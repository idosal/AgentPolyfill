// Model-checks SkillGate.tla (skillGate.qnt in TLA+) with TLC, each configuration against what
// it should give: every invariant holds, or the one named is violated (0.3.0's rule, and the
// documented read-back limit). The *States configurations count the states of the gate alone,
// and that count must equal what verification/model.ts reaches with the same bound.
//
//   node verification/check.mjs [--trace] [name ...]
//
// Needs Java and tla2tools.jar: JAVA (or java on PATH) and TLA2TOOLS (or tla2tools.jar beside
// this file). JAVA_OPTS is passed to Java, MODEL_WORKERS to TLC (default 1). TLC's state files go
// to a temporary folder (TMPDIR), removed after each run; a run whose state passes MODEL_STATE_MB
// (300 MB) is stopped and counts as failed. --trace prints the steps of each violation found.
// Exit 0 when every configuration gave what it should. Node 22.18 or later (it imports model.ts).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// [configuration, expected, the model.ts bound whose state count it must match]
const RUNS = [
  ["Manifest.cfg", "holds"],
  ["Dynamic.cfg", "holds"],
  ["Manifest4.cfg", "holds"],
  ["Dynamic4.cfg", "holds"],
  ["Rule030.cfg", "Gate"],
  ["Lossy.cfg", "Gate"],
  ["ManifestStates.cfg", "holds", { dynamic: false, versions: 3 }],
  ["DynamicStates.cfg", "holds", { dynamic: true, versions: 3 }],
  ["Manifest4States.cfg", "holds", { dynamic: false, versions: 4 }],
  ["Dynamic4States.cfg", "holds", { dynamic: true, versions: 4 }],
];

const java = process.env.JAVA ?? "java";
const jar = process.env.TLA2TOOLS ?? path.join(HERE, "tla2tools.jar");
if (!fs.existsSync(jar)) {
  console.error(`no tla2tools.jar at ${jar} (set TLA2TOOLS)`);
  process.exit(2);
}
const LIMIT = Number(process.env.MODEL_STATE_MB ?? 300) * 1024 * 1024;
const javaOpts = (process.env.JAVA_OPTS ?? "").split(/\s+/).filter(Boolean);
const showTrace = process.argv.includes("--trace");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));

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

function tlc(cfg, meta, workers) {
  return new Promise((resolve) => {
    const child = spawn(java, [...javaOpts, "-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", workers, "-deadlock", "-metadir", meta, "-config", cfg, "SkillGate.tla"], { cwd: HERE });
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

const number = (re, text) => re.exec(text)?.[1] ?? "?";
let failed = 0;
for (const [cfg, expected, bound] of RUNS) {
  if (only.length && !only.some((name) => cfg.startsWith(name))) continue;
  const meta = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-skills-tlc-"));
  const started = Date.now();
  // One worker (unless MODEL_WORKERS says otherwise): TLC's search is then breadth first exactly,
  // so a violation comes with a shortest trace, and the depth and counts are the same every run.
  const { text, tooBig } = await tlc(cfg, meta, process.env.MODEL_WORKERS ?? "1");
  fs.rmSync(meta, { recursive: true, force: true });
  // The last summary TLC prints (progress lines put a rate in brackets after each number).
  const summary = [...text.matchAll(/([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue/g)].pop();
  const generated = summary?.[1] ?? "?";
  const distinct = summary?.[2] ?? "?";
  const depth = number(/depth of the complete state graph search is (\d+)/, text);
  const violated = /Invariant (\w+) is violated/.exec(text)?.[1];
  const holds = /Model checking completed\. No error has been found/.test(text);
  let got = tooBig ? "too big" : holds ? "holds" : violated ?? "error";
  let note = "";
  if (bound && got === "holds") {
    const { explore } = await import("./model.ts");
    const theirs = explore({ dynamic: bound.dynamic, sticky: true, lossyReadback: false, versions: bound.versions }).states;
    const same = theirs === Number(distinct.replace(/,/g, ""));
    note = same ? `, the same as model.ts` : `, model.ts: ${theirs.toLocaleString("en-US")}`;
    if (!same) got = "a different count";
  }
  const ok = got === expected;
  if (!ok) failed++;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${ok ? "ok  " : "FAIL"} ${cfg.padEnd(20)} ${got.padEnd(6)} ${distinct} distinct states${note} (${generated} generated), depth ${depth}, ${seconds} s${ok ? "" : ` (expected ${expected})`}`);
  if (violated && (showTrace || !ok)) {
    const steps = [...text.matchAll(/^State \d+: <(\w+)/gm)].map((m) => m[1]);
    console.log(`     ${steps.join(", ")}`);
  }
  if (got === "error") console.log(text.split("\n").filter((line) => /Error|error|Exception/.test(line)).slice(0, 6).join("\n"));
}
process.exit(failed ? 1 : 0);
