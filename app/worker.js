// Inkleaf PDF engine worker (MuPDF compiled to WebAssembly).
// Several of these run in parallel: one "edit" worker owns annotations,
// text and saving; the others only rasterize tiles.
import * as mupdf from "./vendor/mupdf/mupdf.js";

const PDFAnnotation = mupdf.PDFAnnotation;
const MANAGED_TYPES = new Set(["Ink", "Square", "Highlight"]);
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
function isManaged(a) {
  try {
    if (!MANAGED_TYPES.has(a.getType())) return false;
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
  }
  return d;
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
