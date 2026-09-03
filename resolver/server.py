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
import queue
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psycopg

from resolve import build

# A psycopg connection cannot be used by two threads at once, which is what
# the single global lock here used to protect. But a lock serialises the work
# as well as the socket: a /network export -- the whole cable atlas -- would
# hold it for the duration and block a health check behind it. A small pool
# bounds Postgres connections without serialising anything.
#
# dl_routable_nodes (resolve.py) is a TEMP table, so it is per-connection and
# each pooled Resolver builds its own on first use.
#
# LIFO, not FIFO. Slots are built lazily, and a returned connection goes back
# on top, so a quiet gateway reuses one warm connection and never builds the
# other three. A plain FIFO Queue hands out a cold slot every time and opens
# all POOL_SIZE connections in the first POOL_SIZE requests, buying concurrency
# it was never going to use. tests/resolver_pool.py covers this.
POOL_SIZE = max(1, int(os.environ.get("DOWNLINK_POOL_SIZE", "4")))
_pool: queue.LifoQueue = queue.LifoQueue()
for _ in range(POOL_SIZE):
    _pool.put(None)


@contextmanager
def borrow():
    """Lend one Resolver, then return it to the pool.

    A connection that died -- Postgres restarted, the container was replaced,
    the network blipped -- is closed and NOT returned. The slot goes back
    empty and the next borrower rebuilds it. Without this the process holds a
    dead socket forever and every later request 500s until someone notices.
    """
    r = _pool.get()
    try:
        if r is None:
            r = build()
        yield r
    except psycopg.OperationalError:
        if r is not None:
            try:
                r.conn.close()
            except Exception:
                pass
            r = None
        raise
    finally:
        _pool.put(r)


def call(fn):
    """Run fn(Resolver) on a pooled connection, retrying once.

    The retry is what makes a Postgres restart cost one request instead of
    one per pool slot: the first attempt evicts the dead connection, the
    second gets a fresh one. Only OperationalError is retried -- a bad query
    or a bug would fail identically the second time.
    """
    for attempt in (1, 2):
        try:
            with borrow() as r:
                return fn(r)
        except psycopg.OperationalError:
            if attempt == 2:
                raise


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

    @staticmethod
    def _health(r):
        with r.conn.cursor() as cur:
            cur.execute("SELECT nodes, edges, components, largest_pct "
                        "FROM dl_topology_report")
            nodes, edges, comps, pct = cur.fetchone()
        return {"ok": True, "geo": r.geo.source, "nodes": nodes,
                "edges": edges, "components": comps, "largest_pct": float(pct)}

    def do_GET(self):
        if self.path == "/network":
            try:
                return self._send(200, call(lambda r: r.network()))
            except Exception as e:
                return self._send(503, {"error": str(e)})
        if self.path != "/health":
            return self._send(404, {"error": "not found"})
        try:
            self._send(200, call(self._health))
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
            out = call(lambda r: r.resolve(ip, rtt) if self.path == "/resolve"
                       else r.between(*points))
        except Exception as e:
            return self._send(500, {"error": str(e)})
        self._send(200, out)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8081"))
    print("resolver listening on :%d (pool %d)" % (port, POOL_SIZE), flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
