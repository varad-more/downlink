import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { TripsLayer } from "@deck.gl/geo-layers";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { PathStyleExtension } from "@deck.gl/extensions";
import { TripStore, TRAIL_MS, type Method } from "./trips.ts";
import { gcArc, isPathEndpoint, unwrapPath } from "./geo.ts";
import { placeLabel, type LabelBox } from "./labels.ts";
import * as ks from "./keystone.ts";
import {
  ROUTE_COLORS, TracePanel, type City, type NetworkSummary,
  type TraceCandidate, type WorkspaceMode,
} from "./trace.tsx";

const params = new URLSearchParams(location.search);
// A ws:// URL is unreachable from an https:// page (mixed content), so a
// hosted build can only ever run the synthetic feed. Default it on there
// rather than showing a black wall retrying a connection that cannot open.
// An explicit ?ws= (a wss:// proxy) opts back into the live path.
const SOAK = params.get("soak") === "1" ||
  (location.protocol === "https:" && !params.has("ws"));
const SPEED = Number(params.get("speed") ?? 1);
const WS_URL = params.get("ws") ?? `ws://${location.hostname}:9001`;
const HOME: [number, number] = [
  Number(params.get("lon") ?? -111.94), Number(params.get("lat") ?? 33.4255),
];
const HOME_NAME = params.get("home") ?? "Tempe, AZ";
// ?chrome=0 strips the title/legend for a bare wall once an audience has
// already been told what they are looking at.
const CHROME = params.get("chrome") !== "0";
const LABEL_MS = 4200;
const MAX_LABELS = 7;
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
const DASH_EXTENSION = new PathStyleExtension({ dash: true });
// The camera centres on home's longitude so every great circle from here
// stays within +/-180 of centre and unwrapping never leaves the visible
// span. Latitude sits south of home (33.4N) to keep Sao Paulo,
// Johannesburg and Sydney on screen.
const VIEW_LAT = 18;

const showWorld = (map: maplibregl.Map, duration = 0) =>
  map.fitBounds([[HOME[0] - 180, VIEW_LAT - .5],
                 [HOME[0] + 180, VIEW_LAT + .5]],
                { padding: 0, duration });

/** Legend, and the swatch colours must stay in step with trips.ts:colorFor
 *  at confidence 1. Three methods, three claims of very different strength. */
const METHODS = [
  { m: "route" as Method, c: "rgb(80,230,255)", k: "candidate route",
    d: "named mapped infrastructure; actual route unknown" },
  { m: "greatcircle" as Method, c: "rgb(255,176,64)", k: "great circle",
    d: "no feasible mapped route; spherical estimate" },
  { m: "pop" as Method, c: "rgb(255,95,190)", k: "anycast edge",
    d: "RTT says the endpoint is nearer than the registry claims" },
];
const methodColor = (method: Method) =>
  METHODS.find((candidate) => candidate.m === method)?.c ?? METHODS[1]!.c;

function validNetwork(value: any): value is NetworkSnapshot {
  const collection = (item: any, max: number) => item?.type === "FeatureCollection" &&
    Array.isArray(item.features) && item.features.length <= max;
  return value?.schema === 1 && typeof value.generated_at === "string" &&
    collection(value.cables, 2_000) && collection(value.terrestrial, 20_000) &&
    collection(value.landings, 5_000);
}

interface Entity {
  label: string;
  method: Method;
  confidence: number;
  rttMs: number;
  bytesKb: number;
  path: number[];
}

interface Delta {
  dropped: number;
  unmeasured: number;
  entities: Entity[];
}

type Pending = Omit<Entity, "path"> & { path: Float32Array };
type RouteLine = {
  path: Float32Array;
  routeIndex: number;
  kind: "submarine" | "terrestrial" | "estimate";
};
type Landing = { position: [number, number]; routeIndex: number };
type RoutePlace = Landing & { label: string; order: number };
type Manual = Pending & {
  from: City;
  to: City;
  repeatAt: number;
  active: number;
  color: [number, number, number];
  paths: Float32Array[];
  solidLines: RouteLine[];
  dashedLines: RouteLine[];
  landings: Landing[];
  places: RoutePlace[];
  routeLabels: string[];
};

interface NetworkSnapshot {
  schema: number;
  generated_at: string;
  cables: { type: "FeatureCollection"; features: any[] };
  terrestrial: { type: "FeatureCollection"; features: any[] };
  landings: { type: "FeatureCollection"; features: any[] };
}

const EMPTY_NETWORK: NetworkSummary = {
  loading: false, error: "", cableNames: [], cables: 0,
  terrestrial: 0, landings: 0, generatedAt: "",
};

const CONTINENTS = [
  { name: "North America", position: [-105, 49] },
  { name: "South America", position: [-61, -19] },
  { name: "Europe", position: [16, 53] },
  { name: "Africa", position: [20, 5] },
  { name: "Asia", position: [91, 45] },
  { name: "Oceania", position: [136, -24] },
  { name: "Antarctica", position: [-112, -77] },
] as const;

