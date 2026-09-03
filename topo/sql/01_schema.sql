-- Downlink topology engine.
--
-- Raw TeleGeography MultiLineStrings are NOT a routable network: they are
-- unnoded, and two cables that cross on a map are not physically connected.
-- The only places cables actually interconnect are landing stations. So the
-- graph is built explicitly:
--
--   nodes  = landing stations (+ IXP metros)
--   edges  = cable segments between consecutive landing stations on the same
--            cable, plus short terrestrial hops between nearby stations
--
-- This is also why pgr_createTopology() is deliberately NOT used. It infers
-- vertices from segment endpoints, which would happily weld two unrelated
-- cables together wherever their geometries happen to touch. We assign
-- source/target ourselves from the landing-station table, and validate the
-- result with pgr_connectedComponents() instead.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgrouting;

-- ---------- raw import (populated by resolver/load_cables.py) ----------

CREATE TABLE IF NOT EXISTS cables_raw (
    id    text PRIMARY KEY,
    name  text NOT NULL,
    color text,
    geom  geometry(MultiLineString, 4326) NOT NULL
);

ALTER TABLE cables_raw ADD COLUMN IF NOT EXISTS color text;

CREATE TABLE IF NOT EXISTS landings_raw (
    id    text PRIMARY KEY,
    name  text NOT NULL,
    geom  geometry(Point, 4326) NOT NULL
);

CREATE TABLE IF NOT EXISTS ixps (
    id    text PRIMARY KEY,
    name  text NOT NULL,
    geom  geometry(Point, 4326) NOT NULL
);

