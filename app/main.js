import { host } from "./host.js";
import { Engine } from "./engine.js";
import { Viewer, cssColor } from "./viewer.js";
import { Sidebar } from "./sidebar.js";
import { icon } from "./icons.js";

const $ = (s) => document.querySelector(s);
const appEl = $("#app");

// ------------------------------------------------------------------ config
const cfg = Object.assign(
  {
    folder: null,
    expanded: {},
    lastFile: null,
    files: {},
    tool: "hand",
    styles: null,
    touchDraws: false,
    sidebarOpen: true,
    sidebarW: 300,
  },
  (await host.readJson("config").catch(() => null)) || {}
);
let cfgTimer = 0;
function saveCfg(now = false) {
  clearTimeout(cfgTimer);
  const write = () => host.writeJson("config", cfg);
  if (now) return write();
  cfgTimer = setTimeout(write, 400);
}

const PALETTES = {
  pen: { colors: ["#111111", "#1d4ed8", "#dc2626", "#16a34a", "#ea580c", "#7c3aed"], widths: [0.75, 1.5, 3, 6] },
  highlight: { colors: ["#ffe11a", "#7cf27c", "#ff8fd1", "#7fd4ff", "#ffb54d", "#c4a5ff"], widths: [6, 12, 20, 32] },
  box: { colors: ["#dc2626", "#1d4ed8", "#16a34a", "#111111", "#ea580c", "#7c3aed"], widths: [1, 2, 4, 6] },
};
const hexToRgb = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255);
cfg.styles = Object.assign(
  { pen: { color: "#1d4ed8", width: 1.5 }, highlight: { color: "#ffe11a", width: 12 }, box: { color: "#dc2626", width: 2 } },
  cfg.styles || {}
);

// ------------------------------------------------------------------ setup
if (host.platform === "win32") document.documentElement.classList.add("wco");
// Render workers run in parallel; each holds its own copy of the open PDF, so
// machines with 8 GB of RAM or less get at most 3 (plus the edit worker).
const hc = navigator.hardwareConcurrency || 4;
const mem = navigator.deviceMemory || 8;
const engine = new Engine(new URL("./worker.js", import.meta.url), Math.max(2, Math.min(mem <= 8 ? 3 : 4, Math.floor(hc / 3))));
engine.ready().then(() => engine.setAuthor(host.userName || ""));

const state = { path: null, gen: 0, saving: false };

const viewer = new Viewer($("#viewer"), engine, {
  onPage(i, n) {
    pagePill.textContent = `${i + 1} / ${n}`;
    rememberView();
    pokeIdle();
  },
  onZoom(scale) {
    $("#zoom-label").textContent = Math.round((scale * 72 / 96) * 100) + "%";
    rememberView();
  },
  onHistory(canUndo, canRedo, dirty) {
    $("#btn-undo").disabled = !canUndo;
    $("#btn-redo").disabled = !canRedo;
    appEl.classList.toggle("dirty", dirty);
    updateTitle();
  },
});

const sidebar = new Sidebar($("#sidebar"), {
  onOpen: (p) => openFile(p),
  onPickFolder: () => pickFolder(),
  onRefresh: () => cfg.folder && loadFolder(cfg.folder, false),
  onExpanded: (list) => { if (cfg.folder) { cfg.expanded[cfg.folder] = list; saveCfg(); } },
  onContext: (p, x, y, isFile) => showMenu({ x, y }, [
    isFile && { label: "Open", run: () => openFile(p) },
    { label: "Show in folder", icon: "external", run: () => host.showInFolder(p) },
    { label: "Copy path", icon: "copy", run: () => navigator.clipboard.writeText(p) },
  ]),
});

