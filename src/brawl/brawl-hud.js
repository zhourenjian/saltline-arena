// Brawl HUD layer: join/leave toasts (top centre), standings with the cull timer, the
// play-or-watch prompt and seat offers, the spectator bar and the spectator chat.
// Everything user-provided (names, chat) is written with textContent, never as HTML.
function el(tag, cls, text) {
  let e = document.createElement(tag);
  return (cls && (e.className = cls), text != null && (e.textContent = text), e);
}

var mmss = (s) => {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function createBrawlHud(context, { onAction } = {}) {
  let host = document.getElementById("ui") || document.body,
    root = el("div", "br-layer"),
    toasts = el("div", "br-toasts"),
    side = el("div", "br-side"),
    board = el("div", "br-board"),
    wait = el("div", "br-wait"),
    waitHead = el("div", "br-wait-h"),
    waitList = el("ol", "br-wait-l"),
    waitMe = el("div", "br-wait-me"),
    waitBtns = el("div", "br-wait-b"),
    boardHead = el("div", "br-board-h"),
    boardList = el("ol", "br-board-l"),
    boardFoot = el("div", "br-board-f"),
    prompt = el("div", "br-prompt"),
    pTitle = el("b"),
    pText = el("p"),
    pButtons = el("div", "br-prompt-b"),
    spec = el("div", "br-spec"),
    specText = el("span", "br-spec-t"),
    specButtons = el("span", "br-spec-b"),
    chat = el("div", "br-chat"),
    chatList = el("ol", "br-chat-l"),
    chatRow = el("div", "br-chat-row"),
    chatInput = el("input", "br-chat-in"),
    micBtn = el("button", "br-mic", "Hold V to talk"),
    chatNote = el("div", "br-chat-note"),
    talking = el("div", "br-talking"),
    hint = el("div", "br-hint"),
    promptTimer = null, // { left, base }
    cull = null, // { left, count, queue }
    toastId = 0,
    mutedLeft = 0,
    rows = new Map(); // msg id → { li, downs }
  ((chatInput.type = "text"),
    (chatInput.maxLength = 200),
    (chatInput.placeholder = "Say something · spectators only"),
    chatInput.setAttribute("aria-label", "Spectator chat"),
    (chatInput.autocomplete = "off"),
    (chatInput.spellcheck = !1),
    (micBtn.type = "button"),
    board.append(boardHead, boardList, boardFoot),
    wait.append(waitHead, waitList, waitMe, waitBtns),
    side.append(board, wait),
    prompt.append(pTitle, pText, pButtons),
    spec.append(specText, specButtons),
    chatRow.append(chatInput, micBtn),
    chat.append(talking, chatList, chatNote, chatRow),
    root.append(toasts, side, prompt, spec, chat, hint),
    (prompt.hidden = !0),
    (root.dataset.role = "lobby"),
    host.appendChild(root));

  let act = (a, data) => onAction && onAction(a, data);
  root.addEventListener("click", (e) => {
    let b = e.target.closest("button[data-br]");
    b && (e.preventDefault(), act(b.dataset.br, { msg: +b.dataset.msg || 0, id: b.dataset.id || null }));
  });
  // mic is press-and-hold on the button as well as the V key
  let micDown = (e) => (e.preventDefault(), act("mic-down")),
    micUp = () => act("mic-up");
  (micBtn.addEventListener("pointerdown", micDown),
    micBtn.addEventListener("pointerup", micUp),
    micBtn.addEventListener("pointerleave", micUp),
    chatInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.code === "Enter" || e.code === "NumpadEnter") {
        e.preventDefault();
        let text = chatInput.value.trim();
        ((chatInput.value = ""), text && act("say", { text }), act("chat-close"));
      } else if (e.code === "Escape") (e.preventDefault(), (chatInput.value = ""), act("chat-close"));
    }));

  function button(label, a, { primary = !1, msg, id, on } = {}) {
    let b = el("button", (primary ? "btn primary small" : "btn small") + (on ? " on" : ""), label);
    on != null && b.setAttribute("aria-pressed", on ? "true" : "false");
    return ((b.type = "button"), (b.dataset.br = a), msg && (b.dataset.msg = msg), id && (b.dataset.id = id), b);
  }

  function frame(dt) {
    if (!root.classList.contains("on")) return;
    if (promptTimer && !prompt.hidden) {
      promptTimer.left -= dt;
      let n = Math.max(0, Math.ceil(promptTimer.left));
      pText.textContent = promptTimer.base.replace("{s}", n);
    }
    if (cull) {
      cull.left -= dt;
      boardFoot.textContent = cull.queue
        ? `Next cut in ${mmss(cull.left)} · last ${cull.count} out · ${cull.queue} waiting`
        : "No queue · nobody is cut";
    }
    if (mutedLeft > 0) {
      mutedLeft -= dt;
      chatNote.textContent = mutedLeft > 0 ? `Thumbed down — muted for ${Math.ceil(mutedLeft)} s` : "";
    }
  }
  context.frameHooks.push(frame);

  return {
    root,
    chatInput,
    show(on) {
      root.classList.toggle("on", !!on);
      // watching has no jump / reload / aim / fire buttons on a touch screen
      document.documentElement.classList.toggle("br-watch", !!on && root.dataset.role !== "playing");
      on || ((prompt.hidden = !0), (promptTimer = null));
    },
    // "playing" | "lobby" | "queued" | "offered" — CSS shows the chat only to spectators
    setRole(role) {
      root.dataset.role = role;
      root.classList.contains("on") && document.documentElement.classList.toggle("br-watch", role !== "playing");
      let hud = context.hud && context.hud.root;
      hud && hud.classList.toggle("br-watching", role !== "playing");
    },
    toast(text, kind = "info", seconds = 3.6) {
      let t = el("div", `br-toast ${kind}`, text),
        id = ++toastId;
      toasts.prepend(t);
      while (toasts.children.length > 4) toasts.lastChild.remove();
      setTimeout(() => (t.classList.add("out"), setTimeout(() => t.remove(), 400)), seconds * 1000);
      return id;
    },
    get toastText() {
      return [...toasts.children].map((t) => t.textContent);
    },
    setBoard(view, me) {
      if (!view) return void (board.hidden = !0);
      board.hidden = !1;
      boardHead.textContent = `Arena ${view.id} · ${view.players.length}/${view.max}`;
      boardList.replaceChildren(
        ...view.players.map((p, i) => {
          let li = el("li", p.id === me ? "me" : p.alive ? "" : "dead");
          li.append(el("span", "n", `${i + 1}. ${p.name}${p.id === me ? " (you)" : ""}`), el("span", "s", `${p.kills} / ${p.deaths}`));
          return li;
        }),
      );
      cull = { left: view.cullIn, count: view.cullCount, queue: view.queue };
    },
    // spectators: who is waiting (queue first, then watch-only) and where I stand
    setWaitList(view, me) {
      if (!view) return void (wait.hidden = !0);
      wait.hidden = !1;
      let list = view.list || [],
        q = view.queue || 0,
        watchOnly = Math.max(0, (view.spectators || 0) - q);
      waitHead.textContent = `Queue ${q} · watching ${watchOnly}`;
      waitList.replaceChildren(
        ...list.map((x) => {
          let li = el("li", [x.id === me ? "me" : "", x.pos ? "" : "watch", x.offered ? "offered" : ""].filter(Boolean).join(" "));
          li.append(el("span", "p", x.pos ? `#${x.pos}` : "👁"), el("span", "n", `${x.name}${x.id === me ? " (you)" : ""}`));
          return li;
        }),
      );
      let more = (view.spectators || 0) - list.length;
      more > 0 && waitList.append(el("li", "more", `+${more} more`));
      let text, flash = !1;
      if (view.role === "offered") ((text = "Your seat is ready — press J!"), (flash = !0));
      else if (view.role === "queued" && view.position === 1) ((text = "You're next in line — get ready!"), (flash = !0));
      else if (view.role === "queued") text = `You are #${view.position} of ${q} in the queue`;
      else text = "Not in the queue · watching only";
      waitMe.textContent = text;
      wait.classList.toggle("next", flash);
    },
    // Tab released the mouse: say so, and how to get the view back
    setCursorFree(on) {
      root.classList.toggle("cursor-free", !!on);
      on ? hint.replaceChildren(el("b", "", "Mouse free"), el("span", "", " · click the view or press Tab to look around")) : hint.replaceChildren();
    },
    get waitText() {
      return wait.hidden ? "" : wait.textContent;
    },
    get waitFlashing() {
      return wait.classList.contains("next");
    },
    prompt(title, text, buttons, seconds) {
      ((pTitle.textContent = title), (pText.textContent = text.replace("{s}", Math.ceil(seconds || 0))));
      pButtons.replaceChildren(...buttons.map((b) => button(b.label, b.act, b)));
      promptTimer = seconds ? { left: seconds, base: text } : null;
      prompt.hidden = !1;
    },
    closePrompt() {
      ((prompt.hidden = !0), (promptTimer = null));
    },
    get promptOpen() {
      return !prompt.hidden;
    },
    get promptText() {
      return prompt.hidden ? "" : `${pTitle.textContent} ${pText.textContent}`;
    },
    // text: always shown; desk: keyboard / mouse hints, hidden on touch screens (CSS .br-desk)
    setSpectator(text, buttons, desk) {
      specText.replaceChildren(document.createTextNode(text || ""));
      desk && specText.append(el("span", "br-desk", desk));
      specButtons.replaceChildren(...buttons.map((b) => button(b.label, b.act, b)));
    },
    // the seat button(s) under the queue list: Play / Join queue, Watch only, Take the seat
    setWaitButtons(buttons) {
      waitBtns.replaceChildren(...buttons.map((b) => button(b.label, b.act, b)));
    },
    get waitButtons() {
      return [...waitBtns.children].map((b) => b.textContent);
    },
    get spectatorText() {
      return specText.textContent;
    },
    // chat
    addMessage(m, me) {
      let li = el("li", m.kind === "voice" ? "voice" : ""),
        who = el("b", "", m.name),
        text = el("span", "", m.kind === "voice" ? " 🎤 voice" : ` ${m.text}`),
        downs = el("span", "downs", m.downs ? `👎 ${m.downs}` : "");
      li.append(who, text, downs);
      m.from !== me && li.append(button("👎", "down", { msg: m.id }));
      chatList.append(li);
      rows.set(m.id, { li, downs });
      while (chatList.children.length > 80) {
        let first = chatList.firstChild;
        for (let [id, r] of rows) r.li === first && rows.delete(id);
        first.remove();
      }
      chatList.scrollTop = chatList.scrollHeight;
    },
    vote(id, n, mine) {
      let r = rows.get(id);
      r && ((r.downs.textContent = n ? `👎 ${n}` : ""), mine && r.li.querySelector("button") && r.li.querySelector("button").remove());
    },
    setTalking(list) {
      talking.textContent = list.length ? `🎙 ${list.map((t) => t.name).join(", ")}` : "";
    },
    setMuted(seconds) {
      mutedLeft = seconds;
      chatNote.textContent = seconds > 0 ? `Thumbed down — muted for ${Math.ceil(seconds)} s` : "";
    },
    note(text) {
      mutedLeft > 0 || (chatNote.textContent = text || "");
    },
    setMic(text, live) {
      ((micBtn.textContent = text), micBtn.classList.toggle("live", !!live));
    },
    get chatLines() {
      return [...chatList.children].map((li) => li.textContent);
    },
    openChat() {
      chatInput.focus();
    },
    closeChat() {
      chatInput.blur();
    },
    clearChat() {
      (chatList.replaceChildren(), rows.clear());
    },
    dispose() {
      let i = context.frameHooks.indexOf(frame);
      (i >= 0 && context.frameHooks.splice(i, 1), root.remove());
      let hud = context.hud && context.hud.root;
      hud && hud.classList.remove("br-watching");
    },
  };
}

export { createBrawlHud };
