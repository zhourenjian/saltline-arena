// Optional WebRTC data channel per player, used for the frequent, replaceable messages (poses,
// spectator snapshots, pings) so one lost packet never holds up the next ones the way it does on
// a TCP WebSocket. Everything else stays on the WebSocket, and if anything here is missing or
// fails, the game simply keeps using the WebSocket.
//
// Needs the native module `node-datachannel` (optional; pinned to 0.20.0 because newer prebuilt
// binaries need a newer glibc than CentOS 8 has). The signalling (SDP offer/answer) goes over the
// player's existing WebSocket.
//
// Behind NAT (cloud VMs) the machine only knows its private address, so every private host
// candidate in our answer is rewritten to RTC_PUBLIC_IP; all players share one UDP port.
import { createRequire } from "node:module";

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;
const MAX_FAST_BYTES = 1100; // bigger messages go over the WebSocket instead (no UDP fragmentation)

export function createRtc({ publicIp = "", port = 40000, max = 300, log = () => {}, load = null } = {}) {
  let nd;
  try {
    nd = load ? load() : createRequire(import.meta.url)("node-datachannel");
    nd.initLogger("Error");
  } catch (e) {
    log(`webrtc unavailable (${String((e && e.message) || e).split("\n")[0]})`);
    return null;
  }
  let active = 0;

  function fixSdp(sdp) {
    const seen = new Set(),
      lines = [];
    for (const line of sdp.split(/\r?\n/)) {
      if (!line.startsWith("a=candidate:")) {
        line && lines.push(line);
        continue;
      }
      const f = line.split(" ");
      if (f.length < 8 || f[4].includes(":")) continue; // IPv4 only
      if (publicIp) {
        if (!PRIVATE.test(f[4])) continue;
        f[4] = publicIp;
      }
      const out = f.join(" ");
      seen.has(out) || (seen.add(out), lines.push(out));
    }
    return lines.join("\r\n") + "\r\n";
  }

  // one link per connected player: link.offer(sdp, reply), link.fast(text) → bool, link.close()
  function attach(onText) {
    let pc = null,
      channel = null,
      timer = null,
      lastOffer = 0;
    const close = () => {
      clearTimeout(timer);
      const old = pc;
      pc = channel = null;
      if (old) {
        active--;
        try {
          old.close();
        } catch {}
      }
    };
    return {
      get open() {
        return !!(channel && channel.isOpen());
      },
      offer(sdp, reply) {
        const t = Date.now();
        if (typeof sdp !== "string" || sdp.length > 12000 || t - lastOffer < 3000 || active >= max) return;
        lastOffer = t;
        close();
        active++;
        let answered = false;
        const mine = (pc = new nd.PeerConnection("p", {
          iceServers: [],
          portRangeBegin: port,
          portRangeEnd: port,
          enableIceUdpMux: true,
        }));
        const alive = () => pc === mine;
        mine.onGatheringStateChange((s) => {
          if (s !== "complete" || answered || !alive()) return;
          answered = true;
          reply(fixSdp(mine.localDescription().sdp));
        });
        mine.onDataChannel((dc) => {
          if (!alive()) return;
          channel = dc;
          dc.onMessage((m) => alive() && typeof m === "string" && m.length < 16384 && onText(m));
          dc.onClosed(() => channel === dc && (channel = null));
        });
        mine.onStateChange((s) => (s === "failed" || s === "closed" || s === "disconnected") && alive() && close());
        timer = setTimeout(() => alive() && !channel && close(), 15000); // never connected
        try {
          mine.setRemoteDescription(sdp, "offer");
        } catch (e) {
          log("webrtc offer rejected", e && e.message);
          alive() && close();
        }
      },
      fast(text) {
        if (!channel || text.length > MAX_FAST_BYTES) return false;
        try {
          return channel.isOpen() && (channel.sendMessage(text), true);
        } catch {
          return false;
        }
      },
      close,
    };
  }

  return {
    attach,
    get active() {
      return active;
    },
    cleanup() {
      try {
        nd.cleanup();
      } catch {}
    },
  };
}
