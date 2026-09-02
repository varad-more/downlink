#!/usr/bin/env bash
# Phase 4 gate, headless portion.
#
# What this proves: the kiosk builds for production, the trip ring buffer stays
# bounded and flat over a simulated hour, the geometry wraps correctly, and
# the built bundle reaches for nothing outside itself.
#
# What it does NOT prove: WebGL rendering, frame timings, or real browser
# heap behaviour. That needs the browser soak -- see README, one command,
# and it is an operator step because it needs a GPU and an hour.
#
# Needs Node >= 22 on the host (type stripping). You need it to develop the
# kiosk anyway.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "--- production build ---"
( cd phase4 && npm ci --no-audit --no-fund >/dev/null && npx tsc -b && npx vite build )

# Route segments use flat lon/lat buffers. Without XY, deck.gl assumes XYZ
# and pairs unrelated coordinates into the long zigzags this test prevents.
grep -q 'positionFormat: "XY"' phase4/src/App.tsx || {
    echo "FAIL: flat route segments must declare deck.gl positionFormat XY"
    exit 1
}

python3 - <<'PY'
import json
from pathlib import Path

cities = json.load(open("phase4/src/cities.json"))
routes = {}
for source in cities:
    snapshot = json.load(open("phase4/public/routes/%s.json" % source["id"]))
    assert snapshot.get("schema") == 1, "route snapshot schema changed"
    assert len(snapshot.get("routes", {})) == len(cities) - 1, \
        "%s route shard is incomplete" % source["id"]
    routes.update((source["id"] + ":" + destination, route)
                  for destination, route in snapshot["routes"].items())
expected = len(cities) * (len(cities) - 1)
assert len(routes) == expected, "route snapshot must cover all %d directed pairs" % expected
for key, best in routes.items():
    candidates = [best] + best.get("alternatives", [])
    assert best.get("path") and candidates, "%s has no candidates" % key
    for candidate in candidates:
        assert candidate.get("path") and isinstance(candidate.get("segments"), list), \
            "%s candidate is not drawable" % key
        assert all(len(segment.get("path", [])) >= 2
                   for segment in candidate["segments"]), \
            "%s has a segment without geometry" % key
        for first, second in zip(candidate["segments"], candidate["segments"][1:]):
            a, b = first["path"][-1], second["path"][0]
            assert abs(a[0] - b[0]) < .001 and abs(a[1] - b[1]) < .001, \
                "%s has a visible segment gap between %s and %s" % \
                (key, first["name"], second["name"])
tempe_london = [routes["tempe:london"]] + routes["tempe:london"]["alternatives"]
assert len(tempe_london) == 3, "Tempe-to-London must retain three candidates"
assert all({segment["kind"] for segment in route["segments"]}
           >= {"submarine", "terrestrial"} for route in tempe_london), \
    "Tempe-to-London must retain land/sea classifications"
sf_tokyo = [routes["san-francisco:tokyo"]] + routes["san-francisco:tokyo"]["alternatives"]
trunks = {max((segment for segment in route["segments"]
              if segment["kind"] == "submarine"), key=lambda segment: segment["km"])["name"]
          for route in sf_tokyo}
assert len(sf_tokyo) >= 2 and len(trunks) >= 2, \
    "San Francisco-to-Tokyo must expose distinct Pacific cable crossings"

network = json.load(open("phase4/public/network.json"))
assert network.get("schema") == 1, "network snapshot schema changed"
assert len(network["cables"]["features"]) >= 700, "network cable database is incomplete"
assert len(network["landings"]["features"]) >= 1900, "landing database is incomplete"
assert len(network["terrestrial"]["features"]) >= 100, "modeled land network is incomplete"
print("ok: static snapshot covers %d city pairs plus the global cable network" % expected)
PY

echo
echo "--- self-containment ---"
# The installation may have no internet. A single hosted style URL or CDN
# font reference turns the wall black, and it will not be noticed until
# opening night.
#
# Two different questions, checked differently:
#
#  (a) Our own assets. Anything external here is a hard failure -- these are
#      files we wrote and they are fetched unconditionally at load.
#  (b) The vendored bundle. deck.gl and luma.gl carry CDN strings for things
#      that are lazy-loaded and, in this app, never triggered. Those are
#      allow-listed BY NAME below, so a new one -- a Google Font, a tile
#      server someone added at 2am -- still fails the gate.
#
# Neither check proves the page makes no network request at runtime. That is
# what the browser soak with DevTools set to Offline is for.
PATTERN='mapbox://|api\.mapbox\.com|api\.maptiler\.com|demotiles\.maplibre\.org|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com'

OWN=$(grep -roE "$PATTERN" phase4/public phase4/dist/index.html phase4/dist/basemap 2>/dev/null || true)
if [ -n "$OWN" ]; then
    echo "FAIL: our own assets reference external hosts:"
    echo "$OWN"
    exit 1
fi
echo "ok: no external host references in our own assets"

# Allow-listed dormant references inside the vendored bundle.
ALLOWED='unpkg\.com/@loaders\.gl|cdn\.jsdelivr\.net/npm/spectorjs|unpkg\.com/webgl-debug'
UNKNOWN=$(grep -oE "https://($PATTERN)[^\"'\'']*" phase4/dist/assets/*.js 2>/dev/null \
          | grep -vE "$ALLOWED" | sort -u || true)
if [ -n "$UNKNOWN" ]; then
    echo "FAIL: unrecognised external host in the bundle:"
    echo "$UNKNOWN"
    echo "If this is legitimately dormant, add it to ALLOWED with a reason."
    exit 1
fi
echo "ok: bundle CDN references limited to the known dormant set:"
echo "    unpkg.com/@loaders.gl      loaders.gl worker CDN; no loader runs in this app"
echo "    cdn.jsdelivr.net/spectorjs luma.gl debug capture; needs ?spector"
echo "    unpkg.com/webgl-debug      luma.gl debug; needs a debug flag"

echo
echo "--- trip store soak + geometry ---"
node --experimental-strip-types --expose-gc tests/kiosk_soak.ts
