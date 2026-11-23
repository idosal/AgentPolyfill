// The cells renderer on UI content: flat areas, thin lines and gaps, cells
// with two colours, text, and frame-to-frame stability.

import assert from "node:assert/strict";
import { test } from "node:test";
import { composeFrame } from "../render.mjs";
import { DEFAULT, cells, fill, grid, isBraille, page, rows, stroke } from "./pixels.mjs";

const render = (img, cols, rowCount, texts = [], extra = {}) =>
  composeFrame(img, texts, grid(cols, rowCount, extra));

test("a flat area is spaces on its colour, at Claude Code's 4-bit steps", () => {
  const out = cells(render(page(16, 16, [60, 60, 200]), 2, 1));
  assert.deepEqual(out, [
    { ch: " ", fg: DEFAULT, bg: 0x4444cc },
    { ch: " ", fg: DEFAULT, bg: 0x4444cc },
  ]);
});

test("a thin line through the middle of a row is a box-drawing line", () => {
  const img = fill(page(24, 16, [30, 30, 30]), 0, 7, 24, 2, [220, 220, 220]);
  for (const cell of cells(render(img, 3, 1))) {
    assert.deepEqual(cell, { ch: "━", fg: 0xdddddd, bg: 0x222222 });
  }
  const column = fill(page(24, 16, [40, 180, 60]), 11, 0, 1, 16, [20, 20, 30]);
  assert.deepEqual(rows(render(column, 3, 1)), [" ┃ "]);
});

test("a thin line near a cell edge snaps to that edge at its own thickness", () => {
  const top = fill(page(24, 16, [30, 30, 30]), 0, 0, 24, 1, [220, 220, 220]);
  assert.deepEqual(rows(render(top, 3, 1)), ["▔▔▔"]);
  const low = fill(page(8, 16, [30, 30, 30]), 0, 11, 8, 2, [220, 220, 220]);
  assert.deepEqual(rows(render(low, 1, 1)), ["▁"]);
});

test("a gap between two tiles stays a gap on both sides of the cell edge", () => {
  const img = fill(page(24, 16, [40, 180, 60]), 7, 0, 2, 16, [20, 20, 30]);
  const [left, right, clear] = cells(render(img, 3, 1));
  assert.deepEqual(left, { ch: "▕", fg: 0x111122, bg: 0x22bb44 });
  assert.deepEqual(right, { ch: "▏", fg: 0x111122, bg: 0x22bb44 });
  assert.equal(clear.ch, " ");
});

test("two colours stacked in a cell are a block of the right height", () => {
  const half = fill(page(8, 16, [200, 40, 40]), 0, 8, 8, 8, [40, 40, 200]);
  assert.deepEqual(cells(render(half, 1, 1)), [{ ch: "▄", fg: 0x2222cc, bg: 0xcc2222 }]);
});

test("a cell with three colours keeps the two that matter, exact", () => {
  const img = page(8, 16, [200, 40, 40]);
  fill(img, 0, 5, 8, 6, [40, 200, 40]);
  fill(img, 0, 11, 8, 5, [40, 40, 200]);
  const [cell] = cells(render(img, 1, 1));
  assert.notEqual(cell.ch, " ");
  // No averaged colour: each side is one of the page's colours.
  for (const colour of [cell.fg, cell.bg]) assert.ok([0xcc2222, 0x22cc22, 0x2222cc].includes(colour));
});

test("text is placed as characters, and its glyph pixels leave no blocks", () => {
  // White "glyph" pixels under the text's box.
  const img = fill(page(32, 16, [20, 20, 40]), 2, 3, 12, 10, [255, 255, 255]);
  const out = cells(
    render(img, 4, 1, [{ x: 0, cy: 8, t: "Hi!", color: "rgb(255, 255, 255)", top: 2, bottom: 14, right: 22 }]),
  );
  assert.deepEqual(out.map((c) => c.ch).join(""), "Hi! ");
  for (const cell of out.slice(0, 3)) assert.deepEqual([cell.fg, cell.bg], [0xffffff, 0x111122]);
  assert.equal(out[3].bg, 0x111122);
});

test("text lands in the cell under its position", () => {
  const out = render(page(32, 32, [20, 20, 40]), 4, 2, [
    { x: 8, cy: 24, t: "ok", color: "#ff0000", top: 18, bottom: 30, right: 24 },
  ]);
  assert.deepEqual(rows(out), ["    ", " ok "]);
  assert.equal(cells(out)[5].fg, 0xff0000);
});

