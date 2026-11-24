// Eagles PDF viewer engine worker (MuPDF compiled to WebAssembly).
// Several of these run in parallel: one "edit" worker owns annotations,
// text and saving; the others only rasterize tiles.
import * as mupdf from "./vendor/mupdf/mupdf.js";
import { UNITS } from "./measure.js";
import { strokeOutline } from "./inkgeom.js";

const PDFAnnotation = mupdf.PDFAnnotation;
// MuPDF notes when it re-embeds a font that has no character map of its own;
// Inkleaf writes that map itself, so that note is only noise.
mupdf.setLog({
  error: (m) => console.error("mupdf: " + m),
  warning: (m) => { if (!/cannot create ToUnicode mapping/.test(m)) console.warn("mupdf: " + m); },
});
const MANAGED_TYPES = new Set(["Ink", "Square", "Highlight", "Line", "PolyLine", "Polygon"]);
// Line/PolyLine/Polygon are only managed when this app created them as
// measurements (marked with this key); anyone else's are left to MuPDF.
const MEASURE_TYPES = new Set(["Line", "PolyLine", "Polygon"]);
const MEASURE_KEY = "InkleafMeasure";
const MEASURE_INTENT = { Line: "LineDimension", PolyLine: "PolyLineDimension", Polygon: "PolygonDimension" };
const MEASURE_SUBJECT = { Line: "Length Measurement", PolyLine: "Length Measurement", Polygon: "Area Measurement" };
// Lines, arrows, clouds, text boxes, callouts and signatures this app created
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

// An area of a page as a PNG, for copying: the page with its markups
// (pending erase areas and retyped lines aside), `res` pixels per point.
function snip({ page, rect, res }) {
  const p = entry(page).page;
  const bbox = [Math.floor(rect[0] * res), Math.floor(rect[1] * res), Math.ceil(rect[2] * res), Math.ceil(rect[3] * res)];
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false);
  try {
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    const m = mupdf.Matrix.scale(res, res);
    try {
      p.runPageContents(dev, m);
      for (const a of p.getAnnotations()) if (!contentKind(a.getObject())) { try { a.run(dev, m); } catch {} }
      try { p.runPageWidgets(dev, m); } catch {}
    } finally { dev.close(); dev.destroy(); }
    const buf = pix.asPNG();
    const png = buf.slice ? buf.slice() : new Uint8Array(buf);
    return { result: { png, w: pix.getWidth(), h: pix.getHeight() }, transfer: [png.buffer] };
  } finally {
    pix.destroy();
  }
}

