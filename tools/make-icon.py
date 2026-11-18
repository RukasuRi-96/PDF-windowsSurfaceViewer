# Draws the Eagles PDF viewer icon: the eagle (tools/eagle.png) holding a
# sheet of paper and a pen in its talons.
#   python3 tools/make-icon.py        -> electron/icon.png, electron/icon.ico, app/logo.png
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 2048                      # drawn at 2x, then reduced (smooth edges)
BLUE = (23, 73, 127, 255)     # the eagle's blue
YELLOW = (246, 181, 30, 255)
PAPER = (255, 255, 255, 255)
LINE = (178, 200, 228, 255)
OUT = 40                      # outline width (at 2x)

def k(v): return int(round(v * 2))   # 1024-space -> drawing space

# ---- paper and pen, drawn upright, then tilted like a held sheet ----------
layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(layer)
cx, cy = k(470), k(812)       # centre of the sheet
w, h = k(410), k(290)
x0, y0, x1, y1 = cx - w // 2, cy - h // 2, cx + w // 2, cy + h // 2
fold = k(78)
sheet = [(x0, y0), (x1 - fold, y0), (x1, y0 + fold), (x1, y1), (x0, y1)]
# outline: the sheet drawn bigger in blue, then the paper inside
d.polygon(sheet, fill=BLUE)
shrink = OUT
inner = [(x0 + shrink, y0 + shrink), (x1 - fold - shrink * 0.4, y0 + shrink), (x1 - shrink, y0 + fold + shrink * 0.4), (x1 - shrink, y1 - shrink), (x0 + shrink, y1 - shrink)]
d.polygon(inner, fill=PAPER)
# folded corner
d.polygon([(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)], fill=BLUE)
d.polygon([(x1 - fold + shrink * 0.5, y0 + shrink * 1.4), (x1 - fold + shrink * 0.5, y0 + fold - shrink * 0.5), (x1 - shrink * 1.4, y0 + fold - shrink * 0.5)], fill=(226, 234, 245, 255))
# ruled lines
for i in range(4):
    yy = y0 + k(92) + i * k(52)
    d.rounded_rectangle([x0 + k(46), yy, x1 - k(46) - (k(70) if i == 0 else 0), yy + k(12)], radius=k(6), fill=LINE)
# a line of handwriting on the second rule
pts = []
for t in range(0, 61):
    u = t / 60
    x = x0 + k(52) + u * k(230)
    y = y0 + k(132) - k(14) * abs(__import__("math").sin(u * 9.5)) - k(4) * __import__("math").sin(u * 21)
    pts.append((x, y))
d.line(pts, fill=BLUE, width=k(11), joint="curve")
for p in (pts[0], pts[-1]):
    d.ellipse([p[0] - k(5.5), p[1] - k(5.5), p[0] + k(5.5), p[1] + k(5.5)], fill=BLUE)
nib = pts[-1]

layer = layer.rotate(-7, center=(cx, cy), resample=Image.BICUBIC)

# pen: lying across the sheet, its tip at the end of the handwriting
pen = Image.new("RGBA", (S, S), (0, 0, 0, 0))
p = ImageDraw.Draw(pen)
import math
ang = math.radians(-7)
def rot(pt):  # same tilt as the sheet
    dx, dy = pt[0] - cx, pt[1] - cy
    return (cx + dx * math.cos(ang) - dy * math.sin(ang), cy + dx * math.sin(ang) + dy * math.cos(ang))
tip = rot(nib)
L, R = k(300), k(30)                 # pen length and half-width
a = math.radians(32)                 # lying down and to the right of the tip
ux, uy = math.cos(a), math.sin(a)    # along the pen (towards the back)
nx, ny = -uy, ux
def at(s, o): return (tip[0] + ux * s + nx * o, tip[1] + uy * s + ny * o)
body = [at(k(70), -R), at(L, -R), at(L + k(14), 0), at(L, R), at(k(70), R)]
cone = [at(0, 0), at(k(70), -R), at(k(70), R)]
p.polygon([at(-k(6), 0), at(k(70), -R - OUT * 0.6), at(L + OUT * 0.5, -R - OUT * 0.6), at(L + k(14) + OUT * 0.7, 0), at(L + OUT * 0.5, R + OUT * 0.6), at(k(70), R + OUT * 0.6)], fill=BLUE)
p.polygon(body, fill=YELLOW)
p.polygon([at(k(18), 0), at(k(66), -R + OUT * 0.55), at(k(66), R - OUT * 0.55)], fill=(255, 236, 190, 255))
p.polygon([at(0, 0), at(k(26), -k(9)), at(k(26), k(9))], fill=BLUE)           # nib point
p.line([at(L - k(70), -R), at(L - k(70), R)], fill=BLUE, width=k(10))              # cap ring
p.line([at(k(90), -R + k(12)), at(L - k(84), -R + k(12))], fill=(255, 214, 110, 255), width=k(9))  # shine
layer.alpha_composite(pen)

# ---- the eagle, gripping the top of the sheet ------------------------------
src = Image.open(os.path.join(ROOT, "tools", "eagle.png")).convert("RGBA")
scale = 3.887 * 2
alpha = src.split()[3].resize((round(src.width * scale), round(src.height * scale)), Image.LANCZOS)
alpha = alpha.filter(ImageFilter.GaussianBlur(2.2)).point(lambda v: max(0, min(255, (v - 128) * 3 + 128)))
eagle = Image.new("RGBA", alpha.size, BLUE)
eagle.putalpha(alpha)
canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
canvas.alpha_composite(layer)
canvas.alpha_composite(eagle, (k(13), k(-100)))

full = canvas.resize((1024, 1024), Image.LANCZOS)
full.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, "electron", "icon.png"))
full.save(os.path.join(ROOT, "electron", "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
full.resize((256, 256), Image.LANCZOS).save(os.path.join(ROOT, "app", "logo.png"))
full.save(os.path.join(ROOT, "tools", "icon-1024.png"))
print("ok")
