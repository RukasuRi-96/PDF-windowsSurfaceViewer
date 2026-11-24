// Pages panel: a thumbnail of every page, to select, delete, add, copy in,
// duplicate, rotate and drag pages into a new order (mouse and pen drag; a
// finger drags a page by its grip, or presses and holds it to lift it). Pages
// dropped on another open PDF are copied there. The page being read is
// highlighted; pages show their number, their name (the PDF's page label or
// bookmark), or both. With PDFs side by side, the panel shows the one in use;
// each one's thumbnails are kept, so switching between them is instant.
//
// The thumbnails can be made bigger or smaller (the slider, pinching, or
// Ctrl+wheel) and the panel wider or narrower (its edge, see main.js); when
// they're small or the panel is wide, pages sit in a grid of several columns.
//
// Speed: only the thumbnails in (or near) view exist; they are rendered at
// thumbnail size by the render workers only after the page view's own tiles,
// straight from the page (nothing cached that the page view needs). Making
// them smaller reuses what's drawn; bigger draws them again, sharper.
import { icon } from "./icons.js";

export const THUMB_MIN = 64, THUMB_MAX = 320, THUMB_DEFAULT = 132;
const LABEL_H = 22;
const GAP = 12;        // between rows
const GAP_X = 10;      // between columns
const PAD_X = 6;
const PAD_TOP = 10;
const clampW = (w) => Math.round(Math.max(THUMB_MIN, Math.min(THUMB_MAX, w)));
let GEN = 0;           // thumbnail generations, unique across documents

