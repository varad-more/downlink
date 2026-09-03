#!/usr/bin/env bash
# Phase 2 gate: resolve 20 fixture destinations plus one selected city pair,
# then assert the classification and physical invariants.
#
# Exact geometry is NOT asserted. The cable data is fetched live from
# TeleGeography and legitimately changes between retrievals; pinning path_km
# would make this gate fail on a data refresh rather than on a regression.
# What is asserted is the logic: the three branches, and the invariants that
# must hold whatever the cable set looks like.
set -euo pipefail
cd "$(dirname "$0")/.."

# Connection pool first: stdlib-only, no Docker, ~1s. If borrow/evict/retry is
# broken there is no point building an image to find out.
python3 tests/resolver_pool.py

docker compose build resolver >&2
docker compose run --rm --no-TTY --entrypoint "" resolver \
    python -u resolve.py /tests/fixture_dests.json 2>/dev/null > /tmp/dl_phase2.jsonl
docker compose run --rm --no-TTY --entrypoint "" resolver python -c \
    'import json; from resolve import build; print(json.dumps(build().between({"name":"Tempe, AZ","lat":33.4255,"lon":-111.94},{"name":"London, UK","lat":51.51,"lon":-0.13})))' \
    2>/dev/null > /tmp/dl_between.json
docker compose run --rm --no-TTY --entrypoint "" resolver python -c \
    'import json; from resolve import build; print(json.dumps(build().between({"name":"San Francisco, CA","lat":37.7749,"lon":-122.4194},{"name":"Tokyo, JP","lat":35.68,"lon":139.69})))' \
    2>/dev/null > /tmp/dl_pacific.json
docker compose exec -T db psql -U postgres -d downlink -Atc \
    "SELECT count(*) FILTER (WHERE ST_NumGeometries(geom) > 1), count(*), (SELECT ST_NumGeometries(geom) FROM cables_raw WHERE id='2africa'), (SELECT count(*) FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.kind='terrestrial' AND (s.kind='junction' OR t.kind='junction')) FROM cables_raw" \
    > /tmp/dl_cables.txt

python3 - /tmp/dl_phase2.jsonl /tmp/dl_between.json /tmp/dl_pacific.json /tmp/dl_cables.txt <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.startswith("{")]
by = {r["ip"]: r for r in rows}
between = json.load(open(sys.argv[2]))
pacific = json.load(open(sys.argv[3]))
multipart_cables, cable_ids, africa_parts, ocean_land_links = map(
    int, open(sys.argv[4]).read().strip().split("|"))
fail = []

def check(cond, msg):
    if not cond:
        fail.append(msg)

check(len(rows) == 20, "expected 20 resolved rows, got %d" % len(rows))
check(cable_ids >= 700 and multipart_cables >= 20 and africa_parts >= 40,
      "cable import lost split source features (%d IDs, %d multipart, "
      "2Africa=%d parts)" % (cable_ids, multipart_cables, africa_parts))
check(ocean_land_links == 0,
      "antimeridian junctions must never be joined by modeled land links")

# --- the three branches, each covered deliberately ---
check(by["1.1.1.1"]["method"] == "pop" and
      by["1.1.1.1"]["reason"] == "anycast-reclassified",
      "1.1.1.1 (geo Sydney, 12ms) must reclassify as a local PoP, got %r/%r"
      % (by["1.1.1.1"]["method"], by["1.1.1.1"].get("reason")))

check(by["192.0.2.55"]["method"] == "greatcircle" and
      by["192.0.2.55"]["reason"] == "no-graph-entry",
      "192.0.2.55 (Almaty, deep interior) must fall back to great-circle, "
      "got %r/%r" % (by["192.0.2.55"]["method"], by["192.0.2.55"].get("reason")))

check(by["202.12.27.33"]["method"] == "route" and
      by["202.12.27.33"]["path_km"] <= by["202.12.27.33"]["budget_km"],
      "202.12.27.33 (Sydney, 178ms) should use the repaired Pacific graph, "
      "got %r/%r" % (by["202.12.27.33"]["method"], by["202.12.27.33"].get("reason")))

n_route = sum(1 for r in rows if r["method"] == "route")
check(n_route >= 15, "expected >=15 mapped routes, got %d" % n_route)

check(between["method"] == "route", "city-to-city query did not map a route")
check(between["source"]["name"] == "Tempe, AZ" and
      between["destination"]["name"] == "London, UK",
      "city-to-city endpoints changed")
