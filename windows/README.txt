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

TOOLS (tap the active tool again for colors and thickness)
  Pan (H)  Highlight (M)  Pen (P)  Box (B)  Eraser (E)
  Highlight snaps to text; where there is no text it becomes a marker.

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
