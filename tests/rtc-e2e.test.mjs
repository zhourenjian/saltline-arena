// A real (headless Chrome) page against the real standalone build and server with WebRTC on:
// the browser must open the UDP data channel, play over it, and keep working over the WebSocket
// when the channel is switched off (?rtc=0).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { launch } from "./lib/browser.mjs";
import { serve } from "./lib/serve.mjs";
import { startDuelServer } from "../server/duel-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.SALTLINE_DIST ? path.resolve(process.env.SALTLINE_DIST) : path.join(ROOT, "dist");
const STANDALONE = path.join(DIST, "standalone");
console.log("webrtc in the browser");
let hasNd = true;
try {
  createRequire(import.meta.url)("node-datachannel");
} catch {
  hasNd = false;
}
if (!hasNd || !existsSync(STANDALONE)) {
  console.log("  skip: needs node-datachannel and a build in dist/");
  process.exit(0);
}
let passed = 0,
  failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(e.stack || e).split("\n").slice(0, 4).join("\n       ")}`);
  }
}
const web = await serve([["/", STANDALONE]]);
const duel = startDuelServer({ port: 0, host: "127.0.0.1", quiet: true, env: { RTC_PORT: "40996", MAX_CONNECTIONS_PER_IP: "20" } });
const port = await duel.ready;
const browser = await launch();
const TITLE = `window.__ready && window.__G && window.__G.game && window.__G.game.state === "title"`;
const enter = async (page) => {
  await page.ev(`document.querySelector('.menu [data-act="brawl"]').click()`);
  await page.waitFor(`__G.game.menus.screen === "brawl"`, 3000);
  await page.ev(`document.querySelector('.menu [data-act="br-enter"]').click()`);
  await page.waitFor(`__G.brawl.entered && __G.game.mode === "brawl" && __G.game.state === "playing"`, 15000);
};
const server = encodeURIComponent(`ws://127.0.0.1:${port}`);
try {
  await test("the page opens the data channel and sends its poses over it", async () => {
    const page = await browser.open(`${web.url}/?q=low&noaudio=1&server=${server}`, { wait: TITLE, window: true });
    await enter(page);
    await page.waitFor(`window.__saltlineNet && window.__saltlineNet.transport === "udp"`, 15000);
    // UDP pings are answered and counted
    await page.waitFor(`(window.__saltlineNet.pingStats() || {}).un > 0`, 8000);
  });
  await test("?rtc=0 keeps everything on the WebSocket", async () => {
    const page = await browser.open(`${web.url}/?q=low&noaudio=1&rtc=0&server=${server}`, { wait: TITLE, window: true });
    await enter(page);
    await new Promise((r) => setTimeout(r, 4000));
    const t = await page.ev(`return window.__saltlineNet.transport`);
    if (t !== "ws") throw new Error(`expected ws, got ${t}`);
  });
} finally {
  browser.kill();
  await duel.close();
  web.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
