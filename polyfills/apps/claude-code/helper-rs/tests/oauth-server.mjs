// A stand-in MCP server that needs sign-in (OAuth), for the sign-in tests;
// run with `node` from PATH. Standard library only.
//
//   node oauth-server.mjs <log> [seconds a token lasts, default 3600] [modern|legacy|dual|open, default dual]
//   node oauth-server.mjs browse <url>
//
// First form: the authorization server and the protected resource of the
// MCP authorization spec, in one process, on a loopback port it prints
// (`listening <port>`):
//   /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server,
//   POST /register (dynamic client registration), GET /authorize (approves
//   at once, S256 PKCE), POST /token (authorization_code and refresh_token;
//   a refresh token works once), and POST|DELETE /mcp, which answers 401
//   with a `WWW-Authenticate` naming the resource metadata unless the
//   request carries a token issued here and not ended. With one, it is an
//   MCP App's server: one tool whose `_meta.ui.resourceUri` is a `ui://`
//   resource. It serves revision 2026-07-28 only (modern: `server/discover`,
//   no `initialize`, each request naming the revision in its `_meta` and in
//   MCP-Protocol-Version), the 2025 revisions only (legacy: `initialize`),
//   or both (dual), answering as gate-server.mjs's revision servers do.
//   "open" is modern, but `server/discover` needs no token: the 401 comes
//   at the first request after it.
// Each request is appended to <log> as "<status> <method> <path> <bearer
// sent: yes|no> <JSON-RPC method or grant_type>", and one to /mcp with the
// revision its `_meta` names after that, or "-" for none.
// With OAUTH_NO_REVOKE set in the environment, it publishes no revocation endpoint.
// With OAUTH_ABOUT set, it describes itself: resource metadata with a name,
// documentation, policy and terms links and scopes, and an `initialize` that
// answers without a token with a serverInfo (title, description, website,
// an icon served at /icon.png).
// Second form: opens <url> the way a browser does (follows redirects).

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

if (process.argv[2] === "browse") {
  const answer = await fetch(process.argv[3]);
  console.log(`browsed ${answer.status}`);
  process.exit(answer.ok ? 0 : 1);
}

if (process.argv[2] === "consent") {
  // The person's browser at the consent page: reads it, then answers it, and
  // follows the redirects through the server's sign-in back to the helper.
  //   node oauth-server.mjs consent <page url> accept|refuse|forge
  const [, , , pageUrl, action] = process.argv;
  const page = await fetch(pageUrl);
  const html = await page.text();
  for (const needle of ["separate", "mcp-apps-cli-helper signout", "Accept", "Refuse", "MCP_APPS_CLI_TOKEN_STORE"]) {
    if (!html.includes(needle)) {
      console.log(`the page lacks "${needle}"`);
      process.exit(2);
    }
  }
  console.log(`page ${page.status} ${page.headers.get("content-security-policy")?.includes("default-src 'none'") ? "csp" : "no-csp"} saved:${/Saved in the macOS Keychain/.test(html) ? "keychain" : /Saved in a file protected/.test(html) ? "encrypted" : /Saved in a plain file/.test(html) ? "file" : "unsaid"} ${/name="store"|name="passphrase"/.test(html) ? "has-store-choice" : "no-store-choice"}`);
  console.log(`about ${/Permissions the server lists/.test(html) ? "scopes" : "no-scopes"} ${/<img class="icon" src="data:image\/png;base64,/.test(html) ? "icon" : "no-icon"} ${/Acme Docs/.test(html) ? "title" : "no-title"} ${/Privacy policy/.test(html) ? "links" : "no-links"}`);
  const token = /name="t" value="([^"]+)"/.exec(html)[1];
  const t = token;
  const post = (fields, headers = {}) =>
    fetch(new URL("/decision", pageUrl), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields) });
  if (action === "forge") {
    const wrong = await post({ t: "not-the-token", decision: "accept" });
    const foreign = await post({ t, decision: "accept" }, { origin: "https://evil.example" });
    console.log(`forged ${wrong.status} ${foreign.status}`);
    process.exit(wrong.status === 404 && foreign.status === 404 ? 0 : 1);
  }
  const answered = await post({ t: token, decision: action });
  const text = await answered.text();
  console.log(`answered ${answered.status} ${text.includes("Not signed in") ? "refused" : text.includes("Signed in") ? "signed-in" : text.slice(0, 200)}`);
  process.exit(0);
}

