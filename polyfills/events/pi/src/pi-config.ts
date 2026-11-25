// Which MCP servers to look for events on: the ones Pi itself connects.
//
// Pi reads its servers from <agent dir>/mcp.json (PI_CODING_AGENT_DIR, else
// ~/.pi/agent), from <project>/.pi/mcp.json once the project is trusted, and
// from what extensions register with `pi.registerMcpServer()`. A project entry
// replaces a user entry of the same name; one without `command`, `url` or
// `type` only overrides `enabled`, `exposure` and `toolExposure`. A server in
// mcp.json takes precedence over a registered one of the same name. This file
// reads the same places, in the same order, so the extension never reaches a
// server Pi would not.
//
// The extension opens a connection of its own to each server, so it
// carries only what the configuration holds:
//
//   - a server with `enabled: false`, or `exposure: "hidden"`, is left alone;
//   - a server that signs in through Pi (an `oauth` table, `auth.provider`, or an
//     HTTP server Pi signs in to because it answered 401) is left alone: Pi keeps
//     that sign-in in mcp-auth.json, which this extension never reads;
//   - values are resolved as Pi resolves them: `${NAME}` and `$NAME` from the
//     environment, `$$` and `$!` as literal `$` and `!`, and a value that starts
//     with `!` runs as a shell command whose output is the value. A value that
//     names a variable that is not set leaves the server out, as Pi reports it.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { ServerTable, UpstreamConfig } from '../../core/src/upstream.ts';

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): Record<string, string> | undefined => (isRecord(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string')) : undefined);

/** Pi's server names: letters, digits, `_` and `-`. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const OVERRIDE_KEYS = new Set(['enabled', 'exposure', 'toolExposure']);

// Pi 1.6.0's own checks of an mcp.json entry (pi-mcp's validateMcpServerConfig, and Pi's exposure
// and auth checks in core/mcp-servers.js), mirrored: an extension can't call them, and an entry Pi
// rejects must not be reached, or have its `!command` values run, by this extension either.
const EXPOSURES = ['codemode', 'deferred', 'direct', 'hidden'];
const EXPOSURE_ALIASES: Record<string, string> = { 'codemode-deferred': 'codemode' };
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const stringRecord = (v: unknown) => isRecord(v) && Object.values(v).every((x) => typeof x === 'string');
const alias = (v: unknown) => (typeof v === 'string' ? (EXPOSURE_ALIASES[v] ?? v) : v);
const loopbackRedirect = (v: string) => {
    if (!URL.canParse(v)) return false;
    const u = new URL(v);
    return u.protocol === 'http:' && LOOPBACK.includes(u.hostname) && u.search === '' && u.hash === '';
};

function oauthError(o: unknown): string | undefined {
    if (o === undefined) return undefined;
    if (!isRecord(o)) return 'oauth must be an object';
    if (o.clientId !== undefined && typeof o.clientId !== 'string') return 'oauth.clientId must be a string';
    if (o.clientSecret !== undefined && typeof o.clientSecret !== 'string') return 'oauth.clientSecret must be a string';
    const port = o.callbackPort;
    if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) return 'oauth.callbackPort must be a port number';
    if (o.callbackUrl !== undefined) {
        if (typeof o.callbackUrl !== 'string' || !loopbackRedirect(o.callbackUrl)) return 'oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1]';
        const urlPort = new URL(o.callbackUrl).port;
        if (urlPort && port !== undefined && Number(urlPort) !== port) return 'oauth.callbackUrl and oauth.callbackPort name different ports';
    }
    if (o.scope !== undefined && typeof o.scope !== 'string') return 'oauth.scope must be a string';
    if (o.clientName !== undefined && (typeof o.clientName !== 'string' || !o.clientName.trim())) return 'oauth.clientName must be a non-empty string';
    const registration = o.clientRegistration;
    if (registration !== undefined && registration !== 'auto' && registration !== 'dcr') {
        if (registration !== 'cimd') return 'oauth.clientRegistration must be "auto", "dcr", or "cimd"';
        if (o.clientId !== undefined || o.clientName !== undefined) return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
        if (typeof o.callbackUrl === 'string') {
            const u = new URL(o.callbackUrl);
            if (u.hostname === '[::1]' || u.pathname !== '/callback') return 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback';
        }
    }
    const metadata = o.authServerMetadataUrl;
    if (metadata !== undefined) {
        const u = typeof metadata === 'string' && URL.canParse(metadata) ? new URL(metadata) : undefined;
        if (!u || !(u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.includes(u.hostname)))) return 'oauth.authServerMetadataUrl must be an https URL, or http on localhost';
    }
    return undefined;
}

/** Why Pi rejects this entry, or nothing when Pi accepts it. `v` has its exposure aliases resolved. */
export function entryError(name: string, v: unknown): string | undefined {
    if (!SERVER_NAME.test(name)) return `invalid server name "${name}"`;
    if (!isRecord(v)) return `server "${name}" must be an object`;
    if (v.enabled !== undefined && typeof v.enabled !== 'boolean') return 'enabled must be a boolean';
    if (v.description !== undefined && typeof v.description !== 'string') return 'description must be a string';
    if (v.timeout !== undefined && (typeof v.timeout !== 'number' || !(v.timeout > 0))) return 'timeout must be a positive number of seconds';
    if (v.type === 'sse') return 'legacy SSE transport is not supported';
    let fields: string | undefined;
    if (typeof v.url === 'string' && (v.type === undefined || v.type === 'http' || v.type === 'streamable-http')) {
        if (!URL.canParse(v.url) || !/^https?:$/.test(new URL(v.url).protocol)) fields = 'url must be an http or https URL';
        else if (v.headers !== undefined && !stringRecord(v.headers)) fields = 'headers must map names to strings';
        else fields = oauthError(v.oauth);
        if (!fields && v.auth !== undefined) {
            if (!isRecord(v.auth) || typeof v.auth.provider !== 'string' || !v.auth.provider) fields = 'auth.provider must be a provider name';
            else if (new URL(v.url).protocol !== 'https:' && !LOOPBACK.includes(new URL(v.url).hostname)) fields = 'auth requires an https URL';
        }
    } else if (typeof v.command === 'string' && (v.type === undefined || v.type === 'stdio')) {
        if (v.args !== undefined && !(Array.isArray(v.args) && v.args.every((a) => typeof a === 'string'))) fields = 'args must be an array of strings';
        else if (v.env !== undefined && !stringRecord(v.env)) fields = 'env must map names to strings';
        else if (v.cwd !== undefined && typeof v.cwd !== 'string') fields = 'cwd must be a string';
    } else return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
    if (fields) return `server "${name}": ${fields}`;
    if (v.exposure !== undefined && !EXPOSURES.includes(v.exposure as string)) return `server "${name}": exposure must be one of ${EXPOSURES.join(', ')}`;
    if (v.toolExposure !== undefined && !(isRecord(v.toolExposure) && Object.values(v.toolExposure).every((x) => EXPOSURES.includes(x as string)))) return `server "${name}": toolExposure must map tool names to exposures`;
    return undefined;
}

/** An entry with its exposure aliases resolved, as Pi reads it. */
const resolvedAliases = (v: Json): Json => ({
    ...v,
    ...(v.exposure !== undefined ? { exposure: alias(v.exposure) } : {}),
    ...(isRecord(v.toolExposure) ? { toolExposure: Object.fromEntries(Object.entries(v.toolExposure).map(([k, x]) => [k, alias(x)])) } : {})
});

/**
 * Whether Pi's own MCP support runs in this session: its `/mcp` command is there, from the built-in
 * MCP extension. With `--no-mcp`, `"extensions": ["-builtin:mcp"]`, or an extension that replaces
 * MCP support (it registers `/mcp`), Pi reads no mcp.json and connects none of its servers, and
 * neither does this extension.
 */
export function piRunsMcp(commands: { name: string; sourceInfo?: { path?: string } }[]): boolean {
    // Every /mcp there is must be the built-in one: an /mcp from anywhere else means MCP support is replaced.
    const mcp = commands.filter((c) => c.name === 'mcp');
    return mcp.length > 0 && mcp.every((c) => c.sourceInfo?.path === 'builtin:mcp');
}

/** Pi's agent directory: PI_CODING_AGENT_DIR, else ~/.pi/agent. A leading `~` is the home directory, as Pi reads it. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
    const set = env.PI_CODING_AGENT_DIR?.trim();
    if (set) return set === '~' ? homedir() : set.startsWith('~/') ? join(homedir(), set.slice(2)) : set;
    return join(env.HOME || homedir(), '.pi', 'agent');
}

export type RegisteredServer = { name: string; config: unknown };
export type ReadOptions = {
    env?: NodeJS.ProcessEnv;
    /** The session's working directory (Pi's `ctx.cwd`). */
    cwd: string;
    /** Whether Pi trusts the project (`ctx.isProjectTrusted()`): only then is .pi/mcp.json read. */
    trusted: boolean;
    /** What extensions registered (`pi.getMcpServers()`). */
    registered?: RegisteredServer[];
    /** Runs a `!command` value. The default runs it through the shell, as Pi does. */
    runCommand?: (command: string) => string | undefined;
};

/** The entries as Pi would end up with them, before any value is resolved: name → raw config, and where it came from. */
export function readPiEntries(o: ReadOptions): { entries: Map<string, { config: Json; source: string }>; errors: string[] } {
    const env = o.env ?? process.env;
    const entries = new Map<string, { config: Json; source: string }>();
    const errors: string[] = [];
    const read = (path: string, scope: 'global' | 'project') => {
        if (!existsSync(path)) return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
        } catch {
            errors.push(`${path} is not valid JSON`);
            return;
        }
        if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
            errors.push(`${path}: expected an object with an "mcpServers" object`);
            return;
        }
        for (const [name, value] of Object.entries((parsed.mcpServers ?? {}) as Json)) {
            // An entry Pi rejects is not taken, and an earlier one of the same name stands, as in Pi.
            const isOverride = isRecord(value) && value.command === undefined && value.url === undefined && value.type === undefined;
            if (scope === 'project' && isOverride) {
                const base = entries.get(name);
                if (!base || Object.keys(value).some((k) => !OVERRIDE_KEYS.has(k))) continue;
                const merged = resolvedAliases({ ...base.config, ...(value as Json) });
                const why = entryError(name, merged);
                if (why) errors.push(`${path}: ${why}`);
                else entries.set(name, { config: merged, source: base.source });
                continue;
            }
            const config = isRecord(value) ? resolvedAliases(value) : value;
            const why = entryError(name, config);
            if (why) {
                errors.push(`${path}: ${why}`);
                continue;
            }
            // Names that differ only in `-` and `_` would share a namespace in Pi: the later one is rejected.
            if ([...entries.keys()].some((other) => other !== name && ns(other) === ns(name))) continue;
            if (scope === 'project' && (config as Json).auth !== undefined && typeof (config as Json).url === 'string') continue;
            entries.set(name, { config: config as Json, source: path });
        }
    };
    const ns = (n: string) => n.replace(/-/g, '_');
    read(join(agentDir(env), 'mcp.json'), 'global');
    if (o.trusted) read(join(o.cwd, '.pi', 'mcp.json'), 'project');
    // Registered servers come after: a name mcp.json defines takes precedence. Names that differ only
    // in `-` and `_` are the same server to Pi. Pi refuses to register an entry it would reject.
    for (const r of o.registered ?? []) {
        if (!SERVER_NAME.test(r.name) || !isRecord(r.config)) continue;
        if ([...entries.keys()].some((k) => ns(k) === ns(r.name))) continue;
        entries.set(r.name, { config: r.config, source: 'extension' });
    }
    return { entries, errors };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

