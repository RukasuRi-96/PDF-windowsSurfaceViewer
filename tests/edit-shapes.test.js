// Editing placed shapes: select, move, resize, re-point, retype, restyle,
// delete, undo, finger taps and drags, save + reload (same annotations, edited in place).
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
  await page.click('text=Notes');
  await page.waitForTimeout(900);
  const choose = async (k) => {
    await page.click('.tool[data-tool=box] [data-caret]'); await page.waitForTimeout(100);
    await page.click(`.shapes [data-shape=${k}]`); await page.keyboard.press('Escape'); await page.waitForTimeout(60);
  };
  const all = () => page.evaluate(() => (window.__inkleaf.viewer.doc.annots.get(0) || []).map(a => ({ k: a.shape ? a.shape.k : a.type, id: a.id, rect: a.rect && a.rect.map(v => Math.round(v)), pts: a.pts && a.pts.map(p => p.map(Math.round)), tip: a.callout && a.callout[0].map(Math.round), text: a.text, color: a.color && a.color.map(c => +c.toFixed(2)) })));
  const get = async (k) => (await all()).find(a => a.k === k);
  const S = (x, y) => page.evaluate(([x, y]) => { const v = window.__inkleaf.viewer; const [sx, sy] = v._screenOf(0, [x, y]); return [sx + v.rect.left, sy + v.rect.top]; }, [x, y]);
  const scale = await page.evaluate(() => window.__inkleaf.viewer.scale);
  const drag = async (from, to) => { await page.mouse.move(from[0], from[1]); await page.mouse.down(); await page.mouse.move(to[0], to[1], { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(250); };
  const handle = async (role) => { const b = await page.locator(`.shape-sel .ss-h.${role}`).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };

  await page.keyboard.press('b');
  await choose('box');   await H.pen(H.line(450, 200, 650, 300, 8));
  await choose('line');  await H.pen(H.line(450, 380, 700, 380, 8));
  await choose('callout'); await H.pen(H.line(500, 560, 760, 480, 8));
  await page.waitForSelector('.text-edit textarea'); await page.keyboard.type('Old callout text'); await page.keyboard.press('Control+Enter');
  await choose('text'); await H.pen([[480, 700], [480, 700]]);
  await page.waitForSelector('.text-edit textarea'); await page.keyboard.type('Remove me'); await page.click('.te-bar [data-act=done]');
  await page.waitForTimeout(400);
  const start = await all();
  console.log('drawn:', start.map(a => a.k).join(', '));

  // Box: pen tap selects; drag moves it (same annotation); corner resizes
  await H.pen([[452, 250], [452, 250]]);
  console.log('box selected, corner handles:', await page.locator('.shape-sel .ss-h').count());
  const box0 = await get('Square');
  const c = await S((box0.rect[0] + box0.rect[2]) / 2, (box0.rect[1] + box0.rect[3]) / 2);
  await drag(c, [c[0] + 100, c[1] + 50]);
  const box1 = await get('Square');
  console.log('moved by (pt):', box1.rect[0] - box0.rect[0], box1.rect[1] - box0.rect[1], 'expected', Math.round(100 / scale), Math.round(50 / scale), 'same id:', box1.id === box0.id);
  const se = await handle('se'); await drag(se, [se[0] + 60, se[1] + 30]);
  const box2 = await get('Square');
  console.log('resized (w,h):', box1.rect[2] - box1.rect[0], box1.rect[3] - box1.rect[1], '->', box2.rect[2] - box2.rect[0], box2.rect[3] - box2.rect[1]);
  // Recolour from the shapes menu while selected
  await page.click('.tool[data-tool=box] [data-caret]'); await page.waitForTimeout(100);
  await page.click('.swatch[data-c="#1d4ed8"]'); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  console.log('recoloured:', JSON.stringify((await get('Square')).color));

  // Line: move one end
  const ln0 = await get('line');
  const lc = await S(ln0.pts[0][0] * 0.9 + ln0.pts[1][0] * 0.1, ln0.pts[0][1]); // left end, clear of the box
  await H.pen([lc, lc]);
  const p1 = await handle('p1'); await drag(p1, [p1[0], p1[1] + 80]);
  const ln1 = await get('line');
  console.log('line end moved down (pt):', ln1.pts[1][1] - ln0.pts[1][1], 'start kept:', JSON.stringify(ln1.pts[0]) === JSON.stringify(ln0.pts[0]));

  // Callout: re-point the tip, then move the box (tip stays), then retype it
  const co0 = await get('callout');
  const cc = await S((co0.rect[0] + co0.rect[2]) / 2, (co0.rect[1] + co0.rect[3]) / 2);
  await H.pen([cc, cc]);
  const tip = await handle('tip'); await drag(tip, [tip[0] - 40, tip[1] + 40]);
  const co1 = await get('callout');
  console.log('tip moved:', JSON.stringify(co0.tip), '->', JSON.stringify(co1.tip));
  const cc1 = await S((co1.rect[0] + co1.rect[2]) / 2, (co1.rect[1] + co1.rect[3]) / 2);
  await drag(cc1, [cc1[0] + 80, cc1[1] - 40]);
  const co2 = await get('callout');
  console.log('box moved, tip kept:', co2.rect[0] - co1.rect[0] > 20 && JSON.stringify(co2.tip) === JSON.stringify(co1.tip));
  // tap the selected callout to retype it
  const cc2 = await S((co2.rect[0] + co2.rect[2]) / 2, (co2.rect[1] + co2.rect[3]) / 2);
  await page.mouse.click(cc2[0], cc2[1]);
  await page.waitForSelector('.text-edit textarea');
  console.log('editor opens with the text:', JSON.stringify(await page.inputValue('.text-edit textarea')));
  await page.keyboard.press('Control+a'); await page.keyboard.type('New callout text that is long enough to wrap onto a second line');
  await page.click('.te-bar [data-act=done]');
  await page.waitForTimeout(400);
  const co3 = await get('callout');
  console.log('retyped:', JSON.stringify(co3.text), 'same id:', co3.id === co0.id, 'box grew to fit:', co3.rect[3] - co3.rect[1] > co2.rect[3] - co2.rect[1]);

  // Text: Edit text button, empty it -> removed; undo -> back
  const tx = await get('text');
  const tc = await S(tx.rect[0] + 10, (tx.rect[1] + tx.rect[3]) / 2);
  await H.pen([tc, tc]);
  await page.click('.ss-bar [data-act=edit]');
  await page.waitForSelector('.text-edit textarea');
  await page.keyboard.press('Control+a'); await page.keyboard.press('Delete'); await page.click('.te-bar [data-act=done]');
  await page.waitForTimeout(200);
  const gone = !(await get('text'));
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
  console.log('emptied text removed:', gone, 'undo restores:', (await get('text'))?.text);

  // Undo the retype, then redo it
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
  const undone = (await get('callout')).text;
  await page.keyboard.press('Control+y'); await page.waitForTimeout(300);
  console.log('undo retype:', JSON.stringify(undone), 'redo:', JSON.stringify((await get('callout')).text.slice(0, 16)));

  // Finger: tap selects, drag on the selected shape moves it, tap on blank paper deselects
  const ln = await get('line');
  const fl = await S((ln.pts[0][0] + ln.pts[1][0]) / 2, (ln.pts[0][1] + ln.pts[1][1]) / 2);
  await H.tap(fl[0], fl[1]); await page.waitForTimeout(150);
  const fsel = await page.isVisible('.shape-sel');
  const fr = await page.locator('.shape-sel .ss-frame').boundingBox();
  await H.swipe(fr.x + fr.width / 2, fr.y + fr.height / 2, fr.x + fr.width / 2, fr.y + fr.height / 2 + 60, 6, 16);
  await page.waitForTimeout(250);
  const ln2 = await get('line');
  await H.tap(1300, 800); await page.waitForTimeout(150);
  console.log('finger: selects', fsel, 'drags', ln2.pts[0][1] - ln.pts[0][1] > 20, 'tap elsewhere deselects', !(await page.isVisible('.shape-sel')));

  // Delete button
  const bx = await get('Square');
  const bc = await S(bx.rect[0] + 3, (bx.rect[1] + bx.rect[3]) / 2);
  await H.pen([bc, bc]); await page.click('.ss-bar [data-act=delete]'); await page.waitForTimeout(200);
  console.log('delete button removes:', !(await get('Square')));
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);

  // Save and reload: edits are in the same annotations
  const before = await all();
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.__inkleaf.viewer.dirty, null, { timeout: 8000 });
  await page.evaluate(async () => { const I = window.__inkleaf; await I.openFile(I.state.path, { force: true }); });
  await page.waitForTimeout(900);
  const after = await all();
  const same = before.every(b => after.some(a => a.k === b.k && JSON.stringify(a.rect || a.pts) === JSON.stringify(b.rect || b.pts) && (b.text == null || a.text === b.text)));
  console.log('after reload:', after.map(a => a.k).join(', '), 'geometry and text kept:', same);
  await page.screenshot({ path: W + '/edit-shapes.png' });
  execFileSync('pdftoppm', ['-r', '60', '-f', '1', '-l', '1', '-png', W + '/lib/Notes.pdf', W + '/edit-poppler']);
  console.log(errs.length ? errs.join('\n') : 'no errors');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
