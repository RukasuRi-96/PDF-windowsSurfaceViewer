import { host } from "./host.js";
import { Engine } from "./engine.js";
import { Viewer, cssColor } from "./viewer.js";
import { Sidebar } from "./sidebar.js";
import { icon } from "./icons.js";
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
const TOOL_ICONS = { select: "select", hand: "hand", highlight: "highlighter", pen: "pen", box: "square", eraser: "eraser", measure: "ruler" };
for (const b of document.querySelectorAll(".tool")) b.innerHTML = icon(TOOL_ICONS[b.dataset.tool]);
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
  if (b.dataset.tool === cfg.tool && cfg.tool === "measure") openMeasurePopover();
  else if (b.dataset.tool === cfg.tool && cfg.styles[cfg.tool]) openStylePopover();
  else setTool(b.dataset.tool);
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
    { label: "Fit width", icon: "fitWidth", key: "Ctrl+0", run: () => viewer.fit("width") },
    { label: "Fit page", icon: "fitPage", key: "Ctrl+9", run: () => viewer.fit("page") },
    "-",
    ...[50, 75, 100, 150, 200, 400, 800].map((p) => ({ label: p + "%", run: z(p) })),
    "-",
    ...wheelItems(),
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
  { label: "Copy selected text", icon: "copy", key: "Ctrl+C", run: () => copyText(viewer.sel?.text), disabled: !viewer.hasSelection },
  { label: "Drawing scale…", icon: "ruler", run: () => scaleDialog(), disabled: !state.path },
  "-",
  ...wheelItems(),
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

function showHelp() {
  const rows = [
    ["Finger drag", "Pan (flick to glide)"], ["Two-finger pinch", "Zoom around your fingers"], ["Double-tap", "Zoom in / back to fit width"],
    ["Pen", "Draw with the selected tool"], ["Pen eraser end / side button", "Erase"], ["Ctrl+S", "Save into the PDF"],
    ["Middle-button drag", "Pan the page (any tool)"], ["Mouse wheel", "Scroll or zoom (choose in the ⋯ menu)"],
    ["Ctrl+wheel / Shift+wheel", "Zoom / the other wheel action"],
    ["Select tool: drag over text", "Select it; double-click a word, triple-click a line"], ["Ctrl+C / Ctrl+A", "Copy selection / select the page's text"],
    ["Measure tool", "Drag or click two points; path and area: click points, double-click or Enter to finish"],
    ["Shift while measuring", "Snap to 0°, 45°, 90°"], ["Backspace / Esc", "Remove last point / cancel measuring"],
    ["Ctrl+Z / Ctrl+Y", "Undo / redo"], ["V  H  M  P  B  E  R", "Select, pan, highlight, pen, box, eraser, measure"], ["T", "Toggle finger drawing"],
    ["Ctrl + / −", "Zoom"], ["Ctrl+0 / Ctrl+9", "Fit width / fit page"], ["PgUp / PgDn, Space", "Scroll a screen"],
    ["Alt+↑ / Alt+↓", "Previous / next PDF in the list"], ["Ctrl+F", "Filter the file list"], ["Ctrl+B", "Show / hide the file list"],
  ];
  dialog({
    title: "Touch, pen, mouse and keyboard",
    wide: true,
    html: `<div class="shortcuts">${rows.map(([k, v]) => `<kbd>${k}</kbd><span>${v}</span>`).join("")}</div>`,
    buttons: [{ id: "ok", label: "Close", primary: true }],
  });
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
  if (ctrl && k === "c" && viewer.hasSelection) { e.preventDefault(); copyText(viewer.sel.text); return; }
  if (ctrl && k === "a" && viewer.pageCount) { e.preventDefault(); if (cfg.tool !== "select") setTool("select"); viewer.selectAllOnPage(); return; }
  if (cfg.tool === "measure" && viewer.mdraft && !ctrl && !e.altKey) {
    if (e.key === "Enter") { e.preventDefault(); viewer.finishMeasure(); return; }
    if (e.key === "Backspace") { e.preventDefault(); viewer.measureBack(); return; }
  }
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
    case "v": setTool("select"); break;
    case "h": setTool("hand"); break;
    case "r": setTool("measure"); break;
    case "m": setTool("highlight"); break;
    case "p": setTool("pen"); break;
    case "b": setTool("box"); break;
    case "e": setTool("eraser"); break;
    case "t": setTouchDraws(!cfg.touchDraws); break;
    case "Escape":
      if (!pop.hidden) closePopover();
      else if (viewer.mdraft || viewer._calibrating) viewer.cancelMeasure();
      else if (viewer.hasSelection) viewer.clearSelection();
      break;
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
window.__inkleaf = { viewer, engine, sidebar, state, cfg, openFile, save, scaleFor, setScale, copyText };
