// Exposes a small, explicit API to the UI (window.inkleaf). No Node access leaks through.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const init = ipcRenderer.sendSync("init-info");
const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld("inkleaf", {
  platform: init.platform,
  version: init.version,
  userName: init.userName,
  initialFile: init.file,
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  pickFile: () => ipcRenderer.invoke("pick-file"),
  pickImages: () => ipcRenderer.invoke("pick-images"),
  listImages: (dir) => ipcRenderer.invoke("list-images", dir),
  scanFolder: (dir) => ipcRenderer.invoke("scan-folder", dir),
  fileUrl: (p) => "app://inkleaf/@file?p=" + encodeURIComponent(p) + "&t=" + Date.now(),
  stat: (p) => ipcRenderer.invoke("stat", p),
  writeFile: (p, bytes) => ipcRenderer.invoke("write-file", p, bytes),
  saveAs: (p, bytes) => ipcRenderer.invoke("save-as", p, bytes),
  readJson: (name) => ipcRenderer.invoke("read-json", name),
  writeJson: (name, value) => ipcRenderer.invoke("write-json", name, value),
  watchFolder: (dir) => ipcRenderer.invoke("watch-folder", dir),
  onFolderChanged: on("folder-changed"),
  onOpenFile: on("open-file"),
  onCloseRequest: (cb) => {
    ipcRenderer.on("close-request", () => cb());
    ipcRenderer.send("close-handler");
  },
  confirmClose: () => ipcRenderer.send("close-ok"),
  showInFolder: (p) => ipcRenderer.invoke("show-in-folder", p),
  toggleFullscreen: () => ipcRenderer.invoke("toggle-fullscreen"),
  copyText: (text) => ipcRenderer.invoke("copy-text", text),
  findFont: (q) => ipcRenderer.invoke("find-font", q),
  checkUpdate: () => ipcRenderer.invoke("update-check"),
  downloadUpdate: () => ipcRenderer.invoke("update-download"),
  onUpdateProgress: on("update-progress"),
  installUpdate: (relaunch) => ipcRenderer.invoke("update-install", relaunch),
  installUpdateOnQuit: () => ipcRenderer.invoke("update-on-quit"),
  updateResult: () => ipcRenderer.invoke("update-result"),
  openDownloadPage: () => ipcRenderer.invoke("update-open-download"),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || null; } catch { return null; }
  },
});
