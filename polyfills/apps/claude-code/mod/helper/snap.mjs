// Cells only: a screenshot's long horizontal edges moved onto the cell grid
// before the renderer fits it (helper-rs/src/snap.rs is the same for the Rust
// helper). A table or heatmap whose row height isn't a whole number of cells
// otherwise drifts against them: rows of partial blocks where an edge falls
// mid-cell, and a label a line off from its row. Each long edge moves to the
// nearest cell boundary, at most half a cell, and the rows between stretch or
// shrink to fit; a gap thinner than a third of a cell closes, so the colour
// change itself lands on the boundary. Edges inside a line of text or a photo
// stay where they are. Text and photo positions move with it.
// Off unless MCP_APPS_CLI_SNAP=1: rows land on cells, but texts that share a
// visual line can then fall on different ones (the cohort heatmap's numbers
// left their month's line, bench/cells-update-check.mjs), and a click isn't
// mapped back through it yet, so near a moved edge it can land a row off.

/** A boundary is an edge where this share of the columns changes colour across it, by more than EDGE_STEP. */
const EDGE_SHARE = 0.3;
const EDGE_STEP = 48;

export const SNAP_ON = process.env.MCP_APPS_CLI_SNAP === "1";

/** Where source row `y` lands, given increasing [source, target] anchors. */
export function mapRow(anchors, y) {
  for (let k = 0; k + 1 < anchors.length; k++) {
    const [s0, t0] = anchors[k];
    const [s1, t1] = anchors[k + 1];
    if (y <= s1) return s1 > s0 ? t0 + ((Math.max(y, s0) - s0) * (t1 - t0)) / (s1 - s0) : t0;
  }
  return y;
}

/**
 * The anchors for `img` ({ width, height, data } RGBA), or null where nothing moves.
 * @param {{ width: number, height: number, data: Uint8Array }} img
 */
export function planSnap(img, cellH, texts, photos) {
  const { width: w, height: h, data } = img;
  if (cellH < 4 || w < 16 || h < cellH * 2 || data.length < w * h * 4) return null;
  const step = w > 800 ? 2 : 1;
  const samples = Math.ceil(w / step);
  const share = new Float64Array(h + 1);
  for (let b = 1; b < h; b++) {
    const above = (b - 1) * w * 4;
    const below = b * w * 4;
    let n = 0;
    for (let x = 0; x < w; x += step) {
      const i = x * 4;
      const d =
        Math.abs(data[above + i] - data[below + i]) +
        Math.abs(data[above + i + 1] - data[below + i + 1]) +
        Math.abs(data[above + i + 2] - data[below + i + 2]);
      if (d > EDGE_STEP) n++;
    }
    share[b] = n / samples;
  }
  const inside = (b) =>
    texts.some((t) => t.top != null && t.bottom != null && b > t.top + 1 && b < t.bottom - 1) ||
    photos.some((p) => p.w >= w / 3 && b > p.y && b < p.y + p.h);
  const edges = [];
  for (let b = 1; b < h; b++) {
    if (share[b] >= EDGE_SHARE && share[b] >= share[b - 1] && share[b] > share[b + 1] && !inside(b)) edges.push(b);
  }
  if (!edges.length) return null;
  const snapTo = (y) => Math.round(y / cellH) * cellH;
  const anchors = [[0, 0]];
  const push = (s, t, closing) => {
    if (Math.abs(s - t) > cellH / 2 + 0.5) return;
    const [ls, lt] = anchors[anchors.length - 1];
    if (s <= ls) return;
    if (t < lt || (t === lt && !closing)) return;
    const ratio = (t - lt) / (s - ls);
    if (!closing && (ratio < 0.5 || ratio > 2)) return;
    anchors.push([s, t]);
  };
  for (let i = 0; i < edges.length; ) {
    const b = edges[i];
    const next = edges[i + 1];
    // A thin gap: both its edges to one boundary, so it closes.
    if (next !== undefined && next - b <= cellH / 3) {
      const t = snapTo((b + next) / 2);
      push(b, t, true);
      push(next, t, true);
      i += 2;
      continue;
    }
    push(b, snapTo(b), false);
    i += 1;
  }
  while (anchors.length && (anchors[anchors.length - 1][0] >= h || anchors[anchors.length - 1][1] > h)) anchors.pop();
  anchors.push([h, h]);
  if (anchors.every(([s, t]) => Math.abs(s - t) < 0.5)) return null;
  return anchors;
}

/** The picture remapped (nearest row: no blended colours); texts and photos moved with it, as new objects. */
export function applySnap(anchors, img, texts, photos) {
  const { width: w, height: h, data } = img;
  const row = w * 4;
  const out = new Uint8Array(data.length);
  let k = 0;
  for (let y = 0; y < h; y++) {
    const centre = y + 0.5;
    while (k + 2 < anchors.length && centre >= anchors[k + 1][1]) k++;
    const [s0, t0] = anchors[k];
    const [s1, t1] = anchors[k + 1];
    const source = t1 > t0 ? s0 + ((centre - t0) * (s1 - s0)) / (t1 - t0) : s0;
    const sy = Math.min(h - 1, Math.max(0, Math.floor(source)));
    out.set(data.subarray(sy * row, (sy + 1) * row), y * row);
  }
  const map = (y) => (y == null ? y : mapRow(anchors, y));
  return {
    img: { ...img, data: out },
    texts: texts.map((t) => ({ ...t, cy: map(t.cy), top: map(t.top), bottom: map(t.bottom) })),
    photos: photos.map((p) => {
      const top = map(p.y);
      return { ...p, y: top, h: Math.max(0, map(p.y + p.h) - top) };
    }),
  };
}
