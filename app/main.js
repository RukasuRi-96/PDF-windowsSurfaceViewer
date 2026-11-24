import { host } from "./host.js";
import { Engine } from "./engine.js";
import { Viewer, cssColor, penActive } from "./viewer.js";
import { Sidebar } from "./sidebar.js";
import { PagesPanel, moveOrder } from "./pages.js";
import { MarkupsPanel } from "./markups.js";
import { icon } from "./icons.js";
import { Keymap, comboFromEvent, formatCombo } from "./shortcuts.js";
import { loadSignatureImage, analyzeSignature, removeBackground, signaturePng, fromDataUrl, imageMime, IMAGE_EXT } from "./sigproc.js";
import { UNITS, METRIC_RATIOS, IMPERIAL_SCALES, DEFAULT_SCALE, ratioScale, imperialScale, calibratedScale, fmtLength, ratioOf, sameScale } from "./measure.js";

const $ = (s) => document.querySelector(s);
const appEl = $("#app");

// ------------------------------------------------------------------ config
const cfg = Object.assign(
  {
    folder: null,
    expanded: {},
    lastFile: null,
    files: {},
    tool: "select",
    styles: null,
    touchDraws: false,
    wheel: "scroll",      // or "zoom"
    measure: null,
    scales: {},           // path -> { all: scale, pages: { index: scale } }
    sidebarOpen: true,
    pagesOpen: false,     // the panel on the right (Pages, Markups, Search)
    panelTab: "pages",
    autosave: false,      // save by itself a few seconds after changes
    autoUpdate: true,     // look for a new version at start (installed app)
    ribbon: {},           // toolbar buttons shown or hidden (id -> bool)
    blankSize: "A4",      // last size chosen for a blank page
    pageLabels: "both",   // pages show their number, name or both
    sidebarW: 300,
    shape: "box",         // box tool: box | line | arrow | cloud | callout | text
    textStyle: null,
    sigFolder: null,      // folder of signature images
    lastSig: null,        // id of the signature placed last
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
  { pen: { color: "#1d4ed8", width: 1.5 }, highlight: { color: "#ffe11a", width: 12, mode: "words" }, box: { color: "#dc2626", width: 2 } },
  cfg.styles || {}
);
cfg.textStyle = Object.assign({ size: 12, fillText: false, fillCallout: true }, cfg.textStyle || {});
const SHAPES = [["box", "square", "Box"], ["line", "line", "Line"], ["arrow", "arrow", "Arrow"], ["cloud", "cloud", "Cloud"], ["callout", "callout", "Callout"], ["text", "text", "Text"]];
if (!SHAPES.some(([k]) => k === cfg.shape)) cfg.shape = "box";
delete cfg.contentMode; // 1.4.0 had two modes; the tool now does both
const CONTENT_HINT = "Drag a box to erase an area · tap a line of text to retype it";
const TEXT_SIZES = [9, 12, 18, 28];
cfg.measure = Object.assign({ mode: "distance", color: "#ea580c", dp: null, unit: "mm" }, cfg.measure || {});
cfg.scales = cfg.scales || {};
const MEASURE_COLORS = ["#ea580c", "#dc2626", "#c026d3", "#1d4ed8", "#16a34a", "#111111"];

// ------------------------------------------------------------------ setup
if (host.platform === "win32") document.documentElement.classList.add("wco");
// Render workers run in parallel; each holds its own copy of the open PDF, so
// machines with 8 GB of RAM or less get at most 3 (plus the edit worker).
// PDFs opened side by side get two each.
const hc = navigator.hardwareConcurrency || 4;
const mem = navigator.deviceMemory || 8;
const WORKER = new URL("./worker.js", import.meta.url);
const MAIN_RENDERERS = Math.max(2, Math.min(mem <= 8 ? 3 : 4, Math.floor(hc / 3)));
const MAX_PANES = 4;

// ------------------------------------------------------------------ open PDFs
// Every open PDF is a pane with its own engine, view, file and undo history.
// Several can sit side by side and they all work the same way: the toolbar,
// keys, Pages panel, title and Save act on the active one, which is the PDF
// touched last. `engine`, `viewer`, `state` and `docHist` are always the
// active pane's; async work that must stay with one pane keeps its own.
const panes = [];
let active = null, engine = null, viewer = null, state = null, docHist = null;
let paneSeq = 0;
const panesEl = $("#panes");
const samePath = (a, b) => !!a && !!b && (host.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

function createPane(at = panes.length) {
  const el = document.createElement("div");
  el.className = "pane";
  el.innerHTML = `<div class="pane-head" title="Drag to move this PDF"><span class="pane-grip">${icon("grip")}</span><span class="pane-name"></span><span class="pane-dot" title="Unsaved changes"></span><span class="pane-page"></span>` +
    `<button class="btn icon-btn" data-act="menu" title="More">${icon("more")}</button><button class="btn icon-btn" data-act="close" title="Close this PDF">${icon("x")}</button></div><div class="pane-view"></div>`;
  const P = {
    id: ++paneSeq, el, weight: 1, busy: false,
    head: el.querySelector(".pane-head"), view: el.querySelector(".pane-view"),
    state: { path: null, gen: 0, saving: false, mtime: 0 },
    docHist: { undo: [], redo: [] },
  };
  panesEl.appendChild(el);
  P.engine = new Engine(WORKER, panes.length ? 2 : MAIN_RENDERERS);
  P.engine.ready().then(() => P.engine.setAuthor(host.userName || "")).catch(() => {});
  P.viewer = new Viewer(P.view, P.engine, paneCallbacks(P));
  for (const b of P.viewer.selBar.querySelectorAll("[data-act]")) b.innerHTML = icon(b.dataset.act === "copy" ? "copy" : "highlighter") + `<span>${b.textContent}</span>`;
  applyStylesTo(P.viewer);
  P.viewer.setTool(cfg.tool);
  P.viewer.touchDraws = cfg.touchDraws;
  P.viewer.wheelZooms = cfg.wheel === "zoom";
  // Touching a PDF makes it the active one, before the touch does anything
  // (not a palm resting on it while the pen writes in another one).
  el.addEventListener("pointerdown", (e) => { if (!(e.pointerType === "touch" && penActive())) activate(P); }, true);
  P.head.addEventListener("pointerdown", (e) => paneHeadDown(P, e));
  P.head.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b?.dataset.act === "close") closePane(P);
    else if (b?.dataset.act === "menu") paneMenu(P, b);
  });
  panes.splice(at, 0, P);
  layoutPanes();
  return P;
}

function paneCallbacks(P) {
  const on = () => P === active;
  return {
    onPage(i, n) {
      updatePaneHead(P);
      rememberView(P);
      if (!on()) return;
      pagesPanel.setCurrent(i);
      showPagePill(i, n);
      if (cfg.tool === "measure") updateMeasureBar();
      pokeIdle();
    },
    onZoom(scale) {
      rememberView(P);
      if (on()) $("#zoom-label").textContent = Math.round((scale * 72 / 96) * 100) + "%";
    },
    onMeasure: (st) => { if (on()) updateMeasureBar(st); },
    onCalibrate: (page, lengthPt) => { activate(P); calibrateDialog(page, lengthPt); },
    scaleFor: (i) => scaleOf(P.state.path, i),
    onCopy: (text) => copyText(text),
    onError: (msg) => toast(msg, "error"),
    onInfo: (msg) => toast(msg),
    onSnip: (s) => snipFrom(P.engine, s),
    // The installed font matching a PDF font, for retyping a line in it.
    findFont: async (face) => {
      const f = host.findFont ? await host.findFont({ name: face.name, bold: face.bold, italic: face.italic }) : null;
      return f && f.file ? { ...f, url: host.fileUrl(f.file) } : null;
    },
    onSignTap: (page, p, hit) => { activate(P); signTap(page, p, hit); },
    onSigned: (sig, rect) => signed(sig, rect),
    onPlacing: (placing) => appEl.classList.toggle("placing", placing),
    onShapeSelect: () => {
      if (!on()) return;
      updateStyleButton();
      if (!pop.hidden && popAnchor === $("#btn-style") && cfg.tool === "select") closePopover();
    },
    onHistory(canUndo, canRedo, dirty) {
      P.el.classList.toggle("dirty", dirty);
      if (dirty) scheduleAutosave(P);
      if (!on()) return;
      updateUndoButtons();
      appEl.classList.toggle("dirty", dirty);
      updateTitle();
    },
    // A new edit: page changes that were undone can no longer be redone.
    onEdit: () => { P.docHist.redo = []; if (on()) updateUndoButtons(); },
    // A finger held on the page (or a right-click): the page menu.
    onHold: (h) => { activate(P); pageHoldMenu(P, h); },
    // Snip tool: a tap puts the copied picture there.
    onSnipTap: (page, p) => { activate(P); paste({ at: { page, p }, picture: true }); },
    // Markups on page i changed (for the markups list).
    onMarks: (i) => {
      (P.markPages ||= new Set()).add(i);
      clearTimeout(P.markTimer);
      P.markTimer = setTimeout(() => { const s = P.markPages; P.markPages = null; markupsPanel.invalidate(P.id, s); }, 250);
    },
    // The bar over markups selected with the lasso.
    onGroupAction: (act) => { activate(P); if (act === "copy") copyMarks(); else if (act === "duplicate") duplicateMarks(); },
  };
}

// Make P the PDF the toolbar, keys and Pages panel work on.
function activate(P) {
  if (!P || P === active || !panes.includes(P)) return;
  const prev = active;
  if (prev) {
    const v = prev.viewer;
    v.commitEdits();
    if (v.placing) v.finishPlacing(true);
    if (v.selectedShape) v.deselectShape();
    if (v.mdraft || v._calibrating) v.cancelMeasure();
    prev.el.classList.remove("active");
  }
  active = P;
  ({ engine, viewer, state, docHist } = P);
  P.el.classList.add("active");
  syncActive();
  if (prev) saveSession();
}

// The toolbar, title, page counter and Pages panel show the active PDF.
function syncActive() {
  const P = active;
  P.el.append(pagePill, mbar, findbar);
  pagesPanel.switchTo(engine, P.id, viewer.doc ? viewer.doc.pages : [], viewer.doc ? viewer.currentPage() : 0);
  if (viewer.doc) markupsPanel.setDocument(P.id, viewer.pageCount); else markupsPanel.clear();
  findSync();
  updateUndoButtons();
  appEl.classList.toggle("dirty", !!viewer.dirty);
  updateTitle();
  $("#zoom-label").textContent = viewer.doc ? Math.round((viewer.scale * 72 / 96) * 100) + "%" : "–";
  if (viewer.doc) showPagePill(viewer.currentPage(), viewer.pageCount);
  updateMeasureBar();
  updateStyleButton();
  sidebar.setCurrent(state.path);
  if (state.path) cfg.lastFile = state.path;
  appEl.classList.toggle("no-doc", !state.path && panes.length === 1);
}

function updatePaneHead(P) {
  const name = P.state.path ? baseName(P.state.path).replace(/\.pdf$/i, "") : "";
  const n = P.head.querySelector(".pane-name");
  n.textContent = name;
  n.title = P.state.path || "";
  P.el.classList.toggle("dirty", !!P.viewer.dirty);
  const v = P.viewer;
  P.head.querySelector(".pane-page").textContent = v.doc ? pageText(v, v.currentPage(), v.pageCount) : "";
}

// Side by side, left to right (top to bottom when the window is taller than
// wide), with a divider between each two to share out the room.
function layoutPanes() {
  const kids = [];
  panes.forEach((P, k) => {
    if (k) kids.push(P.split ||= makeSplit(P));
    P.el.style.flex = `${P.weight} 1 0`;
    kids.push(P.el);
  });
  const cur = [...panesEl.children];
  if (cur.length !== kids.length || cur.some((c, i) => c !== kids[i])) panesEl.replaceChildren(...kids);
  panesEl.classList.toggle("multi", panes.length > 1);
  for (const P of panes) P.viewer.setShare(panes.length);
  paneOrientation();
}
function paneOrientation() {
  const r = $("#stage").getBoundingClientRect();
  panesEl.classList.toggle("vertical", panes.length > 1 && r.height > r.width * 1.1);
}
window.addEventListener("resize", paneOrientation);

// The divider before pane P: drag it to give either neighbour more room.
function makeSplit(P) {
  const bar = document.createElement("div");
  bar.className = "pane-split";
  bar.title = "Drag to resize";
  bar.addEventListener("pointerdown", (e) => {
    const k = panes.indexOf(P);
    if (k < 1) return;
    e.preventDefault();
    const A = panes[k - 1], B = P, vert = panesEl.classList.contains("vertical");
    const ra = A.el.getBoundingClientRect(), rb = B.el.getBoundingClientRect();
    const start = vert ? ra.top : ra.left, total = vert ? rb.bottom - ra.top : rb.right - ra.left;
    const sum = A.weight + B.weight;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("active");
    const move = (ev) => {
      const f = Math.max(0.15, Math.min(0.85, ((vert ? ev.clientY : ev.clientX) - start) / total));
      A.weight = sum * f;
      B.weight = sum - A.weight;
      A.el.style.flex = `${A.weight} 1 0`;
      B.el.style.flex = `${B.weight} 1 0`;
    };
    const up = () => {
      bar.classList.remove("active");
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", up);
      saveSession();
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
  });
  return bar;
}

// Drag a PDF's title bar (finger, pen or mouse) to move it to another place.
function paneHeadDown(P, e) {
  if (e.button !== 0 || e.target.closest("button") || panes.length < 2) return;
  const head = P.head, x0 = e.clientX, y0 = e.clientY;
  try { head.setPointerCapture(e.pointerId); } catch {}
  let D = null;
  const move = (ev) => {
    if (!D) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 10) return;
      D = { ghost: document.createElement("div"), mark: document.createElement("div"), to: -1 };
      D.ghost.className = "pane-ghost";
      D.ghost.textContent = P.head.querySelector(".pane-name").textContent || "PDF";
      D.mark.className = "pane-drop";
      document.body.append(D.ghost, D.mark);
      P.el.classList.add("moving");
    }
    D.ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
    const vert = panesEl.classList.contains("vertical"), pos = vert ? ev.clientY : ev.clientX;
    let to = panes.length;
    for (let k = 0; k < panes.length; k++) {
      const r = panes[k].el.getBoundingClientRect();
      if (pos < (vert ? r.top + r.height / 2 : r.left + r.width / 2)) { to = k; break; }
    }
    D.to = to;
    const ref = panes[Math.min(to, panes.length - 1)].el.getBoundingClientRect(), sr = panesEl.getBoundingClientRect();
    const edge = to < panes.length ? (vert ? ref.top : ref.left) : (vert ? ref.bottom : ref.right);
    D.mark.className = "pane-drop" + (vert ? " v" : "");
    D.mark.style.cssText = vert ? `left:${sr.left}px;width:${sr.width}px;top:${edge - 2}px` : `top:${sr.top}px;height:${sr.height}px;left:${edge - 2}px`;
  };
  const up = (ev) => {
    head.removeEventListener("pointermove", move);
    head.removeEventListener("pointerup", up);
    head.removeEventListener("pointercancel", up);
    if (!D) return;
    D.ghost.remove();
    D.mark.remove();
    P.el.classList.remove("moving");
    if (ev.type === "pointerup") movePane(P, D.to);
  };
  head.addEventListener("pointermove", move);
  head.addEventListener("pointerup", up);
  head.addEventListener("pointercancel", up);
}

// Put pane P before position `to` (panes.length: at the end).
function movePane(P, to) {
  const k = panes.indexOf(P);
  if (k < 0 || to === k || to === k + 1) return;
  panes.splice(k, 1);
  panes.splice(to > k ? to - 1 : to, 0, P);
  layoutPanes();
  saveSession();
}

function paneMenu(P, anchor) {
  const k = panes.indexOf(P), vert = panesEl.classList.contains("vertical");
  showMenu(anchor, [
    { label: "Open another PDF here…", icon: "openFile", run: async () => { const p = await host.pickFile(); if (p) { activate(P); openFile(p); } } },
    { label: "Open a PDF side by side…", icon: "columns", key: keyOf("view.side"), run: () => { activate(P); openBeside(null); }, disabled: panes.length >= MAX_PANES },
    "-",
    { label: vert ? "Move up" : "Move left", icon: vert ? "moveUp" : "moveLeft", run: () => movePane(P, k - 1), disabled: k === 0 },
    { label: vert ? "Move down" : "Move right", icon: vert ? "moveDown" : "moveRight", run: () => movePane(P, k + 2), disabled: k === panes.length - 1 },
    "-",
    { label: "Close this PDF", icon: "x", key: keyOf("view.closePane"), run: () => closePane(P) },
  ]);
}

// Close a PDF (asking to save first). Side by side, its pane goes and the
// others share the room; the last one stays, empty.
async function closePane(P = active) {
  if (!P || !panes.includes(P)) return;
  if (!(await confirmDiscard(P))) return;
  storeView(P);
  if (panes.length === 1) { closeDocument(P); saveSession(); return; }
  removePane(P);
}

function removePane(P) {
  const k = panes.indexOf(P);
  if (k < 0) return;
  panes.splice(k, 1);
  P.state.gen++;
  clearTimeout(P.viewTimer);
  P.viewer.destroy();
  P.engine.destroy();
  P.el.remove();
  P.split?.remove();
  clearTimeout(P.autoTimer);
  if (active === P) { active = null; activate(panes[Math.min(k, panes.length - 1)]); }
  pagesPanel.forget(P.id);
  markupsPanel.forget(P.id);
  layoutPanes();
  saveSession();
}

function closeDocument(P) {
  P.state.gen++;
  P.viewer.close();
  P.engine.close();
  P.state.path = null;
  P.docHist.undo = []; P.docHist.redo = [];
  P.find = null;
  updatePaneHead(P);
  markupsPanel.forget(P.id);
  if (P !== active) return;
  pagesPanel.clear();
  $("#empty-msg").textContent = cfg.folder ? "Pick a PDF from the list on the left." : "Open a folder to see every PDF inside it, including subfolders.";
  syncActive();
}

// Open a PDF next to the active one (or in it, if it's empty).
async function openBeside(path) {
  closePopover();
  path = path || (await host.pickFile());
  if (!path) return;
  const open = panes.find((Q) => samePath(Q.state.path, path));
  if (open) { activate(open); toast(`“${baseName(path)}” is already open`); return; }
  if (!state.path) { openFile(path); return; }
  if (panes.length >= MAX_PANES) { toast(`Up to ${MAX_PANES} PDFs side by side: close one first (×)`, "error"); return; }
  const P = createPane(panes.indexOf(active) + 1);
  activate(P);
  await openIn(P, path);
}

function cyclePane(dir) {
  if (panes.length < 2) return;
  activate(panes[(panes.indexOf(active) + dir + panes.length) % panes.length]);
}

const paneAt = (x, y) => panes.find((Q) => { const r = Q.el.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; });

// The open PDFs, for the next start.
let restoring = false;
function saveSession() {
  if (restoring) return;
  const open = panes.filter((Q) => Q.state.path);
  cfg.openFiles = open.map((Q) => Q.state.path);
  cfg.paneWeights = open.map((Q) => Math.round(Q.weight * 1000) / 1000);
  cfg.activeFile = state?.path || null;
  if (state?.path) cfg.lastFile = state.path;
  saveCfg();
}