// ------------------------------------------------------------------ toolbar
const setIcon = (sel, name) => { $(sel).innerHTML = icon(name); };
setIcon("#btn-sidebar", "sidebar");
setIcon("#btn-undo", "undo");
setIcon("#btn-redo", "redo");
setIcon("#btn-zoomout", "zoomOut");
setIcon("#btn-zoomin", "zoomIn");
setIcon("#btn-fitw", "fitWidth");
setIcon("#btn-fitp", "fitPage");
setIcon("#btn-save", "save");
setIcon("#btn-more", "more");
setIcon("#btn-touch", "touch");
$("#empty-open").innerHTML = icon("folderOpen") + " Open folder";
const TOOL_ICONS = { hand: "hand", highlight: "highlighter", pen: "pen", box: "square", eraser: "eraser" };
for (const b of document.querySelectorAll(".tool")) b.innerHTML = icon(TOOL_ICONS[b.dataset.tool]);
const pagePill = $("#pagepill");

function setTool(t) {
  cfg.tool = t;
  viewer.setTool(t);
  for (const b of document.querySelectorAll(".tool")) b.classList.toggle("active", b.dataset.tool === t);
  const st = cfg.styles[t];
  const sb = $("#btn-style");
  sb.classList.toggle("na", !st);
  sb.disabled = !st;
  if (st) sb.querySelector(".swatch-dot").style.background = st.color;
  saveCfg();
}

function applyStyles() {
  for (const k of ["pen", "highlight", "box"]) viewer.setStyle(k, { color: hexToRgb(cfg.styles[k].color), width: cfg.styles[k].width });
}

function setTouchDraws(on) {
  cfg.touchDraws = on;
  viewer.touchDraws = on;
  $("#btn-touch").classList.toggle("on", on);
  $("#btn-touch").title = on
    ? "Finger draws: ON — one finger uses the tool, two fingers pan/zoom (T)"
    : "Finger draws: OFF — finger pans/zooms, pen draws (T)";
  saveCfg();
}

function toggleSidebar(force) {
  cfg.sidebarOpen = force ?? !cfg.sidebarOpen;
  appEl.classList.toggle("no-sidebar", !cfg.sidebarOpen);
  $("#btn-sidebar").classList.toggle("on", cfg.sidebarOpen);
  saveCfg();
}

const narrow = () => window.innerWidth <= 860;

$("#tools").addEventListener("click", (e) => {
  const b = e.target.closest(".tool");
  if (!b) return;
  if (b.dataset.tool === cfg.tool && cfg.styles[cfg.tool]) openStylePopover();
  else setTool(b.dataset.tool);
});
$("#btn-style").onclick = () => openStylePopover();
$("#btn-touch").onclick = () => setTouchDraws(!cfg.touchDraws);
$("#btn-sidebar").onclick = () => toggleSidebar();
$("#btn-undo").onclick = () => viewer.undo();
$("#btn-redo").onclick = () => viewer.redo();
$("#btn-zoomin").onclick = () => viewer.zoomBy(1.25);
$("#btn-zoomout").onclick = () => viewer.zoomBy(0.8);
$("#btn-fitw").onclick = () => viewer.fit("width");
$("#btn-fitp").onclick = () => viewer.fit("page");
$("#btn-save").onclick = () => save();
$("#empty-open").onclick = () => pickFolder();
$("#zoom-label").onclick = (e) => {
  const z = (pct) => () => viewer.setZoom((pct / 100) * (96 / 72));
  showMenu(e.currentTarget, [
    { label: "Fit width", icon: "fitWidth", key: "Ctrl+0", run: () => viewer.fit("width") },
    { label: "Fit page", icon: "fitPage", key: "Ctrl+9", run: () => viewer.fit("page") },
    "-",
    ...[50, 75, 100, 150, 200, 400, 800].map((p) => ({ label: p + "%", run: z(p) })),
  ]);
};
$("#btn-more").onclick = (e) => showMenu(e.currentTarget, [
  { label: "Open folder…", icon: "folderOpen", key: "Ctrl+O", run: pickFolder },
  { label: "Open file…", icon: "openFile", run: pickFile },
  "-",
  { label: "Save", icon: "save", key: "Ctrl+S", run: () => save(), disabled: !state.path },
  { label: "Save as…", key: "Ctrl+Shift+S", run: () => save({ as: true }), disabled: !state.path },
  { label: "Show in folder", icon: "external", run: () => host.showInFolder(state.path), disabled: !state.path },
  "-",
  { label: "Full screen", key: "F11", run: () => host.toggleFullscreen() },
  { label: "Keyboard & touch help", icon: "info", run: showHelp },
]);

