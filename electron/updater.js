// Automatic updates, from the app's public GitHub repository
// (github.com/RukasuRi-96/PDF-windowsSurfaceViewer, folder downloads/).
// downloads/latest.json says:
//   { version, electron, date, notes: [...], changes: [{ version, notes }],
//     setup: { url, sha256, size },   the installer zip (it holds the app)
//     feed?: url }                     where to look from now on, if it moves
// The installer zip is downloaded (~5 MB) and checked against its SHA-256.
// When the Electron runtime is the same, the app (files/app.asar) is taken
// out of it and swapped in once the app has closed; if a version needs a
// new runtime, the installer runs instead. Nothing changes before the check.
//
// The swap is done by a small PowerShell helper that outlives the app. It is
// started through a short-lived PowerShell (not "detached": Windows
// PowerShell started that way may not run at all), and the app only closes
// once the helper has written "started <token>" to update.log. Each step is
// logged there, and the next start reports whether the update took
// (startResult), so a failure is never silent.
const { app, net } = require("electron");
const path = require("path");
const ofs = require("original-fs"); // .asar files are plain files here
const crypto = require("crypto");
const zlib = require("zlib");
const { spawn } = require("child_process");

// Where to get the installer by hand, if an update can't install itself.
const DOWNLOAD_PAGE = "https://github.com/RukasuRi-96/PDF-windowsSurfaceViewer#install";
const DEFAULT_FEED = "https://raw.githubusercontent.com/RukasuRi-96/PDF-windowsSurfaceViewer/main/downloads/latest.json";
const FEED = process.env.EAGLES_UPDATE_URL || DEFAULT_FEED;
const isWin = process.platform === "win32";

// a > b, for versions like 1.9.10 and 1.10.0.
function isNewer(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0), pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
    if ((pa[k] || 0) !== (pb[k] || 0)) return (pa[k] || 0) > (pb[k] || 0);
  }
  return false;
}

// Updates install into the installed Windows app; the feed can be pointed
// elsewhere (EAGLES_UPDATE_URL) to try checking and downloading anywhere.
const canInstall = () => app.isPackaged && isWin;
const supported = () => canInstall() || !!process.env.EAGLES_UPDATE_URL;
const updateDir = () => path.join(app.getPath("userData"), "update");
// If latest.json ever names a new address ("feed"), it's kept here and used
// from then on (with the built-in one as a fallback).
const movedFile = () => path.join(app.getPath("userData"), "update-feed.json");
const logFile = () => path.join(app.getPath("userData"), "update.log");
const pendingFile = () => path.join(app.getPath("userData"), "update-pending.json");
const powershell = () => path.win32.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const encoded = (cmd) => Buffer.from(cmd, "utf16le").toString("base64");
const okUrl = (u) => typeof u === "string" && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(u);
function movedFeed() {
  try { const m = JSON.parse(ofs.readFileSync(movedFile(), "utf8")); return m.from === FEED && okUrl(m.feed) ? m.feed : null; } catch { return null; }
}

// One file out of a zip (stored or deflated; no zip64): the app inside the
// installer zip.
function fromZip(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("the update isn't a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10), csize = buf.readUInt32LE(at + 20), size = buf.readUInt32LE(at + 24);
    const nlen = buf.readUInt16LE(at + 28), elen = buf.readUInt16LE(at + 30), clen = buf.readUInt16LE(at + 32), local = buf.readUInt32LE(at + 42);
    const entry = buf.toString("utf8", at + 46, at + 46 + nlen).replace(/\\/g, "/");
    at += 46 + nlen + elen + clen;
    if (entry !== name) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) break;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    const out = method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data) : null;
    if (!out || out.length !== size) throw new Error("the update's zip couldn't be read");
    return out;
  }
  throw new Error(`the update has no ${name}`);
}

let last = null;    // the last check
let staged = null;  // { version, kind, file } downloaded and verified
let onQuit = false; // install when the app closes