{
  const first = createPane();
  active = first;
  ({ engine, viewer, state, docHist } = first);
  first.el.classList.add("active");
}

// Undo/redo of page changes (delete, add, move...): the whole document as it
// was before each one. Annotation edits made since then are undone first.
function updateUndoButtons() {
  $("#btn-undo").disabled = !(viewer.canUndo || docHist.undo.length);
  $("#btn-redo").disabled = !(viewer.canRedo || docHist.redo.length);
}
function undo() {
  if (viewer.canUndo) viewer.undo();
  else if (docHist.undo.length) restoreDoc(active, docHist.undo, docHist.redo, "Page change undone");
}
function redo() {
  if (viewer.canRedo) viewer.redo();
  else if (docHist.redo.length) restoreDoc(active, docHist.redo, docHist.undo, "Page change redone");
}

const pagesPanel = new PagesPanel($("#pages"), engine, {
  onGo: (i) => viewer.goToPage(i),
  onDelete: (list) => deletePages(list),
  onMove: (order, moved) => movePages(order, moved),
  onMenu: (i, x, y) => pageMenu({ x, y }),
  onAddMenu: (anchor) => addPagesMenu(anchor),
  onLabelsMenu: (anchor) => showMenu(anchor, [["number", "Page numbers"], ["name", "Page names"], ["both", "Numbers and names"]].map(([k, label]) => ({
    label, icon: cfg.pageLabels === k ? "check" : null, run: () => setPageLabels(k),
  }))),
  onClose: () => togglePages(false),
  // Pages dragged out of the panel onto another open PDF are copied there.
  onDragOut: (x, y) => {
    const T = x == null ? null : panes.find((Q) => Q !== active && Q.state.path && Q === paneAt(x, y));
    for (const Q of panes) Q.el.classList.toggle("drop-target", Q === T);
    return T ? { pane: T } : null;
  },
  onDropOut: (list, out) => copyPagesTo(active, list, out.pane),
});

const markupsPanel = new MarkupsPanel($("#marks"), {
  load: (key, from, to) => { const P = panes.find((Q) => Q.id === key); return P && P.viewer.doc ? P.engine.markList(from, to) : Promise.resolve([]); },
  onPick: (it) => { viewer.revealMark(it.page, it.id); },
  pageLabel: (i) => { const name = viewer.doc?.pages[i]?.name; return name ? `Page ${i + 1} · ${name}` : `Page ${i + 1}`; },
});
const sidebar = new Sidebar($("#sidebar"), {
  onOpen: (p) => openFile(p),
  onPickFolder: () => pickFolder(),
  onRefresh: () => cfg.folder && loadFolder(cfg.folder, false),
  onExpanded: (list) => { if (cfg.folder) { cfg.expanded[cfg.folder] = list; saveCfg(); } },
  onContext: (p, x, y, isFile, picks) => fileMenu({ x, y }, p, isFile, picks),
  onMerge: (list) => mergeDialog(list),
});

// ------------------------------------------------------------------ toolbar
const setIcon = (sel, name) => { $(sel).innerHTML = icon(name); };
setIcon("#btn-sidebar", "sidebar");
setIcon("#btn-pages", "pages");
setIcon("#btn-undo", "undo");
setIcon("#btn-redo", "redo");
setIcon("#btn-zoomout", "zoomOut");
setIcon("#btn-zoomin", "zoomIn");
setIcon("#btn-fitw", "fitWidth");
setIcon("#btn-fitp", "fitPage");
setIcon("#btn-save", "save");
setIcon("#btn-more", "more");
setIcon("#btn-touch", "touch");
setIcon("#btn-paste", "clipboard");
setIcon("#btn-search", "search");
setIcon("#btn-side", "columns");
setIcon("#btn-full", "maximize");
setIcon("#btn-marks", "stickyNote");
setIcon("#btn-autosave", "autosave");
setIcon("#find-prev", "up");
setIcon("#find-next", "down");
setIcon("#find-list", "list");
setIcon("#find-close", "x");
document.querySelector("#rpanel .rp-close").innerHTML = icon("x");
$("#empty-open").innerHTML = icon("folderOpen") + " Open folder";
const TOOL_ICONS = { select: "select", hand: "hand", highlight: "highlighter", pen: "pen", box: "square", eraser: "eraser", measure: "ruler", sign: "signature", content: "replaceText", snip: "scissors", lasso: "lasso" };
const LASSO_HINT = "Draw round markups, or over them, to select them · then drag to move, corners to resize";
const SNIP_HINT = "Drag a box, or draw around something, to copy it as a picture · then tap where it should go";
function updateToolIcons() {
  for (const b of document.querySelectorAll(".tool")) {
    const t = b.dataset.tool;
    const ic = t === "box" ? SHAPES.find(([k]) => k === cfg.shape)[1] : TOOL_ICONS[t];
    b.innerHTML = icon(ic) + (t === "box" ? `<span class="caret" data-caret="1">${icon("caret")}</span>` : "") +
      (t === "highlight" && cfg.styles.highlight.mode === "draw" ? `<span class="hl-badge" title="Draws freely">~</span>` : "");
  }
}
updateToolIcons();
const pagePill = $("#pagepill");

// With the Select tool, the colour/size menu styles the selected markup.
function selStyleTool() {
  const k = viewer.selectedShape;
  return SHAPES.some(([s]) => s === k) ? "box" : k === "ink" ? "pen" : null;
}
function updateStyleButton() {
  const t = cfg.tool === "select" ? selStyleTool() : cfg.tool;
  const st = t === "measure" ? cfg.measure : t && cfg.styles[t];
  const sb = $("#btn-style");
  sb.classList.toggle("na", !st);
  sb.disabled = !st;
  if (st) sb.querySelector(".swatch-dot").style.background = st.color;
}

// Tools are the same for every open PDF.
function setTool(t) {
  cfg.tool = t;
  for (const P of panes) P.viewer.setTool(t);
  for (const b of document.querySelectorAll(".tool")) b.classList.toggle("active", b.dataset.tool === t);
  updateStyleButton();
  appEl.classList.toggle("measuring", t === "measure");
  if (t === "content") host.findFont?.({ name: "Arial" }).catch(() => {}); // builds the font list in the background
  if (t === "measure") updateMeasureBar();
  saveCfg();
}

function applyStyles() {
  for (const P of panes) applyStylesTo(P.viewer);
}
function applyStylesTo(v) {
  for (const k of ["pen", "highlight", "box"]) v.setStyle(k, { color: hexToRgb(cfg.styles[k].color), width: cfg.styles[k].width });
  v.setStyle("pen", { pressure: cfg.styles.pen.pressure !== false });
  v.setStyle("highlight", { mode: cfg.styles.highlight.mode === "draw" ? "draw" : "words" });
  v.setMeasureStyle({ color: hexToRgb(cfg.measure.color), dp: cfg.measure.dp });
  v.measureMode = cfg.measure.mode;
  v.setShape(cfg.shape);
  v.setTextStyle(cfg.textStyle);
}

function setWheel(mode, announce = true) {
  cfg.wheel = mode === "zoom" ? "zoom" : "scroll";
  for (const P of panes) P.viewer.wheelZooms = cfg.wheel === "zoom";
  saveCfg();
  if (announce) toast(cfg.wheel === "zoom" ? "Mouse wheel zooms · Shift+wheel scrolls" : "Mouse wheel scrolls · Ctrl+wheel zooms");
}

const wheelItems = () => [
  { label: "Mouse wheel scrolls", icon: cfg.wheel !== "zoom" ? "check" : null, run: () => setWheel("scroll") },
  { label: "Mouse wheel zooms", icon: cfg.wheel === "zoom" ? "check" : null, run: () => setWheel("zoom") },
];

// ------------------------------------------------------------------ copy
async function copyText(text) {
  if (!text) return;
  let ok = false;
  try { if (host.copyText) { await host.copyText(text); ok = true; } } catch {}
  if (!ok) { try { await navigator.clipboard.writeText(text); ok = true; } catch {} }
  if (!ok) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
  }
  if (ok) toast(text.length === 1 ? "Copied 1 character" : `Copied ${text.length.toLocaleString()} characters`);
  else toast("Couldn't copy to the clipboard", "error");
}

function setTouchDraws(on) {
  cfg.touchDraws = on;
  for (const P of panes) P.viewer.touchDraws = on;
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
  const t = b.dataset.tool;
  if (t === "sign") { if (cfg.tool !== "sign") setTool("sign"); openSignPanel(); return; }
  if (t === "box" && e.target.closest("[data-caret]")) { if (cfg.tool !== "box") setTool("box"); openStylePopover(); return; }
  if (t === "content") { setTool("content"); toast(CONTENT_HINT); return; }
  if (t === "snip") { setTool("snip"); toast(SNIP_HINT); return; }
  if (t === "lasso") { setTool("lasso"); toast(LASSO_HINT); return; }
  if (t === cfg.tool && cfg.tool === "measure") openMeasurePopover();
  else if (t === cfg.tool && cfg.styles[cfg.tool]) openStylePopover();
  else setTool(t);
});
$("#btn-style").onclick = () => (cfg.tool === "measure" ? openMeasurePopover() : openStylePopover());
$("#btn-touch").onclick = () => setTouchDraws(!cfg.touchDraws);
$("#btn-sidebar").onclick = () => toggleSidebar();
$("#btn-undo").onclick = () => undo();
$("#btn-redo").onclick = () => redo();
$("#btn-pages").onclick = () => togglePages();
$("#btn-marks").onclick = () => toggleMarks();
$("#btn-paste").onclick = () => paste({ center: true });
$("#btn-search").onclick = () => openFind();
$("#btn-side").onclick = () => openBeside(null);
$("#btn-full").onclick = () => host.toggleFullscreen();
$("#btn-autosave").onclick = () => setAutosave(!cfg.autosave);
$("#btn-zoomin").onclick = () => viewer.zoomBy(1.25);
$("#btn-zoomout").onclick = () => viewer.zoomBy(0.8);
$("#btn-fitw").onclick = () => viewer.fit("width");
$("#btn-fitp").onclick = () => viewer.fit("page");
$("#btn-save").onclick = () => save();
$("#empty-open").onclick = () => pickFolder();
$("#zoom-label").onclick = (e) => {
  const z = (pct) => () => viewer.setZoom((pct / 100) * (96 / 72));
  showMenu(e.currentTarget, [
    { label: "Fit width", icon: "fitWidth", key: keyOf("view.fitWidth"), run: () => viewer.fit("width") },
    { label: "Fit page", icon: "fitPage", key: keyOf("view.fitPage"), run: () => viewer.fit("page") },
    "-",
    ...[50, 75, 100, 150, 200, 400, 800].map((p) => ({ label: p + "%", run: z(p) })),
    "-",
    ...wheelItems(),
  ]);
};
$("#btn-more").onclick = (e) => showMenu(e.currentTarget, [
  { label: "Open folder…", icon: "folderOpen", key: keyOf("file.openFolder"), run: pickFolder },
  { label: "Open file…", icon: "openFile", key: keyOf("file.openFile"), run: pickFile },
  "-",
  { label: "Save", icon: "save", key: keyOf("file.save"), run: () => save(), disabled: !state.path },
  { label: "Autosave", icon: cfg.autosave ? "check" : "autosave", key: keyOf("file.autosave"), run: () => setAutosave(!cfg.autosave) },
  { label: "Save as…", key: keyOf("file.saveAs"), run: () => save({ as: true }), disabled: !state.path },
  { label: "Show in folder", icon: "external", run: () => host.showInFolder(state.path), disabled: !state.path },
  { label: "Embed markups…", icon: "layers", key: keyOf("file.embed"), run: () => embedMarkups(), disabled: !state.path },
  "-",
  { label: "Search in this PDF…", icon: "search", key: keyOf("find.open"), run: () => openFind(), disabled: !state.path },
  { label: "Markups: list every markup", icon: "stickyNote", key: keyOf("panel.marks"), run: () => toggleMarks(true) },
  { label: cfg.pagesOpen && cfg.panelTab === "pages" ? "Hide pages" : "Pages: delete, add, move, rotate", icon: "pages", key: keyOf("pages.panel"), run: () => togglePages() },
  { label: "Add a blank page…", icon: "filePlus", key: keyOf("pages.blank"), run: () => blankPageDialog(), disabled: !state.path },
  { label: "Insert pages from another PDF…", icon: "openFile", key: keyOf("pages.insert"), run: () => insertPagesDialog(null), disabled: !state.path },
  { label: "Merge all PDFs in the folder…", icon: "merge", key: keyOf("file.mergeFolder"), run: () => mergeFolder(), disabled: !cfg.folder },
  "-",
  { label: "Open a PDF side by side…", icon: "columns", key: keyOf("view.side"), run: () => openBeside(null), disabled: panes.length >= MAX_PANES },
  (panes.length > 1 || state.path) && { label: "Close this PDF", icon: "x", key: keyOf("view.closePane"), run: () => closePane(active) },
  "-",
  { label: "Copy selected text", icon: "copy", key: keyOf("edit.copy"), run: () => copyText(viewer.sel?.text), disabled: !viewer.hasSelection },
  { label: "Paste", icon: "clipboard", key: keyOf("edit.paste"), run: () => paste({ center: true }), disabled: !state.path },
  { label: "Select all markups on this page", icon: "lasso", key: keyOf("edit.selectMarks"), run: () => selectAllMarks(), disabled: !state.path },
  { label: "Drawing scale…", icon: "ruler", run: () => scaleDialog(), disabled: !state.path },
  "-",
  ...wheelItems(),
  "-",
  { label: "Full screen", icon: "maximize", key: keyOf("view.fullscreen"), run: () => host.toggleFullscreen() },
  { label: "Customize the toolbar…", icon: "sliders", key: keyOf("view.ribbon"), run: () => ribbonDialog() },
  { label: "Keyboard shortcuts…", icon: "keyboard", key: keyOf("help.keys"), run: () => shortcutsDialog() },
  { label: "Keyboard, touch and pen help", icon: "info", key: keyOf("help.help"), run: showHelp },
  canUpdate && "-",
  canUpdate && { label: updateInfo ? `Update to version ${updateInfo.latest}…` : `Check for updates (version ${host.version})`, icon: "download", run: () => (updateInfo ? updateDialog() : checkForUpdates()) },
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
  const selecting = cfg.tool === "select";
  const tool = selecting ? selStyleTool() : cfg.tool;
  const pal = PALETTES[tool];
  if (!pal) return;
  const anchor = $("#btn-style");
  if (!pop.hidden && (popAnchor === anchor || popAnchor === toolButton(tool))) { closePopover(); return; }
  const st = cfg.styles[tool];
  const selKind = selecting ? viewer.selectedShape : null;
  const shape = tool === "box" ? (selKind || cfg.shape) : null;
  const name = tool === "box" ? SHAPES.find(([k]) => k === shape)[2] : { pen: "Pen", highlight: "Highlighter" }[tool];
  const maxW = pal.widths[pal.widths.length - 1];
  const isText = shape === "text" || shape === "callout";
  let html = "";
  if (tool === "highlight" && !selecting) {
    const m = cfg.styles.highlight.mode === "draw" ? "draw" : "words";
    html += `<div class="pop-title">Highlight</div><div class="mmodes hlmodes">` +
      `<button class="btn${m === "words" ? " sel" : ""}" data-hlmode="words" title="Snaps to the words you sweep over">${icon("text")}<span>Words</span></button>` +
      `<button class="btn${m === "draw" ? " sel" : ""}" data-hlmode="draw" title="A freehand marker, wherever you draw">${icon("highlighter")}<span>Draw</span></button></div>`;
  }
  if (tool === "box" && !selecting) {
    html += `<div class="pop-title">Shape</div><div class="shapes">${SHAPES.map(([k, ic, l]) => `<button class="btn${k === shape ? " sel" : ""}" data-shape="${k}" title="${l}">${icon(ic)}<span>${l}</span></button>`).join("")}</div>`;
  }
  html += `<div class="pop-title">${name} color</div><div class="swatches">${pal.colors
    .map((c) => `<button class="swatch${c === st.color ? " sel" : ""}" data-c="${c}" title="${c}"><span style="background:${c}"></span></button>`)
    .join("")}</div>`;
  if (isText) {
    const ts = cfg.textStyle, fillKey = shape === "text" ? "fillText" : "fillCallout";
    html += `<div class="pop-title">Text size</div><div class="sizes">${TEXT_SIZES.map((z) => `<button class="size tsize${z === ts.size ? " sel" : ""}" data-ts="${z}" title="${z} pt"><b style="font-size:${Math.round(10 + (z / 28) * 12)}px">Aa</b><small>${z}</small></button>`).join("")}</div>
      <label class="pop-check"><input type="checkbox" data-fill="${fillKey}"${ts[fillKey] ? " checked" : ""}> White background</label>`;
  }
  if (shape !== "text") {
    html += `<div class="pop-title">${shape === "callout" ? "Border" : "Thickness"}</div><div class="sizes">${pal.widths
      .map((w) => {
        const d = Math.round(4 + (w / maxW) * 20);
        return `<button class="size${w === st.width ? " sel" : ""}" data-w="${w}" title="${w} pt"><i style="width:${tool === "highlight" ? 26 : d}px;height:${d}px;${tool === "highlight" ? `background:${st.color};opacity:.6` : ""}"></i></button>`;
      })
      .join("")}</div>`;
  }
  if (tool === "pen" && !selecting) html += `<label class="pop-check"><input type="checkbox" data-pressure${cfg.styles.pen.pressure !== false ? " checked" : ""}> Pen pressure changes the width</label>`;
  if (isText) html += `<p class="pop-hint">${shape === "callout" ? "Drag from the point you're marking to where the text should go, then type." : "Tap where the text should start, or drag to set its width, then type."}</p>`;
  pop.innerHTML = html;
  pop.onclick = (e) => {
    const sh = e.target.closest("[data-shape]");
    const hm = e.target.closest("[data-hlmode]");
    const sw = e.target.closest(".swatch");
    const ts = e.target.closest("[data-ts]");
    const sz = e.target.closest("[data-w]");
    // With a shape selected, colour/size changes also apply to it.
    const sel = selecting && viewer.selectedShape;
    if (sh) { cfg.shape = sh.dataset.shape; updateToolIcons(); }
    else if (hm) setHighlightMode(hm.dataset.hlmode, false);
    else if (sw) { st.color = sw.dataset.c; if (sel) viewer.restyleSelected({ color: hexToRgb(st.color) }); }
    else if (ts) { cfg.textStyle.size = +ts.dataset.ts; if (sel) viewer.restyleSelected({ size: cfg.textStyle.size }); }
    else if (sz) { st.width = +sz.dataset.w; if (sel) viewer.restyleSelected({ width: st.width }); }
    else return;
    applyStyles();
    setTool(cfg.tool);
    popAnchor = null;
    openStylePopover();
  };
  pop.onchange = (e) => {
    if (e.target.dataset.pressure != null) { cfg.styles.pen.pressure = e.target.checked; applyStyles(); saveCfg(); return; }
    const k = e.target.dataset.fill;
    if (!k) return;
    cfg.textStyle[k] = e.target.checked;
    if (viewer.selectedShape) viewer.restyleSelected({ fill: e.target.checked });
    applyStyles();
    saveCfg();
  };
  popAnchor = anchor;
  placePopover(anchor);
}

const toolButton = (t) => document.querySelector(`.tool[data-tool="${t}"]`);

// Highlighter: "words" snaps to the text you sweep over; "draw" is a freehand
// marker wherever you draw.
function setHighlightMode(mode, announce = true) {
  cfg.styles.highlight.mode = mode === "draw" ? "draw" : "words";
  applyStyles();
  updateToolIcons();
  saveCfg();
  if (announce) { setTool("highlight"); toast(mode === "draw" ? "Highlighter draws freely" : "Highlighter highlights words"); }
}

document.addEventListener("pointerdown", (e) => {
  if (!pop.hidden && !pop.contains(e.target) && !(popAnchor instanceof Element && popAnchor.contains(e.target))) closePopover();
}, true);

// ------------------------------------------------------------------ dialogs + toasts
const modal = $("#modal");
function dialog({ title, message = "", html = "", input = null, buttons, collect = null, onMount = null, wide = false }) {
  return new Promise((resolve) => {
    modal.innerHTML = "";
    const d = document.createElement("div");
    d.className = "dialog" + (wide ? " wide" : "");
    d.innerHTML = `<h2></h2>${message ? "<p></p>" : ""}${html}${input ? `<input type="${input.type || "text"}">` : ""}<div class="row"></div>`;
    d.querySelector("h2").textContent = title;
    if (message) d.querySelector("p").textContent = message;
    const inp = input ? d.querySelector(":scope > input") : null;
    if (inp && input.value) inp.value = input.value;
    const row = d.querySelector(".row");
    const done = (v) => {
      const data = collect ? collect(d) : undefined;
      modal.hidden = true; modal.innerHTML = ""; document.removeEventListener("keydown", onKey, true);
      resolve(collect ? { id: v, data } : v);
    };
    for (const b of buttons) {
      const el = document.createElement("button");
      el.className = "btn" + (b.primary ? " primary" : "") + (b.left ? " left" : "");
      el.textContent = b.label;
      el.onclick = () => done(inp && b.primary ? inp.value : b.id);
      row.appendChild(el);
    }
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); done(inp ? null : "cancel"); }
      else if (e.key === "Enter" && e.target.tagName !== "SELECT") { e.stopPropagation(); e.preventDefault(); const p = buttons.find((b) => b.primary); done(inp ? inp.value : p ? p.id : "cancel"); }
    };
    document.addEventListener("keydown", onKey, true);
    modal.appendChild(d);
    modal.hidden = false;
    onMount?.(d);
    (inp || d.querySelector("[autofocus]") || row.querySelector(".primary"))?.focus();
  });
}

