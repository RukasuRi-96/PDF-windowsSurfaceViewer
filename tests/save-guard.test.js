const { chromium } = require('playwright');
const fs = require('fs');
const SP = process.env.WORK;
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  const cdp = await ctx.newCDPSession(page);
  const H = require('./helpers.js')(page, cdp);
  await page.goto(`http://localhost:5180/?folder=${encodeURIComponent(SP + '/lib')}`);
  await page.waitForTimeout(1000);
  await page.click('text=Notes');
  await page.waitForTimeout(600);
  await page.keyboard.press('p');
  await H.pen(H.line(600, 300, 800, 350, 10));
  // Another program modifies the file
  const f = SP + '/lib/Notes.pdf';
  await new Promise(r => setTimeout(r, 30));
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.dialog', { timeout: 5000 });
  console.log('guard dialog:', await page.textContent('.dialog h2'));
  await page.click('.dialog >> text=Cancel');
  await page.waitForTimeout(200);
  console.log('still dirty after cancel:', await page.evaluate(() => window.__inkleaf.viewer.dirty));
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.dialog');
  await page.click('.dialog >> text=Overwrite');
  await page.waitForFunction(() => !window.__inkleaf.viewer.dirty, null, { timeout: 5000 });
  console.log('overwrite saved; dirty:', await page.evaluate(() => window.__inkleaf.viewer.dirty));
  // Second save without external change should not prompt
  await H.pen(H.line(600, 400, 800, 450, 10));
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.__inkleaf.viewer.dirty, null, { timeout: 5000 });
  console.log('second save, no prompt:', !(await page.isVisible('.dialog')));
  // Mouse drag in grey margin with pen tool pans
  const sy0 = await page.evaluate(() => window.__inkleaf.viewer.sy);
  await page.mouse.move(1430, 600); await page.mouse.down(); await page.mouse.move(1430, 300, { steps: 5 }); await page.mouse.up();
  console.log('margin drag panned:', (await page.evaluate(() => window.__inkleaf.viewer.sy)) !== sy0);
  console.log('errors:', errs.length ? errs : 'none');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
