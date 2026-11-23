// Small helpers for the renderer's tests: synthetic RGBA pages, and the
// Raster that composeFrame returns decoded back into cells.

export const DEFAULT = 0x01000000;

/** A page `width` x `height` pixels, all one colour. */
export function page(width, height, rgb) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...rgb, 255], i * 4);
  return { width, height, data };
}

/** Paints a rectangle onto a page. */
export function fill(img, x0, y0, w, h, rgb) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) img.data.set(rgb, (y * img.width + x) * 4);
  }
  return img;
}

/** composeFrame's Raster as {ch, fg, bg} cells, colours as numbers. */
export function cells(frame) {
  const bytes = Buffer.from(frame.cells, "base64");
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  const out = [];
  for (let i = 0; i < words.length; i += 3) {
    out.push({ ch: String.fromCodePoint(words[i]), fg: words[i + 1], bg: words[i + 2] });
  }
  return out;
}

/** The characters of each row, joined. */
export function rows(frame) {
  const list = cells(frame);
  const out = [];
  for (let r = 0; r < frame.rows; r++) {
    out.push(list.slice(r * frame.cols, (r + 1) * frame.cols).map((c) => c.ch).join(""));
  }
  return out;
}

/** Options for a grid of 8 x 16 px cells on a black page. */
export function grid(cols, rowCount, extra = {}) {
  return { cols, rows: rowCount, cellWidth: 8, cellHeight: 16, pageBackground: 0, ...extra };
}

/** Strokes an anti-aliased polyline `width` pixels thick through `points`. */
export function stroke(img, points, width, rgb) {
  const half = width / 2;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let best = Infinity;
      for (let k = 0; k + 1 < points.length; k++) {
        const [ax, ay] = points[k];
        const [bx, by] = points[k + 1];
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(x + 0.5 - (ax + t * dx), y + 0.5 - (ay + t * dy)));
      }
      const cover = Math.max(0, Math.min(1, half + 0.5 - best));
      if (!cover) continue;
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) img.data[i + c] = Math.round(img.data[i + c] + (rgb[c] - img.data[i + c]) * cover);
    }
  }
  return img;
}

export const isBraille = (ch) => ch >= "⠁" && ch <= "⣿";