// ------------------------------------------------------------------ popovers
const pop = $("#popover");
let popAnchor = null;

function placePopover(anchor) {
  pop.hidden = false;
  const pr = pop.getBoundingClientRect();
  let x, y;
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    x = r.left + r.width / 2 - pr.width / 2;
    y = r.bottom + 6;
  } else { x = anchor.x; y = anchor.y; }
  pop.style.left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, x)) + "px";
  pop.style.top = Math.max(8, Math.min(window.innerHeight - pr.height - 8, y)) + "px";
}

function closePopover() { pop.hidden = true; pop.innerHTML = ""; popAnchor = null; }

function showMenu(anchor, items) {
  if (!pop.hidden && popAnchor === anchor) { closePopover(); return; }
  pop.innerHTML = "";
  const menu = document.createElement("div");
  menu.className = "menu";
  for (const it of items) {
    if (!it) continue;
    if (it === "-") { menu.appendChild(document.createElement("hr")); continue; }
    const b = document.createElement("button");
    b.className = "btn";
    b.disabled = !!it.disabled;
    b.innerHTML = (it.icon ? icon(it.icon) : `<span style="width:20px"></span>`) + `<span>${it.label}</span>` + (it.key ? `<span class="key">${it.key}</span>` : "");
    b.onclick = () => { closePopover(); it.run(); };
    menu.appendChild(b);
  }
  pop.appendChild(menu);
  popAnchor = anchor;
  placePopover(anchor);
}

function openStylePopover() {
  const tool = cfg.tool;
  const pal = PALETTES[tool];
  if (!pal) return;
  const anchor = $("#btn-style");
  if (!pop.hidden && popAnchor === anchor) { closePopover(); return; }
  const st = cfg.styles[tool];
  const name = { pen: "Pen", highlight: "Highlighter", box: "Box" }[tool];
  const maxW = pal.widths[pal.widths.length - 1];
  pop.innerHTML = `<div class="pop-title">${name} color</div><div class="swatches">${pal.colors
    .map((c) => `<button class="swatch${c === st.color ? " sel" : ""}" data-c="${c}" title="${c}"><span style="background:${c}"></span></button>`)
    .join("")}</div><div class="pop-title">Thickness</div><div class="sizes">${pal.widths
    .map((w) => {
      const d = Math.round(4 + (w / maxW) * 20);
      return `<button class="size${w === st.width ? " sel" : ""}" data-w="${w}" title="${w} pt"><i style="width:${tool === "highlight" ? 26 : d}px;height:${d}px;${tool === "highlight" ? `background:${st.color};opacity:.6` : ""}"></i></button>`;
    })
    .join("")}</div>`;
  pop.onclick = (e) => {
    const sw = e.target.closest(".swatch");
    const sz = e.target.closest(".size");
    if (sw) st.color = sw.dataset.c;
    else if (sz) st.width = +sz.dataset.w;
    else return;
    applyStyles();
    setTool(tool);
    popAnchor = null;
    openStylePopover();
  };
  popAnchor = anchor;
  placePopover(anchor);
}

document.addEventListener("pointerdown", (e) => {
  if (!pop.hidden && !pop.contains(e.target) && !(popAnchor instanceof Element && popAnchor.contains(e.target))) closePopover();
}, true);

