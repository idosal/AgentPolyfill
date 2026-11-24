// Which MCP servers to look for events on.
//
// By default the servers Claude Code itself is configured with: the project's
// `.mcp.json` (shared scope), and from `~/.claude.json` the user scope and this
// project's local scope. This plugin opens its own connection to each, so it
// must not reach further than Claude Code would:
//
//   - a server from the project's `.mcp.json` is used only in a folder Claude Code
//     has marked trusted, and only once it is approved there (one by one, or all
//     at once with `enableAllProjectMcpServers`) and not rejected;
//   - a server switched off for this project in Claude Code stays off here;
//   - `${VAR}` and `${VAR:-default}` are expanded as Claude Code expands them, except
//     that credentials the environment happens to carry are never put in a remote
//     server's address or headers. Claude Code does the same for a set of names it
//     does not publish in full, so the set here is wider on purpose: to send a token,
//     keep it in a variable with a name of your own;
//   - a server's `headersHelper` (a command of the user's that prints the headers to send) is
//     run the way Claude Code documents it, and for a server from the project's `.mcp.json` or
//     this project's local scope only in a folder Claude Code has marked trusted;
//   - where anything says which MCP servers are allowed or denied (a managed policy
//     in any of the places Claude Code reads one, or an allow or deny list in a
//     settings file), discovery is off, because this plugin cannot judge that policy.
//     On Windows a policy in the registry is not visible to it.
//
// Narrow it with:
//   MCP_EVENTS_CONFIG   a file of your own ({ "mcpServers": {...} } or { "servers": {...} }),
//                       used instead of Claude Code's config. It must be outside the project
//                       folder: a project can set environment variables, and may not use
//                       this one to approve servers of its own
//   MCP_EVENTS_SOURCES  which of project,local,user to read (default all three)
//   MCP_EVENTS_SERVERS  only these server names (comma-separated)
//   MCP_EVENTS_SKIP     never these server names

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isHttp, type HeadersHelper, type ServerTable, type UpstreamConfig } from '../../core/src/upstream.ts';

// The shapes of a server's configuration are shared with the Codex form (polyfills/events/core).
export { isHttp };
export type { HeadersHelper, HttpUpstream, ServerTable, StdioUpstream, UpstreamConfig } from '../../core/src/upstream.ts';
export type DiscoverOptions = {
    /** Where managed settings live (for tests; the default is the platform's own place). */
    managedDirs?: string[];
    /** macOS managed-preferences files for Claude Code (for tests). */
    managedPlists?: string[];
};

/** This plugin's own MCP server listed in a config file: connecting to it would loop. */
function isSelf(arg: string): boolean {
    return /mcp-events(?:-plugin)?(?:[\\/][^\\/]+)?[\\/](?:src[\\/]main\.ts|dist[\\/]main\.js)$/.test(arg);
}

/**
 * Credentials an environment carries whether or not any MCP server was meant to have them: Claude's
 * own, this plugin's, cloud providers', model providers', package registries', source hosts', CI's,
 * and proxies (whose addresses often hold a password). In a remote server's address or headers
 * these read as empty, and a default after ":-" is ignored. Claude Code has such a set too and
 * publishes only examples of it, so this one is drawn wide: where they differ, this is the stricter.
 */
const CREDENTIAL_VAR =
    /^(ANTHROPIC_|CLAUDE_|MCP_EVENTS_|AWS_|AZURE_|ARM_|GOOGLE_|GCLOUD_|GCP_|CLOUDSDK_|VERTEX|BEDROCK|CLOUDFLARE_|CF_|DIGITALOCEAN_|HEROKU_|VERCEL_|NETLIFY_|FLY_|OPENAI_|GEMINI_|MISTRAL_|COHERE_|GROQ_|XAI_|HF_|HUGGING_?FACE|NPM_|NODE_AUTH_TOKEN|YARN_|PNPM_|PIP_|PYPI_|TWINE_|POETRY_|UV_|CARGO_|GEM_|BUNDLE_|DOCKER_|KUBE|SSH_|GPG_|GH_|GITHUB_|GITLAB_|BITBUCKET_|CI_|ACTIONS_|RUNNER_|SENTRY_|DATADOG_|DD_|STRIPE_|SLACK_|TWILIO_)|_PROXY$|^(ALL_PROXY|NO_PROXY|PGPASSWORD|MYSQL_PWD|DATABASE_URL|REDIS_URL)$/i;

