import { useEffect, useRef, useState, type CSSProperties } from "react";
import cityData from "./cities.json";
import { gcArc } from "./geo.ts";
import type { Method } from "./trips.ts";

export interface City {
  id: string; name: string; continent: string; lat: number; lon: number;
}
export type WorkspaceMode = "routes" | "network" | "data";
export interface NetworkSummary {
  loading: boolean;
  error: string;
  cableNames: string[];
  cables: number;
  terrestrial: number;
  landings: number;
  generatedAt: string;
}
export interface TraceSegment {
  kind: "submarine" | "terrestrial";
  name: string;
  from: string;
  to: string;
  km: number;
  path: number[][];
  cableId?: string;
}
export interface TraceCandidate {
  name: string;
  method: Method;
  path: number[][];
  pathKm: number;
  rttMs: number;
  confidence: number;
  cables: string[];
  segments: TraceSegment[];
}

export const ROUTE_COLORS = [
  { css: "#ed542d", rgb: [237, 84, 45] as [number, number, number], name: "vermilion" },
  { css: "#1769d2", rgb: [23, 105, 210] as [number, number, number], name: "cobalt" },
  { css: "#07966d", rgb: [7, 150, 109] as [number, number, number], name: "sea green" },
];

export const CITIES = cityData as City[];

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const validPath = (value: unknown) => Array.isArray(value) && value.length >= 2 &&
  value.length <= 10_000 && value.every((point: unknown) =>
    Array.isArray(point) && point.length === 2 && point.every(finite));

function candidate(value: any, best = false): TraceCandidate | null {
  const path = value?.path;
  const name = best ? value?.route_name : value?.name;
  const method = best ? value?.method : "route";
  if (typeof name !== "string" || !name || name.length > 160 ||
      (method !== "route" && method !== "greatcircle") || !validPath(path) ||
      ![value.path_km, value.estimated_rtt_ms, value.confidence].every(finite) ||
      value.path_km <= 0 || value.estimated_rtt_ms <= 0 ||
      !Array.isArray(value.cables) || value.cables.length > 100 ||
      !value.cables.every((c: unknown) => typeof c === "string" && c.length <= 160) ||
      !Array.isArray(value.segments) || value.segments.length > 500) return null;

  const segments: TraceSegment[] = [];
  for (const raw of value.segments) {
    if (!raw || (raw.kind !== "submarine" && raw.kind !== "terrestrial") ||
        ![raw.name, raw.from, raw.to].every((s: unknown) =>
          typeof s === "string" && s.length <= 200) ||
        !finite(raw.km) || raw.km < 0 || !validPath(raw.path) ||
        (raw.cable_id !== undefined &&
          (typeof raw.cable_id !== "string" || raw.cable_id.length > 200))) return null;
    segments.push({
      kind: raw.kind, name: raw.name, from: raw.from, to: raw.to,
      km: raw.km, path: raw.path, cableId: raw.cable_id,
    });
  }
  return {
    name, path, method, segments,
    pathKm: value.path_km, rttMs: value.estimated_rtt_ms,
    confidence: Math.max(0, Math.min(1, value.confidence)),
    cables: value.cables,
  };
}

function candidates(value: any): TraceCandidate[] {
  const first = candidate(value, true);
  return first ? [first, ...(Array.isArray(value.alternatives)
    ? value.alternatives.slice(0, 2).map((route: unknown) => candidate(route)).filter(Boolean)
    : [])] as TraceCandidate[] : [];
}

const snapshotRequests = new Map<string, Promise<any>>();
async function snapshotRoute(source: City, destination: City) {
  if (!snapshotRequests.has(source.id)) snapshotRequests.set(source.id,
    fetch(new URL(`routes/${source.id}.json`, document.baseURI)).then((response) => {
    if (!response.ok) throw new Error(`route snapshot returned ${response.status}`);
    return response.json();
  }));
  const snapshot = await snapshotRequests.get(source.id)!;
  if (snapshot?.schema !== 1 || !snapshot.routes || typeof snapshot.routes !== "object")
    throw new Error("route snapshot is invalid");
  const route = snapshot.routes[destination.id];
  if (!route) throw new Error("city pair is missing from route snapshot");
  return route;
}

