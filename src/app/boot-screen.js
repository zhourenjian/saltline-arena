// Boot progress overlay. Elements are looked up on use (not at import) so the same module works
// for the standalone page and for a World Package that mounts its own DOM before load().
var bootElement = () => document.getElementById("boot");

var bootMessage = () => document.getElementById("boot-msg");

var bootProgress = () => document.getElementById("boot-fill");

var yieldToBrowser = () => new Promise((i) => setTimeout(i, 0));

async function setBootProgress(i, e) {
  let t = bootMessage(),
    n = bootProgress();
  (t && (t.textContent = i),
    n && (n.style.width = Math.round(e * 100) + "%"),
    await yieldToBrowser());
}

export {
  bootElement,
  setBootProgress,
  bootMessage,
  bootProgress,
  yieldToBrowser,
};
