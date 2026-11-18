// Pen strokes whose width follows the pen's pressure. Shared by the viewer
// (live drawing and display) and the engine (the saved appearance), so a
// stroke looks the same everywhere.

// Width for a pen pressure (0..1) around the chosen width: light touch is
// thinner, firm pressure thicker; normal pressure gives about the chosen width.
export function pressureWidth(base, p) {
  const q = Math.max(0, Math.min(1, p));
  return base * (0.4 + 1.2 * Math.pow(q, 0.9));
}

// Outline of a stroke through `pts` with a width per point, as one closed
// polygon with round ends (fill with the nonzero rule).
export function strokeOutline(pts, widths) {
  const n = pts.length;
  if (!n) return [];
  if (n === 1 || (n === 2 && pts[0][0] === pts[1][0] && pts[0][1] === pts[1][1])) return circle(pts[0], widths[0] / 2);
  const left = [], right = [], dirs = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const r = widths[i] / 2;
    dirs.push(Math.atan2(dy, dx));
    left.push([pts[i][0] - dy * r, pts[i][1] + dx * r]);
    right.push([pts[i][0] + dy * r, pts[i][1] - dx * r]);
  }
  const out = left.slice();
  out.push(...cap(pts[n - 1], widths[n - 1] / 2, dirs[n - 1] + Math.PI / 2));
  for (let i = n - 1; i >= 0; i--) out.push(right[i]);
  out.push(...cap(pts[0], widths[0] / 2, dirs[0] - Math.PI / 2));
  return out;
}

// Half circle from angle a0, turning by -π (through the stroke's end).
function cap(c, r, a0) {
  const out = [], m = 6;
  for (let k = 1; k < m; k++) {
    const t = a0 - (Math.PI * k) / m;
    out.push([c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r]);
  }
  return out;
}

function circle(c, r) {
  const out = [];
  for (let k = 0; k < 12; k++) {
    const t = (Math.PI * 2 * k) / 12;
    out.push([c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r]);
  }
  return out;
}

// SVG path data for a closed polygon.
export function polyPath(poly) {
  if (!poly.length) return "";
  return "M" + poly.map((p) => (Math.round(p[0] * 100) / 100) + " " + (Math.round(p[1] * 100) / 100)).join("L") + "Z";
}
