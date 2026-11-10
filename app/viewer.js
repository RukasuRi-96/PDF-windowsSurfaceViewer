// Inkleaf viewer: continuous page layout, compositor-driven pan/zoom,
// tiled rendering, touch + pen gestures, and live vector annotations.

import { measureText, MODE_TYPES, DEFAULT_SCALE, pathLength, polyCentroid, sameScale } from "./measure.js";

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

// Tools a finger uses when "finger draws" is on (otherwise a finger pans).
const DRAW_TOOLS = new Set(["pen", "highlight", "box", "eraser", "select", "measure"]);
const round2 = (v) => Math.round(v * 100) / 100;

export class Viewer {
  constructor(root, engine, callbacks = {}) {
    this.root = root;
    this.engine = engine;
    this.cb = callbacks;
    root.classList.add("viewer");
    this.world = el("div", "world", root);
    this.live = el("canvas", "live", root);
    this.liveCtx = this.live.getContext("2d");
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
    this.scrollTo(this.sx, y);
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
    this._stopInertia();
    this.rect = this.root.getBoundingClientRect();
    try { this.root.setPointerCapture(e.pointerId); } catch {}
    const ptr = { id: e.pointerId, type, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: t, ignored: false };
    this.pointers.set(e.pointerId, ptr);

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
      if (this.touchDraws && DRAW_TOOLS.has(this.tool)) { if (this._startTool(e, ptr, true)) return; }
      this._startPan(ptr, true);
      return;
    }
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
      case "ink": this._moveInk(a, e); break;
      case "highlight": this._moveHighlight(a, e); break;
      case "box": this._moveBox(a, e); break;
      case "erase": this._moveErase(a, e); break;
      case "select": this._moveSelect(a, e); break;
      case "measure": this._measureMove(a, e); break;
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
    else return false;
    return true;
  }

  _screenOf(i, pt) {
    const p = this.doc.pages[i], L = this.L;
    return [L.left[i] + (pt[0] - p.x0) * this.scale - this.sx, L.top[i] + (pt[1] - p.y0) * this.scale - this.sy];
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
    const a = (this.action = { ...base, kind: "ink", pts: [p], color: st.color.slice(), width: st.width, opacity: 1 });
    const c = this.liveCtx;
    c.save();
    this._liveClipToPage(a.page);
    c.strokeStyle = cssColor(a.color);
    c.fillStyle = cssColor(a.color);
    c.lineWidth = Math.max(0.5, a.width * this.scale);
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
      if (Math.hypot(p[0] - lp[0], p[1] - lp[1]) * this.scale < 0.6) continue;
      a.pts.push(p);
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
    pts = simplify(smooth(pts), 0.18 / this.scale).map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
    this._commitAdd(a.page, { type: "Ink", color: a.color, opacity: a.opacity, width: a.width, ink: [pts] });
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

  // ---- box
  _startBox(base, p) {
    const st = this.styles.box;
    this.action = { ...base, kind: "box", start: p, end: p, color: st.color.slice(), width: st.width };
    this._drawBoxPreview(this.action);
  }

  _moveBox(a, e) {
    a.end = this._clampToPage(a.page, this._clientToPage(a.page, e.clientX, e.clientY));
    this._drawBoxPreview(a);
  }

  _boxRect(a) {
    const x0 = Math.min(a.start[0], a.end[0]), y0 = Math.min(a.start[1], a.end[1]);
    const x1 = Math.max(a.start[0], a.end[0]), y1 = Math.max(a.start[1], a.end[1]);
    return [x0, y0, x1, y1];
  }

  _drawBoxPreview(a) {
    const s = this._state(a.page);
    s.prevInk.textContent = "";
    const [x0, y0, x1, y1] = this._boxRect(a);
    svgEl("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: "none", stroke: cssColor(a.color), "stroke-width": a.width }, s.prevInk);
  }

  _finishBox(a, cancel) {
    const s = this._state(a.page);
    s.prevInk.textContent = "";
    if (cancel) return;
    const [x0, y0, x1, y1] = this._boxRect(a);
    if ((x1 - x0) * this.scale < 4 || (y1 - y0) * this.scale < 4) return;
    const h = a.width / 2;
    const r = [x0 - h, y0 - h, x1 + h, y1 + h].map((v) => Math.round(v * 100) / 100);
    this._commitAdd(a.page, { type: "Square", color: a.color, opacity: 1, width: a.width, rect: r, fill: [] });
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
    }).catch((err) => console.warn("annots", err));
    d.annotsP.set(i, pr);
    return pr;
  }

  _drawAnnot(i, d) {
    const s = this._state(i);
    let node;
    if (d.type === "Ink") {
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
  }

  get _nodes() {
    return (this.__nodes ||= new WeakMap());
  }

  _payload(d) {
    const o = { type: d.type, color: d.color, opacity: d.opacity, width: d.width };
    if (d.ink) o.ink = d.ink;
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
    this._drawAnnot(i, d);
    d.id = 0;
    this.engine.addAnnot(i, this._payload(d), d);
  }

  _removeAnnot(i, d) {
    const list = this.doc.annots.get(i);
    const k = list ? list.indexOf(d) : -1;
    if (k >= 0) list.splice(k, 1);
    this._nodes.get(d)?.remove();
    this._nodes.delete(d);
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
  }

  _apply(ops, inverse) {
    const list = inverse ? ops.slice().reverse() : ops;
    for (const o of list) {
      const add = (o.op === "add") !== inverse;
      if (add) this._insertAnnot(o.page, o.data);
      else this._removeAnnot(o.page, o.data);
    }
  }

  undo() {
    const d = this.doc;
    if (!d || this.action || !d.undo.length) return;
    const h = d.undo.pop();
    this._apply(h.ops, true);
    d.redo.push(h);
    this._history();
  }

  redo() {
    const d = this.doc;
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
