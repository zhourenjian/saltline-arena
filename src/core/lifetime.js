// Ownership of browser-level side effects (window/document listeners, timers) for one world
// instance. Systems register through listen() so that a World can be left (gated listeners stop
// reacting) and disposed (every listener and timer is removed) without reloading the page.

function createLifetime() {
  let controller = new AbortController(),
    timers = new Set(),
    lifetime = {
      // false while the world is loaded but not entered (or has been left)
      active: !0,
      disposed: !1,
      signal: controller.signal,
      listen(target, type, handler, options, gated = !0) {
        if (!target || lifetime.disposed) return () => {};
        let wrapped = gated
            ? function (event) {
                if (lifetime.active) return handler.call(this, event);
              }
            : handler,
          opts =
            typeof options == "boolean"
              ? { capture: options, signal: controller.signal }
              : { ...(options || {}), signal: controller.signal };
        target.addEventListener(type, wrapped, opts);
        return () => target.removeEventListener(type, wrapped, opts);
      },
      timeout(fn, ms) {
        if (lifetime.disposed) return 0;
        let id = setTimeout(() => {
          (timers.delete(id), lifetime.disposed || fn());
        }, ms);
        return (timers.add(id), id);
      },
      dispose() {
        if (lifetime.disposed) return;
        ((lifetime.disposed = !0), (lifetime.active = !1), controller.abort());
        for (let id of timers) clearTimeout(id);
        timers.clear();
      },
    };
  return lifetime;
}

// Systems call this instead of addEventListener. Without a lifetime (showcase stubs, tools) it
// behaves exactly like the original direct registration.
function listen(context, target, type, handler, options, gated = !0) {
  let lifetime = context && context.lifetime;
  if (lifetime) return lifetime.listen(target, type, handler, options, gated);
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

export { createLifetime, listen };
