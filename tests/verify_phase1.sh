#!/usr/bin/env bash
# Phase 1 gate: run the checked-in fixture through the real BPF bytecode and
# diff against the expected output.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose --profile tools build replay >&2
got=$(docker compose --profile tools run --rm --no-TTY replay 2>/dev/null)

if diff -u tests/expected_phase1.txt <(printf '%s\n' "$got"); then
    echo
    echo "PHASE 1 PASS: 7 rtt events, 8 volume rows, counters exact."
else
    echo
    echo "PHASE 1 FAIL: output above differs from tests/expected_phase1.txt" >&2
    exit 1
fi