// A short message at the bottom; `action` ({label, run}) adds a button to it.
function toast(msg, kind = "", action = null) {
  const t = document.createElement("div");
  t.className = "toast " + kind + (action ? " act" : "");
  // A newer message replaces one with a button (its offer is out of date).
  document.querySelectorAll("#toasts .toast.act").forEach((o) => o.remove());
  t.innerHTML = (kind === "error" ? "" : icon("check")) + "<span></span>";
  t.querySelector("span").textContent = msg;
  if (action) {
    const b = document.createElement("button");
    b.className = "toast-act";
    b.textContent = action.label;
    b.onclick = () => { t.remove(); action.run(); };
    t.appendChild(b);
  }
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), action ? 6000 : kind === "error" ? 5000 : 1800);
}

async function showHelp() {
  closePopover();
  const gestures = [
    ["Finger drag", "Pan (flick to glide)"], ["Two-finger pinch", "Zoom around your fingers"], ["Double-tap", "Zoom in / back to fit width"],
    ["Pen", "Draw with the selected tool"],
    ["Middle-button drag", "Pan the page (any tool)"], ["Mouse wheel", "Scroll or zoom (choose in the ⋯ menu)"],
    ["Ctrl+wheel / Shift+wheel", "Zoom / the other wheel action"],
    ["Select tool: tap or drag a markup", "Select it, then move, reshape, retype or delete it (Delete key)"],
    ["Select tool: drag over text", "Select it; double-click a word, triple-click a line"],
    ["Shapes tool ▾", "Box, line, arrow, cloud, callout or text; it always draws, even on top of other markups"],
    ["Typing in a text box", "Enter finishes · Shift+Enter starts a new line · Esc cancels"],
    ["Edit content tool", "Drag a box to erase an area · tap a line of text to retype it (same font, size and colour); tap it again to change it"],
    ["Side by side", "Right-click (or press and hold) a PDF in the list › Open side by side (Ctrl+Shift+O) · every PDF works the same; the one you touched last is the one the toolbar and keys use · drag a title bar to move a PDF, the bar between them to resize · × closes it"],
    ["Snip tool (C)", "Drag a box, or draw around something, to copy it as a picture · then tap where it should go (or Ctrl+V) · it pastes at the same size; drag it or its corners"],
    ["Press and hold the page (or right-click)", "Paste here · Snip · Lasso · Select all markups · Open a PDF side by side · Close this PDF"],
    ["Pen side button (hold) · Lasso tool (L)", "Draw round markups, or over them, to select them · drag to move, corners to resize · Copy, Duplicate, Delete on the bar; Ctrl+C / X / V / D, Delete, arrow keys"],
    ["Pen eraser end (top button)", "Erase"],
    ["Ctrl+F", "Search in the PDF · Enter / Shift+Enter for the next / previous result"],
    ["Pages panel", "Click a page to go to it · drag pages to reorder (with a finger: drag the grip, or press and hold) · drop them on another open PDF to copy them there · right-click (or press and hold) to add, copy in, duplicate, rotate or delete"],
    ["File list: Ctrl+click / Shift+click", "Select several PDFs, then right-click › Merge · right-click a folder › Merge all PDFs in this folder"],
    ["Callout", "Drag from the spot you're marking to where the text goes, then type"],
    ["Signature tool", "Pick a signature, drag it into place, Place; tap a placed one to move, resize or delete it"],
    ["Measure tool", "Drag or click two points; path and area: click points, double-click or Enter to finish"],
    ["Shift while drawing a line or measuring", "Snap to 0°, 45°, 90°"],
  ];
  const groups = [...new Set(COMMANDS.map((c) => c.group))];
  let keysHtml = "";
  for (const g of groups) {
    const rows = COMMANDS.filter((c) => c.group === g && keymap.keys(c.id).length);
    if (!rows.length) continue;
    keysHtml += `<div class="help-group">${esc(g)}</div>` + rows.map((c) => `<kbd>${esc(keymap.keys(c.id).map(formatCombo).join("  ·  "))}</kbd><span>${esc(c.label)}</span>`).join("");
  }
  const r = await dialog({
    title: "Touch, pen, mouse and keyboard",
    wide: true,
    html: `<div class="shortcuts">${gestures.map(([k, v]) => `<kbd>${k}</kbd><span>${v}</span>`).join("")}${keysHtml}</div>`,
    buttons: [{ id: "keys", label: "Customize shortcuts…", left: true }, { id: "ok", label: "Close", primary: true }],
  });
  if (r === "keys") shortcutsDialog();
}

// ------------------------------------------------------------------ measuring
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function scaleFor(i) { return scaleOf(state.path, i); }
function scaleOf(path, i) {
  const ds = path && cfg.scales[path];
  return (ds && ((ds.pages && ds.pages[i]) || ds.all)) || { ...DEFAULT_SCALE, unit: cfg.measure.unit || "mm" };
}

function scaleText(sc) {
  if (sc.unset) return `Scale not set · ${UNITS[sc.unit]?.label || sc.unit}`;
  return `${sc.label} · ${sc.unit === "ftin" ? "ft-in" : UNITS[sc.unit]?.label || sc.unit}`;
}

// scope: "all" or a page index.
async function setScale(scope, sc) {
  const { viewer, state } = active;
  if (!state.path) return;
  const clean = { mPerPt: sc.mPerPt, unit: sc.unit, label: sc.label };
  const ds = (cfg.scales[state.path] ||= { all: null, pages: {} });
  ds.pages ||= {};
  if (scope === "all") { ds.all = clean; ds.pages = {}; }
  else ds.pages[scope] = clean;
  delete cfg.scales[state.path];
  cfg.scales[state.path] = ds; // most recent last, for pruning
  const keys = Object.keys(cfg.scales);
  if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete cfg.scales[k];
  cfg.measure.unit = clean.unit;
  saveCfg();
  viewer.setMeasureStyle({});
  updateMeasureBar();
  // Check every page of a drawing set; for very long documents, the pages
  // already opened this session.
  const n = viewer.pageCount;
  const pages = scope !== "all" ? [scope] : n <= 80 ? Array.from({ length: n }, (_, k) => k) : viewer.loadedPages();
  const stale = (await viewer.measurementsOn(pages)).filter(([i, d]) => !sameScale(d.scale, scaleFor(i)));
  if (!stale.length) return;
  const r = await dialog({
    title: "Update existing measurements?",
    message: `${stale.length === 1 ? "1 measurement was" : stale.length + " measurements were"} made at a different scale or unit. Recalculate ${stale.length === 1 ? "it" : "them"} with ${clean.label}?`,
    buttons: [{ id: "keep", label: "Keep as is" }, { id: "update", label: "Recalculate", primary: true }],
  });
  if (r === "update") {
    const k = viewer.rescaleMeasurements(stale, scaleFor);
    if (k) toast(`Updated ${k} measurement${k === 1 ? "" : "s"}`);
  }
}

function unitOptions(sel) {
  return Object.entries(UNITS).map(([k, u]) => `<option value="${k}"${k === sel ? " selected" : ""}>${esc(u.name)}</option>`).join("");
}

function scopeHtml(page) {
  if (viewer.pageCount <= 1) return "";
  return `<div class="field"><span>Applies to</span><div class="radios">
    <label><input type="radio" name="scope" value="all" checked> All pages</label>
    <label><input type="radio" name="scope" value="page"> Page ${page + 1} only</label></div></div>`;
}
const readScope = (d, page) => (d.querySelector('input[name="scope"]:checked')?.value === "page" ? page : "all");

async function scaleDialog() {
  if (!state.path) return;
  closePopover();
  const page = viewer.currentPage();
  const cur = scaleFor(page);
  const curN = ratioOf(cur);
  const metric = METRIC_RATIOS.map((n) => `<option value="r:${n}">1:${n}</option>`).join("");
  const imperial = IMPERIAL_SCALES.map(([l], k) => `<option value="i:${k}">${esc(l)}</option>`).join("");
  let selected = "custom";
  if (!cur.unset) {
    const ir = IMPERIAL_SCALES.findIndex(([l]) => l === cur.label);
    if (ir >= 0) selected = "i:" + ir;
    else if (METRIC_RATIOS.some((n) => Math.abs(n - curN) < 1e-6 && cur.label === "1:" + n)) selected = "r:" + Math.round(curN);
  } else selected = "r:1";
  const r = await dialog({
    title: "Drawing scale",
    html: `<div class="form">
      <label class="field"><span>Scale</span><select id="sc-preset">
        <optgroup label="Metric">${metric}</optgroup>
        <optgroup label="Imperial">${imperial}</optgroup>
        <option value="custom">Custom 1:N…</option></select></label>
      <label class="field" id="sc-custom-row"><span>Custom 1 :</span><input id="sc-custom" type="number" min="0.0001" step="any" value="${+curN.toPrecision(6)}"></label>
      <label class="field"><span>Show results in</span><select id="sc-unit">${unitOptions(cur.unit)}</select></label>
      ${scopeHtml(page)}
      <p class="hint">Scale unknown or a scanned drawing? Use <b>Calibrate</b> and draw over a dimension you know.</p></div>`,
    buttons: [{ id: "cal", label: "Calibrate…", left: true }, { id: "cancel", label: "Cancel" }, { id: "ok", label: "Apply", primary: true }],
    onMount(d) {
      const pre = d.querySelector("#sc-preset"), row = d.querySelector("#sc-custom-row"), unit = d.querySelector("#sc-unit");
      pre.value = selected;
      const sync = () => { row.style.display = pre.value === "custom" ? "" : "none"; };
      pre.onchange = () => {
        sync();
        if (pre.value.startsWith("i:") && !["ftin", "ft", "in"].includes(unit.value)) unit.value = "ftin";
        else if (pre.value.startsWith("r:") && ["ftin", "ft", "in"].includes(unit.value)) unit.value = "m";
      };
      sync();
    },
    collect: (d) => ({ preset: d.querySelector("#sc-preset").value, custom: parseFloat(d.querySelector("#sc-custom").value), unit: d.querySelector("#sc-unit").value, scope: readScope(d, page) }),
  });
  if (r.id === "cal") { setTool("measure"); viewer.startCalibrate(); return; }
  if (r.id !== "ok") return;
  const { preset, custom, unit, scope } = r.data;
  let sc;
  if (preset.startsWith("i:")) { const [l, a, b] = IMPERIAL_SCALES[+preset.slice(2)]; sc = imperialScale(l, a, b, unit); }
  else if (preset.startsWith("r:")) sc = ratioScale(+preset.slice(2), unit);
  else if (custom > 0) sc = ratioScale(custom, unit);
  else { toast("Enter a scale such as 1:100", "error"); return; }
  await setScale(scope, sc);
  toast("Scale set to " + sc.label);
}

// "12'6", 12' 6 1/2", 12.5 (feet) -> feet
function parseFeet(t) {
  const s = String(t).trim().replace(/[″”]/g, '"').replace(/[′’]/g, "'");
  const m = s.match(/^(\d+(?:\.\d+)?)\s*'\s*-?\s*(?:(\d+(?:\.\d+)?)(?:\s+(\d+)\/(\d+))?\s*"?)?$/);
  if (m) return +m[1] + ((+m[2] || 0) + (m[3] ? +m[3] / +m[4] : 0)) / 12;
  const n = s.match(/^(\d+(?:\.\d+)?)\s*"$/);
  if (n) return +n[1] / 12;
  return parseFloat(s);
}

async function calibrateDialog(page, lengthPt) {
  const unit = cfg.measure.unit || "mm";
  const paper = fmtLength(lengthPt, ratioScale(1, "mm"), 1);
  const r = await dialog({
    title: "Set scale from this line",
    html: `<div class="form"><p class="hint">The line you drew is ${esc(paper)} long on paper. How long is it in real life?</p>
      <div class="field"><span>Real length</span><div class="inline"><input id="cal-len" type="text" inputmode="decimal" autofocus placeholder="e.g. 5000">
      <select id="cal-unit">${unitOptions(unit)}</select></div></div>${scopeHtml(page)}</div>`,
    buttons: [{ id: "cancel", label: "Cancel" }, { id: "ok", label: "Set scale", primary: true }],
    collect: (d) => ({ len: d.querySelector("#cal-len").value, unit: d.querySelector("#cal-unit").value, scope: readScope(d, page) }),
  });
  if (r.id !== "ok") return;
  const u = UNITS[r.data.unit];
  const v = r.data.unit === "ftin" ? parseFeet(r.data.len) : parseFloat(String(r.data.len).replace(/,/g, ""));
  if (!u || !(v > 0)) { toast("Enter the real length as a number", "error"); return; }
  const sc = calibratedScale(v * u.m, lengthPt, r.data.unit);
  await setScale(r.data.scope, sc);
  toast("Scale calibrated: " + sc.label.replace("Calibrated ", ""));
}

function openMeasurePopover() {
  const anchor = $("#btn-style");
  if (!pop.hidden && popAnchor === anchor) { closePopover(); return; }
  const m = cfg.measure;
  const sc = scaleFor(viewer.currentPage());
  const modes = [["distance", "distance", "Distance"], ["path", "path", "Path length"], ["area", "area", "Area"]];
  const dps = [["auto", "Auto"], ["0", "0"], ["1", "0.0"], ["2", "0.00"], ["3", "0.000"]];
  pop.innerHTML = `<div class="pop-title">Measure</div>
    <div class="mmodes">${modes.map(([k, ic, l]) => `<button class="btn${m.mode === k ? " sel" : ""}" data-mode="${k}">${icon(ic)}<span>${l}</span></button>`).join("")}</div>
    <div class="pop-title">Scale</div>
    <button class="btn mp-scale${sc.unset ? " warn" : ""}" data-act="scale">${icon("ruler")}<span>${esc(scaleText(sc))}</span><span class="key">Change</span></button>
    <button class="btn mp-scale" data-act="cal">${icon("calibrate")}<span>Calibrate from a known length</span></button>
    <div class="mp-row"><label>Units<select data-set="unit">${unitOptions(sc.unit)}</select></label>
    <label>Decimals<select data-set="dp">${dps.map(([v, l]) => `<option value="${v}"${String(m.dp ?? "auto") === v ? " selected" : ""}>${l}</option>`).join("")}</select></label></div>
    <div class="pop-title">Color</div>
    <div class="swatches">${MEASURE_COLORS.map((c) => `<button class="swatch${c === m.color ? " sel" : ""}" data-c="${c}"><span style="background:${c}"></span></button>`).join("")}</div>`;
  pop.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.mode) { m.mode = b.dataset.mode; viewer.setMeasureMode(m.mode); }
    else if (b.dataset.c) { m.color = b.dataset.c; applyStyles(); setTool("measure"); }
    else if (b.dataset.act === "scale") { scaleDialog(); return; }
    else if (b.dataset.act === "cal") { closePopover(); viewer.startCalibrate(); return; }
    else return;
    saveCfg();
    popAnchor = null;
    openMeasurePopover();
  };
  pop.onchange = async (e) => {
    const k = e.target.dataset.set;
    if (k === "dp") {
      m.dp = e.target.value === "auto" ? null : +e.target.value;
      viewer.setMeasureStyle({ dp: m.dp });
      saveCfg();
    } else if (k === "unit") {
      const page = viewer.currentPage(), cur = scaleFor(page);
      m.unit = e.target.value;
      saveCfg();
      closePopover();
      if (!cur.unset) {
        const ds = cfg.scales[state.path];
        await setScale(ds?.pages?.[page] ? page : "all", { ...cur, unit: m.unit });
      } else { viewer.setMeasureStyle({}); updateMeasureBar(); }
    }
  };
  popAnchor = anchor;
  placePopover(anchor);
}

const mbar = $("#measurebar");
function updateMeasureBar(st = viewer.measureStatus()) {
  if (cfg.tool !== "measure" || !viewer.pageCount) return;
  const sc = scaleFor(st.page);
  const chip = $("#mb-scale");
  chip.querySelector("span").textContent = scaleText(sc);
  chip.classList.toggle("warn", !!sc.unset);
  const hints = {
    distance: "Drag, or click two points",
    path: "Click each point · double-click or Done to finish",
    area: "Click each corner · click the first point to close",
    calibrate: "Calibrate: draw a line over a dimension you know",
  };
  let text = hints[st.mode] || "";
  if (st.drafting && st.value) text = (st.mode === "calibrate" ? "Calibrate · " : "") + st.value;
  else if (st.drafting && (st.mode === "distance" || st.mode === "calibrate")) text = "Click the second point";
  $("#mb-text").textContent = text;
  mbar.classList.toggle("drafting", st.drafting || st.mode === "calibrate");
  mbar.classList.toggle("calibrating", st.mode === "calibrate");
  $("#mb-done").hidden = !(st.drafting && (st.mode === "path" || st.mode === "area"));
  $("#mb-done").disabled = !st.canFinish;
  $("#mb-back").hidden = !(st.drafting && (st.mode === "path" || st.mode === "area"));
}
$("#mb-scale").innerHTML = icon("ruler") + "<span></span>";
$("#mb-back").innerHTML = icon("undo");
$("#mb-cancel").innerHTML = icon("x");
$("#mb-done").innerHTML = icon("check") + "<span>Done</span>";
$("#mb-scale").onclick = () => scaleDialog();
$("#mb-back").onclick = () => viewer.measureBack();
$("#mb-done").onclick = () => viewer.finishMeasure();
$("#mb-cancel").onclick = () => viewer.cancelMeasure();

