INKLEAF PDF  -  fast touch & pen PDF reader for Windows
=====================================================

INSTALL
  1. Right-click InkleafPDF-Setup.zip > "Extract All..." > Extract.
  2. In the folder that opens, double-click  Install Inkleaf PDF
     (its full name is "Install Inkleaf PDF.cmd"; Windows usually hides
      the ".cmd" ending). Leave the "files" folder next to it.
     If Windows says "Windows protected your PC", click "More info"
     > "Run anyway". The app isn't code-signed.
  3. Setup downloads the app runtime (about 160 MB) straight from
     Electron's official GitHub releases, checks its SHA-256 fingerprint,
     and installs everything to  %LOCALAPPDATA%\Programs\Inkleaf PDF.
     It takes a minute or two, then Inkleaf PDF opens by itself and is
     on your Start menu and Desktop. No admin rights are needed.

  To update later, run the new "Install Inkleaf PDF" the same way.
  Your settings and your PDFs are kept.

  If "Install Inkleaf PDF" is missing (some antivirus or company
  policies remove .cmd files), open the "files" folder, right-click
  "setup" (setup.ps1) and choose "Run with PowerShell".

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
  Select (V)  Pan (H)  Highlight (M)  Pen (P)  Shapes (B)  Signature (S)
  Eraser (E)  Edit content (X)  Measure (R)
  Highlight snaps to text; where there is no text it becomes a marker.
  Drawing tools always draw, even on top of other markups.

SELECT, MOVE, EDIT OR DELETE A MARKUP (V)
  With the Select tool, tap any markup: shape, text, callout, pen
  stroke, signature, highlight or measurement. Drag it to move it, drag
  its handles to resize or re-point it, tap it again (or Enter) to
  retype a text box or callout, and press Delete (or the Delete button)
  to remove it. The colored dot next to the tools restyles it.
  Highlights and measurements can be deleted but not moved.

SHAPES (B) - tap the tool again (or its small arrow) to choose
  Box, Line, Arrow, Cloud: drag. Shift keeps lines at 0/45/90 degrees.
  Callout: drag from the spot you're marking to where the text goes,
  then type. Text: tap (or drag to set the width), then type.
  While typing: Enter or Done = finish, Shift+Enter = new line,
  Esc = cancel. The same menu sets text size and a white background.
  To change a shape later, use the Select tool (V), see above.

SIGN (S)
  1. Choose the Signature tool and click "Add signature from file..."
     (a photo or scan: PNG, JPG, GIF, BMP or WebP).
  2. The paper background is removed for you. Slide "Remove
     background" right to remove more, left to keep faint strokes.
     Pick the ink colour and click "Use signature".
  3. Drag the signature into place, drag a corner to resize it, then
     click Place (or press Enter).
  Next time: tap it in My signatures, or just tap the page with the
  Signature tool to place your last one. Tap a placed signature to move,
  resize or delete it (Delete button or Delete key). "Choose folder..."
  lists the images in a folder of signatures.

EDIT THE PAGE'S CONTENT (X)
  Drag a box to erase an area: text, pictures, lines, and the markups
  you added inside it.
  Tap a line of text to retype it, then press Enter. It keeps the
  line's font, size, bold/italic, colour and position. Tap it again to
  change it again, before or after saving.
  Everything is applied when you save (Inkleaf asks first for erase
  areas): what is under them is removed from the PDF for good. Use
  Save as to keep the original.

SAVING
  Ctrl+S saves the annotations straight into the PDF as standard PDF
  annotations, so they show up in Acrobat, Edge, Bluebeam, etc.
  Ctrl+Shift+S = Save as.  Ctrl+Z / Ctrl+Y = undo / redo.

EMBED MARKUPS: More (...) > Embed markups...
  Makes highlights, drawings, shapes, text and signatures part of the
  pages, so they can no longer be moved, edited or deleted (in any PDF
  app). Choose "Save as a copy..." (the open file keeps its editable
  markups) or "Replace this file".

CHANGE ANY SHORTCUT: More (...) > Keyboard shortcuts (Ctrl+K)
  Search for a command, click "Add shortcut", press the keys you want.

OTHER KEYS
  Ctrl+O open folder   Ctrl+F filter files   Ctrl+B show/hide file list
  Alt+Up / Alt+Down previous / next PDF   Ctrl+0 fit width   Ctrl+9 fit page
  F11 full screen

UNINSTALL
  Settings > Apps > Installed apps > Inkleaf PDF > Uninstall.

Third-party: MuPDF (AGPL-3.0, Artifex), Electron/Chromium (MIT/BSD),
Lucide icons (ISC). See the 'licenses' folder and LICENSES.chromium.html.
