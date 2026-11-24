// Checks that SkillGate.tla says what skillGate.qnt says, on samples: Quint generates random
// traces of each instance (manifest, dynamic, rule030, lossy), and TLC replays every one in the
// TLA+ module with the same constants. Each trace's first state must be an initial state there
// and each step a step of Next there, or TLC stops at the first one that is not and this prints it.
//
//   node verification/conform.mjs [traces per instance, default 300]
//
// Needs Quint 0.34.0 (QUINT, default `npx --yes @informalsystems/quint@0.34.0`), Java and
// tla2tools.jar (JAVA, TLA2TOOLS, as for check.mjs). Works in a temporary folder, removed after.
// This samples one direction: what Quint can do, TLA+ can do. check.mjs also compares the states
// TLC reaches with the states verification/model.ts reaches, which covers both directions for
// the state of the gate.

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
const perInstance = Number(process.argv[2] ?? 300);
const VARS = ["st", "ev", "kept"];

// The instances at the end of skillGate.qnt, and their constants.
const INSTANCES = {
  manifest: { DYNAMIC: "FALSE", STICKY: "TRUE", LOSSY: "FALSE", NVERSIONS: "3" },
  dynamic: { DYNAMIC: "TRUE", STICKY: "TRUE", LOSSY: "FALSE", NVERSIONS: "3" },
  rule030: { DYNAMIC: "FALSE", STICKY: "FALSE", LOSSY: "FALSE", NVERSIONS: "3" },
  lossy: { DYNAMIC: "FALSE", STICKY: "TRUE", LOSSY: "TRUE", NVERSIONS: "3" },
};

// ITF (https://apalache-mc.org/docs/adr/015adr-trace.html) to a TLA+ value.
function tla(v) {
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `<<${v.map(tla).join(", ")}>>`;
  if ("#bigint" in v) return v["#bigint"];
  if ("#set" in v) return `{${v["#set"].map(tla).join(", ")}}`;
  if ("#tup" in v) return `<<${v["#tup"].map(tla).join(", ")}>>`;
  return `[${Object.entries(v).map(([k, x]) => `${k} |-> ${tla(x)}`).join(", ")}]`;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-skills-conform-"));
let failed = 0;
try {
  fs.copyFileSync(path.join(HERE, "SkillGate.tla"), path.join(work, "SkillGate.tla"));
  for (const [instance, constants] of Object.entries(INSTANCES)) {
    const out = path.join(work, instance);
    fs.mkdirSync(out);
    // Steps of up to 25, as docs/verification.md's simulation runs.
    execSync(`${quint} run ${path.join(HERE, "skillGate.qnt")} --main ${instance} --max-samples ${perInstance} --n-traces ${perInstance} --max-steps 25 --seed 7 --backend typescript --out-itf ${path.join(out, "run_{seq}.itf.json")}`, { stdio: "ignore" });
    // Quint names a variable by its instance (manifest::skillGate::st): the last part is its name.
    const traces = fs.readdirSync(out).filter((f) => f.endsWith(".itf.json")).sort().map((f) =>
      JSON.parse(fs.readFileSync(path.join(out, f), "utf8")).states.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== "#meta").map(([k, v]) => [k.split("::").pop(), v]))),
    );
    const name = `Conform_${instance}`;
    const state = (st) => `[${VARS.map((x) => `${x} |-> ${tla(st[x])}`).join(", ")}]`;
    const same = (i, prime) => VARS.map((x) => `${x}${prime ? "'" : ""} = Traces[k][${i}].${x}`).join(" /\\ ");
    fs.writeFileSync(
      path.join(work, `${name}.tla`),
      `---- MODULE ${name} ----\nEXTENDS SkillGate, Sequences, TLC\nVARIABLES k, i\n` +
        `Traces == <<\n${traces.map((t) => `<<${t.map(state).join(",\n")}>>`).join(",\n")}\n>>\n` +
        `TInit == k \\in 1..Len(Traces) /\\ i = 1 /\\ Init /\\ ${same(1)}\n` +
        `TNext == \\/ /\\ i < Len(Traces[k]) /\\ Next /\\ ${same("i + 1", true)} /\\ i' = i + 1 /\\ k' = k\n` +
        `         \\/ /\\ i = Len(Traces[k]) /\\ UNCHANGED <<${VARS.join(", ")}, k, i>>\n====\n`,
    );
    fs.writeFileSync(path.join(work, `${name}.cfg`), `INIT TInit\nNEXT TNext\nCONSTANTS\n${Object.entries(constants).map(([k, v]) => `    ${k} = ${v}`).join("\n")}\n`);
    // Deadlock checking on: a trace that stops matching leaves TLC in a state with no step.
    const meta = path.join(work, `meta-${name}`);
    const r = spawnSync(java, ["-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", "auto", "-metadir", meta, "-config", `${name}.cfg`, `${name}.tla`], { cwd: work, encoding: "utf8", maxBuffer: 1 << 28 });
    fs.rmSync(meta, { recursive: true, force: true });
    const text = r.stdout + r.stderr;
    // Each state of each trace is one state (k, i, ...) here: all of them reached, and no
    // deadlock, is every trace matched from its first state to its last.
    const reached = Number(/([\d,]+) distinct states found/.exec(text)?.[1]?.replace(/,/g, "") ?? -1);
    const states = traces.reduce((n, t) => n + t.length, 0);
    const ok = /Model checking completed\. No error has been found/.test(text) && reached === states;
    console.log(`${ok ? "ok  " : "FAIL"} ${instance}: ${traces.length} Quint traces, ${states - traces.length} steps${ok ? ", each a behaviour of SkillGate.tla" : ""}`);
    if (!ok) {
      failed++;
      if (reached !== states) console.log(`  ${reached} of the traces' ${states} states reached (a first state that is not an initial state is never reached)`);
      const last = text.split("\n").filter((l) => /^\/\\ [ki] = /.test(l)).slice(-2).join(" ");
      if (last) console.log(`  the first step that is not one: ${last} (k: the trace, i: the state it got to)`);
      console.log(text.split("\n").filter((l) => /Error|error|Exception|deadlock/i.test(l)).slice(0, 6).join("\n"));
    }
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
