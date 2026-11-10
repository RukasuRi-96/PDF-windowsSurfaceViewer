const { chromium } = require('playwright');
const SP = process.env.WORK;
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: true });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => { if (m.type() !== 'log') logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  const cdp = await ctx.newCDPSession(page);
  const H = require('./helpers.js')(page, cdp);
  await page.goto(`http://localhost:5180/?folder=${encodeURIComponent(SP + '/lib')}`);
  await page.waitForTimeout(800);
  await page.click('text=Appendix A');
  await page.waitForTimeout(800);
  const st = () => page.evaluate(() => { const v = window.__inkleaf.viewer; return { scale: +v.scale.toFixed(3), sx: Math.round(v.sx), sy: Math.round(v.sy), page: v.currentPage(), annots: [...v.doc.annots.values()].reduce((a, l) => a + l.length, 0), dirty: v.dirty, tiles: v.tileCount }; });
  console.log('open', JSON.stringify(await st()));
  // Pen stroke (a squiggle) on page 1
  await page.keyboard.press('p');
  const sq = []; for (let i = 0; i <= 40; i++) sq.push([500 + i * 8, 600 + Math.sin(i / 3) * 25]);
  await H.pen(sq);
  // Highlight over text line 2 (text at y ~ 292 in screen at this zoom)
  await page.keyboard.press('m');
  await H.pen(H.line(430, 292, 900, 292, 25));
  await page.waitForTimeout(150);
  // Marker in margin (no text there)
  await H.pen(H.line(340, 700, 400, 820, 15));
  // Box
  await page.keyboard.press('b');
  await H.pen(H.line(1000, 450, 1250, 560, 10));
  await page.waitForTimeout(300);
  console.log('after draw', JSON.stringify(await st()));
  await page.screenshot({ path: SP + '/s3-annots.png' });
  // Eraser over the squiggle using pen barrel button
  await H.pen(H.line(620, 560, 620, 650, 10), { eraser: true });
  await page.waitForTimeout(200);
  console.log('after erase', JSON.stringify(await st()));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  console.log('after undo', JSON.stringify(await st()));
  await page.screenshot({ path: SP + '/s4-undo.png' });
  // Save
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(1000);
  console.log('after save', JSON.stringify(await st()));
  // Pinch zoom in around (900, 450)
  await page.keyboard.press('h');
  await H.pinch(900, 450, 100, 300, 12);
  await page.waitForTimeout(600);
  console.log('after pinch', JSON.stringify(await st()));
  await page.screenshot({ path: SP + '/s5-pinch.png' });
  // Touch pan + fling up
  await H.swipe(900, 700, 900, 300, 8, 12);
  await page.waitForTimeout(1200);
  console.log('after fling', JSON.stringify(await st()));
  // double tap -> fit width
  await H.tap(800, 400); await page.waitForTimeout(80); await H.tap(800, 400);
  await page.waitForTimeout(700);
  console.log('after dbltap', JSON.stringify(await st()));
  await page.screenshot({ path: SP + '/s6-dbltap.png' });
  console.log(logs.join('\n'));
  await browser.close();
})();
