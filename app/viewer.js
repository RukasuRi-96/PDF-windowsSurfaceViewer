// Eagles PDF viewer: page view: continuous page layout, compositor-driven pan/zoom,
// tiled rendering, touch + pen gestures, and live vector annotations.

import { measureText, MODE_TYPES, DEFAULT_SCALE, pathLength, polyCentroid, sameScale } from "./measure.js";
import { pressureWidth, strokeOutline, polyPath } from "./inkgeom.js";

const SVGNS = "http://www.w3.org/2000/svg";
const TILE = 512;              // device pixels per tile edge
const BASE_PIXELS = 1.3e6;     // budget for the quick whole-page preview
const MAX_BASE_RES = 4;
const GAP = 14;                // css px between pages
const PAD = 16;                // css px around the document
const MIN_SCALE = 0.05;
const MAX_SCALE = 48;
const MAX_TILES = (navigator.deviceMemory || 8) <= 8 ? 180 : 260; // ~1 MB each
const MAX_BASES = 40;
const PALM_MS = 450;           // ignore touch this long after any pen activity

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => performance.now();

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}
function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

export function cssColor(c) {
  if (!c || !c.length) return "none";
  let r, g, b;
  if (c.length === 1) r = g = b = c[0];
  else if (c.length === 3) [r, g, b] = c;
  else { const [C, M, Y, K] = c; r = (1 - C) * (1 - K); g = (1 - M) * (1 - K); b = (1 - Y) * (1 - K); }
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function quadPoly(q) {
  // MuPDF quad order: ul, ur, ll, lr
  return [[q[0], q[1]], [q[2], q[3]], [q[6], q[7]], [q[4], q[5]]];
}

// Ramer–Douglas–Peucker simplification.
function simplify(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distSeg(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      if (d > max) { max = d; idx = i; }
    }
    if (max > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function smooth(pts) {
  if (pts.length < 4) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    out.push([(pts[i - 1][0] + 2 * pts[i][0] + pts[i + 1][0]) / 4, (pts[i - 1][1] + 2 * pts[i][1] + pts[i + 1][1]) / 4]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// The stroke exactly as drawn live: a quadratic curve through the midpoints
// of the pen's samples, flattened into short straight pieces (PDF ink is a
// polyline) at most `step` long. Small loops keep their shape.
function curveStroke(pts, step) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  let from = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const c = pts[i], to = c.map((v, j) => (v + pts[i + 1][j]) / 2);
    const len = Math.hypot(c[0] - from[0], c[1] - from[1]) + Math.hypot(to[0] - c[0], to[1] - c[1]);
    const n = Math.max(1, Math.min(16, Math.ceil(len / step)));
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t;
      out.push(c.map((_, j) => u * u * from[j] + 2 * u * t * c[j] + t * t * to[j]));
    }
    from = to;
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Cursor for a pen hovering over the page: a dot the size and colour of the ink.
function dotCursor(color, px) {
  const d = Math.round(Math.max(4, Math.min(26, px))), r = d / 2, s = d + 4, c = s / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><circle cx="${c}" cy="${c}" r="${r + 1}" fill="white" fill-opacity="0.85"/><circle cx="${c}" cy="${c}" r="${r}" fill="${color}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}, crosshair`;
}

// Tools a finger uses when "finger draws" is on (otherwise a finger pans).
const DRAW_TOOLS = new Set(["pen", "highlight", "box", "eraser", "select", "measure", "content", "snip"]);
// Signatures and pasted pictures: images that keep their proportions.
const isPic = (k) => k === "sig" || k === "image";
const FONT_CSS = { Helv: "Helvetica, Arial, sans-serif", TiRo: '"Times New Roman", Times, serif', Cour: '"Courier New", Courier, monospace' };
const round2 = (v) => Math.round(v * 100) / 100;
// A pen stroke with a width per point (drawn with pressure).
const inkWidths = (d) => d.widths && d.ink && d.ink.length === 1 && d.widths.length === d.ink[0].length;

// CSS font for typing over a line of the page (the real font is used once
// the edit is made): the installed family, else the PDF's font name.
function faceCss(face = {}) {
  const generic = face.mono ? "monospace" : face.serif ? "serif" : "sans-serif";
  const base = face.family || String(face.name || "").replace(/^[A-Z]{6}\+/, "").split(/[,-]/)[0].replace(/(PSMT|PS|MT)$/, "");
  return { family: (base ? `"${base.replace(/"/g, "")}", ` : "") + generic, weight: face.bold ? "700" : "400", style: face.italic ? "italic" : "normal" };
}

// Share of rect `r` lying inside rect `by`.
function coverage(r, by) {
  const w = Math.min(r[2], by[2]) - Math.max(r[0], by[0]), h = Math.min(r[3], by[3]) - Math.max(r[1], by[1]);
  const a = Math.max(1e-6, (r[2] - r[0]) * (r[3] - r[1]));
  return w > 0 && h > 0 ? (w * h) / a : 0;
}

export class Viewer {
  constructor(root, engine, callbacks = {}) {
    this.root = root;
    this.engine = engine;
    this.cb = callbacks;
    root.classList.add("viewer");
    this.world = el("div", "world", root);
    this.live = el("canvas", "live", root);
    // Low-latency canvas for live ink: drawn strokes skip the compositor.
    this.liveCtx = this.live.getContext("2d", { desynchronized: true }) || this.live.getContext("2d");
    this.vbar = el("div", "scrollbar v", root);
    this.vthumb = el("div", "thumb", this.vbar);
    this.hbar = el("div", "scrollbar h", root);
    this.hthumb = el("div", "thumb", this.hbar);
    this.selBar = el("div", "selbar", root);
    this.selBar.hidden = true;
    this.selBar.innerHTML = `<button class="btn" data-act="copy">Copy</button><button class="btn" data-act="highlight">Highlight</button>`;
    this.selBar.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.selBar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b || !this.sel) return;
      if (b.dataset.act === "copy") this.cb.onCopy?.(this.sel.text);
      else if (b.dataset.act === "highlight") this.highlightSelection();
    });

    this.doc = null;
    this.scale = 1;
    this.zoomMode = "width";
    this.sx = 0;
    this.sy = 0;
    this.zt = null;            // transient zoom transform {a, bx, by}
    this.tool = "hand";
    this.styles = {
      pen: { color: [0.1, 0.3, 0.85], width: 1.5 },
      highlight: { color: [1, 0.86, 0.1], width: 12 },
      box: { color: [0.86, 0.15, 0.15], width: 2 },
    };
    this.shape = "box";          // box tool: box | line | arrow | cloud | callout | text
    this.textStyle = { size: 12, fillText: false, fillCallout: true };
    this.editor = null;          // text box / callout being typed
    this.shapeSel = null;        // shape selected for moving / editing
    this.placing = null;         // signature being positioned
    this.placeBar = el("div", "placebar", root);
    this.placeBar.hidden = true;
    this.placeBar.innerHTML = `<span class="pb-text">Drag to move · drag a corner to resize · tap the page to move it there</span><button class="btn" data-act="delete" hidden>Delete</button><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="place">Place</button>`;
    this.placeBar.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.placeBar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (b) this.finishPlacing(b.dataset.act === "place" ? true : b.dataset.act === "delete" ? "delete" : false);
    });
    this.touchDraws = false;
    this.wheelZooms = false;     // plain mouse wheel zooms instead of scrolling
    this.measureMode = "distance";
    this.measureStyle = { color: [0.92, 0.35, 0.05], dp: null };
    this.mdraft = null;          // measurement being drawn
    this.sel = null;             // current text selection
    this.pointers = new Map();
    this.action = null;
    this.lastPen = -1e9;
    this.frame = 0;
    this.tileCount = 0;
    this.lastTap = null;
    this.dpr = window.devicePixelRatio || 1;

    engine.onRendered = (task, bmp) => this._onRendered(task, bmp);

    this._measure();
    new ResizeObserver(() => this._onResize()).observe(root);
    this._watchDpr();

    root.addEventListener("pointerdown", (e) => this._down(e));
    root.addEventListener("pointermove", (e) => this._move(e));
    // Pen samples as soon as they arrive (not once per frame) while writing.
    if ("onpointerrawupdate" in window) {
      root.addEventListener("pointerrawupdate", (e) => {
        const a = this.action;
        if (a && a.kind === "ink" && a.pid === e.pointerId) { a.raw = true; this._moveInk(a, e); }
      });
    }
    root.addEventListener("pointerleave", () => root.classList.remove("pen-near"));
    root.addEventListener("pointerup", (e) => this._up(e, false));
    root.addEventListener("pointercancel", (e) => this._up(e, true));
    root.addEventListener("lostpointercapture", (e) => { if (this.pointers.has(e.pointerId)) this._up(e, true); });
    root.addEventListener("wheel", (e) => this._wheel(e), { passive: false });
    root.addEventListener("contextmenu", (e) => e.preventDefault());
    // Middle button is ours (drag to pan): no autoscroll or paste.
    root.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    root.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
    this._setupScrollbars();

    if (navigator.ink && navigator.ink.requestPresenter) {
      navigator.ink.requestPresenter({ presentationArea: this.live }).then((p) => (this.inkPresenter = p)).catch(() => {});
    }
  }

  // ------------------------------------------------------------ document
  open(gen, pages, view) {
    this.close();
    const P = pages.map((p) => ({ ...p, w: p.x1 - p.x0, h: p.y1 - p.y0 }));
    this.doc = {
      gen, pages: P,
      states: new Map(),
      attached: new Set(),
      annots: new Map(),
      annotsP: new Map(),
      text: new Map(),
      undo: [], redo: [], seq: 0, savedSeq: 0,
    };
    this._lastPage = -1;
    this.zoomMode = view?.mode || "width";
    this.scale = this.zoomMode === "custom" && view?.scale ? view.scale : this._fitScale(this.zoomMode, view?.page || 0);
    this.scale = clamp(this.scale, MIN_SCALE, MAX_SCALE);
    this._layout();
    const page = clamp(view?.page || 0, 0, P.length - 1);
    const L = this.L;
    this.sx = view?.sx != null ? view.sx * this.scale : (L.worldW - this.vw) / 2;
    this.sy = L.top[page] - PAD + (view?.offset || 0) * this.scale;
    this._clamp();
    this._positionAll();
    this._update();
    this._history();
  }

  close() {
    this._closeEditor(false);
    this.deselectShape();
    this.finishPlacing(false);
    this._stopInertia();
    this.action = null;
    this.root.classList.remove("panning", "over-text");
    this.sel = null;
    this._selPages = null;
    this.selBar.hidden = true;
    const hadDraft = this.mdraft || this._calibrating;
    this.mdraft = null;
    this._calibrating = false;
    if (hadDraft) this._measureChanged();
    this.pointers.clear();
    this.zt = null;
    this._clearLive();
    this.world.textContent = "";
    this.tileCount = 0;
    this.doc = null;
    this.vbar.style.display = this.hbar.style.display = "none";
  }

  get pageCount() { return this.doc ? this.doc.pages.length : 0; }

  viewState() {
    if (!this.doc) return null;
    const i = this.currentPage();
    return {
      page: i,
      offset: (this.sy + PAD - this.L.top[i]) / this.scale,
      mode: this.zoomMode,
      scale: this.scale,
      sx: this.sx / this.scale,
    };
  }

  // ------------------------------------------------------------ geometry
  _measure() {
    this.vw = this.root.clientWidth || 1;
    this.vh = this.root.clientHeight || 1;
    this.rect = this.root.getBoundingClientRect();
    const d = this.dpr;
    this.live.width = Math.round(this.vw * d);
    this.live.height = Math.round(this.vh * d);
    this.live.style.width = this.vw + "px";
    this.live.style.height = this.vh + "px";
  }

  _watchDpr() {
    const mq = matchMedia(`(resolution: ${this.dpr}dppx)`);
    mq.addEventListener("change", () => {
      this.dpr = window.devicePixelRatio || 1;
      this._measure();
      if (this.doc) { this._relayoutKeep(); }
      this._watchDpr();
    }, { once: true });
  }

  _onResize() {
    const oldW = this.vw, oldH = this.vh;
    this._measure();
    if (!this.doc || (oldW === this.vw && oldH === this.vh)) return;
    if (this.zoomMode !== "custom") {
      const i = this.currentPage();
      this._zoomAround(this._fitScale(this.zoomMode, i), this.vw / 2, 0, this.zoomMode);
    } else {
      this._relayoutKeep();
    }
  }

  _relayoutKeep() {
    this._zoomAround(this.scale, this.vw / 2, this.vh / 2, this.zoomMode);
  }

  _fitScale(mode, i) {
    if (!this.doc) return 1;
    const p = this.doc.pages[clamp(i, 0, this.doc.pages.length - 1)];
    const sw = (this.vw - 2 * PAD) / p.w;
    if (mode === "page") return Math.min(sw, (this.vh - 2 * PAD) / p.h);
    return sw;
  }

  _pixRect(p, res) {
    return [Math.floor(p.x0 * res), Math.floor(p.y0 * res), Math.ceil(p.x1 * res), Math.ceil(p.y1 * res)];
  }

  _layout() {
    const P = this.doc.pages, n = P.length, dpr = this.dpr, res = this.scale * dpr;
    let L = this.L;
    if (!L || L.n !== n) {
      L = this.L = { n, left: new Float64Array(n), top: new Float64Array(n), W: new Float64Array(n), H: new Float64Array(n) };
    }
    let maxW = 0;
    for (let i = 0; i < n; i++) {
      const r = this._pixRect(P[i], res);
      L.W[i] = (r[2] - r[0]) / dpr;
      L.H[i] = (r[3] - r[1]) / dpr;
      if (L.W[i] > maxW) maxW = L.W[i];
    }
    L.worldW = Math.max(this.vw, maxW + 2 * PAD);
    let y = PAD;
    for (let i = 0; i < n; i++) {
      L.left[i] = Math.round(((L.worldW - L.W[i]) / 2) * dpr) / dpr;
      L.top[i] = Math.round(y * dpr) / dpr;
      y = L.top[i] + L.H[i] + GAP;
    }
    L.worldH = y - GAP + PAD;
    // Measurement labels and handles stay the same size on screen at any zoom.
    this.world.style.setProperty("--ms", String(1 / this.scale));
    this.world.style.width = L.worldW + "px";
    this.world.style.height = L.worldH + "px";
  }

  _clamp() {
    const L = this.L;
    this.sx = L.worldW <= this.vw ? 0 : clamp(this.sx, 0, L.worldW - this.vw);
    this.sy = L.worldH <= this.vh ? -(this.vh - L.worldH) / 2 : clamp(this.sy, 0, L.worldH - this.vh);
  }

  // Index of the last page whose top is <= y (world px).
  _pageAtY(y) {
    const t = this.L.top;
    let lo = 0, hi = t.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t[mid] <= y) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  _visibleRange(margin = 0) {
    const a = this._pageAtY(this.sy - margin);
    const b = this._pageAtY(this.sy + this.vh + margin);
    return [a, b];
  }

  currentPage() {
    if (!this.doc) return 0;
    return this._pageAtY(this.sy + this.vh * 0.4);
  }

  _toWorld(cx, cy) {
    return [cx - this.rect.left + this.sx, cy - this.rect.top + this.sy];
  }

  // Page under a world point, or -1 if the point is in the gaps/margins.
  _hitPage(wx, wy, slack = 0) {
    const i = this._pageAtY(wy + slack);
    const L = this.L;
    for (const k of [i, i - 1]) {
      if (k < 0) continue;
      if (wx >= L.left[k] - slack && wx <= L.left[k] + L.W[k] + slack && wy >= L.top[k] - slack && wy <= L.top[k] + L.H[k] + slack) return k;
    }
    return -1;
  }

  _worldToPage(i, wx, wy) {
    const p = this.doc.pages[i], L = this.L;
    return [p.x0 + (wx - L.left[i]) / this.scale, p.y0 + (wy - L.top[i]) / this.scale];
  }

  _clientToPage(i, cx, cy) {
    const [wx, wy] = this._toWorld(cx, cy);
    return this._worldToPage(i, wx, wy);
  }

  _clampToPage(i, pt) {
    const p = this.doc.pages[i];
    return [clamp(pt[0], p.x0, p.x1), clamp(pt[1], p.y0, p.y1)];
  }

  // ------------------------------------------------------------ view
  _applyTransform() {
    const d = this.dpr;
    const tx = -Math.round(this.sx * d) / d, ty = -Math.round(this.sy * d) / d;
    if (this.zt) {
      const { a, bx, by } = this.zt;
      this.world.style.transform = `translate(${bx}px,${by}px) scale(${a}) translate(${tx}px,${ty}px)`;
      this.selBar.hidden = true;
    } else {
      this.world.style.transform = `translate(${tx}px,${ty}px)`;
    }
  }

  _update() {
    if (!this.doc) return;
    this._applyTransform();
    this._syncPages();
    this._updateScrollbars();
    this._placeSelBar();
    if (this.tool === "select" || this.tool === "highlight") {
      const [a, b] = this._visibleRange(0);
      for (let i = a; i <= b; i++) if (!this.doc.text.has(i)) this._loadText(i);
    }
    const cur = this.currentPage();
    if (cur !== this._lastPage) {
      this._lastPage = cur;
      this.cb.onPage?.(cur, this.doc.pages.length);
    }
    this._scheduleRender();
  }

  scrollBy(dx, dy) {
    if (!this.doc) return;
    this.sx += dx;
    this.sy += dy;
    this._clamp();
    this._update();
  }

  scrollTo(x, y) {
    if (!this.doc) return;
    this.sx = x;
    this.sy = y;
    this._clamp();
    this._update();
  }

  goToPage(i) {
    if (!this.doc) return;
    i = clamp(i, 0, this.doc.pages.length - 1);
    this._stopInertia();
    const L = this.L;
    const y = L.H[i] <= this.vh ? L.top[i] - (this.vh - L.H[i]) / 2 : L.top[i] - PAD / 2;
    this.scrollTo(this._xFor(i), y);
  }

  // Horizontal scroll that shows page i: unchanged if it's in view, else
  // centred on it (a narrow page next to wide drawings can be off to the side).
  _xFor(i) {
    const L = this.L, left = L.left[i], w = L.W[i];
    if (w <= this.vw) return left >= this.sx && left + w <= this.sx + this.vw ? this.sx : left - (this.vw - w) / 2;
    return left + w < this.sx + 40 || left > this.sx + this.vw - 40 ? left - PAD : this.sx;
  }

  pageStep(dir) {
    this.goToPage(this.currentPage() + dir);
  }

  _syncPages() {
    const [a, b] = this._visibleRange(this.vh * 0.5);
    const d = this.doc;
    for (const i of d.attached) {
      if (i < a || i > b) {
        const s = d.states.get(i);
        s?.el.remove();
        d.attached.delete(i);
      }
    }
    for (let i = a; i <= b; i++) {
      if (d.attached.has(i)) continue;
      const s = this._state(i);
      this._positionPage(s, i);
      this.world.appendChild(s.el);
      d.attached.add(i);
    }
  }

  _state(i) {
    const d = this.doc;
    let s = d.states.get(i);
    if (s) return s;
    const p = d.pages[i];
    s = { i, el: el("div", "page"), base: null, baseRes: 0, tiles: new Map() };
    s.baseCv = el("canvas", "base", s.el);
    s.baseCv.width = s.baseCv.height = 1;
    s.tilesEl = el("div", "tiles", s.el);
    const vb = `${p.x0} ${p.y0} ${p.w} ${p.h}`;
    // Erase areas sit under every markup: saving removes the page content
    // beneath them, but markups stay.
    s.svgErase = svgEl("svg", { class: "annots erase", viewBox: vb, preserveAspectRatio: "none" }, s.el);
    s.svgHl = svgEl("svg", { class: "annots hl", viewBox: vb, preserveAspectRatio: "none" }, s.el);
    s.svgInk = svgEl("svg", { class: "annots ink", viewBox: vb, preserveAspectRatio: "none" }, s.el);
    s.svgSel = svgEl("svg", { class: "annots sel", viewBox: vb, preserveAspectRatio: "none" }, s.el);
    s.svgMeas = svgEl("svg", { class: "annots meas", viewBox: vb, preserveAspectRatio: "none" }, s.el);
    s.prevHl = svgEl("g", {}, s.svgHl);
    s.prevInk = svgEl("g", {}, s.svgInk);
    s.prevMeas = svgEl("g", {}, s.svgMeas);
    d.states.set(i, s);
    this._loadAnnots(i);
    return s;
  }

  _positionPage(s, i) {
    const L = this.L, st = s.el.style;
    st.left = L.left[i] + "px";
    st.top = L.top[i] + "px";
    st.width = L.W[i] + "px";
    st.height = L.H[i] + "px";
    for (const t of s.tiles.values()) this._placeTile(t, i);
  }

  _positionAll() {
    for (const [i, s] of this.doc.states) this._positionPage(s, i);
  }

  _placeTile(t, i) {
    const p = this.doc.pages[i], S = this.scale, res = S * this.dpr;
    const ox = Math.floor(p.x0 * res) / res, oy = Math.floor(p.y0 * res) / res;
    const st = t.cv.style;
    st.left = (t.bbox[0] / t.res - ox) * S + "px";
    st.top = (t.bbox[1] / t.res - oy) * S + "px";
    st.width = ((t.bbox[2] - t.bbox[0]) / t.res) * S + "px";
    st.height = ((t.bbox[3] - t.bbox[1]) / t.res) * S + "px";
  }

  // ------------------------------------------------------------ zoom
  _zoomAround(newScale, px, py, mode = "custom") {
    if (!this.doc) return;
    newScale = clamp(newScale, MIN_SCALE, MAX_SCALE);
    const wx = px + this.sx, wy = py + this.sy;
    const i = this._pageAtY(wy);
    const [x, y] = this._worldToPage(i, wx, wy);
    this.scale = newScale;
    this.zoomMode = mode;
    this._layout();
    const p = this.doc.pages[i];
    this.sx = this.L.left[i] + (x - p.x0) * newScale - px;
    this.sy = this.L.top[i] + (y - p.y0) * newScale - py;
    this._clamp();
    this._positionAll();
    this._update();
    this.cb.onZoom?.(this.scale, this.zoomMode);
    this._penCursor();
  }

  zoomBy(f, px = this.vw / 2, py = this.vh / 2) {
    this._stopInertia();
    this._zoomAround(this.scale * f, px, py, "custom");
  }

  setZoom(scale) { this._zoomAround(scale, this.vw / 2, this.vh / 2, "custom"); }

  fit(mode) {
    if (!this.doc) return;
    const i = this.currentPage();
    const s = this._fitScale(mode, i);
    this._zoomAround(s, this.vw / 2, this.vh / 2, mode);
    if (mode === "page") this.goToPage(i);
    else this.scrollTo(this._xFor(i), this.sy);
  }

  // Transient zoom: a GPU transform on top of the committed layout.
  _ztSet(a, bx, by) {
    this.zt = { a, bx, by };
    this._applyTransform();
  }

  _ztCommit(px, py) {
    const zt = this.zt;
    if (!zt) return;
    this.zt = null;
    const { a, bx, by } = zt;
    const qx = (px - bx) / a, qy = (py - by) / a; // committed-view point under (px,py)
    const wx = qx + this.sx, wy = qy + this.sy;
    const i = this._pageAtY(wy);
    const [x, y] = this._worldToPage(i, wx, wy);
    this.scale = clamp(this.scale * a, MIN_SCALE, MAX_SCALE);
    this.zoomMode = "custom";
    this._layout();
    const p = this.doc.pages[i];
    this.sx = this.L.left[i] + (x - p.x0) * this.scale - px;
    this.sy = this.L.top[i] + (y - p.y0) * this.scale - py;
    this._clamp();
    this._positionAll();
    this._update();
    this.cb.onZoom?.(this.scale, this.zoomMode);
    this._penCursor();
  }

  _wheel(e) {
    e.preventDefault();
    if (!this.doc) return;
    this._stopInertia();
    const px = e.clientX - this.rect.left, py = e.clientY - this.rect.top;
    let dx = e.deltaX, dy = e.deltaY;
    // Ctrl/⌘+wheel (and touchpad pinch) always zooms. When the wheel is set to
    // zoom, a plain vertical wheel zooms too and Shift+wheel scrolls instead.
    const zoom = e.ctrlKey || e.metaKey || (this.wheelZooms && !e.shiftKey && Math.abs(dy) >= Math.abs(dx));
    if (zoom) {
      const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 0.5 : 0.0025;
      const f = Math.exp(-dy * unit);
      const zt = this.zt || { a: 1, bx: 0, by: 0 };
      const a = clamp(zt.a * f, MIN_SCALE / this.scale, MAX_SCALE / this.scale);
      const g = a / zt.a;
      this._ztSet(a, px - g * (px - zt.bx), py - g * (py - zt.by));
      clearTimeout(this._wheelTimer);
      this._wheelTimer = setTimeout(() => this._ztCommit(px, py), 160);
      return;
    }
    if (this.zt) this._ztCommit(px, py);
    if (e.deltaMode === 1) { dx *= 40; dy *= 40; }
    else if (e.deltaMode === 2) { dx *= this.vw; dy *= this.vh; }
    if (e.shiftKey) {
      // Windows may already have turned Shift+wheel into a sideways delta.
      if (this.wheelZooms) { if (!dy) { dy = dx; dx = 0; } }
      else if (!dx) { dx = dy; dy = 0; }
    }
    this.scrollBy(dx, dy);
  }

  // Animated zoom (double-tap).
  _animateZoom(targetScale, px, py) {
    const a1 = clamp(targetScale, MIN_SCALE, MAX_SCALE) / this.scale;
    const t0 = now(), dur = 180;
    const step = () => {
      const t = Math.min(1, (now() - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      const a = 1 + (a1 - 1) * e;
      this._ztSet(a, px - a * px, py - a * py);
      if (t < 1) requestAnimationFrame(step);
      else this._ztCommit(px, py);
    };
    requestAnimationFrame(step);
  }

  // ------------------------------------------------------------ rendering
  _scheduleRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this._updateRender();
    });
  }

  _baseRes(i) {
    const p = this.doc.pages[i];
    return Math.min(MAX_BASE_RES, Math.sqrt(BASE_PIXELS / Math.max(1, p.w * p.h)));
  }

  _baseTask(i) {
    const res = this._baseRes(i);
    return { key: `${i}|base`, kind: "base", page: i, res, bbox: this._pixRect(this.doc.pages[i], res) };
  }

  _tilesFor(i, res) {
    // Tiles covering the visible part of page i at resolution res.
    const L = this.L, d = this.dpr, p = this.doc.pages[i];
    const vx0 = Math.max(this.sx, L.left[i]), vx1 = Math.min(this.sx + this.vw, L.left[i] + L.W[i]);
    const vy0 = Math.max(this.sy, L.top[i]), vy1 = Math.min(this.sy + this.vh, L.top[i] + L.H[i]);
    if (vx1 <= vx0 || vy1 <= vy0) return [];
    const pr = this._pixRect(p, res);
    const cols = Math.ceil((pr[2] - pr[0]) / TILE), rows = Math.ceil((pr[3] - pr[1]) / TILE);
    const tx0 = clamp(Math.floor(((vx0 - L.left[i]) * d) / TILE), 0, cols - 1);
    const tx1 = clamp(Math.floor(((vx1 - L.left[i]) * d - 1) / TILE), 0, cols - 1);
    const ty0 = clamp(Math.floor(((vy0 - L.top[i]) * d) / TILE), 0, rows - 1);
    const ty1 = clamp(Math.floor(((vy1 - L.top[i]) * d - 1) / TILE), 0, rows - 1);
    const rk = res.toFixed(5);
    const cx = this.sx + this.vw / 2, cy = this.sy + this.vh / 2;
    const out = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const x0 = pr[0] + tx * TILE, y0 = pr[1] + ty * TILE;
        const bbox = [x0, y0, Math.min(x0 + TILE + 1, pr[2]), Math.min(y0 + TILE + 1, pr[3])];
        const wx = L.left[i] + (tx + 0.5) * TILE / d, wy = L.top[i] + (ty + 0.5) * TILE / d;
        out.push({ key: `${i}|${rk}|${tx}|${ty}`, kind: "tile", page: i, res, rk, bbox, dist: Math.hypot(wx - cx, wy - cy) });
      }
    }
    return out;
  }

  _updateRender() {
    const d = this.doc;
    if (!d || this.zt) return;
    this.frame++;
    const res = this.scale * this.dpr;
    const [a, b] = this._visibleRange(0);
    const tasks = [];
    for (let i = a; i <= b; i++) {
      const s = this._state(i);
      const want = this._baseRes(i);
      if (!s.base) tasks.push(this._baseTask(i));
      else if (s.baseRes < want / 1.5) tasks.push(this._baseTask(i));
    }
    const tiles = [];
    for (let i = a; i <= b; i++) {
      const s = this._state(i);
      if (res <= this._baseRes(i) * 1.02 && s.base) {
        this._dropTiles(s, null);
        continue;
      }
      for (const t of this._tilesFor(i, res)) {
        const have = s.tiles.get(t.key);
        if (have) have.used = this.frame;
        else tiles.push(t);
      }
      this._cleanupTiles(i);
    }
    tiles.sort((x, y) => x.dist - y.dist);
    tasks.push(...tiles);
    for (const i of [b + 1, a - 1, b + 2, b + 3, a - 2]) {
      if (i < 0 || i >= d.pages.length) continue;
      const s = d.states.get(i);
      if (!s || !s.base) tasks.push(this._baseTask(i));
    }
    this.engine.setQueue(tasks);
    this._evict(a, b);
  }

  _onRendered(task, bmp) {
    const d = this.doc;
    if (!d || task.page >= d.pages.length) { bmp.close(); return; }
    const s = d.states.get(task.page) || this._state(task.page);
    if (task.kind === "base") {
      const ctx = s.baseCv.getContext("bitmaprenderer");
      ctx.transferFromImageBitmap(bmp);
      s.base = true;
      s.baseRes = task.res;
      s.el.classList.add("ready");
      return;
    }
    if (s.tiles.has(task.key)) { bmp.close(); return; }
    const cv = el("canvas", "tile");
    cv.getContext("bitmaprenderer").transferFromImageBitmap(bmp);
    const t = { key: task.key, res: task.res, rk: task.rk, bbox: task.bbox, cv, used: this.frame };
    s.tiles.set(task.key, t);
    this.tileCount++;
    this._placeTile(t, task.page);
    s.tilesEl.appendChild(cv);
    this._cleanupTiles(task.page);
  }

  // Remove other-resolution tiles once the current resolution covers the view.
  _cleanupTiles(i) {
    const s = this.doc.states.get(i);
    if (!s || s.tiles.size === 0) return;
    const rk = (this.scale * this.dpr).toFixed(5);
    let stale = false;
    for (const t of s.tiles.values()) if (t.rk !== rk) { stale = true; break; }
    if (!stale) return;
    const need = this._tilesFor(i, this.scale * this.dpr);
    if (need.every((t) => s.tiles.has(t.key))) this._dropTiles(s, rk);
  }

  _dropTiles(s, keepRk) {
    for (const [k, t] of s.tiles) {
      if (keepRk && t.rk === keepRk) continue;
      t.cv.remove();
      s.tiles.delete(k);
      this.tileCount--;
    }
  }

  _evict(a, b) {
    const d = this.doc;
    if (this.tileCount > MAX_TILES) {
      const all = [];
      for (const s of d.states.values()) for (const t of s.tiles.values()) all.push([t, s]);
      all.sort((x, y) => x[0].used - y[0].used);
      for (const [t, s] of all) {
        if (this.tileCount <= MAX_TILES * 0.75) break;
        if (t.used === this.frame) continue;
        t.cv.remove();
        s.tiles.delete(t.key);
        this.tileCount--;
      }
    }
    let bases = 0;
    for (const s of d.states.values()) if (s.base) bases++;
    if (bases > MAX_BASES) {
      const far = [...d.states.values()].filter((s) => s.base && (s.i < a - 3 || s.i > b + 3));
      far.sort((x, y) => Math.abs(y.i - a) - Math.abs(x.i - a));
      for (const s of far) {
        if (bases <= MAX_BASES * 0.75) break;
        s.baseCv.width = s.baseCv.height = 1;
        s.base = false;
        s.baseRes = 0;
        s.el.classList.remove("ready");
        bases--;
      }
    }
  }

  // ------------------------------------------------------------ scrollbars
  _setupScrollbars() {
    const drag = (bar, thumb, vertical) => {
      bar.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!this.doc) return;
        this._stopInertia();
        bar.setPointerCapture(e.pointerId);
        bar.classList.add("active");
        const L = this.L;
        const track = vertical ? this.vh : this.vw;
        const size = vertical ? L.worldH : L.worldW;
        const view = vertical ? this.vh : this.vw;
        const tlen = Math.max(36, (view / size) * track);
        const r = thumb.getBoundingClientRect();
        const start = vertical ? e.clientY : e.clientX;
        const onThumb = vertical ? e.clientY >= r.top && e.clientY <= r.bottom : e.clientX >= r.left && e.clientX <= r.right;
        const grab = onThumb ? start - (vertical ? r.top : r.left) : tlen / 2;
        const barStart = vertical ? this.rect.top : this.rect.left;
        const apply = (c) => {
          const f = clamp((c - barStart - grab) / (track - tlen), 0, 1);
          const pos = f * (size - view);
          if (vertical) this.scrollTo(this.sx, pos); else this.scrollTo(pos, this.sy);
        };
        apply(start);
        const mv = (ev) => apply(vertical ? ev.clientY : ev.clientX);
        const up = () => {
          bar.classList.remove("active");
          bar.removeEventListener("pointermove", mv);
          bar.removeEventListener("pointerup", up);
          bar.removeEventListener("pointercancel", up);
        };
        bar.addEventListener("pointermove", mv);
        bar.addEventListener("pointerup", up);
        bar.addEventListener("pointercancel", up);
      });
    };
    drag(this.vbar, this.vthumb, true);
    drag(this.hbar, this.hthumb, false);
  }

  _updateScrollbars() {
    const L = this.L;
    const vis = (bar, thumb, size, view, pos, vertical) => {
      if (size <= view + 1) { bar.style.display = "none"; return; }
      bar.style.display = "";
      const track = vertical ? this.vh : this.vw;
      const tlen = Math.max(36, (view / size) * track);
      const off = (clamp(pos, 0, size - view) / (size - view)) * (track - tlen);
      if (vertical) { thumb.style.height = tlen + "px"; thumb.style.transform = `translateY(${off}px)`; }
      else { thumb.style.width = tlen + "px"; thumb.style.transform = `translateX(${off}px)`; }
    };
    vis(this.vbar, this.vthumb, L.worldH, this.vh, this.sy, true);
    vis(this.hbar, this.hthumb, L.worldW, this.vw, this.sx, false);
  }

  // ------------------------------------------------------------ inertia
  _startInertia(vx, vy) {
    this._stopInertia();
    let last = now();
    const step = () => {
      const t = now(), dt = Math.min(40, t - last);
      last = t;
      const bx = this.sx, by = this.sy;
      this.scrollBy(-vx * dt, -vy * dt);
      if (this.sx === bx) vx = 0;
      if (this.sy === by) vy = 0;
      const k = Math.exp(-dt / 330);
      vx *= k; vy *= k;
      this._inertiaV = [vx, vy];
      if (Math.hypot(vx, vy) < 0.02) { this._inertia = 0; return; }
      this._inertia = requestAnimationFrame(step);
    };
    this._inertia = requestAnimationFrame(step);
  }

  _stopInertia() {
    if (this._inertia) {
      cancelAnimationFrame(this._inertia);
      // Remember the glide so a quick follow-up flick can build on it.
      if (this._inertiaV) this._carry = { v: this._inertiaV, t: now() };
    }
    this._inertia = 0;
    this._inertiaV = null;
  }

  // ------------------------------------------------------------ input
  setTool(tool) {
    if (tool !== this.tool) {
      if (this.mdraft || this._calibrating) this.cancelMeasure();
      if (this.sel && tool !== "select") this.clearSelection();
      this._closeEditor(true);
      this.deselectShape();
      if (this.placing) this.finishPlacing(false);
    }
    this.tool = tool;
    this.root.dataset.tool = tool;
    this.root.classList.remove("over-text");
    if ((tool === "highlight" || tool === "select") && this.doc) {
      const [a, b] = this._visibleRange(0);
      for (let i = a; i <= b; i++) this._loadText(i);
    }
  }

  setStyle(tool, style) {
    Object.assign(this.styles[tool], style);
    if (tool === "pen") this._penCursor();
  }

  _penCursor() {
    const st = this.styles.pen;
    if (!st || !st.color) return;
    const key = cssColor(st.color) + "|" + Math.round(st.width * this.scale);
    if (key === this._penCursorKey) return;
    this._penCursorKey = key;
    this.root.style.setProperty("--pen-cursor", dotCursor(cssColor(st.color), st.width * this.scale));
  }

  setShape(shape) {
    this._closeEditor(true);
    this.shape = shape;
    this.root.dataset.shape = shape;
  }

  setTextStyle(style) {
    Object.assign(this.textStyle, style);
  }

  _isEraser(e) {
    return e.pointerType === "pen" && ((e.buttons & 32) || e.button === 5 || (e.buttons & 2) || e.button === 2);
  }

  _touchCount() {
    let n = 0;
    for (const p of this.pointers.values()) if (p.type === "touch" && !p.ignored) n++;
    return n;
  }

  _down(e) {
    if (!this.doc) return;
    const type = e.pointerType;
    const t = now();
    if (type === "pen") {
      this.lastPen = t;
      // Pen wins: drop whatever the palm/fingers were doing.
      if (this.action && this.action.touch) this._endAction(true);
      for (const p of this.pointers.values()) if (p.type === "touch") p.ignored = true;
    } else if (type === "touch" && t - this.lastPen < PALM_MS) {
      return;
    }
    if (type === "mouse" && e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    // Working on the page ends typing elsewhere (e.g. the file filter), so
    // keyboard shortcuts apply to the page again.
    const ae = document.activeElement;
    if (ae && ae !== document.body && !this.root.contains(ae) && ae.closest?.("input, textarea, select")) ae.blur();
    this._stopInertia();
    this.rect = this.root.getBoundingClientRect();
    try { this.root.setPointerCapture(e.pointerId); } catch {}
    const ptr = { id: e.pointerId, type, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: t, ignored: false };
    this.pointers.set(e.pointerId, ptr);
    // Tapping outside a text box being typed finishes it (and does nothing else).
    if (this.editor) { this._closeEditor(true); ptr.ignored = true; return; }
    // Pen/mouse on the page outside the selected shape lets it go (a finger
    // still pans; a finger tap deselects).
    if (this.shapeSel && type !== "touch") this.deselectShape();

    if (type === "touch") {
      const n = this._touchCount();
      if (n === 2) {
        const a = this.action;
        if (a && a.touch && a.kind !== "pan" && a.kind !== "pinch") {
          if (t - a.t0 < 300) this._endAction(true);
          else { ptr.ignored = true; return; }
        } else if (a) this._endAction(false);
        this._startPinch();
        return;
      }
      if (n > 2) { ptr.ignored = true; return; }
      if (this.touchDraws && !this.placing && DRAW_TOOLS.has(this.tool)) { if (this._startTool(e, ptr, true)) return; }
      this._startPan(ptr, true);
      return;
    }
    // While a signature is being placed, drags pan and taps move it.
    if (this.placing) { this._startPan(ptr, type === "pen"); return; }
    if (type === "pen") {
      if (this._isEraser(e)) { this._startErase(e, ptr, false); return; }
      if (this.tool === "hand" || !this._startTool(e, ptr, false)) this._startPan(ptr, true);
      return;
    }
    // mouse: the middle button always pans; so does dragging in the margins,
    // whatever the tool.
    if (e.button === 1) { this._startPan(ptr, false); return; }
    if (this.tool === "hand" || !this._startTool(e, ptr, false)) this._startPan(ptr, false);
  }

  _move(e) {
    if (e.pointerType === "pen") this.lastPen = now();
    if (e.pointerType !== "touch") this._hoverPt = { x: e.clientX, y: e.clientY, t: now() };
    // A hovering pen shows a dot (ink colour and size) instead of a crosshair.
    const pen = e.pointerType === "pen";
    if (pen !== this._penNear) { this._penNear = pen; this.root.classList.toggle("pen-near", pen); }
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) { this._hover(e); return; }
    if (ptr.ignored) return;
    ptr.x = e.clientX;
    ptr.y = e.clientY;
    const a = this.action;
    if (!a) return;
    if (a.kind === "pinch") { this._movePinch(); return; }
    if (a.pid !== e.pointerId) return;
    switch (a.kind) {
      case "pan": this._movePan(a, ptr); break;
      case "ink": if (!a.raw) this._moveInk(a, e); break;
      case "highlight": this._moveHighlight(a, e); break;
      case "box": this._moveBox(a, e); break;
      case "erase": this._moveErase(a, e); break;
      case "select": this._moveSelect(a, e); break;
      case "measure": this._measureMove(a, e); break;
      case "pickmark": this._movePick(a, e); break;
      case "snip": this._moveSnip(a, e); break;
    }
  }

  // Mouse/pen moving without a button pressed.
  _hover(e) {
    if (!this.doc || this.action) return;
    if (this.tool === "measure" && this.mdraft && e.pointerType !== "touch") {
      const d = this.mdraft;
      const p = this._clampToPage(d.page, this._clientToPage(d.page, e.clientX, e.clientY));
      d.hover = this._constrainPt(d, p, e.shiftKey);
      this._drawDraft();
    } else if (this.tool === "select" && e.pointerType === "mouse") {
      const [wx, wy] = this._toWorld(e.clientX, e.clientY);
      const i = this._hitPage(wx, wy, 0);
      this.root.classList.toggle("over-text", i >= 0 && this._selectableAt(i, this._worldToPage(i, wx, wy)) === true);
    }
  }

  _up(e, cancelled) {
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    this.pointers.delete(e.pointerId);
    try { this.root.releasePointerCapture(e.pointerId); } catch {}
    if (ptr.ignored) return;
    const a = this.action;
    if (!a) return;
    if (a.kind === "pinch") {
      if (!a.ids.includes(e.pointerId)) return;
      const rest = a.ids.find((id) => id !== e.pointerId);
      const c = this._pinchCenter(a);
      this.action = null;
      this._ztCommit(c[0], c[1]);
      const other = this.pointers.get(rest);
      if (other && !other.ignored) { other.x0 = other.x; other.y0 = other.y; other.t0 = now(); this._startPan(other, true, true); }
      return;
    }
    if (a.pid !== e.pointerId) return;
    if (a.kind === "pan") {
      this.action = null;
      this.root.classList.remove("panning");
      this._endPan(a, ptr, cancelled);
      return;
    }
    this._endAction(cancelled);
  }

  _endAction(cancel) {
    const a = this.action;
    this.action = null;
    this.root.classList.remove("panning");
    if (!a) return;
    switch (a.kind) {
      case "ink": this._finishInk(a, cancel); break;
      case "highlight": this._finishHighlight(a, cancel); break;
      case "box": this._finishBox(a, cancel); break;
      case "erase": this._finishErase(a, cancel); break;
      case "select": this._finishSelect(a, cancel); break;
      case "measure": this._measureUp(a, cancel); break;
      case "pickmark": if (!cancel) this.selectShape(a.page, a.d); break;
      case "snip": this._finishSnip(a, cancel); break;
      case "pinch": this._ztCommit(this.vw / 2, this.vh / 2); break;
    }
  }

  // ---- pan
  _startPan(ptr, inertia, resumed = false) {
    if (ptr.type === "mouse") this.root.classList.add("panning");
    this.action = { kind: "pan", pid: ptr.id, touch: ptr.type === "touch", t0: now(), lx: ptr.x, ly: ptr.y, samples: [[now(), ptr.x, ptr.y]], inertia, resumed };
  }

  _movePan(a, ptr) {
    const dx = ptr.x - a.lx, dy = ptr.y - a.ly;
    a.lx = ptr.x; a.ly = ptr.y;
    this.scrollBy(-dx, -dy);
    const t = now();
    a.samples.push([t, ptr.x, ptr.y]);
    while (a.samples.length > 2 && t - a.samples[0][0] > 90) a.samples.shift();
  }

  _endPan(a, ptr, cancelled) {
    const t = now();
    const moved = Math.hypot(ptr.x - ptr.x0, ptr.y - ptr.y0);
    const tapLike = !cancelled && !a.resumed && moved < (ptr.type === "touch" ? 12 : 6) && t - ptr.t0 < 450;
    if (tapLike && (this.placing || this.tool === "sign")) {
      this._signTap(ptr);
      return;
    }
    if (tapLike && this.tool === "select" && this._shapeTap(ptr)) return;
    if (tapLike && this.tool === "content") { this._replaceTap(ptr); return; }
    if (!cancelled && !a.resumed && ptr.type === "touch" && moved < 12 && t - ptr.t0 < 300) {
      this._tap(ptr);
      return;
    }
    // A click in empty space drops the text selection.
    if (!cancelled && !a.resumed && moved < 5 && this.sel) this.clearSelection();
    if (cancelled || !a.inertia) return;
    const s = a.samples;
    if (s.length < 2) return;
    const [t0, x0, y0] = s[0];
    const [t1, x1, y1] = s[s.length - 1];
    if (t - t1 > 60 || t1 - t0 < 8) return;
    let vx = (x1 - x0) / (t1 - t0), vy = (y1 - y0) / (t1 - t0);
    const c = this._carry;
    this._carry = null;
    if (c && t - c.t < 900) {
      // Repeated flicks in the same direction accelerate (fast travel in long PDFs).
      if (Math.sign(c.v[1]) === Math.sign(vy) && Math.abs(vy) > 0.3) vy = clamp(vy + c.v[1] * 0.9, -30, 30);
      if (Math.sign(c.v[0]) === Math.sign(vx) && Math.abs(vx) > 0.3) vx = clamp(vx + c.v[0] * 0.9, -30, 30);
    }
    if (Math.hypot(vx, vy) > 0.15) this._startInertia(vx, vy);
  }

  _tap(ptr) {
    // Measuring with a finger: tap to place points, drag to pan.
    if (this.tool === "measure" && this._measureTap(ptr)) { this.lastTap = null; return; }
    if (this.sel) this.clearSelection();
    const t = now();
    const lt = this.lastTap;
    if (lt && t - lt.t < 320 && Math.hypot(ptr.x - lt.x, ptr.y - lt.y) < 40) {
      this.lastTap = null;
      const px = ptr.x - this.rect.left, py = ptr.y - this.rect.top;
      const fw = this._fitScale("width", this.currentPage());
      if (this.scale > fw * 1.15) this._animateZoom(fw, px, py);
      else this._animateZoom(fw * 2.5, px, py);
      return;
    }
    this.lastTap = { t, x: ptr.x, y: ptr.y };
  }

  // ---- pinch
  _pinchPointers() {
    const out = [];
    for (const p of this.pointers.values()) if (p.type === "touch" && !p.ignored) out.push(p);
    return out.slice(0, 2);
  }
  _pinchCenter(a) {
    const ps = a.ids.map((id) => this.pointers.get(id)).filter(Boolean);
    if (ps.length === 2) return [(ps[0].x + ps[1].x) / 2 - this.rect.left, (ps[0].y + ps[1].y) / 2 - this.rect.top];
    return a.lastC || [this.vw / 2, this.vh / 2];
  }

  _startPinch() {
    this.root.classList.remove("panning");
    const [p, q] = this._pinchPointers();
    const c = [(p.x + q.x) / 2 - this.rect.left, (p.y + q.y) / 2 - this.rect.top];
    const d = Math.max(10, Math.hypot(p.x - q.x, p.y - q.y));
    this.action = { kind: "pinch", touch: true, ids: [p.id, q.id], c0: c, d0: d, lastC: c, lastA: 1, stillSince: now(), t0: now() };
    this.zt = { a: 1, bx: 0, by: 0 };
  }

  _movePinch() {
    const a = this.action;
    const ps = a.ids.map((id) => this.pointers.get(id));
    if (ps.some((p) => !p)) return;
    const c = [(ps[0].x + ps[1].x) / 2 - this.rect.left, (ps[0].y + ps[1].y) / 2 - this.rect.top];
    const d = Math.max(10, Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y));
    let s = d / a.d0;
    s = clamp(s, MIN_SCALE / this.scale, MAX_SCALE / this.scale);
    a.lastC = c;
    this._ztSet(s, c[0] - s * a.c0[0], c[1] - s * a.c0[1]);
    // While fingers rest, sharpen: commit the zoom and keep pinching from here.
    const t = now();
    if (Math.abs(s - a.lastA) / a.lastA > 0.01) { a.lastA = s; a.stillSince = t; }
    else if (t - a.stillSince > 280 && Math.abs(s - 1) > 0.02) {
      this._ztCommit(c[0], c[1]);
      a.c0 = c; a.d0 = d; a.lastA = 1; a.stillSince = t;
      this.zt = { a: 1, bx: 0, by: 0 };
    }
  }

  // ---- drawing tools
  _pageForPointer(e) {
    const [wx, wy] = this._toWorld(e.clientX, e.clientY);
    return this._hitPage(wx, wy, 0);
  }

  _startTool(e, ptr, touch) {
    if (this.tool === "eraser") { this._startErase(e, ptr, touch); return true; }
    if (this.tool === "select") return this._startSelect(e, ptr, touch);
    if (this.tool === "measure") return this._measureDown(e, ptr, touch);
    const i = this._pageForPointer(e);
    if (i < 0) return false;
    const p = this._clampToPage(i, this._clientToPage(i, e.clientX, e.clientY));
    const base = { pid: ptr.id, page: i, touch, t0: now() };
    if (this.tool === "pen") this._startInk(base, p, e);
    else if (this.tool === "highlight") this._startHighlight(base, p, e);
    else if (this.tool === "box") this._startBox(base, p);
    // Edit content: drag a box to erase an area; tap text to retype it.
    else if (this.tool === "content") { this._startBox(base, p, "redact"); this.action.tapEdit = true; }
    else if (this.tool === "snip") this.action = { ...base, kind: "snip", pts: [p], len: 0 };
    else return false;
    return true;
  }

  _screenOf(i, pt) {
    const p = this.doc.pages[i], L = this.L;
    return [L.left[i] + (pt[0] - p.x0) * this.scale - this.sx, L.top[i] + (pt[1] - p.y0) * this.scale - this.sy];
  }

  // ---- snip: copy an area of the page as a picture. A straight drag makes a
  // box (corner to corner); drawing around something makes a lasso.
  _snipShape(a) {
    const p0 = a.pts[0], p1 = a.pts[a.pts.length - 1];
    const chord = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (a.pts.length < 3 || a.len <= chord * 1.35) return { rect: [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])], poly: null };
    const xs = a.pts.map((q) => q[0]), ys = a.pts.map((q) => q[1]);
    return { rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], poly: a.pts };
  }

  _moveSnip(a, e) {
    for (const ev of e.getCoalescedEvents ? e.getCoalescedEvents() : [e]) {
      const p = this._clampToPage(a.page, this._clientToPage(a.page, ev.clientX, ev.clientY));
      const lp = a.pts[a.pts.length - 1];
      const d = Math.hypot(p[0] - lp[0], p[1] - lp[1]);
      if (d * this.scale < 1.5) continue;
      a.len += d;
      a.pts.push(p);
    }
    this._drawSnip(a);
  }

  _drawSnip(a, done = false) {
    this._clearLive();
    const c = this.liveCtx, { rect, poly } = this._snipShape(a);
    c.save();
    this._liveClipToPage(a.page);
    c.beginPath();
    if (poly) poly.forEach((q, k) => { const [x, y] = this._screenOf(a.page, q); if (k) c.lineTo(x, y); else c.moveTo(x, y); });
    else { const [x0, y0] = this._screenOf(a.page, [rect[0], rect[1]]), [x1, y1] = this._screenOf(a.page, [rect[2], rect[3]]); c.rect(x0, y0, x1 - x0, y1 - y0); }
    c.closePath();
    c.fillStyle = done ? "rgba(47,111,237,0.12)" : "rgba(47,111,237,0.06)";
    c.fill();
    c.lineWidth = 1.5;
    c.setLineDash([6, 4]);
    c.strokeStyle = "#2f6fed";
    c.stroke();
    c.restore();
  }

  _finishSnip(a, cancel) {
    const { rect, poly } = this._snipShape(a);
    if (cancel || (rect[2] - rect[0]) * this.scale < 6 || (rect[3] - rect[1]) * this.scale < 6) { this._clearLive(); return; }
    this._drawSnip(a, true);
    clearTimeout(this._snipFade);
    this._snipFade = setTimeout(() => { if (!this.action) this._clearLive(); }, 900);
    this.cb.onSnip?.({ page: a.page, rect: rect.map(round2), poly: poly && poly.map((q) => [round2(q[0]), round2(q[1])]), zoom: this.scale * this.dpr });
  }

  // Where a pasted picture goes: under the pointer if it's over a page,
  // else the middle of the view.
  pastePoint(center = false) {
    if (!this.doc) return null;
    const h = this._hoverPt;
    if (!center && h && now() - h.t < 15000) {
      const [wx, wy] = this._toWorld(h.x, h.y);
      const i = this._hitPage(wx, wy, 0);
      if (i >= 0) return { page: i, p: this._worldToPage(i, wx, wy) };
    }
    const i = this.currentPage(), P = this.doc.pages[i];
    const [wx, wy] = this._toWorld(this.rect.left + this.vw / 2, this.rect.top + this.vh / 2);
    const q = this._hitPage(wx, wy, 0) === i ? this._worldToPage(i, wx, wy) : [(P.x0 + P.x1) / 2, (P.y0 + P.y1) / 2];
    return { page: i, p: q };
  }

  // Put a picture on page i, centred at p, `w` × `h` points (shrunk to fit
  // the page if needed); it is selected so it can be moved straight away.
  insertPicture(i, p, png, w, h) {
    const P = this.doc.pages[i];
    const f = Math.min(1, (P.w * 0.96) / w, (P.h * 0.96) / h);
    w *= f; h *= f;
    const x0 = clamp(p[0] - w / 2, P.x0, P.x1 - w), y0 = clamp(p[1] - h / 2, P.y0, P.y1 - h);
    const d = { type: "Stamp", shape: { k: "image" }, rect: [x0, y0, x0 + w, y0 + h].map(round2), png, href: URL.createObjectURL(new Blob([png], { type: "image/png" })), color: [], opacity: 1 };
    this._commitAdd(i, d);
    this.selectShape(i, d);
    return f < 1;
  }

  _clearLive() {
    const c = this.liveCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.live.width, this.live.height);
  }

  _liveClipToPage(i) {
    const c = this.liveCtx, L = this.L, d = this.dpr;
    c.setTransform(d, 0, 0, d, 0, 0);
    c.beginPath();
    c.rect(L.left[i] - this.sx, L.top[i] - this.sy, L.W[i], L.H[i]);
    c.clip();
  }

  _startInk(base, p, e) {
    const st = this.styles.pen;
    // With the pen, the stroke's width follows its pressure (unless turned off).
    const pressure = st.pressure !== false && e.pointerType === "pen";
    const pr0 = pressure ? (e.pressure || 0.5) : 0.5;
    const a = (this.action = { ...base, kind: "ink", pts: [p], pr: [pr0], prS: pr0, pressure, color: st.color.slice(), width: st.width, opacity: 1 });
    const c = this.liveCtx;
    c.save();
    this._liveClipToPage(a.page);
    c.strokeStyle = cssColor(a.color);
    c.fillStyle = cssColor(a.color);
    c.lineWidth = Math.max(0.5, (a.pressure ? pressureWidth(a.width, pr0) : a.width) * this.scale);
    c.lineCap = "round";
    c.lineJoin = "round";
    const [sx, sy] = this._screenOf(a.page, p);
    c.beginPath();
    c.arc(sx, sy, c.lineWidth / 2, 0, Math.PI * 2);
    c.fill();
    a.last = [sx, sy];
    a.mid = [sx, sy];
  }

  _moveInk(a, e) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const c = this.liveCtx;
    for (const ev of evs.length ? evs : [e]) {
      const p = this._clampToPage(a.page, this._clientToPage(a.page, ev.clientX, ev.clientY));
      const lp = a.pts[a.pts.length - 1];
      if (Math.hypot(p[0] - lp[0], p[1] - lp[1]) * this.scale < 0.4) continue;
      a.pts.push(p);
      if (a.pressure) {
        a.prS += ((ev.pressure || a.prS) - a.prS) * 0.35; // steady out sensor noise
        c.lineWidth = Math.max(0.5, pressureWidth(a.width, a.prS) * this.scale);
      }
      a.pr.push(a.prS);
      const s = this._screenOf(a.page, p);
      const mid = [(a.last[0] + s[0]) / 2, (a.last[1] + s[1]) / 2];
      c.beginPath();
      c.moveTo(a.mid[0], a.mid[1]);
      c.quadraticCurveTo(a.last[0], a.last[1], mid[0], mid[1]);
      c.stroke();
      a.last = s;
      a.mid = mid;
    }
    if (this.inkPresenter && e.isTrusted) {
      try { this.inkPresenter.updateInkTrailStartPoint(e, { color: cssColor(a.color), diameter: Math.max(1, a.width * this.scale) }); } catch {}
    }
  }

  _finishInk(a, cancel) {
    const c = this.liveCtx;
    c.beginPath();
    c.moveTo(a.mid[0], a.mid[1]);
    c.lineTo(a.last[0], a.last[1]);
    c.stroke();
    c.restore();
    if (cancel) { this._clearLive(); return; }
    let pts = a.pts;
    if (pts.length === 1) pts = [pts[0], [pts[0][0] + 0.01, pts[0][1]]];
    // Keep the stroke as written (no averaging, which shrinks small loops),
    // as the same smooth curve that was drawn live.
    if (a.pressure) {
      const pw = a.pts.length === 1 ? [a.pr[0], a.pr[0]] : a.pr;
      const curve = curveStroke(pts.map((q, k) => [q[0], q[1], pressureWidth(a.width, pw[k])]), 2 / this.scale);
      const ink = curve.map((q) => [round2(q[0]), round2(q[1])]);
      const widths = curve.map((q) => Math.round(q[2] * 1000) / 1000);
      this._commitAdd(a.page, { type: "Ink", color: a.color, opacity: a.opacity, width: a.width, ink: [ink], widths });
    } else {
      pts = simplify(curveStroke(pts, 1.5 / this.scale), 0.12 / this.scale).map(([x, y]) => [round2(x), round2(y)]);
      this._commitAdd(a.page, { type: "Ink", color: a.color, opacity: a.opacity, width: a.width, ink: [pts] });
    }
    this._clearLive();
  }

  // ---- highlight (snaps to text; freehand marker where there is none)
  async _loadText(i) {
    const d = this.doc;
    if (!d || d.text.has(i)) return d?.text.get(i);
    const pr = this.engine.textLines(i).then((lines) => {
      if (this.doc === d) d.text.set(i, lines);
      return lines;
    }).catch(() => {
      if (this.doc === d) d.text.set(i, new Float32Array(0));
      return null;
    });
    d.text.set(i, pr);
    return pr;
  }

  _onText(i, p) {
    const lines = this.doc.text.get(i);
    if (!(lines instanceof Float32Array)) return null;
    return !!this._snapText(i, p, 3);
  }

  // Move a point onto the vertical center of the nearest text line, so pen
  // strokes that drift into the gaps between lines still select text.
  _snapText(i, p, maxDist) {
    const lines = this.doc.text.get(i);
    if (!(lines instanceof Float32Array)) return null;
    let best = null, bd = Infinity;
    for (let k = 0; k < lines.length; k += 4) {
      const x0 = lines[k], y0 = lines[k + 1], x1 = lines[k + 2], y1 = lines[k + 3];
      const dx = p[0] < x0 ? x0 - p[0] : p[0] > x1 ? p[0] - x1 : 0;
      const dy = p[1] < y0 ? y0 - p[1] : p[1] > y1 ? p[1] - y1 : 0;
      const d = dx + dy;
      if (d < bd) { bd = d; best = [clamp(p[0], x0 + 0.01, x1 - 0.01), (y0 + y1) / 2]; }
    }
    return bd <= maxDist ? best : null;
  }

  _hlPoints(a) {
    const p = this._snapText(a.page, a.start, 3) || a.start;
    const q = this._snapText(a.page, a.end, 14) || a.end;
    return [p, q];
  }

  _startHighlight(base, p, e) {
    const st = this.styles.highlight;
    const a = (this.action = { ...base, kind: "highlight", start: p, end: p, pts: [p], quads: [], color: st.color.slice(), width: st.width, mode: "pending", qseq: 0 });
    const known = this._onText(a.page, p);
    if (known === null) {
      this._loadText(a.page).then(() => {
        if (this.action === a && a.mode === "pending") {
          a.mode = this._onText(a.page, a.start) ? "text" : "marker";
          this._refreshHighlight(a);
        }
      });
    } else a.mode = known ? "text" : "marker";
    this._refreshHighlight(a);
  }

  _moveHighlight(a, e) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) {
      const p = this._clampToPage(a.page, this._clientToPage(a.page, ev.clientX, ev.clientY));
      a.end = p;
      const lp = a.pts[a.pts.length - 1];
      if (Math.hypot(p[0] - lp[0], p[1] - lp[1]) * this.scale >= 0.8) a.pts.push(p);
    }
    this._refreshHighlight(a);
  }

  _refreshHighlight(a) {
    if (a.mode === "text") {
      this._clearLive();
      if (a.querying) { a.dirty = true; return; }
      a.querying = true;
      a.dirty = false;
      const seq = ++a.qseq;
      const [hp, hq] = this._hlPoints(a);
      this.engine.highlight(a.page, hp, hq).then((q) => {
        a.querying = false;
        if (seq !== a.qseq || this.action !== a) return;
        a.quads = q;
        this._drawHlPreview(a);
        if (a.dirty) this._refreshHighlight(a);
      }).catch(() => { a.querying = false; });
      return;
    }
    // Marker: redraw whole translucent stroke so overlaps don't darken.
    if (a.raf) return;
    a.raf = requestAnimationFrame(() => {
      a.raf = 0;
      if (this.action !== a && !a.finishing) return;
      this._clearLive();
      if (a.mode !== "marker" && a.mode !== "pending") return;
      const c = this.liveCtx;
      c.save();
      this._liveClipToPage(a.page);
      c.globalAlpha = 0.4;
      c.strokeStyle = cssColor(a.color);
      c.lineWidth = a.width * this.scale;
      c.lineCap = "round";
      c.lineJoin = "round";
      c.beginPath();
      a.pts.forEach((p, k) => { const [x, y] = this._screenOf(a.page, p); if (k) c.lineTo(x, y); else c.moveTo(x, y); });
      if (a.pts.length === 1) { const [x, y] = this._screenOf(a.page, a.pts[0]); c.lineTo(x + 0.01, y); }
      c.stroke();
      c.restore();
    });
  }

  _drawHlPreview(a) {
    const s = this._state(a.page);
    s.prevHl.textContent = "";
    if (!a.quads.length) return;
    svgEl("path", { d: a.quads.map((q) => "M" + quadPoly(q).map((p) => p.join(" ")).join("L") + "Z").join(""), fill: cssColor(a.color) }, s.prevHl);
  }

  async _finishHighlight(a, cancel) {
    const s = this._state(a.page);
    if (cancel) { s.prevHl.textContent = ""; this._clearLive(); return; }
    if (a.mode === "pending") {
      await this._loadText(a.page);
      a.mode = this._onText(a.page, a.start) ? "text" : "marker";
    }
    if (a.mode === "text") {
      let quads = a.quads;
      try { quads = await this.engine.highlight(a.page, ...this._hlPoints(a)); } catch {}
      s.prevHl.textContent = "";
      this._clearLive();
      if (quads && quads.length) {
        this._commitAdd(a.page, { type: "Highlight", color: a.color, opacity: 1, quads: quads.map((q) => q.map((v) => Math.round(v * 100) / 100)) });
        return;
      }
      // No text actually selected: keep the stroke as a marker instead of losing it.
    }
    this._clearLive();
    let pts = a.pts;
    if (pts.length === 1) pts = [pts[0], [pts[0][0] + 0.01, pts[0][1]]];
    pts = simplify(smooth(pts), 0.3 / this.scale).map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
    this._commitAdd(a.page, { type: "Ink", color: a.color, opacity: 0.4, width: a.width, ink: [pts] });
  }

  // ---- box tool: box, line, arrow, cloud, callout and text
  _startBox(base, p, shape = this.shape) {
    const st = this.styles.box;
    this.action = { ...base, kind: "box", shape, start: p, end: p, moved: false, color: st.color.slice(), width: st.width };
    this._drawBoxPreview(this.action);
  }

  _moveBox(a, e) {
    let q = this._clampToPage(a.page, this._clientToPage(a.page, e.clientX, e.clientY));
    if (e.shiftKey && (a.shape === "line" || a.shape === "arrow")) q = this._snap45(a.page, a.start, q);
    a.end = q;
    if (this._screenDist(a.page, a.start, q) > 5) a.moved = true;
    this._drawBoxPreview(a);
  }

  _snap45(i, from, p) {
    const dx = p[0] - from[0], dy = p[1] - from[1], step = Math.PI / 4;
    const ang = Math.round(Math.atan2(dy, dx) / step) * step;
    const len = dx * Math.cos(ang) + dy * Math.sin(ang);
    return this._clampToPage(i, [from[0] + len * Math.cos(ang), from[1] + len * Math.sin(ang)]);
  }

  _boxRect(a) {
    const x0 = Math.min(a.start[0], a.end[0]), y0 = Math.min(a.start[1], a.end[1]);
    const x1 = Math.max(a.start[0], a.end[0]), y1 = Math.max(a.start[1], a.end[1]);
    return [x0, y0, x1, y1];
  }

  // Open arrowhead at b for a line from a to b (page units).
  _arrowHead(a, b, w) {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), L = Math.max(6, w * 4.5), s = Math.PI / 7;
    const p1 = [b[0] - L * Math.cos(ang - s), b[1] - L * Math.sin(ang - s)];
    const p2 = [b[0] - L * Math.cos(ang + s), b[1] - L * Math.sin(ang + s)];
    return `M${p1[0]} ${p1[1]}L${b[0]} ${b[1]}L${p2[0]} ${p2[1]}`;
  }

  _drawBoxPreview(a) {
    const s = this._state(a.page);
    s.prevInk.textContent = "";
    const col = cssColor(a.color), w = a.width, g = s.prevInk;
    const stroke = { fill: "none", stroke: col, "stroke-width": w, "stroke-linecap": "round", "stroke-linejoin": "round" };
    if (a.shape === "line" || a.shape === "arrow") {
      if (!a.moved) return;
      svgEl("path", { ...stroke, d: `M${a.start[0]} ${a.start[1]}L${a.end[0]} ${a.end[1]}` + (a.shape === "arrow" ? this._arrowHead(a.start, a.end, w) : "") }, g);
    } else if (a.shape === "callout") {
      if (!a.moved) return;
      svgEl("path", { ...stroke, "stroke-width": Math.min(w, 2), d: `M${a.end[0]} ${a.end[1]}L${a.start[0]} ${a.start[1]}` + this._arrowHead(a.end, a.start, Math.min(w, 2)) }, g);
      const sz = this.textStyle.size;
      svgEl("rect", { class: "dash", x: a.end[0], y: a.end[1] - sz, width: sz * 8, height: sz * 2, fill: "none", stroke: col, "stroke-width": 1 / this.scale }, g);
    } else if (a.shape === "redact") {
      const [x0, y0, x1, y1] = this._boxRect(a);
      const gg = svgEl("g", { class: "redact" }, g);
      svgEl("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, class: "rd-fill" }, gg);
      svgEl("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, class: "rd-line" }, gg);
    } else if (a.shape === "text") {
      if (!a.moved) return;
      const [x0, , x1] = this._boxRect(a);
      svgEl("rect", { class: "dash", x: x0, y: a.start[1], width: x1 - x0, height: this.textStyle.size * 1.4, fill: "none", stroke: col, "stroke-width": 1 / this.scale }, g);
    } else {
      const [x0, y0, x1, y1] = this._boxRect(a);
      const r = svgEl("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: "none", stroke: col, "stroke-width": w }, g);
      if (a.shape === "cloud") r.setAttribute("class", "cloud-prev");
    }
  }

  _finishBox(a, cancel) {
    const s = this._state(a.page);
    s.prevInk.textContent = "";
    if (cancel) return;
    const k = a.shape;
    if (k === "text" || k === "callout") { this._openTextEditor(a); return; }
    if (k === "line" || k === "arrow") {
      if (this._screenDist(a.page, a.start, a.end) < 6) return;
      this._commitAdd(a.page, { type: "Line", shape: { k }, pts: [a.start.map(round2), a.end.map(round2)], color: a.color, opacity: 1, width: a.width });
      return;
    }
    const [x0, y0, x1, y1] = this._boxRect(a);
    if ((x1 - x0) * this.scale < 4 || (y1 - y0) * this.scale < 4) {
      if (a.tapEdit && (x1 - x0) * this.scale < 8 && (y1 - y0) * this.scale < 8) this._replaceAt(a.page, a.start);
      return;
    }
    if (k === "redact") {
      this._commitAdd(a.page, { type: "Redact", shape: { k }, rect: [x0, y0, x1, y1].map(round2), color: [], width: 0, opacity: 1 });
      return;
    }
    const h = a.width / 2;
    const r = [x0 - h, y0 - h, x1 + h, y1 + h].map(round2);
    if (k === "cloud") this._commitAdd(a.page, { type: "Square", shape: { k }, rect: r, color: a.color, opacity: 1, width: a.width });
    else this._commitAdd(a.page, { type: "Square", color: a.color, opacity: 1, width: a.width, rect: r, fill: [] });
  }

  // ---- text boxes and callouts: type straight onto the page
  // Leader for a callout box: from the tip to the middle of the first line,
  // on the side of the box facing the tip, with a short horizontal knee.
  _calloutPts(tip, rect, bw, size) {
    const [x0, y0, x1] = rect;
    const left = tip[0] <= (x0 + x1) / 2;
    const ay = y0 + bw + 1.5 + size * 0.6;
    const attach = [left ? x0 : x1, ay];
    const K = Math.min(36, Math.abs(attach[0] - tip[0]) * 0.35);
    const pts = K >= 2 ? [tip, [attach[0] + (left ? -K : K), ay], attach] : [tip, attach];
    return pts.map((p) => p.map(round2));
  }

  _openTextEditor(a) {
    const i = a.page, P = this.doc.pages[i], ts = this.textStyle, size = ts.size;
    const callout = a.shape === "callout";
    const bw = callout ? Math.min(2, a.width) : 0;
    const fill = (callout ? ts.fillCallout : ts.fillText) ? [1, 1, 1] : [];
    const lineH = size * 1.2, firstMid = bw + 1.5 + size * 0.6;
    let W, x, y, pts = null;
    if (callout) {
      const tip = a.start;
      let end = a.end;
      if (!a.moved) end = this._clampToPage(i, [tip[0] + 40 / this.scale, tip[1] - 40 / this.scale]);
      W = Math.min(size * 16, P.w * 0.6);
      const right = end[0] >= tip[0];
      x = clamp(right ? end[0] : end[0] - W, P.x0, P.x1 - W);
      y = clamp(end[1] - firstMid, P.y0, P.y1 - lineH - 2 * bw - 3);
      pts = this._calloutPts(tip.map(round2), [x, y, x + W], bw, size);
    } else {
      const [x0, , x1] = this._boxRect(a);
      W = a.moved && (x1 - x0) >= size * 3 ? x1 - x0 : Math.min(size * 16, P.w * 0.6);
      x = clamp(a.moved ? x0 : a.start[0], P.x0, P.x1 - W);
      y = clamp(a.start[1] - (a.moved ? 0 : firstMid), P.y0, P.y1 - lineH - 3);
    }
    this._showEditor({ page: i, kind: a.shape, x, y, W, size, bw, fill, color: a.color.slice(), callout: pts, text: "", target: null });
  }

  // The on-page editor. With `target`, an existing text box/callout is being
  // retyped (it is hidden meanwhile and updated in place when done).
  _showEditor(o) {
    const P = this.doc.pages[o.page], s = this._state(o.page);
    const box = el("div", "text-edit", s.el);
    box.style.left = ((o.x - P.x0) / P.w) * 100 + "%";
    box.style.top = ((o.y - P.y0) / P.h) * 100 + "%";
    box.style.width = (o.W / P.w) * 100 + "%";
    const ta = el("textarea", "", box);
    ta.spellcheck = true;
    ta.placeholder = o.kind === "callout" ? "Callout text" : o.kind === "retext" ? "Empty: the line is removed" : "Type text";
    ta.value = o.text || "";
    const col = cssColor(o.color);
    ta.style.setProperty("--ts", o.size + "px");
    ta.style.setProperty("--tb", o.bw + "px");
    ta.style.color = col;
    ta.style.borderColor = o.bw ? col : "";
    ta.classList.toggle("bordered", !!o.bw);
    ta.classList.toggle("filled", !!((o.fill && o.fill.length) || o.editFill));
    if (o.face) {
      const css = faceCss(o.face);
      ta.style.fontFamily = css.family;
      ta.style.fontWeight = css.weight;
      ta.style.fontStyle = css.style;
    } else ta.style.fontFamily = FONT_CSS[o.font] || FONT_CSS.Helv;
    const bar = el("div", "te-bar", box);
    bar.innerHTML = `<span class="te-hint">Shift+Enter: new line</span><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="done">Done</button>`;
    box.addEventListener("pointerdown", (e) => e.stopPropagation());
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (b) this._closeEditor(b.dataset.act === "done");
    });
    ta.addEventListener("keydown", (e) => {
      // Plain keys stay in the box; Ctrl/Alt/F-key shortcuts (Save…) still work.
      if (!(e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key))) e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this._closeEditor(false); }
      // Enter finishes; Shift+Enter starts a new line.
      else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); this._closeEditor(true); }
    });
    if (o.callout) {
      const lw = Math.max(o.bw, 1), pts = o.callout;
      const d = "M" + pts.map((p) => p.join(" ")).join("L") + this._arrowHead(pts[1], pts[0], lw);
      svgEl("path", { d, fill: "none", stroke: col, "stroke-width": lw, "stroke-linecap": "round", "stroke-linejoin": "round" }, s.prevInk);
    }
    if (o.target) this._nodes.get(o.target)?.setAttribute("visibility", "hidden");
    this.editor = { ...o, el: box, ta };
    this.cb.onEditing?.(true);
    // Focus right away so the very next key press goes into the box.
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  get editing() { return !!this.editor; }

  _closeEditor(commit) {
    const E = this.editor;
    if (!E) return;
    this.editor = null;
    E.el.remove();
    const s = this.doc?.states.get(E.page);
    if (s) s.prevInk.textContent = "";
    if (E.target) this._nodes.get(E.target)?.removeAttribute("visibility");
    this.cb.onEditing?.(false);
    if (!commit || !this.doc) return;
    const text = E.ta.value.replace(/\s+$/, "");
    const lines = text.split("\n").length;
    const rect = [E.x, E.y, E.x + E.W, E.y + lines * E.size * 1.2 + 2 * E.bw + 3].map(round2);
    if (E.kind === "retext") {
      const L = E.line;
      if (text === L.text) return;
      if (E.target) { this._updateShape(E.page, E.target, { ...this._snap(E.target), text }); return; }
      this._commitAdd(E.page, { type: "Redact", shape: { k: "retext" }, text, size: L.size, color: L.color, origin: L.origin, erase: L.erase, face: L.face, rect: L.erase.slice(), width: 0, opacity: 1 });
      return;
    }
    if (E.target) {
      const d = E.target;
      if (!text.trim()) {
        // Emptied: remove it (one undo brings it back).
        this._removeAnnot(E.page, d);
        this._pushHistory([{ op: "del", page: E.page, data: d }]);
      } else if (text !== d.text) {
        this._updateShape(E.page, d, { ...this._snap(d), text, rect });
      }
      return;
    }
    if (!text.trim()) return;
    const d = { type: "FreeText", shape: { k: E.kind }, text, size: E.size, color: E.color, fill: E.fill, width: E.bw, rect, opacity: 1 };
    if (E.callout) d.callout = E.callout;
    if (E.font && E.font !== "Helv") d.font = E.font;
    this._commitAdd(E.page, d);
  }

  // ---- selecting, moving and reshaping shapes (Shapes tool)
  // Tap a shape to select it. Drag it to move; drag the handles to resize a
  // box or cloud, move a line's ends or re-point a callout. Tap a selected
  // text box or callout (or "Edit text") to retype it. Changes are made to the
  // same annotation in place, one undo step each.
  _kindOf(d) {
    if (d.shape) return d.shape.k;
    if (d.measure) return "measure";
    return d.type === "Ink" ? "ink" : d.type === "Highlight" ? "highlight" : "box";
  }

  // Highlights, measurements and edited lines of text can be selected (to
  // delete, or retype) but not moved.
  _canMove(kind) { return kind !== "highlight" && kind !== "measure" && kind !== "retext"; }

  // Topmost markup under a point.
  _pickShape(i, p) {
    const tol = 8 / this.scale;
    const list = this.doc.annots.get(i) || [];
    for (let k = list.length - 1; k >= 0; k--) {
      const d = list[k], kind = this._kindOf(d);
      if (this._erased.has(d)) continue;
      if ((kind === "box" || kind === "cloud" || kind === "redact" || kind === "retext") && d.rect) {
        const r = d.rect;
        if (p[0] >= r[0] - tol && p[0] <= r[2] + tol && p[1] >= r[1] - tol && p[1] <= r[3] + tol) return d;
      } else if (this._hitAnnot(d, p, tol)) return d;
    }
    return null;
  }

  _shapeTap(ptr) {
    const [wx, wy] = this._toWorld(ptr.x, ptr.y);
    const i = this._hitPage(wx, wy, 0);
    const d = i >= 0 ? this._pickShape(i, this._worldToPage(i, wx, wy)) : null;
    if (d) {
      if (this.shapeSel && this.shapeSel.d === d) this.editSelectedText();
      else this.selectShape(i, d);
      return true;
    }
    if (this.shapeSel) { this.deselectShape(); return true; }
    return false;
  }

  _snap(d) {
    const g = {};
    for (const k of ["pts", "rect", "ink", "widths", "text", "size", "font", "color", "fill", "width", "callout", "origin", "erase", "face"]) if (d[k] != null) g[k] = JSON.parse(JSON.stringify(d[k]));
    return g;
  }

  // Change a shape (one undo step).
  _updateShape(i, d, after) {
    const before = this._snap(d);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this._applySnap(i, d, after);
    this._pushHistory([{ op: "upd", page: i, data: d, before, after }]);
  }

  _applySnap(i, d, snap) {
    Object.assign(d, JSON.parse(JSON.stringify(snap)));
    if (d.shape) d.svg = null;
    this._redrawAnnot(i, d);
    this._refreshErased(i);
    if (this.shapeSel && this.shapeSel.d === d) this._renderShapeSel();
    this.engine.updateAnnot(i, () => d.id, () => this._payload(d), d)
      .then(() => {
        this._annotReady(d);
        if (this.shapeSel && this.shapeSel.d === d) this._renderShapeSel();
      })
      .catch((err) => this.cb.onError?.("Couldn't change that markup: " + err.message));
  }

  _redrawAnnot(i, d) {
    this._nodes.get(d)?.remove();
    this._nodes.delete(d);
    this._drawAnnot(i, d);
  }

  get placingExisting() { return !!(this.placing && this.placing.replace); }

  get selectedShape() { return this.shapeSel ? this._kindOf(this.shapeSel.d) : null; }

  selectShape(i, d) {
    this.deselectShape();
    if (isPic(this._kindOf(d)) && !d.href && !d.png) {
      this.engine.annotImage(i, () => d.id).then((png) => {
        if (!png || d.png) return;
        d.png = png;
        d.href = URL.createObjectURL(new Blob([png], { type: "image/png" }));
      }).catch(() => {});
    }
    this.shapeSel = { page: i, d, el: null, geo: null };
    this._renderShapeSel();
    this.cb.onShapeSelect?.(this._kindOf(d), d);
  }

  deselectShape() {
    const S = this.shapeSel;
    if (!S) return;
    this.shapeSel = null;
    S.el?.remove();
    const s = this.doc?.states.get(S.page);
    if (s && S.geo) { s.prevInk.textContent = ""; this._nodes.get(S.d)?.removeAttribute("visibility"); }
    this.cb.onShapeSelect?.(null, null);
  }

  deleteSelectedShape() {
    const S = this.shapeSel;
    if (!S) return;
    this.deselectShape();
    this._removeAnnot(S.page, S.d);
    this._pushHistory([{ op: "del", page: S.page, data: S.d }]);
  }

  editSelectedText() {
    const S = this.shapeSel;
    if (!S) return;
    const d = S.d, k = this._kindOf(d);
    if (k === "retext") { this.deselectShape(); this._editRetext(S.page, d); return; }
    if (k !== "text" && k !== "callout") return;
    this.deselectShape();
    const [x0, y0, x1] = d.rect;
    this._showEditor({ page: S.page, kind: k, x: x0, y: y0, W: x1 - x0, size: d.size, bw: d.width || 0, fill: d.fill || [], color: d.color, font: d.font, callout: d.callout || null, text: d.text, target: d });
  }

  // Recolour / re-size the selected shape from the shapes menu.
  restyleSelected(style) {
    const S = this.shapeSel;
    if (!S) return false;
    const d = S.d, k = this._kindOf(d), g = this._snap(d), isText = k === "text" || k === "callout";
    if (style.color) g.color = style.color.slice();
    if (style.width != null && k !== "text") g.width = k === "callout" ? Math.min(2, style.width) : style.width;
    if (k === "ink" && g.widths && style.width != null && d.width) g.widths = g.widths.map((w) => Math.round((w * style.width / d.width) * 1000) / 1000);
    if (isText && style.size) g.size = style.size;
    if (isText && style.fill != null) g.fill = style.fill ? [1, 1, 1] : [];
    if (k === "callout" && g.callout) g.callout = this._calloutPts(g.callout[0], g.rect, g.width || 0, g.size);
    this._updateShape(S.page, d, g);
    return true;
  }

  _selBox(g, kind, d) {
    let pts = null;
    if (kind === "line" || kind === "arrow" || kind === "measure") pts = g.pts || d.pts;
    else if (kind === "ink") pts = (g.ink || d.ink).flat();
    else if (kind === "highlight") pts = d.quads.flatMap((q) => quadPoly(q));
    if (!pts) return g.rect;
    const m = Math.max(6 / this.scale, (g.width || d.width || 1) * 1.5);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m];
  }

  _renderShapeSel() {
    const S = this.shapeSel;
    if (!S || !this.doc) return;
    const i = S.page, P = this.doc.pages[i], s = this._state(i), d = S.d, kind = this._kindOf(d);
    const g = S.geo || this._snap(d);
    const pct = (el, x, y) => { el.style.left = ((x - P.x0) / P.w) * 100 + "%"; el.style.top = ((y - P.y0) / P.h) * 100 + "%"; };
    if (!S.el || S.el.parentNode !== s.el) {
      S.el?.remove();
      S.el = el("div", "shape-sel", s.el);
      const frame = el("div", "ss-frame", S.el);
      if (this._canMove(kind)) frame.dataset.role = "move";
      else frame.classList.add("fixed");
      const roles = ["box", "cloud", "redact", "sig", "image"].includes(kind) ? ["nw", "ne", "sw", "se"] : kind === "line" || kind === "arrow" ? ["p0", "p1"] : kind === "callout" ? ["tip"] : [];
      for (const r of roles) { const h = el("div", "ss-h " + r, S.el); h.dataset.role = r; }
      const bar = el("div", "ss-bar", S.el);
      bar.innerHTML = (kind === "text" || kind === "callout" || kind === "retext" ? `<button class="btn" data-act="edit">Edit text</button>` : "") + `<button class="btn" data-act="delete">${kind === "retext" ? "Undo edit" : "Delete"}</button>`;
      bar.addEventListener("pointerdown", (e) => e.stopPropagation());
      bar.addEventListener("click", (e) => {
        const b = e.target.closest("[data-act]");
        if (b?.dataset.act === "edit") this.editSelectedText();
        else if (b?.dataset.act === "delete") this.deleteSelectedShape();
      });
      S.el.addEventListener("pointerdown", (e) => this._selDown(e));
      this.cb.onDecorate?.(bar);
    }
    const [x0, y0, x1, y1] = this._selBox(g, kind, d);
    const frame = S.el.querySelector(".ss-frame");
    pct(frame, x0, y0);
    frame.style.width = ((x1 - x0) / P.w) * 100 + "%";
    frame.style.height = ((y1 - y0) / P.h) * 100 + "%";
    frame.classList.toggle("line", ["line", "arrow", "ink", "highlight", "measure"].includes(kind));
    for (const h of S.el.querySelectorAll(".ss-h")) {
      const r = h.dataset.role;
      if (r === "p0" || r === "p1") pct(h, ...g.pts[r === "p0" ? 0 : 1]);
      else if (r === "tip") pct(h, ...g.callout[0]);
      else pct(h, r.includes("w") ? g.rect[0] : g.rect[2], r.includes("n") ? g.rect[1] : g.rect[3]);
    }
    const bar = S.el.querySelector(".ss-bar");
    pct(bar, x0, y0);
    bar.classList.toggle("below", (y0 - P.y0) * this.scale < 56);
    if (bar.classList.contains("below")) pct(bar, x0, y1);
  }

  // Geometry while dragging part of the selected shape.
  _dragGeo(S, g0, role, dx, dy, shift) {
    const P = this.doc.pages[S.page], kind = this._kindOf(S.d);
    const g = JSON.parse(JSON.stringify(g0));
    if (role === "move") {
      const all = kind === "ink" ? g0.ink.flat() : kind === "line" || kind === "arrow" ? g0.pts : null;
      const [bx0, by0, bx1, by1] = all
        ? [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))]
        : g0.rect;
      dx = clamp(dx, P.x0 - bx0, P.x1 - bx1);
      dy = clamp(dy, P.y0 - by0, P.y1 - by1);
      if (g.pts) g.pts = g0.pts.map((p) => [round2(p[0] + dx), round2(p[1] + dy)]);
      if (g.ink) g.ink = g0.ink.map((st) => st.map((p) => [round2(p[0] + dx), round2(p[1] + dy)]));
      if (g.rect && kind !== "ink") g.rect = [g0.rect[0] + dx, g0.rect[1] + dy, g0.rect[2] + dx, g0.rect[3] + dy].map(round2);
      if (kind === "callout") g.callout = this._calloutPts(g0.callout[0], g.rect, g.width || 0, g.size);
    } else if (role === "p0" || role === "p1") {
      const k = role === "p0" ? 0 : 1;
      let q = this._clampToPage(S.page, [g0.pts[k][0] + dx, g0.pts[k][1] + dy]);
      if (shift) q = this._snap45(S.page, g0.pts[1 - k], q);
      g.pts[k] = q.map(round2);
    } else if (role === "tip") {
      const tip = this._clampToPage(S.page, [g0.callout[0][0] + dx, g0.callout[0][1] + dy]);
      g.callout = this._calloutPts(tip, g.rect, g.width || 0, g.size);
    } else if (isPic(kind)) {
      // A signature keeps its proportions.
      const r = g0.rect, aspect = (r[3] - r[1]) / (r[2] - r[0]);
      const ax = role.includes("w") ? r[2] : r[0], ay = role.includes("n") ? r[3] : r[1];
      const px = (role.includes("w") ? r[0] : r[2]) + dx, py = (role.includes("n") ? r[1] : r[3]) + dy;
      let w = Math.max(16 / this.scale, 8, Math.abs(px - ax), Math.abs(py - ay) / aspect);
      w = Math.min(w, P.w, P.h / aspect);
      const h = w * aspect;
      let nx = role.includes("w") ? ax - w : ax, ny = role.includes("n") ? ay - h : ay;
      nx = clamp(nx, P.x0, P.x1 - w);
      ny = clamp(ny, P.y0, P.y1 - h);
      g.rect = [nx, ny, nx + w, ny + h].map(round2);
    } else {
      // A corner of a box, cloud or erase area: resize from the opposite corner.
      const r = g0.rect, min = Math.max(6, 12 / this.scale);
      const ax = role.includes("w") ? r[2] : r[0], ay = role.includes("n") ? r[3] : r[1];
      let px = clamp((role.includes("w") ? r[0] : r[2]) + dx, P.x0, P.x1);
      let py = clamp((role.includes("n") ? r[1] : r[3]) + dy, P.y0, P.y1);
      if (Math.abs(px - ax) < min) px = ax + (role.includes("w") ? -min : min);
      if (Math.abs(py - ay) < min) py = ay + (role.includes("n") ? -min : min);
      g.rect = [Math.min(ax, px), Math.min(ay, py), Math.max(ax, px), Math.max(ay, py)].map(round2);
    }
    return g;
  }

  _selDown(e) {
    const S = this.shapeSel;
    const t = e.target.closest("[data-role]");
    if (!S || !t) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.pointerType === "touch" && now() - this.lastPen < PALM_MS) return;
    if (e.pointerType === "pen") this.lastPen = now();
    try { t.setPointerCapture(e.pointerId); } catch {}
    this._beginSelDrag(e, t.dataset.role, t, false);
  }

  // Stand-in drawing of a markup at a new place while it's dragged.
  _previewNode(tmp, kind) {
    if (tmp.shape) return this._shapeNode(tmp);
    if (kind === "ink" && inkWidths(tmp)) return svgEl("path", { d: polyPath(strokeOutline(tmp.ink[0], tmp.widths)), fill: cssColor(tmp.color) });
    if (kind === "ink") {
      return svgEl("path", { d: tmp.ink.map((st) => "M" + st.map((p) => p.join(" ")).join("L")).join(""), fill: "none", stroke: cssColor(tmp.color), "stroke-width": tmp.width || 1, "stroke-linecap": "round", "stroke-linejoin": "round", opacity: tmp.opacity < 1 ? tmp.opacity : 1 });
    }
    const w = tmp.width || 1;
    return svgEl("rect", { x: tmp.rect[0] + w / 2, y: tmp.rect[1] + w / 2, width: tmp.rect[2] - tmp.rect[0] - w, height: tmp.rect[3] - tmp.rect[1] - w, fill: "none", stroke: cssColor(tmp.color), "stroke-width": w });
  }

  // Drag the selected markup (or one of its handles). `fresh`: it was only
  // just selected by this press, so a tap doesn't open it for typing.
  _beginSelDrag(e, role, target, fresh) {
    const S = this.shapeSel;
    const i = S.page, d = S.d, kind = this._kindOf(d);
    const sx = e.clientX, sy = e.clientY, t0 = now(), g0 = this._snap(d);
    let moved = false;
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId || this.shapeSel !== S) return;
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true;
      S.geo = this._dragGeo(S, g0, role, (ev.clientX - sx) / this.scale, (ev.clientY - sy) / this.scale, ev.shiftKey);
      // Live preview: hide the markup and draw a stand-in at the new place.
      const s = this._state(i);
      this._nodes.get(d)?.setAttribute("visibility", "hidden");
      s.prevInk.textContent = "";
      s.prevInk.appendChild(this._previewNode({ ...d, ...S.geo, svg: null }, kind));
      this._renderShapeSel();
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      if (this.shapeSel !== S) return;
      if (!moved) {
        const tap = !fresh && ev.type === "pointerup" && role === "move" && now() - t0 < 500;
        // A tap on a markup lying on top of the selected one selects that one.
        if (tap) {
          const top = this._pickShape(i, this._clientToPage(i, ev.clientX, ev.clientY));
          if (top && top !== d) { this.selectShape(i, top); return; }
        }
        // A tap on an already selected text box or callout opens it for typing.
        if (tap && (kind === "text" || kind === "callout")) this.editSelectedText();
        return;
      }
      const after = S.geo;
      S.geo = null;
      this._state(i).prevInk.textContent = "";
      if (ev.type === "pointercancel") { this._nodes.get(d)?.removeAttribute("visibility"); this._renderShapeSel(); return; }
      this._updateShape(i, d, after);
      this._renderShapeSel();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  // Finish typing (e.g. before saving).
  commitEdits() { this._closeEditor(true); }

  // ---- editing the page's own content: erase areas and retyped lines
  // Erase areas and edited lines waiting to be applied (done when saving).
  pendingContentEdits() {
    const n = { erase: 0, lines: 0 };
    for (const list of this.doc ? this.doc.annots.values() : []) {
      for (const d of list) {
        if (d.shape && d.shape.k === "redact") n.erase++;
        else if (d.shape && d.shape.k === "retext") n.lines++;
      }
    }
    return n;
  }

  _replaceTap(ptr) {
    const [wx, wy] = this._toWorld(ptr.x, ptr.y);
    const i = this._hitPage(wx, wy, 0);
    if (i >= 0) this._replaceAt(i, this._worldToPage(i, wx, wy));
  }

  // Tap with Edit content: retype an edited line again, or the page's text.
  async _replaceAt(i, p) {
    const doc = this.doc;
    const list = doc.annots.get(i) || [];
    for (let k = list.length - 1; k >= 0; k--) {
      const d = list[k];
      if (d.shape && d.shape.k === "retext" && !this._erased.has(d) && d.rect && p[0] >= d.rect[0] && p[0] <= d.rect[2] && p[1] >= d.rect[1] && p[1] <= d.rect[3]) {
        this._editRetext(i, d);
        return;
      }
    }
    let line = null;
    try { line = await this.engine.lineAt(i, p); } catch {}
    if (this.doc !== doc) return;
    if (!line) { this.cb.onInfo?.("No text here. Drag a box to erase an area instead."); return; }
    if (line.rotated) { this.cb.onInfo?.("Rotated or vertical text can't be retyped. Drag a box over it to erase it."); return; }
    const face = { ...line.face };
    try {
      const f = await this.cb.findFont?.(face);
      if (f) Object.assign(face, { file: f.file, url: f.url, index: f.index, ps: f.ps, family: f.family });
    } catch {}
    if (this.doc !== doc || this.editor) return;
    const erase = [line.bbox[0] - 0.5, line.bbox[1] - 0.5, line.bbox[2] + 0.5, line.bbox[3] + 0.5].map(round2);
    this._showLineEditor(i, { text: line.text, size: line.size, color: line.color, origin: line.origin, erase, face }, null);
  }

  _editRetext(i, d) {
    this._showLineEditor(i, { text: d.text, size: d.size, color: d.color, origin: d.origin, erase: d.erase, face: d.face }, d);
  }

  // The editor sits over the line with its first baseline on the line's.
  _showLineEditor(i, L, target) {
    const P = this.doc.pages[i];
    const x = L.origin[0] - 2;
    const W = Math.max(L.erase[2] - L.erase[0] + L.size * 2, P.x1 - x - 12);
    this._showEditor({ page: i, kind: "retext", x, y: L.origin[1] - L.size * 0.945 - 1, W, size: L.size, bw: 0, fill: [], editFill: true, color: L.color, face: L.face, text: L.text, line: L, target });
  }

  // Markups made before an erase area and lying mostly inside it are removed
  // with it when saving: hide them now so the page shows the result.
  _refreshErased(i) {
    const list = this.doc?.annots.get(i);
    if (!list) return;
    const areas = [];
    list.forEach((d, k) => { if (d.shape && d.shape.k === "redact" && d.rect) areas.push([k, d.rect]); });
    list.forEach((d, k) => {
      let hide = false;
      if (areas.length && !(d.shape && (d.shape.k === "redact" || d.shape.k === "retext"))) {
        const b = this._annotBox(d);
        if (b) hide = areas.some(([ak, r]) => ak > k && coverage(b, r) >= 0.5);
      }
      if (hide) this._erased.add(d); else this._erased.delete(d);
      this._nodes.get(d)?.classList.toggle("erased", hide);
      if (hide && this.shapeSel && this.shapeSel.d === d) this.deselectShape();
    });
  }

  get _erased() { return (this.__erased ||= new WeakSet()); }

  _annotBox(d) {
    if (d.rect) return d.rect;
    let pts = d.pts || (d.ink && d.ink.flat()) || (d.quads && d.quads.flatMap((q) => quadPoly(q)));
    if (!pts || !pts.length) return d.bounds || null;
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  // ---- signatures
  // sig: { href, png, aspect (height / width) }. With `replace`, an existing
  // signature is being moved/resized.
  placeSignature(sig, { page, center, width, replace, replacePage } = {}) {
    if (!this.doc) return;
    this._closeEditor(true);
    this.finishPlacing(false);
    const i = clamp(page ?? this.currentPage(), 0, this.doc.pages.length - 1);
    const P = this.doc.pages[i];
    let rect;
    if (replace) rect = replace.rect.slice();
    else {
      let w = Math.min(width || 150, P.w * 0.5), h = w * sig.aspect;
      if (h > P.h * 0.4) { h = P.h * 0.4; w = h / sig.aspect; }
      let c = center;
      if (!c) {
        const L = this.L;
        const vx0 = Math.max(this.sx, L.left[i]), vx1 = Math.min(this.sx + this.vw, L.left[i] + L.W[i]);
        const vy0 = Math.max(this.sy, L.top[i]), vy1 = Math.min(this.sy + this.vh, L.top[i] + L.H[i]);
        c = vx1 > vx0 && vy1 > vy0 ? this._worldToPage(i, (vx0 + vx1) / 2, (vy0 + vy1) / 2) : [P.x0 + P.w / 2, P.y0 + P.h / 2];
      }
      rect = [c[0] - w / 2, c[1] - h / 2, c[0] + w / 2, c[1] + h / 2];
    }
    this.placing = { sig, page: i, rect, replace: replace || null, replacePage: replace ? replacePage ?? i : null };
    if (replace) this._nodes.get(replace)?.setAttribute("visibility", "hidden");
    this.placeBar.querySelector('[data-act="delete"]').hidden = !replace;
    this._clampPlacing();
    this._renderPlacing();
    this.placeBar.hidden = false;
    this.cb.onPlacing?.(true);
  }

  // Move or resize a signature already on the page.
  async adjustSignature(i, d) {
    if (!d.png) {
      const png = await this.engine.annotImage(i, () => d.id);
      if (!png || !this.doc) return;
      d.png = png;
    }
    if (!d.href) d.href = URL.createObjectURL(new Blob([d.png], { type: "image/png" }));
    const [x0, y0, x1, y1] = d.rect;
    this.placeSignature({ href: d.href, png: d.png, aspect: (y1 - y0) / Math.max(1e-6, x1 - x0) }, { page: i, replace: d, replacePage: i });
  }

  _clampPlacing() {
    const pl = this.placing, P = this.doc.pages[pl.page];
    let [x0, y0, x1, y1] = pl.rect;
    let w = x1 - x0, h = y1 - y0;
    const f = Math.min(1, P.w / w, P.h / h);
    w *= f; h *= f;
    x0 = clamp(x0, P.x0, P.x1 - w);
    y0 = clamp(y0, P.y0, P.y1 - h);
    pl.rect = [x0, y0, x0 + w, y0 + h];
  }

  _renderPlacing() {
    const pl = this.placing;
    if (!pl) return;
    const s = this._state(pl.page), P = this.doc.pages[pl.page];
    if (!pl.el || pl.el.parentNode !== s.el) {
      pl.el?.remove();
      pl.el = el("div", "sig-place", s.el);
      const img = el("img", "", pl.el);
      img.src = pl.sig.href;
      img.alt = "";
      img.draggable = false;
      for (const c of ["nw", "ne", "sw", "se"]) el("div", "sp-h " + c, pl.el).dataset.h = c;
      pl.el.addEventListener("pointerdown", (e) => this._placeDown(e));
    }
    const [x0, y0, x1, y1] = pl.rect, st = pl.el.style;
    st.left = ((x0 - P.x0) / P.w) * 100 + "%";
    st.top = ((y0 - P.y0) / P.h) * 100 + "%";
    st.width = ((x1 - x0) / P.w) * 100 + "%";
    st.height = ((y1 - y0) / P.h) * 100 + "%";
  }

  _placeDown(e) {
    e.stopPropagation();
    e.preventDefault();
    const pl = this.placing;
    if (!pl) return;
    if (e.pointerType === "touch" && now() - this.lastPen < PALM_MS) return;
    if (e.pointerType === "pen") this.lastPen = now();
    const target = pl.el, h = e.target.dataset?.h || null;
    try { target.setPointerCapture(e.pointerId); } catch {}
    target.classList.add("dragging");
    const sx = e.clientX, sy = e.clientY, r0 = pl.rect.slice(), aspect = (r0[3] - r0[1]) / (r0[2] - r0[0]);
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      const dx = (ev.clientX - sx) / this.scale, dy = (ev.clientY - sy) / this.scale;
      const [x0, y0, x1, y1] = r0;
      if (!h) pl.rect = [x0 + dx, y0 + dy, x1 + dx, y1 + dy];
      else {
        // Resize from the opposite corner, keeping the proportions.
        const ax = h.includes("w") ? x1 : x0, ay = h.includes("n") ? y1 : y0;
        const px = (h.includes("w") ? x0 : x1) + dx, py = (h.includes("n") ? y0 : y1) + dy;
        const w = Math.max(16 / this.scale, 8, Math.abs(px - ax), Math.abs(py - ay) / aspect), hh = w * aspect;
        const nx = h.includes("w") ? ax - w : ax, ny = h.includes("n") ? ay - hh : ay;
        pl.rect = [nx, ny, nx + w, ny + hh];
      }
      this._clampPlacing();
      this._renderPlacing();
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      target.classList.remove("dragging");
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  _signTap(ptr) {
    const [wx, wy] = this._toWorld(ptr.x, ptr.y);
    const i = this._hitPage(wx, wy, 0);
    if (i < 0) return;
    const p = this._worldToPage(i, wx, wy);
    const pl = this.placing;
    if (pl) {
      if (pl.replace && i !== pl.page) return; // a moved signature stays on its page
      const w = pl.rect[2] - pl.rect[0], h = pl.rect[3] - pl.rect[1];
      pl.page = i;
      pl.rect = [p[0] - w / 2, p[1] - h / 2, p[0] + w / 2, p[1] + h / 2];
      this._clampPlacing();
      this._renderPlacing();
      return;
    }
    const hit = (this.doc.annots.get(i) || []).slice().reverse().find((d) => d.shape?.k === "sig" && this._hitAnnot(d, p, 4 / this.scale));
    this.cb.onSignTap?.(i, p, hit || null);
  }

  // Place (true) or drop (false) the signature being positioned; "delete"
  // removes the signature that was being moved.
  finishPlacing(place) {
    const pl = this.placing;
    if (!pl) return;
    this.placing = null;
    pl.el?.remove();
    this.placeBar.hidden = true;
    const old = pl.replace;
    if (old) this._nodes.get(old)?.removeAttribute("visibility");
    this.cb.onPlacing?.(false);
    if (place === "delete" && old && this.doc) {
      this._removeAnnot(pl.replacePage, old);
      this._pushHistory([{ op: "del", page: pl.replacePage, data: old }]);
      return;
    }
    if (place !== true || !this.doc) return;
    const rect = pl.rect.map(round2);
    if (old && pl.page === pl.replacePage && rect.every((v, k) => Math.abs(v - old.rect[k]) < 0.01)) return;
    const d = { type: "Stamp", shape: { k: "sig" }, rect, png: pl.sig.png, href: pl.sig.href, color: [], opacity: 1 };
    if (old) {
      this._removeAnnot(pl.replacePage, old);
      this._insertAnnot(pl.page, d);
      this._pushHistory([{ op: "del", page: pl.replacePage, data: old }, { op: "add", page: pl.page, data: d }]);
    } else {
      this._commitAdd(pl.page, d);
    }
    this.cb.onSigned?.(pl.sig, rect);
  }

  // ---- eraser
  _startErase(e, ptr, touch) {
    this.action = { kind: "erase", pid: ptr.id, touch, t0: now(), removed: [], last: [e.clientX, e.clientY] };
    this.root.classList.add("erasing");
    this._eraseAt(this.action, e.clientX, e.clientY);
  }

  _moveErase(a, e) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) {
      const [lx, ly] = a.last;
      const dist = Math.hypot(ev.clientX - lx, ev.clientY - ly);
      const steps = Math.max(1, Math.ceil(dist / 4));
      for (let k = 1; k <= steps; k++) this._eraseAt(a, lx + ((ev.clientX - lx) * k) / steps, ly + ((ev.clientY - ly) * k) / steps);
      a.last = [ev.clientX, ev.clientY];
    }
  }

  _eraseAt(a, cx, cy) {
    const [wx, wy] = this._toWorld(cx, cy);
    const i = this._hitPage(wx, wy, 10);
    if (i < 0) return;
    const p = this._worldToPage(i, wx, wy);
    const tol = 7 / this.scale;
    const list = this.doc.annots.get(i);
    if (!list) return;
    for (const d of list.slice()) {
      if (this._hitAnnot(d, p, tol)) {
        this._removeAnnot(i, d);
        a.removed.push({ op: "del", page: i, data: d });
      }
    }
  }

  _hitAnnot(d, p, tol) {
    const [x, y] = p;
    if (d.shape) {
      const k = d.shape.k, w = d.width || 1;
      if (k === "line" || k === "arrow") {
        const [a, b] = d.pts;
        return distSeg(x, y, a[0], a[1], b[0], b[1]) <= tol + w / 2 + (k === "arrow" ? 2 : 0);
      }
      const r = d.rect || d.bounds;
      if (!r) return false;
      if (k === "callout" && d.callout) {
        for (let j = 1; j < d.callout.length; j++) {
          const a = d.callout[j - 1], b = d.callout[j];
          if (distSeg(x, y, a[0], a[1], b[0], b[1]) <= tol + 1) return true;
        }
      }
      if (k === "cloud") {
        // Like a box: touch the (bumpy) border.
        const m = tol + w / 2 + 5;
        const inside = x >= r[0] + m && x <= r[2] - m && y >= r[1] + m && y <= r[3] - m;
        return !inside && x >= r[0] - m && x <= r[2] + m && y >= r[1] - m && y <= r[3] + m;
      }
      // Text, callout box and signature: anywhere inside.
      return x >= r[0] - tol && x <= r[2] + tol && y >= r[1] - tol && y <= r[3] + tol;
    }
    if (d.measure) {
      const pts = d.pts, r = tol + 2 / this.scale;
      const closed = d.type === "Polygon";
      if (closed && pointInPoly(x, y, pts)) return true;
      for (let k = 1; k < pts.length + (closed ? 1 : 0); k++) {
        const a = pts[k - 1], b = pts[k % pts.length];
        if (distSeg(x, y, a[0], a[1], b[0], b[1]) <= r) return true;
      }
      return false;
    }
    if (d.type === "Ink") {
      const r = tol + (d.width || 1) / 2;
      for (const s of d.ink) {
        if (s.length === 1 && Math.hypot(x - s[0][0], y - s[0][1]) <= r) return true;
        for (let k = 1; k < s.length; k++) if (distSeg(x, y, s[k - 1][0], s[k - 1][1], s[k][0], s[k][1]) <= r) return true;
      }
      return false;
    }
    if (d.type === "Square") {
      const w = d.width || 1, h = w / 2;
      const [x0, y0, x1, y1] = [d.rect[0] + h, d.rect[1] + h, d.rect[2] - h, d.rect[3] - h];
      const r = tol + h;
      const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
      if (inside && d.fill && d.fill.length) return true;
      const edges = [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]];
      return edges.some(([ax, ay, bx, by]) => distSeg(x, y, ax, ay, bx, by) <= r);
    }
    if (d.type === "Highlight") {
      for (const q of d.quads) {
        const poly = quadPoly(q);
        if (pointInPoly(x, y, poly)) return true;
        for (let k = 0; k < 4; k++) {
          const [ax, ay] = poly[k], [bx, by] = poly[(k + 1) % 4];
          if (distSeg(x, y, ax, ay, bx, by) <= tol) return true;
        }
      }
    }
    return false;
  }

  _finishErase(a, cancel) {
    this.root.classList.remove("erasing");
    if (a.removed.length) this._pushHistory(a.removed);
  }

  // ------------------------------------------------------------ text selection
  // A drag that starts on (or right next to) text selects it; one that starts
  // on blank paper pans instead, so the select tool doubles as a hand tool.
  _selectableAt(i, p) {
    const lines = this.doc.text.get(i);
    if (!(lines instanceof Float32Array)) return null; // not loaded yet
    return !!this._snapText(i, p, Math.max(3, 12 / this.scale));
  }

  _startSelect(e, ptr, touch) {
    const i = this._pageForPointer(e);
    if (i < 0) return false;
    const p = this._clampToPage(i, this._clientToPage(i, e.clientX, e.clientY));
    const hit = !e.shiftKey && this._pickShape(i, p);
    if (hit) {
      if (this._canMove(this._kindOf(hit))) {
        // Press on a markup: select it; dragging moves it straight away.
        this.selectShape(i, hit);
        this._beginSelDrag(e, "move", this.root, true);
        return true;
      }
      // A highlight or measurement: a tap selects it, a drag still selects text.
      this.action = { kind: "pickmark", pid: ptr.id, touch, t0: now(), x0: e.clientX, y0: e.clientY, page: i, d: hit, ev: { clientX: e.clientX, clientY: e.clientY, shiftKey: false }, ptr };
      return true;
    }
    return this._startTextSelect(e, ptr, touch, i, p);
  }

  _movePick(a, e) {
    if (Math.hypot(e.clientX - a.x0, e.clientY - a.y0) < 4) return;
    this.action = null;
    if (this._startTextSelect(a.ev, a.ptr, a.touch, a.page, this._clampToPage(a.page, this._clientToPage(a.page, a.x0, a.y0)))) this._moveSelect(this.action, e);
  }

  _startTextSelect(e, ptr, touch, i, p) {
    const t = now(), lc = this._lastClick;
    let clicks = 1;
    if (lc && t - lc.t < 450 && Math.hypot(e.clientX - lc.x, e.clientY - lc.y) < (touch ? 24 : 6)) clicks = lc.n >= 3 ? 1 : lc.n + 1;
    const extend = e.shiftKey && this.sel && clicks === 1;
    if (clicks === 1 && !extend && this._selectableAt(i, p) === false) { this._lastClick = null; return false; }
    this._loadText(i);
    this._lastClick = { t, x: e.clientX, y: e.clientY, n: clicks };
    const mode = clicks === 2 ? "words" : clicks === 3 ? "lines" : extend ? this.sel.mode : "chars";
    if (!extend && clicks === 1) this.clearSelection();
    const a = (this.action = {
      kind: "select", pid: ptr.id, touch, t0: t, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY,
      anchor: extend ? this.sel.anchor : { page: i, p }, focus: { page: i, p }, mode, active: clicks > 1 || extend, seq: 0,
    });
    if (a.active) this._querySelection(a);
    return true;
  }

  _moveSelect(a, e) {
    a.lx = e.clientX;
    a.ly = e.clientY;
    if (!a.active && Math.hypot(e.clientX - a.x0, e.clientY - a.y0) < 4) return;
    a.active = true;
    this._selectTo(a);
    this._edgeScroll(a);
  }

  _selectTo(a) {
    const [wx, wy] = this._toWorld(a.lx, a.ly);
    let i = this._hitPage(wx, wy, 0);
    if (i < 0) i = clamp(this._pageAtY(wy), 0, this.doc.pages.length - 1);
    a.focus = { page: i, p: this._clampToPage(i, this._worldToPage(i, wx, wy)) };
    this._querySelection(a);
  }

  // Scroll while dragging a selection near the edge of the view.
  _edgeScroll(a) {
    const E = 36, x = a.lx - this.rect.left, y = a.ly - this.rect.top;
    const v = (c, n) => (c < E ? -(E - c) : c > n - E ? c - (n - E) : 0) * 0.5;
    a.ev = [v(x, this.vw), v(y, this.vh)];
    if ((a.ev[0] || a.ev[1]) && !a.raf) {
      const step = () => {
        if (this.action !== a || (!a.ev[0] && !a.ev[1])) { a.raf = 0; return; }
        this.scrollBy(a.ev[0], a.ev[1]);
        this._selectTo(a);
        a.raf = requestAnimationFrame(step);
      };
      a.raf = requestAnimationFrame(step);
    }
  }

  // [page, from, to] for each page the selection touches.
  _selParts(anchor, focus) {
    let A = anchor, B = focus;
    if (B.page < A.page) [A, B] = [B, A];
    if (A.page === B.page) return [[A.page, A.p, B.p]];
    const P = this.doc.pages, out = [[A.page, A.p, [P[A.page].x1, P[A.page].y1]]];
    for (let k = A.page + 1; k < B.page && out.length < 60; k++) out.push([k, [P[k].x0, P[k].y0], [P[k].x1, P[k].y1]]);
    out.push([B.page, [P[B.page].x0, P[B.page].y0], B.p]);
    return out;
  }

  _querySelection(a) {
    if (a.querying) { a.dirty = true; return; }
    a.querying = true;
    a.dirty = false;
    const seq = ++a.seq, doc = this.doc;
    const parts = this._selParts(a.anchor, a.focus);
    Promise.all(parts.map(([k, p, q]) => this.engine.selectText(k, p, q, a.mode).then((r) => ({ page: k, ...r }))))
      .then((res) => {
        a.querying = false;
        if (this.doc !== doc || seq !== a.seq) return;
        if (a.dirty) { this._querySelection(a); return; }
        if (this.action !== a && !a.ended) return; // replaced by another gesture
        const kept = res.filter((r) => r.quads.length);
        this._setSelection(kept.length ? { anchor: a.anchor, focus: a.focus, mode: a.mode, parts: kept } : null);
      })
      .catch((err) => { a.querying = false; console.warn("select", err); });
  }

  _finishSelect(a, cancel) {
    if (a.raf) cancelAnimationFrame(a.raf);
    a.raf = 0;
    a.ended = true;
    if (cancel || !a.active) { this.clearSelection(); return; }
    this._placeSelBar();
  }

  _setSelection(sel) {
    if (sel) sel.text = sel.parts.map((r) => r.text.replace(/\s+$/, "")).join("\n");
    this.sel = sel;
    this._drawSelection();
    this._placeSelBar();
    this.cb.onSelection?.(sel ? sel.text : "");
  }

  _drawSelection() {
    const d = this.doc;
    for (const i of this._selPages || []) { const s = d?.states.get(i); if (s) s.svgSel.textContent = ""; }
    this._selPages = new Set();
    if (!this.sel || !d) return;
    for (const part of this.sel.parts) {
      const s = this._state(part.page);
      svgEl("path", { d: part.quads.map((q) => "M" + quadPoly(q).map((p) => p.join(" ")).join("L") + "Z").join("") }, s.svgSel);
      this._selPages.add(part.page);
    }
  }

  _placeSelBar() {
    const b = this.selBar, sel = this.sel;
    if (!sel || !sel.parts.length || this.zt || this.action?.kind === "select") { b.hidden = true; return; }
    const last = sel.parts[sel.parts.length - 1], q = last.quads[last.quads.length - 1];
    const first = sel.parts[0], q0 = first.quads[0];
    const [x1, y1] = this._screenOf(last.page, [Math.max(q[4], q[6]), Math.max(q[5], q[7])]);
    const [, y0] = this._screenOf(first.page, [q0[0], Math.min(q0[1], q0[3])]);
    if (y1 < 0 || y0 > this.vh) { b.hidden = true; return; }
    b.hidden = false;
    const w = b.offsetWidth, h = b.offsetHeight;
    let top = y1 + 10;
    if (top + h > this.vh - 8) top = y0 - h - 10;
    top = clamp(top, 8, this.vh - h - 8);
    b.style.transform = `translate(${Math.round(clamp(x1 - w / 2, 8, this.vw - w - 8))}px,${Math.round(top)}px)`;
  }

  get hasSelection() { return !!this.sel; }

  clearSelection() {
    if (!this.sel && !this._selPages?.size) return;
    this.sel = null;
    this._drawSelection();
    this.selBar.hidden = true;
    this.cb.onSelection?.("");
  }

  selectAllOnPage(i = this.currentPage()) {
    if (!this.doc) return;
    const p = this.doc.pages[i];
    const a = { anchor: { page: i, p: [p.x0, p.y0] }, focus: { page: i, p: [p.x1, p.y1] }, mode: "chars", ended: true, seq: 0 };
    this._querySelection(a);
  }

  // Turn the selection into highlight annotations (one undo step).
  highlightSelection() {
    if (!this.sel || !this.doc) return;
    const ops = [];
    for (const part of this.sel.parts) {
      const d = { type: "Highlight", color: this.styles.highlight.color.slice(), opacity: 1, quads: part.quads.map((q) => q.map(round2)) };
      this._insertAnnot(part.page, d);
      ops.push({ op: "add", page: part.page, data: d });
    }
    this.clearSelection();
    if (ops.length) this._pushHistory(ops);
  }

  // ------------------------------------------------------------ measuring
  // Distance: drag, or click two points. Path/area: click (or tap) each
  // point; double-click, Enter or "Done" finishes, clicking the first point
  // closes an area. Shift snaps to 45°. Middle-drag / finger-drag still pan.
  _screenDist(i, p, q) {
    return Math.hypot(p[0] - q[0], p[1] - q[1]) * this.scale;
  }

  _constrainPt(d, p, shift, idx = d.pts.length) {
    const prev = d.pts[idx - 1];
    if (!shift || !prev) return p;
    const dx = p[0] - prev[0], dy = p[1] - prev[1], step = Math.PI / 4;
    const ang = Math.round(Math.atan2(dy, dx) / step) * step;
    const len = dx * Math.cos(ang) + dy * Math.sin(ang); // project onto the snapped direction
    return this._clampToPage(d.page, [prev[0] + len * Math.cos(ang), prev[1] + len * Math.sin(ang)]);
  }

  _measureDown(e, ptr, touch) {
    const t = now();
    let d = this.mdraft;
    const i = d ? d.page : this._pageForPointer(e);
    if (i < 0) return false;
    if (!d) d = this.mdraft = { page: i, mode: this._calibrating ? "calibrate" : this.measureMode, pts: [], hover: null };
    const p = this._constrainPt(d, this._clampToPage(i, this._clientToPage(i, e.clientX, e.clientY)), e.shiftKey);
    const a = (this.action = { kind: "measure", pid: ptr.id, touch, t0: t, x0: e.clientX, y0: e.clientY, moved: false, idx: -1, finish: false });
    const lc = this._mClick;
    this._mClick = { t, x: e.clientX, y: e.clientY };
    if (d.mode === "path" || d.mode === "area") {
      const need = d.mode === "area" ? 3 : 2;
      if (d.mode === "area" && d.pts.length >= 3 && this._screenDist(i, p, d.pts[0]) < (touch ? 24 : 12)) { a.finish = true; return true; }
      if (lc && t - lc.t < 400 && Math.hypot(e.clientX - lc.x, e.clientY - lc.y) < (touch ? 24 : 10) && d.pts.length >= need) { a.finish = true; return true; }
    }
    d.pts.push(p);
    a.idx = d.pts.length - 1;
    d.hover = null;
    this._drawDraft();
    return true;
  }

  _measureMove(a, e) {
    const d = this.mdraft;
    if (!d || a.idx < 0) return;
    if (!a.moved && Math.hypot(e.clientX - a.x0, e.clientY - a.y0) > 6) a.moved = true;
    if (!a.moved) return;
    const p = this._clampToPage(d.page, this._clientToPage(d.page, e.clientX, e.clientY));
    // Distance: press, drag and release draws the whole line.
    if ((d.mode === "distance" || d.mode === "calibrate") && d.pts.length === 1 && a.idx === 0) { d.pts.push(p); a.idx = 1; }
    d.pts[a.idx] = this._constrainPt(d, p, e.shiftKey, a.idx);
    this._drawDraft();
  }

  _measureUp(a, cancel) {
    const d = this.mdraft;
    if (!d || cancel) return;
    if (a.finish) { this.finishMeasure(); return; }
    if ((d.mode === "distance" || d.mode === "calibrate") && d.pts.length >= 2) {
      // Second point on top of the first: wait for a real second point.
      if (this._screenDist(d.page, d.pts[0], d.pts[1]) < 6) { d.pts.length = 1; this._drawDraft(); return; }
      this.finishMeasure();
    }
  }

  _measureTap(ptr) {
    const fake = { clientX: ptr.x, clientY: ptr.y, shiftKey: false };
    if (!this._measureDown(fake, ptr, true)) return false;
    const a = this.action;
    this.action = null;
    this._measureUp(a, false);
    return true;
  }

  _drawDraft() {
    if (this._draftRaf) return;
    this._draftRaf = requestAnimationFrame(() => {
      this._draftRaf = 0;
      const d = this.mdraft;
      for (const s of this.doc ? this.doc.states.values() : []) if (s.prevMeas.firstChild && (!d || s.i !== d.page)) s.prevMeas.textContent = "";
      if (d && this.doc) {
        const s = this._state(d.page);
        s.prevMeas.textContent = "";
        const pts = d.hover ? d.pts.concat([d.hover]) : d.pts;
        const type = MODE_TYPES[d.mode];
        const hint = d.mode === "area" && d.hover && d.pts.length >= 3 && this._screenDist(d.page, d.hover, d.pts[0]) < 12;
        s.prevMeas.appendChild(this._measureGroup(type, pts, cssColor(this.measureStyle.color), this._draftLabel(d, pts), true, hint));
      }
      this._measureChanged();
    });
  }

  _draftLabel(d, pts) {
    const type = MODE_TYPES[d.mode];
    if (pts.length < (type === "Polygon" ? 3 : 2)) return null;
    return measureText(type, pts, this.cb.scaleFor?.(d.page) || DEFAULT_SCALE, this.measureStyle.dp);
  }

  // Live state for the measuring bar.
  measureStatus() {
    const d = this.mdraft;
    const mode = d ? d.mode : this._calibrating ? "calibrate" : this.measureMode;
    const st = { mode, drafting: !!d, points: d ? d.pts.length : 0, value: "", canFinish: false, page: d ? d.page : this.currentPage() };
    if (d) {
      const pts = d.hover ? d.pts.concat([d.hover]) : d.pts;
      const lbl = this._draftLabel(d, pts);
      if (lbl) st.value = lbl.main + (lbl.sub ? " · " + lbl.sub : "");
      st.canFinish = d.pts.length >= (d.mode === "area" ? 3 : 2);
    }
    return st;
  }

  _measureChanged() {
    this.cb.onMeasure?.(this.measureStatus());
  }

  setMeasureMode(mode) {
    this.cancelMeasure();
    this.measureMode = mode;
    this._measureChanged();
  }

  setMeasureStyle(style) {
    Object.assign(this.measureStyle, style);
    if (this.mdraft) this._drawDraft();
    else this._measureChanged();
  }

  // Next line drawn sets the scale (see cb.onCalibrate).
  startCalibrate() {
    this.cancelMeasure();
    this._calibrating = true;
    this._measureChanged();
  }

  cancelMeasure() {
    this.mdraft = null;
    this._calibrating = false;
    this._mClick = null;
    this._drawDraft();
  }

  // Remove the last point placed (Backspace).
  measureBack() {
    const d = this.mdraft;
    if (!d) return;
    d.pts.pop();
    if (!d.pts.length) { this.cancelMeasure(); return; }
    this._drawDraft();
  }

  finishMeasure() {
    const d = this.mdraft;
    if (!d) return false;
    this.mdraft = null;
    this._mClick = null;
    const type = MODE_TYPES[d.mode];
    let pts = d.pts.map((p) => p.map(round2));
    if (type === "Line") pts = pts.slice(0, 2);
    const ok = pts.length >= (type === "Polygon" ? 3 : 2) && pathLength(pts) * this.scale >= 3;
    if (d.mode === "calibrate") {
      this._calibrating = false;
      this._drawDraft();
      if (ok) this.cb.onCalibrate?.(d.page, pathLength(pts));
      return ok;
    }
    if (ok) {
      const sc = this.cb.scaleFor?.(d.page) || DEFAULT_SCALE;
      const dp = this.measureStyle.dp;
      const scale = { mPerPt: sc.mPerPt, unit: sc.unit, label: sc.label };
      this._commitAdd(d.page, { type, measure: true, pts, color: this.measureStyle.color.slice(), opacity: 1, width: 1, scale, dp, contents: measureText(type, pts, scale, dp).contents });
    }
    this._drawDraft();
    return ok;
  }

  _measureLabel(d) {
    if (d.scale) return measureText(d.type, d.pts, d.scale, d.dp);
    const lines = (d.contents || "").split(/\r?\n/);
    return { main: lines[0].replace(/^(Area|Length)\s+/i, ""), sub: lines[1] || "" };
  }

  // SVG (page coordinates) for one measurement. Labels, ticks and handles
  // are scaled by --ms so they stay the same size on screen.
  _measureGroup(type, pts, color, label, draft, closeHint = false) {
    const g = svgEl("g", { class: "measure" + (draft ? " draft" : "") });
    g.style.setProperty("--mc", color);
    const P = (p) => p[0] + " " + p[1];
    const closed = type === "Polygon" && pts.length >= 3;
    if (pts.length >= 2) svgEl("path", { class: closed ? "m-area" : "m-line", d: "M" + pts.map(P).join("L") + (closed ? "Z" : "") }, g);
    if (type === "Line" && pts.length >= 2) {
      const [a, b] = pts;
      const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      for (const p of [a, b]) svgEl("line", { class: "m-tick", x1: 0, y1: -7, x2: 0, y2: 7 }, svgEl("g", { transform: `translate(${P(p)}) rotate(${ang})` }, g));
    } else {
      pts.forEach((p, k) => svgEl("circle", { class: "m-dot" + (k === 0 && closeHint ? " snap" : ""), cx: p[0], cy: p[1] }, g));
    }
    if (label && label.main) {
      let at, ang = 0;
      if (closed) at = polyCentroid(pts);
      else {
        let k = 1, best = -1;
        for (let j = 1; j < pts.length; j++) {
          const l = Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]);
          if (l > best) { best = l; k = j; }
        }
        const a = pts[k - 1], b = pts[k];
        at = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
        if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
      }
      const lg = svgEl("g", { class: "m-lbl" }, svgEl("g", { transform: `translate(${P(at)}) rotate(${ang})` }, g));
      const t = svgEl("text", { x: 0, y: closed ? (label.sub ? -3 : 5) : -8, "text-anchor": "middle" }, lg);
      t.textContent = label.main;
      if (closed && label.sub) {
        const t2 = svgEl("text", { class: "sub", x: 0, y: 13, "text-anchor": "middle" }, lg);
        t2.textContent = label.sub;
      }
    }
    return g;
  }

  // Pages whose annotations have been loaded this session.
  loadedPages() {
    return this.doc ? [...this.doc.annotsP.keys()] : [];
  }

  // Measurements on the given pages (loading their annotations if needed).
  async measurementsOn(pages) {
    const d = this.doc;
    if (!d) return [];
    await Promise.all(pages.map((i) => this._loadAnnots(i)));
    if (this.doc !== d) return [];
    const out = [];
    for (const i of pages) for (const a of d.annots.get(i) || []) if (a.measure && a.scale) out.push([i, a]);
    return out;
  }

  // Re-label measurements with each page's current scale (one undo step).
  rescaleMeasurements(list, scaleFor) {
    const ops = [];
    for (const [i, d] of list) {
      const sc = scaleFor(i);
      if (!sc || sameScale(d.scale, sc)) continue;
      const scale = { mPerPt: sc.mPerPt, unit: sc.unit, label: sc.label };
      const nd = { ...this._payload(d), scale, contents: measureText(d.type, d.pts, scale, d.dp).contents };
      ops.push({ op: "del", page: i, data: d }, { op: "add", page: i, data: nd });
    }
    if (!ops.length) return 0;
    this._apply(ops, false);
    this._pushHistory(ops);
    return ops.length / 2;
  }

  // ------------------------------------------------------------ annotations
  _loadAnnots(i) {
    const d = this.doc;
    let pr = d.annotsP.get(i);
    if (pr) return pr;
    pr = this.engine.pageAnnots(i).then((list) => {
      if (this.doc !== d || !list) return;
      const local = d.annots.get(i) || [];
      d.annots.set(i, list.concat(local));
      for (const a of list) this._drawAnnot(i, a);
      this._refreshErased(i);
    }).catch((err) => console.warn("annots", err));
    d.annotsP.set(i, pr);
    return pr;
  }

  _drawAnnot(i, d) {
    const s = this._state(i);
    let node;
    if (d.shape && (d.shape.k === "redact" || d.shape.k === "retext")) {
      node = this._shapeNode(d);
      s.svgErase.appendChild(node);
    } else if (d.shape) {
      node = this._shapeNode(d);
      s.svgInk.insertBefore(node, s.prevInk);
    } else if (d.type === "Ink" && inkWidths(d)) {
      node = svgEl("path", { d: polyPath(strokeOutline(d.ink[0], d.widths)), fill: cssColor(d.color) });
      if (d.opacity < 1) node.setAttribute("opacity", d.opacity);
      s.svgInk.insertBefore(node, s.prevInk);
    } else if (d.type === "Ink") {
      const path = d.ink.map((st) => "M" + st.map((p) => p[0] + " " + p[1]).join("L")).join("");
      node = svgEl("path", { d: path, fill: "none", stroke: cssColor(d.color), "stroke-width": d.width || 1, "stroke-linecap": "round", "stroke-linejoin": "round" });
      if (d.opacity < 1) node.setAttribute("opacity", d.opacity);
      s.svgInk.insertBefore(node, s.prevInk);
    } else if (d.type === "Square") {
      const w = d.width || 1, h = w / 2;
      node = svgEl("rect", { x: d.rect[0] + h, y: d.rect[1] + h, width: Math.max(0, d.rect[2] - d.rect[0] - w), height: Math.max(0, d.rect[3] - d.rect[1] - w), fill: d.fill && d.fill.length ? cssColor(d.fill) : "none", stroke: cssColor(d.color), "stroke-width": w });
      if (d.opacity < 1) node.setAttribute("opacity", d.opacity);
      s.svgInk.insertBefore(node, s.prevInk);
    } else if (d.type === "Highlight") {
      node = svgEl("path", { d: d.quads.map((q) => "M" + quadPoly(q).map((p) => p.join(" ")).join("L") + "Z").join(""), fill: cssColor(d.color) });
      if (d.opacity < 1) node.setAttribute("fill-opacity", d.opacity);
      s.svgHl.insertBefore(node, s.prevHl);
    } else if (d.measure) {
      node = this._measureGroup(d.type, d.pts, cssColor(d.color), this._measureLabel(d), false);
      s.svgMeas.insertBefore(node, s.prevMeas);
    }
    if (node) this._nodes.set(d, node);
    if (node && this._erased.has(d)) node.classList.add("erased");
  }

  // Shapes are drawn from MuPDF's SVG of their saved appearance. Until that
  // arrives (a few ms after creating one) a close approximation stands in.
  _shapeNode(d) {
    const k = d.shape.k;
    if (k === "retext") {
      const g = svgEl("g", { class: "shape retext" });
      if (d.svg) { g.innerHTML = d.svg; return g; }
      // Until MuPDF's drawing arrives: white-out and the text in a close font.
      const e = d.erase;
      svgEl("rect", { x: e[0], y: e[1], width: e[2] - e[0], height: e[3] - e[1], fill: "#fff" }, g);
      const css = faceCss(d.face);
      d.text.split("\n").forEach((line, j) => {
        const t = svgEl("text", { x: d.origin[0], y: d.origin[1] + j * d.size * 1.2, "font-size": d.size, fill: cssColor(d.color), "font-family": css.family, "font-weight": css.weight, "font-style": css.style }, g);
        t.textContent = line;
      });
      return g;
    }
    if (k === "redact") {
      const [x0, y0, x1, y1] = d.rect;
      const g = svgEl("g", { class: "shape redact" });
      svgEl("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, class: "rd-fill" }, g);
      svgEl("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, class: "rd-line" }, g);
      return g;
    }
    if (isPic(k) && (d.href || d.png)) {
      if (!d.href) d.href = URL.createObjectURL(new Blob([d.png], { type: "image/png" }));
      const [x0, y0, x1, y1] = d.rect;
      return svgEl("image", { class: "shape", href: d.href, x: x0, y: y0, width: x1 - x0, height: y1 - y0, preserveAspectRatio: "none" });
    }
    const g = svgEl("g", { class: "shape" });
    if (d.svg) { g.innerHTML = d.svg; return g; }
    const col = cssColor(d.color), w = d.width || 1;
    const stroke = { fill: "none", stroke: col, "stroke-width": w, "stroke-linecap": "round", "stroke-linejoin": "round" };
    if (k === "line" || k === "arrow") {
      const [a, b] = d.pts;
      svgEl("path", { ...stroke, d: `M${a[0]} ${a[1]}L${b[0]} ${b[1]}` + (k === "arrow" ? this._arrowHead(a, b, w) : "") }, g);
    } else if (k === "cloud") {
      const [x0, y0, x1, y1] = d.rect;
      svgEl("rect", { ...stroke, class: "cloud-prev", x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, g);
    } else if (k === "text" || k === "callout") {
      const [x0, y0, x1, y1] = d.rect, bw = d.width || 0;
      if (d.callout) {
        const lw = Math.max(bw, 1);
        svgEl("path", { ...stroke, "stroke-width": lw, d: "M" + d.callout.map((p) => p.join(" ")).join("L") + this._arrowHead(d.callout[1], d.callout[0], lw) }, g);
      }
      if (bw || (d.fill && d.fill.length)) svgEl("rect", { x: x0 + bw / 2, y: y0 + bw / 2, width: x1 - x0 - bw, height: y1 - y0 - bw, fill: d.fill && d.fill.length ? cssColor(d.fill) : "none", stroke: bw ? col : "none", "stroke-width": bw }, g);
      const t = svgEl("text", { x: x0 + bw / 2 + 2, y: y0 + bw + d.size, fill: col, "font-size": d.size, "font-family": "Helvetica, Arial, sans-serif" }, g);
      d.text.split("\n").forEach((line, j) => {
        const sp = svgEl("tspan", { x: x0 + bw / 2 + 2, y: y0 + bw + d.size * (0.95 + j * 1.2) }, t);
        sp.textContent = line;
      });
    }
    return g;
  }

  // MuPDF's drawing of a just-created shape has arrived: swap it in.
  _annotReady(d) {
    if (!d.shape || !d.svg || (isPic(d.shape.k) && d.href) || d.shape.k === "redact") return;
    const old = this._nodes.get(d);
    if (!old || !old.parentNode) return;
    const n = this._shapeNode(d);
    if (old.getAttribute("visibility")) n.setAttribute("visibility", old.getAttribute("visibility"));
    old.replaceWith(n);
    this._nodes.set(d, n);
  }

  get _nodes() {
    return (this.__nodes ||= new WeakMap());
  }

  _payload(d) {
    if (d.shape) {
      const o = { type: d.type, shape: d.shape, color: d.color, opacity: d.opacity, width: d.width };
      for (const k of ["pts", "rect", "text", "size", "fill", "callout", "png", "font", "origin", "erase", "face"]) if (d[k] != null) o[k] = d[k];
      // Replacement text lines up with the old line once, when created (an
      // undo/redo later must not pull a moved box back).
      if (d.align) { o.align = d.align; delete d.align; }
      return o;
    }
    const o = { type: d.type, color: d.color, opacity: d.opacity, width: d.width };
    if (d.ink) o.ink = d.ink;
    if (inkWidths(d)) o.widths = d.widths;
    if (d.rect) o.rect = d.rect;
    if (d.fill) o.fill = d.fill;
    if (d.quads) o.quads = d.quads;
    if (d.measure) Object.assign(o, { measure: true, pts: d.pts, contents: d.contents, scale: d.scale, dp: d.dp });
    return o;
  }

  _insertAnnot(i, d) {
    const doc = this.doc;
    if (!doc.annots.has(i)) doc.annots.set(i, []);
    doc.annots.get(i).push(d);
    if (d.shape) d.svg = null; // redrawn from the new annotation's appearance
    this._drawAnnot(i, d);
    this._refreshErased(i);
    d.id = 0;
    this.engine.addAnnot(i, () => this._payload(d), d)
      .then(() => this._annotReady(d))
      .catch((err) => this.cb.onError?.("Couldn't add that annotation: " + err.message));
  }

  _removeAnnot(i, d) {
    if (this.shapeSel && this.shapeSel.d === d) this.deselectShape();
    const list = this.doc.annots.get(i);
    const k = list ? list.indexOf(d) : -1;
    if (k >= 0) list.splice(k, 1);
    this._nodes.get(d)?.remove();
    this._nodes.delete(d);
    this._refreshErased(i);
    // A signature loaded from the file: keep its image so undo can restore it.
    if (isPic(d.shape?.k) && !d.png) this.engine.annotImage(i, () => d.id).then((png) => { if (png) d.png = png; }).catch(() => {});
    this.engine.deleteAnnot(i, () => d.id);
  }

  _commitAdd(i, d) {
    this._insertAnnot(i, d);
    this._pushHistory([{ op: "add", page: i, data: d }]);
  }

  _pushHistory(ops) {
    const doc = this.doc;
    doc.undo.push({ seq: ++doc.seq, ops });
    doc.redo.length = 0;
    this._history();
    this.cb.onEdit?.();
  }

  // The pages changed (added, removed, moved...): unsaved until saved.
  markChanged() {
    if (!this.doc) return;
    this.doc.savedSeq = -1;
    this._history();
  }

  get canUndo() { return !!(this.doc && (this.doc.undo.length || this.editor || this.placing)); }
  get canRedo() { return !!(this.doc && this.doc.redo.length); }

  _apply(ops, inverse) {
    const list = inverse ? ops.slice().reverse() : ops;
    for (const o of list) {
      if (o.op === "upd") { this._applySnap(o.page, o.data, inverse ? o.before : o.after); continue; }
      const add = (o.op === "add") !== inverse;
      if (add) this._insertAnnot(o.page, o.data);
      else this._removeAnnot(o.page, o.data);
    }
  }

  undo() {
    const d = this.doc;
    if (this.editor) { this._closeEditor(false); return; }
    if (this.placing) { this.finishPlacing(false); return; }
    this.deselectShape();
    if (!d || this.action || !d.undo.length) return;
    const h = d.undo.pop();
    this._apply(h.ops, true);
    d.redo.push(h);
    this._history();
  }

  redo() {
    const d = this.doc;
    this.deselectShape();
    if (!d || this.action || !d.redo.length) return;
    const h = d.redo.pop();
    this._apply(h.ops, false);
    d.undo.push(h);
    this._history();
  }

  get dirty() {
    const d = this.doc;
    if (!d) return false;
    const top = d.undo.length ? d.undo[d.undo.length - 1].seq : 0;
    return top !== d.savedSeq;
  }

  // Call when a save that started at `seq` has completed.
  markSaved(seq) {
    if (!this.doc) return;
    this.doc.savedSeq = seq;
    this._history();
  }

  get historySeq() {
    const d = this.doc;
    return d && d.undo.length ? d.undo[d.undo.length - 1].seq : 0;
  }

  _history() {
    const d = this.doc;
    this.cb.onHistory?.(!!d && d.undo.length > 0, !!d && d.redo.length > 0, this.dirty);
  }
}
