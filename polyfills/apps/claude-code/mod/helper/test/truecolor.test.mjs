// Full colour (opts.truecolor), drawn as styled text: photo cells keep the
// scene's own colours, off Claude Code's 16-level Raster grid, and the frame
// comes as rows of styled runs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { composeFrame } from "../render.mjs";
import { COLS, ROWS, scene } from "./scene.mjs";

test("full colour keeps a 3D scene's own colours, as rows of styled runs", () => {
  const frame = composeFrame(scene(5), [], {
    cols: COLS, rows: ROWS, cellWidth: 8, cellHeight: 16, pageBackground: 0,
    photos: [{ x: 0, y: 0, w: COLS * 8, h: ROWS * 16 }], memory: {}, painter: {}, now: 0,
    truecolor: true, lines: true,
  });
  assert.equal(frame.lines.length, ROWS);
  const colours = new Set();
  for (const runs of frame.lines) {
    assert.equal(runs.reduce((n, [text]) => n + [...text].length, 0), COLS);
    for (const [, fg, bg] of runs) for (const c of [fg, bg]) if (c) colours.add(c);
  }
  const offGrid = [...colours].filter((c) => [1, 3, 5].some((i) => parseInt(c.slice(i, i + 2), 16) % 17));
  assert.ok(colours.size > 1000, `only ${colours.size} colours`);
  assert.ok(offGrid.length > colours.size / 2, `${offGrid.length} of ${colours.size} off the 16-level grid`);
});
