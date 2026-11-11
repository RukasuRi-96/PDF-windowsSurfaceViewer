import os, sys, random
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas
root = sys.argv[1]
# rotated pages
os.makedirs(f"{root}/Misc", exist_ok=True)
c = canvas.Canvas(f"{root}/Misc/Rotated.pdf", pagesize=A4)
for rot in (0, 90, 180, 270):
    c.setFont("Helvetica-Bold", 24); c.drawString(60, 760, f"Page with /Rotate {rot}")
    c.setFont("Helvetica", 12)
    for i in range(30): c.drawString(60, 720 - i * 18, f"Line {i+1}: the quick brown fox jumps over the lazy dog")
    c.setPageRotation(rot); c.showPage()
c.save()
# encrypted
c = canvas.Canvas(f"{root}/Misc/Locked (password is secret).pdf", pagesize=A4, encrypt="secret")
c.setFont("Helvetica", 18); c.drawString(60, 760, "This file was password protected."); c.showPage(); c.save()
# 500 pages
c = canvas.Canvas(f"{root}/Reports/Big 500 pages.pdf", pagesize=A4)
for p in range(500):
    c.setFont("Helvetica-Bold", 40); c.drawString(60, 760, f"Page {p+1}")
    c.setFont("Helvetica", 10)
    for i in range(40): c.drawString(60, 700 - i * 15, f"Row {i} of page {p+1} " + "lorem ipsum dolor " * 4)
    c.showPage()
c.save()
# A letter set like a word-processor export: embedded TrueType subset fonts
# (Calibri-like Carlito, or DejaVu), a bold line, a coloured line and a serif line.
def first(*paths):
    return next((p for p in paths if os.path.exists(p)), None)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
F = "/usr/share/fonts/truetype/"
reg = first(F + "crosextra/Carlito-Regular.ttf", F + "dejavu/DejaVuSans.ttf")
bold = first(F + "crosextra/Carlito-Bold.ttf", F + "dejavu/DejaVuSans-Bold.ttf")
serif = first(F + "liberation/LiberationSerif-Regular.ttf", F + "dejavu/DejaVuSerif.ttf")
if reg and bold and serif:
    pdfmetrics.registerFont(TTFont("Body", reg)); pdfmetrics.registerFont(TTFont("BodyBold", bold)); pdfmetrics.registerFont(TTFont("Serif", serif))
    c = canvas.Canvas(f"{root}/Letter.pdf", pagesize=A4)
    y = 780
    for font, size, color, text in [
        ("BodyBold", 18, (0, 0, 0), "Site Inspection Report"),
        ("Body", 11, (0, 0, 0), "Project: Riverside Station upgrade, contract 2041-B"),
        ("Body", 11, (0, 0, 0), "The inspection was carried out on 3 March by the site team."),
        ("BodyBold", 11, (0, 0, 0), "Status: approved with comments"),
        ("Body", 11, (0.75, 0, 0), "Note: the cable tray in zone 4 must be re-routed."),
        ("Serif", 12, (0, 0, 0), "Signed for and on behalf of the consultant."),
        ("Body", 11, (0, 0, 0), "Total cost estimate: 12,500 dollars"),
    ]:
        c.setFont(font, size); c.setFillColorRGB(*color); c.drawString(57, y, text); y -= 28
    c.showPage(); c.save()
print("ok")
