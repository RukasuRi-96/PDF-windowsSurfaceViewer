INKLEAF PDF  -  fast touch & pen PDF reader for Windows
=====================================================

INSTALL
  1. Right-click InkleafPDF-Setup.zip > "Extract All...".
  2. Open the extracted folder and double-click  Setup.cmd
     (If Windows asks whether to run it, choose "Run", or
      "More info" > "Run anyway". The app isn't code-signed.)
  3. Setup downloads the app runtime (about 160 MB) straight from
     Electron's official GitHub releases, checks its SHA-256 fingerprint,
     and installs everything to  %LOCALAPPDATA%\Programs\Inkleaf PDF.
     It takes a minute or two, then Inkleaf PDF opens by itself and is
     on your Start menu and Desktop. No admin rights are needed.

  To update later, run the new Setup.cmd the same way. Your settings
  and your PDFs are kept.

FIRST RUN
  Click "Open folder" and pick the folder where your PDFs live.
  Every PDF inside it - including all subfolders - appears on the left.
  Use the filter box to find a file by name. The list updates by itself
  when files are added or removed.

TOUCH & PEN
  Finger drag ............ pan (flick to glide)
  Two-finger pinch ....... zoom around your fingers
  Double-tap ............. zoom in / back to fit width
  Pen .................... uses the selected tool
  Pen eraser / side button erase
  Resting your palm while the pen is near the screen is ignored.
  The finger button in the toolbar (or T) lets one finger draw instead.

MOUSE
  Middle-button drag ..... pan the page (whatever tool is selected)
  Mouse wheel ............ scrolls pages, or zooms at the pointer.
                           Choose in the  ...  menu: "Mouse wheel scrolls"
                           or "Mouse wheel zooms". Ctrl+wheel always zooms;
                           in zoom mode Shift+wheel scrolls.

TOOLS (tap the active tool again for colors and thickness)
  Select (V)  Pan (H)  Highlight (M)  Pen (P)  Box (B)  Eraser (E)  Measure (R)
  Highlight snaps to text; where there is no text it becomes a marker.

SELECT & COPY TEXT (V)
  Drag over text to select it (across pages too). Double-click selects a
  word, triple-click a line, Ctrl+A the whole page. Press Ctrl+C or tap
  "Copy" on the little bar that appears; "Highlight" turns the selection
  into a highlight. Dragging on blank paper pans.

MEASURE (R) - distance, path length and area at the drawing's scale
  1. Set the scale: click the scale button on the measuring bar at the
     bottom (e.g. 1:100, 1/4" = 1'-0"), or choose "Calibrate" and draw
     a line over a dimension you know, then type its real length.
     The scale can apply to all pages or to one page.
  2. Tap the Measure tool again to pick Distance, Path length or Area,
     the units (mm, cm, m, km, in, ft, ft-in), decimals and color.
  Distance: drag, or click the two ends.
  Path / Area: click each point; double-click, Enter or Done finishes;
  clicking the first point closes an area. Backspace removes the last
  point, Esc cancels, Shift snaps to 0/45/90 degrees. With a finger,
  tap to place points and drag to pan.
  Measurements are saved into the PDF as standard measurement markups
  (with the value in their note), and the eraser and undo work on them.
  If you change the scale later, Inkleaf offers to recalculate them.

SAVING
  Ctrl+S saves the annotations straight into the PDF as standard PDF
  annotations, so they show up in Acrobat, Edge, Bluebeam, etc.
  Ctrl+Shift+S = Save as.  Ctrl+Z / Ctrl+Y = undo / redo.

OTHER KEYS
  Ctrl+O open folder   Ctrl+F filter files   Ctrl+B show/hide file list
  Alt+Up / Alt+Down previous / next PDF   Ctrl+0 fit width   Ctrl+9 fit page
  F11 full screen

UNINSTALL
  Settings > Apps > Installed apps > Inkleaf PDF > Uninstall.

Third-party: MuPDF (AGPL-3.0, Artifex), Electron/Chromium (MIT/BSD),
Lucide icons (ISC). See the 'licenses' folder and LICENSES.chromium.html.
