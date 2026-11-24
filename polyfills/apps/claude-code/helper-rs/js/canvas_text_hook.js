(() => {
  if (window.__cliCanvasTexts) return;
  const P = CanvasRenderingContext2D.prototype;
  const drawn = new Map();
  const list = (canvas) => {
    let a = drawn.get(canvas);
    if (!a) drawn.set(canvas, (a = []));
    return a;
  };
  const clearRect = P.clearRect;
  P.clearRect = function (x, y, w, h) {
    try {
      const m = this.getTransform();
      if (Math.abs(w * m.a) >= this.canvas.width * 0.9 && Math.abs(h * m.d) >= this.canvas.height * 0.9) {
        drawn.set(this.canvas, []);
      }
    } catch {}
    return clearRect.apply(this, arguments);
  };
  for (const name of ["fillText", "strokeText"]) {
    const original = P[name];
    P[name] = function (text, x, y) {
      try {
        const m = this.getTransform();
        if (Math.abs(m.b) < 1e-3 && Math.abs(m.c) < 1e-3 && String(text).trim()) {
          const metrics = this.measureText(text);
          const width = metrics.width;
          const align = this.textAlign;
          const rtl = this.direction === "rtl";
          let left = x;
          if (align === "center") left = x - width / 2;
          else if (align === "right" || (align === "end" && !rtl) || (align === "start" && rtl)) left = x - width;
          const ascent = metrics.actualBoundingBoxAscent || 0;
          const descent = metrics.actualBoundingBoxDescent || 0;
          const x0 = m.a * left + m.e;
          const x1 = m.a * (left + width) + m.e;
          const y0 = m.d * (y - ascent) + m.f;
          const y1 = m.d * (y + descent) + m.f;
          const style = name === "fillText" ? this.fillStyle : this.strokeStyle;
          list(this.canvas).push({
            text: String(text),
            x0: Math.min(x0, x1), x1: Math.max(x0, x1),
            y0: Math.min(y0, y1), y1: Math.max(y0, y1),
            color: typeof style === "string" ? style : null,
            alpha: this.globalAlpha,
            bold: /bold|[6-9]00/.test(this.font),
          });
        }
      } catch {}
      return original.apply(this, arguments);
    };
  }
  window.__cliCanvasTexts = () => {
    const out = [];
    for (const [canvas, texts] of drawn) {
      if (!canvas.isConnected || !texts.length) continue;
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height || !canvas.width || !canvas.height) continue;
      const sx = r.width / canvas.width;
      const sy = r.height / canvas.height;
      for (const t of texts) {
        if (t.alpha < 0.2) continue;
        out.push({
          x: r.left + t.x0 * sx,
          right: r.left + t.x1 * sx,
          top: r.top + t.y0 * sy,
          bottom: r.top + t.y1 * sy,
          cy: r.top + ((t.y0 + t.y1) / 2) * sy,
          t: t.text,
          color: t.color || "rgb(220, 220, 220)",
          bold: t.bold,
        });
      }
    }
    return out;
  };
  // Canvases drawn by WebGL/WebGPU, plus images and videos: photo regions,
  // which the cell renderer fits for shading rather than for flat UI. 2D
  // canvases are reported too, flagged: the renderer fits one as a photo only
  // when it's densely filled (an area chart), not a sparse line chart.
  const photoCanvases = new Set();
  const flatCanvases = new Set();
  const getContext = HTMLCanvasElement.prototype.getContext;
  // A 3D scene that sizes its drawing by devicePixelRatio (three.js's
  // setPixelRatio) rendered four times the pixels on picture mode's 2x page and
  // stuttered: a bloom-lit torus knot ran at about 2 pictures a second. Once
  // the page has a WebGL/WebGPU canvas, devicePixelRatio reads 1, the scale
  // its frames are captured at while they move; DOM text, 2D canvases and
  // images keep the page's real scale (1 in cells mode anyway).
  let webgl = false;
  const ratio = Object.getOwnPropertyDescriptor(window, "devicePixelRatio") ??
    Object.getOwnPropertyDescriptor(Window.prototype, "devicePixelRatio");
  const realRatio = () => (ratio && ratio.get ? ratio.get.call(window) : 1);
  try {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => (webgl ? 1 : realRatio()) });
  } catch {}
  HTMLCanvasElement.prototype.getContext = function (type) {
    const context = getContext.apply(this, arguments);
    if (context && /webgl|webgpu/i.test(String(type))) webgl = true;
    if (context && /webgl|webgpu|bitmaprenderer/i.test(String(type))) photoCanvases.add(this);
    else if (context && /^2d$/i.test(String(type))) flatCanvases.add(this);
    return context;
  };
  window.__cliPhotoRects = () => {
    const out = [];
    const box = (el, extra) => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      if (r.width >= 8 && r.height >= 8) out.push({ x: r.left, y: r.top, w: r.width, h: r.height, ...extra });
    };
    for (const el of [...photoCanvases, ...document.querySelectorAll("img, video")]) box(el);
    for (const el of flatCanvases) if (!photoCanvases.has(el)) box(el, { canvas2d: true });
    return out;
  };
})();
