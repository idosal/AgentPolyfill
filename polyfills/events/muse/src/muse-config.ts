// Reuse user-selected stdio and HTTP connections from Muse settings. Managed credentials
// and environment substitutions require host support and stay unavailable here.
import { readConfig, securePublisher } from '../../../../tools/muse-grok/config.ts';
import { spawnSync } from 'node:child_process';
import { lstatSync, accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ServerTable, UpstreamConfig } from '../../core/src/upstream.ts';

type Json = Record<string, unknown>;
const isTable = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const home = (env: NodeJS.ProcessEnv) => env.HOME || homedir();
/** Muse's config folder: $XDG_CONFIG_HOME/muse, else ~/.config/muse. */
export function museConfigDir(env: NodeJS.ProcessEnv = process.env): string {
    const hint = env.MUSE_PLUGIN_DATA_DIR && join(env.MUSE_PLUGIN_DATA_DIR, 'native-config-home.json');
    const base = hint && lstatSync(hint, { throwIfNoEntry: false })?.isFile()
        ? readConfig(hint) : env.XDG_CONFIG_HOME;
    if (base !== undefined && typeof base !== 'string') throw Error('Invalid Muse config home.');
    return join(base && isAbsolute(base) ? base : join(home(env), '.config'), 'muse');
}

/** Only connections the operator named for this plugin may be opened. */
export function selectedServers(env: NodeJS.ProcessEnv = process.env): string[] {
    if (!env.MUSE_PLUGIN_DATA_DIR) return [];
    const file = join(env.MUSE_PLUGIN_DATA_DIR, 'muse-servers.json');
    if (!existsSync(file)) return [];
    const names: unknown = readConfig(file);
    if (!Array.isArray(names) || !names.every(n => typeof n === 'string' && SERVER_NAME.test(n))) throw Error('Invalid selected Muse server names.');
    return [...new Set<string>(names)];
}
/** Muse's user settings, where `muse mcp add` writes servers. */
export const museSettingsPath = (env: NodeJS.ProcessEnv = process.env): string => join(museConfigDir(env), 'settings.json');

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const unresolved = (v: unknown) => typeof v === 'string' && v.includes('${');
const needsEnv = { skip: 'this Muse connection needs an environment value that the plugin cannot reuse' };

/** One entry of Muse's `mcpServers`, as the Events client takes it, or why it is left out. */
export function parseMuseServer(v: Json, base: string, isSelf: (arg: string) => boolean = () => false): UpstreamConfig | { skip: string } | undefined {
    if (v.enabled === false || v.disabled === true) return { skip: 'it is switched off in Muse' };
    if (v.oauth || v.auth) return { skip: "it signs in through Muse, and this plugin has no access to Muse's sign-in" };
    const type = typeof v.type === 'string' ? v.type : typeof v.command === 'string' ? 'stdio' : typeof v.url === 'string' ? 'http' : '';
    if (v.bearer_token_env_var || v.bearerTokenEnvVar || (Array.isArray(v.env_vars) && v.env_vars.length)) return needsEnv;
    if (type === 'stdio') {
        if (typeof v.command !== 'string' || !v.command.trim()) return { skip: 'it has no command' };
        if (v.args !== undefined && (!Array.isArray(v.args) || !v.args.every(x => typeof x === 'string'))) return { skip: 'invalid stdio arguments' };
        const args = (v.args ?? []) as string[];
        if ([v.command, ...args].some(isSelf)) return undefined;
        if (v.env !== undefined && (!isTable(v.env) || !Object.entries(v.env).every(([k,x]) => ENV_NAME.test(k) && typeof x === 'string'))) return { skip: 'invalid stdio environment' };
        const childEnv = v.env as Record<string,string> | undefined;
        if ([v.command, v.cwd, ...args, ...Object.values(childEnv ?? {})].some(unresolved)) return needsEnv;
        const cwd = typeof v.cwd === 'string' && v.cwd ? resolve(base, v.cwd) : undefined;
        return { command: v.command, args, env: childEnv, cwd };
    }
    if (type === 'http' || type === 'streamable-http' || type === 'streamableHttp') {
        if (typeof v.url !== 'string') return { skip: 'it has no URL' };
        if (v.headers !== undefined && (!isTable(v.headers) || !Object.values(v.headers).every(x => typeof x === 'string'))) return { skip: 'invalid HTTP headers' };
        const headers = v.headers as Record<string,string> | undefined;
        if ([v.url, ...Object.values(headers ?? {})].some(unresolved)) return needsEnv;
        if (!securePublisher(v.url)) return { skip: 'use HTTPS or loopback HTTP without inline credentials, query or fragment' };
        return { url: v.url, headers };
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
    const out: ServerTable & { file: string } = { servers: Object.create(null), skipped: Object.create(null), file };
    // Where an organisation manages Muse (museManaged), no server is reached.
    if (o.managed) {
        out.skipped['(all servers)'] = o.managed;
        log(o.managed);
        return out;
    }
    if (!o.only?.length) return out;
    let config: unknown = {};
    try {
        if (existsSync(file)) config = readConfig(file);
    } catch {
        out.skipped['(all servers)'] = 'Muse settings could not be read. No selected server was connected.';
        log(out.skipped['(all servers)']!);
        return out;
    }
    const table = isTable(config) ? config.mcpServers : undefined;
    if (isTable(table)) {
        for (const [name, value] of Object.entries(table)) {
            if (!o.only?.includes(name) || !SERVER_NAME.test(name) || !isTable(value)) continue;
            const r = parseMuseServer(value, dirname(file), o.isSelf);
            if (!r) continue;
            if ('skip' in r) out.skipped[name] = r.skip;
            else out.servers[name] = r;
        }
    }
    const skip = new Set(o.skip ?? []);
    for (const name of Object.keys(out.servers)) {
        if (skip.has(name)) {
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
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) if (isAbsolute(dir) && executable(join(dir, 'muse'))) return join(dir, 'muse');
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
    if (!sources?.length || sources.length !== (status as {sources: unknown[]}).sources.length) return "Muse's enterprise configuration could not be read (muse config status), so this plugin connects to no server";
    if (r.status !== 0) return 'Muse policy could not be checked.';
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
