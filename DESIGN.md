---
name: Downlink
description: A light cable-laying chart table for comparing plausible signal routes.
colors:
  navy-ink: "#0c2747"
  muted-navy: "#61778b"
  chart-hairline: "#ccd6da"
  ledger-paper: "#faf9f4"
  mineral-sea: "#d9edf5"
  chalk-land: "#f4f1e8"
  white: "#ffffff"
  route-vermilion: "#ed542d"
  route-cobalt: "#1769d2"
  route-sea-green: "#07966d"
typography:
  display:
    fontFamily: '"Downlink Display", ui-sans-serif, sans-serif'
    fontSize: "clamp(22px, 2.15vw, 32px)"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.13em"
  title:
    fontFamily: '"Downlink Display", ui-sans-serif, sans-serif'
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1
  body:
    fontFamily: 'Avenir, "Avenir Next", Futura, ui-sans-serif, sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.02em"
rounded:
  badge: "6px"
  control: "8px"
  card: "9px"
  sheet: "18px"
spacing:
  tight: "8px"
  compact: "12px"
  control: "16px"
  section: "24px"
components:
  trace-action:
    backgroundColor: "{colors.navy-ink}"
    textColor: "{colors.white}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
    height: "50px"
  trace-action-hover:
    backgroundColor: "#163d68"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
  city-select:
    backgroundColor: "{colors.white}"
    textColor: "{colors.navy-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 36px 0 13px"
    height: "48px"
  route-choice:
    backgroundColor: "rgba(255, 255, 255, 0.58)"
    textColor: "{colors.navy-ink}"
    rounded: "{rounded.card}"
    padding: "0 15px 0 0"
  route-choice-selected:
    backgroundColor: "{colors.white}"
    textColor: "{colors.navy-ink}"
    rounded: "{rounded.card}"
    padding: "0 15px 0 0"
  route-badge:
    textColor: "{colors.white}"
    rounded: "{rounded.badge}"
    size: "24px"
  route-badge-selected:
    textColor: "{colors.white}"
    rounded: "{rounded.badge}"
    size: "29px"
---

# Design System: Downlink

## Overview

**Creative North Star: "The Cable-Laying Chart Table"**

Downlink is a pale working chart: mineral-blue water, chalk land, navy instrument ink, and fine rules make route evidence feel plotted rather than decorated. The interface is restrained, technical, and daylight-legible, with the comparison ledger and geography reading as one continuous work surface.

Color carries meaning instead of atmosphere. Three stable route marks keep alternatives comparable, solid and dashed geometry separates mapped submarine infrastructure from modeled land connections, and motion belongs only to the selected signal.

**Key Characteristics:**

- Light nautical chart palette with high-contrast navy notation
- Condensed display type paired with plain controls and monospaced map annotations
- Fixed planning ledger beside a dominant interactive map
- Persistent candidate context with selected-only motion

## Colors

The palette combines warm paper and land with a cool mineral sea; dark navy establishes hierarchy while three saturated marks identify routes.

### Primary

