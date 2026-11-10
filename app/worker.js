// Inkleaf PDF engine worker (MuPDF compiled to WebAssembly).
// Several of these run in parallel: one "edit" worker owns annotations,
// text and saving; the others only rasterize tiles.
import * as mupdf from "./vendor/mupdf/mupdf.js";
import { UNITS } from "./measure.js";

const PDFAnnotation = mupdf.PDFAnnotation;
const MANAGED_TYPES = new Set(["Ink", "Square", "Highlight", "Line", "PolyLine", "Polygon"]);
// Line/PolyLine/Polygon are only managed when Inkleaf created them as
// measurements (marked with this key); anyone else's are left to MuPDF.
const MEASURE_TYPES = new Set(["Line", "PolyLine", "Polygon"]);
const MEASURE_KEY = "InkleafMeasure";
const MEASURE_INTENT = { Line: "LineDimension", PolyLine: "PolyLineDimension", Polygon: "PolygonDimension" };
const MEASURE_SUBJECT = { Line: "Length Measurement", PolyLine: "Length Measurement", Polygon: "Area Measurement" };
const LIST_CACHE_SIZE = 6;

let doc = null;
let author = "";
const pages = new Map(); // index -> { page, list, stext, lines }
const listLRU = [];

function resetPages() {
  for (const e of pages.values()) dropEntry(e);
  pages.clear();
  listLRU.length = 0;
}

function dropEntry(e) {
  try { e.list?.destroy(); } catch {}
  try { e.stext?.destroy(); } catch {}
  try { e.page?.destroy(); } catch {}
}

function entry(i) {
  let e = pages.get(i);
  if (!e) {
    e = { page: doc.loadPage(i), list: null, stext: null, lines: null };
    pages.set(i, e);
  }
  return e;
}

// Annotations we draw ourselves as live vectors (so pen edits never force a
// page re-render). Anything fancier is left to MuPDF to render faithfully.
function measureInfo(a) {
  try {
    const v = a.getObject().get(MEASURE_KEY);
    if (!v || !v.isString()) return null;
    const info = JSON.parse(v.asString());
    return info && typeof info === "object" ? info : null;
  } catch {
    return null;
  }
}

function isManaged(a) {
  try {
    const type = a.getType();
    if (!MANAGED_TYPES.has(type)) return false;
    if (MEASURE_TYPES.has(type) && !measureInfo(a)) return false;
    const f = a.getFlags();
    if (f & (PDFAnnotation.IS_HIDDEN | PDFAnnotation.IS_NO_VIEW | PDFAnnotation.IS_LOCKED | PDFAnnotation.IS_READ_ONLY)) return false;
    if (a.getObject().asIndirect() <= 0) return false;
    if (a.hasBorder()) {
      if (a.getBorderStyle() !== "Solid") return false;
      if (a.getBorderDashCount() > 0) return false;
    }
    if (a.hasBorderEffect() && a.getBorderEffect() !== "None") return false;
    return true;
  } catch {
    return false;
  }
}

function displayList(i) {
  const e = entry(i);
  if (e.list) {
    const k = listLRU.indexOf(i);
    if (k >= 0) listLRU.splice(k, 1);
    listLRU.push(i);
    return e.list;
  }
  const page = e.page;
  const list = new mupdf.DisplayList(page.getBounds());
  const dev = new mupdf.DisplayListDevice(list);
  try {
    page.runPageContents(dev, mupdf.Matrix.identity);
    if (page.isPDF()) {
      for (const a of page.getAnnotations()) {
        if (!isManaged(a)) {
          try { a.run(dev, mupdf.Matrix.identity); } catch {}
        }
      }
      try { page.runPageWidgets(dev, mupdf.Matrix.identity); } catch {}
    } else {
      page.runPageAnnots(dev, mupdf.Matrix.identity);
    }
  } finally {
    dev.close();
    dev.destroy();
  }
  e.list = list;
  listLRU.push(i);
  while (listLRU.length > LIST_CACHE_SIZE) {
    const old = listLRU.shift();
    const oe = pages.get(old);
    if (oe?.list) { oe.list.destroy(); oe.list = null; }
  }
  return list;
}

async function render({ page, res, bbox }) {
  const list = displayList(page);
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, true);
  try {
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    try {
      list.run(dev, mupdf.Matrix.scale(res, res));
    } finally {
      dev.close();
      dev.destroy();
    }
    const w = pix.getWidth(), h = pix.getHeight();
    const data = new Uint8ClampedArray(pix.getPixels());
    const bitmap = await createImageBitmap(new ImageData(data, w, h));
    return { result: { bitmap, w, h }, transfer: [bitmap] };
  } finally {
    pix.destroy();
  }
}

function colorOf(c) {
  return Array.isArray(c) ? Array.from(c) : [];
}

