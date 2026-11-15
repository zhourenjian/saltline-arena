// window.DuoWorldAvatars: the registry Avatar Packages call from their avatar.js.
// Works as a plain classic <script> (it must run before avatar scripts on a hand-written page)
// and as a side-effect ES module import (the World Package installs it on load). It has no
// imports and no exports on purpose. Both register(definition) and register(id, definition)
// are accepted, and a registry an avatar created before this script ran is adopted.
(function (global) {
  "use strict";
  var existing = global.DuoWorldAvatars;
  if (existing && existing.__saltlineRegistry) return;

  var definitions = Object.create(null);
  var baseUrls = Object.create(null);
  var listeners = [];

  function currentScriptBase() {
    try {
      var s = global.document && global.document.currentScript;
      if (s && s.src) return s.src.slice(0, s.src.lastIndexOf("/") + 1);
    } catch (e) {
      /* non-DOM host */
    }
    return "";
  }

  function register(idOrDefinition, maybeDefinition) {
    var definition = idOrDefinition;
    if (typeof idOrDefinition === "string") {
      definition = Object.assign({}, maybeDefinition || {}, {
        id: idOrDefinition,
      });
    }
    if (!definition || typeof definition.id !== "string" || !definition.id) {
      throw new Error("DuoWorldAvatars.register: definition needs a string id");
    }
    if (typeof definition.create !== "function") {
      throw new Error(
        'DuoWorldAvatars.register("' +
          definition.id +
          '"): create(context) is required',
      );
    }
    definitions[definition.id] = definition;
    var base = currentScriptBase();
    if (base) baseUrls[definition.id] = base;
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](definition);
      } catch (e) {
        if (global.console) global.console.error(e);
      }
    }
    try {
      if (
        typeof global.dispatchEvent === "function" &&
        typeof global.CustomEvent === "function"
      ) {
        global.dispatchEvent(
          new global.CustomEvent("duoworld:avatar-registered", {
            detail: { id: definition.id },
          }),
        );
      }
    } catch (e) {
      /* events are a convenience only */
    }
    return definition;
  }

  var registry = {
    __saltlineRegistry: true,
    protocol: "duoworld-avatar/1",
    protocolVersions: ["1.0", "1.1"],
    definitions: definitions,
    register: register,
    get: function (id) {
      return definitions[id];
    },
    has: function (id) {
      return Object.prototype.hasOwnProperty.call(definitions, id);
    },
    list: function () {
      return Object.keys(definitions).map(function (k) {
        return definitions[k];
      });
    },
    // directory of the script that registered id (absolute URL ending in "/"), when known
    baseUrlOf: function (id) {
      return baseUrls[id] || "";
    },
    onRegister: function (fn) {
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };

  // adopt definitions from a registry an avatar package created on its own
  if (existing) {
    var previous =
      typeof existing.list === "function"
        ? existing.list()
        : existing.definitions
          ? Object.keys(existing.definitions).map(function (k) {
              return existing.definitions[k];
            })
          : [];
    for (var j = 0; j < previous.length; j++) {
      var d = previous[j];
      if (d && typeof d.id === "string" && typeof d.create === "function")
        definitions[d.id] = d;
    }
  }
  global.DuoWorldAvatars = registry;
})(typeof window !== "undefined" ? window : globalThis);
