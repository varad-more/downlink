"""Destination IP + measured RTT -> named candidate infrastructure routes.

Everything this module emits is a hypothesis. The confidence score is the
honest part; cable names describe mapped infrastructure, not a proven packet
path.
"""
import json
import math
import os

# Group velocity in single-mode fibre is c/n with n ~ 1.468, i.e. 204 km/ms.
# The build document said 200; 204 is the correct figure and, because this is
# used as an UPPER bound on distance, the more generous number is also the
# safer one -- 200 would reject marginally-feasible real paths.
SOL_KM_PER_MS = 204.0

# Beyond this, an endpoint has no plausible entry into the cable graph and we
# stop pretending otherwise.
SNAP_MAX_KM = 1200.0

R_EARTH_KM = 6371.0088


def great_circle_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH_KM * math.asin(min(1.0, math.sqrt(a)))


def gc_arc(lat1, lon1, lat2, lon2, n=48):
    """Great-circle polyline, densified so it renders as an arc rather than a
    straight line in a Mercator projection."""
    p1, l1, p2, l2 = map(math.radians, (lat1, lon1, lat2, lon2))
    d = great_circle_km(lat1, lon1, lat2, lon2) / R_EARTH_KM
    if d < 1e-9:
        return [[lon1, lat1], [lon2, lat2]]
    out = []
    for i in range(n + 1):
        f = i / n
        a = math.sin((1 - f) * d) / math.sin(d)
        b = math.sin(f * d) / math.sin(d)
        x = a * math.cos(p1) * math.cos(l1) + b * math.cos(p2) * math.cos(l2)
        y = a * math.cos(p1) * math.sin(l1) + b * math.cos(p2) * math.sin(l2)
        z = a * math.sin(p1) + b * math.sin(p2)
        out.append([math.degrees(math.atan2(y, x)),
                    math.degrees(math.atan2(z, math.hypot(x, y)))])
    return out


def _clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def confidence(path_km, gc_km, budget_km, snap_km, accuracy_km):
    """Multiplicative, one factor per thing that can be wrong. Each factor is
    1.0 when that particular worry does not apply.

      detour   real routes run ~1.5-2x great circle; much more than that and
               the router picked something implausible
      headroom how much of the speed-of-light budget the path consumes; a
               path that only just fits is far more likely to be wrong than
               one with slack for queueing and serialisation
      snap     how far the endpoints had to be dragged to reach a graph node
      geo      MaxMind's own stated accuracy radius
    """
    detour = path_km / gc_km if gc_km > 1.0 else 1.0
    f_detour = 1.0 if detour <= 2.0 else _clamp(2.0 / detour)
    headroom = path_km / budget_km if budget_km > 0 else 1.0
    f_headroom = 1.0 if headroom <= 0.5 else _clamp(1.0 - (headroom - 0.5))
    f_snap = math.exp(-snap_km / 800.0)
    f_geo = _clamp(1.0 - (accuracy_km / 2000.0), 0.3, 1.0)
    return round(f_detour * f_headroom * f_snap * f_geo, 3)


_NEAREST = """
SELECT id, name, kind, ST_Y(geom) AS lat, ST_X(geom) AS lon,
       ST_Distance(geom::geography,
                   ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography) / 1000.0 AS km
FROM nodes
JOIN dl_routable_nodes USING (id)
ORDER BY geom <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)
LIMIT 1
"""

_ROUTABLE_NODES = """
CREATE TEMP TABLE dl_routable_nodes ON COMMIT PRESERVE ROWS AS
WITH components AS MATERIALIZED (
  SELECT component, node
  FROM pgr_connectedComponents(
    'SELECT id, source, target, cost, reverse_cost FROM edges')
)
SELECT node AS id
FROM components
WHERE component = (
  SELECT component FROM components
  GROUP BY component
  ORDER BY count(*) DESC
  LIMIT 1
)
"""

_NEAREST_WITHIN = """
SELECT id, name, kind, ST_Y(geom) AS lat, ST_X(geom) AS lon,
       ST_Distance(geom::geography,
                   ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography) / 1000.0 AS km
FROM nodes
WHERE kind = 'ixp'
  AND ST_DWithin(geom::geography,
                 ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, %s)
ORDER BY geom <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)
LIMIT 1
"""