function annotData(a) {
  const type = a.getType();
  const d = { id: a.getObject().asIndirect(), type, color: colorOf(a.getColor()), opacity: a.getOpacity() };
  if (type === "Ink") {
    d.width = a.getBorderWidth();
    d.ink = a.getInkList().map((s) => s.map((p) => [p[0], p[1]]));
  } else if (type === "Square") {
    d.width = a.getBorderWidth();
    d.rect = Array.from(a.getRect());
    d.fill = a.hasInteriorColor() ? colorOf(a.getInteriorColor()) : [];
  } else if (type === "Highlight") {
    d.quads = a.getQuadPoints().map((q) => Array.from(q));
  } else if (MEASURE_TYPES.has(type)) {
    const info = measureInfo(a) || {};
    d.measure = true;
    d.width = a.getBorderWidth();
    d.pts = (type === "Line" ? a.getLine() : a.getVertices()).map((p) => [p[0], p[1]]);
    d.contents = a.getContents() || "";
    if (info.scale && info.scale.mPerPt > 0) d.scale = info.scale;
    if (info.dp != null) d.dp = info.dp;
  }
  return d;
}

// Standard /Measure dictionary so Acrobat, Bluebeam etc. recognise the
// annotation as a measurement at the same scale.
function writeMeasure(a, data) {
  const obj = a.getObject();
  const sc = data.scale;
  obj.put("IT", doc.newName(MEASURE_INTENT[data.type]));
  obj.put("Subj", doc.newString(MEASURE_SUBJECT[data.type]));
  obj.put(MEASURE_KEY, doc.newString(JSON.stringify({ v: 1, scale: sc, dp: data.dp ?? null })));
  const u = sc && UNITS[sc.unit];
  if (!u || !(sc.mPerPt > 0)) return;
  const den = (dp) => Math.pow(10, Math.max(0, Math.min(6, data.dp ?? dp)));
  const fmt = (label, factor, d) => {
    const f = doc.newDictionary();
    f.put("Type", doc.newName("NumberFormat"));
    f.put("U", doc.newString(label));
    f.put("C", doc.newReal(factor));
    f.put("F", doc.newName("D"));
    f.put("D", doc.newInteger(d));
    const arr = doc.newArray();
    arr.push(f);
    return arr;
  };
  const m = doc.newDictionary();
  m.put("Type", doc.newName("Measure"));
  m.put("Subtype", doc.newName("RL"));
  m.put("R", doc.newString(sc.label || ""));
  m.put("X", fmt(u.label, sc.mPerPt / u.m, den(u.dp)));
  m.put("D", fmt(u.label, 1, den(u.dp)));
  m.put("A", fmt(u.area, Math.pow(u.m / (u.am || u.m), 2), den(u.adp)));
  obj.put("Measure", m);
}

function findAnnot(page, id) {
  for (const a of page.getAnnotations()) {
    if (a.getObject().asIndirect() === id) return a;
  }
  return null;
}

function openFrom(bytes, password) {
  resetPages();
  if (doc) { try { doc.destroy(); } catch {} }
  doc = mupdf.Document.openDocument(bytes, "application/pdf");
  if (doc.needsPassword()) {
    if (!password || !doc.authenticatePassword(password)) {
      return { needsPassword: true };
    }
  }
  const n = doc.countPages();
  const info = new Float64Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = doc.loadPage(i);
    const b = p.getBounds();
    info[i * 4] = b[0]; info[i * 4 + 1] = b[1]; info[i * 4 + 2] = b[2]; info[i * 4 + 3] = b[3];
    p.destroy();
  }
  return { needsPassword: false, pageCount: n, bounds: info, isPDF: doc.isPDF() };
}

let fileBytes = null;
let docPassword = null;

