import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../codex/src/store.ts';
import { App } from '../src/app.ts';
import { handlers } from '../src/approval.ts';
import { configPath } from '../src/config.ts';
import { stubRootOf } from '../src/stubs.ts';
import { answerHook } from '../../../server-cards/antigravity/src/gate.ts';
import { preToolUse, tempHome } from '../../../server-cards/antigravity/test/harness.ts';
import type { Fixture } from '../../core/test-fixtures/harness.ts';
export { digest, Fixture, scenarioOf, sizeOf, skill, skillMd, type Entry, type Scenario } from '../../core/test-fixtures/harness.ts';
export { antigravityServer, localWeb, matches, preToolUse, runHook, tempHome } from '../../../server-cards/antigravity/test/harness.ts';
export const temp = tempHome;
export const TOOL = 'mcp_mcp-skills_skills_load_skill';
type Decision = 'load' | 'no';
type Asked = { decision: Decision } | { unavailable: string };
type Answers = (Decision | Asked)[] | ((message: string, choices: Decision[]) => Asked);
export type Started = {
    app: App; store: Store; stubRoot: string; env: NodeJS.ProcessEnv;
    questions: { message: string; choices: Decision[] }[];
    call: (name: string, args: Record<string, unknown>, o?: { thread?: string; answers?: Answers }) => Promise<{ text: string; isError?: boolean }>;
};
const open: App[] = [];
export function writeConfig(home: string, servers: Record<string, unknown>) {
    const file = configPath({ HOME: home });
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: servers }));
}
export async function startApp(servers: Record<string, Fixture>, o: { answers?: Answers; store?: Store; stubRoot?: string; now?: () => number } = {}): Promise<Started> {
    const home = tempHome(), store = o.store ?? new Store(join(home, 'state'));
    const env = { HOME: home, PATH: process.env.PATH };
    writeConfig(home, Object.fromEntries(Object.entries(servers).map(([name, f]) => [name, f.config])));
    const stubRoot = o.stubRoot ?? stubRootOf(home);
    const app = new App({ env, store, stubRoot, now: o.now });
    open.push(app);
    await app.start();
    const questions: Started['questions'] = [];
    let answers = o.answers ?? [];
    return { app, store, env, stubRoot, questions, call: async (name, args, c = {}) => {
        if (name === 'list_skills') return app.call(name, args);
        // As Antigravity calls an eager MCP tool (plugin/mcp_config.json marks the three gated ones eager), with
        // the toolSummary it adds for its own display and takes out before the server gets the call.
        const hook = await answerHook(preToolUse(`mcp_mcp-skills_skills_${name}`, { ...args, toolSummary: `Calling ${name}` }, c.thread ?? 'test-conversation'), handlers(env, store), store.dir, Date.now(), 'mcp-skills_skills');
        if (hook.decision === 'deny') return { text: String(hook.reason), isError: true };
        if (c.answers) answers = c.answers;
        if (hook.decision === 'force_ask') {
            const message = String(hook.reason), choices: Decision[] = ['no', 'load'];
            questions.push({ message, choices });
            const answer = typeof answers === 'function' ? answers(message, choices) : answers.shift();
            if (!(answer === 'load' || (typeof answer === 'object' && 'decision' in answer && answer.decision === 'load'))) return { text: 'The user did not approve the skill, so it is not loaded.', isError: true };
        }
        return app.call(name, { ...args, ...(hook.overwrite as Record<string, unknown>) });
    } };
}
export async function closeAll() { await Promise.all(open.splice(0).map(a => a.stop())); }
