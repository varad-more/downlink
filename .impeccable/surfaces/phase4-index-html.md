---
version: 1
slug: "phase4-index-html"
primary_target: "phase4/index.html"
related_targets: ["phase4/src/App.tsx","phase4/src/trace.tsx","phase4/public/basemap/style.json"]
---

## Scope

- Surface: `phase4/index.html` and its route explorer UI.
- Mode: Operate.
- Audience: people comparing plausible signal paths between cities; projector viewers are secondary.
- Job: select two cities, trace candidates, compare their physical infrastructure, and focus the map.
- Primary action: Trace route.
- Proof: real local route API output, named cable systems, distance, latency floor, confidence, and explicit inference language.

## Approved direction

- Comp: `.impeccable/mocks/route-chart-split-workspace.png`.
- Direction: a 34/66 split chart-table workspace, with the route planner and comparison ledger at left and the Atlantic-scale map dominant at right.
- Memorable moment: three colored paths remain visible together; only the selected route carries the moving signal, while solid and dashed spans explain mapped submarine versus modeled terrestrial infrastructure.
- Do not literalize the comp's invented cable names, landing labels, or basemap detail. Runtime facts must come from the resolver, and the local Natural Earth map remains the geographic source.

## Implementation inventory

| Visible ingredient | Medium | Commitment |
| --- | --- | --- |
| Fixed left planning ledger | Semantic React + CSS | 30–34% desktop width; mobile bottom sheet; no floating-card pile |
| City selectors and trace action | Native form controls | Large hit targets, keyboard focus, clear loading/error states |
| Three route choices | Semantic buttons + CSS | Stable vermilion, cobalt, and sea-green identity; active choice has stronger border and selected state |
| Dominant interactive map | Existing MapLibre/WebGL | Pale mineral sea, chalk land, fine graticule, familiar zoom/pan/recenter |
| Candidate route geometry | deck.gl | All candidates visible; inactive paths retain hue at reduced width/opacity |
| Infrastructure encoding | deck.gl PathLayer | Mapped submarine solid; modeled terrestrial dashed; explicit text legend |
| Selected signal | Existing TripsLayer | Only selected candidate animates, in its route color; honor reduced motion |
| Landing transitions | deck.gl points | Small color-keyed station markers at submarine segment endpoints |
| Source/destination labels | Semantic overlay | Clear navy endpoint markers that remain readable on the pale map |
| Brand and operating status | Semantic HTML/CSS | Restrained ship-chart typography; live traffic stays available but secondary |

## Unresolved decisions

- None blocking. Country and ocean labels remain omitted until a verified local label dataset exists.
