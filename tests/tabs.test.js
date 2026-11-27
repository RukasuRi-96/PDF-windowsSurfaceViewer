// Tabs: opening a PDF while another is open adds a tab (the first stays
// open, with its changes); tap a tab to switch, with each tab keeping its
// page, zoom and unsaved changes; the same PDF again goes to its tab;
// Ctrl+Tab; close with × (asks about unsaved changes) and Ctrl+W; the tab's
// menu; drag a tab to reorder it, and onto the pane beside to move it
// there; a finger held on a tab drags it; tabs out of view go to sleep
// (render workers stopped) and wake up drawn; side by side, each pane has its
// own tabs; tabs and the one in front are restored after a restart, also
// when the app is started by opening a PDF.
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

  const tabs = () => page.evaluate(() => window.__inkleaf.groups.map(G => G.tabs.map(P => (P.state.path || P.pendingPath || '').split('/').pop().replace('.pdf', '') + (G.shown === P ? '*' : '') + (P === window.__inkleaf.active ? '!' : ''))));
  const ready = (name) => page.waitForFunction((n) => { const P = window.__inkleaf.active; return P.state.path?.endsWith(n + '.pdf') && P.viewer.doc?.states.get(P.viewer.currentPage())?.base; }, name, { timeout: 15000 });
  const tabEl = (name) => page.locator(`.tab:has(.tab-name:text-is("${name}"))`);

  // 1. Open one, then another: two tabs, the first still open.
  await page.click('text=Quarterly summary');
  await ready('Quarterly summary');
  // a change in the first, and a page further on
  await page.keyboard.press('p');
  const vr = await page.evaluate(() => { const r = window.__inkleaf.viewer.root.getBoundingClientRect(); return { x: r.left, y: r.top }; });
  await H.pen([[vr.x + 200, vr.y + 200], [vr.x + 260, vr.y + 230], [vr.x + 320, vr.y + 210]]);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__inkleaf.viewer.goToPage(2));
  await page.waitForTimeout(400);
  const first = await page.evaluate(() => ({ page: window.__inkleaf.viewer.currentPage(), dirty: window.__inkleaf.viewer.dirty, scale: window.__inkleaf.viewer.scale }));
  await page.click('text=Annual Report 2026');
  await ready('Annual Report 2026');
  const t1 = await tabs();
  const bar = await page.evaluate(() => { const b = document.querySelector('.tabbar').getBoundingClientRect(); return { h: Math.round(b.height), visible: b.height > 0 }; });
  console.log('open a second PDF: tabs', JSON.stringify(t1), '· the first stays open', t1[0].length === 2 && t1[0][0].startsWith('Quarterly summary'), '· tab bar', bar.h, 'px');
  console.log('the first tab shows it has unsaved changes:', await tabEl('Quarterly summary').evaluate(el => el.classList.contains('dirty') && getComputedStyle(el.querySelector('.pane-dot')).display !== 'none'));

  // 2. Switch back by tapping its tab: same page, zoom, unsaved stroke.
  const tq = await tabEl('Quarterly summary').boundingBox();
  await page.touchscreen.tap(tq.x + 40, tq.y + tq.height / 2);
  await ready('Quarterly summary');
  const back = await page.evaluate(() => ({ page: window.__inkleaf.viewer.currentPage(), dirty: window.__inkleaf.viewer.dirty, scale: window.__inkleaf.viewer.scale, ink: (window.__inkleaf.viewer.doc.annots.get(0) || []).length }));
  console.log('tap the first tab: back on page', back.page + 1, back.page === first.page, '· zoom kept', Math.abs(back.scale - first.scale) < 1e-6, '· unsaved stroke kept', back.dirty && back.ink >= 1, '· title', JSON.stringify(await page.textContent('#title-text')));
  // the toolbar and Pages panel follow the tab
  await page.click('#btn-pages');
  await page.waitForSelector('.pp-item[data-i="0"] canvas', { timeout: 10000 });
  const pp = () => page.evaluate(() => { const p = window.__inkleaf.pagesPanel; return [p.key === window.__inkleaf.active.id, p.pages.length]; });
  const n1 = await pp();
  await tabEl('Annual Report 2026').click();
  await ready('Annual Report 2026');
  await page.waitForTimeout(500);
  const n2 = await pp();
  console.log('Pages panel follows the tab: Quarterly summary', JSON.stringify(n1), '→ Annual Report', JSON.stringify(n2), '· (its own, page count)');
  await page.click('#btn-pages');

  // 3. The same PDF again goes to its tab; a third PDF; Ctrl+Tab.
  await page.click('text=Quarterly summary');
  await page.waitForTimeout(300);
  console.log('open it again: goes to its tab', JSON.stringify(await tabs()));
  await page.click('text=Pump manual');
  await ready('Pump manual');
  console.log('a third, next to the tab in use:', JSON.stringify(await tabs()));
  await page.keyboard.press('Control+Tab');
  await page.waitForTimeout(200);
  const ct = await tabs();
  await page.keyboard.press('Control+Shift+Tab');
  await page.waitForTimeout(200);
  console.log('Ctrl+Tab →', JSON.stringify(ct), '· Ctrl+Shift+Tab →', JSON.stringify(await tabs()));

  // 4. Drag a tab (mouse) to reorder.
  const a = await tabEl('Annual Report 2026').boundingBox();
  const q = await tabEl('Quarterly summary').boundingBox();
  await page.mouse.move(a.x + 30, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(q.x + 10, q.y + q.height / 2, { steps: 8 });
  const mark = await page.evaluate(() => { const d = document.querySelector('.pane-drop'); return d && !d.hidden; });
  await page.mouse.up();
  await page.waitForTimeout(200);
  console.log('drag a tab to the front: a drop line', mark, '·', JSON.stringify(await tabs()));
  // a finger held on a tab, then dragged to the end
  const a2 = await tabEl('Annual Report 2026').boundingBox();
  const last = await page.locator('.tab').last().boundingBox();
  await H.touch('touchStart', [[a2.x + 30, a2.y + a2.height / 2]]);
  await H.sleep(500);
  for (let k = 1; k <= 8; k++) { await H.touch('touchMove', [[a2.x + 30 + (last.x + last.width - 10 - a2.x - 30) * k / 8, a2.y + a2.height / 2]]); await H.sleep(25); }
  await H.touch('touchEnd', []);
  await page.waitForTimeout(250);
  console.log('a finger held on a tab drags it to the end:', JSON.stringify(await tabs()));
  // a finger held still: the tab's menu
  const p3 = await tabEl('Pump manual').boundingBox();
  await H.touch('touchStart', [[p3.x + 30, p3.y + p3.height / 2]]);
  await H.sleep(550);
  await H.touch('touchEnd', []);
  await page.waitForTimeout(250);
  const menu = await page.locator('.menu button').allTextContents();
  console.log('a finger held still: menu', JSON.stringify(menu.map(t => t.replace(/Ctrl.*$/, '').trim())));
  await page.keyboard.press('Escape');

  // 5. Sleep: tabs out of view stop their render workers, and come back drawn.
  await page.evaluate(() => { for (const P of window.__inkleaf.panes) if (!window.__inkleaf.groups.some(G => G.shown === P)) window.__inkleaf.sleepTab(P); });
  const sleeping = await page.evaluate(() => window.__inkleaf.panes.map(P => [P.state.path.split('/').pop(), P.engine.sleeping, P.engine.renderers.length]));
  await tabEl('Quarterly summary').click();
  await page.waitForFunction(() => { const v = window.__inkleaf.viewer, P = window.__inkleaf.active; return !P.engine.sleeping && P.engine.activeRenderers.length > 0 && v.root.querySelectorAll('.tile, canvas').length > 0; }, null, { timeout: 15000 });
  await page.waitForTimeout(800);
  const woke = await page.evaluate(() => ({ dirty: window.__inkleaf.viewer.dirty, ink: (window.__inkleaf.viewer.doc.annots.get(0) || []).length, renderers: window.__inkleaf.engine.activeRenderers.length }));
  console.log('asleep:', JSON.stringify(sleeping), '· woken: render workers', woke.renderers, '· unsaved stroke still there', woke.dirty && woke.ink >= 1);
  await page.screenshot({ path: W + '/tabs1.png' });

  // 6. Close: × asks about unsaved changes; Ctrl+W.
  await tabEl('Quarterly summary').locator('.tab-x').click();
  await page.waitForSelector('.dialog', { timeout: 5000 });
  const ask = await page.textContent('.dialog h2');
  await page.click('.dialog .btn:has-text("Cancel")');
  await page.waitForTimeout(200);
  console.log('× on a tab with changes asks:', JSON.stringify(ask), '· cancelled, still open', (await tabs())[0].length === 3);
  await tabEl('Pump manual').click();
  await page.keyboard.press('Control+w');
  await page.waitForTimeout(300);
  console.log('Ctrl+W closes the tab in use:', JSON.stringify(await tabs()));

  // 7. Side by side: its own tabs; open a PDF there adds a tab there; drag a tab across.
  await page.click('.sb-row:has-text("Drawing set")', { button: 'right' });
  await page.click('.menu button:has-text("Open side by side")');
  await page.waitForFunction(() => window.__inkleaf.groups.length === 2 && window.__inkleaf.groups[1].shown?.viewer.doc, null, { timeout: 15000 });
  await page.click('text=Pump manual');
  await ready('Pump manual');
  const sb = await tabs();
  console.log('side by side: each pane has its own tabs', JSON.stringify(sb));
  const from = await tabEl('Pump manual').boundingBox();
  const target = await page.evaluate(() => { const r = window.__inkleaf.groups[0].el.querySelector('.tabbar').getBoundingClientRect(); return { x: r.right - 60, y: r.top + r.height / 2 }; });
  await page.mouse.move(from.x + 30, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  console.log('drag a tab onto the other pane\'s bar:', JSON.stringify(await tabs()));
  // the tab menu: move to a new pane side by side
  const tp = await tabEl('Pump manual').boundingBox();
  await page.mouse.click(tp.x + 30, tp.y + tp.height / 2, { button: 'right' });
  await page.click('.menu button:has-text("Move to the next pane")');
  await page.waitForTimeout(300);
  console.log('tab menu → Move to the next pane:', JSON.stringify(await tabs()));
  // drag a tab to the right edge of the right pane: a new pane there
  const ar = await tabEl('Annual Report 2026').boundingBox();
  const edge = await page.evaluate(() => { const r = window.__inkleaf.groups[1].stack.getBoundingClientRect(); return { x: r.right - 25, y: r.top + r.height / 2 }; });
  await page.mouse.move(ar.x + 30, ar.y + ar.height / 2); await page.mouse.down();
  await page.mouse.move(edge.x, edge.y, { steps: 12 });
  const zone = await page.evaluate(() => { const d = document.querySelector('.pane-drop'); return !!d && !d.hidden && d.classList.contains('zone'); });
  await page.mouse.up();
  await page.waitForTimeout(400);
  console.log('drag a tab to a pane\'s right edge: "New pane here"', zone, '·', JSON.stringify(await tabs()));
  await page.screenshot({ path: W + '/tabs2.png' });

  // 8. Restart: tabs, the one in front of each pane and the PDF in use come back.
  await page.evaluate(() => window.__inkleaf.save());
  await page.waitForTimeout(600);
  const before = await tabs();
  await page.reload();
  await page.waitForFunction(() => window.__inkleaf?.groups?.length === 3 && window.__inkleaf.groups.every(G => G.shown?.viewer.doc), null, { timeout: 20000 });
  await page.waitForFunction(() => window.__inkleaf.panes.every(P => P.state.path && P.viewer.doc), null, { timeout: 20000 });
  const after = await tabs();
  const asleepBehind = await page.evaluate(() => window.__inkleaf.panes.filter(P => !window.__inkleaf.groups.some(G => G.shown === P)).every(P => P.engine.sleeping));
  const clean = await page.evaluate(() => window.__inkleaf.panes.every(P => !P.viewer.dirty && !P.tab.classList.contains('dirty')));
  console.log('after a restart:', JSON.stringify(after), '· same as before', JSON.stringify(after) === JSON.stringify(before), '· tabs behind opened asleep', asleepBehind, '· nothing marked unsaved', clean);
  await page.screenshot({ path: W + '/tabs3.png' });
  // Started by opening a PDF (double-clicked in File Explorer): the tabs
  // come back too, with that PDF in a new tab in front.
  await page.goto(url + '&file=' + encodeURIComponent(W + '/lib/Letter.pdf'));
  await page.waitForFunction(() => window.__inkleaf?.state?.path?.endsWith('Letter.pdf') && window.__inkleaf.viewer.doc && window.__inkleaf.panes.length === 5, null, { timeout: 20000 }).catch(() => {});
  console.log('started by opening Letter:', JSON.stringify(await tabs()));
  console.log(errs.length ? errs.join('\n') : 'no errors');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
