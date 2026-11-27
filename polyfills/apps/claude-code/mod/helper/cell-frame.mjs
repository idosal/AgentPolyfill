// Fit screenshots in capture order so photo glyphs retain their history.
import { on } from "node:events";
import { Worker, parentPort, workerData } from "node:worker_threads";
import { decodePng } from "./png.mjs";
import { composeFrame } from "./render.mjs";
import { SNAP_ON, applySnap, planSnap } from "./snap.mjs";

export function fitCellFrame(state, { png, texts, photos, top, ...options }) {
  if (!state.memory || state.top !== top) {
    state.memory = {};
    state.top = top;
  }
  const img = decodePng(Buffer.isBuffer(png) ? png : Buffer.from(png.buffer, png.byteOffset, png.byteLength));
  const anchors = SNAP_ON ? planSnap(img, Math.round(options.cellHeight), texts, photos) : null;
  const fitted = anchors ? applySnap(anchors, img, texts, photos) : { img, texts, photos };
  const frame = composeFrame(fitted.img, fitted.texts, {
    ...options, photos: fitted.photos, memory: state.memory, painter: state.painter ??= {},
    raster: !options.truecolor,
  });
  if (options.truecolor) {
    frame.styled = frame.lines;
    delete frame.lines;
    delete frame.cells;
  }
  return frame;
}

export function createCellWorker() {
  const worker = new Worker(new URL(import.meta.url), {workerData: "fit-cells"});
  const replies = on(worker, "message", {close: ["exit"]});
  return {
    async paint(request) {
      worker.postMessage(request);
      const { value, done } = await replies.next();
      if (done) throw Error("Cell renderer closed");
      return value[0];
    },
    close() { void worker.terminate(); },
  };
}

if (workerData === "fit-cells") {
  const state = {};
  parentPort.on("message", request => parentPort.postMessage(fitCellFrame(state, request)));
}
