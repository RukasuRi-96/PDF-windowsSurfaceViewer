// The updater (electron/updater.js) without Electron: a stand-in `electron`
// module and a local server playing the repository's downloads/ folder.
// Checks version order; an app update taken out of the installer zip
// (download, SHA-256, files/app.asar byte for byte); the notes of every
// version since the installed one; a version that needs a new runtime (the
// installer itself); a tampered download refused; latest.json moving the
// feed elsewhere (remembered, with a fallback); and the PowerShell that swaps
// the app in after it closes.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const Module = require("module");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eagles-upd-"));
const ELECTRON = "44.9.3";
Object.defineProperty(process.versions, "electron", { value: ELECTRON, configurable: true });
const fake = {
  app: { getVersion: () => "1.10.1", isPackaged: false, getPath: () => TMP },
  net: { fetch: (u) => fetch(u) },
};
const load = Module._load;
Module._load = function (req, ...a) {
  if (req === "electron") return fake;
  if (req === "original-fs") return fs;
  return load.call(this, req, ...a);
};

// An installer zip like the real one: files/app.asar inside.
const appBytes = crypto.randomBytes(400000);
const ZD = path.join(TMP, "zipsrc");
fs.mkdirSync(path.join(ZD, "files"), { recursive: true });
fs.writeFileSync(path.join(ZD, "files", "app.asar"), appBytes);
fs.writeFileSync(path.join(ZD, "README.txt"), "readme");
execFileSync("zip", ["-q", "-r", "-9", path.join(TMP, "setup.zip"), "."], { cwd: ZD });
const zipBytes = fs.readFileSync(path.join(TMP, "setup.zip"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let feed = {}, moved = null, hits = { main: 0, moved: 0 };
const server = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  if (u === "/downloads/latest.json") { hits.main++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(feed)); return; }
  if (u === "/elsewhere/latest.json") { hits.moved++; if (!moved) { res.writeHead(404); res.end(); return; } res.writeHead(200); res.end(JSON.stringify(moved)); return; }
  if (u === "/downloads/updates/setup.zip") { res.writeHead(200, { "content-length": zipBytes.length }); res.end(zipBytes); return; }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.EAGLES_UPDATE_URL = base + "/downloads/latest.json";
  const up = require("../electron/updater.js");
  console.log("version order:", [up.isNewer("1.10.0", "1.9.1"), !up.isNewer("1.9.1", "1.10.0"), up.isNewer("1.9.10", "1.9.2"), !up.isNewer("1.10.0", "1.10.0"), up.isNewer("2.0", "1.99.99")].every(Boolean));
  console.log("the built-in feed is the app's own repository:", up.DEFAULT_FEED);
  console.log("zip reader: files/app.asar out of the installer zip", up.fromZip(zipBytes, "files/app.asar").equals(appBytes), "· a missing file is reported", (() => { try { up.fromZip(zipBytes, "nope"); return false; } catch (e) { return /no nope/.test(e.message); } })());

  const setup = { url: base + "/downloads/updates/setup.zip", sha256: sha(zipBytes), size: zipBytes.length };
  feed = { version: "1.10.1", electron: ELECTRON, notes: ["x"], setup };
  let c = await up.check();
  console.log("same version: newer", c.newer);

  // an app update, taken out of the installer zip
  feed = { version: "1.10.2", electron: ELECTRON, notes: ["Faster search", "A fix"], changes: [{ version: "1.10.2", notes: ["Faster search", "A fix"] }, { version: "1.10.1", notes: ["Moved"] }, { version: "1.10.0", notes: ["Updates"] }], setup };
  c = await up.check();
  const prog = [];
  const d = await up.download((p) => prog.push(p));
  const staged = path.join(TMP, "update", "app-1.10.2.asar");
  console.log("new version 1.10.2: newer", c.newer, "· kind", c.kind, "· size", c.size === zipBytes.length, "· changes since 1.10.1 only", JSON.stringify(c.changes.map((x) => x.version)), "· downloaded", d.ok, "· progress reached", prog.at(-1), "· the app inside, byte for byte", fs.existsSync(staged) && fs.readFileSync(staged).equals(appBytes));
  console.log("installing outside the Windows app is refused:", JSON.stringify(up.install(true)));

  // a version that needs a new runtime: the installer itself
  feed = { ...feed, version: "1.11.0", electron: "45.0.0" };
  c = await up.check();
  const d2 = await up.download();
  const setupStaged = path.join(TMP, "update", "EaglesPDF-Setup-1.11.0.zip");
  console.log("new runtime: kind", c.kind, "· installer downloaded as is", d2.ok && fs.existsSync(setupStaged) && fs.readFileSync(setupStaged).equals(zipBytes));

  // tampered: the fingerprint doesn't match
  feed = { version: "1.12.0", electron: ELECTRON, setup: { ...setup, sha256: "0".repeat(64) } };
  await up.check();
  let refused = "";
  try { await up.download(); } catch (err) { refused = err.message; }
  console.log("tampered download refused:", /safety check/.test(refused), "· nothing staged for it", !fs.existsSync(path.join(TMP, "update", "app-1.12.0.asar")));

  // latest.json says the files moved: remembered and used from then on,
  // with the original address as a fallback while the new one isn't there
  feed = { version: "1.13.0", electron: ELECTRON, setup, feed: base + "/elsewhere/latest.json" };
  await up.check();
  const remembered = JSON.parse(fs.readFileSync(path.join(TMP, "update-feed.json"), "utf8")).feed === base + "/elsewhere/latest.json";
  hits = { main: 0, moved: 0 };
  c = await up.check(); // the new address isn't there yet (404): falls back
  const fellBack = hits.moved === 1 && hits.main === 1 && c.latest === "1.13.0";
  moved = { version: "1.14.0", electron: ELECTRON, setup };
  hits = { main: 0, moved: 0 };
  c = await up.check();
  console.log("feed moved: remembered", remembered, "· falls back while the new one is missing", fellBack, "· then reads only the new address", hits.moved === 1 && hits.main === 0 && c.latest === "1.14.0");

  // the PowerShell that finishes an app update
  const ps = up.helperScript({ kind: "app", file: "C:\\Users\\me\\AppData\\Roaming\\Eagles PDF viewer\\update\\app-1.10.2.asar", version: "1.10.2", relaunch: true, pid: 4242, exe: "C:\\Users\\me\\AppData\\Local\\Programs\\Eagles PDF viewer\\EaglesPDF.exe", resources: "C:\\Users\\me\\AppData\\Local\\Programs\\Eagles PDF viewer\\resources" });
  const checks = {
    waits: /Wait-Process -Id 4242/.test(ps),
    copiesBeside: /\$tmp = \$dst \+ '\.new'/.test(ps) && /Copy-Item -LiteralPath \$src -Destination \$tmp/.test(ps),
    swaps: /Move-Item -LiteralPath \$tmp -Destination \$dst -Force/.test(ps),
    target: ps.includes("'C:\\Users\\me\\AppData\\Local\\Programs\\Eagles PDF viewer\\resources\\app.asar'"),
    version: /DisplayVersion -Value '1\.10\.2'/.test(ps),
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
