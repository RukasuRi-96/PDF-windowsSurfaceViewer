// The updater (electron/updater.js) without Electron: a stand-in `electron`
// module and a local server playing the repository's downloads/ folder.
// Checks version order; an app update taken out of the installer zip
// (download, SHA-256, files/app.asar byte for byte); the notes of every
// version since the installed one; a version that needs a new runtime (the
// installer itself); a tampered download refused; latest.json moving the
// feed elsewhere (remembered, with a fallback); the PowerShell that swaps
// the app in after it closes; and, as the installed Windows app (with a
// stand-in PowerShell), how the helper is started: the app closes only once
// the helper says it's running, a helper that never starts is reported (and
// the app stays open), and the next start says whether the update took.
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
let fakeCp = null; // a stand-in child_process for the "Windows" copy below
Module._load = function (req, ...a) {
  if (req === "electron") return fake;
  if (req === "original-fs") return fs;
  if (req === "child_process" && fakeCp) return fakeCp;
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
  console.log("installing outside the Windows app is refused:", JSON.stringify(await up.install(true)));

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
  const ps = up.helperScript({ kind: "app", file: "C:\\Users\\me\\AppData\\Roaming\\Eagles PDF viewer\\update\\app-1.10.2.asar", version: "1.10.2", relaunch: true, pid: 4242, exe: "C:\\Users\\me\\AppData\\Local\\Programs\\Eagles PDF viewer\\EaglesPDF.exe", resources: "C:\\Users\\me\\AppData\\Local\\Programs\\Eagles PDF viewer\\resources", log: "C:\\Users\\me\\AppData\\Roaming\\Eagles PDF viewer\\update.log", token: "abc123" });
  const at = (re) => ps.split("\r\n").findIndex((l) => re.test(l));
  const checks = {
    saysStartedFirst: at(/^Log 'started abc123: installing version 1\.10\.2'$/) >= 0 && at(/^Log 'started/) < at(/Wait-Process/),
    logs: ps.includes("$log = 'C:\\Users\\me\\AppData\\Roaming\\Eagles PDF viewer\\update.log'") && /Add-Content -LiteralPath \$log/.test(ps),
    waits: /Wait-Process -Id 4242 -Timeout 60/.test(ps),
    waitsForItsOtherProcesses: /Get-Process -Name \(\[IO\.Path\]::GetFileNameWithoutExtension\(\$exe\)\)/.test(ps) && /Where-Object \{ \$_\.Path -eq \$exe \}/.test(ps) && /Stop-Process -Force/.test(ps),
    copiesBeside: /\$tmp = \$dst \+ '\.new'/.test(ps) && /Copy-Item -LiteralPath \$src -Destination \$tmp -Force -ErrorAction Stop/.test(ps),
    swapsInOneStep: /\[IO\.File\]::Replace\(\$tmp, \$dst, \$bak, \$true\)/.test(ps),
    putsTheOldBackIfTheSwapFailed: /if \(-not \(Test-Path -LiteralPath \$dst\) -and \(Test-Path -LiteralPath \$bak\)\) \{ Move-Item -LiteralPath \$bak -Destination \$dst/.test(ps),
    logsWhyItFailed: /\$err = \$_\.Exception\.Message/.test(ps) && /Log \('could not replace the app: ' \+ \$err\)/.test(ps),
    target: ps.includes("$dst = 'C:\\Users\\me\\AppData\\Local\\Programs\\Eagles PDF viewer\\resources\\app.asar'"),
    version: /DisplayVersion -Value '1\.10\.2'/.test(ps),
    relaunches: at(/^Start-Process -FilePath \$exe -WorkingDirectory/) > at(/\[IO\.File\]::Replace/),
    crlf: ps.includes("\r\n"),
    braces: (ps.match(/\{/g) || []).length === (ps.match(/\}/g) || []).length && (ps.match(/\(/g) || []).length === (ps.match(/\)/g) || []).length,
  };
  const quoted = up.helperScript({ kind: "app", file: "C:\\it's\\a.asar", version: "1", relaunch: false, pid: 1, exe: "x", resources: "C:\\r", log: "C:\\l.log", token: "t" });
  const setupPs = up.helperScript({ kind: "setup", file: "C:\\u\\EaglesPDF-Setup-1.11.0.zip", version: "1.11.0", relaunch: true, pid: 9, exe: "x", resources: "y", log: "C:\\l.log", token: "t" });
  console.log("swap script:", JSON.stringify(checks), "· quotes escaped", quoted.includes("'C:\\it''s\\a.asar'"), "· no relaunch when closing", !/Start-Process/.test(quoted), "· new runtime runs the installer", /Expand-Archive/.test(setupPs) && /setup\.ps1/.test(setupPs) && /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/.test(setupPs));

  // How it's started: a PowerShell that runs Start-Process (so the helper
  // isn't tied to the app), the helper reading the script as text.
  const dec = (b64) => Buffer.from(b64, "base64").toString("utf16le");
  const la = up.launchArgs("C:\\Users\\O'Neil\\AppData\\Roaming\\Eagles PDF viewer\\update\\apply.ps1", true);
  const outer = dec(la[la.indexOf("-EncodedCommand") + 1]);
  const innerB64 = (outer.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/) || [])[1];
  const inner = innerB64 ? dec(innerB64) : "";
  const visible = dec(up.launchArgs("C:\\a.ps1", false).at(-1));
  console.log("start command:", JSON.stringify({
    startProcess: /^Start-Process -FilePath 'C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe' -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-EncodedCommand','/.test(outer),
    readsTheScriptAsText: inner === "iex ([IO.File]::ReadAllText('C:\\Users\\O''Neil\\AppData\\Roaming\\Eagles PDF viewer\\update\\apply.ps1'))",
    hiddenStarter: la.slice(0, 6).join(" ") === "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden",
    installerVisible: /-WindowStyle Normal -ArgumentList/.test(visible) && /'-WindowStyle','Normal'/.test(visible),
  }));

  // As the installed Windows app, with a stand-in PowerShell.
  const W = fs.mkdtempSync(path.join(os.tmpdir(), "eagles-win-"));
  const real = { platform: process.platform };
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  fake.app = { getVersion: () => "1.10.2", isPackaged: true, getPath: () => W };
  process.resourcesPath = path.join(W, "resources");
  let helperRuns = true, spawned = [];
  fakeCp = {
    spawn: (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      const kids = { on() { return kids; }, unref() {} };
      if (helperRuns) setTimeout(() => {
        // what the real helper does first: read apply.ps1 and log "started <token>"
        const o = dec(args.at(-1)), i = dec(o.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/)[1]);
        const file = i.match(/ReadAllText\('(.*)'\)\)$/)[1].replace(/''/g, "'");
        const text = fs.readFileSync(file, "utf8");
        const tok = text.match(/Log 'started (\w+):/)[1];
        const log = text.match(/^\$log = '(.*)'\r$/m)[1];
        fs.appendFileSync(log, "2026-01-01 00:00:00  started " + tok + ": installing\r\n");
      }, 400);
      return kids;
    },
  };
  for (const k of Object.keys(require.cache)) if (k.endsWith(path.join("electron", "updater.js"))) delete require.cache[k];
  const win = require("../electron/updater.js");
  Object.defineProperty(process, "platform", { value: real.platform, configurable: true });
  feed = { version: "1.11.0", electron: ELECTRON, notes: ["n"], setup };
  await win.check();
  await win.download();
  // the stand-in writes the log where the app looks for it
  const logPath = path.join(W, "update.log");
  const t0 = Date.now();
  let r = await win.install(true);
  const script = fs.readFileSync(path.join(W, "update", "apply.ps1"));
  const pending = JSON.parse(fs.readFileSync(path.join(W, "update-pending.json"), "utf8"));
  const sp = spawned[0];
  console.log("install (Windows): ok", r.ok, "· waited for the helper", Date.now() - t0 >= 350, "· not detached", !sp.opts.detached && sp.opts.windowsHide === true, "· Windows PowerShell", /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/.test(sp.cmd), "· script has a BOM", script[0] === 0xef && script[1] === 0xbb && script[2] === 0xbf, "· names the log", script.toString("utf8").includes(logPath.replace(/'/g, "''")), "· remembered as pending", pending.version === "1.11.0" && pending.from === "1.10.2" && /^[0-9a-f]{12}$/.test(pending.token));
  // next start, still the old version: reported, with the log since then
  fs.appendFileSync(logPath, "2026-01-01 00:00:05  could not replace the app: access denied\r\n");
  let s1 = win.startResult();
  const again = win.startResult();
  console.log("next start, not installed:", JSON.stringify({ failed: s1?.failed, current: s1?.current }), "· log lines from this attempt", s1?.log?.some((l) => l.includes("started " + pending.token)) && s1.log.some((l) => /access denied/.test(l)) && !s1.log.some((l) => /^$/.test(l)), "· reported once", again === null);
  // the helper never starts: an error, the app stays open, nothing pending
  helperRuns = false;
  await win.check(); await win.download();
  r = await win.install(true, { wait: 1200 });
  console.log("helper never starts:", JSON.stringify({ ok: r.ok, error: r.error, download: r.download }), "· nothing left pending", !fs.existsSync(path.join(W, "update-pending.json")));
  // "When I close the app" with no window to say it failed: kept for the next start
  win.installOnQuit();
  const wq = win.wantsInstallOnQuit();
  r = await win.finishOnQuit();
  const left = JSON.parse(fs.readFileSync(path.join(W, "update-pending.json"), "utf8"));
  s1 = win.startResult();
  console.log("on close, helper never starts:", "wanted", wq, "· failed", !r.ok, "· next start says so", s1?.failed === "1.11.0" && left.version === "1.11.0");
  // it took: the next start is the new version
  helperRuns = true;
  await win.check(); await win.download();
  r = await win.install(true);
  fake.app.getVersion = () => "1.11.0";
  s1 = win.startResult();
  console.log("next start, installed:", JSON.stringify(s1), "· staged files cleaned up", !fs.existsSync(path.join(W, "update")), "· the log is kept", fs.existsSync(logPath));
  fakeCp = null;
  fs.rmSync(W, { recursive: true, force: true });

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("no errors");
})().catch((e) => { console.error("FAIL", e); server.close(); process.exit(1); });