- **Navy Instrument Ink** (#0c2747): Primary text, endpoint markers, the trace action, line legends, and control chrome.

### Secondary

- **Route Vermilion** (#ed542d): First candidate and its selected signal.
- **Route Cobalt** (#1769d2): Second candidate, keyboard focus, and connected status.
- **Route Sea Green** (#07966d): Third candidate and its selected signal.

### Tertiary

- **Mineral Sea** (#d9edf5): Edge-to-edge map field.
- **Chalk Land** (#f4f1e8): Landmass fill against the cool sea.

### Neutral

- **Ledger Paper** (#faf9f4): Planning surface, route casings, and label halos.
- **White** (#ffffff): Active cards and native field surfaces.
- **Muted Navy** (#61778b): Secondary copy, metrics, and attribution.
- **Chart Hairline** (#ccd6da): Dividers and quiet structural borders.

### Named Rules

**The Route Identity Rule.** Candidate order owns the vermilion, cobalt, and sea-green sequence everywhere; do not reuse those colors as interchangeable decoration.

## Typography

**Display Font:** Downlink Display / Barlow Condensed Semibold (with ui-sans-serif fallback)
**Body Font:** Avenir (with Avenir Next, Futura, and ui-sans-serif fallbacks)
**Label/Mono Font:** Platform monospace (with SFMono-Regular and Menlo fallbacks)

**Character:** Condensed uppercase display type gives the ledger a ship-instrument cadence. Neutral body text keeps native controls familiar, while compact monospace labels make map annotations read as measured notation.

### Hierarchy

- **Display** (600, 22–32px, line-height 1, letter-spacing 0.13em): Tightly led, widely tracked uppercase branding.
- **Title** (600, 17–18px, line-height 1–1.18): Condensed headings for route groups and candidate names.
- **Body** (400, 10–14px, line-height up to 1.55): Instructions, fields, empty states, and explanatory copy.
- **Label** (600–700, 10–11px, line-height 1.2–1.35): Compact monospaced map annotations; small uppercase sans-serif is reserved for form and route labels.

### Named Rules

**The Instrument Type Rule.** Use Barlow Condensed for identity and route naming, ordinary sans-serif for operation, and monospace only where text behaves like map or telemetry notation.

## Layout

Desktop uses a fixed 32vw planning ledger on the left and leaves the remaining map visible edge to edge. The ledger scrolls independently, with generous clamped padding, vertical section rules, and compact route-card rhythm; map controls remain in the lower-right corner.

At 1080px and below, the ledger becomes a full-width bottom sheet capped at 60vh, the three route choices form a compact row, secondary detail collapses, and map controls move above the sheet. At 540px and below, the sheet cap becomes 64vh and the infrastructure legend stacks to one column.

## Elevation & Depth

The system is flat by default. Depth is structural and sparse: a lateral shadow separates the fixed ledger from the map, the primary action lifts slightly, and map controls sit on an opaque paper surface. Candidate selection is expressed by border color and opacity rather than stronger elevation.

### Shadow Vocabulary

- **Ledger Separation** (`14px 0 38px rgba(0, 0, 0, 0.09)`): A wide, low-opacity shadow cast only toward the map.
- **Action Lift** (`0 5px 14px rgba(0, 0, 0, 0.14)`): A compact shadow under the primary trace action.
- **Map Control Lift** (`0 5px 18px rgba(0, 0, 0, 0.14)`): A restrained shadow that keeps controls legible over geography.

### Named Rules

**The Structural Depth Rule.** Shadows may separate working layers or protect controls from the map; they do not turn the ledger into a pile of floating cards.

## Shapes

Controls use gently rounded corners, route cards are only slightly softer, and the mobile ledger receives the largest radius at its exposed top edge. Route lines use rounded caps and joins; endpoint dots, landing stations, wave-like brand strokes, and square-numbered route badges provide the recurring chart geometry.

## Components

### Trace Action

- **Shape:** Full-width, gently rounded control with a 50px minimum height.
- **Color:** Navy fill with white label and icon; hover deepens the navy.
- **State:** Lifts by one pixel on hover, settles on press, shows a cobalt focus outline, and reduces opacity while loading.

### City Selects

- **Style:** Native 48px select controls on white with a cool gray border and navy text.
- **State:** The border darkens on hover and receives the shared cobalt focus outline.

### Text Actions

- **Style:** Borderless muted-blue text with an offset underline for Live view and Fit map; Swap remains an inline icon-and-label action.

### Route Choices

- **Style:** Each button pairs a saturated numbered rail with a translucent white body, condensed cable name, and tabular metrics.
- **State:** Inactive choices retain their assigned hue at lower opacity. Selection turns the body white, strengthens the route-colored border, and adds an explicit Selected label.

### Infrastructure Encoding

- **Mapped:** Submarine cable spans are solid.
- **Modeled:** Terrestrial and estimate spans are dashed.
- **Selection:** All candidates remain visible; the selected route is wider and fully opaque, and only its signal animates.

### Map Markers and Controls

- **Markers:** Navy source and destination dots use paper casings and high-contrast labels; route badges keep their candidate color and grow when selected.
- **Controls:** Familiar MapLibre controls sit in a rounded paper group with 42–44px targets.

## Do's and Don'ts

### Do:

- **Do** keep the map visually dominant and the route ledger contiguous with the viewport edge.
- **Do** preserve candidate color by route order across cards, badges, paths, landings, and animation.
- **Do** pair every infrastructure line style with explicit text and keep inference language visible.
- **Do** honor reduced motion and preserve visible keyboard focus.

### Don't:

- **Don't** convert the light chart table into a dark monitoring dashboard or a pile of floating glass cards.
- **Don't** animate inactive routes or hide alternatives when one route is selected.
- **Don't** imply that modeled terrestrial paths, candidate cables, or latency floors are measured packet routes.
- **Don't** add geographic labels until they come from a verified local dataset.
