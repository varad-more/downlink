# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People exploring how modeled internet signals could travel between cities on
an interactive desktop map. The same interface also runs as an ambient wall
projection for an audience watching live network traffic.

## Product Purpose

Downlink makes global data movement understandable. A user selects two cities,
compares named candidate infrastructure routes, and follows the selected signal
across the map. Live mode visualizes aggregated traffic leaving the configured
home network.

Success means the source, destination, selected route, alternatives, cable
names, distance, and modeled latency can be understood within seconds.

## Positioning

Downlink connects animated traffic and city-to-city exploration to named,
mapped submarine-cable infrastructure while explicitly distinguishing modeled
candidates from measured packet routes.

## Operating Context

- Interactive desktop use is primary.
- Large-screen projector display is secondary and retains keystone calibration.
- The interface may run offline with local map assets.
- Live traffic remains available as a secondary mode.

## Capabilities and Constraints

- Users choose from supported cities and compare up to three candidate routes.
- All returned candidates remain visible; only the selected route animates.
- The map supports pan, zoom, touch gestures, route refitting, and responsive UI.
- Cable and landing data comes from a dated TeleGeography snapshot in `data/`.
- Route geometry, terrestrial connections, confidence, and latency are modeled.
- The product must not claim to know a packet's actual route or cable status.
- No hosted map, font, tile service, or API key is required by the kiosk.
- The WebGL trip store and client queues stay bounded for long-running display.

## Brand Commitments

The product name is Downlink. Its voice is direct, technically precise, and
honest about inference. Network terminology is permitted when immediately
understandable in context.

## Evidence on Hand

- Working topology, resolver, stream, and map code in this repository.
- Named cable and landing-point data in the local PostGIS graph.
- Synthetic fixture traffic is labeled and never presented as measurement.
- Automated phase gates cover parsing, routing, boundedness, geometry, and
  production builds; real hardware and browser/GPU inspection remain manual.

## Product Principles

1. Show the route before explaining the system.
2. Make uncertainty visible instead of hiding it behind visual confidence.
3. Keep map interaction familiar and recovery obvious.
4. Prefer legible geography and route hierarchy over ambient decoration.
5. Preserve reliable offline and long-running operation.

## Accessibility & Inclusion

Keyboard access, visible focus, semantic control labels, reduced-motion support,
zoom support, readable contrast, and touch-sized targets are required.
