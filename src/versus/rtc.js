// The UDP side of the connection: an unordered, no-retransmit WebRTC data channel to the game
// server, used for poses and snapshots (see server/rtc.mjs). The WebSocket carries the signalling and
// everything that must arrive; if WebRTC is unavailable or fails, nothing changes for the player.
//   ?rtc=0 in the page address turns it off.
var GATHER_MS = 2500;
var RETRY_MS = 10000;

function rtcWanted() {
  try {
    return typeof RTCPeerConnection === "function" && !/[?&]rtc=0/.test(location.search);
  } catch {
    return !1;
  }
}

// openUdp({ signal(sdp), onAnswer(fn) → off, onText(text) }) → { get open, send(text) → bool, close() }
function openUdp({ signal, onAnswer, onText }) {
  let pc = null,
    dc = null,
    closed = !1,
    retry = 0,
    offAnswer = () => {};
  const teardown = () => {
    offAnswer();
    clearTimeout(retry);
    const old = pc;
    pc = dc = null;
    try {
      old && old.close();
    } catch {}
  };
  async function attempt() {
    teardown();
    if (closed) return;
    const mine = (pc = new RTCPeerConnection({ iceServers: [] }));
    const alive = () => pc === mine && !closed;
    const again = () => alive() && (teardown(), (retry = setTimeout(attempt, RETRY_MS)));
    try {
      const ch = mine.createDataChannel("pose", { ordered: !1, maxRetransmits: 0 });
      ch.onopen = () => alive() && (dc = ch);
      ch.onclose = () => dc === ch && ((dc = null), again());
      ch.onmessage = (e) => alive() && typeof e.data == "string" && onText(e.data, e);
      mine.onconnectionstatechange = () => (mine.connectionState === "failed" || mine.connectionState === "closed") && again();
      offAnswer = onAnswer((sdp) => alive() && mine.setRemoteDescription({ type: "answer", sdp }).catch(again));
      await mine.setLocalDescription(await mine.createOffer());
      await new Promise((resolve) => {
        if (mine.iceGatheringState === "complete") return resolve();
        const done = () => mine.iceGatheringState === "complete" && (mine.removeEventListener("icegatheringstatechange", done), resolve());
        mine.addEventListener("icegatheringstatechange", done);
        setTimeout(resolve, GATHER_MS);
      });
      if (!alive()) return;
      signal(mine.localDescription.sdp) || again();
      // never connected: try once more later
      setTimeout(() => alive() && !dc && again(), 15000);
    } catch {
      again();
    }
  }
  attempt();
  return {
    get open() {
      return !!dc && dc.readyState === "open";
    },
    send(text) {
      if (!dc || dc.readyState !== "open" || text.length > 1100) return !1;
      try {
        dc.send(text);
        return !0;
      } catch {
        return !1;
      }
    },
    close() {
      closed = !0;
      teardown();
    },
  };
}

export { openUdp, rtcWanted };