// ------------------------------------------------------------------ signatures
// "My signatures" live in signatures.json (PNG data URLs, most recently used
// first). A signatures folder can also be browsed; picking an image from it
// (or any file) goes through "Prepare signature" first.
let sigLib = ((await host.readJson("signatures").catch(() => null)) || []).filter((x) => x && x.id && x.png);
const thumbCache = new Map();

function saveSigLib() { host.writeJson("signatures", sigLib); }
const sigObj = (s) => ({ id: s.id, href: s.png, png: fromDataUrl(s.png), aspect: s.h / s.w });

async function readImageBlob(path) {
  const r = await fetch(host.fileUrl(path));
  if (!r.ok) throw new Error("couldn't read " + baseName(path));
  return new Blob([await r.arrayBuffer()], { type: imageMime(path) });
}

function placeSig(s, opts = {}) {
  if (!viewer.pageCount) { toast("Open a PDF first, then add your signature", "error"); return; }
  if (cfg.tool !== "sign") setTool("sign");
  closePopover();
  viewer.placeSignature(sigObj(s), { width: s.width || undefined, ...opts });
}

// A signature was placed: remember it (and its size) for next time.
function signed(sig, rect) {
  const s = sigLib.find((x) => x.id === sig.id);
  if (!s) return;
  s.used = Date.now();
  s.width = Math.round((rect[2] - rect[0]) * 10) / 10;
  cfg.lastSig = s.id;
  sigLib.sort((a, b) => (b.used || 0) - (a.used || 0));
  saveSigLib();
  saveCfg();
}

// Signature tool: tap a placed signature to adjust it, or the page to place
// the last one used.
function signTap(page, p, hit) {
  if (hit) { viewer.adjustSignature(page, hit); return; }
  const last = sigLib.find((x) => x.id === cfg.lastSig) || sigLib[0];
  if (last) placeSig(last, { page, center: p });
  else openSignPanel();
}

async function removeSig(id) {
  const s = sigLib.find((x) => x.id === id);
  if (!s) return;
  const r = await dialog({
    title: "Remove signature?",
    message: `Remove “${s.name || "Signature"}” from My signatures? Signatures already placed in PDFs stay as they are.`,
    buttons: [{ id: "cancel", label: "Cancel" }, { id: "ok", label: "Remove", primary: true }],
  });
  if (r !== "ok") return;
  sigLib = sigLib.filter((x) => x.id !== id);
  if (cfg.lastSig === id) cfg.lastSig = null;
  saveSigLib();
  saveCfg();
  openSignPanel();
}

function openSignPanel() {
  const anchor = toolButton("sign");
  if (!pop.hidden && popAnchor === anchor) { closePopover(); return; }
  const folder = cfg.sigFolder;
  const mine = sigLib.length
    ? sigLib.map((s) => `<div class="sig-item" data-id="${esc(s.id)}" title="${esc(s.name || "Signature")}" role="button" tabindex="0"><img src="${s.png}" alt=""><button class="sig-del" data-del="${esc(s.id)}" title="Remove from My signatures">${icon("x")}</button></div>`).join("")
    : `<p class="pop-hint">No signatures yet. Add a photo or scan of your signature: the background is removed for you.</p>`;
  pop.innerHTML = `<div class="sig-panel">
    <div class="pop-title">My signatures</div>
    <div class="sig-grid" id="sig-mine">${mine}</div>
    <button class="btn wide" data-act="add">${icon("imagePlus")}<span>Add signature from file…</span></button>
    <div class="pop-title">${folder ? `Folder · ${esc(baseName(folder))}` : "Signatures folder"}</div>
    <div class="sig-grid" id="sig-folder">${folder ? `<p class="pop-hint">Loading…</p>` : `<p class="pop-hint">Keep signature images (PNG, JPG…) in a folder and pick them from here.</p>`}</div>
    <button class="btn wide" data-act="folder">${icon("folderOpen")}<span>${folder ? "Change folder…" : "Choose folder…"}</span></button>
    <p class="pop-hint">Tap a signature to place it. With this tool, tap the page to place your last signature there, or tap a placed one to move or resize it.</p>
  </div>`;
  pop.onclick = async (e) => {
    const del = e.target.closest("[data-del]");
    if (del) { e.stopPropagation(); removeSig(del.dataset.del); return; }
    const it = e.target.closest(".sig-item[data-id]");
    if (it) { const s = sigLib.find((x) => x.id === it.dataset.id); if (s) placeSig(s); return; }
    const fi = e.target.closest(".sig-item[data-path]");
    if (fi) { closePopover(); prepareSignature(fi.dataset.path); return; }
    const b = e.target.closest("[data-act]");
    if (b?.dataset.act === "add") {
      closePopover();
      const paths = await host.pickImages();
      if (paths && paths[0]) prepareSignature(paths[0]);
    } else if (b?.dataset.act === "folder") {
      const d = await host.pickFolder();
      if (d) { cfg.sigFolder = d; saveCfg(); popAnchor = null; openSignPanel(); }
    }
  };
  pop.onchange = null;
  popAnchor = anchor;
  placePopover(anchor);
  if (folder) fillFolderGrid(folder, anchor);
}

async function thumbnail(path) {
  const bmp = await createImageBitmap(await readImageBlob(path), { resizeHeight: 96, resizeQuality: "medium" });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close();
  return URL.createObjectURL(await c.convertToBlob({ type: "image/png" }));
}

async function fillFolderGrid(folder, anchor) {
  const grid = pop.querySelector("#sig-folder");
  let list = null;
  try { list = await host.listImages(folder); } catch {}
  if (!grid.isConnected) return;
  if (!list || !list.length) { grid.innerHTML = `<p class="pop-hint">${list ? "No images in this folder." : "Couldn't read this folder."}</p>`; return; }
  list = list.slice(0, 60);
  grid.innerHTML = list.map((f) => `<div class="sig-item" data-path="${esc(f.path)}" title="${esc(f.name)}" role="button" tabindex="0"><img alt=""></div>`).join("");
  placePopover(anchor);
  const items = [...grid.querySelectorAll(".sig-item")];
  for (const [k, f] of list.entries()) {
    const key = f.path + "|" + f.mtime;
    let url = thumbCache.get(key);
    if (url == null) { try { url = await thumbnail(f.path); } catch { url = ""; } thumbCache.set(key, url); }
    if (!items[k].isConnected) return;
    if (url) items[k].querySelector("img").src = url;
    else items[k].classList.add("bad");
  }
}

function scaleImageData(img, f) {
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext("2d").putImageData(img, 0, 0);
  const w = Math.max(1, Math.round(img.width * f)), h = Math.max(1, Math.round(img.height * f));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

// Background removal with a live preview and a strength slider, then save to
// My signatures and start placing it.
async function prepareSignature(path) {
  let img;
  try { img = await loadSignatureImage(await readImageBlob(path)); }
  catch (err) { toast("Couldn't open that image: " + err.message, "error"); return false; }
  const info = analyzeSignature(img);
  const st = { strength: info.auto, ink: "original" };
  const r = await dialog({
    title: "Prepare signature",
    wide: true,
    html: `<div class="sigprep">
      <div class="sp-preview check" id="sp-prev"><canvas id="sp-canvas"></canvas></div>
      <div class="form">
        <div class="field"><span>Remove background · <output id="sp-val"></output></span>
          <div class="inline"><input type="range" id="sp-strength" min="0" max="100" step="1" aria-label="Background removal strength">
          <button class="btn" id="sp-auto" type="button">${icon("wand")}<span>Auto</span></button></div>
          <p class="hint">Slide right to remove more (paper texture, shadows, ruled lines), left to keep faint strokes.</p></div>
        <div class="field"><span>Ink colour</span><div class="radios">
          <label><input type="radio" name="sp-ink" value="original" checked> As in the image</label>
          <label><input type="radio" name="sp-ink" value="black"> Black</label>
          <label><input type="radio" name="sp-ink" value="blue"> Blue</label></div></div>
        <div class="field"><span>Preview on</span><div class="radios">
          <label><input type="radio" name="sp-bg" value="check" checked> Transparent</label>
          <label><input type="radio" name="sp-bg" value="white"> White paper</label></div></div>
        <label class="field"><span>Name</span><input id="sp-name" type="text" value="${esc(baseName(path).replace(IMAGE_EXT, ""))}"></label>
      </div></div>`,
    buttons: [{ id: "cancel", label: "Cancel" }, { id: "ok", label: "Use signature", primary: true }],
    onMount(d) {
      const cv = d.querySelector("#sp-canvas"), ctx = cv.getContext("2d");
      const small = img.width > 900 ? scaleImageData(img, 900 / img.width) : img;
      cv.width = small.width;
      cv.height = small.height;
      const sl = d.querySelector("#sp-strength"), out = d.querySelector("#sp-val");
      sl.value = st.strength;
      let raf = 0;
      const render = () => {
        raf = 0;
        ctx.putImageData(removeBackground(small, { bg: info.bg, strength: st.strength, ink: st.ink }).image, 0, 0);
        out.textContent = st.strength === 0 ? "off" : st.strength + "%";
      };
      const later = () => { if (!raf) raf = requestAnimationFrame(render); };
      sl.oninput = () => { st.strength = +sl.value; later(); };
      d.querySelector("#sp-auto").onclick = () => { st.strength = info.auto; sl.value = info.auto; later(); };
      for (const x of d.querySelectorAll('input[name="sp-ink"]')) x.onchange = () => { st.ink = x.value; later(); };
      for (const x of d.querySelectorAll('input[name="sp-bg"]')) x.onchange = () => { d.querySelector("#sp-prev").className = "sp-preview " + x.value; };
      render();
    },
    collect: (d) => ({ name: d.querySelector("#sp-name").value.trim() }),
  });
  if (r.id !== "ok") return false;
  let out;
  try {
    const res = removeBackground(img, { bg: info.bg, strength: st.strength, ink: st.ink });
    out = await signaturePng(res.image, res.box);
  } catch (err) {
    toast(err.message, "error");
    return false;
  }
  const s = { id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: r.data.name || "Signature", png: out.dataUrl, w: out.w, h: out.h, added: Date.now(), used: Date.now() };
  sigLib.unshift(s);
  saveSigLib();
  placeSig(s);
  return true;
}

// ------------------------------------------------------------------ files
function baseName(p) { return p ? p.split(/[\\/]/).pop() : ""; }

function updateTitle() {
  const name = state.path ? baseName(state.path).replace(/\.pdf$/i, "") : "Eagles PDF viewer";
  $("#title-text").textContent = name;
  document.title = (viewer.dirty ? "• " : "") + (state.path ? name + " — Eagles PDF viewer" : "Eagles PDF viewer");
  updatePaneHead(active);
}

// Where you were in each file, for next time.
function rememberView(P = active) {
  if (!P.state.path) return;
  clearTimeout(P.viewTimer);
  P.viewTimer = setTimeout(() => storeView(P), 400);
}
function storeView(P) {
  clearTimeout(P.viewTimer);
  const v = P.viewer.viewState(), path = P.state.path;
  if (!v || !path) return;
  delete cfg.files[path];
  cfg.files[path] = v;
  const keys = Object.keys(cfg.files);
  if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete cfg.files[k];
  saveCfg();
}

async function confirmDiscard(P = active) {
  const { viewer, state } = P;
  viewer.commitEdits();
  if (!viewer.dirty) return true;
  // With autosave on, closing just saves (unless that needs asking).
  if (cfg.autosave) {
    clearTimeout(P.autoTimer);
    if (viewer.placing) viewer.finishPlacing(true);
    await save({ quiet: true }, P);
    if (!viewer.dirty) return true;
  }
  activate(P);
  const r = await dialog({
    title: "Save changes?",
    message: `“${baseName(state.path)}” has changes that aren't saved yet.`,
    buttons: [{ id: "cancel", label: "Cancel" }, { id: "discard", label: "Don't save" }, { id: "save", label: "Save", primary: true }],
  });
  if (r === "save") { await save({}, P); return !viewer.dirty; }
  return r === "discard";
}

// Open a PDF in the active pane; if it's already open side by side, go to it.
async function openFile(path, { force = false } = {}) {
  if (!path) return false;
  const other = panes.find((Q) => Q !== active && samePath(Q.state.path, path));
  if (other) { activate(other); if (narrow()) toggleSidebar(false); return true; }
  return openIn(active, path, { force });
}

async function openIn(P, path, { force = false } = {}) {
  const { engine, viewer, state, docHist } = P;
  if (path === state.path && !force) { if (narrow()) toggleSidebar(false); return true; }
  if (!(await confirmDiscard(P))) return false;
  closePopover();
  storeView(P);
  const gen = ++state.gen;
  viewer.close();
  engine.close();
  state.path = path;
  updatePaneHead(P);
  if (P === active) {
    cfg.lastFile = path;
    sidebar.setCurrent(path);
    appEl.classList.remove("no-doc");
    updateTitle();
  }
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
    if (gen !== state.gen) return false;
    if (!res.pages.length) throw new Error("this PDF has no pages");
    viewer.open(gen, res.pages, cfg.files[path]);
    viewer.setTool(cfg.tool);
    docHist.undo = []; docHist.redo = [];
    updatePaneHead(P);
    P.find = null;
    P.autoBlocked = 0;
    if (P === active) {
      pagesPanel.setDocument(viewer.doc.pages, viewer.currentPage());
      markupsPanel.reset(P.id, viewer.pageCount);
      updateUndoButtons();
      updateMeasureBar();
      $("#zoom-label").textContent = Math.round((viewer.scale * 72 / 96) * 100) + "%";
      findSync();
    } else { pagesPanel.forget(P.id); markupsPanel.forget(P.id); }
    if (narrow()) toggleSidebar(false);
    saveSession();
    return true;
  } catch (err) {
    if (gen !== state.gen) return false;
    state.path = null;
    viewer.close();
    updatePaneHead(P);
    // Side by side, a PDF that couldn't open doesn't keep an empty pane.
    if (panes.length > 1) {
      if (err.message !== "cancelled") toast(`Couldn't open “${baseName(path)}”: ${err.message}`, "error");
      removePane(P);
      return false;
    }
    if (P === active) {
      pagesPanel.clear();
      appEl.classList.add("no-doc");
      $("#empty-msg").textContent = err.message === "cancelled" ? "Pick a PDF from the list." : `Couldn't open “${baseName(path)}”: ${err.message}`;
      updateTitle();
    }
    saveSession();
    return false;
  } finally {
    clearTimeout(spin);
    if (gen === state.gen || !panes.includes(P)) appEl.classList.remove("loading");
  }
}

// ------------------------------------------------------------------ pages
// The page counter at the bottom: "3 / 12", with the page's name if it has one.
function showPagePill(i, n) {
  const name = viewer.doc?.pages[i]?.name;
  pagePill.textContent = pageText(viewer, i, n);
  pagePill.title = name ? `Page ${i + 1} of ${n}: ${name}` : "Go to page";
}
function pageText(v, i, n) {
  const name = v.doc?.pages[i]?.name;
  const num = `${i + 1} / ${n}`;
  return name && cfg.pageLabels !== "number" ? (cfg.pageLabels === "name" ? name : `${name} · ${num}`) : num;
}

function setPageLabels(mode) {
  cfg.pageLabels = mode;
  pagesPanel.setLabelMode(mode);
  if (viewer.doc) showPagePill(viewer.currentPage(), viewer.pageCount);
  for (const P of panes) updatePaneHead(P);
  saveCfg();
  toast(mode === "number" ? "Showing page numbers" : mode === "name" ? "Showing page names (numbers where a page has no name)" : "Showing page numbers and names");
}
// Delete, add, copy in, duplicate, move and rotate pages. Each change is one
// undo step (the document before it is kept); saving writes the new pages.
const PAPER = [["A4", 210, 297, "mm"], ["A3", 297, 420, "mm"], ["A5", 148, 210, "mm"], ["Letter", 8.5, 11, "in"], ["Legal", 8.5, 14, "in"], ["Tabloid", 11, 17, "in"]];
const pageWord = (n) => (n === 1 ? "1 page" : `${n} pages`);
const range = (a, n) => Array.from({ length: n }, (_, k) => a + k);

// The panel on the right: Pages, Markups or Search results (null: hidden).
// Only the tab in view does any work.
function showPanel(tab) {
  cfg.pagesOpen = !!tab;
  if (tab) cfg.panelTab = tab;
  $("#rpanel").hidden = !tab;
  for (const b of document.querySelectorAll(".rp-tab")) b.classList.toggle("active", b.dataset.tab === tab);
  pagesPanel.show(tab === "pages");
  markupsPanel.show(tab === "marks");
  $("#findlist").hidden = tab !== "find";
  if (tab === "find") renderFindList();
  $("#btn-pages").classList.toggle("on", tab === "pages");
  $("#btn-marks").classList.toggle("on", tab === "marks");
  saveCfg();
}
const panelIs = (tab) => cfg.pagesOpen && cfg.panelTab === tab;
function togglePages(force) { showPanel((force ?? !panelIs("pages")) ? "pages" : null); }
function toggleMarks(force) { showPanel((force ?? !panelIs("marks")) ? "marks" : null); }
document.querySelector("#rpanel .rp-tabs").addEventListener("click", (e) => {
  const t = e.target.closest("[data-tab]");
  if (t) showPanel(t.dataset.tab);
  else if (e.target.closest(".rp-close")) showPanel(null);
});

function showNewPages(P, pages, focus, keep, select) {
  const { viewer, state } = P;
  const gen = ++state.gen;
  focus = Math.max(0, Math.min(pages.length - 1, focus));
  const same = focus === keep?.page;
  viewer.open(gen, pages, { mode: keep?.mode, scale: keep?.scale, sx: same ? keep?.sx : null, page: focus, offset: same ? keep.offset : 0 });
  viewer.setTool(cfg.tool);
  viewer.markChanged();
  updatePaneHead(P);
  P.find = null;
  if (P !== active) { pagesPanel.forget(P.id); markupsPanel.forget(P.id); return; }
  pagesPanel.setDocument(viewer.doc.pages, focus, select);
  markupsPanel.reset(P.id, pages.length);
  findSync();
  updateUndoButtons();
  updateTitle();
}

