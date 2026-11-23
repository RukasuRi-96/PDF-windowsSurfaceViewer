// Pages panel: a thumbnail of every page, to select, delete, add, copy in,
// duplicate, rotate and drag pages into a new order (mouse and pen drag;
// a finger presses and holds a page to lift it). The page being read is
// highlighted; pages show their number, their name (the PDF's page label or
// bookmark), or both.
//
// Speed: only the thumbnails in (or near) view exist; they are rendered at
// thumbnail size by the render workers only after the page view's own tiles,
// straight from the page (nothing cached that the page view needs).
import { icon } from "./icons.js";

const THUMB_W = 132;   // thumbnail width (CSS px)
const LABEL_H = 22;
const GAP = 12;
const PAD_TOP = 10;

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
    this.gen = 0;
    this.labelMode = "both"; // number | name | both
    root.tabIndex = -1;
    root.innerHTML = `
      <div class="pp-head">
        <span class="pp-title">Pages <span class="pp-count"></span></span>
        <button class="btn icon-btn" data-act="labels" title="Show page numbers, names or both">${icon("tag")}</button>
        <button class="btn icon-btn" data-act="add" title="Add pages">${icon("filePlus")}</button>
        <button class="btn icon-btn" data-act="delete" title="Delete the selected pages (Delete)">${icon("trash")}</button>
        <button class="btn icon-btn" data-act="close" title="Hide pages">${icon("x")}</button>
      </div>
      <div class="pp-list"><div class="pp-inner"></div><div class="pp-drop" hidden></div></div>`;
    this.list = root.querySelector(".pp-list");
    this.inner = root.querySelector(".pp-inner");
    this.dropEl = root.querySelector(".pp-drop");
    this.countEl = root.querySelector(".pp-count");
    root.querySelector(".pp-head").addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      if (b.dataset.act === "add") cb.onAddMenu?.(b, this.insertAt());
      else if (b.dataset.act === "labels") cb.onLabelsMenu?.(b);
      else if (b.dataset.act === "delete") cb.onDelete?.(this.selected());
      else if (b.dataset.act === "close") cb.onClose?.();
    });
    this.list.addEventListener("scroll", () => this._schedule());
    new ResizeObserver(() => this._schedule()).observe(this.list);
    this.list.addEventListener("pointerdown", (e) => this._down(e));
    // While a finger holds a page to move it, the list must not scroll.
    this.list.addEventListener("touchmove", (e) => { if (this.drag || this._hold) e.preventDefault(); }, { passive: false });
    this.list.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (performance.now() - (this._touchAt || -1e9) < 1500) return; // touch: handled by press and hold
      const i = this._indexAt(e);
      if (i < 0) return;
      if (!this.sel.has(i)) this._select(i, {});
      cb.onMenu?.(i, e.clientX, e.clientY);
    });
    root.addEventListener("keydown", (e) => this._key(e));
    engine.onThumb = (task, bmp) => this._onThumb(task, bmp);
  }

  get open() { return !this.root.hidden; }

  show(on) {
    this.root.hidden = !on;
    if (on) { this._layout(); this._render(); this.reveal(this.current); }
    else this.engine.setThumbQueue([]);
  }

  // A (re)opened document, or its pages changed.
  setDocument(pages, current = 0, select = null) {
    this.gen++;
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
  _layout() {
    const n = this.pages.length;
    this.tops = new Float64Array(n);
    this.heights = new Float64Array(n);
    let y = PAD_TOP;
    for (let i = 0; i < n; i++) {
      const p = this.pages[i], w = p.x1 - p.x0, h = p.y1 - p.y0;
      const th = Math.round(Math.min(THUMB_W * 2, Math.max(THUMB_W * 0.3, (THUMB_W * h) / Math.max(1, w))));
      this.tops[i] = y;
      this.heights[i] = th + LABEL_H;
      y += th + LABEL_H + GAP;
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
    for (let i = a; i < b; i++) {
      if (this.cache.has(i)) continue;
      const p = this.pages[i], res = (THUMB_W * dpr) / Math.max(1, p.x1 - p.x0);
      tasks.push({
        key: `t${this.gen}:${i}`, thumb: true, gen: this.gen, page: i, res,
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
    const box = document.createElement("div");
    box.className = "pp-thumb";
    box.style.height = this.heights[i] - LABEL_H + "px";
    const cv = this.cache.get(i);
    if (cv) box.appendChild(cv);
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
    if (el) el.querySelector(".pp-thumb").replaceChildren(cv);
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
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false, held = false, last = e;
    if (touch) {
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
        if (!touch || held) this._startDrag(i, e);
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
      if (ev.type !== "pointerup") return;
      if (held && !moved) {
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
    const y = ev.clientY - r.top + this.list.scrollTop;
    // Insertion point: before the first page whose middle is below the pointer.
    let to = this.pages.length;
    for (let k = 0; k < this.pages.length; k++) if (y < this.tops[k] + this.heights[k] / 2) { to = k; break; }
    D.to = to;
    const lineY = to < this.pages.length ? this.tops[to] - GAP / 2 : this.tops[this.pages.length - 1] + this.heights[this.pages.length - 1] + GAP / 2;
    this.dropEl.hidden = false;
    this.dropEl.style.top = lineY - 1.5 + "px";
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
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      const i = Math.max(0, Math.min(last, this.anchor + (e.key === "ArrowDown" ? 1 : -1)));
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
