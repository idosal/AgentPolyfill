// Turns a screenshot of a view plus the text the page lays out into a grid
// of terminal cells: a Claude Code Raster, one character and two colours
// per cell.
//
// Pixels become block characters: for each cell, every candidate glyph
// (the 14 quadrant shapes ▘▝▖▗▚▞▀▄▌▐▙▛▜▟, the lower and left eighth bars
// ▁▂▃▅▆▇ ▏▎▍▋▊▉, and the one-eighth top and right lines ▔▕) is fitted
// with the best two colours for the pixels it covers and doesn't, and the
// glyph with the least error wins. All are Block Elements, which every
// terminal font draws. UI and photo regions (WebGL canvases, images,
// videos) are fitted with different settings: see UI and PHOTO below.
// Text is not read off the pixels: the page reports each laid-out line and
// its colour, and those characters replace the blocks under them, which
// keeps text legible at one character per cell.

const BOLD = 1;
const INVERSE = 2;
const DIM = 4;

// Quadrant bits: top-left 1, top-right 2, bottom-left 4, bottom-right 8.
const QUADRANTS = [" ", "▘", "▝", "▀", "▖", "▌", "▞", "▛", "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█"];

/**
 * How cells are fitted. UI keeps flat areas calm: a glyph must beat the flat
 * colour clearly, near colours merge and colours snap to steps of 8. Photo
 * cells (inside a WebGL canvas, an image or a video) keep detail: a low bar
 * for glyphs, the fit weighing green over blue as the eye does, colours from
 * the view's palette (see "photo palettes"), and glyphs that hold from frame
 * to frame unless a clearly better one appears, so animation doesn't shimmer.
 */
const UI = { minGain: 45, nearTol: 10, step: 17, bgTol: 10, weights: [1, 1, 1], photo: false };
const PHOTO = { minGain: 3, weights: [0.9, 1.8, 0.3], photo: true };
const KEEP = 0.8;
const DROP = 0.6;

// A glyph is drawn in fg over its region, bg elsewhere: a set of quadrants,
// a band of rows [a, b) or a band of columns [a, b). When the page background
// would land on the fg side, the complement glyph (if the font has one)
// swaps the two so the terminal's own background shows.
const candidateCache = new Map();
function candidates(cw, ch) {
  const key = `${cw}x${ch}`;
  if (candidateCache.has(key)) return candidateCache.get(key);
  const hx = cw >> 1;
  const hy = ch >> 1;
  const quadArea = [hx * hy, (cw - hx) * hy, hx * (ch - hy), (cw - hx) * (ch - hy)];
  const list = [];
  for (let mask = 1; mask < 15; mask++) {
    let nf = 0;
    for (let k = 0; k < 4; k++) if (mask & (1 << k)) nf += quadArea[k];
    list.push({ ch: QUADRANTS[mask], complement: QUADRANTS[mask ^ 15], kind: 0, mask, nf });
  }
  const eighthH = (k) => Math.max(1, Math.round((ch * k) / 8));
  const eighthW = (k) => Math.max(1, Math.round((cw * k) / 8));
  for (const k of [1, 2, 3, 5, 6, 7]) {
    list.push({ ch: String.fromCodePoint(0x2580 + k), complement: k === 7 ? "▔" : null, kind: 1, a: ch - eighthH(k), b: ch, nf: eighthH(k) * cw });
    list.push({ ch: String.fromCodePoint(0x2590 - k), complement: k === 7 ? "▕" : null, kind: 2, a: 0, b: eighthW(k), nf: eighthW(k) * ch });
  }
  list.push({ ch: "▔", complement: "▇", kind: 1, a: 0, b: eighthH(1), nf: eighthH(1) * cw });
  list.push({ ch: "▕", complement: "▉", kind: 2, a: cw - eighthW(1), b: cw, nf: eighthW(1) * ch });
  // Sextants (2 x 3 blocks), for photo cells in terminals that draw them:
  // appended after the others, so `all` shares `list`'s indices.
  const t1 = Math.round(ch / 3);
  const t2 = Math.round((2 * ch) / 3);
  const sextArea = [hx * t1, (cw - hx) * t1, hx * (t2 - t1), (cw - hx) * (t2 - t1), hx * (ch - t2), (cw - hx) * (ch - t2)];
  const all = list.slice();
  for (let mask = 1; mask < 63; mask++) {
    if (mask === 21 || mask === 42) continue; // ▌ and ▐, already quadrant shapes
    let nf = 0;
    for (let k = 0; k < 6; k++) if (mask & (1 << k)) nf += sextArea[k];
    all.push({ ch: sextant(mask), complement: sextant(63 - mask), kind: 3, mask, nf });
  }
  const out = { list, all, hx, hy, t1, t2 };
  candidateCache.set(key, out);
  return out;
}

/** The sextant character for a 6-bit mask (bit 0 top left, row by row). */
function sextant(mask) {
  if (mask === 21) return "▌";
  if (mask === 42) return "▐";
  if (mask === 63) return "█";
  return String.fromCodePoint(0x1fb00 + mask - 1 - (mask > 21 ? 1 : 0) - (mask > 42 ? 1 : 0));
}

// sRGB byte -> linear light (for Oklab).
const LIN = Float64Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

let scratch = null;
function scratchFor(cw, ch) {
  if (!scratch || scratch.cw !== cw || scratch.ch !== ch) {
    scratch = {
      cw,
      ch,
      rowP: new Float64Array((ch + 1) * 3),
      colP: new Float64Array((cw + 1) * 3),
      quad: new Float64Array(12),
      sext: new Float64Array(18),
      sf: new Float64Array(3),
      T: new Float64Array(3),
      n: 0,
      w: null,
    };
  }
  return scratch;
}

/**
 * The best block glyph for one cell, as an index into `candidates()` (-1 for
 * a flat cell) with its two colours. One pass gathers per-row, per-column and
 * per-quadrant sums; each candidate's fit is then a few of those: the squared
 * error of a two-colour fit is the cell's total minus |S_fg|²/n_fg +
 * |S_bg|²/n_bg (per channel, weighted), so the best glyph maximises that sum.
 */
function gather(img, x0, y0, cw, ch, weights) {
  const s = scratchFor(cw, ch);
  const { hx, hy, t1, t2 } = candidates(cw, ch);
  const { rowP, colP, quad, sext } = s;
  rowP.fill(0);
  colP.fill(0);
  quad.fill(0);
  sext.fill(0);
  const d = img.data;
  const W = img.width;
  const H = img.height;
  for (let y = 0; y < ch; y++) {
    const py = y0 + y < H ? y0 + y : H - 1;
    const qy = y < hy ? 0 : 6;
    const sy = y < t1 ? 0 : y < t2 ? 6 : 12;
    let rr = 0;
    let rg = 0;
    let rb = 0;
    for (let x = 0; x < cw; x++) {
      const px = x0 + x < W ? x0 + x : W - 1;
      const i = (py * W + px) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      rr += r;
      rg += g;
      rb += b;
      const o = (x + 1) * 3;
      colP[o] += r;
      colP[o + 1] += g;
      colP[o + 2] += b;
      const q = qy + (x < hx ? 0 : 3);
      quad[q] += r;
      quad[q + 1] += g;
      quad[q + 2] += b;
      const e = sy + (x < hx ? 0 : 3);
      sext[e] += r;
      sext[e + 1] += g;
      sext[e + 2] += b;
    }
    const o = (y + 1) * 3;
    rowP[o] = rowP[o - 3] + rr;
    rowP[o + 1] = rowP[o - 2] + rg;
    rowP[o + 2] = rowP[o - 1] + rb;
  }
  for (let x = 1; x <= cw; x++) {
    colP[x * 3] += colP[x * 3 - 3];
    colP[x * 3 + 1] += colP[x * 3 - 2];
    colP[x * 3 + 2] += colP[x * 3 - 1];
  }
  s.n = cw * ch;
  s.T[0] = rowP[ch * 3];
  s.T[1] = rowP[ch * 3 + 1];
  s.T[2] = rowP[ch * 3 + 2];
  s.w = weights;
  return s;
}

/** Fills s.sf with the fg-side sums of `cand`, and returns its fit J. */
function fitOf(s, cand) {
  const { rowP, colP, quad, sext, sf, T, n } = s;
  const [w0, w1, w2] = s.w;
  if (cand.kind === 3) {
    sf[0] = sf[1] = sf[2] = 0;
    for (let k = 0; k < 6; k++) {
      if (cand.mask & (1 << k)) {
        sf[0] += sext[k * 3];
        sf[1] += sext[k * 3 + 1];
        sf[2] += sext[k * 3 + 2];
      }
    }
  } else if (cand.kind === 0) {
    sf[0] = sf[1] = sf[2] = 0;
    for (let k = 0; k < 4; k++) {
      if (cand.mask & (1 << k)) {
        sf[0] += quad[k * 3];
        sf[1] += quad[k * 3 + 1];
        sf[2] += quad[k * 3 + 2];
      }
    }
  } else {
    const P = cand.kind === 1 ? rowP : colP;
    sf[0] = P[cand.b * 3] - P[cand.a * 3];
    sf[1] = P[cand.b * 3 + 1] - P[cand.a * 3 + 1];
    sf[2] = P[cand.b * 3 + 2] - P[cand.a * 3 + 2];
  }
  const nf = cand.nf;
  const nb = n - nf;
  return (
    (w0 * sf[0] * sf[0] + w1 * sf[1] * sf[1] + w2 * sf[2] * sf[2]) / nf +
    (w0 * (T[0] - sf[0]) ** 2 + w1 * (T[1] - sf[1]) ** 2 + w2 * (T[2] - sf[2]) ** 2) / nb
  );
}

