// Minimal PNG decoder for Chrome screenshots: 8-bit, non-interlaced,
// grayscale / RGB / RGBA. Returns { width, height, data } with RGBA bytes.

import { inflateSync } from "node:zlib";

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(buffer) {
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") throw new Error("not a PNG");

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body[8];
      colorType = body[9];
      const interlace = body[12];
      if (bitDepth !== 8 || interlace !== 0 || !(colorType in CHANNELS)) {
        throw new Error(
          `unsupported PNG (depth ${bitDepth}, color ${colorType}, interlace ${interlace})`,
        );
      }
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  const channels = CHANNELS[colorType];
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    if (filter === 0 || (filter === 2 && y === 0)) {
      out.set(line);
      continue;
    }
    // Chrome's fast screenshots usually use the Up filter for whole rows.
    // Only the previous row is needed, so decode it in one linear pass.
    if (filter === 2) {
      const above = (y - 1) * stride;
      for (let x = 0; x < stride; x++) out[x] = line[x] + pixels[above + x];
      continue;
    }
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      switch (filter) {
        case 1:
          value += a;
          break;
        case 3:
          value += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
      }
      out[x] = value & 0xff;
    }
  }

  if (channels === 4) return { width, height, data: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++) {
    if (channels === 3) {
      rgba[j++] = pixels[i * 3];
      rgba[j++] = pixels[i * 3 + 1];
      rgba[j++] = pixels[i * 3 + 2];
    } else {
      const g = pixels[i * channels];
      rgba[j++] = g;
      rgba[j++] = g;
      rgba[j++] = g;
    }
    rgba[j++] = channels === 2 ? pixels[i * 2 + 1] : 255;
  }
  return { width, height, data: rgba };
}