async function fetchFeed(url) {
  const r = await net.fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error(`the update server answered ${r.status}`);
  return r.json();
}

async function check() {
  const current = app.getVersion();
  if (!supported()) return { supported: false, current };
  const moved = movedFeed();
  let info;
  try { info = await fetchFeed(moved || FEED); } catch (err) { if (!moved) throw err; info = await fetchFeed(FEED); }
  // The files have moved: look there from now on.
  if (okUrl(info.feed) && info.feed !== (moved || FEED)) {
    try { ofs.writeFileSync(movedFile(), JSON.stringify({ from: FEED, feed: info.feed })); } catch {}
  }
  const kind = info.electron && info.electron !== process.versions.electron ? "setup" : "app";
  // The installer zip holds the app too; older feeds had the app on its own.
  const asset = info.setup || (kind === "app" ? info.app : null);
  last = { info, kind, asset, zipped: !!info.setup };
  return {
    supported: true, current, latest: String(info.version || ""), newer: !!asset && isNewer(info.version, current),
    notes: Array.isArray(info.notes) ? info.notes.map(String) : [], date: info.date || "", kind, size: asset?.size || 0,
    // What changed in every version since this one (newest first).
    changes: Array.isArray(info.changes) ? info.changes.filter((c) => c && isNewer(c.version, current)).map((c) => ({ version: String(c.version), notes: (c.notes || []).map(String) })) : [],
    ready: staged?.version === info.version,
  };
}

async function download(onProgress) {
  if (!last) await check();
  const { info, kind, asset, zipped } = last;
  if (!asset || !isNewer(info.version, app.getVersion())) throw new Error("there is no newer version");
  if (staged?.version === info.version) return { ok: true, version: info.version, kind };
  const r = await net.fetch(asset.url, { cache: "no-store" });
  if (!r.ok) throw new Error(`the download answered ${r.status}`);
  const total = +r.headers.get("content-length") || asset.size || 0;
  const reader = r.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
    got += value.length;
    if (total) onProgress?.(Math.min(1, got / total));
  }
  const buf = Buffer.concat(parts);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  if (sha !== String(asset.sha256).toLowerCase()) throw new Error("the download didn't pass its safety check (SHA-256); please try again");
  const dir = updateDir();
  ofs.rmSync(dir, { recursive: true, force: true });
  ofs.mkdirSync(dir, { recursive: true });
  let file;
  if (kind === "app") {
    file = path.join(dir, `app-${info.version}.asar`);
    ofs.writeFileSync(file, zipped ? fromZip(buf, "files/app.asar") : zlib.gunzipSync(buf));
  } else {
    file = path.join(dir, `EaglesPDF-Setup-${info.version}.zip`);
    ofs.writeFileSync(file, buf);
  }
  staged = { version: String(info.version), kind, file };
  return { ok: true, version: staged.version, kind };
}

