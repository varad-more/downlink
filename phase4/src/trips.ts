/*
 * Fixed-capacity trip store for a 24/7 kiosk.
 *
 * Two properties matter and neither is negotiable at three in the morning
 * on day nine:
 *
 *  1. Nothing grows. Capacity is fixed, the typed arrays are allocated once
 *     at construction and never reallocated, and expired trips are pruned on
 *     every tick.
 *  2. GPU buffers are only rebuilt when the trip SET changes, never for a
 *     change of currentTime. Animation costs one uniform per frame.
 */
const MAX_TRIPS = 1500;
const MAX_POINTS_PER_TRIP = 160;
const VERTEX_BUDGET = MAX_TRIPS * 64;   // typical simplified path is 4-90 pts

export const TRAIL_MS = 900;
export type Method = "route" | "greatcircle" | "pop";

export interface Trip {
  id: number;
  t0: number;
  t1: number;
  nPoints: number;
  offset: number;   // first vertex index in the shared arrays
}

/** Colour by inference method and confidence. A low-confidence guess must
 *  not look like a measurement. */
function colorFor(method: Method, conf: number): [number, number, number] {
  // route = cyan, greatcircle = amber, pop = magenta.
  const base: [number, number, number] =
    method === "route" ? [80, 230, 255]
      : method === "pop" ? [255, 95, 190] : [255, 176, 64];
  // Confidence dims, but the floor is high enough that a 0.3-confidence
  // amber still reads as amber on a wall instead of as mud. Anything below
  // 0.55 of full luminance disappears into the basemap at throw distance.
  const k = 0.55 + 0.45 * Math.max(0, Math.min(1, conf));
  return [base[0] * k, base[1] * k, base[2] * k];
}

export class TripStore {
  private trips: Trip[] = [];
  private nextVertex = 0;
  readonly positions = new Float32Array(VERTEX_BUDGET * 2);
  readonly timestamps = new Float32Array(VERTEX_BUDGET);
  readonly colors = new Uint8Array(VERTEX_BUDGET * 3);
  readonly widths = new Float32Array(VERTEX_BUDGET);
  private startIndices = new Uint32Array(MAX_TRIPS + 1);
  private dirty = true;
  private _data: any = null;
  dropped = 0;

  get size() { return this.trips.length; }

  clear() {
    this.trips.length = 0;
    this.nextVertex = 0;
    this.dirty = true;
  }

  add(path: Float32Array, method: Method, conf: number, bytesKb: number,
      rttMs: number, now: number,
      color?: readonly [number, number, number]) {
    const sourcePoints = path.length >> 1;
    if (sourcePoints < 2) return;
    const n = Math.min(sourcePoints, MAX_POINTS_PER_TRIP);
    const sourceIndex = (i: number) => sourcePoints === n ? i :
      Math.round(i * (sourcePoints - 1) / (n - 1));

    // Animation duration is proportional to measured RTT, so Singapore
    // visibly takes longer to cross the wall than San Jose.
    const dur = Math.max(600, Math.min(8000, rttMs * 20));

    if (this.nextVertex + n > VERTEX_BUDGET || this.trips.length >= MAX_TRIPS) {
      this.compact(now);
      if (this.nextVertex + n > VERTEX_BUDGET || this.trips.length >= MAX_TRIPS) {
        this.trips.shift();          // still full: oldest goes
        this.dropped++;
        this.compact(now, true);
        if (this.nextVertex + n > VERTEX_BUDGET) return;
      }
    }

    const off = this.nextVertex;
    // Distribute timestamps by cumulative arc length so the head travels at
    // constant speed instead of lurching between densely-sampled vertices.
    let total = 0;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const here = sourceIndex(i), previous = sourceIndex(i - 1);
      const dx = path[here * 2]! - path[previous * 2]!;
      const dy = path[here * 2 + 1]! - path[previous * 2 + 1]!;
      total += Math.hypot(dx, dy);
      cum[i] = total;
    }
    const [r, g, b] = color ?? colorFor(method, conf);
    const w = 1.2 + Math.min(6, Math.log2(1 + Math.max(0, bytesKb)) * 0.8);
    for (let i = 0; i < n; i++) {
      const vi = off + i;
      const source = sourceIndex(i);
      this.positions[vi * 2] = path[source * 2]!;
      this.positions[vi * 2 + 1] = path[source * 2 + 1]!;
      this.timestamps[vi] = now + (total > 0 ? (cum[i]! / total) * dur : 0);
      this.colors[vi * 3] = r;
      this.colors[vi * 3 + 1] = g;
      this.colors[vi * 3 + 2] = b;
      this.widths[vi] = w;
    }
    this.nextVertex += n;
    this.trips.push({ id: 0, t0: now, t1: now + dur, nPoints: n, offset: off });
    this.dirty = true;
  }

  /** Drop trips whose trail has fully faded, then repack the vertex arrays. */
  prune(currentTime: number) {
    const cutoff = currentTime - TRAIL_MS;
    let i = 0;
    while (i < this.trips.length && this.trips[i]!.t1 < cutoff) i++;
    if (i === 0) return;
    this.trips.splice(0, i);
    this.compact(currentTime, true);
  }

  private compact(currentTime: number, force = false) {
    const cutoff = currentTime - TRAIL_MS;
    if (!force) {
      let i = 0;
      while (i < this.trips.length && this.trips[i]!.t1 < cutoff) i++;
      if (i === 0) return;
      this.trips.splice(0, i);
    }
    // Slide surviving vertices down to the front. Trips are append-ordered
    // so this is one forward pass, never a sort.
    let w = 0;
    for (const t of this.trips) {
      if (t.offset !== w) {
        this.positions.copyWithin(w * 2, t.offset * 2, (t.offset + t.nPoints) * 2);
        this.timestamps.copyWithin(w, t.offset, t.offset + t.nPoints);
        this.colors.copyWithin(w * 3, t.offset * 3, (t.offset + t.nPoints) * 3);
        this.widths.copyWithin(w, t.offset, t.offset + t.nPoints);
        t.offset = w;
      }
      w += t.nPoints;
    }
    this.nextVertex = w;
    this.dirty = true;
  }

  /** deck.gl binary attribute payload. Identity-stable while nothing has
   *  changed, so the layer diff skips the buffer upload entirely. */
  data() {
    if (!this.dirty && this._data) return this._data;
    const n = this.trips.length;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      this.startIndices[i] = acc;
      acc += this.trips[i]!.nPoints;
    }
    this.startIndices[n] = acc;
    this._data = {
      length: n,
      startIndices: this.startIndices.subarray(0, n + 1),
      attributes: {
        getPath: { value: this.positions.subarray(0, acc * 2), size: 2 },
        getTimestamps: { value: this.timestamps.subarray(0, acc), size: 1 },
        getColor: { value: this.colors.subarray(0, acc * 3), size: 3 },
        getWidth: { value: this.widths.subarray(0, acc), size: 1 },
      },
    };
    this.dirty = false;
    return this._data;
  }

  stats() {
    return { trips: this.trips.length, vertices: this.nextVertex,
             capacity: MAX_TRIPS, vertexBudget: VERTEX_BUDGET,
             dropped: this.dropped };
  }
}
