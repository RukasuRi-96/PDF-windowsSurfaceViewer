// Automatic updates, from the public releases repository on GitHub
// (github.com/RukasuRi-96/PDF-windowsSurfaceViewerPublic; the source code stays private).
// It holds latest.json:
//   { version, electron, date, notes: [...],
//     app:   { url, sha256, size },    the app itself (app.asar, gzipped)
//     setup: { url, sha256, size } }   the full installer
// When the Electron runtime is the same, only the app (~5 MB) is fetched and
// swapped in once the app has closed; if a version needs a new runtime, the
// installer runs instead. Every download is checked against its SHA-256
// before it is used; nothing is changed until then.
const { app, net } = require("electron");
const path = require("path");
const ofs = require("original-fs"); // .asar files are plain files here
const crypto = require("crypto");
const zlib = require("zlib");
const { spawn } = require("child_process");

const FEED = process.env.EAGLES_UPDATE_URL || "https://raw.githubusercontent.com/RukasuRi-96/PDF-windowsSurfaceViewerPublic/main/latest.json";
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

let last = null;    // the last check
let staged = null;  // { version, kind, file } downloaded and verified
let onQuit = false; // install when the app closes

async function check() {
  const current = app.getVersion();
  if (!supported()) return { supported: false, current };
  const r = await net.fetch(FEED + (FEED.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error(`the update server answered ${r.status}`);
  const info = await r.json();
  const kind = info.electron && info.electron !== process.versions.electron ? "setup" : "app";
  const asset = info[kind];
  last = { info, kind, asset };
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
  const { info, kind, asset } = last;
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
    ofs.writeFileSync(file, zlib.gunzipSync(buf));
  } else {
    file = path.join(dir, `EaglesPDF-Setup-${info.version}.zip`);
    ofs.writeFileSync(file, buf);
  }
  staged = { version: String(info.version), kind, file };
  return { ok: true, version: staged.version, kind };
}

// PowerShell that finishes the update once this app (pid) has closed.
function helperScript({ kind, file, version, relaunch, pid, exe = process.execPath, resources = process.resourcesPath }) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const lines = [
    "# Eagles PDF viewer: finishes an update after the app has closed.",
    "$ErrorActionPreference = 'Continue'",
    `try { Wait-Process -Id ${pid | 0} -Timeout 90 -ErrorAction SilentlyContinue } catch {}`,
    "Start-Sleep -Milliseconds 400",
  ];
  if (kind === "app") {
    lines.push(
      `$src = ${q(file)}`,
      `$dst = ${q(path.win32.join(resources, "app.asar"))}`,
      "$tmp = $dst + '.new'",
      "$ok = $false",
      // Copy beside it, then swap: the old app stays if anything goes wrong.
      "for ($i = 0; $i -lt 40 -and -not $ok; $i++) {",
      "  try { Copy-Item -LiteralPath $src -Destination $tmp -Force -ErrorAction Stop; Move-Item -LiteralPath $tmp -Destination $dst -Force -ErrorAction Stop; $ok = $true }",
      "  catch { Start-Sleep -Milliseconds 500 }",
      "}",
      "if ($ok) {",
      `  Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EaglesPDF' -Name DisplayVersion -Value ${q(version)} -ErrorAction SilentlyContinue`,
      "  Remove-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue",
      "} else { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }",
    );
    if (relaunch) lines.push(`Start-Process -FilePath ${q(exe)}`);
  } else {
    lines.push(
      `$x = Join-Path ([IO.Path]::GetTempPath()) ${q("eaglespdf-setup-" + version)}`,
      "Remove-Item -LiteralPath $x -Recurse -Force -ErrorAction SilentlyContinue",
      `Expand-Archive -LiteralPath ${q(file)} -DestinationPath $x -Force`,
      // The installer shows its progress and opens the app when it's done.
      "& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $x 'files\\setup.ps1') -FromLauncher",
    );
  }
  return lines.join("\r\n") + "\r\n";
}

// Start the helper; the caller then quits the app.
function install(relaunch) {
  if (!staged) return { ok: false, error: "nothing has been downloaded" };
  if (!canInstall()) return { ok: false, error: "updates install in the installed Windows app" };
  const script = path.join(updateDir(), "apply.ps1");
  ofs.writeFileSync(script, helperScript({ ...staged, relaunch, pid: process.pid }));
  const hidden = staged.kind === "app";
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", ...(hidden ? ["-WindowStyle", "Hidden"] : []), "-File", script];
  spawn("powershell.exe", args, { detached: true, stdio: "ignore", windowsHide: hidden }).unref();
  staged = null;
  onQuit = false;
  return { ok: true };
}

const installOnQuit = () => { if (staged) onQuit = true; return { ok: !!staged }; };
// When the app closes with an update waiting (and "When I close the app" chosen).
function finishOnQuit() { if (onQuit && staged) install(false); }

module.exports = { isNewer, check, download, install, installOnQuit, finishOnQuit, helperScript, FEED };
