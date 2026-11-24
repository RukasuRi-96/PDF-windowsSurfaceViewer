// The Pages panel's sizes: the page-size slider and its buttons, Ctrl+wheel
// and a two-finger pinch over the pages; sharper thumbnails when bigger; the
// panel's width from its edge (double-click resets); a grid of several
// columns when the pages are small or the panel wide, with drag-and-drop and
// arrow keys in the grid; the small grip, still easy to hit; both sizes kept
// after a restart.
const { chromium } = require('playwright');
const W = process.env.WORK;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1290, height: 860 }, deviceScaleFactor: 1, hasTouch: true });
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
  await page.click('text=Drawing set');
  await page.waitForTimeout(900);
  await page.click('#btn-pages');
  await page.waitForSelector('.pp-item[data-i="3"] canvas');

  const P = () => page.evaluate(() => { const p = window.__inkleaf.pagesPanel, t = document.querySelector('.pp-item[data-i="0"] .pp-thumb').getBoundingClientRect(); return { w: p.thumbW, cols: p.cols, thumb: Math.round(t.width), panel: Math.round(document.querySelector('#rpanel').getBoundingClientRect().width) }; });
  const names = () => page.evaluate(() => window.__inkleaf.viewer.doc.pages.map(p => (p.name || '-').split(' ')[0]));
  const s0 = await P();
  // the grip: small to see, big to hit
  const g = await page.locator('.pp-item[data-i="0"] .pp-grip').boundingBox();
  const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.pp-grip'), [g.x + g.width / 2 - 14, g.y + g.height / 2 + 12]);
  console.log('default: pages', s0.w, 'px wide, one column', s0.cols === 1, '· panel', s0.panel, 'px · grip', Math.round(g.width), 'x', Math.round(g.height), 'px, a finger 14 px off still hits it', hit);

  // the slider: bigger pages, drawn sharper
  await page.locator('.pp-size input').fill('220');
  await page.waitForTimeout(200);
  const s1 = await P();
  await page.waitForFunction(() => { const c = document.querySelector('.pp-item[data-i="0"] canvas'); return c && c.width >= 220 * 0.85; }, null, { timeout: 8000 }).catch(() => {});
  const sharp = await page.evaluate(() => document.querySelector('.pp-item[data-i="0"] canvas').width);
  console.log('slider to 220: pages', s1.thumb, 'px wide · drawn again sharper:', sharp, 'px');
  await page.click('.pp-size [data-act=smaller]');
  await page.waitForTimeout(150);
  console.log('the − button: smaller', (await P()).w);
  // Ctrl+wheel over the pages
  const lb = await page.locator('.pp-list').boundingBox();
  await page.mouse.move(lb.x + lb.width / 2, lb.y + 200);
  const w0 = (await P()).w;
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 400);
  await page.keyboard.up('Control');
  await page.waitForTimeout(400);
  const w1 = (await P()).w;
  console.log('Ctrl+wheel down: smaller', w0, '→', w1, w1 < w0, '· the page view did not zoom', await page.evaluate(() => Math.abs(window.__inkleaf.viewer.scale - window.__inkleaf.viewer._fitScale('width', 0)) < 0.01));
  // a two-finger pinch over the pages
  const cx = lb.x + lb.width / 2, cy = lb.y + 300;
  const cur0 = await page.evaluate(() => window.__inkleaf.viewer.currentPage());
  await H.touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
  for (let k = 1; k <= 10; k++) { await H.touch('touchMove', [[cx - 30 - 6 * k, cy], [cx + 30 + 6 * k, cy]]); await H.sleep(20); }
  await H.touch('touchEnd', []);
  await page.waitForTimeout(400);
  const w2 = (await P()).w;
  console.log('pinch out with two fingers: bigger', w1, '→', w2, w2 > w1 * 1.4, '· no page opened by it', (await page.evaluate(() => window.__inkleaf.viewer.currentPage())) === cur0);

  // the panel's width, from its edge
  const edge = await page.locator('#rpanel .rp-resize').boundingBox();
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 300); await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - 220, edge.y + 300, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(300);
  const s3 = await P();
  console.log('dragged the panel edge 220 px: panel', s0.panel, '→', s3.panel);
  // small pages in a wide panel: a grid
  await page.locator('.pp-size input').fill('80');
  await page.waitForTimeout(400);
  const s4 = await P();
  const rects = await page.evaluate(() => [0, 1, 2, 3].map(i => { const r = document.querySelector(`.pp-item[data-i="${i}"]`).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; }));
  console.log('small pages, wide panel: columns', s4.cols, '· pages side by side', rects[1][1] === rects[0][1] && rects[1][0] > rects[0][0]);
  // drag page 1 after page 3 in the grid (mouse)
  const before = await names();
  const a = await page.locator('.pp-item[data-i="0"] .pp-thumb').boundingBox();
  const c3 = await page.locator('.pp-item[data-i="2"] .pp-thumb').boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(c3.x + c3.width * 0.8, c3.y + c3.height / 2, { steps: 10 });
  const vline = await page.evaluate(() => { const d = document.querySelector('.pp-drop'); return !d.hidden && d.classList.contains('v'); });
  await page.mouse.up();
  await page.waitForFunction((b) => JSON.stringify(window.__inkleaf.viewer.doc.pages.map(p => (p.name || '-').split(' ')[0])) !== b, JSON.stringify(before), { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  console.log('grid drag page 1 after page 3: an upright drop line', vline, '·', JSON.stringify(before), '→', JSON.stringify(await names()));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(800);
  // arrow keys in the grid
  await page.click('.pp-item[data-i="0"] .pp-thumb');
  await page.keyboard.press('ArrowRight');
  const right = await page.evaluate(() => window.__inkleaf.pagesPanel.selected());
  await page.keyboard.press('ArrowLeft');
  console.log('arrow keys in the grid: → selects', JSON.stringify(right), '· ← back', JSON.stringify(await page.evaluate(() => window.__inkleaf.pagesPanel.selected())));

  // kept after a restart
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector('.pp-item[data-i="0"]', { timeout: 10000 });
  await page.waitForTimeout(400);
  const s5 = await P();
  console.log('after a restart: pages', s5.w, 'px, panel', s5.panel, 'px, columns', s5.cols, '· same', s5.w === s4.w && s5.panel === s4.panel);
  // double-click the edge: normal width
  const edge2 = await page.locator('#rpanel .rp-resize').boundingBox();
  await page.mouse.dblclick(edge2.x + edge2.width / 2, edge2.y + 300);
  await page.waitForTimeout(300);
  console.log('double-click the edge: panel back to', (await P()).panel, 'px');
  await page.screenshot({ path: W + '/thumbs.png' });
  console.log(errs.length ? errs.join('\n') : 'no errors');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