function routeLayers(manual: Manual) {
  const color = (line: RouteLine, alpha: number) => line.routeIndex === manual.active
    ? [...ROUTE_COLORS[line.routeIndex]!.rgb, alpha] as [number, number, number, number]
    : [76, 94, 108, Math.round(alpha * .48)] as [number, number, number, number];
  const width = (line: RouteLine, casing = 0) =>
    (line.routeIndex === manual.active ? 4.5 : 2.5) + casing;
  const common = {
    getPath: (line: RouteLine) => line.path,
    // Flat route buffers contain lon/lat pairs. Deck.gl defaults flat paths
    // to XYZ, which groups these values in threes and draws false diagonals.
    positionFormat: "XY" as const,
    _pathType: "open" as const,
    widthUnits: "pixels" as const,
    capRounded: true,
    jointRounded: true,
    pickable: false,
  };
  const dash = {
    extensions: [DASH_EXTENSION],
    getDashArray: (line: RouteLine) => line.kind === "estimate" ? [1, 2] : [4, 3],
    dashJustified: false,
  };
  return [
    new PathLayer<RouteLine>({
      ...common, id: "route-solid-casing", data: manual.solidLines,
      getColor: (line) => [250, 249, 244,
        line.routeIndex === manual.active ? 235 : 150],
      getWidth: (line) => width(line, 3),
    }),
    new PathLayer<RouteLine>({
      ...common, ...dash, id: "route-dashed-casing", data: manual.dashedLines,
      getColor: (line) => [250, 249, 244,
        line.routeIndex === manual.active ? 235 : 150],
      getWidth: (line) => width(line, 3),
    }),
    new PathLayer<RouteLine>({
      ...common, id: "route-solid", data: manual.solidLines,
      getColor: (line) => color(line, 255),
      getWidth: (line) => width(line),
    }),
    new PathLayer<RouteLine>({
      ...common, ...dash, id: "route-dashed", data: manual.dashedLines,
      getColor: (line) => color(line, 255),
      getWidth: (line) => width(line),
    }),
  ];
}

function delta(value: unknown): Delta | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Delta;
  if (!Number.isFinite(d.dropped) || !Number.isFinite(d.unmeasured) ||
      d.unmeasured < 0 || d.unmeasured > 1 || !Array.isArray(d.entities) ||
      d.entities.length > 4096) return null;
  for (const e of d.entities) {
    if (!e || typeof e.label !== "string" || e.label.length > 300 ||
        !METHODS.some((m) => m.m === e.method) ||
        ![e.confidence, e.rttMs, e.bytesKb].every(Number.isFinite) ||
        !Array.isArray(e.path) || e.path.length < 4 || e.path.length > 320 ||
        e.path.length % 2 || !e.path.every(Number.isFinite)) return null;
  }
  return d;
}

interface Label {
  id: number; key: string; text: string;
  lon: number; lat: number; color: string; born: number;
}

