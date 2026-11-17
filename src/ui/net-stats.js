// Corner readout: frames per second and the round trip to the duel/brawl server.
// FPS counts real frames over half-second windows; ping comes from the network client's
// ping/pong (src/versus/net.js). Shown while a game runs or a server connection is open.
function createNetStats(context) {
  let host = document.getElementById("ui") || document.body,
    root = document.createElement("div"),
    fpsEl = document.createElement("span"),
    pingEl = document.createElement("span"),
    resEl = document.createElement("span"),
    frames = 0,
    windowStart = performance.now(),
    fps = 0,
    shown = null;
  ((root.className = "net-stats"),
    root.setAttribute("aria-hidden", "true"),
    ((resEl.className = "res"), root.append(fpsEl, pingEl, resEl)),
    host.appendChild(root));

  let client = () =>
    (context.brawl && context.brawl.client) || (context.versus && context.versus.client) || null;

  function frame() {
    frames++;
    let t = performance.now();
    if (t - windowStart < 500) return;
    ((fps = (frames * 1000) / (t - windowStart)), (frames = 0), (windowStart = t));
    let c = client(),
      rtt = c && c.open ? c.rtt : null,
      game = context.game,
      on = !!c || (!!game && game.state !== "title");
    on !== shown && ((shown = on), root.classList.toggle("on", on));
    if (!on) return;
    fpsEl.textContent = `FPS ${Math.round(fps)}`;
    fpsEl.className = fps >= 50 ? "good" : fps >= 30 ? "ok" : "bad";
    pingEl.textContent = c ? (rtt == null ? "PING …" : `PING ${Math.round(rtt)} ms`) : "PING —";
    pingEl.className = !c || rtt == null ? "" : rtt < 80 ? "good" : rtt < 160 ? "ok" : "bad";
    // what the 3D view really renders at: pixels, share of the screen's physical width, running preset
    try {
      let st = context.render && context.render.stats && context.render.stats(),
        q = context.quality;
      if (st && st.res) {
        let native = (window.innerWidth || 1) * (window.devicePixelRatio || 1);
        resEl.textContent = `${st.res[0]}\u00d7${st.res[1]} ${Math.round((100 * st.res[0]) / native)}% ${((q && q.name) || "").toUpperCase()}${context.frameCap ? " \u00b7" + context.frameCap : ""}`;
      }
    } catch {}
  }
  context.frameHooks.push(frame);

  return {
    root,
    get fps() {
      return fps;
    },
    get ping() {
      let c = client();
      return c && c.open ? c.rtt : null;
    },
    get text() {
      return root.textContent;
    },
    dispose() {
      let i = context.frameHooks.indexOf(frame);
      (i >= 0 && context.frameHooks.splice(i, 1), root.remove());
    },
  };
}

export { createNetStats };
