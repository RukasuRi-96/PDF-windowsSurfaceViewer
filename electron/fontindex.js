// Find the installed font file that matches a font name used in a PDF
// ("ABCDEF+Calibri-Bold", "ArialMT", "TimesNewRomanPS-BoldMT", "Calibri,Bold"),
// so text retyped into a PDF can use the same typeface. Shared by the
// Electron main process and the dev server.
//
// Only the font files' name tables are read (a few small reads per file),
// once, the first time a font is looked up.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");

function fontDirs() {
  if (process.platform === "win32") {
    return [
      path.join(process.env.WINDIR || "C:\\Windows", "Fonts"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"),
    ].filter(Boolean);
  }
  if (process.platform === "darwin") return ["/System/Library/Fonts", "/Library/Fonts", path.join(os.homedir(), "Library", "Fonts")];
  return ["/usr/share/fonts", "/usr/local/share/fonts", path.join(os.homedir(), ".fonts"), path.join(os.homedir(), ".local", "share", "fonts")];
}

async function listFiles(dir, out, depth = 0) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 4) await listFiles(full, out, depth + 1); }
    else if (/\.(ttf|otf|ttc)$/i.test(e.name)) out.push(full);
  }
}

async function readAt(fh, pos, len) {
  const b = Buffer.alloc(len);
  const { bytesRead } = await fh.read(b, 0, len, pos);
  return b.subarray(0, bytesRead);
}

// Names (family, subfamily, full, PostScript, typographic family/subfamily)
// and style of the font starting at `off` in the file.
async function readFace(fh, off) {
  const head = await readAt(fh, off, 12);
  if (head.length < 12) return null;
  const n = head.readUInt16BE(4);
  const dir = await readAt(fh, off + 12, n * 16);
  const tables = {};
  for (let k = 0; k + 16 <= dir.length; k += 16) tables[dir.toString("latin1", k, k + 4)] = { off: dir.readUInt32BE(k + 8), len: dir.readUInt32BE(k + 12) };
  const nt = tables.name;
  if (!nt || nt.len > 1 << 20) return null;
  const nb = await readAt(fh, nt.off, nt.len);
  const count = nb.readUInt16BE(2), strOff = nb.readUInt16BE(4);
  const names = {}, rank = {};
  for (let k = 0; k < count; k++) {
    const r = 6 + k * 12;
    if (r + 12 > nb.length) break;
    const plat = nb.readUInt16BE(r), enc = nb.readUInt16BE(r + 2), lang = nb.readUInt16BE(r + 4), id = nb.readUInt16BE(r + 6);
    const len = nb.readUInt16BE(r + 8), so = strOff + nb.readUInt16BE(r + 10);
    if (![1, 2, 4, 6, 16, 17].includes(id) || so + len > nb.length) continue;
    let s, score;
    if (plat === 3 && (enc === 1 || enc === 10 || enc === 0)) {
      const sw = Buffer.from(nb.subarray(so, so + len));
      sw.swap16();
      s = sw.toString("utf16le");
      score = lang === 0x409 ? 3 : 2;
    } else if (plat === 1 && enc === 0) {
      s = nb.toString("latin1", so, so + len);
      score = 1;
    } else continue;
    if (!(rank[id] >= score)) { names[id] = s; rank[id] = score; }
  }
  let bold = false, italic = false;
  const os2 = tables["OS/2"];
  if (os2 && os2.len >= 64) {
    const ob = await readAt(fh, os2.off, 64);
    const weight = ob.readUInt16BE(4), sel = ob.readUInt16BE(62);
    bold = weight >= 600 || !!(sel & 32);
    italic = !!(sel & 1);
  } else {
    const sub = (names[17] || names[2] || "").toLowerCase();
    bold = /bold|black|heavy/.test(sub);
    italic = /italic|oblique/.test(sub);
  }
  return { family: names[16] || names[1] || "", family1: names[1] || "", sub: names[17] || names[2] || "", full: names[4] || "", ps: names[6] || "", bold, italic };
}