export default function App() {
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [corners, setCorners] = useState<ks.Corners>(() =>
    ks.load(innerWidth, innerHeight));
  const [calibrating, setCalibrating] = useState(false);
  const [hud, setHud] = useState({
    connected: false, unmeasured: 0, dropped: 0, trips: 0, fps: 0,
    heapMb: 0, entities: 0, frames: 0,
  });
  const [labels, setLabels] = useState<Label[]>([]);
  // Bumped whenever the camera or the window changes, so the label anchors
  // (which are map.project() results read at render) get recomputed.
  const [viewTick, setViewTick] = useState(0);
  const [traceTick, setTraceTick] = useState(0);
  const [showPlaces, setShowPlaces] = useState(false);
  const [mode, setMode] = useState<WorkspaceMode>("routes");
  const [mapReady, setMapReady] = useState(false);
  const [network, setNetwork] = useState<NetworkSnapshot | null>(null);
  const [networkSummary, setNetworkSummary] = useState(EMPTY_NETWORK);
  const [selectedCable, setSelectedCable] = useState("");
  const [networkLayers, setNetworkLayers] = useState({
    submarine: true, terrestrial: true, landings: true,
  });
  const store = useRef(new TripStore()).current;
  const manualRef = useRef<Manual | null>(null);
  const modeRef = useRef<WorkspaceMode>("routes");

  // ---------------------------------------------------------------- map
  useEffect(() => {
    if (!mapDiv.current) return;
    const map = new maplibregl.Map({
      container: mapDiv.current,
      // Page-relative, not root-absolute, so the kiosk also serves from a
      // subpath. MapLibre resolves the style's source "data" the same way
      // (browser.resolveURL -> <a href>, i.e. against the document base).
      style: "basemap/style.json",    // local; no key, no network
      center: [HOME[0], VIEW_LAT],
      zoom: 1.1,                      // replaced by fitWorld() on load
      attributionControl: false,
      interactive: CHROME,
      dragRotate: false,
      touchPitch: false,
      fadeDuration: 0,
    });
    mapRef.current = map;
    const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    let raf = 0, frames = 0, lastFps = performance.now();
    const pending: Pending[] = [];
    let unmeasured = 0, dropped = 0, entityCount = 0, deltas = 0, labelId = 0;
    let ws: WebSocket | null = null;
    let soakTimer: number | undefined;

    // Fill the frame edge to edge: fit a full 360 of longitude in a band so
    // thin that width is always the binding constraint, then recentre on
    // home. fitBounds does the zoom arithmetic, so no world-size constant
    // has to be assumed here.
    const fitInitialWorld = () => {
      showWorld(map);
      setViewTick((v) => v + 1);
    };

    map.on("load", () => {
      setMapReady(true);
      map.addControl(overlay);
      if (CHROME) map.addControl(new maplibregl.NavigationControl({
        showCompass: false,
      }), "bottom-right");
      if (CHROME) map.addControl(new maplibregl.ScaleControl({
        maxWidth: 120, unit: "metric",
      }), "bottom-right");
      if (manualRef.current) focusRoutes(); else fitInitialWorld();
      map.on("move", () => setViewTick((v) => v + 1));
      const start = performance.now();

      const tick = () => {
        raf = requestAnimationFrame(tick);
        const now = performance.now();
        const currentTime = SOAK ? start + (now - start) * SPEED : now;

        while (pending.length) {
          const e = pending.shift()!;
          if (!manualRef.current)
            store.add(e.path, e.method, e.confidence, e.bytesKb, e.rttMs, currentTime);
        }
        const manual = modeRef.current === "routes" ? manualRef.current : null;
        if (manual && !REDUCED_MOTION && currentTime >= manual.repeatAt) {
          store.add(manual.path, manual.method, manual.confidence,
                    manual.bytesKb, manual.rttMs, currentTime, manual.color);
          manual.repeatAt = currentTime +
            Math.max(1500, Math.min(8000, manual.rttMs * 20) + TRAIL_MS);
        }
        store.prune(currentTime);

        // A new TripsLayer per frame is the idiomatic deck.gl pattern and is
        // cheap: the layer object is a props descriptor that deck diffs. The
        // expensive thing is the GPU upload, and that is avoided because
        // store.data() returns an identity-stable object while the trip set
        // is unchanged -- currentTime alone only moves a uniform.
        const common = {
          data: store.data(),
          _pathType: "open" as const,
          currentTime,                 // ms, same clock as getTimestamps
          trailLength: TRAIL_MS,
          widthUnits: "pixels" as const,
          capRounded: true,
          jointRounded: true,
          updateTriggers: {},
        };
        overlay.setProps({
          layers: [
            ...(manual ? routeLayers(manual) : []),
            ...(manual?.landings.length ? [new ScatterplotLayer<Landing>({
              id: "route-landings",
              data: manual.landings,
              getPosition: (landing) => landing.position,
              getFillColor: [250, 249, 244, 245],
              getLineColor: (landing) => [
                ...ROUTE_COLORS[landing.routeIndex]!.rgb,
                landing.routeIndex === manual.active ? 255 : 155,
              ],
              getRadius: (landing) => landing.routeIndex === manual.active ? 5 : 4,
              radiusUnits: "pixels", stroked: true, filled: true,
              lineWidthUnits: "pixels", getLineWidth: 2,
              pickable: false,
            })] : []),
            // ponytail: the glow is a second wide, dim pass over the same
            // buffers rather than an additive blend, because luma.gl v9's
            // blend-parameter shape is not something I could verify. It
            // costs one extra tesselation. If fps on the wall drops, delete
            // the glow layer, not the core one.
            new TripsLayer({ ...common, id: "trips-glow", widthScale: 5,
                             widthMinPixels: 5, opacity: 0.11 }),
            new TripsLayer({ ...common, id: "trips",
                             widthMinPixels: 1, opacity: 0.95 }),
          ],
        });

        frames++;
        if (now - lastFps > 1000) {
          const mem = (performance as any).memory;
          setHud((h) => ({
            ...h,
            fps: Math.round((frames * 1000) / (now - lastFps)),
            trips: store.stats().trips,
            unmeasured, dropped, entities: entityCount, frames: deltas,
            heapMb: mem ? +(mem.usedJSHeapSize / 1e6).toFixed(1) : 0,
            connected: SOAK || ws?.readyState === 1,
          }));
          frames = 0;
          lastFps = now;
        }
      };
      raf = requestAnimationFrame(tick);

      const ingest = (d: Delta | null) => {
        if (!d) return;
        deltas++;
        unmeasured = d.unmeasured;
        dropped = d.dropped;
        entityCount = d.entities.length;
        if (manualRef.current) return;
        const fresh: Label[] = [];
        for (const e of d.entities) {
          const path = Float32Array.from(e.path);
          unwrapPath(path, HOME[0]);
          pending.push({ ...e, path });
          const n = path.length >> 1;
          if (n < 2) continue;
          fresh.push({
            id: ++labelId, key: e.label, text: e.label,
            lon: path[(n - 1) * 2]!, lat: path[(n - 1) * 2 + 1]!,
            color: methodColor(e.method), born: performance.now(),
          });
        }
        if (!fresh.length) return;
        // One setState per delta, not one per entity. Repeat destinations
        // replace their own label instead of stacking on top of it.
        setLabels((ls) => {
          const next = ls.filter((l) => !fresh.some((f) => f.key === l.key));
          return next.concat(fresh).slice(-MAX_LABELS);
        });
      };

      if (SOAK) {
        // 2 flows every 200ms. Fast enough to look alive, slow enough that
        // a label can be read before it is replaced.
        soakTimer = window.setInterval(() => ingest(synth()), 200 / SPEED);
      } else {
        const connect = () => {
          ws = new WebSocket(WS_URL);
          ws.onmessage = (event) => {
            try { ingest(delta(JSON.parse(String(event.data)))); }
            catch { /* malformed frame; wait for the next delta */ }
          };
          ws.onclose = () => { ws = null; setTimeout(connect, 2000); };
          ws.onerror = () => ws?.close();
        };
        connect();
      }
    });

    return () => {
      cancelAnimationFrame(raf);
      if (soakTimer) clearInterval(soakTimer);
      ws?.close();
      setMapReady(false);
      mapRef.current = null;
      map.remove();
    };
  }, []);

  useEffect(() => {
    if (mode === "routes" || network || networkSummary.loading) return;
    setNetworkSummary((current) => ({ ...current, loading: true, error: "" }));
    void fetch(new URL("network.json", document.baseURI))
      .then((response) => {
        if (!response.ok) throw new Error(`network snapshot returned ${response.status}`);
        return response.json();
      })
      .then((value) => {
        if (!validNetwork(value)) throw new Error("network snapshot is invalid");
        setNetwork(value);
        setNetworkSummary({
          loading: false, error: "",
          cableNames: value.cables.features.map((feature) => feature.properties.name),
          cables: value.cables.features.length,
          terrestrial: value.terrestrial.features.length,
          landings: value.landings.features.length,
          generatedAt: value.generated_at,
        });
      })
      .catch((cause) => setNetworkSummary({
        ...EMPTY_NETWORK, error: `Could not load the network database: ${(cause as Error).message}`,
      }));
  }, [mode, network]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !network || map.getSource("network-cables")) return;
    map.addSource("network-cables", { type: "geojson", data: network.cables as any });
    map.addSource("network-terrestrial", { type: "geojson", data: network.terrestrial as any });
    map.addSource("network-landings", { type: "geojson", data: network.landings as any });
    map.addLayer({
      id: "network-cables", type: "line", source: "network-cables",
      layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["coalesce", ["get", "color"], "#3974a8"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 0, .7, 5, 2.2],
        "line-opacity": .58,
      },
    });
    map.addLayer({
      id: "network-terrestrial", type: "line", source: "network-terrestrial",
      layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#66747d", "line-dasharray": [3, 3],
        "line-width": ["interpolate", ["linear"], ["zoom"], 0, .55, 5, 1.8],
        "line-opacity": .55,
      },
    });
    map.addLayer({
      id: "network-selected", type: "line", source: "network-cables",
      filter: ["==", ["get", "name"], "__none__"],
      layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["coalesce", ["get", "color"], "#ed542d"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 0, 3, 5, 6],
        "line-opacity": 1,
      },
    });
    map.addLayer({
      id: "network-landings", type: "circle", source: "network-landings",
      layout: { visibility: "none" },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 1.4, 5, 4],
        "circle-color": "#faf9f4", "circle-stroke-color": "#0c5367",
        "circle-stroke-width": 1, "circle-opacity": .9,
      },
    });
    const chooseCable = (event: any) => {
      const name = event.features?.[0]?.properties?.name;
      if (typeof name === "string") setSelectedCable(name);
    };
    const pointer = () => { map.getCanvas().style.cursor = "pointer"; };
    const unpointer = () => { map.getCanvas().style.cursor = ""; };
    map.on("click", "network-cables", chooseCable);
    map.on("mouseenter", "network-cables", pointer);
    map.on("mouseleave", "network-cables", unpointer);
    return () => {
      map.off("click", "network-cables", chooseCable);
      map.off("mouseenter", "network-cables", pointer);
      map.off("mouseleave", "network-cables", unpointer);
    };
  }, [mapReady, network]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !map.getLayer("network-cables")) return;
    const atlas = mode === "network";
    map.setLayoutProperty("network-cables", "visibility",
      atlas && networkLayers.submarine ? "visible" : "none");
    map.setLayoutProperty("network-selected", "visibility",
      atlas && networkLayers.submarine && selectedCable ? "visible" : "none");
    map.setLayoutProperty("network-terrestrial", "visibility",
      atlas && networkLayers.terrestrial ? "visible" : "none");
    map.setLayoutProperty("network-landings", "visibility",
      atlas && networkLayers.landings ? "visible" : "none");
    map.setFilter("network-selected", ["==", ["get", "name"],
      selectedCable || "__none__"]);
  }, [mapReady, mode, network, networkLayers, selectedCable]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || mode !== "network" || !network || !selectedCable) return;
    const bounds = new maplibregl.LngLatBounds();
    const add = (coordinates: any) => {
      if (Array.isArray(coordinates) && coordinates.length >= 2 &&
          coordinates.every((value, index) => index > 1 || typeof value === "number")) {
        const lon = coordinates[0] - 360 * Math.round((coordinates[0] - HOME[0]) / 360);
        bounds.extend([lon, coordinates[1]]);
      } else if (Array.isArray(coordinates)) coordinates.forEach(add);
    };
    network.cables.features
      .filter((feature) => feature.properties.name === selectedCable)
      .forEach((feature) => add(feature.geometry.coordinates));
    if (!bounds.isEmpty()) map.fitBounds(bounds, {
      padding: innerWidth <= 1080
        ? { top: 48, right: 36, bottom: Math.min(innerHeight * .62, 560), left: 36 }
        : { top: 72, right: 72, bottom: 72, left: innerWidth * .35 },
      maxZoom: 5, duration: 600,
    });
  }, [mapReady, mode, network, selectedCable]);

  // Age labels out. One timer, not one per label.
  useEffect(() => {
    const t = setInterval(() => {
      const now = performance.now();
      setLabels((ls) => ls.filter((l) => now - l.born < LABEL_MS));
    }, 500);
    return () => clearInterval(t);
  }, []);

  // ---------------------------------------------------------------- keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k") setCalibrating((c) => !c);
      if (e.key === "r" && calibrating) {
        const c = ks.identityCorners(innerWidth, innerHeight);
        setCorners(c); ks.clear();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [calibrating]);

  useEffect(() => {
    const onResize = () => setViewTick((v) => v + 1);
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("calibrating", calibrating);
  }, [calibrating]);

  const drag = (i: number) => (ev: React.PointerEvent) => {
    ev.preventDefault();
    (ev.target as Element).setPointerCapture(ev.pointerId);
    const move = (m: PointerEvent) => {
      setCorners((c) => {
        const n = c.map((p) => [...p]) as ks.Corners;
        n[i] = [m.clientX, m.clientY];
        return n;
      });
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      setCorners((c) => { ks.save(c); return c; });
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };

  const transform = ks.matrix3d(innerWidth, innerHeight, corners);
  // Anchors come from the map's own camera, so they stay correct at any
  // zoom, aspect ratio or centre -- including the unwrapped longitudes
  // beyond +/-180 that deck.gl draws in the adjacent world copy.
  const map = mapRef.current;
  void viewTick; void traceTick;       // re-project when the view/trace changes
  const home = map ? map.project(HOME) : null;
  const manual = mode === "routes" ? manualRef.current : null;
  const fromPoint = map && manual ? map.project([manual.path[0]!, manual.path[1]!]) : null;
  const n = manual?.path.length ?? 0;
  const toPoint = map && manual ? map.project([manual.path[n - 2]!, manual.path[n - 1]!]) : null;
  const routeAnchors = map && manual ? manual.paths.map((path, index) => {
    const anchor = Math.floor(((path.length / 2) - 1) * .42) * 2;
    return { point: map.project([path[anchor]!, path[anchor + 1]!]),
      label: manual.routeLabels[index]! };
  }) : [];
  const placeLabels: { place: RoutePlace; anchorX: number; anchorY: number;
    x: number; y: number; width: number }[] = [];
  if (map && manual && showPlaces) {
    const panel = document.querySelector<HTMLElement>(".trace-panel")?.getBoundingClientRect();
    const bounds: LabelBox = innerWidth <= 1080
      ? [8, 8, innerWidth - 8, (panel?.top ?? innerHeight) - 8]
      : [(panel?.right ?? innerWidth * .32) + 8, 8, innerWidth - 8, innerHeight - 8];
    const boxes: LabelBox[] = [];
    const activeBadge = routeAnchors[manual.active];
    if (activeBadge) {
      const width = Math.min(430, innerWidth * .5);
      const charsPerLine = Math.max(22, Math.floor((width - 48) / 6));
      const height = 16 + Math.ceil(activeBadge.label.length / charsPerLine) * 13;
      const centerY = activeBadge.point.y + (manual.active - 1) * 27;
      boxes.push([activeBadge.point.x - width / 2, centerY - height / 2,
        activeBadge.point.x + width / 2, centerY + height / 2]);
    }
    for (const place of manual.places.filter((item) => item.routeIndex === manual.active)) {
      const point = map.project(place.position);
      const width = Math.min(innerWidth <= 640 ? 150 : 230,
        Math.max(90, place.label.length * 6.4 + 34));
      const box = placeLabel([point.x, point.y], [width, 24], boxes, bounds);
      placeLabels.push({ place, anchorX: point.x, anchorY: point.y,
        x: box[0], y: box[1], width });
    }
  }
  const continentAnchors = map && mode !== "routes" ? CONTINENTS.map((continent) => {
    const lon = continent.position[0] -
      360 * Math.round((continent.position[0] - HOME[0]) / 360);
    return { name: continent.name, point: map.project([lon, continent.position[1]]) };
  }) : [];

  const focusRoutes = () => {
    const map = mapRef.current, paths = manualRef.current?.paths;
    if (!map || !paths?.length) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const path of paths)
      for (let i = 0; i < path.length; i += 2)
        bounds.extend([path[i]!, path[i + 1]!]);
    const mobile = innerWidth <= 1080;
    map.fitBounds(bounds, {
      padding: mobile
        ? { top: 48, right: 36, bottom: Math.min(innerHeight * .62, 560), left: 36 }
        : { top: 72, right: 72, bottom: 72, left: innerWidth * .35 },
      maxZoom: 5,
      duration: 600,
    });
  };

  const changeMode = (next: WorkspaceMode) => {
    modeRef.current = next;
    setMode(next);
    setTraceTick((tick) => tick + 1);
    if (next === "routes" && manualRef.current) focusRoutes();
    else if (mapRef.current) showWorld(mapRef.current, 600);
  };

  const trace = (from: City, to: City, route: TraceCandidate,
                 routes: TraceCandidate[]) => {
    const paths = routes.map((candidate) => {
      const path = Float32Array.from(candidate.path.flat());
      unwrapPath(path, from.lon);
      return path;
    });
    const active = routes.indexOf(route);
    const path = paths[active]!;
    const lines: RouteLine[] = [];
    const landings: Landing[] = [];
    const places: RoutePlace[] = [];
    routes.forEach((candidate, routeIndex) => {
      let refLon = from.lon;
      const seenPlaces = new Set<string>();
      const candidatePath = paths[routeIndex]!;
      const addPlace = (label: string, position: [number, number]) => {
        if (!label || label === from.name || label === to.name || seenPlaces.has(label) ||
            isPathEndpoint(position, candidatePath)) return;
        seenPlaces.add(label);
        places.push({ label, position, routeIndex, order: seenPlaces.size });
      };
      const segments = candidate.segments.length ? candidate.segments : [{
        kind: "estimate" as const, path: candidate.path,
        from: from.name, to: to.name,
      }];
      for (const segment of segments) {
        const segmentPath = Float32Array.from(segment.path.flat());
        unwrapPath(segmentPath, refLon);
        refLon = segmentPath[segmentPath.length - 2]!;
        lines.push({ path: segmentPath, routeIndex, kind: segment.kind });
        addPlace(segment.from, [segmentPath[0]!, segmentPath[1]!]);
        addPlace(segment.to, [segmentPath[segmentPath.length - 2]!,
          segmentPath[segmentPath.length - 1]!]);
        if (segment.kind === "submarine") {
          landings.push(
            { position: [segmentPath[0]!, segmentPath[1]!], routeIndex },
            { position: [segmentPath[segmentPath.length - 2]!,
                         segmentPath[segmentPath.length - 1]!], routeIndex },
          );
        }
      }
    });
    const color = ROUTE_COLORS[active] ?? ROUTE_COLORS[0]!;
    lines.sort((a, b) => Number(a.routeIndex === active) -
      Number(b.routeIndex === active));
    store.clear();
    manualRef.current = {
      from, to, path, repeatAt: 0, method: route.method,
      confidence: route.confidence, rttMs: route.rttMs, bytesKb: 320,
      label: `${from.name} to ${to.name} · ${route.name}`,
      active, color: color.rgb, paths,
      solidLines: lines.filter((line) => line.kind === "submarine"),
      dashedLines: lines.filter((line) => line.kind !== "submarine"),
      landings, places,
      routeLabels: routes.map((candidate) => candidate.cables.length
        ? candidate.cables.join(" → ") : candidate.name.replace(/^via /, "")),
    };
    setLabels([]); setTraceTick((tick) => tick + 1); focusRoutes();
  };

  const live = () => {
    store.clear();
    manualRef.current = null;
    if (mapRef.current) showWorld(mapRef.current, 600);
    setTraceTick((tick) => tick + 1);
  };

  return (
    <>
      {/* Everything projected lives inside the keystone-corrected wrapper:
          map, trails, labels and chrome alike. The handles deliberately do not. */}
      <div style={{
        position: "absolute", inset: 0, transformOrigin: "0 0",
        transform, willChange: "transform",
      }}>
        <div ref={mapDiv} style={{ position: "absolute", inset: 0 }} />
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          {mode === "routes" && !manual && home && <HomeDot x={home.x} y={home.y} />}
          {manual && fromPoint && <CityDot x={fromPoint.x} y={fromPoint.y}
            name={manual.from.name} kind="SOURCE" />}
          {manual && toPoint && <CityDot x={toPoint.x} y={toPoint.y}
            name={manual.to.name} kind="DESTINATION" />}
          {manual && routeAnchors.map(({ point, label }, index) =>
            (!showPlaces || index === manual.active) && <RouteBadge
              key={index} x={point.x} y={point.y + (index - 1) * 27} index={index}
              active={index === manual.active} label={label} />)}
          {placeLabels.map(({ place, anchorX, anchorY, x, y, width }) => <RoutePlaceLabel
            key={`${place.routeIndex}-${place.label}`} anchorX={anchorX} anchorY={anchorY}
            x={x} y={y} width={width}
            color={ROUTE_COLORS[manual!.active]!.css}
            label={place.label} order={place.order} />)}
          {continentAnchors.map(({ name, point }) => <div key={name}
            className="continent-label" style={{ left: point.x, top: point.y }}>{name}</div>)}
          {map && labels.map((l) => {
            const p = map.project([l.lon, l.lat]);
            return <LabelDot key={l.id} label={l} x={p.x} y={p.y} />;
          })}
        </div>
        {CHROME && mode === "routes" && !manual && <Frame soak={SOAK} />}
      </div>

      {CHROME && <TracePanel onTrace={trace} onLive={live} onFit={focusRoutes}
        showPlaces={showPlaces} onShowPlaces={setShowPlaces}
        mode={mode} onMode={changeMode} network={networkSummary}
        selectedCable={selectedCable} onSelectCable={setSelectedCable}
        networkLayers={networkLayers} onNetworkLayers={setNetworkLayers} />}

      {calibrating && corners.map((c, i) => (
        <div key={i} onPointerDown={drag(i)} style={{
          position: "absolute", left: c[0] - 14, top: c[1] - 14,
          width: 28, height: 28, borderRadius: 14,
          border: "2px solid #5adcff", background: "rgba(90,220,255,.18)",
          cursor: "grab", touchAction: "none", zIndex: 20,
        }} />
      ))}

      {mode === "routes" && <Hud hud={hud} calibrating={calibrating}
        exploring={Boolean(manual)} />}
    </>
  );
}

