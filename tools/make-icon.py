# Draws the Inkleaf icon: gradient tile, white page, yellow highlighter stroke, ink line.
import sys
from PIL import Image, ImageDraw, ImageFilter
S = 1024
def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
grad = Image.new("RGB", (S, S))
px = grad.load()
c0, c1 = (58, 123, 255), (123, 92, 255)
for y in range(S):
    for x in range(S):
        px[x, y] = lerp(c0, c1, (x + y) / (2 * S))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=230, fill=255)
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)
# page with shadow
sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(sh).rounded_rectangle([300, 210, 724, 820], radius=40, fill=(20, 20, 60, 110))
sh = sh.filter(ImageFilter.GaussianBlur(22))
img.alpha_composite(sh, (10, 18))
d = ImageDraw.Draw(img)
d.rounded_rectangle([300, 200, 724, 810], radius=40, fill=(255, 255, 255, 255))
for i, w in enumerate([300, 250, 320, 210]):
    y = 300 + i * 70
    d.rounded_rectangle([360, y, 360 + w, y + 22], radius=11, fill=(200, 206, 222, 255))
# highlighter stroke
hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(hl).rounded_rectangle([340, 572, 700, 640], radius=30, fill=(255, 214, 40, 235))
hl = hl.rotate(14, center=(520, 606), resample=Image.BICUBIC)
img.alpha_composite(hl)
# ink squiggle
d = ImageDraw.Draw(img)
pts = [(372, 720), (430, 690), (480, 735), (540, 692), (600, 735), (650, 700)]
d.line(pts, fill=(30, 64, 175, 255), width=26, joint="curve")
for p in (pts[0], pts[-1]):
    d.ellipse([p[0] - 13, p[1] - 13, p[0] + 13, p[1] + 13], fill=(30, 64, 175, 255))
out = sys.argv[1]
img.resize((512, 512), Image.LANCZOS).save(out + "/icon.png")
img.save(out + "/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("ok")
