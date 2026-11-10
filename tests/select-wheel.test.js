// New features: wheel zoom/scroll, middle-drag pan, text selection + copy.
const { chromium } = require('playwright');
const OLD = process.env.WORK, SP = process.env.WORK;
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:5180' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => errs.push(`[pageerror] ${e.message}`));
  await page.goto(`http://localhost:5180/?folder=${encodeURIComponent(OLD + '/lib')}`);
  await page.waitForTimeout(800);
  await page.click('text=Quarterly summary');
  await page.waitForTimeout(900);
  const st = () => page.evaluate(() => { const v = window.__inkleaf.viewer; return { tool: v.tool, scale: +v.scale.toFixed(3), sx: Math.round(v.sx), sy: Math.round(v.sy), annots: [...v.doc.annots.values()].reduce((a, l) => a + l.length, 0) }; });
  // client point of a page point
  const C = (i, x, y) => page.evaluate(([i, x, y]) => { const v = window.__inkleaf.viewer; const [sx, sy] = v._screenOf(i, [x, y]); return [sx + v.rect.left, sy + v.rect.top]; }, [i, x, y]);
  const P = (cx, cy) => page.evaluate(([cx, cy]) => { const v = window.__inkleaf.viewer; return v._clientToPage(0, cx, cy).map(n => +n.toFixed(2)); }, [cx, cy]);
  console.log('default tool:', (await st()).tool);

  // ---- 1. wheel: scroll mode (default)
  let s0 = await st();
  await page.mouse.move(800, 450);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(300);
  let s1 = await st();
  console.log('wheel(scroll mode): dy', s1.sy - s0.sy, 'scale same', s1.scale === s0.scale);
  // switch to zoom via the ⋯ menu
  await page.click('#btn-more');
  await page.click('text=Mouse wheel zooms');
  await page.waitForTimeout(200);
  await page.mouse.move(800, 450);
  const before = await P(800, 450);
  s0 = await st();
  await page.mouse.wheel(0, -100);   // one notch up = zoom in
  await page.waitForTimeout(400);
  s1 = await st();
  const after = await P(800, 450);
  console.log('wheel(zoom mode): scale', s0.scale, '->', s1.scale, 'point under cursor', JSON.stringify(before), '->', JSON.stringify(after));
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(400);
  console.log('wheel down zooms out to', (await st()).scale);
  s0 = await st();
  await page.keyboard.down('Shift'); await page.mouse.wheel(0, 200); await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
  s1 = await st();
  console.log('shift+wheel in zoom mode scrolls: dy', s1.sy - s0.sy, 'scale same', s1.scale === s0.scale);
  console.log('cfg.wheel saved:', await page.evaluate(() => window.__inkleaf.cfg.wheel));
  // back to scroll mode for the rest
  await page.click('#btn-more'); await page.click('text=Mouse wheel scrolls');
  await page.evaluate(() => window.__inkleaf.viewer.fit('width'));
  await page.evaluate(() => window.__inkleaf.viewer.scrollTo(0, 0));
  await page.waitForTimeout(300);

  // ---- 2. middle-button drag pans (in select and pen tools), no annotations made
  await page.keyboard.press('p');
  await page.evaluate(() => window.__inkleaf.viewer.zoomBy(2));
  await page.waitForTimeout(300);
  s0 = await st();
  await page.mouse.move(900, 600);
  await page.mouse.down({ button: 'middle' });
  const panCls = await page.evaluate(() => document.querySelector('.viewer').classList.contains('panning'));
  for (let k = 1; k <= 10; k++) { await page.mouse.move(900 - 25 * k, 600 - 20 * k); await page.waitForTimeout(10); }
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(150);
  s1 = await st();
  console.log('middle-drag (pen tool): dx', s1.sx - s0.sx, 'dy', s1.sy - s0.sy, 'panning cursor', panCls, 'annots added', s1.annots - s0.annots);
  await page.evaluate(() => window.__inkleaf.viewer.fit('width'));
  await page.evaluate(() => window.__inkleaf.viewer.scrollTo(0, 0));
  await page.keyboard.press('v');
  await page.waitForTimeout(400);

  // ---- 3. text selection
  const lines = await page.evaluate(async () => Array.from(await window.__inkleaf.engine.textLines(0)));
  const L = []; for (let k = 0; k < lines.length; k += 4) L.push(lines.slice(k, k + 4));
  L.sort((a, b) => a[1] - b[1]);
  const l1 = L[1], l2 = L[2], l3 = L[3];  // L[0] is the title
  const a = await C(0, l1[0] + 1, (l1[1] + l1[3]) / 2), b = await C(0, l3[0] + 120, (l3[1] + l3[3]) / 2);
  await page.mouse.move(a[0], a[1]);
  const cursor = await page.evaluate(() => getComputedStyle(document.querySelector('.viewer')).cursor);
  await page.mouse.down();
  for (let k = 1; k <= 12; k++) { await page.mouse.move(a[0] + (b[0] - a[0]) * k / 12, a[1] + (b[1] - a[1]) * k / 12); await page.waitForTimeout(12); }
  await page.mouse.up();
  await page.waitForTimeout(300);
  let sel = await page.evaluate(() => ({ text: window.__inkleaf.viewer.sel?.text, bar: !document.querySelector('.selbar').hidden }));
  console.log('cursor over text:', cursor);
  console.log('drag-select text:', JSON.stringify(sel.text), 'bar shown', sel.bar);
  await page.screenshot({ path: SP + '/n-select.png' });
  await page.click('.selbar [data-act=copy]');
  await page.waitForTimeout(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  console.log('clipboard == selection:', clip === sel.text, 'toast:', await page.evaluate(() => document.querySelector('.toast')?.textContent));
  // double click a word, triple click a line
  const w = await C(0, l2[0] + 40, (l2[1] + l2[3]) / 2);
  await page.waitForTimeout(500);
  await page.mouse.dblclick(w[0], w[1]);
  await page.waitForTimeout(300);
  console.log('double-click word:', JSON.stringify(await page.evaluate(() => window.__inkleaf.viewer.sel?.text)));
  await page.waitForTimeout(500);
  await page.mouse.click(w[0], w[1], { clickCount: 3 });
  await page.waitForTimeout(300);
  console.log('triple-click line:', JSON.stringify(await page.evaluate(() => window.__inkleaf.viewer.sel?.text)));
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(150);
  console.log('ctrl+c copied line:', (await page.evaluate(() => navigator.clipboard.readText())) === await page.evaluate(() => window.__inkleaf.viewer.sel?.text));
  // click on blank paper clears selection; drag on blank paper pans
  await page.waitForTimeout(500);
  const blank = await C(0, 20, 300);
  await page.mouse.click(blank[0], blank[1]);
  await page.waitForTimeout(100);
  console.log('click blank clears selection:', await page.evaluate(() => window.__inkleaf.viewer.sel === null));
  s0 = await st();
  await page.mouse.move(blank[0], blank[1]); await page.mouse.down();
  for (let k = 1; k <= 8; k++) { await page.mouse.move(blank[0], blank[1] - 30 * k); await page.waitForTimeout(10); }
  await page.mouse.up(); await page.waitForTimeout(100);
  s1 = await st();
  console.log('drag on blank paper pans: dy', s1.sy - s0.sy, 'selection', await page.evaluate(() => window.__inkleaf.viewer.sel));
  await page.evaluate(() => window.__inkleaf.viewer.scrollTo(0, 0)); await page.waitForTimeout(200);
  // highlight the selection
  const h0 = await C(0, l2[0] + 1, (l2[1] + l2[3]) / 2), h1 = await C(0, l2[2] - 1, (l2[1] + l2[3]) / 2);
  await page.mouse.move(h0[0], h0[1]); await page.mouse.down();
  for (let k = 1; k <= 8; k++) { await page.mouse.move(h0[0] + (h1[0] - h0[0]) * k / 8, h0[1]); await page.waitForTimeout(12); }
  await page.mouse.up(); await page.waitForTimeout(300);
  s0 = await st();
  await page.click('.selbar [data-act=highlight]'); await page.waitForTimeout(200);
  s1 = await st();
  console.log('highlight selection: +annots', s1.annots - s0.annots, 'types', await page.evaluate(() => window.__inkleaf.viewer.doc.annots.get(0).map(a => a.type).join()));
  // Ctrl+A selects all text on the page
  await page.keyboard.press('Control+a'); await page.waitForTimeout(400);
  const all = await page.evaluate(() => window.__inkleaf.viewer.sel?.text || '');
  console.log('ctrl+a: chars', all.length, 'lines', all.split('\n').length, 'starts', JSON.stringify(all.slice(0, 20)));
  // multi-page selection: zoom out so pages 1 and 2 are visible, drag from p1 bottom to p2 top
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const v = window.__inkleaf.viewer; v.setZoom(0.6); v.scrollTo(0, 300); });
  await page.waitForTimeout(500);
  const last = L[L.length - 1];
  const m0 = await C(0, last[0] + 1, (last[1] + last[3]) / 2);
  const p2lines = await page.evaluate(async () => Array.from(await window.__inkleaf.engine.textLines(1)));
  const m1 = await page.evaluate(([x, y]) => { const v = window.__inkleaf.viewer; const [sx, sy] = v._screenOf(1, [x, y]); return [sx + v.rect.left, sy + v.rect.top]; }, [p2lines[4] + 100, (p2lines[5] + p2lines[7]) / 2]);
  await page.mouse.move(m0[0], m0[1]); await page.mouse.down();
  for (let k = 1; k <= 12; k++) { await page.mouse.move(m0[0] + (m1[0] - m0[0]) * k / 12, m0[1] + (m1[1] - m0[1]) * k / 12); await page.waitForTimeout(12); }
  await page.mouse.up(); await page.waitForTimeout(400);
  const ms = await page.evaluate(() => ({ pages: window.__inkleaf.viewer.sel?.parts.map(p => p.page), text: window.__inkleaf.viewer.sel?.text }));
  console.log('cross-page selection pages', JSON.stringify(ms.pages), JSON.stringify(ms.text));
  console.log(errs.length ? errs.join('\n') : 'no errors');
  await browser.close();
})();