// A page thumbnail, drawn straight from the page (no cached display list, so
// thumbnails never push the page view's lists out of the cache).
async function thumb({ page, res, bbox }) {
  const p = entry(page).page;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false);
  try {
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    try { p.run(dev, mupdf.Matrix.scale(res, res)); } finally { dev.close(); dev.destroy(); }
    const w = pix.getWidth(), h = pix.getHeight(), src = pix.getPixels();
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < src.length; i += 3, j += 4) { rgba[j] = src[i]; rgba[j + 1] = src[i + 1]; rgba[j + 2] = src[i + 2]; rgba[j + 3] = 255; }
    const bitmap = await createImageBitmap(new ImageData(rgba, w, h));
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
  return drawSvg(a.getBounds(), (dev) => a.run(dev, mupdf.Matrix.identity));
}
function drawSvg(bounds, draw) {
  const buf = new mupdf.Buffer();
  try {
    const w = new mupdf.DocumentWriter(buf, "svg", "text=path");
    const dev = w.beginPage(bounds);
    try { draw(dev); } finally { w.endPage(); w.close(); }
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
  if (shape.k === "retext") {
    Object.assign(d, { text: shape.text, size: shape.size, color: shape.color, origin: shape.origin, erase: shape.erase, face: shape.face });
    const F = fontCache.get(shape.fkey);
    d.svg = F ? retextSvg(d.rect, shape, F) : null;
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
    const w = inkWidths(a);
    if (w && d.ink.length === 1 && w.length === d.ink[0].length) d.widths = w;
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

// Pen strokes drawn with pressure: their widths (one per point) are kept in
// this key, and the appearance is the stroke's filled outline, so it looks the
// same in any PDF app.
const INK_KEY = "InkleafInk";
function inkWidths(a) {
  try {
    const v = a.getObject().get(INK_KEY);
    if (!v || !v.isString()) return null;
    const w = JSON.parse(v.asString()).w;
    return Array.isArray(w) ? w : null;
  } catch { return null; }
}
function writeInkAP(a, p, data) {
  const pts = data.ink && data.ink[0], w = data.widths;
  if (!pts || !Array.isArray(w) || data.ink.length !== 1 || w.length !== pts.length) return;
  const m = mupdf.Matrix.invert(p.getTransform());
  const P = strokeOutline(pts, w).map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = P.map((q) => q[0]), ys = P.map((q) => q[1]);
  const r = [Math.min(...xs) - 0.5, Math.min(...ys) - 0.5, Math.max(...xs) + 0.5, Math.max(...ys) + 0.5];
  const f = (v) => String(Math.round(v * 1000) / 1000);
  const arr = (vals) => { const o = doc.newArray(); for (const v of vals) o.push(doc.newReal(v)); return o; };
  const c = Array.isArray(data.color) && data.color.length === 3 ? data.color : [0, 0, 0];
  const ops = `${c.map(f).join(" ")} rg\n${f(P[0][0])} ${f(P[0][1])} m\n` + P.slice(1).map((q) => `${f(q[0])} ${f(q[1])} l`).join("\n") + "\nh f\n";
  const obj = a.getObject();
  obj.put("Rect", arr(r));
  const ap = obj.get("AP").get("N");
  ap.writeStream(ops);
  ap.put("BBox", arr(r));
  ap.put("Matrix", arr([1, 0, 0, 1, 0, 0]));
  obj.put(INK_KEY, doc.newString(JSON.stringify({ v: 1, w })));
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
  } else if (k === "sig" || k === "image" || k === "redact") {
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
  } else if (k === "sig" || k === "image") {
    a = p.createAnnotation("Stamp");
    a.setRect(data.rect);
    a.setStampImage(new mupdf.Image(data.png));
    a.setContents(k === "sig" ? "Signature" : "Picture");
  } else {
    throw new Error("Unknown shape " + k);
  }
  setShapeProps(a, k, data, info);
  if (author) { try { a.setAuthor(author); } catch {} }
  try { a.setModificationDate(new Date()); } catch {}
  return finishShape(a, k, data, info);
}

// Change an existing shape (or plain box) in place.
function updateShape(p, id, data) {
  const a = findAnnot(p, id);
  if (!a) throw new Error("That markup is no longer in the document");
  // Text highlights and measurements: moved or resized with other markups.
  if (!data.shape && (data.type === "Highlight" || data.measure)) {
    if (data.type === "Highlight") a.setQuadPoints(data.quads);
    else {
      if (data.type === "Line") a.setLine(data.pts[0], data.pts[1]);
      else a.setVertices(data.pts);
      a.setContents(data.contents || "");
      writeMeasure(a, data);
    }
    try { a.setModificationDate(new Date()); } catch {}
    a.update();
    return { bounds: Array.from(a.getBounds()) };
  }
  const k = data.shape ? data.shape.k : data.type === "Ink" ? "ink" : "box";
  const info = data.shape ? Object.assign({ v: 1 }, shapeInfo(a) || {}, { k }) : null;
  setShapeProps(a, k, data, info || {});
  try { a.setModificationDate(new Date()); } catch {}
  const out = finishShape(a, k, data, info);
  if (k === "ink" && data.widths) { writeInkAP(a, p, data); out.bounds = Array.from(a.getBounds()); }
  return out;
}

// ---- edited lines of page text ("retext") --------------------------------
// Retyping a line of the page's text makes one "retext" item: the old line's
// box (whited out) plus the new text, set in the same font, size, colour and
// baseline. Until saving it is an annotation drawn from our own glyph layout;
// saving writes it into the page as real text (searchable, editable again).
//
// The font, in order of preference:
//   1. the document's own embedded font, when every letter of the new text is
//      already drawn with it on the page (so the glyphs are sure to exist);
//   2. the same font installed on this computer (found by name);
//   3. the nearest standard PDF font (Helvetica, Times, Courier; bold/italic).
const fontCache = new Map(); // key -> { font, gidOf, spaceGid, spaceEm, full }
let scratchDoc = null;
const B14 = {
  sans: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
  serif: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
  mono: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
};

// Glyphs each font draws on a page (visible text only): unicode -> glyph id.
function pageGlyphs(i) {
  const e = entry(i);
  if (e.glyphs) return e.glyphs;
  const map = new Map();
  const collect = (text) => {
    text.walk({
      showGlyph(font, trm, gid, uni) {
        const k = "p" + font.pointer;
        let g = map.get(k);
        if (!g) { g = { font, map: new Map() }; map.set(k, g); }
        if (uni > 0 && gid > 0 && !g.map.has(uni)) g.map.set(uni, gid);
      },
    });
  };
  const dev = new mupdf.Device({ fillText: collect, strokeText: collect });
  try { e.page.runPageContents(dev, mupdf.Matrix.identity); } catch {} finally { try { dev.close(); } catch {} }
  e.glyphs = map;
  return map;
}

// Can this font be embedded again (not a Type 3 or otherwise odd font)?
function embeddable(font) {
  try {
    if (/glyphless/i.test(font.getName())) return false;
    scratchDoc ||= new mupdf.PDFDocument();
    scratchDoc.addFont(font);
    return true;
  } catch {
    return false;
  }
}

const sysEntry = (font, full) => ({ font, gidOf: (u) => font.encodeCharacter(u), spaceGid: font.encodeCharacter(32), spaceEm: 0, full });

async function resolveFace(page, face, text) {
  const need = [...text].filter((ch) => !/\s/.test(ch)).map((ch) => ch.codePointAt(0));
  const g = face.key && pageGlyphs(page).get(face.key);
  if (g && need.every((u) => g.map.has(u))) {
    const key = "page:" + face.key;
    if (!fontCache.has(key) && embeddable(g.font)) {
      fontCache.set(key, { font: g.font, gidOf: (u) => g.map.get(u) || 0, spaceGid: g.map.get(32) || 0, spaceEm: face.spaceEm || 0, full: false });
    }
    if (fontCache.has(key)) return key;
  }
  if (face.url && face.file) {
    const key = "sys:" + face.file + "#" + (face.index || 0);
    if (!fontCache.has(key)) {
      try {
        const r = await fetch(face.url);
        if (r.ok) fontCache.set(key, sysEntry(new mupdf.Font(face.ps || face.name || "Font", new Uint8Array(await r.arrayBuffer()), face.index || 0), true));
      } catch {}
    }
    if (fontCache.has(key)) return key;
  }
  const name = B14[face.mono ? "mono" : face.serif ? "serif" : "sans"][(face.bold ? 1 : 0) + (face.italic ? 2 : 0)];
  const key = "b14:" + name;
  if (!fontCache.has(key)) fontCache.set(key, sysEntry(new mupdf.Font(name), true));
  return key;
}

// Glyph runs (one per word) from the baseline origin, and the text's box.
function layoutRetext(info, F) {
  const size = info.size, lh = size * 1.2, o = info.origin;
  const spaceEm = (F.spaceGid && F.font.advanceGlyph(F.spaceGid)) || F.spaceEm || (info.face && info.face.spaceEm) || 0.25;
  const runs = [];
  const lines = info.text.split("\n");
  let maxX = o[0];
  lines.forEach((line, j) => {
    let x = o[0], cur = null;
    const y = o[1] + j * lh;
    for (const ch of line) {
      if (/\s/.test(ch)) { x += spaceEm * size * (ch === "\t" ? 4 : 1); cur = null; continue; }
      const u = ch.codePointAt(0), gid = F.gidOf(u) || 0;
      if (!cur) { cur = { x: r2(x), y: r2(y), g: [], u: [] }; runs.push(cur); }
      cur.g.push(gid);
      cur.u.push(u);
      x += F.font.advanceGlyph(gid) * size;
    }
    maxX = Math.max(maxX, x);
  });
  return { runs, box: [o[0], o[1] - size * 0.95, Math.max(maxX, o[0] + size * 0.3), o[1] + (lines.length - 1) * lh + size * 0.3] };
}
const r2 = (v) => Math.round(v * 100) / 100;

function rectPath(r) {
  const p = new mupdf.Path();
  p.moveTo(r[0], r[1]); p.lineTo(r[2], r[1]); p.lineTo(r[2], r[3]); p.lineTo(r[0], r[3]); p.closePath();
  return p;
}

function retextSvg(rect, info, F) {
  return drawSvg(rect, (dev) => {
    if (info.erase) dev.fillPath(rectPath(info.erase), false, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [1, 1, 1], 1);
    if (!info.runs || !info.runs.length) return;
    const t = new mupdf.Text(), s = info.size;
    for (const r of info.runs) {
      let x = r.x;
      r.g.forEach((gid, k) => { t.showGlyph(F.font, [s, 0, 0, -s, x, r.y], gid, r.u[k]); x += F.font.advanceGlyph(gid) * s; });
    }
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, info.color && info.color.length === 3 ? info.color : [0, 0, 0], 1);
  });
}

async function retextInfo(page, data) {
  const face = data.face || {};
  const fkey = await resolveFace(page, face, data.text || "");
  const F = fontCache.get(fkey);
  const store = { v: 1, k: "retext", text: data.text || "", size: data.size, color: data.color, origin: data.origin, erase: data.erase, face, fkey };
  const { runs, box } = layoutRetext(store, F);
  store.runs = runs;
  const e = data.erase;
  const rect = (runs.length ? [Math.min(e[0], box[0]), Math.min(e[1], box[1]), Math.max(e[2], box[2]), Math.max(e[3], box[3])] : e.slice()).map(r2);
  return { store, rect, svg: retextSvg(rect, store, F) };
}

async function createRetext(p, page, data) {
  const R = await retextInfo(page, data);
  const a = p.createAnnotation("Redact");
  a.setRect(R.rect);
  a.getObject().put(SHAPE_KEY, doc.newString(JSON.stringify(R.store)));
  if (author) { try { a.setAuthor(author); } catch {} }
  try { a.setModificationDate(new Date()); } catch {}
  a.update();
  return { id: a.getObject().asIndirect(), bounds: R.rect, rect: R.rect, svg: R.svg };
}

async function updateRetext(p, page, id, data) {
  const a = findAnnot(p, id);
  if (!a) throw new Error("That edit is no longer in the document");
  const R = await retextInfo(page, data);
  a.setRect(R.rect);
  a.getObject().put(SHAPE_KEY, doc.newString(JSON.stringify(R.store)));
  a.update();
  return { id, bounds: R.rect, rect: R.rect, svg: R.svg };
}

// ---- applying erase areas and edited lines (when saving) -------------------
const REDACT = [0, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE];
const subtypeOf = (o) => { try { return o.get("Subtype").asName(); } catch { return ""; } };
const contentKind = (o) => {
  try {
    if (subtypeOf(o) !== "Redact") return null;
    const v = o.get(SHAPE_KEY);
    if (!v || !v.isString()) return null;
    const k = JSON.parse(v.asString()).k;
    return k === "redact" || k === "retext" ? k : null;
  } catch { return null; }
};
function pdfRect(o) {
  try {
    const r = o.get("Rect"), v = [0, 1, 2, 3].map((k) => r.get(k).asNumber());
    return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
  } catch { return null; }
}
// Share of `r` lying inside `by`.
function coverage(r, by) {
  const w = Math.min(r[2], by[2]) - Math.max(r[0], by[0]), h = Math.min(r[3], by[3]) - Math.max(r[1], by[1]);
  const a = Math.max(1e-6, (r[2] - r[0]) * (r[3] - r[1]));
  return w > 0 && h > 0 ? (w * h) / a : 0;
}

// Applies every erase area and edited line, page by page in the order they
// were made: what an erase area covers is removed for good (text, line art,
// image pixels, and markups made before it that lie mostly inside it), and
// edited lines become real page text. Returns how many were applied.
function applyContentEdits(d) {
  let count = 0;
  const fonts = new Map(); // font key -> { obj, uni: Map<gid, unicode>, names: Map<page, name> }
  for (let i = 0; i < d.countPages(); i++) {
    const pobj = d.findPage(i);
    const annots = pobj.get("Annots");
    if (!annots || !annots.isArray() || !annots.length) continue;
    const items = [];
    for (let k = 0; k < annots.length; k++) { const o = annots.get(k); items.push({ o, k, kind: contentKind(o) }); }
    const mine = items.filter((x) => x.kind);
    if (!mine.length) continue;
    const gone = new Set();
    for (const m of mine) {
      if (m.kind !== "redact") continue;
      const er = pdfRect(m.o);
      if (!er) continue;
      for (const x of items) {
        if (x.k >= m.k || x.kind || gone.has(x)) continue;
        const st = subtypeOf(x.o);
        if (st === "Widget" || st === "Popup") continue;
        const r = pdfRect(x.o);
        if (r && coverage(r, er) >= 0.5) gone.add(x);
      }
    }
    if (gone.size) {
      const nums = new Set([...gone].map((x) => x.o.asIndirect()));
      for (const x of items) if (subtypeOf(x.o) === "Popup" && nums.has(x.o.get("Parent").asIndirect())) gone.add(x);
    }
    // MuPDF's redaction also deletes annotations under the areas, so the
    // markups are kept out of its reach while the edits are applied.
    const only = d.newArray();
    for (const m of mine) only.push(m.o);
    pobj.put("Annots", only);
    const page = d.loadPage(i);
    for (const a of page.getAnnotations()) {
      const info = shapeInfo(a);
      if (!info) continue;
      if (info.k === "redact") {
        const r = Array.from(a.getRect());
        a.applyRedaction(...REDACT);
        whiteout(d, page, [r]);
        count++;
      } else if (info.k === "retext") {
        if (Array.isArray(info.erase)) {
          const t = page.createAnnotation("Redact");
          t.setRect(info.erase);
          t.update();
          t.applyRedaction(...REDACT);
          whiteout(d, page, [info.erase]);
        }
        if (info.runs && info.runs.length) writeRuns(d, page, i, info, fonts);
        count++;
      }
    }
    page.destroy();
    const arr = d.newArray(), left = pobj.get("Annots");
    if (left && left.isArray()) for (let k = 0; k < left.length; k++) if (!contentKind(left.get(k))) arr.push(left.get(k));
    for (const x of items) if (!x.kind && !gone.has(x)) arr.push(x.o);
    pobj.put("Annots", arr);
  }
  // A ToUnicode map for each font we added, so the new text can be searched,
  // copied and edited again.
  for (const f of fonts.values()) f.obj.put("ToUnicode", d.addStream(toUnicodeCMap(f.uni), {}));
  // Whole installed fonts were embedded: keep only the letters used. (Not
  // in forms, whose fields may need any letter when filled in later.)
  if ([...fonts.values()].some((f) => f.full) && !hasFormFields(d)) { try { d.subsetFonts(); } catch {} }
  return count;
}

function hasFormFields(d) {
  try {
    const f = d.getTrailer().get("Root").get("AcroForm").get("Fields");
    return f.isArray() && f.length > 0;
  } catch { return false; }
}

function writeRuns(d, page, i, info, fonts) {
  const F = fontCache.get(info.fkey);
  if (!F) return;
  let f = fonts.get(info.fkey);
  if (!f) { f = { obj: d.addFont(F.font), uni: new Map(), names: new Map(), full: F.full }; fonts.set(info.fkey, f); }
  const pobj = page.getObject();
  let res = pobj.get("Resources");
  if (!res.isDictionary()) {
    const inh = pobj.getInheritable("Resources");
    res = d.newDictionary();
    if (inh.isDictionary()) inh.forEach((v, k) => res.put(k, v));
    pobj.put("Resources", res);
  }
  let fd = res.get("Font");
  if (!fd.isDictionary()) { fd = d.newDictionary(); res.put("Font", fd); }
  let name = f.names.get(i);
  if (!name) {
    let n = 0;
    while (!fd.get("IkF" + n).isNull()) n++;
    name = "IkF" + n;
    fd.put(name, f.obj);
    f.names.set(i, name);
  }
  const inv = mupdf.Matrix.invert(page.getTransform());
  const num = (v) => String(Math.round(v * 10000) / 10000);
  const c = info.color && info.color.length === 3 ? info.color : [0, 0, 0];
  let ops = `q BT ${c.map(num).join(" ")} rg /${name} ${num(info.size)} Tf\n`;
  for (const r of info.runs) {
    const m = mupdf.Matrix.concat([1, 0, 0, -1, r.x, r.y], inv);
    ops += `${m.map(num).join(" ")} Tm <${r.g.map((g) => g.toString(16).padStart(4, "0")).join("")}> Tj\n`;
    r.g.forEach((g, k) => { if (g) f.uni.set(g, r.u[k]); });
  }
  ops += "ET Q\n";
  appendContent(d, pobj, ops);
}

function toUnicodeCMap(uni) {
  const utf16 = (u) => {
    if (u < 0x10000) return u.toString(16).padStart(4, "0");
    const v = u - 0x10000;
    return (0xd800 + (v >> 10)).toString(16) + (0xdc00 + (v & 0x3ff)).toString(16);
  };
  const ent = [...uni.entries()].sort((a, b) => a[0] - b[0]);
  let s = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n";
  for (let k = 0; k < ent.length; k += 100) {
    const part = ent.slice(k, k + 100);
    s += `${part.length} beginbfchar\n` + part.map(([g, u]) => `<${g.toString(16).padStart(4, "0")}> <${utf16(u)}>`).join("\n") + "\nendbfchar\n";
  }
  return s + "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
}

// Add content on top of the page, after wrapping what's there in q/Q so
// its leftover graphics state can't move or recolour ours.
function appendContent(d, pobj, ops) {
  const old = pobj.get("Contents");
  const arr = d.newArray();
  arr.push(d.addStream("q\n", {}));
  if (old.isArray()) for (let k = 0; k < old.length; k++) arr.push(old.get(k));
  else if (!old.isNull()) arr.push(old);
  arr.push(d.addStream("Q\n" + ops, {}));
  pobj.put("Contents", arr);
}

function whiteout(d, page, rects) {
  const inv = mupdf.Matrix.invert(page.getTransform());
  let ops = "q 1 g\n";
  for (const r of rects) {
    const R = mupdf.Rect.transform(r, inv);
    ops += `${R[0].toFixed(3)} ${R[1].toFixed(3)} ${(R[2] - R[0]).toFixed(3)} ${(R[3] - R[1]).toFixed(3)} re\n`;
  }
  appendContent(d, page.getObject(), ops + "f Q\n");
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
    const erased = applyContentEdits(tmp);
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
  // Page names: the PDF's own page labels ("A-101", "iv"; plain numbers
  // don't count) and the bookmark that points at the page.
  const labels = new Array(n).fill("");
  for (let i = 0; i < n; i++) {
    const p = doc.loadPage(i);
    const b = p.getBounds();
    info[i * 4] = b[0]; info[i * 4 + 1] = b[1]; info[i * 4 + 2] = b[2]; info[i * 4 + 3] = b[3];
    try { const l = (p.getLabel() || "").trim(); if (l && l !== String(i + 1)) labels[i] = l; } catch {}
    p.destroy();
  }
  const titles = new Array(n).fill("");
  try {
    const walk = (items) => {
      for (const it of items || []) {
        if (it.page >= 0 && it.page < n && !titles[it.page] && it.title) titles[it.page] = it.title.trim();
        walk(it.down);
      }
    };
    walk(doc.loadOutline());
  } catch {}
  const names = labels.map((l, i) => [l, titles[i]].filter(Boolean).filter((v, k, a) => a.indexOf(v) === k).join(" · "));
  return { needsPassword: false, pageCount: n, bounds: info, names: names.some(Boolean) ? names : null, isPDF: doc.isPDF() };
}

let fileBytes = null;
let docPassword = null;

// ---- pages: delete, add, copy in, move, rotate; merging files --------------
// Each change is made to the open document, which is then rewritten in
// memory (dropping removed pages' content) and reopened; the renderers reopen
// the same bytes. The state before the change comes back for undo.
// ---- search ---------------------------------------------------------------
// Case-insensitive, runs of spaces count as one; a match stays within a line.
// Pages are opened only for the search (not kept), so a long PDF doesn't fill
// the page cache.
const normFind = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();

function searchPage(i, want) {
  const e = pages.get(i);
  const page = e ? e.page : doc.loadPage(i);
  const st = e?.stext || page.toStructuredText("preserve-whitespace");
  const hits = [];
  try {
    let chars = null, quads = null;
    st.walk({
      beginLine() { chars = []; quads = []; },
      onChar(c, origin, font, size, quad) { chars.push(c); quads.push(quad); },
      endLine() {
        if (!chars || !chars.length || hits.length >= 500) return;
        // Lower-case text with runs of spaces collapsed, mapped back to characters.
        let low = "", map = [], orig = "", omap = [];
        for (let k = 0; k < chars.length; k++) {
          const c = chars[k];
          if (/\s/.test(c)) {
            if (low.endsWith(" ") || !low) continue;
            low += " "; map.push(k); omap[k] = orig.length; orig += " ";
            continue;
          }
          const l = c.toLowerCase();
          low += l;
          for (let u = 0; u < l.length; u++) map.push(k);
          omap[k] = orig.length;
          orig += c;
        }
        let at = low.indexOf(want);
        while (at >= 0 && hits.length < 500) {
          const k0 = map[at], k1 = map[at + want.length - 1];
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (let k = k0; k <= k1; k++) {
            const q = quads[k];
            for (let v = 0; v < 8; v += 2) { x0 = Math.min(x0, q[v]); x1 = Math.max(x1, q[v]); y0 = Math.min(y0, q[v + 1]); y1 = Math.max(y1, q[v + 1]); }
          }
          // A little of the line around it, for the results list.
          const s0 = omap[k0], s1 = omap[k1] + chars[k1].length;
          const a = Math.max(0, s0 - 36), b = Math.min(orig.length, s1 + 44);
          hits.push({ rect: [x0, y0, x1, y1].map((v) => Math.round(v * 100) / 100), text: (a ? "…" : "") + orig.slice(a, b) + (b < orig.length ? "…" : ""), at: s0 - a + (a ? 1 : 0), len: s1 - s0 });
          at = low.indexOf(want, at + Math.max(1, want.length));
        }
      },
    });
  } finally {
    if (!e?.stext) st.destroy();
    if (!e) page.destroy();
  }
  return hits;
}

// ---- the markups list ------------------------------------------------------
function markKind(a, type, shape) {
  if (shape) return shape.k;
  if (type === "Ink") return a.getOpacity() < 1 ? "marker" : "ink";
  if (type === "Highlight") return "highlight";
  if (type === "Square") return "box";
  if (MEASURE_TYPES.has(type) && measureInfo(a)) return "measure";
  return type.toLowerCase();
}

function markSummary(i, page) {
  const out = [];
  let st = null;
  try {
    for (const a of page.getAnnotations()) {
      if (!isManaged(a)) continue;
      const type = a.getType(), shape = SHAPE_TYPES.has(type) ? shapeInfo(a) : null, k = markKind(a, type, shape);
      let text = "", color = null;
      try {
        if (type === "FreeText") { text = a.getContents() || ""; color = colorOf(a.getDefaultAppearance().color); }
        else color = colorOf(a.getColor());
      } catch {}
      if (k === "measure") text = (a.getContents() || "").split(/\r?\n/)[0];
      else if (k === "retext") text = shape.text || "";
      else if (k === "highlight") {
        // The highlighted words.
        try {
          const q = a.getQuadPoints();
          if (q.length) {
            st ||= page.toStructuredText("preserve-whitespace");
            const f = q[0], l = q[q.length - 1];
            text = st.copy([f[0] + 0.5, (f[1] + f[5]) / 2], [l[2] - 0.5, (l[3] + l[7]) / 2]) || "";
          }
        } catch {}
      }
      let author = "", date = 0;
      try { author = a.getAuthor() || ""; } catch {}
      // (An unset date comes back as the start of 1970: leave it out.)
      try { const m = a.getModificationDate(); date = m && +m > 631152000000 ? +m : 0; } catch {}
      out.push({ page: i, id: a.getObject().asIndirect(), k, color, text: text.replace(/\s+/g, " ").trim().slice(0, 160), author, date, rect: Array.from(a.getBounds()) });
    }
  } finally {
    try { st?.destroy(); } catch {}
  }
  return out;
}

// The PDF pages are copied from: a file, or (`bytes`) another open PDF as it
// is now, with its unsaved markups.
async function loadSource(url, password, bytes) {
  let data = bytes;
  if (!data) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Cannot read file (${r.status})`);
    data = new Uint8Array(await r.arrayBuffer());
  }
  const src = mupdf.Document.openDocument(data, "application/pdf");
  if (src.needsPassword() && !(password && src.authenticatePassword(password))) {
    src.destroy();
    const e = new Error("This PDF is password protected");
    e.code = "password";
    throw e;
  }
  return src;
}

function snapshot(opts) {
  const b = doc.saveToBuffer(opts || "");
  const u = b.asUint8Array().slice();
  b.destroy();
  return u;
}

function reloadFrom(bytes) {
  fileBytes = { url: fileBytes?.url, data: bytes };
  const r = openFrom(bytes, docPassword);
  if (r.needsPassword) throw new Error("Couldn't reopen the document");
  return r;
}

function graftPages(src, list, at) {
  const map = doc.newGraftMap(); // shared fonts and images are copied once
  list.forEach((sp, k) => map.graftPage(at + k, src, sp));
}

// Page labels ("A-101") belong to positions in a PDF: after pages move,
// are deleted or added, each page's own label is written back explicitly.
function readLabels() {
  try {
    if (doc.getTrailer().get("Root").get("PageLabels").isNull()) return null;
    const n = doc.countPages(), out = [];
    for (let i = 0; i < n; i++) { const p = doc.loadPage(i); const l = p.getLabel(); p.destroy(); out.push(l && l !== String(i + 1) ? l : null); }
    return out.some((l) => l) ? out : null;
  } catch { return null; }
}
function writeLabels(from, old) {
  const nums = doc.newArray();
  from.forEach((k, i) => {
    const d = doc.newDictionary();
    d.put("P", doc.newString(k != null && old[k] ? old[k] : String(i + 1)));
    nums.push(doc.newInteger(i));
    nums.push(d);
  });
  const pl = doc.newDictionary();
  pl.put("Nums", nums);
  doc.getTrailer().get("Root").put("PageLabels", pl);
}
const span = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);

async function pageOp(op) {
  const n = doc.countPages();
  const valid = (i) => Number.isInteger(i) && i >= 0 && i < n;
  const labels = op.kind === "rotate" ? null : readLabels();
  let from = null; // for each new page, the old page it came from (null: new)
  switch (op.kind) {
    case "delete": {
      const list = [...new Set(op.pages)].filter(valid).sort((a, b) => b - a);
      if (!list.length) throw new Error("No pages to delete");
      if (list.length >= n) throw new Error("A PDF needs at least one page");
      for (const i of list) doc.deletePage(i);
      from = span(0, n).filter((i) => !list.includes(i));
      break;
    }
    case "blank": {
      const at = Math.max(0, Math.min(n, op.at)), c = Math.max(1, Math.min(100, op.count || 1));
      for (let k = 0; k < c; k++) doc.insertPage(at + k, doc.addPage([0, 0, op.w, op.h], 0, null, ""));
      from = [...span(0, at), ...Array(c).fill(null), ...span(at, n)];
      break;
    }
    case "insert": {
      const src = await loadSource(op.url, op.password, op.bytes);
      try {
        const m = src.countPages();
        const list = (op.pages && op.pages.length ? op.pages : [...Array(m).keys()]).filter((i) => i >= 0 && i < m);
        const at = Math.max(0, Math.min(n, op.at));
        graftPages(src, list, at);
        from = [...span(0, at), ...Array(list.length).fill(null), ...span(at, n)];
      } finally { src.destroy(); }
      break;
    }
    case "duplicate": {
      const list = op.pages.filter(valid).sort((a, b) => a - b);
      const src = mupdf.Document.openDocument(snapshot(""), "application/pdf");
      try {
        if (src.needsPassword()) src.authenticatePassword(docPassword || "");
        const at = Math.max(0, Math.min(n, op.at));
        graftPages(src, list, at);
        from = [...span(0, at), ...list, ...span(at, n)];
      } finally { src.destroy(); }
      break;
    }
    case "move": {
      // op.order: the old index of each page, in the new order.
      if (op.order.length !== n || new Set(op.order).size !== n || !op.order.every(valid)) throw new Error("Bad page order");
      doc.rearrangePages(op.order);
      from = op.order.slice();
      break;
    }
    case "rotate": {
      for (const i of op.pages.filter(valid)) {
        const pobj = doc.findPage(i);
        const r = pobj.getInheritable("Rotate");
        const cur = r.isNumber() ? r.asNumber() : 0;
        pobj.put("Rotate", doc.newInteger((((cur + op.by) % 360) + 360) % 360));
      }
      break;
    }
    default:
      throw new Error("Unknown page change " + op.kind);
  }
  if (labels && from) writeLabels(from, labels);
}

function structureResult(before) {
  const after = snapshot("garbage=yes,compress=yes");
  const r = reloadFrom(after);
  const forRenderers = after.slice();
  const result = { bytes: forRenderers, bounds: r.bounds, pageCount: r.pageCount, names: r.names };
  const transfer = [forRenderers.buffer, r.bounds.buffer];
  if (before) { result.before = before; transfer.push(before.buffer); }
  return { result, transfer };
}

const handlers = {
  async open({ url, password, bytes }) {
    if (bytes) fileBytes = { url: null, data: bytes }; // reopened after a page change
    else if (!fileBytes || fileBytes.url !== url) {
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
  // Change pages (see pageOp); returns the new bytes and page sizes, and the
  // document as it was before, for undo.
  async pages({ op }) {
    const before = snapshot("");
    await pageOp(op);
    return structureResult(before);
  },
  // Undo/redo of a page change: go back to a saved state, returning the
  // current one.
  restore({ bytes }) {
    const before = snapshot("");
    reloadFrom(bytes);
    return structureResult(before);
  },
  // Number of pages in another PDF (to choose pages to copy from it).
  // Search pages from `from` on for up to `budget` ms; `next` is where to
  // carry on (-1 when done).
  search({ needle, from, budget = 50 }) {
    const want = normFind(needle), n = doc.countPages(), t0 = performance.now(), out = [];
    if (!want) return { result: { pages: [], next: -1 } };
    let i = Math.max(0, from);
    for (; i < n && (i === from || performance.now() - t0 < budget); i++) {
      const hits = searchPage(i, want);
      if (hits.length) out.push({ page: i, hits });
    }
    return { result: { pages: out, next: i < n ? i : -1 } };
  },
  // Every markup on pages from..to-1, for the markups list.
  markList({ from, to }) {
    const out = [], n = doc.countPages();
    if (!doc.isPDF()) return { result: out };
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) {
      const e = pages.get(i);
      const page = e ? e.page : doc.loadPage(i);
      try { out.push(...markSummary(i, page)); } finally { if (!e) page.destroy(); }
    }
    return { result: out };
  },
  // The open document as it is now (markups included), to copy pages from.
  snapshot() {
    const b = snapshot("");
    return { result: b, transfer: [b.buffer] };
  },
  async countPagesOf({ url, password }) {
    const src = await loadSource(url, password);
    try { return { result: src.countPages() }; } finally { src.destroy(); }
  },
  // A new PDF with every page of each file, in order.
  async merge({ files }) {
    const out = new mupdf.PDFDocument();
    const failed = [];
    try {
      for (const f of files) {
        let src;
        try { src = await loadSource(f.url); } catch (e) { failed.push({ name: f.name, why: e.code === "password" ? "password protected" : e.message }); continue; }
        try {
          const map = out.newGraftMap();
          const m = src.countPages();
          for (let i = 0; i < m; i++) map.graftPage(out.countPages(), src, i);
        } catch (e) {
          failed.push({ name: f.name, why: e.message });
        } finally { src.destroy(); }
      }
      if (!out.countPages()) throw new Error("None of the files could be read" + (failed.length ? ` (${failed.map((x) => x.name + ": " + x.why).join("; ")})` : ""));
      const b = out.saveToBuffer("garbage=yes,compress=yes");
      const bytes = b.asUint8Array().slice();
      b.destroy();
      return { result: { bytes, failed, pages: out.countPages() }, transfer: [bytes.buffer] };
    } finally { out.destroy(); }
  },
  render,
  thumb,
  snip,
  pageAnnots({ page }) {
    const e = entry(page);
    const out = [];
    if (e.page.isPDF()) {
      for (const a of e.page.getAnnotations()) if (isManaged(a)) out.push(annotData(a));
    }
    return { result: out };
  },
  async addAnnot({ page, data }) {
    const p = entry(page).page;
    if (data.shape && data.shape.k === "retext") return { result: await createRetext(p, page, data) };
    if (data.shape) return { result: createShape(p, data) };
    const a = p.createAnnotation(data.type);
    if (author) { try { a.setAuthor(author); } catch {} }
    try { a.setModificationDate(new Date()); } catch {}
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
    if (data.type === "Ink" && data.widths) writeInkAP(a, p, data);
    return { result: a.getObject().asIndirect() };
  },
  async updateAnnot({ page, id, data }) {
    if (data.shape && data.shape.k === "retext") return { result: await updateRetext(entry(page).page, page, id, data) };
    return { result: updateShape(entry(page).page, id, data) };
  },
  // The line of the page's own text under a point, for retyping it: its
  // text, box, exact baseline start, size, colour and font.
  lineAt({ page, p }) {
    const e = entry(page);
    if (!e.stext) e.stext = e.page.toStructuredText("preserve-whitespace");
    let best = null, bd = Infinity, cur = null;
    e.stext.walk({
      beginLine(bbox, wmode, dir) { cur = { bbox, dir, wmode, chars: [] }; },
      onChar(c, origin, font, size, quad, color) { cur.chars.push({ c, origin, font, size, quad, color }); },
      endLine() {
        const l = cur;
        if (!l.chars.some((ch) => ch.c.trim())) return;
        const bb = l.bbox;
        const dx = p[0] < bb[0] ? bb[0] - p[0] : p[0] > bb[2] ? p[0] - bb[2] : 0;
        const dy = p[1] < bb[1] ? bb[1] - p[1] : p[1] > bb[3] ? p[1] - bb[3] : 0;
        if (dx + dy < bd) { bd = dx + dy; best = l; }
      },
    });
    if (!best || bd > 3) return { result: null };
    if (best.wmode || Math.abs(best.dir[1]) > 0.02 || best.dir[0] < 0) return { result: { rotated: true } };
    const chars = best.chars;
    let lastInk = chars.length - 1;
    while (lastInk > 0 && !chars[lastInk].c.trim()) lastInk--;
    const used = chars.slice(0, lastInk + 1);
    // The font, size and colour most of the line is set in.
    const tally = new Map();
    for (const ch of used) {
      if (!ch.c.trim()) continue;
      const k = ch.font.pointer + "|" + ch.size.toFixed(2) + "|" + ch.color.join(",");
      const t = tally.get(k) || { n: 0, ch };
      t.n++;
      tally.set(k, t);
    }
    const main = [...tally.values()].sort((a, b) => b.n - a.n)[0].ch;
    const f = main.font, raw = f.getName();
    const name = raw.replace(/^[A-Z]{6}\+/, "");
    const spaces = used.filter((ch) => ch.c === " ").map((ch) => (ch.quad[2] - ch.quad[0]) / ch.size).filter((w) => w > 0.05 && w < 1);
    spaces.sort((a, b) => a - b);
    const first = used.find((ch) => ch.c.trim()) || used[0];
    const xs = used.flatMap((ch) => [ch.quad[0], ch.quad[2], ch.quad[4], ch.quad[6]]);
    const ys = used.flatMap((ch) => [ch.quad[1], ch.quad[3], ch.quad[5], ch.quad[7]]);
    const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    return {
      result: {
        text: used.map((ch) => ch.c).join(""),
        bbox,
        origin: [first.origin[0], first.origin[1]],
        size: Math.round(main.size * 100) / 100,
        color: main.color.map((v) => Math.round(v * 1000) / 1000),
        face: {
          key: "p" + f.pointer, name,
          bold: f.isBold() || /bold|black|heavy|semibold|demi/i.test(name),
          italic: f.isItalic() || /italic|oblique/i.test(name),
          mono: f.isMono() || /courier|mono|consol/i.test(name),
          serif: /times|roman|serif|georgia|garamond|cambria|caladea|book|minion|palatino|century/i.test(name) && !/sans/i.test(name),
          spaceEm: spaces.length ? Math.round(spaces[spaces.length >> 1] * 1000) / 1000 : 0,
        },
      },
    };
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
