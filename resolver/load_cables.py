"""Load submarine cable + landing point GeoJSON into PostGIS and build the
routable graph.

Data acquisition is a MANUAL PREREQUISITE -- see README. Run `make fetch-data`
first; this script reads what that put in data/ and will not silently invent
an endpoint.
"""
import json
import os
import sys

from resolve import connect

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(cur, path, table, geomtype):
    with open(path) as f:
        gj = json.load(f)
    rows = 0
    cur.execute("TRUNCATE %s CASCADE" % table)
    for feat in gj["features"]:
        p = feat["properties"]
        if feat["geometry"]["type"] != geomtype:
            continue
        if p.get("is_tbd"):          # planned, not in service
            continue
        conflict = ("DO UPDATE SET geom = ST_Multi(ST_CollectionExtract("
                    "ST_Collect(%s.geom, EXCLUDED.geom), 2))" % table
                    if geomtype == "MultiLineString" else "DO NOTHING")
        if table == "cables_raw":
            conflict += ", name = EXCLUDED.name, color = EXCLUDED.color"
        if table == "cables_raw":
            cur.execute(
                "INSERT INTO cables_raw (id, name, color, geom) VALUES (%%s, %%s, %%s, "
                "ST_SetSRID(ST_GeomFromGeoJSON(%%s), 4326)) "
                "ON CONFLICT (id) %s" % conflict,
                (p["id"], p.get("name") or p["id"], p.get("color"),
                 json.dumps(feat["geometry"])))
        else:
            cur.execute(
                "INSERT INTO %s (id, name, geom) VALUES (%%s, %%s, "
                "ST_SetSRID(ST_GeomFromGeoJSON(%%s), 4326)) "
                "ON CONFLICT (id) %s" % (table, conflict),
                (p["id"], p.get("name") or p["id"], json.dumps(feat["geometry"])))
        rows += 1
    cur.execute("SELECT count(*) FROM %s" % table)
    return rows, cur.fetchone()[0]


def main():
    data = os.environ.get("DOWNLINK_DATA_DIR", os.path.join(HERE, "..", "data"))
    cables = os.path.join(data, "cable-geo.json")
    landings = os.path.join(data, "landing-point-geo.json")
    for p in (cables, landings):
        if not os.path.exists(p):
            sys.exit("missing %s -- run `make fetch-data` first (see README, "
                     "TeleGeography acquisition is a documented manual step)" % p)

    conn = connect()
    with conn.cursor() as cur:
        f_c, n_c = _load(cur, cables, "cables_raw", "MultiLineString")
        f_l, n_l = _load(cur, landings, "landings_raw", "Point")

        # Natural Earth land polygons: only used for the terrestrial-edge
        # land test, and checked in (public domain, no restrictions).
        land_path = os.environ.get(
            "DOWNLINK_LAND_GEOJSON",
            os.path.join(HERE, "..", "phase4", "public", "basemap",
                         "ne_50m_land.geojson"))
        cur.execute("TRUNCATE land RESTART IDENTITY CASCADE")
        n_land = 0
        if os.path.exists(land_path):
            with open(land_path) as f:
                for feat in json.load(f)["features"]:
                    cur.execute(
                        "INSERT INTO land (geom) VALUES "
                        "(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326))",
                        (json.dumps(feat["geometry"]),))
                    n_land += 1
        else:
            print("WARNING: %s missing -- every terrestrial edge will fail the "
                  "land test and the graph will be cable-only" % land_path)

        cur.execute("TRUNCATE ixps CASCADE")
        with open(os.path.join(HERE, "ixps.json")) as f:
            ixps = json.load(f)["ixps"]
        for x in ixps:
            cur.execute(
                "INSERT INTO ixps (id, name, geom) VALUES (%s, %s, "
                "ST_SetSRID(ST_MakePoint(%s, %s), 4326))",
                (x["id"], x["name"], x["lon"], x["lat"]))
        print("loaded: cables=%d (%d features) landings=%d (%d features) "
              "ixps=%d land=%d" % (n_c, f_c, n_l, f_l, len(ixps), n_land))

        print("building graph ...")
        cur.execute("SELECT stage, n FROM dl_build_graph()")
        for stage, n in cur.fetchall():
            print("  %-18s %d" % (stage, n))

        # Validate BEFORE anything runs a dijkstra against this.
        cur.execute("SELECT nodes, edges, components, largest_component, "
                    "largest_pct FROM dl_topology_report")
        nodes, edges, comps, largest, pct = cur.fetchone()
        print("topology: nodes=%d edges=%d components=%d largest=%d (%.1f%%)"
              % (nodes, edges, comps, largest, pct))
        cur.execute("SELECT component, n_nodes FROM dl_components LIMIT 8")
        for c, n in cur.fetchall():
            print("  component %-8s %d nodes" % (c, n))
        if pct < 60.0:
            sys.exit("FAIL: largest component holds only %.1f%% of nodes -- "
                     "the graph is broken, do not route on it" % pct)
    conn.close()


if __name__ == "__main__":
    main()