async function indexFile(file) {
  const fh = await fsp.open(file, "r");
  try {
    const head = await readAt(fh, 0, 12);
    if (head.length < 12) return [];
    let offs = [0];
    if (head.toString("latin1", 0, 4) === "ttcf") {
      const n = Math.min(head.readUInt32BE(8), 64);
      const ob = await readAt(fh, 12, n * 4);
      offs = [];
      for (let k = 0; k + 4 <= ob.length; k += 4) offs.push(ob.readUInt32BE(k));
    }
    const out = [];
    for (let i = 0; i < offs.length; i++) {
      try { const f = await readFace(fh, offs[i]); if (f && (f.ps || f.family)) out.push({ file, index: i, ...f }); } catch {}
    }
    return out;
  } finally {
    await fh.close();
  }
}

let indexP = null;
function buildIndex() {
  if (!indexP) {
    indexP = (async () => {
      const files = [];
      for (const d of fontDirs()) await listFiles(d, files);
      const all = [];
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const f = files[next++];
          try { all.push(...(await indexFile(f))); } catch {}
        }
      };
      await Promise.all(Array.from({ length: 16 }, worker));
      return all;
    })();
  }
  return indexP;
}

// Metric-compatible stand-ins, used when the font itself isn't installed.
const ALIASES = [
  ["calibri", "carlito"], ["cambria", "caladea"],
  ["arial", "helvetica", "liberationsans", "arimo", "nimbussans"],
  ["timesnewroman", "times", "liberationserif", "tinos", "nimbusroman"],
  ["couriernew", "courier", "liberationmono", "cousine", "nimbusmono"],
];
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const STYLE = /(bold|black|heavy|semibold|demibold|italic|oblique|regular|roman|book|medium|light|condensed|narrow)/gi;

// { name, bold, italic } -> { file, index, family, ps, bold, italic } | null
async function findFont({ name, bold = false, italic = false } = {}) {
  const clean = String(name || "").replace(/^[A-Z]{6}\+/, "").trim();
  if (!clean) return null;
  const all = await buildIndex();
  const n = norm(clean);
  const pick = (f) => ({ file: f.file, index: f.index, family: f.family1 || f.family, ps: f.ps, bold: f.bold, italic: f.italic });
  // 1. The exact face: PostScript name ("Calibri-Bold") or full name ("Calibri Bold").
  const exact = all.find((f) => norm(f.ps) === n) || all.find((f) => norm(f.full) === n);
  if (exact) return pick(exact);
  // 2. Same family, closest style. "TimesNewRomanPS-BoldMT" -> family
  //    "TimesNewRoman", bold.
  const [base, ...rest] = clean.split(/[,-]/);
  const tail = rest.join(" ");
  const wantBold = bold || /bold|black|heavy|semibold|demi/i.test(tail);
  const wantItalic = italic || /italic|oblique/i.test(tail);
  const fam = norm(base.replace(/(PSMT|PS|MT)$/, "").replace(STYLE, ""));
  if (!fam) return null;
  let same = all.filter((f) => norm(f.family) === fam || norm(f.family1) === fam);
  if (!same.length) {
    const group = ALIASES.find((g) => g.includes(fam)) || [];
    for (const alt of group) {
      same = all.filter((f) => norm(f.family) === alt || norm(f.family1) === alt);
      if (same.length) break;
    }
  }
  if (!same.length) return null;
  const score = (f) => (f.bold === wantBold ? 2 : 0) + (f.italic === wantItalic ? 2 : 0) + (/regular|roman|book|normal/i.test(f.sub) || (!f.bold && !f.italic) ? 0.5 : 0);
  same.sort((a, b) => score(b) - score(a));
  return pick(same[0]);
}

module.exports = { findFont, buildIndex };
