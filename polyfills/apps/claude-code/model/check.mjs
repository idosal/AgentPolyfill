// Model-checks the TLA+ models in this folder with TLC, each configuration
// against what it should give: every invariant holds, or (for a configuration
// of an earlier version's code) the one named is violated.
//
//   node model/check.mjs [name ...]
//
// Needs Java and tla2tools.jar: JAVA (or java on PATH) and TLA2TOOLS (or
// tla2tools.jar beside this file). TLC's state files go to a temporary folder,
// removed after each run; a run whose state passes MODEL_STATE_MB (150 MB) is
// stopped and counts as failed. Exit 0 when every configuration gave what it should.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// [configuration, module, expected]: "holds", or the invariant TLC must find violated.
const RUNS = [
  ["Live.cfg", "MCAppsOne.tla", "holds"],
  ["Reopen.cfg", "MCAppsViews.tla", "holds"],
  ["Race.cfg", "MCAppsViews.tla", "holds"],
  ["Traffic.cfg", "MCAppsViews.tla", "holds"],
  ["TrafficShared.cfg", "MCAppsViews.tla", "holds"],
  ["Instance.cfg", "MCAppsViews.tla", "holds"],
  ["ReopenTraffic.cfg", "MCAppsViews.tla", "holds"],
  ["Token.cfg", "MCAppsViews.tla", "holds"],
  ["ConsentRules.cfg", "AppsConsent.tla", "holds"],
  ["ConsentAsk.cfg", "AppsConsent.tla", "holds"],
  ["ConsentAllow.cfg", "AppsConsent.tla", "holds"],
  ["ConsentOther.cfg", "AppsConsent.tla", "holds"],
  // 0.1.1, before the fixes the model found.
  ["RaceBefore.cfg", "MCAppsViews.tla", "NoOrphanPages"],
  ["RaceBeforeDead.cfg", "MCAppsViews.tla", "NoDeadViews"],
  ["TrafficBefore.cfg", "MCAppsViews.tla", "GatedSends"],
  ["TrafficBeforeNo.cfg", "MCAppsViews.tla", "NoSendAfterNo"],
  // 0.1.2, before the fixes of 0.1.3 (the two windows 0.1.2 documented).
  ["WindowBefore.cfg", "MCAppsViews.tla", "SendsOnlyWhileUsed"],
  ["CancelBefore.cfg", "MCAppsViews.tla", "NoAnswerAfterNo"],
  ["InstanceBefore.cfg", "MCAppsViews.tla", "SameInstance"],
  // Generations without the one-at-a-time order of /open and /close: a late
  // /open of an earlier generation replaces the newer page, so the order stays.
  ["RaceGen.cfg", "MCAppsViews.tla", "NoDeadViews"],
  // Witnesses: each outcome the consent properties judge does happen.
  ["WitnessNothingRuns.cfg", "AppsConsent.tla", "NothingRuns"],
  ["WitnessNothingSent.cfg", "AppsConsent.tla", "NothingSent"],
  ["WitnessNothingOpens.cfg", "AppsConsent.tla", "NothingOpens"],
  ["WitnessNothingSaved.cfg", "AppsConsent.tla", "NothingSaved"],
];

const java = process.env.JAVA ?? "java";
const jar = process.env.TLA2TOOLS ?? path.join(HERE, "tla2tools.jar");
if (!fs.existsSync(jar)) {
  console.error(`no tla2tools.jar at ${jar} (set TLA2TOOLS)`);
  process.exit(2);
}
const LIMIT = Number(process.env.MODEL_STATE_MB ?? 150) * 1024 * 1024;
const only = process.argv.slice(2);

function size(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? size(at) : fs.statSync(at).size;
    } catch {}
  }
  return total;
}

function tlc(cfg, module, meta) {
  return new Promise((resolve) => {
    const child = spawn(java, ["-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", "auto", "-deadlock", "-metadir", meta, "-config", cfg, module], { cwd: HERE });
    let text = "";
    let tooBig = false;
    child.stdout.on("data", (d) => (text += d));
    child.stderr.on("data", (d) => (text += d));
    const watch = setInterval(() => {
      if (size(meta) > LIMIT) {
        tooBig = true;
        child.kill("SIGKILL");
      }
    }, 500);
    child.on("close", () => {
      clearInterval(watch);
      resolve({ text, tooBig });
    });
  });
}
let failed = 0;
for (const [cfg, module, expected] of RUNS) {
  if (only.length && !only.some((name) => cfg.startsWith(name))) continue;
  const meta = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-apps-tlc-"));
  const started = Date.now();
  const { text, tooBig } = await tlc(cfg, module, meta);
  fs.rmSync(meta, { recursive: true, force: true });
  // The last count TLC prints is the final one (progress lines come before it).
  const states = [...text.matchAll(/([\d,]+) distinct states found/g)].at(-1)?.[1]?.replaceAll(",", "") ?? "?";
  const depth = /depth of the complete state graph search is (\d+)/.exec(text)?.[1] ?? "?";
  const violated = /Invariant (\w+) is violated/.exec(text)?.[1];
  const holds = /Model checking completed\. No error has been found/.test(text);
  const got = tooBig ? "too big" : holds ? "holds" : violated ?? "error";
  const ok = got === expected;
  if (!ok) failed++;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${ok ? "ok  " : "FAIL"} ${cfg.padEnd(22)} ${got.padEnd(20)} ${states} states, depth ${depth}, ${seconds} s${ok ? "" : ` (expected ${expected})`}`);
  if (got === "error") console.log(text.split("\n").filter((line) => /Error|error|Exception/.test(line)).slice(0, 6).join("\n"));
}
process.exit(failed ? 1 : 0);
