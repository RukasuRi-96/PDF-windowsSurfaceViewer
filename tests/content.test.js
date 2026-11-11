// 1.4.0: drawing tools draw on top of markups, the Select tool picks any markup
// (delete with the key), Enter / Shift+Enter in text boxes, deleting a signature,
// Edit content (erase an area, replace a line of text) applied on save,
// and embedding markups (as a copy, and over the file).
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const W = process.env.WORK;
const pdfText = (f) => execFileSync('pdftotext', ['-f', '1', '-l', '1', f, '-']).toString();

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
  await page.evaluate(() => { localStorage.removeItem('inkleaf:config'); localStorage.removeItem('inkleaf:signatures'); });
  await page.goto(url);
  await page.waitForTimeout(800);
  await page.click('text=Notes');
  await page.waitForTimeout(900);

  const all = () => page.evaluate(() => (window.__inkleaf.viewer.doc.annots.get(0) || []).map(a => ({ k: a.shape ? a.shape.k : a.type, text: a.text, rect: a.rect && a.rect.map(v => Math.round(v * 10) / 10) })));
  const count = async (k) => (await all()).filter(a => a.k === k).length;
  const S = (x, y) => page.evaluate(([x, y]) => { const v = window.__inkleaf.viewer; const [sx, sy] = v._screenOf(0, [x, y]); return [sx + v.rect.left, sy + v.rect.top]; }, [x, y]);
  const choose = async (k) => {
    await page.click('.tool[data-tool=box] [data-caret]'); await page.waitForTimeout(100);
    await page.click(`.shapes [data-shape=${k}]`); await page.keyboard.press('Escape'); await page.waitForTimeout(60);
  };
  const kindSel = () => page.evaluate(() => window.__inkleaf.viewer.selectedShape);
  // Text lines of page 1 (page coordinates).
  const lines = await page.evaluate(async () => {
    const f = await window.__inkleaf.engine.textLines(0), out = [];
    for (let k = 0; k < f.length; k += 4) out.push([f[k], f[k + 1], f[k + 2], f[k + 3]]);
    return out;
  });
  const lineAt = (k) => page.evaluate(([x, y]) => window.__inkleaf.engine.lineAt(0, [x, y]), [(lines[k][0] + lines[k][2]) / 2, (lines[k][1] + lines[k][3]) / 2]);

  // ---- 1. Drawing tools always draw, even on top of markups
  const L12 = lines[12];
  const bx0 = await S(L12[0] + 250, L12[1]), bx1 = await S(L12[0] + 420, L12[1] + 90);
  await page.keyboard.press('b');
  await choose('box');
  await H.pen(H.line(bx0[0], bx0[1], bx1[0], bx1[1], 8));
  await page.waitForTimeout(150);
  const inside = [(bx0[0] + bx1[0]) / 2, (bx0[1] + bx1[1]) / 2];
  await H.pen(H.line(inside[0] - 30, inside[1] - 20, inside[0] + 30, inside[1] + 20, 8));   // starts inside the first box
  await page.waitForTimeout(150);
  console.log('box drawn starting inside another box:', await count('Square'), 'boxes, nothing selected:', !(await kindSel()));
  // Text tool: a tap inside a box starts a text box there
  await choose('text');
  await H.pen([[bx0[0] + 12, bx0[1] + 14], [bx0[0] + 12, bx0[1] + 14]]);
  await page.waitForSelector('.text-edit textarea');
  console.log('editor hint:', await page.textContent('.te-bar .te-hint'));
  await page.keyboard.type('First line');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Second line');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  console.log('Shift+Enter = new line, Enter = done:', !(await page.isVisible('.text-edit textarea')), JSON.stringify((await all()).find(a => a.k === 'text')?.text));
  // Pen across the boxes
  await page.keyboard.press('p');
  await H.pen(H.line(bx0[0] - 20, inside[1] + 30, bx1[0] + 20, inside[1] + 30, 12));
  await page.waitForTimeout(150);
  console.log('pen stroke across the boxes:', await count('Ink'));
  // Highlight a line
  await page.keyboard.press('m');
  const L8 = lines[8], h0 = await S(L8[0] + 2, (L8[1] + L8[3]) / 2), h1 = await S(L8[0] + 160, (L8[1] + L8[3]) / 2);
  await H.pen(H.line(h0[0], h0[1], h1[0], h1[1], 10));
  await page.waitForTimeout(300);
  console.log('highlight:', await count('Highlight'));

  // ---- 2. Select tool picks any markup; Delete removes it; undo brings it back
  await page.keyboard.press('v');
  const pick = async (x, y) => { await H.pen([[x, y], [x, y]]); await page.waitForTimeout(150); return kindSel(); };
  const inkK = await pick(bx1[0] + 10, inside[1] + 30);
  await page.keyboard.press('Delete'); await page.waitForTimeout(150);
  const inkGone = (await count('Ink')) === 0;
  await page.keyboard.press('Control+z'); await page.waitForTimeout(250);
  const hlK = await pick((h0[0] + h1[0]) / 2, h0[1]);
  await page.keyboard.press('Backspace'); await page.waitForTimeout(150);
  const hlGone = (await count('Highlight')) === 0;
  await page.keyboard.press('Control+z'); await page.waitForTimeout(250);
  const boxK = await pick(bx0[0] + 1, (bx0[1] + bx1[1]) / 2 - 15);
  const txK = await pick(bx0[0] + 30, bx0[1] + 16);
  await H.pen([[1350, 850], [1350, 850]]); await page.waitForTimeout(100);
  console.log('select picks: pen', inkK, '(Delete removes', inkGone + ') · highlight', hlK, '(Backspace removes', hlGone + ') · box', boxK, '· text', txK,
    '| counts after undo:', await count('Ink'), await count('Highlight'));

  // ---- 3. Signatures can be deleted: from the Signature tool's adjust bar, and with the Select tool
  const sigPath = W + '/sigs/content-sig.png';
  fs.mkdirSync(W + '/sigs', { recursive: true });
  await page.evaluate(async (p) => {
    const c = new OffscreenCanvas(500, 180), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 500, 180);
    g.strokeStyle = '#1a237e'; g.lineWidth = 7; g.beginPath(); g.moveTo(30, 120); g.bezierCurveTo(150, 10, 250, 170, 470, 50); g.stroke();
    await fetch('/api/write?p=' + encodeURIComponent(p), { method: 'POST', body: await c.convertToBlob({ type: 'image/png' }) });
  }, sigPath);
  page.evaluate((p) => { window.__inkleaf.prepareSignature(p); }, sigPath);
  await page.waitForSelector('.sigprep canvas');
  await page.click('.dialog .btn.primary');
  await page.waitForSelector('.sig-place');
  console.log('new signature: Delete hidden while placing a new one:', await page.isHidden('.placebar [data-act=delete]'));
  await page.click('.placebar [data-act=place]');
  await page.waitForTimeout(400);
  const sigRect = (await all()).find(a => a.k === 'sig').rect;
  const sc = await S((sigRect[0] + sigRect[2]) / 2, (sigRect[1] + sigRect[3]) / 2);
  await H.pen([sc, sc]); await page.waitForTimeout(200);   // Signature tool: tap it to adjust
  const adjusting = await page.isVisible('.placebar [data-act=delete]');
  await page.click('.placebar [data-act=delete]'); await page.waitForTimeout(200);
  const sigGone1 = (await count('sig')) === 0;
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
  const sigBack = await count('sig');
  await page.keyboard.press('v');
  const sigK = await pick(sc[0], sc[1]);
  await page.keyboard.press('Delete'); await page.waitForTimeout(200);
  const sigGone2 = (await count('sig')) === 0;
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
  console.log('signature: adjust bar has Delete', adjusting, '→ removed', sigGone1, '· undo', sigBack, '· Select tool picks', sigK, '→ Delete removes', sigGone2, '· undo', await count('sig'));

  // ---- 4. Edit content: erase an area, replace a line of text
  const erased = await lineAt(2), replaced = await lineAt(4);
  await page.keyboard.press('x');
  console.log('content tool:', await page.evaluate(() => window.__inkleaf.cfg.tool + ':' + window.__inkleaf.cfg.contentMode));
  const e0 = await S(erased.bbox[0] - 2, erased.bbox[1] - 1), e1 = await S(erased.bbox[2] + 2, erased.bbox[3] + 1);
  await H.pen(H.line(e0[0], e0[1], e1[0], e1[1], 10));
  await page.waitForTimeout(200);
  console.log('erase area added:', await count('redact'), 'pending:', await page.evaluate(() => window.__inkleaf.viewer.pendingRedactions()));
  await page.click('.tool[data-tool=content] [data-caret]'); await page.waitForTimeout(100);
  await page.click('.menu button:has-text("Replace text")'); await page.waitForTimeout(100);
  const r0 = await S(replaced.bbox[0] + 40, (replaced.bbox[1] + replaced.bbox[3]) / 2);
  await H.pen([r0, r0]);
  await page.waitForSelector('.text-edit textarea');
  const opened = await page.inputValue('.text-edit textarea');
  await page.screenshot({ path: W + '/content-replace-editor.png', clip: { x: 300, y: 150, width: 1140, height: 300 } });
  console.log('replace: editor opens with the line:', opened === replaced.text, JSON.stringify(opened.slice(0, 30)), 'font', replaced.font, replaced.size + 'pt');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('REPLACED LINE TEXT 123');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const rep = (await all()).find(a => a.text === 'REPLACED LINE TEXT 123');
  console.log('replacement: erase areas', await count('redact'), '· text box at the old line (dx, dy):', rep && +(rep.rect[0] - replaced.bbox[0]).toFixed(1), rep && +(rep.rect[1] - replaced.bbox[1]).toFixed(1));
  await page.screenshot({ path: W + '/content-before-save.png' });
  // Undo/redo the replacement as one step
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
  const afterUndo = [await count('redact'), await count('text')];
  await page.keyboard.press('Control+y'); await page.waitForTimeout(300);
  console.log('undo replacement (erase areas, text boxes):', afterUndo.join(','), '→ redo:', await count('redact') + ',' + await count('text'));

  // Save: confirm, applied for good, file rewritten, reopened
  const notes = W + '/lib/Notes.pdf';
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.dialog');
  console.log('save asks:', await page.textContent('.dialog h2'), '|', (await page.textContent('.dialog p')).slice(0, 60) + '…');
  await page.click('.dialog .btn:has-text("Cancel")'); await page.waitForTimeout(200);
  console.log('cancel keeps it unsaved:', await page.evaluate(() => window.__inkleaf.viewer.dirty));
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.dialog');
  await page.click('.dialog .btn.primary');
  await page.waitForFunction(() => !window.__inkleaf.viewer.dirty && window.__inkleaf.viewer.doc && window.__inkleaf.viewer.doc.annotsP.size > 0, null, { timeout: 10000 });
  await page.waitForTimeout(900);
  const t1 = pdfText(notes);
  const raw = fs.readFileSync(notes).toString('latin1');
  console.log('saved: erased line gone:', !t1.includes(erased.text.slice(0, 30)), '· replaced line gone:', !t1.includes(replaced.text.slice(0, 30)),
    '· neighbours kept:', t1.includes((await lineAt(1)).text.slice(0, 25)) && t1.includes((await lineAt(3)).text.slice(0, 25)) && t1.includes((await lineAt(5)).text.slice(0, 25)),
    '· no Redact left:', !/\/Redact/.test(raw), '· one file section (no old copy):', (raw.match(/%%EOF/g) || []).length === 1);
  const after = await all();
  console.log('after reopen:', after.map(a => a.k).join(', '), '· replacement text kept:', after.some(a => a.text === 'REPLACED LINE TEXT 123'));
  await page.screenshot({ path: W + '/content-after-save.png' });

  // ---- 5. Embed markups: as a copy (original keeps its markups), then over the file
  const copy = W + '/lib/Notes (embedded).pdf';
  page.once('dialog', (d) => d.accept(copy));
  await page.click('#btn-more'); await page.click('.menu button:has-text("Embed markups")');
  await page.waitForSelector('.dialog');
  console.log('embed dialog:', await page.textContent('.dialog h2'), '| buttons:', (await page.locator('.dialog .row .btn').allTextContents()).join(' / '));
  await page.click('.dialog .btn:has-text("Save as a copy")');
  for (let k = 0; k < 80 && !fs.existsSync(copy); k++) await page.waitForTimeout(100);
  await page.waitForTimeout(500);
  const tc = pdfText(copy), rawc = fs.readFileSync(copy).toString('latin1');
  console.log('copy: text box and replacement now page text:', tc.includes('First') && tc.includes('Second') && tc.includes('REPLACED LINE TEXT 123'), '· no annotations:', !/\/Subtype\s*\/(FreeText|Ink|Square|Highlight|Stamp)/.test(rawc),
    '· original untouched:', /\/Subtype\s*\/FreeText/.test(fs.readFileSync(notes).toString('latin1')), '· still showing the original:', await page.evaluate(() => window.__inkleaf.state.path.endsWith('/Notes.pdf')));
  execFileSync('pdftoppm', ['-r', '60', '-f', '1', '-l', '1', '-png', copy, W + '/content-embedded']);

  await page.click('#btn-more'); await page.click('.menu button:has-text("Embed markups")');
  await page.waitForSelector('.dialog');
  await page.click('.dialog .btn:has-text("Replace this file")');
  await page.waitForFunction(() => !window.__inkleaf.viewer.dirty && window.__inkleaf.viewer.doc && window.__inkleaf.viewer.doc.annotsP.size > 0, null, { timeout: 10000 });
  await page.waitForTimeout(900);
  const t2 = pdfText(notes);
  console.log('replace file: markups left to move:', (await all()).length, '· text now part of the page:', t2.includes('First') && t2.includes('Second') && t2.includes('REPLACED LINE TEXT 123'));
  await page.keyboard.press('v');
  const nothing = await pick(bx0[0] + 1, (bx0[1] + bx1[1]) / 2 - 15);
  console.log('embedded box can no longer be selected:', nothing === null);
  await page.screenshot({ path: W + '/content-embedded-view.png' });
  console.log(errs.length ? errs.join('\n') : 'no errors');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
