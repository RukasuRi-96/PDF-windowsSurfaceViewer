// Builds the Windows app: dist/EaglesPDF-win-<arch>/ and a .zip of it.
// usage: node tools/build-win.js [x64|arm64]
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { packager } = require("@electron/packager");

const ROOT = path.join(__dirname, "..");
const arch = process.argv[2] || "x64";
const pkg = require(path.join(ROOT, "package.json"));
const electronVersion = require(path.join(ROOT, "node_modules", "electron", "package.json")).version;
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(DIST, "stage");

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function findCachedElectronZip(name) {
  const os = require("os");
  const roots = [process.env.electron_config_cache, path.join(os.homedir(), ".cache", "electron"), path.join(os.homedir(), "AppData", "Local", "electron", "Cache"), path.join(os.homedir(), "Library", "Caches", "electron")].filter(Boolean);
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    for (const d of fs.readdirSync(r)) {
      const p = path.join(r, d, name);
      if (fs.existsSync(p)) return p;
      if (d === name) return path.join(r, d);
    }
  }
  throw new Error("Electron zip not found in cache: " + name);
}

(async () => {
  // 1. Stage only what the app needs at runtime (no node_modules).
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  copyDir(path.join(ROOT, "app"), path.join(STAGE, "app"));
  copyDir(path.join(ROOT, "electron"), path.join(STAGE, "electron"));
  fs.writeFileSync(path.join(STAGE, "package.json"), JSON.stringify({
    name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, main: pkg.main,
  }, null, 2));

  // 2. Package with Electron for Windows.
  const [outDir] = await packager({
    dir: STAGE,
    out: DIST,
    platform: "win32",
    arch,
    electronVersion,
    name: "EaglesPDF",
    executableName: "EaglesPDF",
    appVersion: pkg.version,
    icon: path.join(ROOT, "electron", "icon.ico"),
    asar: true,
    overwrite: true,
    prune: false,
    appCopyright: "Eagles PDF viewer",
    win32metadata: {
      CompanyName: "Eagles",
      FileDescription: "Eagles PDF viewer",
      ProductName: "Eagles PDF viewer",
      InternalName: "EaglesPDF",
      OriginalFilename: "EaglesPDF.exe",
    },
  });

  // 3. Trim UI translations we don't use (Chromium falls back to en-US).
  const loc = path.join(outDir, "locales");
  for (const f of fs.readdirSync(loc)) if (!/^en-(US|GB)\.pak$/.test(f)) fs.rmSync(path.join(loc, f));

  // 4. Installer scripts + readme.
  for (const f of ["Install.cmd", "Uninstall.cmd", "README.txt"]) {
    const txt = fs.readFileSync(path.join(ROOT, "windows", f), "utf8").replace("__APP_VERSION__", pkg.version).replace(/\r?\n/g, "\r\n");
    fs.writeFileSync(path.join(outDir, f), txt);
  }

  const lic = path.join(outDir, "licenses");
  fs.mkdirSync(lic, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "node_modules", "mupdf", "LICENSE"), path.join(lic, "MuPDF-AGPL-3.0.txt"));
  fs.copyFileSync(path.join(ROOT, "node_modules", "lucide-static", "LICENSE"), path.join(lic, "Lucide-ISC.txt"));
  fs.copyFileSync(path.join(outDir, "LICENSE"), path.join(lic, "Electron-MIT.txt"));

  // 5. Zip.
  const folder = `EaglesPDF-win-${arch}`;
  const final = path.join(DIST, folder);
  fs.rmSync(final, { recursive: true, force: true });
  fs.renameSync(outDir, final);
  const zip = path.join(DIST, `${folder}.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync("zip", ["-q", "-r", "-9", zip, folder], { cwd: DIST });
  fs.rmSync(STAGE, { recursive: true, force: true });
  console.log("Built", zip, (fs.statSync(zip).size / 1e6).toFixed(1) + " MB");

  // 6. Small setup package: the app (app.asar) + a script that fetches the
  //    official Electron runtime from GitHub on the target PC and verifies it.
  //    Flat layout, so "Extract All" shows one thing to double-click:
  //      Install Eagles PDF viewer.cmd   README.txt   files\ (app.asar, setup.ps1, ...)
  if (arch === "x64") {
    const cacheZip = findCachedElectronZip(`electron-v${electronVersion}-win32-x64.zip`);
    const sha = require("crypto").createHash("sha256").update(fs.readFileSync(cacheZip)).digest("hex");
    const setupName = "EaglesPDF-Setup";
    const sdir = path.join(DIST, setupName);
    fs.rmSync(sdir, { recursive: true, force: true });
    const files = path.join(sdir, "files");
    fs.mkdirSync(files, { recursive: true });
    fs.copyFileSync(path.join(final, "resources", "app.asar"), path.join(files, "app.asar"));
    fs.copyFileSync(path.join(ROOT, "electron", "icon.ico"), path.join(files, "icon.ico"));
    copyDir(path.join(final, "licenses"), path.join(files, "licenses"));
    const place = { "Setup.cmd": "Install Eagles PDF viewer.cmd", "README.txt": "README.txt", "setup.ps1": "files/setup.ps1", "Uninstall.cmd": "files/Uninstall.cmd" };
    for (const [f, to] of Object.entries(place)) {
      let txt = fs.readFileSync(path.join(ROOT, "windows", f), "utf8");
      txt = txt.replace("__APP_VERSION__", pkg.version).replace("__ELECTRON_VERSION__", electronVersion).replace("__ELECTRON_SHA256__", sha);
      fs.writeFileSync(path.join(sdir, to), txt.replace(/\r?\n/g, "\r\n"));
    }
    const szip = path.join(DIST, `${setupName}.zip`);
    fs.rmSync(szip, { force: true });
    execFileSync("zip", ["-q", "-r", "-9", szip, "."], { cwd: sdir });
    console.log("Built", szip, (fs.statSync(szip).size / 1e6).toFixed(1) + " MB", "(electron sha256 " + sha + ")");
  }
})().catch((e) => { console.error(e); process.exit(1); });
