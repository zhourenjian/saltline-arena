// Browser test for the brawl: four headless Chrome pages against the real standalone build and
// the real server, with seats limited to 2 so the queue, offers and spectators all happen.
//   node tests/brawl-e2e.test.mjs            (builds first if dist/ is missing)
//   node tests/brawl-e2e.test.mjs --build    (always rebuild)
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./lib/browser.mjs";
import { serve } from "./lib/serve.mjs";
import { startDuelServer } from "../server/duel-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/out");
const DIST = process.env.SALTLINE_DIST ? path.resolve(process.env.SALTLINE_DIST) : path.join(ROOT, "dist");
const STANDALONE = path.join(DIST, "standalone");
mkdirSync(OUT, { recursive: true });
if (process.argv.includes("--build") || !existsSync(STANDALONE)) {
  if (process.env.SALTLINE_DIST) throw new Error(`no build in ${DIST} (SALTLINE_DIST)`);
  console.log("building (npm run build) ...");
  execSync("npm run build", { cwd: ROOT, stdio: "inherit" });
}

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
// all four pages come from 127.0.0.1, so the per-IP cap is raised for the test
const duel = startDuelServer({
  port: 0,
  host: "127.0.0.1",
  quiet: true,
  // the players stand still between steps and a loading page can stall the others for a few
  // seconds: no AFK / stalled removal and no cut of the last place during the test
  // (tests/brawl.test.mjs covers those with a fake clock)
  env: { BRAWL_MAX_PLAYERS: "2", BRAWL_MAX_ARENAS: "1", BRAWL_AFK_SECONDS: "3600", BRAWL_STALLED_SECONDS: "3600", BRAWL_CULL_SECONDS: "600", MAX_CONNECTIONS_PER_IP: "20" },
});
const port = await duel.ready;
const server = `ws://127.0.0.1:${port}`;
const browser = await launch();
const pages = [];
const TITLE = `window.__ready && window.__G && window.__G.game && window.__G.game.state === "title"`;

async function open() {
  const page = await browser.open(`${web.url}/?q=low&noaudio=1&server=${encodeURIComponent(server)}`, { wait: TITLE, window: true });
  pages.push(page);
  return page;
}
const act = (page, a) => page.ev(`document.querySelector('.menu [data-act="${a}"]').click()`);
const errorsOf = (page) => page.logs.filter((l) => /^EXC|^error:/.test(l) && !/favicon|ERR_CONNECTION_REFUSED/.test(l));
const role = (page) => page.ev(`return __G.brawl.role`);
const toasts = (page) => page.ev(`return __G.brawl.hud.toastText.join(" | ")`);
async function shot(page, name) {
  writeFileSync(path.join(OUT, `brawl-${name}.jpg`), await page.screenshot());
}

async function enter(page, name, how = "br-enter") {
  await act(page, "brawl");
  await page.waitFor(`__G.game.menus.screen === "brawl"`, 3000);
  await page.ev(`const n = document.querySelector('[data-f="br-name"]'); n.value = ${JSON.stringify(name)}; n.dispatchEvent(new Event("change"));`);
  await act(page, how);
  await page.waitFor(`__G.brawl.entered && __G.game.mode === "brawl" && __G.game.state === "playing"`, 15000);
}