const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";

function HomeDot({ x, y }: { x: number; y: number }) {
  return (
    <div style={{ position: "absolute", left: x, top: y }}>
      <div style={{
        position: "absolute", left: -4, top: -4, width: 8, height: 8,
        borderRadius: 4, background: "#0c2747",
        boxShadow: "0 0 0 4px rgba(250,249,244,.85)",
      }} />
      <div style={{
        position: "absolute", left: 12, top: 0, transform: "translateY(-50%)",
        color: "#0c2747", font: `700 11px/1.2 ${MONO}`,
        letterSpacing: ".22em", whiteSpace: "nowrap",
        textShadow: "0 1px 0 #faf9f4, 0 0 5px #faf9f4",
      }}>{HOME_NAME.toUpperCase()}</div>
    </div>
  );
}

function CityDot({ x, y, name, kind }: {
  x: number; y: number; name: string; kind: string;
}) {
  return (
    <div style={{ position: "absolute", left: x, top: y, zIndex: 4 }}>
      <div style={{
        position: "absolute", left: -6, top: -6, width: 10, height: 10,
        borderRadius: 6, background: "#0c2747", border: "2px solid #faf9f4",
        boxShadow: "0 1px 0 1px rgba(12,39,71,.22), 0 4px 14px rgba(12,39,71,.2)",
      }} />
      <div style={{
        position: "absolute", left: 14, top: 0, transform: "translateY(-50%)",
        color: "#0c2747", font: `700 11px/1.35 ${MONO}`,
        whiteSpace: "nowrap", textShadow: "0 1px 0 #faf9f4, 0 0 5px #faf9f4",
      }}><span style={{ color: "#0c2747", letterSpacing: ".14em" }}>{kind}</span><br />{name}</div>
    </div>
  );
}