const [log, lasts = "3600", serves = "dual"] = process.argv.slice(2);
const MODERN = "2026-07-28";
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const modern = serves !== "legacy";
const legacy = serves === "legacy" || serves === "dual";
const VIEW = "ui://demo/view.html";
const serverInfo = { name: `oauth-${serves}`, version: "0" };
const codes = new Map(); // code -> { challenge, redirect }
const refresh = new Set();
const tokens = new Map(); // access token -> end (ms)
const registered = new Set();
const about = Boolean(process.env.OAUTH_ABOUT);
const ICON = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAMAAADVRocKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAkUExURQ92bhJ4cP///1igmmSmoYO4tCOBeqfNyjSLhNHl40mXkRF3b2M41LsAAAABYktHRAJmC3xkAAAAB3RJTUUH6gsbESc7/enhzQAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0xMS0yN1QxNzozOTo1OSswMDowML3eDowAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMTEtMjdUMTc6Mzk6NTkrMDA6MDDMg7YwAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTExLTI3VDE3OjM5OjU5KzAwOjAwm5aX7wAAAZFJREFUaN7t1tuOgzAMBFDAufP//7ssbVmwk1CSsbQP8WM8dDiqonaaxowZM2bMmOczL7NuAS2kDFh0CbQVaBJ+AaoE2gv0CC+AIoHeBVqED0CNQEeBDuEPoESgU4EG4QxQIdClAE+4AhQIxArQBA6AE0gUYAkSACZQpgBJyAGgBMoW4Ah5AJBAhQIUoQSAEahYgCGUASACVQoQhBoAQmAAgyaI3wE0gQHsZLEE/sJuclgCA/jtyCMJHBC2s4AkMEDcDyOOwAFpP004Ar/E6366wq4zB5j3uUERqPBBM4jAP8ceG4shcIA7Ng5C4AB/2nkEgQPCaRcABA6Il23sJ3BAumxTN0H8kK2XNb9szwkcYNjedBLmuze8DTwEWJGwXQTxfk5EXBeBA3wm4zsIAhAyodBB4ICYTcVmggCkbCw1E8S/0TUbE5ftW4IAmELQNBLo2+fmNoJ4zBajtokgAK4YdS0EAfCVsG8gCECohMNzggDEajw+JghAqsbTYwJ/oHDJPiMu23L/JYwZM2bMmP83Pxi2Ds5FxdiuAAAAAElFTkSuQmCC", "base64");

