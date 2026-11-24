// Publishes a version for download and for automatic updates, after
// `node tools/build-win.js x64`. Everything goes in downloads/ of this
// (public) repository; commit and push, and installed apps find it:
//
//   downloads/EaglesPDF-Setup.zip                the installer (the download link)
//   downloads/updates/EaglesPDF-Setup-<v>.zip    the same file, under its version,
//                                                for updates (git stores it once)
//   downloads/latest.json                        what installed apps check
//
// The two newest versioned zips are kept, so an update that started just
// before a new release still finds its file.
//
// usage: node tools/release.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const REPO = "RukasuRi-96/PDF-windowsSurfaceViewer";
const RAW = `https://raw.githubusercontent.com/${REPO}/main/downloads/`;
const pkg = require(path.join(ROOT, "package.json"));
const electron = require(path.join(ROOT, "node_modules", "electron", "package.json")).version;
const DL = path.join(ROOT, "downloads");
const UPD = path.join(DL, "updates");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const byVersion = (a, b) => { const pa = a.split(".").map(Number), pb = b.split(".").map(Number); for (let k = 0; k < 3; k++) if (pa[k] !== pb[k]) return pb[k] - pa[k]; return 0; };

// The notes for a version: the "- " lines under its heading in CHANGELOG.md.
const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8").split(/\r?\n/);
function notesFor(version) {
  const at = changelog.findIndex((l) => l.trim() === "## " + version);
  if (at < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  const out = [];
  for (const l of changelog.slice(at + 1)) {
    if (l.startsWith("## ")) break;
    if (l.startsWith("- ")) out.push(l.slice(2).trim());
  }
  return out;
}
// The recent versions with their notes, newest first, so someone a few
// versions behind sees everything that changed since theirs.
const recentChanges = (n = 10) => changelog.filter((l) => /^## \d+\.\d+\.\d+\s*$/.test(l)).slice(0, n).map((l) => ({ version: l.slice(3).trim(), notes: notesFor(l.slice(3).trim()) }));

const setup = path.join(ROOT, "dist", "EaglesPDF-Setup.zip");
if (!fs.existsSync(setup)) throw new Error("Build first (node tools/build-win.js x64): missing " + setup);
const bytes = fs.readFileSync(setup);
const notes = notesFor(pkg.version);

fs.mkdirSync(UPD, { recursive: true });
fs.writeFileSync(path.join(DL, "EaglesPDF-Setup.zip"), bytes);
const name = `EaglesPDF-Setup-${pkg.version}.zip`;
fs.writeFileSync(path.join(UPD, name), bytes);
const kept = fs.readdirSync(UPD).filter((f) => /^EaglesPDF-Setup-\d+\.\d+\.\d+\.zip$/.test(f)).map((f) => f.slice(16, -4)).sort(byVersion);
for (const v of kept.slice(2)) fs.rmSync(path.join(UPD, `EaglesPDF-Setup-${v}.zip`));

const latest = {
  version: pkg.version,
  electron,
  date: new Date().toISOString().slice(0, 10),
  notes,
  changes: recentChanges(),
  setup: { url: RAW + "updates/" + name, sha256: sha(bytes), size: bytes.length },
};
fs.writeFileSync(path.join(DL, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
console.log(`Release ${pkg.version}: downloads/latest.json, downloads/EaglesPDF-Setup.zip and downloads/updates/${name} (${(bytes.length / 1e6).toFixed(1)} MB, sha256 ${latest.setup.sha256})`);
console.log("Kept for updates:", kept.slice(0, 2).join(", "));