-- Natural Earth 1:50m land polygons (public domain). Used only to decide
-- whether a proposed terrestrial edge is actually over land.
CREATE TABLE IF NOT EXISTS land (
    id   serial PRIMARY KEY,
    geom geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS land_gix ON land USING GIST (geom);

CREATE INDEX IF NOT EXISTS cables_raw_gix   ON cables_raw   USING GIST (geom);
CREATE INDEX IF NOT EXISTS landings_raw_gix ON landings_raw USING GIST (geom);

-- ---------- routable graph ----------

CREATE TABLE IF NOT EXISTS nodes (
    id     bigserial PRIMARY KEY,
    ext_id text UNIQUE NOT NULL,
    kind   text NOT NULL,
    cable_id text,
    name   text NOT NULL,
    geom   geometry(Point, 4326) NOT NULL
);

ALTER TABLE nodes ADD COLUMN IF NOT EXISTS cable_id text;
ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_kind_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_kind_check
    CHECK (kind IN ('landing', 'ixp', 'junction'));

CREATE TABLE IF NOT EXISTS edges (
    id           bigserial PRIMARY KEY,
    source       bigint NOT NULL REFERENCES nodes(id),
    target       bigint NOT NULL REFERENCES nodes(id),
    cable_id     text,
    kind         text NOT NULL CHECK (kind IN ('submarine', 'terrestrial')),
    len_km       double precision NOT NULL,
    cost         double precision NOT NULL,
    reverse_cost double precision NOT NULL,
    geom         geometry(LineString, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS nodes_gix    ON nodes USING GIST (geom);
CREATE INDEX IF NOT EXISTS edges_gix    ON edges USING GIST (geom);
CREATE INDEX IF NOT EXISTS edges_source ON edges (source);
CREATE INDEX IF NOT EXISTS edges_target ON edges (target);

-- Cost model. Length in km, never hop count.
--   submarine   : cost = length
--   terrestrial : cost = length * DL_TERR_FACTOR + DL_STATION_PENALTY_KM
-- Overland fibre is not free: it follows roads and rail, and every station
-- hop adds cross-connect and regeneration delay. The penalty is expressed in
-- km-equivalents so the whole cost function stays in one unit.
CREATE OR REPLACE FUNCTION dl_terr_factor() RETURNS double precision
    LANGUAGE sql IMMUTABLE AS $$ SELECT 1.6::double precision $$;
CREATE OR REPLACE FUNCTION dl_station_penalty_km() RETURNS double precision
    LANGUAGE sql IMMUTABLE AS $$ SELECT 25.0::double precision $$;

-- ---------- graph construction ----------

-- Snap radius for deciding that a landing point sits ON a given cable line.
-- TeleGeography landing-point coordinates are the station, not the exact
-- cable terminus, so they are consistently a few km off the line.
CREATE OR REPLACE FUNCTION dl_landing_snap_km() RETURNS double precision
    LANGUAGE sql IMMUTABLE AS $$ SELECT 30.0::double precision $$;

-- What fraction of a proposed terrestrial edge is actually over land?
-- Without this, "terrestrial" edges cheerfully bridge the Arabian Sea and
-- the South China Sea, which is exactly the kind of confident nonsense this
-- project must not produce. The straight lon/lat line is an approximation to
-- the great circle; over the <=5000 km these edges span, it is close enough
-- to decide land vs. ocean.
CREATE OR REPLACE FUNCTION dl_land_fraction(l geometry) RETURNS double precision
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        SUM(ST_Length(ST_Intersection(l, g.geom)::geography)), 0.0)
        / NULLIF(ST_Length(l::geography), 0.0)
    FROM land g
    WHERE ST_Intersects(l, g.geom)
$$;

-- Terrestrial edges shorter than this are accepted without the land test:
-- a short hop across a bay or estuary is normal coastal infrastructure.
CREATE OR REPLACE FUNCTION dl_land_test_min_km() RETURNS double precision
    LANGUAGE sql IMMUTABLE AS $$ SELECT 300.0::double precision $$;

CREATE OR REPLACE FUNCTION dl_build_graph()
RETURNS TABLE (stage text, n bigint)
LANGUAGE plpgsql AS $$
DECLARE
    snap_m double precision := dl_landing_snap_km() * 1000.0;
BEGIN
    TRUNCATE edges RESTART IDENTITY;
    DELETE FROM nodes;
    ALTER SEQUENCE nodes_id_seq RESTART;

    INSERT INTO nodes (ext_id, kind, name, geom)
    SELECT id, 'landing', name, geom FROM landings_raw;
    INSERT INTO nodes (ext_id, kind, name, geom)
    SELECT id, 'ixp', name, geom FROM ixps
    ON CONFLICT (ext_id) DO NOTHING;

    -- TeleGeography splits cable geometry at the antimeridian. Preserve
    -- those endpoints as cable-specific graph nodes; otherwise every
    -- trans-Pacific system becomes two disconnected regional fragments.
    INSERT INTO nodes (ext_id, kind, cable_id, name, geom)
    SELECT 'junction:' || cable_id || ':' || md5(ST_AsEWKT(point)),
           'junction', cable_id, cable_name || ' antimeridian junction', point
    FROM (
        SELECT DISTINCT c.id AS cable_id, c.name AS cable_name,
               endpoint.point
        FROM cables_raw c
        CROSS JOIN LATERAL ST_Dump(c.geom) part
        CROSS JOIN LATERAL (VALUES (ST_StartPoint(part.geom)),
                                   (ST_EndPoint(part.geom))) endpoint(point)
        WHERE abs(abs(ST_X(endpoint.point)) - 180.0) < 0.01
    ) junctions
    ON CONFLICT (ext_id) DO NOTHING;

    stage := 'nodes'; SELECT count(*) INTO n FROM nodes; RETURN NEXT;

    -- Split each cable LineString at the landing stations that lie on it.
    -- ST_LineLocatePoint gives the fraction along the line; consecutive
    -- fractions become one edge via ST_LineSubstring. A line with fewer than
    -- two nearby stations connects nothing and is dropped.
    WITH lines AS (
        SELECT c.id AS cable_id, (ST_Dump(c.geom)).geom AS line
        FROM cables_raw c
    ),
    landing_hits AS (
        SELECT l.cable_id,
               l.line,
               n.id AS node_id,
               ST_LineLocatePoint(l.line, n.geom) AS frac
        FROM lines l
        JOIN nodes n
          ON n.kind = 'landing'
         AND ST_DWithin(l.line::geography, n.geom::geography, snap_m)
    ),
    junction_hits AS (
        SELECT l.cable_id,
               l.line,
               n.id AS node_id,
               ST_LineLocatePoint(l.line, n.geom) AS frac
        FROM lines l
        JOIN nodes n
         ON n.kind = 'junction'
         AND n.cable_id = l.cable_id
         -- Geometry distance is intentional here: geography considers
         -- +180 and -180 adjacent, but each side needs its own node before
         -- the explicit dateline edge joins them.
         AND ST_DWithin(l.line, n.geom, 0.01)
    ),
    hits AS (
        SELECT * FROM landing_hits
        UNION ALL
        SELECT * FROM junction_hits
    ),
    ordered AS (
        SELECT cable_id, line, node_id, frac,
               row_number() OVER (PARTITION BY cable_id, line ORDER BY frac) AS rn
        FROM hits
    ),
    pairs AS (
        SELECT a.cable_id, a.line,
               a.node_id AS src, b.node_id AS dst,
               a.frac AS f0, b.frac AS f1
        FROM ordered a
        JOIN ordered b
          ON b.cable_id = a.cable_id
         AND ST_Equals(b.line, a.line)
         AND b.rn = a.rn + 1
        WHERE a.node_id <> b.node_id
          AND b.frac - a.frac > 1e-9
    ),
    seg AS (
        SELECT cable_id, src, dst,
               ST_LineSubstring(line, f0, f1) AS geom
        FROM pairs
    )
    INSERT INTO edges (source, target, cable_id, kind, len_km, cost, reverse_cost, geom)
    SELECT src, dst, cable_id, 'submarine',
           ST_Length(geom::geography) / 1000.0,
           ST_Length(geom::geography) / 1000.0,
           ST_Length(geom::geography) / 1000.0,
           geom
    FROM seg
    WHERE ST_GeometryType(geom) = 'ST_LineString'
      AND ST_NumPoints(geom) >= 2;

    -- Join the two published halves of each cable across +/-180. Matching
    -- by cable and latitude also handles systems with multiple crossings.
    INSERT INTO edges (source, target, cable_id, kind, len_km, cost, reverse_cost, geom)
    SELECT east.id, west.id, east.cable_id, 'submarine',
           ST_Distance(east.geom::geography, west.geom::geography) / 1000.0,
           ST_Distance(east.geom::geography, west.geom::geography) / 1000.0,
           ST_Distance(east.geom::geography, west.geom::geography) / 1000.0,
           ST_MakeLine(east.geom, west.geom)
    FROM nodes east
    JOIN nodes west
      ON west.kind = 'junction'
     AND west.cable_id = east.cable_id
     AND ST_X(west.geom) < 0
     AND abs(ST_Y(west.geom) - ST_Y(east.geom)) < 0.1
    WHERE east.kind = 'junction'
      AND ST_X(east.geom) > 0;

    stage := 'submarine_edges'; SELECT count(*) INTO n FROM edges WHERE kind = 'submarine'; RETURN NEXT;

    -- Terrestrial hops.
    --
    -- Two tiers, because the physical reality is two different things:
    --   station <-> station   short coastal interconnect, 400 km, K=6
    --   ixp     <-> anything  metro backhaul, 2000 km, K=4. Phoenix to Los
    --                         Angeles is 570 km of utterly ordinary
    --                         terrestrial fibre; capping IXPs at the coastal
    --                         radius strands every inland metro as its own
    --                         component.
    --
    -- Capping at K keeps the graph sparse. An all-pairs join over ~1900
    -- stations produces a hairball that cheerfully routes through
    -- implausible chains of adjacent coastal landings.
    WITH cand AS (
        SELECT a.id AS a_id, b.id AS b_id, a.geom AS a_geom, b.geom AS b_geom, b.d
        FROM nodes a
        CROSS JOIN LATERAL (
            SELECT m.id, m.geom,
                   ST_Distance(a.geom::geography, m.geom::geography) AS d
            FROM nodes m
            WHERE m.id <> a.id
              AND m.kind <> 'junction'
            ORDER BY a.geom <-> m.geom
            LIMIT CASE WHEN a.kind = 'ixp' THEN 4 ELSE 6 END
        ) b
        WHERE a.kind <> 'junction'
          AND b.d <= CASE WHEN a.kind = 'ixp' THEN 2000000.0 ELSE 400000.0 END
    ),
    uniq AS (
        -- Orient the geometry to match source->target. Getting this wrong
        -- yields edges whose LineString runs backwards, and a route that
        -- visibly doubles back on itself at every terrestrial hop.
        SELECT DISTINCT ON (least(a_id, b_id), greatest(a_id, b_id))
               least(a_id, b_id) AS src, greatest(a_id, b_id) AS dst,
               CASE WHEN a_id < b_id THEN a_geom ELSE b_geom END AS src_geom,
               CASE WHEN a_id < b_id THEN b_geom ELSE a_geom END AS dst_geom,
               d
        FROM cand
    )
    INSERT INTO edges (source, target, cable_id, kind, len_km, cost, reverse_cost, geom)
    SELECT u.src, u.dst, NULL, 'terrestrial',
           u.d / 1000.0,
           (u.d / 1000.0) * dl_terr_factor() + dl_station_penalty_km(),
           (u.d / 1000.0) * dl_terr_factor() + dl_station_penalty_km(),
           ST_MakeLine(u.src_geom, u.dst_geom)
    FROM uniq u
    WHERE u.d > 0
      AND (u.d / 1000.0 <= dl_land_test_min_km()
           OR dl_land_fraction(ST_MakeLine(u.src_geom, u.dst_geom)) >= 0.7)
      AND NOT EXISTS (
            SELECT 1 FROM edges e
            WHERE e.kind = 'submarine'
              AND ((e.source = u.src AND e.target = u.dst)
                OR (e.source = u.dst AND e.target = u.src)));

    -- Tier 3: the continental backbone. IXP to IXP, all pairs up to 5000 km
    -- that are >=70% over land. Without this, an inland metro can only reach
    -- the rest of its own continent by going out to the coast and back --
    -- Phoenix to Atlanta routed through Panama in the first build, which is
    -- how this tier got written.
    INSERT INTO edges (source, target, cable_id, kind, len_km, cost, reverse_cost, geom)
    SELECT a.id, b.id, NULL, 'terrestrial',
           ST_Distance(a.geom::geography, b.geom::geography) / 1000.0,
           (ST_Distance(a.geom::geography, b.geom::geography) / 1000.0)
               * dl_terr_factor() + dl_station_penalty_km(),
           (ST_Distance(a.geom::geography, b.geom::geography) / 1000.0)
               * dl_terr_factor() + dl_station_penalty_km(),
           ST_MakeLine(a.geom, b.geom)
    FROM nodes a
    JOIN nodes b ON b.kind = 'ixp' AND a.id < b.id
    WHERE a.kind = 'ixp'
      AND ST_Distance(a.geom::geography, b.geom::geography) <= 5000000.0
      AND dl_land_fraction(ST_MakeLine(a.geom, b.geom)) >= 0.7
      AND NOT EXISTS (
            SELECT 1 FROM edges e
            WHERE (e.source = a.id AND e.target = b.id)
               OR (e.source = b.id AND e.target = a.id));

    stage := 'terrestrial_edges'; SELECT count(*) INTO n FROM edges WHERE kind = 'terrestrial'; RETURN NEXT;
    stage := 'edges_total';       SELECT count(*) INTO n FROM edges; RETURN NEXT;
    RETURN;
END $$;

-- ---------- topology validation ----------
--
-- Run this BEFORE trusting any pgr_dijkstra result. A cable network is
-- expected to have some genuinely isolated pieces (domestic festoon systems,
-- island links with a single landing) but the main component must dominate.

CREATE OR REPLACE VIEW dl_components AS
SELECT component, count(*) AS n_nodes
FROM pgr_connectedComponents(
        'SELECT id, source, target, cost, reverse_cost FROM edges')
GROUP BY component
ORDER BY n_nodes DESC;

CREATE OR REPLACE VIEW dl_topology_report AS
SELECT (SELECT count(*) FROM nodes)                              AS nodes,
       (SELECT count(*) FROM edges)                              AS edges,
       (SELECT count(*) FROM dl_components)                      AS components,
       (SELECT max(n_nodes) FROM dl_components)                  AS largest_component,
       round(100.0 * (SELECT max(n_nodes) FROM dl_components)
             / NULLIF((SELECT sum(n_nodes) FROM dl_components), 0), 1)
                                                                 AS largest_pct;
