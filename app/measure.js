// Measurement scales, units, geometry and label formatting.
//
// A scale is { mPerPt, unit, label }: real-world metres per PDF point
// (1 pt = 1/72 inch on paper), the unit used for display, and a short name
// such as "1:100" or `1/4" = 1'-0"`.

export const PT_M = 0.0254 / 72; // metres per point on paper

// m: metres per unit. Areas are shown in `area`, whose side is `am` metres
// (millimetre and centimetre drawings report areas in m², as on drawings).
export const UNITS = {
  mm: { m: 0.001, name: "Millimetres", label: "mm", area: "m²", am: 1, dp: 0, adp: 2 },
  cm: { m: 0.01, name: "Centimetres", label: "cm", area: "m²", am: 1, dp: 1, adp: 2 },
  m: { m: 1, name: "Metres", label: "m", area: "m²", dp: 2, adp: 2 },
  km: { m: 1000, name: "Kilometres", label: "km", area: "km²", dp: 3, adp: 3 },
  in: { m: 0.0254, name: "Inches", label: "in", area: "in²", dp: 2, adp: 1 },
  ft: { m: 0.3048, name: "Feet (decimal)", label: "ft", area: "ft²", dp: 2, adp: 2 },
  ftin: { m: 0.3048, name: "Feet and inches", label: "ft", area: "ft²", dp: 2, adp: 2 },
};

export const METRIC_RATIOS = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 200, 250, 500, 1000, 1250, 2000, 2500, 5000];

// [label, paper inches, real feet]
export const IMPERIAL_SCALES = [
  ['1/16" = 1\'-0"', 1 / 16, 1],
  ['3/32" = 1\'-0"', 3 / 32, 1],
  ['1/8" = 1\'-0"', 1 / 8, 1],
  ['3/16" = 1\'-0"', 3 / 16, 1],
  ['1/4" = 1\'-0"', 1 / 4, 1],
  ['3/8" = 1\'-0"', 3 / 8, 1],
  ['1/2" = 1\'-0"', 1 / 2, 1],
  ['3/4" = 1\'-0"', 3 / 4, 1],
  ['1" = 1\'-0"', 1, 1],
  ['1 1/2" = 1\'-0"', 1.5, 1],
  ['3" = 1\'-0"', 3, 1],
  ['1" = 10\'', 1, 10],
  ['1" = 20\'', 1, 20],
  ['1" = 30\'', 1, 30],
  ['1" = 40\'', 1, 40],
  ['1" = 50\'', 1, 50],
  ['1" = 60\'', 1, 60],
  ['1" = 100\'', 1, 100],
];

export function ratioScale(n, unit = "mm") {
  return { mPerPt: n * PT_M, unit, label: "1:" + fmtNum(n, n % 1 ? 2 : 0) };
}

export function imperialScale(label, paperIn, realFt, unit = "ftin") {
  return { mPerPt: (realFt * 0.3048) / (paperIn * 72), unit, label };
}

export function calibratedScale(realMetres, lengthPt, unit) {
  const mPerPt = realMetres / lengthPt;
  return { mPerPt, unit, label: "Calibrated ≈ 1:" + fmtNum(sig3(mPerPt / PT_M), null) };
}

export const DEFAULT_SCALE = { mPerPt: PT_M, unit: "mm", label: "1:1", unset: true };

// Equivalent drawing ratio (1:N) for display.
export function ratioOf(sc) {
  return sc.mPerPt / PT_M;
}

export function sameScale(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.mPerPt - b.mPerPt) <= 1e-9 * Math.max(a.mPerPt, b.mPerPt) && a.unit === b.unit;
}

function sig3(v) {
  if (!isFinite(v) || v <= 0) return v;
  const p = Math.pow(10, 2 - Math.floor(Math.log10(v)));
  return Math.round(v * p) / p;
}

export function fmtNum(v, dp) {
  if (dp == null) return v.toLocaleString(undefined, { maximumFractionDigits: 3 });
  return v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function gcd(a, b) { return b ? gcd(b, a % b) : a; }

// 12'-6 1/2"  (rounded to 1/16")
export function fmtFeetInches(inches, den = 16) {
  let total = Math.round(Math.abs(inches) * den);
  const feet = Math.floor(total / (12 * den));
  total -= feet * 12 * den;
  const whole = Math.floor(total / den);
  let frac = total - whole * den;
  let s = `${feet}'-${whole}`;
  if (frac) { const g = gcd(frac, den); s += ` ${frac / g}/${den / g}`; }
  return (inches < 0 ? "-" : "") + s + '"';
}

export function fmtLength(pt, sc, dp = null) {
  const m = pt * sc.mPerPt;
  if (sc.unit === "ftin") return fmtFeetInches(m / 0.0254);
  const u = UNITS[sc.unit] || UNITS.mm;
  return fmtNum(m / u.m, dp ?? u.dp) + " " + u.label;
}

export function fmtArea(pt2, sc, dp = null) {
  const u = UNITS[sc.unit] || UNITS.mm;
  const side = u.am || u.m;
  const v = (pt2 * sc.mPerPt * sc.mPerPt) / (side * side);
  return fmtNum(v, dp ?? u.adp) + " " + u.area;
}

// ---------------------------------------------------------------- geometry
export function dist(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }

export function pathLength(pts, closed = false) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) s += dist(pts[pts.length - 1], pts[0]);
  return s;
}

export function polyArea(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(s) / 2;
}

export function polyCentroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    a += f;
    cx += (pts[j][0] + pts[i][0]) * f;
    cy += (pts[j][1] + pts[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = pts.length || 1;
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

// Annotation type for each measuring mode.
export const MODE_TYPES = { distance: "Line", path: "PolyLine", area: "Polygon", calibrate: "Line" };

// Label lines for a measurement: { main, sub, contents } (contents is what
// other PDF apps show in the annotation's note).
export function measureText(type, pts, sc, dp = null) {
  if (type === "Polygon") {
    const area = fmtArea(polyArea(pts), sc, dp);
    const per = fmtLength(pathLength(pts, true), sc, dp);
    return { main: area, sub: "Perimeter " + per, contents: `Area ${area}\nPerimeter ${per}`, value: area };
  }
  const len = fmtLength(pathLength(pts), sc, dp);
  if (type === "PolyLine") return { main: len, sub: "", contents: "Length " + len, value: len };
  return { main: len, sub: "", contents: len, value: len };
}
