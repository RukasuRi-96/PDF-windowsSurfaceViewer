// PDFs side by side, all equal: write in either one, the toolbar, keys and
// Pages panel follow the one touched last, snip in one and paste into another
// with no keyboard (tap with the Snip tool, or press and hold the page), a
// third PDF, move a PDF by its title bar, resize with the divider, copy a page
// into another PDF by dragging it out of the Pages panel, move a page by its
// grip with a finger, restore after a restart, stack in portrait, close each.
const { chromium } = require('playwright');
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

  const I = 'window.__inkleaf';
  const names = () => page.evaluate(() => window.__inkleaf.visible.map(P => (P.state.path || '').split('/').pop().replace('.pdf', '')));
  const activeName = () => page.evaluate(() => (window.__inkleaf.state.path || '').split('/').pop().replace('.pdf', ''));
  const box = (k) => page.evaluate((k) => { const r = window.__inkleaf.visible[k].view.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, k);
  const annots = (k, pg = 0) => page.evaluate(([k, pg]) => (window.__inkleaf.visible[k].viewer.doc.annots.get(pg) || []).length, [k, pg]);
  const lastAnnot = (k, pg = 0) => page.evaluate(([k, pg]) => { const d = window.__inkleaf.visible[k].viewer.doc.annots.get(pg).at(-1); return { k: d.shape?.k || d.kind, c: [(d.rect[0] + d.rect[2]) / 2, (d.rect[1] + d.rect[3]) / 2] }; }, [k, pg]);
  const toPage = (k, x, y) => page.evaluate(([k, x, y]) => { const v = window.__inkleaf.visible[k].viewer; v.rect = v.root.getBoundingClientRect(); const [wx, wy] = v._toWorld(x, y); const i = v._hitPage(wx, wy, 0); return { i, p: v._worldToPage(i, wx, wy) }; }, [k, x, y]);
  const near = (a, b, d = 2) => Math.abs(a[0] - b[0]) < d && Math.abs(a[1] - b[1]) < d;

  // ---- 1. Two PDFs side by side
  await page.click('text=Notes');
  await page.waitForTimeout(900);
  await page.click('.sb-row:has-text("Drawing set")', { button: 'right' });
  await page.click('.menu button:has-text("Open side by side")');
  const t0 = Date.now();
  await page.waitForFunction(() => window.__inkleaf.visible.length === 2 && window.__inkleaf.visible[1].view.querySelector('.page.ready'), null, { timeout: 10000 });
  const ms = Date.now() - t0;
  const w = await page.evaluate(() => window.__inkleaf.visible.map(P => Math.round(P.el.getBoundingClientRect().width)));
  console.log('side by side:', JSON.stringify(await names()), '· shown in', ms < 2500 ? '< 2.5 s' : ms + ' ms', '· widths', JSON.stringify(w), '· tab bars', await page.locator('.tabbar:visible').count(), '· in use:', await activeName(), '· toolbar title:', await page.textContent('#title-text'));
  await page.click('#btn-pages');
  await page.waitForSelector('.pp-item[data-i="3"]');
  console.log('Pages panel shows it:', await page.textContent('.pp-count'), (await page.textContent('.pp-item[data-i="0"] .pp-num')).trim());

  // ---- 2. Write in the second PDF: same tools, its own undo
  await page.keyboard.press('p');
  let b1 = await box(1);
  await H.pen(H.line(b1.x + 80, b1.y + 200, b1.x + 260, b1.y + 260, 16));
  await page.waitForTimeout(500);
  console.log('pen in the second PDF: marks', await annots(1), '· unsaved dot', await page.isVisible('.pane.active .pane-dot'), '· undo enabled', await page.isEnabled('#btn-undo'));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  const undone = await annots(1);
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(300);
  console.log('Ctrl+Z undoes it there:', undone === 0, '· Ctrl+Y redoes:', (await annots(1)) === 1);

  // ---- 3. Touch the first PDF: the toolbar, keys and Pages panel follow
  let b0 = await box(0);
  const n0 = await annots(0);
  await H.pen(H.line(b0.x + 80, b0.y + 200, b0.x + 260, b0.y + 230, 16));
  await page.waitForTimeout(500);
  console.log('pen in the first PDF: in use', await activeName(), '· marks', (await annots(0)) - n0, '· Pages panel', await page.textContent('.pp-count'), '· title', await page.textContent('#title-text'));
  const sy1 = await page.evaluate(`${I}.visible[1].viewer.sy`);
  await page.keyboard.press('End');
  await page.waitForTimeout(600);
  console.log('End key moves only the PDF in use:', await page.evaluate(() => { const v = window.__inkleaf.visible[0].viewer; return v.sy >= v.L.worldH - v.vh - 2; }), (await page.evaluate(`${I}.visible[1].viewer.sy`)) === sy1);
  await page.keyboard.press('Home');
  await page.waitForTimeout(400);
  // a palm resting on the other PDF while the pen writes in this one: ignored
  b0 = await box(0); b1 = await box(1);
  const sy1b = await page.evaluate(`${I}.visible[1].viewer.sy`);
  const nP = await annots(0);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b0.x + 100, y: b0.y + 300, button: 'none', buttons: 0, pointerType: 'pen' });
  await H.swipe(b1.x + 200, b1.y + 500, b1.x + 200, b1.y + 300, 8, 16);
  await H.pen(H.line(b0.x + 100, b0.y + 300, b0.x + 250, b0.y + 320, 12));
  await page.waitForTimeout(400);
  console.log('palm on the other PDF while writing: it did not move', (await page.evaluate(`${I}.visible[1].viewer.sy`)) === sy1b, '· still in use', await activeName(), '· the stroke went in', (await annots(0)) === nP + 1);
  await page.waitForTimeout(700);
  await H.swipe(b1.x + 200, b1.y + 500, b1.x + 200, b1.y + 300, 8, 16);
  await page.waitForTimeout(300);
  console.log('the same swipe with the pen away does scroll it:', (await page.evaluate(`${I}.visible[1].viewer.sy`)) !== sy1b, '· and makes it the one in use:', await activeName());
  await page.click('.tab:has-text("Notes")');

  // ---- 4. Snip in one, paste in the other, no keyboard
  await page.click('.tool[data-tool=snip]');
  b1 = await box(1);
  await H.pen(H.line(b1.x + 60, b1.y + 120, b1.x + 300, b1.y + 190, 10));
  await page.waitForSelector('.toast:has-text("Copied")');
  b0 = await box(0);
  const tapAt = [b0.x + b0.w / 2, b0.y + 330]; // the middle of the page: a wide picture isn't pushed in from the edge
  const target = await toPage(0, ...tapAt);
  const nA = await annots(0);
  await H.pen([tapAt, tapAt]);
  await page.waitForTimeout(600);
  const pasted = await lastAnnot(0);
  console.log('snip in Drawing set, pen tap in Notes: pasted', (await annots(0)) === nA + 1 && pasted.k === 'image', '· at the tap', near(pasted.c, target.p), '· in use', await activeName(), '· tool', await page.evaluate(`${I}.cfg.tool`));
  // a finger held on the page: the page menu
  const holdAt = [b0.x + 220, b0.y + 520];
  const target2 = await toPage(0, ...holdAt);
  await H.touch('touchStart', [holdAt]);
  await H.sleep(700);
  const menu = await page.isVisible('.menu button:has-text("Paste picture here")');
  await H.touch('touchEnd', []);
  await page.waitForTimeout(150);
  const nB = await annots(0);
  await page.click('.menu button:has-text("Paste picture here")');
  await page.waitForTimeout(600);
  const pasted2 = await lastAnnot(0);
  console.log('press and hold with a finger: menu', menu, '· Paste picture here pasted', (await annots(0)) === nB + 1 && pasted2.k === 'image', '· where the finger was', near(pasted2.c, target2.p));
  // right-click does the same with a mouse
  await page.mouse.click(b0.x + 200, b0.y + 450, { button: 'right' });
  await page.waitForTimeout(150);
  console.log('right-click: page menu', await page.isVisible('.menu button:has-text("Paste picture here")'));
  await page.keyboard.press('Escape');

  // ---- 5. A third PDF; move it by dragging its tab to the left edge; resize with the divider
  await page.click('.sb-row:has-text("Letter")', { button: 'right' });
  await page.click('.menu button:has-text("Open side by side")');
  await page.waitForFunction(() => window.__inkleaf.visible.length === 3 && window.__inkleaf.visible.every(P => P.viewer.doc), null, { timeout: 10000 });
  console.log('third PDF, next to the one in use:', JSON.stringify(await names()));
  const h2 = await page.locator('.group').nth(2).locator('.tab.on').boundingBox();
  const b0b = await box(0);
  const steps = 12, sx = h2.x + 30, sy = h2.y + h2.height / 2, ex = b0b.x + 30, ey = b0b.y + 300;
  // pulled down out of its bar with a finger, then across to the far left
  await H.touch('touchStart', [[sx, sy]]);
  for (let k = 1; k <= 3; k++) { await H.touch('touchMove', [[sx, sy + 12 * k]]); await H.sleep(20); }
  for (let k = 1; k <= steps; k++) { await H.touch('touchMove', [[sx + (ex - sx) * k / steps, sy + 36 + (ey - sy - 36) * k / steps]]); await H.sleep(20); }
  const marker = await page.evaluate(() => { const d = document.querySelector('.pane-drop'); return !!d && !d.hidden && d.classList.contains('zone') && d.textContent; });
  await H.touch('touchEnd', []);
  await page.waitForTimeout(300);
  console.log('dragged its tab with a finger to the left edge:', JSON.stringify(marker), '· order', JSON.stringify(await names()), '· still three panes', await page.evaluate(() => window.__inkleaf.groups.length));
  const wBefore = await page.evaluate(() => window.__inkleaf.visible.map(P => Math.round(P.el.getBoundingClientRect().width)));
  const sp = await page.locator('.pane-split').first().boundingBox();
  await page.mouse.move(sp.x + sp.width / 2, sp.y + 400); await page.mouse.down(); await page.mouse.move(sp.x + sp.width / 2 + 150, sp.y + 400, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(300);
  const wAfter = await page.evaluate(() => window.__inkleaf.visible.map(P => Math.round(P.el.getBoundingClientRect().width)));
  console.log('divider: widths', JSON.stringify(wBefore), '→', JSON.stringify(wAfter));

  // ---- 6. Pages: copy one into another PDF by dragging it there; move one by its grip
  await page.click('.tab:has-text("Drawing set")');
  await page.waitForFunction(() => document.querySelector('.pp-count').textContent === '(4)');
  await page.waitForSelector('.pp-item[data-i="1"] .pp-grip');
  const notesK = (await names()).indexOf('Notes');
  const notesPages = await page.evaluate((k) => window.__inkleaf.visible[k].viewer.pageCount, notesK);
  const g = await page.locator('.pp-item[data-i="1"] .pp-grip').boundingBox();
  const nb = await box(notesK);
  const from = [g.x + g.width / 2, g.y + g.height / 2], to = [nb.x + nb.w / 2, nb.y + nb.h / 2];
  await H.touch('touchStart', [from]);
  for (let k = 1; k <= 14; k++) { await H.touch('touchMove', [[from[0] + (to[0] - from[0]) * k / 14, from[1] + (to[1] - from[1]) * k / 14]]); await H.sleep(20); }
  const hint = await page.isVisible('.pane.drop-target');
  await H.touch('touchEnd', []);
  await page.waitForFunction((k) => window.__inkleaf.visible[k].viewer.pageCount === 3, notesK, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
  const copied = await page.evaluate((k) => { const P = window.__inkleaf.visible[k]; return { n: P.viewer.pageCount, w: P.viewer.doc.pages.map(p => Math.round(p.w)) }; }, notesK);
  console.log('page dragged from the panel onto Notes: "copy here" shown', hint, '· Notes', notesPages, '→', copied.n, 'pages', JSON.stringify(copied.w), '· in use', await activeName(), '· Drawing set still', await page.evaluate(() => window.__inkleaf.visible.find(P => P.state.path.endsWith('Drawing set.pdf')).viewer.pageCount), 'pages');
  // in Notes' panel: drag the new page (2) to the top by its grip, no hold
  await page.waitForSelector('.pp-item[data-i="2"] .pp-grip');
  const g2 = await page.locator('.pp-item[data-i="2"] .pp-grip').boundingBox();
  const t1 = await page.locator('.pp-item[data-i="0"] .pp-thumb').boundingBox();
  await H.touch('touchStart', [[g2.x + 15, g2.y + 15]]);
  for (let k = 1; k <= 10; k++) { await H.touch('touchMove', [[g2.x + 15, g2.y + 15 + (t1.y + 10 - g2.y - 15) * k / 10]]); await H.sleep(20); }
  await H.touch('touchEnd', []);
  await page.waitForTimeout(800);
  console.log('grip: page moved to the top with a finger at once:', JSON.stringify(await page.evaluate((k) => window.__inkleaf.visible[k].viewer.doc.pages.map(p => Math.round(p.w)), notesK)));

  // ---- 7. Ctrl+Tab; restart; portrait
  const before = await activeName();
  await page.keyboard.press('Control+Tab');
  console.log('Ctrl+Tab: in use', before, '→', await activeName());
  await page.waitForTimeout(700);
  const session = { names: await names(), w: await page.evaluate(() => window.__inkleaf.visible.map(P => Math.round(P.el.getBoundingClientRect().width))) };
  await page.reload();
  await page.waitForFunction(() => window.__inkleaf && window.__inkleaf.visible.length === 3 && window.__inkleaf.visible.every(P => P.viewer.doc), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const w2 = await page.evaluate(() => window.__inkleaf.visible.map(P => Math.round(P.el.getBoundingClientRect().width)));
  console.log('after a restart:', JSON.stringify(await names()), 'same order', JSON.stringify(await names()) === JSON.stringify(session.names), '· same widths', w2.every((x, k) => Math.abs(x - session.w[k]) < 6));
  await page.setViewportSize({ width: 900, height: 1300 });
  await page.waitForTimeout(500);
  console.log('portrait: stacked', await page.evaluate(() => document.querySelector('#panes').classList.contains('vertical')), JSON.stringify(await page.evaluate(() => window.__inkleaf.visible.map(P => Math.round(P.el.getBoundingClientRect().height)))));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);

  // ---- 8. Close each one
  await page.locator('.group').nth(1).locator('.tab.on .tab-x').click();
  await page.waitForTimeout(300);
  console.log('× closes that PDF:', JSON.stringify(await names()));
  await page.locator('.group').nth(1).locator('.tab.on .tab-x').click();
  await page.waitForTimeout(300);
  console.log('one left: full width', await page.evaluate(() => Math.round(window.__inkleaf.visible[0].el.getBoundingClientRect().width)), '· its tab bar', await page.locator('.tabbar:visible').count());
  await page.keyboard.press('Control+w');
  await page.waitForTimeout(300);
  console.log('Ctrl+W closes the last one: empty', await page.isVisible('#empty'));
  await page.screenshot({ path: W + '/panes.png' });
  console.log(errs.length ? errs.join('\n') : 'no errors');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
