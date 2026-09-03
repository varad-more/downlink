/*
 * Phase 4 headless gate.
 *
 * Two things are checked here because both can be checked without a GPU:
 *
 *  1. PATH GEOMETRY. A great circle that crosses the antimeridian is the
 *     one case where wrong geometry is invisible in code review and
 *     unmissable on a wall, so it is asserted numerically here.
 *
 *  2. TRIP STORE SOAK. TripStore is where a 24/7 kiosk leaks, and it has no
 *     DOM dependency, so a simulated hour runs here in seconds. This does
 *     NOT replace the browser soak (?soak=1&speed=10) -- it cannot see
 *     WebGL buffers or frame timings -- but it does prove the ring buffer,
 *     the pruning and the compaction under an hour of traffic.
 */
import { TripStore, TRAIL_MS } from "../phase4/src/trips.ts";
import { gcArc, isPathEndpoint, unwrapPath } from "../phase4/src/geo.ts";
import { placeLabel, type LabelBox } from "../phase4/src/labels.ts";

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) { failures++; console.log("  FAIL " + msg); }
};

const boxes: LabelBox[] = [];
for (let i = 0; i < 12; i++) placeLabel([160, 150], [140, 24], boxes, [0, 0, 320, 300]);
check(boxes.every((box) => box[0] >= 0 && box[1] >= 0 && box[2] <= 320 && box[3] <= 300),
      "route-place label escaped the visible map area");
check(boxes.every((box, i) => boxes.slice(i + 1).every((other) =>
  box[2] <= other[0] || box[0] >= other[2] || box[3] <= other[1] || box[1] >= other[3])),
  "dense route-place labels overlap or disappear");

// ---------------------------------------------------------------- 1. soak

const SIM_HOURS = Number(process.env.SOAK_HOURS ?? 1);
const RATE = Number(process.env.SOAK_RATE ?? 60);   // trips/sec added
const store = new TripStore();
const paths = [2, 4, 30, 60, 90, 128].map((n, i) => {
  const f = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) {
    f[k * 2] = -111.9 + (k / n) * (i * 40 - 100);
    f[k * 2 + 1] = 33.4 + Math.sin(k / 6) * 20;
  }
  return f;
});

const totalMs = SIM_HOURS * 3600_000;
const stepMs = 1000 / RATE;
let t = 0, n = 0;
if (global.gc) global.gc();
const h0 = process.memoryUsage().heapUsed;
let maxTrips = 0, maxVerts = 0;
const residentSamples: number[] = [];
let nextSample = totalMs / 12;

while (t < totalMs) {
  const p = paths[n % paths.length]!;
  const method = (["route", "greatcircle", "pop"] as const)[n % 3]!;
  store.add(p, method, (n % 100) / 100, 1 + (n % 4000), 20 + (n % 280), t);
  store.prune(t);
  const s = store.stats();
  if (s.trips > maxTrips) maxTrips = s.trips;
  if (s.vertices > maxVerts) maxVerts = s.vertices;
  if (n % 97 === 0) store.data();          // exercise the buffer rebuild
  if (t >= nextSample) { residentSamples.push(s.trips); nextSample += totalMs / 12; }
  t += stepMs;
  n++;
}
store.data();
if (global.gc) global.gc();
const h1 = process.memoryUsage().heapUsed;
const s = store.stats();
const growthMb = (h1 - h0) / 1e6;

console.log("\n2. trip store soak");
console.log("   simulated       %s h at %d trips/sec (%d trips added)", SIM_HOURS, RATE, n);
console.log("   trips resident  %d (peak %d, cap %d)", s.trips, maxTrips, s.capacity);
console.log("   vertices        %d (peak %d, budget %d)", s.vertices, maxVerts, s.vertexBudget);
console.log("   overflow drops  %d", s.dropped);
console.log(`   heap delta      ${growthMb >= 0 ? "+" : ""}${growthMb.toFixed(2)} MB`);
console.log("   resident/12ths  %s", residentSamples.join(" "));

check(maxTrips <= s.capacity, `trip count exceeded capacity: ${maxTrips}`);
check(maxVerts <= s.vertexBudget, `vertex count exceeded budget: ${maxVerts}`);
check(growthMb < 4, `heap grew ${growthMb.toFixed(2)} MB over ${SIM_HOURS} simulated hour(s)`);