// PowerShell that finishes the update once this app (pid) has closed. Every
// step goes to the log; the first line ("started <token>") tells the app the
// helper is running, so it can close.
function helperScript({ kind, file, version, relaunch, pid, exe = process.execPath, resources = process.resourcesPath, log = logFile(), token = "" }) {
  const q = psq;
  const lines = [
    "# Eagles PDF viewer: finishes an update after the app has closed.",
    "$ErrorActionPreference = 'Continue'",
    `$log = ${q(log)}`,
    "function Log([string]$m) { try { Add-Content -LiteralPath $log -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + $m) -Encoding UTF8 -ErrorAction Stop } catch {} }",
    `Log ${q(`started ${token}: installing version ${version}`)}`,
    `$exe = ${q(exe)}`,
    `try { Wait-Process -Id ${pid | 0} -Timeout 60 -ErrorAction SilentlyContinue } catch {}`,
    // The app's other processes (graphics, pages) end with it. Wait for them;
    // any still there after 15 s are stopped, or the app can't be replaced.
    "$left = @()",
    "for ($i = 0; $i -lt 30; $i++) {",
    "  $left = @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($exe)) -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })",
    "  if ($left.Count -eq 0) { break }",
    "  Start-Sleep -Milliseconds 500",
    "}",
    "if ($left.Count -gt 0) { Log ('stopping ' + $left.Count + ' app process(es) still running'); $left | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800 }",
    "Log 'the app has closed'",
  ];
  if (kind === "app") {
    lines.push(
      `$src = ${q(file)}`,
      `$dst = ${q(path.win32.join(resources, "app.asar"))}`,
      "$tmp = $dst + '.new'",
      "$bak = $dst + '.old'",
      "Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue",
      "$ok = $false",
      "$err = ''",
      // Copy beside it, then swap in one step (the old one is kept until the
      // swap has worked), so a failure leaves the old app as it was.
      "for ($i = 0; $i -lt 40 -and -not $ok; $i++) {",
      "  try {",
      "    Copy-Item -LiteralPath $src -Destination $tmp -Force -ErrorAction Stop",
      "    if (Test-Path -LiteralPath $dst) { [IO.File]::Replace($tmp, $dst, $bak, $true) } else { Move-Item -LiteralPath $tmp -Destination $dst -Force -ErrorAction Stop }",
      "    $ok = $true",
      "  } catch { $err = $_.Exception.Message; Start-Sleep -Milliseconds 500 }",
      "}",
      "if ($ok) {",
      "  Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue",
      "  Remove-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue",
      `  Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EaglesPDF' -Name DisplayVersion -Value ${q(version)} -ErrorAction SilentlyContinue`,
      `  Log ${q(`installed version ${version}`)}`,
      "} else {",
      "  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue",
      // A failed swap can leave the old app under its backup name: put it back.
      "  if (-not (Test-Path -LiteralPath $dst) -and (Test-Path -LiteralPath $bak)) { Move-Item -LiteralPath $bak -Destination $dst -Force -ErrorAction SilentlyContinue }",
      "  Log ('could not replace the app: ' + $err)",
      "}",
    );
    if (relaunch) lines.push("Log 'opening the app'", "Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)");
  } else {
    lines.push(
      `$x = Join-Path ([IO.Path]::GetTempPath()) ${q("eaglespdf-setup-" + version)}`,
      "Remove-Item -LiteralPath $x -Recurse -Force -ErrorAction SilentlyContinue",
      "try {",
      `  Expand-Archive -LiteralPath ${q(file)} -DestinationPath $x -Force -ErrorAction Stop`,
      "  Log 'running the installer'",
      // The installer shows its progress and opens the app when it's done.
      `  & ${q(powershell())} -NoProfile -ExecutionPolicy Bypass -File (Join-Path $x 'files\\setup.ps1') -FromLauncher`,
      "  Log ('the installer finished (' + $LASTEXITCODE + ')')",
      "} catch { Log ('the installer could not run: ' + $_.Exception.Message) }",
    );
  }
  lines.push("Log 'done'");
  return lines.join("\r\n") + "\r\n";
}

// The command line that starts the helper. A short-lived PowerShell starts
// it with Start-Process, so it's not tied to this app and keeps running once
// the app closes. The script is read and run as text (no script-running
// policy applies, and any characters in folder names survive).
function launchArgs(script, hidden) {
  const style = hidden ? "Hidden" : "Normal";
  const inner = encoded(`iex ([IO.File]::ReadAllText(${psq(script)}))`);
  const outer = `Start-Process -FilePath ${psq(powershell())} -WindowStyle ${style} -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','${style}','-EncodedCommand','${inner}'`;
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded(outer)];
}

function appendLog(line) {
  try {
    const f = logFile();
    // keep it small
    if (ofs.existsSync(f) && ofs.statSync(f).size > 200000) ofs.writeFileSync(f, ofs.readFileSync(f, "utf8").slice(-40000));
    ofs.appendFileSync(f, new Date().toISOString().replace("T", " ").slice(0, 19) + "  " + line + "\r\n");
  } catch {}
}

