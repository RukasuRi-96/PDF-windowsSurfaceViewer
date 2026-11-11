// Turning a photo or scan of a signature into a clean, transparent PNG.
//
// The paper colour is estimated from the image border; every pixel's alpha
// comes from how far its colour is from the paper (with a soft edge so
// strokes stay smooth). The threshold is picked automatically (Otsu's method)
// and the user can push it either way with a slider.

const MAX_SIDE = 1600;     // working resolution
const OUT_MAX_W = 1000;    // stored width: plenty for a ~5 cm signature

export const INKS = { original: null, black: [20, 20, 24], blue: [24, 52, 160] };

// Decode an image file and scale it to the working size.
export async function loadSignatureImage(blob) {
  const bmp = await createImageBitmap(blob);
  const f = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * f)), h = Math.max(1, Math.round(bmp.height * f));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return ctx.getImageData(0, 0, w, h);
}

function median(arr) {
  const a = Array.from(arr).sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : 255;
}

// Paper colour, whether the image is already transparent, and an automatic
// threshold.
export function analyzeSignature(img) {
  const { width: w, height: h, data } = img;
  const ring = Math.max(1, Math.round(Math.min(w, h) * 0.02));
  const rs = [], gs = [], bs = [];
  let transparent = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      if (data[k + 3] < 250) transparent++;
      if (x < ring || y < ring || x >= w - ring || y >= h - ring) {
        if ((x + y) % 3 === 0 && data[k + 3] > 200) { rs.push(data[k]); gs.push(data[k + 1]); bs.push(data[k + 2]); }
      }
    }
  }
  const bg = rs.length ? [median(rs), median(gs), median(bs)] : [255, 255, 255];
  const hasAlpha = transparent > w * h * 0.02;
  // Otsu on the distance-from-paper histogram.
  const hist = new Float64Array(256);
  for (let k = 0; k < data.length; k += 4) {
    if (data[k + 3] < 128) continue;
    hist[dist(data, k, bg)]++;
  }
  let total = 0, sum = 0;
  for (let t = 0; t < 256; t++) { total += hist[t]; sum += t * hist[t]; }
  let wB = 0, sB = 0, best = 0, otsu = 60;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; otsu = t; }
  }
  // Slider value 0..100: the cut sits a little below Otsu's split, so faint
  // ends of strokes survive; an already transparent PNG starts at 0.
  const auto = hasAlpha ? 0 : Math.round(Math.min(95, Math.max(8, (otsu * 0.7) / 2.2)));
  return { bg, hasAlpha, auto };
}

function dist(d, k, bg) {
  return Math.max(Math.abs(d[k] - bg[0]), Math.abs(d[k + 1] - bg[1]), Math.abs(d[k + 2] - bg[2]));
}

// Remove the background. strength: 0 (keep everything) .. 100 (only the
// darkest ink). Returns the processed image and the bounding box of the ink.
export function removeBackground(img, { bg, strength, ink }) {
  const { width: w, height: h, data } = img;
  const out = new ImageData(w, h);
  const o = out.data;
  const T = strength * 2.2;
  const half = Math.max(10, T * 0.25);
  const lo = T - half, hi = T + half;
  const inkRGB = INKS[ink] || null;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      let a = 1;
      if (strength > 0) {
        const d = dist(data, k, bg);
        a = d <= lo ? 0 : d >= hi ? 1 : (d - lo) / (hi - lo);
      }
      a *= data[k + 3] / 255;
      if (a <= 0.004) { o[k + 3] = 0; continue; }
      if (inkRGB) {
        o[k] = inkRGB[0]; o[k + 1] = inkRGB[1]; o[k + 2] = inkRGB[2];
      } else if (strength > 0 && a < 1) {
        // Undo the paper showing through anti-aliased edges.
        for (let c = 0; c < 3; c++) o[k + c] = Math.max(0, Math.min(255, Math.round(bg[c] + (data[k + c] - bg[c]) / a)));
      } else {
        o[k] = data[k]; o[k + 1] = data[k + 1]; o[k + 2] = data[k + 2];
      }
      o[k + 3] = Math.round(a * 255);
      if (o[k + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const box = x1 >= 0 ? [x0, y0, x1 + 1, y1 + 1] : null;
  return { image: out, box };
}

// Crop to the ink (plus a small margin), cap the width, encode as PNG.
export async function signaturePng(image, box) {
  if (!box) throw new Error("No signature found. Lower the background removal and try again.");
  const m = Math.round(Math.max(box[2] - box[0], box[3] - box[1]) * 0.03) + 2;
  const sx = Math.max(0, box[0] - m), sy = Math.max(0, box[1] - m);
  const sw = Math.min(image.width, box[2] + m) - sx, sh = Math.min(image.height, box[3] + m) - sy;
  const src = new OffscreenCanvas(image.width, image.height);
  src.getContext("2d").putImageData(image, 0, 0);
  const f = Math.min(1, OUT_MAX_W / sw);
  const w = Math.max(1, Math.round(sw * f)), h = Math.max(1, Math.round(sh * f));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  const blob = await c.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, w, h, dataUrl: "data:image/png;base64," + toBase64(bytes) };
}

export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromDataUrl(url) {
  const bin = atob(url.slice(url.indexOf(",") + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp)$/i;
export function imageMime(name) {
  const e = (name.match(IMAGE_EXT) || [])[1]?.toLowerCase();
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp" }[e] || "application/octet-stream";
}
