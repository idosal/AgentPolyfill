// The bench drives the helper without the mod, so it answers what the mod
// would: from 0.1.3 the helper asks Claude Code's verdict (through the mod)
// before each request it writes to an MCP server, a `check` line on its
// stdout (helper-rs/src/verdict.rs). This `spawn` is node's, and answers each
// check of the child it starts with a yes, as the mod does for a server
// Claude Code uses. A child that never says the helper's ready line is left
// alone.
import { spawn as spawnChild } from "node:child_process";
import http from "node:http";

export function spawn(...args) {
  const child = spawnChild(...args);
  let buf = "";
  let ready;
  child.stdout?.on("data", (d) => {
    buf += d;
    let k;
    while ((k = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, k);
      buf = buf.slice(k + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m?.type === "ready") ready = m;
      if (m?.type === "check" && ready) reply(ready, { id: m.id, result: { allow: true, epoch: 0 } });
    }
  });
  return child;
}

function reply(ready, body) {
  const where = ready.socket ? { socketPath: ready.socket } : { host: "127.0.0.1", port: new URL(ready.url).port };
  const data = JSON.stringify(body);
  const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-mcp-apps-cli-token": ready.token };
  const q = http.request({ ...where, path: "/reply", method: "POST", headers }, (r) => r.resume());
  q.on("error", () => {});
  q.end(data);
}
