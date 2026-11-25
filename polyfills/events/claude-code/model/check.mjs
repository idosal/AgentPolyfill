// Model-checks the TLA+ models in this folder (Wake.tla, Delivery.tla, Relay.tla, WakeCodex.tla,
// WakeHermes.tla (TLA+ only):
// wake.qnt, delivery.qnt, relay.qnt and wakeCodex.qnt in TLA+) with TLC, each configuration against
// what it should give: every invariant it names holds, or the one named is violated (a defect of an
// earlier version that must still be found, a defect found and not yet fixed, a documented limit,
// or a variant with a protection taken out).
//
//   node model/check.mjs [--trace] [name ...]
//
// Needs Java and tla2tools.jar: JAVA (or java on PATH) and TLA2TOOLS (or tla2tools.jar beside
// this file). JAVA_OPTS is passed to Java (the heap, TLC's queue), MODEL_WORKERS to TLC (default
// 1). TLC's state files go to a temporary folder (TMPDIR), removed after each run; a run whose
// state passes MODEL_STATE_MB (300 MB) is stopped and counts as failed. --trace prints the steps
// of each violation found. Exit 0 when every configuration gave what it should.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// [configuration, module, expected]: "holds", or the invariant TLC must find violated.
const RUNS = [
  // wake.qnt, 0.5.1
  ["WakeKept.cfg", "MCWake.tla", "holds"],
  // delivery.qnt, 0.5.1
  ["Poll.cfg", "MCDelivery.tla", "holds"],
  ["Push.cfg", "MCDelivery.tla", "holds"],
  ["Webhook.cfg", "MCDelivery.tla", "holds"],
  ["WebhookTwo.cfg", "MCDelivery.tla", "holds"],
  ["WebhookLying.cfg", "MCDelivery.tla", "holds"],
  // Where TLC found violations on 0.5.0's models (README.md): each holds in 0.5.1.
  ["WakeNotice.cfg", "MCWake.tla", "holds"],
  ["PollSeenForgotten.cfg", "MCDelivery.tla", "holds"],
  ["PushSeenForgotten.cfg", "MCDelivery.tla", "holds"],
  ["WebhookSeenForgotten.cfg", "MCDelivery.tla", "holds"],
  ["PollCarriedTwice.cfg", "MCDelivery.tla", "holds"],
  // relay.qnt, 0.7.0: one mailbox per MCP server
  ["RelayOwn.cfg", "Relay.tla", "holds"],
  ["RelayMigrating.cfg", "Relay.tla", "holds"],
  // Documented limits: AtMostOnce's one exception is reachable; a watch not yet moved to its
  // server's own mailbox is still in the shared one.
  ["Strict.cfg", "MCDelivery.tla", "StrictAtMostOnce"],
  ["RelayMigratingShared.cfg", "Relay.tla", "NoCrossRefusal"],
  // A variant without the drain: the check must see what the drain is for.
  ["RelayNoDrain.cfg", "Relay.tla", "NothingLost"],
  // 0.4.1, the defects the Quint scenarios show: TLC must find each.
  ["WakeBefore.cfg", "MCWake.tla", "Gap"],
  ["WakeBeforeHour.cfg", "MCWake.tla", "WithinHour"],
  ["WakeBeforeNotice.cfg", "MCWake.tla", "OneNotice"],
  ["PollBefore.cfg", "MCDelivery.tla", "AtMostOnce"],
  ["PushBeforeStored.cfg", "MCDelivery.tla", "AtMostOnce"],
  ["PollBeforeStranded.cfg", "MCDelivery.tla", "NoneStranded"],
  ["WebhookBeforeB1.cfg", "MCDelivery.tla", "NoAckBeforeStore"],
  ["WebhookBeforeB1Cursor.cfg", "MCDelivery.tla", "CursorSafe"],
  // 0.6.0: one mailbox for a project's watches.
  ["RelayShared.cfg", "Relay.tla", "NoCrossRefusal"],
  // wakeCodex.qnt, mcp-events for Codex 0.1.3 (README.md, "wakeCodex.qnt").
  ["WakeCodexKept.cfg", "MCWakeCodex.tla", "holds"],
  ["WakeCodexLong.cfg", "MCWakeCodex.tla", "holds"],
  // 0.1.2 without the one step TLC found its violations through.
  ["WakeCodexHeard.cfg", "MCWakeCodex.tla", "holds"],
  // Found in 0.1.2, fixed in 0.1.3: a wake codex queue took and the helper never heard of goes
  // uncounted and is handed over again; a notice codex queue did not take pauses a new helper.
  ["WakeCodexHour.cfg", "MCWakeCodex.tla", "WithinHour"],
  ["WakeCodexGap.cfg", "MCWakeCodex.tla", "Gap"],
  ["WakeCodexTwice.cfg", "MCWakeCodex.tla", "AtMostOnce"],
  ["WakeCodexStale.cfg", "MCWakeCodex.tla", "NoStalePause"],
  // Documented limits: delivery is at most once (a batch the helper never heard back about is
  // counted as handed over); a session codex queue cannot reach is tried once more by a new helper.
  ["WakeCodexSkipped.cfg", "MCWakeCodex.tla", "NothingLost"],
  ["WakeCodexRetried.cfg", "MCWakeCodex.tla", "NeverRetried"],
  // 0.1.0's rule and pause, and a pause that lifts too soon: the check must see what each is for.
  ["WakeCodexBefore.cfg", "MCWakeCodex.tla", "OnlyThePerson"],
  ["WakeCodexBeforeHour.cfg", "MCWakeCodex.tla", "WithinHour"],
  ["WakeCodexShortLift.cfg", "MCWakeCodex.tla", "WithinHour"],
  // WakeHermes.tla, mcp-events for Hermes 0.1.0 (README.md, "WakeHermes.tla").
  ["WakeHermesKept.cfg", "MCWakeHermes.tla", "holds"],
  ["WakeHermesDrops.cfg", "MCWakeHermes.tla", "holds"],
  // Documented limits: a message the gateway took and dropped; turns another plugin or Hermes
  // starts count as the person's; delivery is at most once.
  ["WakeHermesDropped.cfg", "MCWakeHermes.tla", "OnlyUnheardNotDropped"],
  ["WakeHermesOthers.cfg", "MCWakeHermes.tla", "OnlyThePerson"],
  ["WakeHermesOthersHour.cfg", "MCWakeHermes.tla", "WithinHour"],
  ["WakeHermesSkipped.cfg", "MCWakeHermes.tla", "NothingLost"],
  // The write-ahead record taken out: the check must see what it is for.
  ["WakeHermesNoRecord.cfg", "MCWakeHermes.tla", "WithinHour"],
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

function tlc(cfg, module, meta, workers) {
  return new Promise((resolve) => {
    const child = spawn(java, [...javaOpts, "-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", workers, "-deadlock", "-metadir", meta, "-config", cfg, module], { cwd: HERE });
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
for (const [cfg, module, expected] of RUNS) {
  if (only.length && !only.some((name) => cfg.startsWith(name))) continue;
  const meta = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-events-tlc-"));
  const started = Date.now();
  // One worker (unless MODEL_WORKERS says otherwise): TLC's search is then breadth first exactly,
  // so a violation comes with a shortest trace, and the depth and counts are the same every run.
  const { text, tooBig } = await tlc(cfg, module, meta, process.env.MODEL_WORKERS ?? "1");
  fs.rmSync(meta, { recursive: true, force: true });
  // The last summary TLC prints (progress lines put a rate in brackets after each number).
  const summary = [...text.matchAll(/([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue/g)].pop();
  const generated = summary?.[1] ?? "?";
  const distinct = summary?.[2] ?? "?";
  const depth = number(/depth of the complete state graph search is (\d+)/, text);
  const violated = /Invariant (\w+) is violated/.exec(text)?.[1];
  const holds = /Model checking completed\. No error has been found/.test(text);
  const got = tooBig ? "too big" : holds ? "holds" : violated ?? "error";
  const ok = got === expected;
  if (!ok) failed++;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${ok ? "ok  " : "FAIL"} ${cfg.padEnd(26)} ${got.padEnd(17)} ${distinct} distinct states (${generated} generated), depth ${depth}, ${seconds} s${ok ? "" : ` (expected ${expected})`}`);
  if (violated && (showTrace || !ok)) {
    const steps = [...text.matchAll(/^State \d+: <(\w+)/gm)].map((m) => m[1]);
    console.log(`     ${steps.join(", ")}`);
  }
  if (got === "error") console.log(text.split("\n").filter((line) => /Error|error|Exception/.test(line)).slice(0, 6).join("\n"));
}
process.exit(failed ? 1 : 0);
