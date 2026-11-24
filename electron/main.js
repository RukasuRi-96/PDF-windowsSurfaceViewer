// Eagles PDF viewer — Electron main process.
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, nativeTheme, Menu, screen, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Readable } = require("stream");
const { scanFolder, writeFileSafe, stat, listImages } = require("./fsops");
const { findFont } = require("./fontindex");
const updater = require("./updater");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

const APP_DIR = path.join(__dirname, "..", "app");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
};
const isWin = process.platform === "win32";

if (process.env.INKLEAF_USER_DATA) app.setPath("userData", process.env.INKLEAF_USER_DATA);
else migrateSettings();

// Until 1.4 the app was called "Inkleaf PDF": the first time the new name
// starts, bring over its settings, signatures and shortcuts.
function migrateSettings() {
  try {
    const now = app.getPath("userData");
    const old = path.join(app.getPath("appData"), "Inkleaf PDF");
    if (fs.existsSync(path.join(now, "config.json")) || !fs.existsSync(old)) return;
    fs.mkdirSync(now, { recursive: true });
    for (const f of fs.readdirSync(old)) if (/\.json$/i.test(f)) fs.copyFileSync(path.join(old, f), path.join(now, f));
  } catch {}
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let allowClose = false;
let closeHandlerReady = false;
let watcher = null;
let initialFile = fileFromArgv(process.argv);

function fileFromArgv(argv) {
  for (const a of argv.slice(1)) {
    if (/\.pdf$/i.test(a)) {
      try { if (fs.statSync(a).isFile()) return path.resolve(a); } catch {}
    }
  }
  return null;
}

// ---------------------------------------------------------------- settings files
const dataDir = () => app.getPath("userData");
const jsonPath = (name) => path.join(dataDir(), String(name).replace(/[^a-z0-9_-]/gi, "") + ".json");
function readJsonSync(name) {
  try { return JSON.parse(fs.readFileSync(jsonPath(name), "utf8")); } catch { return null; }
}
async function writeJson(name, value) {
  await fs.promises.mkdir(dataDir(), { recursive: true });
  return writeFileSafe(jsonPath(name), JSON.stringify(value));
}

// ---------------------------------------------------------------- window
function overlayColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? "#23252a" : "#ffffff", symbolColor: dark ? "#e9eaed" : "#1c1e22", height: 48 };
}

function visibleBounds(b) {
  if (!b || b.x == null) return null;
  const area = screen.getDisplayMatching(b).workArea;
  const overlaps = b.x < area.x + area.width - 80 && b.x + b.width > area.x + 80 && b.y < area.y + area.height - 60 && b.y >= area.y - 10;
  return overlaps ? b : null;
}

function createWindow() {
  const saved = readJsonSync("window") || {};
  const b = visibleBounds(saved.bounds);
  win = new BrowserWindow({
    width: b?.width || 1280,
    height: b?.height || 860,
    x: b?.x,
    y: b?.y,
    minWidth: 420,
    minHeight: 360,
    show: false,
    title: "Eagles PDF viewer",
    icon: path.join(__dirname, isWin ? "icon.ico" : "icon.png"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1c20" : "#f4f5f7",
    ...(isWin ? { titleBarStyle: "hidden", titleBarOverlay: overlayColors() } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (saved.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.key === "F12") win.webContents.toggleDevTools();
  });
  win.webContents.on("render-process-gone", () => { allowClose = true; });
  win.on("close", (e) => {
    if (!allowClose && closeHandlerReady) {
      e.preventDefault();
      win.webContents.send("close-request");
      return;
    }
    try {
      fs.mkdirSync(dataDir(), { recursive: true });
      fs.writeFileSync(jsonPath("window"), JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }));
    } catch {}
  });
  win.on("closed", () => { win = null; });
  win.loadURL("app://inkleaf/index.html");
}

nativeTheme.on("updated", () => {
  if (!win) return;
  if (isWin) { try { win.setTitleBarOverlay(overlayColors()); } catch {} }
  win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#1b1c20" : "#f4f5f7");
});

app.on("second-instance", (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const f = fileFromArgv(argv);
  if (f) win.webContents.send("open-file", f);
});

// ---------------------------------------------------------------- IPC
ipcMain.on("init-info", (e) => {
  e.returnValue = { platform: process.platform, userName: safeUser(), file: initialFile, version: app.getVersion() };
  initialFile = null;
});
ipcMain.on("close-handler", () => { closeHandlerReady = true; });
ipcMain.on("close-ok", () => {
  allowClose = true;
  win?.close();
});