let A, B, C, D;
try {
  console.log("brawl");

  await test("menu: Brawl button, screen with the server prefilled, Escape back", async () => {
    A = await open();
    const acts = await A.ev(`return [...document.querySelectorAll('.menu [data-s="title"] [data-act]')].map(b => b.dataset.act)`);
    assert(acts.includes("brawl"), "brawl button", acts);
    await act(A, "brawl");
    assert((await A.ev(`return document.querySelector('[data-f="br-server"]').value`)) === server, "?server= prefilled");
    await A.keyDown("Escape");
    await A.keyUp("Escape");
    await A.waitFor(`__G.game.menus.screen === "title"`, 3000);
  });

  await test("first player: a free seat is taken at once, no play-or-watch question", async () => {
    await enter(A, "Alpha");
    await A.waitFor(`__G.brawl.role === "playing"`, 5000);
    assert(!(await A.ev(`return __G.brawl.hud.promptOpen`)), "no prompt");
    const st = await A.ev(`return { en: __G.player.enabled, gun: __G.weapon.visible !== false, board: __G.brawl.arena && __G.brawl.arena.players.length }`);
    assert(st.en && st.board === 1, "playing, alone on the board", st);
  });

  await test("corner readout shows FPS and the server ping", async () => {
    await A.waitFor(`__G.netStats && /FPS \\d+/.test(__G.netStats.text) && /PING \\d+ ms/.test(__G.netStats.text)`, 8000);
    const r = await A.ev(`const e = document.querySelector('.net-stats'); const b = e.getBoundingClientRect(); return { text: e.textContent, top: b.top, right: innerWidth - b.right, shown: getComputedStyle(e).display }`);
    assert(r.shown !== "none" && r.top < 40 && r.right < 40, "top-right corner", r);
  });

  await test("second player joins: everyone in the arena gets a top-centre notice", async () => {
    B = await open();
    await enter(B, "Bravo");
    await B.waitFor(`__G.brawl.role === "playing"`, 5000);
    await A.waitFor(`__G.brawl.hud.toastText.some(t => /Bravo joined/.test(t))`, 5000);
    const box = await A.ev(`const b = document.querySelector('.br-toast').getBoundingClientRect(); return { cx: (b.left + b.right) / 2, top: b.top, w: innerWidth, h: innerHeight }`);
    assert(Math.abs(box.cx - box.w / 2) < 40 && box.top < box.h / 2, "toast in the upper centre", box);
    await A.waitFor(`__G.brawl.remotes.size === 1`, 5000);
    await B.waitFor(`__G.brawl.remotes.size === 1`, 5000);
  });

  await test("arena full: the next player goes straight into the queue and watches", async () => {
    C = await open();
    await enter(C, "Charlie");
    await C.waitFor(`__G.brawl.role === "queued" && __G.brawl.lobby && __G.brawl.lobby.position === 1`, 5000);
    assert(!(await C.ev(`return __G.brawl.hud.promptOpen`)), "no prompt");
    await C.waitFor(`__G.brawl.hud.toastText.some(t => /full.*#1 in the queue/i.test(t))`, 3000);
    const st = await C.ev(`return { en: __G.player.enabled, spec: __G.brawl.spectator.on, bar: __G.brawl.hud.spectatorText, watch: document.querySelector('.hud').classList.contains('br-watching') }`);
    assert(!st.en && st.spec && st.watch, "spectating", st);
    assert(!/watching|hold v|enter chat|queue/i.test(st.bar), "the bar does not repeat the queue list or the chat / mic hints", st);
    assert((await C.ev(`return __G.brawl.hud.waitButtons`)).some((t) => /watch only/i.test(t)), "queued: the seat button under the queue list reads Watch only");
    // wait list top right: me at #1, flashing because I'm next
    await C.waitFor(`__G.brawl.hud.waitFlashing && __G.brawl.hud.waitText.includes("#1Charlie (you)") && /next in line/i.test(__G.brawl.hud.waitText)`, 3000);
    const box = await C.ev(`const b = document.querySelector('.br-wait').getBoundingClientRect(); const s = document.querySelector('.br-board').getBoundingClientRect(); return { right: innerWidth - b.right, top: b.top, below: b.top >= s.bottom, h: innerHeight }`);
    assert(box.right < 40 && box.top < box.h / 2 && box.below, "wait list in the top-right, under the board", box);
    assert(!(await A.ev(`return getComputedStyle(document.querySelector('.br-wait')).display !== "none"`)), "players don't see the wait list");
  });

  await test("spectator: snapshots move the players, follow cam and free cam", async () => {
    // both players walk a little so the spectator has something to follow
    for (const p of [A, B]) await p.keyDown("KeyW");
    await C.waitFor(`__G.brawl.remotes.size === 2 && [...__G.brawl.remotes.values()].every(r => r.opp.visible)`, 10000);
    await C.waitFor(`__G.brawl.spectator.mode === "follow" && __G.brawl.spectator.target`, 5000);
    const near = await C.ev(`const t = __G.brawl.remotes.get(__G.brawl.spectator.target).opp.pos; return __G.camera.position.distanceTo(t)`);
    assert(near > 0.5 && near < 6, "chase camera close behind the target", near);
    const first = await C.ev(`return __G.brawl.spectator.target`);
    await C.press("KeyE");
    const second = await C.ev(`return __G.brawl.spectator.target`);
    assert(second && second !== first, "E switches player", { first, second });
    for (const p of [A, B]) await p.keyUp("KeyW");
    await C.press("KeyF");
    assert((await C.ev(`return __G.brawl.spectator.mode`)) === "free", "F: free camera");
    const y0 = await C.ev(`return __G.camera.position.y`);
    await C.keyDown("Space");
    await sleep(500);
    await C.keyUp("Space");
    const y1 = await C.ev(`return __G.camera.position.y`);
    assert(y1 > y0 + 1, "Space flies up", { y0, y1 });
    // nothing the spectator does is sent as a pose
    assert((await A.ev(`return __G.brawl.arena.players.length`)) === 2, "still two players");
    await shot(C, "spectator");
  });

  await test("name tags only show with a clear line of sight", async () => {
    await C.press("KeyF"); // back to follow
    // Spawns are random: a player against a container squeezes the chase camera up to their head,
    // the tag leaves the view, and no tag is then the right answer. Make the shot clear: follow
    // Alpha and turn Alpha so the chase camera (behind them, along (sin yaw, cos yaw)) has open space.
    const yaw = await C.ev(`
      const r = [...__G.brawl.remotes.values()].find(r => r.name === "Alpha");
      const h = r.opp.pos.clone(); h.y += 1.55; const d = h.clone();
      for (let i = 0; i < 24; i++) { const a = (i * Math.PI) / 12; d.set(Math.sin(a), 0.15, Math.cos(a)).normalize(); if (!__G.physics.raycast(h, d, 4.5)) return a; }
      return null;`);
    assert(yaw !== null, "Alpha has open space on some side");
    await A.ev(`__G.player.yaw = ${yaw}; __G.player.pitch = 0`);
    await C.ev(`__G.brawl.spectator.follow([...__G.brawl.remotes.entries()].find(([, r]) => r.name === "Alpha")[0])`);
    try {
      await C.waitFor(`[...__G.brawl.remotes.values()].some(r => r.tag.visible)`, 10000);
    } catch (e) {
      const f0 = await C.ev(`return __G.renderer && __G.renderer.info ? __G.renderer.info.render.frame : -1`);
      await sleep(500);
      throw new Error("no tag: " + JSON.stringify(await C.ev(`const c = __G.camera, b = __G.brawl; const manual = [...b.remotes.values()].map(r => { r.tag.hide(); r.tag.update(r.opp.headPosition, true); return r.tag.visible; }); return { f0: ${f0}, f1: __G.renderer && __G.renderer.info ? __G.renderer.info.render.frame : -1, state: __G.game.state, focus: document.hasFocus(), vis: document.visibilityState, manual, sameCam: __G.camera === __G.brawl.spectator.camera, mode: b.spectator.mode, target: b.spectator.target, cam: c.position.toArray(), r: [...b.remotes.entries()].map(([id, r]) => { const h = r.opp.headPosition.clone(); const t = h.clone(); t.y -= 0.35; const p = h.clone().project(c); return { id, vis: r.opp.visible, alive: r.opp.alive, head: h.toArray(), los: __G.physics.lineOfSight(c.position, t), ndc: p.toArray(), cls: r.tagEl.className, d: c.position.distanceTo(h) }; }) }`)));
    }
    await C.ev(`window.__los = __G.physics.lineOfSight; __G.physics.lineOfSight = () => false`);
    await sleep(300);
    const any = await C.ev(`return [...__G.brawl.remotes.values()].some(r => r.tag.visible)`);
    await C.ev(`__G.physics.lineOfSight = window.__los`);
    assert(!any, "a wall between camera and head hides the tag");
  });

  await test("follow cam stays smooth with 10 Hz snapshots that arrive unevenly", async () => {
    // Feed Alpha's body a synthetic walk at the spectator rate with 60-160 ms random gaps (a bad
    // network), and watch it move frame by frame: no stalls, no jumps; the camera does not twitch.
    await C.ev(`
      const [id, r] = [...__G.brawl.remotes.entries()].find(([, r]) => r.name === "Alpha");
      window.__sim = { r, real: r.opp.push, samples: [], cam: [], stop: false, ray: __G.physics.raycast };
      __G.physics.raycast = () => null; // walls would move the camera on their own
      const real = r.opp.push; r.opp.push = () => {};
      __G.brawl.spectator.follow(id);
      const base = r.opp.pos.clone(), t0 = performance.now();
      const send = () => {
        if (__sim.stop) return;
        const t = (performance.now() - t0) / 1000;
        real({ p: [base.x + Math.sin(t * 0.8) * 3, base.y, base.z + t * 2.2 % 12], v: [Math.cos(t * 0.8) * 2.4, 0, 2.2], yaw: Math.sin(t * 0.5), pitch: 0, crouch: false, loco: null });
        setTimeout(send, 60 + Math.random() * 100);
      };
      send();
      const q = __G.camera.quaternion.clone(); let lastQ = null, lastP = null, lastT = 0;
      const tick = (now) => {
        if (__sim.stop) return;
        const dt = Math.max(0.001, (now - lastT) / 1000); lastT = now;
        const p = r.opp.pos.clone(); lastP && dt < 0.2 && __sim.samples.push(p.distanceTo(lastP) / dt); lastP = p;
        const cq = __G.camera.quaternion.clone(); lastQ && dt < 0.2 && __sim.cam.push(2 * Math.acos(Math.min(1, Math.abs(lastQ.dot(cq)))) / dt); lastQ = cq;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);`);
    await sleep(4500);
    const r = JSON.parse(await C.ev(`
      __sim.stop = true; __sim.r.opp.push = __sim.real; __G.physics.raycast = __sim.ray;
      const s = __sim.samples.slice(30), c = __sim.cam.slice(30), med = [...s].sort((a, b) => a - b)[s.length >> 1];
      return JSON.stringify({ n: s.length, med, max: Math.max(...s), stalls: s.filter((x) => x < med * 0.25).length, camMax: Math.max(...c) });`));
    assert(r.n > 100 && r.med > 0.005, "the body moves every frame", r);
    assert(r.max < r.med * 2, "no jumps between frames (speed per second, so frame-time noise cancels)", r);
    assert(r.stalls <= r.n * 0.03, "no stop-and-go from late snapshots", r);
    assert(r.camMax < 3, "the chase camera does not twitch (rad per second)", r);
  });

  await test("spectator chat: text, thumbs-down mute, players never see it", async () => {
    D = await open();
    await enter(D, "Delta", "br-watch-only");
    await D.waitFor(`__G.brawl.role === "lobby" && /watching only/i.test(__G.brawl.hud.waitText)`, 5000);
    assert(!(await D.ev(`return __G.brawl.hud.waitFlashing`)), "watch-only does not flash");
    // others see Delta in the list without a number
    await C.waitFor(`[...document.querySelectorAll('.br-wait-l li')].some(li => li.classList.contains('watch') && li.textContent.includes('Delta'))`, 5000);
    // Enter opens the chat box without pausing the game
    await C.press("Enter");
    await C.waitFor(`document.activeElement && document.activeElement.classList.contains("br-chat-in")`, 3000);
    assert((await C.ev(`return __G.game.state`)) === "playing", "chat does not pause");
    await C.ev(`const i = document.activeElement; i.value = "hello <b>world</b>";`);
    await C.press("Enter");
    await D.waitFor(`__G.brawl.hud.chatLines.some(l => l.includes("hello <b>world</b>"))`, 5000);
    assert((await D.ev(`return document.querySelector('.br-chat-l b + span').innerHTML`)).includes("&lt;b&gt;"), "chat is text, not HTML");
    assert(!(await A.ev(`return __G.brawl.hud.chatLines.length`)), "players get no chat");
    // the player's chat is refused
    await A.ev(`__G.brawl.client.send("br.say", { text: "callout" })`);
    await sleep(300);
    assert(!(await D.ev(`return __G.brawl.hud.chatLines.some(l => l.includes("callout"))`)), "player chat refused");
    // D thumbs down C's message → C muted for 10 s
    await D.ev(`document.querySelector('.br-chat-l button[data-br="down"]').click()`);
    await C.waitFor(`/muted for (9|10) s/.test(document.querySelector('.br-chat-note').textContent)`, 5000);
    await D.waitFor(`/👎 1/.test(__G.brawl.hud.chatLines.join(" "))`, 3000);
    await C.ev(`__G.brawl.action("say", { text: "again" })`);
    await sleep(300);
    assert(!(await D.ev(`return __G.brawl.hud.chatLines.some(l => l.includes("again"))`)), "muted user cannot post");
  });

  await test("push-to-talk: the mic is granted, audio reaches other spectators", async () => {
    // a fake microphone: an oscillator through a MediaStream destination
    await D.ev(`
      const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination();
      o.connect(d); o.start(); navigator.mediaDevices.getUserMedia = async () => d.stream;`);
    await C.ev(`window.__played = 0; const p = __G.brawl.voice.play; __G.brawl.voice.play = (...a) => (window.__played++, p(...a));`);
    await D.keyDown("KeyV");
    await D.waitFor(`__G.brawl.mic && __G.brawl.mic.ok`, 5000);
    await C.waitFor(`window.__played >= 2`, 5000);
    await C.waitFor(`document.querySelector('.br-talking').textContent.includes("Delta")`, 3000);
    assert(/\d+ listening/.test(await D.ev(`return __G.brawl.hud.chatLines.length ? document.querySelector('.br-mic, [data-br="mic-down"]').textContent : ""`)), "the speaker sees how many are listening");
    await D.keyUp("KeyV");
    await D.waitFor(`!__G.brawl.mic`, 3000);
    await C.waitFor(`!document.querySelector('.br-talking').textContent`, 3000);
    assert(!(await A.ev(`return window.__played`)), "players hear nothing");
    // the clip is kept and the ▶ button plays it again (also for a listener whose audio was locked)
    assert((await C.ev(`return __G.brawl.voice.clipCount`)) >= 1, "the clip is kept for replay");
    const peak = await C.ev(`const id = [...document.querySelectorAll('.br-chat-l li.voice button[data-br="replay"]')].pop().dataset.msg; return __G.brawl.voice.clipPeak(+id)`);
    assert(peak > 0.2, "the recorded clip carries the microphone signal (auto gain brings it up)", peak);
    const rb = await C.ev(`return !!document.querySelector('.br-chat-l li.voice button[data-br="replay"]')`);
    assert(rb, "a voice message has a ▶ button");
    await C.ev(`window.__replayed = 0; const pc = __G.brawl.voice.playClip; __G.brawl.voice.playClip = async (...a) => { const r = await pc(...a); window.__replayed = r ? 1 : -1; return r; }; document.querySelector('.br-chat-l li.voice button[data-br="replay"]').click()`);
    await C.waitFor(`window.__replayed !== 0`, 3000);
    assert((await C.ev(`return window.__replayed`)) === 1, "the replay plays");
  });

  await test("a silent default microphone: the game switches to the next input and remembers it", async () => {
    await sleep(800); // the previous talk must be over on the server too, or the new grab is ignored
    await D.ev(`
      localStorage.removeItem("saltline.mic.v1");
      const ac = new AudioContext(), o = ac.createOscillator(), loud = ac.createMediaStreamDestination(), quiet = ac.createMediaStreamDestination();
      o.connect(loud); o.start();
      const tag = (stream, id) => (stream.getAudioTracks().forEach((t) => (t.getSettings = () => ({ deviceId: id }))), stream);
      navigator.mediaDevices.enumerateDevices = async () => [{ kind: "audioinput", deviceId: "A", label: "Built-in" }, { kind: "audioinput", deviceId: "B", label: "iPhone" }];
      navigator.mediaDevices.getUserMedia = async (c) => {
        const want = c.audio && c.audio.deviceId && c.audio.deviceId.ideal;
        return want === "B" ? tag(loud.stream, "B") : tag(quiet.stream, "A");
      };`);
    await D.keyDown("KeyV");
    await D.waitFor(`__G.brawl.mic && __G.brawl.mic.ok`, 5000).catch(async (e) => {
      throw new Error(e.message + " — " + (await D.ev(`return JSON.stringify({ mic: !!__G.brawl.mic, note: document.querySelector('.br-chat-note') && document.querySelector('.br-chat-note').textContent, role: __G.brawl.role })`)));
    });
    await D.waitFor(`__G.brawl.voice.level > 0.05`, 9000);
    await D.waitFor(`localStorage.getItem("saltline.mic.v1") === "B"`, 3000);
    await D.keyUp("KeyV");
    await D.waitFor(`!__G.brawl.mic`, 3000);
  });

  await test("Tab frees the mouse without pausing; a real click reaches 👎; Tab takes it back", async () => {
    await D.ev(`__G.brawl.action("say", { text: "from delta" })`);
    await C.waitFor(`document.querySelector('.br-chat-l li:last-child button[data-br="down"]')`, 5000);
    await C.press("Tab");
    await C.waitFor(`__G.brawl.cursorFree && __G.game.keepPlayingOnUnlock`, 2000);
    await sleep(400);
    const st = await C.ev(`return { state: __G.game.state, hint: document.querySelector('.br-hint').textContent, bar: __G.brawl.hud.spectatorText }`);
    assert(st.state === "playing" && /mouse free/i.test(st.hint) && /Tab back to the view/.test(st.bar), "free mouse, still playing", st);
    const at = await C.ev(`const b = document.querySelector('.br-chat-l li:last-child button[data-br="down"]').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]`);
    await C.click(at[0], at[1]);
    await D.waitFor(`/from delta.*👎 1/.test(__G.brawl.hud.chatLines.join(" | "))`, 5000);
    await C.press("Tab");
    await C.waitFor(`!__G.brawl.cursorFree && !document.querySelector('.br-hint').textContent`, 2000);
    await sleep(400);
    assert((await C.ev(`return __G.game.state`)) === "playing", "still playing after Tab back");
  });

  await test("a player leaves their seat: notice, the first in the queue gets the offer and takes it", async () => {
    await A.ev(`__G.game.pause()`);
    await A.waitFor(`__G.game.state === "paused"`, 3000);
    const btn = await A.ev(`const b = document.querySelector('.menu [data-act="br-watch"]'); return b && b.offsetParent !== null`);
    assert(btn, "pause menu offers Leave seat");
    await act(A, "br-watch");
    await A.waitFor(`__G.brawl.role === "lobby" && __G.brawl.spectator.on`, 5000);
    await B.waitFor(`__G.brawl.hud.toastText.some(t => /Alpha left/.test(t))`, 5000);
    await C.waitFor(`__G.brawl.role === "offered" && /Seat open/.test(__G.brawl.hud.promptText)`, 5000);
    await C.waitFor(`__G.brawl.hud.waitFlashing && /seat is ready/i.test(__G.brawl.hud.waitText)`, 3000);
    await C.press("KeyJ");
    await C.waitFor(`__G.brawl.role === "playing" && __G.player.enabled`, 5000);
    await B.waitFor(`__G.brawl.hud.toastText.some(t => /Charlie joined/.test(t))`, 5000);
    await shot(C, "playing");
  });

  await test("quitting to the main menu leaves the brawl", async () => {
    await B.ev(`__G.game.pause()`);
    await act(B, "quit");
    await B.waitFor(`__G.game.state === "title" && !__G.brawl.entered && !__G.brawl.client`, 5000);
    await C.waitFor(`__G.brawl.hud.toastText.some(t => /Bravo left/.test(t))`, 5000);
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert(health.brawl && health.brawl.playing === 1, "server counts one player", health.brawl);
    for (const p of [A, B, C, D]) assert(errorsOf(p).length === 0, "no page errors", errorsOf(p));
  });
} finally {
  for (const p of pages) p.close();
  browser.kill();
  await duel.close();
  web.close();
}

console.log(`\n${passed} passed, ${failed} failed${failures.length ? ": " + failures.join("; ") : ""}`);
process.exit(failed ? 1 : 0);
