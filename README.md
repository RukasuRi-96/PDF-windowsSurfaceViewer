# Inkleaf PDF

A fast PDF reader and markup app for Windows tablets like the Surface Pro, for touch, pen and mouse. It lists every PDF in a folder (including subfolders) down the left, lets you highlight, write and draw on them, add boxes, arrows, clouds, callouts and text, sign them, copy text, and measure distances and areas on scaled drawings. You can also erase parts of a page or retype a line of its text, and embed your markups so they can no longer be moved. Everything you add is saved into the PDF itself.

![Inkleaf PDF measuring a services layout drawing at 1:100](docs/screenshot.jpg)

**Current version: 1.4.1** · Windows 10 or 11, 64-bit

- [Install](#install)
- [Getting started](#getting-started)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Troubleshooting](#troubleshooting)
- [For developers](#for-developers)

## Install

You need Windows 10 or 11 on a 64-bit Intel or AMD PC, such as a Surface Pro 9 with an Intel Core i5 or i7. You also need an internet connection while setup runs, and you don't need administrator rights.

1. Download **`InkleafPDF-Setup.zip`** (about 5 MB) from the [`downloads` folder](downloads/InkleafPDF-Setup.zip): open it and click the **Download raw file** button (↓) at the top right. Don't use the green **Code → Download ZIP** button; that gives you the source code, not the installer.
2. Right-click the zip and choose **Extract All…**, then **Extract**. Setup doesn't work from inside the zip.
3. The extracted folder holds **Install Inkleaf PDF**, **README** and a **files** folder. Double-click **Install Inkleaf PDF**.
   - Its full name is `Install Inkleaf PDF.cmd`, but Windows usually hides the `.cmd` ending.
   - If Windows shows *"Windows protected your PC"*, click **More info**, then **Run anyway**. This appears because the app isn't code-signed.
   - If **Install Inkleaf PDF** is missing (some antivirus or company policies remove `.cmd` files), open the **files** folder, right-click **setup** (`setup.ps1`) and choose **Run with PowerShell**.
4. A setup window opens and does three things:
   - it downloads the app's runtime (about 160 MB) from Electron's official GitHub releases;
   - it checks the download's SHA-256 fingerprint;
   - it installs everything to `%LOCALAPPDATA%\Programs\Inkleaf PDF`.

   This takes a minute or two. Inkleaf PDF then opens by itself, and it's on your **Start menu** and **Desktop**.

### Make it your default PDF app (optional)

Right-click any PDF in File Explorer and choose **Open with**, then **Choose another app**, then **Inkleaf PDF**, then **Always**.

### Update

Download the new `InkleafPDF-Setup.zip` and run its **Install Inkleaf PDF** the same way. Your settings, drawing scales and last-opened file are kept.

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
| **Select** | V | Tap or drag any markup to select it, then move, reshape, retype, restyle or delete it. Drag over text to select and copy it. Dragging on blank paper pans. |
| **Pan** | H | Drag to move around. |
| **Highlight** | M | Snaps to the text you sweep over. Where there's no text, it becomes a freehand marker. |
| **Pen** | P | Write or draw freehand. |
| **Shapes** | B | Box, line, arrow, cloud, callout or text. Tap the tool again (or its small ▾) to choose. It always draws, even on top of other markups. See [Shapes, text and callouts](#4-shapes-text-and-callouts). |
| **Signature** | S | Place your signature, with its background removed. See [Sign](#5-sign). |
| **Eraser** | E | Removes the ink, shapes, text, signatures, highlights and measurements you touch. |
| **Edit content** | X | Drag a box to erase an area of the page; tap a line of the page's own text to retype it. See [Edit the page's content](#6-edit-the-pages-content). |
| **Measure** | R | Distance, path length and area at the drawing's scale (see below). |

- **Colors and thickness:** tap the active tool again, or tap the colored dot next to the tools.
- **Pen and finger:** the pen uses the selected tool, and a finger always pans and zooms. To draw with a finger, turn on the **finger button** (**T**); you then pan and zoom with two fingers.
- **Erasing with the pen:** flip the Surface Pen over and use its eraser end, or hold its side button.
- **Palm rejection:** your palm is ignored while the pen is near the screen.
- **Undo and redo:** Ctrl+Z and Ctrl+Y, or the arrows in the toolbar.

### 4. Shapes, text and callouts

Choose the **Shapes** tool (**B**), then tap it again (or its small ▾) to pick a shape, its color and its thickness.

| Shape | How to draw it |
|---|---|
| **Box** | Drag from corner to corner. |
| **Line** / **Arrow** | Drag from start to end; the arrow points where you finish. **Shift** keeps it at 0°, 45° or 90°. |
| **Cloud** | Drag from corner to corner. Good for marking revisions on drawings. |
| **Callout** | Drag from the spot you're pointing at to where the text should go, then type. The leader line and arrow are added for you. |
| **Text** | Tap where the text should start, or drag to set how wide it is, then type. |

- While typing, **Enter** finishes (so does **Done**, or tapping anywhere else on the page). **Shift+Enter** starts a new line. **Esc** or **Cancel** throws the text away.
- Long text wraps to the box's width, and the box grows to fit.
- For text and callouts, the same menu sets the **text size** (9, 12, 18 or 28 pt) and an optional **white background**, which keeps text readable on busy drawings.
- Text in other languages works too, including accented letters and Chinese.

**Move, reshape and edit** any markup with the **Select** tool (**V**). The Shapes, Pen and other drawing tools always draw, so you can add text or another shape on top of a box.

- **Tap a markup** (pen, mouse or finger) to select it: shapes, text, callouts, pen strokes, signatures, highlights and measurements. A dashed frame and handles appear. With the pen or mouse you can also press on a markup and drag it straight away.
- If another markup lies on top of the selected one, tap it to select that one instead.
- **Drag it** to move it. Highlights and measurements stay where they are; they can be deleted.
  - Drag a **corner** of a box or cloud to resize it.
  - Drag either **end** of a line or arrow.
  - Drag a callout's **round tip** to point it somewhere else. Moving a callout's box keeps its tip where it was.
- **Retype** a text box or callout: tap it again, click **Edit text**, or press **Enter**. Delete all the text to remove it.
- **Restyle:** with a shape or pen stroke selected, tap the coloured dot next to the tools. Its colour, thickness, text size and white-background choices apply to the selection.
- **Delete** with the **Delete** (or **Backspace**) key or the **Delete** button. Tap blank paper or press **Esc** to deselect.

Each change updates the same markup in the PDF, so replies or status added to it in Acrobat or Bluebeam stay attached. Every change is one undo step.

### 5. Sign

1. Choose **Signature** (**S**). The signature panel opens.
2. The first time, click **Add signature from file…** and pick a photo or scan of your signature (PNG, JPG, GIF, BMP or WebP). You can also drag an image file onto the window.
3. In **Prepare signature**:
   - the paper background is removed automatically;
   - move the **Remove background** slider right to remove more (paper texture, shadows, ruled lines) or left to keep faint strokes, and **Auto** goes back to the automatic setting;
   - choose the ink colour (as in the image, black or blue) and check the result on a transparent or white background;
   - click **Use signature**. It's saved to **My signatures** for next time.
4. The signature appears on the page with a dashed frame. **Drag it** to move it, **drag a corner** to resize it (it keeps its proportions), or **tap the page** to move it there. Click **Place** (or press **Enter**). **Cancel** (or **Esc**) drops it.

Next time:
- tap a signature in **My signatures** to place it, or, with the Signature tool, just **tap the page** to place your last signature there at the size you used last;
- to move, resize or delete a signature already on the page, **tap it** with the Signature tool, then drag it, or click **Delete** (or press **Delete**). With the Select tool you can also tap it and press **Delete**;
- keep signature images in a folder and click **Choose folder…** in the panel: its images are listed there too, and picking one goes through **Prepare signature**;
- to remove a signature from **My signatures**, hover over it (or tap) and click its **×**. Signatures already placed in PDFs stay.

Signatures are saved in the PDF as stamp annotations with a transparent image, so they look the same in Acrobat, Edge and other PDF apps.

### 6. Edit the page's content

The **Edit content** tool (**X**) changes the page itself, not just the markups on top of it. It does two things, with no modes to switch:

- **Drag a box to erase an area:** text, pictures, lines, anything. The area turns white with a red dashed edge. Markups you added earlier that lie mostly inside the box (highlights, pen strokes, shapes) disappear with it. You can still resize or delete the box with the Select tool, or undo it.
- **Tap a line of text to retype it.** It opens for editing right over the line, in the same font. Change it and press **Enter** (**Shift+Enter** adds a line, **Esc** cancels). The new text keeps the line's font, size, weight (bold, italic), colour and exact position. Delete all the text to remove the line.
  - **Tap it again** to change it again, before or after saving. The Select tool's **Edit text** works too, and **Undo edit** (or Ctrl+Z) puts the original back.

Everything is applied when you **save**:
- Edited lines become real text in the PDF: searchable, copyable, and editable again later.
- For erase areas Inkleaf asks first, because what's under them is removed from the PDF for good: it can't be copied, searched or recovered from the saved file.
- To keep the original, use **Save as** (**Ctrl+Shift+S**) for the edited version.

How the font is matched:
1. If every letter you type already appears in that font on the page, the document's own embedded font is used, so the result is identical.
2. Otherwise Inkleaf uses the same font installed on your PC (Calibri, Arial, Times New Roman and so on). Only the letters used are embedded, so the file stays small.
3. If that font isn't installed either, it uses the closest standard font (Helvetica, Times or Courier, in bold or italic as needed).

> Each line is edited on its own. Longer new text doesn't push the rest of the paragraph along, so for big rewrites erase the paragraph and add a text box instead. Rotated or vertical text can't be retyped, but you can erase it.

### 7. Select and copy text

1. Choose **Select** (**V**).
2. Drag over the text you want. A selection can run across several pages, and it scrolls the page when you drag near the edge.
   - Double-click to select a word, or triple-click to select a line.
   - **Ctrl+A** selects all the text on the current page.
3. Press **Ctrl+C**, or click **Copy** on the small bar that appears under the selection.
   - Click **Highlight** on that bar instead to turn the selection into a highlight.

Click on blank paper or press **Esc** to clear the selection.

### 8. Measure drawings

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

### 9. Save and embed

- **Ctrl+S** (or the save button) writes your markups into the PDF as standard annotations. Acrobat, Edge, Bluebeam and other PDF apps show them too, and they stay movable and editable.
- **Ctrl+Shift+S** saves a copy under a new name.
- A blue dot next to the file name means there are unsaved changes. Inkleaf asks before you close or switch files with unsaved changes.
- If another program changed the file after you opened it, Inkleaf asks before overwriting those changes.

**Embed markups** (**⋯ → Embed markups…**) makes highlights, drawings, shapes, text, callouts and signatures part of the pages. After that they can't be moved, edited or deleted, in Inkleaf or any other PDF app. Use it when you send out a final, signed or marked-up copy. Erase areas are applied at the same time, and form fields stay fillable. You choose:

- **Save as a copy…** (suggested name: *name (embedded).pdf*). The file you have open keeps its editable markups.
- **Replace this file.** The open file is rewritten with everything embedded. This can't be undone.

## Keyboard shortcuts

**You can change any shortcut**, and give a shortcut to every function, including each shape, signature actions, measuring modes, zoom levels and page navigation:

1. Open **⋯ → Keyboard shortcuts…** (or press **Ctrl+K**).
2. Find the command (type in the search box).
3. Click **Add shortcut** (or **+**), then press the keys you want. **Esc** cancels.
   - If those keys already did something else, they move to the new command, and **Undo** puts them back.
   - Click **×** on a key to remove it, or **Reset** to go back to the default. **Reset all** restores every default.

Your shortcuts are saved and kept when you update the app. **⋯ → Keyboard, touch and pen help** (**F1**) always shows your current keys.

Shortcuts work by key position, so they keep working with other keyboard layouts and input methods. Plain-letter shortcuts don't fire while you're typing in a box; Ctrl, Alt and F-key shortcuts such as Save still do.

The defaults:

| Keys | Action |
|---|---|
| V · H · M · P · B · S · E · X · R | Select · Pan · Highlight · Pen · Shapes · Signature · Eraser · Edit content · Measure |
| T | Finger draws on/off |
| Ctrl+S / Ctrl+Shift+S | Save / Save as |
| Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) | Undo / Redo |
| Ctrl+C / Ctrl+A | Copy selected text / Select all text on the page |
| Enter or F2 · Delete or Backspace | Edit the selected text box or callout · delete the selected markup or signature |
| Ctrl + / Ctrl − / Ctrl+0 / Ctrl+9 / Ctrl+1 | Zoom in / out / fit width / fit page / 100% |
| PgUp / PgDn / Space · Home / End | Scroll a screen · first / last page |
| Ctrl+G | Go to page |
| Alt+↑ / Alt+↓ | Previous / next PDF in the list |
| Ctrl+O · Ctrl+F · Ctrl+B · F5 | Open folder · filter files · show/hide the file list · refresh it |
| F11 · F1 · Ctrl+K | Full screen · help · keyboard shortcuts |

These keys always do the same thing in their situation:

| Keys | Action |
|---|---|
| Enter · Backspace · Esc | Finish · remove last point · cancel (while measuring) |
| Enter · Shift+Enter · Esc | Finish · new line · cancel a text box or callout you're typing |
| Enter · Esc | Place · cancel the signature you're positioning |
| Esc | Deselect a markup, close a menu, clear a text selection |
| Shift (while drawing a line or measuring) | Keep it at 0°, 45° or 90° |

## Troubleshooting

| Problem | What to do |
|---|---|
| *"Windows protected your PC"* when running Setup | Click **More info**, then **Run anyway**. The app isn't code-signed. |
| Can't find **Install Inkleaf PDF** after extracting | Make sure you extracted `InkleafPDF-Setup.zip` (the installer), not the repository's source-code zip. If it's still missing, use **files → setup → Run with PowerShell** as described in [Install](#install). |
| Setup says it couldn't download, or the safety check failed | Check your internet connection and run **Install Inkleaf PDF** again. If your network blocks github.com, use `InkleafPDF-win-x64.zip` and `Install.cmd` instead (see [Other ways to install](#other-ways-to-install)). |
| *"Couldn't save"* | The file may be open in another app, or in a read-only or locked folder. Use **Save as…** to save a copy somewhere else. |
| Measurements look wrong | Check the scale on the measuring bar. *Scale not set* means 1:1 (real paper size). Set the scale or calibrate. |
| Some of the paper is still visible around a signature | Tap the Signature tool, add the image again, and move **Remove background** further right. Photos with shadows usually need more. |
| Part of a signature is missing | Move **Remove background** further left, or choose **Black** or **Blue** ink so faint strokes become solid. |
| A finger draws instead of panning | The finger button (**T**) is on. Tap it to turn it off. |
| Tapping a markup draws a new one instead of selecting it | Drawing tools always draw. Choose **Select** (**V**), then tap the markup. |
| A markup can't be moved or deleted | It has been embedded into the page (**⋯ → Embed markups**), or it was flattened by another app. If you kept the copy without embedding, edit that one. |
| Erased text still shows in another app | Erase areas are applied when you save. Save, then reopen the file there. |
| Dragging with Edit content opens a text box instead of erasing | A short drag counts as a tap. Drag a little further. |
| A retyped line looks slightly different | The font isn't installed on this PC and some letters you typed weren't in the PDF's own copy of it, so the closest standard font was used. Install the font, or keep to letters already on the page. |
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
| `app/shortcuts.js` | Key combos by physical key position, display names, and the keymap of user overrides on top of the defaults. Every command and its default keys live in the `COMMANDS` list in `app/main.js`. |
| `app/sigproc.js` | Signature background removal: paper colour from the image border, automatic threshold (Otsu), soft edges, paper-tint removal at stroke edges, ink recolouring, crop and PNG export. |
| `app/sidebar.js` | Virtualized folder tree, so thousands of files stay instant. |
| `electron/fontindex.js` | Finds the installed font file matching a PDF font name, for retyping text in the same font. |
| `app/main.js` | Toolbar, dialogs, shortcuts, settings, scales, and the open/save flow. |
| `electron/` | Desktop shell: `app://` protocol, file IPC, clipboard, folder watcher, single instance, and Windows title bar. |
| `windows/` | Installer scripts (`Setup.cmd`, shipped as `Install Inkleaf PDF.cmd`, plus `setup.ps1` for the small package; `Install.cmd` for the full zip) and the readme that ships with them. |
| `tools/devserver.js` | Runs the same UI in a normal browser for testing. |

Shapes are standard annotations: box and cloud are `Square` (the cloud uses the PDF's cloudy border effect), line and arrow are `Line`, text and callout are `FreeText` (the callout uses the `FreeTextCallout` intent with a callout line), and signatures are `Stamp` annotations with a transparent image. Each one Inkleaf creates carries an `InkleafShape` key. The viewer draws those from MuPDF's own SVG of the saved appearance, so what you see is exactly what other apps see. Text boxes are sized to the number of lines MuPDF wraps the text into.

Erase areas are `Redact` annotations with an `InkleafShape` key until you save. Saving applies them to a temporary copy of the document: MuPDF's redaction removes the text, covered line art and image pixels under them (other annotations are detached from the page meanwhile, so they survive), the areas are painted white, and the whole file is rewritten with garbage collection, so no old copy of the erased content stays in it. A retyped line is one item (a `Redact` annotation whose `InkleafShape` key holds the text, size, colour, baseline origin, the old line's box and the laid-out glyph runs). The viewer draws it from MuPDF's SVG of those glyphs in the chosen font. On save, the old line's box is redacted and whited out, the font is embedded (`addFont`, with our own `ToUnicode` map), and the text is written into the page content as glyph runs. Everything happens in the order it was made, so a later erase area also removes earlier edited text. The font is the page's own embedded font when its glyphs (captured from the page's text) cover the new text; otherwise the installed font found by `electron/fontindex.js` (name tables of the system fonts, with metric-compatible fallbacks such as Carlito for Calibri), fetched by the worker and subset on save; otherwise a base-14 font. **Embed markups** does the same on a temporary copy, then bakes every annotation into the page content (`bake`, with form widgets left alone).

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

- `dist/InkleafPDF-Setup.zip`: the small installer. It holds `Install Inkleaf PDF.cmd` (built from `windows/Setup.cmd`), `README.txt`, and a `files` folder with the app and `setup.ps1`. The runtime is downloaded and verified during setup.
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
