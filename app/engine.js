// Worker pool + render scheduler.
// - One "edit" worker owns annotations, text lookup and saving.
// - N "render" workers rasterize tiles in parallel (one task in flight each),
//   always picking the highest-priority task from a queue that the viewer
//   replaces every time the view changes, so stale work is simply dropped.

class WorkerClient {
  constructor(url) {
    this.worker = new Worker(url, { type: "module" });
    this.seq = 0;
    this.pending = new Map();
    this.busy = false;
    this.ready = new Promise((resolve, reject) => {
      this.worker.onerror = (e) => reject(new Error(e.message || "Worker failed to start"));
      this.worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.ready) { resolve(); return; }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
      };
    });
  }
  // Messages sent while the worker is still compiling MuPDF would be lost,
  // so every call waits for the worker's "ready" signal first.
  call(type, args, transfer) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ready.then(
        () => this.worker.postMessage({ id, type, args }, transfer || []),
        (err) => { this.pending.delete(id); reject(err); }
      );
    });
  }
}

export class Engine {
  constructor(workerUrl, renderCount) {
    this.edit = new WorkerClient(workerUrl);
    this.renderers = [];
    for (let i = 0; i < renderCount; i++) this.renderers.push(new WorkerClient(workerUrl));
    this.queue = [];
    this.inFlight = new Map(); // key -> task
    this.gen = 0;
    this.onRendered = null; // (task, bitmap) => void
    this.editChain = Promise.resolve();
    this.activeRenderers = [];
    this.thumbQueue = [];   // page thumbnails: rendered only when the page view is idle
    this.onThumb = null;    // (task, bitmap) => void
    this.password = null;
    this.rendererCount = renderCount;
  }

  async ready() {
    await Promise.all([this.edit.ready, ...this.renderers.map((r) => r.ready)]);
  }

  setAuthor(name) {
    this.edit.call("setAuthor", { name });
  }

  // Opens a document everywhere. Resolves with page info from the edit worker.
  async open(url, password, sizeBytes) {
    this.gen++;
    this.queue = [];
    const gen = this.gen;
    const info = await this.edit.call("open", { url, password });
    if (info.needsPassword) return info;
    this.password = password || null;
    // Big files: fewer render workers so we don't multiply memory use.
    let n = this.renderers.length;
    if (sizeBytes > 150e6) n = 1;
    else if (sizeBytes > 60e6) n = Math.min(n, 2);
    this.rendererCount = n;
    this.activeRenderers = [];
    const opens = this.renderers.slice(0, n).map(async (r) => {
      r.docOpen = false;
      const ri = await r.call("open", { url, password });
      if (gen !== this.gen) return;
      if (!ri.needsPassword) {
        r.docOpen = true;
        this.activeRenderers.push(r);
        this._pump();
      }
    });
    for (const r of this.renderers.slice(n)) { r.docOpen = false; r.call("close"); }
    // Don't wait for every renderer; the first one is enough to start drawing.
    await Promise.race(opens);
    const pages = [];
    const b = info.bounds;
    for (let i = 0; i < info.pageCount; i++) {
      pages.push({ x0: b[i * 4], y0: b[i * 4 + 1], x1: b[i * 4 + 2], y1: b[i * 4 + 3], name: info.names ? info.names[i] : "" });
    }
    return { pages, needsPassword: false };
  }

  // ---- pages (see worker pageOp). Resolves with { pages, before } where
  // `before` is the document as it was (bytes), for undo.
  pageOp(op) { return this._edit(() => this.edit.call("pages", { op })).then((r) => this._structure(r)); }
  restore(bytes) { return this._edit(() => this.edit.call("restore", { bytes }, [bytes.buffer])).then((r) => this._structure(r)); }
  // An area of a page as a PNG ({ png, w, h }), markups included.
  snip(page, rect, res) { return this._edit(() => this.edit.call("snip", { page, rect, res })); }
  // Search (a chunk of pages at a time): { pages: [{ page, hits }], next }.
  find(needle, from) { return this.edit.call("search", { needle, from }); }
  // Markups on pages from..to-1 (after any edits still being made).
  markList(from, to) { return this._edit(() => this.edit.call("markList", { from, to })); }
  // The open document as it is now, markups included (bytes).
  snapshot() { return this._edit(() => this.edit.call("snapshot")); }
  countPagesOf(url, password) { return this.edit.call("countPagesOf", { url, password }); }
  // Merging reads other files only, so it isn't tied to the open document.
  merge(files) { return this.edit.call("merge", { files }); }

  // The page structure changed: renderers reopen the new bytes; queued and
  // in-flight tiles of the old document are dropped.
  _structure(r) {
    if (!r) return null;
    this.gen++;
    this.queue = [];
    this.thumbQueue = [];
    const gen = this.gen;
    this.activeRenderers = [];
    for (const rd of this.renderers.slice(0, this.rendererCount)) {
      rd.docOpen = false;
      const copy = r.bytes.slice();
      rd.call("open", { bytes: copy, password: this.password }, [copy.buffer]).then((ri) => {
        if (gen !== this.gen || ri.needsPassword) return;
        rd.docOpen = true;
        this.activeRenderers.push(rd);
        this._pump();
      }).catch((err) => console.warn("reopen failed", err));
    }
    const b = r.bounds, pages = [];
    for (let i = 0; i < r.pageCount; i++) pages.push({ x0: b[i * 4], y0: b[i * 4 + 1], x1: b[i * 4 + 2], y1: b[i * 4 + 3], name: r.names ? r.names[i] : "" });
    return { pages, before: r.before };
  }