// A page change in pane P (the active one unless said otherwise).
async function changePages(op, { focus, select, done } = {}, P = active) {
  const { viewer, engine, state, docHist } = P;
  if (!state.path || P.busy || state.saving) return false;
  viewer.commitEdits();
  if (viewer.placing) viewer.finishPlacing(true);
  P.busy = true;
  const spin = setTimeout(() => appEl.classList.add("loading"), 150);
  const keep = viewer.viewState();
  try {
    const r = await engine.pageOp(op);
    if (!r) return false;
    docHist.undo.push({ bytes: r.before });
    if (docHist.undo.length > 20) docHist.undo.shift();
    docHist.redo = [];
    showNewPages(P, r.pages, focus ?? keep.page, keep, select);
    if (done) toast(done);
    return true;
  } catch (err) {
    toast("Couldn't change the pages: " + err.message, "error");
    return false;
  } finally {
    clearTimeout(spin);
    appEl.classList.remove("loading");
    P.busy = false;
  }
}

async function restoreDoc(P, from, to, msg) {
  const { viewer, engine, state } = P;
  if (P.busy || !state.path) return;
  P.busy = true;
  const item = from.pop();
  const keep = viewer.viewState();
  try {
    const r = await engine.restore(item.bytes.slice());
    if (!r) { from.push(item); return; }
    to.push({ bytes: r.before });
    showNewPages(P, r.pages, keep.page, keep);
    toast(msg);
  } catch (err) {
    from.push(item);
    toast("Couldn't undo that: " + err.message, "error");
  } finally {
    P.busy = false;
    updateUndoButtons();
  }
}

// Pages dragged from the Pages panel onto another open PDF: copied there
// (with their markups, saved or not), after the page shown in it.
async function copyPagesTo(S, list, T) {
  for (const Q of panes) Q.el.classList.remove("drop-target");
  if (!T || !T.state.path || !list.length || !panes.includes(S)) return;
  S.viewer.commitEdits();
  let bytes;
  try { bytes = await S.engine.snapshot(); } catch (err) { toast("Couldn't copy the pages: " + err.message, "error"); return; }
  if (!bytes) return;
  const at = T.viewer.currentPage() + 1;
  activate(T);
  await changePages({ kind: "insert", bytes, password: S.engine.password, pages: list, at }, {
    focus: at, select: range(at, list.length),
    done: `Copied ${pageWord(list.length)} from “${baseName(S.state.path)}” after page ${at}`,
  }, T);
}

const pageCount = () => viewer.pageCount;
const chosenPages = () => { const s = pagesPanel.open ? pagesPanel.selected() : []; return s.length ? s : [viewer.currentPage()]; };

function deletePages(list) {
  if (!list.length) return;
  if (list.length >= pageCount()) { toast("A PDF needs at least one page", "error"); return; }
  const first = Math.min(...list);
  changePages({ kind: "delete", pages: list }, { focus: Math.min(first, pageCount() - list.length - 1), done: `Deleted ${pageWord(list.length)} · Ctrl+Z to undo` });
}

function movePages(order, moved) {
  const set = new Set(moved);
  const now = order.map((old, k) => (set.has(old) ? k : -1)).filter((k) => k >= 0);
  changePages({ kind: "move", order }, { focus: now[0], select: now, done: `Moved ${pageWord(moved.length)}` });
}

function movePagesTo(list, to) {
  const order = moveOrder(pageCount(), list, to);
  if (order) movePages(order, list);
}

function rotatePages(list, by) {
  changePages({ kind: "rotate", pages: list, by }, { focus: list[0], select: list });
}

function duplicatePages(list) {
  const at = Math.max(...list) + 1;
  changePages({ kind: "duplicate", pages: list, at }, { focus: at, select: range(at, list.length), done: `Duplicated ${pageWord(list.length)}` });
}

// Right-click (or press and hold) on a page in the panel.
function pageMenu(at) {
  const list = chosenPages(), n = list.length, last = Math.max(...list);
  showMenu(at, [
    { label: "Insert blank page…", icon: "filePlus", key: keyOf("pages.blank"), run: () => blankPageDialog(last + 1) },
    { label: "Insert pages from another PDF…", icon: "openFile", key: keyOf("pages.insert"), run: () => insertPagesDialog(null, last + 1) },
    { label: n > 1 ? `Duplicate ${n} pages` : "Duplicate page", icon: "duplicate", run: () => duplicatePages(list) },
    "-",
    { label: "Rotate right", icon: "rotateCw", key: keyOf("pages.rotateRight"), run: () => rotatePages(list, 90) },
    { label: "Rotate left", icon: "rotateCcw", key: keyOf("pages.rotateLeft"), run: () => rotatePages(list, -90) },
    { label: "Move to the start", run: () => movePagesTo(list, 0), disabled: list.every((p, k) => p === k) },
    { label: "Move to the end", run: () => movePagesTo(list, pageCount()), disabled: list.every((p, k) => p === pageCount() - n + k) },
    "-",
    { label: n > 1 ? `Delete ${n} pages` : "Delete page", icon: "trash", key: keyOf("pages.delete"), run: () => deletePages(list), disabled: n >= pageCount() },
    { label: "Select all pages", run: () => pagesPanel.selectAll() },
  ]);
}

function addPagesMenu(anchor) {
  const at = pagesPanel.insertAt();
  showMenu(anchor, [
    { label: "Blank page…", icon: "filePlus", key: keyOf("pages.blank"), run: () => blankPageDialog(at) },
    { label: "Pages from another PDF…", icon: "openFile", key: keyOf("pages.insert"), run: () => insertPagesDialog(null, at) },
    { label: "Duplicate the selected pages", icon: "duplicate", run: () => duplicatePages(chosenPages()) },
  ]);
}

// Where new pages go: a choice of positions around page `at`.
function whereOptions(at) {
  const n = pageCount(), ref = Math.max(1, Math.min(n, at));
  return `<option value="${at}">After page ${ref}</option>` + (ref > 1 || at === 0 ? `<option value="${ref - 1}">Before page ${ref}</option>` : "") +
    (at !== n ? `<option value="${n}">At the end</option>` : "") + (at !== 0 ? `<option value="0">At the start</option>` : "");
}

async function blankPageDialog(at = pagesPanel.insertAt()) {
  if (!state.path) return;
  closePopover();
  const ref = viewer.doc.pages[Math.max(0, Math.min(pageCount() - 1, at - 1))];
  const sameMm = `${Math.round((ref.w * 25.4) / 72)} × ${Math.round((ref.h * 25.4) / 72)} mm`;
  const sizes = PAPER.map(([k, w, h, u]) => `<option value="${k}"${cfg.blankSize === k ? " selected" : ""}>${k} (${w} × ${h} ${u})</option>`).join("");
  const r = await dialog({
    title: "Add a blank page",
    html: `<div class="form">
      <label class="field">Size<select id="bp-size"><option value="same"${cfg.blankSize === "same" ? " selected" : ""}>Same as page ${Math.max(1, at)} (${sameMm})</option>${sizes}</select></label>
      <div class="field">Orientation<div class="radios"><label><input type="radio" name="bp-or" value="p" checked> Portrait</label><label><input type="radio" name="bp-or" value="l"> Landscape</label></div></div>
      <label class="field">Where<select id="bp-where">${whereOptions(at)}</select></label>
      <label class="field">How many<input id="bp-count" type="number" min="1" max="100" value="1"></label>
    </div>`,
    buttons: [{ id: "cancel", label: "Cancel" }, { id: "ok", label: "Add", primary: true }],
    collect: (d) => ({ size: d.querySelector("#bp-size").value, land: d.querySelector('input[name="bp-or"]:checked').value === "l", where: +d.querySelector("#bp-where").value, count: Math.max(1, Math.min(100, Math.round(+d.querySelector("#bp-count").value || 1))) }),
  });
  if (!r || r.id !== "ok") return;
  const o = r.data;
  cfg.blankSize = o.size;
  saveCfg();
  let w, h;
  if (o.size === "same") { w = ref.w; h = ref.h; } else {
    const [, a, b, u] = PAPER.find(([k]) => k === o.size);
    const f = u === "mm" ? 72 / 25.4 : 72;
    w = a * f; h = b * f;
  }
  if (o.size !== "same" && o.land) [w, h] = [h, w];
  if (o.size === "same" && o.land !== w > h) [w, h] = [h, w];
  changePages({ kind: "blank", at: o.where, w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100, count: o.count }, { focus: o.where, select: range(o.where, o.count), done: `Added ${pageWord(o.count)}` });
}

// "1-3, 5, 8-" -> 0-based page numbers (null if it doesn't make sense).
function parsePages(text, n) {
  const t = text.trim().toLowerCase();
  if (!t || t === "all") return [...Array(n).keys()];
  const out = [];
  for (const part of t.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*[-–]\s*(\d*)$/) || part.match(/^(\d+)$/);
    if (!m) return null;
    const a = m[1] ? +m[1] : 1, b = m.length > 2 ? (m[2] ? +m[2] : n) : a;
    if (a < 1 || b > n || a > b) return null;
    for (let k = a; k <= b; k++) out.push(k - 1);
  }
  return out;
}

// Copy pages of another PDF into this one.
async function insertPagesDialog(path, at = pagesPanel.insertAt()) {
  if (!state.path) return;
  closePopover();
  path = path || (await host.pickFile());
  if (!path) return;
  const url = host.fileUrl(path);
  let password = null, count = 0;
  for (;;) {
    try { count = await engine.countPagesOf(url, password); break; } catch (err) {
      if (!/password/i.test(err.message)) { toast("Couldn't read that PDF: " + err.message, "error"); return; }
      const pw = await dialog({ title: "Password required", message: `“${baseName(path)}” is protected. Enter its password:`, input: { type: "password" }, buttons: [{ id: "cancel", label: "Cancel" }, { id: "ok", label: "Open", primary: true }] });
      if (pw == null || pw === "cancel") return;
      password = pw;
    }
  }
  const r = await dialog({
    title: "Insert pages",
    html: `<p class="hint" style="margin-bottom:14px">From “${esc(baseName(path))}” (${pageWord(count)}).</p><div class="form">
      <label class="field">Pages<input id="ip-pages" type="text" value="all" placeholder="all, or e.g. 1-3, 5" autocomplete="off"></label>
      <label class="field">Where<select id="ip-where">${whereOptions(at)}</select></label>
      <p class="hint" id="ip-msg"></p>
    </div>`,
    buttons: [{ id: "cancel", label: "Cancel" }, { id: "ok", label: "Insert", primary: true }],
    onMount: (d) => { const i = d.querySelector("#ip-pages"); i.focus(); i.select(); },
    collect: (d) => ({ pages: d.querySelector("#ip-pages").value, where: +d.querySelector("#ip-where").value }),
  });
  if (!r || r.id !== "ok") return;
  const pages = parsePages(r.data.pages, count);
  if (!pages || !pages.length) { toast(`Pages must be between 1 and ${count}, like 1-3, 5`, "error"); return; }
  changePages({ kind: "insert", url, password, pages, at: r.data.where }, { focus: r.data.where, select: range(r.data.where, pages.length), done: `Inserted ${pageWord(pages.length)} from “${baseName(path)}”` });
}

// ------------------------------------------------------------------ snip & paste
// The Snip tool copies an area as a picture: onto the system clipboard (for
// any app) and kept here with its size, so Ctrl+V pastes it back at exactly
// the same size, ready to move or resize.
let clip = null; // { id, png, w, h } (w, h in points)
let markClip = null; // markups copied: { id, items, box }
let lastCopied = null; // "marks" or "picture": what Paste uses when the clipboard can't tell

async function snipFrom(eng, s) {
  const w = s.rect[2] - s.rect[0], h = s.rect[3] - s.rect[1];
  // Sharp: at least 144 dpi, or as sharp as it was on screen; at most 16 MP.
  let res = Math.max(2, s.zoom || 2);
  res = Math.min(res, Math.sqrt(16e6 / Math.max(1, w * h)), 6000 / Math.max(w, h));
  let out;
  try { out = await eng.snip(s.page, s.rect, res); } catch (err) { toast("Couldn't copy that: " + err.message, "error"); return; }
  if (!out) return;
  let png = out.png;
  if (s.poly) png = await lassoCut(png, s.rect, s.poly, res);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  clip = { id, png, w, h };
  lastCopied = "picture";
  // The system clipboard gets the picture (for any app) plus a small html
  // part marking it as ours, so pasting it back here keeps its exact size.
  try {
    await navigator.clipboard.write([new ClipboardItem({
      "image/png": new Blob([png], { type: "image/png" }),
      "text/html": new Blob([`<img data-eagles-snip="${id}" alt="">`], { type: "text/html" }),
    })]);
  } catch {}
  toast("Copied · now tap where it should go (in any open PDF)", "", { label: "Paste", run: () => paste({ center: true }) });
}

// A lasso: keep only what's inside the shape (the rest is transparent).
async function lassoCut(png, rect, poly, res) {
  const bmp = await createImageBitmap(new Blob([png], { type: "image/png" }));
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d");
  const ox = Math.floor(rect[0] * res), oy = Math.floor(rect[1] * res);
  g.beginPath();
  poly.forEach(([x, y], k) => { const X = x * res - ox, Y = y * res - oy; if (k) g.lineTo(X, Y); else g.moveTo(X, Y); });
  g.closePath();
  g.clip();
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
}

async function readClipboard() {
  try {
    for (const it of await navigator.clipboard.read()) {
      const html = it.types.includes("text/html") ? await (await it.getType("text/html")).text() : "";
      const png = it.types.includes("image/png") ? await it.getType("image/png") : null;
      return { ok: true, html, png };
    }
    return { ok: true, html: "", png: null };
  } catch { return { ok: false, html: "", png: null }; }
}

// The picture to paste: our last snip (at its exact size), or one copied in
// another app (at its usual size on screen, 96 dpi).
async function clipboardPicture(cb) {
  const id = (/data-eagles-snip="([\w-]+)"/.exec(cb.html) || [])[1] || null;
  if (cb.png && !(clip && id === clip.id)) {
    const bm = await createImageBitmap(cb.png);
    const pic = { png: new Uint8Array(await cb.png.arrayBuffer()), w: bm.width * 0.75, h: bm.height * 0.75 };
    bm.close();
    return pic;
  }
  return clip;
}

const plural = (n, w) => (n === 1 ? `1 ${w}` : `${n} ${w}s`);

// Paste into the active PDF what was copied last: markups (copied from the
// lasso's selection), or a picture. At `at` ({ page, p }: a tap or a held
// finger), where the pointer is, or in the middle of the view (`center`).
// `picture`: a tap with the Snip tool, which always pastes the snip.
async function paste({ center = false, at = null, picture = false } = {}) {
  const P = active, { viewer, state } = P;
  if (!state.path) return;
  const cb = await readClipboard();
  const marksId = (/data-eagles-marks="([\w-]+)"/.exec(cb.html) || [])[1];
  const marks = !picture && markClip && (marksId === markClip.id || (!marksId && !cb.png && lastCopied === "marks"));
  const pt = at || viewer.pastePoint(center);
  if (!pt || !viewer.doc) return;
  if (marks) {
    if (cfg.tool !== "lasso" && cfg.tool !== "select") setTool("lasso");
    const n = viewer.pasteMarks(markClip, pt.page, pt.p);
    toast(`Pasted ${plural(n, "markup")} · drag to move, corners to resize`);
    return;
  }
  const pic = await clipboardPicture(cb);
  if (!pic) { toast("Nothing to paste yet: select markups with the Lasso and Copy, or snip part of a page"); return; }
  if (cfg.tool !== "select") setTool("select");
  const shrunk = viewer.insertPicture(pt.page, pt.p, pic.png, pic.w, pic.h);
  toast(shrunk ? "Pasted, made smaller to fit the page · drag to move, corners to resize" : "Pasted at the same size · drag to move, corners to resize");
}

// Markups selected with the lasso (or the one selected): copy, cut,
// duplicate. They can be pasted on any page, in any open PDF.
async function copyMarks({ cut = false } = {}) {
  const v = active.viewer;
  const c = await v.copyMarks();
  if (!c) { toast("Select markups first: draw round them with the Lasso, or hold the pen's side button"); return false; }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  markClip = { id, ...c };
  lastCopied = "marks";
  try {
    await navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob([`<div data-eagles-marks="${id}">${c.items.length} markups</div>`], { type: "text/html" }),
      "text/plain": new Blob([plural(c.items.length, "markup") + " copied in Eagles PDF viewer"], { type: "text/plain" }),
    })]);
  } catch {}
  const n = c.items.length;
  if (cut) {
    if (v.groupCount) v.deleteGroup(); else v.deleteSelectedShape();
    toast(`Cut ${plural(n, "markup")} · Paste puts them back where you tap`, "", { label: "Paste", run: () => paste({ center: true }) });
  } else {
    toast(`Copied ${plural(n, "markup")} · Paste puts them where you tap or point`, "", { label: "Paste", run: () => paste({ center: true }) });
  }
  return true;
}

async function duplicateMarks() {
  const v = active.viewer, page = v.groupSel ? v.groupSel.page : v.shapeSel?.page;
  const c = await v.copyMarks();
  if (!c) return;
  const n = v.pasteMarks(c, page, null, 14);
  toast(`Duplicated ${plural(n, "markup")}`);
}

function selectAllMarks(page) {
  if (!viewer.doc) return;
  if (cfg.tool !== "lasso" && cfg.tool !== "select") setTool("lasso");
  const n = viewer.selectAllMarks(page);
  toast(n ? `Selected ${plural(n, "markup")} on this page` : "No markups on this page");
}

// A finger held on the page, or a right-click: what you can do there.
function pageHoldMenu(P, h) {
  const at = h.page != null ? { page: h.page, p: h.p } : null;
  const v = P.viewer;
  showMenu({ x: h.x - 20, y: h.y + 14 }, [
    { label: lastCopied === "marks" && markClip ? `Paste ${plural(markClip.items.length, "markup")} here` : "Paste picture here", icon: "clipboard", key: keyOf("edit.paste"), run: () => paste({ at, center: !at }) },
    { label: "Snip: copy part of a page", icon: "scissors", key: keyOf("tool.snip"), run: () => { setTool("snip"); toast(SNIP_HINT); } },
    { label: "Lasso: select markups", icon: "lasso", key: keyOf("tool.lasso"), run: () => { setTool("lasso"); toast(LASSO_HINT); } },
    { label: "Select all markups on this page", key: keyOf("edit.selectMarks"), run: () => selectAllMarks(h.page ?? undefined) },
    v.hasSelection && { label: "Copy selected text", icon: "copy", key: keyOf("edit.copy"), run: () => copyText(v.sel.text) },
    "-",
    { label: "Open a PDF side by side…", icon: "columns", key: keyOf("view.side"), run: () => openBeside(null), disabled: panes.length >= MAX_PANES },
    { label: "Close this PDF", icon: "x", key: keyOf("view.closePane"), run: () => closePane(P) },
  ]);
}

