// Input helpers driving real pointer events through CDP.
module.exports = function (page, cdp) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function pen(points, { eraser = false, delay = 8 } = {}) {
    const [x0, y0] = points[0];
    const extra = { pointerType: 'pen', force: 0.5 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, button: 'none', buttons: 0, ...extra });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: eraser ? 'right' : 'left', buttons: eraser ? 2 : 1, clickCount: 1, ...extra });
    for (const [x, y] of points.slice(1)) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: eraser ? 'right' : 'left', buttons: eraser ? 2 : 1, ...extra });
      await sleep(delay);
    }
    const [xn, yn] = points[points.length - 1];
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: xn, y: yn, button: eraser ? 'right' : 'left', buttons: 0, clickCount: 1, ...extra });
  }
  function line(x0, y0, x1, y1, n = 20) { const out = []; for (let i = 0; i <= n; i++) out.push([x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]); return out; }
  async function touch(type, pts) {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i, radiusX: 4, radiusY: 4, force: 1 })) });
  }
  async function pinch(cx, cy, d0, d1, steps = 12, dx = 0, dy = 0) {
    const pts = (d, k) => [[cx - d / 2 + dx * k, cy + dy * k], [cx + d / 2 + dx * k, cy + dy * k]];
    await touch('touchStart', pts(d0, 0));
    for (let i = 1; i <= steps; i++) { await touch('touchMove', pts(d0 + (d1 - d0) * i / steps, i / steps)); await sleep(16); }
    await touch('touchEnd', []);
  }
  async function swipe(x0, y0, x1, y1, steps = 10, stepMs = 16) {
    await touch('touchStart', [[x0, y0]]);
    for (let i = 1; i <= steps; i++) { await touch('touchMove', [[x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps]]); await sleep(stepMs); }
    await touch('touchEnd', []);
  }
  async function tap(x, y) { await touch('touchStart', [[x, y]]); await sleep(30); await touch('touchEnd', []); }
  return { sleep, pen, line, touch, pinch, swipe, tap };
};