function RouteBadge({ x, y, index, active, label }: {
  x: number; y: number; index: number; active: boolean; label: string;
}) {
  const color = ROUTE_COLORS[index]!.css;
  return <div className={`map-route-badge ${active ? "active" : ""}`} style={{
    position: "absolute", left: x, top: y, "--route-color": color,
  } as React.CSSProperties}><span>{index + 1}</span><strong>{label}</strong></div>;
}

function RoutePlaceLabel({ anchorX, anchorY, x, y, width, color, label, order }: {
  anchorX: number; anchorY: number; x: number; y: number; width: number;
  color: string; label: string; order: number;
}) {
  const targetX = Math.max(x, Math.min(anchorX, x + width));
  const targetY = Math.max(y, Math.min(anchorY, y + 24));
  const dx = targetX - anchorX, dy = targetY - anchorY;
  return <>
    <i className="route-place-leader" style={{ left: anchorX, top: anchorY,
      width: Math.hypot(dx, dy), transform: `rotate(${Math.atan2(dy, dx)}rad)` }} />
    <i className="route-place-anchor" style={{ left: anchorX, top: anchorY }} />
    <div className="route-place-callout" style={{
      position: "absolute", left: x, top: y, width,
      "--route-color": color, animationDelay: `${Math.min(order * 18, 180)}ms`,
    } as React.CSSProperties}>
      <div className="route-place-label"><span>{order}</span><strong>{label}</strong></div>
    </div>
  </>;
}

