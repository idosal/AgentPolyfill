// Stand-in MCP servers for gate.rs, run with `node` from PATH, so the gate
// tests run alike on macOS, Linux and Windows. Standard library only.
//
//   node gate-server.mjs marker <file>
//     Writes "ran" to <file> as soon as it starts, then waits a second: a
//     server whose start the test can see (a planted one must never write it).
//   node gate-server.mjs probe <log> <answer|hang>
//     A stdio MCP server that appends "start <pid>" to <log> when it starts
//     and each method it is sent; "hang" leaves tools/list unanswered.

import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [mode, file, how] = process.argv.slice(2);

if (mode === "marker") {
  writeFileSync(file, "ran\n");
  setTimeout(() => {}, 1000);
} else if (mode === "probe") {
  const log = (line) => appendFileSync(file, `${line}\n`);
  log(`start ${process.pid}`);
  createInterface({ input: process.stdin }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const method = typeof message.method === "string" ? message.method : "";
    log(method);
    if (!("id" in message)) return;
    let result;
    if (method === "initialize") {
      result = {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "probe", version: "0" },
      };
    } else if (method === "tools/list" && how === "hang") {
      return;
    } else if (method === "tools/list") {
      result = { tools: [{ name: "t", inputSchema: { type: "object" } }] };
    } else {
      result = {};
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  });
} else {
  console.error("usage: node gate-server.mjs marker <file> | probe <log> <answer|hang>");
  process.exit(2);
}
