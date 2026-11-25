// Muse Code's MCP servers, as the polyfills that open their own connection read them
// (mcp-events and mcp-skills, each in its Muse form): `mcpServers` in Muse's user settings,
// ~/.config/muse/settings.json, which `muse mcp add` writes. Muse passes a plugin's server no
// environment variables of the person's, so a value Muse would take from the environment
// (`${VAR}`) is filled only when the plugin's own process has that variable; otherwise the
// server is left out, with the reason. A server signed in through Muse (`muse mcp login`) is
// not reached with that sign-in: its tokens are Muse's, and no polyfill reads them.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ServerTable, UpstreamConfig } from '../../core/src/upstream.ts';

type Json = Record<string, unknown>;
const isTable = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const home = (env: NodeJS.ProcessEnv) => env.HOME || homedir();
/** Muse's config folder: $XDG_CONFIG_HOME/muse, else ~/.config/muse. */
export const museConfigDir = (env: NodeJS.ProcessEnv = process.env): string => join(env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home(env), '.config'), 'muse');
/** Muse's user settings, where `muse mcp add` writes servers. */
export const museSettingsPath = (env: NodeJS.ProcessEnv = process.env): string => join(museConfigDir(env), 'settings.json');

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WHOLE_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BEARER_REF = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const strings = (v: unknown): Record<string, string> => (isTable(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string')) : {});


/**
 * A value as Muse reads it: literal, or `${VAR}` (the whole value, or after "Bearer " in a header),
 * taken from the environment. Muse passes its plugins' servers no variables of the person's, so a
 * reference is filled only when this helper was given one (MCP_EVENTS_CONFIG pointing at a file
 * of the person's, with the variable set where the helper runs, in tests).
 */
function fill(value: string, env: NodeJS.ProcessEnv, need: string[]): string | undefined {
    const whole = WHOLE_REF.exec(value);
    const bearer = BEARER_REF.exec(value);
    const name = whole?.[1] ?? bearer?.[1];
    if (name) {
        const v = env[name];
        if (!v) {
            need.push(name);
            return undefined;
        }
        return bearer ? `Bearer ${v}` : v;
    }
    if (value.includes('${')) {
        need.push(value);
        return undefined;
    }
    return value;
}

/** One entry of Muse's `mcpServers`, as the Events client takes it, or why it is left out. */
export function parseMuseServer(v: Json, env: NodeJS.ProcessEnv, base: string, isSelf: (arg: string) => boolean = () => false): UpstreamConfig | { skip: string } | undefined {
    if (v.enabled === false || v.disabled === true) return { skip: 'it is switched off in Muse' };
    if (isTable(v.oauth) || isTable(v.auth)) return { skip: "it signs in through Muse, and this plugin has no access to Muse's sign-in" };
    const type = typeof v.type === 'string' ? v.type : typeof v.command === 'string' ? 'stdio' : typeof v.url === 'string' ? 'http' : '';
    const need: string[] = [];
    const why = () =>
        `its configuration takes ${need.length > 1 ? 'values' : 'a value'} from ${need.map((n) => (ENV_NAME.test(n) ? `$${n}` : n)).join(', ')}, and Muse passes no environment variables to a plugin's server`;
    if (type === 'stdio') {
        if (typeof v.command !== 'string' || !v.command.trim()) return { skip: 'it has no command' };
        const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string') : [];
        if ([v.command, ...args].some(isSelf)) return undefined;
        const childEnv: Record<string, string> = {};
        for (const [k, raw] of Object.entries(strings(v.env))) {
            if (!ENV_NAME.test(k)) continue;
            const filled = fill(raw, env, need);
            if (filled !== undefined) childEnv[k] = filled;
        }
        // `env_vars` names variables to pass on from Muse's environment; here, from this helper's.
        for (const e of Array.isArray(v.env_vars) ? v.env_vars : []) if (typeof e === 'string' && ENV_NAME.test(e) && env[e] !== undefined) childEnv[e] = env[e]!;
        if (need.length) return { skip: why() };
        const cwd = typeof v.cwd === 'string' && v.cwd ? (isAbsolute(v.cwd) ? v.cwd : resolve(base, v.cwd)) : undefined;
        return { command: v.command, args, env: Object.keys(childEnv).length ? childEnv : undefined, cwd };
    }
    if (type === 'http' || type === 'streamable-http' || type === 'streamableHttp') {
        if (typeof v.url !== 'string') return { skip: 'it has no url' };
        const url = fill(v.url, env, need);
        const headers: Record<string, string> = {};
        for (const [k, raw] of Object.entries(strings(v.headers))) {
            const filled = fill(raw, env, need);
            if (filled !== undefined) headers[k] = filled;
        }
        if (need.length || url === undefined) return { skip: why() };
        return { url, headers: Object.keys(headers).length ? headers : undefined };
    }
    return { skip: `its transport (${type || 'none'}) is not supported (only stdio and streamable HTTP are)` };
}

/**
 * The servers in Muse's user settings (or `o.file`, a JSON file with `mcpServers`), narrowed to
 * `o.only` and without `o.skip`. `o.isSelf` says which command is the plugin's own server.
 */
export function readMuseSettings(env: NodeJS.ProcessEnv, o: { file?: string; only?: string[]; skip?: string[]; isSelf?: (arg: string) => boolean; log?: (s: string) => void; managed?: string } = {}): ServerTable & { file: string } {
    const log = o.log ?? (() => {});
    const file = o.file ? resolve(o.file) : museSettingsPath(env);
    const out: ServerTable & { file: string } = { servers: {}, skipped: {}, file };
    // Where an organisation manages Muse (museManaged), no server is reached.
    if (o.managed) {
        out.skipped['(all servers)'] = o.managed;
        log(o.managed);
        return out;
    }
    let config: unknown = {};
    try {
        if (existsSync(file)) config = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
        out.skipped['(all servers)'] = `${file} could not be read (${e instanceof Error ? e.message.split('\n')[0] : 'not JSON'}), so this plugin connects to no server`;
        log(out.skipped['(all servers)']!);
        return out;
    }
    const table = isTable(config) ? config.mcpServers : undefined;
    if (isTable(table)) {
        for (const [name, value] of Object.entries(table)) {
            if (!SERVER_NAME.test(name) || !isTable(value)) continue;
            const r = parseMuseServer(value, env, dirname(file), o.isSelf);
            if (!r) continue;
            if ('skip' in r) out.skipped[name] = r.skip;
            else out.servers[name] = r;
        }
    }
    const skip = new Set(o.skip ?? []);
    for (const name of Object.keys(out.servers)) {
        if ((o.only?.length && !o.only.includes(name)) || skip.has(name)) {
            delete out.servers[name];
            out.skipped[name] = 'excluded by this plugin\'s settings';
        }
    }
    return out;
}

// ---- The muse command, Muse's enterprise configuration, and what the person turned off ----

const executable = (p: string) => {
    try {
        if (!statSync(p).isFile()) return false;
        accessSync(p, constants.X_OK);
        return true;
    } catch {
        return false;
    }
};

/**
 * The `muse` to run: `bin` if given (an absolute path), else the first on PATH, else where Muse's
 * installers put it, else the program that started this process when that is a muse.
 */
export function findMuse(env: NodeJS.ProcessEnv = process.env, bin?: string): string | undefined {
    if (bin) return isAbsolute(bin) && executable(bin) ? bin : undefined;
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) if (executable(join(dir, 'muse'))) return join(dir, 'muse');
    const known = ['/opt/homebrew/bin/muse', '/usr/local/bin/muse', join(home(env), '.local', 'bin', 'muse')].find(executable);
    if (known) return known;
    if (process.platform === 'win32') return undefined;
    const r = spawnSync('ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 5000, shell: false });
    const parent = (r.stdout ?? '').trim();
    return isAbsolute(parent) && /^muse/.test(basename(parent)) && executable(parent) ? parent : undefined;
}

/**
 * Why this plugin connects to no server, when an organisation manages Muse: `muse config status
 * --json` lists Muse's enterprise configuration (a defaults plane and a policy plane, from a system
 * file or macOS managed preferences), and either may say which MCP servers Muse may use. This
 * plugin cannot judge that policy, so with any of it present, or when it can't be read, it reaches
 * none. Undefined when none is present.
 */
export function museManaged(muse: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (!muse) return "the muse command was not found, so this plugin can't check whether your organisation manages Muse, and connects to no server";
    const childEnv = Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !/^(MCP_EVENTS_|MCP_SKILLS_)/.test(k))) as NodeJS.ProcessEnv;
    const r = spawnSync(muse, ['config', 'status', '--json'], { encoding: 'utf8', timeout: 15000, env: childEnv, shell: false, windowsHide: true });
    let status: unknown;
    try {
        status = JSON.parse(r.stdout ?? '');
    } catch {
        return "Muse's enterprise configuration could not be read (muse config status), so this plugin connects to no server";
    }
    const sources = isTable(status) && Array.isArray(status.sources) ? status.sources.filter(isTable) : undefined;
    if (!sources) return "Muse's enterprise configuration could not be read (muse config status), so this plugin connects to no server";
    const present = sources.filter((x) => x.state !== 'absent');
    if (!present.length) return undefined;
    const what = present.map((x) => `${String(x.plane ?? 'a')} plane from ${String(x.source_class ?? 'somewhere')}`).join(', ');
    return `your organisation manages Muse (${what}), which may say which MCP servers Muse may use, and this plugin cannot judge that policy, so it connects to none`;
}

/**
 * Whether the person has this plugin's MCP server turned on in Muse: it is approved and not
 * rejected (`runtime_capabilities` in Muse's settings). A hook of the plugin does nothing while it
 * isn't, as Muse runs nothing of the server.
 */
export function serverEnabled(env: NodeJS.ProcessEnv, plugin: string, server = plugin): boolean {
    try {
        const j = JSON.parse(readFileSync(museSettingsPath(env), 'utf8')) as unknown;
        const caps = isTable(j) && isTable(j.runtime_capabilities) ? j.runtime_capabilities : {};
        const mine = caps[`plugin:${plugin}:mcp_server:${server}`];
        return isTable(mine) && mine.enabled === true;
    } catch {
        return false;
    }
}
