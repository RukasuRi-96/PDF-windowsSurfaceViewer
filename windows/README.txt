EAGLES PDF VIEWER  -  fast touch & pen PDF reader for Windows
=============================================================

INSTALL
  1. Right-click EaglesPDF-Setup.zip > "Extract All..." > Extract.
  2. In the folder that opens, double-click  Install Eagles PDF viewer
     (its full name is "Install Eagles PDF viewer.cmd"; Windows usually hides
      the ".cmd" ending). Leave the "files" folder next to it.
     If Windows says "Windows protected your PC", click "More info"
     > "Run anyway". The app isn't code-signed.
  3. Setup downloads the app runtime (about 160 MB) straight from
     Electron's official GitHub releases, checks its SHA-256 fingerprint,
     and installs everything to  %LOCALAPPDATA%\Programs\Eagles PDF viewer.
     It takes a minute or two, then Eagles PDF viewer opens by itself and is
     on your Start menu and Desktop. No admin rights are needed.

UPDATES
  The app updates itself. When a new version is out it tells you (and
  a dot appears on the More (...) button): choose "Update now", then
  "Restart now" or "When I close the app". Or More (...) > Check for
  updates. The update is checked against its fingerprint first, and
  your settings, signatures and PDFs are kept. Updates come from
  github.com/RukasuRi-96/EaglesPDF-releases.
  You can also run a new "Install Eagles PDF viewer" the same way. If
  you had "Inkleaf PDF" (this app's earlier name), setup replaces it
  and keeps its settings.

  If "Install Eagles PDF viewer" is missing (some antivirus or company
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
  Pen eraser end ......... erase
  Pen side button (hold) . lasso: select markups (any tool)
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
  Eraser (E)  Lasso (L)  Snip (C)  Edit content (X)  Measure (R)
  Highlight: in its colour menu choose Words (snaps to text; where
  there is no text it becomes a marker) or Draw (a freehand marker).
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
  Everything is applied when you save (the app asks first for erase
  areas): what is under them is removed from the PDF for good. Use
  Save as to keep the original.

PAGES (button at the top right, or Ctrl+Shift+P)
  A thumbnail of every page. Click one to go there; Ctrl/Shift+click
  selects several. Delete key or the bin button deletes them. The +
  button (or right-click a page; with a finger, press and hold) adds a
  blank page (A4, A3, A5, Letter, Legal, Tabloid, portrait or landscape)
  or pages from another PDF, and duplicates, rotates or moves pages.
  Drag pages with the mouse or pen to reorder them; with a finger,
  drag a page by its grip (the dotted handle), or press and hold it
  until it lifts, then drag it. Drop pages on another PDF open side by
  side to copy them there. Ctrl+Z undoes.
  The page you are reading is highlighted. If the PDF names its pages
  (like A-101) or has bookmarks, the names are shown too: the tag button
  at the top of the panel switches between numbers, names or both.
  Ctrl+G (or click the page counter) goes to a page by number or name.

SNIP: COPY PART OF A PAGE AS A PICTURE (C)
  Drag a box, or draw around something (a lasso), with the pen, mouse
  or a finger. It is copied as a picture (other apps can paste it too).
  To paste it at exactly the same size, no keyboard needed: tap the
  page where it should go (in any open PDF). Or press and hold the
  page with a finger (or right-click) > "Paste picture here", or tap
  "Paste" on the "Copied" message. With a keyboard: Ctrl+V.
  Drag the picture to move it, drag a corner to resize it (it keeps its
  proportions), Delete removes it.

PRESS AND HOLD THE PAGE (or right-click)
  Paste here, Snip, Lasso, Select all markups on this page, Open a PDF
  side by side, Close this PDF.

LASSO: SELECT SEVERAL MARKUPS (L, or hold the pen's side button)
  Draw round markups, or over them. Then drag inside the frame to move
  them, drag a corner to resize them (proportions kept), or use the bar:
  Copy, Duplicate, Delete. Paste with press and hold > "Paste here" (or
  Ctrl+V), on any page of any open PDF. Arrow keys nudge them. Each
  change is one undo step.

SEARCH (Ctrl+F)
  Type words: every match is marked, Enter / Shift+Enter (or the
  arrows) go to the next / previous one, the list button shows them all
  with their context. Esc closes it.

MARKUPS LIST (Markups button, top right, or Ctrl+Shift+M)
  Every markup in the PDF, page by page, with its words and colour.
  Choose a kind at the top; tap one to go to it and select it.

TOOLBAR: More (...) > Customize the toolbar (or right-click it)
  Tick the buttons to show. With many, the buttons get smaller so all
  fit. Hidden ones stay in the More (...) menu and on their keys.

SIDE BY SIDE: UP TO FOUR PDFS AT ONCE
  Right-click a PDF in the file list (with a finger: press and hold)
  > "Open side by side", or press Ctrl+Shift+O.
  Every PDF works the same: write, draw, sign, snip, change pages, undo
  and save in any of them. The one you touched last is the one in use
  (blue line on its title bar); the toolbar, keys and Pages panel
  follow it. Drag a title bar to move that PDF; drag the bar between
  two PDFs to resize them; X on a title bar (or Ctrl+W) closes it.
  Ctrl+Tab goes to the next one. In portrait they stack. The same PDFs
  open again next time.

MERGE PDFS
  In the file list, Ctrl+click the PDFs you want (Shift+click for a
  range), right-click one of them > "Merge N PDFs...". Or right-click a
  folder > "Merge all PDFs in this folder..." (subfolders included).
  Set the order, choose where to save; the merged PDF opens.
  With a finger: press and hold a PDF > "Select for merging", tap the
  others, then tap "Merge..." at the bottom of the list.

SAVING
  Ctrl+S saves the annotations straight into the PDF as standard PDF
  annotations, so they show up in Acrobat, Edge, Bluebeam, etc.
  Ctrl+Shift+S = Save as.  Ctrl+Z / Ctrl+Y = undo / redo.
  Autosave: More (...) > Autosave. Each PDF then saves itself a few
  seconds after you stop. Erase areas and retyped text still wait for
  Ctrl+S (they can't be undone), and a file changed by another program
  is never overwritten without asking.

EMBED MARKUPS: More (...) > Embed markups...
  Makes highlights, drawings, shapes, text, signatures and pictures
  part of the pages, so they can no longer be moved, edited or deleted
  (in any PDF app). Choose "Save as a copy..." (the open file keeps its
  editable markups) or "Replace this file".

CHANGE ANY SHORTCUT: More (...) > Keyboard shortcuts (Ctrl+K)
  Search for a command, click "Add shortcut", press the keys you want.

OTHER KEYS
  Ctrl+O open folder   Ctrl+Shift+F filter files   Ctrl+B file list
  Alt+Up / Alt+Down previous / next PDF   Ctrl+0 fit width   Ctrl+9 fit page
  F11 full screen

UNINSTALL
  Settings > Apps > Installed apps > Eagles PDF viewer > Uninstall.

Third-party: MuPDF (AGPL-3.0, Artifex), Electron/Chromium (MIT/BSD),
Lucide icons (ISC). See the 'licenses' folder and LICENSES.chromium.html.
