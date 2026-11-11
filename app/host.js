// Host bridge. Inside the desktop app this is provided by electron/preload.js;
// in a plain browser (development/testing) it talks to tools/devserver.js.

function devHost() {
  const qs = new URLSearchParams(location.search);
  const json = (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
  const store = (k, v) => { try { localStorage.setItem("inkleaf:" + k, JSON.stringify(v)); } catch {} };
  const load = (k) => { try { return JSON.parse(localStorage.getItem("inkleaf:" + k)); } catch { return null; } };
  return {
    platform: "web",
    userName: "",
    async pickFolder() { return qs.get("folder") || prompt("Folder path"); },
    async pickFile() { return prompt("PDF path"); },
    async pickImages() { const p = qs.get("images") || prompt("Image path"); return p ? p.split("|") : []; },
    listImages: (dir) => fetch("/api/images?dir=" + encodeURIComponent(dir)).then(json),
    scanFolder: (dir) => fetch("/api/scan?dir=" + encodeURIComponent(dir)).then(json),
    fileUrl: (p) => "/api/file?p=" + encodeURIComponent(p) + "&t=" + Date.now(),
    stat: (p) => fetch("/api/stat?p=" + encodeURIComponent(p)).then(json),
    async writeFile(p, bytes) {
      return fetch("/api/write?p=" + encodeURIComponent(p), { method: "POST", body: bytes }).then(json);
    },
    async saveAs(p, bytes) {
      const target = prompt("Save as", p);
      if (!target) return null;
      const r = await this.writeFile(target, bytes);
      return r.ok ? target : null;
    },
    async readJson(name) { return load(name); },
    async writeJson(name, v) { store(name, v); },
    watchFolder() {},
    onFolderChanged() {},
    onOpenFile() {},
    onCloseRequest() {},
    confirmClose() {},
    showInFolder() {},
    toggleFullscreen() { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); },
    pathForFile() { return null; },
    setTitleBarTheme() {},
    initialFile: qs.get("file"),
  };
}

export const host = window.inkleaf || devHost();
