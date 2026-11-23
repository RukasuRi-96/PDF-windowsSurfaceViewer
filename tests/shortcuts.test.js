// Custom keyboard shortcuts: defaults, record, conflicts + undo, remove, reset,
// persistence, typing protection, tooltips/help, shape keys (Enter, Delete).
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
  await page.click('text=Notes');
  await page.waitForTimeout(800);
  const tool = () => page.evaluate(() => window.__inkleaf.cfg.tool + (window.__inkleaf.cfg.tool === 'box' ? ':' + window.__inkleaf.cfg.shape : ''));
  const openKeys = async () => { await page.click('#btn-more'); await page.click('.menu button:has-text("Keyboard shortcuts")'); await page.waitForSelector('#keys-list .kr'); };
  const row = (label) => page.locator('.kr', { has: page.locator('.kr-label', { hasText: new RegExp('^' + label + '$') }) });
  const note = () => page.textContent('#keys-note');

  await page.keyboard.press('p');
  console.log('default P:', await tool());

  // Record Shift+L for "Line"
  await openKeys();
  await page.fill('#keys-q', 'line');
  await row('Line').locator('.kr-add').click();
  console.log('recording shows:', await row('Line').locator('.kr-wait').textContent());
  await page.keyboard.press('Shift+L');
  console.log('note:', await note());
  // Esc while recording cancels the recording, not the dialog
  await row('Line').locator('.kr-add').click();
  await page.keyboard.press('Escape');
  console.log('esc cancels recording, dialog still open:', await page.isVisible('#keys-list') && !(await page.isVisible('.kr.rec')));
  // Conflict: give Pen the key M (Highlight's), then undo
  await page.fill('#keys-q', '');
  await row('Pen').locator('.kr-add').click();
  await page.keyboard.press('m');
  console.log('conflict note:', await note());
  await page.click('#keys-undo');
  console.log('after undo, Highlight keys:', await row('Highlight').locator('kbd').allTextContents(), 'Pen keys:', await row('Pen').locator('kbd').allTextContents());
  // Remove P from Pen, give the Shapes tool G
  await row('Pen').locator('[data-rm="P"]').click();
  await row('Shapes tool').locator('.kr-add').click();
  await page.keyboard.press('g');
  await page.click('.dialog .btn.primary');
  await page.waitForTimeout(500);

  await page.keyboard.press('Shift+L');
  const t1 = await tool();
  await page.keyboard.press('v'); await page.keyboard.press('p');
  const t2 = await tool();
  await page.keyboard.press('g');
  console.log('Shift+L ->', t1, '| P removed ->', t2, '| G ->', await tool());
  console.log('tooltip follows keys:', await page.getAttribute('.tool[data-tool=box]', 'title'));

  // Help lists the custom keys
  await page.click('#btn-more'); await page.click('.menu button:has-text("help")');
  const help = await page.textContent('.dialog .shortcuts');
  console.log('help shows Shift+L for Line:', /Shift\+L\s*Line/.test(help));
  await page.click('.dialog .btn.primary');

  // Persist across a restart
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForTimeout(1200);
  await page.keyboard.press('v');
  await page.keyboard.press('Shift+L');
  console.log('after restart Shift+L ->', await tool());

  // Typing in the file filter doesn't trigger tool keys
  await page.click('.sb-search input');
  await page.keyboard.type('vh');
  console.log('typing "vh" in the filter keeps tool:', await tool(), '| filter text:', await page.inputValue('.sb-search input'));
  await page.fill('.sb-search input', '');
  await page.click('.pane.active .pane-view', { position: { x: 5, y: 5 } });

  // Shape keys: select a box, Delete removes it, undo; text: Enter edits
  await page.keyboard.press('b');
  await page.evaluate(() => { const I = window.__inkleaf; I.cfg.shape = 'box'; I.viewer.setShape('box'); });
  await H.pen(H.line(500, 300, 650, 380, 6));
  await page.keyboard.press('v');
  await H.pen([[502, 340], [502, 340]]);
  const selected = await page.isVisible('.shape-sel');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(150);
  const n0 = await page.evaluate(() => (window.__inkleaf.viewer.doc.annots.get(0) || []).length);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(250);
  console.log('box selected:', selected, 'Delete removes:', n0 === 0, 'undo:', await page.evaluate(() => window.__inkleaf.viewer.doc.annots.get(0).length));
  await page.keyboard.press('b');
  await page.evaluate(() => { const I = window.__inkleaf; I.cfg.shape = 'text'; I.viewer.setShape('text'); });
  await H.pen([[520, 600], [520, 600]]);
  await page.waitForSelector('.text-edit textarea');
  await page.keyboard.type('Hello');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await page.keyboard.press('v');
  await H.pen([[524, 600], [524, 600]]);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  console.log('Enter on a selected text box edits it:', await page.isVisible('.text-edit textarea') && await page.inputValue('.text-edit textarea'));
  // Ctrl+S while typing finishes the text and saves
  await page.keyboard.type(' world');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.__inkleaf.viewer.dirty, null, { timeout: 8000 });
  console.log('Ctrl+S while typing saved:', JSON.stringify(await page.evaluate(() => window.__inkleaf.viewer.doc.annots.get(0).find(a => a.text)?.text)));

  // Reset all
  await openKeys();
  await page.click('#keys-reset');
  console.log('reset all note:', await note(), '| Pen keys:', await row('Pen').locator('kbd').allTextContents());
  await page.click('.dialog .btn.primary');
  await page.keyboard.press('v'); await page.keyboard.press('p');
  console.log('P works again:', await tool());
  console.log(errs.length ? errs.join('\n') : 'no errors');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
