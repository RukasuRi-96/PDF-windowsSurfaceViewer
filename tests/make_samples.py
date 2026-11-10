import os, random, sys
from reportlab.lib.pagesizes import A4, A1, landscape, letter
from reportlab.pdfgen import canvas
from reportlab.lib.colors import Color

root = sys.argv[1]
random.seed(7)
words = ("lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore "
         "et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip "
         "station platform concourse drawing services electrical mechanical ventilation duct cable tray").split()

def text_doc(path, pages, size=A4, title="Document"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    c = canvas.Canvas(path, pagesize=size)
    W, H = size
    for p in range(pages):
        c.setFont("Helvetica-Bold", 20); c.drawString(60, H-70, f"{title} - page {p+1}")
        c.setFont("Helvetica", 11)
        y = H - 110
        while y > 60:
            line = " ".join(random.choice(words) for _ in range(14))
            c.drawString(60, y, line.capitalize() + ".")
            y -= 16
        c.setFillColor(Color(0.2,0.4,0.8)); c.rect(W-160, 40, 100, 30, fill=1, stroke=0); c.setFillColor(Color(0,0,0))
        c.showPage()
    c.save()

def drawing(path, nlines=60000):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    size = landscape(A1)
    c = canvas.Canvas(path, pagesize=size)
    W, H = size
    c.setLineWidth(0.3)
    # grid
    for x in range(40, int(W)-40, 20): c.line(x, 40, x, H-40)
    for y in range(40, int(H)-40, 20): c.line(40, y, W-40, y)
    c.setLineWidth(0.6)
    for i in range(nlines):
        x = random.uniform(60, W-60); y = random.uniform(60, H-60)
        c.setStrokeColor(Color(random.random()*0.6, random.random()*0.6, random.random()*0.8))
        c.line(x, y, x + random.uniform(-40, 40), y + random.uniform(-40, 40))
    c.setStrokeColor(Color(0,0,0)); c.setLineWidth(2); c.rect(30, 30, W-60, H-60)
    c.setFont("Helvetica", 8)
    for i in range(400):
        c.drawString(random.uniform(60, W-200), random.uniform(60, H-60), f"DUCT-{i:03d} 300x200 CABLE TRAY T{i%9}")
    c.setFont("Helvetica-Bold", 28); c.drawString(W-700, 60, "SERVICES LAYOUT - LEVEL B1 (SAMPLE)")
    c.showPage(); c.save()

def mixed(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    c = canvas.Canvas(path, pagesize=A4)
    for i, sz in enumerate([A4, landscape(A4), letter, (400, 400)]):
        c.setPageSize(sz); W, H = sz
        c.setFont("Helvetica", 14); c.drawString(40, H-50, f"Mixed size page {i+1}: {int(W)} x {int(H)} pt")
        c.rect(20, 20, W-40, H-40)
        c.showPage()
    c.save()

text_doc(f"{root}/Reports/Annual Report 2026.pdf", 40, title="Annual Report")
text_doc(f"{root}/Reports/Q3/Quarterly summary.pdf", 6, title="Q3 Summary")
text_doc(f"{root}/Reports/Q3/Appendix A.pdf", 3, title="Appendix A")
text_doc(f"{root}/Manuals/Pump manual.pdf", 12, size=letter, title="Pump Manual")
text_doc(f"{root}/Notes.pdf", 2, title="Notes")
drawing(f"{root}/Drawings/Station A/B1 services layout.pdf")
drawing(f"{root}/Drawings/Station A/B2 services layout.pdf", 20000)
mixed(f"{root}/Misc/Mixed sizes.pdf")
os.makedirs(f"{root}/Empty folder/Nothing here", exist_ok=True)
open(f"{root}/Misc/readme.txt","w").write("not a pdf")
print("ok")
