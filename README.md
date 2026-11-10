# Inkleaf PDF

A fast touch-and-pen PDF reader and annotator for Windows tablets like the Surface Pro.

- **Folder sidebar**: every PDF under a folder, including subfolders. It has a filter box and refreshes itself when files change.
- **Touch**: drag to pan with momentum, pinch to zoom around your fingers, double-tap to zoom.
- **Pen**: highlight (snaps to text, or works as a freehand marker where there's no text), box, pen ink, and eraser (the pen's eraser end or side button also erases). Palm rejection is built in.
- **Save**: Ctrl+S writes standard PDF annotations into the file with an incremental save, so Acrobat, Edge, Bluebeam and other apps show them.

## How it's built

| Part | Role |
|---|---|
| `app/worker.js` | MuPDF (WebAssembly) engine. One *edit* worker owns annotations, text lookup and saving; 2–4 *render* workers rasterize 512px tiles in parallel. |
| `app/engine.js` | Worker pool and priority render queue. The viewer replaces the queue on every view change, so stale work gets dropped. |
| `app/viewer.js` | Continuous page layout. Pan and pinch run as GPU transforms, and the pages are re-tiled at the new resolution once a gesture settles. Annotations are live SVG vectors, so drawing never forces a page re-render. |
| `app/sidebar.js` | Virtualized folder tree, so thousands of files stay instant. |
| `app/main.js` | Toolbar, dialogs, shortcuts, settings, and the open/save flow. |
| `electron/` | Desktop shell: `app://` protocol, file IPC, folder watcher, single instance, and Windows title bar. |
| `tools/devserver.js` | Runs the same UI in a normal browser for testing. |

## Develop

```bash
npm install
node node_modules/electron/install.js   # if Electron's binary wasn't downloaded
npm start                               # run the desktop app
npm run dev                             # or run the UI in a browser at http://localhost:5180/?folder=C:/path/to/pdfs
```

## Build the Windows app

```bash
npm run build:win            # x64  -> dist/InkleafPDF-win-x64.zip
node tools/build-win.js arm64   # Surface Pro (ARM / SQ3) -> dist/InkleafPDF-win-arm64.zip
```

`npm install` copies the MuPDF WebAssembly build into `app/vendor/mupdf/` (see `tools/vendor-mupdf.js`); run `node tools/vendor-mupdf.js` again after you update `mupdf`. To regenerate the icons, run `node tools/gen-icons.js` and `python3 tools/make-icon.py electron`.

## Licenses

MuPDF is AGPL-3.0 (Artifex). This source tree is the corresponding source for the build. Electron/Chromium are MIT/BSD, and the Lucide icons are ISC.
