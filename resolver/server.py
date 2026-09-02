"""Resolver HTTP service. stdlib only -- the request rate is one lookup per
destination per debounce window, which is single-digit requests per second on
a home gateway. A web framework here would be pure ceremony.

  POST /resolve  {"ip": "1.1.1.1", "rtt_ms": 12.0} -> observed-flow route
  POST /route    {"source": {...}, "destination": {...}} -> city route
  GET  /health                                       -> service status
  GET  /network                                      -> cable/land graph
"""
import json
import ipaddress
import math
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from resolve import build

_lock = threading.Lock()
_res = None
def resolver():
    global _res
    if _res is None:
        _res = build()
    return _res


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/network":
            try:
                with _lock:
                    return self._send(200, resolver().network())
            except Exception as e:
                return self._send(503, {"error": str(e)})
        if self.path != "/health":
            return self._send(404, {"error": "not found"})
        try:
            r = resolver()
            with _lock, r.conn.cursor() as cur:
                cur.execute("SELECT nodes, edges, components, largest_pct "
                            "FROM dl_topology_report")
                nodes, edges, comps, pct = cur.fetchone()
            self._send(200, {"ok": True, "geo": r.geo.source, "nodes": nodes,
                             "edges": edges, "components": comps,
                             "largest_pct": float(pct)})
        except Exception as e:
            self._send(503, {"ok": False, "error": str(e)})

    def do_POST(self):
        if self.path not in ("/resolve", "/route"):
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n < 1 or n > 4096:
                raise ValueError("body must be 1..4096 bytes")
            req = json.loads(self.rfile.read(n) or b"{}")
            if self.path == "/resolve":
                ip = str(ipaddress.IPv4Address(req["ip"]))
                rtt = float(req["rtt_ms"])
                if not math.isfinite(rtt) or not 0 < rtt <= 10_000:
                    raise ValueError("rtt_ms must be between 0 and 10000")
            else:
                points = []
                for key in ("source", "destination"):
                    point = req[key]
                    name = str(point["name"]).strip()
                    lat, lon = float(point["lat"]), float(point["lon"])
                    if (not name or len(name) > 80 or not math.isfinite(lat) or
                            not math.isfinite(lon) or not -90 <= lat <= 90 or
                            not -180 <= lon <= 180):
                        raise ValueError("cities need a name and valid coordinates")
                    points.append({"name": name, "lat": lat, "lon": lon})
                if points[0]["lat"] == points[1]["lat"] and points[0]["lon"] == points[1]["lon"]:
                    raise ValueError("choose two different cities")
        except Exception as e:
            return self._send(400, {"error": "bad request: %s" % e})

        try:
            with _lock:
                out = (resolver().resolve(ip, rtt) if self.path == "/resolve"
                       else resolver().between(*points))
        except Exception as e:
            return self._send(500, {"error": str(e)})
        self._send(200, out)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8081"))
    print("resolver listening on :%d" % port, flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
