// Folder tree of every PDF under a root folder (recursive), virtualized so
// folders with thousands of files stay instant.
import { icon } from "./icons.js";

const ROW_H = 38;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortTree(node) {
  node.dirs.sort((a, b) => collator.compare(a.name, b.name));
  node.files.sort((a, b) => collator.compare(a.name, b.name));
  let count = node.files.length;
  for (const d of node.dirs) count += sortTree(d);
  node.count = count;
  return count;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export class Sidebar {
  constructor(container, cb) {
    this.cb = cb;
    this.tree = null;
    this.rows = [];
    this.expanded = new Set();
    this.current = null;
    this.filter = "";
    container.innerHTML = `
      <div class="sb-head">
        <button class="sb-root" title="Choose folder (Ctrl+O)">
          ${icon("folderOpen")}
          <span class="sb-root-text"><span class="sb-root-name">Open a folder</span><span class="sb-root-path"></span></span>
        </button>
        <button class="btn icon-btn sb-collapse" title="Collapse all">${icon("collapse")}</button>
        <button class="btn icon-btn sb-refresh" title="Refresh">${icon("refresh")}</button>
      </div>
      <label class="sb-search">${icon("search")}<input type="search" placeholder="Filter PDFs" spellcheck="false"><button class="sb-clear" title="Clear">${icon("x")}</button></label>
      <div class="sb-list" tabindex="-1"><div class="sb-spacer"></div></div>
      <div class="sb-foot"></div>`;
    this.el = container;
    this.listEl = container.querySelector(".sb-list");
    this.spacer = container.querySelector(".sb-spacer");
    this.foot = container.querySelector(".sb-foot");
    this.input = container.querySelector("input");
    container.querySelector(".sb-root").onclick = () => cb.onPickFolder();
    container.querySelector(".sb-refresh").onclick = () => cb.onRefresh();
    container.querySelector(".sb-collapse").onclick = () => { this.expanded.clear(); this._rebuild(); cb.onExpanded?.([...this.expanded]); };
    container.querySelector(".sb-clear").onclick = () => { this.input.value = ""; this.setFilter(""); this.input.focus(); };
    this.input.addEventListener("input", () => this.setFilter(this.input.value));
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = this.rows.find((r) => r.file);
        if (first) cb.onOpen(first.file.path);
      } else if (e.key === "Escape") { this.input.value = ""; this.setFilter(""); this.input.blur(); }
    });
    this.listEl.addEventListener("scroll", () => this._paint());
    new ResizeObserver(() => this._paint()).observe(this.listEl);
    this.listEl.addEventListener("click", (e) => this._click(e));
    this.listEl.addEventListener("contextmenu", (e) => {
      const row = this._rowFromEvent(e);
      if (row) { e.preventDefault(); cb.onContext?.(row.file ? row.file.path : row.dir.path, e.clientX, e.clientY, !!row.file); }
    });
  }

  setRoot(rootPath) {
    const name = rootPath ? rootPath.split(/[\\/]/).filter(Boolean).pop() || rootPath : "Open a folder";
    this.el.querySelector(".sb-root-name").textContent = name;
    // Leading LRM keeps slashes in place while the path is ellipsized from the left.
    const pathEl = this.el.querySelector(".sb-root-path");
    pathEl.textContent = rootPath ? "\u200E" + rootPath + "\u200E" : "Choose where your PDFs live";
    pathEl.classList.toggle("has-path", !!rootPath);
    this.el.querySelector(".sb-root").title = rootPath ? `${rootPath}\nClick to choose another folder (Ctrl+O)` : "Choose folder (Ctrl+O)";
  }

  setTree(tree, expanded) {
    this.tree = tree;
    if (tree) sortTree(tree);
    if (expanded) this.expanded = new Set(expanded);
    else if (tree) {
      // First visit: open everything if small, else just the top level.
      this.expanded = new Set();
      const all = tree.count <= 400;
      const walk = (n, depth) => { for (const d of n.dirs) { if (all || depth === 0) this.expanded.add(d.path); walk(d, depth + 1); } };
      walk(tree, 0);
    }
    this._rebuild();
  }

  // Files in on-screen order (dirs before files at each level).
  orderedFiles() {
    const out = [];
    const walk = (n) => { for (const d of n.dirs) walk(d); for (const f of n.files) out.push(f.path); };
    if (this.tree) walk(this.tree);
    return out;
  }

  setCurrent(path) {
    this.current = path;
    if (path && this.tree && !this.filter) {
      // Make sure the folder chain is expanded.
      let changed = false;
      const find = (n, chain) => {
        if (n.files.some((f) => f.path === path)) {
          for (const c of chain) if (!this.expanded.has(c)) { this.expanded.add(c); changed = true; }
          return true;
        }
        for (const d of n.dirs) if (find(d, [...chain, d.path])) return true;
        return false;
      };
      find(this.tree, []);
      if (changed) { this._rebuild(); this.cb.onExpanded?.([...this.expanded]); }
    }
    this._paint();
    this.reveal(path);
  }

  reveal(path) {
    const idx = this.rows.findIndex((r) => r.file && r.file.path === path);
    if (idx < 0) return;
    const top = idx * ROW_H, h = this.listEl.clientHeight;
    if (top < this.listEl.scrollTop || top + ROW_H > this.listEl.scrollTop + h) {
      this.listEl.scrollTop = Math.max(0, top - h / 2 + ROW_H / 2);
    }
  }

  setFilter(text) {
    this.filter = text.trim().toLowerCase();
    this.el.classList.toggle("filtering", !!this.filter);
    this._rebuild();
    this.listEl.scrollTop = 0;
  }

  _rebuild() {
    const rows = [];
    const terms = this.filter ? this.filter.split(/\s+/) : null;
    const match = (f) => {
      const hay = f.name.toLowerCase();
      return terms.every((t) => hay.includes(t));
    };
    const walk = (n, depth) => {
      for (const d of n.dirs) {
        if (terms) {
          // Keep a folder only if something inside it matches.
          const start = rows.length;
          rows.push({ dir: d, depth, open: true });
          walk(d, depth + 1);
          if (rows.length === start + 1) rows.pop();
        } else {
          const open = this.expanded.has(d.path);
          rows.push({ dir: d, depth, open });
          if (open) walk(d, depth + 1);
        }
      }
      for (const f of n.files) if (!terms || match(f)) rows.push({ file: f, depth });
    };
    if (this.tree) walk(this.tree, 0);
    this.rows = rows;
    this.spacer.style.height = rows.length * ROW_H + "px";
    const total = this.tree ? this.tree.count : 0;
    if (!this.tree) this.foot.textContent = "";
    else if (terms) this.foot.textContent = `${rows.filter((r) => r.file).length} of ${total} PDFs match`;
    else this.foot.textContent = `${total} PDF${total === 1 ? "" : "s"}`;
    this._paint(true);
  }

  _paint() {
    const top = this.listEl.scrollTop, h = this.listEl.clientHeight || 600;
    const a = Math.max(0, Math.floor(top / ROW_H) - 6);
    const b = Math.min(this.rows.length, Math.ceil((top + h) / ROW_H) + 6);
    let html = "";
    for (let k = a; k < b; k++) {
      const r = this.rows[k];
      const pad = 10 + r.depth * 16;
      if (r.dir) {
        html += `<div class="sb-row dir${r.open ? " open" : ""}" data-k="${k}" style="top:${k * ROW_H}px;padding-left:${pad}px" title="${escapeHtml(r.dir.path)}">${icon("chevron", "chev")}${icon(r.open ? "folderOpen" : "folder", "kind")}<span class="name">${escapeHtml(r.dir.name)}</span><span class="count">${r.dir.count}</span></div>`;
      } else {
        const f = r.file;
        const cur = f.path === this.current ? " current" : "";
        const name = f.name.replace(/\.pdf$/i, "");
        html += `<div class="sb-row file${cur}" data-k="${k}" style="top:${k * ROW_H}px;padding-left:${pad + 18}px" title="${escapeHtml(f.path)}">${icon("file", "kind")}<span class="name">${escapeHtml(name)}</span></div>`;
      }
    }
    if (!this.tree) {
      html = `<div class="sb-empty">No folder selected.<br><button class="btn primary sb-pick">${icon("folderOpen")} Open folder</button></div>`;
    } else if (!this.rows.length) {
      html = `<div class="sb-empty">${this.filter ? "No PDFs match your filter." : "No PDFs in this folder."}</div>`;
    }
    this.spacer.innerHTML = html;
    this.spacer.querySelector(".sb-pick")?.addEventListener("click", () => this.cb.onPickFolder());
  }

  _rowFromEvent(e) {
    const rowEl = e.target.closest(".sb-row");
    return rowEl ? this.rows[+rowEl.dataset.k] : null;
  }

  _click(e) {
    const r = this._rowFromEvent(e);
    if (!r) return;
    if (r.dir) {
      if (this.filter) return;
      if (this.expanded.has(r.dir.path)) this.expanded.delete(r.dir.path);
      else this.expanded.add(r.dir.path);
      this._rebuild();
      this.cb.onExpanded?.([...this.expanded]);
    } else {
      this.cb.onOpen(r.file.path);
    }
  }
}
