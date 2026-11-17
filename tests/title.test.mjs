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
  await test("aiming: the barrel line goes through the shooter's camera at any pitch (the aimed-at player looks into the muzzle)", async () => {
    const page = await browser.open(`${web.url}/?noaudio=1&battle=1&q=low`, { wait: TITLE, window: true });
    await page.waitFor(`__G.titleBattle && __G.titleBattle.stats().visible >= 1`, 70000);
    await page.ev(`const T = __G.titleBattle;
      __G.frameHooks.push(() => T.bots().forEach((x) => { x.nextShot = 99; x.burst = 0; x.hp = 100; }));
      const cp = __G.camera.position.clone(), cq = __G.camera.quaternion.clone();
      __G.frameHooks.push(() => { __G.camera.position.copy(cp); __G.camera.quaternion.copy(cq); __G.camera.updateMatrixWorld(true); });
      const b = T.bots()[0]; b.goal.copy(b.p); b.hold = 999; b.v.set(0, 0, 0); window.__ad = 1;
      if (!b.__p) { b.__p = 1; const push = b.opp.push; b.opp.push = (m) => { m.loco.ad = window.__ad; m.v = [0, 0, 0]; return push(m); }; }`);
    for (const pitch of [-0.7, 0, 0.6]) {
      await page.ev(`__G.titleBattle.pitch = ${pitch}`);
      await sleep(1200);
      await page.waitFor(`(() => { const V = __G.camera.position.constructor; return __G.titleBattle.bots()[0].opp.muzzle(new V(), new V()); })()`, 70000);
      const d = await page.ev(`const T = __G.titleBattle, b = T.bots()[0], V = __G.camera.position.constructor, p = new V(), dir = new V();
        if (!b.opp.muzzle(p, dir)) return { err: "no muzzle" };
        const cam = new V(b.p.x, b.p.y + 1.68, b.p.z), w = cam.clone().sub(p), t = w.dot(dir), off = w.clone().addScaledVector(dir, -t).length();
        return { off, t, pitchDir: Math.asin(dir.y) };`);
      if (d.err) { await page.waitFor(`__G.titleBattle.bots()[0].opp.visible`, 70000); }
      ok(!d.err && d.off < 0.22, `pitch ${pitch}: muzzle line misses the camera by ${d.off}`, d);
    }
    // the stock stays about where it is when the gun is carried (at the shoulder) and out of the head
    const rear = (ad) => page.ev(`window.__ad = ${ad}; __G.titleBattle.pitch = 0; return new Promise((res) => setTimeout(() => { const T = __G.titleBattle, b = T.bots()[0], V = __G.camera.position.constructor, p = new V(), d = new V();
      let n = 0; const go = () => { if (!b.opp.muzzle(p, d)) return n++ < 200 ? setTimeout(go, 100) : res({ err: 1 }); fin(); };
      const fin = () => {
      const r = p.clone().addScaledVector(d, -0.73), head = new V(b.p.x, b.p.y + 1.62, b.p.z);
      res({ rear: [r.x - b.p.x, r.y - b.p.y, r.z - b.p.z], head: r.distanceTo(head) }); }; go(); }, 1500))`);
    await page.waitFor(`(() => { const V = __G.camera.position.constructor; return __G.titleBattle.bots()[0].opp.muzzle(new V(), new V()); })()`, 70000);
    const hip = await rear(0), aim = await rear(1);
    ok(!hip.err && !aim.err, "muzzle for the stock check", { hip, aim });
    const moved = Math.hypot(hip.rear[0] - aim.rear[0], hip.rear[1] - aim.rear[1], hip.rear[2] - aim.rear[2]);
    ok(moved < 0.25, `stock moves ${moved} m between carrying and aiming`, { hip, aim });
    ok(aim.head > 0.14, `stock ${aim.head} m from the head centre (inside the head)`, aim);
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