/** A UI cell: free colours, a glyph only where it clearly beats flat. */
function fitCell(img, x0, y0, cw, ch, prm) {
  return fitGathered(gather(img, x0, y0, cw, ch, prm.weights), cw, ch, prm);
}

function fitGathered(s, cw, ch, prm) {
  const { list } = candidates(cw, ch);
  const { T, n, sf } = s;
  const [w0, w1, w2] = s.w;
  const flat = (w0 * T[0] * T[0] + w1 * T[1] * T[1] + w2 * T[2] * T[2]) / n;
  let best = -1;
  let bestJ = flat;
  for (let k = 0; k < list.length; k++) {
    const J = fitOf(s, list[k]);
    if (J > bestJ) {
      bestJ = J;
      best = k;
    }
  }
  const mean = pack(T[0] / n, T[1] / n, T[2] / n);
  if (best < 0 || (bestJ - flat) / n < prm.minGain) return { index: -1, fg: mean, bg: mean, mean };
  const cand = list[best];
  fitOf(s, cand);
  const nf = cand.nf;
  const nb = n - nf;
  return {
    index: best,
    fg: pack(sf[0] / nf, sf[1] / nf, sf[2] / nf),
    bg: pack((T[0] - sf[0]) / nb, (T[1] - sf[1]) / nb, (T[2] - sf[2]) / nb),
    mean,
  };
}

// ---------------------------------------------------------------- UI cells
//
// UI is flat colours with sharp edges, so a UI cell is fitted by its two
// dominant colours rather than by means: the commonest colour and the
// commonest one clearly different from it are kept exact (no mud where three
// chart layers share a cell), each pixel goes to one side, and the glyph is
// the one whose shape agrees with that mask on most pixels. A glyph is used
// only when it explains at least half of what flat gets wrong, so slivers and
// rounded corners don't leave debris. A thin line or gap the grid can't place
// (a 1 px border in the middle of a cell) snaps to the nearer cell edge at
// its own thickness instead of dissolving into the mean.
const UI_BINS = 32;
const UI_BUSY = 0.12; // share of a third colour that makes a cell "busy"
const UI_CONTRAST = 10; // least per-channel difference between the two colours
const UI_MIN_PIXELS = 6;
const UI_EXPLAIN = 0.65;
const UI_EXPLAIN_THIN = 0.25; // for bars of a quarter cell or less: lines, not slivers
const UI_STILL = 3.5; // mean change per channel below which a cell keeps its last fit,
// unless UI_STILL_PIXELS of its pixels changed by UI_STILL_DELTA (summed over
// channels): a faint gridline entering or leaving barely moves the mean.
const UI_STILL_PIXELS = 4;
const UI_STILL_DELTA = 30;
const UI_TRIES = 3; // second colours to try, most striking first
const UI_TRACE_MAX = 0.4; // a line to trace covers at most this much of a cell
const uiScratch = {
  key: new Int32Array(UI_BINS), n: new Int32Array(UI_BINS),
  r: new Float64Array(UI_BINS), g: new Float64Array(UI_BINS), b: new Float64Array(UI_BINS),
  top: new Int32Array(UI_BINS), left: new Int32Array(UI_BINS), side: new Uint8Array(UI_BINS), bin: new Uint8Array(64 * 64),
  rowOn: new Int32Array(64), colOn: new Int32Array(64), quadOn: new Int32Array(4),
  prev: 0, // the cell's last glyph (a char code), for hysteresis; 0 when unknown
  soft: new Uint8Array(UI_BINS), rowSoft: new Int32Array(64), colSoft: new Int32Array(64),
  share: new Float32Array(UI_BINS), // how far each soft bin is toward the second colour
  dots: new Float64Array(16), // Braille dot coverage, then dot areas
  inked: false,
};
const lowerBar = (k) => (k === 4 ? 11 : 14 + 2 * [1, 2, 3, 5, 6, 7].indexOf(k));
const leftBar = (k) => (k === 4 ? 4 : 15 + 2 * [1, 2, 3, 5, 6, 7].indexOf(k));

/** Eighths of the cell a stripe `size` pixels thick is drawn with. */
const eighths = (size, len, most) => Math.min(most, Math.max(1, Math.floor((size * 8) / len + 0.3)));

/**
 * A stripe of colour `band` over `rest`, `e` eighths thick, centred `centre`
 * pixels into a cell `len` long: on the nearer edge, or, when it is thin and
 * runs through the middle of the cell, as a box-drawing line there, so a
 * line that climbs steps by a third of a cell rather than a whole one.
 * Thicker stripes (a slider's track) keep to the edges: one thickness per track.
 */
function stripe(list, horizontal, centre, len, e, band, rest, mean) {
  // The line a cell showed last frame holds its place a little past the
  // point where a fresh one would be put elsewhere, so a line sitting on
  // the boundary between two levels doesn't flip between them.
  const prev = uiScratch.prev;
  const hold = prev === 0x2501 || prev === 0x2503 ? len / 8 : prev > 0x2580 && prev < 0x2596 ? -len / 8 : 0;
  if (e === 1 && Math.abs(centre - len / 2) <= len / 5 + hold) {
    // Heavy lines: about an eighth of a cell thick where terminals draw box
    // characters themselves, so they match the ▁ and ▔ they join.
    return { index: -1, glyph: horizontal ? "━" : "┃", fg: band, bg: rest, mean };
  }
  if (horizontal) {
    return centre < len / 2
      ? e === 1
        ? { index: list.length - 2, fg: band, bg: rest, mean } // ▔
        : { index: lowerBar(8 - e), fg: rest, bg: band, mean }
      : { index: lowerBar(e), fg: band, bg: rest, mean };
  }
  return centre < len / 2
    ? { index: leftBar(e), fg: band, bg: rest, mean }
    : e === 1
      ? { index: list.length - 1, fg: band, bg: rest, mean } // ▕
      : { index: leftBar(8 - e), fg: rest, bg: band, mean };
}

/**
 * One run of set (want=1) or clear (want=0) lines no thicker than half the
 * cell, or null. It may touch an edge: a 3 px track at the bottom of a cell
 * is no eighth bar exactly, and is drawn as the nearest one.
 */
function interiorBand(counts, len, across, want) {
  let start = -1;
  let end = -1;
  let runs = 0;
  // A stripe crossing the other way adds the same few pixels to every line.
  let base = across;
  for (let i = 0; i < len; i++) if (counts[i] < base) base = counts[i];
  if (base > across / 2) base = 0;
  for (let i = 0; i < len; i++) {
    const c = counts[i];
    if (c > base + 1 && c < across - 1) return null; // not a clean stripe pattern
    const on = c >= across - 1 ? 1 : 0;
    if (on === want) {
      if (i === 0 || end !== i) {
        runs++;
        start = i;
      }
      end = i + 1;
    }
  }
  if (runs !== 1 || end - start > len / 2) return null;
  return { start, size: end - start };
}

/**
 * Returns null when the cell has too many colours (a gradient): use fitCell.
 * `ink` (a packed colour, or -1) is text drawn over the cell: pixels of that
 * colour, and its anti-aliased blends with the cell's main colour, are left
 * out, so the shapes under a label survive without the label's pixels. Only
 * rows [inkTop, inkBottom) of the cell can hold ink: a border just above a
 * heading is often a blend of the same two colours.
 */
