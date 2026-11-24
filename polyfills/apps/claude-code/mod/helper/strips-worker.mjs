// Encodes inline picture strips off the helper's event loop (see strips.mjs).
// One worker for all views: each message is one view's job, answered in turn.

import { parentPort } from "node:worker_threads";
import { encodeStrips } from "./strips.mjs";

const states = new Map();

parentPort.on("message", (message) => {
  if (message.drop) {
    states.delete(message.drop);
    return;
  }
  const { id, viewId, job } = message;
  try {
    if (!states.has(viewId)) states.set(viewId, {});
    parentPort.postMessage({ id, result: encodeStrips(states.get(viewId), job) });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message ?? error) });
  }
});
