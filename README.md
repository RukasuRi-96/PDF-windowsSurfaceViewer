# Inkleaf PDF

A fast PDF reader and markup app for Windows tablets like the Surface Pro, for touch, pen and mouse. It lists every PDF in a folder (including subfolders) down the left, lets you highlight, write and draw on them, copy text, and measure distances and areas on scaled drawings. Everything you add is saved into the PDF itself.

![Inkleaf PDF measuring a services layout drawing at 1:100](docs/screenshot.jpg)

**Current version: 1.1.0** · Windows 10 or 11, 64-bit

- [Install](#install)
- [Getting started](#getting-started)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Troubleshooting](#troubleshooting)
- [For developers](#for-developers)

## Install

You need Windows 10 or 11 on a 64-bit Intel or AMD PC, such as a Surface Pro 9 with an Intel Core i5 or i7. You also need an internet connection while setup runs, and you don't need administrator rights.

1. Download **`InkleafPDF-Setup.zip`** (about 5 MB) from the [Releases page](https://github.com/RukasuRi-96/PDF-windowsSurfaceViewer/releases/latest).
2. Right-click the zip and choose **Extract All…**, then **Extract**. Setup doesn't work from inside the zip.
3. Open the extracted folder and double-click **`Setup.cmd`**.
   - If Windows shows *"Windows protected your PC"*, click **More info**, then **Run anyway**. This appears because the app isn't code-signed.
4. A setup window opens and does three things:
   - it downloads the app's runtime (about 160 MB) from Electron's official GitHub releases;
   - it checks the download's SHA-256 fingerprint;
   - it installs everything to `%LOCALAPPDATA%\Programs\Inkleaf PDF`.

   This takes a minute or two. Inkleaf PDF then opens by itself, and it's on your **Start menu** and **Desktop**.

### Make it your default PDF app (optional)

Right-click any PDF in File Explorer and choose **Open with**, then **Choose another app**, then **Inkleaf PDF**, then **Always**.

### Update

Download the new `InkleafPDF-Setup.zip` and run its `Setup.cmd` the same way. Your settings, drawing scales and last-opened file are kept.

### Uninstall

Go to **Settings**, then **Apps**, then **Installed apps**. Click **⋯** next to **Inkleaf PDF** and choose **Uninstall**. Your PDFs are not touched.

### Other ways to install

- **No internet during setup, or GitHub is blocked on your network:** use **`InkleafPDF-win-x64.zip`** (about 150 MB) from the same release. It already contains the runtime. Extract it and double-click **`Install.cmd`**.
- **Surface Pro 9 with 5G (Microsoft SQ3, ARM):** the x64 version runs through Windows 11's built-in emulation. For full speed, build the ARM version (`node tools/build-win.js arm64`, see [Build the Windows app](#build-the-windows-app)) and install it with `Install.cmd`.

## Getting started

### 1. Open your PDFs

- Click **Open folder** and pick the folder where your PDFs live. You can also use **⋯ → Open folder…** or **Ctrl+O**.
  - Every PDF in that folder and all its subfolders appears in the list on the left.
  - The list updates by itself when files are added or removed.
- Type in **Filter PDFs** (**Ctrl+F**) to find a file by name.
- Click or tap a file to open it. **Alt+↓** and **Alt+↑** move to the next and previous PDF in the list.
- You can also drag a PDF or a folder onto the window, use **⋯ → Open file…**, or open PDFs from File Explorer once Inkleaf is your default app.
- Right-click a file in the list for **Show in folder** and **Copy path**.
- Drag the list's edge to resize it, or hide it with the button at the top left (**Ctrl+B**).
- Inkleaf remembers where you were in each file and reopens the last one when it starts.

### 2. Move around

| | Pan | Zoom | Other |
|---|---|---|---|
| **Finger** | Drag; flick to glide | Pinch | Double-tap to zoom in, or back to fit width |
| **Mouse** | Middle-button drag, with any tool | Ctrl+wheel; the zoom buttons; click the **%** for presets | The wheel scrolls (or zooms, see below) |
| **Keyboard** | Arrow keys, PgUp/PgDn, Space | Ctrl + / Ctrl − | Ctrl+0 fits width, Ctrl+9 fits page, Home/End jump to the first/last page |

To jump to a page, click the page number at the bottom of the screen.

**Mouse wheel: scroll or zoom.** Open the **⋯** menu (or the **%** zoom menu) and choose **Mouse wheel scrolls** or **Mouse wheel zooms**.
- In zoom mode, the wheel zooms around the pointer, and Shift+wheel scrolls.
- Ctrl+wheel and touchpad pinch always zoom.

### 3. The tools

The toolbar in the middle holds the tools:

| Tool | Key | What it does |
|---|---|---|
| **Select** | V | Select and copy text. Dragging on blank paper pans. |
| **Pan** | H | Drag to move around. |
| **Highlight** | M | Snaps to the text you sweep over. Where there's no text, it becomes a freehand marker. |
| **Pen** | P | Write or draw freehand. |
| **Box** | B | Draw a rectangle. |
| **Eraser** | E | Removes the ink, boxes, highlights and measurements you touch. |
| **Measure** | R | Distance, path length and area at the drawing's scale (see below). |

- **Colors and thickness:** tap the active tool again, or tap the colored dot next to the tools.
- **Pen and finger:** the pen uses the selected tool, and a finger always pans and zooms. To draw with a finger, turn on the **finger button** (**T**); you then pan and zoom with two fingers.
- **Erasing with the pen:** flip the Surface Pen over and use its eraser end, or hold its side button.
- **Palm rejection:** your palm is ignored while the pen is near the screen.
- **Undo and redo:** Ctrl+Z and Ctrl+Y, or the arrows in the toolbar.

### 4. Select and copy text

1. Choose **Select** (**V**).
2. Drag over the text you want. A selection can run across several pages, and it scrolls the page when you drag near the edge.
   - Double-click to select a word, or triple-click to select a line.
   - **Ctrl+A** selects all the text on the current page.
3. Press **Ctrl+C**, or click **Copy** on the small bar that appears under the selection.
   - Click **Highlight** on that bar instead to turn the selection into a highlight.

Click on blank paper or press **Esc** to clear the selection.

### 5. Measure drawings

1. **Choose Measure** (**R**). A measuring bar appears at the bottom of the page.
2. **Set the drawing's scale.** Click the scale button on the left of the measuring bar. It says *Scale not set* until you set one.
   - Pick the scale printed on the drawing:
     - metric: 1:1 to 1:5000;
     - imperial architectural: 1/16" = 1'-0" to 3" = 1'-0";
     - imperial engineering: 1" = 10' to 1" = 100';
     - or type a custom 1:N.
   - Choose the units for the results: mm, cm, m, km, inches, decimal feet, or feet-and-inches. Areas for mm, cm and m drawings are shown in m².
   - If a PDF has several sheets at different scales, the scale can apply to **all pages** or to **one page only**.
   - For a scanned drawing, or one whose scale you don't trust, click **Calibrate…**. Draw a line over a dimension you know, such as a grid spacing, and type its real length.
3. **Pick what to measure.** Tap the **Measure** tool again (or the colored dot) to choose **Distance**, **Path length** or **Area**, and to set the units, decimal places and color.
4. **Measure.**
   - **Distance:** drag from one end to the other, or click both ends.
   - **Path length:** click each point along the route. Double-click, press **Enter** or click **Done** to finish.
   - **Area:** click each corner. Click the first corner again to close the shape; you can also double-click, press **Enter** or click **Done**. You get the area and the perimeter.
   - The value updates live on the measuring bar as you move.
   - **Shift** keeps lines at 0°, 45° or 90°.
   - **Backspace** removes the last point, and **Esc** cancels.
   - **With a finger:** tap to place points, and drag to pan as usual.

Each measurement is saved into the PDF as a standard PDF measurement markup, with its value in the markup's note, so other PDF apps can show it. You can erase measurements and undo them like any other markup. If you change the scale after measuring, Inkleaf offers to recalculate the existing measurements, and one Ctrl+Z puts them back.

> A measurement is only as accurate as the scale. For drawings marked *NTS* (not to scale), or ones that may have been printed or scanned at a different size, calibrate against a known dimension first.

### 6. Save

- **Ctrl+S** (or the save button) writes your markups into the PDF as standard annotations. Acrobat, Edge, Bluebeam and other PDF apps show them too.
- **Ctrl+Shift+S** saves a copy under a new name.
- A blue dot next to the file name means there are unsaved changes. Inkleaf asks before you close or switch files with unsaved changes.
- If another program changed the file after you opened it, Inkleaf asks before overwriting those changes.

## Keyboard shortcuts

In the app, **⋯ → Keyboard & touch help** shows this list.

| Keys | Action |
|---|---|
| V · H · M · P · B · E · R | Select · Pan · Highlight · Pen · Box · Eraser · Measure |
| T | Finger draws on/off |
| Ctrl+S / Ctrl+Shift+S | Save / Save as |
| Ctrl+Z / Ctrl+Y | Undo / Redo |
| Ctrl+C / Ctrl+A | Copy selected text / Select all text on the page |
| Enter · Backspace · Esc | Finish · remove last point · cancel (while measuring) |
| Ctrl + / Ctrl − / Ctrl+0 / Ctrl+9 | Zoom in / out / fit width / fit page |
| PgUp / PgDn / Space | Scroll a screen |
| Home / End | First / last page |
| Alt+↑ / Alt+↓ | Previous / next PDF in the list |
| Ctrl+O · Ctrl+F · Ctrl+B | Open folder · filter files · show/hide the file list |
| F11 | Full screen |

## Troubleshooting

| Problem | What to do |
|---|---|
| *"Windows protected your PC"* when running Setup | Click **More info**, then **Run anyway**. The app isn't code-signed. |
| Setup says it couldn't download, or the safety check failed | Check your internet connection and run `Setup.cmd` again. If your network blocks github.com, use `InkleafPDF-win-x64.zip` and `Install.cmd` instead (see [Other ways to install](#other-ways-to-install)). |
| *"Couldn't save"* | The file may be open in another app, or in a read-only or locked folder. Use **Save as…** to save a copy somewhere else. |
| Measurements look wrong | Check the scale on the measuring bar. *Scale not set* means 1:1 (real paper size). Set the scale or calibrate. |
| A finger draws instead of panning | The finger button (**T**) is on. Tap it to turn it off. |
| The mouse wheel zooms when you want it to scroll (or the reverse) | **⋯ → Mouse wheel scrolls / Mouse wheel zooms** |

## For developers

### How it's built

Inkleaf is an [Electron](https://www.electronjs.org/) app that renders PDFs with [MuPDF](https://mupdf.com/) compiled to WebAssembly.

| Part | Role |
|---|---|
| `app/worker.js` | MuPDF (WebAssembly) engine. One *edit* worker owns annotations, text lookup, text selection and saving; 2–4 *render* workers rasterize 512px tiles in parallel. |
| `app/engine.js` | Worker pool and priority render queue. The viewer replaces the queue on every view change, so stale work gets dropped. |
| `app/viewer.js` | Continuous page layout. Pan and pinch run as GPU transforms, and the pages are re-tiled at the new resolution once a gesture settles. Annotations are live SVG vectors, so drawing never forces a page re-render. Also handles text selection and the measuring tool. |
| `app/measure.js` | Drawing scales, units, label formatting and polygon geometry for the measuring tool. |
| `app/sidebar.js` | Virtualized folder tree, so thousands of files stay instant. |
| `app/main.js` | Toolbar, dialogs, shortcuts, settings, scales, and the open/save flow. |
| `electron/` | Desktop shell: `app://` protocol, file IPC, clipboard, folder watcher, single instance, and Windows title bar. |
| `windows/` | Installer scripts (`Setup.cmd` + `setup.ps1` for the small package; `Install.cmd` for the full zip) and the readme that ships with them. |
| `tools/devserver.js` | Runs the same UI in a normal browser for testing. |

Measurements are saved as `Line`, `PolyLine` and `Polygon` annotations. Each one has a dimension intent (`LineDimension`, `PolyLineDimension` or `PolygonDimension`), a standard `/Measure` dictionary and an `InkleafMeasure` key that holds the scale.

### Run from source

You need [Node.js](https://nodejs.org/) 22.12 or later.

```bash
npm install
node node_modules/electron/install.js   # if Electron's binary wasn't downloaded
npm start                               # run the desktop app
npm run dev                             # or run the UI in a browser at http://localhost:5180/?folder=C:/path/to/pdfs
```

`npm install` copies the MuPDF WebAssembly build into `app/vendor/mupdf/` (see `tools/vendor-mupdf.js`). Run `node tools/vendor-mupdf.js` again after you update `mupdf`. To regenerate the icons, run `node tools/gen-icons.js` and `python3 tools/make-icon.py electron`.

### Build the Windows app

This works on Windows, macOS or Linux; it needs `zip` on the PATH.

```bash
npm run build:win               # x64
node tools/build-win.js arm64   # ARM (Surface Pro with Microsoft SQ chips)
```

The x64 build produces:

- `dist/InkleafPDF-Setup.zip`: the small installer (the app plus `Setup.cmd`; the runtime is downloaded and verified during setup).
- `dist/InkleafPDF-win-x64.zip`: the full app with the runtime included (`Install.cmd`).

The ARM build produces `dist/InkleafPDF-win-arm64.zip` only.

To publish a version, raise `version` in `package.json`, build, then create a [GitHub release](https://github.com/RukasuRi-96/PDF-windowsSurfaceViewer/releases/new) and attach `InkleafPDF-Setup.zip`. Attaching `InkleafPDF-win-x64.zip` too is optional. The [Install](#install) steps link to the latest release.

### Tests

End-to-end tests drive the real UI with Playwright, using real pointer, pen, touch and wheel input. They live in `tests/`; see [`tests/README.md`](tests/README.md).

```bash
tests/run.sh            # all browser tests
tests/run.sh measure    # one test
```

## Licenses

MuPDF is AGPL-3.0 (Artifex), and this source tree is the corresponding source for the build. Electron and Chromium are MIT/BSD, and the Lucide icons are ISC.