function fitUi(img, x0, y0, cw, ch, ink = -1, inkTop = 0, inkBottom = ch) {
  const u = uiScratch;
  const d = img.data;
  const W = img.width;
  const H = img.height;
  const { hx, hy, list } = candidates(cw, ch);
  const bin = u.bin;
  const inked = ink >= 0;
  u.inked = inked;
  let bins = 0;
  for (let y = 0; y < ch; y++) {
    const py = y0 + y < H ? y0 + y : H - 1;
    for (let x = 0; x < cw; x++) {
      const px = x0 + x < W ? x0 + x : W - 1;
      const i = (py * W + px) * 4;
      const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4) | (inked && y >= inkTop && y < inkBottom ? 4096 : 0);
      let k = 0;
      while (k < bins && u.key[k] !== key) k++;
      if (k === bins) {
        if (bins === UI_BINS) return null;
        u.key[k] = key;
        u.n[k] = u.top[k] = u.left[k] = 0;
        u.r[k] = u.g[k] = u.b[k] = 0;
        bins++;
      }
      bin[y * cw + x] = k;
      u.n[k]++;
      if (y < hy) u.top[k]++;
      if (x < hx) u.left[k]++;
      u.r[k] += d[i];
      u.g[k] += d[i + 1];
      u.b[k] += d[i + 2];
    }
  }
  for (let k = 0; k < bins; k++) {
    u.r[k] /= u.n[k];
    u.g[k] /= u.n[k];
    u.b[k] /= u.n[k];
    u.side[k] = 0; // 0 first colour, 1 second, 2 a third, 3 ink
  }
  const color = (k) => pack(u.r[k], u.g[k], u.b[k]);
  const ir = (ink >> 16) & 255;
  const ig = (ink >> 8) & 255;
  const ib = ink & 255;
  if (inked) {
    for (let k = 0; k < bins; k++) {
      if (u.key[k] >= 4096 && Math.max(Math.abs(u.r[k] - ir), Math.abs(u.g[k] - ig), Math.abs(u.b[k] - ib)) <= 40) u.side[k] = 3;
    }
  }
  let a = -1;
  for (let k = 0; k < bins; k++) if (u.side[k] !== 3 && (a < 0 || u.n[k] > u.n[a])) a = k;
  if (a < 0) return null;
  const ar = u.r[a];
  const ag = u.g[a];
  const ab = u.b[a];
  if (inked) {
    // Blends of the ink with the main colour lie on the line between them.
    const er = ir - ar;
    const eg = ig - ag;
    const eb = ib - ab;
    const ee = er * er + eg * eg + eb * eb;
    for (let k = 0; k < bins && ee > 0; k++) {
      if (k === a || u.side[k] === 3 || u.key[k] < 4096) continue;
      const dr = u.r[k] - ar;
      const dg = u.g[k] - ag;
      const db = u.b[k] - ab;
      const t = (dr * er + dg * eg + db * eb) / ee;
      if (t > 0.1 && dr * dr + dg * dg + db * db - t * t * ee < 24 * 24) u.side[k] = 3;
    }
  }
  const first = color(a);
  const flatFirst = { index: -1, fg: first, bg: first, mean: first };
  const { rowOn, colOn, quadOn, soft, rowSoft, colSoft } = u;
  const n = cw * ch;
  // The second colour: the one that matters most beside the first, by how
  // many pixels it has and how different it is (a dark gap beats a
  // neighbouring tile of nearly the same green). When no glyph can show it
  // (a slider's thumb barely entering the cell), the next one gets its turn
  // (the slider's track), so a small bright thing doesn't hide a plain one.
  for (let attempt = 0; attempt < UI_TRIES; attempt++) {
    let b = -1;
    let weight = 0;
    for (let k = 0; k < bins; k++) {
      if (k === a || u.side[k] >= 3) continue;
      const dr = u.r[k] - ar;
      const dg = u.g[k] - ag;
      const db = u.b[k] - ab;
      if (Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db)) < UI_CONTRAST) continue;
      const w = u.n[k] * (dr * dr + dg * dg + db * db);
      if (w > weight) {
        weight = w;
        b = k;
      }
    }
    if (b < 0) return flatFirst;
    const br = u.r[b];
    const bg = u.g[b];
    const bb = u.b[b];
    const er = br - ar;
    const eg = bg - ag;
    const eb = bb - ab;
    const ee = er * er + eg * eg + eb * eb;
    const second = color(b);
    const reach = 0.3 * ee;
    let third = 0;
    // How much of the second colour is in the cell, counting an anti-aliased
    // pixel by its share: a line's real thickness, however soft its edges.
    let mass = 0;
    for (let k = 0; k < bins; k++) {
      soft[k] = 0;
      u.share[k] = 0;
      if (u.side[k] >= 3) continue; // ink, or a colour already tried
      u.side[k] = 0;
      const dr = u.r[k] - ar;
      const dg = u.g[k] - ag;
      const db = u.b[k] - ab;
      const dd = dr * dr + dg * dg + db * db;
      // Anti-aliased pixels of a thin line: part of the way to its colour.
      const t = (dr * er + dg * eg + db * eb) / ee;
      if (t >= 0.3 && dd - t * t * ee <= 0.15 * ee) {
        soft[k] = 1;
        u.share[k] = t < 1 ? t : 1;
        mass += u.n[k] * u.share[k];
      }
      if ((u.r[k] - br) ** 2 + (u.g[k] - bg) ** 2 + (u.b[k] - bb) ** 2 <= reach) u.side[k] = 1;
      else if (dd > reach) {
        u.side[k] = 2;
        third += u.n[k];
      }
    }
    rowOn.fill(0, 0, ch);
    colOn.fill(0, 0, cw);
    rowSoft.fill(0, 0, ch);
    colSoft.fill(0, 0, cw);
    quadOn.fill(0);
    let on = 0;
    let softN = 0;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const k = bin[y * cw + x];
        if (soft[k]) {
          softN++;
          rowSoft[y]++;
          colSoft[x]++;
        }
        if (u.side[k] !== 1) continue;
        on++;
        rowOn[y]++;
        colOn[x]++;
        quadOn[(y < hy ? 0 : 2) + (x < hx ? 0 : 1)]++;
      }
    }
    const fit = fitMask(u, bins, cw, ch, on, third, softN, mass, first, second, color);
    if (fit) return fit;
    // Not drawable: set this colour aside and try the next.
    for (let k = 0; k < bins; k++) if (u.side[k] === 1 || soft[k]) u.side[k] = 4;
    u.side[a] = 0;
  }
  return flatFirst;
}

/** The glyph for one first/second colour split of a cell, or null. */
function fitMask(u, bins, cw, ch, on, third, softN, mass, first, second, color) {
  const { hx, hy, list } = candidates(cw, ch);
  const { rowOn, colOn, quadOn, rowSoft, colSoft } = u;
  const n = cw * ch;
  const wrongFlat = Math.min(on, n - on);
  const flatMean = on * 2 > n ? second : first;
  if (on * 2 > n && n - on < UI_MIN_PIXELS) return { index: -1, fg: second, bg: second, mean: second };
  if (Math.max(wrongFlat, softN) < UI_MIN_PIXELS) return null;

  // A stripe the grid can't place: snap it to the nearer edge.
  for (let want = 1; want >= 0 && wrongFlat >= UI_MIN_PIXELS; want--) {
    const band = want ? second : first;
    const rest = want ? first : second;
    const rows = interiorBand(rowOn, ch, cw, want);
    if (rows) return stripe(list, true, rows.start + rows.size / 2, ch, eighths(want ? Math.min(rows.size, mass / cw) : rows.size, ch, 4), band, rest, flatMean);
    const colsBand = interiorBand(colOn, cw, ch, want);
    if (colsBand) return stripe(list, false, colsBand.start + colsBand.size / 2, cw, eighths(want ? Math.min(colsBand.size, mass / ch) : colsBand.size, cw, 4), band, rest, flatMean);
  }

  // A thin line crossing the cell on a slant or zig-zagging (a sparkline, a
  // steep chart line): Braille dots, a 2 x 4 grid, follow it where block
  // shapes could only step. The block fit is kept beside it (`alt`) for a
  // Braille cell that turns out to have no Braille neighbour (a rounded
  // corner, the edge of a thumb), which goes back to it.
  if (!u.inked) {
    const dots = third <= UI_LINE_THIRD * n ? slopedLine(u, cw, ch, mass) : 0;
    if (dots) {
      const alt = fitRest(u, bins, cw, ch, on, third, softN, mass, first, second, color, wrongFlat, flatMean);
      return { index: -1, glyph: String.fromCodePoint(0x2800 + dots), fg: second, bg: first, mean: first, alt };
    }
  }
  return fitRest(u, bins, cw, ch, on, third, softN, mass, first, second, color, wrongFlat, flatMean);
}

/** fitMask past the stripe rule: busy cells, then the best shape, then a traced line. */
function fitRest(u, bins, cw, ch, on, third, softN, mass, first, second, color, wrongFlat, flatMean) {
  const { hx, hy, list } = candidates(cw, ch);
  const { rowOn, colOn, quadOn, rowSoft, colSoft } = u;
  const n = cw * ch;
  if (third > UI_BUSY * n) {
    // Three or more colours (stacked chart layers): no two-colour shape is
    // right, and picking the best pair cell by cell speckles. Sample instead:
    // the commonest colour of each half, the same rule in every cell.
    let t = -1;
    let bo = -1;
    let l = -1;
    let r = -1;
    for (let k = 0; k < bins; k++) {
      if (u.side[k] === 3) continue;
      if (t < 0 || u.top[k] > u.top[t]) t = k;
      if (bo < 0 || u.n[k] - u.top[k] > u.n[bo] - u.top[bo]) bo = k;
      if (l < 0 || u.left[k] > u.left[l]) l = k;
      if (r < 0 || u.n[k] - u.left[k] > u.n[r] - u.left[r]) r = k;
    }
    const vertical = u.top[t] + u.n[bo] - u.top[bo] >= u.left[l] + u.n[r] - u.left[r];
    const p = vertical ? t : l;
    const q = vertical ? bo : r;
    if (p === q) return { index: -1, fg: color(p), bg: color(p), mean: color(p) };
    // ▄ (index 11): fg below; ▌ (index 4): fg left.
    return vertical
      ? { index: 11, fg: color(q), bg: color(p), mean: first }
      : { index: 4, fg: color(p), bg: color(q), mean: first };
  }

  // Otherwise the glyph agreeing with the mask on most pixels.
  let best = -1;
  let bestAgree = 0;
  let inverted = false;
  for (let k = 0; k < list.length && wrongFlat >= UI_MIN_PIXELS; k++) {
    const cand = list[k];
    const thin = cand.kind !== 0 && (cand.nf * 4 <= n || cand.nf * 4 >= 3 * n);
    let inside = 0;
    if (cand.kind === 0) {
      for (let q = 0; q < 4; q++) if (cand.mask & (1 << q)) inside += quadOn[q];
    } else {
      const counts = cand.kind === 1 ? rowOn : colOn;
      for (let i = cand.a; i < cand.b; i++) inside += counts[i];
    }
    const agree = inside + (n - cand.nf - (on - inside));
    const better = Math.max(agree, n - agree);
    if (n - better > (thin ? UI_EXPLAIN_THIN : UI_EXPLAIN) * wrongFlat) continue;
    if (better > bestAgree) {
      bestAgree = better;
      best = k;
      inverted = agree < n - agree;
    }
  }
  if (best >= 0) {
    return inverted
      ? { index: best, fg: first, bg: second, mean: flatMean }
      : { index: best, fg: second, bg: first, mean: flatMean };
  }

  // A thin line no shape fits (sloped, zig-zag, anti-aliased): if it crosses
  // the whole cell, trace it as a bar of its own thickness on the edge it
  // runs nearer to. Neighbouring cells then join into a line that steps.
  if (softN >= UI_MIN_PIXELS && softN <= UI_TRACE_MAX * n) {
    let covered = 0;
    let centre = 0;
    for (let x = 0; x < cw; x++) if (colSoft[x]) covered++;
    if (covered >= cw - 1) {
      for (let y = 0; y < ch; y++) centre += rowSoft[y] * (y + 0.5);
      return stripe(list, true, centre / softN, ch, eighths(mass / cw, ch, 2), second, first, first);
    }
    covered = 0;
    for (let y = 0; y < ch; y++) if (rowSoft[y]) covered++;
    if (covered >= ch - 2) {
      for (let x = 0; x < cw; x++) centre += colSoft[x] * (x + 0.5);
      return stripe(list, false, centre / softN, cw, eighths(mass / ch, cw, 2), second, first, first);
    }
  }
  // No shape, but most of the cell is the second colour: that, flat.
  return on * 2 > n ? { index: -1, fg: second, bg: second, mean: second } : null;
}