check(between.get("route_name") and len(between["path"]) >= 2,
      "city-to-city route is unnamed or has no path")
check(between["estimated_rtt_ms"] > 0 and between["path_km"] >= between["gc_km"] * .99,
      "city-to-city distance/latency estimate is invalid")
city_candidates = [between] + between.get("alternatives", [])
check(any(segment["kind"] == "submarine" and segment["km"] > 3000
          for candidate in city_candidates for segment in candidate["segments"]),
      "Tempe-to-London candidates contain no Atlantic-scale cable crossing")
check(all(isinstance(segment.get("path"), list) and len(segment["path"]) >= 2
          for candidate in city_candidates for segment in candidate["segments"]),
      "Tempe-to-London segment geometry is missing")
check(all({segment["kind"] for segment in candidate["segments"]}
          >= {"submarine", "terrestrial"} for candidate in city_candidates),
      "Tempe-to-London candidates do not distinguish sea and land spans")
check(len({tuple(candidate["cables"]) for candidate in city_candidates}) >= 2,
      "Tempe-to-London alternatives repeat the same cable route")

pacific_candidates = [pacific] + pacific.get("alternatives", [])
pacific_trunks = {
    max((segment for segment in candidate["segments"]
         if segment["kind"] == "submarine"), key=lambda segment: segment["km"])["name"]
    for candidate in pacific_candidates
}
check(pacific["method"] == "route" and len(pacific_candidates) >= 2,
      "San Francisco-to-Tokyo needs multiple mapped Pacific candidates")
check(len(pacific_trunks) >= 2,
      "San Francisco-to-Tokyo alternatives must use distinct ocean crossings")
for candidate in city_candidates + pacific_candidates:
    for first, second in zip(candidate["segments"], candidate["segments"][1:]):
        a, b = first["path"][-1], second["path"][0]
        check(abs(a[0] - b[0]) < .001 and abs(a[1] - b[1]) < .001,
              "%s to %s has a visible line gap" % (first["to"], second["from"]))

# --- invariants that must hold for every row ---
for r in rows:
    ip = r["ip"]
    check(0.0 <= r["confidence"] <= 1.0, "%s confidence out of range" % ip)
    check(r.get("path") and len(r["path"]) >= 2, "%s has no usable path" % ip)
    check(r["method"] != "unknown", "%s failed to geolocate" % ip)
    if r["method"] == "route":
        # The whole point of the speed-of-light check.
        check(r["path_km"] <= r["budget_km"],
              "%s: mapped path %.0f km exceeds light budget %.0f km"
              % (ip, r["path_km"], r["budget_km"]))
        check(r["path_km"] >= r["gc_km"] * 0.99,
              "%s: mapped path %.0f km is SHORTER than the great circle %.0f km"
              % (ip, r["path_km"], r["gc_km"]))
        check(r["confidence"] > 0.3,
              "%s: mapped route should out-score a fallback" % ip)
        check(r.get("route_name"), "%s: route is unnamed" % ip)
        check(len(r.get("route_name", "")) <= 160,
              "%s: route name is too long for the wall" % ip)
        check(isinstance(r.get("segments"), list), "%s: route has no segments" % ip)
        for segment in r.get("segments", []):
            check(isinstance(segment.get("path"), list) and len(segment["path"]) >= 2,
                  "%s: segment has no drawable geometry" % ip)
            if segment["kind"] == "submarine":
                check(segment.get("cable_id") and segment.get("name"),
                      "%s: submarine segment is unnamed" % ip)
        for alt in r.get("alternatives", []):
            check(alt["path_km"] <= r["budget_km"],
                  "%s: alternative exceeds light budget" % ip)
            check(alt.get("name") and len(alt["name"]) <= 160,
                  "%s: alternative is unnamed or too long" % ip)
    else:
        check(r["confidence"] <= 0.3,
              "%s: %s is an inference, it must not score like a route"
              % (ip, r["method"]))

from collections import Counter
c = Counter(r["method"] for r in rows)
print("methods: %s" % dict(c))
print("mean confidence (route): %.2f" %
      (sum(r["confidence"] for r in rows if r["method"] == "route") / max(n_route, 1)))
if fail:
    print("\nPHASE 2 FAIL:")
    for f in fail:
        print("  - " + f)
    sys.exit(1)
print("\nPHASE 2 PASS: 20/20 destinations plus Atlantic and Pacific city pairs "
      "resolved, all three branches covered, every named route continuous.")
PY