test("a legend item that runs into the previous label moves right, clear of it", () => {
  const out = render(page(128, 16, [20, 20, 40]), 16, 1, [
    { x: 0, cy: 8, t: "alpha", color: "#ffffff", top: 2, bottom: 14, right: 20 },
    { x: 24, cy: 8, t: "beta", color: "#ffff00", top: 2, bottom: 14, right: 44 },
  ]);
  assert.deepEqual(rows(out), ["alpha beta      "]);
});

test("two lines that land on one row: the second takes the free row beside it", () => {
  const out = render(page(64, 48, [20, 20, 40]), 8, 3, [
    { x: 0, cy: 18, t: "Users", color: "#ffffff", top: 13, bottom: 23, right: 30 },
    { x: 0, cy: 28, t: "1234", color: "#ffff00", top: 23, bottom: 32, right: 24 },
  ]);
  assert.deepEqual(rows(out), ["        ", "Users   ", "1234    "]);
});

test("the same page drawn twice gives the same cells", () => {
  const img = page(48, 32, [30, 30, 30]);
  fill(img, 0, 7, 48, 2, [220, 220, 220]);
  fill(img, 13, 16, 20, 16, [40, 180, 60]);
  const memory = {};
  const first = render(img, 6, 2, [], { memory }).cells;
  assert.equal(render(img, 6, 2, [], { memory }).cells, first);
  assert.equal(render(img, 6, 2).cells, first);
});

test("a cell holds still through anti-aliasing noise, and changes for a real change", () => {
  // An edge whose anti-aliased row sits on the boundary between two glyphs:
  // a few levels of change flip a fresh fit from ▄ to ▅.
  const dark = [30, 30, 30];
  const green = [40, 180, 60];
  const edge = (row, share) =>
    fill(fill(page(8, 16, dark), 0, row + 1, 8, 15 - row, green), 0, row, 8, 1, dark.map((v, k) => Math.round(v + (green[k] - v) * share)));
  assert.deepEqual(rows(render(edge(7, 0.52), 1, 1)), ["▄"]);
  assert.deepEqual(rows(render(edge(7, 0.56), 1, 1)), ["▅"]);
  const memory = {};
  assert.deepEqual(rows(render(edge(7, 0.52), 1, 1, [], { memory })), ["▄"]);
  assert.deepEqual(rows(render(edge(7, 0.56), 1, 1, [], { memory })), ["▄"]);
  assert.deepEqual(rows(render(edge(3, 0), 1, 1, [], { memory })), ["▆"]);
});

test("a line holds its glyph a little past where a fresh one would step", () => {
  const line = (y) => fill(page(8, 16, [30, 30, 30]), 0, y, 8, 2, [220, 220, 220]);
  const memory = {};
  assert.deepEqual(rows(render(line(7), 1, 1, [], { memory })), ["━"]);
  assert.deepEqual(rows(render(line(11), 1, 1, [], { memory })), ["━"]);
  assert.deepEqual(rows(render(line(11), 1, 1)), ["▁"]);
});

test("a zig-zag sparkline is drawn in Braille dots", () => {
  const img = page(64, 16, [30, 34, 50]);
  const points = [];
  for (let x = 0; x <= 64; x += 4) points.push([x, x % 8 ? 4 : 12]);
  stroke(img, points, 1.5, [60, 140, 250]);
  const out = cells(render(img, 8, 1));
  const dotted = out.filter((c) => isBraille(c.ch));
  assert.ok(dotted.length >= 6, `only ${dotted.length} of 8 cells in Braille: ${out.map((c) => c.ch).join("")}`);
  for (const cell of dotted) assert.deepEqual([cell.fg, cell.bg], [0x4488ff, 0x222233]);
});

test("straight lines and borders stay solid, not dotted", () => {
  const img = page(64, 32, [30, 30, 30]);
  fill(img, 0, 7, 64, 2, [220, 220, 220]);
  fill(img, 35, 0, 1, 32, [220, 220, 220]);
  assert.equal(cells(render(img, 8, 2)).filter((c) => isBraille(c.ch)).length, 0);
});

test("a short slanted mark alone in its cell keeps a block shape", () => {
  const img = stroke(page(24, 16, [30, 30, 30]), [[8, 3], [16, 12]], 1.5, [220, 220, 220]);
  assert.equal(cells(render(img, 3, 1)).filter((c) => isBraille(c.ch)).length, 0);
});

test("a track's rounded end takes the track's shape", () => {
  // A 4 px track with a round cap ending part way into the last cell: alone,
  // that cell fits a thinner bar (▆▆▆▆▆▔, ▂▂▂▂▂▁).
  for (const top of [2, 10]) {
    const img = page(48, 16, [20, 20, 40]);
    fill(img, 0, top, 45, 4, [70, 90, 110]);
    stroke(img, [[45, top + 2], [45, top + 2.01]], 4, [70, 90, 110]);
    const out = rows(render(img, 6, 1))[0];
    assert.equal(new Set(out).size, 1, `track cells differ: "${out}"`);
  }
});

