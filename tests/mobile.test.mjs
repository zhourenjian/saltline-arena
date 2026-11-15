// Phones and tablets (headless Chrome with touch + mobile metrics emulation):
//   node tests/mobile.test.mjs            (uses dist/standalone, or SALTLINE_DIST)
// Covers: the Home Screen pieces (manifest, icons, meta tags, guide), the MENU button in the
// brawl, rotation with stale browser metrics, page scroll pinning, unlimited ammo in the brawl
// and the 30 fps cap. Screenshots land in tests/out/mobile-*.jpg.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./lib/browser.mjs";
import { serve } from "./lib/serve.mjs";
import { startDuelServer } from "../server/duel-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/out");
mkdirSync(OUT, { recursive: true });
const DIST = process.env.SALTLINE_DIST ? path.resolve(process.env.SALTLINE_DIST) : path.join(ROOT, "dist");
const STANDALONE = path.join(DIST, "standalone");
if (!existsSync(path.join(STANDALONE, "index.html"))) throw new Error(`no build at ${STANDALONE} (npm run build)`);

let passed = 0,
  failed = 0;
const failures = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(e.stack || e).split("\n").slice(0, 4).join("\n       ")}`);
  }
}
function assert(ok, msg, detail) {
  if (!ok) throw new Error(msg + (detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""));
}

const web = await serve([["/", STANDALONE]]);
const duel = startDuelServer({ port: 0, host: "127.0.0.1", quiet: true });
const port = await duel.ready;
const server = `ws://127.0.0.1:${port}`;
const browser = await launch({ width: 390, height: 844 });
const pages = [];
const TITLE = `window.__ready && window.__G && window.__G.game && window.__G.game.state === "title"`;
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const spoof = (ua, standalone = false) => `
  try { localStorage.removeItem("saltline.install.hideUntil"); } catch {}
  Object.defineProperty(navigator, "userAgent", { get: () => ${JSON.stringify(ua)} });
  Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 });
  ${standalone ? 'Object.defineProperty(navigator, "standalone", { get: () => true });' : ""}`;
