// The UDP (WebRTC data channel) path against the real game server, with node-datachannel as the
// player's side. Skipped where Node has no global WebSocket or node-datachannel is not installed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startDuelServer } from "../server/duel-server.mjs";
import { DUEL_PROTOCOL } from "../src/versus/rules.js";

let nd = null;
try {
  nd = createRequire(import.meta.url)("node-datachannel");
} catch {}
let passed = 0,
  failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e.stack.split("\n").slice(0, 4).join("\n       ")}`);
  }
}
console.log("webrtc data channel");
if (typeof WebSocket !== "function" || !nd) {
  console.log("  skip: needs Node 22+ and node-datachannel");
} else {
  const open = (port) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`),
        inbox = [];
      ws.onmessage = (e) => inbox.push(JSON.parse(e.data));
      ws.onerror = reject;
      ws.onopen = () =>
        resolve({
          ws,
          inbox,
          send: (m) => ws.send(JSON.stringify(m)),
          wait: async (t, pred = () => true, ms = 8000) => {
            const end = Date.now() + ms;
            while (Date.now() < end) {
              const hit = inbox.find((m) => m.t === t && pred(m));
              if (hit) return hit;
              await new Promise((r) => setTimeout(r, 20));
            }
            throw new Error(`timeout waiting for ${t}`);
          },
        });
    });

  await test("poses and pings travel over the data channel, the rest stays on the WebSocket", async () => {
    const srv = startDuelServer({ port: 0, host: "127.0.0.1", quiet: true, env: { RTC_PORT: "40998" } });
    const port = await srv.ready;
    let pc;
    try {
      const a = await open(port),
        b = await open(port);
      a.send({ t: "hello", v: DUEL_PROTOCOL, name: "Aaa" });
      b.send({ t: "hello", v: DUEL_PROTOCOL, name: "Bbb" });
      const aw = await a.wait("welcome");
      await b.wait("welcome");
      assert.ok(aw.features.includes("rtc"));

      // A's side of the data channel
      pc = new nd.PeerConnection("a", { iceServers: [] });
      const dcIn = [];
      // (handlers first: gathering starts as soon as the channel exists)
      pc.onGatheringStateChange((s) => s === "complete" && a.send({ t: "rtc.offer", sdp: pc.localDescription().sdp }));
      const dc = pc.createDataChannel("pose", { unordered: true, maxRetransmits: 0 });
      dc.onMessage((m) => dcIn.push(JSON.parse(m)));
      const opened = new Promise((r) => dc.onOpen(r));
      const answer = await a.wait("rtc.answer", () => true, 10000);
      assert.match(answer.sdp, /a=candidate:/);
      pc.setRemoteDescription(answer.sdp, "answer");
      await Promise.race([opened, new Promise((_, rej) => setTimeout(() => rej(new Error("data channel never opened")), 10000))]);

      a.send({ t: "create" });
      const room = await a.wait("room", (m) => m && m.code);
      b.send({ t: "join", code: room.code });
      await a.wait("live");
      await b.wait("live");

      // B's pose reaches A on the data channel, not on A's WebSocket
      b.send({ t: "state", p: [1, 0, 0], yaw: 0, pitch: 0 });
      const end = Date.now() + 5000;
      while (!dcIn.some((m) => m.t === "state") && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      assert.ok(dcIn.some((m) => m.t === "state" && m.p[0] === 1), "pose arrived over UDP");
      assert.ok(!a.inbox.some((m) => m.t === "state"), "and not over the WebSocket");

      // A's pose over the data channel reaches B's WebSocket
      dc.sendMessage(JSON.stringify({ t: "state", p: [2, 0, 0], yaw: 0, pitch: 0 }));
      assert.equal((await b.wait("state", (m) => m.p[0] === 2)).p[0], 2);

      // a UDP ping is answered over UDP, a WebSocket ping over the WebSocket
      dc.sendMessage(JSON.stringify({ t: "ping", at: 7, u: 1 }));
      a.send({ t: "ping", at: 8 });
      await a.wait("pong", (m) => m.at === 8);
      const end2 = Date.now() + 5000;
      while (!dcIn.some((m) => m.t === "pong" && m.at === 7) && Date.now() < end2) await new Promise((r) => setTimeout(r, 20));
      assert.ok(dcIn.some((m) => m.t === "pong" && m.at === 7 && m.u === 1), "udp pong over udp");
      assert.ok(!a.inbox.some((m) => m.t === "pong" && m.at === 7), "udp pong not on the WebSocket");

      // events are never sent over UDP
      b.send({ t: "ping", at: 9 });
      await b.wait("pong", (m) => m.at === 9);
      assert.ok(!dcIn.some((m) => m.t === "pong" && m.at === 9));

      // closing the player's UDP leaves a working WebSocket game
      dc.close();
      pc.close();
      await new Promise((r) => setTimeout(r, 400));
      b.send({ t: "state", p: [3, 0, 0], yaw: 0, pitch: 0 });
      assert.equal((await a.wait("state", (m) => m.p[0] === 3)).p[0], 3, "pose falls back to the WebSocket");
    } finally {
      try {
        pc && pc.close();
      } catch {}
      await srv.close();
    }
  });

  await test("without RTC_PORT the server does not offer the data channel", async () => {
    const srv = startDuelServer({ port: 0, host: "127.0.0.1", quiet: true, env: {} });
    const port = await srv.ready;
    try {
      const a = await open(port);
      a.send({ t: "hello", v: DUEL_PROTOCOL, name: "Aaa" });
      const w = await a.wait("welcome");
      assert.ok(!w.features.includes("rtc"));
      a.send({ t: "rtc.offer", sdp: "v=0" }); // ignored, not fatal
      a.send({ t: "ping", at: 1 });
      await a.wait("pong");
    } finally {
      await srv.close();
    }
  });
}
console.log(`\n${passed} passed, ${failed} failed`);
nd && nd.cleanup();
process.exit(failed ? 1 : 0);
