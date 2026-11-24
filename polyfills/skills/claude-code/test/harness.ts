// What the tests share: a fixture server driven by a scenario file, builders for
// skills with correct digests, and the helper's app connected to fixtures.

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../src/app.ts';
import type { StdioUpstream } from '../src/config.ts';
import { Connection } from '../src/wire.ts';

export type Json = Record<string, unknown>;
export type Entry = { uri: string; frontmatter: Json; resources: { uri: string; digest: string; size: number }[] | 'dynamic' | unknown };
export type Scenario = {
    caps?: string;
    directoryRead?: boolean;
    revision?: string;
    serverName?: string;
    listed?: Entry[];
    unlisted?: Entry[];
    getAnswers?: Record<string, Entry>;
    files?: Record<string, { text?: string; blob?: string; mimeType?: string }>;
    dirs?: Record<string, Json[]>;
    pageSize?: number;
    ttlMs?: number | null;
};

const FIXTURE = fileURLToPath(new URL('./fixture-skills-server.ts', import.meta.url));
export const temp = (): string => mkdtempSync(join(tmpdir(), 'mcp-skills-test-'));
export const digest = (content: string | Uint8Array): string => `sha256:${createHash('sha256').update(content).digest('hex')}`;
export const sizeOf = (content: string | Uint8Array): number => Buffer.byteLength(content as string);

export const skillMd = (name: string, description = `What ${name} does.`, extra = ''): string => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody of ${name}.\n`;

/**
 * A skill as a conforming server would publish it: the entry with a complete manifest, and the
 * files behind it. `path` is the skill path (`acme/billing/refunds`); `files` maps paths inside
 * the skill to text (`SKILL.md` is added when left out).
 */
export function skill(path: string, files: Record<string, string> = {}, o: { description?: string; frontmatter?: Json; dynamic?: boolean; scheme?: string } = {}): { entry: Entry; files: NonNullable<Scenario['files']>; uri: string; root: string } {
    const name = path.split('/').at(-1)!;
    const root = `${o.scheme ?? 'skill'}://${path}`;
    const all: Record<string, string> = { 'SKILL.md': skillMd(name, o.description), ...files };
    const frontmatter = o.frontmatter ?? { name, description: o.description ?? `What ${name} does.` };
    const entry: Entry = {
        uri: `${root}/SKILL.md`,
        frontmatter,
        resources: o.dynamic ? 'dynamic' : Object.entries(all).map(([p, text]) => ({ uri: `${root}/${p}`, digest: digest(text), size: sizeOf(text) }))
    };
    return { entry, uri: entry.uri, root, files: Object.fromEntries(Object.entries(all).map(([p, text]) => [`${root}/${p}`, { text }])) };
}

/** A fixture server: its scenario can be rewritten while it runs, and every request it received can be read back. */
export class Fixture {
    readonly dir = temp();
    readonly scenarioPath = join(this.dir, 'scenario.json');
    readonly logPath = join(this.dir, 'requests.jsonl');
    scenario: Scenario;

    constructor(scenario: Scenario) {
        this.scenario = scenario;
        this.write();
    }

    /** Applies a change to the scenario and writes it: the server serves it from its next request on. */
    change(update: (s: Scenario) => void): void {
        update(this.scenario);
        this.write();
    }

    write(): void {
        writeFileSync(this.scenarioPath, JSON.stringify(this.scenario));
    }

    get config(): StdioUpstream {
        return { command: process.execPath, args: ['--no-warnings', FIXTURE], env: { FIXTURE_SCENARIO: this.scenarioPath, FIXTURE_LOG: this.logPath } };
    }

    /** Every request the server received, in order, as sent. */
    requests(method?: string): { method: string; params: Json }[] {
        if (!existsSync(this.logPath)) return [];
        return readFileSync(this.logPath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { method: string; params: Json })
            .filter((m) => method === undefined || m.method === method);
    }
}

/** Puts several skills into one scenario. */
export function scenarioOf(skills: ReturnType<typeof skill>[], extra: Scenario = {}): Scenario {
    return { listed: skills.map((s) => s.entry), files: Object.assign({}, ...skills.map((s) => s.files)), ...extra };
}

const open: { stop: () => Promise<void> }[] = [];

/** The helper's app, connected to the given fixtures under the given labels. */
export async function startApp(servers: Record<string, Fixture>, o: { verdict?: (name: string) => Promise<{ ok: boolean; reason?: string }>; now?: () => number } = {}): Promise<App> {
    const app = new App({ table: { servers: Object.fromEntries(Object.entries(servers).map(([name, f]) => [name, f.config])), skipped: {} }, verdict: o.verdict ?? (async () => ({ ok: true })), connectTimeoutMs: 8000, now: o.now });
    open.push(app);
    await app.start();
    return app;
}

export async function connect(label: string, fixture: Fixture): Promise<Connection> {
    const c = new Connection(label, fixture.config);
    open.push({ stop: () => c.close() });
    await c.connect(8000);
    return c;
}

/** Closes what the tests of a file opened. */
export async function closeAll(): Promise<void> {
    await Promise.all(open.splice(0).map((a) => a.stop().catch(() => {})));
}
