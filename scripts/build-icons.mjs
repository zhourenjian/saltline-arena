// Draws the Home Screen icons (public/icons/*.png) with headless Chrome's canvas.
//   node scripts/build-icons.mjs
import { launch } from "../tests/lib/browser.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const out = join(dirname(fileURLToPath(import.meta.url)), "../public/icons");
mkdirSync(out, { recursive: true });
const chrome = await launch({ width: 600, height: 600 });
const page = await chrome.open("about:blank", { wait: "true" });
// size, safe-zone scale (maskable icons keep the mark inside the central 80%)
const draw = (size, k) => `
  const c = document.createElement("canvas"); c.width = c.height = ${size}; const g = c.getContext("2d"), S = ${size};
  g.fillStyle = "#0b0d0f"; g.fillRect(0, 0, S, S);
  const grd = g.createLinearGradient(0, S, 0, 0); grd.addColorStop(0, "#3a2a14"); grd.addColorStop(0.55, "#0b0d0f"); g.fillStyle = grd; g.fillRect(0, 0, S, S);
  g.translate(S / 2, S / 2); g.scale(${k}, ${k}); g.translate(-S / 2, -S / 2);
  // the saltline: a water line with the crosshair above it
  g.strokeStyle = "#ffb347"; g.lineWidth = S * 0.035; g.lineCap = "square";
  g.beginPath(); g.moveTo(S * 0.16, S * 0.62); g.lineTo(S * 0.84, S * 0.62); g.stroke();
  g.lineWidth = S * 0.018; g.strokeStyle = "rgba(232,228,218,0.55)";
  for (const [y, a, b] of [[0.7, 0.24, 0.76], [0.77, 0.32, 0.68]]) { g.beginPath(); g.moveTo(S * a, S * y); g.lineTo(S * b, S * y); g.stroke(); }
  g.strokeStyle = "#e8e4da"; g.lineWidth = S * 0.028;
  g.beginPath(); g.arc(S / 2, S * 0.38, S * 0.15, 0, Math.PI * 2); g.stroke();
  for (const [x1, y1, x2, y2] of [[0.5, 0.17, 0.5, 0.25], [0.5, 0.51, 0.5, 0.59], [0.29, 0.38, 0.37, 0.38], [0.63, 0.38, 0.71, 0.38]]) { g.beginPath(); g.moveTo(S * x1, S * y1); g.lineTo(S * x2, S * y2); g.stroke(); }
  g.fillStyle = "#ffb347"; g.beginPath(); g.arc(S / 2, S * 0.38, S * 0.014, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#e8e4da"; g.font = "700 " + S * 0.09 + "px sans-serif"; g.textAlign = "center"; g.fillText("SALTLINE", S / 2, S * 0.9);
  return c.toDataURL("image/png").split(",")[1];`;
for (const [name, size, k] of [["icon-192.png", 192, 1], ["icon-512.png", 512, 1], ["icon-maskable-512.png", 512, 0.78], ["apple-touch-icon.png", 180, 0.92]]) {
  const b64 = await page.ev(draw(size, k));
  writeFileSync(join(out, name), Buffer.from(b64, "base64"));
  console.log("wrote", name);
}
chrome.kill();
