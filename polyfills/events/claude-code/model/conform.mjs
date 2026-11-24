// Checks that the TLA+ models in this folder say what the Quint models say, on samples: Quint
// generates traces of wake.qnt, delivery.qnt and relay.qnt (random runs of each init, and the
// scenarios of `quint test`), and TLC replays every one in Wake.tla, Delivery.tla or Relay.tla. Each trace's first state
// must be an initial state there and each step a step of Next there, or TLC stops at the first
// one that is not and this prints it.
//
//   node model/conform.mjs [traces per init: default 300 of wake.qnt and relay.qnt, 40 of delivery.qnt]
//
// Needs Quint 0.34.0 (QUINT, default `npx --yes @informalsystems/quint@0.34.0`), Java and
// tla2tools.jar (JAVA, TLA2TOOLS, as for check.mjs). Works in a temporary folder, removed after.
// This samples one direction only: what Quint can do, TLA+ can do. For the other, each
// counterexample TLC found on 0.5.0's models was replayed as a scenario in the Quint file, and
// Quint reproduced it; the rest is by reading.

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const quint = process.env.QUINT ?? "npx --yes @informalsystems/quint@0.34.0";
const java = process.env.JAVA ?? "java";
const jar = process.env.TLA2TOOLS ?? path.join(HERE, "tla2tools.jar");
if (!fs.existsSync(jar)) {
  console.error(`no tla2tools.jar at ${jar} (set TLA2TOOLS)`);
  process.exit(2);
}
const perInit = process.argv[2] ? Number(process.argv[2]) : undefined;

// The Quint model, its TLA+ module, the variables, the constants Quint fixes (as TLC writes
// them), the constants a trace's first state gives (Quint's init variants), and the inits to sample.
const MODELS = [
  {
    qnt: "wake.qnt",
    module: "Wake",
    vars: ["s"],
    constants: { MAX_TIME: "9", HOUR: "3", GAP: "1", PER_HOUR: "2" },
    group: (state) => ({ label: state.s.fix ? "0.5.1" : "0.4.1", constants: { FIX: state.s.fix ? "TRUE" : "FALSE" } }),
    inits: ["init", "initBefore"],
    steps: 40,
    traces: 300,
  },
  {
    qnt: "delivery.qnt",
    module: "Delivery",
    vars: ["cfg", "now", "srv", "rly", "disk", "host", "mem", "hist"],
    constants: { N: "3", MAX_TIME: "7", FRESH: "1", SLACK: "2", MAX_SESSIONS: "3", MAX_SEQ: "9", MODES: '{"poll", "push", "webhook"}', EVILS: "{FALSE, TRUE}" },
    group: (state) => ({ label: state.cfg.fix ? "0.5.1" : "0.4.1", constants: { FIX: state.cfg.fix ? "TRUE" : "FALSE" } }),
    inits: ["poll", "push", "webhook", "webhookEvilRelay", "pollBefore", "pushBefore", "webhookBefore", "webhookEvilRelayBefore"],
    steps: 60,
    traces: 40,
  },
  {
    qnt: "relay.qnt",
    module: "Relay",
    vars: ["cfg", "open", "home", "box", "made", "shown", "accepted", "crossRefused", "crossRefusedOwn"],
    constants: { CAP: "2", MAX_EV: "3" },
    group: (state) => {
      const start = state.home["#map"].find(([server]) => server === "a")[1] === "p" ? "p" : "own";
      const label = state.cfg.perServer ? `0.7.0${state.cfg.drain ? "" : " without the drain"}, from ${start === "p" ? "the project's mailbox" : "each server's own"}` : "0.6.0";
      return { label, constants: { PER_SERVER: state.cfg.perServer ? "TRUE" : "FALSE", DRAIN: state.cfg.drain ? "TRUE" : "FALSE", START: JSON.stringify(start) } };
    },
    inits: ["init", "migrating", "initBefore", "migratingNoDrain"],
    steps: 30,
    traces: 300,
  },
];

