// Filesystem helpers shared by the Electron main process and the dev server.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const SKIP_DIRS = new Set(["node_modules", "$recycle.bin", "system volume information", "__macosx", "$windows.~ws", "$windows.~bt"]);

// Recursively list every PDF below `root`. Returns a tree; empty folders are pruned.
async function scanFolder(root, { maxEntries = 300000 } = {}) {
  let seen = 0;
  let active = 0;
  const waiters = [];
  const acquire = () => (active < 24 ? (active++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
  const release = () => { const w = waiters.shift(); if (w) w(); else active--; };

  async function walk(dir, name) {
    const node = { name, path: dir, dirs: [], files: [] };
    let entries;
    await acquire();
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return node;
    } finally {
      release();
    }
    const subs = [];
    for (const e of entries) {
      if (++seen > maxEntries) break;
      const n = e.name;
      if (n.startsWith(".") || n.startsWith("~$")) continue;
      const full = path.join(dir, n);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(n.toLowerCase())) subs.push(walk(full, n));
      } else if ((e.isFile() || e.isSymbolicLink()) && n.toLowerCase().endsWith(".pdf")) {
        node.files.push({ name: n, path: full });
      }
    }
    for (const s of await Promise.all(subs)) {
      if (s.files.length || s.dirs.length) node.dirs.push(s);
    }
    return node;
  }
  return walk(root, path.basename(root) || root);
}

// Write via a temp file + rename so a crash never leaves a half-written PDF.
async function writeFileSafe(target, bytes) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.inkleaf-${process.pid}-${Date.now()}.tmp`);
  try {
    await fsp.writeFile(tmp, bytes);
    try {
      await fsp.rename(tmp, target);
    } catch (err) {
      // Some sync clients / AV hold the file; fall back to overwriting in place.
      await fsp.writeFile(target, bytes);
      await fsp.unlink(tmp).catch(() => {});
    }
    return { ok: true };
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    return { ok: false, error: err.code === "EPERM" || err.code === "EACCES" ? "Permission denied" : err.code === "EBUSY" ? "The file is in use by another program" : err.message };
  }
}

async function stat(p) {
  const s = await fsp.stat(p);
  return { size: s.size, mtime: s.mtimeMs, isDirectory: s.isDirectory() };
}

module.exports = { scanFolder, writeFileSafe, stat };
