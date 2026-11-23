// 3D scenes, images and video in cells mode: every colour pair the renderer
// draws must be one Claude Code's Raster painter will hold. The painter
// keeps 1024 pairs (colours at 4 bits a channel) and admits new ones from a
// session-wide bucket of 4096 tokens refilled at 160 a second; a pair it
// can't admit is drawn as the nearest one it holds, a wrong-colour patch.
// (Its own file: the renderer's bucket is the process's, like the painter's.)

import assert from "node:assert/strict";
import { test } from "node:test";
import { composeFrame } from "../render.mjs";
import { COLS, CH, CW, ROWS, painter, scene } from "./scene.mjs";


test("an animated 3D scene stays within the painter's pairs, and keeps its shading", () => {
  const model = painter();
  const memory = {};
  const state = {};
  let starved = 0;
  let glyphs = 0;
  let counted = 0;
  const FRAME_MS = 100;
  for (let f = 0; f < 120; f++) {
    const frame = composeFrame(scene(f), [], {
      cols: COLS,
      rows: ROWS,
      cellWidth: CW,
      cellHeight: CH,
      pageBackground: 0,
      photos: [{ x: 0, y: 0, w: COLS * CW, h: ROWS * CH }],
      memory,
      painter: state,
      now: f * FRAME_MS,
    });
    const bytes = Buffer.from(frame.cells, "base64");
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    starved += model.paint(words, f ? FRAME_MS : 0);
    const pairs = new Set();
    for (let i = 0; i < words.length; i += 3) {
      pairs.add(`${words[i] === 32 ? "-" : words[i + 1]}/${words[i + 2]}`);
      if (f >= 10) {
        counted++;
        if (words[i] !== 32) glyphs++;
      }
    }
    assert.ok(pairs.size <= 1024, `frame ${f} draws ${pairs.size} pairs`);
  }
  assert.equal(starved, 0, "cells drawn with a pair the painter would not admit");
  // Not flat: a good share of cells keep a glyph (shading, edges).
  assert.ok(glyphs / counted > 0.3, `only ${((100 * glyphs) / counted).toFixed(0)}% glyph cells`);
});