// Horizontal bars, and the corner shapes a bar's rounded end leaves.
const BARS = new Set(["▀", "▄", "▔", "━", "▁", "▂", "▃", "▅", "▆", "▇"]);
const CORNERS = new Set(["▘", "▝", "▖", "▗", "▛", "▜", "▙", "▟"]);

// ---------------------------------------------------------------- Braille lines
//
// Braille cells are a 2 x 4 grid of dots; each dot is on where the line
// covers enough of its eighth of the cell. Used only for thin lines that
// cross a cell on a slant: straight lines and borders keep their solid
// block and box glyphs, and filled shapes their blocks.
const BRAILLE_THICK = 3.2; // thickest line, in pixels across it, drawn as dots
const UI_LINE_THIRD = 0.05; // a line is two colours: more of a third is an area's edge
const BRAILLE_MIN = 0.12; // share of a dot's area the line must cover
const BRAILLE_BITS = [0x01, 0x02, 0x04, 0x40, 0x08, 0x10, 0x20, 0x80]; // [column][row]

/** Dots from coverage (`cov[0..7]`, column-major) over areas (`cov[8..15]`). */
function dotsOf(cov) {
  let bits = 0;
  for (let c = 0; c < 2; c++) {
    let most = 0;
    for (let r = 0; r < 4; r++) {
      const f = cov[c * 4 + r] / Math.max(1, cov[8 + c * 4 + r]);
      cov[c * 4 + r] = f;
      if (f > most) most = f;
    }
    if (most < BRAILLE_MIN) continue;
    for (let r = 0; r < 4; r++) if (cov[c * 4 + r] >= Math.max(BRAILLE_MIN, 0.45 * most)) bits |= BRAILLE_BITS[c * 4 + r];
  }
  return bits;
}

/** Braille dots for the second colour of a UI cell, if it is a thin sloped line; else 0. */
function slopedLine(u, cw, ch, mass) {
  if (mass < 3) return 0;
  const { colSoft, rowSoft, bin, share, dots } = u;
  let cols = 0;
  let rows = 0;
  for (let x = 0; x < cw; x++) if (colSoft[x]) cols++;
  for (let y = 0; y < ch; y++) if (rowSoft[y]) rows++;
  const across = cols >= cw - 1;
  const down = rows >= ch - 2;
  if (!across && !down) return 0;
  const thick = mass / Math.max(cols, rows);
  if (thick > BRAILLE_THICK) return 0;
  const hx = cw >> 1;
  const hy = ch >> 1;
  dots.fill(0);
  let wl = 0, yl = 0, wr = 0, yr = 0, wt = 0, xt = 0, wb = 0, xb = 0;
  for (let y = 0; y < ch; y++) {
    const r = Math.min(3, Math.floor((y * 4) / ch));
    for (let x = 0; x < cw; x++) {
      const c = x < hx ? 0 : 1;
      dots[8 + c * 4 + r]++;
      const w = share[bin[y * cw + x]];
      if (!w) continue;
      dots[c * 4 + r] += w;
      if (c === 0) { wl += w; yl += w * y; } else { wr += w; yr += w * y; }
      if (y < hy) { wt += w; xt += w * x; } else { wb += w; xb += w * x; }
    }
  }
  // A line keeps its thickness along its length; a gap between rounded
  // tiles widens at their corners, and a shape's edge grows.
  const even = (counts, len) => {
    let lo = Infinity;
    let hi = 0;
    for (let i = 0; i < len; i++) {
      if (!counts[i]) continue;
      if (counts[i] < lo) lo = counts[i];
      if (counts[i] > hi) hi = counts[i];
    }
    return hi - lo <= 2;
  };
  // Where two gaps meet (a vertical one into a horizontal one), one of them
  // runs straight through the whole cell: a junction, not a line.
  for (let x = 0; x < cw; x++) if (across && colSoft[x] >= ch - 2) return 0;
  for (let y = 0; y < ch; y++) if (down && rowSoft[y] >= cw - 1) return 0;
  const slant =
    (across && wl && wr && Math.abs(yl / wl - yr / wr) >= 0.75) ||
    (down && !across && wt && wb && Math.abs(xt / wt - xb / wb) >= 0.75 && even(rowSoft, ch)) ||
    (across && rows >= 2 * thick + 3) || // zig-zag up and down within the cell
    (down && !across && cols >= 2 * thick + 2 && even(rowSoft, ch));
  return slant ? dotsOf(dots) : 0;
}

// ---------------------------------------------------------------- photo palettes
//
// Claude Code draws a Raster's colours at 4 bits a channel (multiples of 17)
// and keeps up to 1024 colour pairs per Raster. A new pair costs a token from
// a bucket the whole session shares (4096, refilled at 160 a second; once a
// Raster's slots are full, spent only above 1024). Animation whose pairs keep
// changing drains it, and a starved pair is drawn as the nearest held one:
// patches of wrong colour. So photo cells take their colours from a small
// palette per view that changes slowly. The pairs it can make are a closed
// set, admitted once, and a mirror of the painter draws a cell flat rather
// than ask for a pair the bucket can't pay for.

