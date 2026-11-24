// The updater (electron/updater.js) without Electron: a stand-in `electron`
// module and a local server playing the releases repository. Checks version
// order, an app-only update (download, SHA-256, unpacked app), a version that
// needs a new runtime (the installer), a tampered download being refused,
// and the PowerShell that swaps the app in after it closes.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const Module = require("module");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eagles-upd-"));
const ELECTRON = "44.9.3";
Object.defineProperty(process.versions, "electron", { value: ELECTRON, configurable: true });
const fake = {
  app: { getVersion: () => "1.10.0", isPackaged: false, getPath: () => TMP },
  net: { fetch: (u) => fetch(u) },
};
const load = Module._load;
Module._load = function (req, ...a) {
  if (req === "electron") return fake;
  if (req === "original-fs") return fs;
  return load.call(this, req, ...a);
};

const appBytes = crypto.randomBytes(300000);
const gz = zlib.gzipSync(appBytes);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let feed = {};
const server = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  if (u === "/latest.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(feed)); return; }
  if (u === "/app.asar.gz") { res.writeHead(200, { "content-length": gz.length }); res.end(gz); return; }
  if (u === "/setup.zip") { res.writeHead(200); res.end(Buffer.from("PK-fake-setup")); return; }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.EAGLES_UPDATE_URL = base + "/latest.json";
  const up = require("../electron/updater.js");

  console.log("version order:", [up.isNewer("1.10.0", "1.9.1"), !up.isNewer("1.9.1", "1.10.0"), up.isNewer("1.9.10", "1.9.2"), !up.isNewer("1.10.0", "1.10.0"), up.isNewer("2.0", "1.99.99")].every(Boolean));

  // nothing newer
  feed = { version: "1.10.0", electron: ELECTRON, notes: ["x"], app: { url: base + "/app.asar.gz", sha256: sha(gz), size: gz.length } };
  let c = await up.check();
  console.log("same version: newer", c.newer);

  // an app-only update
  feed = { version: "1.10.1", electron: ELECTRON, notes: ["Faster search", "A fix"], app: { url: base + "/app.asar.gz", sha256: sha(gz), size: gz.length }, setup: { url: base + "/setup.zip", sha256: sha(Buffer.from("PK-fake-setup")), size: 13 } };
  c = await up.check();
  const prog = [];
  const d = await up.download((p) => prog.push(p));
  const staged = path.join(TMP, "update", "app-1.10.1.asar");
  console.log("new version 1.10.1: newer", c.newer, "· kind", c.kind, "· notes", JSON.stringify(c.notes), "· downloaded", d.ok, "· progress reached", prog.at(-1), "· app unpacked and identical", fs.existsSync(staged) && fs.readFileSync(staged).equals(appBytes));
  console.log("installing outside the Windows app is refused:", JSON.stringify(up.install(true)));

  // a version that needs a new runtime: the installer instead
  feed = { ...feed, version: "1.11.0", electron: "45.0.0" };
  c = await up.check();
  const d2 = await up.download();
  console.log("new runtime: kind", c.kind, "· size", c.size, "· installer downloaded", d2.ok && fs.existsSync(path.join(TMP, "update", "EaglesPDF-Setup-1.11.0.zip")));

  // tampered: the fingerprint doesn't match
  feed = { version: "1.12.0", electron: ELECTRON, app: { url: base + "/app.asar.gz", sha256: "0".repeat(64), size: gz.length } };
  await up.check();
  let refused = "";
  try { await up.download(); } catch (err) { refused = err.message; }
  console.log("tampered download refused:", /safety check/.test(refused), "· nothing staged for it", !fs.existsSync(path.join(TMP, "update", "app-1.12.0.asar")));

  // the PowerShell that finishes an app update
  const ps = up.helperScript({ kind: "app", file: "C:\\Users\\me\\AppData\\Roaming\\Eagles PDF viewer\\update\\app-1.10.1.asar", version: "1.10.1", relaunch: true, pid: 4242, exe: "C:\\Users\\me\\AppData\\Local\\Programs\\Eagles PDF viewer\\EaglesPDF.exe", resources: "C:\\Users\\me\\AppData\\Local\\Programs\\Eagles PDF viewer\\resources" });
  const checks = {
    waits: /Wait-Process -Id 4242/.test(ps),
    copiesBeside: /\$tmp = \$dst \+ '\.new'/.test(ps) && /Copy-Item -LiteralPath \$src -Destination \$tmp/.test(ps),
    swaps: /Move-Item -LiteralPath \$tmp -Destination \$dst -Force/.test(ps),
    target: ps.includes("'C:\\Users\\me\\AppData\\Local\\Programs\\Eagles PDF viewer\\resources\\app.asar'"),
    version: /DisplayVersion -Value '1\.10\.1'/.test(ps),
    relaunches: /Start-Process -FilePath 'C:\\Users\\me\\AppData\\Local\\Programs\\Eagles PDF viewer\\EaglesPDF\.exe'/.test(ps),
    crlf: ps.includes("\r\n"),
  };
  const quoted = up.helperScript({ kind: "app", file: "C:\\it's\\a.asar", version: "1", relaunch: false, pid: 1, exe: "x", resources: "C:\\r" });
  const setupPs = up.helperScript({ kind: "setup", file: "C:\\u\\EaglesPDF-Setup-1.11.0.zip", version: "1.11.0", relaunch: true, pid: 9, exe: "x", resources: "y" });
  console.log("swap script:", JSON.stringify(checks), "· quotes escaped", quoted.includes("'C:\\it''s\\a.asar'"), "· no relaunch when closing", !/Start-Process/.test(quoted), "· new runtime runs the installer", /Expand-Archive/.test(setupPs) && /setup\.ps1/.test(setupPs));

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("no errors");
})().catch((e) => { console.error("FAIL", e); server.close(); process.exit(1); });
