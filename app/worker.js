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
// Lines, arrows, clouds, text boxes, callouts and signatures Inkleaf created
// carry this key (JSON { v, k: kind, ... }). They are drawn live from MuPDF's
// own SVG of their appearance, so the screen matches the saved file exactly.
// Anyone else's annotations of these types are left to MuPDF.
const SHAPE_KEY = "InkleafShape";
const SHAPE_TYPES = new Set(["Line", "Square", "FreeText", "Stamp", "Redact"]);
// Fonts for text boxes (PDF base-14 names MuPDF knows).
const FONTS = new Set(["Helv", "TiRo", "Cour"]);
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

function shapeInfo(a) {
  try {
    const v = a.getObject().get(SHAPE_KEY);
    if (!v || !v.isString()) return null;
    const info = JSON.parse(v.asString());
    return info && typeof info === "object" && typeof info.k === "string" ? info : null;
  } catch {
    return null;
  }
}

function isManaged(a) {
  try {
    const type = a.getType();
    const shape = SHAPE_TYPES.has(type) ? shapeInfo(a) : null;
    if (!MANAGED_TYPES.has(type) && !shape) return false;
    if (MEASURE_TYPES.has(type) && !shape && !measureInfo(a)) return false;
    const f = a.getFlags();
    if (f & (PDFAnnotation.IS_HIDDEN | PDFAnnotation.IS_NO_VIEW | PDFAnnotation.IS_LOCKED | PDFAnnotation.IS_READ_ONLY)) return false;
    if (a.getObject().asIndirect() <= 0) return false;
    if (shape) return true;
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

// MuPDF's own vector drawing of an annotation, as SVG markup in page
// coordinates. Element ids get a unique prefix so many can share one page.
let svgSeq = 0;
function annotSvg(a) {
  const buf = new mupdf.Buffer();
  try {
    const w = new mupdf.DocumentWriter(buf, "svg", "text=path");
    const dev = w.beginPage(a.getBounds());
    try { a.run(dev, mupdf.Matrix.identity); } finally { w.endPage(); w.close(); }
    let s = buf.asString();
    s = s.slice(s.indexOf(">", s.indexOf("<svg")) + 1, s.lastIndexOf("</svg>"));
    const p = "a" + (++svgSeq) + "_";
    return s.replace(/\bid="/g, `id="${p}`).replace(/url\(#/g, `url(#${p}`).replace(/href="#/g, `href="#${p}`);
  } finally {
    buf.destroy();
  }
}

function shapeData(a, type, shape, d) {
  d.shape = shape;
  d.bounds = Array.from(a.getBounds());
  d.svg = annotSvg(a);
  if (type === "Line") {
    d.pts = a.getLine().map((p) => [p[0], p[1]]);
    d.width = a.getBorderWidth();
  } else if (type === "Square") {
    d.rect = Array.from(a.getRect());
    d.width = a.getBorderWidth();
  } else if (type === "FreeText") {
    const da = a.getDefaultAppearance();
    d.rect = Array.from(a.getRect());
    d.text = a.getContents() || "";
    d.size = da.size || 12;
    d.color = colorOf(da.color);
    d.fill = colorOf(a.getColor());
    d.width = a.getBorderWidth();
    if (FONTS.has(da.font) && da.font !== "Helv") d.font = da.font;
    if (shape.k === "callout" && Array.isArray(shape.pts)) d.callout = shape.pts;
  } else if (type === "Stamp" || type === "Redact") {
    d.rect = Array.from(a.getRect());
  }
  return d;
}

function annotData(a) {
  const type = a.getType();
  const d = { id: a.getObject().asIndirect(), type, color: colorOf(a.getColor()), opacity: a.getOpacity() };
  const shape = SHAPE_TYPES.has(type) ? shapeInfo(a) : null;
  if (shape) return shapeData(a, type, shape, d);
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

// Number of text lines MuPDF laid out (wrapped lines and blank lines each
// move down once with "0 -h Td").
function apLineCount(a) {
  try {
    const s = a.getObject().get("AP").get("N").readStream().asString();
    return (s.match(/(^|\s)0 -[\d.]+ Td/g) || []).length;
  } catch {
    return 1;
  }
}

// Properties that can change after a shape is made (also used when editing
// one in place, so it keeps its identity and anything attached to it).
function setShapeProps(a, k, data, info) {
  if (k === "line" || k === "arrow") {
    a.setColor(data.color);
    a.setBorderWidth(data.width);
    a.setLine(data.pts[0], data.pts[1]);
  } else if (k === "cloud" || k === "box") {
    a.setColor(data.color);
    a.setBorderWidth(data.width);
    a.setRect(data.rect);
  } else if (k === "sig" || k === "redact") {
    a.setRect(data.rect);
  } else if (k === "ink") {
    a.setColor(data.color);
    a.setBorderWidth(data.width);
    a.setInkList(data.ink);
  } else if (k === "text" || k === "callout") {
    a.setContents(data.text);
    a.setDefaultAppearance(FONTS.has(data.font) ? data.font : "Helv", data.size, data.color);
    a.setBorderWidth(data.width);
    a.setColor(data.fill && data.fill.length ? data.fill : []);
    if (k === "callout") {
      a.setCalloutLine(data.callout);
      info.pts = data.callout;
    }
    a.setRect(data.rect);
  }
}

function finishShape(a, k, data, info) {
  if (info) a.getObject().put(SHAPE_KEY, doc.newString(JSON.stringify(info)));
  a.update();
  if (k === "text" || k === "callout") {
    // Grow or shrink the box to exactly the lines MuPDF wrapped the text into.
    const r = data.rect, bw = data.width || 0;
    const h = Math.max(1, apLineCount(a)) * data.size * 1.2 + 2 * bw + 3;
    a.setRect([r[0], r[1], r[2], r[1] + h]);
    a.update();
    // Replacing a line of the page's text: put the new first line exactly on
    // the old line's start and baseline.
    if (Array.isArray(data.align)) {
      const o = firstTextOrigin(a);
      if (o) {
        const dx = data.align[0] - o[0], dy = data.align[1] - o[1], q = a.getRect();
        a.setRect([q[0] + dx, q[1] + dy, q[2] + dx, q[3] + dy]);
        a.update();
      }
    }
  }
  const out = { id: a.getObject().asIndirect(), bounds: Array.from(a.getBounds()) };
  if (info) out.svg = annotSvg(a);
  if (k !== "line" && k !== "arrow" && k !== "ink") out.rect = Array.from(a.getRect());
  return out;
}

function firstTextOrigin(a) {
  try {
    const st = a.toDisplayList().toStructuredText("preserve-whitespace");
    for (const b of JSON.parse(st.asJSON()).blocks || []) for (const l of b.lines || []) return [l.x, l.y];
  } catch {}
  return null;
}

function createShape(p, data) {
  const k = data.shape.k;
  const info = { v: 1, k };
  let a;
  if (k === "line" || k === "arrow") {
    a = p.createAnnotation("Line");
    a.setLineEndingStyles("None", k === "arrow" ? "OpenArrow" : "None");
  } else if (k === "cloud") {
    a = p.createAnnotation("Square");
    a.setBorderEffect("Cloudy");
    a.setBorderEffectIntensity(1);
  } else if (k === "text" || k === "callout") {
    a = p.createAnnotation("FreeText");
    if (k === "callout") {
      a.setIntent("FreeTextCallout");
      a.setCalloutStyle("OpenArrow");
    }
  } else if (k === "redact") {
    a = p.createAnnotation("Redact");
  } else if (k === "sig") {
    a = p.createAnnotation("Stamp");
    a.setRect(data.rect);
    a.setStampImage(new mupdf.Image(data.png));
    a.setContents("Signature");
  } else {
    throw new Error("Unknown shape " + k);
  }
  setShapeProps(a, k, data, info);
  if (author) { try { a.setAuthor(author); } catch {} }
  return finishShape(a, k, data, info);
}

// Change an existing shape (or plain box) in place.
function updateShape(p, id, data) {
  const a = findAnnot(p, id);
  if (!a) throw new Error("That markup is no longer in the document");
  const k = data.shape ? data.shape.k : data.type === "Ink" ? "ink" : "box";
  const info = data.shape ? Object.assign({ v: 1 }, shapeInfo(a) || {}, { k }) : null;
  setShapeProps(a, k, data, info || {});
  try { a.setModificationDate(new Date()); } catch {}
  return finishShape(a, k, data, info);
}

// Permanently remove what's under Inkleaf's "erase area" boxes: text,
// covered vector art and image pixels (redaction), then paint the areas
// white so partly covered lines leave no traces. Returns how many.
const isEraseArea = (o) => {
  try {
    if (o.get("Subtype").asName() !== "Redact") return false;
    const v = o.get(SHAPE_KEY);
    return !!v && v.isString() && JSON.parse(v.asString()).k === "redact";
  } catch { return false; }
};
function applyInkleafRedactions(d) {
  let count = 0;
  for (let i = 0; i < d.countPages(); i++) {
    const pobj = d.findPage(i);
    const annots = pobj.get("Annots");
    if (!annots || !annots.isArray() || !annots.length) continue;
    const mine = [], others = [];
    for (let k = 0; k < annots.length; k++) { const o = annots.get(k); (isEraseArea(o) ? mine : others).push(o); }
    if (!mine.length) continue;
    // MuPDF's redaction also deletes annotations under the areas. Erase areas
    // only remove page content, so the other markups are kept out of its reach.
    const only = d.newArray();
    for (const o of mine) only.push(o);
    pobj.put("Annots", only);
    const page = d.loadPage(i);
    const rects = [];
    for (const a of page.getAnnotations()) {
      if (a.getType() !== "Redact") continue;
      rects.push(Array.from(a.getRect()));
      a.applyRedaction(0, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
      count++;
    }
    whiteout(d, page, rects);
    page.destroy();
    const left = pobj.get("Annots"), arr = d.newArray();
    if (left && left.isArray()) for (let k = 0; k < left.length; k++) if (!isEraseArea(left.get(k))) arr.push(left.get(k));
    for (const o of others) arr.push(o);
    pobj.put("Annots", arr);
  }
  return count;
}

function whiteout(d, page, rects) {
  const inv = mupdf.Matrix.invert(page.getTransform());
  let ops = "q 1 g\n";
  for (const r of rects) {
    const R = mupdf.Rect.transform(r, inv);
    ops += `${R[0].toFixed(3)} ${R[1].toFixed(3)} ${(R[2] - R[0]).toFixed(3)} ${(R[3] - R[1]).toFixed(3)} re\n`;
  }
  ops += "f Q\n";
  // Wrap the existing content in q/Q so its leftover graphics state can't
  // move our rectangles.
  const pobj = page.getObject();
  const old = pobj.get("Contents");
  const arr = d.newArray();
  arr.push(d.addStream("q\n", {}));
  if (old && old.isArray()) for (let k = 0; k < old.length; k++) arr.push(old.get(k));
  else if (old) arr.push(old);
  arr.push(d.addStream("Q\n" + ops, {}));
  pobj.put("Contents", arr);
}

// A finished copy of the document, made on a temporary copy so the open
// document is untouched (if writing the file fails or Save as is cancelled,
// nothing is lost): erase areas applied, optionally every markup embedded
// into the page content, then a full rewrite so nothing erased survives in
// the file.
function exportCopy(bake) {
  const src = doc.saveToBuffer("");
  let tmp = null;
  try {
    tmp = mupdf.Document.openDocument(src.asUint8Array().slice(), "application/pdf");
    if (tmp.needsPassword()) tmp.authenticatePassword(docPassword || "");
    const erased = applyInkleafRedactions(tmp);
    if (bake) tmp.bake(true, false);
    const buf = tmp.saveToBuffer("garbage=yes,compress=yes");
    const bytes = buf.asUint8Array().slice();
    buf.destroy();
    return { bytes, erased };
  } finally {
    src.destroy();
    if (tmp) { try { tmp.destroy(); } catch {} }
  }
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
    if (data.shape) return { result: createShape(p, data) };
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
  updateAnnot({ page, id, data }) {
    return { result: updateShape(entry(page).page, id, data) };
  },
  // The line of the page's own text under a point (for "Replace text").
  lineAt({ page, p }) {
    const e = entry(page);
    if (!e.stext) e.stext = e.page.toStructuredText("preserve-whitespace");
    let best = null, bd = Infinity;
    for (const b of JSON.parse(e.stext.asJSON()).blocks || []) {
      if (b.type !== "text") continue;
      for (const l of b.lines || []) {
        const bb = l.bbox;
        if (!bb || !l.text || !l.text.trim()) continue;
        const dx = p[0] < bb.x ? bb.x - p[0] : p[0] > bb.x + bb.w ? p[0] - bb.x - bb.w : 0;
        const dy = p[1] < bb.y ? bb.y - p[1] : p[1] > bb.y + bb.h ? p[1] - bb.y - bb.h : 0;
        const d = dx + dy;
        if (d < bd) { bd = d; best = l; }
      }
    }
    if (!best || bd > 3) return { result: null };
    const f = best.font || {};
    const fam = /mono|courier/i.test(f.family + f.name) ? "Cour" : /serif|times|roman|georgia|garamond|cambria/i.test(f.family + f.name) && !/sans/i.test(f.family + f.name) ? "TiRo" : "Helv";
    return { result: { text: best.text.replace(/\s+$/, ""), bbox: [best.bbox.x, best.bbox.y, best.bbox.x + best.bbox.w, best.bbox.y + best.bbox.h], origin: [best.x, best.y], size: Math.round((f.size || 11) * 10) / 10, font: fam } };
  },
  // The file with erase areas applied ({ bake: true } also embeds every
  // markup into the pages; form fields stay fillable).
  exportCopy({ bake }) {
    const r = exportCopy(!!bake);
    return { result: r, transfer: [r.bytes.buffer] };
  },
  // A signature stamp as a transparent PNG (to restore it after erasing, or
  // to move/resize one loaded from the file).
  annotImage({ page, id }) {
    const a = findAnnot(entry(page).page, id);
    if (!a) return { result: null };
    const r = a.getRect();
    const sc = Math.max(1, Math.min(6, 1000 / Math.max(1, r[2] - r[0])));
    const pix = a.toPixmap(mupdf.Matrix.scale(sc, sc), mupdf.ColorSpace.DeviceRGB, true);
    try {
      const png = pix.asPNG().slice();
      return { result: png, transfer: [png.buffer] };
    } finally {
      pix.destroy();
    }
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
