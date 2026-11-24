// Which MCP server a name means, as Claude Code itself would use it, or why
// the helper won't connect to it. The same rules as the Rust helper's
// (helper-rs/src/config.rs), which says why each one is there:
//
// - names beginning `claude_ai_` or `plugin_` (claude.ai connectors and
//   plugins' servers, as Claude Code names them) are never taken from a file;
// - a managed MCP policy, or an allow or deny list in any settings file,
//   turns every server off;
// - a server switched off for this project stays off;
// - local scope and the project's `.mcp.json` only in a trusted folder, and a
//   `.mcp.json` entry only once approved and not rejected (the project's own
//   settings count as approval only where the folder's trust is its own);
// - the entry Claude Code would use decides (local, then project, then
//   user); when it is refused, no lower scope's entry stands in;
// - the parent claude's `--mcp-config` is used (alone under
//   `--strict-mcp-config`), but a name it shares with a config file is refused;
// - `${VAR}` is expanded only in an entry that passed, and a credential's
//   name never in a remote server's url or headers.
//
// No npm packages: the Node helper's tests import this file directly.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandWords, mcpConfigArgs } from "./platform.mjs";

/**
 * Credentials an environment carries whether or not any MCP server was meant
 * to have them (the mcp-events plugin's set, and this plugin's own): in a
 * remote server's url or headers they read as empty, a default after ":-"
 * ignored. To send a token to a server, keep it in a variable of your own.
 */
export const CREDENTIAL_VAR =
  /^(ANTHROPIC_|CLAUDE_|MCP_APPS_CLI_|MCP_EVENTS_|AWS_|AZURE_|ARM_|GOOGLE_|GCLOUD_|GCP_|CLOUDSDK_|VERTEX|BEDROCK|CLOUDFLARE_|CF_|DIGITALOCEAN_|HEROKU_|VERCEL_|NETLIFY_|FLY_|OPENAI_|GEMINI_|MISTRAL_|COHERE_|GROQ_|XAI_|HF_|HUGGING_?FACE|NPM_|NODE_AUTH_TOKEN|YARN_|PNPM_|PIP_|PYPI_|TWINE_|POETRY_|UV_|CARGO_|GEM_|BUNDLE_|DOCKER_|KUBE|SSH_|GPG_|GH_|GITHUB_|GITLAB_|BITBUCKET_|CI_|ACTIONS_|RUNNER_|SENTRY_|DATADOG_|DD_|STRIPE_|SLACK_|TWILIO_)|_PROXY$|^(ALL_PROXY|NO_PROXY|PGPASSWORD|MYSQL_PWD|DATABASE_URL|REDIS_URL)$/i;

const POLICY_KEYS = ["allowedMcpServers", "deniedMcpServers", "allowManagedMcpServersOnly", "managedMcpServers"];

/** Where the files Claude Code decides by are, for this machine. */
export function placesHere(project, env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const custom = env.CLAUDE_CONFIG_DIR || undefined;
  let user = "";
  try {
    user = os.userInfo().username;
  } catch {}
  return {
    project,
    claudeJson: custom ? path.join(custom, ".claude.json") : path.join(home, ".claude.json"),
    configDir: custom ?? path.join(home, ".claude"),
    managedDirs:
      process.platform === "darwin"
        ? ["/Library/Application Support/ClaudeCode"]
        : process.platform === "win32"
          ? ["C:\\Program Files\\ClaudeCode"]
          : ["/etc/claude-code"],
    managedPlists:
      process.platform === "darwin"
        ? ["/Library/Managed Preferences/com.anthropic.claudecode.plist", `/Library/Managed Preferences/${user}/com.anthropic.claudecode.plist`]
        : [],
  };
}

/** The words of the command line of the claude that started us. */
export function parentCommandWords() {
  try {
    const line =
      process.platform === "win32"
        ? execFileSync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.ppid}").CommandLine`],
            { encoding: "utf8", timeout: 10_000, windowsHide: true },
          )
        : execFileSync("ps", ["-ww", "-o", "args=", "-p", String(process.ppid)], { encoding: "utf8" });
    return commandWords(line.trim());
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

function setsPolicy(v, depth = 0) {
  if (!v || typeof v !== "object" || depth > 6) return false;
  return Object.entries(v).some(([k, x]) => POLICY_KEYS.includes(k) || setsPolicy(x, depth + 1));
}

function managedPolicy(places) {
  const holds = (file) => fs.existsSync(file) && (readJson(file) === undefined || setsPolicy(readJson(file)));
  for (const dir of places.managedDirs) {
    if (fs.existsSync(path.join(dir, "managed-mcp.json"))) return path.join(dir, "managed-mcp.json");
    if (holds(path.join(dir, "managed-settings.json"))) return path.join(dir, "managed-settings.json");
    try {
      for (const f of fs.readdirSync(path.join(dir, "managed-settings.d"))) {
        const drop = path.join(dir, "managed-settings.d", f);
        if (f.endsWith(".json") && holds(drop)) return drop;
      }
    } catch {}
  }
  for (const plist of places.managedPlists) if (fs.existsSync(plist)) return plist;
  const remote = path.join(places.configDir, "remote-settings.json");
  return holds(remote) ? remote : undefined;
}

