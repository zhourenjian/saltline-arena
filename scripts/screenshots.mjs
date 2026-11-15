// Regenerates the README screenshots (docs/screenshots/arena-*.jpg): real build, real server, a few
// headless pages in one arena.   npm run build && node scripts/screenshots.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "../tests/lib/browser.mjs";
import { serve } from "../tests/lib/serve.mjs";
import { startDuelServer } from "../server/duel-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs/screenshots");
mkdirSync(OUT, { recursive: true });
const web = await serve([["/", path.join(ROOT, "dist/standalone")]]);
const duel = startDuelServer({ port: 0, host: "127.0.0.1", quiet: true, env: { BRAWL_MAX_PLAYERS: "2", BRAWL_MAX_ARENAS: "1", BRAWL_AFK_SECONDS: "3600", BRAWL_STALLED_SECONDS: "3600", BRAWL_CULL_SECONDS: "600", MAX_CONNECTIONS_PER_IP: "20" } });
const server = `ws://127.0.0.1:${await duel.ready}`;
const browser = await launch({ width: 1280, height: 720 });
const TITLE = `window.__ready && window.__G && window.__G.game && window.__G.game.state === "title"`;
const open = (extra = "") => browser.open(`${web.url}/?q=high&noaudio=1&noinstall=1${extra}&server=${encodeURIComponent(server)}`, { wait: TITLE, window: true });
const act = (p, a) => p.ev(`document.querySelector('.menu [data-act="${a}"]').click()`);
const save = async (p, n) => writeFileSync(path.join(OUT, `${n}.jpg`), await p.screenshot(82));
async function enter(p, name, how = "br-enter") {
  await act(p, "brawl");
  await p.waitFor(`__G.game.menus.screen === "brawl"`, 3000);
  await p.ev(`const n = document.querySelector('[data-f="br-name"]'); n.value = ${JSON.stringify(name)}; n.dispatchEvent(new Event("change"));`);
  await act(p, how);
  await p.waitFor(`__G.brawl.entered && __G.game.state === "playing"`, 20000);
}
try {
  const A = await open();
  await save(A, "arena-title");
  await enter(A, "Alpha");
  const B = await open("&avatar=masked-raider");
  await enter(B, "Bravo");
  await A.waitFor(`__G.brawl.remotes.size === 1`, 8000);
  await B.waitFor(`__G.brawl.remotes.size === 1`, 8000);
  // stand Bravo three metres in front of Alpha, both on open ground
  await A.ev(`__G.player.pitch = 0`);
  for (let a = 0; a < 24; a++) {
    const ok = await A.ev(`const h = __G.player.pos.clone(); h.y += 1.5; const d = new __G.player.pos.constructor(Math.sin(${a} * Math.PI / 12), 0, Math.cos(${a} * Math.PI / 12)); return !__G.physics.raycast(h, d, 5)`);
    if (!ok) continue;
    await A.ev(`const a = ${a} * Math.PI / 12; __G.player.yaw = Math.atan2(-Math.sin(a), -Math.cos(a)); `);
    await B.ev(`const A = [...__G.brawl.remotes.values()][0].opp.pos, a = ${a} * Math.PI / 12; __G.player.pos.set(A.x + Math.sin(a) * 3.2, A.y, A.z + Math.cos(a) * 3.2); __G.player.yaw = Math.atan2(Math.sin(a), Math.cos(a)); __G.player.pitch = 0;`);
    break;
  }
  await sleep(1500);
  await save(A, "arena-duel");
  // a spectator in the queue
  const C = await open();
  await enter(C, "Charlie");
  await C.waitFor(`__G.brawl.role === "queued"`, 8000);
  await sleep(2500);
  await save(C, "arena-spectate");
} finally {
  browser.kill(); await duel.close(); web.close();
}