function safeUser() {
  try { return os.userInfo().username || ""; } catch { return ""; }
}

ipcMain.handle("pick-folder", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Choose a folder of PDFs", properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("pick-file", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Open PDF", properties: ["openFile"], filters: [{ name: "PDF", extensions: ["pdf"] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("pick-images", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Choose a signature image",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp"] }],
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle("list-images", (_e, dir) => listImages(dir));
ipcMain.handle("scan-folder", (_e, dir) => scanFolder(dir));
ipcMain.handle("stat", (_e, p) => stat(p));
ipcMain.handle("write-file", (_e, p, bytes) => writeFileSafe(p, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
ipcMain.handle("save-as", async (_e, p, bytes) => {
  const r = await dialog.showSaveDialog(win, { title: "Save PDF as", defaultPath: p, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (r.canceled || !r.filePath) return null;
  const out = await writeFileSafe(r.filePath, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (!out.ok) throw new Error(out.error);
  return r.filePath;
});
ipcMain.handle("read-json", (_e, name) => readJsonSync(name));
ipcMain.handle("find-font", (_e, q) => findFont(q || {}).catch(() => null));
ipcMain.handle("write-json", (_e, name, value) => writeJson(name, value));
ipcMain.handle("show-in-folder", (_e, p) => { if (p) shell.showItemInFolder(p); });
ipcMain.handle("toggle-fullscreen", () => { if (win) win.setFullScreen(!win.isFullScreen()); });
ipcMain.handle("copy-text", (_e, text) => { clipboard.writeText(String(text ?? "")); return true; });
// Updates (see updater.js). Errors come back as { error } for the UI to show.
const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (err) { return { ok: false, error: err.message || String(err) }; } };
ipcMain.handle("update-check", safe(() => updater.check()));
ipcMain.handle("update-download", safe((e) => updater.download((p) => { try { e.sender.send("update-progress", p); } catch {} })));
ipcMain.handle("update-install", safe(async (_e, relaunch) => {
  // Closes only once the helper that installs it is running.
  const r = await updater.install(!!relaunch);
  // The UI has already saved or asked about unsaved changes.
  if (r.ok) { allowClose = true; setTimeout(() => app.quit(), 50); }
  return r;
}));
ipcMain.handle("update-on-quit", safe(() => updater.installOnQuit()));
// Whether an update installed since the last run (asked once, at start).
let updateResult;
ipcMain.handle("update-result", () => { if (updateResult === undefined) { try { updateResult = updater.startResult(); } catch { updateResult = null; } return updateResult; } return null; });
ipcMain.handle("update-open-download", () => shell.openExternal(updater.DOWNLOAD_PAGE));
ipcMain.handle("watch-folder", (_e, dir) => {
  try { watcher?.close(); } catch {}
  watcher = null;
  let timer = 0;
  try {
    watcher = fs.watch(dir, { recursive: true }, (_type, name) => {
      if (name && path.extname(name) && !/\.pdf$/i.test(name)) return; // ignore non-PDF files
      if (name && /\.inkleaf-.*\.tmp$/i.test(name)) return;
      clearTimeout(timer);
      timer = setTimeout(() => win?.webContents.send("folder-changed"), 900);
    });
    watcher.on("error", () => {});
  } catch {}
  return true;
});

// ---------------------------------------------------------------- app
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle("app", async (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/@file") {
      const p = u.searchParams.get("p");
      try {
        const s = await fs.promises.stat(p);
        const body = Readable.toWeb(fs.createReadStream(p));
        return new Response(body, { headers: { "content-type": "application/pdf", "content-length": String(s.size) } });
      } catch {
        return new Response("not found", { status: 404 });
      }
    }
    const full = path.normalize(path.join(APP_DIR, decodeURIComponent(u.pathname)));
    if (!full.startsWith(APP_DIR)) return new Response("forbidden", { status: 403 });
    try {
      const data = await fs.promises.readFile(full);
      return new Response(data, { headers: { "content-type": MIME[path.extname(full)] || "application/octet-stream" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
  createWindow();
});

app.on("window-all-closed", () => app.quit());
// An update chosen for "when I close the app": start its helper first.
let installingOnQuit = false;
app.on("will-quit", (e) => {
  if (installingOnQuit || !updater.wantsInstallOnQuit()) return;
  installingOnQuit = true;
  e.preventDefault();
  updater.finishOnQuit().catch(() => {}).finally(() => app.exit(0));
});