const STEP = 17;
const level = (v) => {
  const q = Math.round(v / STEP);
  return q < 0 ? 0 : q > 15 ? 15 : q;
};
const latticeOf = (r, g, b) => (level(r) << 8) | (level(g) << 4) | level(b);
const latticeColor = (i) => ((((i >> 8) & 15) * STEP) << 16) | ((((i >> 4) & 15) * STEP) << 8) | ((i & 15) * STEP);
// Oklab's lightness with Ottosson's toe (as in Okhsl): plain Oklab puts
// near-black far from black, so (2,2,2) would match dark red over black.
const TOE_K1 = 0.206;
const TOE_K2 = 0.03;
const TOE_K3 = (1 + TOE_K1) / (1 + TOE_K2);
const toe = (x) => 0.5 * (TOE_K3 * x - TOE_K1 + Math.sqrt((TOE_K3 * x - TOE_K1) ** 2 + 4 * TOE_K2 * TOE_K3 * x));
let oklabTable = null;
function oklabOf() {
  if (oklabTable) return oklabTable;
  oklabTable = new Float32Array(4096 * 3);
  for (let i = 0; i < 4096; i++) {
    const R = LIN[((i >> 8) & 15) * STEP];
    const G = LIN[((i >> 4) & 15) * STEP];
    const B = LIN[(i & 15) * STEP];
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    oklabTable[i * 3] = toe(0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s);
    oklabTable[i * 3 + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    oklabTable[i * 3 + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  }
  return oklabTable;
}
/** Oklab of an sRGB colour with fractional channels (a partition's mean). */
function okOfSrgb(r, g, b) {
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    toe(0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s),
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const okDist = (ok, i, j) =>
  (ok[i * 3] - ok[j * 3]) ** 2 + (ok[i * 3 + 1] - ok[j * 3 + 1]) ** 2 + (ok[i * 3 + 2] - ok[j * 3 + 2]) ** 2;

// 48 colours: about 15 new pairs a frame at most once warm, inside the
// bucket's refill at 10 frames a second.
const PALETTE_SIZE = 48;
const PALETTE_DECAY = 0.85;
const PALETTE_EVERY = 10;

function newPalette() {
  return { hist: new Float32Array(4096), centers: null, rgb: null, ok: null, near: null, frames: 0 };
}

/**
 * k-means in Oklab over the decayed histogram of lattice colours (square-root
 * weights, so a large dark background doesn't take every colour), black
 * pinned, topped up to PALETTE_SIZE by weighted farthest points.
 */
function updatePalette(pal, iters) {
  const ok = oklabOf();
  const pts = [];
  const wts = [];
  for (let i = 0; i < 4096; i++) {
    if (pal.hist[i] > 0.5) {
      pts.push(i);
      wts.push(Math.sqrt(pal.hist[i]));
    }
  }
  if (!pts.length) {
    pts.push(0);
    wts.push(1);
  }
  const topUp = (centers) => {
    const minD = pts.map((p) => Math.min(...centers.map((c) => okDist(ok, p, c))));
    while (centers.length < Math.min(PALETTE_SIZE, pts.length + 1)) {
      let best = -1;
      let bestV = 0;
      for (let k = 0; k < pts.length; k++) {
        const v = wts[k] * minD[k];
        if (v > bestV) {
          bestV = v;
          best = k;
        }
      }
      if (best < 0) break;
      const c = pts[best];
      centers.push(c);
      for (let k = 0; k < pts.length; k++) minD[k] = Math.min(minD[k], okDist(ok, pts[k], c));
    }
    return centers;
  };
  let centers = topUp(pal.centers ? [...pal.centers] : [0]);
  for (let it = 0; it < iters; it++) {
    const acc = centers.map(() => [0, 0, 0, 0]);
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      let j = 0;
      let bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const dd = okDist(ok, p, centers[c]);
        if (dd < bd) {
          bd = dd;
          j = c;
        }
      }
      acc[j][0] += wts[k] * ok[p * 3];
      acc[j][1] += wts[k] * ok[p * 3 + 1];
      acc[j][2] += wts[k] * ok[p * 3 + 2];
      acc[j][3] += wts[k];
    }
    for (let c = 1; c < centers.length; c++) {
      const [L, A, B, w] = acc[c];
      if (w <= 0) continue;
      let bestP = centers[c];
      let bd = Infinity;
      for (let i = 0; i < 4096; i++) {
        const dd = (ok[i * 3] - L / w) ** 2 + (ok[i * 3 + 1] - A / w) ** 2 + (ok[i * 3 + 2] - B / w) ** 2;
        if (dd < bd) {
          bd = dd;
          bestP = i;
        }
      }
      centers[c] = bestP;
    }
    centers = topUp([...new Set(centers)]);
  }
  pal.centers = centers;
  pal.rgb = new Float32Array(centers.length * 3);
  pal.ok = new Float32Array(centers.length * 3);
  pal.near = new Int16Array(1 << 18).fill(-1);
  centers.forEach((c, k) => {
    pal.rgb[k * 3] = ((c >> 8) & 15) * STEP;
    pal.rgb[k * 3 + 1] = ((c >> 4) & 15) * STEP;
    pal.rgb[k * 3 + 2] = (c & 15) * STEP;
    pal.ok[k * 3] = ok[c * 3];
    pal.ok[k * 3 + 1] = ok[c * 3 + 1];
    pal.ok[k * 3 + 2] = ok[c * 3 + 2];
  });
}

// Photo glyphs: one per partition of the cell, each with a complement, so a
// pair is always stored one way round (the lower colour value as fg). The 14
// quadrant shapes are 7 partitions, and ▇/▔ and ▉/▕ two more.
const photoCache = new Map();
function photoPartitions(cw, ch, sextants = false) {
  const key = `${cw}x${ch}x${sextants}`;
  if (photoCache.has(key)) return photoCache.get(key);
  const { all } = candidates(cw, ch);
  const out = [];
  all.forEach((cand, k) => {
    if (cand.kind === 3 ? sextants && cand.mask < 32 : cand.kind === 0 ? cand.mask <= 7 : cand.ch === "▇" || cand.ch === "▉") out.push(k);
  });
  photoCache.set(key, out);
  return out;
}

/**
 * A photo cell: of the cell's 9 partitions (or flat), the one whose two
 * palette colours fit best: for a partition, each side takes the palette
 * colour nearest its mean (not rounded first: rounding loses the dark
 * shades gradients are made of). Returns palette indices; `prev` is the
 * partition the cell had last frame.
 */
const PHOTO_TOP = 8;
const photoScratch = { J: new Float64Array(64), top: new Int32Array(PHOTO_TOP) };

function fitPhoto(img, x0, y0, cw, ch, prm, prev, pal, sextants = false) {
  const s = gather(img, x0, y0, cw, ch, prm.weights);
  const { all: list } = candidates(cw, ch);
  const { T, n, sf } = s;
  const [w0, w1, w2] = s.w;
  const { rgb, ok } = pal;
  const K = pal.centers.length;
  // The nearest palette colour by eye (Oklab), so a dark blue-grey doesn't
  // go teal; its error is then weighed as the fit weighs pixels.
  // Nearest palette colour per 6-bit-a-channel bin, found once per palette.
  const near = pal.near;
  const pick = (m0, m1, m2) => {
    const bin = ((m0 >> 2) << 12) | ((m1 >> 2) << 6) | (m2 >> 2);
    let j = near[bin];
    if (j < 0) {
      const [L, A, B] = okOfSrgb((m0 & ~3) + 2, (m1 & ~3) + 2, (m2 & ~3) + 2);
      let d = Infinity;
      for (let k = 0; k < K; k++) {
        const dd = (L - ok[k * 3]) ** 2 + (A - ok[k * 3 + 1]) ** 2 + (B - ok[k * 3 + 2]) ** 2;
        if (dd < d) {
          d = dd;
          j = k;
        }
      }
      near[bin] = j;
    }
    const e = w0 * (m0 - rgb[j * 3]) ** 2 + w1 * (m1 - rgb[j * 3 + 1]) ** 2 + w2 * (m2 - rgb[j * 3 + 2]) ** 2;
    return [j, e];
  };
  const flatJ = (w0 * T[0] * T[0] + w1 * T[1] * T[1] + w2 * T[2] * T[2]) / n;
  const [flatIdx, flatE] = pick(T[0] / n, T[1] / n, T[2] / n);
  const flatScore = flatJ - n * flatE;
  let best = -1;
  let bestScore = flatScore;
  let bestF = flatIdx;
  let bestB = flatIdx;
  let prevScore = -Infinity;
  let prevF = 0;
  let prevB = 0;
  let freeBest = -1;
  let freeBestJ = flatJ;
  // Every partition's fit with free colours is a few sums; matching both
  // sides to the palette costs more, so only the best few (and last frame's
  // partition) are matched.
  const parts = photoPartitions(cw, ch, sextants);
  const freeJ = photoScratch.J;
  const top = photoScratch.top;
  let tops = 0;
  for (let i = 0; i < parts.length; i++) {
    const J = fitOf(s, list[parts[i]]);
    freeJ[i] = J;
    if (J > freeBestJ) {
      freeBestJ = J;
      freeBest = parts[i];
    }
    // Keep the PHOTO_TOP best indices, best first.
    let at = tops < PHOTO_TOP ? tops++ : PHOTO_TOP;
    while (at > 0 && freeJ[top[at - 1]] < J) {
      if (at < PHOTO_TOP) top[at] = top[at - 1];
      at--;
    }
    if (at < PHOTO_TOP) top[at] = i;
  }
  const prevAt = prev >= 0 ? parts.indexOf(prev) : -1;
  let prevIn = false;
  for (let t = 0; t <= tops; t++) {
    const i = t < tops ? top[t] : prevAt;
    if (i < 0 || (t === tops && prevIn)) continue;
    const k = parts[i];
    if (k === prev) prevIn = true;
    const cand = list[k];
    const J = fitOf(s, cand);
    const nf = cand.nf;
    const nb = n - nf;
    const [jf, ef] = pick(sf[0] / nf, sf[1] / nf, sf[2] / nf);
    const [jb, eb] = pick((T[0] - sf[0]) / nb, (T[1] - sf[1]) / nb, (T[2] - sf[2]) / nb);
    if (jf === jb) continue;
    const score = J - nf * ef - nb * eb;
    if (k === prev) {
      prevScore = score;
      prevF = jf;
      prevB = jb;
    }
    if (score > bestScore) {
      bestScore = score;
      best = k;
      bestF = jf;
      bestB = jb;
    }
  }
  if (prev >= 0 && prevScore - flatScore >= KEEP * (bestScore - flatScore)) {
    best = prev;
    bestScore = prevScore;
    bestF = prevF;
    bestB = prevB;
  }
  const threshold = prev >= 0 ? DROP * prm.minGain : prm.minGain;
  if (best >= 0 && (bestScore - flatScore) / n < threshold) best = -1;
  // What the palette should learn from: the free fit's two means.
  if (freeBest >= 0) {
    const cand = list[freeBest];
    fitOf(s, cand);
    const nf = cand.nf;
    const nb = n - nf;
    pal.hist[latticeOf(sf[0] / nf, sf[1] / nf, sf[2] / nf)] += nf;
    pal.hist[latticeOf((T[0] - sf[0]) / nb, (T[1] - sf[1]) / nb, (T[2] - sf[2]) / nb)] += nb;
  } else {
    pal.hist[latticeOf(T[0] / n, T[1] / n, T[2] / n)] += n;
  }
  if (best < 0) return { index: -1, fg: flatIdx, bg: flatIdx, flat: flatIdx, gain: 0 };
  return { index: best, fg: bestF, bg: bestB, flat: flatIdx, gain: bestScore - flatScore };
}

// The painter's admission bucket is the session's: one per helper.
const bucket = { tokens: 4096, at: null };
const MAX_NEW_PER_FRAME = 24;
const RESERVE = 1100;

/** A pair as Claude Code keys it: both colours at 4 bits, default apart. */
function pairKey(fg, bg) {
  const k = (c) => (c < 0 ? 4096 : latticeOf((c >> 16) & 255, (c >> 8) & 255, c & 255));
  return k(fg) * 8192 + k(bg);
}

const pack = (r, g, b) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);

/**
 * Whether a 2D canvas is fitted as a photo. One mostly filled with colour (an
 * area chart, a drawing, a rendered page) is shaded better as a photo: UI
 * fitting broke a stacked area chart's curves and faint gridlines into stray
 * blocks. A sparse one (a line chart, a sparkline) stays UI, whose Braille
 * lines suit it. The share of its pixels that differ clearly from its most
 * common colour decides, with a gap (in at DENSE_IN, out under DENSE_OUT,
 * remembered in `painter`) so a chart near the line doesn't switch each frame.
 */
const DENSE_IN = 0.25;
const DENSE_OUT = 0.15;
export function canvasIsPhoto(img, rect, painter) {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(img.width, Math.round(rect.x + rect.w));
  const y1 = Math.min(img.height, Math.round(rect.y + rect.h));
  if (x1 - x0 < 8 || y1 - y0 < 8) return false;
  const d = img.data;
  const counts = new Map();
  let samples = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * img.width + x) * 4;
      const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
      counts.set(k, (counts.get(k) ?? 0) + 1);
      samples++;
    }
  }
  let mode = 0;
  let most = -1;
  for (const [k, n] of counts) if (n > most) [mode, most] = [k, n];
  const br = ((mode >> 10) & 31) * 8 + 4;
  const bgc = ((mode >> 5) & 31) * 8 + 4;
  const bb = (mode & 31) * 8 + 4;
  let differ = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * img.width + x) * 4;
      if (Math.abs(d[i] - br) + Math.abs(d[i + 1] - bgc) + Math.abs(d[i + 2] - bb) > 36) differ++;
    }
  }
  const share = differ / samples;
  const key = `${x0},${y0},${x1 - x0},${y1 - y0}`;
  const was = painter?.denseCanvases?.[key];
  const dense = was ? share >= DENSE_OUT : share >= DENSE_IN;
  if (painter) (painter.denseCanvases ??= {})[key] = dense;
  return dense;
}