export class PagesPanel {
  constructor(root, engine, cb) {
    this.root = root;
    this.engine = engine;
    this.cb = cb;
    this.pages = [];
    this.sel = new Set();
    this.anchor = 0;
    this.current = 0;
    this.cache = new Map();   // page -> canvas
    this.items = new Map();   // page -> element
    this.gen = ++GEN;
    this.key = null;          // which document (side-by-side PDFs share the panel)
    this.saved = new Map();   // key -> that document's panel state
    this.labelMode = "both"; // number | name | both
    this.thumbW = THUMB_DEFAULT; // thumbnail width (CSS px)
    this.cols = 1;
    root.tabIndex = -1;
    root.innerHTML = `
      <div class="pp-head">
        <span class="pp-title">Pages <span class="pp-count"></span></span>
        <button class="btn icon-btn" data-act="labels" title="Show page numbers, names or both">${icon("tag")}</button>
        <button class="btn icon-btn" data-act="add" title="Add pages">${icon("filePlus")}</button>
        <button class="btn icon-btn" data-act="delete" title="Delete the selected pages (Delete)">${icon("trash")}</button>
      </div>
      <div class="pp-size" title="Page size (or pinch the pages, or Ctrl+wheel)">
        <button class="btn icon-btn" data-act="smaller" title="Smaller pages">${icon("zoomOut")}</button>
        <input type="range" min="${THUMB_MIN}" max="${THUMB_MAX}" step="4" aria-label="Page size">
        <button class="btn icon-btn" data-act="bigger" title="Bigger pages">${icon("zoomIn")}</button>
      </div>
      <div class="pp-list"><div class="pp-inner"></div><div class="pp-drop" hidden></div></div>`;
    this.list = root.querySelector(".pp-list");
    this.inner = root.querySelector(".pp-inner");
    this.dropEl = root.querySelector(".pp-drop");
    this.countEl = root.querySelector(".pp-count");
    // Page size: the slider and its buttons.
    this.slider = root.querySelector(".pp-size input");
    this.slider.value = this.thumbW;
    this.slider.addEventListener("input", () => this.setThumbSize(+this.slider.value));
    this.slider.addEventListener("change", () => cb.onThumbSize?.(this.thumbW));
    root.querySelector(".pp-size").addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      this.setThumbSize(this.thumbW * (b.dataset.act === "bigger" ? 1.25 : 0.8));
      cb.onThumbSize?.(this.thumbW);
    });
    root.querySelector(".pp-head").addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      if (b.dataset.act === "add") cb.onAddMenu?.(b, this.insertAt());
      else if (b.dataset.act === "labels") cb.onLabelsMenu?.(b);
      else if (b.dataset.act === "delete") cb.onDelete?.(this.selected());
      else if (b.dataset.act === "close") cb.onClose?.();
    });
    this.list.addEventListener("scroll", () => this._schedule());
    // A wider or narrower panel: the columns change.
    new ResizeObserver(() => { if (this.open && this.list.clientWidth !== this.layoutW) this._relayout(); else this._schedule(); }).observe(this.list);
    this.list.addEventListener("pointerdown", (e) => this._down(e));
    // Two fingers pinch the pages bigger or smaller.
    const span = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    this.list.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2 && !this.drag) { this._pinch = { d0: Math.max(20, span(e.touches)), w0: this.thumbW }; this._multi = true; clearTimeout(this._holdTimer); }
    }, { passive: true });
    // While a finger holds a page to move it, the list must not scroll.
    this.list.addEventListener("touchmove", (e) => {
      if (this._pinch && e.touches.length === 2) {
        e.preventDefault();
        this._pinchW = this._pinch.w0 * (span(e.touches) / this._pinch.d0);
        if (!this._pinchRaf) this._pinchRaf = requestAnimationFrame(() => { this._pinchRaf = 0; this.setThumbSize(this._pinchW); });
        return;
      }
      if (this.drag || this._hold) e.preventDefault();
    }, { passive: false });
    const pinchEnd = (e) => {
      if (e.touches.length === 0) this._multi = false;
      if (this._pinch && e.touches.length < 2) { this._pinch = null; cb.onThumbSize?.(this.thumbW); }
    };
    this.list.addEventListener("touchend", pinchEnd);
    this.list.addEventListener("touchcancel", pinchEnd);
    // Ctrl+wheel: the same with a mouse or touchpad.
    this.list.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.setThumbSize(this.thumbW * Math.exp(-e.deltaY * 0.0025));
      clearTimeout(this._wheelSave);
      this._wheelSave = setTimeout(() => cb.onThumbSize?.(this.thumbW), 300);
    }, { passive: false });
    this.list.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (performance.now() - (this._touchAt || -1e9) < 1500) return; // touch: handled by press and hold
      const i = this._indexAt(e);
      if (i < 0) return;
      if (!this.sel.has(i)) this._select(i, {});
      cb.onMenu?.(i, e.clientX, e.clientY);
    });
    root.addEventListener("keydown", (e) => this._key(e));
    this._listen(engine);
  }

  _listen(engine) {
    engine.onThumb = (task, bmp) => { if (this.engine === engine) this._onThumb(task, bmp); else bmp.close(); };
  }

  // Show another open document (`key`) in the panel. Its thumbnails, selection
  // and scroll position come back as they were if its pages haven't changed.
  switchTo(engine, key, pages, current) {
    if (key === this.key && engine === this.engine) return;
    this.engine.setThumbQueue([]);
    if (this.key != null) this.saved.set(this.key, { pages: this.pages, cache: this.cache, sel: this.sel, anchor: this.anchor, gen: this.gen, scroll: this.list.scrollTop });
    this.engine = engine;
    this.key = key;
    this._listen(engine);
    const st = this.saved.get(key);
    this.saved.delete(key);
    if (st && st.pages === pages) {
      this.gen = st.gen;
      this.cache = st.cache;
      this.inner.textContent = "";
      this.items.clear();
      this.pages = pages;
      this.sel = st.sel;
      this.anchor = st.anchor;
      this.current = Math.min(current, Math.max(0, pages.length - 1));
      this.countEl.textContent = pages.length ? `(${pages.length})` : "";
      this.hasNames = pages.some((p) => p.name);
      this._layout();
      this.list.scrollTop = st.scroll;
      if (this.open) { this._render(); this.reveal(this.current); }
    } else {
      if (st) for (const cv of st.cache.values()) cv.width = 0;
      this.cache = new Map();
      this.setDocument(pages, current);
    }
  }

  // A document closed: drop what was kept for it.
  forget(key) {
    const st = this.saved.get(key);
    if (st) for (const cv of st.cache.values()) cv.width = 0;
    this.saved.delete(key);
  }

  get open() { return !this.root.hidden; }

  // Thumbnail width in CSS px (64-320); the page in view stays in view.
  setThumbSize(w) {
    w = clampW(w);
    this.slider.value = w;
    if (w === this.thumbW) return;
    this.thumbW = w;
    this._relayout();
  }

  // Lay out again (new size or width), keeping the page at the top in view.
  _relayout() {
    let anchor = -1, off = 0;
    if (this.tops && this.pages.length) {
      const st = this.list.scrollTop;
      anchor = 0;
      while (anchor < this.pages.length - 1 && this.tops[anchor] + this.heights[anchor] <= st) anchor++;
      off = this.tops[anchor] - st;
    }
    this.inner.textContent = "";
    this.items.clear();
    this._layout();
    if (anchor >= 0 && anchor < this.pages.length) this.list.scrollTop = Math.max(0, this.tops[anchor] - off);
    if (this.open) this._render();
  }

  show(on) {
    this.root.hidden = !on;
    if (on) { this._layout(); this._render(); this.reveal(this.current); }
    else this.engine.setThumbQueue([]);
  }

  // A (re)opened document, or its pages changed.
  setDocument(pages, current = 0, select = null) {
    this.gen = ++GEN;
    for (const cv of this.cache.values()) cv.width = 0;
    this.cache.clear();
    this.inner.textContent = "";
    this.items.clear();
    this.pages = pages || [];
    this.current = Math.min(current, Math.max(0, this.pages.length - 1));
    this.sel = new Set((select || [this.current]).filter((i) => i >= 0 && i < this.pages.length));
    this.anchor = this.current;
    this.countEl.textContent = this.pages.length ? `(${this.pages.length})` : "";
    this.hasNames = this.pages.some((p) => p.name);
    this._layout();
    if (this.open) { this._render(); this.reveal(this.current, true); }
  }

  clear() { this.setDocument([], 0); }

  // The page view moved to page i: highlight it (a single selection follows
  // along; several selected pages stay selected).
  setCurrent(i) {
    if (i === this.current) return;
    const old = this.items.get(this.current);
    old?.classList.remove("current");
    this.current = i;
    this.items.get(i)?.classList.add("current");
    if (this.sel.size <= 1 && !this.drag) { this.sel = new Set([i]); this.anchor = i; this._paintSel(); }
    if (this.open && !this.drag) this.reveal(i);
  }

  // "3", "A-101" or "3 · A-101".
  labelOf(i) {
    const name = this.pages[i]?.name || "";
    if (!name || this.labelMode === "number") return String(i + 1);
    return this.labelMode === "name" ? name : `${i + 1} · ${name}`;
  }

  setLabelMode(mode) {
    this.labelMode = mode;
    for (const [i, el] of this.items) { const l = el.querySelector(".pp-num"); l.textContent = this.labelOf(i); l.title = this._fullLabel(i); }
  }

  _fullLabel(i) { const n = this.pages[i]?.name; return n ? `Page ${i + 1}: ${n}` : `Page ${i + 1}`; }

  selected() { return [...this.sel].sort((a, b) => a - b); }

  // Where new pages go: after the last selected page (or the current one).
  insertAt() {
    const s = this.selected();
    return (s.length ? s[s.length - 1] : this.current) + 1;
  }

  selectAll() {
    this.sel = new Set(this.pages.map((_, i) => i));
    this._paintSel();
  }

  reveal(i, center = false) {
    if (!this.tops || i < 0 || i >= this.pages.length) return;
    const top = this.tops[i], h = this.heights[i], st = this.list.scrollTop, vh = this.list.clientHeight;
    if (center || top < st || top + h > st + vh) this.list.scrollTop = Math.max(0, top - (vh - h) / 2);
    this._schedule();
  }

  // ---- layout and painting (only what's in view)
  // Rows of `cols` pages (one column unless they're small or the panel is
  // wide); each row is as tall as its tallest page.
  _layout() {
    const n = this.pages.length, tw = this.thumbW;
    const W = this.list.clientWidth || 216;
    this.layoutW = this.list.clientWidth;
    const cols = Math.max(1, Math.floor((W - 2 * PAD_X + GAP_X) / (tw + GAP_X)));
    const cellW = cols === 1 ? W - 2 * PAD_X : (W - 2 * PAD_X - (cols - 1) * GAP_X) / cols;
    this.cols = cols;
    this.cellW = cellW;
    this.root.style.setProperty("--thumb-w", tw + "px");
    this.root.classList.toggle("grid", cols > 1);
    this.tops = new Float64Array(n);
    this.lefts = new Float64Array(n);
    this.heights = new Float64Array(n);
    this.thumbH = new Float64Array(n);
    let y = PAD_TOP;
    for (let r = 0; r * cols < n; r++) {
      let rowH = 0;
      const a = r * cols, b = Math.min(n, a + cols);
      for (let i = a; i < b; i++) {
        const p = this.pages[i], w = p.x1 - p.x0, h = p.y1 - p.y0;
        this.thumbH[i] = Math.round(Math.min(tw * 2, Math.max(tw * 0.3, (tw * h) / Math.max(1, w))));
        rowH = Math.max(rowH, this.thumbH[i] + LABEL_H);
      }
      for (let i = a; i < b; i++) {
        this.tops[i] = y;
        this.lefts[i] = PAD_X + (i - a) * (cellW + GAP_X);
        this.heights[i] = rowH;
      }
      y += rowH + GAP;
    }
    this.inner.style.height = y + "px";
  }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  _range() {
    const st = this.list.scrollTop, vh = this.list.clientHeight || 600, n = this.pages.length;
    let a = 0, b = n;
    while (a < n && this.tops[a] + this.heights[a] < st - vh * 0.5) a++;
    b = a;
    while (b < n && this.tops[b] < st + vh * 1.5) b++;
    return [a, b];
  }

  _render() {
    if (!this.open || !this.pages.length) { this.engine.setThumbQueue([]); return; }
    const [a, b] = this._range();
    for (const [i, el] of this.items) if (i < a || i >= b) { el.remove(); this.items.delete(i); }
    for (let i = a; i < b; i++) if (!this.items.has(i)) this._item(i);
    // Thumbnails still to render, nearest to the middle of the list first.
    const mid = this.list.scrollTop + this.list.clientHeight / 2;
    const dpr = window.devicePixelRatio || 1;
    const tasks = [];
    const want = this.thumbW * dpr;
    for (let i = a; i < b; i++) {
      // Drawn already, big enough (a bigger one just shows smaller).
      const cv = this.cache.get(i);
      if (cv && cv.width >= want * 0.85) continue;
      const p = this.pages[i], res = want / Math.max(1, p.x1 - p.x0);
      tasks.push({
        key: `t${this.gen}:${i}:${Math.round(want)}`, thumb: true, gen: this.gen, page: i, res,
        bbox: [Math.floor(p.x0 * res), Math.floor(p.y0 * res), Math.ceil(p.x1 * res), Math.ceil(p.y1 * res)],
        d: Math.abs(this.tops[i] + this.heights[i] / 2 - mid),
      });
    }
    tasks.sort((x, y) => x.d - y.d);
    this.engine.setThumbQueue(tasks);
  }

  _item(i) {
    const el = document.createElement("div");
    el.className = "pp-item" + (this.sel.has(i) ? " sel" : "") + (i === this.current ? " current" : "");
    el.dataset.i = i;
    el.style.top = this.tops[i] + "px";
    el.style.left = this.lefts[i] + "px";
    el.style.width = this.cellW + "px";
    el.style.height = this.heights[i] + "px";
    const box = document.createElement("div");
    box.className = "pp-thumb";
    box.style.height = this.thumbH[i] + "px";
    const cv = this.cache.get(i);
    if (cv) box.appendChild(cv);
    const grip = document.createElement("span");
    grip.className = "pp-grip";
    grip.title = "Drag to move";
    grip.innerHTML = icon("grip");
    box.appendChild(grip);
    const label = document.createElement("div");
    label.className = "pp-num";
    label.textContent = this.labelOf(i);
    label.title = this._fullLabel(i);
    el.append(box, label);
    this.inner.appendChild(el);
    this.items.set(i, el);
    return el;
  }

  _onThumb(task, bmp) {
    if (task.gen !== this.gen || task.page >= this.pages.length) { bmp.close(); return; }
    // A smaller one arriving after a bigger one: keep the bigger.
    const had = this.cache.get(task.page);
    if (had && had.width >= bmp.width) { bmp.close(); return; }
    if (had) had.width = 0;
    const cv = document.createElement("canvas");
    cv.width = bmp.width;
    cv.height = bmp.height;
    cv.getContext("bitmaprenderer").transferFromImageBitmap(bmp);
    this.cache.set(task.page, cv);
    // Keep memory bounded on long documents: forget thumbnails far away.
    if (this.cache.size > 400) {
      const [a, b] = this._range();
      for (const k of this.cache.keys()) if (k < a - 100 || k > b + 100) { this.cache.get(k).width = 0; this.cache.delete(k); }
    }
    const el = this.items.get(task.page);
    if (el) { const box = el.querySelector(".pp-thumb"); box.querySelector("canvas")?.remove(); box.prepend(cv); }
  }

  _paintSel() {
    for (const [i, el] of this.items) el.classList.toggle("sel", this.sel.has(i));
  }

  _indexAt(e) {
    const el = e.target.closest?.(".pp-item");
    return el ? +el.dataset.i : -1;
  }

  _select(i, e) {
    if (e.shiftKey) {
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      this.sel = new Set();
      for (let k = a; k <= b; k++) this.sel.add(k);
    } else if (e.ctrlKey || e.metaKey) {
      if (this.sel.has(i) && this.sel.size > 1) this.sel.delete(i); else this.sel.add(i);
      this.anchor = i;
    } else {
      this.sel = new Set([i]);
      this.anchor = i;
    }
    this._paintSel();
  }

  // ---- pointer: click selects (and shows the page); mouse/pen drag moves
  // pages; a finger scrolls the list, or presses and holds a page to lift it
  // and move it (letting go without moving opens the page menu).
  _down(e) {
    if (e.button !== 0) return;
    const i = this._indexAt(e);
    if (i < 0) return;
    this.root.focus({ preventScroll: true });
    const touch = e.pointerType === "touch";
    if (touch && this._multi) return; // two fingers: pinching, not a tap
    const x0 = e.clientX, y0 = e.clientY;
    // The grip moves the page straight away, even with a finger.
    const grip = !!e.target.closest(".pp-grip");
    let moved = false, held = grip, last = e;
    if (grip) { this._hold = true; this.items.get(i)?.classList.add("lifted"); }
    else if (touch) {
      this._touchAt = performance.now();
      this._holdTimer = setTimeout(() => {
        if (moved) return;
        held = true;
        this._hold = true;
        this.items.get(i)?.classList.add("lifted");
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch {} }
      }, 380);
    }
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      last = ev;
      const far = Math.hypot(ev.clientX - x0, ev.clientY - y0) > (touch ? 8 : 6);
      if (!moved && far) {
        moved = true;
        clearTimeout(this._holdTimer);
        if ((!touch || held) && !this._pinch) this._startDrag(i, e);
      }
      if (this.drag) this._dragMove(ev);
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      clearTimeout(this._holdTimer);
      this._hold = false;
      this.items.get(i)?.classList.remove("lifted");
      this.list.removeEventListener("pointermove", move);
      this.list.removeEventListener("pointerup", up);
      this.list.removeEventListener("pointercancel", up);
      if (this.drag) { this._dragEnd(ev.type === "pointercancel"); return; }
      if (ev.type !== "pointerup" || (touch && (this._multi || this._pinch))) return;
      if (held && !moved && !grip) {
        if (!this.sel.has(i)) this._select(i, {});
        this.cb.onMenu?.(i, last.clientX, last.clientY);
      } else if (!moved) {
        this._select(i, e);
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) this.cb.onGo?.(i);
      }
    };
    this.list.addEventListener("pointermove", move);
    this.list.addEventListener("pointerup", up);
    this.list.addEventListener("pointercancel", up);
  }

  _startDrag(i, e) {
    if (!this.sel.has(i)) this._select(i, {});
    try { this.list.setPointerCapture(e.pointerId); } catch {}
    const pages = this.selected();
    const ghost = document.createElement("div");
    ghost.className = "pp-ghost";
    const cv = this.cache.get(i);
    if (cv) { const c2 = document.createElement("canvas"); c2.width = cv.width; c2.height = cv.height; c2.getContext("2d").drawImage(cv, 0, 0); ghost.appendChild(c2); }
    if (pages.length > 1) { const b = document.createElement("span"); b.className = "pp-badge"; b.textContent = pages.length; ghost.appendChild(b); }
    document.body.appendChild(ghost);
    this.drag = { pages, ghost, to: -1 };
    this.root.classList.add("dragging");
  }

  _dragMove(ev) {
    const D = this.drag;
    D.ghost.style.transform = `translate(${ev.clientX - 30}px, ${ev.clientY - 30}px)`;
    const r = this.list.getBoundingClientRect();
    // Over another open PDF: the pages will be copied there.
    D.out = ev.clientX < r.left - 4 && this.cb.onDragOut ? this.cb.onDragOut(ev.clientX, ev.clientY, D.pages) : null;
    D.ghost.classList.toggle("copy", !!D.out);
    if (D.out || ev.clientX < r.left - 4) { D.to = -1; this.dropEl.hidden = true; D.scroll = 0; return; }
    const n = this.pages.length, x = ev.clientX - r.left, y = ev.clientY - r.top + this.list.scrollTop;
    let to = n;
    if (this.cols === 1) {
      // One column: before the first page whose middle is below the pointer.
      for (let k = 0; k < n; k++) if (y < this.tops[k] + this.heights[k] / 2) { to = k; break; }
      const lineY = to < n ? this.tops[to] - GAP / 2 : this.tops[n - 1] + this.heights[n - 1] + GAP / 2;
      this.dropEl.className = "pp-drop";
      this.dropEl.style.cssText = `top:${lineY - 1.5}px`;
    } else {
      // A grid: the row under the pointer, then the gap nearest it in that row.
      let a = Math.floor((n - 1) / this.cols) * this.cols; // below every row: the last one
      for (let k = 0; k < n; k += this.cols) if (y < this.tops[k] + this.heights[k] + GAP / 2) { a = k; break; }
      const b = Math.min(n, a + this.cols);
      to = a;
      while (to < b && x > this.lefts[to] + this.cellW / 2) to++;
      const lx = to < b ? this.lefts[to] - GAP_X / 2 : this.lefts[b - 1] + this.cellW + GAP_X / 2;
      this.dropEl.className = "pp-drop v";
      this.dropEl.style.cssText = `left:${lx - 1.5}px;top:${this.tops[a]}px;height:${this.heights[a]}px`;
    }
    D.to = to;
    this.dropEl.hidden = false;
    // Scroll when dragging near the top or bottom edge.
    const edge = 40;
    D.scroll = ev.clientY < r.top + edge ? -1 : ev.clientY > r.bottom - edge ? 1 : 0;
    if (D.scroll && !D.timer) {
      D.timer = setInterval(() => { if (this.drag && this.drag.scroll) { this.list.scrollTop += this.drag.scroll * 14; this._schedule(); } }, 16);
    }
  }

  _dragEnd(cancel) {
    const D = this.drag;
    this.drag = null;
    clearInterval(D.timer);
    D.ghost.remove();
    this.dropEl.hidden = true;
    this.root.classList.remove("dragging");
    this.cb.onDragOut?.(null);
    if (!cancel && D.out) { this.cb.onDropOut?.(D.pages, D.out); return; }
    if (!cancel && D.to >= 0) {
      const order = moveOrder(this.pages.length, D.pages, D.to);
      if (order) this.cb.onMove?.(order, D.pages, D.to);
    }
  }

  _key(e) {
    if (!this.pages.length || e.target.closest("input, textarea")) return;
    const last = this.pages.length - 1;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); this.cb.onDelete?.(this.selected()); }
    else if ((e.ctrlKey || e.metaKey) && e.code === "KeyA") { e.preventDefault(); e.stopPropagation(); this.selectAll(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp" || (this.cols > 1 && (e.key === "ArrowLeft" || e.key === "ArrowRight"))) {
      e.preventDefault(); e.stopPropagation();
      const step = { ArrowDown: this.cols, ArrowUp: -this.cols, ArrowLeft: -1, ArrowRight: 1 }[e.key];
      const i = Math.max(0, Math.min(last, this.anchor + step));
      this._select(i, e.shiftKey ? { shiftKey: true } : {});
      if (!e.shiftKey) this.anchor = i;
      this.reveal(i);
      this.cb.onGo?.(i);
    }
  }
}

// New page order (old index of each page, in the new order) when `pages` move
// to before page `to`; null if nothing changes.
export function moveOrder(n, pages, to) {
  const set = new Set(pages);
  const rest = [];
  for (let i = 0; i < n; i++) if (!set.has(i)) rest.push(i);
  let k = 0;
  while (k < rest.length && rest[k] < to) k++;
  const order = [...rest.slice(0, k), ...[...set].sort((a, b) => a - b), ...rest.slice(k)];
  return order.every((v, i) => v === i) ? null : order;
}