/** A config value as Pi resolves it, or nothing when a variable it names is not set (or its command fails). */
export function resolveValue(value: string, env: NodeJS.ProcessEnv, runCommand: (command: string) => string | undefined): string | undefined {
    if (value.startsWith('!')) return runCommand(value.slice(1));
    let out = '';
    for (let i = 0; i < value.length; ) {
        const at = value.indexOf('$', i);
        if (at < 0) {
            out += value.slice(i);
            break;
        }
        out += value.slice(i, at);
        const next = value[at + 1];
        if (next === '$' || next === '!') {
            out += next;
            i = at + 2;
            continue;
        }
        if (next === '{') {
            const end = value.indexOf('}', at + 2);
            if (end < 0) {
                out += '$';
                i = at + 1;
                continue;
            }
            const name = value.slice(at + 2, end);
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
                const v = env[name];
                if (!v) return undefined;
                out += v;
            } else out += value.slice(at, end + 1);
            i = end + 1;
            continue;
        }
        const m = value.slice(at + 1).match(ENV_NAME);
        if (m) {
            const v = env[m[0]];
            if (!v) return undefined;
            out += v;
            i = at + 1 + m[0].length;
            continue;
        }
        out += '$';
        i = at + 1;
    }
    return out;
}

/** Runs a `!command` value through the user's shell, as Pi does: its trimmed output, or nothing if it fails. */
export function shellCommand(command: string): string | undefined {
    try {
        const out = execSync(command, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 });
        return out.trim() || undefined;
    } catch {
        return undefined;
    }
}

