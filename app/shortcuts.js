// Keyboard shortcuts: turning key presses into combo names ("Ctrl+Shift+S"),
// showing them, and a keymap of user overrides on top of the defaults.
//
// Letters, digits and punctuation are named by their physical key
// (KeyboardEvent.code), so shortcuts keep working with other keyboard
// layouts and input methods.

const PUNCT = {
  Equal: "=", Minus: "-", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Backquote: "`", IntlBackslash: "\\",
  NumpadAdd: "+", NumpadSubtract: "-", NumpadMultiply: "*", NumpadDivide: "/", NumpadDecimal: ".",
};
const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "Fn", "OS"]);

export function keyName(e) {
  const c = e.code || "";
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^Numpad\d$/.test(c)) return c.slice(6);
  if (PUNCT[c]) return PUNCT[c];
  if (c === "Space" || e.key === " ") return "Space";
  if (MODIFIERS.has(e.key)) return null;
  if (!e.key || e.key === "Unidentified" || e.key === "Process" || e.key === "Dead") return null;
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

// "Ctrl+Alt+Shift+K", or null for a lone modifier.
export function comboFromEvent(e) {
  const k = keyName(e);
  if (!k) return null;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(k);
  return parts.join("+");
}

const NICE = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", PageUp: "PgUp", PageDown: "PgDn",
  Delete: "Del", Escape: "Esc", Backspace: "Backspace", Enter: "Enter", Space: "Space",
};
export function formatCombo(c) {
  if (!c) return "";
  const parts = c.split("+");
  // "Ctrl++" splits into ["Ctrl", "", ""]: the key itself is "+".
  if (c.endsWith("++")) { parts.splice(parts.length - 2, 2, "+"); }
  return parts.map((p) => NICE[p] || p).join("+");
}

// Commands: [{ id, keys: [default combos], ... }]. Overrides: { id: [combos] }.
export class Keymap {
  constructor(commands, overrides) {
    this.commands = commands;
    this.byId = new Map(commands.map((c) => [c.id, c]));
    this.overrides = overrides || {};
    this.rebuild();
  }
  keys(id) {
    const o = this.overrides[id];
    return Array.isArray(o) ? o : this.byId.get(id)?.keys || [];
  }
  isDefault(id) { return !Array.isArray(this.overrides[id]); }
  rebuild() {
    this.owner = new Map();
    for (const c of this.commands) for (const k of this.keys(c.id)) if (!this.owner.has(k)) this.owner.set(k, c.id);
  }
  lookup(combo) { return this.owner.get(combo) || null; }
  set(id, list) {
    const def = this.byId.get(id)?.keys || [];
    if (list.length === def.length && list.every((k, i) => k === def[i])) delete this.overrides[id];
    else this.overrides[id] = list.slice();
    this.rebuild();
  }
  add(id, combo) {
    const list = this.keys(id).filter((k) => k !== combo);
    list.push(combo);
    this.set(id, list);
  }
  remove(id, combo) { this.set(id, this.keys(id).filter((k) => k !== combo)); }
  reset(id) { delete this.overrides[id]; this.rebuild(); }
  resetAll() { for (const k of Object.keys(this.overrides)) delete this.overrides[k]; this.rebuild(); }
  // First shortcut, for menus; all of them, for tooltips.
  label(id) { return formatCombo(this.keys(id)[0]); }
  labelAll(id) { return this.keys(id).map(formatCombo).join(" or "); }
}