/** Expands `${VAR}` and `${VAR:-default}`. A variable that is unset with no default is left as written and noted in `missing`. */
export function expandEnv(text: string, env: NodeJS.ProcessEnv, o: { remote?: boolean; missing?: Set<string> } = {}): string {
    return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name: string, fallback: string | undefined) => {
        if (o.remote && CREDENTIAL_VAR.test(name)) return '';
        const value = env[name];
        if (value !== undefined) return value;
        if (fallback !== undefined) return fallback;
        o.missing?.add(name);
        return whole;
    });
}

function expandAll(v: unknown, env: NodeJS.ProcessEnv, o: { remote?: boolean; missing: Set<string> }): Record<string, string> | undefined {
    if (typeof v !== 'object' || v === null) return undefined;
    return Object.fromEntries(
        Object.entries(v)
            .filter((e): e is [string, string] => typeof e[1] === 'string')
            .map(([k, x]) => [k, expandEnv(x, env, o)])
    );
}

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/;
/** A reason to leave a named server out, or nothing. */
type Gate = (name: string) => string | undefined;

export type HelperRule = {
    /** Where a `headersHelper` runs: the project folder for project and local servers, Claude Code's config folder otherwise. */
    cwd: string;
    fromRepo?: boolean;
    /** A reason not to run helpers from this source (an untrusted folder), or nothing. */
    refuse?: string;
};

export function parseServers(table: unknown, baseDir: string, out: ServerTable = { servers: {}, skipped: {} }, env: NodeJS.ProcessEnv = process.env, gate?: Gate, helpers?: HelperRule): ServerTable {
    if (typeof table !== 'object' || table === null) return out;
    for (const [name, value] of Object.entries(table as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) continue;
        // A name is repeated in this plugin's instructions and tool results: it has to look like one.
        if (!SERVER_NAME.test(name)) continue;
        const v = value as Record<string, unknown>;
        const leave = (why: string) => {
            // The entry from the highest scope decides: a lower scope's server of the same name does not stand in for it.
            delete out.servers[name];
            out.skipped[name] = why;
        };
        const refused = gate?.(name);
        if (refused) {
            leave(refused);
            continue;
        }
        const type = typeof v.type === 'string' ? v.type : undefined;
        const missing = new Set<string>();
        let cfg: UpstreamConfig;
        if (typeof v.command === 'string') {
            const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string') : [];
            if ([v.command, ...args].some(isSelf)) continue; // ourselves, from source or from an installed bundle
            cfg = { command: expandEnv(v.command, env, { missing }), args: args.map((a) => expandEnv(a, env, { missing })), env: expandAll(v.env, env, { missing }), cwd: typeof v.cwd === 'string' ? resolve(baseDir, v.cwd) : undefined };
        } else if (typeof v.url === 'string' && (type === undefined || type === 'http' || type === 'streamable-http')) {
            let headersHelper: HeadersHelper | undefined;
            if (v.headersHelper !== undefined) {
                if (typeof v.headersHelper !== 'string' || !v.headersHelper.trim()) {
                    leave('its headersHelper is not a command');
                    continue;
                }
                if (helpers?.refuse) {
                    leave(helpers.refuse);
                    continue;
                }
                headersHelper = { command: v.headersHelper, cwd: helpers?.cwd ?? baseDir, fromRepo: helpers?.fromRepo === true };
            }
            cfg = { url: expandEnv(v.url, env, { remote: true, missing }), headers: expandAll(v.headers, env, { remote: true, missing }), ...(headersHelper ? { headersHelper } : {}) };
        } else {
            leave('its transport is not supported (only stdio and streamable HTTP are)');
            continue;
        }
        if (missing.size) {
            leave(`it needs the environment variable${missing.size > 1 ? 's' : ''} ${[...missing].join(', ')}`);
            continue;
        }
        delete out.skipped[name];
        out.servers[name] = cfg;
    }
    return out;
}

