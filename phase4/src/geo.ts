/*
 * Path geometry shared by the live feed and the synthetic one.
 *
 * Both of these exist because a lon/lat pair is not a plane coordinate and
 * pretending otherwise produces two very visible artefacts on a wall: routes
 * that go the wrong way round the globe, and a horizontal streak across the
 * whole map every time an arc crosses the antimeridian.
 */

/** Make a path's longitudes continuous, relative to a reference meridian.
 *
 *  Great-circle arcs come out of atan2 in [-180,180], so a Pacific crossing
 *  jumps +179 -> -179 and PathLayer draws a straight line between those two
 *  vertices -- right across the map. Unwrapping leaves longitudes outside
 *  [-180,180], which is correct: deck.gl renders world copies (MapLibre's
 *  renderWorldCopies defaults on), so a vertex at -220 draws in the copy to
 *  the left. Mutates in place. */
export function unwrapPath(path: Float32Array, refLon: number) {
  let prev = refLon;
  for (let i = 0; i < path.length; i += 2) {
    let lon = path[i]!;
    lon -= 360 * Math.round((lon - prev) / 360);
    path[i] = lon;
    prev = lon;
  }
}

export function isPathEndpoint(position: [number, number], path: Float32Array) {
  const last = path.length - 2;
  return Math.hypot(position[0] - path[0]!, position[1] - path[1]!) < .001 ||
    Math.hypot(position[0] - path[last]!, position[1] - path[last + 1]!) < .001;
}

/** Spherical interpolation between two points, mirroring
 *  resolver/resolve.py:gc_arc. A naive lon/lat lerp is not a route: for
 *  anything trans-Pacific it goes the long way round and it never bends
 *  poleward the way a real fibre run does. */
export function gcArc(lat1: number, lon1: number, lat2: number, lon2: number,
                      n = 48): Float32Array {
  const R = Math.PI / 180;
  const p1 = lat1 * R, l1 = lon1 * R, p2 = lat2 * R, l2 = lon2 * R;
  const d = 2 * Math.asin(Math.min(1, Math.sqrt(
    Math.sin((p2 - p1) / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2)));
  const out = new Float32Array(n * 2);
  const sd = Math.sin(d);
  const degenerate = sd < 1e-9;   // coincident or antipodal: no unique arc
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const a = degenerate ? 1 - f : Math.sin((1 - f) * d) / sd;
    const b = degenerate ? f : Math.sin(f * d) / sd;
    const x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
    const y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
    const z = a * Math.sin(p1) + b * Math.sin(p2);
    out[i * 2] = Math.atan2(y, x) / R;
    out[i * 2 + 1] = Math.atan2(z, Math.hypot(x, y)) / R;
  }
  return out;
}