const query = `?q=low&noaudio=1&server=${encodeURIComponent(server)}`;
const queryAuto = `?noaudio=1&server=${encodeURIComponent(server)}`; // no q=: the quality is picked from the device
const metrics = (page, w, h) => page.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true, screenWidth: w, screenHeight: h });
async function phone(extra = "", init = "", q = query) {
  // one heavy WebGL page at a time: the earlier ones would starve the new one
  for (const p of pages.splice(0)) p.close();
  await sleep(300);
  const page = await browser.open(`${web.url}/${q}${extra}`, { wait: TITLE, window: true, init });
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await metrics(page, 390, 844);
  await sleep(400);
  return page;
}
const tap = async (page, x, y) => {
  await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await sleep(60);
  await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(250);
};
async function enterBrawl(page) {
  await tap(page, 200, 420); // the first touch switches the controls to touch mode
  await page.ev(`document.querySelector('.menu [data-act="brawl"]').click()`);
  await page.waitFor(`__G.game.menus.screen === "brawl"`, 3000);
  await page.ev(`document.querySelector('[data-act="br-enter"]').click()`);
  await page.waitFor(`__G.brawl.entered && __G.game.mode === "brawl" && __G.game.state === "playing"`, 15000);
  await sleep(1200);
}
const rect = (page, sel) => page.ev(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, shown: e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden" }`);
const overlap = (a, b) => a && b && a.shown && b.shown && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

console.log("Home Screen");
await test("manifest, icons and the Home Screen meta tags are published", async () => {
  const html = readFileSync(path.join(STANDALONE, "index.html"), "utf8");
  for (const needle of ['rel="manifest"', 'name="apple-mobile-web-app-capable"', 'name="mobile-web-app-capable"', "black-translucent", 'rel="apple-touch-icon"', "viewport-fit=cover"])
    assert(html.includes(needle), "index.html has " + needle);
  const m = JSON.parse(readFileSync(path.join(STANDALONE, "manifest.webmanifest"), "utf8"));
  assert(m.display === "fullscreen" && m.display_override.includes("standalone"), "full screen display", m.display);
  assert(m.start_url === "./" && m.scope === "./", "relative start_url and scope (works under any path)");
  assert(m.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable"), "maskable icon");
  for (const i of m.icons) assert(existsSync(path.join(STANDALONE, i.src)), "icon exists: " + i.src);
  assert(existsSync(path.join(STANDALONE, "icons/apple-touch-icon.png")), "apple touch icon");
  const res = await fetch(`${web.url}/manifest.webmanifest`);
  assert(res.ok, "manifest is served", res.status);
});

await test("iPhone in a browser tab: the guide opens by itself with the Share steps; dismissal sticks", async () => {
  const page = await phone("", spoof(IPHONE));
  pages.push(page);
  await page.waitFor(`__G.installGuide && __G.installGuide.visible`, 6000);
  const text = await page.ev(`return document.querySelector(".install-guide").innerText`);
  assert(/Share/i.test(text) && /Add to Home Screen/i.test(text), "iOS steps", text.slice(0, 200));
  assert(!/Install app/i.test(text), "no Android wording on iOS");
  const link = await rect(page, "[data-install]");
  assert(link && link.shown, "the title screen has the Add to Home Screen link");
  writeFileSync(path.join(OUT, "mobile-install-ios.jpg"), await page.screenshot());
  const btn = await rect(page, '[data-ig="later"]');
  assert(btn && btn.y + btn.h <= 844 && btn.x >= 0 && btn.x + btn.w <= 390, "buttons are inside the screen", btn);
  await page.ev(`document.querySelector('[data-ig="later"]').click()`);
  assert(!(await page.ev(`return __G.installGuide.visible`)), "closed");
  const until = await page.ev(`return +localStorage.getItem("saltline.install.hideUntil")`);
  assert(until > Date.now() + 6 * 864e5, "hidden for about a week", until);
  await page.ev(`__G.installGuide.open()`);
  assert(await page.ev(`return __G.installGuide.visible`), "the title link can open it again");
  await page.ev(`__G.installGuide.close()`);
});

await test("Android shows the Chrome menu steps; the installed app never shows the guide", async () => {
  const page = await phone("", spoof(ANDROID));
  pages.push(page);
  await page.waitFor(`__G.installGuide && __G.installGuide.visible`, 6000);
  const text = await page.ev(`return document.querySelector(".install-guide").innerText`);
  assert(/Install app/i.test(text) && !/Share button/i.test(text), "Android steps", text.slice(0, 200));
  assert(/Full screen now/i.test(text), "Android offers the Fullscreen API button");
  const app = await phone("", spoof(IPHONE, true));
  pages.push(app);
  await sleep(2600);
  assert(!(await app.ev(`return __G.installGuide.visible`)), "no guide when started from the Home Screen");
  const link = await rect(app, "[data-install]");
  assert(!link || !link.shown, "no title link in the installed app");
  const desk = await browser.open(`${web.url}/${query}`, { wait: TITLE, window: true });
  pages.push(desk);
  await sleep(2600);
  assert(!(await desk.ev(`return __G.installGuide.visible`)), "no guide on a desktop browser");
});

console.log("Phone layout");
await test("brawl on a phone: the MENU button is visible, unobstructed, and opens the pause menu", async () => {
  const page = await phone("&noinstall=1");
  pages.push(page);
  await enterBrawl(page);
  const btn = await rect(page, ".t-pause");
  assert(btn && btn.shown && btn.w >= 56 && btn.h >= 36, "a real button, not a corner dot", btn);
  assert(await page.ev(`return document.querySelector(".t-pause").innerText.trim() === "MENU"`), "labelled MENU");
  const stats = await rect(page, ".net-stats"),
    board = await rect(page, ".br-side");
  assert(!overlap(btn, stats), "FPS / ping readout is not on top of the button", { btn, stats });
  assert(!overlap(btn, board), "brawl board is not on top of the button", { btn, board });
  const ammo = await rect(page, ".h-ammo");
  assert(!overlap(board, ammo), "brawl board is not on top of the ammo counter (portrait)", { board, ammo });
  const top = await page.ev(`const b = document.querySelector(".t-pause").getBoundingClientRect(); const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return e && e.closest(".t-pause") ? "button" : (e && e.className) || String(e)`);
  assert(top === "button", "the button is what a finger touches", top);
  writeFileSync(path.join(OUT, "mobile-brawl-portrait.jpg"), await page.screenshot());
  await tap(page, btn.x + btn.w / 2, btn.y + btn.h / 2);
  assert((await page.ev(`return __G.game.state`)) === "paused", "tapping MENU pauses and opens the menu");
  const actions = await page.ev(`return [...document.querySelectorAll('.menu [data-s="paused"] [data-act]')].map((b) => b.dataset.act)`);
  assert(actions.includes("resume") && actions.includes("settings") && actions.includes("quit"), "resume, settings and quit are there", actions);
  await page.ev(`document.querySelector('.menu [data-s="paused"] [data-act="resume"]').click()`);
  await page.waitFor(`__G.game.state === "playing"`, 3000);
});

await test("rotation: stale browser metrics are corrected, canvas and camera follow, buttons stay hittable", async () => {
  const page = await phone("&noinstall=1");
  pages.push(page);
  await enterBrawl(page);
  // iOS reports the old size for a moment after a rotation: fake that
  await page.ev(`window.__stale = { on: true, w: 390, h: 844 };
    Object.defineProperty(window, "innerWidth", { configurable: true, get: () => __stale.on ? __stale.w : visualViewport.width });
    Object.defineProperty(window, "innerHeight", { configurable: true, get: () => __stale.on ? __stale.h : visualViewport.height });`);
  const sizes = async () => JSON.parse(await page.ev(`const c = document.getElementById("view"), a = document.getElementById("app"), f = document.querySelector(".t-fire").getBoundingClientRect();
    return JSON.stringify({ css: [c.clientWidth, c.clientHeight], buf: [c.width, c.height], app: [a.clientWidth, a.clientHeight], aspect: __G.camera.aspect, fire: [f.x, f.y, f.width, f.height], vp: [visualViewport.width, visualViewport.height] })`));
  for (let round = 0; round < 3; round++) {
    const land = round % 2 === 0;
    await metrics(page, land ? 844 : 390, land ? 390 : 844);
    await sleep(150);
    await page.ev(`__stale.on = false`); // the browser catches up, without another event
    const [w, h] = land ? [844, 390] : [390, 844];
    await page.waitFor(`document.getElementById("view").clientWidth === ${w} && document.getElementById("view").clientHeight === ${h} && Math.abs(__G.camera.aspect - ${w / h}) < 0.01`, 4000);
    await sleep(300);
    const s = await sizes();
    assert(s.app[0] === w && s.app[1] === h, "app box fills the screen", s);
    assert(Math.abs(s.buf[0] / s.buf[1] - w / h) < 0.02, "drawing buffer has the screen's aspect (not narrower / squashed)", s);
    assert(s.fire[1] + s.fire[3] <= h + 1 && s.fire[0] + s.fire[2] <= w + 1, "FIRE button is on screen", s);
    // and a finger on FIRE reaches it (no vertical offset)
    const hit = await page.ev(`const f = document.querySelector(".t-fire").getBoundingClientRect(); const e = document.elementFromPoint(f.x + f.width / 2, f.y + f.height / 2); return e && !!e.closest(".t-fire")`);
    assert(hit, "FIRE is what a finger touches after rotation round " + round, s);
    const b = await rect(page, ".br-side"),
      am = await rect(page, ".h-ammo"),
      mn = await rect(page, ".t-pause");
    assert(!overlap(b, am) && !overlap(b, mn), "board clear of ammo and MENU, round " + round, { b, am, mn });
    if (land) writeFileSync(path.join(OUT, "mobile-brawl-landscape.jpg"), await page.screenshot());
    await page.ev(`__stale.on = true; __stale.w = ${w}; __stale.h = ${h};`);
  }
});

async function enterWatch(page) {
  await tap(page, 200, 420);
  await page.ev(`document.querySelector('.menu [data-act="brawl"]').click()`);
  await page.waitFor(`__G.game.menus.screen === "brawl"`, 3000);
  await page.ev(`document.querySelector('[data-act="br-watch-only"]').click()`);
  await page.waitFor(`__G.brawl.entered && __G.game.state === "playing"`, 15000);
  await sleep(1500);
}
const shown = (r) => r && r.shown && r.w > 0 && r.h > 0;

await test("full-screen title: no letterbox bars, the app box is the whole screen, both orientations", async () => {
  const page = await phone("&noinstall=1");
  pages.push(page);
  for (const [w, h] of [[390, 844], [844, 390], [390, 844]]) {
    await metrics(page, w, h);
    await sleep(500);
    const bars = await page.ev(`return [...document.querySelectorAll(".m-bars i")].map((i) => i.getClientRects().length)`);
    assert(bars.every((n) => n === 0), "the cinematic bars are not rendered on a touch screen", bars);
    const a = await rect(page, "#app"), u = await rect(page, "#ui");
    assert(a.x === 0 && a.y === 0 && a.w === w && a.h === h && u.w === w && u.h === h, "app and ui fill the screen", { a, u, w, h });
    const c = await page.ev(`const c = document.getElementById("view"); return [c.clientWidth, c.clientHeight]`);
    assert(c[0] === w && c[1] === h, "canvas fills the screen", c);
  }
});

await test("character select: the model is outside the card in portrait and landscape", async () => {
  const page = await phone("&noinstall=1");
  pages.push(page);
  await tap(page, 200, 420);
  for (const [w, h] of [[390, 844], [844, 390]]) {
    await metrics(page, w, h);
    await sleep(500);
    await page.ev(`document.querySelector('.menu [data-act="character"]').click()`);
    await page.waitFor(`__G.game.menus.screen === "character"`, 3000);
    await sleep(1400);
    const r = JSON.parse(await page.ev(`
      const cam = __G.camera, P = cam.position.constructor, d = cam.getWorldDirection(new P());
      const out = {};
      for (const [k, dy] of [["feet", -1.0], ["head", 0.75], ["mid", 0]]) {
        const v = cam.position.clone().addScaledVector(d, 3.1); v.y += dy; v.project(cam);
        out[k] = [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight];
      }
      const c = document.querySelector(".m-card.m-chars").getBoundingClientRect();
      out.card = [c.left, c.top, c.right, c.bottom];
      out.view = !!(cam.view && cam.view.enabled);
      return JSON.stringify(out);`));
    const inCard = (p) => p[0] > r.card[0] && p[0] < r.card[2] && p[1] > r.card[1] && p[1] < r.card[3];
    assert(r.view, "the picture is shifted into the free part", r);
    assert(!inCard(r.mid) && !inCard(r.head), "the model's body and head are not under the card " + w + "x" + h, r);
    assert(r.head[1] > 0 && r.feet[1] < h + 2 && r.mid[0] > 0 && r.mid[0] < w, "the whole model is on screen", r);
    if (w < h) assert(r.feet[1] <= r.card[1] + 6, "portrait: feet end above the card", r);
    else assert(r.mid[0] >= r.card[2] - 6, "landscape: model is right of the card", r);
    writeFileSync(path.join(OUT, `mobile-character-${w < h ? "portrait" : "landscape"}.jpg`), await page.screenshot());
    await page.ev(`document.querySelector('[data-act="ch-done"]').click()`);
    await page.waitFor(`__G.game.menus.screen === "title"`, 3000);
    await sleep(300);
    assert(!(await page.ev(`return !!(__G.camera.view && __G.camera.view.enabled)`)), "the view offset is cleared when leaving");
  }
});

await test("watching on a phone: no action buttons, lists in opposite corners, slim bar, PAUSED on top", async () => {
  const page = await phone("&noinstall=1");
  pages.push(page);
  await enterWatch(page);
  for (const [w, h] of [[390, 844], [844, 390]]) {
    await metrics(page, w, h);
    await sleep(700);
    for (const sel of [".t-fire", ".t-ads", ".t-reload", ".t-jump", ".t-interact"]) assert(!shown(await rect(page, sel)), "action button hidden while watching: " + sel);
    assert(shown(await rect(page, ".t-pause")), "MENU stays");
    const board = await rect(page, ".br-board"), wait = await rect(page, ".br-wait"), spec = await rect(page, ".br-spec"), chat = await rect(page, ".br-chat");
    assert(shown(board) && shown(wait), "both lists are shown", { board, wait });
    assert(board.x + board.w / 2 < w / 2 && wait.x + wait.w / 2 > w / 2, "players on the left, the queue on the right", { board, wait });
    assert(board.y < h * 0.3 && wait.y < h * 0.3, "lists are up in the corners", { board, wait });
    assert(board.w <= w * 0.32 && wait.w <= w * 0.32, "lists are narrow", { board, wait });
    const mid = { x: w * 0.3, y: h * 0.3, w: w * 0.4, h: h * 0.4, shown: true };
    for (const [n, r] of Object.entries({ board, wait, spec, chat })) assert(!overlap(mid, r), n + " leaves the middle of the screen free", { r, mid });
    assert(spec.h <= (w > h ? 40 : 48), "the Play / Follow / Free cam bar is slim", spec);
    assert(spec.w <= w - 20 && spec.x >= 0, "the bar fits the screen", spec);
    // the bar says nothing the lists, the chat box or the buttons already say; no keyboard hints on a phone
    const bar = await page.ev(`return document.querySelector(".br-spec").innerText`);
    assert(!/watching|hold v|enter|Q\/E|tab|free mouse/i.test(bar.replace(/free cam/i, "")), "no duplicated or keyboard-only text in the bar", bar);
    const btns = await page.ev(`return [...document.querySelectorAll(".br-spec-b button")].map((b) => b.textContent.trim())`);
    assert(btns.length === 2 && /^follow/i.test(btns[0]) && /free cam/i.test(btns[1]), "the bar has only the Follow / Free cam toggle", btns);
    const seat = await page.ev(`return [...document.querySelectorAll(".br-wait .br-wait-b button")].map((b) => b.textContent.trim())`);
    assert(seat.length === 1 && /play|queue/i.test(seat[0]), "the seat button sits under the queue list", seat);
    const seatRect = await rect(page, ".br-wait .br-wait-b button");
    assert(seatRect.shown && seatRect.h >= 30, "the seat button is a real touch target", seatRect);
    // Follow / Free cam is a toggle; a second tap on Follow moves on to the next player
    await tap(page, ...(await page.ev(`const b = document.querySelectorAll(".br-spec-b button")[1].getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]`)));
    assert((await page.ev(`return __G.brawl.spectator.mode`)) === "free", "Free cam switches to the free camera");
    await tap(page, ...(await page.ev(`const b = document.querySelectorAll(".br-spec-b button")[0].getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]`)));
    assert((await page.ev(`return __G.brawl.spectator.mode`)) === "follow", "Follow switches back");
    await page.ev(`window.__nexts = 0; const s = __G.brawl.spectator, n = s.next; s.next = () => (window.__nexts++, n());`);
    await tap(page, ...(await page.ev(`const b = document.querySelectorAll(".br-spec-b button")[0].getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]`)));
    assert((await page.ev(`return window.__nexts`)) === 1, "tapping Follow while following cycles to the next player");
    await page.ev(`delete __G.brawl.spectator.next`);
    writeFileSync(path.join(OUT, `mobile-watch-${w < h ? "portrait" : "landscape"}.jpg`), await page.screenshot());
    // the pause card is above every brawl panel
    await tap(page, ...(await page.ev(`const b = document.querySelector(".t-pause").getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]`)));
    assert((await page.ev(`return __G.game.state`)) === "paused", "MENU pauses while watching");
    const card = await rect(page, '.menu[data-screen="paused"] .m-card');
    assert(card && card.shown, "the PAUSED card is shown", card);
    const top = await page.ev(`const c = document.querySelector('.menu .m-card:not([hidden])'); const out = [];
      for (const r of [[0.1, 0.1], [0.9, 0.1], [0.5, 0.5], [0.1, 0.9], [0.9, 0.9], [0.5, 0.95]]) {
        const b = c.getBoundingClientRect(), e = document.elementFromPoint(b.left + b.width * r[0], b.top + b.height * r[1]);
        out.push(!e || !!e.closest(".menu"));
      } return out;`);
    assert(top.every(Boolean), "nothing from the brawl HUD sits over the PAUSED card", top);
    writeFileSync(path.join(OUT, `mobile-watch-pause-${w < h ? "portrait" : "landscape"}.jpg`), await page.screenshot());
    await page.ev(`__G.game.resume()`);
    await page.waitFor(`__G.game.state === "playing"`, 3000);
  }
});

await test("touch crouch toggle: CROUCH latches the stance, a second tap stands up; hidden while watching", async () => {
  const page = await phone("&noinstall=1");
  pages.push(page);
  await enterBrawl(page);
  const b = await rect(page, ".t-crouch");
  assert(shown(b) && b.w >= 48, "a CROUCH button", b);
  for (const sel of [".t-fire", ".t-jump", ".t-reload", ".t-ads"]) assert(!overlap(b, await rect(page, sel)), "CROUCH does not overlap " + sel);
  await tap(page, b.x + b.w / 2, b.y + b.h / 2);
  await page.waitFor(`__G.player.crouching === true`, 2000);
  assert(await page.ev(`return document.querySelector(".t-crouch").classList.contains("active")`), "button shows it is on");
  await tap(page, b.x + b.w / 2, b.y + b.h / 2);
  await page.waitFor(`__G.player.crouching === false`, 2000);
});

await test("Home Screen app whose layout viewport stops above the home indicator: the app box still reaches the screen's bottom edge", async () => {
  const page = await phone("&noinstall=1", spoof(IPHONE, true));
  pages.push(page);
  // layout 390x800 on a 390x844 screen: a 44 px strip would stay black
  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });
  await page.waitFor(`document.getElementById("app").getBoundingClientRect().height === 844`, 4000);
  const c = await page.ev(`const c = document.getElementById("view"); return [c.clientWidth, c.clientHeight]`);
  assert(c[1] === 844, "the canvas fills the full screen height too", c);
  const doc = await page.ev(`const r = document.documentElement; return { cls: r.classList.contains("is-standalone"), h: r.getBoundingClientRect().height, sh: r.scrollHeight, pos: getComputedStyle(r).position, ih: innerHeight }`);
  assert(doc.cls && doc.pos === "static" && doc.h >= doc.ih && doc.sh >= doc.ih, "Home Screen app: the document itself is a full screen tall (iOS gives the short viewport only to shorter documents)", doc);
  // an ordinary page (not a Home Screen app) must not grow past its viewport
  const tab = await phone("&noinstall=1", spoof(IPHONE, false));
  pages.push(tab);
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });
  await sleep(1800);
  assert((await tab.ev(`return document.getElementById("app").getBoundingClientRect().height`)) === 800, "browser tab: no extra growth");
});