# Simplify in the database: a raw cable chain can carry thousands of vertices
# and every client pays for every one of them. 0.15 degrees keeps the
# recognisable shape of a cable at wall-projection scale.
_ROUTES = """
SELECT d.path_id, d.path_seq, d.node, d.edge,
       e.source, e.target, e.kind, e.len_km, e.cable_id,
       c.name AS cable_name, src.name AS source_name, dst.name AS target_name,
       ST_AsGeoJSON(ST_Simplify(e.geom, 0.15)) AS gj
FROM pgr_KSP(
        %s, %s, %s, 50, directed := false) d
LEFT JOIN edges e ON e.id = d.edge
LEFT JOIN cables_raw c ON c.id = e.cable_id
LEFT JOIN nodes src ON src.id = e.source
LEFT JOIN nodes dst ON dst.id = e.target
ORDER BY d.path_id, d.path_seq
"""


class Resolver:
    def __init__(self, conn, geo, home_lat, home_lon):
        self.conn = conn
        self.geo = geo
        self.home = (home_lat, home_lon)
        self._home_node = None
        # The closest node may be an isolated cable fragment. Restrict every
        # route lookup to the graph's connected global backbone.
        with self.conn.cursor() as cur:
            cur.execute(_ROUTABLE_NODES)
            cur.execute("CREATE UNIQUE INDEX ON dl_routable_nodes (id)")

    def _nearest(self, lat, lon):
        with self.conn.cursor() as cur:
            cur.execute(_NEAREST, (lon, lat, lon, lat))
            r = cur.fetchone()
        return dict(zip(("id", "name", "kind", "lat", "lon", "km"), r)) if r else None

    def _nearest_ixp_within(self, lat, lon, budget_km):
        with self.conn.cursor() as cur:
            cur.execute(_NEAREST_WITHIN,
                        (lon, lat, lon, lat, budget_km * 1000.0, lon, lat))
            r = cur.fetchone()
        return dict(zip(("id", "name", "kind", "lat", "lon", "km"), r)) if r else None

    def home_node(self):
        if self._home_node is None:
            self._home_node = self._nearest(*self.home)
        return self._home_node

    def network(self):
        """Export the complete mapped cable layer and modeled land graph."""
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT id, name, color, ST_AsGeoJSON(geom) "
                "FROM cables_raw ORDER BY name")
            cables = [{
                "type": "Feature", "geometry": json.loads(geometry),
                "properties": {"id": cable_id, "name": name,
                               "color": color or "#3974a8"},
            } for cable_id, name, color, geometry in cur.fetchall()]
            cur.execute(
                "SELECT e.id, src.name, dst.name, e.len_km, "
                "ST_AsGeoJSON(e.geom) FROM edges e "
                "JOIN nodes src ON src.id=e.source "
                "JOIN nodes dst ON dst.id=e.target "
                "WHERE e.kind='terrestrial' ORDER BY e.id")
            terrestrial = [{
                "type": "Feature", "geometry": json.loads(geometry),
                "properties": {"id": edge_id, "from": source, "to": target,
                               "km": round(km, 1)},
            } for edge_id, source, target, km, geometry in cur.fetchall()]
            cur.execute(
                "SELECT ext_id, name, ST_AsGeoJSON(geom) FROM nodes "
                "WHERE kind='landing' ORDER BY name")
            landings = [{
                "type": "Feature", "geometry": json.loads(geometry),
                "properties": {"id": landing_id, "name": name},
            } for landing_id, name, geometry in cur.fetchall()]
        return {
            "schema": 1,
            "topology_source": "TeleGeography Submarine Cable Map API snapshot",
            "license": "CC BY-SA 4.0",
            "cables": {"type": "FeatureCollection", "features": cables},
            "terrestrial": {"type": "FeatureCollection", "features": terrestrial},
            "landings": {"type": "FeatureCollection", "features": landings},
        }

    def _routes(self, src_id, dst_id):
        """Return up to three distinct, named graph routes."""
        def assemble(rows):
            routes = {}
            for (path_id, _path_seq, node, edge, source, target, kind, len_km,
                 cable_id, cable_name, source_name, target_name, gj) in rows:
                if edge is None or edge == -1 or gj is None:
                    continue
                route = routes.setdefault(path_id, {
                    "path": [], "path_km": 0.0, "segments": []})
                pts = json.loads(gj)["coordinates"]
                if node == target:      # traversing this edge backwards
                    pts = list(reversed(pts))
                    source_name, target_name = target_name, source_name

                if route["path"] and route["path"][-1] != pts[0]:
                    previous = route["path"][-1]
                    handoff_km = great_circle_km(
                        previous[1], previous[0], pts[0][1], pts[0][0])
                    if handoff_km > 75:
                        route["invalid"] = True
                        continue
                    if handoff_km > 0.05:
                        route["path"].append(pts[0])
                        route["path_km"] += handoff_km
                        route["segments"].append({
                            "kind": "terrestrial",
                            "name": "modeled landing-station handoff",
                            "from": route["segments"][-1]["to"],
                            "to": source_name,
                            "km": round(handoff_km, 1),
                            "path": [previous, pts[0]],
                        })
                route_pts = (pts[1:] if route["path"] and
                             route["path"][-1] == pts[0] else pts)
                route["path"].extend(route_pts)
                route["path_km"] += len_km

                name = cable_name or "modeled terrestrial connection"
                segment = {
                    "kind": kind, "name": name, "from": source_name,
                    "to": target_name, "km": round(len_km, 1), "path": pts,
                }
                if cable_id:
                    segment["cable_id"] = cable_id
                previous = route["segments"][-1] if route["segments"] else None
                if (previous and previous["kind"] == kind and
                        previous["name"] == name):
                    previous["to"] = target_name
                    previous["km"] = round(previous["km"] + len_km, 1)
                    previous["path"].extend(
                        pts[1:] if previous["path"][-1] == pts[0] else pts)
                else:
                    route["segments"].append(segment)

            finished = []
            for route in routes.values():
                if route.get("invalid"):
                    continue
                cables, cable_km = [], {}
                for segment in route["segments"]:
                    name = segment["name"]
                    if segment["kind"] == "submarine" and name not in cables:
                        cables.append(name)
                    if segment["kind"] == "submarine":
                        cable_km[name] = cable_km.get(name, 0.0) + segment["km"]
                material = [name for name in cables if cable_km[name] >= 50]
                signature = tuple(material) or tuple(
                    (s["from"], s["to"]) for s in route["segments"])
                route["cables"] = cables
                if len(material) <= 3:
                    route["name"] = ("via " + " → ".join(material)
                                     if material else "modeled regional route")
                else:
                    route["name"] = "via %s → … → %s (%d major cables)" % (
                        material[0], material[-1], len(material))
                if not cables:
                    route["name"] = "modeled terrestrial route"
                submarine = [segment for segment in route["segments"]
                             if segment["kind"] == "submarine" and
                             segment.get("cable_id")]
                route["_trunk"] = (max(submarine, key=lambda s: s["km"])
                                   ["cable_id"] if submarine else None)
                finished.append((signature, route))
            return finished

        out, seen, excluded = [], set(), set()
        for _ in range(3):
            edge_sql = "SELECT id, source, target, cost, reverse_cost FROM edges"
            if excluded:
                quoted = ",".join("'%s'" % cable.replace("'", "''")
                                  for cable in sorted(excluded))
                edge_sql += (" WHERE cable_id IS NULL OR cable_id NOT IN (" +
                             quoted + ")")
            with self.conn.cursor() as cur:
                cur.execute(_ROUTES, (edge_sql, src_id, dst_id))
                candidates = assemble(cur.fetchall())
            choice = next((route for signature, route in candidates
                           if signature not in seen), None)
            if not choice:
                break
            signature = next(signature for signature, route in candidates
                             if route is choice)
            seen.add(signature)
            trunk = choice.pop("_trunk")
            out.append(choice)
            if not trunk or trunk in excluded:
                break
            excluded.add(trunk)
        return out

    @staticmethod
    def _segments_with_snaps(route, source, destination, source_node,
                             destination_node):
        """Copy route segments and include the modeled city-to-graph hops."""
        segments = [{**segment, "path": [list(point) for point in segment["path"]]}
                    for segment in route["segments"]]
        if not route["path"]:
            return segments

        def add_connector(at_start, endpoint, node, graph_point):
            if node["km"] <= 0.05:
                return
            endpoint_point = [endpoint["lon"], endpoint["lat"]]
            connector = {
                "kind": "terrestrial",
                "name": "modeled terrestrial connection",
                "from": endpoint["name"] if at_start else node["name"],
                "to": node["name"] if at_start else endpoint["name"],
                "km": round(node["km"], 1),
                "path": ([endpoint_point, graph_point] if at_start
                         else [graph_point, endpoint_point]),
            }
            adjacent = segments[0] if at_start and segments else (
                segments[-1] if segments else None)
            if (adjacent and adjacent["kind"] == connector["kind"] and
                    adjacent["name"] == connector["name"]):
                adjacent["km"] = round(adjacent["km"] + node["km"], 1)
                if at_start:
                    adjacent["from"] = endpoint["name"]
                    adjacent["path"] = connector["path"][:-1] + adjacent["path"]
                else:
                    adjacent["to"] = endpoint["name"]
                    adjacent["path"].extend(connector["path"][1:])
            elif at_start:
                segments.insert(0, connector)
            else:
                segments.append(connector)

        add_connector(True, source, source_node, route["path"][0])
        add_connector(False, destination, destination_node, route["path"][-1])
        return segments

    def between(self, source, destination):
        """Return named candidate routes between two user-selected cities.

        There is no observed RTT here, so latency is a fibre propagation
        floor and the result is never described as a measured packet path.
        """
        sl, so = source["lat"], source["lon"]
        dl, do = destination["lat"], destination["lon"]
        gc_km = great_circle_km(sl, so, dl, do)
        out = {
            "source": source, "destination": destination,
            "gc_km": round(gc_km, 1),
        }
        sn, dn = self._nearest(sl, so), self._nearest(dl, do)
        snap_km = (sn["km"] if sn else 9e9) + (dn["km"] if dn else 9e9)
        if (not sn or not dn or sn["km"] > SNAP_MAX_KM or
                dn["km"] > SNAP_MAX_KM):
            return self._between_great_circle(out, sl, so, dl, do,
                                              "no-graph-route")

        if sn["id"] == dn["id"]:
            path = gc_arc(sl, so, dl, do, n=12)
            out.update(
                method="route", reason=None,
                route_name="modeled terrestrial route", path=path,
                path_km=round(gc_km, 1),
                estimated_rtt_ms=round(gc_km * 2 / SOL_KM_PER_MS, 1),
                confidence=confidence(gc_km, gc_km, gc_km * 2,
                                      snap_km, 0),
                segments=[{
                    "kind": "terrestrial",
                    "name": "modeled terrestrial connection",
                    "from": source["name"], "to": destination["name"],
                    "km": round(gc_km, 1), "path": path,
                }],
                cables=[], alternatives=[], entry=sn["name"],
                exit=dn["name"], snap_km=round(snap_km, 1),
            )
            return out

        routes = self._routes(sn["id"], dn["id"])
        if not routes:
            return self._between_great_circle(out, sl, so, dl, do,
                                              "no-graph-route")

        candidates = []
        for route in routes:
            path_km = max(gc_km, route["path_km"] + snap_km)
            segments = self._segments_with_snaps(
                route, source, destination, sn, dn)
            candidates.append({
                "rank": len(candidates) + 1,
                "name": route["name"],
                "path": [[so, sl]] + route["path"] + [[do, dl]],
                "path_km": round(path_km, 1),
                "estimated_rtt_ms": round(path_km * 2 / SOL_KM_PER_MS, 1),
                "segments": segments,
                "cables": route["cables"],
                # No RTT/GeoIP uncertainty applies to a user-chosen point.
                "confidence": confidence(path_km, gc_km, path_km * 2,
                                         snap_km, 0),
            })

        best = candidates[0]
        out.update(
            method="route", reason=None,
            route_name=best["name"], path=best["path"],
            path_km=best["path_km"], estimated_rtt_ms=best["estimated_rtt_ms"],
            confidence=best["confidence"], segments=best["segments"],
            cables=best["cables"], alternatives=candidates[1:],
            entry=sn["name"], exit=dn["name"], snap_km=round(snap_km, 1),
        )
        return out

    def _between_great_circle(self, out, sl, so, dl, do, reason):
        km = out["gc_km"]
        out.update(
            method="greatcircle", reason=reason,
            route_name="great-circle estimate",
            path=gc_arc(sl, so, dl, do), path_km=km,
            estimated_rtt_ms=round(km * 2 / SOL_KM_PER_MS, 1),
            confidence=0.2, segments=[], cables=[], alternatives=[],
        )
        return out

    def resolve(self, ip, rtt_ms):
        hl, ho = self.home
        budget_km = (rtt_ms / 2.0) * SOL_KM_PER_MS
        out = {"ip": ip, "rtt_ms": rtt_ms, "budget_km": round(budget_km, 1)}

        g = self.geo.lookup(ip)
        if not g:
            out.update(method="unknown", confidence=0.0, path=None,
                       reason="no-geolocation", label=ip)
            return out

        out["city"] = g["city"]
        gc_km = great_circle_km(hl, ho, g["lat"], g["lon"])
        out["gc_km"] = round(gc_km, 1)

        # (1) Anycast / CDN detection. The measured RTT physically cannot
        # reach the coordinate MaxMind gave us, so the coordinate is wrong --
        # this is a local edge node, not a machine in Sydney. Reclassify to
        # the nearest metro that DOES fit the budget rather than drawing a
        # line to a place the packets never went.
        if gc_km > budget_km:
            pop = self._nearest_ixp_within(hl, ho, budget_km)
            tgt = pop or self.home_node()
            out.update(
                method="pop",
                reason="anycast-reclassified",
                city=f"{tgt['name']} (edge)",
                dst=[tgt["lon"], tgt["lat"]],
                path=gc_arc(hl, ho, tgt["lat"], tgt["lon"], n=12),
                path_km=round(great_circle_km(hl, ho, tgt["lat"], tgt["lon"]), 1),
                confidence=0.3,
                label=f"{tgt['name']} · anycast edge · {rtt_ms:.0f}ms",
            )
            return out

        out["dst"] = [g["lon"], g["lat"]]

        # (2) Can both ends even reach the cable graph?
        hn, dn = self.home_node(), self._nearest(g["lat"], g["lon"])
        snap_km = (hn["km"] if hn else 9e9) + (dn["km"] if dn else 9e9)
        if not hn or not dn or hn["km"] > SNAP_MAX_KM or dn["km"] > SNAP_MAX_KM:
            return self._great_circle(out, g, gc_km, budget_km,
                                      "no-graph-entry", rtt_ms)

        # (3) Find up to three mapped candidates. These are physically
        # possible graph paths, not proof that the observed flow used them.
        if hn["id"] == dn["id"]:
            routes = [{
                "path": [], "path_km": gc_km, "segments": [], "cables": [],
                "name": "modeled terrestrial route",
            }]
        else:
            routes = self._routes(hn["id"], dn["id"])
        if not routes:
            return self._great_circle(out, g, gc_km, budget_km,
                                      "no-route", rtt_ms)

        candidates = []
        for route in routes:
            total_km = route["path_km"] + (0 if hn["id"] == dn["id"] else snap_km)
            if total_km > budget_km:
                continue
            path = [[ho, hl]] + route["path"] + [[g["lon"], g["lat"]]]
            segments = self._segments_with_snaps(
                route,
                {"name": os.getenv("HOME_NAME", "home"), "lat": hl, "lon": ho},
                {"name": g["city"], "lat": g["lat"], "lon": g["lon"]},
                hn, dn)
            candidates.append({
                "rank": len(candidates) + 1,
                "name": route["name"],
                "path": path,
                "path_km": round(total_km, 1),
                "segments": segments,
                "cables": route["cables"],
                "confidence": confidence(total_km, gc_km, budget_km, snap_km,
                                         g["accuracy_km"]),
            })

        # (4) A constructed route longer than the light budget did not
        # happen, whatever the graph says.
        if not candidates:
            return self._great_circle(out, g, gc_km, budget_km,
                                      "exceeds-light-budget", rtt_ms)

        best = candidates[0]
        out.update(
            method="route",
            reason=None,
            path=best["path"],
            path_km=best["path_km"],
            snap_km=round(snap_km, 1),
            entry=hn["name"], exit=dn["name"],
            confidence=best["confidence"],
            route_name=best["name"],
            cables=best["cables"],
            segments=best["segments"],
            alternatives=candidates[1:],
        )
        out["label"] = "%s · %s · %.0fms · ~conf %.1f" % (
            g["city"], best["name"], rtt_ms, out["confidence"])
        return out

    def _great_circle(self, out, g, gc_km, budget_km, reason, rtt_ms):
        out.update(
            method="greatcircle",
            reason=reason,
            path=gc_arc(self.home[0], self.home[1], g["lat"], g["lon"]),
            path_km=round(gc_km, 1),
            confidence=0.2,
            label="%s · great-circle estimate · %.0fms · ~conf 0.2" % (
                g["city"], rtt_ms),
        )
        return out


def connect():
    import psycopg
    return psycopg.connect(
        host=os.environ.get("PGHOST", "db"),
        dbname=os.environ.get("PGDATABASE", "downlink"),
        user=os.environ.get("PGUSER", "postgres"),
        password=os.environ.get("PGPASSWORD", "downlink"),
        autocommit=True,
    )


def build(conn=None):
    conn = conn or connect()
    here = os.path.dirname(os.path.abspath(__file__))
    from geo import Geo
    geo = Geo(os.environ.get("DOWNLINK_GEOIP_DB"),
              os.environ.get("DOWNLINK_GEO_FIXTURE",
                             os.path.join(here, "..", "tests", "fixture_dests.json")))
    return Resolver(conn, geo,
                    float(os.environ.get("DOWNLINK_HOME_LAT", "33.4255")),
                    float(os.environ.get("DOWNLINK_HOME_LON", "-111.9400")))


if __name__ == "__main__":
    import sys
    r = build()
    src = sys.argv[1] if len(sys.argv) > 1 else "tests/fixture_dests.json"
    with open(src) as f:
        dests = json.load(f)["destinations"]
    for d in dests:
        print(json.dumps(r.resolve(d["ip"], d["rtt_ms"]), separators=(",", ":")))
