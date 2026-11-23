// Page names (labels and bookmarks; number / name / both), the current page
// highlighted in the Pages panel, press and hold to move a page with a finger,
// and the Snip tool (box and lasso, pasted at the same size, moved, saved;
// the Paste button). PDFs side by side: panes.test.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const W = process.env.WORK;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const H = require('./helpers.js')(page, cdp);
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => errs.push(`[pageerror] ${e.message}`));
  const url = `http://localhost:5180/?folder=${encodeURIComponent(W + '/lib')}`;
  await page.goto(url);
  await page.evaluate(() => { localStorage.removeItem('inkleaf:config'); });
  await page.goto(url);
  await page.waitForTimeout(800);
  const V = 'window.__inkleaf.viewer';
  const labels = () => page.evaluate(() => [...document.querySelectorAll('.pp-item')].map(e => e.querySelector('.pp-num').textContent));

  // ---- 1. Page names, and the page you're on highlighted
  await page.click('text=Drawing set');
  await page.waitForTimeout(900);
  await page.click('#btn-pages');
  await page.waitForSelector('.pp-item[data-i="3"]');
  console.log('labels (both):', JSON.stringify(await labels()), '· counter:', await page.textContent('#pagepill'));
  await page.click('.pp-head [data-act=labels]'); await page.click('.menu button:has-text("Page names")');
  const names = await labels();
  await page.click('.pp-head [data-act=labels]'); await page.click('.menu button:has-text("Page numbers")');
  console.log('names only:', JSON.stringify(names), '· numbers only:', JSON.stringify(await labels()));
  await page.click('.pp-head [data-act=labels]'); await page.click('.menu button:has-text("Numbers and names")');
  // go to a page by its name
  await page.click('#pagepill');
  await page.fill('#pagepill input', 'M-201');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const cur = await page.evaluate(() => [...document.querySelectorAll('.pp-item.current')].map(e => +e.dataset.i));
  console.log('go to "M-201": page', await page.evaluate(`${V}.currentPage() + 1`), '· highlighted in the panel:', JSON.stringify(cur), '· selection follows:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.pp-item.sel')].map(e => +e.dataset.i))), '· counter:', await page.textContent('#pagepill'));
  await page.evaluate(`${V}.goToPage(0)`);
  await page.waitForTimeout(500);
  console.log('scrolled back to page 1, highlight follows:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.pp-item.current')].map(e => +e.dataset.i))));

  // ---- 2. Press and hold a page with a finger, then drag it down two places
  const b0 = await page.locator('.pp-item[data-i="0"] .pp-thumb').boundingBox();
  const b2 = await page.locator('.pp-item[data-i="2"] .pp-thumb').boundingBox();
  const x = b0.x + b0.width / 2;
  await H.touch('touchStart', [[x, b0.y + b0.height / 2]]);
  await H.sleep(520);
  const lifted = await page.isVisible('.pp-item.lifted');
  for (let k = 1; k <= 10; k++) { await H.touch('touchMove', [[x, b0.y + b0.height / 2 + (b2.y + b2.height * 0.85 - b0.y - b0.height / 2) * k / 10]]); await H.sleep(20); }
  const dropLine = await page.isVisible('.pp-drop');
  await H.touch('touchEnd', []);
  await page.waitForFunction(() => window.__inkleaf.viewer.doc.pages[2]?.name?.startsWith('A-101'), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
  console.log('press and hold: lifted', lifted, '· drop line', dropLine, '· order now:', JSON.stringify(await page.evaluate(() => window.__inkleaf.viewer.doc.pages.map(p => p.name.split(' ')[0] || '-'))));
  // hold without moving: the page menu
  const bb = await page.locator('.pp-item[data-i="1"] .pp-thumb').boundingBox();
  await H.touch('touchStart', [[bb.x + 40, bb.y + 40]]); await H.sleep(520); await H.touch('touchEnd', []);
  await page.waitForTimeout(200);
  console.log('hold without moving opens the menu:', await page.isVisible('.menu button:has-text("Rotate right")'));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(800);
  console.log('undo puts the page back:', JSON.stringify(await page.evaluate(() => window.__inkleaf.viewer.doc.pages.map(p => p.name.split(' ')[0] || '-'))));
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(800);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.__inkleaf.viewer.dirty, null, { timeout: 10000 });
  await page.waitForTimeout(300);
  const saved = require('child_process').execFileSync('node', ['-e', `import(${JSON.stringify('/home/user/pdf-windowssurfaceviewer/app/vendor/mupdf/mupdf.js')}).then(m => { const d = m.Document.openDocument(require('fs').readFileSync(process.argv[1]), 'application/pdf'); console.log([...Array(d.countPages()).keys()].map(i => d.loadPage(i).getLabel()).join(',')); })`, W + '/lib/Drawings/Drawing set.pdf'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').pop();
  console.log('saved with the page moved: labels in the file', saved);

  // ---- 3. Snip: a box, pasted at the same size
  await page.click('text=Notes');
  await page.waitForTimeout(900);
  await page.keyboard.press('c');
  await H.pen(H.line(460, 200, 760, 330, 10));
  await page.waitForTimeout(700);
  await page.mouse.move(820, 620);
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(600);
  const scale = await page.evaluate(`${V}.scale`);
  const p1 = await page.evaluate(() => { const v = window.__inkleaf.viewer, d = v.doc.annots.get(0).at(-1); return { k: d.shape?.k, w: +(d.rect[2] - d.rect[0]).toFixed(1), h: +(d.rect[3] - d.rect[1]).toFixed(1), x: +((d.rect[0] + d.rect[2]) / 2).toFixed(0), y: +((d.rect[1] + d.rect[3]) / 2).toFixed(0), sel: v.selectedShape, tool: window.__inkleaf.cfg.tool }; });
  console.log('box snip pasted:', p1.k, `${p1.w} x ${p1.h} pt`, '(drawn', (300 / scale).toFixed(1), 'x', (130 / scale).toFixed(1) + ')', '· selected:', p1.sel, '· tool:', p1.tool);
  // move it by dragging, and make it bigger by a corner (proportions kept)
  const c0 = await page.evaluate(([x, y]) => { const v = window.__inkleaf.viewer; const [sx, sy] = v._screenOf(0, [x, y]); return [sx + v.rect.left, sy + v.rect.top]; }, [p1.x, p1.y]);
  await page.mouse.move(c0[0], c0[1]); await page.mouse.down(); await page.mouse.move(c0[0] - 120, c0[1] + 60, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(300);
  const se = await page.locator('.shape-sel .ss-h.se').boundingBox();
  await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2); await page.mouse.down(); await page.mouse.move(se.x + 60, se.y + 40, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(400);
  const p2 = await page.evaluate(() => { const d = window.__inkleaf.viewer.doc.annots.get(0).at(-1); return { w: d.rect[2] - d.rect[0], h: d.rect[3] - d.rect[1], x: (d.rect[0] + d.rect[2]) / 2 }; });
  console.log('moved left:', p2.x < p1.x - 40, '· resized bigger with the same proportions:', p2.w > p1.w && Math.abs(p2.w / p2.h - p1.w / p1.h) < 0.02);
  // lasso: transparent outside the shape
  await page.keyboard.press('c');
  const loop = []; for (let k = 0; k <= 40; k++) { const t = (k / 40) * 2 * Math.PI; loop.push([600 + 90 * Math.cos(t), 470 + 60 * Math.sin(t)]); }
  await H.pen(loop);
  await page.waitForTimeout(700);
  await page.mouse.move(700, 760);
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(600);
  const lasso = await page.evaluate(async () => {
    const d = window.__inkleaf.viewer.doc.annots.get(0).at(-1);
    const bm = await createImageBitmap(new Blob([d.png], { type: 'image/png' }));
    const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bm, 0, 0);
    return { corner: g.getImageData(1, 1, 1, 1).data[3], middle: g.getImageData(bm.width >> 1, bm.height >> 1, 1, 1).data[3], px: [bm.width, bm.height] };
  });
  console.log('lasso snip: corner transparent', lasso.corner === 0, '· inside solid', lasso.middle === 255, '· sharp:', lasso.px[0] >= 2 * 180 / scale);
  // without a keyboard: the Paste button on the "Copied" message
  await page.keyboard.press('c');
  await H.pen(H.line(460, 200, 640, 280, 8));
  const btn = page.locator('.toast .toast-act', { hasText: 'Paste' });
  await page.waitForFunction(() => document.querySelectorAll('.toast-act').length === 1, null, { timeout: 3000 });
  await btn.waitFor({ timeout: 3000 });
  const nBefore = await page.evaluate(() => window.__inkleaf.viewer.doc.annots.get(0).length);
  await btn.click();
  await page.waitForTimeout(600);
  const tp = await page.evaluate(() => {
    const v = window.__inkleaf.viewer, d = v.doc.annots.get(0).at(-1), c = v.pastePoint(true);
    return { n: v.doc.annots.get(0).length, k: d.shape?.k, dx: Math.abs((d.rect[0] + d.rect[2]) / 2 - c.p[0]), dy: Math.abs((d.rect[1] + d.rect[3]) / 2 - c.p[1]) };
  });
  console.log('Paste button on the message: pasted', tp.n === nBefore + 1 && tp.k === 'image', '· in the middle of the view', tp.dx < 2 && tp.dy < 2);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.__inkleaf.viewer.dirty, null, { timeout: 10000 });
  await page.evaluate(async () => { const I = window.__inkleaf; await I.openFile(I.state.path, { force: true }); });
  await page.waitForTimeout(1000);
  const imgs = execFileSync('pdfimages', ['-list', W + '/lib/Notes.pdf']).toString().split('\n').filter(l => /^\s*\d+\s+\d+\s+(image|smask)/.test(l)).length;
  console.log('saved and reopened: pictures', await page.evaluate(() => window.__inkleaf.viewer.doc.annots.get(0).filter(a => a.shape?.k === 'image').length), '· images in the file (with masks):', imgs);

  await page.screenshot({ path: W + '/snip.png' });
  console.log(errs.length ? errs.join('\n') : 'no errors');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
