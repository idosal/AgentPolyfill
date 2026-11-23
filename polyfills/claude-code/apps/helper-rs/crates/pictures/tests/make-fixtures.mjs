// Regenerate with Node 22; no packages or network required. All oracle results
// come from the original JS, never the Rust implementation.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodePng } from "../../../../mod/helper/png.mjs";
import { quantize } from "../../../../mod/helper/quantize.mjs";

// The module snapshots PALETTE at import time. Import two separate instances,
// independently of the environment in which fixture generation is launched.
const originalPalette = process.env.MCP_APPS_CLI_PALETTE;
process.env.MCP_APPS_CLI_PALETTE = "1";
const on = await import("../../../../mod/helper/strips.mjs?fixtures=on");
process.env.MCP_APPS_CLI_PALETTE = "0";
const off = await import("../../../../mod/helper/strips.mjs?fixtures=off");
if (originalPalette === undefined) delete process.env.MCP_APPS_CLI_PALETTE;
else process.env.MCP_APPS_CLI_PALETTE = originalPalette;

const dir = new URL("./fixtures/", import.meta.url);
mkdirSync(dir, { recursive: true });
const write = (name, bytes) => writeFileSync(new URL(name, dir), bytes);
const json = (name, value) => write(name, JSON.stringify(value, null, 2) + "\n");
const chunk = (kind, body) => {
  const bytes = Buffer.alloc(body.length + 12);
  bytes.writeUInt32BE(body.length);
  bytes.write(kind, 4, "latin1");
  body.copy(bytes, 8);
  bytes.writeUInt32BE(on.crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
};

function png(width, height, rgba, color = 6, filters = [0], extra = []) {
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
  const pixels = Buffer.alloc(width * height * channels);
  for (let p = 0; p < width * height; p++) {
    const [r, g, b, a] = rgba.subarray(p * 4, p * 4 + 4);
    pixels.set(color === 0 ? [r] : color === 2 ? [r, g, b] : color === 4 ? [r, a] : [r, g, b, a], p * channels);
  }
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length];
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y ? pixels[(y - 1) * stride + x] : 0;
      const c = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const prediction = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      raw[y * (stride + 1) + 1 + x] = (pixels[y * stride + x] - prediction) & 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.set([8, color, 0, 0, 0], 8);
  const idat = deflateSync(raw);
  const mid = Math.floor(idat.length / 2);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), ...extra,
    chunk("IDAT", idat.subarray(0, mid)), chunk("IDAT", idat.subarray(mid)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const manifest = { schema: 1, sources: {}, decode: [], quantize: [], sequences: [], crc32: [] };
for (const name of ["png", "quantize", "strips"]) {
  const source = readFileSync(new URL(`../../../../mod/helper/${name}.mjs`, import.meta.url));
  manifest.sources[`${name}.mjs`] = createHash("sha256").update(source).digest("hex");
}
const images = new Map();
function image(name, width, height, at, options = {}) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = at(x, y);
    data.set([p[0], p[1], p[2], p[3] ?? 255], (y * width + x) * 4);
  }
  const bytes = png(width, height, data, options.color ?? 6, options.filters ?? [0], options.extra);
  write(`${name}.png`, bytes);
  const decoded = decodePng(bytes);
  write(`${name}.rgba`, decoded.data);
  manifest.decode.push({ name, png: `${name}.png`, rgba: `${name}.rgba`, width, height });
  images.set(name, { width, height, data: decoded.data, bytes });
  return name;
}
function q(name, input, y0 = 0, height, maxColours) {
  const im = images.get(input);
  height ??= im.height - y0;
  const result = quantize(im.data, im.width, y0, height, maxColours);
  let expected = null;
  if (result) {
    write(`${name}.indices`, result.indices);
    expected = { palette: result.palette, indices: `${name}.indices`, psnr: Number.isFinite(result.psnr) ? result.psnr : "Infinity", colours: result.colours };
  }
  manifest.quantize.push({ name, png: `${input}.png`, y0, height, maxColours: maxColours ?? null, expected });
}

