// Real Electron app: select + copy via the clipboard IPC, measure, save, relaunch, erase + embed, pages panel, snip to the system clipboard, side by side.
const { _electron: electron } = require('playwright');
const OLD = process.env.WORK, SP = process.env.WORK, R = require('path').join(__dirname, '..');
const MM = 72 / 25.4;
(async () => {
  const launch = () => electron.launch({ executablePath: R + '/node_modules/electron/dist/electron', args: ['--no-sandbox', R], env: { ...process.env, INKLEAF_USER_DATA: SP + '/ud' } });
  const app = await launch();
  const page = await app.firstWindow();
  const logs = [];
  page.on('console', m => { if (m.type() !== 'log') logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  await page.waitForSelector('.sb-row.file', { timeout: 15000 });
  await page.click('text=Quarterly summary');
  await page.waitForFunction(() => window.__inkleaf?.viewer.doc?.states.get(0)?.base, null, { timeout: 15000 });
  console.log('has host.copyText:', await page.evaluate(() => typeof window.inkleaf.copyText));
  await page.keyboard.press('v');
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(300);
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
  const sel = await page.evaluate(() => window.__inkleaf.viewer.sel?.text || '');
  console.log('system clipboard matches selection:', clip === sel && clip.length > 100, clip.length, JSON.stringify(clip.slice(0, 40)));
  // measure on the drawing
  await page.click('text=B1 services layout');
  await page.waitForFunction(() => window.__inkleaf?.state.path?.includes('B1') && window.__inkleaf.viewer.doc?.states.get(0)?.base, null, { timeout: 15000 });
  await page.evaluate(async () => { const m = await import('./measure.js'); await window.__inkleaf.setScale('all', m.ratioScale(50, 'mm')); });
  await page.keyboard.press('r');
  const C = (x, y) => page.evaluate(([x, y]) => { const v = window.__inkleaf.viewer; const [sx, sy] = v._screenOf(0, [x, y]); return [sx + v.rect.left, sy + v.rect.top]; }, [x, y]);
  const A = await C(300, 300), B = await C(300 + 60 * MM, 300);
  await page.mouse.move(A[0], A[1]); await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(A[0] + (B[0] - A[0]) * k / 10, A[1]);
  await page.mouse.up(); await page.waitForTimeout(200);
  console.log('measurement:', await page.evaluate(() => window.__inkleaf.viewer.doc.annots.get(0).filter(a => a.measure).map(a => a.contents).join(', ')));
  // Signature through the real file APIs: write a JPEG, list the folder, prepare it, place it.
  const sigDir = SP + '/esigs', sigFile = sigDir + '/scan.jpg';
  require('fs').mkdirSync(sigDir, { recursive: true });
  await page.evaluate(async (p) => {
    const c = new OffscreenCanvas(400, 150), g = c.getContext('2d');
    g.fillStyle = 'rgb(240,236,226)'; g.fillRect(0, 0, 400, 150);
    g.strokeStyle = 'rgb(20,30,90)'; g.lineWidth = 5; g.beginPath(); g.moveTo(30, 100); g.bezierCurveTo(120, 10, 200, 140, 370, 40); g.stroke();
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg' })).arrayBuffer());
    await window.inkleaf.writeFile(p, bytes);
  }, sigFile);
  console.log('listImages via IPC:', JSON.stringify((await page.evaluate((d) => window.inkleaf.listImages(d), sigDir)).map(f => f.name)));
  page.evaluate((p) => { window.__inkleaf.prepareSignature(p); }, sigFile);
  await page.waitForSelector('.sigprep canvas', { timeout: 10000 });
  await page.click('.dialog .btn.primary');
  await page.waitForSelector('.sig-place', { timeout: 10000 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  console.log('signature placed:', await page.evaluate(() => (window.__inkleaf.viewer.doc.annots.get(0) || []).filter(a => a.shape && a.shape.k === 'sig').length));
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.__inkleaf.viewer.dirty, null, { timeout: 10000 });
  await page.screenshot({ path: SP + '/e3.png' });
  await app.close();
  const app2 = await launch();
  const p2 = await app2.firstWindow();
  await p2.waitForFunction(() => window.__inkleaf?.viewer.doc?.states.get(0)?.base, null, { timeout: 15000 });
  await p2.waitForTimeout(500);
  console.log('relaunch: my signatures', await p2.evaluate(() => window.__inkleaf.sigs().length), 'signatures on page', await p2.evaluate(() => (window.__inkleaf.viewer.doc.annots.get(0) || []).filter(a => a.shape && a.shape.k === 'sig').length));
  console.log('relaunch:', await p2.evaluate(() => window.__inkleaf.state.path.split('/').pop()), 'tool', await p2.evaluate(() => window.__inkleaf.viewer.tool), 'scale', await p2.evaluate(() => window.__inkleaf.scaleFor(0).label), 'measures', await p2.evaluate(() => (window.__inkleaf.viewer.doc.annots.get(0) || []).filter(a => a.measure).map(a => a.contents).join()));
  // Erase an area (applied on save) and embed the markups over the file, through the desktop write path.
  await p2.keyboard.press('x');
  const C2 = (x, y) => p2.evaluate(([x, y]) => { const v = window.__inkleaf.viewer; const [sx, sy] = v._screenOf(0, [x, y]); return [sx + v.rect.left, sy + v.rect.top]; }, [x, y]);
  const a0 = await C2(60, 60), a1 = await C2(260, 140);
  await p2.mouse.move(a0[0], a0[1]); await p2.mouse.down(); await p2.mouse.move(a1[0], a1[1], { steps: 6 }); await p2.mouse.up();
  await p2.waitForTimeout(200);
  await p2.keyboard.press('Control+s');
  await p2.waitForSelector('.dialog'); await p2.click('.dialog .btn.primary');
  await p2.waitForFunction(() => !window.__inkleaf.viewer.dirty && window.__inkleaf.viewer.doc?.annotsP.size > 0, null, { timeout: 15000 });
  await p2.waitForTimeout(600);
  const kept = await p2.evaluate(() => (window.__inkleaf.viewer.doc.annots.get(0) || []).length);
  await p2.click('#btn-more'); await p2.click('.menu button:has-text("Embed markups")');
  await p2.waitForSelector('.dialog'); await p2.click('.dialog .btn:has-text("Replace this file")');
  await p2.waitForFunction(() => !window.__inkleaf.viewer.dirty && window.__inkleaf.viewer.doc?.annotsP.size > 0, null, { timeout: 15000 });
  await p2.waitForTimeout(600);
  console.log('erase + save: markups kept', kept, '· embed over the file: markups left', await p2.evaluate(() => (window.__inkleaf.viewer.doc.annots.get(0) || []).length));
  // Pages panel in the desktop app: thumbnails render, a blank page is added and saved.
  await p2.click('#btn-pages');
  await p2.waitForSelector('.pp-item[data-i="0"] canvas', { timeout: 10000 });
  await p2.click('.pp-head [data-act=add]'); await p2.click('.menu button:has-text("Blank page")');
  await p2.waitForSelector('#bp-size'); await p2.click('.dialog .btn.primary');
  await p2.waitForFunction(() => window.__inkleaf.viewer.pageCount === 2, null, { timeout: 15000 });
  await p2.keyboard.press('Control+s');
  await p2.waitForFunction(() => !window.__inkleaf.viewer.dirty, null, { timeout: 15000 });
  await p2.waitForTimeout(500);
  console.log('pages panel: thumbnail shown, blank page added and saved:', await p2.evaluate(() => window.__inkleaf.viewer.pageCount), 'pages');
  // Snip: the picture reaches the system clipboard (marked as ours), and Ctrl+V pastes it at the same size.
  await p2.keyboard.press('c');
  await p2.keyboard.press('Control+9'); // fit the page, so the middle of the view is on it
  await p2.waitForTimeout(500);
  const z = await p2.evaluate(() => { const v = window.__inkleaf.viewer, r = v.rect; const [wx, wy] = v._toWorld(r.left + v.vw / 2, r.top + v.vh / 2); return [r.left + v.vw / 2 - 100, r.top + v.vh / 2 - 60, v.scale, v._hitPage(wx, wy, 0)]; });
  await p2.mouse.move(z[0], z[1]); await p2.mouse.down(); await p2.mouse.move(z[0] + 200, z[1] + 120, { steps: 8 }); await p2.mouse.up();
  await p2.waitForTimeout(1200);
  const cb = await app2.evaluate(async ({ clipboard }) => {
    const [it] = await clipboard.read();
    const html = it && it.types.includes('text/html') ? await (await it.getType('text/html')).text() : '';
    return { image: !!it && it.types.includes('image/png'), marked: /data-eagles-snip/.test(html) };
  });
  await p2.keyboard.press('Control+v');
  await p2.waitForTimeout(800);
  const pic = await p2.evaluate((i) => { const d = (window.__inkleaf.viewer.doc.annots.get(i) || []).at(-1); if (!d) return null; return d.shape && d.shape.k === 'image' ? [d.rect[2] - d.rect[0], d.rect[3] - d.rect[1]] : null; }, z[3]);
  console.log('snip: system clipboard has the picture', cb.image, '· marked as ours', cb.marked, '· pasted at the same size', !!pic && Math.abs(pic[0] - 200 / z[2]) < 1.5 && Math.abs(pic[1] - 120 / z[2]) < 1.5);
  await p2.keyboard.press('Control+s');
  await p2.waitForFunction(() => !window.__inkleaf.viewer.dirty, null, { timeout: 15000 });
  // Side by side
  await p2.click('#btn-sidebar').catch(() => {});
  if (!(await p2.isVisible('.sb-row:has-text("B2 services layout")'))) await p2.click('#btn-sidebar');
  await p2.click('.sb-row:has-text("B2 services layout")', { button: 'right' });
  await p2.click('.menu button:has-text("Open side by side")');
  await p2.waitForFunction(() => document.querySelector('#viewer2 .page.ready'), null, { timeout: 15000 });
  console.log('side by side:', await p2.textContent('.side-name'), '·', await p2.evaluate(() => Math.round(document.querySelector('#viewer2').getBoundingClientRect().width)) > 200);
  await p2.click('.side-head [data-act=close]');
  await app2.close();
  console.log(logs.length ? logs.join('\n') : 'no errors');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
