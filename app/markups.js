// The markups list: every markup in the open PDF, page by page, with its
// kind, colour and text (a text box's words, the highlighted words, a
// measurement's value). Tap one to go to it and select it.
//
// Speed: nothing is read until the list is shown. Then the edit worker
// summarises the pages a few dozen at a time, and after an edit only the
// pages that changed are read again. Each open PDF keeps its own list, so
// switching between PDFs side by side doesn't start over.
import { icon } from "./icons.js";

const CHUNK = 40;
export const MARK_KINDS = {
  ink: ["Pen", "pen", "ink"], marker: ["Marker", "highlighter", "ink"], highlight: ["Highlight", "highlighter", "hl"],
  box: ["Box", "square", "shape"], cloud: ["Cloud", "cloud", "shape"], line: ["Line", "line", "shape"], arrow: ["Arrow", "arrow", "shape"],
  text: ["Text", "text", "text"], callout: ["Callout", "callout", "text"],
  sig: ["Signature", "signature", "pic"], image: ["Picture", "imagePlus", "pic"],
  measure: ["Measurement", "ruler", "measure"], redact: ["Erase area", "eraseArea", "edit"], retext: ["Edited text", "replaceText", "edit"],
};
const FILTERS = [["all", "All markups"], ["ink", "Pen and marker"], ["hl", "Highlights"], ["shape", "Shapes"], ["text", "Text and callouts"], ["pic", "Signatures and pictures"], ["measure", "Measurements"], ["edit", "Page edits"]];
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const css = (c) => (c && c.length >= 3 ? `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})` : "var(--muted)");

export class MarkupsPanel {
  // cb.load(from, to) -> Promise<items>; cb.onPick(item); cb.pageLabel(i)
  constructor(root, cb) {
    this.root = root;
    this.cb = cb;
    this.docs = new Map(); // key -> { n, byPage: Map(page -> items), stale: Set, loading }
    this.key = null;
    this.filter = "all";
    root.innerHTML = `
      <div class="mk-head"><span class="mk-title">Markups <span class="mk-count"></span></span>
        <select class="mk-filter" title="Show">${FILTERS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></div>
      <div class="mk-list"></div>`;
    this.list = root.querySelector(".mk-list");
    this.countEl = root.querySelector(".mk-count");
    root.querySelector(".mk-filter").addEventListener("change", (e) => { this.filter = e.target.value; this._render(); });
    this.list.addEventListener("click", (e) => {
      const row = e.target.closest(".mk-row");
      if (!row) return;
      const D = this.docs.get(this.key);
      const it = D?.byPage.get(+row.dataset.page)?.find((x) => x.id === +row.dataset.id);
      if (!it) return;
      for (const r of this.list.querySelectorAll(".mk-row.sel")) r.classList.remove("sel");
      row.classList.add("sel");
      this.cb.onPick?.(it);
    });
  }

  get open() { return !this.root.hidden; }

  show(on) {
    this.root.hidden = !on;
    if (on) this._refresh();
  }

  // Which document the list shows (`n` pages); a new `n` starts it over.
  setDocument(key, n) {
    let D = this.docs.get(key);
    if (!D || D.n !== n) { D = { n, byPage: new Map(), stale: new Set(), all: true, run: 0 }; this.docs.set(key, D); }
    this.key = key;
    this.countEl.textContent = "";
    if (this.open) this._refresh(); else this._render();
  }

  // The document in use was opened, or its pages changed (added, removed,
  // moved): read it all again.
  reset(key, n) {
    this.docs.delete(key);
    this.setDocument(key, n);
  }

  forget(key) { this.docs.delete(key); }

  clear() { this.key = null; this._render(); }

  // Markups on these pages changed.
  invalidate(key, pages) {
    const D = this.docs.get(key);
    if (!D) return;
    for (const i of pages) D.stale.add(i);
    if (key === this.key && this.open) this._refresh();
  }

  async _refresh() {
    const D = this.docs.get(this.key);
    if (!D) { this._render(); return; }
    if (D.busy) { D.again = true; return; }
    D.busy = true;
    const key = this.key;
    try {
      do {
        D.again = false;
        let ranges = [];
        if (D.all) {
          D.all = false;
          D.stale.clear();
          for (let a = 0; a < D.n; a += CHUNK) ranges.push([a, Math.min(D.n, a + CHUNK)]);
        } else if (D.stale.size) {
          ranges = [...D.stale].sort((a, b) => a - b).map((i) => [i, i + 1]);
          D.stale.clear();
        }
        for (const [a, b] of ranges) {
          const items = await this.cb.load(key, a, b);
          if (this.docs.get(key) !== D) return;
          for (let i = a; i < b; i++) D.byPage.delete(i);
          for (const it of items || []) {
            if (!D.byPage.has(it.page)) D.byPage.set(it.page, []);
            D.byPage.get(it.page).push(it);
          }
          if (key === this.key) this._renderSoon();
        }
      } while (D.again || D.stale.size);
      D.loaded = true;
    } catch (err) {
      console.warn("markups", err);
    } finally {
      D.busy = false;
      if (key === this.key) this._renderSoon();
    }
  }

  _renderSoon() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  _render() {
    const D = this.docs.get(this.key);
    if (!D) { this.list.innerHTML = ""; this.countEl.textContent = ""; return; }
    const want = this.filter;
    let html = "", total = 0, shown = 0;
    const pagesSorted = [...D.byPage.keys()].sort((a, b) => a - b);
    for (const i of pagesSorted) {
      const items = D.byPage.get(i);
      total += items.length;
      const rows = items.filter((it) => want === "all" || (MARK_KINDS[it.k]?.[2] || "shape") === want);
      if (!rows.length) continue;
      shown += rows.length;
      if (shown > 3000) continue;
      html += `<div class="mk-pg">${esc(this.cb.pageLabel?.(i) || "Page " + (i + 1))}</div>`;
      for (const it of rows) {
        const [name, ic] = MARK_KINDS[it.k] || [it.k, "square"];
        const sub = [it.author, it.date ? new Date(it.date).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : ""].filter(Boolean).join(" · ");
        html += `<div class="mk-row" data-page="${i}" data-id="${it.id}" role="button" tabindex="0"><span class="mk-ic" style="color:${css(it.color)}">${icon(ic)}</span>` +
          `<span class="mk-main"><span class="mk-name">${esc(name)}</span>${it.text ? `<span class="mk-text">${esc(it.text)}</span>` : ""}${sub ? `<span class="mk-sub">${esc(sub)}</span>` : ""}</span></div>`;
      }
    }
    if (shown > 3000) html += `<p class="mk-empty">… and ${shown - 3000} more. Choose a kind above to see fewer.</p>`;
    if (!html) html = `<p class="mk-empty">${D.busy || D.all ? "Reading the markups…" : want === "all" ? "No markups in this PDF yet." : "None of this kind."}</p>`;
    this.list.innerHTML = html;
    this.countEl.textContent = `(${want === "all" ? total : `${shown} of ${total}`})`;
  }
}