/**
 * @param {{width:number,height:number,data:Uint8Array}} img RGBA pixels
 * @param {Array<TextLine>} texts lines reported by the page (page pixels)
 * @param {{cols:number, rows:number, cellWidth:number, cellHeight:number,
 *          pageBackground:number, photos?: Array<{x:number,y:number,w:number,h:number}>,
 *          memory?: {key?: string, glyphs?: Int16Array}, halfBlocks?:boolean}} opts
 *   `photos`: boxes (page pixels) of WebGL canvases, images and videos, and of
 *   2D canvases (`canvas2d: true`), which are photos only when densely filled
 *   (see canvasIsPhoto).
 *   `memory`: kept by the caller between frames of one view; holds each
 *   cell's glyph so photo cells change glyph only for a clearly better one.
 *   `sextants`: photo cells may also use the 2 x 3 sextant shapes (U+1FB00),
 *   for terminals known to draw them.
 */
export function composeFrame(img, texts, opts) {
  const { cols, rows, cellWidth: cw, cellHeight: ch, pageBackground } = opts;
  const halfBlocks = opts.halfBlocks ?? true;
  const photos = (opts.photos ?? []).filter((p) => !p.canvas2d || canvasIsPhoto(img, p, opts.painter));
  const memory = opts.memory;
  const key = `${cols}x${rows}x${cw}x${ch}x${pageBackground}`;
  let previous = null;
  if (memory) {
    if (memory.key === key && memory.glyphs) previous = memory.glyphs;
    else memory.ui = null;
    memory.key = key;
    memory.glyphs = new Int16Array(cols * rows).fill(-2);
  }
  // UI cells hold still: each remembers the pixels it was last fitted from
  // and what it became, and is fitted again only once its pixels have moved
  // from those by more than UI_STILL on average (or a few of them by a lot:
  // a faint line arriving or leaving). An animating chart then
  // changes only where it really changed, instead of edges twitching between
  // near-equal glyphs on anti-aliasing noise. (Measured from the remembered
  // pixels, not the last frame, so a slow drift still gets through.)
  const still = memory
    ? (memory.ui ??= {
        ref: new Uint8Array(cols * rows * cw * ch * 3),
        ch: new Uint16Array(cols * rows),
        fg: new Int32Array(cols * rows),
        bg: new Int32Array(cols * rows),
      })
    : null;
  const uiFit = (c, r) => {
    const x0 = c * cw;
    const y0 = r * ch;
    const at = r * cols + c;
    if (!still) return uiCell(fitUi(img, x0, y0, cw, ch) ?? fitCell(img, x0, y0, cw, ch, UI));
    const ref = still.ref;
    const base = at * cw * ch * 3;
    const limit = still.ch[at] ? UI_STILL * cw * ch * 3 : -1;
    const d = img.data;
    let moved = 0;
    let pixels = 0;
    for (let y = 0, o = base; y < ch && moved <= limit && pixels < UI_STILL_PIXELS; y++) {
      const py = y0 + y < img.height ? y0 + y : img.height - 1;
      for (let x = 0; x < cw; x++, o += 3) {
        const i = (py * img.width + (x0 + x < img.width ? x0 + x : img.width - 1)) * 4;
        const delta = Math.abs(d[i] - ref[o]) + Math.abs(d[i + 1] - ref[o + 1]) + Math.abs(d[i + 2] - ref[o + 2]);
        moved += delta;
        if (delta >= UI_STILL_DELTA) pixels++;
      }
    }
    if (moved <= limit && pixels < UI_STILL_PIXELS) return { ch: String.fromCharCode(still.ch[at]), fg: still.fg[at], bg: still.bg[at], flags: 0 };
    uiScratch.prev = still.ch[at];
    const cell = uiCell(fitUi(img, x0, y0, cw, ch) ?? fitCell(img, x0, y0, cw, ch, UI));
    uiScratch.prev = 0;
    for (let y = 0, o = base; y < ch; y++) {
      const py = y0 + y < img.height ? y0 + y : img.height - 1;
      for (let x = 0; x < cw; x++, o += 3) {
        const i = (py * img.width + (x0 + x < img.width ? x0 + x : img.width - 1)) * 4;
        ref[o] = d[i];
        ref[o + 1] = d[i + 1];
        ref[o + 2] = d[i + 2];
      }
    }
    still.ch[at] = cell.ch.charCodeAt(0);
    still.fg[at] = cell.fg;
    still.bg[at] = cell.bg;
    return cell;
  };
  const quant = (c, prm = UI) => (c < 0 ? c : quantize(c, prm.step));
  const toTerminal = (c, prm = UI) => (near(c, pageBackground, prm.bgTol) ? -1 : quant(c, prm));
  const isPhoto = (c, r) => {
    const x = (c + 0.5) * cw;
    const y = (r + 0.5) * ch;
    return photos.some((p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
  };
  // A dense 2D canvas fitted as a photo (a chart) keeps no glyph memory: it
  // doesn't shimmer as a 3D scene does, and kept shapes left a trail where a
  // tooltip had slid across its bands.
  const flatPhotos = photos.filter((p) => p.canvas2d);
  const isFlatPhoto = (c, r) => {
    if (!flatPhotos.length) return false;
    const x = (c + 0.5) * cw;
    const y = (r + 0.5) * ch;
    return flatPhotos.some((p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
  };

  const uiCell = (fit) => {
    if (fit.alt !== undefined) {
      const cell = uiCell({ ...fit, alt: undefined });
      cell.alt = fit.alt ? uiCell(fit.alt) : { ch: " ", fg: -1, bg: toTerminal(fit.bg), flags: 0 };
      return cell;
    }
    const cand = fit.index >= 0 ? list[fit.index] : null;
    let glyph = fit.glyph ?? (cand ? cand.ch : " ");
    let fg = toTerminal(fit.fg);
    let bg = toTerminal(fit.bg);
    // One spelling for a line on the top or right edge (▇ and ▉ with the
    // colours swapped draw the same thing): one colour pair, and the line
    // pass below sees one glyph.
    if (glyph === "▇" || glyph === "▉") {
      glyph = glyph === "▇" ? "▔" : "▕";
      [fg, bg] = [bg, fg];
    }
    // The page background is best drawn as the terminal's own: keep it on
    // the background side, where "no colour" means the default.
    if (fg === -1 && bg !== -1) {
      if (cand?.complement) {
        glyph = cand.complement;
        [fg, bg] = [bg, fg];
      } else {
        fg = quant(fit.fg);
      }
    }
    if (glyph === " " || fg === bg || (fg >= 0 && bg >= 0 && near(fg, bg, UI.nearTol))) {
      // Flat, or two colours too close to tell apart: the cell's main colour.
      return { ch: " ", fg: -1, bg: toTerminal(fit.mean), flags: 0 };
    }
    return { ch: glyph, fg, bg, flags: 0 };
  };

  /** @type {{ch:string, fg:number, bg:number, flags:number, photo?:{gain:number, flat:number}}[]} */
  const cells = new Array(cols * rows);
  const { list, all } = candidates(cw, ch);
  const sextants = Boolean(opts.sextants);
  const painter = opts.painter ?? {};
  let pal = null;
  // Full colour (`opts.truecolor`, drawn as styled text, not a Raster): photo
  // cells take free colours, with no palette and no pair budget to keep.
  const truecolor = Boolean(opts.truecolor);
  if (photos.length && !truecolor) {
    pal = painter.palette ??= newPalette();
    for (let i = 0; i < 4096; i++) pal.hist[i] *= PALETTE_DECAY;
    if (!pal.centers) {
      // First frame: learn the colours before fitting with them.
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (!isPhoto(c, r)) continue;
          const s = gather(img, c * cw, r * ch, cw, ch, PHOTO.weights);
          let best = -1;
          let bestJ = -Infinity;
          for (const k of photoPartitions(cw, ch, sextants)) {
            const J = fitOf(s, all[k]);
            if (J > bestJ) {
              bestJ = J;
              best = k;
            }
          }
          const cand = all[best];
          fitOf(s, cand);
          const nb = s.n - cand.nf;
          pal.hist[latticeOf(s.sf[0] / cand.nf, s.sf[1] / cand.nf, s.sf[2] / cand.nf)] += cand.nf;
          pal.hist[latticeOf((s.T[0] - s.sf[0]) / nb, (s.T[1] - s.sf[1]) / nb, (s.T[2] - s.sf[2]) / nb)] += nb;
        }
      }
      updatePalette(pal, 8);
    } else if (pal.frames % PALETTE_EVERY === 0) {
      updatePalette(pal, 2);
    }
    pal.frames++;
  }
  const paletteColor = (j) => latticeColor(pal.centers[j]);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = c * cw;
      const y0 = r * ch;
      if (!halfBlocks) {
        const bg = toTerminal(average(img, x0, y0, cw, ch));
        cells[r * cols + c] = { ch: " ", fg: -1, bg, flags: 0 };
        continue;
      }
      const prm = photos.length && isPhoto(c, r) ? PHOTO : UI;
      if (prm.photo && truecolor) {
        const s = gather(img, x0, y0, cw, ch, PHOTO.weights);
        const fit = fitGathered(s, cw, ch, PHOTO);
        const prev = previous && !isFlatPhoto(c, r) ? previous[r * cols + c] : -2;
        // Glyph hysteresis as in palette cells: keep last frame's shape unless clearly worse.
        let index = fit.index;
        if (prev >= 0 && prev !== index) {
          const keep = fitOf(s, list[prev]);
          const best = index >= 0 ? fitOf(s, list[index]) : 0;
          if (index < 0 || keep >= KEEP * best) index = prev;
        }
        if (memory) memory.glyphs[r * cols + c] = index;
        if (index < 0) {
          cells[r * cols + c] = { ch: " ", fg: -1, bg: fit.mean, flags: 0 };
          continue;
        }
        if (index === fit.index) {
          cells[r * cols + c] = { ch: list[index].ch, fg: fit.fg, bg: fit.bg, flags: 0 };
          continue;
        }
        const cand = list[index];
        fitOf(s, cand);
        const nb = s.n - cand.nf;
        const fg = pack(s.sf[0] / cand.nf, s.sf[1] / cand.nf, s.sf[2] / cand.nf);
        const bg = pack((s.T[0] - s.sf[0]) / nb, (s.T[1] - s.sf[1]) / nb, (s.T[2] - s.sf[2]) / nb);
        cells[r * cols + c] = { ch: cand.ch, fg, bg, flags: 0 };
        continue;
      }
      if (prm.photo) {
        const prev = previous && !isFlatPhoto(c, r) ? previous[r * cols + c] : -2;
        const fit = fitPhoto(img, x0, y0, cw, ch, prm, prev, pal, sextants);
        if (memory) memory.glyphs[r * cols + c] = fit.index;
        if (fit.index < 0) {
          cells[r * cols + c] = { ch: " ", fg: -1, bg: paletteColor(fit.flat), flags: 0 };
          continue;
        }
        let glyph = all[fit.index].ch;
        let fgIndex = fit.fg;
        let bgIndex = fit.bg;
        if (pal.centers[fgIndex] > pal.centers[bgIndex]) {
          glyph = all[fit.index].complement;
          [fgIndex, bgIndex] = [bgIndex, fgIndex];
        }
        cells[r * cols + c] = {
          ch: glyph,
          fg: paletteColor(fgIndex),
          bg: paletteColor(bgIndex),
          flags: 0,
          photo: { gain: fit.gain, flat: paletteColor(fit.flat) },
        };
        continue;
      }
      cells[r * cols + c] = uiFit(c, r);
    }
  }

  // A thin line that sits between two levels can come out ▁━▁▁━▁ along a
  // row. One or two cells out of step with the same line on both sides of
  // them take its level, so the line steps once where it changes level.
  const level = (cell) => (cell.ch === "▔" ? 0 : cell.ch === "━" ? 1 : cell.ch === "▁" ? 2 : -1);
  for (let r = 0; r < rows; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const before = cells[r * cols + c - 1];
      const lv = level(before);
      if (lv < 0) continue;
      for (let run = 1; run <= 2 && c + run < cols; run++) {
        const after = cells[r * cols + c + run];
        if (level(after) !== lv || after.fg !== before.fg || after.bg !== before.bg) continue;
        let odd = true;
        for (let k = 0; k < run; k++) {
          const cell = cells[r * cols + c + k];
          if (level(cell) < 0 || level(cell) === lv || cell.fg !== before.fg || cell.bg !== before.bg) odd = false;
        }
        if (odd) for (let k = 0; k < run; k++) cells[r * cols + c + k].ch = before.ch;
        break;
      }
    }
  }

  // A Braille cell is part of a line only with another beside it (above,
  // below, either side or diagonally) in the same colour; alone, it is a
  // rounded corner or an edge, and goes back to its block fit (also for the
  // frames it holds still).
  const isBraille = (cell) => cell.ch >= "\u2801" && cell.ch <= "\u28ff";
  const lone = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r * cols + c];
      if (cell.photo || !isBraille(cell)) continue;
      let joined = false;
      for (let dr = -1; dr <= 1 && !joined; dr++) {
        for (let dc = -1; dc <= 1 && !joined; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if ((dr || dc) && rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
            const other = cells[rr * cols + cc];
            joined = isBraille(other) && other.fg === cell.fg;
          }
        }
      }
      if (!joined) lone.push(r * cols + c);
    }
  }
  for (const at of lone) {
    const back = cells[at].alt ?? { ch: " ", fg: -1, bg: cells[at].bg, flags: 0 };
    cells[at] = back;
    if (still) {
      still.ch[at] = back.ch.charCodeAt(0);
      still.fg[at] = back.fg;
      still.bg[at] = back.bg;
    }
  }

  // Clear the whole box each line of text covers first: glyphs are taller
  // and, in a proportional font, wider than the characters drawn for them,
  // and their pixels would otherwise show as blocks around the text.
  const boxOf = (line) => ({
    r0: Math.max(0, Math.floor(line.top / ch)),
    r1: Math.min(rows - 1, Math.floor((line.bottom - 1) / ch)),
    c0: Math.max(0, Math.floor(line.x / cw)),
    c1: Math.min(cols, Math.ceil(line.right / cw)),
  });
  const covering = new Uint8Array(cols * rows);
  for (const line of texts) {
    if (line.top == null || line.right == null) continue;
    const { r0, r1, c0, c1 } = boxOf(line);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c < c1; c++) if (covering[r * cols + c] < 2) covering[r * cols + c]++;
    }
  }
  for (const line of texts) {
    if (line.top == null || line.right == null) continue;
    const { r0, r1, c0, c1 } = boxOf(line);
    const ink = parseCssColor(line.color).rgb;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c < c1; c++) {
        // The cell again without the text's own pixels, so a tile edge or a
        // gap under the label keeps its shape; flat when that can't be told.
        // (Two lines over one cell: two inks, so no telling; flat.)
        const fit =
          covering[r * cols + c] > 1
            ? null
            : fitUi(img, c * cw, r * ch, cw, ch, ink, Math.floor(line.top) - r * ch, Math.ceil(line.bottom) - r * ch);
        cells[r * cols + c] = fit
          ? uiCell(fit)
          : { ch: " ", fg: -1, bg: toTerminal(dominant(img, c * cw, r * ch, cw, ch)), flags: 0 };
      }
    }
  }

  // The end of a bar (a slider's track, the bottom edge of a badge) often
  // falls part way into a cell, which then fits a thinner bar or a corner
  // notch: the run's last cell takes the run's shape instead, when nothing
  // in the same colours continues past it.
  // (Either way round: a bar on the top edge is a lower bar with the colours swapped.)
  const sameColours = (a, b) => (a.fg === b.fg && a.bg === b.bg) || (a.fg === b.bg && a.bg === b.fg);
  for (let r = 0; r < rows; r++) {
    const at = (c) => cells[r * cols + c];
    for (let c = 0; c < cols; c++) {
      const cell = at(c);
      if (!BARS.has(cell.ch) || cell.photo) continue;
      let end = c;
      while (end + 1 < cols && at(end + 1).ch === cell.ch && at(end + 1).fg === cell.fg && at(end + 1).bg === cell.bg) end++;
      if (end - c >= 1) {
        for (const [cap, beyond] of [[end + 1, end + 2], [c - 1, c - 2]]) {
          if (cap < 0 || cap >= cols) continue;
          const tail = at(cap);
          if (tail.ch === cell.ch || !sameColours(tail, cell) || !(BARS.has(tail.ch) || CORNERS.has(tail.ch))) continue;
          const past = beyond >= 0 && beyond < cols ? at(beyond) : null;
          if (past && sameColours(past, cell) && (BARS.has(past.ch) || CORNERS.has(past.ch))) continue;
          tail.ch = cell.ch;
          tail.fg = cell.fg;
          tail.bg = cell.bg;
        }
      }
      c = end;
    }
  }

  // Two short lines stacked closer than two terminal rows (a label over a
  // count) can land on the same row. A line whose cells are already text
  // goes to the nearer neighbouring row when that one is free.
  const isText = new Uint8Array(cols * rows);
  const isFree = (row, from, to) => {
    if (row < 0 || row >= rows) return false;
    for (let c = Math.max(0, from); c < Math.min(cols, to); c++) {
      if (isText[row * cols + c]) return false;
    }
    return true;
  };
  for (const line of texts) {
    const exact = line.cy / ch;
    const home = Math.floor(exact);
    if (home < 0 || home >= rows) continue;
    let col = Math.round(line.x / cw);
    const limit = Math.min(
      cols,
      line.maxX != null ? Math.floor(line.maxX / cw) : cols,
    );
    const chars = [...line.t];
    if (line.caret != null && line.caret >= chars.length) chars.push(" ");
    const end = Math.min(limit, col + chars.length);
    const near = exact - home < 0.5 ? home - 1 : home + 1;
    const far = near === home - 1 ? home + 1 : home - 1;
    let row = home;
    if (!isFree(home, col, end)) {
      // In a terminal font a label is wider than on the page, so the next
      // item of a legend starts under its tail: move that a few cells right
      // (one clear of the label) before trying another row, which would put
      // it among some other row's text.
      // A line cut off at the view's edge anyway (a long log entry) shifts too:
      // on another row it would read as the line above's.
      let shifted = col;
      while (shifted - col <= 6 && !isFree(home, shifted - 1, shifted + chars.length)) shifted++;
      const clipped = col + chars.length > limit;
      if (shifted - col <= 6 && (shifted + chars.length <= limit || (clipped && shifted < limit))) {
        col = shifted;
      } else {
        row = [near, far].find((r) => isFree(r, col, end)) ?? home;
      }
    }
    const placedEnd = Math.min(limit, col + chars.length);
    for (let c = Math.max(0, col); c < placedEnd; c++) isText[row * cols + c] = 1;
    for (let i = 0; i < chars.length && col < limit; i++, col++) {
      if (col < 0) continue;
      const cell = cells[row * cols + col];
      const bgPixel = dominant(img, col * cw, row * ch, cw, ch);
      const bg = toTerminal(bgPixel);
      const fg = quant(blend(parseCssColor(line.color), bgPixel));
      let flags = 0;
      if (line.bold) flags |= BOLD;
      if (line.dim) flags |= DIM;
      if (line.caret === i || line.inverse) flags |= INVERSE;
      cell.ch = singleWidth(chars[i]);
      cell.fg = fg;
      cell.bg = bg;
      cell.flags = flags;
    }
  }

  if (photos.length && !truecolor) admitPairs(cells, painter, opts.now ?? Date.now());
  return { cols, rows, cells: opts.raster === false ? undefined : packRaster(cells), lines: opts.lines ? toRuns(cells, cols, rows) : undefined };
}