// Start the helper and wait (up to `wait` ms) until it says it's running.
function startHelper(args, token, wait) {
  return new Promise((resolve) => {
    let done = false, timer = null;
    const finish = (r) => { if (done) return; done = true; clearInterval(timer); resolve(r); };
    let child;
    try { child = spawn(powershell(), args, { windowsHide: true, stdio: "ignore" }); } catch (err) { finish({ ok: false, error: "Windows PowerShell couldn't be started (" + err.message + ")" }); return; }
    child.on("error", (err) => finish({ ok: false, error: "Windows PowerShell couldn't be started (" + err.message + ")" }));
    const t0 = Date.now();
    timer = setInterval(() => {
      let txt = "";
      try { txt = ofs.readFileSync(logFile(), "utf8"); } catch {}
      if (txt.includes("started " + token)) finish({ ok: true });
      else if (Date.now() - t0 > wait) finish({ ok: false, error: "the update helper didn't start" });
    }, 150);
  });
}

// Start the helper; once it's running, the caller quits the app. `quiet`:
// nothing on screen can say it failed (the app is closing), so the next
// start reports it.
async function install(relaunch, { quiet = false, wait = 25000 } = {}) {
  if (!staged) return { ok: false, error: "nothing has been downloaded" };
  if (!canInstall()) return { ok: false, error: "updates install in the installed Windows app" };
  const token = crypto.randomBytes(6).toString("hex");
  const script = path.join(updateDir(), "apply.ps1");
  ofs.writeFileSync(script, "\ufeff" + helperScript({ ...staged, relaunch, pid: process.pid, token }));
  ofs.writeFileSync(pendingFile(), JSON.stringify({ version: staged.version, from: app.getVersion(), kind: staged.kind, token, at: Date.now() }));
  appendLog(`app ${app.getVersion()}: starting the helper ${token} for version ${staged.version}`);
  const r = await startHelper(launchArgs(script, staged.kind === "app"), token, wait);
  if (!r.ok) {
    appendLog(`app: ${r.error}`);
    if (!quiet) try { ofs.rmSync(pendingFile(), { force: true }); } catch {}
    return { ok: false, error: r.error, download: DOWNLOAD_PAGE };
  }
  staged = null;
  onQuit = false;
  return { ok: true };
}

const installOnQuit = () => { if (staged) onQuit = true; return { ok: !!staged }; };
// When the app closes with an update waiting (and "When I close the app" chosen).
const wantsInstallOnQuit = () => onQuit && !!staged;
const finishOnQuit = () => (wantsInstallOnQuit() ? install(false, { quiet: true }) : Promise.resolve({ ok: false }));

// At start: did an update that was being installed take? { updated, from }
// or { failed, current, log }, once; null when none was pending.
function startResult() {
  let p;
  try { p = JSON.parse(ofs.readFileSync(pendingFile(), "utf8")); } catch { return null; }
  try { ofs.rmSync(pendingFile(), { force: true }); } catch {}
  const now = app.getVersion();
  if (!isNewer(p.version, now)) {
    appendLog(`app ${now}: started after the update`);
    try { ofs.rmSync(updateDir(), { recursive: true, force: true }); } catch {}
    return { updated: String(now), from: String(p.from || "") };
  }
  appendLog(`app ${now}: started, but version ${p.version} wasn't installed`);
  let lines = [];
  try { lines = ofs.readFileSync(logFile(), "utf8").replace(/^\ufeff/, "").split(/\r?\n/).filter(Boolean); } catch {}
  const at = lines.findIndex((l) => p.token && l.includes(p.token));
  return { failed: String(p.version), current: now, log: (at >= 0 ? lines.slice(at) : lines).slice(-14) };
}

module.exports = { isNewer, check, download, install, installOnQuit, wantsInstallOnQuit, finishOnQuit, startResult, helperScript, launchArgs, fromZip, FEED, DEFAULT_FEED, DOWNLOAD_PAGE };