  // Thumbnails: [{ key, page, res, bbox }], rendered after all page tiles.
  setThumbQueue(tasks) {
    this.thumbQueue = tasks.filter((t) => !this.inFlight.has(t.key));
    this._pump();
  }

  // Stop every worker (a second document closed for good).
  destroy() {
    this.gen++;
    this.queue = [];
    this.thumbQueue = [];
    this.activeRenderers = [];
    for (const w of [this.edit, ...this.renderers]) {
      try { w.worker.terminate(); } catch {}
      // Calls still waiting would never be answered: end them.
      for (const p of w.pending.values()) p.reject(new Error("closed"));
      w.pending.clear();
    }
  }

  close() {
    this.gen++;
    this.queue = [];
    this.thumbQueue = [];
    this.editChain = Promise.resolve();
    this.edit.call("close");
    for (const r of this.renderers) { r.docOpen = false; r.call("close"); }
    this.activeRenderers = [];
  }

  // tasks: [{ key, page, res, bbox, kind }] in priority order.
  setQueue(tasks) {
    this.queue = tasks.filter((t) => !this.inFlight.has(t.key));
    this._pump();
  }

  _pump() {
    for (const r of this.activeRenderers) {
      if (r.busy || !r.docOpen) continue;
      const task = this.queue.shift() || this.thumbQueue.shift();
      if (!task) return;
      r.busy = true;
      const gen = this.gen;
      this.inFlight.set(task.key, task);
      r.call(task.thumb ? "thumb" : "render", { page: task.page, res: task.res, bbox: task.bbox })
        .then((out) => {
          const cb = task.thumb ? this.onThumb : this.onRendered;
          if (gen === this.gen && cb) cb(task, out.bitmap);
          else out.bitmap.close();
        })
        .catch((err) => {
          if (gen === this.gen) console.warn("render failed", task.key, err);
        })
        .finally(() => {
          r.busy = false;
          this.inFlight.delete(task.key);
          this._pump();
        });
    }
  }

  get idle() {
    return this.queue.length === 0 && ![...this.inFlight.values()].some((t) => !t.thumb);
  }

  // ---- edit worker (serialized so annotation ops apply in order) ----
  _edit(fn) {
    const gen = this.gen;
    const p = this.editChain.then(() => (gen === this.gen ? fn() : null));
    this.editChain = p.catch(() => {});
    return p;
  }
  pageAnnots(page) { return this._edit(() => this.edit.call("pageAnnots", { page })); }
  // `target.id` is set inside the chain, before any later delete runs.
  // Shapes also come back with MuPDF's SVG of their appearance and final
  // bounds (text boxes are fitted to their text).
  addAnnot(page, data, target) {
    return this._edit(async () => {
      // `data` may be a function: evaluated in order, after earlier edits finished.
      const payload = typeof data === "function" ? data() : data;
      const r = await this.edit.call("addAnnot", { page, data: payload });
      const shape = r && typeof r === "object";
      const id = shape ? r.id : r;
      if (target) {
        target.id = id;
        if (shape) {
          target.svg = r.svg;
          target.bounds = r.bounds;
          if (r.rect) target.rect = r.rect;
        }
      }
      return r;
    });
  }
  // Change a shape in place (same annotation, so replies etc. stay attached).
  updateAnnot(page, getId, data, target) {
    return this._edit(async () => {
      const id = typeof getId === "function" ? getId() : getId;
      if (!id) return null;
      const payload = typeof data === "function" ? data() : data;
      const r = await this.edit.call("updateAnnot", { page, id, data: payload });
      if (target && r) {
        if (r.svg) target.svg = r.svg;
        if (r.bounds) target.bounds = r.bounds;
        if (r.rect) target.rect = r.rect;
      }
      return r;
    });
  }
  // Line of page text under a point: { text, bbox, origin, size, font } or null.
  lineAt(page, p) { return this._edit(() => this.edit.call("lineAt", { page, p })); }
  // The whole file with erase areas applied (and, with bake, every markup
  // embedded into the pages): { bytes, erased }. The open document is unchanged.
  exportCopy(bake = false) { return this._edit(() => this.edit.call("exportCopy", { bake })); }
  // Transparent PNG of a signature stamp (null if it no longer exists).
  annotImage(page, getId) {
    return this._edit(() => {
      const id = typeof getId === "function" ? getId() : getId;
      return id ? this.edit.call("annotImage", { page, id }) : null;
    });
  }
  deleteAnnot(page, getId) {
    return this._edit(() => {
      const id = typeof getId === "function" ? getId() : getId;
      return id ? this.edit.call("deleteAnnot", { page, id }) : false;
    });
  }
  textLines(page) { return this.edit.call("textLines", { page }); }
  highlight(page, p, q) { return this.edit.call("highlight", { page, p, q }); }
  selectText(page, p, q, mode = "chars") { return this.edit.call("selectText", { page, p, q, mode }); }
  save(mode = "incremental") { return this._edit(() => this.edit.call("save", { mode })); }
}