function LabelDot({ label, x, y }: { label: Label; x: number; y: number }) {
  // The wrapper animates opacity only; the children own their transforms,
  // so the dot cannot drift away from its anchor as the label fades.
  return (
    <div style={{
      position: "absolute", left: x, top: y,
      animation: `dl-label ${LABEL_MS}ms linear forwards`,
    }}>
      <div style={{
        position: "absolute", left: -9, top: -9, width: 18, height: 18,
        borderRadius: 9, border: `1px solid ${label.color}`,
        animation: "dl-ping 1.6s ease-out forwards",
      }} />
      <div style={{
        position: "absolute", left: -2.5, top: -2.5, width: 5, height: 5,
        borderRadius: 3, background: label.color,
      }} />
      <div style={{
        position: "absolute", left: 11, top: 0, transform: "translateY(-50%)",
        color: "#0c2747", font: `600 11px/1.3 ${MONO}`,
        letterSpacing: ".02em", whiteSpace: "nowrap",
        textShadow: "0 1px 0 #faf9f4, 0 0 5px #faf9f4",
      }}>{label.text}</div>
    </div>
  );
}

/** The part that answers "what am I looking at". Without it the piece is a
 *  screensaver: pretty lines, no claim. */
function Frame({ soak }: { soak: boolean }) {
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <div className="intro" style={{
        position: "absolute", left: "calc(var(--panel-width) + 3vw)", top: "4vh",
      }}>
        <div style={{
          font: `600 clamp(17px,2.4vw,40px)/1 ${MONO}`,
          letterSpacing: ".34em", color: "#0c2747",
        }}>DOWNLINK</div>
        <div style={{
          marginTop: "1.1em", maxWidth: "34ch", color: "#46627b",
          font: `clamp(10px,1.02vw,16px)/1.6 ${MONO}`,
        }}>
          Each pulse is observed traffic leaving {HOME_NAME}.
          Cable and landing names describe mapped infrastructure; they do not
          prove which route traffic used.
        </div>
        {soak && (
          <div style={{
            marginTop: "1.4em", display: "inline-block",
            padding: ".45em .8em", border: "1px solid #a75e2c",
            color: "#8c461e", background: "rgba(250,249,244,.88)",
            font: `clamp(9px,.82vw,13px)/1.4 ${MONO}`, letterSpacing: ".16em",
          }}>
            SYNTHETIC REPLAY — NOTHING HERE IS BEING MEASURED
          </div>
        )}
      </div>

      <div className="legend" style={{
        position: "absolute", right: "3.2vw", bottom: "3.6vh",
        textAlign: "right", font: `clamp(9px,.86vw,14px)/1.5 ${MONO}`,
      }}>
        {METHODS.map((m) => {
          // The synthetic feed cannot honestly emit a named route: the
          // TeleGeography landing-point set is a manual prerequisite and is
          // not vendored, so nothing here knows where the cables are.
          const off = soak && m.m === "route";
          return (
            <div key={m.k} style={{
              marginTop: ".85em", opacity: off ? 0.32 : 1,
            }}>
              <div style={{ color: "#0c2747", letterSpacing: ".1em" }}>
                <span style={{
                  display: "inline-block", width: 22, height: 2,
                  marginRight: 9, verticalAlign: "middle",
                  background: m.c, boxShadow: `0 0 8px ${m.c}`,
                }} />
                {m.k.toUpperCase()}{off ? " · live install only" : ""}
              </div>
              <div style={{ color: "#46627b", marginTop: ".25em" }}>{m.d}</div>
            </div>
          );
        })}
        <div style={{ color: "#61778b", marginTop: "1.2em" }}>
          brightness = confidence · width = recent bytes · travel time = RTT
        </div>
      </div>
    </div>
  );
}