// ------------------------------------------------------------------ dialogs + toasts
const modal = $("#modal");
function dialog({ title, message = "", html = "", input = null, buttons }) {
  return new Promise((resolve) => {
    modal.innerHTML = "";
    const d = document.createElement("div");
    d.className = "dialog";
    d.innerHTML = `<h2></h2>${message ? "<p></p>" : ""}${html}${input ? `<input type="${input.type || "text"}">` : ""}<div class="row"></div>`;
    d.querySelector("h2").textContent = title;
    if (message) d.querySelector("p").textContent = message;
    const inp = d.querySelector("input");
    if (inp && input.value) inp.value = input.value;
    const row = d.querySelector(".row");
    const done = (v) => { modal.hidden = true; modal.innerHTML = ""; document.removeEventListener("keydown", onKey, true); resolve(v); };
    for (const b of buttons) {
      const el = document.createElement("button");
      el.className = "btn" + (b.primary ? " primary" : "");
      el.textContent = b.label;
      el.onclick = () => done(inp && b.primary ? inp.value : b.id);
      row.appendChild(el);
    }
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); done(inp ? null : "cancel"); }
      else if (e.key === "Enter") { e.stopPropagation(); e.preventDefault(); const p = buttons.find((b) => b.primary); done(inp ? inp.value : p ? p.id : "cancel"); }
    };
    document.addEventListener("keydown", onKey, true);
    modal.appendChild(d);
    modal.hidden = false;
    (inp || row.querySelector(".primary"))?.focus();
  });
}

function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.innerHTML = (kind === "error" ? "" : icon("check")) + "<span></span>";
  t.querySelector("span").textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), kind === "error" ? 5000 : 1800);
}

function showHelp() {
  const rows = [
    ["Finger drag", "Pan (flick to glide)"], ["Two-finger pinch", "Zoom around your fingers"], ["Double-tap", "Zoom in / back to fit width"],
    ["Pen", "Draw with the selected tool"], ["Pen eraser end / side button", "Erase"], ["Ctrl+S", "Save into the PDF"],
    ["Ctrl+Z / Ctrl+Y", "Undo / redo"], ["H  M  P  B  E", "Pan, highlight, pen, box, eraser"], ["T", "Toggle finger drawing"],
    ["Ctrl+wheel, Ctrl + / −", "Zoom"], ["Ctrl+0 / Ctrl+9", "Fit width / fit page"], ["PgUp / PgDn, Space", "Scroll a screen"],
    ["Alt+↑ / Alt+↓", "Previous / next PDF in the list"], ["Ctrl+F", "Filter the file list"], ["Ctrl+B", "Show / hide the file list"],
  ];
  dialog({
    title: "Touch, pen and keyboard",
    html: `<div class="shortcuts">${rows.map(([k, v]) => `<kbd>${k}</kbd><span>${v}</span>`).join("")}</div>`,
    buttons: [{ id: "ok", label: "Close", primary: true }],
  });
}

// ------------------------------------------------------------------ files
function baseName(p) { return p ? p.split(/[\\/]/).pop() : ""; }

function updateTitle() {
  const name = state.path ? baseName(state.path).replace(/\.pdf$/i, "") : "Inkleaf PDF";
  $("#title-text").textContent = name;
  document.title = (viewer.dirty ? "• " : "") + (state.path ? name + " — Inkleaf PDF" : "Inkleaf PDF");
}

let viewTimer = 0;
function rememberView() {
  if (!state.path) return;
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    const v = viewer.viewState();
    if (!v || !state.path) return;
    delete cfg.files[state.path];
    cfg.files[state.path] = v;
    const keys = Object.keys(cfg.files);
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete cfg.files[k];
    saveCfg();
  }, 400);
}

async function confirmDiscard() {
  if (!viewer.dirty) return true;
  const r = await dialog({
    title: "Save changes?",
    message: `“${baseName(state.path)}” has annotations that aren't saved yet.`,
    buttons: [{ id: "cancel", label: "Cancel" }, { id: "discard", label: "Don't save" }, { id: "save", label: "Save", primary: true }],
  });
  if (r === "save") { await save(); return !viewer.dirty; }
  return r === "discard";
}

