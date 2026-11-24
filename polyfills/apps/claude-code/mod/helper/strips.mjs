// Inline pictures (iTerm2) go as bands of STRIP_ROWS rows, each its own
// Image: a hover that changes one band sends that band, a sixth of the bytes
// through the terminal. Each band is whole rows of whole pixels, so the bands
// meet without a seam. The work (decoding Chrome's PNG, comparing bands,
// compressing the changed ones) runs in strips-worker.mjs, off the helper's
// event loop, so input keeps flowing and the next screenshot is taken while
// this one is compressed.

import { deflateSync } from "node:zlib";
import { decodePng } from "./png.mjs";
import { quantize } from "./quantize.mjs";

/** Rows of the terminal per band. */
export const STRIP_ROWS = 6;

// Bands in at most 256 colours (see quantize.mjs) where that looks the same:
// a band with more distinct colours than this (a photo, a 3D scene), or that
// would come out worse than this many dB, is sent as it is.
// MCP_APPS_CLI_PALETTE=0 sends every band in full colour.
const PALETTE_ON = process.env.MCP_APPS_CLI_PALETTE !== "0";
const PALETTE_MAX_COLOURS = 16384;
const PALETTE_MIN_PSNR = 42;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The compressed pixels (IDAT) of `height` rows of RGBA from `data` starting at row `y0`. */
function deflateStrip(data, width, y0, height) {
  if (PALETTE_ON) {
    const quantized = quantize(data, width, y0, height, PALETTE_MAX_COLOURS);
    if (quantized && quantized.psnr >= PALETTE_MIN_PSNR) {
      const raw = Buffer.alloc((width + 1) * height);
      for (let y = 0; y < height; y++) raw.set(quantized.indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
      return { idat: deflateSync(raw, { level: 6 }), width, height, palette: Buffer.from(quantized.palette.flat()) };
    }
  }
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, (y0 + y) * stride, (y0 + y + 1) * stride);
  }
  return { idat: deflateSync(raw, { level: 6 }), width, height };
}

/** A strip's PNG, stamped `n` so the same pixels sent again are new bytes. */
function wrapStrip({ idat, width, height, palette }, n) {
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "latin1");
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, palette ? 3 : 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    ...(palette ? [chunk("PLTE", palette)] : []),
    chunk("tEXt", Buffer.from(`mcp-apps-cli\0${n}`, "latin1")),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The bands of picture `version` (`png`, `rows` terminal rows, scrolled to
 * `top`) that differ from the last ones in `state` (one view's), each a
 * stamped PNG in base64; with `all`, every band (a fresh copy). The same
 * version again re-stamps its bands with no decoding or compressing.
 *
 * @param {{ layout?: string, pixels?: Buffer[], encoded?: object[], version?: number }} state
 * @param {{ png: Uint8Array, rows: number, top: number, all: boolean, stamp: number, version: number }} job
 */
export function encodeStrips(state, { png, rows, top, all, stamp, version }) {
  const count = Math.ceil(rows / STRIP_ROWS);
  const bandRows = (i) => Math.min(rows, (i + 1) * STRIP_ROWS) - i * STRIP_ROWS;
  if (state.version === version && state.encoded?.length === count) {
    const strips = all ? state.encoded.map((encoded, i) => ({ i, rows: bandRows(i), png: wrapStrip(encoded, stamp).toString("base64") })) : [];
    return { strips, stripCount: count };
  }
  const { width, height, data } = decodePng(Buffer.from(png.buffer, png.byteOffset, png.byteLength));
  const pixels = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const rowPx = height / rows;
  const layout = `${width}x${height}/${rows}/${top}`;
  if (state.layout !== layout) {
    state.layout = layout;
    state.pixels = [];
    state.encoded = [];
    all = true;
  }
  state.version = version;
  const strips = [];
  for (let i = 0; i < count; i++) {
    const y0 = Math.round(i * STRIP_ROWS * rowPx);
    const y1 = Math.round(Math.min(rows, (i + 1) * STRIP_ROWS) * rowPx);
    const band = pixels.subarray(y0 * width * 4, y1 * width * 4);
    if (!all && state.pixels[i]?.equals(band)) continue;
    state.pixels[i] = Buffer.from(band);
    state.encoded[i] = deflateStrip(pixels, width, y0, y1 - y0);
    strips.push({ i, rows: bandRows(i), png: wrapStrip(state.encoded[i], stamp).toString("base64") });
  }
  return { strips, stripCount: count };
}
