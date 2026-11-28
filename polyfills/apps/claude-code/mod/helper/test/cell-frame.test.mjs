import assert from "node:assert/strict";
import { test } from "node:test";
import { fitCellFrame, createCellWorker } from "../cell-frame.mjs";
import { decodePng } from "../png.mjs";

// A 16x32 RGBA gradient with the PNG Up filter on every row, including the first.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAgCAYAAAAbifjMAAAArklEQVR4nGNiYGD4z8fA9l+Ggee/FoPQfwsGif9uDHL/QxhU/icxaP0vYDD4X8dg9r+Hweb/LAan/ysYPP5vY/D7f4Qh5P8lhqj/TAzsbAwM7L8YyKWhBggB8TskCeL51HSBHBBrAfE1IH6ExUbs8sMzDMyA2AmI/YA4CoiXAfEmIN4HxKdGSBiMpgPMdJAGxEVAXAfEXUA8DYgXAfE6IN41TMNgNB2MlgcjMh0AAKYcHTDSIeEZAAAAAElFTkSuQmCC", "base64");

test("decodes Up-filtered RGBA bytes across the first and subsequent rows", () => {
  const { width, height, data } = decodePng(png);
  assert.deepEqual([width, height], [16, 32]);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    assert.deepEqual([...data.subarray(at, at + 4)], [x * 14, y * 7, (x ^ y) * 6, 255]);
  }
});

test("the cell worker preserves ordered glyphs, colours and text across scroll and resize", async t => {
  const worker = createCellWorker();
  t.after(() => worker.close());
  const state = {};
  const request = { png, texts: [], photos: [{x:0, y:0, w:16, h:32}], top:0, cols:2, rows:2,
    cellWidth:8, cellHeight:16, pageBackground:0, sextants:true, truecolor:true, lines:true };
  for (const change of [{}, {texts:[{x:0, cy:8, t:"x", color:"#ffffff"}]}, {top:16, rows:1}, {cols:1, truecolor:false}]) {
    const frame = {...request, ...change};
    assert.deepEqual(await worker.paint(frame), fitCellFrame(state, frame));
  }
});
