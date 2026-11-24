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
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const OVERRIDE_KEYS = new Set(['enabled', 'exposure', 'toolExposure']);

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
        const table = isRecord(parsed) ? parsed.mcpServers : undefined;
        if (!isRecord(table)) return;
        for (const [name, value] of Object.entries(table)) {
            if (!SERVER_NAME.test(name) || !isRecord(value)) continue;
            const isOverride = value.command === undefined && value.url === undefined && value.type === undefined;
            if (scope === 'project' && isOverride) {
                const base = entries.get(name);
                if (!base || Object.keys(value).some((k) => !OVERRIDE_KEYS.has(k))) continue;
                entries.set(name, { config: { ...base.config, ...value }, source: base.source });
                continue;
            }
            entries.set(name, { config: value, source: path });
        }
    };
    read(join(agentDir(env), 'mcp.json'), 'global');
    if (o.trusted) read(join(o.cwd, '.pi', 'mcp.json'), 'project');
    // Registered servers come after: a name mcp.json defines takes precedence. Names that differ only
    // in `-` and `_` are the same server to Pi.
    const ns = (n: string) => n.replace(/-/g, '_');
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
    if (v.type === 'sse') return undefined;
    const missing = (what: string) => ({ skip: `${what} could not be resolved (a variable it names is not set, or its command failed)` });
    if (typeof v.command === 'string') {
        const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string').map(expandHome) : [];
        const env: Record<string, string> = {};
        for (const [k, raw] of Object.entries(strings(v.env) ?? {})) {
            const r = resolveValue(raw, o.env, o.runCommand);
            if (r === undefined) return missing(`its env value ${k}`);
            env[k] = r;
        }
        const cwd = typeof v.cwd === 'string' && v.cwd ? (isAbsolute(expandHome(v.cwd)) ? expandHome(v.cwd) : resolve(o.cwd, v.cwd)) : o.cwd;
        return { command: expandHome(v.command), args, env: Object.keys(env).length ? env : undefined, cwd };
    }
    if (typeof v.url === 'string') {
        if (isRecord(v.oauth)) return { skip: 'it signs in through Pi (an oauth setting), and this extension has no access to Pi\'s sign-in' };
        if (isRecord(v.auth)) return { skip: 'its token comes from a Pi provider sign-in (auth.provider), which this extension has no access to' };
        const headers: Record<string, string> = {};
        for (const [k, raw] of Object.entries(strings(v.headers) ?? {})) {
            const r = resolveValue(raw, o.env, o.runCommand);
            if (r === undefined) return missing(`its header ${k}`);
            headers[k] = r;
        }
        return { url: v.url, headers: Object.keys(headers).length ? headers : undefined };
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
