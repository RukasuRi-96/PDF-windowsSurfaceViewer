// Real Electron app: select + copy via the clipboard IPC, measure, save, relaunch, erase + embed, pages panel, snip to the system clipboard, side by side.
const { _electron: electron } = require('playwright');
const OLD = process.env.WORK, SP = process.env.WORK, R = require('path').join(__dirname, '..');
const MM = 72 / 25.4;
(async () => {
  const launch = (env = {}) => electron.launch({ executablePath: R + '/node_modules/electron/dist/electron', args: ['--no-sandbox', R], env: { ...process.env, INKLEAF_USER_DATA: SP + '/ud', ...env } });
  // A stand-in for the repository's downloads/ folder: version 9.9.9 is out,
  // as an installer zip with the app (files/app.asar) inside.
  const crypto = require('crypto'), fs0 = require('fs'), path0 = require('path');
  const newApp = crypto.randomBytes(200000);
  const zdir = path0.join(SP, 'feedzip'); fs0.rmSync(zdir, { recursive: true, force: true }); fs0.mkdirSync(path0.join(zdir, 'files'), { recursive: true });
  fs0.writeFileSync(path0.join(zdir, 'files', 'app.asar'), newApp);
  fs0.rmSync(path0.join(SP, 'feed.zip'), { force: true });
  require('child_process').execFileSync('zip', ['-q', '-r', path0.join(SP, 'feed.zip'), '.'], { cwd: zdir });
  const zipBytes = fs0.readFileSync(path0.join(SP, 'feed.zip'));
  const feedSrv = require('http').createServer((req, res) => {
    const u = req.url.split('?')[0], base = `http://127.0.0.1:${feedSrv.address().port}`;
    if (u === '/downloads/latest.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ version: '9.9.9', electron: require(R + '/node_modules/electron/package.json').version, notes: ['A test update'], setup: { url: base + '/downloads/updates/EaglesPDF-Setup-9.9.9.zip', sha256: crypto.createHash('sha256').update(zipBytes).digest('hex'), size: zipBytes.length } })); }
    else if (u === '/downloads/updates/EaglesPDF-Setup-9.9.9.zip') { res.writeHead(200, { 'content-length': zipBytes.length }); res.end(zipBytes); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => feedSrv.listen(0, '127.0.0.1', r));
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
  const app2 = await launch({ EAGLES_UPDATE_URL: `http://127.0.0.1:${feedSrv.address().port}/downloads/latest.json` });
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
  // Lasso with the pen's side button round the pasted picture, Ctrl+C: the
  // system clipboard says markups were copied, and Ctrl+V pastes them.
  const pc = await p2.evaluate((i) => { const v = window.__inkleaf.viewer, d = v.doc.annots.get(i).at(-1); v.rect = v.root.getBoundingClientRect(); const s = v._screenOf(i, [(d.rect[0] + d.rect[2]) / 2, (d.rect[1] + d.rect[3]) / 2]); return [s[0] + v.rect.left, s[1] + v.rect.top]; }, z[3]);
  const cdp2 = await p2.context().newCDPSession(p2);
  const lp = []; for (let k = 0; k <= 30; k++) { const a = k / 30 * 2 * Math.PI; lp.push([pc[0] + 150 * Math.cos(a), pc[1] + 100 * Math.sin(a)]); }
  const penEv = (type, [x, y], button, buttons) => cdp2.send('Input.dispatchMouseEvent', { type, x, y, pointerType: 'pen', force: 0.5, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  await penEv('mouseMoved', lp[0], 'none', 0);
  await penEv('mousePressed', lp[0], 'right', 2);
  for (const q of lp.slice(1)) { await penEv('mouseMoved', q, 'right', 2); await p2.waitForTimeout(8); }
  await penEv('mouseReleased', lp[lp.length - 1], 'right', 0);
  await p2.waitForTimeout(300);
  const lassoed = await p2.evaluate(() => window.__inkleaf.viewer.groupCount);
  await p2.keyboard.press('Control+c');
  await p2.waitForTimeout(500);
  const cb2 = await app2.evaluate(async ({ clipboard }) => { const [it] = await clipboard.read(); return it && it.types.includes('text/html') ? await (await it.getType('text/html')).text() : ''; });
  const before = await p2.evaluate((i) => window.__inkleaf.viewer.doc.annots.get(i).length, z[3]);
  await p2.keyboard.press('Control+v');
  await p2.waitForTimeout(600);
  console.log('lasso (pen side button):', lassoed, 'selected · Ctrl+C marks the clipboard', /data-eagles-marks/.test(cb2), '· Ctrl+V pasted', (await p2.evaluate((i) => window.__inkleaf.viewer.doc.annots.get(i).length, z[3])) - before);
  await p2.keyboard.press('Control+s');
  await p2.waitForFunction(() => !window.__inkleaf.viewer.dirty, null, { timeout: 15000 });
  // Side by side
  await p2.click('#btn-sidebar').catch(() => {});
  if (!(await p2.isVisible('.sb-row:has-text("B2 services layout")'))) await p2.click('#btn-sidebar');
  await p2.click('.sb-row:has-text("B2 services layout")', { button: 'right' });
  await p2.click('.menu button:has-text("Open side by side")');
  await p2.waitForFunction(() => window.__inkleaf.panes.length === 2 && window.__inkleaf.panes[1].view.querySelector('.page.ready'), null, { timeout: 15000 });
  console.log('side by side:', await p2.textContent('.pane.active .pane-name'), '·', await p2.evaluate(() => window.__inkleaf.panes.every(P => P.el.getBoundingClientRect().width > 200)), '· in use:', await p2.evaluate(() => window.__inkleaf.state.path.split(/[\\/]/).pop()));
  await p2.click('.pane.active [data-act=close]');
  await p2.waitForFunction(() => window.__inkleaf.panes.length === 1);
  // Updates: found a few seconds after start, the ⋯ menu offers it, downloaded
  // and checked, then "When I close the app".
  await p2.waitForFunction(() => window.__inkleaf.updateInfo?.latest === '9.9.9', null, { timeout: 20000 });
  const badge = await p2.evaluate(() => document.querySelector('#btn-more').classList.contains('badge'));
  await p2.keyboard.press('Escape');
  await p2.click('#btn-more');
  await p2.click('.menu button:has-text("Update to version 9.9.9")');
  await p2.waitForSelector('.dialog:has-text("Update to version 9.9.9?")');
  const notes = await p2.textContent('.dialog .upd-notes');
  const tick = await p2.evaluate(() => { const r = document.querySelector('#upd-auto').getBoundingClientRect(), l = document.querySelector('.upd-auto').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left - l.left) }; });
  await p2.screenshot({ path: SP + '/upd-dialog.png' });
  await p2.click('.dialog .btn:has-text("Update now")');
  await p2.waitForSelector('.dialog:has-text("The update is ready")', { timeout: 15000 });
  await p2.click('.dialog .btn:has-text("When I close the app")');
  await p2.waitForTimeout(300);
  const staged = require('fs').existsSync(SP + '/ud/update/app-9.9.9.asar') && require('fs').readFileSync(SP + '/ud/update/app-9.9.9.asar').equals(newApp);
  console.log('update: found at start', badge, '· notes', JSON.stringify(notes.trim()), '· tick box', tick.w + 'x' + tick.h, 'at the left', tick.left <= 2, '· downloaded, checked and unpacked', staged, '· version shown', await p2.evaluate(() => window.inkleaf.version));
  await app2.close();
  // The next start says whether an update took. Not installed: the log of
  // that attempt and the installer offered.
  const ud = SP + '/ud', ver = require(R + '/package.json').version;
  fs0.writeFileSync(ud + '/update-pending.json', JSON.stringify({ version: '9.9.9', from: ver, kind: 'app', token: 'feedbeef0001', at: Date.now() }));
  fs0.appendFileSync(ud + '/update.log', '2026-01-01 10:00:00  started feedbeef0001: installing version 9.9.9\r\n2026-01-01 10:00:03  could not replace the app: The process cannot access the file\r\n');
  const app3 = await launch();
  const p3 = await app3.firstWindow();
  await p3.waitForSelector('.dialog:has-text("The update didn\'t install")', { timeout: 15000 });
  const failLog = await p3.textContent('.dialog .upd-log');
  const failBtn = await p3.isVisible('.dialog .btn.primary:has-text("Get the installer")');
  await p3.screenshot({ path: SP + '/upd-failed.png' });
  await p3.click('.dialog .btn:has-text("Close")');
  console.log('update not installed: told at the next start, with what happened', /started feedbeef0001/.test(failLog) && /could not replace the app/.test(failLog), '· the installer offered', failBtn, '· asked once', !fs0.existsSync(ud + '/update-pending.json'));
  await app3.close();
  // Installed: a short message.
  fs0.writeFileSync(ud + '/update-pending.json', JSON.stringify({ version: ver, from: '1.10.2', kind: 'app', token: 'feedbeef0002', at: Date.now() }));
  const app4 = await launch();
  const p4 = await app4.firstWindow();
  const okToast = await p4.waitForSelector(`.toast:has-text("updated to version ${ver}")`, { timeout: 15000 }).then(() => true, () => false);
  console.log('update installed: told at the next start', okToast);
  await app4.close();
  feedSrv.close();
  console.log(logs.length ? logs.join('\n') : 'no errors');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
