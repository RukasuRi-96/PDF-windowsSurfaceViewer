// Pages panel (thumbnails, delete, blank pages, insert from another PDF,
// duplicate, rotate, drag to reorder, undo/redo, save), speed with the panel
// open, and merging PDFs (selected files, a whole folder, touch "Select" mode).
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const W = process.env.WORK;
const pdfPages = (f) => +execFileSync('pdfinfo', [f]).toString().match(/Pages:\s+(\d+)/)[1];
const pdfText = (f, p) => execFileSync('pdftotext', ['-f', String(p), '-l', String(p), f, '-']).toString().trim().split('\n')[0];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const H = require('./helpers.js')(page, cdp);
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => errs.push(`[pageerror] ${e.message}`));
  let answer = null; // what the next host prompt (file picker / save as) answers
  page.on('dialog', (d) => d.accept(answer ?? undefined));
  const url = `http://localhost:5180/?folder=${encodeURIComponent(W + '/lib')}`;
  await page.goto(url);
  await page.evaluate(() => { localStorage.removeItem('inkleaf:config'); });
  await page.goto(url);
  await page.waitForTimeout(800);

  const n = () => page.evaluate(() => window.__inkleaf.viewer.pageCount);
  // First line of text on page i of the open document.
  const title = (i) => page.evaluate(async (i) => {
    const E = window.__inkleaf.engine, f = await E.textLines(i);
    if (!f.length) return '(blank)';
    const l = await E.lineAt(i, [(f[0] + f[2]) / 2, (f[1] + f[3]) / 2]);
    return l ? (l.rotated ? '↻' : l.text) : '?';
  }, i);
  const titles = async () => { const out = []; for (let i = 0; i < await n(); i++) out.push((await title(i)).replace(/^Q3 Summary - page /, 'Q').replace(/^Appendix A - page /, 'A')); return out.join(' '); };
  const thumb = (i) => page.locator(`.pp-item[data-i="${i}"]`);
  const toTop = async () => { await page.evaluate(() => { document.querySelector('.pp-list').scrollTop = 0; }); await page.waitForTimeout(150); };
  const menu = async (label) => { await page.click(`.menu button:has-text("${label}")`); };
  const waitPages = async (count) => { await page.waitForFunction((c) => window.__inkleaf.viewer.pageCount === c, count, { timeout: 15000 }); await page.waitForTimeout(400); };

  await page.click('text=Quarterly summary');
  await page.waitForTimeout(900);

  // ---- 1. The panel and its thumbnails
  await page.click('#btn-pages');
  const t0 = Date.now();
  await page.waitForSelector('.pp-item[data-i="0"] canvas', { timeout: 8000 });
  console.log('panel open:', await page.isVisible('#pages'), '· first thumbnail in', Date.now() - t0 < 3000 ? '< 3 s' : Date.now() - t0 + ' ms', '· items', await page.locator('.pp-item').count(), '· count label', await page.textContent('.pp-count'));
  console.log('pages:', await titles());

  // ---- 2. Delete (Delete key in the panel), undo, redo, undo
  await thumb(1).click();
  console.log('clicking page 2 goes there:', await page.evaluate(() => window.__inkleaf.viewer.currentPage()) === 1);
  await page.keyboard.press('Delete');
  await waitPages(5);
  const afterDel = await titles();
  console.log('delete page 2:', afterDel, '· unsaved:', await page.evaluate(() => window.__inkleaf.viewer.dirty));
  await page.keyboard.press('Control+z'); await waitPages(6);
  const undone = await titles();
  await page.keyboard.press('Control+y'); await waitPages(5);
  const redone = await titles();
  await page.keyboard.press('Control+z'); await waitPages(6);
  console.log('undo:', undone, '| redo:', redone, '| undo again:', await titles());

  // ---- 3. Two blank A3 landscape pages after page 1
  await thumb(0).click();
  await page.click('.pp-head [data-act=add]'); await menu('Blank page');
  await page.waitForSelector('#bp-size');
  console.log('blank page dialog sizes:', (await page.locator('#bp-size option').allTextContents()).map(t => t.split(' (')[0]).join(', '));
  await page.selectOption('#bp-size', 'A3');
  await page.check('input[name="bp-or"][value="l"]');
  await page.fill('#bp-count', '2');
  await page.click('.dialog .btn.primary');
  await waitPages(8);
  const sz = await page.evaluate(() => window.__inkleaf.viewer.doc.pages.slice(1, 3).map(p => [Math.round(p.w), Math.round(p.h)]));
  console.log('2 blank A3 landscape pages:', await titles(), JSON.stringify(sz), '· selected in the panel:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.pp-item.sel')].map(e => +e.dataset.i))));

  // ---- 4. Pages 2-3 of another PDF, at the end
  answer = W + '/lib/Reports/Q3/Appendix A.pdf';
  await page.click('.pp-head [data-act=add]'); await menu('Pages from another PDF');
  await page.waitForSelector('#ip-pages');
  console.log('insert dialog:', (await page.textContent('.dialog .hint')).trim());
  await page.fill('#ip-pages', '2-3');
  await page.selectOption('#ip-where', String(await n()));
  await page.click('.dialog .btn.primary');
  await waitPages(10);
  console.log('inserted Appendix A pages 2-3 at the end:', await titles());

  // ---- 5. Duplicate and rotate page 1 (right-click menu)
  await toTop();
  await thumb(0).click({ button: 'right' }); await menu('Duplicate page');
  await waitPages(11);
  await toTop();
  await thumb(0).click({ button: 'right' }); await menu('Rotate right');
  await page.waitForTimeout(800);
  const rot = await page.evaluate(() => { const p = window.__inkleaf.viewer.doc.pages; return [Math.round(p[0].w), Math.round(p[0].h), Math.round(p[1].w), Math.round(p[1].h)]; });
  console.log('duplicate + rotate page 1:', await titles(), '· page 1 now', rot[0] > rot[1] ? 'landscape' : 'portrait', '(copy stays', rot[2] > rot[3] ? 'landscape)' : 'portrait)');

  // ---- 6. Drag page 1 to after page 4 (mouse)
  await toTop();
  const b0 = await thumb(0).boundingBox();
  const b4 = await thumb(4).boundingBox();
  await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2);
  await page.mouse.down();
  await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2 + 20, { steps: 3 });
  console.log('dragging shows a drop line:', await page.isVisible('.pp-drop'), '· ghost:', await page.isVisible('.pp-ghost'));
  await page.mouse.move(b4.x + b4.width / 2, b4.y + 4, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  console.log('dragged page 1 to before page 5:', await titles());

  // ---- 7. Save: the file has the new pages, in order, rotation kept
  const qs = W + '/lib/Reports/Q3/Quarterly summary.pdf';
  const order = await titles();
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.__inkleaf.viewer.dirty, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  const fileOrder = [];
  for (let p = 1; p <= pdfPages(qs); p++) fileOrder.push((pdfText(qs, p) || '(blank)').replace(/^Q3 Summary - page /, 'Q').replace(/^Appendix A - page /, 'A'));
  const rotInfo = execFileSync('pdfinfo', ['-f', '1', '-l', '11', qs]).toString().match(/rot:\s+\d+/g).map(r => r.replace(/rot:\s+/, ''));
  console.log('saved file:', pdfPages(qs), 'pages ·', fileOrder.join(' '), '· same as on screen:', fileOrder.join(' ') === order.replace('↻', 'Q1'), '· rotations', rotInfo.join(','));

  // ---- 8. Speed: the 500-page file with the panel open
  await page.click('text=Big 500 pages');
  const s0 = Date.now();
  await page.waitForFunction(() => { const v = window.__inkleaf.viewer; return v.pageCount === 500 && v.doc.states.get(0)?.el.classList.contains('ready'); }, null, { timeout: 15000 });
  const firstPage = Date.now() - s0;
  await page.waitForSelector('.pp-item[data-i="0"] canvas', { timeout: 8000 });
  const items = await page.locator('.pp-item').count();
  await page.evaluate(() => { document.querySelector('.pp-list').scrollTop = 400 * 200; });
  await page.waitForTimeout(1500);
  console.log('500 pages: first page drawn in', firstPage < 2500 ? '< 2.5 s' : firstPage + ' ms', '· thumbnails in the page:', items, '(of 500) · after scrolling the panel, thumbnails shown near page', await page.evaluate(() => Math.min(...[...document.querySelectorAll('.pp-item')].filter(e => e.querySelector('canvas')).map(e => +e.dataset.i))) + 1);

  // ---- 9. Merge two PDFs picked with Ctrl+click
  await page.click('.sb-row:has-text("Notes")');
  await page.waitForTimeout(600);
  await page.click('.sb-row:has-text("Letter")', { modifiers: ['Control'] });
  console.log('Ctrl+click: picked', await page.locator('.sb-row.picked').count(), '· bar:', (await page.textContent('.sb-pickcount')).trim());
  await page.click('.sb-row:has-text("Letter")', { button: 'right' });
  const mergeLabel = (await page.locator('.menu button').first().textContent()).trim();
  await menu('Merge 2 PDFs');
  await page.waitForSelector('.merge-list .ml-row');
  console.log('menu:', mergeLabel, '· order:', (await page.locator('.ml-name').allTextContents()).join(' + '));
  const merged = W + '/lib/Merged test.pdf';
  answer = merged;
  await page.click('.dialog .btn.primary');
  for (let k = 0; k < 100 && !fs.existsSync(merged); k++) await page.waitForTimeout(100);
  await page.waitForTimeout(1500);
  console.log('merged file:', pdfPages(merged), 'pages ·', pdfText(merged, 1), '/', pdfText(merged, 3), '· opened:', await page.evaluate(() => window.__inkleaf.state.path.endsWith('Merged test.pdf')), '· selection cleared:', await page.locator('.sb-row.picked').count() === 0);

  // ---- 10. Merge a whole folder (subfolders included), changing the order
  await page.click('.sb-row.dir:has-text("Reports")', { button: 'right' });
  const folderLabel = (await page.locator('.menu button').first().textContent()).trim();
  await page.keyboard.press('Escape');
  await page.click('.pane.active .pane-view', { position: { x: 5, y: 5 } }).catch(() => {});
  await page.click('.sb-row.dir:has-text("Q3")', { button: 'right' });
  await menu('Merge all 2 PDFs');
  await page.waitForSelector('.merge-list .ml-row');
  const before = (await page.locator('.ml-name').allTextContents()).join(' + ');
  await page.click('.ml-row[data-k="1"] [data-mv="-1"]');
  const after = (await page.locator('.ml-name').allTextContents()).join(' + ');
  const fm = W + '/lib/Reports/Q3 (merged).pdf';
  answer = fm;
  await page.click('.dialog .btn.primary');
  for (let k = 0; k < 100 && !fs.existsSync(fm); k++) await page.waitForTimeout(100);
  await page.waitForTimeout(800);
  console.log('folder menu on Reports:', folderLabel, '| Q3 order', before, '→', after, '| merged:', pdfPages(fm), 'pages, starts with', pdfText(fm, 1), 'and', pdfText(fm, 1 + pdfPages(W + '/lib/Reports/Q3/Quarterly summary.pdf')));

  // ---- 11. Touch: "Select for merging", then taps pick files
  await page.evaluate(() => { document.querySelector('.sb-list').scrollTop = 1e6; });
  await page.waitForTimeout(200);
  await page.click('.sb-row:has-text("Notes")', { button: 'right' });
  await menu('Select for merging');
  await page.waitForTimeout(300);
  const r1 = await page.locator('.sb-row:has-text("Letter")').boundingBox();
  await H.tap(r1.x + 60, r1.y + r1.height / 2);
  await page.waitForTimeout(200);
  console.log('touch select mode: checkboxes', await page.isVisible('.sb-row.file .sb-check'), '· picked', await page.locator('.sb-row.picked').count(), '· Merge enabled', await page.isEnabled('.sb-merge'));
  await page.click('.sb-pickclear');
  console.log('cancel clears:', await page.locator('.sb-row.picked').count() === 0 && await page.isHidden('.sb-pickbar'));

  console.log(errs.length ? errs.join('\n') : 'no errors');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