await test("the page cannot be scrolled out of place", async () => {
  const page = await phone("&noinstall=1");
  pages.push(page);
  await page.ev(`document.scrollingElement.scrollTop = 60; window.scrollTo(0, 60); window.dispatchEvent(new Event("scroll"))`);
  await sleep(200);
  const y = await page.ev(`return window.scrollY + document.scrollingElement.scrollTop`);
  assert(y === 0, "scroll position is pinned to 0", y);
  const pos = await page.ev(`const r = document.getElementById("app").getBoundingClientRect(); return [r.x, r.y]`);
  assert(pos[0] === 0 && pos[1] === 0, "app box sits at the top-left corner", pos);
});

console.log("Brawl ammunition and performance");
await test("Home Screen app on a 402x874 phone: the app box holds one height through rotations (no flip-flop between measurements)", async () => {
  const page = await phone("&noinstall=1", spoof(IPHONE, true));
  pages.push(page);
  const seen = async (w, h, ms = 2200) => {
    await page.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true, screenWidth: 402, screenHeight: 874 });
    await sleep(500); // the settling measurements after a change
    const out = new Set();
    for (let t = 0; t < ms; t += 100) {
      out.add(await page.ev(`const a = document.getElementById("app"); return a.clientWidth + "x" + a.clientHeight`));
      await sleep(100);
    }
    return [...out];
  };
  // the layout viewport 62 px short of the screen at first, then the full window (iOS 26 behaviour)
  let a = await seen(402, 812, 800);
  a = await seen(402, 874);
  assert(a.length === 1 && a[0] === "402x874", "portrait: one stable size", a);
  a = await seen(874, 402);
  assert(a.length === 1 && a[0] === "874x402", "landscape: one stable size", a);
  a = await seen(402, 874);
  assert(a.length === 1 && a[0] === "402x874", "back to portrait: one stable size", a);
});