function Hud({ hud, calibrating, exploring }: {
  hud: any; calibrating: boolean; exploring: boolean;
}) {
  return (
    <div className={`hud ${exploring ? "is-exploring" : ""}`} style={{
      position: "absolute", bottom: 12, zIndex: 30,
      color: "#61778b", font: `10px/1.5 ${MONO}`,
      letterSpacing: ".04em", pointerEvents: "none",
    }}>
      {!exploring && <>
        <div style={{ color: hud.connected ? "#1769d2" : "#a75e2c", marginBottom: 3 }}>
          {hud.connected ? "LINK" : "NO LINK"} · {hud.trips} trips · {hud.fps} fps
          {hud.heapMb ? ` · ${hud.heapMb} MB heap` : ""}
        </div>
        <div>
          unmeasured {(hud.unmeasured * 100).toFixed(0)}% (QUIC/UDP-443, IPv6)
          {hud.dropped ? ` · ${hud.dropped} frames dropped` : ""}
        </div>
      </>}
      <div style={{ opacity: 0.65, marginTop: 3 }}>
        paths are inference, not measurement · basemap Natural Earth (public domain)
        {SOAK && !exploring ? "" : " · cables © TeleGeography CC BY-SA 4.0"}
      </div>
      {calibrating && (
        <div style={{ color: "#1769d2", marginTop: 4 }}>
          CALIBRATE — drag corners · r to reset · k to exit
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- soak feed
//
// A replay of tests/fixture_dests.json: real city coordinates with invented
// RTTs and confidences. It emits only the two methods
// it can honestly produce -- greatcircle, and the anycast reclassification
// that resolve.py performs when RTT is far too low for the registry's
// coordinates. It never emits `route`, because it does not run the resolver.

interface Dest {
  lat: number; lon: number; rtt: number;
  method: Method; conf: number; label: string;
}

// Label formats mirror resolver/resolve.py.
const DESTS: Dest[] = [
  { lat: 37.39, lon: -122.08, rtt: 22, method: "greatcircle", conf: 0.9,
    label: "Mountain View, CA · great-circle estimate · 22ms" },
  { lat: 37.34, lon: -121.89, rtt: 18, method: "greatcircle", conf: 0.9,
    label: "San Jose, CA · great-circle estimate · 18ms" },
  { lat: 47.67, lon: -122.12, rtt: 38, method: "greatcircle", conf: 0.8,
    label: "Redmond, WA · great-circle estimate · 38ms" },
  { lat: 32.78, lon: -96.80, rtt: 34, method: "greatcircle", conf: 0.8,
    label: "Dallas, TX · great-circle estimate · 34ms" },
  { lat: 41.88, lon: -87.63, rtt: 55, method: "greatcircle", conf: 0.8,
    label: "Chicago, IL · great-circle estimate · 55ms" },
  { lat: 33.75, lon: -84.39, rtt: 62, method: "greatcircle", conf: 0.7,
    label: "Atlanta, GA · great-circle estimate · 62ms" },
  { lat: 52.37, lon: 4.90, rtt: 145, method: "greatcircle", conf: 0.8,
    label: "Amsterdam, NL · great-circle estimate · 145ms" },
  { lat: 51.51, lon: -0.13, rtt: 152, method: "greatcircle", conf: 0.8,
    label: "London, UK · great-circle estimate · 152ms" },
  { lat: 35.68, lon: 139.69, rtt: 135, method: "greatcircle", conf: 0.7,
    label: "Tokyo, JP · great-circle estimate · 135ms" },
  { lat: 1.35, lon: 103.82, rtt: 235, method: "greatcircle", conf: 0.6,
    label: "Singapore, SG · great-circle estimate · 235ms" },
  { lat: -23.55, lon: -46.63, rtt: 168, method: "greatcircle", conf: 0.7,
    label: "Sao Paulo, BR · great-circle estimate · 168ms" },
  { lat: -26.20, lon: 28.05, rtt: 265, method: "greatcircle", conf: 0.6,
    label: "Johannesburg, ZA · great-circle estimate · 265ms" },
  { lat: 19.08, lon: 72.88, rtt: 240, method: "greatcircle", conf: 0.6,
    label: "Mumbai, IN · great-circle estimate · 240ms" },
  { lat: 55.75, lon: 37.62, rtt: 195, method: "greatcircle", conf: 0.6,
    label: "Moscow, RU · great-circle estimate · 195ms" },
  // Registry says Sydney; 12ms says Los Angeles. resolve.py reclassifies to
  // the nearest metro anchor (resolver/ixps.json: Any2 Los Angeles) at low
  // confidence -- the arc is short because the endpoint really is close.
  { lat: 34.05, lon: -118.24, rtt: 12, method: "pop", conf: 0.3,
    label: "Any2 Los Angeles · anycast edge · 12ms" },
];

let soakN = 0;
function synth() {
  const entities = [];
  for (let k = 0; k < 2; k++) {
    const d = DESTS[soakN++ % DESTS.length]!;
    entities.push({
      confidence: d.conf, method: d.method,
      rttMs: d.rtt, bytesKb: 100, label: d.label,
      path: Array.from(gcArc(HOME[1], HOME[0], d.lat, d.lon,
                            d.method === "pop" ? 12 : 48)),
    });
  }
  return { tMs: Date.now(), dropped: 0, unmeasured: 0.31, entities };
}
