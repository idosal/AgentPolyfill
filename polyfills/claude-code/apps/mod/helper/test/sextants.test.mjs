// Sextants (2 x 3 blocks) for photo cells: used only when asked for, never
// in UI cells, and inside the painter's colour-pair budget like the rest.
// (Its own file: the renderer's pair bucket is the process's.)

import assert from "node:assert/strict";
import { test } from "node:test";
import { composeFrame } from "../render.mjs";
import { COLS, ROWS, painter, scene } from "./scene.mjs";
import { fill, page } from "./pixels.mjs";

const isSextant = (cp) => cp >= 0x1fb00 && cp <= 0x1fb3b;

test("sextants shape 3D scenes when the terminal draws them, within the pair budget", () => {
  const model = painter();
  const memory = {};
  const state = {};
  let starved = 0;
  let sextants = 0;
  for (let f = 0; f < 40; f++) {
    const frame = composeFrame(scene(f), [], {
      cols: COLS, rows: ROWS, cellWidth: 8, cellHeight: 16, pageBackground: 0,
      photos: [{ x: 0, y: 0, w: COLS * 8, h: ROWS * 16 }],
      memory, painter: state, now: f * 100, sextants: true,
    });
    const bytes = Buffer.from(frame.cells, "base64");
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    starved += model.paint(words, f ? 100 : 0);
    for (let i = 0; i < words.length; i += 3) if (isSextant(words[i])) sextants++;
  }
  assert.equal(starved, 0);
  assert.ok(sextants > 40 * 100, `only ${sextants} sextant cells in 40 frames`);
});

test("no sextants unless asked for, and never in UI cells", () => {
  const ui = fill(page(64, 48, [30, 30, 30]), 10, 5, 30, 20, [200, 80, 40]);
  const asked = composeFrame(ui, [], { cols: 8, rows: 3, cellWidth: 8, cellHeight: 16, pageBackground: 0, sextants: true });
  const photo = composeFrame(scene(3), [], {
    cols: COLS, rows: ROWS, cellWidth: 8, cellHeight: 16, pageBackground: 0,
    photos: [{ x: 0, y: 0, w: COLS * 8, h: ROWS * 16 }], memory: {}, painter: {}, now: 0,
  });
  for (const frame of [asked, photo]) {
    const bytes = Buffer.from(frame.cells, "base64");
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    for (let i = 0; i < words.length; i += 3) assert.ok(!isSextant(words[i]));
  }
});