// ------------------------------------------------------------------ autosave
// With autosave on, each open PDF saves itself a few seconds after changes
// stop (never while you're writing, typing or placing something). Erase areas
// and retyped text are applied only when you save yourself, since that can't
// be undone, and a file another program changed is never overwritten without
// asking.
const AUTOSAVE_MS = 3000;
function setAutosave(on, announce = true) {
  cfg.autosave = !!on;
  saveCfg();
  const b = $("#btn-autosave");
  b.classList.toggle("on", cfg.autosave);
  b.title = cfg.autosave ? "Autosave is on: changes save by themselves. Click to turn it off" : "Autosave is off: click to save changes by themselves";
  if (announce) toast(cfg.autosave ? "Autosave on: changes save by themselves a few seconds after you stop" : "Autosave off: save with Ctrl+S");
  if (cfg.autosave) for (const P of panes) if (P.viewer.dirty) scheduleAutosave(P);
}
function scheduleAutosave(P, ms = AUTOSAVE_MS) {
  if (!cfg.autosave || !P.state.path) return;
  clearTimeout(P.autoTimer);
  P.autoTimer = setTimeout(() => autosave(P), ms);
}
async function autosave(P) {
  if (!cfg.autosave || !panes.includes(P) || !P.state.path || !P.viewer.dirty) return;
  const v = P.viewer;
  if (v.action || v.editing || v.placing || v.mdraft || P.busy || P.state.saving || !modal.hidden) { scheduleAutosave(P, 1500); return; }
  const pend = v.pendingContentEdits();
  if (pend.erase || pend.lines) {
    if (!P.autoNoted) { P.autoNoted = true; toast("Autosave is waiting: erase areas and edited text are applied when you save (Ctrl+S)"); }
    return;
  }
  await save({ quiet: true }, P);
}

// ------------------------------------------------------------------ search
// Ctrl+F: find words in the PDF in use. The edit worker searches a few pages
// at a time, so results come in as it goes and the app stays responsive.
// Matches are marked on the pages; Enter / Shift+Enter (or the arrows) go to
// the next / previous one; the list button shows them all with their context.
const findbar = $("#findbar"), findQ = $("#find-q");
const FIND_MAX = 5000;
let findTimer = 0, findRaf = 0;
function openFind() {
  if (!viewer.doc) { toast("Open a PDF first"); return; }
  findbar.hidden = false;
  active.el.append(findbar);
  findQ.focus();
  findQ.select();
  findSync();
}
function closeFind() {
  findbar.hidden = true;
  for (const P of panes) { P.find = null; P.viewer.setFindHits(null); }
  renderFindList();
  if (document.activeElement === findQ) findQ.blur();
}
// The PDF in use shows results for what's typed (searching if needed).
function findSync() {
  if (findbar.hidden) return;
  const P = active, q = findQ.value;
  if (!P.viewer.doc) { updateFindUI(); return; }
  if (P.find && P.find.q === q) showFind(P);
  else runFind(P, q);
}
async function runFind(P, q) {
  const F = (P.find = { q, hits: [], byPage: new Map(), cur: -1, done: false });
  P.viewer.setFindHits(null);
  if (P === active) { updateFindUI(); renderFindList(); }
  if (!q.trim()) { F.done = true; if (P === active) updateFindUI(); return; }
  const start = P.viewer.currentPage();
  let from = 0;
  try {
    while (from >= 0 && F.hits.length < FIND_MAX) {
      const r = await P.engine.find(q, from);
      if (P.find !== F) return;
      for (const pg of r.pages) {
        const rects = [];
        for (const h of pg.hits) { if (F.hits.length >= FIND_MAX) break; F.hits.push({ page: pg.page, k: rects.length, ...h }); rects.push(h.rect); }
        if (rects.length) F.byPage.set(pg.page, rects);
      }
      from = r.next;
      // Go to the first match from the page you're on, as soon as there is one.
      if (F.cur < 0) { const k = F.hits.findIndex((h) => h.page >= start); if (k >= 0) { F.cur = k; showFind(P, true); continue; } }
      showFindSoon(P);
    }
  } catch (err) {
    if (P.find === F) toast("Search stopped: " + err.message, "error");
  }
  if (P.find !== F) return;
  F.done = true;
  if (F.cur < 0 && F.hits.length) { F.cur = 0; showFind(P, true); }
  else showFind(P);
}
function showFindSoon(P) {
  if (findRaf) return;
  findRaf = requestAnimationFrame(() => { findRaf = 0; if (P.find) showFind(P); });
}
function showFind(P, go = false) {
  const F = P.find, cur = F && F.cur >= 0 ? F.hits[F.cur] : null;
  P.viewer.setFindHits(F ? F.byPage : null, cur ? { page: cur.page, k: cur.k } : null);
  if (go && cur) P.viewer.revealRect(cur.page, cur.rect);
  if (P === active) { updateFindUI(); renderFindList(); }
}
function findStep(dir) {
  const P = active, F = P.find;
  if (!F || !F.hits.length) { findSync(); return; }
  F.cur = (F.cur + dir + F.hits.length) % F.hits.length;
  showFind(P, true);
}
function updateFindUI() {
  const F = active?.find, n = $("#find-n");
  const many = F && F.hits.length >= FIND_MAX ? "+" : "";
  if (!F || !F.q.trim()) n.textContent = "";
  else if (!F.hits.length) n.textContent = F.done ? "No results" : "Searching…";
  else n.textContent = `${F.cur + 1} of ${F.hits.length}${many}${F.done ? "" : "…"}`;
  findbar.classList.toggle("none", !!F && F.done && !F.hits.length && !!F.q.trim());
  $("#find-prev").disabled = $("#find-next").disabled = !F || !F.hits.length;
}
function renderFindList() {
  const box = $("#findlist");
  if (box.hidden) return;
  const F = active?.find;
  const n = F ? F.hits.length : 0;
  let html = `<div class="mk-head"><span class="mk-title">Search <span class="mk-count">${F && F.q.trim() ? `(${n}${n >= FIND_MAX ? "+" : ""})` : ""}</span></span></div><div class="mk-list">`;
  if (!F || !F.q.trim()) html += `<p class="mk-empty">Press Ctrl+F (or the magnifier) and type the words to find.</p>`;
  else if (!n) html += `<p class="mk-empty">${F.done ? `No results for “${esc(F.q)}”.` : "Searching…"}</p>`;
  else {
    let page = -1;
    F.hits.slice(0, 1500).forEach((h, k) => {
      if (h.page !== page) {
        page = h.page;
        const name = viewer.doc?.pages[page]?.name;
        html += `<div class="mk-pg">${esc(name ? `Page ${page + 1} · ${name}` : `Page ${page + 1}`)}</div>`;
      }
      const t = h.text || "";
      html += `<div class="fl-row${k === F.cur ? " sel" : ""}" data-k="${k}" role="button" tabindex="0">${esc(t.slice(0, h.at))}<mark>${esc(t.slice(h.at, h.at + h.len))}</mark>${esc(t.slice(h.at + h.len))}</div>`;
    });
    if (n > 1500) html += `<p class="mk-empty">… and ${n - 1500} more.</p>`;
  }
  box.innerHTML = html + "</div>";
  box.querySelector(".fl-row.sel")?.scrollIntoView({ block: "nearest" });
}
$("#findlist").addEventListener("click", (e) => {
  const row = e.target.closest(".fl-row");
  const F = active?.find;
  if (!row || !F) return;
  F.cur = +row.dataset.k;
  showFind(active, true);
});
findQ.addEventListener("input", () => { clearTimeout(findTimer); findTimer = setTimeout(findSync, 220); });
findQ.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(findTimer);
    if (!active.find || active.find.q !== findQ.value) findSync(); else findStep(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
});
$("#find-next").onclick = () => findStep(1);
$("#find-prev").onclick = () => findStep(-1);
$("#find-close").onclick = () => closeFind();
$("#find-list").onclick = () => showPanel(panelIs("find") ? null : "find");

// ------------------------------------------------------------------ updates
// The installed app looks for a new version a few seconds after it starts
// (and every few hours), from the public releases repository. Updating
// downloads it (checked against its fingerprint), then either restarts now
// or installs when the app closes. Settings, signatures and shortcuts stay.
const canUpdate = !!host.checkUpdate;
let updateInfo = null, updateStatus = null;
function autoUpdateBox() {
  return `<label class="pop-check upd-auto"><input type="checkbox" id="upd-auto"${cfg.autoUpdate !== false ? " checked" : ""}> Look for updates automatically</label>`;
}
const readAuto = (d) => d.querySelector("#upd-auto")?.checked;
function keepAuto(v) { if (typeof v === "boolean" && v !== (cfg.autoUpdate !== false)) { cfg.autoUpdate = v; saveCfg(); } }

async function checkForUpdates({ quiet = false } = {}) {
  if (!canUpdate) return;
  const r = await host.checkUpdate();
  if (!r || r.error) { if (!quiet) toast("Couldn't check for updates: " + (r?.error || "no answer") + ". Are you online?", "error"); return; }
  if (!r.supported) {
    if (!quiet) await dialog({ title: "Updates", message: `This is Eagles PDF viewer ${r.current}. Updates install in the installed Windows app.`, buttons: [{ id: "ok", label: "Close", primary: true }] });
    return;
  }
  updateInfo = r.newer ? r : null;
  $("#btn-more").classList.toggle("badge", !!updateInfo);
  if (!r.newer) {
    if (quiet) return;
    const res = await dialog({ title: "You're up to date", message: `Eagles PDF viewer ${r.current} is the latest version.`, html: autoUpdateBox(), buttons: [{ id: "ok", label: "Close", primary: true }], collect: readAuto });
    keepAuto(res.data);
    return;
  }
  if (quiet) toast(`Eagles PDF viewer ${r.latest} is available`, "", { label: "Update…", run: () => updateDialog() });
  else updateDialog();
}

