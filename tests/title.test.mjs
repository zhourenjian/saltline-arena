// The title screen: two-line "SALTLINE ARENA", GitHub link, and the background fight.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./lib/browser.mjs";
import { serve } from "./lib/serve.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STANDALONE = path.join(process.env.SALTLINE_DIST ? path.resolve(process.env.SALTLINE_DIST) : path.join(ROOT, "dist"), "standalone");
if (!existsSync(path.join(STANDALONE, "index.html"))) throw new Error("no build (npm run build)");
mkdirSync(path.join(ROOT, "tests/out"), { recursive: true });
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.stack || e).split("\n").slice(0, 3).join("\n       ")}`); }
}
const ok = (c, m, d) => { if (!c) throw new Error(m + (d !== undefined ? " — " + JSON.stringify(d) : "")); };
const TITLE = `window.__ready && window.__G && window.__G.game && window.__G.game.state === "title"`;
const web = await serve([["/", STANDALONE]]);
const browser = await launch({ width: 1280, height: 720 });
console.log("title screen");
try {
  await test("heading is SALTLINE over ARENA, fits, and the GitHub link opens in a new tab", async () => {
    const page = await browser.open(`${web.url}/?noaudio=1&battle=0&q=low`, { wait: TITLE, window: true });
    const r = await page.ev(`return (() => { const h = document.querySelector(".m-word"), s = h.querySelectorAll("span"), a = document.querySelector("[data-gh]"), b = h.getBoundingClientRect();
      return { text: h.textContent, lines: [...s].map((x) => x.getBoundingClientRect().top), right: b.right, w: innerWidth, href: a && a.href, target: a && a.target, rel: a && a.rel, over: h.scrollWidth > h.clientWidth + 2 }; })()`);
    ok(r.text === "SALTLINEARENA", "heading text", r);
    ok(r.lines[1] > r.lines[0] + 10, "two lines", r);
    ok(r.right <= r.w, "fits", r);
    ok(r.href === "https://github.com/zhourenjian/saltline-arena" && r.target === "_blank" && /noopener/.test(r.rel), "github link", r);
    page.close();
  });
  await test("?battle=1: fighters appear, are visible and shoot", async () => {
    const page = await browser.open(`${web.url}/?noaudio=1&battle=1&q=low`, { wait: TITLE, window: true });
    await page.waitFor(`__G.titleBattle && __G.titleBattle.stats().visible >= 2`, 70000);
    await page.waitFor(`__G.titleBattle.stats().shots >= 3`, 20000);
    const st = await page.ev(`return __G.titleBattle.stats()`);
    ok(st.bots === 2 && st.spot, "bots", st);
    const gap = Math.hypot(st.at[0][0] - st.at[1][0], st.at[0][2] - st.at[1][2]);
    ok(gap > 4, "fighters stay apart", st);
    page.close();
  });
  await test("?battle=0 has no fight; leaving the title hides the fighters", async () => {
    let page = await browser.open(`${web.url}/?noaudio=1&battle=0&q=low`, { wait: TITLE, window: true });
    ok((await page.ev(`return !__G.titleBattle`)) === true, "disabled");
    page.close();
    page = await browser.open(`${web.url}/?noaudio=1&battle=1&q=low`, { wait: TITLE, window: true });
    await page.waitFor(`__G.titleBattle.stats().visible >= 1`, 70000);
    await page.ev(`document.querySelector('.menu [data-act="character"]').click()`);
    await page.waitFor(`__G.titleBattle.stats().visible === 0`, 4000);
    page.close();
  });
} finally {
  console.log(`\n${passed} passed, ${failed} failed`);
  await browser.kill(); await web.close?.();
  process.exit(failed ? 1 : 0);
}
