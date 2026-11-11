import { host } from "./host.js";
import { Engine } from "./engine.js";
import { Viewer, cssColor } from "./viewer.js";
import { Sidebar } from "./sidebar.js";
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
  { pen: { color: "#1d4ed8", width: 1.5 }, highlight: { color: "#ffe11a", width: 12 }, box: { color: "#dc2626", width: 2 } },
  cfg.styles || {}
);
cfg.textStyle = Object.assign({ size: 12, fillText: false, fillCallout: true }, cfg.textStyle || {});
const SHAPES = [["box", "square", "Box"], ["line", "line", "Line"], ["arrow", "arrow", "Arrow"], ["cloud", "cloud", "Cloud"], ["callout", "callout", "Callout"], ["text", "text", "Text"]];
if (!SHAPES.some(([k]) => k === cfg.shape)) cfg.shape = "box";
const TEXT_SIZES = [9, 12, 18, 28];
cfg.measure = Object.assign({ mode: "distance", color: "#ea580c", dp: null, unit: "mm" }, cfg.measure || {});
cfg.scales = cfg.scales || {};
const MEASURE_COLORS = ["#ea580c", "#dc2626", "#c026d3", "#1d4ed8", "#16a34a", "#111111"];

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
    if (cfg.tool === "measure") updateMeasureBar();
    rememberView();
    pokeIdle();
  },
  onZoom(scale) {
    $("#zoom-label").textContent = Math.round((scale * 72 / 96) * 100) + "%";
    rememberView();
  },
  onMeasure: (st) => updateMeasureBar(st),
  onCalibrate: (page, lengthPt) => calibrateDialog(page, lengthPt),
  scaleFor: (i) => scaleFor(i),
  onCopy: (text) => copyText(text),
  onError: (msg) => toast(msg, "error"),
  onSignTap: (page, p, hit) => signTap(page, p, hit),
  onSigned: (sig, rect) => signed(sig, rect),
  onPlacing: (on) => appEl.classList.toggle("placing", on),
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
const TOOL_ICONS = { select: "select", hand: "hand", highlight: "highlighter", pen: "pen", box: "square", eraser: "eraser", measure: "ruler", sign: "signature" };
function updateToolIcons() {
  for (const b of document.querySelectorAll(".tool")) {
    const t = b.dataset.tool;
    const ic = t === "box" ? SHAPES.find(([k]) => k === cfg.shape)[1] : TOOL_ICONS[t];
    b.innerHTML = icon(ic) + (t === "box" ? `<span class="caret" data-caret="1">${icon("caret")}</span>` : "");
  }
}
updateToolIcons();
const pagePill = $("#pagepill");

function setTool(t) {
  cfg.tool = t;
  viewer.setTool(t);
  for (const b of document.querySelectorAll(".tool")) b.classList.toggle("active", b.dataset.tool === t);
  const st = t === "measure" ? cfg.measure : cfg.styles[t];
  const sb = $("#btn-style");
  sb.classList.toggle("na", !st);
  sb.disabled = !st;
  if (st) sb.querySelector(".swatch-dot").style.background = st.color;
  appEl.classList.toggle("measuring", t === "measure");
  if (t === "measure") updateMeasureBar();
  saveCfg();
}

function applyStyles() {
  for (const k of ["pen", "highlight", "box"]) viewer.setStyle(k, { color: hexToRgb(cfg.styles[k].color), width: cfg.styles[k].width });
  viewer.setMeasureStyle({ color: hexToRgb(cfg.measure.color), dp: cfg.measure.dp });
  viewer.measureMode = cfg.measure.mode;
  viewer.setShape(cfg.shape);
  viewer.setTextStyle(cfg.textStyle);
}

