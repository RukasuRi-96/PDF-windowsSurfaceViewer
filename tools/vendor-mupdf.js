// Copies the MuPDF WebAssembly build from node_modules into app/vendor/mupdf/,
// where the UI loads it from. Runs automatically after `npm install`.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = path.join(ROOT, "node_modules", "mupdf");
const dst = path.join(ROOT, "app", "vendor", "mupdf");
if (!fs.existsSync(src)) {
  console.warn("vendor-mupdf: node_modules/mupdf not found; run npm install first");
  process.exit(0);
}
fs.mkdirSync(dst, { recursive: true });
for (const f of ["mupdf.js", "mupdf-wasm.js", "mupdf-wasm.wasm"]) {
  fs.copyFileSync(path.join(src, "dist", f), path.join(dst, f));
}
fs.copyFileSync(path.join(src, "LICENSE"), path.join(dst, "LICENSE"));
console.log("vendor-mupdf: copied MuPDF", require(path.join(src, "package.json")).version, "into app/vendor/mupdf");
