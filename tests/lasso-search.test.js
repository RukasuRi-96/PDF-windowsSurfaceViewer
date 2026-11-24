// 1.9: the app icon and a toolbar that never overlaps (choose its buttons;
// they shrink to fit), highlighter Words / Draw, lasso select (Lasso tool,
// the pen's side button, a finger): move, resize, copy, paste on another
// page, duplicate, delete, undo; the eraser end still erases; the markups
// list; search (Ctrl+F, next / previous, results list, a 500-page PDF);
// autosave on and off.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const W = process.env.WORK;
const MUPDF = require('path').resolve(__dirname, '../app/vendor/mupdf/mupdf.js');

// Markups in a saved file, by type.
function fileAnnots(file) {
  const js = `import(${JSON.stringify(MUPDF)}).then(m => { const d = m.Document.openDocument(require('fs').readFileSync(process.argv[1]), 'application/pdf'); const out = []; for (let i = 0; i < d.countPages(); i++) for (const a of d.loadPage(i).getAnnotations()) out.push(a.getType()); console.log(JSON.stringify(out)); })`;
  return JSON.parse(execFileSync('node', ['-e', js, file], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').pop());
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1290, height: 900 }, deviceScaleFactor: 1, hasTouch: true });
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
  await page.click('text=Notes');
  await page.waitForTimeout(900);

  const V = 'window.__inkleaf.viewer';
  // A point on page i (page units) on screen.
  const scr = (i, pt) => page.evaluate(([i, pt]) => { const v = window.__inkleaf.viewer; v.rect = v.root.getBoundingClientRect(); const s = v._screenOf(i, pt); return [s[0] + v.rect.left, s[1] + v.rect.top]; }, [i, pt]);
  const annots = (i = 0) => page.evaluate((i) => (window.__inkleaf.viewer.doc.annots.get(i) || []).map(d => ({ t: d.type, k: d.shape?.k || (d.measure ? 'measure' : d.type), ink: d.ink, quads: d.quads, w: d.width, rect: d.rect, op: d.opacity })), i);
  const groups = () => page.evaluate(() => window.__inkleaf.viewer.groupCount);
  const overlap = () => page.evaluate(() => {
    const g = (s) => document.querySelector(s).getBoundingClientRect();
    const l = g('.tb-left'), t = g('.tb-tools'), r = g('.tb-right');
    return l.right > t.left + 1 || t.right > r.left + 1;
  });
  const loop = (cx, cy, rx, ry, n = 36) => { const o = []; for (let k = 0; k <= n; k++) { const a = (k / n) * 2 * Math.PI; o.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); } return o; };
  const bbox = (ink) => { const p = ink.flat(); const xs = p.map(q => q[0]), ys = p.map(q => q[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };

  // ---- 1. The icon; the toolbar fits (a Surface at 1440 less the window buttons)
  console.log('app icon shown:', await page.evaluate(() => { const i = document.querySelector('#app-logo'); const r = i.getBoundingClientRect(); return i.complete && i.naturalWidth > 0 && r.left < 120 && r.width > 15; }), '· toolbar at 1290 px: overlap', await overlap(), '· button size', await page.evaluate(() => document.querySelector('#toolbar').style.getPropertyValue('--b')));
  await page.click('#btn-more');
  await page.click('.menu button:has-text("Customize the toolbar")');
  await page.waitForSelector('input[data-rb-id="paste"]');
  for (const id of ['paste', 'side', 'fullscreen', 'autosave']) await page.check(`input[data-rb-id="${id}"]`);
  await page.uncheck('input[data-rb-id="tool.measure"]');
  await page.waitForTimeout(200);
  const shown = await page.evaluate(() => ['#btn-paste', '#btn-side', '#btn-full', '#btn-autosave', '.tool[data-tool=measure]'].map(s => !document.querySelector(s).hidden));
  console.log('customize: paste, side by side, full screen, autosave shown, measure hidden:', JSON.stringify(shown), '· buttons now', await page.evaluate(() => document.querySelector('#toolbar').style.getPropertyValue('--b')), '· overlap', await overlap());
  await page.click('.dialog .btn.primary');
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.waitForTimeout(300);
  console.log('narrow window (1000 px): buttons', await page.evaluate(() => document.querySelector('#toolbar').style.getPropertyValue('--b')), '· overlap', await overlap());
  await page.setViewportSize({ width: 1290, height: 900 });
  await page.reload();
  await page.waitForTimeout(1200);
  console.log('kept after a restart:', await page.isVisible('#btn-paste'), await page.isHidden('.tool[data-tool=measure]'));
  await page.click('#btn-more');
  await page.click('.menu button:has-text("Customize the toolbar")');
  await page.click('.dialog .btn:has-text("Reset to default")');
  await page.waitForSelector('input[data-rb-id="paste"]');
  console.log('reset: paste hidden', await page.isHidden('#btn-paste'), '· measure back', await page.isVisible('.tool[data-tool=measure]'));
  await page.click('.dialog .btn.primary');
  await page.waitForTimeout(300);

  // ---- 2. Highlighter: Words or Draw (the whole page in view)
  await page.keyboard.press('Control+9');
  await page.waitForTimeout(400);
  const lines = await page.evaluate(async () => Array.from(await window.__inkleaf.engine.textLines(0)));
  const L = (k) => [lines[k * 4], lines[k * 4 + 1], lines[k * 4 + 2], lines[k * 4 + 3]];
  const across = async (k) => { const [x0, y0, x1, y1] = L(k); const a = await scr(0, [x0 + 10, (y0 + y1) / 2]), b = await scr(0, [x0 + 120, (y0 + y1) / 2]); return H.line(a[0], a[1], b[0], b[1], 14); };
  await page.keyboard.press('m');
  await H.pen(await across(4));
  await page.waitForTimeout(600);
  let a0 = await annots(0);
  const t1 = a0.at(-1).t;
  await page.click('.tool[data-tool=highlight]');
  await page.click('[data-hlmode="draw"]');
  await page.keyboard.press('Escape');
  await H.pen(await across(6));
  await page.waitForTimeout(600);
  a0 = await annots(0);
  console.log('highlighter Words over text:', t1, '· Draw over text:', a0.at(-1).t, 'opacity', a0.at(-1).op, '· tool shows it', await page.isVisible('.tool[data-tool=highlight] .hl-badge'));
  await page.click('.tool[data-tool=highlight]');
  await page.click('[data-hlmode="words"]');
  await page.keyboard.press('Escape');

  // ---- 3. Lasso
  await page.keyboard.press('p');
  const s1 = await scr(0, [80, 520]), s2 = await scr(0, [80, 560]), s3 = await scr(0, [380, 700]);
  await H.pen(H.line(s1[0], s1[1], s1[0] + 90, s1[1] + 10, 12));
  await H.pen(H.line(s2[0], s2[1], s2[0] + 70, s2[1] - 12, 12));
  await H.pen(H.line(s3[0], s3[1], s3[0] + 60, s3[1] + 20, 12));
  await page.waitForTimeout(500);
  const before = await annots(0), n0 = before.length;
  const A = before[n0 - 3], B = before[n0 - 2];
  await page.keyboard.press('l');
  const c = await scr(0, [120, 540]);
  await H.pen(loop(c[0], c[1], 110, 60));
  await page.waitForTimeout(300);
  console.log('Lasso tool round two strokes: selected', await groups(), '· bar', (await page.textContent('.group-sel .ss-bar')).replace(/\s+/g, ' ').trim());
  // move: drag the frame
  const sc = await page.evaluate(`${V}.scale`);
  const fr = await page.locator('.group-sel .ss-frame').boundingBox();
  await page.mouse.move(fr.x + fr.width / 2, fr.y + fr.height / 2); await page.mouse.down();
  await page.mouse.move(fr.x + fr.width / 2 + 80, fr.y + fr.height / 2 + 40, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(400);
  let now0 = await annots(0);
  const dA = [now0[n0 - 3].ink[0][0][0] - A.ink[0][0][0], now0[n0 - 3].ink[0][0][1] - A.ink[0][0][1]], dB = [now0[n0 - 2].ink[0][0][0] - B.ink[0][0][0], now0[n0 - 2].ink[0][0][1] - B.ink[0][0][1]];
  console.log('moved together:', Math.abs(dA[0] - 80 / sc) < 1 && Math.abs(dA[1] - 40 / sc) < 1 && Math.abs(dA[0] - dB[0]) < 0.05 && Math.abs(dA[1] - dB[1]) < 0.05, '· the third stroke stayed:', JSON.stringify(now0[n0 - 1].ink) === JSON.stringify(before[n0 - 1].ink));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  now0 = await annots(0);
  console.log('one Ctrl+Z puts both back:', JSON.stringify(now0[n0 - 3].ink) === JSON.stringify(A.ink) && JSON.stringify(now0[n0 - 2].ink) === JSON.stringify(B.ink));
  // resize from a corner: both scale the same way, proportions kept
  await H.pen(loop(c[0], c[1], 110, 60));
  await page.waitForTimeout(300);
  const se = await page.locator('.group-sel .ss-h.se').boundingBox();
  await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2); await page.mouse.down();
  await page.mouse.move(se.x + se.width / 2 + 90, se.y + se.height / 2 + 30, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(400);
  now0 = await annots(0);
  const rA = (bbox(now0[n0 - 3].ink)[2] - bbox(now0[n0 - 3].ink)[0]) / (bbox(A.ink)[2] - bbox(A.ink)[0]);
  const rB = (bbox(now0[n0 - 2].ink)[2] - bbox(now0[n0 - 2].ink)[0]) / (bbox(B.ink)[2] - bbox(B.ink)[0]);
  const rAh = (bbox(now0[n0 - 3].ink)[3] - bbox(now0[n0 - 3].ink)[1]) / (bbox(A.ink)[3] - bbox(A.ink)[1]);
  console.log('resized from a corner: bigger', rA > 1.2, '· same scale for both', Math.abs(rA - rB) < 0.02, '· proportions kept', Math.abs(rA - rAh) < 0.05, '· pen width scaled too', Math.abs(now0[n0 - 3].w / A.w - rA) < 0.05);
  // copy, then paste on page 2 where the pointer is
  await page.click('.group-sel .ss-bar [data-act=copy]');
  await page.waitForTimeout(300);
  await page.evaluate(`${V}.goToPage(1)`);
  await page.waitForTimeout(500);
  const p2 = await scr(1, [300, 400]);
  await page.mouse.move(p2[0], p2[1]);
  const n1 = (await annots(1)).length;
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(500);
  const pg2 = await annots(1);
  const same = Math.abs((bbox(pg2.at(-2).ink)[2] - bbox(pg2.at(-2).ink)[0]) - (bbox(now0[n0 - 3].ink)[2] - bbox(now0[n0 - 3].ink)[0])) < 0.2;
  console.log('copied, Ctrl+V on page 2: pasted', pg2.length - n1, '· same size', same, '· selected', await groups());
  await page.click('.group-sel .ss-bar [data-act=duplicate]');
  await page.waitForTimeout(400);
  console.log('Duplicate:', (await annots(1)).length - n1, 'on page 2 · Delete key:', await (async () => { await page.keyboard.press('Delete'); await page.waitForTimeout(300); return (await annots(1)).length - n1; })());
  await page.evaluate(`${V}.goToPage(0)`);
  await page.waitForTimeout(500);
  // the pen's side button: lasso with any tool (here the pen), nothing drawn
  await page.keyboard.press('p');
  const nP = (await annots(0)).length;
  const c3 = await scr(0, [400, 708]);
  await H.pen(loop(c3[0], c3[1], 70, 40), { barrel: true });
  await page.waitForTimeout(300);
  console.log('pen side button (Pen tool on): selected', await groups(), '· nothing drawn', (await annots(0)).length === nP, '· tool still', await page.evaluate(() => window.__inkleaf.cfg.tool));
  // arrow keys nudge it
  const before3 = (await annots(0)).at(-1).ink[0][0];
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await page.waitForTimeout(300);
  const after3 = (await annots(0)).at(-1).ink[0][0];
  console.log('arrow keys nudge it:', Math.abs(after3[0] - before3[0] - 1) < 0.05 && Math.abs(after3[1] - before3[1] - 10) < 0.05);
  await page.keyboard.press('Escape');
  // the eraser end still erases
  const e3 = await scr(0, [410, 711]);
  await H.pen(H.line(e3[0] - 5, e3[1] - 30, e3[0] + 5, e3[1] + 30, 10), { eraser: true });
  await page.waitForTimeout(300);
  console.log('eraser end erases:', (await annots(0)).length === nP - 1);
  // a text highlight moves with the rest
  await page.keyboard.press('l');
  const hl = (await annots(0)).find(d => d.t === 'Highlight');
  const hc = await scr(0, [(hl.quads[0][0] + hl.quads[0][2]) / 2, (hl.quads[0][1] + hl.quads[0][5]) / 2]);
  await H.pen(loop(hc[0], hc[1], 120, 26));
  await page.waitForTimeout(300);
  const fr2 = await page.locator('.group-sel .ss-frame').boundingBox();
  await page.mouse.move(fr2.x + fr2.width / 2, fr2.y + fr2.height / 2); await page.mouse.down();
  await page.mouse.move(fr2.x + fr2.width / 2, fr2.y + fr2.height / 2 + 60, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(400);
  const hl2 = (await annots(0)).find(d => d.t === 'Highlight');
  console.log('lasso a text highlight and move it:', Math.abs(hl2.quads[0][1] - hl.quads[0][1] - 60 / sc) < 1);
  await page.keyboard.press('Control+z');
  // with a finger (Lasso tool): one finger lassos
  await page.keyboard.press('Escape');
  const fl = loop(c[0], c[1], 110, 60, 24);
  await H.touch('touchStart', [fl[0]]);
  for (const p of fl.slice(1)) { await H.touch('touchMove', [p]); await H.sleep(12); }
  await H.touch('touchEnd', []);
  await page.waitForTimeout(300);
  console.log('a finger with the Lasso tool selects:', await groups());
  await page.keyboard.press('Escape');
  // saved and reopened: the moves are in the file
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.__inkleaf.viewer.dirty, null, { timeout: 10000 });
  const types = fileAnnots(W + '/lib/Notes.pdf');
  console.log('saved: markups in the file', types.length, '·', JSON.stringify([...new Set(types)]));

  // ---- 4. The markups list
  await page.click('#btn-marks');
  await page.waitForFunction(() => document.querySelectorAll('#marks .mk-row').length > 0, null, { timeout: 5000 });
  await page.waitForTimeout(400);
  const total = await page.evaluate(() => [...window.__inkleaf.viewer.doc.annots.values()].reduce((n, l) => n + l.length, 0));
  const rows = await page.locator('#marks .mk-row').count();
  console.log('markups list: rows', rows, '= markups', total, rows === total, '·', await page.textContent('#marks .mk-count'), '· groups', JSON.stringify(await page.$$eval('#marks .mk-pg', (e) => e.map(x => x.textContent))));
  await page.selectOption('#marks .mk-filter', 'ink');
  const inkRows = await page.locator('#marks .mk-row').count();
  const inkCount = await page.evaluate(() => [...window.__inkleaf.viewer.doc.annots.values()].flat().filter(d => d.type === 'Ink').length);
  console.log('filter "Pen and marker":', inkRows, '=', inkCount);
  await page.selectOption('#marks .mk-filter', 'all');
  await page.locator('#marks .mk-row', { hasText: 'Highlight' }).first().click();
  await page.waitForTimeout(400);
  console.log('tap a row: goes to it and selects it:', await page.evaluate(`${V}.selectedShape`));
  await page.keyboard.press('Escape');
  await page.keyboard.press('p');
  const s4 = await scr(0, [300, 120]);
  await H.pen(H.line(s4[0], s4[1], s4[0] + 50, s4[1] + 5, 8));
  await page.waitForFunction((n) => document.querySelectorAll('#marks .mk-row').length === n + 1, rows, { timeout: 4000 }).catch(() => {});
  console.log('a new stroke appears in the list:', (await page.locator('#marks .mk-row').count()) === rows + 1);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.__inkleaf.viewer.dirty, null, { timeout: 10000 });

  // ---- 5. Search
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(100);
  const focused = await page.evaluate(() => document.activeElement?.id);
  await page.keyboard.type('dolor');
  await page.waitForFunction(() => window.__inkleaf.find?.q === 'dolor' && window.__inkleaf.find.done, null, { timeout: 8000 });
  const n = await page.textContent('#find-n');
  const marks = await page.locator('svg.annots.find rect').count();
  await page.keyboard.press('Enter');
  const n2 = await page.textContent('#find-n');
  await page.keyboard.press('Shift+Enter');
  console.log('Ctrl+F: typing in it', focused === 'find-q', '· "dolor":', n, '· marked on the page', marks > 0, '· Enter', n2, '· Shift+Enter', await page.textContent('#find-n'));
  await page.click('#find-list');
  await page.waitForSelector('#findlist .fl-row');
  const fr3 = await page.locator('#findlist .fl-row').count();
  await page.locator('#findlist .fl-row').nth(2).click();
  console.log('results list:', fr3, 'rows, with the word marked:', await page.isVisible('#findlist .fl-row mark'), '· tap the 3rd:', await page.textContent('#find-n'));
  await page.fill('#find-q', 'zzqqxx');
  await page.waitForFunction(() => window.__inkleaf.find?.q === 'zzqqxx' && window.__inkleaf.find.done, null, { timeout: 5000 });
  console.log('nothing found:', await page.textContent('#find-n'));
  await page.focus('#find-q');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  console.log('Esc closes it and clears the marks:', await page.isHidden('#findbar'), (await page.locator('svg.annots.find').count()) === 0);
  // a 500-page PDF: the first result comes quickly, the count grows as it searches
  await page.click('text=Big 500 pages');
  await page.waitForFunction(() => window.__inkleaf.viewer.pageCount === 500, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+f');
  const tf = Date.now();
  await page.fill('#find-q', 'Row 39 of page');
  await page.waitForFunction(() => window.__inkleaf.find?.q === 'Row 39 of page' && window.__inkleaf.find.hits.length > 0, null, { timeout: 10000 });
  const first = Date.now() - tf;
  let busy = 0;
  const probe = setInterval(async () => { const t = Date.now(); await page.evaluate(() => 1); busy = Math.max(busy, Date.now() - t); }, 50);
  await page.waitForFunction(() => window.__inkleaf.find?.q === 'Row 39 of page' && window.__inkleaf.find.done, null, { timeout: 60000 });
  clearInterval(probe);
  const all = Date.now() - tf;
  console.log('500 pages: first result in', first < 1500 ? '< 1.5 s' : first + ' ms', '· all', await page.textContent('#find-n'), 'in', all < 15000 ? '< 15 s' : all + ' ms', '· app answered within', busy < 300 ? '< 0.3 s' : busy + ' ms', 'while searching');
  await page.keyboard.press('Escape');

  // ---- 6. Autosave
  await page.click('text=Letter');
  await page.waitForTimeout(1000);
  await page.keyboard.press('Control+9');
  await page.waitForTimeout(400);
  const letterBefore = fileAnnots(W + '/lib/Letter.pdf').length;
  await page.click('#btn-more');
  await page.click('.menu button:has-text("Autosave")');
  console.log('autosave on:', await page.evaluate(() => window.__inkleaf.cfg.autosave));
  await page.keyboard.press('p');
  const s5 = await scr(0, [100, 600]);
  await H.pen(H.line(s5[0], s5[1], s5[0] + 120, s5[1] + 20, 12));
  await page.waitForTimeout(300);
  const dirty1 = await page.evaluate(`${V}.dirty`);
  await page.waitForFunction(() => !window.__inkleaf.viewer.dirty, null, { timeout: 8000 }).catch(() => {});
  console.log('a stroke: unsaved', dirty1, '→ saved by itself', !(await page.evaluate(`${V}.dirty`)), '· in the file', fileAnnots(W + '/lib/Letter.pdf').length - letterBefore);
  // switching files with autosave on doesn't ask
  await H.pen(H.line(s5[0], s5[1] + 60, s5[0] + 120, s5[1] + 80, 12));
  await page.click('text=Notes');
  await page.waitForTimeout(1200);
  await page.keyboard.press('Control+9');
  await page.waitForTimeout(300);
  console.log('switching file right away: no question', await page.isHidden('.dialog'), '· saved', fileAnnots(W + '/lib/Letter.pdf').length - letterBefore, '· now on', await page.evaluate(() => window.__inkleaf.state.path.split('/').pop()));
  await page.click('#btn-more');
  await page.click('.menu button:has-text("Autosave")');
  const s6 = await scr(0, [100, 650]);
  await H.pen(H.line(s6[0], s6[1], s6[0] + 120, s6[1] + 20, 12));
  await page.waitForTimeout(4500);
  console.log('autosave off: still unsaved after 4.5 s', await page.evaluate(`${V}.dirty`));
  await page.screenshot({ path: W + '/lasso-search.png' });
  console.log(errs.length ? errs.join('\n') : 'no errors');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