image("exact256", 64, 8, (x, y) => [x * 4, y * 30, 200]);
q("exact256-band", "exact256", 2, 4);
q("exact256-limit256", "exact256", 2, 4, 256);
q("exact256-limit255", "exact256", 2, 4, 255);
q("empty-band", "exact256", 2, 0);
q("zero-limit", "exact256", 0, 1, 0);
image("flat-ui", 400, 120, (x, y) => {
  const cards = [[30, 34, 48], [205, 220, 57], [224, 180, 60], [180, 220, 40]];
  const card = cards[Math.floor(x / 100)];
  const edge = ((x * 7 + y * 13) % 97) / 96;
  const ink = x % 9 < 2 && y % 11 < 6 ? edge : 0;
  return card.map((c) => Math.round(c * (1 - ink) + 255 * ink));
});
q("flat-ui", "flat-ui");
image("gradient", 64, 40, (x, y) => [x * 4, y * 6, ((x + y) * 3) & 255], { filters: [0, 1, 2, 3, 4] });
q("gradient", "gradient");
q("gradient-band", "gradient", 7, 12);
image("photo", 256, 64, (x, y) => [x, y * 4, (x * y) & 255]);
q("photo-over-limit", "photo", 0, 64, 4096);
q("photo-at-limit", "photo", 0, 64, 16384);
let seed = 0x12345678;
const randomByte = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; };
image("noise", 192, 100, () => [randomByte(), randomByte(), randomByte()]);
q("noise-over-limit", "noise", 0, 100, 16384);
q("noise-small-band", "noise", 17, 8);
// Equal channel ranges, equal scores, repeated channel values and skewed weights.
image("ties", 32, 32, (x, y) => [(x % 8) * 32, (y % 8) * 32, ((x >> 3) + (y >> 3) * 4) * 16]);
q("ties", "ties");
image("weighted", 80, 20, (x, y) => x < 50 ? [30, 30, 30] : [x * 3, y * 12, (x + y) % 4 * 60]);
q("weighted", "weighted");
image("257-colours", 257, 1, (x) => [x & 255, x >> 8, 42]);
q("257-colours", "257-colours");
image("alpha", 32, 35, (x, y) => [x % 4 * 70, y % 4 * 70, 90, (x * 7 + y * 19) & 255]);
q("alpha", "alpha");
image("alpha-changed", 32, 35, (x, y) => [x % 4 * 70, y % 4 * 70, 90, ((x * 7 + y * 19) + (y >= 15 && y < 30 ? 1 : 0)) & 255]);
for (const color of [0, 2, 4, 6]) {
  image(`filters-${color}`, 13, 10, (x, y) => [(x * 19 + y * 23) & 255, x * 11, y * 25, (x * 29 + y * 31) & 255], { color, filters: [0, 1, 2, 3, 4] });
}
// JS ignores tRNS for RGB/grayscale rather than expanding it into alpha.
image("rgb-trns", 5, 6, () => [10, 20, 30], { color: 2, extra: [chunk("tRNS", Buffer.from([0, 10, 0, 20, 0, 30]))] });
image("gray-trns", 5, 6, () => [10, 10, 10], { color: 0, extra: [chunk("tRNS", Buffer.from([0, 10]))] });
image("bands", 64, 140, () => [10, 20, 30]);
image("bands-middle", 64, 140, (_x, y) => [y >= 60 && y < 120 ? 200 : 10, 20, 30]);
image("bands-grey", 64, 140, () => [90, 90, 90]);
image("bands-last", 64, 140, (_x, y) => y >= 120 ? [0, 0, 0] : [90, 90, 90]);
image("resized-width", 65, 140, () => [10, 20, 30]);
image("resized-height", 65, 143, () => [10, 20, 30]);
image("half-rounding", 17, 35, (x, y) => [y * 7, x * 13, y]);
write("invalid.png", Buffer.from("not a png"));

