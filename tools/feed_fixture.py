#!/usr/bin/env python3
"""Feed the stream server's :9000 line protocol from tests/fixture_dests.json.

This stands in for the eBPF tap, which needs a Linux host and a real WAN
interface. Everything downstream of it is the real thing: the resolver does
the actual geolocation, cable-graph routing and RTT plausibility check, and
the stream server does the real aggregation and framing.

The RTTs come from the fixture and are synthetic. The routes the resolver
draws from them are not.

  python3 tools/feed_fixture.py [--host 127.0.0.1] [--port 9000] [--rate 24]
"""
import argparse
import json
import os
import random
import socket
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "..", "tests", "fixture_dests.json")

p = argparse.ArgumentParser()
p.add_argument("--host", default="127.0.0.1")
p.add_argument("--port", type=int, default=9000)
p.add_argument("--rate", type=float, default=24.0, help="rtt lines per second")
a = p.parse_args()

dests = json.load(open(FIXTURE))["destinations"]
print("%d destinations from %s" % (len(dests), os.path.normpath(FIXTURE)))

s = socket.create_connection((a.host, a.port), timeout=5)
s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
print("connected to %s:%d, %.0f lines/sec -- ctrl-c to stop" % (a.host, a.port, a.rate))

period = 1.0 / a.rate
n = 0
quic = 0
try:
    while True:
        d = dests[n % len(dests)]
        # Small jitter keeps the demo from feeling frozen.
        base = d["rtt_ms"]
        rtt_us = int((base - base % 10 + random.uniform(0, 9.9)) * 1000)
        out = "rtt dst=%s rtt_us=%d\n" % (d["ip"], rtt_us)
        # Bytes are what set line thickness on the wall. Weight the CDNs
        # heavier than the long-haul endpoints so the picture has hierarchy.
        if n % 3 == 0:
            out += "vol dst=%s bytes=%d\n" % (d["ip"], random.randint(1500, 240000))
        # QUIC is the traffic the tap can see the volume of but not the RTT
        # of, which is what the "unmeasured" figure on the wall reports.
        if n % 40 == 0:
            quic += random.randint(50000, 400000)
            out += "stat quic_bytes=%d\n" % quic
        s.sendall(out.encode())
        n += 1
        if n % 200 == 0:
            print("  %d rtt lines sent" % n, flush=True)
        time.sleep(period)
except KeyboardInterrupt:
    print("\nstopped after %d lines" % n)
except (BrokenPipeError, ConnectionResetError):
    print("stream server closed the connection after %d lines" % n, file=sys.stderr)
    sys.exit(1)
finally:
    s.close()