const issue = (res) => {
  const access = `at-${randomUUID()}`;
  const next = `rt-${randomUUID()}`;
  tokens.set(access, Date.now() + Number(lasts) * 1000);
  refresh.add(next);
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ access_token: access, token_type: "Bearer", expires_in: Number(lasts), refresh_token: next }));
};

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const origin = `http://${req.headers.host}`;
    const url = new URL(req.url, origin);
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    let what = "";
    const note = (status) => appendFileSync(log, `${status} ${req.method} ${url.pathname} ${bearer ? "yes" : "no"} ${what}\n`);
    const json = (status, value) => {
      note(status);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        ...(about ? { resource_name: "Acme Docs", resource_documentation: "https://docs.acme.example/mcp", resource_policy_uri: "https://acme.example/privacy", resource_tos_uri: "https://acme.example/terms", scopes_supported: ["docs:read", "docs:write", "openid"] } : {}),
      });
    }
    if (about && url.pathname === "/icon.png") {
      note(200);
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(ICON);
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        ...(process.env.OAUTH_NO_REVOKE ? {} : { revocation_endpoint: `${origin}/revoke` }),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      what = "register";
      const meta = JSON.parse(body);
      const client_id = `client-${registered.size + 1}`;
      registered.add(client_id);
      return json(201, { ...meta, client_id, token_endpoint_auth_method: "none" });
    }
    if (url.pathname === "/authorize") {
      what = "authorize";
      const q = url.searchParams;
      if (!registered.has(q.get("client_id")) || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return json(400, { error: "invalid_request" });
      const code = `code-${randomUUID()}`;
      codes.set(code, { challenge: q.get("code_challenge"), redirect: q.get("redirect_uri") });
      const back = new URL(q.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state"));
      note(302);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/revoke" && req.method === "POST") {
      // RFC 7009: the token named is ended, whichever kind it is.
      const form = new URLSearchParams(body);
      what = "revoke";
      tokens.delete(form.get("token"));
      refresh.delete(form.get("token"));
      return json(200, {});
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(body);
      what = form.get("grant_type") ?? "";
      if (what === "authorization_code") {
        const grant = codes.get(form.get("code"));
        codes.delete(form.get("code"));
        const proof = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (!grant || proof !== grant.challenge || form.get("redirect_uri") !== grant.redirect) return json(400, { error: "invalid_grant" });
        note(200);
        return issue(res);
      }
      if (what === "refresh_token") {
        if (!refresh.delete(form.get("refresh_token"))) return json(400, { error: "invalid_grant" });
        note(200);
        return issue(res);
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname !== "/mcp") return json(404, {});
    let message;
    try {
      message = req.method === "POST" ? JSON.parse(body) : undefined;
    } catch {
      return json(400, {});
    }
    const meta = message?.params?._meta ?? {};
    const envelope = meta["io.modelcontextprotocol/protocolVersion"] ?? null;
    if (message) what = `${message.method} ${envelope ?? "-"}`;
    if (about && message?.method === "initialize" && !bearer) {
      note(200);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: LEGACY[0], capabilities: {}, serverInfo: { name: "acme-docs", title: "Acme Docs", version: "1", description: "Search the Acme documentation.", websiteUrl: "https://acme.example/", icons: [{ src: `${origin}/icon.png`, mimeType: "image/png", sizes: ["96x96"] }] } } }));
    }
    const live = tokens.has(bearer) && tokens.get(bearer) > Date.now();
    if (!live && !(serves === "open" && message?.method === "server/discover")) {
      note(401);
      res.writeHead(401, {
        "www-authenticate": `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        "content-type": "application/json",
      });
      return res.end(JSON.stringify({ error: "invalid_token" }));
    }
    if (req.method === "DELETE") return json(200, {});
    if (req.method !== "POST") return json(405, {});
    if (message.id === undefined) {
      note(202);
      res.writeHead(202);
      return res.end();
    }
    const fail = (code, text, data) => json(200, { jsonrpc: "2.0", id: message.id, error: { code, message: text, ...(data ? { data } : {}) } });
    // A 2026-07-28 result carries its type, how long it may be cached and
    // for whom, and who the server is.
    const answer = (result) =>
      json(200, {
        jsonrpc: "2.0",
        id: message.id,
        result: envelope ? { ...result, resultType: "complete", ttlMs: 0, cacheScope: "private", _meta: { "io.modelcontextprotocol/serverInfo": serverInfo } } : result,
      });
    if (message.method === "initialize") {
      const asked = message.params?.protocolVersion;
      if (!legacy) return fail(-32022, `Unsupported protocol version: ${asked}`, { supported: [MODERN], requested: asked });
      return json(200, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0], capabilities: { tools: {}, resources: {} }, serverInfo } });
    }
    if (envelope !== null) {
      if (!modern) return json(400, { jsonrpc: "2.0", id: null, error: { code: -32000, message: `Bad Request: Unsupported protocol version: ${envelope}` } });
      if (envelope !== MODERN || req.headers["mcp-protocol-version"] !== MODERN) return fail(-32022, `Unsupported protocol version: ${envelope}`, { supported: [MODERN], requested: envelope });
    } else if (!legacy) {
      return fail(-32022, "Unsupported protocol version: none", { supported: [MODERN] });
    }
    switch (message.method) {
      case "server/discover":
        return modern ? answer({ supportedVersions: [MODERN], capabilities: { tools: {}, resources: {} } }) : fail(-32601, "Method not found");
      case "tools/list":
        return answer({ tools: [{ name: "show", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: VIEW } } }] });
      case "resources/read":
        return answer({ contents: [{ uri: message.params?.uri, mimeType: "text/html;profile=mcp-app", text: "<!doctype html><p>signed-in view</p>" }] });
      default:
        return fail(-32601, "Method not found");
    }
  });
});
server.listen(0, "127.0.0.1", () => console.log(`listening ${server.address().port}`));
