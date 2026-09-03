.PHONY: help build sample-pcap verify-phase1 run clean pin-base probe \
	fetch-data fetch-basemap load-topo snapshot-routes verify-phase2 verify-phase3 verify-phase4 \
	snapshot-network verify-all up kiosk dev

help:
	@echo "make sample-pcap    regenerate tests/sample.pcap from tools/gen_sample_pcap.py"
	@echo "make build          build the tap image"
	@echo "make verify-phase1  Phase 1 gate (no NIC touched)"
	@echo "make run            attach to \$$DOWNLINK_WAN_IFACE and stream live"
	@echo "make probe          print the kernel feature probes the VERIFY notes ask for"
	@echo "make pin-base       print the base-image digest to pin in tap/Dockerfile"
	@echo "make fetch-data     download cable + landing point GeoJSON into data/"
	@echo "make fetch-basemap  refresh pinned Natural Earth 1:50m map geometry"
	@echo "make load-topo      load cables into PostGIS and build the routable graph"
	@echo "make verify-phase2  Phase 2 gate (20 fixture destinations)"
	@echo "make verify-phase3  Phase 3 gate (10 min load test, 500 events/sec)"
	@echo "make verify-phase4  Phase 4 gate (build and trip-store soak)"
	@echo "make verify-all     all four gates in order"
	@echo "make up             bring up db + resolver + stream"
	@echo "make kiosk          bring up the projection kiosk on :8080"
	@echo "make dev            run the full route explorer without Docker on :5173"
	@echo "make snapshot-routes refresh the static route snapshot from local :8080"
	@echo "make snapshot-network refresh the complete static cable/network atlas"

sample-pcap:
	python3 tools/gen_sample_pcap.py tests/sample.pcap

build:
	docker compose build tap

verify-phase1:
	./tests/verify_phase1.sh

run:
	docker compose up --build tap

probe:
	@echo '--- kernel + BTF ---'
	uname -r
	@test -r /sys/kernel/btf/vmlinux && echo 'BTF: present' || echo 'BTF: MISSING'
	@echo '--- bpf features ---'
	bpftool feature probe kernel 2>/dev/null | grep -E 'ringbuf|lru_hash|sched_cls|bpf_ktime_get_ns' || true
	@echo '--- clsact ---'
	tc qdisc add dev lo clsact 2>&1 && tc qdisc del dev lo clsact && echo 'clsact: ok'

pin-base:
	docker buildx imagetools inspect debian:bookworm-slim --format '{{.Manifest.Digest}}'

clean:
	docker compose down --remove-orphans
	$(MAKE) -C tap clean

# TeleGeography submarine cable data, CC BY-SA 4.0, attribution required in
# the projected output. Their public GitHub repo is no longer maintained; the
# live site API below is the source of record. Retrieval date is stamped into
# data/SOURCES.md so a rebuild is dated, not anonymous.
TG_BASE := https://www.submarinecablemap.com/api/v3
fetch-data:
	mkdir -p data
	curl -sSLf -o data/cable-geo.json         "$(TG_BASE)/cable/cable-geo.json"
	curl -sSLf -o data/landing-point-geo.json "$(TG_BASE)/landing-point/landing-point-geo.json"
	@printf 'TeleGeography submarine cable map, CC BY-SA 4.0\n%s/cable/cable-geo.json\n%s/landing-point/landing-point-geo.json\nretrieved: %s\n' \
		"$(TG_BASE)" "$(TG_BASE)" "$$(date -u +%Y-%m-%dT%H:%M:%SZ)" > data/SOURCES.md
	@cat data/SOURCES.md

NE_REV := ca96624a56bd078437bca8184e78163e5039ad19
NE_GEOJSON := https://raw.githubusercontent.com/nvkelso/natural-earth-vector/$(NE_REV)/geojson
fetch-basemap:
	curl -sSLf -o phase4/public/basemap/ne_50m_land.geojson "$(NE_GEOJSON)/ne_50m_land.geojson"
	curl -sSLf -o phase4/public/basemap/ne_50m_lakes.geojson "$(NE_GEOJSON)/ne_50m_lakes.geojson"
	curl -sSLf -o phase4/public/basemap/ne_50m_admin_0_boundary_lines_land.geojson "$(NE_GEOJSON)/ne_50m_admin_0_boundary_lines_land.geojson"

load-topo:
	docker compose up -d --build --wait db
	docker compose exec -T db psql -U postgres -d downlink \
		-f /docker-entrypoint-initdb.d/01_schema.sql
	docker compose --profile tools build topo-load
	docker compose --profile tools run --rm --no-TTY topo-load

snapshot-routes:
	python3 tools/export_routes.py

snapshot-network:
	python3 tools/export_network.py

dev:
	npm --prefix phase4 install --no-audit --no-fund
	npm --prefix phase4 run dev

verify-phase2:
	./tests/verify_phase2.sh

up:
	docker compose up -d --build db resolver stream

verify-phase3: up
	docker compose --profile tools build loadtest
	docker compose --profile tools run --rm --no-TTY loadtest

verify-phase4:
	./tests/verify_phase4.sh

kiosk:
	docker compose up -d --build kiosk
	@echo "kiosk: http://localhost:8080  (k = keystone calibration)"
	@echo "soak:  http://localhost:8080/?soak=1&speed=10"

verify-all: verify-phase1 verify-phase2 verify-phase3 verify-phase4
	@echo
	@echo "ALL FOUR GATES PASSED"
