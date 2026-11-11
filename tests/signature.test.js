// Signatures: prepare (background removal), place, move, resize, tap-to-place,
// adjust, eraser + undo, save, transparency in another PDF engine, folder list.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const W = process.env.WORK;

// Read a binary PPM (P6) from pdftoppm.
function readPPM(file) {
  const b = fs.readFileSync(file);
  let pos = 0;
  const tok = () => { while (/\s/.test(String.fromCharCode(b[pos]))) pos++; let s = ''; while (!/\s/.test(String.fromCharCode(b[pos]))) s += String.fromCharCode(b[pos++]); return s; };
  if (tok() !== 'P6') throw new Error('not P6');
  const w = +tok(), h = +tok(); tok(); pos++;
  return { w, h, px: (x, y) => { const k = pos + (y * w + x) * 3; return [b[k], b[k + 1], b[k + 2]]; } };
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const H = require('./helpers.js')(page, cdp);
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => errs.push(`[pageerror] ${e.message}`));
  await page.goto(`http://localhost:5180/?folder=${encodeURIComponent(W + '/lib')}`);
  await page.waitForTimeout(800);
  await page.evaluate(() => localStorage.removeItem('inkleaf:signatures'));

  // A phone photo of a signature: dark blue ink on off-white, slightly uneven paper, saved as JPEG.
  fs.mkdirSync(W + '/sigs', { recursive: true });
  const sigPath = W + '/sigs/my signature.jpg';
  await page.evaluate(async (p) => {
    const c = new OffscreenCanvas(600, 220), g = c.getContext('2d');
    g.fillStyle = 'rgb(242,238,229)'; g.fillRect(0, 0, 600, 220);
    for (let i = 0; i < 4000; i++) { g.fillStyle = `rgba(200,195,185,${Math.random() * 0.25})`; g.fillRect(Math.random() * 600, Math.random() * 220, 2, 2); }
    g.strokeStyle = 'rgb(25,35,95)'; g.lineWidth = 6; g.lineCap = 'round'; g.beginPath();
    for (let t = 0; t < 100; t++) { const x = 40 + t * 5, y = 115 + 45 * Math.sin(t / 6) * Math.cos(t / 17); t ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke(); g.lineWidth = 4; g.beginPath(); g.moveTo(80, 170); g.lineTo(520, 150); g.stroke();
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
    await fetch('/api/write?p=' + encodeURIComponent(p), { method: 'POST', body: blob });
  }, sigPath);

  await page.click('text=Quarterly summary');
  await page.waitForTimeout(900);
  const stamps = () => page.evaluate(() => (window.__inkleaf.viewer.doc.annots.get(0) || []).filter(a => a.shape && a.shape.k === 'sig').map(a => a.rect.map(Math.round)));

  // 1. Prepare: automatic background removal, then a stronger setting.
  page.evaluate((p) => { window.__inkleaf.prepareSignature(p); }, sigPath);
  await page.waitForSelector('.sigprep canvas');
  await page.waitForTimeout(200);
  const auto = await page.$eval('#sp-strength', (e) => +e.value);
  const prev = await page.$eval('#sp-canvas', (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let clear = 0, ink = 0;
    for (let k = 3; k < d.length; k += 4) { if (d[k] === 0) clear++; else if (d[k] > 200) ink++; }
    return { clear: +(clear / (d.length / 4)).toFixed(2), ink: +(ink / (d.length / 4)).toFixed(3) };
  });
  console.log('auto strength:', auto, 'preview: transparent', prev.clear, 'solid ink', prev.ink);
  await page.$eval('#sp-strength', (e) => { e.value = 45; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.check('input[name="sp-bg"][value="white"]');
  await page.screenshot({ path: W + '/sig-prepare.png' });
  await page.click('.dialog .btn.primary');
  await page.waitForSelector('.sig-place');
  console.log('placing:', await page.isVisible('.placebar'), 'library:', await page.evaluate(() => window.__inkleaf.sigs().length));

  // 2. Move by dragging, resize by the bottom-right corner (keeps proportions), Place.
  let b = await page.locator('.sig-place').boundingBox();
  const ratio0 = b.height / b.width;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 120, b.y + b.height / 2 + 160, { steps: 6 }); await page.mouse.up();
  b = await page.locator('.sig-place').boundingBox();
  await page.mouse.move(b.x + b.width, b.y + b.height); await page.mouse.down();
  await page.mouse.move(b.x + b.width + 80, b.y + b.height + 10, { steps: 6 }); await page.mouse.up();
  const b2 = await page.locator('.sig-place').boundingBox();
  console.log('resized wider:', Math.round(b.width), '->', Math.round(b2.width), 'proportions kept:', Math.abs(b2.height / b2.width - ratio0) < 0.02);
  await page.screenshot({ path: W + '/sig-placing.png' });
  await page.click('.placebar [data-act=place]');
  await page.waitForTimeout(300);
  console.log('placed:', JSON.stringify(await stamps()));

  // 3. Signature tool: tap the page to place the last signature there (Enter = Place).
  await H.tap(700, 700);
  await page.waitForSelector('.sig-place');
  const sz = await page.locator('.sig-place').boundingBox();
  console.log('tap places last signature, same size:', Math.abs(sz.width - b2.width) < 2);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  console.log('two signatures:', (await stamps()).length);

  // 4. Tap a placed signature to adjust it; move it; Place; undo restores it.
  const before = (await stamps())[0];
  const C = await page.evaluate((r) => { const v = window.__inkleaf.viewer; const [x, y] = v._screenOf(0, [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]); return [x + v.rect.left, y + v.rect.top]; }, before);
  await H.tap(C[0], C[1]);
  await page.waitForSelector('.sig-place');
  b = await page.locator('.sig-place').boundingBox();
  await page.mouse.move(b.x + 20, b.y + 10); await page.mouse.down();
  await page.mouse.move(b.x - 60, b.y + 10, { steps: 5 }); await page.mouse.up();
  await page.click('.placebar [data-act=place]');
  await page.waitForTimeout(300);
  const moved = await stamps();
  console.log('adjusted (moved left):', moved.length === 2 && !moved.some(r => r[0] === before[0] && r[1] === before[1]));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  console.log('undo puts it back:', (await stamps()).some(r => r[0] === before[0] && r[1] === before[1]));

  // 5. Eraser removes a signature; undo brings it back.
  const last = (await stamps())[1];
  const E = await page.evaluate((r) => { const v = window.__inkleaf.viewer; const [x, y] = v._screenOf(0, [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]); return [x + v.rect.left, y + v.rect.top]; }, last);
  await H.pen(H.line(E[0] - 10, E[1], E[0] + 10, E[1], 4), { eraser: true });
  await page.waitForTimeout(200);
  const afterErase = (await stamps()).length;
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  console.log('eraser:', afterErase, 'undo:', (await stamps()).length);

  // 6. Save, then check the saved PDF in Poppler: ink is dark, the paper is gone.
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.__inkleaf.viewer.dirty, null, { timeout: 8000 });
  const pdf = W + '/lib/Reports/Q3/Quarterly summary.pdf';
  execFileSync('pdftoppm', ['-r', '72', '-f', '1', '-l', '1', pdf, W + '/sig-poppler']);
  const img = readPPM(W + '/sig-poppler-1.ppm');
  const r = (await stamps())[0];
  let paper = 0, dark = 0, white = 0, n = 0;
  for (let y = Math.ceil(r[1]); y < Math.floor(r[3]); y++) for (let x = Math.ceil(r[0]); x < Math.floor(r[2]); x++) {
    const [R, G, B] = img.px(x, y); n++;
    if (Math.abs(R - 242) < 6 && Math.abs(G - 238) < 6 && Math.abs(B - 229) < 6) paper++;
    if (R > 248 && G > 248 && B > 248) white++;
    if (B > R + 25 && R < 110) dark++;
  }
  console.log(`saved PDF in Poppler, signature area: paper-coloured ${(100 * paper / n).toFixed(1)}%, page-white ${(100 * white / n).toFixed(0)}%, blue ink ${(100 * dark / n).toFixed(1)}%`);

  // 7. Signatures folder: images there show up in the panel.
  await page.evaluate((d) => { window.__inkleaf.cfg.sigFolder = d; }, W + '/sigs');
  await page.click('.tool[data-tool=sign]');
  await page.waitForSelector('#sig-folder .sig-item img[src]', { timeout: 8000 });
  console.log('panel: my signatures', await page.locator('#sig-mine .sig-item').count(), 'folder images', await page.locator('#sig-folder .sig-item').count());
  await page.screenshot({ path: W + '/sig-panel.png' });
  await page.keyboard.press('Escape');

  // 8. Reload: signatures come back from the file and can still be adjusted.
  await page.evaluate(async () => { const I = window.__inkleaf; await I.openFile(I.state.path, { force: true }); });
  await page.waitForTimeout(900);
  const loaded = await stamps();
  console.log('reloaded signatures:', loaded.length);
  await page.evaluate(() => { const v = window.__inkleaf.viewer; const d = v.doc.annots.get(0).find(a => a.shape && a.shape.k === 'sig'); v.adjustSignature(0, d); });
  await page.waitForSelector('.sig-place');
  console.log('loaded signature can be adjusted:', await page.isVisible('.sig-place img'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  console.log('escape cancels, nothing changed:', !(await page.isVisible('.sig-place')) && !(await page.evaluate(() => window.__inkleaf.viewer.dirty)));
  console.log(errs.length ? errs.join('\n') : 'no errors');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