/** How the helper reaches a server: http, sse or stdio. */
export function kindOf(config) {
  const type = typeof config?.type === "string" ? config.type : undefined;
  if (type === "http" || type === "streamable-http") return "http";
  if (type === "sse") return "sse";
  if (type !== undefined) return "stdio";
  return config?.url !== undefined ? "http" : "stdio";
}

/** `${NAME}` and `${NAME:-fallback}`; in a remote server's config a credential's name reads as empty. */
export function expandValue(value, remote, env) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) =>
      remote && CREDENTIAL_VAR.test(name) ? "" : (env[name] ?? fallback ?? ""),
    );
  }
  if (Array.isArray(value)) return value.map((v) => expandValue(v, remote, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandValue(v, remote, env)]));
  }
  return value;
}

const keysOf = (p) => [...new Set([p, p.replaceAll("\\", "/")])];

/**
 * The entry Claude Code would use for `name`: `{ config, scope }`, the config
 * expanded and `scope` one of "command line", "local", "project", "user".
 * Throws an Error saying why when there's none the helper may use.
 */
export function resolveServer(name, { places, own = [], parent = [], env = process.env, log = () => {} }) {
  if (name.startsWith("claude_ai_") || name.startsWith("plugin_")) {
    throw new Error(`"${name}" is how Claude Code names a claude.ai connector or a plugin's server, which no config file the helper reads defines`);
  }
  const policy = managedPolicy(places);
  if (policy) throw new Error(`your organisation manages which MCP servers are allowed (${policy}), and the helper can't judge that policy, so it connects to none`);
  const claude = readJson(places.claudeJson);
  const projects = claude?.projects && typeof claude.projects === "object" ? claude.projects : {};
  let real = places.project;
  try {
    real = fs.realpathSync(places.project);
  } catch {}
  const lookup = (p) => keysOf(p).map((k) => projects[k]).find((e) => e && typeof e === "object");
  const accepted = (p) => lookup(p)?.hasTrustDialogAccepted === true;
  const entry = lookup(places.project) ?? lookup(real) ?? {};
  const ownTrust = accepted(places.project) || accepted(real);
  const trusted =
    ownTrust ||
    [places.project, real].some((start) => {
      for (let at = start; ; at = path.dirname(at)) {
        if (accepted(at)) return true;
        if (path.dirname(at) === at) return false;
      }
    });
  const projectSettings = [readJson(path.join(places.project, ".claude", "settings.local.json")), readJson(path.join(places.project, ".claude", "settings.json"))];
  const userSettings = readJson(path.join(places.configDir, "settings.json"));
  if ([...projectSettings, userSettings].some((s) => s && POLICY_KEYS.some((k) => k in s))) {
    throw new Error("a settings file says which MCP servers are allowed or denied, and the helper can't apply such a list, so it connects to none");
  }
  if (names(entry.disabledMcpServers).includes(name)) throw new Error("it is switched off for this project in Claude Code");

  let command;
  for (const source of [...own, ...mcpConfigArgs(parent)]) {
    try {
      const text = source.trim().startsWith("{") ? source : fs.readFileSync(path.resolve(places.project, source), "utf8");
      const found = JSON.parse(text)?.mcpServers?.[name];
      if (command === undefined && found !== undefined) command = found;
    } catch (error) {
      log(`could not read MCP config ${source}: ${error.message}`);
    }
  }
  const strict = parent.includes("--strict-mcp-config");
  const own_ = (table) => (table && typeof table === "object" && Object.hasOwn(table, name) ? table[name] : undefined);
  const inFiles = strict
    ? []
    : [
        ["local", own_(entry.mcpServers)],
        ["project", own_(readJson(path.join(places.project, ".mcp.json"))?.mcpServers)],
        ["user", own_(claude?.mcpServers)],
      ];
  const expanded = (config, scope) => {
    const remote = kindOf(config) !== "stdio" || config?.url !== undefined;
    return { config: expandValue(config, remote, env), scope };
  };
  if (command !== undefined) {
    if (inFiles.some(([, found]) => found !== undefined)) {
      throw new Error("it is named both on Claude Code's command line (--mcp-config) and in a config file, and the helper can't be sure which one Claude Code uses");
    }
    return expanded(command, "command line");
  }
  const hit = inFiles.find(([, found]) => found !== undefined);
  if (!hit) throw new Error(`no config found for MCP server "${name}"`);
  const [scope, config] = hit;
  const untrusted = "this folder is not trusted in Claude Code, so neither its .mcp.json nor its local servers are used";
  if (scope === "local" && !trusted) throw new Error(untrusted);
  if (scope === "project") {
    if (!trusted) throw new Error(untrusted);
    const layers = [...(ownTrust ? projectSettings.filter(Boolean) : []), ...(userSettings ? [userSettings] : []), entry];
    const approveAll = layers.find((l) => typeof l.enableAllProjectMcpServers === "boolean")?.enableAllProjectMcpServers === true;
    if (layers.some((l) => names(l.disabledMcpjsonServers).includes(name))) throw new Error("it was rejected for this project in Claude Code");
    if (!approveAll && !layers.some((l) => names(l.enabledMcpjsonServers).includes(name))) {
      throw new Error("it is in this project's .mcp.json but not approved in Claude Code");
    }
  }
  return expanded(config, scope);
}
