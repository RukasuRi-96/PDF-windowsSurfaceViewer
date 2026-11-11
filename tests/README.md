# End-to-end tests

Smoke tests that drive the real UI in headless Chromium with Playwright, using
real pointer, pen, touch and wheel input (see `helpers.js`). They run against
`tools/devserver.js` and a library of generated sample PDFs: text reports, a
500-page document, rotated and password-protected files, and A1 engineering
drawings.

```bash
npm install
pip install reportlab          # sample PDF generator
npm install --no-save playwright && npx playwright install chromium
tests/run.sh                   # all browser tests (annotate documents save-guard select-wheel measure shapes edit-shapes signature shortcuts)
tests/run.sh measure           # one test
tests/run.sh electron          # the packaged-app path (needs the Electron binary; xvfb-run on Linux)
```

Each test prints what it checked. Expected results:

| Test | Checks |
|---|---|
| `annotate` | pen, highlight (text-snapped and marker), box, eraser, undo, save, pinch zoom, fling, double-tap |
| `documents` | rotated pages, password prompt, 500-page fling and page jump, Ctrl+wheel zoom, finger drawing, palm rejection, `no errors` |
| `save-guard` | "File changed on disk" prompt, overwrite, margin drag pans, `errors: none` |
| `select-wheel` | wheel scrolls (default) or zooms around the pointer, Shift+wheel, middle-drag pans in any tool, text drag-select, Copy button and Ctrl+C reach the clipboard, double/triple-click, blank-paper drag pans, Highlight from selection, Ctrl+A, cross-page selection |
| `measure` | scale dialog (1:100), distance by drag and by two clicks (10.00 m, 5.00 m), Shift snap (8.00 m, horizontal), path (6.00 m), area (15.00 m², perimeter 16.00 m), Backspace/Enter, calibration (≈ 1:50) with recalculation and undo, eraser, finger taps, save and reload |
| `shapes` | box, line, arrow, cloud, text (tap and type) and callout (drag and type) from the shapes menu, all drawn from MuPDF's SVG, callout box fitted to its wrapped lines, eraser and undo, Esc cancels typing, save and reload with the text kept, `no errors` |
| `edit-shapes` | select by pen tap, move (exact offset, same annotation), resize, recolour from the menu, move a line end, re-point a callout tip, move a callout box (tip stays), retype in place (box grows to fit), emptying removes and undo restores, undo/redo a retype, finger tap selects / drag moves / tap elsewhere deselects, Delete button, save and reload keep geometry and text |
| `shortcuts` | defaults, recording Shift+L, Esc cancels recording, conflict moves a key with a note and Undo, removing a key, a second key on a command, tooltips and help follow, keys kept after restart, typing in the filter doesn't trigger tools, Delete and Enter on a selected shape, Ctrl+S while typing saves, Reset all |
| `signature` | prepare a JPEG photo (automatic background removal, then 45%), place, move, resize keeping proportions, tap-to-place the last signature at the same size, tap to adjust then undo, eraser and undo, saved PDF in Poppler shows 0% paper colour in the signature area, signatures folder listed, reload and adjust a loaded signature, `no errors` |
| `electron` | system clipboard via the app's IPC, measuring, signature from a JPEG written and listed through the app's file IPC, scale, tool and My signatures restored after relaunch |
