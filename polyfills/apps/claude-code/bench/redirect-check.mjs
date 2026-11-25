// The helper's own MCP connections follow no redirect to another origin.
// A local "server" answers the helper's first request
// with a 307 or 308 to another local address, which records what reaches it;
// nothing may, the server's headers least of all. For streamable HTTP a
// redirect within the server's own origin is followed (so the check can
// tell); the older SSE transport follows none.
//
//   MCP_APPS_CLI_HELPER=<binary> node redirect-check.mjs   (the Rust helper)
//   node redirect-check.mjs                                (the Node helper)
//
// Prints PASS or FAIL per check; exits 1 on a failure.

import { spawn } from "./answer-checks.mjs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE_HELPER = path.join(HERE, "..", "mod", "helper", "helper.mjs");
const KEY = "synthetic-key-3e1";

let failed = 0;
const check = (label, ok, got) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${got === undefined ? "" : `: ${got}`}`);
};

/** A local HTTP server: what reaches it, and `answer` for each request. */
async function server(answer) {
  const seen = [];
  const s = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, key: req.headers["x-api-key"] });
      answer(req, res);
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${s.address().port}`, seen, close: () => s.close() };
}

const fail = (_req, res) => res.writeHead(500).end();

async function discover(servers) {
  const config = JSON.stringify({ mcpServers: servers });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-apps-redirect-"));
  const [cmd, args] = process.env.MCP_APPS_CLI_HELPER ? [process.env.MCP_APPS_CLI_HELPER, []] : [process.execPath, [NODE_HELPER]];
  const helper = spawn(cmd, [...args, "--mcp-config", config], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, MCP_APPS_CLI_STORAGE_DIR: "off" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const ready = await Promise.race([
    new Promise((resolve) =>
      helper.stdout.on("data", (d) => {
        buf += d;
        for (const line of buf.split("\n")) {
          try {
            const m = JSON.parse(line);
            if (m.type === "ready") resolve(m);
          } catch {}
        }
      }),
    ),
    new Promise((r) => setTimeout(() => r(null), 30_000)),
  ]);
  if (!ready) throw new Error("the helper never said it was ready");
  const post = (body) =>
    new Promise((resolve) => {
      const where = ready.socket ? { socketPath: ready.socket } : { host: "127.0.0.1", port: new URL(ready.url).port };
      const q = http.request({ ...where, path: "/discover", method: "POST", headers: { "x-mcp-apps-cli-token": ready.token } }, (r) => {
        let t = "";
        r.on("data", (c) => (t += c));
        r.on("end", () => {
          try {
            resolve(JSON.parse(t));
          } catch {
            resolve({ ok: false, error: t });
          }
        });
      });
      q.on("error", (e) => resolve({ ok: false, error: String(e) }));
      q.end(JSON.stringify(body));
    });
  const answers = {};
  for (const name of Object.keys(servers)) answers[name] = await post({ server: name });
  await new Promise((r) => setTimeout(r, 300));
  helper.kill("SIGTERM");
  fs.rmSync(home, { recursive: true, force: true });
  return answers;
}

console.log(`helper: ${process.env.MCP_APPS_CLI_HELPER ? path.basename(process.env.MCP_APPS_CLI_HELPER) : "helper.mjs (Node)"}`);

for (const type of ["http", "sse"]) {
  for (const status of [307, 308]) {
    const elsewhere = await server(fail);
    const first = await server((req, res) => res.writeHead(status, { location: `${elsewhere.origin}${req.url}` }).end());
    const answers = await discover({ redirected: { type, url: `${first.origin}/mcp`, headers: { "x-api-key": KEY } } });
    check(`${type}: a ${status} to another origin is not followed`, answers.redirected.ok === false && elsewhere.seen.length === 0, `${elsewhere.seen.length} request(s) there; ${String(answers.redirected.error ?? "").slice(0, 100)}`);
    check(`${type}: ... and the server's header never reaches it`, !elsewhere.seen.some((r) => r.key === KEY));
    check(`${type}: the server itself was asked (control)`, first.seen.length > 0 && first.seen[0].key === KEY);
    first.close();
    elsewhere.close();
  }
}
// Within its own origin, a streamable HTTP server's 307 is followed, its header with it.
{
  const same = await server((req, res) => (req.url.startsWith("/moved") ? fail(req, res) : res.writeHead(307, { location: "/moved" }).end()));
  await discover({ same: { type: "http", url: `${same.origin}/mcp`, headers: { "x-api-key": KEY } } });
  check("http: a 307 within the server's own origin is followed (control)", same.seen.some((r) => r.url === "/moved" && r.key === KEY), JSON.stringify(same.seen.map((r) => r.url)));
  same.close();
}

console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
