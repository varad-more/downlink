#!/usr/bin/env python3
"""Export every supported directed city pair for the static web demo."""
import argparse
import concurrent.futures
import datetime
import json
import pathlib
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
CITIES_FILE = ROOT / "phase4/src/cities.json"
DEFAULT_OUTPUT = ROOT / "phase4/public/routes"


def fetch(url, source, destination):
    body = json.dumps({"source": source, "destination": destination}).encode()
    request = urllib.request.Request(
        url, data=body, headers={"content-type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                route = json.load(response)
            break
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")
            if error.code < 500 or attempt == 2:
                raise RuntimeError(
                    f"{source['id']}:{destination['id']}: HTTP {error.code} {detail}") from error
            time.sleep(attempt + 1)
    if route.get("source", {}).get("name") != source["name"] or not route.get("path"):
        raise ValueError(f"invalid route response for {source['id']}:{destination['id']}")
    return f"{source['id']}:{destination['id']}", route


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:8080/api/route")
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    cities = json.loads(CITIES_FILE.read_text())
    pairs = [(source, destination) for source in cities for destination in cities
             if source["id"] != destination["id"]]
    routes = {city["id"]: {} for city in cities}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        jobs = [pool.submit(fetch, args.url, source, destination)
                for source, destination in pairs]
        for count, job in enumerate(concurrent.futures.as_completed(jobs), 1):
            key, route = job.result()
            source_id, destination_id = key.split(":", 1)
            routes[source_id][destination_id] = route
            if count % 40 == 0 or count == len(jobs):
                print(f"exported {count}/{len(jobs)} routes", flush=True)

    metadata = {
        "schema": 1,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "topology_source": "TeleGeography Submarine Cable Map API snapshot",
        "license": "CC BY-SA 4.0",
    }
    args.output.mkdir(parents=True, exist_ok=True)
    for source_id, source_routes in routes.items():
        path = args.output / f"{source_id}.json"
        path.write_text(json.dumps({**metadata, "routes": source_routes},
                                   ensure_ascii=False, separators=(",", ":"),
                                   sort_keys=True) + "\n")
    expected = {f"{city['id']}.json" for city in cities} | {"index.json"}
    for stale in args.output.glob("*.json"):
        if stale.name not in expected:
            stale.unlink()
    manifest = {**metadata, "cities": cities, "pair_count": len(pairs)}
    (args.output / "index.json").write_text(json.dumps(
        manifest, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n")
    size = sum(path.stat().st_size for path in args.output.glob("*.json"))
    print(f"wrote {len(cities)} route shards ({size:,} bytes)")


if __name__ == "__main__":
    main()
