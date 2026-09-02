# Downlink

Downlink is an interactive network-route map and an optional ambient wall
projection. Its three-tab workspace lets you compare named **candidate
routes**, browse the global cable network, and inspect the underlying data and
modeling limits.

It does not claim to know the physical route of a packet. Public Internet
measurements cannot normally prove which terrestrial fibre, exchange, or
submarine cable an operator used.

```
city explorer -> static route snapshot -> interactive map

WAN interface -> eBPF tap -> resolver/PostGIS -> JSON WebSocket -> live wall
```

## What the wall means

- A pulse is observed traffic, aggregated by destination city.
- Travel time is proportional to the measured TCP handshake RTT.
- Width is proportional to bytes seen in the last two seconds.
- Brightness is the confidence of the route inference.
- Cyan is a named route through mapped infrastructure.
- Amber is a great-circle fallback.
- Magenta is an anycast endpoint reclassified near home by its RTT.

Cable and landing names are factual properties of the map. Their use by a
particular flow is still an inference.

## Architecture

### Tap

`tap/` attaches one tc/eBPF program to ingress and egress on the WAN-facing
interface of an inline Linux gateway. It emits:

```
rtt dst=1.1.1.1 rtt_us=12000
vol dst=1.1.1.1 bytes=2048
stat pkts=... ipv6_bytes=... quic_bytes=... rtt_emitted=...
```

The tap reads no payload and emits no source address, source identifier, or
port. It records one RTT per TCP connection from SYN to SYN-ACK. UDP/443 and
IPv6 byte totals are counted as visible-but-unmeasured traffic.

Attach to the WAN side of a NAT gateway. Egress must see the post-SNAT tuple
and ingress the matching pre-DNAT tuple. A mirror port sends everything through
ingress and therefore cannot measure the handshake with this program.

Replay mode drives a pcap through the same BPF bytecode with
`BPF_PROG_TEST_RUN`; it is not a second userspace parser.

### Topology and resolver

`topo/` turns TeleGeography cable geometry into a routable PostGIS/pgRouting
graph:

- Nodes are published landing stations and a small set of metro anchors.
- Submarine edges retain their published cable ID and name.
- Cable crossings are not connections.
- Terrestrial edges are explicitly modeled links, never named carrier fibre.
- Cost is distance plus a terrestrial/station penalty.

`resolver/` geolocates the destination, finds up to three shortest distinct
candidate routes with `pgr_KSP`, rejects candidates that exceed the measured
speed-of-light budget, and returns the best route plus alternatives.

Example route metadata:

```json
{
  "method": "route",
  "route_name": "via Cable A -> Cable B",
  "segments": [
    {"kind": "terrestrial", "name": "modeled terrestrial connection"},
    {"kind": "submarine", "name": "Cable A", "cable_id": "cable-a"}
  ],
  "alternatives": []
}
```

The loader skips features marked `is_tbd`, but the public geometry still does
not prove current operational status, capacity, outages, or commercial routing
rights. Downlink therefore says **mapped candidate**, not **available live
path**.

### Stream

`stream/` accepts tap lines on TCP `:9000`, resolves destinations, aggregates
them by city over a trailing two-second window, and emits JSON deltas at 8 Hz
on WebSocket `:9001`.

All collections and client queues are bounded. Slow clients lose old frames
instead of growing memory. Operator statistics are available locally on
`http://127.0.0.1:9002/stats`.

### Kiosk

`phase4/` is a local MapLibre/deck.gl projection. It uses no hosted map style,
font, tile server, or API key. A fixed-capacity typed-array trip store keeps a
24/7 display bounded.

The on-map explorer lets a user choose two cities and compare up to three named
candidate routes at once. Route 1 is vermilion, route 2 cobalt, and route 3 sea
green; inactive routes are muted while only the selected route pulses. Solid
spans are mapped submarine cables. Dashed spans are modeled terrestrial
connections and short landing-station handoffs. The Network atlas tab exposes
all mapped cable systems, landing points, and modeled terrestrial graph links.
The Data tab records the source, license, counts, and limits. Its latency is a
fibre propagation floor, not a measurement.

Every supported city pair is checked into source-sharded files under
`phase4/public/routes/`, so a browser downloads routes for only the selected
source city. `phase4/public/network.json` contains the static global atlas. The
browser uses these snapshots whenever the resolver is absent, so the complete
workspace works locally and on GitHub Pages without Docker.

Press `k` to drag four keystone-correction handles, `r` to reset, and `k` again
to save. Calibration is stored in browser local storage.

## Run the route explorer — no Docker

Only Node 22+ is required.

```sh
npm --prefix phase4 install
make dev
```

Open `http://localhost:5173`. The bundled snapshot contains all 930 directed
pairs between the 31 supported cities.

## Rebuild the topology or run live traffic

Docker is required only for maintainers refreshing the cable graph or for the
gateway capture pipeline.

```sh
cp .env.example .env
make fetch-data
make load-topo
make up
make snapshot-routes
make snapshot-network
make kiosk
```

Open `http://localhost:8080` for the containerized build.

The fixture feed uses invented RTTs. The kiosk labels its built-in hosted demo
as synthetic and never pretends that it is live traffic.

## Run on a gateway

The supported target is Debian 12 on an inline Linux gateway with kernel
`>= 5.15`, BTF, `clsact`, and the BPF/PERFMON/NET_ADMIN capabilities described
in `docker-compose.yml`.

```sh
cp .env.example .env
# set DOWNLINK_WAN_IFACE in .env
make load-topo
make up
make run
make kiosk
```

The default home coordinate is Tempe, Arizona. Set `DOWNLINK_HOME_LAT` and
`DOWNLINK_HOME_LON` in `.env`; set `?home=Name&lat=...&lon=...` on the kiosk URL
to keep its label and camera aligned.

For real destination geolocation, mount a MaxMind GeoLite2 City database and
set `DOWNLINK_GEOIP_DB`. Without it the checked-in fixture is used, which is
only suitable for tests and demonstrations.

## Data

`make fetch-data` downloads:

- TeleGeography cable geometry and landing stations, CC BY-SA 4.0.
- Natural Earth 110m land is checked in and public domain.

Downloaded cable data lives in ignored `data/`; `data/SOURCES.md` records its
source and retrieval time. The checked-in route snapshot is a derived work and
retains TeleGeography attribution under CC BY-SA 4.0.

## Verification

```sh
make verify-phase1  # real BPF bytecode against the pcap fixture
make verify-phase2  # named candidates and physical invariants
make verify-phase3  # bounded stream and slow-client backpressure
make verify-phase4  # production build, offline assets, one-hour store soak
make verify-all
```

The headless kiosk gate cannot validate WebGL, GPU memory, or projector output.
For that, run:

```sh
make kiosk
open 'http://localhost:8080/?soak=1&speed=10'
```

Leave it running offline for an hour while watching the HUD. The remaining
hardware and modeling checks are in `docs/known-unknowns.md`.

## Deliberate limits

- No exact physical packet path without operator telemetry.
- No reverse-path inference; RTT is round trip.
- No continuous RTT for long-lived TCP connections.
- No QUIC RTT measurement.
- No IPv6 path inference yet; its bytes are counted.
- No operational cable status or capacity claim.
- Terrestrial links and metro anchors are modeling aids.

## License

MIT, except `tap/`, which remains GPL-2.0 as marked in its source files.
TeleGeography data is CC BY-SA 4.0 and Natural Earth data is public domain.
Barlow Condensed is licensed under the SIL Open Font License 1.1; its license
is checked in at `phase4/public/fonts/OFL.txt`.