// ITF (https://apalache-mc.org/docs/adr/015adr-trace.html) to a TLA+ value.
function tla(v) {
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `<<${v.map(tla).join(", ")}>>`;
  if ("#bigint" in v) return v["#bigint"];
  if ("#set" in v) return `{${v["#set"].map(tla).join(", ")}}`;
  if ("#tup" in v) return `<<${v["#tup"].map(tla).join(", ")}>>`;
  if ("#map" in v) return v["#map"].length ? `(${v["#map"].map(([k, x]) => `${tla(k)} :> ${tla(x)}`).join(" @@ ")})` : "<<>>";
  return `[${Object.entries(v).map(([k, x]) => `${k} |-> ${tla(x)}`).join(", ")}]`;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-events-conform-"));
let failed = 0;
try {
  for (const m of MODELS) {
    const out = path.join(work, m.module);
    fs.mkdirSync(out);
    const n = perInit ?? m.traces;
    for (const init of m.inits) {
      execSync(`${quint} run ${path.join(HERE, m.qnt)} --init ${init} --max-samples ${n} --n-traces ${n} --max-steps ${m.steps} --seed 7 --backend typescript --out-itf ${path.join(out, `run_${init}_{seq}.itf.json`)}`, { stdio: "ignore" });
    }
    execSync(`${quint} test ${path.join(HERE, m.qnt)} --max-samples 1 --seed 7 --backend typescript --out-itf ${path.join(out, "test_{test}_{seq}.itf.json")}`, { stdio: "ignore" });
    const traces = fs.readdirSync(out).filter((f) => f.endsWith(".itf.json")).sort().map((f) => ({ name: f, states: JSON.parse(fs.readFileSync(path.join(out, f), "utf8")).states }));
    // What Quint's init variants choose is a constant in TLA+ and a field of the state in Quint:
    // one TLC run for each set of values.
    const groups = new Map();
    for (const t of traces) {
      const g = m.group(t.states[0]);
      const key = JSON.stringify(g.constants);
      if (!groups.has(key)) groups.set(key, { ...g, traces: [] });
      groups.get(key).traces.push(t);
    }
    let count = 0;
    for (const { label, constants, traces: group } of groups.values()) {
      const name = `Conform${m.module}${++count}`;
      const state = (st) => `[${m.vars.map((x) => `${x} |-> ${tla(st[x])}`).join(", ")}]`;
      const same = (at) => m.vars.map((x) => `${x}${at.prime ? "'" : ""} = Traces[k][${at.i}].${x}`).join(" /\\ ");
      fs.writeFileSync(
        path.join(out, `${name}.tla`),
        `---- MODULE ${name} ----\nEXTENDS ${m.module}, TLC\nVARIABLES k, i\n` +
          `Traces == <<\n${group.map((t) => `<<${t.states.map(state).join(",\n")}>>`).join(",\n")}\n>>\n` +
          `TInit == k \\in 1..Len(Traces) /\\ i = 1 /\\ Init /\\ ${same({ i: 1 })}\n` +
          `TNext == \\/ /\\ i < Len(Traces[k]) /\\ Next /\\ ${same({ i: "i + 1", prime: true })} /\\ i' = i + 1 /\\ k' = k\n` +
          `         \\/ /\\ i = Len(Traces[k]) /\\ UNCHANGED <<${m.vars.join(", ")}, k, i>>\n====\n`,
      );
      fs.writeFileSync(path.join(out, `${name}.cfg`), `INIT TInit\nNEXT TNext\nCONSTANTS\n${Object.entries({ ...m.constants, ...constants }).map(([k, v]) => `    ${k} = ${v}`).join("\n")}\n`);
      fs.copyFileSync(path.join(HERE, `${m.module}.tla`), path.join(out, `${m.module}.tla`));
      // Deadlock checking on: a trace that stops matching leaves TLC in a state with no step.
      const meta = path.join(out, `meta-${name}`);
      const r = spawnSync(java, ["-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", "auto", "-metadir", meta, "-config", `${name}.cfg`, `${name}.tla`], { cwd: out, encoding: "utf8", maxBuffer: 1 << 28 });
      fs.rmSync(meta, { recursive: true, force: true });
      const text = r.stdout + r.stderr;
      // Each state of each trace is one state (k, i, ...) of this module: all of them reached, and
      // no deadlock, is every trace matched from its first state to its last.
      const reached = Number(/([\d,]+) distinct states found/.exec(text)?.[1]?.replace(/,/g, "") ?? -1);
      const states = group.reduce((n, t) => n + t.states.length, 0);
      const ok = /Model checking completed\. No error has been found/.test(text) && reached === states;
      console.log(`${ok ? "ok  " : "FAIL"} ${m.module} (${label}): ${group.length} Quint traces, ${states - group.length} steps${ok ? ", each a behaviour of the TLA+ model" : ""}`);
      if (!ok) {
        failed++;
        if (reached !== states) console.log(`  ${reached} of the traces' ${states} states reached (a first state that is not an initial state is never reached)`);
        const last = text.split("\n").filter((l) => /^\/\\ [ki] = /.test(l)).slice(-2).join(" ");
        if (last) console.log(`  the first step that is not one: ${last} (k: the trace, i: the state it got to)`);
        console.log(text.split("\n").filter((l) => /Error|error|Exception|deadlock/i.test(l)).slice(0, 6).join("\n"));
      }
    }
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
