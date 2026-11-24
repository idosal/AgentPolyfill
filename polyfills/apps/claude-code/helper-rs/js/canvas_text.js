(() => {
  const vw = innerWidth, vh = innerHeight, out = [];
  if (typeof window.__cliCanvasTexts === "function") {
    for (const t of window.__cliCanvasTexts()) {
      if (t.bottom < 0 || t.top > vh || t.right < 0 || t.x > vw) continue;
      out.push({ ...t, source: "canvas" });
    }
  }
  return [window.__cliDom ? window.__cliDom() : -1, out];
})()
