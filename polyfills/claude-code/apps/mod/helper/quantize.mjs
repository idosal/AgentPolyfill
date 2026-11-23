// 256-colour pictures for terminals that are sent the bytes of every picture
// (iTerm2): an app's page is mostly flat colour with anti-aliased edges, and
// a palette PNG of it is a third of the size of a true-colour one, which is
// a third of the time a picture takes to arrive (Claude Code writes images at
// about 1 MB/s, and sends a picture again whenever the transcript moves it).

/**
 * Picks at most 256 colours for rows `y0` to `y0 + height` of an RGBA image
 * (median cut, weighted by how many pixels have each colour) and maps every
 * pixel to the nearest. Returns the palette (RGB triplets), one index per
 * pixel, and the peak signal-to-noise ratio of the result in dB (Infinity
 * when no colour changed). Opaque pages only: alpha is ignored. Returns
 * undefined, early, for rows with more than `maxColours` distinct colours
 * (a photo or a 3D scene, which 256 colours would band).
 *
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} y0
 * @param {number} height
 * @param {number} [maxColours]
 */
export function quantize(rgba, width, y0, height, maxColours = Infinity) {
  const pixels = width * height;
  const start = y0 * width * 4;
  // Each distinct colour once, with its pixel count; each pixel's colour id.
  const ids = new Uint32Array(pixels);
  const seen = new Map();
  const keys = [];
  const counts = [];
  for (let p = 0, i = start; p < pixels; p++, i += 4) {
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    let id = seen.get(key);
    if (id === undefined) {
      if (keys.length >= maxColours) return undefined;
      id = keys.length;
      seen.set(key, id);
      keys.push(key);
      counts.push(0);
    }
    counts[id]++;
    ids[p] = id;
  }

  const colours = keys.length;
  const toPalette = new Uint8Array(colours);
  let palette;
  if (colours <= 256) {
    palette = keys.map((k) => [k >> 16, (k >> 8) & 255, k & 255]);
    for (let c = 0; c < colours; c++) toPalette[c] = c;
  } else {
    palette = medianCut(keys, counts, 256);
    // Nearest palette colour for each distinct colour (perceptual weights).
    for (let c = 0; c < colours; c++) {
      const k = keys[c];
      const r = k >> 16, g = (k >> 8) & 255, b = k & 255;
      let best = 0, bestD = Infinity;
      for (let q = 0; q < palette.length; q++) {
        const e = palette[q];
        const d = 3 * (r - e[0]) ** 2 + 4 * (g - e[1]) ** 2 + 2 * (b - e[2]) ** 2;
        if (d < bestD) { bestD = d; best = q; }
      }
      toPalette[c] = best;
    }
  }

  const indices = new Uint8Array(pixels);
  for (let p = 0; p < pixels; p++) indices[p] = toPalette[ids[p]];
  let error = 0;
  if (colours > 256) {
    for (let c = 0; c < colours; c++) {
      const k = keys[c];
      const e = palette[toPalette[c]];
      error += counts[c] * ((k >> 16) - e[0]) ** 2 + counts[c] * (((k >> 8) & 255) - e[1]) ** 2 + counts[c] * ((k & 255) - e[2]) ** 2;
    }
  }
  const psnr = error === 0 ? Infinity : 10 * Math.log10((255 * 255 * pixels * 3) / error);
  return { palette, indices, psnr, colours };
}

/** Splits the colour space into `size` boxes, each the weighted mean of its colours. */
function medianCut(keys, counts, size) {
  const channel = (k, c) => (c === 0 ? k >> 16 : c === 1 ? (k >> 8) & 255 : k & 255);
  const box = (members) => {
    let n = 0;
    const lo = [255, 255, 255], hi = [0, 0, 0];
    for (const m of members) {
      n += counts[m];
      const k = keys[m];
      for (let c = 0; c < 3; c++) {
        const v = channel(k, c);
        if (v < lo[c]) lo[c] = v;
        if (v > hi[c]) hi[c] = v;
      }
    }
    // Split along the widest channel; boxes with many pixels first.
    let axis = 0;
    for (let c = 1; c < 3; c++) if (hi[c] - lo[c] > hi[axis] - lo[axis]) axis = c;
    return { members, n, axis, score: members.length > 1 ? (hi[axis] - lo[axis]) * Math.sqrt(n) : 0 };
  };
  const boxes = [box(keys.map((_, i) => i))];
  while (boxes.length < size) {
    let at = 0;
    for (let i = 1; i < boxes.length; i++) if (boxes[i].score > boxes[at].score) at = i;
    const { members, n, axis, score } = boxes[at];
    if (score === 0) break;
    members.sort((a, b) => channel(keys[a], axis) - channel(keys[b], axis));
    let acc = 0, cut = 1;
    for (let i = 0; i < members.length; i++) {
      acc += counts[members[i]];
      if (acc >= n / 2) { cut = Math.min(members.length - 1, Math.max(1, i)); break; }
    }
    boxes.splice(at, 1, box(members.slice(0, cut)), box(members.slice(cut)));
  }
  return boxes.map(({ members, n }) => {
    let r = 0, g = 0, b = 0;
    for (const m of members) {
      const k = keys[m], c = counts[m];
      r += (k >> 16) * c; g += ((k >> 8) & 255) * c; b += (k & 255) * c;
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
}
