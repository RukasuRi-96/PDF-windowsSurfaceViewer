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
tests/run.sh                   # all browser tests
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
| `electron` | system clipboard via the app's IPC, measuring, scale and tool restored after relaunch |