async function openFile(path, { force = false } = {}) {
  if (!path) return;
  if (path === state.path && !force) { if (narrow()) toggleSidebar(false); return; }
  if (!(await confirmDiscard())) return;
  closePopover();
  const gen = ++state.gen;
  viewer.close();
  engine.close();
  state.path = path;
  cfg.lastFile = path;
  saveCfg();
  sidebar.setCurrent(path);
  appEl.classList.remove("no-doc");
  updateTitle();
  const spin = setTimeout(() => appEl.classList.add("loading"), 120);
  try {
    let st = null;
    try { st = await host.stat(path); } catch {}
    state.mtime = st?.mtime || 0;
    const url = host.fileUrl(path);
    let res = await engine.open(url, null, st?.size || 0);
    while (res.needsPassword) {
      clearTimeout(spin);
      appEl.classList.remove("loading");
      const pw = await dialog({ title: "Password required", message: `“${baseName(path)}” is protected. Enter its password:`, input: { type: "password" }, buttons: [{ id: "cancel", label: "Cancel" }, { id: "ok", label: "Open", primary: true }] });
      if (pw == null || pw === "cancel") throw new Error("cancelled");
      res = await engine.open(url, pw, st?.size || 0);
    }
    if (gen !== state.gen) return;
    if (!res.pages.length) throw new Error("this PDF has no pages");
    viewer.open(gen, res.pages, cfg.files[path]);
    viewer.setTool(cfg.tool);
    $("#zoom-label").textContent = Math.round((viewer.scale * 72 / 96) * 100) + "%";
    if (narrow()) toggleSidebar(false);
  } catch (err) {
    if (gen !== state.gen) return;
    state.path = null;
    viewer.close();
    appEl.classList.add("no-doc");
    $("#empty-msg").textContent = err.message === "cancelled" ? "Pick a PDF from the list." : `Couldn't open “${baseName(path)}”: ${err.message}`;
    updateTitle();
  } finally {
    clearTimeout(spin);
    if (gen === state.gen) appEl.classList.remove("loading");
  }
}

async function save({ as = false } = {}) {
  if (!state.path || state.saving) return;
  if (!as && !viewer.dirty) { toast("No changes to save"); return; }
  state.saving = true;
  $("#btn-save").classList.add("saving");
  const seq = viewer.historySeq;
  const path = state.path;
  let failure = null, retryAs = false, skip = false;
  try {
    const out = await engine.save("incremental");
    if (!out) throw new Error("Document closed");
    if (as) {
      const target = await host.saveAs(path, out.bytes);
      if (target) {
        state.path = target;
        state.mtime = (await host.stat(target).catch(() => null))?.mtime || 0;
        cfg.lastFile = target;
        sidebar.setCurrent(target);
        viewer.markSaved(seq);
        toast("Saved as " + baseName(target));
      }
    } else {
      // Don't silently clobber edits another program made after we opened the file.
      const cur = await host.stat(path).catch(() => null);
      if (cur && state.mtime && Math.abs(cur.mtime - state.mtime) > 2) {
        const r = await dialog({
          title: "File changed on disk",
          message: `“${baseName(path)}” was changed by another program after you opened it. Saving here will replace those changes.`,
          buttons: [{ id: "cancel", label: "Cancel" }, { id: "as", label: "Save as…" }, { id: "overwrite", label: "Overwrite", primary: true }],
        });
        if (r === "as") retryAs = true;
        if (r !== "overwrite") skip = true;
      }
      if (!skip) {
        const r = await host.writeFile(path, out.bytes);
        if (!r || !r.ok) throw new Error(r?.error || "Write failed");
        const after = await host.stat(path).catch(() => null);
        if (after) state.mtime = after.mtime;
        viewer.markSaved(seq);
        toast("Saved");
      }
    }
    updateTitle();
  } catch (err) {
    failure = err;
  } finally {
    state.saving = false;
    $("#btn-save").classList.remove("saving");
  }
  if (retryAs) return save({ as: true });
  if (failure) {
    const r = await dialog({
      title: "Couldn't save",
      message: `${failure.message}\n\nThe file may be open in another app or in a read-only folder.`,
      buttons: [{ id: "cancel", label: "Close" }, { id: "as", label: "Save as…", primary: true }],
    });
    if (r === "as") await save({ as: true });
  }
}

