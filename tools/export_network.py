#!/usr/bin/env python3
"""Export the complete cable and modeled terrestrial network for static use."""
import argparse
import datetime
import json
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:8080/api/network")
    parser.add_argument("--output", type=pathlib.Path,
                        default=ROOT / "phase4/public/network.json")
    args = parser.parse_args()
    with urllib.request.urlopen(args.url, timeout=90) as response:
        network = json.load(response)
    if network.get("schema") != 1 or not network.get("cables", {}).get("features"):
        raise ValueError("invalid network response")
    network["generated_at"] = datetime.datetime.now(
        datetime.timezone.utc).isoformat()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(network, ensure_ascii=False,
                                    separators=(",", ":"), sort_keys=True) + "\n")
    temporary.replace(args.output)
    print("wrote %s (%s cables, %s land links, %s landing points)" % (
        args.output, len(network["cables"]["features"]),
        len(network["terrestrial"]["features"]),
        len(network["landings"]["features"])))


if __name__ == "__main__":
    main()
