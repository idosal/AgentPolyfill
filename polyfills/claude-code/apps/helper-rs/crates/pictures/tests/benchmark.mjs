// Same workload, warm-up, measurements and cache states as examples/benchmark.rs.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { decodePng } from "../../../../mod/helper/png.mjs";
process.env.MCP_APPS_CLI_PALETTE = "1";
const { encodeStrips } = await import("../../../../mod/helper/strips.mjs");
const iterations = Number(process.argv[2] ?? 20), warmup = 5;
if (!Number.isInteger(iterations) || iterations < 1) throw new Error("positive iteration count required");
const png = readFileSync(new URL("./fixtures/benchmark.png", import.meta.url));
const job = { png, rows: 48, top: 0, all: false, stamp: 1, version: 1 };
let sink;
function measure(f) {
  for (let i = 0; i < warmup; i++) sink = f();
  const samplesMs = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    sink = f();
    samplesMs.push(performance.now() - start);
  }
  samplesMs.sort((a, b) => a - b);
  const mid = Math.floor(iterations / 2);
  return { medianMs: iterations % 2 ? samplesMs[mid] : (samplesMs[mid - 1] + samplesMs[mid]) / 2, minMs: samplesMs[0], maxMs: samplesMs.at(-1), samplesMs };
}
const decode = measure(() => decodePng(png));
const fresh = measure(() => encodeStrips({}, job));
const state = {};
const first = encodeStrips(state, job);
let version = 1;
const unchanged = measure(() => encodeStrips(state, { ...job, version: ++version, stamp: version }));
let stamp = version;
const restamp = measure(() => encodeStrips(state, { ...job, png: Buffer.from("unused"), version, stamp: ++stamp, all: true }));
if (!sink) throw new Error("no result");
console.log(JSON.stringify({ runtime: process.version, width: 2192, height: 1152, rows: 48, palette: true, warmup, iterations,
  pngBytes: png.length, stripCount: first.stripCount, base64Bytes: first.strips.reduce((n, s) => n + s.png.length, 0),
  decode, fresh, unchanged, restamp }, null, 2));
