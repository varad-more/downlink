/*
 * Keystone correction.
 *
 * A projector is never square to the wall. Rather than deriving the geometry
 * from throw ratio and mount angle -- which requires measurements nobody
 * takes -- expose four corner handles and solve the homography empirically,
 * the way every working installation actually does it.
 *
 * Solves H mapping the unit rect (0,0),(w,0),(0,h),(w,h) onto four dragged
 * corners, and emits it as a CSS matrix3d (column-major).
 */
export type Corner = [number, number];
export type Corners = [Corner, Corner, Corner, Corner]; // TL, TR, BL, BR

const STORAGE_KEY = "downlink.keystone.v1";

type M9 = number[];

function adj(m: M9): M9 {
  return [
    m[4]! * m[8]! - m[5]! * m[7]!, m[2]! * m[7]! - m[1]! * m[8]!, m[1]! * m[5]! - m[2]! * m[4]!,
    m[5]! * m[6]! - m[3]! * m[8]!, m[0]! * m[8]! - m[2]! * m[6]!, m[2]! * m[3]! - m[0]! * m[5]!,
    m[3]! * m[7]! - m[4]! * m[6]!, m[1]! * m[6]! - m[0]! * m[7]!, m[0]! * m[4]! - m[1]! * m[3]!,
  ];
}

function mul(a: M9, b: M9): M9 {
  const c = new Array(9).fill(0) as M9;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) c[i * 3 + j]! += a[i * 3 + k]! * b[k * 3 + j]!;
  return c;
}

function mulv(m: M9, v: number[]): number[] {
  return [
    m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!,
    m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!,
    m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!,
  ];
}

function basis(x1: number, y1: number, x2: number, y2: number,
               x3: number, y3: number, x4: number, y4: number): M9 {
  const m: M9 = [x1, x2, x3, y1, y2, y3, 1, 1, 1];
  const v = mulv(adj(m), [x4, y4, 1]);
  return mul(m, [v[0]!, 0, 0, 0, v[1]!, 0, 0, 0, v[2]!]);
}

/** CSS matrix3d string mapping the w x h rect onto `c` (TL, TR, BL, BR). */
export function matrix3d(w: number, h: number, c: Corners): string {
  const s = basis(0, 0, w, 0, 0, h, w, h);
  const d = basis(c[0][0], c[0][1], c[1][0], c[1][1], c[2][0], c[2][1], c[3][0], c[3][1]);
  const t = mul(d, adj(s));
  for (let i = 0; i < 9; i++) t[i]! /= t[8]!;
  // CSS matrix3d is column-major; t is row-major 3x3.
  const m = [
    t[0], t[3], 0, t[6],
    t[1], t[4], 0, t[7],
    0, 0, 1, 0,
    t[2], t[5], 0, 1,
  ];
  return `matrix3d(${m.map((x) => (Math.abs(x!) < 1e-10 ? 0 : x)).join(",")})`;
}

export function identityCorners(w: number, h: number): Corners {
  return [[0, 0], [w, 0], [0, h], [w, h]];
}

/** Persisted to localStorage -- the kiosk's disk. Wrapped because a browser
 *  with site data blocked throws on access rather than returning null. */
export function load(w: number, h: number): Corners {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (Array.isArray(c) && c.length === 4) return c as Corners;
    }
  } catch { /* private window, cleared data, blocked storage */ }
  return identityCorners(w, h);
}

export function save(c: Corners) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(c)); } catch { /* ignore */ }
}

export function clear() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