const expandHome = (v: string) => (v === '~' ? homedir() : v.startsWith('~/') ? join(homedir(), v.slice(2)) : v);

/**
 * One server's entry as this extension's own connection would use it, or why it is left out.
 * `undefined`: the entry names no transport this extension knows (Pi reports that itself).
 */
export function parseEntry(name: string, v: Json, o: { env: NodeJS.ProcessEnv; cwd: string; runCommand: (command: string) => string | undefined }): UpstreamConfig | { skip: string } | undefined {
    if (v.enabled === false) return { skip: 'it is turned off in Pi (enabled: false)' };
    if (v.exposure === 'hidden') return { skip: 'its exposure in Pi is "hidden"' };
    const missing = (what: string) => ({ skip: `${what} could not be resolved (a variable it names is not set, or its command failed)` });
    // The transport, chosen as Pi chooses it (pi-mcp's config parser), before any value is resolved: a
    // `url` is streamable HTTP unless `type` says otherwise, then a `command` is stdio unless `type`
    // says otherwise. Anything else Pi rejects, and so does this, without running anything.
    const http = typeof v.url === 'string' && (v.type === undefined || v.type === 'http' || v.type === 'streamable-http');
    const stdio = !http && typeof v.command === 'string' && (v.type === undefined || v.type === 'stdio');
    if (stdio) {
        const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string').map(expandHome) : [];
        const env: Record<string, string> = {};
        for (const [k, raw] of Object.entries(strings(v.env) ?? {})) {
            const r = resolveValue(raw, o.env, o.runCommand);
            if (r === undefined) return missing(`its env value ${k}`);
            env[k] = r;
        }
        const cwd = typeof v.cwd === 'string' && v.cwd ? (isAbsolute(expandHome(v.cwd)) ? expandHome(v.cwd) : resolve(o.cwd, v.cwd)) : o.cwd;
        return { command: expandHome(v.command as string), args, env: Object.keys(env).length ? env : undefined, cwd };
    }
    if (http) {
        if (isRecord(v.oauth)) return { skip: 'it signs in through Pi (an oauth setting), and this extension has no access to Pi\'s sign-in' };
        if (isRecord(v.auth)) return { skip: 'its token comes from a Pi provider sign-in (auth.provider), which this extension has no access to' };
        const headers: Record<string, string> = {};
        for (const [k, raw] of Object.entries(strings(v.headers) ?? {})) {
            const r = resolveValue(raw, o.env, o.runCommand);
            if (r === undefined) return missing(`its header ${k}`);
            headers[k] = r;
        }
        return { url: v.url as string, headers: Object.keys(headers).length ? headers : undefined };
    }
    return undefined;
}

/** The servers Pi connects, as this extension's own connection would reach them, and the ones it leaves out with why. */
export function readPiServers(o: ReadOptions): ServerTable {
    const env = o.env ?? process.env;
    const runCommand = o.runCommand ?? shellCommand;
    const out: ServerTable = { servers: {}, skipped: {} };
    const { entries } = readPiEntries(o);
    for (const [name, { config }] of entries) {
        const r = parseEntry(name, config, { env, cwd: o.cwd, runCommand });
        if (!r) continue;
        if ('skip' in r) out.skipped[name] = r.skip;
        else out.servers[name] = r;
    }
    return out;
}

/** Whether Pi would sign in to this HTTP server with OAuth when it answers 401: no Authorization header of its own. */
export function mayUseOAuth(cfg: UpstreamConfig): boolean {
    if (!('url' in cfg)) return false;
    return !Object.keys(cfg.headers ?? {}).some((k) => k.toLowerCase() === 'authorization');
}
