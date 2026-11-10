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
print("ok")
