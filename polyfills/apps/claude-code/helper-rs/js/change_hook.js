(() => {
  // The app's frame counts what changes; frames it embeds (another site's
  // too) only say that something did. The host page itself runs neither.
  if (window.parent === window) return;
  const app = window.parent === window.top;
  // The helper hears of a change at once, through its binding, at most once
  // a frame's worth of time (it paces captures itself). An untrusted hint:
  // it only brings a capture sooner.
  let soon = 0;
  const notify = () => {
    if (soon) return;
    soon = setTimeout(() => {
      soon = 0;
      try { window.__cliChanged?.(""); } catch {}
    }, 16);
  };
  let n = 0;
  const bump = () => { n++; notify(); };
  // What moves the page's text (the DOM, layout, fonts, animations), apart
  // from canvas draws: while it stands still a cells frame keeps the text it
  // read last (the helper asks __cliDom; -1 while something animates).
  let dom = 0;
  const bumpDom = () => { dom++; bump(); };
  const moving = () =>
    (document.getAnimations?.() ?? []).some((a) => a.playState === "running") ||
    [...document.querySelectorAll("video, audio")].some((m) => !m.paused);
  if (app) window.__cliChanges = () => (moving() ? -1 : n);
  if (app) window.__cliDom = () => (moving() ? -1 : dom);
  const watch = () => new MutationObserver(bumpDom).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  watch();
  for (const type of ["scroll", "load", "resize", "input", "change"]) addEventListener(type, bumpDom, true);
  document.fonts?.addEventListener?.("loadingdone", bumpDom);
  // CSS animations and playing media change with no event of their own:
  // from when one starts, a notice every 100 ms while anything still runs.
  let ticking = 0;
  const tick = () => {
    if (ticking) return;
    ticking = setInterval(() => {
      if (moving()) notify();
      else { clearInterval(ticking); ticking = 0; }
    }, 100);
  };
  for (const type of ["animationstart", "transitionrun", "play", "playing"]) addEventListener(type, () => { bumpDom(); tick(); }, true);
  const animate = window.Element?.prototype.animate;
  if (animate) Element.prototype.animate = function (...args) { const running = animate.apply(this, args); tick(); return running; };
  // Drawing on a canvas moves neither the DOM nor, from a timer, animation
  // frames: each draw call counts too. (Asking for an animation frame
  // doesn't: an idle loop of them drew nothing, and looked like constant change.)
  const counted = (proto, names) => {
    if (!proto) return;
    for (const name of names) {
      const draw = proto[name];
      if (typeof draw !== "function") continue;
      proto[name] = function (...args) { bump(); return draw.apply(this, args); };
    }
  };
  const flat = ["fillRect", "strokeRect", "clearRect", "fill", "stroke", "fillText", "strokeText", "drawImage", "putImageData"];
  counted(window.CanvasRenderingContext2D?.prototype, flat);
  counted(window.OffscreenCanvasRenderingContext2D?.prototype, flat);
  const gl = ["clear", "drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements", "blitFramebuffer"];
  counted(window.WebGLRenderingContext?.prototype, gl);
  counted(window.WebGL2RenderingContext?.prototype, gl);
  counted(window.ImageBitmapRenderingContext?.prototype, ["transferFromImageBitmap"]);
  counted(window.GPUQueue?.prototype, ["submit"]);
})();