async function updateDialog() {
  const r = updateInfo;
  if (!r) { checkForUpdates(); return; }
  if (r.ready) { readyDialog(r.latest); return; }
  const mb = r.size ? ` (${Math.max(0.1, r.size / 1e6).toFixed(1)} MB)` : "";
  const res = await dialog({
    title: `Update to version ${r.latest}?`,
    html: `<p>You have version ${esc(r.current)}.${r.notes.length ? " What's new:" : ""}</p>` +
      (r.notes.length ? `<ul class="upd-notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "") +
      `<p class="hint">The download${mb} is checked before it's used. Your settings, signatures, shortcuts and PDFs are kept.` +
      (r.kind === "setup" ? " This version needs a new app runtime, so the installer window opens to finish." : "") + `</p>` + autoUpdateBox(),
    buttons: [{ id: "later", label: "Later" }, { id: "go", label: "Update now", primary: true }],
    collect: readAuto,
  });
  keepAuto(res.data);
  if (res.id === "go") downloadUpdate();
}

function showUpdateStatus(text) {
  if (!text) { updateStatus?.remove(); updateStatus = null; return; }
  if (!updateStatus) {
    updateStatus = document.createElement("div");
    updateStatus.className = "toast upd-status";
    updateStatus.innerHTML = icon("download") + "<span></span>";
    $("#toasts").appendChild(updateStatus);
  }
  updateStatus.querySelector("span").textContent = text;
}
if (canUpdate) host.onUpdateProgress((p) => { if (updateStatus) showUpdateStatus(`Downloading the update… ${Math.round(p * 100)}%`); });

async function downloadUpdate() {
  const v = updateInfo.latest;
  showUpdateStatus("Downloading the update…");
  const d = await host.downloadUpdate();
  showUpdateStatus(null);
  if (!d || !d.ok) { toast("The update couldn't be downloaded: " + (d?.error || "unknown problem"), "error"); return; }
  updateInfo.ready = true;
  readyDialog(v);
}

async function readyDialog(v) {
  const r = await dialog({
    title: "The update is ready",
    message: `Version ${v} is downloaded. Restart Eagles PDF viewer now to start using it, or it installs by itself when you close the app.`,
    buttons: [{ id: "later", label: "When I close the app" }, { id: "now", label: "Restart now", primary: true }],
  });
  if (r === "now") restartToUpdate();
  else { await host.installUpdateOnQuit(); toast(`Version ${v} installs when you close the app`); }
}

async function restartToUpdate() {
  for (const P of panes.slice()) if (!(await confirmDiscard(P))) return;
  for (const P of panes) storeView(P);
  saveSession();
  await saveCfg(true);
  const r = await host.installUpdate(true);
  if (!r || !r.ok) toast("Couldn't install the update: " + (r?.error || "unknown problem"), "error");
}

// ------------------------------------------------------------------ toolbar (ribbon)
// You choose which buttons the toolbar shows (⋯ → Customize the toolbar, or
// right-click it). The buttons get smaller when there are many, so the
// groups never run into each other; at the very smallest the tools scroll.
const RIBBON = [
  ["Window", [["sidebar", "File list button", true], ["title", "File name", true]]],
  ["Tools", [["tool.select", "Select", true], ["tool.hand", "Pan", true], ["tool.highlight", "Highlight", true], ["tool.pen", "Pen", true], ["tool.box", "Shapes", true], ["tool.sign", "Signature", true], ["tool.eraser", "Eraser", true], ["tool.lasso", "Lasso select", true], ["tool.snip", "Snip", true], ["tool.content", "Edit content", true], ["tool.measure", "Measure", true]]],
  ["Edit", [["style", "Colour and size", true], ["touch", "Finger draws", true], ["undo", "Undo", true], ["redo", "Redo", true], ["paste", "Paste", false]]],
  ["View", [["search", "Search", true], ["zoomout", "Zoom out", true], ["zoom", "Zoom level", true], ["zoomin", "Zoom in", true], ["fitw", "Fit width", true], ["fitp", "Fit page", true], ["side", "Open side by side", false], ["fullscreen", "Full screen", false]]],
  ["Panels and saving", [["pages", "Pages panel", true], ["marks", "Markups list", true], ["autosave", "Autosave on / off", false], ["save", "Save", true]]],
];
const RB_DEFAULT = new Map(RIBBON.flatMap(([, items]) => items.map(([id, , on]) => [id, on])));
const RB_SIZES = { large: 40, medium: 34, small: 28 };
if (!cfg.ribbon || typeof cfg.ribbon !== "object") cfg.ribbon = {};
const rbShown = (id) => (typeof cfg.ribbon[id] === "boolean" ? cfg.ribbon[id] : RB_DEFAULT.get(id) !== false);
function applyRibbon() {
  for (const node of document.querySelectorAll("[data-rb]")) node.hidden = !rbShown(node.dataset.rb);
  document.querySelector("[data-rb-sep]").hidden = !(rbShown("undo") || rbShown("redo") || rbShown("paste"));
  $("#tools").hidden = ![...$("#tools").children].some((b) => !b.hidden);
  fitToolbar();
}
let fitRaf = 0;
function fitToolbar() {
  cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(() => {
    const tb = $("#toolbar"), max = RB_SIZES[cfg.ribbonSize] || 40;
    tb.classList.remove("squeeze");
    for (const sz of [40, 37, 34, 31, 28, 26]) {
      if (sz > max) continue;
      tb.style.setProperty("--b", sz + "px");
      if (tb.scrollWidth <= tb.clientWidth + 1) return;
    }
    tb.classList.add("squeeze");
  });
}
window.addEventListener("resize", fitToolbar);
function ribbonDialog() {
  closePopover();
  const sizes = [["auto", "Automatic (fits the window)"], ["large", "Large"], ["medium", "Medium"], ["small", "Small"]];
  const html = `<p class="hint" style="margin-bottom:12px">Choose what the toolbar shows. When it shows a lot, the buttons get smaller so everything fits. Anything you hide is still in the ⋯ menu and on its keyboard shortcut.</p>
    <div class="rb-groups">${RIBBON.map(([g, items]) => `<div class="rb-group"><div class="pop-title">${esc(g)}</div>${items.map(([id, label]) => `<label class="pop-check"><input type="checkbox" data-rb-id="${id}"${rbShown(id) ? " checked" : ""}> ${esc(label)}</label>`).join("")}</div>`).join("")}</div>
    <label class="field rb-size"><span>Button size</span><select id="rb-size">${sizes.map(([k, l]) => `<option value="${k}"${(cfg.ribbonSize || "auto") === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>`;
  return dialog({
    title: "Customize the toolbar",
    wide: true,
    html,
    buttons: [{ id: "reset", label: "Reset to default", left: true }, { id: "ok", label: "Done", primary: true }],
    onMount(d) {
      d.addEventListener("change", (e) => {
        if (e.target.id === "rb-size") cfg.ribbonSize = e.target.value;
        else if (e.target.dataset.rbId) cfg.ribbon[e.target.dataset.rbId] = e.target.checked;
        else return;
        applyRibbon();
        saveCfg();
      });
    },
  }).then((r) => {
    if (r !== "reset") return;
    cfg.ribbon = {};
    cfg.ribbonSize = "auto";
    applyRibbon();
    saveCfg();
    ribbonDialog();
  });
}
$("#toolbar").addEventListener("contextmenu", (e) => {
  if (e.target.closest("input")) return;
  e.preventDefault();
  showMenu({ x: e.clientX, y: e.clientY + 8 }, [{ label: "Customize the toolbar…", icon: "sliders", key: keyOf("view.ribbon"), run: () => ribbonDialog() }]);
});

// ------------------------------------------------------------------ merging
const dirOf = (p) => p.replace(/[\\/][^\\/]*$/, "");
const sepOf = (p) => (p.includes("\\") ? "\\" : "/");

function fileMenu(at, p, isFile, picks) {
  if (picks && picks.length > 1) {
    showMenu(at, [
      { label: `Merge ${picks.length} PDFs…`, icon: "merge", run: () => mergeDialog(picks) },
      { label: "Clear the selection", icon: "x", run: () => sidebar.clearPicked() },
    ]);
  } else if (isFile) {
    showMenu(at, [
      { label: "Open", run: () => openFile(p) },
      { label: "Open side by side", icon: "columns", key: keyOf("view.side"), run: () => openBeside(p), disabled: panes.length >= MAX_PANES && !panes.some((Q) => samePath(Q.state.path, p)) },
      { label: "Select for merging", icon: "check", run: () => sidebar.startPicking(p) },
      state.path && { label: "Insert into the open PDF…", icon: "filePlus", run: () => insertPagesDialog(p) },
      "-",
      { label: "Show in folder", icon: "external", run: () => host.showInFolder(p) },
      { label: "Copy path", icon: "copy", run: () => navigator.clipboard.writeText(p) },
    ]);
  } else {
    const files = sidebar.filesUnder(p);
    showMenu(at, [
      { label: `Merge all ${files.length} PDFs in this folder…`, icon: "merge", run: () => mergeDialog(files, p), disabled: files.length < 2 },
      "-",
      { label: "Show in folder", icon: "external", run: () => host.showInFolder(p) },
      { label: "Copy path", icon: "copy", run: () => navigator.clipboard.writeText(p) },
    ]);
  }
}

function mergeFolder() {
  if (!cfg.folder) { toast("Open a folder first"); return; }
  mergeDialog(sidebar.filesUnder(cfg.folder), cfg.folder);
}

// Choose the order, then save the merged PDF (and open it).
async function mergeDialog(paths, folder = null) {
  closePopover();
  let list = paths.slice();
  if (list.length < 2) { toast("Choose at least two PDFs to merge"); return; }
  const root = cfg.folder || "";
  const render = (d) => {
    const box = d.querySelector(".merge-list");
    box.innerHTML = list.map((p, k) => {
      const rel = root && p.startsWith(root) ? dirOf(p).slice(root.length).replace(/^[\\/]/, "") : "";
      return `<div class="ml-row" data-k="${k}"><span class="ml-n">${k + 1}</span><span class="ml-name" title="${esc(p)}">${esc(baseName(p).replace(/\.pdf$/i, ""))}${rel ? `<span class="ml-dir">${esc(rel)}</span>` : ""}</span>` +
        `<button class="btn" data-mv="-1" title="Move up"${k ? "" : " disabled"}>${icon("chevron")}</button><button class="btn" data-mv="1" title="Move down"${k < list.length - 1 ? "" : " disabled"}>${icon("chevron")}</button><button class="btn" data-rm title="Leave out">${icon("x")}</button></div>`;
    }).join("");
    const ok = d.querySelector(".row .primary");
    ok.textContent = `Merge ${list.length} PDFs…`;
    ok.disabled = list.length < 2;
  };
  const r = await dialog({
    title: folder ? `Merge “${baseName(folder)}”` : "Merge PDFs",
    wide: true,
    html: `<p>The pages of each PDF are added in this order${folder ? " (subfolders included)" : ""}. Use the arrows to change it.</p><div class="merge-list"></div>`,
    buttons: [{ id: "cancel", label: "Cancel" }, { id: "ok", label: "Merge", primary: true }],
    onMount: (d) => {
      render(d);
      d.querySelector(".merge-list").addEventListener("click", (e) => {
        const row = e.target.closest(".ml-row"), b = e.target.closest("button");
        if (!row || !b) return;
        const k = +row.dataset.k;
        if (b.dataset.rm != null) list.splice(k, 1);
        else { const j = k + +b.dataset.mv; [list[k], list[j]] = [list[j], list[k]]; }
        render(d);
      });
    },
  });
  if (r !== "ok" || list.length < 2) return;
  const base = folder || dirOf(list[0]);
  const name = folder ? `${baseName(folder)} (merged).pdf` : "Merged.pdf";
  await mergeFiles(list, base + sepOf(base) + name);
}

async function mergeFiles(list, defaultPath) {
  const spin = setTimeout(() => appEl.classList.add("loading"), 100);
  toast(`Merging ${list.length} PDFs…`);
  let out;
  try {
    out = await engine.merge(list.map((p) => ({ url: host.fileUrl(p), name: baseName(p) })));
  } catch (err) {
    toast("Couldn't merge: " + err.message, "error");
    return;
  } finally {
    clearTimeout(spin);
    appEl.classList.remove("loading");
  }
  const target = await host.saveAs(defaultPath, out.bytes);
  if (!target) return;
  sidebar.clearPicked();
  const merged = list.length - out.failed.length;
  toast(`Merged ${merged} PDFs (${pageWord(out.pages)}) into “${baseName(target)}”`);
  if (out.failed.length) toast(`Left out: ${out.failed.map((f) => `${f.name} (${f.why})`).join(", ")}`, "error");
  if (cfg.folder) loadFolder(cfg.folder, false);
  openFile(target);
}

// Embed every markup into the pages, so it can no longer be moved, edited or
// deleted (in this app or any other PDF app). Saved as a copy or over the file.
async function embedMarkups() {
  const P = active, { viewer, engine, state } = P;
  if (!state.path || state.saving) return;
  viewer.commitEdits();
  if (viewer.placing) viewer.finishPlacing(true);
  const pend = viewer.pendingContentEdits();
  const r = await dialog({
    title: "Embed markups",
    message: "Highlights, drawings, shapes, text boxes and signatures become part of the pages: they can't be moved, edited or deleted any more." + (pend.erase || pend.lines ? " Erase areas and edited text are applied too." : "") + "\n\nSave the result as a new copy (this file keeps its editable markups), or replace this file.",
    buttons: [{ id: "cancel", label: "Cancel" }, { id: "replace", label: "Replace this file" }, { id: "copy", label: "Save as a copy…", primary: true }],
  });
  if (r !== "copy" && r !== "replace") return;
  state.saving = true;
  $("#btn-save").classList.add("saving");
  const seq = viewer.historySeq, path = state.path;
  let failure = null, reopen = null;
  try {
    const out = await engine.exportCopy(true);
    if (!out) throw new Error("Document closed");
    if (r === "copy") {
      const target = await host.saveAs(path.replace(/(\.pdf)?$/i, " (embedded).pdf"), out.bytes);
      if (target) {
        if (cfg.scales[path] && !cfg.scales[target]) { cfg.scales[target] = cfg.scales[path]; saveCfg(); }
        toast(`Saved “${baseName(target)}” with the markups embedded`);
      }
    } else {
      const w = await host.writeFile(path, out.bytes);
      if (!w || !w.ok) throw new Error(w?.error || "Write failed");
      viewer.markSaved(seq);
      reopen = path;
    }
  } catch (err) {
    failure = err;
  } finally {
    state.saving = false;
    $("#btn-save").classList.remove("saving");
  }
  if (failure) await dialog({ title: "Couldn't embed the markups", message: `${failure.message}\n\nThe file may be open in another app or in a read-only folder. Nothing was changed.`, buttons: [{ id: "ok", label: "Close", primary: true }] });
  if (reopen) { await openIn(P, reopen, { force: true }); toast("Markups embedded"); }
}

// `quiet`: autosave (no messages; skips anything that needs asking).
async function save({ as = false, quiet = false } = {}, P = active) {
  const { viewer, engine, state } = P;
  if (!state.path || state.saving) return;
  if (!quiet) viewer.commitEdits();
  if (viewer.placing && !quiet) viewer.finishPlacing(true);
  if (!as && !viewer.dirty) { if (!quiet) toast("No changes to save"); return; }
  // Erase areas and edited text are applied when saving; after that they
  // can't be undone.
  const pend = viewer.pendingContentEdits();
  const erase = pend.erase + pend.lines;
  if (quiet && erase) return;
  if (pend.erase) {
    const r = await dialog({
      title: "Erase for good?",
      message: `${pend.erase === 1 ? "1 erase area" : pend.erase + " erase areas"} will be applied: the text, pictures, drawings and markups under ${pend.erase === 1 ? "it" : "them"} are removed from the PDF and can't be brought back after saving.`,
      buttons: [{ id: "cancel", label: "Cancel" }, { id: "ok", label: "Erase and save", primary: true }],
    });
    if (r !== "ok") return;
  }
  state.saving = true;
  $("#btn-save").classList.add("saving");
  const seq = viewer.historySeq;
  const path = state.path;
  let failure = null, retryAs = false, skip = false, reopen = null;
  try {
    // With erase areas the whole file is rewritten, so nothing erased is
    // left behind in it.
    const out = erase ? await engine.exportCopy(false) : await engine.save("incremental");
    if (!out) throw new Error("Document closed");
    if (as) {
      const target = await host.saveAs(path, out.bytes);
      if (target) {
        if (cfg.scales[path] && !cfg.scales[target]) cfg.scales[target] = cfg.scales[path];
        state.path = target;
        state.mtime = (await host.stat(target).catch(() => null))?.mtime || 0;
        if (P === active) { cfg.lastFile = target; sidebar.setCurrent(target); }
        saveSession();
        viewer.markSaved(seq);
        if (erase) reopen = target; else toast("Saved as " + baseName(target));
      }
    } else {
      // Don't silently clobber edits another program made after we opened the file.
      const cur = await host.stat(path).catch(() => null);
      if (cur && state.mtime && Math.abs(cur.mtime - state.mtime) > 2 && quiet) {
        // Autosave never overwrites another program's changes.
        skip = true;
        if (P.autoBlocked !== cur.mtime) { P.autoBlocked = cur.mtime; toast(`Autosave paused: “${baseName(path)}” was changed by another program. Press Ctrl+S to choose what to do.`, "error"); }
      } else if (cur && state.mtime && Math.abs(cur.mtime - state.mtime) > 2) {
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
        P.autoNoted = false;
        if (erase) reopen = path; else if (!quiet) toast("Saved");
      }
    }
    updatePaneHead(P);
    if (P === active) updateTitle();
  } catch (err) {
    failure = err;
  } finally {
    state.saving = false;
    $("#btn-save").classList.remove("saving");
  }
  if (retryAs) return save({ as: true }, P);
  // Show the pages as saved (erased content gone).
  if (reopen) {
    await openIn(P, reopen, { force: true });
    const parts = ["Saved"];
    if (pend.erase) parts.push(pend.erase === 1 ? "1 area erased" : `${pend.erase} areas erased`);
    if (pend.lines) parts.push(pend.lines === 1 ? "1 line edited" : `${pend.lines} lines edited`);
    toast(parts.join(" · "));
  }
  if (failure && quiet) {
    toast(`Autosave couldn't save “${baseName(state.path)}”: ${failure.message}`, "error");
    return;
  }
  if (failure) {
    const r = await dialog({
      title: "Couldn't save",
      message: `${failure.message}\n\nThe file may be open in another app or in a read-only folder.`,
      buttons: [{ id: "cancel", label: "Close" }, { id: "as", label: "Save as…", primary: true }],
    });
    if (r === "as") await save({ as: true }, P);
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
  // A page number, or a page's name ("A-101").
  const named = viewer.doc.pages.some((p) => p.name);
  pagePill.innerHTML = `<input type="text" inputmode="${named ? "text" : "numeric"}" autocomplete="off" value="${viewer.currentPage() + 1}"> / ${n}`;
  const inp = pagePill.querySelector("input");
  inp.focus();
  inp.select();
  let closed = false;
  const finish = (go) => {
    if (closed) return;
    closed = true;
    const t = inp.value.trim(), v = /^\d+$/.test(t) ? parseInt(t, 10) : NaN;
    let target = v >= 1 && v <= n ? v - 1 : -1;
    if (target < 0 && t) {
      const low = t.toLowerCase(), P = viewer.doc.pages;
      target = P.findIndex((p) => (p.name || "").toLowerCase() === low);
      if (target < 0) target = P.findIndex((p) => (p.name || "").toLowerCase().includes(low));
    }
    showPagePill(viewer.currentPage(), n);
    if (go && target >= 0) viewer.goToPage(target);
    else if (go && t) toast(`No page “${t}”`, "error");
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
// Every function is a command with default keys; users can change them in
// ⋯ → Keyboard shortcuts (saved as cfg.keys). Keys that only mean something
// in a mode (Enter, Esc, Backspace while measuring, placing or typing) are fixed.
const hasDoc = () => viewer.pageCount > 0;
function setShapeKind(k) { cfg.shape = k; updateToolIcons(); applyStyles(); setTool("box"); saveCfg(); }
function setMeasureModeCmd(m) { cfg.measure.mode = m; setTool("measure"); viewer.setMeasureMode(m); saveCfg(); updateMeasureBar(); }
function openToolMenu() {
  if (cfg.tool === "measure") openMeasurePopover();
  else if (cfg.tool === "sign") openSignPanel();
  else if (cfg.tool === "content") toast(CONTENT_HINT);
  else openStylePopover();
}
async function addSignatureFromFile() {
  if (cfg.tool !== "sign") setTool("sign");
  const paths = await host.pickImages();
  if (paths && paths[0]) prepareSignature(paths[0]);
}
function placeLastSig() {
  const last = sigLib.find((x) => x.id === cfg.lastSig) || sigLib[0];
  if (last) placeSig(last); else openSignPanel();
}
// Keys act on the active PDF (the one touched last).
const nv = () => viewer;
const vh = () => viewer.vh;
const wide = () => viewer.L && viewer.L.worldW > viewer.vw;

const COMMANDS = [
  // File
  { id: "file.openFolder", group: "File", label: "Open folder…", keys: ["Ctrl+O"], typing: true, run: () => pickFolder() },
  { id: "file.openFile", group: "File", label: "Open file…", keys: [], typing: true, run: () => pickFile() },
  { id: "file.save", group: "File", label: "Save", keys: ["Ctrl+S"], typing: true, run: () => save() },
  { id: "file.saveAs", group: "File", label: "Save as…", keys: ["Ctrl+Shift+S"], typing: true, run: () => save({ as: true }) },
  { id: "file.embed", group: "File", label: "Embed markups into the pages…", keys: [], when: () => !!state.path, run: () => embedMarkups() },
  { id: "file.mergeFolder", group: "File", label: "Merge all PDFs in the folder…", keys: [], when: () => !!cfg.folder, run: () => mergeFolder() },
  { id: "file.mergeSelected", group: "File", label: "Merge the selected PDFs…", keys: [], when: () => sidebar.picked.size > 1, run: () => mergeDialog(sidebar.pickedList()) },
  // Pages
  { id: "pages.panel", group: "Pages", label: "Show / hide the Pages panel", keys: ["Ctrl+Shift+P"], typing: true, run: () => togglePages() },
  { id: "pages.blank", group: "Pages", label: "Add a blank page…", keys: [], when: hasDoc, run: () => blankPageDialog() },
  { id: "pages.insert", group: "Pages", label: "Insert pages from another PDF…", keys: [], when: hasDoc, run: () => insertPagesDialog(null) },
  { id: "pages.duplicate", group: "Pages", label: "Duplicate the selected pages", keys: [], when: hasDoc, run: () => duplicatePages(chosenPages()) },
  { id: "pages.delete", group: "Pages", label: "Delete the selected pages", keys: [], when: hasDoc, run: () => deletePages(chosenPages()) },
  { id: "pages.rotateRight", group: "Pages", label: "Rotate the selected pages right", keys: [], when: hasDoc, run: () => rotatePages(chosenPages(), 90) },
  { id: "pages.rotateLeft", group: "Pages", label: "Rotate the selected pages left", keys: [], when: hasDoc, run: () => rotatePages(chosenPages(), -90) },
  { id: "file.showInFolder", group: "File", label: "Show in folder", keys: [], when: () => !!state.path, run: () => host.showInFolder(state.path) },
  { id: "file.next", group: "File", label: "Next PDF in the list", keys: ["Alt+ArrowDown"], run: () => stepFile(1) },
  { id: "file.prev", group: "File", label: "Previous PDF in the list", keys: ["Alt+ArrowUp"], run: () => stepFile(-1) },
  { id: "file.filter", group: "File", label: "Filter the file list", keys: ["Ctrl+Shift+F"], typing: true, run: () => { toggleSidebar(true); sidebar.input.focus(); sidebar.input.select(); } },
  { id: "file.autosave", group: "File", label: "Autosave on / off", keys: [], typing: true, run: () => setAutosave(!cfg.autosave) },
  // Search
  { id: "find.open", group: "Search", label: "Search in this PDF", keys: ["Ctrl+F"], typing: true, run: () => (hasDoc() ? openFind() : (toggleSidebar(true), sidebar.input.focus())) },
  { id: "find.next", group: "Search", label: "Next result", keys: ["F3"], typing: true, run: () => findStep(1) },
  { id: "find.prev", group: "Search", label: "Previous result", keys: ["Shift+F3"], typing: true, run: () => findStep(-1) },
  { id: "panel.marks", group: "Search", label: "Show / hide the markups list", keys: ["Ctrl+Shift+M"], typing: true, run: () => toggleMarks() },
  { id: "file.sidebar", group: "File", label: "Show / hide the file list", keys: ["Ctrl+B"], typing: true, run: () => toggleSidebar() },
  { id: "file.refresh", group: "File", label: "Refresh the file list", keys: ["F5"], when: () => !!cfg.folder, run: () => loadFolder(cfg.folder, false) },
  // Edit
  { id: "edit.undo", group: "Edit", label: "Undo", keys: ["Ctrl+Z"], run: () => undo() },
  { id: "edit.redo", group: "Edit", label: "Redo", keys: ["Ctrl+Y", "Ctrl+Shift+Z"], run: () => redo() },
  { id: "edit.copy", group: "Edit", label: "Copy (selected text or markups)", keys: ["Ctrl+C"], when: () => viewer.hasSelection || !!viewer.groupCount || !!viewer.selectedShape, run: () => (viewer.hasSelection ? copyText(viewer.sel.text) : copyMarks()) },
  { id: "edit.cut", group: "Edit", label: "Cut the selected markups", keys: ["Ctrl+X"], when: () => !!viewer.groupCount || !!viewer.selectedShape, run: () => copyMarks({ cut: true }) },
  { id: "edit.paste", group: "Edit", label: "Paste (markups, or a picture at the same size)", keys: ["Ctrl+V"], when: hasDoc, run: () => paste() },
  { id: "edit.duplicate", group: "Edit", label: "Duplicate the selected markups", keys: ["Ctrl+D"], when: () => !!viewer.groupCount || !!viewer.selectedShape, run: () => duplicateMarks() },
  { id: "edit.selectMarks", group: "Edit", label: "Select all markups on the page", keys: ["Ctrl+Shift+A"], when: hasDoc, run: () => selectAllMarks() },
  { id: "edit.selectAll", group: "Edit", label: "Select all text on the page", keys: ["Ctrl+A"], when: hasDoc, run: () => { if (cfg.tool !== "select") setTool("select"); viewer.selectAllOnPage(); } },
  { id: "edit.editText", group: "Edit", label: "Edit the selected text box or callout", keys: ["Enter", "F2"], when: () => ["text", "callout"].includes(viewer.selectedShape), run: () => viewer.editSelectedText() },
  { id: "edit.delete", group: "Edit", label: "Delete the selected markups", keys: ["Delete", "Backspace"], when: () => !!viewer.selectedShape || !!viewer.groupCount || viewer.placingExisting, run: () => (viewer.placingExisting ? viewer.finishPlacing("delete") : viewer.groupCount ? viewer.deleteGroup() : viewer.deleteSelectedShape()) },
  // Tools
  { id: "tool.select", group: "Tools", label: "Select (text and markups)", keys: ["V"], run: () => setTool("select") },
  { id: "tool.hand", group: "Tools", label: "Pan", keys: ["H"], run: () => setTool("hand") },
  { id: "tool.highlight", group: "Tools", label: "Highlight", keys: ["M"], run: () => setTool("highlight") },
  { id: "tool.pen", group: "Tools", label: "Pen", keys: ["P"], run: () => setTool("pen") },
  { id: "tool.box", group: "Tools", label: "Shapes tool", keys: ["B"], run: () => setTool("box") },
  { id: "tool.sign", group: "Tools", label: "Signature tool", keys: ["S"], run: () => setTool("sign") },
  { id: "tool.eraser", group: "Tools", label: "Eraser", keys: ["E"], run: () => setTool("eraser") },
  { id: "tool.measure", group: "Tools", label: "Measure", keys: ["R"], run: () => setTool("measure") },
  { id: "tool.content", group: "Tools", label: "Edit content tool", keys: ["X"], run: () => setTool("content") },
  { id: "tool.snip", group: "Tools", label: "Snip: copy an area as a picture", keys: ["C"], run: () => setTool("snip") },
  { id: "tool.lasso", group: "Tools", label: "Lasso: select several markups", keys: ["L"], run: () => setTool("lasso") },
  { id: "highlight.words", group: "Tools", label: "Highlighter highlights words", keys: [], run: () => setHighlightMode("words") },
  { id: "highlight.draw", group: "Tools", label: "Highlighter draws freely", keys: [], run: () => setHighlightMode("draw") },
  { id: "tool.touch", group: "Tools", label: "Finger draws on / off", keys: ["T"], run: () => setTouchDraws(!cfg.touchDraws) },
  { id: "tool.menu", group: "Tools", label: "Colour and size menu for the current tool", keys: [], run: () => openToolMenu() },
  // Shapes
  ...SHAPES.map(([k, , l]) => ({ id: "shape." + k, group: "Shapes", label: l, keys: [], run: () => setShapeKind(k) })),
  // Signature
  { id: "sig.panel", group: "Signature", label: "Open My signatures", keys: [], run: () => { if (cfg.tool !== "sign") setTool("sign"); openSignPanel(); } },
  { id: "sig.add", group: "Signature", label: "Add signature from file…", keys: [], run: () => addSignatureFromFile() },
  { id: "sig.placeLast", group: "Signature", label: "Place my last signature", keys: [], when: hasDoc, run: () => placeLastSig() },
  // Measure
  { id: "measure.distance", group: "Measure", label: "Measure distance", keys: [], run: () => setMeasureModeCmd("distance") },
  { id: "measure.path", group: "Measure", label: "Measure path length", keys: [], run: () => setMeasureModeCmd("path") },
  { id: "measure.area", group: "Measure", label: "Measure area", keys: [], run: () => setMeasureModeCmd("area") },
  { id: "measure.scale", group: "Measure", label: "Drawing scale…", keys: [], when: hasDoc, run: () => scaleDialog() },
  { id: "measure.calibrate", group: "Measure", label: "Calibrate the scale", keys: [], when: hasDoc, run: () => { setTool("measure"); viewer.startCalibrate(); } },
  // View
  { id: "view.zoomIn", group: "View", label: "Zoom in", keys: ["Ctrl+=", "Ctrl+Shift+=", "Ctrl++"], repeat: true, run: () => nv().zoomBy(1.25) },
  { id: "view.zoomOut", group: "View", label: "Zoom out", keys: ["Ctrl+-"], repeat: true, run: () => nv().zoomBy(0.8) },
  { id: "view.fitWidth", group: "View", label: "Fit width", keys: ["Ctrl+0"], run: () => nv().fit("width") },
  { id: "view.fitPage", group: "View", label: "Fit page", keys: ["Ctrl+9"], run: () => nv().fit("page") },
  { id: "view.actual", group: "View", label: "Actual size (100%)", keys: ["Ctrl+1"], run: () => nv().setZoom(96 / 72) },
  { id: "view.fullscreen", group: "View", label: "Full screen", keys: ["F11"], typing: true, run: () => host.toggleFullscreen() },
  { id: "view.side", group: "View", label: "Open a PDF side by side…", keys: ["Ctrl+Shift+O"], typing: true, run: () => openBeside(null) },
  { id: "view.closePane", group: "View", label: "Close this PDF", keys: ["Ctrl+W"], typing: true, when: () => !!state.path || panes.length > 1, run: () => closePane(active) },
  { id: "view.nextPane", group: "View", label: "Go to the next PDF side by side", keys: ["Ctrl+Tab"], typing: true, when: () => panes.length > 1, run: () => cyclePane(1) },
  { id: "view.prevPane", group: "View", label: "Go to the previous PDF side by side", keys: ["Ctrl+Shift+Tab"], typing: true, when: () => panes.length > 1, run: () => cyclePane(-1) },
  { id: "view.paneBack", group: "View", label: "Move this PDF left (or up)", keys: [], when: () => panes.indexOf(active) > 0, run: () => movePane(active, panes.indexOf(active) - 1) },
  { id: "view.paneForward", group: "View", label: "Move this PDF right (or down)", keys: [], when: () => panes.indexOf(active) < panes.length - 1, run: () => movePane(active, panes.indexOf(active) + 2) },
  { id: "view.ribbon", group: "View", label: "Customize the toolbar…", keys: [], typing: true, run: () => ribbonDialog() },
  { id: "view.wheel", group: "View", label: "Switch the mouse wheel between scroll and zoom", keys: [], run: () => setWheel(cfg.wheel === "zoom" ? "scroll" : "zoom") },
  // Navigate
  { id: "nav.down", group: "Navigate", label: "Scroll down", keys: ["ArrowDown"], repeat: true, run: () => nv().scrollBy(0, 60) },
  { id: "nav.up", group: "Navigate", label: "Scroll up", keys: ["ArrowUp"], repeat: true, run: () => nv().scrollBy(0, -60) },
  { id: "nav.right", group: "Navigate", label: "Scroll right (or next page)", keys: ["ArrowRight"], repeat: true, run: () => (wide() ? nv().scrollBy(60, 0) : nv().pageStep(1)) },
  { id: "nav.left", group: "Navigate", label: "Scroll left (or previous page)", keys: ["ArrowLeft"], repeat: true, run: () => (wide() ? nv().scrollBy(-60, 0) : nv().pageStep(-1)) },
  { id: "nav.screenDown", group: "Navigate", label: "Down a screen", keys: ["PageDown", "Space"], repeat: true, run: () => nv().scrollBy(0, vh() * 0.9) },
  { id: "nav.screenUp", group: "Navigate", label: "Up a screen", keys: ["PageUp", "Shift+Space"], repeat: true, run: () => nv().scrollBy(0, -vh() * 0.9) },
  { id: "nav.nextPage", group: "Navigate", label: "Next page", keys: [], repeat: true, run: () => nv().pageStep(1) },
  { id: "nav.prevPage", group: "Navigate", label: "Previous page", keys: [], repeat: true, run: () => nv().pageStep(-1) },
  { id: "nav.first", group: "Navigate", label: "First page", keys: ["Home"], run: () => nv().goToPage(0) },
  { id: "nav.last", group: "Navigate", label: "Last page", keys: ["End"], run: () => nv().goToPage(nv().pageCount - 1) },
  { id: "nav.goto", group: "Navigate", label: "Go to page…", keys: ["Ctrl+G"], when: hasDoc, run: () => pagePill.onclick() },
  // Help
  { id: "help.help", group: "Help", label: "Keyboard, touch and pen help", keys: ["F1"], typing: true, run: () => showHelp() },
  { id: "help.keys", group: "Help", label: "Customize keyboard shortcuts…", keys: ["Ctrl+K"], typing: true, run: () => shortcutsDialog() },
];
cfg.keys = cfg.keys && typeof cfg.keys === "object" ? cfg.keys : {};
const keymap = new Keymap(COMMANDS, cfg.keys);

// Keys that only apply in a mode. Returns true if handled.
function contextKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key === "Escape") {
    if (!pop.hidden) closePopover();
    else if (viewer.placing) viewer.finishPlacing(false);
    else if (viewer.groupCount) viewer.clearGroup();
    else if (viewer.selectedShape) viewer.deselectShape();
    else if (viewer.mdraft || viewer._calibrating) viewer.cancelMeasure();
    else if (viewer.hasSelection) viewer.clearSelection();
    else if (!findbar.hidden) closeFind();
    else return false;
    return true;
  }
  // Arrow keys move markups selected with the lasso (Shift: further).
  if (viewer.groupCount && e.key.startsWith("Arrow")) {
    const st = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
    if (d) { viewer.nudgeGroup(...d); return true; }
  }
  if (viewer.placing && e.key === "Enter") { viewer.finishPlacing(true); return true; }
  if (cfg.tool === "measure" && viewer.mdraft) {
    if (e.key === "Enter") { viewer.finishMeasure(); return true; }
    if (e.key === "Backspace") { viewer.measureBack(); return true; }
  }
  return false;
}