test("a long value cut off at the edge stays on its label's row", () => {
  // A label one cell wider in the terminal than on the page runs into the
  // value after it; the value, too long for the view, moved to a free row
  // and read as the line above's.
  const out = rows(
    render(page(160, 48, [20, 20, 40]), 20, 3, [
      { x: 0, cy: 8, t: "first: ok", color: "#ffffff", top: 2, bottom: 14, right: 60 },
      { x: 0, cy: 40, t: "result:", color: "#ffffff", top: 34, bottom: 46, right: 50 },
      { x: 50, cy: 40, t: '{"meta":{"long":"value that does not fit"}}', color: "#ffff00", top: 34, bottom: 46, right: 330 },
    ]),
  );
  assert.equal(out[1].trim(), "");
  assert.ok(out[2].startsWith("result: {"), `row 3 is "${out[2]}"`);
});

test("a densely filled 2D canvas is fitted as a photo; a sparse one stays UI", () => {
  // Stacked bands with sloped tops, like an area chart: shaded as a photo.
  const area = page(64, 32, [30, 34, 50]);
  for (let x = 0; x < 64; x++) {
    const top = 26 - Math.round(x / 3);
    fill(area, x, top, 1, 32 - top, [60, 140, 250]);
    fill(area, x, top + Math.round((32 - top) / 2), 1, 32 - top - Math.round((32 - top) / 2), [240, 140, 40]);
  }
  const box = { x: 0, y: 0, w: 64, h: 32 };
  const asPhoto = cells(render(area, 8, 2, [], { photos: [box] }));
  assert.deepEqual(cells(render(area, 8, 2, [], { photos: [{ ...box, canvas2d: true }] })), asPhoto);
  // A line chart on a 2D canvas (mostly empty) keeps its Braille line.
  const line = page(64, 48, [30, 34, 50]);
  const points = [];
  for (let x = 0; x <= 64; x += 4) points.push([x, x % 8 ? 20 : 28]);
  stroke(line, points, 1.5, [60, 140, 250]);
  const sparse = cells(render(line, 8, 3, [], { photos: [{ x: 0, y: 0, w: 64, h: 48, canvas2d: true }] }));
  assert.deepEqual(sparse, cells(render(line, 8, 3)));
  assert.ok(sparse.some((c) => isBraille(c.ch)));
});

test("a 2D canvas near the density line keeps its fitting from frame to frame", () => {
  const box = { x: 0, y: 0, w: 64, h: 32, canvas2d: true };
  const dense = fill(page(64, 32, [30, 34, 50]), 0, 16, 64, 16, [60, 140, 250]);
  const middling = fill(page(64, 32, [30, 34, 50]), 0, 26, 64, 6, [60, 140, 250]);
  const photo = { x: 0, y: 0, w: 64, h: 32 };
  // The same two frames with a plain photo box (a photo's palette lives in
  // the painter too, so both go through the dense frame first).
  const painter = {};
  const asPhoto = {};
  render(dense, 8, 2, [], { photos: [box], painter });
  render(dense, 8, 2, [], { photos: [photo], painter: asPhoto });
  const kept = cells(render(middling, 8, 2, [], { photos: [box], painter }));
  assert.deepEqual(kept, cells(render(middling, 8, 2, [], { photos: [photo], painter: asPhoto })));
  assert.deepEqual(cells(render(middling, 8, 2, [], { photos: [box], painter: {} })), cells(render(middling, 8, 2)));
});

test("a tooltip sliding off a dense 2D canvas leaves no trail", () => {
  const chart = () => {
    const img = page(64, 32, [30, 34, 50]);
    for (let x = 0; x < 64; x++) {
      const top = 20 - Math.round(x / 6);
      fill(img, x, top, 1, 32 - top, [60, 140, 250]);
      fill(img, x, top + 6, 1, 32 - top - 6, [240, 140, 40]);
    }
    return img;
  };
  const box = { x: 0, y: 0, w: 64, h: 32, canvas2d: true };
  const memory = {};
  const painter = {};
  for (const opts of [{ truecolor: true }, {}]) {
    const withTip = fill(chart(), 16, 4, 24, 20, [10, 10, 12]);
    render(withTip, 8, 2, [], { photos: [box], memory, painter, ...opts });
    const after = cells(render(chart(), 8, 2, [], { photos: [box], memory, painter, ...opts }));
    assert.deepEqual(after, cells(render(chart(), 8, 2, [], { photos: [box], memory: {}, painter, ...opts })));
  }
});