async function loadFolder(dir, useCache) {
  sidebar.setRoot(dir);
  if (useCache) {
    const cache = await host.readJson("tree").catch(() => null);
    if (cache && cache.root === dir && cache.tree) {
      sidebar.setTree(cache.tree, cfg.expanded[dir]);
      sidebar.setCurrent(state.path);
    }
  }
  sidebar.foot.classList.add("scanning");
  try {
    const tree = await host.scanFolder(dir);
    sidebar.foot.classList.remove("scanning");
    if (cfg.folder !== dir) return;
    sidebar.setTree(tree, cfg.expanded[dir]);
    if (!cfg.expanded[dir]) { cfg.expanded[dir] = [...sidebar.expanded]; saveCfg(); }
    sidebar.setCurrent(state.path);
    host.writeJson("tree", { root: dir, tree });
    host.watchFolder(dir);
  } catch (err) {
    sidebar.foot.classList.remove("scanning");
    toast("Couldn't read folder: " + err.message, "error");
  }
}

async function pickFolder() {
  const dir = await host.pickFolder();
  if (!dir) return;
  cfg.folder = dir;
  saveCfg();
  toggleSidebar(true);
  await loadFolder(dir, false);
}

async function pickFile() {
  const p = await host.pickFile();
  if (p) openFile(p);
}

function stepFile(dir) {
  const files = sidebar.orderedFiles();
  if (!files.length) return;
  const k = files.indexOf(state.path);
  const next = files[(k < 0 ? (dir > 0 ? -1 : 0) : k) + dir];
  if (next) openFile(next);
}

// ------------------------------------------------------------------ page pill
pagePill.onclick = () => {
  if (!viewer.pageCount || pagePill.querySelector("input")) return;
  const n = viewer.pageCount;
  pagePill.innerHTML = `<input type="number" min="1" max="${n}" value="${viewer.currentPage() + 1}"> / ${n}`;
  const inp = pagePill.querySelector("input");
  inp.focus();
  inp.select();
  let closed = false;
  const finish = (go) => {
    if (closed) return;
    closed = true;
    const v = parseInt(inp.value, 10);
    pagePill.textContent = `${viewer.currentPage() + 1} / ${n}`;
    if (go && v >= 1 && v <= n) viewer.goToPage(v - 1);
  };
  inp.onkeydown = (e) => { if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); e.stopPropagation(); };
  inp.onblur = () => finish(false);
};
let idleTimer = 0;
function pokeIdle() {
  appEl.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => appEl.classList.add("idle"), 2200);
}

// ------------------------------------------------------------------ sidebar resize
{
  const rz = $("#resizer");
  document.documentElement.style.setProperty("--sb-w", cfg.sidebarW + "px");
  rz.addEventListener("pointerdown", (e) => {
    rz.setPointerCapture(e.pointerId);
    rz.classList.add("active");
    const move = (ev) => {
      cfg.sidebarW = Math.round(Math.max(200, Math.min(640, ev.clientX)));
      document.documentElement.style.setProperty("--sb-w", cfg.sidebarW + "px");
    };
    const up = () => { rz.classList.remove("active"); rz.removeEventListener("pointermove", move); saveCfg(); };
    rz.addEventListener("pointermove", move);
    rz.addEventListener("pointerup", up, { once: true });
  });
}

