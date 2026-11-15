// Headless Chrome over the DevTools protocol (Node's built-in WebSocket, no dependencies).
// Gives the tests: evaluate with the DevTools command-line API (getEventListeners), console and
// exception capture, real keyboard/mouse input events, forced GC and screenshots.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const CHROME =
  process.env.CHROME ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEYCODES = { Space: 32, ShiftLeft: 16, Escape: 27, Enter: 13 };

export async function launch({ width = 1280, height = 720 } = {}) {
  const port = 9200 + Math.floor(Math.random() * 600);
  const profile = `/tmp/saltline-test-chrome-${port}`;
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-crash-reporter",
      "--disable-breakpad",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--use-angle=metal",
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      "--disable-gpu-watchdog",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--autoplay-policy=no-user-gesture-required",
      "--hide-scrollbars",
      "--mute-audio",
      "--enable-precise-memory-info",
      "--js-flags=--expose-gc",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const json = async (p, method = "GET") => {
    for (let i = 0; i < 150; i++) {
      try {
        return await (
          await fetch(`http://127.0.0.1:${port}${p}`, { method })
        ).json();
      } catch {
        await sleep(100);
      }
    }
    throw new Error("chrome not reachable");
  };
  const version = await json("/json/version");

  // a page in its own window keeps rendering while other pages are open (a background tab in
  // headless Chrome is "hidden" and gets no requestAnimationFrame)
  async function newWindowTarget() {
    const bws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => ((bws.onopen = res), (bws.onerror = rej)));
    const reply = await new Promise((res) => {
      bws.onmessage = (ev) => res(JSON.parse(ev.data));
      bws.send(
        JSON.stringify({
          id: 1,
          method: "Target.createTarget",
          params: { url: "about:blank", newWindow: true, width, height },
        }),
      );
    });
    bws.close();
    return {
      id: reply.result.targetId,
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${reply.result.targetId}`,
    };
  }

  async function open(
    url,
    { init = "", wait = "true", timeout = 90000, window: ownWindow = false } = {},
  ) {
    const tgt = ownWindow
      ? await newWindowTarget()
      : await json("/json/new?about:blank", "PUT");
    const ws = new WebSocket(tgt.webSocketDebuggerUrl);
    await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
    let id = 0;
    const pending = new Map();
    const logs = [];
    const handlers = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method && handlers.has(m.method))
        for (const fn of handlers.get(m.method)) fn(m.params);
      if (m.id && pending.has(m.id))
        (pending.get(m.id)(m), pending.delete(m.id));
      else if (m.method === "Runtime.consoleAPICalled")
        logs.push(
          m.params.type +
            ": " +
            m.params.args.map((a) => a.value ?? a.description).join(" "),
        );
      else if (m.method === "Runtime.exceptionThrown")
        logs.push(
          "EXC " +
            (m.params.exceptionDetails.exception?.description ||
              m.params.exceptionDetails.text),
        );
      else if (m.method === "Inspector.targetCrashed") logs.push("CRASHED");
    };
    const send = (method, params = {}) =>
      new Promise((res) => {
        const i = ++id;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    if (init)
      await send("Page.addScriptToEvaluateOnNewDocument", { source: init });
    const ev = async (expression) => {
      const m = await send("Runtime.evaluate", {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
        includeCommandLineAPI: true,
      });
      if (m.result?.exceptionDetails)
        throw new Error(
          m.result.exceptionDetails.exception?.description ||
            JSON.stringify(m.result.exceptionDetails).slice(0, 800),
        );
      return m.result?.result?.value;
    };
    const waitFor = async (cond, ms = 60000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try {
          if (await ev(`return !!(${cond})`)) return true;
        } catch {
          /* navigating */
        }
        if (logs.includes("CRASHED")) throw new Error("renderer crashed");
        await sleep(100);
      }
      throw new Error(`timed out waiting for ${cond}`);
    };
    await send("Page.navigate", { url });
    await waitFor(`document.readyState === 'complete' && (${wait})`, timeout);
    const key = (type, code) =>
      send("Input.dispatchKeyEvent", {
        type,
        code,
        key: code.startsWith("Key")
          ? code.slice(3).toLowerCase()
          : code === "Space"
            ? " "
            : code,
        windowsVirtualKeyCode: code.startsWith("Key")
          ? code.charCodeAt(3)
          : KEYCODES[code] || 0,
      });
    return {
      ev,
      logs,
      send,
      on: (method, fn) => (
        handlers.has(method) || handlers.set(method, []),
        handlers.get(method).push(fn)
      ),
      waitFor,
      gc: () => send("HeapProfiler.collectGarbage"),
      keyDown: (code) => key("keyDown", code),
      keyUp: (code) => key("keyUp", code),
      async press(code, ms = 60) {
        await key("keyDown", code);
        await sleep(ms);
        await key("keyUp", code);
      },
      click: async (x, y) => {
        for (const type of ["mousePressed", "mouseReleased"])
          await send("Input.dispatchMouseEvent", {
            type,
            x,
            y,
            button: "left",
            clickCount: 1,
          });
      },
      async screenshot(q = 80) {
        const m = await send("Page.captureScreenshot", {
          format: "jpeg",
          quality: q,
        });
        return Buffer.from(m.result.data, "base64");
      },
      // closes the tab/window itself, not only the DevTools connection
      close: () => {
        try {
          ws.close();
        } catch {}
        tgt.id && fetch(`http://127.0.0.1:${port}/json/close/${tgt.id}`).catch(() => {});
      },
    };
  }
  return {
    open,
    kill: () => {
      proc.kill("SIGTERM");
      setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
    },
  };
}