await test("touch ids may be negative (iOS 26) and a finger that vanished without a touchend does not lock the left stick", async () => {
  const page = await phone("&noinstall=1", spoof(IPHONE));
  pages.push(page);
  await enterBrawl(page);
  const p0 = await page.ev(`return [__G.player.pos.x, __G.player.pos.z]`);
  await page.ev(`
    const c = document.getElementById("view");
    const mk = (id, x, y) => new Touch({ identifier: id, target: c, clientX: x, clientY: y });
    const fire = (type, ch, all) => c.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, changedTouches: ch, touches: all, targetTouches: all }));
    const a = mk(-117731596, 80, 600); fire("touchstart", [a], [a]);
    const b = mk(-117731594, 90, 600); fire("touchstart", [b], [b]);
    for (let i = 1; i <= 8; i++) { const m = mk(-117731594, 90, 600 - i * 8); fire("touchmove", [m], [m]); }`);
  await sleep(900);
  const p1 = await page.ev(`return [__G.player.pos.x, __G.player.pos.z]`);
  assert(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) > 1, "the stick still moves the player", { p0, p1 });
});

await test("brawl has unlimited ammo: reloads never run dry, the HUD shows ∞; other modes keep the reserve", async () => {
  const page = await phone("&noinstall=1");
  pages.push(page);
  await enterBrawl(page);
  await page.ev(`__G.weapon.reserve = 0; __G.weapon.ammo = 0; __G.weapon.reloadNow()`);
  await page.waitFor(`__G.weapon.ammo === __G.weapon.magSize`, 6000);
  const after = await page.ev(`return { ammo: __G.weapon.ammo, reserve: __G.weapon.reserve, text: document.querySelector(".h-ammo").innerText, inf: __G.weapon.infiniteAmmo }`);
  assert(after.ammo > 0, "magazine refilled with an empty reserve", after);
  assert(after.inf && after.reserve === 0, "nothing was deducted", after);
  assert(after.text.includes("∞"), "HUD shows the infinity sign", after.text);
  // a long fight: 6 magazines
  for (let i = 0; i < 6; i++) {
    await page.waitFor(`__G.weapon.state === "idle"`, 6000); // the previous reload's animation must finish
    await page.ev(`__G.weapon.ammo = 0; __G.weapon.reloadNow()`);
    await page.waitFor(`__G.weapon.ammo === __G.weapon.magSize`, 6000);
  }
  assert((await page.ev(`return __G.weapon.reserve`)) === 0, "reserve still untouched after six more reloads");
  await page.ev(`__G.game.pause()`);
  await page.waitFor(`__G.game.state === "paused"`, 3000);
  await page.ev(`document.querySelector('.menu [data-s="paused"] [data-act="quit"]').click()`);
  await page.waitFor(`__G.game.state === "title"`, 6000);
  const off = await page.ev(`return { inf: __G.weapon.infiniteAmmo, mode: __G.game.mode }`);
  assert(!off.inf, "outside the brawl the reserve is limited again", off);
});

