// Input helpers driving real pointer events through CDP.
module.exports = function (page, cdp) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // The pen. `barrel`: with its side button held (lasso select). `eraser`:
  // its eraser end, which CDP can't send, so those are real PointerEvents
  // with the eraser's button (5) and buttons (32), as Windows reports them.
  async function pen(points, { eraser = false, barrel = false, delay = 8 } = {}) {
    if (eraser) return eraserEnd(points);
    const [x0, y0] = points[0];
    const extra = { pointerType: 'pen', force: 0.5 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, button: 'none', buttons: 0, ...extra });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: barrel ? 'right' : 'left', buttons: barrel ? 2 : 1, clickCount: 1, ...extra });
    for (const [x, y] of points.slice(1)) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: barrel ? 'right' : 'left', buttons: barrel ? 2 : 1, ...extra });
      await sleep(delay);
    }
    const [xn, yn] = points[points.length - 1];
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: xn, y: yn, button: barrel ? 'right' : 'left', buttons: 0, clickCount: 1, ...extra });
  }
  async function eraserEnd(points) {
    await page.evaluate((pts) => {
      const fire = (type, [x, y], buttons, button) => {
        const t = document.elementFromPoint(x, y);
        if (t) t.dispatchEvent(new PointerEvent(type, { pointerType: 'pen', pointerId: 77, isPrimary: true, clientX: x, clientY: y, button, buttons, pressure: buttons ? 0.5 : 0, bubbles: true, cancelable: true, composed: true }));
      };
      fire('pointerdown', pts[0], 32, 5);
      for (const p of pts.slice(1)) fire('pointermove', p, 32, -1);
      fire('pointerup', pts[pts.length - 1], 0, 5);
    }, points);
    await sleep(30);
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
