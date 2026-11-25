// Runs a real Pi (the version in devDependencies) in RPC mode, isolated: its own
// agent directory (PI_CODING_AGENT_DIR) and its own HOME in a temporary folder
// (Pi also reads ~/.agents/skills, whatever its agent directory), never ~/.pi, the
// scripted model of brain.ts, and the extensions under test. Answers the
// extension's dialogs as a test says, and records everything Pi prints.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PI_BIN = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
export const BRAIN = fileURLToPath(new URL('./brain.ts', import.meta.url));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const temp = (prefix = 'pi-polyfill-') => mkdtempSync(join(tmpdir(), prefix));

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 15000, what = 'condition'): Promise<T> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const v = await fn();
        if (v) return v;
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
}

export type Rule = { when: string; call?: { name: string; args: Record<string, unknown> }; say?: string };
export type UiRequest = { id: string; method: string; title?: string; message?: string; options?: string[] };
/** How a test answers a dialog: a value for select/input, a boolean for confirm, or nothing to cancel. */
export type Answer = (r: UiRequest) => string | boolean | undefined;

export type PiOptions = {
    extensions: string[];
    rules?: Rule[];
    agentDir?: string;
    cwd?: string;
    env?: Record<string, string>;
    answer?: Answer;
    /** Keep the session in this folder (for resume); default --no-session. */
    sessionDir?: string;
    /** Resume this session file. */
    session?: string;
    args?: string[];
    /** Another Pi to run: the path of its cli.js. Default: the one in devDependencies. */
    piBin?: string;
    /** A real model instead of the scripted stand-in: a provider and model id Pi knows (from models.json in the agent directory). */
    model?: { provider: string; id: string };
};

export class Pi {
    readonly records: Record<string, unknown>[] = [];
    readonly ui: UiRequest[] = [];
    readonly agentDir: string;
    readonly brainLog: string;
    stderr = '';
    readonly #child: ChildProcess;
    #buf = '';
    #n = 0;
    #answer: Answer;
    readonly exited: Promise<number | null>;

    constructor(o: PiOptions) {
        const dir = temp();
        this.agentDir = o.agentDir ?? join(dir, 'agent');
        mkdirSync(this.agentDir, { recursive: true });
        this.brainLog = join(dir, 'brain.jsonl');
        this.#answer = o.answer ?? (() => undefined);
        const model = o.model ? ['--provider', o.model.provider, '--model', o.model.id] : ['--provider', 'scripted', '--model', 'm1', '-e', BRAIN];
        const args = [o.piBin ?? PI_BIN, '--mode', 'rpc', '--offline', ...model, ...o.extensions.flatMap((e) => ['-e', e])];
        if (o.session) args.push('--session', o.session);
        else if (o.sessionDir) args.push('--session-dir', o.sessionDir);
        else args.push('--no-session');
        args.push(...(o.args ?? []));
        const home = o.env?.HOME ?? join(dir, 'home');
        mkdirSync(home, { recursive: true });
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: this.agentDir, PI_TEST_RULES: JSON.stringify(o.rules ?? []), PI_TEST_BRAIN_LOG: this.brainLog, ...o.env };
        this.#child = spawn(process.execPath, args, { cwd: o.cwd ?? dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
        this.#child.stdout!.on('data', (d: Buffer) => this.#read(d));
        this.#child.stderr!.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString('utf8')).slice(-20000)));
        this.exited = new Promise((r) => this.#child.on('exit', (code) => r(code)));
    }

    set answer(a: Answer) {
        this.#answer = a;
    }

    #read(d: Buffer): void {
        this.#buf += d.toString('utf8');
        let nl: number;
        while ((nl = this.#buf.indexOf('\n')) >= 0) {
            const line = this.#buf.slice(0, nl).replace(/\r$/, '');
            this.#buf = this.#buf.slice(nl + 1);
            if (!line.trim()) continue;
            let rec: Record<string, unknown>;
            try {
                rec = JSON.parse(line) as Record<string, unknown>;
            } catch {
                continue;
            }
            this.records.push(rec);
            if (rec.type === 'extension_ui_request') {
                const r = rec as unknown as UiRequest;
                if (!['select', 'confirm', 'input', 'editor'].includes(r.method)) continue;
                this.ui.push(r);
                const a = this.#answer(r);
                const reply = a === undefined ? { cancelled: true } : r.method === 'confirm' ? { confirmed: a === true } : { value: String(a) };
                this.send({ type: 'extension_ui_response', id: r.id, ...reply });
            }
        }
    }

    send(cmd: Record<string, unknown>): void {
        this.#child.stdin!.write(JSON.stringify(cmd) + '\n');
    }

    /** Sends a prompt and waits until Pi settles. */
    async prompt(message: string, timeoutMs = 20000): Promise<void> {
        const from = this.records.length;
        const id = `p${++this.#n}`;
        this.send({ id, type: 'prompt', message });
        await waitFor(() => this.records.slice(from).some((r) => r.type === 'agent_settled'), timeoutMs, `the prompt ${JSON.stringify(message)} to settle`);
    }

    /** Waits for Pi to have started (an answer to get_state). */
    async ready(timeoutMs = 20000): Promise<void> {
        this.send({ id: 'ready', type: 'get_state' });
        await waitFor(() => this.records.some((r) => r.type === 'response' && r.id === 'ready'), timeoutMs, 'Pi to start');
    }

    /** Messages of one role as Pi reported them finished (message_end). */
    messages(role?: string): { role: string; customType?: string; content: unknown }[] {
        return this.records
            .filter((r) => r.type === 'message_end')
            .map((r) => r.message as { role: string; customType?: string; content: unknown })
            .filter((m) => !role || m.role === role);
    }

    /** Tool results Pi reported, by tool name, as text. */
    toolResults(name?: string): { name: string; text: string; isError: boolean }[] {
        return this.records
            .filter((r) => r.type === 'tool_execution_end')
            .map((r) => {
                const result = r.result as { content?: { type: string; text?: string }[] } | undefined;
                return { name: String(r.toolName), text: (result?.content ?? []).map((c) => c.text ?? '').join('\n'), isError: r.isError === true };
            })
            .filter((t) => !name || t.name === name);
    }

    async stop(): Promise<void> {
        this.#child.stdin!.end();
        const t = setTimeout(() => this.#child.kill('SIGKILL'), 8000);
        await this.exited;
        clearTimeout(t);
    }
}
