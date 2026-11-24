// Prepares a release for the public releases repository
// (github.com/RukasuRi-96/PDF-windowsSurfaceViewerPublic), after `node tools/build-win.js x64`:
//
//   dist/release/
//     latest.json              what the app checks: version, notes, files and their SHA-256
//     EaglesPDF-Setup.zip      the installer (the download link)
//     app/<version>.asar.gz    the app alone, for automatic updates
//     README.md                the repository's front page
//
// usage: node tools/release.js [--keep <dir>]
//   --keep <dir>  a checkout of the releases repo: its app/ updates are kept
//                 (the last few), so people a version or two behind still
//                 update from files that exist.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const REPO = "RukasuRi-96/PDF-windowsSurfaceViewerPublic";
const RAW = `https://raw.githubusercontent.com/${REPO}/main/`;
const pkg = require(path.join(ROOT, "package.json"));
const electron = require(path.join(ROOT, "node_modules", "electron", "package.json")).version;
const DIST = path.join(ROOT, "dist");
const OUT = path.join(DIST, "release");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// The notes for a version: the "- " lines under its heading in CHANGELOG.md.
function notesFor(version) {
  const lines = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8").split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === "## " + version);
  if (at < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith("## ")) break;
    if (l.startsWith("- ")) out.push(l.slice(2).trim());
  }
  return out;
}

// The recent versions and their notes, newest first, so someone a few
// versions behind sees everything that changed since theirs.
function recentChanges(n = 10) {
  const lines = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8").split(/\r?\n/);
  return lines.filter((l) => /^## \d+\.\d+\.\d+\s*$/.test(l)).slice(0, n).map((l) => {
    const version = l.slice(3).trim();
    return { version, notes: notesFor(version) };
  });
}

const asar = path.join(DIST, "EaglesPDF-Setup", "files", "app.asar");
const setup = path.join(DIST, "EaglesPDF-Setup.zip");
for (const f of [asar, setup]) if (!fs.existsSync(f)) throw new Error("Build first (node tools/build-win.js x64): missing " + f);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "app"), { recursive: true });
const keepAt = process.argv.indexOf("--keep");
if (keepAt > 0) {
  // The last 3 app updates already published stay available.
  const old = path.join(process.argv[keepAt + 1], "app");
  if (fs.existsSync(old)) {
    const byVersion = (a, b) => b.split(".").map(Number).reduce((r, v, k) => r || v - (+a.split(".")[k] || 0), 0);
    const files = fs.readdirSync(old).filter((f) => /^\d+\.\d+\.\d+\.asar\.gz$/.test(f) && f !== `${pkg.version}.asar.gz`)
      .map((f) => f.replace(/\.asar\.gz$/, "")).sort(byVersion).slice(0, 3);
    for (const v of files) fs.copyFileSync(path.join(old, `${v}.asar.gz`), path.join(OUT, "app", `${v}.asar.gz`));
  }
}

const gz = zlib.gzipSync(fs.readFileSync(asar), { level: 9 });
const appName = `app/${pkg.version}.asar.gz`;
fs.writeFileSync(path.join(OUT, appName), gz);
const setupBytes = fs.readFileSync(setup);
fs.writeFileSync(path.join(OUT, "EaglesPDF-Setup.zip"), setupBytes);

const notes = notesFor(pkg.version);
const latest = {
  version: pkg.version,
  electron,
  date: new Date().toISOString().slice(0, 10),
  notes,
  changes: recentChanges(),
  app: { url: RAW + appName, sha256: sha(gz), size: gz.length },
  setup: { url: RAW + "EaglesPDF-Setup.zip", sha256: sha(setupBytes), size: setupBytes.length },
};
fs.writeFileSync(path.join(OUT, "latest.json"), JSON.stringify(latest, null, 2) + "\n");

const mb = (n) => (n / 1e6).toFixed(1) + " MB";
fs.writeFileSync(path.join(OUT, "README.md"), `# Eagles PDF viewer

A fast PDF reader and markup app for Windows tablets like the Surface Pro, for touch, pen and mouse.

## ⬇ [Download Eagles PDF viewer ${pkg.version} for Windows (EaglesPDF-Setup.zip, ${mb(setupBytes.length)})](https://github.com/${REPO}/raw/main/EaglesPDF-Setup.zip)

1. Right-click the downloaded **EaglesPDF-Setup.zip** › **Extract All…**
2. In the folder that opens, double-click **Install Eagles PDF viewer**. If Windows says "Windows protected your PC", click **More info** › **Run anyway** (the app isn't code-signed).
3. Setup fetches the app runtime from Electron's official GitHub releases, checks its fingerprint, and installs to your user profile. No admin rights needed.

After that, the app updates itself: it tells you when a new version is out (or use **⋯ › Check for updates**), downloads it, checks its fingerprint, and installs it when you restart or close the app. Windows 10 or 11, 64-bit.

## What's new in ${pkg.version}

${notes.map((n) => "- " + n).join("\n")}

---

This repository only holds the installer and the update files; the app checks \`latest.json\` here.
SHA-256 of EaglesPDF-Setup.zip: \`${latest.setup.sha256}\`
`);

console.log("Release", pkg.version, "in", OUT);
console.log("  latest.json, EaglesPDF-Setup.zip", mb(setupBytes.length) + ",", appName, mb(gz.length));
