// Inline picture strips (iTerm2): only the bands that changed are sent, the
// same picture again is re-stamped without decoding, and the work runs in a
// worker thread off the helper's event loop.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import { STRIP_ROWS, crc32, encodeStrips } from "../strips.mjs";

const WIDTH = 64;
const ROW_PX = 10;
const ROWS = 14; // three bands: 6, 6 and 2 rows

/** An RGBA PNG of the picture, its bands filled by `colourOf(band)`. */
function png(colourOf) {
  const height = ROWS * ROW_PX;
  const raw = Buffer.alloc((WIDTH * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const [r, g, b] = colourOf(Math.floor(y / ROW_PX / STRIP_ROWS));
    for (let x = 0; x < WIDTH; x++) raw.set([r, g, b, 255], y * (WIDTH * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "latin1");
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const job = (picture, version, extra = {}) => ({ png: picture, rows: ROWS, top: 0, all: false, stamp: version, version, ...extra });
const bands = ({ strips }) => strips.map((s) => [s.i, s.rows]);

test("only the bands that changed are sent; the same picture again re-stamps its bands", () => {
  const state = {};
  const first = encodeStrips(state, job(png(() => [10, 20, 30]), 1));
  assert.equal(first.stripCount, 3);
  assert.deepEqual(bands(first), [[0, 6], [1, 6], [2, 2]]);

  // New pixels in the middle band only.
  const second = encodeStrips(state, job(png((b) => (b === 1 ? [200, 20, 30] : [10, 20, 30])), 2));
  assert.deepEqual(bands(second), [[1, 6]]);

  // A new capture with the same pixels: nothing to send.
  assert.deepEqual(bands(encodeStrips(state, job(png((b) => (b === 1 ? [200, 20, 30] : [10, 20, 30])), 3))), []);

  // A fresh copy of the same version: every band, stamped anew, from what
  // was compressed (the PNG isn't even read).
  const again = encodeStrips(state, job(Buffer.from("not a png"), 3, { all: true, stamp: 9 }));
  assert.deepEqual(bands(again), [[0, 6], [1, 6], [2, 2]]);
  assert.match(Buffer.from(again.strips[0].png, "base64").toString("latin1"), /mcp-apps-cli\x009/);
});

test("the worker encodes strips off the event loop, one view's bands kept per view", async () => {
  const worker = new Worker(new URL("../strips-worker.mjs", import.meta.url));
  let id = 0;
  const ask = (viewId, j) =>
    new Promise((resolve, reject) => {
      const mine = ++id;
      const onMessage = (m) => {
        if (m.id !== mine) return;
        worker.off("message", onMessage);
        if (m.error) reject(new Error(m.error));
        else resolve(m.result);
      };
      worker.on("message", onMessage);
      worker.postMessage({ id: mine, viewId, job: j });
    });
  try {
    const grey = png(() => [90, 90, 90]);
    assert.deepEqual(bands(await ask("a", job(grey, 1))), [[0, 6], [1, 6], [2, 2]]);
    // Another view has its own bands: all of them are new there.
    assert.deepEqual(bands(await ask("b", job(grey, 1))), [[0, 6], [1, 6], [2, 2]]);
    assert.deepEqual(bands(await ask("a", job(png((b) => (b === 2 ? [0, 0, 0] : [90, 90, 90])), 2))), [[2, 2]]);
    // A dropped view starts over.
    worker.postMessage({ drop: "a" });
    assert.deepEqual(bands(await ask("a", job(grey, 3))), [[0, 6], [1, 6], [2, 2]]);
    await assert.rejects(ask("a", job(Buffer.from("not a png"), 4)), /not a PNG/);
  } finally {
    await worker.terminate();
  }
});
