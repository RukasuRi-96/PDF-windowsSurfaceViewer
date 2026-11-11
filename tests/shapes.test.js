// Box tool shapes: box, line, arrow, cloud, text and callout; eraser, undo, save and reload.
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
  await page.goto(`http://localhost:5180/?folder=${encodeURIComponent(W + '/lib')}`);
  await page.waitForTimeout(800);
  await page.click('text=Appendix A');
  await page.waitForTimeout(900);
  const shapes = () => page.evaluate(() => (window.__inkleaf.viewer.doc.annots.get(0) || []).map(a => a.shape ? a.shape.k : a.type));
  const choose = async (k) => {
    await page.click('.tool[data-tool=box] [data-caret]');
    await page.waitForTimeout(120);
    await page.click(`.shapes [data-shape=${k}]`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
  };

  await page.keyboard.press('b');
  console.log('box tool icon has caret:', await page.isVisible('.tool[data-tool=box] .caret'));
  await H.pen(H.line(450, 180, 700, 230, 8));                  // box
  await choose('line');  await H.pen(H.line(450, 300, 750, 300, 8));
  await choose('arrow'); await H.pen(H.line(450, 360, 650, 440, 8));
  await choose('cloud'); await H.pen(H.line(800, 300, 1050, 420, 8));
  // Text: tap, type, Done
  await choose('text');
  await H.pen([[460, 520], [460, 520]]);
  await page.waitForSelector('.text-edit textarea');
  await page.keyboard.type('Plain text note'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('second line');
  await page.click('.te-bar [data-act=done]');
  // Callout: drag from the point being marked to where the text goes, type, Ctrl+Enter
  await choose('callout');
  await H.pen(H.line(700, 650, 900, 560, 8));
  await page.waitForSelector('.text-edit textarea');
  console.log('callout leader preview while typing:', await page.evaluate(() => document.querySelectorAll('.annots.ink g:last-child path').length > 0));
  await page.keyboard.type('Check this dimension with the site team before issue');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(400);
  console.log('after drawing:', JSON.stringify(await shapes()));
  const fromMupdf = await page.evaluate(() => (window.__inkleaf.viewer.doc.annots.get(0) || []).filter(a => a.shape).map(a => `${a.shape.k}:${!!a.svg}`));
  console.log('drawn from MuPDF SVG:', fromMupdf.join(' '));
  const fitted = await page.evaluate(() => { const c = window.__inkleaf.viewer.doc.annots.get(0).find(a => a.shape && a.shape.k === 'callout'); return { lines: Math.round((c.rect[3] - c.rect[1] - 2 * c.width - 3) / (c.size * 1.2)), rect: c.rect.map(Math.round) }; });
  console.log('callout box fitted to wrapped text:', JSON.stringify(fitted));
  await page.screenshot({ path: W + '/shapes.png' });

  // Eraser over the arrow, then undo
  await H.pen(H.line(540, 380, 560, 420, 6), { eraser: true });
  await page.waitForTimeout(150);
  console.log('after erasing arrow:', JSON.stringify(await shapes()));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  console.log('after undo:', JSON.stringify(await shapes()));
  // Escape cancels a text box, and an empty one adds nothing
  await choose('text');
  await H.pen([[460, 760], [460, 760]]);
  await page.waitForSelector('.text-edit textarea');
  await page.keyboard.type('discard me');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  console.log('escape cancels text box:', (await shapes()).length === 6 && !(await page.isVisible('.text-edit')));

  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.__inkleaf.viewer.dirty, null, { timeout: 8000 });
  await page.evaluate(async () => { const I = window.__inkleaf; await I.openFile(I.state.path, { force: true }); });
  await page.waitForTimeout(900);
  console.log('reloaded:', JSON.stringify(await shapes()));
  const text = await page.evaluate(() => window.__inkleaf.viewer.doc.annots.get(0).filter(a => a.text).map(a => a.text));
  console.log('text kept:', JSON.stringify(text));
  const pdf = W + '/lib/Reports/Q3/Appendix A.pdf';
  execFileSync('pdftoppm', ['-r', '60', '-f', '1', '-l', '1', '-png', pdf, W + '/shapes-poppler']);
  console.log('poppler render: shapes-poppler-1.png');
  console.log(errs.length ? errs.join('\n') : 'no errors');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
