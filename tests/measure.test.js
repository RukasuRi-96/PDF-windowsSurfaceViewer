// Measuring: scale dialog, distance/path/area, shift snap, calibration, eraser, save + reload, touch.
const { chromium } = require('playwright');
const OLD = process.env.WORK, SP = process.env.WORK;
const MM = 72 / 25.4;
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const H = require('./helpers.js')(page, cdp);
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => errs.push(`[pageerror] ${e.message}`));
  await page.goto(`http://localhost:5180/?folder=${encodeURIComponent(OLD + '/lib')}`);
  await page.waitForTimeout(800);
  await page.click('text=B1 services layout');
  await page.waitForTimeout(1200);
  const C = (x, y) => page.evaluate(([x, y]) => { const v = window.__inkleaf.viewer; const [sx, sy] = v._screenOf(0, [x, y]); return [sx + v.rect.left, sy + v.rect.top]; }, [x, y]);
  const measures = () => page.evaluate(() => (window.__inkleaf.viewer.doc.annots.get(0) || []).filter(a => a.measure).map(a => `${a.type}: ${a.contents.replace(/\n/g, ' | ')}`));
  const bar = () => page.evaluate(() => document.querySelector('#mb-text').textContent + ' [' + document.querySelector('#mb-scale').textContent + ']');
  const drag = async (a, b, n = 10, shiftWobble = 0) => {
    const A = await C(...a), B = await C(...b);
    await page.mouse.move(A[0], A[1]); await page.mouse.down();
    for (let k = 1; k <= n; k++) await page.mouse.move(A[0] + (B[0] - A[0]) * k / n, A[1] + (B[1] - A[1]) * k / n + (k < n ? shiftWobble * Math.sin(k) : shiftWobble));
    await page.mouse.up(); await page.waitForTimeout(150);
  };
  const click = async (p) => { const A = await C(...p); await page.mouse.click(A[0], A[1]); await page.waitForTimeout(60); };

  await page.keyboard.press('r');
  await page.waitForTimeout(200);
  console.log('bar (no scale):', await bar());
  // Scale dialog from the bar's scale chip
  await page.click('#mb-scale');
  await page.waitForTimeout(200);
  await page.selectOption('#sc-preset', 'r:100');
  await page.selectOption('#sc-unit', 'm');
  await page.click('.dialog .btn.primary');
  await page.waitForTimeout(300);
  console.log('bar (1:100):', await bar());

  // distance by dragging: 100 mm on paper at 1:100 = 10 m
  await drag([200, 300], [200 + 100 * MM, 300]);
  // distance by two clicks: 30 mm x 40 mm diagonal = 50 mm -> 5 m
  await click([200, 400]);
  console.log('after 1st click:', await bar());
  const hov = await C(200 + 30 * MM, 400 + 40 * MM); await page.mouse.move(hov[0], hov[1]); await page.waitForTimeout(80);
  console.log('hover (live):', await bar());
  await click([200 + 30 * MM, 400 + 40 * MM]);
  // shift-constrained drag with wobble -> exactly horizontal
  await page.keyboard.down('Shift');
  await drag([200, 600], [200 + 80 * MM, 600], 10, 9);
  await page.keyboard.up('Shift');
  const shiftLine = await page.evaluate(() => { const l = window.__inkleaf.viewer.doc.annots.get(0).filter(a => a.measure).pop(); return l.pts; });
  console.log('shift line is horizontal:', Math.abs(shiftLine[0][1] - shiftLine[1][1]) < 0.02, JSON.stringify(shiftLine));
  // path: 3 clicks + double-click (20 + 20 + 20 mm = 6 m)
  await page.click('#btn-style'); await page.waitForTimeout(150);
  await page.click('.mmodes [data-mode=path]'); await page.keyboard.press('Escape');
  const pts = [[600, 300], [600 + 20 * MM, 300], [600 + 20 * MM, 300 + 20 * MM]];
  for (const p of pts) await click(p);
  const last = await C(600 + 40 * MM, 300 + 20 * MM);
  await page.mouse.dblclick(last[0], last[1]); await page.waitForTimeout(150);
  // area: 50 x 30 mm rectangle -> 15 m², perimeter 16 m; close by clicking the first point
  await page.click('#btn-style'); await page.waitForTimeout(150);
  await page.click('.mmodes [data-mode=area]'); await page.keyboard.press('Escape');
  const r = [[900, 300], [900 + 50 * MM, 300], [900 + 50 * MM, 300 + 30 * MM], [900, 300 + 30 * MM]];
  for (const p of r) await click(p);
  console.log('area live:', await bar());
  await page.screenshot({ path: SP + '/n-area-draft.png' });
  await click(r[0]);
  // area closed with Enter, and Backspace removing a point
  for (const p of [[1300, 300], [1300 + 20 * MM, 300], [1300 + 20 * MM, 300 + 20 * MM], [1300 + 99 * MM, 300 + 99 * MM]]) await click(p);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter'); await page.waitForTimeout(150);
  console.log('measurements:', JSON.stringify(await measures(), null, 1));
  await page.evaluate(() => { const v = window.__inkleaf.viewer; v.setZoom(1.3); v.scrollTo(v.L.left[0] + 150 * 1.3 - 20, v.L.top[0] + 230 * 1.3); });
  await page.waitForTimeout(700);
  await page.screenshot({ path: SP + '/n-measures.png' });
  await page.evaluate(() => window.__inkleaf.viewer.fit('width'));
  await page.waitForTimeout(300);

  // Calibrate: draw over a 100 mm (paper) line and say it is 5000 mm
  await page.click('.tool[data-tool=measure]'); await page.waitForTimeout(150);
  await page.screenshot({ path: SP + '/n-popover.png' });
  await page.click('text=Calibrate from a known length'); await page.waitForTimeout(100);
  console.log('calibrate bar:', await bar());
  await drag([200, 900], [200 + 100 * MM, 900]);
  await page.fill('#cal-len', '5000');
  await page.selectOption('#cal-unit', 'mm');
  await page.screenshot({ path: SP + '/n-calibrate.png' });
  await page.click('.dialog .btn.primary'); await page.waitForTimeout(400);
  console.log('scale after calibrate:', JSON.stringify(await page.evaluate(() => window.__inkleaf.scaleFor(0))));
  console.log('prompt:', await page.evaluate(() => document.querySelector('.dialog h2')?.textContent + ' — ' + document.querySelector('.dialog p')?.textContent));
  await page.click('.dialog .btn.primary'); await page.waitForTimeout(300);
  console.log('after recalculate:', JSON.stringify(await measures()));
  await page.keyboard.press('Control+z'); await page.waitForTimeout(200);
  console.log('undo recalculation:', JSON.stringify((await measures()).slice(0, 2)));
  await page.keyboard.press('Control+y'); await page.waitForTimeout(200);

  // eraser removes a measurement; undo brings it back
  const n0 = (await measures()).length;
  await page.keyboard.press('e');
  await H.pen(H.line(...(await C(200 + 50 * MM, 290)), ...(await C(200 + 50 * MM, 310)), 6));
  await page.waitForTimeout(200);
  const n1 = (await measures()).length;
  await page.keyboard.press('Control+z'); await page.waitForTimeout(200);
  console.log('eraser: ', n0, '->', n1, '-> undo', (await measures()).length);

  // touch: finger taps place points in measure tool (finger draws off), drag still pans
  await page.keyboard.press('r');
  await page.click('#btn-style'); await page.waitForTimeout(150);
  await page.click('.mmodes [data-mode=area]'); await page.keyboard.press('Escape');
  const before = (await measures()).length;
  for (const p of [[300, 1100], [300 + 40 * MM, 1100], [300 + 40 * MM, 1100 + 40 * MM]]) { const A = await C(...p); await H.tap(A[0], A[1]); await page.waitForTimeout(450); }
  const T0 = await C(300, 1100); await H.tap(T0[0], T0[1]); await page.waitForTimeout(200);
  console.log('touch area:', (await measures()).length - before, 'new, last =', (await measures()).pop());
  await page.evaluate(() => window.__inkleaf.viewer.zoomBy(2.5)); await page.waitForTimeout(300);
  const sy0 = await page.evaluate(() => window.__inkleaf.viewer.sy);
  await H.swipe(700, 700, 700, 450, 8, 16); await page.waitForTimeout(700);
  console.log('finger drag pans in measure tool:', Math.round(await page.evaluate(() => window.__inkleaf.viewer.sy) - sy0) > 100);

  // save, reload, check the measurements come back with labels
  await page.keyboard.press('Control+s'); await page.waitForTimeout(1200);
  console.log('dirty after save:', await page.evaluate(() => window.__inkleaf.viewer.dirty));
  const saved = await measures();
  await page.reload(); await page.waitForTimeout(1500);
  await page.evaluate(() => window.__inkleaf.viewer.goToPage(0)); await page.waitForTimeout(800);
  const reloaded = await measures();
  const labels = await page.evaluate(() => [...document.querySelectorAll('.page svg.meas .m-lbl text')].map(t => t.textContent));
  console.log('reloaded same:', JSON.stringify(saved.sort()) === JSON.stringify(reloaded.sort()), reloaded.length, 'labels', JSON.stringify(labels));
  console.log(errs.length ? errs.join('\n') : 'no errors');
  await browser.close();
})();