const handlers = {
  async open({ url, password }) {
    if (!fileBytes || fileBytes.url !== url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Cannot read file (${res.status})`);
      fileBytes = { url, data: new Uint8Array(await res.arrayBuffer()) };
    }
    const r = openFrom(fileBytes.data, password);
    if (!r.needsPassword) docPassword = password || null;
    if (r.bounds) return { result: r, transfer: [r.bounds.buffer] };
    return { result: r };
  },
  close() {
    resetPages();
    if (doc) { try { doc.destroy(); } catch {} }
    doc = null;
    fileBytes = null;
    docPassword = null;
    return { result: true };
  },
  setAuthor({ name }) { author = name || ""; return { result: true }; },
  render,
  pageAnnots({ page }) {
    const e = entry(page);
    const out = [];
    if (e.page.isPDF()) {
      for (const a of e.page.getAnnotations()) if (isManaged(a)) out.push(annotData(a));
    }
    return { result: out };
  },
  addAnnot({ page, data }) {
    const p = entry(page).page;
    const a = p.createAnnotation(data.type);
    if (author) { try { a.setAuthor(author); } catch {} }
    a.setColor(data.color);
    if (data.opacity != null && data.opacity < 1) a.setOpacity(data.opacity);
    if (data.type === "Ink") {
      a.setBorderWidth(data.width);
      a.setInkList(data.ink);
    } else if (data.type === "Square") {
      a.setBorderWidth(data.width);
      a.setRect(data.rect);
      if (data.fill && data.fill.length) a.setInteriorColor(data.fill);
    } else if (data.type === "Highlight") {
      a.setQuadPoints(data.quads);
    } else if (MEASURE_TYPES.has(data.type)) {
      a.setBorderWidth(data.width || 1);
      if (data.type === "Line") {
        a.setLine(data.pts[0], data.pts[1]);
        try { a.setLineEndingStyles("Butt", "Butt"); } catch {}
        try { a.setLineCaption(true); } catch {}
      } else {
        a.setVertices(data.pts);
      }
      a.setContents(data.contents || "");
      writeMeasure(a, data);
    }
    a.update();
    return { result: a.getObject().asIndirect() };
  },
  deleteAnnot({ page, id }) {
    const p = entry(page).page;
    const a = findAnnot(p, id);
    if (a) p.deleteAnnotation(a);
    return { result: !!a };
  },
  textLines({ page }) {
    const e = entry(page);
    if (!e.lines) {
      if (!e.stext) e.stext = e.page.toStructuredText("preserve-whitespace");
      const lines = [];
      const json = JSON.parse(e.stext.asJSON());
      for (const b of json.blocks || []) {
        if (b.type !== "text") continue;
        for (const l of b.lines || []) {
          const bb = l.bbox;
          if (bb && bb.w > 0 && bb.h > 0) lines.push(bb.x, bb.y, bb.x + bb.w, bb.y + bb.h);
        }
      }
      e.lines = new Float32Array(lines);
    }
    const copy = e.lines.slice();
    return { result: copy, transfer: [copy.buffer] };
  },
  // Text between two points (optionally snapped to whole words or lines):
  // the quads to paint and the plain text to copy.
  selectText({ page, p, q, mode }) {
    const e = entry(page);
    if (!e.stext) e.stext = e.page.toStructuredText("preserve-whitespace");
    if (mode === "words" || mode === "lines") {
      const h = e.stext.snap(p, q, mode);
      let ux = h[2] - h[0], uy = h[3] - h[1];
      const ul = Math.hypot(ux, uy) || 1;
      ux = (ux / ul) * 0.05; uy = (uy / ul) * 0.05;
      p = [(h[0] + h[4]) / 2 + ux, (h[1] + h[5]) / 2 + uy];
      q = [(h[2] + h[6]) / 2 - ux, (h[3] + h[7]) / 2 - uy];
    }
    const quads = e.stext.highlight(p, q, 5000).map((qd) => Array.from(qd));
    const text = quads.length ? e.stext.copy(p, q) : "";
    return { result: { quads, text } };
  },
  highlight({ page, p, q }) {
    const e = entry(page);
    if (!e.stext) e.stext = e.page.toStructuredText("preserve-whitespace");
    return { result: e.stext.highlight(p, q, 1000).map((qd) => Array.from(qd)) };
  },
  save({ mode }) {
    let buf;
    let usedMode = mode;
    if (mode === "incremental") {
      try {
        if (!doc.canBeSavedIncrementally()) throw new Error("not incremental");
        buf = doc.saveToBuffer("incremental");
      } catch {
        usedMode = "full";
      }
    }
    if (!buf) buf = doc.saveToBuffer("garbage=yes,compress=yes");
    const bytes = buf.asUint8Array().slice();
    buf.destroy();
    // Reload from what we wrote: MuPDF cannot append a second incremental
    // section to a document it already saved from memory.
    fileBytes = { url: fileBytes?.url, data: bytes };
    openFrom(bytes, docPassword);
    const out = bytes.slice();
    return { result: { bytes: out, mode: usedMode }, transfer: [out.buffer] };
  },
  authenticate({ password }) {
    return { result: !!doc && doc.authenticatePassword(password) > 0 };
  },
};

// Serialize work so state changes happen in message order.
let chain = Promise.resolve();
self.onmessage = (ev) => {
  const { id, type, args } = ev.data;
  chain = chain.then(async () => {
    try {
      const h = handlers[type];
      if (!h) throw new Error("Unknown request " + type);
      const { result, transfer } = await h(args || {});
      self.postMessage({ id, ok: true, result }, transfer || []);
    } catch (err) {
      self.postMessage({ id, ok: false, error: String(err?.message || err) });
    }
  });
};

self.postMessage({ ready: true });
