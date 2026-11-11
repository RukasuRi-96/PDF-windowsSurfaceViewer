// Development server: runs the UI in an ordinary browser for testing.
// usage: node tools/devserver.js [port]
const http = require("http");
const fs = require("fs");
const path = require("path");
const { scanFolder, writeFileSafe, stat, listImages } = require("../electron/fsops");
const { findFont } = require("../electron/fontindex");

const APP = path.join(__dirname, "..", "app");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const port = +process.argv[2] || 5180;

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
  try {
    if (url.pathname === "/api/scan") return send(200, JSON.stringify(await scanFolder(url.searchParams.get("dir"))));
    if (url.pathname === "/api/font") return send(200, JSON.stringify(await findFont(JSON.parse(url.searchParams.get("q") || "{}")).catch(() => null)));
    if (url.pathname === "/api/images") return send(200, JSON.stringify(await listImages(url.searchParams.get("dir"))));
    if (url.pathname === "/api/stat") return send(200, JSON.stringify(await stat(url.searchParams.get("p"))));
    if (url.pathname === "/api/file") {
      const p = url.searchParams.get("p");
      res.writeHead(200, { "content-type": "application/pdf", "cache-control": "no-store" });
      return fs.createReadStream(p).on("error", () => res.end()).pipe(res);
    }
    if (url.pathname === "/api/write" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return send(200, JSON.stringify(await writeFileSafe(url.searchParams.get("p"), Buffer.concat(chunks))));
    }
    let p = path.normalize(path.join(APP, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)));
    if (!p.startsWith(APP)) return send(403, "forbidden", "text/plain");
    const data = await fs.promises.readFile(p);
    send(200, data, MIME[path.extname(p)] || "application/octet-stream");
  } catch (err) {
    send(404, String(err.message), "text/plain");
  }
}).listen(port, () => console.log(`Inkleaf dev server on http://localhost:${port}`));