document.addEventListener("keydown", (e) => {
  if (!modal.hidden) return;
  const typing = !!e.target.closest?.("input, textarea, select") || viewer.editing;
  if (!typing && contextKey(e)) { e.preventDefault(); return; }
  const combo = comboFromEvent(e);
  const cmd = combo && keymap.byId.get(keymap.lookup(combo));
  if (!cmd) return;
  if (typing && !cmd.typing) return;
  if (cmd.when && !cmd.when()) return;
  e.preventDefault();
  if (e.repeat && !cmd.repeat) return;
  cmd.run(e);
});

// Toolbar tooltips show the current keys.
const TITLES = {
  "tool.select": [".tool[data-tool=select]", "Select: tap or drag a markup to select, move or delete it; drag over text to select and copy; drag on blank paper to pan"],
  "tool.hand": [".tool[data-tool=hand]", "Pan"],
  "tool.highlight": [".tool[data-tool=highlight]", "Highlight"],
  "tool.pen": [".tool[data-tool=pen]", "Pen"],
  "tool.box": [".tool[data-tool=box]", "Shapes: box, line, arrow, cloud, callout, text. Tap again to choose. To move or edit a shape, use Select"],
  "tool.sign": [".tool[data-tool=sign]", "Signature: add your signature, then drag it into place; tap a placed one to move, resize or delete it"],
  "tool.lasso": [".tool[data-tool=lasso]", "Lasso select: draw round markups (or over them) to select them, then move, resize, copy or delete them. Or hold the pen's side button with any tool"],
  "find.open": ["#btn-search", "Search in this PDF"],
  "panel.marks": ["#btn-marks", "Markups: a list of every markup in this PDF"],
  "edit.paste": ["#btn-paste", "Paste: markups you copied, or a picture, where you point or in the middle"],
  "view.side": ["#btn-side", "Open a PDF side by side"],
  "view.fullscreen": ["#btn-full", "Full screen"],
  "tool.snip": [".tool[data-tool=snip]", "Snip: drag a box, or draw around something, to copy it as a picture; then tap where it should go (or Ctrl+V) to paste it at the same size"],
  "tool.content": [".tool[data-tool=content]", "Edit content: drag a box to erase an area of the page; tap a line of text to retype it in the same font"],
  "tool.eraser": [".tool[data-tool=eraser]", "Eraser"],
  "tool.measure": [".tool[data-tool=measure]", "Measure distance, path length and area"],
  "tool.touch": ["#btn-touch", "Finger draws on/off. Off: finger pans and zooms, pen draws"],
  "edit.undo": ["#btn-undo", "Undo"],
  "edit.redo": ["#btn-redo", "Redo"],
  "file.save": ["#btn-save", "Save"],
  "file.sidebar": ["#btn-sidebar", "Show/hide files"],
  "pages.panel": ["#btn-pages", "Pages: delete, add, move and rotate pages"],
  "view.zoomIn": ["#btn-zoomin", "Zoom in"],
  "view.zoomOut": ["#btn-zoomout", "Zoom out"],
  "view.fitWidth": ["#btn-fitw", "Fit width"],
  "view.fitPage": ["#btn-fitp", "Fit page"],
};
function refreshTitles() {
  for (const [id, [sel, text]] of Object.entries(TITLES)) {
    const node = document.querySelector(sel);
    if (!node) continue;
    const k = keymap.labelAll(id);
    node.title = k ? `${text} (${k})` : text;
  }
}
refreshTitles();
const keyOf = (id) => keymap.label(id) || undefined;

// ⋯ → Keyboard shortcuts: change, add or remove keys for any command.
function shortcutsDialog() {
  closePopover();
  let recording = null, note = null, query = "";
  const groups = [...new Set(COMMANDS.map((c) => c.group))];
  let list;
  const changed = () => { saveCfg(); refreshTitles(); };
  const render = () => {
    const q = query.trim().toLowerCase();
    let html = "";
    for (const g of groups) {
      const rows = COMMANDS.filter((c) => c.group === g && (!q || (c.label + " " + g + " " + keymap.keys(c.id).map(formatCombo).join(" ")).toLowerCase().includes(q)));
      if (!rows.length) continue;
      html += `<div class="kg"><div class="kg-title">${esc(g)}</div>`;
      for (const c of rows) {
        const keys = keymap.keys(c.id);
        const chips = keys.map((k) => `<span class="chip"><kbd>${esc(formatCombo(k))}</kbd><button class="chip-x" data-rm="${esc(k)}" title="Remove ${esc(formatCombo(k))}">${icon("x")}</button></span>`).join("");
        const rec = recording === c.id;
        html += `<div class="kr${rec ? " rec" : ""}" data-id="${c.id}"><span class="kr-label">${esc(c.label)}</span><span class="kr-keys">${chips}${rec ? `<span class="kr-wait">Press the new keys… (Esc cancels)</span>` : `<button class="btn kr-add" title="Add a shortcut">${keys.length ? "+" : "Add shortcut"}</button>`}</span><button class="btn kr-reset"${keymap.isDefault(c.id) ? " hidden" : ""} title="Back to the default">Reset</button></div>`;
      }
      html += `</div>`;
    }
    list.innerHTML = html || `<p class="hint">No command matches “${esc(query)}”.</p>`;
    const n = list.parentNode.querySelector("#keys-note");
    n.hidden = !note;
    if (note) n.innerHTML = note.text + (note.undo ? ` <button class="btn link" id="keys-undo">Undo</button>` : "");
  };
  const onKey = (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) { recording = null; render(); return; }
    const combo = comboFromEvent(e);
    if (!combo) return; // a modifier on its own: keep waiting
    const id = recording;
    recording = null;
    const before = JSON.stringify(keymap.overrides);
    const other = keymap.lookup(combo);
    if (other && other !== id) keymap.remove(other, combo);
    keymap.add(id, combo);
    note = other && other !== id
      ? { text: `${esc(formatCombo(combo))} now does “${esc(keymap.byId.get(id).label)}”. It no longer does “${esc(keymap.byId.get(other).label)}”.`, undo: before }
      : { text: `${esc(formatCombo(combo))} now does “${esc(keymap.byId.get(id).label)}”.`, undo: before };
    changed();
    render();
  };
  window.addEventListener("keydown", onKey, true);
  return dialog({
    title: "Keyboard shortcuts",
    wide: true,
    html: `<div class="keys-ui">
      <div class="keys-top"><label class="sb-search">${icon("search")}<input type="search" id="keys-q" placeholder="Find a command or key" spellcheck="false"></label>
      <button class="btn" id="keys-reset">Reset all</button></div>
      <p class="keys-note" id="keys-note" hidden></p>
      <div class="keys-list" id="keys-list"></div>
      <p class="hint">Always the same: <b>Enter</b> / <b>Esc</b> place or cancel a signature, finish or cancel measuring, and <b>Backspace</b> removes the last measuring point. While typing in a text box, <b>Ctrl+Enter</b> finishes and <b>Esc</b> cancels. <b>Shift</b> while drawing a line or measuring keeps 0°, 45° or 90°.</p></div>`,
    buttons: [{ id: "ok", label: "Done", primary: true }],
    onMount(d) {
      list = d.querySelector("#keys-list");
      const q = d.querySelector("#keys-q");
      q.addEventListener("input", () => { query = q.value; render(); });
      q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); } });
      d.querySelector("#keys-reset").onclick = () => {
        const before = JSON.stringify(keymap.overrides);
        keymap.resetAll();
        note = { text: "All shortcuts are back to their defaults.", undo: before };
        recording = null;
        changed();
        render();
      };
      d.addEventListener("click", (e) => {
        if (e.target.closest("#keys-undo") && note?.undo) {
          keymap.resetAll();
          Object.assign(keymap.overrides, JSON.parse(note.undo));
          keymap.rebuild();
          note = { text: "Change undone." };
          changed();
          render();
          return;
        }
        const row = e.target.closest(".kr");
        if (!row) return;
        const id = row.dataset.id;
        const rm = e.target.closest("[data-rm]");
        if (rm) { keymap.remove(id, rm.dataset.rm); note = null; changed(); render(); }
        else if (e.target.closest(".kr-add")) { recording = id; note = null; render(); }
        else if (e.target.closest(".kr-reset")) { keymap.reset(id); note = null; changed(); render(); }
      });
      render();
    },
  }).finally(() => window.removeEventListener("keydown", onKey, true));
}

// ------------------------------------------------------------------ drag & drop
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  const p = f && host.pathForFile(f);
  if (!p) return;
  const st = await host.stat(p).catch(() => null);
  if (st?.isDirectory) { cfg.folder = p; saveCfg(); toggleSidebar(true); loadFolder(p, false); }
  else if (/\.pdf$/i.test(p)) { activate(paneAt(e.clientX, e.clientY)); openFile(p); }
  else if (IMAGE_EXT.test(p)) prepareSignature(p);
});

// ------------------------------------------------------------------ host events
host.onFolderChanged(() => { if (cfg.folder) loadFolder(cfg.folder, false); });
host.onOpenFile((p) => openFile(p));
host.onCloseRequest(async () => {
  for (const P of panes.slice()) if (!(await confirmDiscard(P))) return;
  for (const P of panes) storeView(P);
  saveSession();
  await saveCfg(true);
  host.confirmClose();
});

// ------------------------------------------------------------------ start
appEl.classList.add("no-doc");
toggleSidebar(cfg.sidebarOpen);
if (!["number", "name", "both"].includes(cfg.pageLabels)) cfg.pageLabels = "both";
pagesPanel.labelMode = cfg.pageLabels;
showPanel(cfg.pagesOpen ? (["pages", "marks", "find"].includes(cfg.panelTab) ? cfg.panelTab : "pages") : null);
applyRibbon();
setAutosave(cfg.autosave, false);
applyStyles();
setWheel(cfg.wheel, false);
setTool(cfg.tool);
setTouchDraws(cfg.touchDraws);
syncActive();

if (host.platform === "web" && new URLSearchParams(location.search).get("folder")) {
  cfg.folder = new URLSearchParams(location.search).get("folder");
}
if (cfg.folder) loadFolder(cfg.folder, true);
else { sidebar.setRoot(null); sidebar.setTree(null); }

// The PDFs that were open side by side last time, or the one Windows asked
// to open. (1.7 kept a second, read-only PDF on the side: it opens as an
// ordinary one now.)
{
  restoring = true;
  let list;
  if (host.initialFile) list = [host.initialFile];
  else if (Array.isArray(cfg.openFiles)) list = cfg.openFiles;
  else list = [cfg.lastFile, cfg.sidePath];
  const weights = !host.initialFile && Array.isArray(cfg.paneWeights) ? cfg.paneWeights : [];
  delete cfg.sidePath;
  delete cfg.sideFrac;
  const files = [];
  for (const p of list.filter(Boolean)) {
    if (files.length >= MAX_PANES || files.some((f) => samePath(f, p))) continue;
    const st = await host.stat(p).catch(() => null);
    if (st && !st.isDirectory) files.push(p);
  }
  const jobs = files.map((p, k) => {
    const P = k ? createPane() : panes[0];
    P.weight = weights[k] > 0 ? weights[k] : 1;
    return [P, p];
  });
  layoutPanes();
  const ai = files.findIndex((p) => samePath(p, cfg.activeFile));
  if (ai > 0) activate(panes[ai]);
  Promise.all(jobs.map(([P, p]) => openIn(P, p))).finally(() => { restoring = false; saveSession(); });
  if (!files.length) {
    restoring = false;
    $("#empty-msg").textContent = cfg.folder ? "Pick a PDF from the list on the left." : "Open a folder to see every PDF inside it, including subfolders.";
  }
}

if (canUpdate && cfg.autoUpdate !== false) {
  setTimeout(() => checkForUpdates({ quiet: true }), 6000);
  setInterval(() => checkForUpdates({ quiet: true }), 6 * 3600e3);
}

// Expose for automated tests.
window.__inkleaf = {
  get viewer() { return viewer; }, get engine() { return engine; }, get state() { return state; }, get active() { return active; },
  panes, activate, openBeside, closePane, movePane, cyclePane, paste, copyMarks, duplicateMarks, selectAllMarks, setAutosave,
  checkForUpdates, updateDialog, get updateInfo() { return updateInfo; },
  markupsPanel, openFind, closeFind, findStep, applyRibbon, ribbonDialog, fitToolbar, showPanel, get find() { return active?.find; },
  sidebar, cfg, openFile, save, scaleFor, setScale, copyText, prepareSignature, openSignPanel, sigs: () => sigLib,
};
