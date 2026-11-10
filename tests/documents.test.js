const { chromium } = require('playwright');
const SP = process.env.WORK;
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: true });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  const cdp = await ctx.newCDPSession(page);
  const H = require('./helpers.js')(page, cdp);
  const I = (fn, arg) => page.evaluate(fn, arg);
  const annCount = () => I(() => [...window.__inkleaf.viewer.doc.annots.values()].reduce((a, l) => a + l.length, 0));
  const open = async (name) => { await I(async (n) => { const I = window.__inkleaf; await I.openFile(I.sidebar.orderedFiles().find(p => p.includes(n))); }, name); await page.waitForTimeout(400); };
  await page.goto(`http://localhost:5180/?folder=${encodeURIComponent(SP + '/lib')}`);
  await page.waitForTimeout(1200);

  // 1. Rotated page: box on page 2 (Rotate 90)
  await open('Rotated');
  await I(() => window.__inkleaf.viewer.goToPage(1));
  await page.waitForTimeout(500);
  await page.keyboard.press('b');
  await H.pen(H.line(600, 300, 900, 450, 8));
  await page.waitForTimeout(200);
  await page.screenshot({ path: SP + '/r1.png', clip: { x: 300, y: 48, width: 1140, height: 852 } });
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(800);
  console.log('rotated: annots', await annCount(), 'dirty', await I(() => window.__inkleaf.viewer.dirty));

  // 2. Password
  const pw = open('Locked');
  await page.waitForSelector('.dialog input', { timeout: 5000 });
  await page.fill('.dialog input', 'wrong');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  console.log('after wrong pw, dialog shown again:', await page.isVisible('.dialog input'));
  await page.fill('.dialog input', 'secret');
  await page.keyboard.press('Enter');
  await pw; await page.waitForTimeout(500);
  console.log('locked opened pages:', await I(() => window.__inkleaf.viewer.pageCount));

  // 3. 500 pages: fling hard several times
  await open('Big 500');
  await page.keyboard.press('h');
  for (let k = 0; k < 6; k++) { await H.swipe(900, 800, 900, 150, 5, 8); await page.waitForTimeout(250); }
  await page.waitForTimeout(1500);
  const s3 = await I(() => { const v = window.__inkleaf.viewer; let bases = 0; for (const s of v.doc.states.values()) if (s.base) bases++; return { page: v.currentPage() + 1, tiles: v.tileCount, bases, states: v.doc.states.size, domPages: document.querySelectorAll('.page').length }; });
  console.log('after flings', JSON.stringify(s3));
  // jump via page pill
  await page.click('#pagepill');
  await page.fill('#pagepill input', '400');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  console.log('jumped to', await I(() => window.__inkleaf.viewer.currentPage() + 1), 'pill', await page.textContent('#pagepill'));
  await page.screenshot({ path: SP + '/b1.png' });

  // 4. Ctrl+wheel zoom
  const sc0 = await I(() => window.__inkleaf.viewer.scale);
  await page.mouse.move(900, 400);
  await page.keyboard.down('Control');
  for (let k = 0; k < 5; k++) await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await page.waitForTimeout(500);
  console.log('ctrl+wheel zoom', (await I(() => window.__inkleaf.viewer.scale) / sc0).toFixed(2) + 'x');

  // 5. Touch-draws: one finger draws with pen tool, two fingers still zoom
  await I(() => window.__inkleaf.viewer.fit('width'));
  await page.keyboard.press('p'); await page.keyboard.press('t');
  const a0 = await annCount();
  await H.swipe(500, 300, 800, 350, 10, 10);
  await page.waitForTimeout(200);
  const a1 = await annCount();
  const z0 = await I(() => window.__inkleaf.viewer.scale);
  await H.pinch(900, 450, 100, 200, 10);
  await page.waitForTimeout(300);
  console.log('touch-draw: +annots', a1 - a0, 'pinch zoom', (await I(() => window.__inkleaf.viewer.scale) / z0).toFixed(2) + 'x', 'annots unchanged', (await annCount()) === a1);
  // 6. Palm rejection: pen hovering, then a palm touch drag must not draw or pan
  const sy0 = await I(() => window.__inkleaf.viewer.sy);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 500, button: 'none', buttons: 0, pointerType: 'pen' });
  await H.swipe(400, 600, 450, 400, 6, 10);
  await page.waitForTimeout(200);
  console.log('palm: annots unchanged', (await annCount()) === a1, 'scroll unchanged', (await I(() => window.__inkleaf.viewer.sy)) === sy0);
  await page.keyboard.press('t');
  console.log(logs.length ? logs.join('\n') : 'no errors');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