function setWheel(mode, announce = true) {
  cfg.wheel = mode === "zoom" ? "zoom" : "scroll";
  viewer.wheelZooms = cfg.wheel === "zoom";
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
  const t = b.dataset.tool;
  if (t === "sign") { if (cfg.tool !== "sign") setTool("sign"); openSignPanel(); return; }
  if (t === "box" && e.target.closest("[data-caret]")) { if (cfg.tool !== "box") setTool("box"); openStylePopover(); return; }
  if (t === cfg.tool && cfg.tool === "measure") openMeasurePopover();
  else if (t === cfg.tool && cfg.styles[cfg.tool]) openStylePopover();
  else setTool(t);
});
$("#btn-style").onclick = () => (cfg.tool === "measure" ? openMeasurePopover() : openStylePopover());
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
  { label: "Save as…", key: keyOf("file.saveAs"), run: () => save({ as: true }), disabled: !state.path },
  { label: "Show in folder", icon: "external", run: () => host.showInFolder(state.path), disabled: !state.path },
  "-",
  { label: "Copy selected text", icon: "copy", key: keyOf("edit.copy"), run: () => copyText(viewer.sel?.text), disabled: !viewer.hasSelection },
  { label: "Drawing scale…", icon: "ruler", run: () => scaleDialog(), disabled: !state.path },
  "-",
  ...wheelItems(),
  "-",
  { label: "Full screen", key: keyOf("view.fullscreen"), run: () => host.toggleFullscreen() },
  { label: "Keyboard shortcuts…", icon: "keyboard", key: keyOf("help.keys"), run: () => shortcutsDialog() },
  { label: "Keyboard, touch and pen help", icon: "info", key: keyOf("help.help"), run: showHelp },
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
  if (!pop.hidden && (popAnchor === anchor || popAnchor === toolButton(tool))) { closePopover(); return; }
  const st = cfg.styles[tool];
  const selKind = tool === "box" ? viewer.selectedShape : null;
  const shape = tool === "box" ? (selKind || cfg.shape) : null;
  const name = tool === "box" ? SHAPES.find(([k]) => k === shape)[2] : { pen: "Pen", highlight: "Highlighter" }[tool];
  const maxW = pal.widths[pal.widths.length - 1];
  const isText = shape === "text" || shape === "callout";
  let html = "";
  if (tool === "box") {
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
  if (isText) html += `<p class="pop-hint">${shape === "callout" ? "Drag from the point you're marking to where the text should go, then type." : "Tap where the text should start, or drag to set its width, then type."}</p>`;
  pop.innerHTML = html;
  pop.onclick = (e) => {
    const sh = e.target.closest("[data-shape]");
    const sw = e.target.closest(".swatch");
    const ts = e.target.closest("[data-ts]");
    const sz = e.target.closest("[data-w]");
    // With a shape selected, colour/size changes also apply to it.
    const sel = tool === "box" && viewer.selectedShape;
    if (sh) { cfg.shape = sh.dataset.shape; updateToolIcons(); }
    else if (sw) { st.color = sw.dataset.c; if (sel) viewer.restyleSelected({ color: hexToRgb(st.color) }); }
    else if (ts) { cfg.textStyle.size = +ts.dataset.ts; if (sel) viewer.restyleSelected({ size: cfg.textStyle.size }); }
    else if (sz) { st.width = +sz.dataset.w; if (sel) viewer.restyleSelected({ width: st.width }); }
    else return;
    applyStyles();
    setTool(tool);
    popAnchor = null;
    openStylePopover();
  };
  pop.onchange = (e) => {
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

function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.innerHTML = (kind === "error" ? "" : icon("check")) + "<span></span>";
  t.querySelector("span").textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), kind === "error" ? 5000 : 1800);
}