function fallback(from: City, to: City): TraceCandidate {
  const path = gcArc(from.lat, from.lon, to.lat, to.lon);
  const R = Math.PI / 180;
  const a = Math.sin((to.lat - from.lat) * R / 2) ** 2 +
    Math.cos(from.lat * R) * Math.cos(to.lat * R) *
    Math.sin((to.lon - from.lon) * R / 2) ** 2;
  const km = 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
  return {
    name: "great-circle estimate", method: "greatcircle", segments: [],
    path: Array.from({ length: path.length / 2 }, (_, i) =>
      [path[i * 2]!, path[i * 2 + 1]!]),
    pathKm: km, rttMs: km * 2 / 204, confidence: 0.2, cables: [],
  };
}

const routeTitle = (route: TraceCandidate) => {
  return route.name.replace(/^via /, "");
};

export function TracePanel({ onTrace, onLive, onFit, showPlaces, onShowPlaces,
  mode, onMode, network, selectedCable, onSelectCable,
  networkLayers, onNetworkLayers }: {
  onTrace: (from: City, to: City, route: TraceCandidate,
            routes: TraceCandidate[]) => void;
  onLive: () => void;
  onFit: () => void;
  showPlaces: boolean;
  onShowPlaces: (show: boolean) => void;
  mode: WorkspaceMode;
  onMode: (mode: WorkspaceMode) => void;
  network: NetworkSummary;
  selectedCable: string;
  onSelectCable: (name: string) => void;
  networkLayers: { submarine: boolean; terrestrial: boolean; landings: boolean };
  onNetworkLayers: (next: { submarine: boolean; terrestrial: boolean; landings: boolean }) => void;
}) {
  const [fromId, setFromId] = useState("tempe");
  const [toId, setToId] = useState("london");
  const [routes, setRoutes] = useState<TraceCandidate[]>([]);
  const [routeFrom, setRouteFrom] = useState<City | null>(null);
  const [routeTo, setRouteTo] = useState<City | null>(null);
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState<"idle" | "loading" | "snapshot" | "fallback">("idle");
  const [error, setError] = useState("");
  const [cableQuery, setCableQuery] = useState("");
  const [cableError, setCableError] = useState("");
  const request = useRef<AbortController | null>(null);
  const from = CITIES.find((city) => city.id === fromId)!;
  const to = CITIES.find((city) => city.id === toId)!;
  const cityOptions = [...new Set(CITIES.map((city) => city.continent))].map(
    (continent) => <optgroup key={continent} label={continent}>
      {CITIES.filter((city) => city.continent === continent).map((city) =>
        <option key={city.id} value={city.id}>{city.name}</option>)}
    </optgroup>);

  const choose = (index: number, next = routes,
                  source = routeFrom!, destination = routeTo!) => {
    setActive(index);
    onTrace(source, destination, next[index]!, next);
  };

  const findRoutes = async (source: City, destination: City) => {
    setError("");
    request.current?.abort();
    if (source.id === destination.id) {
      setStatus("idle");
      return setError("Choose two different cities.");
    }
    const controller = new AbortController();
    request.current = controller;
    setStatus("loading");
    try {
      let data: any, fromSnapshot = import.meta.env.VITE_STATIC_ROUTES === "1";
      if (fromSnapshot) {
        data = await snapshotRoute(source, destination);
      } else {
        try {
          const response = await fetch(new URL("api/route", document.baseURI), {
            method: "POST", signal: controller.signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ source, destination }),
          });
          if (!response.ok) throw new Error(`route service returned ${response.status}`);
          data = await response.json();
        } catch (cause) {
          if ((cause as Error).name === "AbortError") throw cause;
          data = await snapshotRoute(source, destination);
          fromSnapshot = true;
        }
      }
      if (controller.signal.aborted) throw new DOMException("aborted", "AbortError");
      const next = candidates(data);
      if (!next.length) throw new Error("route service returned invalid data");
      setRoutes(next); setRouteFrom(source); setRouteTo(destination);
      setStatus(fromSnapshot ? "snapshot" : "idle");
      choose(0, next, source, destination);
    } catch (cause) {
      if ((cause as Error).name === "AbortError") return;
      const next = [fallback(source, destination)];
      setRoutes(next); setRouteFrom(source); setRouteTo(destination); setStatus("fallback");
      choose(0, next, source, destination);
    }
  };

  useEffect(() => {
    void findRoutes(CITIES.find((city) => city.id === "tempe")!,
      CITIES.find((city) => city.id === "london")!);
    return () => request.current?.abort();
  }, []);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void findRoutes(from, to);
  };
  const swap = () => { setFromId(toId); setToId(fromId); setError(""); };
  const showLive = () => {
    request.current?.abort();
    setRoutes([]); setRouteFrom(null); setRouteTo(null); setStatus("idle"); onLive();
  };
  const current = routes[active];
  const seaKm = current?.segments.filter((segment) => segment.kind === "submarine")
    .reduce((sum, segment) => sum + segment.km, 0) ?? 0;
  const landKm = current?.segments.filter((segment) => segment.kind === "terrestrial")
    .reduce((sum, segment) => sum + segment.km, 0) ?? 0;
  const routeStops = current?.segments.reduce<string[]>((stops, segment) => {
    if (!stops.length) stops.push(segment.from);
    if (stops.at(-1) !== segment.to) stops.push(segment.to);
    return stops;
  }, []) ?? [];
  const selectCable = (event: React.FormEvent) => {
    event.preventDefault();
    const query = cableQuery.trim().toLocaleLowerCase();
    const match = network.cableNames.find((name) => name.toLocaleLowerCase() === query) ??
      network.cableNames.find((name) => name.toLocaleLowerCase().includes(query));
    if (!query || !match) return setCableError("No mapped cable matches that name.");
    setCableQuery(match); setCableError(""); onSelectCable(match);
  };

  return (
    <aside className="trace-panel" aria-label="Trace a signal between cities">
      <header className="brand-row">
        <div className="brand-lockup">
          <svg className="brand-mark" viewBox="0 0 44 44" aria-hidden="true">
            <path d="M4 12c8-7 14-7 22 0s14 7 18 3" />
            <path d="M2 22c9-7 16-7 24 0s13 7 18 3" />
            <path d="M4 32c8-7 14-7 22 0s14 7 18 3" />
          </svg>
          <div><h1>Downlink</h1><p>Trace the physical path</p></div>
        </div>
      </header>

      <nav className="workspace-tabs" aria-label="Downlink views">
        {([['routes', 'Route explorer'], ['network', 'Network atlas'], ['data', 'Data']] as const)
          .map(([value, label]) => <button key={value} type="button"
            aria-pressed={mode === value} aria-controls={`${value}-panel`}
            className={mode === value ? "active" : ""} onClick={() => onMode(value)}>
            {label}
          </button>)}
      </nav>

      {mode === "routes" && <div id="routes-panel">
      <form className="trace-form" onSubmit={submit}>
        <div className="city-fields">
          <label>From
            <select value={fromId} onChange={(event) => setFromId(event.target.value)}>
              {cityOptions}
            </select>
          </label>
          <button className="swap" type="button" onClick={swap} aria-label="Swap source and destination">
            <svg className="button-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M7 4v16m0-16L3.5 7.5M7 4l3.5 3.5M17 20V4m0 16-3.5-3.5M17 20l3.5-3.5"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Swap
          </button>
          <label>To
            <select value={toId} onChange={(event) => setToId(event.target.value)}>
              {cityOptions}
            </select>
          </label>
        </div>
        <button className="trace-button" disabled={status === "loading"}>
          <svg className="button-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="5" cy="17" r="2.5" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="19" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M7.2 15.6 16.8 8.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          {status === "loading" ? "Finding routes…" : "Trace route"}
        </button>
        {error && <p className="trace-error" role="alert">{error}</p>}
      </form>

      <section className="trace-result" aria-live="polite" aria-busy={status === "loading"}>
        <div className="result-heading">
          <div><h2 className="route-options-heading">Route options</h2>
            <p className="route-pair">{routeFrom && routeTo ? `${routeFrom.name} → ${routeTo.name}` : "Select a city pair"}</p></div>
          {current && <div className="result-actions">
            <label className="place-toggle" title="Show intermediate route locations on the map">
              <input type="checkbox" checked={showPlaces}
                onChange={(event) => onShowPlaces(event.target.checked)} />
              Route places
            </label>
            <button className="fit-button" type="button" onClick={onFit}>Fit map</button>
          </div>}
        </div>
        {current && routes.length < 3 && status !== "fallback" &&
          <p className="route-availability">{routes.length} distinct candidate{routes.length === 1 ? "" : "s"} found. The topology contains no additional non-duplicate cable path for this pair.</p>}

        {!current && <p className="trace-empty">Choose two cities to compare modeled cable and terrestrial paths.</p>}
        {current && <div className="route-options">
          {routes.map((route, index) => {
            const color = ROUTE_COLORS[index]!;
            return <button key={`${route.name}-${index}`} type="button"
              className={`route-card ${index === active ? "active" : ""}`}
              style={{ "--route-color": color.css } as CSSProperties}
              aria-label={`Route ${index + 1}, ${routeTitle(route)}, ${Math.round(route.pathKm).toLocaleString()} kilometers`}
              aria-pressed={index === active} onClick={() => choose(index)}>
              <span className="route-number" aria-hidden="true">{index + 1}</span>
              <span className="route-card-body">
                <span className="route-card-top"><span>Route {index + 1}</span>
                  {index === active && <span className="selected-label">Selected</span>}</span>
                <strong>{routeTitle(route)}</strong>
                <span className="route-metrics">
                  <span>{Math.round(route.pathKm).toLocaleString()} km</span>
                  <span>~{Math.round(route.rttMs)} ms RTT</span>
                </span>
              </span>
            </button>;
          })}
        </div>}

        {current && <div className="route-detail">
          <dl>
            <div><dt>Submarine</dt><dd>{Math.round(seaKm).toLocaleString()} km</dd></div>
            <div><dt>Modeled land</dt><dd>{Math.round(landKm).toLocaleString()} km</dd></div>
            <div><dt>Graph fit</dt><dd>{Math.round(current.confidence * 100)}%</dd></div>
          </dl>
          <p className="infrastructure"><span>Cable systems</span>
            {current.cables.length ? current.cables.join(" · ") : "No named cable path available"}
          </p>
          {routeStops.length > 2 && <details className="route-stops">
            <summary>Path sequence · {routeStops.length} places</summary>
            <ol>{routeStops.map((stop, index) => <li key={`${index}-${stop}`}>{stop}</li>)}</ol>
          </details>}
        </div>}

        {status === "fallback" && <p className="trace-warning">
          Topology service unavailable. Showing a great-circle estimate only.
        </p>}
        {status === "snapshot" && <p className="snapshot-note">
          Using the bundled topology snapshot — no local services required.
        </p>}
      </section>

      <footer className="panel-footer">
        <div className="infrastructure-legend" aria-label="Infrastructure line styles">
          <div><span className="legend-stroke solid" aria-hidden="true" />Mapped submarine cable</div>
          <div><span className="legend-stroke dashed" aria-hidden="true" />Modeled terrestrial connection</div>
        </div>
        <p>All routes are infrastructure candidates, not measured packet paths. Latency is a fibre propagation floor.</p>
        <button className="text-button live-button" type="button" onClick={showLive}>Show live traffic view</button>
      </footer>
      </div>}

      {mode === "network" && <section id="network-panel" className="atlas-panel">
        <div className="panel-heading"><h2>Global network atlas</h2>
          <p>Browse every mapped cable system and the modeled land links that connect the route graph.</p></div>
        {network.loading && <p className="trace-empty">Loading the network database…</p>}
        {network.error && <p className="trace-error" role="alert">{network.error}</p>}
        {!network.loading && !network.error && <>
          <dl className="atlas-counts">
            <div><dt>Cable systems</dt><dd>{network.cables.toLocaleString()}</dd></div>
            <div><dt>Land links</dt><dd>{network.terrestrial.toLocaleString()}</dd></div>
            <div><dt>Landing points</dt><dd>{network.landings.toLocaleString()}</dd></div>
          </dl>
          <form className="cable-search" onSubmit={selectCable}>
            <label htmlFor="cable-name">Find a cable system</label>
            <div><input id="cable-name" list="cable-names" value={cableQuery}
              onChange={(event) => setCableQuery(event.target.value)}
              placeholder="e.g. FASTER" autoComplete="off" />
              <button type="submit">Locate</button></div>
            <datalist id="cable-names">{network.cableNames.map((name) =>
              <option key={name} value={name} />)}</datalist>
            {cableError && <p className="trace-error" role="alert">{cableError}</p>}
          </form>
          {selectedCable && <div className="selected-cable">
            <span>Selected cable</span><strong>{selectedCable}</strong>
            <button type="button" className="text-button" onClick={() => {
              setCableQuery(""); setCableError(""); onSelectCable("");
            }}>Show all systems</button>
          </div>}
          <fieldset className="layer-controls"><legend>Visible layers</legend>
            {([['submarine', 'Submarine cables'], ['terrestrial', 'Modeled terrestrial'],
               ['landings', 'Landing points']] as const).map(([key, label]) =>
              <label key={key}><input type="checkbox" checked={networkLayers[key]}
                onChange={(event) => onNetworkLayers({
                  ...networkLayers, [key]: event.target.checked,
                })} />{label}</label>)}
          </fieldset>
        </>}
        <p className="atlas-note">Cable geometry is mapped infrastructure. Land links are modeled connections, not carrier-published fibre routes.</p>
      </section>}

      {mode === "data" && <section id="data-panel" className="data-panel">
        <div className="panel-heading"><h2>Data & methodology</h2>
          <p>What the map knows, what it models, and what it cannot prove.</p></div>
        <dl className="data-ledger">
          <div><dt>Route cities</dt><dd>{CITIES.length}</dd><p>Grouped across six named continents.</p></div>
          <div><dt>Directed city pairs</dt><dd>{(CITIES.length * (CITIES.length - 1)).toLocaleString()}</dd><p>Static and available without Docker.</p></div>
          <div><dt>Mapped cable systems</dt><dd>{network.cables ? network.cables.toLocaleString() : "Loading…"}</dd><p>Full source geometry, including multipart systems.</p></div>
          <div><dt>Landing points</dt><dd>{network.landings ? network.landings.toLocaleString() : "Loading…"}</dd><p>Published coastal stations in the topology snapshot.</p></div>
          <div><dt>Modeled land links</dt><dd>{network.terrestrial ? network.terrestrial.toLocaleString() : "Loading…"}</dd><p>Distance-weighted metro and landing-station links.</p></div>
          <div><dt>Submarine source</dt><dd><a href="https://www.submarinecablemap.com/" target="_blank" rel="noreferrer">TeleGeography</a></dd><p>Published cable geometry and landing stations.</p></div>
          <div><dt>Project source</dt><dd><a href="https://github.com/varad-more/downlink" target="_blank" rel="noreferrer">GitHub</a></dd><p>Open-source application code under the MIT License.</p></div>
          <div><dt>License</dt><dd>CC BY-SA 4.0</dd><p>Applies to the TeleGeography-derived snapshot.</p></div>
          <div><dt>Packet certainty</dt><dd>Candidate only</dd><p>A public trace cannot prove the operator’s physical cable.</p></div>
        </dl>
        {network.generatedAt && <p className="data-date">Atlas generated {new Date(network.generatedAt).toLocaleDateString()}.</p>}
      </section>}
    </aside>
  );
}