// Oversize paths are thinned, not truncated: the destination must survive.
const longPath = new Float32Array(600);
for (let i = 0; i < 300; i++) { longPath[i * 2] = i; longPath[i * 2 + 1] = -i; }
const thin = new TripStore();
thin.add(longPath, "route", 1, 1, 20, 0);
check(thin.stats().vertices === 160, "oversize path was not capped at 160 points");
check(thin.positions[318] === 299 && thin.positions[319] === -299,
      "path thinning discarded the destination");
thin.clear();
check(thin.stats().trips === 0 && thin.stats().vertices === 0 && thin.data().length === 0,
      "clear left stale route data visible");

// A trip lives for its duration (RTT-proportional, capped at 8 s) plus the
// trail, so the steady-state resident count is RATE * (8 + TRAIL) at worst.
const ceiling = RATE * (8000 + TRAIL_MS) / 1000 + 10;
check(maxTrips <= ceiling, `resident trips ${maxTrips} above the theoretical ceiling ${ceiling.toFixed(0)}`);

// The property that actually matters for a kiosk: it does not CREEP. Compare
// the first quarter of the run against the last.
const early = residentSamples.slice(1, 4);
const late = residentSamples.slice(-3);
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1);
check(avg(late) < avg(early) * 1.15 + 10,
      `resident trips crept from ${avg(early).toFixed(0)} to ${avg(late).toFixed(0)}`);

// ---------------------------------------------------------------- geometry
//
// Phoenix -> Tokyo is the interesting case: the arc crosses the antimeridian
// and reaches ~50N, far north of either endpoint. Raw atan2 output therefore
// contains a ~357 degree jump, which PathLayer would draw as a horizontal
// streak across the entire map. After unwrapping there must be no jump.
console.log("\ngreat-circle geometry");
{
  const HOME_LAT = 33.4255, HOME_LON = -111.94;
  const arc = gcArc(HOME_LAT, HOME_LON, 35.68, 139.69, 48);
  const lons = () => Array.from({ length: arc.length >> 1 }, (_, i) => arc[i * 2]!);
  const lats = Array.from({ length: arc.length >> 1 }, (_, i) => arc[i * 2 + 1]!);
  const maxJump = (a: number[]) =>
    a.slice(1).reduce((m, v, i) => Math.max(m, Math.abs(v - a[i]!)), 0);

  check(Math.abs(arc[0]! - HOME_LON) < 1e-4 && Math.abs(arc[1]! - HOME_LAT) < 1e-4,
        "arc does not start at the origin");
  check(Math.abs(arc[arc.length - 2]! - 139.69) < 1e-4 &&
        Math.abs(arc[arc.length - 1]! - 35.68) < 1e-4,
        "arc does not end at the destination");
  check(Math.max(...lats) > 45,
        `arc peaks at ${Math.max(...lats).toFixed(1)}N -- that is a lerp, not a great circle`);
  check(maxJump(lons()) > 180, "test premise broken: this arc should wrap in raw form");

  unwrapPath(arc, HOME_LON);
  check(maxJump(lons()) < 10,
        `unwrapped arc still jumps ${maxJump(lons()).toFixed(0)} degrees`);
  check(Math.abs(arc[arc.length - 2]! - (139.69 - 360)) < 1e-3,
        `Tokyo unwrapped to ${arc[arc.length - 2]!.toFixed(2)}, expected -220.31`);
  check(Math.abs(arc[arc.length - 1]! - 35.68) < 1e-4, "unwrap moved a latitude");
  check(isPathEndpoint([HOME_LON, HOME_LAT], arc) &&
        isPathEndpoint([arc[arc.length - 2]!, 35.68], arc),
        "route endpoints were not recognised for label collision filtering");
  check(!isPathEndpoint([-180, 45], arc),
        "an intermediate route place was mistaken for an endpoint");

  // A westward arc that does not cross must be left exactly alone.
  const ams = gcArc(HOME_LAT, HOME_LON, 52.37, 4.90, 48);
  const before = ams[ams.length - 2]!;
  unwrapPath(ams, HOME_LON);
  check(ams[ams.length - 2]! === before, "unwrap moved a path that never wrapped");
  console.log(`  arc peaks ${Math.max(...lats).toFixed(1)}N, Tokyo at ${arc[arc.length - 2]!.toFixed(2)} lon`);
}

console.log("\n%s", failures === 0
  ? "PHASE 4 HEADLESS PASS: arcs unwrapped, trip store bounded and flat."
  : `PHASE 4 HEADLESS FAIL: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
