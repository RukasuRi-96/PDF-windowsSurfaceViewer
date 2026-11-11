// Builds app/icons.js from lucide-static (ISC license) so the app ships no runtime deps.
const fs = require("fs");
const path = require("path");
const names = {
  sidebar: "panel-left", folderOpen: "folder-open", folder: "folder", refresh: "refresh-cw", search: "search",
  hand: "hand", highlighter: "highlighter", pen: "pen-line", square: "square", eraser: "eraser",
  undo: "undo-2", redo: "redo-2", zoomIn: "zoom-in", zoomOut: "zoom-out", fitWidth: "move-horizontal",
  fitPage: "scan", save: "save", touch: "pointer", more: "ellipsis", file: "file-text", chevron: "chevron-right",
  x: "x", check: "check", openFile: "file-down", external: "external-link", copy: "copy", info: "info",
  collapse: "chevrons-down-up",
  select: "text-cursor", ruler: "ruler", distance: "move-diagonal-2", path: "waypoints", area: "pentagon",
  calibrate: "crosshair",
  line: "minus", arrow: "move-up-right", cloud: "cloud", callout: "message-square-text", text: "type",
  signature: "signature", imagePlus: "image-plus", trash: "trash-2", caret: "chevron-down", wand: "wand-sparkles", keyboard: "keyboard",
};
const dir = path.join(__dirname, "..", "node_modules", "lucide-static", "icons");
let out = "// Generated from lucide-static (ISC License, https://lucide.dev). Do not edit.\nexport const ICONS = {\n";
for (const [k, n] of Object.entries(names)) {
  const svg = fs.readFileSync(path.join(dir, n + ".svg"), "utf8");
  const inner = svg.slice(svg.indexOf(">", svg.indexOf("<svg")) + 1, svg.lastIndexOf("</svg>")).replace(/\s*\n\s*/g, "");
  out += `  ${k}: ${JSON.stringify(inner)},\n`;
}
out += "};\n\nexport function icon(name, cls = \"\") {\n  return `<svg class=\"icon ${cls}\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">${ICONS[name]}</svg>`;\n}\n";
fs.writeFileSync(path.join(__dirname, "..", "app", "icons.js"), out);
console.log("icons:", Object.keys(names).length);