await test("a phone that cannot hold 60 falls back to a steady 30 fps (frame cap), ?fps= forces it", async () => {
  const page = await phone("&noinstall=1&fps=30", spoof(ANDROID), queryAuto);
  pages.push(page);
  const count = async (ms) => {
    const a = await page.ev(`return __G.time.frame`);
    await sleep(ms);
    return ((await page.ev(`return __G.time.frame`)) - a) * (1000 / ms);
  };
  const capped = await count(1500);
  assert(capped <= 36, "about 30 simulated frames per second with the cap", capped);
  await page.ev(`__G.frameCap = 0`);
  const free = await count(1500);
  assert(free > capped * 1.2 || free > 45, "removing the cap restores the full rate", { capped, free });
  const q = await page.ev(`return __G.quality`);
  assert(q.name === "low" && q.shadow === 1024 && q.volSteps === 8, "phones start on the cheaper low preset", q);
  const min = await page.ev(`return !!window.matchMedia("(pointer: coarse)").matches`);
  assert(typeof min === "boolean", "pointer media query available");
});

for (const p of pages) p.close();
browser.kill();
await duel.close();
web.close();
console.log(`\n${passed} passed, ${failed} failed${failed ? ": " + failures.join("; ") : ""}`);
process.exit(failed ? 1 : 0);