function readJson(path: string): Record<string, unknown> | undefined {
    try {
        const j = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        return typeof j === 'object' && j !== null && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function defaultManagedDirs(): string[] {
    if (process.platform === 'darwin') return ['/Library/Application Support/ClaudeCode'];
    if (process.platform === 'win32') return ['C:\\Program Files\\ClaudeCode'];
    return ['/etc/claude-code'];
}

const POLICY_KEYS = ['allowedMcpServers', 'deniedMcpServers', 'allowManagedMcpServersOnly', 'managedMcpServers'];
/** Whether a settings object (or anything nested in it: a cached policy has its own wrapping) says which MCP servers may be used. */
function setsMcpPolicy(v: unknown, depth = 0): boolean {
    if (typeof v !== 'object' || v === null || depth > 6) return false;
    return Object.entries(v).some(([k, x]) => POLICY_KEYS.includes(k) || setsMcpPolicy(x, depth + 1));
}

/**
 * Where an MCP policy was found, if one was: a managed file or drop-in, the managed-MCP file, a
 * macOS managed-preferences file for Claude Code (its contents are not read: its presence is
 * enough), or policy fetched from the organisation and kept in the user's config folder.
 */
function managedMcpPolicy(dirs: string[], configDir: string, o: DiscoverOptions): string | undefined {
    for (const dir of dirs) {
        if (existsSync(join(dir, 'managed-mcp.json'))) return join(dir, 'managed-mcp.json');
        // A managed file that is there but cannot be read as JSON is taken to hold a policy (it might).
        const managed = join(dir, 'managed-settings.json');
        if (existsSync(managed) && (readJson(managed) === undefined || setsMcpPolicy(readJson(managed)))) return managed;
        try {
            for (const f of readdirSync(join(dir, 'managed-settings.d'))) {
                const drop = join(dir, 'managed-settings.d', f);
                if (f.endsWith('.json') && (readJson(drop) === undefined || setsMcpPolicy(readJson(drop)))) return drop;
            }
        } catch {
            // no drop-in folder
        }
    }
    for (const plist of o.managedPlists ?? (process.platform === 'darwin' ? ['/Library/Managed Preferences/com.anthropic.claudecode.plist', `/Library/Managed Preferences/${userInfo().username}/com.anthropic.claudecode.plist`] : [])) {
        if (existsSync(plist)) return plist;
    }
    const remote = join(configDir, 'remote-settings.json');
    if (existsSync(remote) && (setsMcpPolicy(readJson(remote)) || readJson(remote) === undefined)) return remote;
    return undefined;
}

/** The outermost folder above (or at) `dir` that is a git checkout, or `dir` itself if none is. */
function repositoryRoot(dir: string, home: string): string {
    let root = dir;
    for (let at = dir; ; ) {
        // A home folder kept in git is not "the project's repository".
        if (at !== home && existsSync(join(at, '.git'))) root = at;
        const up = dirname(at);
        if (up === at) return root;
        at = up;
    }
}

export function discoverServers(env: NodeJS.ProcessEnv = process.env, log: (s: string) => void = () => {}, o: DiscoverOptions = {}): ServerTable {
    const out: ServerTable = { servers: {}, skipped: {} };
    const home = env.HOME ?? homedir();
    const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
    const project = resolve(env.CLAUDE_PROJECT_DIR ?? process.cwd());
    const real = (p: string) => {
        try {
            return realpathSync(p);
        } catch {
            return p;
        }
    };
    const off = (why: string) => {
        out.skipped['(all servers)'] = why;
        log(why);
        return out;
    };
    const policy = managedMcpPolicy(o.managedDirs ?? defaultManagedDirs(), configDir, o);
    if (policy) return off(`your organisation manages which MCP servers are allowed (${policy}), and this plugin cannot judge that policy, so it connects to none`);

    const claudeJson = readJson(env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json'));
    const projects = (claudeJson?.projects ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const entry = projects[project] ?? projects[real(project)] ?? {};
    const trusted = entry.hasTrustDialogAccepted === true;
    // What Claude Code reads to decide about `.mcp.json` servers, highest first. The folder's own
    // settings count only once it is trusted.
    const layers = [...(trusted ? [readJson(join(project, '.claude', 'settings.local.json')), readJson(join(project, '.claude', 'settings.json'))] : []), readJson(join(configDir, 'settings.json'))].filter((x) => x !== undefined);
    // An allow or deny list for MCP servers counts from any settings file, and this plugin cannot apply one.
    if (layers.some((x) => POLICY_KEYS.some((k) => k in x))) return off('a settings file says which MCP servers are allowed or denied, and this plugin cannot apply such a list, so it connects to none');

    const switched = new Set(names(entry.disabledMcpServers));
    const switchedOff: Gate = (name) => (switched.has(name) ? 'it is switched off for this project in Claude Code' : undefined);

    if (env.MCP_EVENTS_CONFIG) {
        const p = resolve(env.MCP_EVENTS_CONFIG);
        // A project's settings can set environment variables. A servers file inside the project, or
        // anywhere in the repository the project is part of, is the project approving its own servers,
        // which is Claude Code's question to ask, not this variable's. (A guard against a careless or
        // unexpected setting: a folder marked trusted can already run commands of its own through hooks.)
        const within = (dir: string) => {
            const rel = relative(dir, real(p));
            return !(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel));
        };
        if (within(repositoryRoot(real(project), real(home)))) {
            return off('MCP_EVENTS_CONFIG points inside the project folder or its repository; a servers file of your own must be kept outside it');
        }
        const j = readJson(p) ?? {};
        // A server switched off for this project in Claude Code stays off, whichever file names it.
        parseServers(j.mcpServers ?? j.servers, dirname(p), out, env, switchedOff, { cwd: dirname(p) });
    } else {
        const sources = new Set((env.MCP_EVENTS_SOURCES ?? 'project,local,user').split(',').map((x) => x.trim()));
        // A yes-or-no setting is taken from the highest file that sets it; lists add up across files.
        const approveAll = layers.find((x) => typeof x.enableAllProjectMcpServers === 'boolean')?.enableAllProjectMcpServers === true;
        const approved = new Set([...names(entry.enabledMcpjsonServers), ...layers.flatMap((x) => names(x.enabledMcpjsonServers))]);
        const rejected = new Set([...names(entry.disabledMcpjsonServers), ...layers.flatMap((x) => names(x.disabledMcpjsonServers))]);
        const projectGate: Gate = (name) => {
            if (!trusted) return 'this folder is not marked trusted in Claude Code, so nothing from its .mcp.json is used';
            if (rejected.has(name)) return 'it was rejected (disabled) for this project in Claude Code';
            if (!approveAll && !approved.has(name)) return 'it is in this project\'s .mcp.json but not approved in Claude Code yet';
            return switchedOff(name);
        };
        // Lowest precedence first, as Claude Code does: user, then project, then local.
        // A headersHelper runs in the project folder for project and local servers, and only once the
        // folder is trusted; for a user-scope server it runs in Claude Code's config folder.
        const untrusted = trusted ? undefined : 'it uses a headersHelper, which is run only in a folder marked trusted in Claude Code';
        if (sources.has('user')) parseServers(claudeJson?.mcpServers, project, out, env, switchedOff, { cwd: configDir });
        const mcpJson = join(project, '.mcp.json');
        if (sources.has('project') && existsSync(mcpJson)) parseServers(readJson(mcpJson)?.mcpServers, project, out, env, projectGate, { cwd: project, fromRepo: true, refuse: untrusted });
        if (sources.has('local')) parseServers(entry.mcpServers, project, out, env, switchedOff, { cwd: project, refuse: untrusted });
    }
    const only = env.MCP_EVENTS_SERVERS?.split(',').map((s) => s.trim()).filter(Boolean);
    const skip = new Set(env.MCP_EVENTS_SKIP?.split(',').map((s) => s.trim()).filter(Boolean) ?? []);
    for (const name of Object.keys(out.servers)) {
        if ((only && !only.includes(name)) || skip.has(name)) {
            delete out.servers[name];
            out.skipped[name] = 'excluded by MCP_EVENTS_SERVERS / MCP_EVENTS_SKIP';
        }
    }
    return out;
}