const job = (input, version, extra = {}) => ({ png: `${input}.png`, rows: 14, top: 0, all: false, stamp: version, version, ...extra });
function sequence(name, palette, steps) {
  const states = new Map();
  const encoder = palette ? on : off;
  const output = [];
  for (const step of steps) {
    const view = step.view ?? "a";
    if (step.drop) { states.delete(view); output.push({ view, drop: true }); continue; }
    if (!states.has(view)) states.set(view, {});
    try {
      const result = encoder.encodeStrips(states.get(view), { ...step.job, png: readFileSync(new URL(step.job.png, dir)) });
      output.push({ view, job: step.job, expected: result });
    } catch (error) {
      output.push({ view, job: step.job, error: error.message });
    }
  }
  manifest.sequences.push({ name, palette, steps: output });
}
for (const palette of [true, false]) {
  sequence(`state-${palette}`, palette, [
    { job: job("bands", 1) },
    { job: job("bands-middle", 2) },
    { job: job("bands-middle", 3) },
    { job: job("invalid", 3, { all: true, stamp: 9 }) },
    { job: job("invalid", 3, { stamp: 10 }) },
    { job: job("bands-middle", 4, { all: true, stamp: 11 }) },
    { job: job("bands-middle", 5, { top: 1 }) },
    { job: job("bands-middle", 6, { rows: 13, top: 1 }) },
    { job: job("resized-width", 7, { rows: 13, top: 1 }) },
    { job: job("resized-height", 8, { rows: 13, top: 1 }) },
    // Same-version shortcut deliberately ignores layout if the count matches.
    { job: job("invalid", 8, { rows: 18, top: 999, all: true, stamp: 1234567890123 }) },
    // A different count must decode even with the same version.
    { job: job("resized-height", 8, { rows: 19 }) },
    { job: job("invalid", 9) },
    { job: job("resized-height", 9, { rows: 19 }) },
    { job: job("bands", 10, { rows: 1 }) },
    { job: job("bands", 11, { rows: 6 }) },
    { job: job("bands", 12, { rows: 12 }) },
    { job: job("bands", 13, { rows: 0 }) },
    { job: job("invalid", 13, { rows: 0, all: true }) },
    { job: job("bands", 14) },
  ]);
  sequence(`views-${palette}`, palette, [
    { view: "a", job: job("bands-grey", 1) },
    { view: "b", job: job("bands-grey", 1) },
    { view: "a", job: job("bands-last", 2) },
    { view: "a", drop: true },
    { view: "a", job: job("bands-grey", 3) },
    { view: "b", job: job("bands-grey", 2) },
    { view: "a", job: job("invalid", 4) },
  ]);
  for (const input of ["flat-ui", "gradient", "photo", "noise", "half-rounding"]) {
    sequence(`${input}-${palette}`, palette, [
      { job: job(input, 1, { rows: input === "half-rounding" ? 12 : 6 }) },
      { job: job("invalid", 1, { rows: input === "half-rounding" ? 12 : 6, all: true, stamp: 0 }) },
    ]);
  }
  sequence(`alpha-${palette}`, palette, [
    { job: job("alpha", 1) },
    { job: job("alpha-changed", 2) },
  ]);
}
for (const bytes of [Buffer.alloc(0), Buffer.from("123456789"), Buffer.from(Array.from({ length: 256 }, (_, i) => i)), images.get("noise").bytes]) {
  manifest.crc32.push({ bytes: bytes.toString("base64"), expected: on.crc32(bytes) });
}
json("manifest.json", manifest);

// The checked-in Chrome capture is regenerated separately, so normal fixtures
// stay reproducible across operating systems, font sets and Chrome versions.
const screenshotPath = new URL("benchmark.png", dir);
if (existsSync(screenshotPath)) {
  const screenshot = readFileSync(screenshotPath);
  const decoded = decodePng(screenshot);
  const job = { png: screenshot, rows: 48, top: 0, all: false, stamp: 1, version: 1 };
  json("benchmark-parity.json", { width: decoded.width, height: decoded.height,
    rgbaCrc32: on.crc32(decoded.data), expected: on.encodeStrips({}, job) });
}

console.log(`Wrote ${manifest.decode.length} decode cases, ${manifest.quantize.length} quantize cases and ${manifest.sequences.length} stateful sequences to ${fileURLToPath(dir)}`);