// ------------------------------------------------------------------ keyboard
document.addEventListener("keydown", (e) => {
  if (!modal.hidden) return;
  const typing = e.target.closest?.("input, textarea");
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl && k === "s") { e.preventDefault(); save({ as: e.shiftKey }); return; }
  if (ctrl && k === "o") { e.preventDefault(); pickFolder(); return; }
  if (ctrl && k === "f") { e.preventDefault(); toggleSidebar(true); sidebar.input.focus(); sidebar.input.select(); return; }
  if (ctrl && k === "b") { e.preventDefault(); toggleSidebar(); return; }
  if (e.key === "F11") { e.preventDefault(); host.toggleFullscreen(); return; }
  if (typing) return;
  if (ctrl && k === "z") { e.preventDefault(); if (e.shiftKey) viewer.redo(); else viewer.undo(); return; }
  if (ctrl && k === "y") { e.preventDefault(); viewer.redo(); return; }
  if (ctrl && (k === "=" || k === "+")) { e.preventDefault(); viewer.zoomBy(1.25); return; }
  if (ctrl && k === "-") { e.preventDefault(); viewer.zoomBy(0.8); return; }
  if (ctrl && k === "0") { e.preventDefault(); viewer.fit("width"); return; }
  if (ctrl && k === "9") { e.preventDefault(); viewer.fit("page"); return; }
  if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); stepFile(e.key === "ArrowDown" ? 1 : -1); return; }
  if (ctrl || e.altKey) return;
  const vh = viewer.vh;
  switch (e.key) {
    case "ArrowDown": viewer.scrollBy(0, 60); break;
    case "ArrowUp": viewer.scrollBy(0, -60); break;
    case "ArrowRight": viewer.L && viewer.L.worldW > viewer.vw ? viewer.scrollBy(60, 0) : viewer.pageStep(1); break;
    case "ArrowLeft": viewer.L && viewer.L.worldW > viewer.vw ? viewer.scrollBy(-60, 0) : viewer.pageStep(-1); break;
    case "PageDown": viewer.scrollBy(0, vh * 0.9); break;
    case "PageUp": viewer.scrollBy(0, -vh * 0.9); break;
    case " ": viewer.scrollBy(0, (e.shiftKey ? -1 : 1) * vh * 0.9); break;
    case "Home": viewer.goToPage(0); break;
    case "End": viewer.goToPage(viewer.pageCount - 1); break;
    case "h": case "v": setTool("hand"); break;
    case "m": setTool("highlight"); break;
    case "p": setTool("pen"); break;
    case "b": setTool("box"); break;
    case "e": setTool("eraser"); break;
    case "t": setTouchDraws(!cfg.touchDraws); break;
    case "Escape": closePopover(); break;
    default: return;
  }
  e.preventDefault();
});

// ------------------------------------------------------------------ drag & drop
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  const p = f && host.pathForFile(f);
  if (!p) return;
  const st = await host.stat(p).catch(() => null);
  if (st?.isDirectory) { cfg.folder = p; saveCfg(); toggleSidebar(true); loadFolder(p, false); }
  else if (/\.pdf$/i.test(p)) openFile(p);
});

// ------------------------------------------------------------------ host events
host.onFolderChanged(() => { if (cfg.folder) loadFolder(cfg.folder, false); });
host.onOpenFile((p) => openFile(p));
host.onCloseRequest(async () => {
  if (await confirmDiscard()) {
    const v = viewer.viewState();
    if (v && state.path) cfg.files[state.path] = v;
    await saveCfg(true);
    host.confirmClose();
  }
});

// ------------------------------------------------------------------ start
appEl.classList.add("no-doc");
toggleSidebar(cfg.sidebarOpen);
applyStyles();
setTool(cfg.tool);
setTouchDraws(cfg.touchDraws);
viewer.cb.onHistory(false, false, false);
$("#zoom-label").textContent = "–";

const startFile = host.initialFile || cfg.lastFile;
if (host.platform === "web" && new URLSearchParams(location.search).get("folder")) {
  cfg.folder = new URLSearchParams(location.search).get("folder");
}
if (cfg.folder) loadFolder(cfg.folder, true);
else sidebar.setRoot(null), sidebar.setTree(null);
if (startFile) {
  const st = await host.stat(startFile).catch(() => null);
  if (st && !st.isDirectory) openFile(startFile);
}
if (!state.path) $("#empty-msg").textContent = cfg.folder ? "Pick a PDF from the list on the left." : "Open a folder to see every PDF inside it, including subfolders.";

// Expose for automated tests.
window.__inkleaf = { viewer, engine, sidebar, state, cfg, openFile, save };
