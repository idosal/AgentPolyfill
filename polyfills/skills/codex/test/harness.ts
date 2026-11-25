// What the Codex adapter's tests share. The fixture server and the skill builders
// are the Claude adapter's (../claude-code/test): a server written by hand that
// shares no code with the polyfill, driven by a scenario file.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, type Asked, type Decision } from '../src/app.ts';
import type { SkillRule } from '../src/config.ts';
import { Store } from '../src/store.ts';
import type { Fixture } from '../../claude-code/test/harness.ts';

export { digest, Fixture, scenarioOf, sizeOf, skill, skillMd, type Entry, type Scenario } from '../../claude-code/test/harness.ts';

export const temp = (): string => mkdtempSync(join(tmpdir(), 'mcp-skills-codex-test-'));

/** How the person answers each question, in order; past the list, every question is answered "no". */
export type Answers = (Decision | Asked)[] | ((message: string, choices: Decision[], subject?: readonly string[]) => Asked);

export type Started = {
    app: App;
    store: Store;
    stubRoot: string;
    /** Every question put to the person, in order. */
    questions: { message: string; choices: Decision[] }[];
    rules: SkillRule[];
    /** Calls a tool as Codex would, on one thread. */
    call: (name: string, input: Record<string, unknown>, o?: { thread?: string; answers?: Answers }) => Promise<{ text: string; isError?: boolean }>;
};

const open: App[] = [];

export async function startApp(servers: Record<string, Fixture>, o: { answers?: Answers; store?: Store; stubRoot?: string; rules?: SkillRule[]; now?: () => number } = {}): Promise<Started> {
    const store = o.store ?? new Store(temp());
    const stubRoot = o.stubRoot ?? join(temp(), 'skills', 'served');
    const rules = o.rules ?? [];
    const app = new App({ table: { servers: Object.fromEntries(Object.entries(servers).map(([name, f]) => [name, f.config])), skipped: {} }, store, stubRoot, skillRules: () => rules, connectTimeoutMs: 8000, now: o.now });
    open.push(app);
    await app.start();
    const questions: Started['questions'] = [];
    let answers = o.answers ?? [];
    const ask = async (message: string, choices: Decision[], subject?: readonly string[]): Promise<Asked> => {
        questions.push({ message, choices });
        if (typeof answers === 'function') return answers(message, choices, subject);
        const next = answers[0];
        answers = answers.slice(1);
        if (next === undefined) return { decision: 'no' };
        return typeof next === 'string' ? { decision: next } : next;
    };
    return {
        app,
        store,
        stubRoot,
        questions,
        rules,
        call: (name, input, c = {}) => {
            if (c.answers) answers = c.answers;
            return app.call(name, input, { ask, thread: c.thread });
        }
    };
}

export async function closeAll(): Promise<void> {
    await Promise.all(open.splice(0).map((a) => a.stop().catch(() => {})));
}