async function showHelp() {
  closePopover();
  const gestures = [
    ["Finger drag", "Pan (flick to glide)"], ["Two-finger pinch", "Zoom around your fingers"], ["Double-tap", "Zoom in / back to fit width"],
    ["Pen", "Draw with the selected tool"], ["Pen eraser end / side button", "Erase"],
    ["Middle-button drag", "Pan the page (any tool)"], ["Mouse wheel", "Scroll or zoom (choose in the ⋯ menu)"],
    ["Ctrl+wheel / Shift+wheel", "Zoom / the other wheel action"],
    ["Select tool: drag over text", "Select it; double-click a word, triple-click a line"],
    ["Shapes tool ▾", "Box, line, arrow, cloud, callout or text; tap a placed shape to move, reshape or retype it"],
    ["Callout", "Drag from the spot you're marking to where the text goes, then type"],
    ["Signature tool", "Pick a signature, drag it into place, Place; tap a placed one to move or resize it"],
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

function scaleFor(i) {
  const ds = state.path && cfg.scales[state.path];
  return (ds && ((ds.pages && ds.pages[i]) || ds.all)) || { ...DEFAULT_SCALE, unit: cfg.measure.unit || "mm" };
}

function scaleText(sc) {
  if (sc.unset) return `Scale not set · ${UNITS[sc.unit]?.label || sc.unit}`;
  return `${sc.label} · ${sc.unit === "ftin" ? "ft-in" : UNITS[sc.unit]?.label || sc.unit}`;
}

// scope: "all" or a page index.
async function setScale(scope, sc) {
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
for (const b of viewer.selBar.querySelectorAll("[data-act]")) b.innerHTML = icon(b.dataset.act === "copy" ? "copy" : "highlighter") + `<span>${b.textContent}</span>`;

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
  viewer.commitEdits();
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
    updateMeasureBar();
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
  viewer.commitEdits();
  if (viewer.placing) viewer.finishPlacing(true);
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
        if (cfg.scales[path] && !cfg.scales[target]) cfg.scales[target] = cfg.scales[path];
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
// Every function is a command with default keys; users can change them in
// ⋯ → Keyboard shortcuts (saved as cfg.keys). Keys that only mean something
// in a mode (Enter, Esc, Backspace while measuring, placing or typing) are fixed.
const hasDoc = () => viewer.pageCount > 0;
function setShapeKind(k) { cfg.shape = k; updateToolIcons(); applyStyles(); setTool("box"); saveCfg(); }
function setMeasureModeCmd(m) { cfg.measure.mode = m; setTool("measure"); viewer.setMeasureMode(m); saveCfg(); updateMeasureBar(); }
function openToolMenu() {
  if (cfg.tool === "measure") openMeasurePopover();
  else if (cfg.tool === "sign") openSignPanel();
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
const vh = () => viewer.vh;
const wide = () => viewer.L && viewer.L.worldW > viewer.vw;

const COMMANDS = [
  // File
  { id: "file.openFolder", group: "File", label: "Open folder…", keys: ["Ctrl+O"], typing: true, run: () => pickFolder() },
  { id: "file.openFile", group: "File", label: "Open file…", keys: [], typing: true, run: () => pickFile() },
  { id: "file.save", group: "File", label: "Save", keys: ["Ctrl+S"], typing: true, run: () => save() },
  { id: "file.saveAs", group: "File", label: "Save as…", keys: ["Ctrl+Shift+S"], typing: true, run: () => save({ as: true }) },
  { id: "file.showInFolder", group: "File", label: "Show in folder", keys: [], when: () => !!state.path, run: () => host.showInFolder(state.path) },
  { id: "file.next", group: "File", label: "Next PDF in the list", keys: ["Alt+ArrowDown"], run: () => stepFile(1) },
  { id: "file.prev", group: "File", label: "Previous PDF in the list", keys: ["Alt+ArrowUp"], run: () => stepFile(-1) },
  { id: "file.filter", group: "File", label: "Filter the file list", keys: ["Ctrl+F"], typing: true, run: () => { toggleSidebar(true); sidebar.input.focus(); sidebar.input.select(); } },
  { id: "file.sidebar", group: "File", label: "Show / hide the file list", keys: ["Ctrl+B"], typing: true, run: () => toggleSidebar() },
  { id: "file.refresh", group: "File", label: "Refresh the file list", keys: ["F5"], when: () => !!cfg.folder, run: () => loadFolder(cfg.folder, false) },
  // Edit
  { id: "edit.undo", group: "Edit", label: "Undo", keys: ["Ctrl+Z"], run: () => viewer.undo() },
  { id: "edit.redo", group: "Edit", label: "Redo", keys: ["Ctrl+Y", "Ctrl+Shift+Z"], run: () => viewer.redo() },
  { id: "edit.copy", group: "Edit", label: "Copy selected text", keys: ["Ctrl+C"], when: () => viewer.hasSelection, run: () => copyText(viewer.sel.text) },
  { id: "edit.selectAll", group: "Edit", label: "Select all text on the page", keys: ["Ctrl+A"], when: hasDoc, run: () => { if (cfg.tool !== "select") setTool("select"); viewer.selectAllOnPage(); } },
  { id: "edit.editText", group: "Edit", label: "Edit the selected text box or callout", keys: ["Enter", "F2"], when: () => ["text", "callout"].includes(viewer.selectedShape), run: () => viewer.editSelectedText() },
  { id: "edit.delete", group: "Edit", label: "Delete the selected shape", keys: ["Delete", "Backspace"], when: () => !!viewer.selectedShape, run: () => viewer.deleteSelectedShape() },
  // Tools
  { id: "tool.select", group: "Tools", label: "Select text", keys: ["V"], run: () => setTool("select") },
  { id: "tool.hand", group: "Tools", label: "Pan", keys: ["H"], run: () => setTool("hand") },
  { id: "tool.highlight", group: "Tools", label: "Highlight", keys: ["M"], run: () => setTool("highlight") },
  { id: "tool.pen", group: "Tools", label: "Pen", keys: ["P"], run: () => setTool("pen") },
  { id: "tool.box", group: "Tools", label: "Shapes tool", keys: ["B"], run: () => setTool("box") },
  { id: "tool.sign", group: "Tools", label: "Signature tool", keys: ["S"], run: () => setTool("sign") },
  { id: "tool.eraser", group: "Tools", label: "Eraser", keys: ["E"], run: () => setTool("eraser") },
  { id: "tool.measure", group: "Tools", label: "Measure", keys: ["R"], run: () => setTool("measure") },
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
  { id: "view.zoomIn", group: "View", label: "Zoom in", keys: ["Ctrl+=", "Ctrl+Shift+=", "Ctrl++"], repeat: true, run: () => viewer.zoomBy(1.25) },
  { id: "view.zoomOut", group: "View", label: "Zoom out", keys: ["Ctrl+-"], repeat: true, run: () => viewer.zoomBy(0.8) },
  { id: "view.fitWidth", group: "View", label: "Fit width", keys: ["Ctrl+0"], run: () => viewer.fit("width") },
  { id: "view.fitPage", group: "View", label: "Fit page", keys: ["Ctrl+9"], run: () => viewer.fit("page") },
  { id: "view.actual", group: "View", label: "Actual size (100%)", keys: ["Ctrl+1"], run: () => viewer.setZoom(96 / 72) },
  { id: "view.fullscreen", group: "View", label: "Full screen", keys: ["F11"], typing: true, run: () => host.toggleFullscreen() },
  { id: "view.wheel", group: "View", label: "Switch the mouse wheel between scroll and zoom", keys: [], run: () => setWheel(cfg.wheel === "zoom" ? "scroll" : "zoom") },
  // Navigate
  { id: "nav.down", group: "Navigate", label: "Scroll down", keys: ["ArrowDown"], repeat: true, run: () => viewer.scrollBy(0, 60) },
  { id: "nav.up", group: "Navigate", label: "Scroll up", keys: ["ArrowUp"], repeat: true, run: () => viewer.scrollBy(0, -60) },
  { id: "nav.right", group: "Navigate", label: "Scroll right (or next page)", keys: ["ArrowRight"], repeat: true, run: () => (wide() ? viewer.scrollBy(60, 0) : viewer.pageStep(1)) },
  { id: "nav.left", group: "Navigate", label: "Scroll left (or previous page)", keys: ["ArrowLeft"], repeat: true, run: () => (wide() ? viewer.scrollBy(-60, 0) : viewer.pageStep(-1)) },
  { id: "nav.screenDown", group: "Navigate", label: "Down a screen", keys: ["PageDown", "Space"], repeat: true, run: () => viewer.scrollBy(0, vh() * 0.9) },
  { id: "nav.screenUp", group: "Navigate", label: "Up a screen", keys: ["PageUp", "Shift+Space"], repeat: true, run: () => viewer.scrollBy(0, -vh() * 0.9) },
  { id: "nav.nextPage", group: "Navigate", label: "Next page", keys: [], repeat: true, run: () => viewer.pageStep(1) },
  { id: "nav.prevPage", group: "Navigate", label: "Previous page", keys: [], repeat: true, run: () => viewer.pageStep(-1) },
  { id: "nav.first", group: "Navigate", label: "First page", keys: ["Home"], run: () => viewer.goToPage(0) },
  { id: "nav.last", group: "Navigate", label: "Last page", keys: ["End"], run: () => viewer.goToPage(viewer.pageCount - 1) },
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
    else if (viewer.selectedShape) viewer.deselectShape();
    else if (viewer.mdraft || viewer._calibrating) viewer.cancelMeasure();
    else if (viewer.hasSelection) viewer.clearSelection();
    else return false;
    return true;
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
  "tool.select": [".tool[data-tool=select]", "Select text — drag over text to select and copy; drag on blank paper to pan"],
  "tool.hand": [".tool[data-tool=hand]", "Pan"],
  "tool.highlight": [".tool[data-tool=highlight]", "Highlight"],
  "tool.pen": [".tool[data-tool=pen]", "Pen"],
  "tool.box": [".tool[data-tool=box]", "Shapes: box, line, arrow, cloud, callout, text. Tap again to choose; tap a shape to move or edit it"],
  "tool.sign": [".tool[data-tool=sign]", "Signature: add your signature, then drag it into place"],
  "tool.eraser": [".tool[data-tool=eraser]", "Eraser"],
  "tool.measure": [".tool[data-tool=measure]", "Measure distance, path length and area"],
  "tool.touch": ["#btn-touch", "Finger draws on/off. Off: finger pans and zooms, pen draws"],
  "edit.undo": ["#btn-undo", "Undo"],
  "edit.redo": ["#btn-redo", "Redo"],
  "file.save": ["#btn-save", "Save"],
  "file.sidebar": ["#btn-sidebar", "Show/hide files"],
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
  else if (/\.pdf$/i.test(p)) openFile(p);
  else if (IMAGE_EXT.test(p)) prepareSignature(p);
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
setWheel(cfg.wheel, false);
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
window.__inkleaf = { viewer, engine, sidebar, state, cfg, openFile, save, scaleFor, setScale, copyText, prepareSignature, openSignPanel, sigs: () => sigLib };