/**
 * Keeps photo cells within what Claude Code's painter will admit this frame
 * (see "photo palettes"): mirrors its 1024 pair slots (least recently painted
 * out first) and the session's token bucket. Pairs it already holds are free;
 * new UI and flat pairs go first; photo glyph cells then get new pairs in
 * order of how much they gain over flat, within a per-frame allowance, and
 * the rest are drawn flat. Blockier for a frame or two, never wrong colours.
 */
function admitPairs(cells, painter, now) {
  const held = (painter.held ??= new Map());
  painter.paint = (painter.paint ?? 0) + 1;
  const paint = painter.paint;
  if (bucket.at === null) bucket.at = now;
  bucket.tokens = Math.min(4096, bucket.tokens + (Math.max(0, now - bucket.at) * 160) / 1000);
  bucket.at = now;
  const keyOf = (cell) => pairKey(cell.ch === " " ? -1 : cell.fg, cell.bg);
  const used = new Set();
  const admit = (k) => {
    if (held.size >= 1024) {
      let oldest = null;
      let oldestPaint = Infinity;
      for (const [key, last] of held) {
        if (last < paint && last < oldestPaint && !used.has(key)) {
          oldest = key;
          oldestPaint = last;
        }
      }
      if (oldest !== null) held.delete(oldest);
    }
    bucket.tokens -= 1;
    held.set(k, paint);
  };
  const wants = [];
  cells.forEach((cell, i) => {
    const k = keyOf(cell);
    if (held.has(k) || used.has(k)) {
      used.add(k);
      held.set(k, paint);
      return;
    }
    if (cell.photo) {
      wants.push(i);
      return;
    }
    admit(k);
    used.add(k);
  });
  let allowance =
    held.size < 1024
      ? Math.min(1024 - held.size, Math.floor(bucket.tokens) - 64)
      : Math.min(MAX_NEW_PER_FRAME, Math.floor(bucket.tokens - RESERVE));
  wants.sort((a, b) => cells[b].photo.gain - cells[a].photo.gain);
  for (const i of wants) {
    const k = keyOf(cells[i]);
    if (held.has(k) || used.has(k)) {
      used.add(k);
      held.set(k, paint);
      continue;
    }
    if (allowance > 0) {
      admit(k);
      used.add(k);
      allowance--;
      continue;
    }
    cells[i] = { ch: " ", fg: -1, bg: cells[i].photo.flat, flags: 0 };
    const flatKey = keyOf(cells[i]);
    if (!held.has(flatKey) && !used.has(flatKey)) admit(flatKey);
    used.add(flatKey);
    held.set(flatKey, paint);
  }
}

