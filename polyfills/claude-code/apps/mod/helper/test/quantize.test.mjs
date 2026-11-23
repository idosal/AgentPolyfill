// 256-colour inline strips (iTerm2): a page of flat colour with anti-aliased
// edges comes out the same to the eye, a photo is left alone.

import assert from "node:assert/strict";
import { test } from "node:test";
import { quantize } from "../quantize.mjs";

function image(width, height, colourAt) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colourAt(x, y);
      rgba.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return rgba;
}

test("a band with 256 colours or fewer keeps every one exactly", () => {
  const width = 64;
  const rgba = image(width, 8, (x, y) => [x * 4, y * 30, 200]);
  const { palette, indices, psnr } = quantize(rgba, width, 2, 4);
  assert.equal(psnr, Infinity);
  for (let p = 0; p < width * 4; p++) {
    const i = (2 * width + p) * 4;
    assert.deepEqual(palette[indices[p]], [rgba[i], rgba[i + 1], rgba[i + 2]]);
  }
});

test("a page of flat colours with soft edges stays the same to the eye", () => {
  // Cards on a dark background with text-like edges blending into them.
  const width = 400, height = 120;
  const cards = [[30, 34, 48], [205, 220, 57], [224, 180, 60], [180, 220, 40]];
  const rgba = image(width, height, (x, y) => {
    const card = cards[Math.floor(x / 100)];
    const edge = ((x * 7 + y * 13) % 97) / 96;
    const ink = (x % 9 < 2) && (y % 11 < 6) ? edge : 0;
    return card.map((c) => Math.round(c * (1 - ink) + 255 * ink));
  });
  const result = quantize(rgba, width, 0, height);
  assert.ok(result.colours > 256);
  assert.ok(result.palette.length <= 256);
  assert.ok(result.psnr >= 42, `psnr ${result.psnr}`);
});

test("a band with too many colours (a photo) is left as it is", () => {
  const width = 256;
  const rgba = image(width, 64, (x, y) => [x, y * 4, (x * y) & 255]);
  assert.equal(quantize(rgba, width, 0, 64, 4096), undefined);
});