const DEFAULT_COLOR = 0x01000000;

/**
 * The cells as a Claude Code Raster: little-endian u32 triplets [code point,
 * fg, bg], base64. A Raster has no bold or dim, so dim text is blended toward
 * its background and inverse (a caret, a focused dropdown) swaps the colours.
 */
function packRaster(cells) {
  const words = new Uint32Array(cells.length * 3);
  cells.forEach((cell, i) => {
    let fg = cell.fg;
    let bg = cell.bg;
    if (cell.flags & DIM && fg >= 0) fg = mix(fg, bg >= 0 ? bg : 0x202020);
    if (cell.flags & INVERSE) {
      [fg, bg] = [bg >= 0 ? bg : 0x161616, fg >= 0 ? fg : 0xe6e6e6];
    }
    words[i * 3] = cell.ch.codePointAt(0) ?? 32;
    words[i * 3 + 1] = fg >= 0 ? fg : DEFAULT_COLOR;
    words[i * 3 + 2] = bg >= 0 ? bg : DEFAULT_COLOR;
  });
  return Buffer.from(words.buffer).toString("base64");
}

function mix(a, b) {
  const m = (shift) => ((((a >> shift) & 255) + ((b >> shift) & 255)) >> 1) << shift;
  return m(16) | m(8) | m(0);
}

/** Runs of equal style per row, for the preview tool's ANSI output. */
function toRuns(cells, cols, rows) {
  const lines = [];
  for (let r = 0; r < rows; r++) {
    const runs = [];
    let run = null;
    for (let c = 0; c < cols; c++) {
      const cell = cells[r * cols + c];
      const fg = cell.ch === " " && !(cell.flags & INVERSE) ? -1 : cell.fg;
      if (run && run.fg === fg && run.bg === cell.bg && run.flags === cell.flags) {
        run.t += cell.ch;
      } else {
        run = { t: cell.ch, fg, bg: cell.bg, flags: cell.flags };
        runs.push(run);
      }
    }
    lines.push(runs.map((x) => [x.t, hex(x.fg), hex(x.bg), x.flags]));
  }
  return lines;
}

function average(img, x0, y0, w, h) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const x1 = Math.min(img.width, x0 + w);
  const y1 = Math.min(img.height, y0 + h);
  for (let y = Math.max(0, y0); y < y1; y++) {
    let i = (y * img.width + Math.max(0, x0)) * 4;
    for (let x = Math.max(0, x0); x < x1; x++, i += 4) {
      r += img.data[i];
      g += img.data[i + 1];
      b += img.data[i + 2];
      n++;
    }
  }
  if (n === 0) return 0;
  return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
}

/** The most common colour in a cell: its background, glyph pixels aside. */
function dominant(img, x0, y0, w, h) {
  const counts = new Map();
  const x1 = Math.min(img.width, x0 + w);
  const y1 = Math.min(img.height, y0 + h);
  for (let y = Math.max(0, y0); y < y1; y++) {
    let i = (y * img.width + Math.max(0, x0)) * 4;
    for (let x = Math.max(0, x0); x < x1; x++, i += 4) {
      const key =
        ((img.data[i] >> 4) << 8) | ((img.data[i + 1] >> 4) << 4) | (img.data[i + 2] >> 4);
      let entry = counts.get(key);
      if (!entry) counts.set(key, (entry = { n: 0, r: 0, g: 0, b: 0 }));
      entry.n++;
      entry.r += img.data[i];
      entry.g += img.data[i + 1];
      entry.b += img.data[i + 2];
    }
  }
  let best = null;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  if (!best) return 0;
  return (
    (Math.round(best.r / best.n) << 16) |
    (Math.round(best.g / best.n) << 8) |
    Math.round(best.b / best.n)
  );
}

function quantize(color, step) {
  if (step <= 1) return color;
  const q = (v) => Math.min(255, Math.round(v / step) * step);
  return (q((color >> 16) & 255) << 16) | (q((color >> 8) & 255) << 8) | q(color & 255);
}

function near(a, b, tolerance) {
  if (a < 0 || b < 0) return a === b;
  return (
    Math.abs(((a >> 16) & 255) - ((b >> 16) & 255)) <= tolerance &&
    Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) <= tolerance &&
    Math.abs((a & 255) - (b & 255)) <= tolerance
  );
}

function hex(color) {
  return color < 0 ? "" : `#${color.toString(16).padStart(6, "0")}`;
}

/** rgb(), rgba() and color(srgb ...) as Chrome reports computed colours. */
export function parseCssColor(css) {
  if (!css) return { rgb: 0xffffff, alpha: 1 };
  const h = css.trim().match(/^#([0-9a-f]{3,8})$/i);
  if (h) {
    let digits = h[1];
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join("");
    const n = parseInt(digits.slice(0, 6), 16);
    return { rgb: n, alpha: digits.length === 8 ? parseInt(digits.slice(6), 16) / 255 : 1 };
  }
  let m = css.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  if (m) {
    return {
      rgb: (Math.round(+m[1]) << 16) | (Math.round(+m[2]) << 8) | Math.round(+m[3]),
      alpha: m[4] != null ? +m[4] : 1,
    };
  }
  m = css.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
  if (m) {
    const to255 = (v) => Math.round(Math.min(1, Math.max(0, +v)) * 255);
    return {
      rgb: (to255(m[1]) << 16) | (to255(m[2]) << 8) | to255(m[3]),
      alpha: m[4] != null ? +m[4] : 1,
    };
  }
  return { rgb: 0xffffff, alpha: 1 };
}

function blend({ rgb, alpha }, under) {
  if (alpha >= 1) return rgb;
  const mix = (shift) =>
    Math.round(((rgb >> shift) & 255) * alpha + ((under >> shift) & 255) * (1 - alpha));
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

/**
 * One printable, single-width BMP character per cell, as a Raster requires:
 * wide characters (CJK, emoji) become "?", marks and format characters " ".
 */
function singleWidth(ch) {
  const code = ch.codePointAt(0) ?? 32;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return " ";
  if (/[\p{M}\p{Cf}]/u.test(ch)) return " ";
  if (code > 0xffff) return "?";
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return "?";
  }
  return ch;
}

/**
 * @typedef {object} TextLine
 * @property {number} x left edge of the first character, page pixels
 * @property {number} cy vertical centre of the line, page pixels
 * @property {string} t the characters, in order
 * @property {string} color computed CSS colour
 * @property {boolean} [bold]
 * @property {boolean} [dim]
 * @property {number} [top] top of the line's glyph boxes, page pixels
 * @property {number} [bottom] bottom of the line's glyph boxes
 * @property {number} [right] right edge of the last glyph
 * @property {number} [maxX] right edge past which nothing is drawn
 * @property {number} [caret] index of the caret within `t`
 * @property {boolean} [inverse] draw the whole line inverted (a focused select)
 * @property {string} [source] "canvas" for text a canvas drew
 */
