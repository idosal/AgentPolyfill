// A stand-in model for tests: a Pi extension that registers a scripted provider
// ("scripted/m1", Pi's own faux provider), so a real Pi runs real turns without
// an API key or a network.
//
// What it answers is set by PI_TEST_RULES, a JSON list of rules tried in order
// against the text of the last message of each request:
//   { "when": "<regex>", "call": { "name": "<tool>", "args": { ... } } }  calls a tool
//   { "when": "<regex>", "say": "<text>" }                                answers with text
// In `args` and `say`, "$1", "$2"... are the regex's groups. With no rule
// matching, it answers "ok". Every request is logged to PI_TEST_BRAIN_LOG, one
// JSON line: the last message's role and text, and the system prompt.

import { appendFileSync } from 'node:fs';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';

type Rule = { when: string; call?: { name: string; args: Record<string, unknown> }; say?: string };
type Msg = { role: string; content: unknown };

const textOf = (m: Msg | undefined): string => {
    if (!m) return '';
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
    return '';
};

const fill = (v: unknown, groups: string[]): unknown => {
    if (typeof v === 'string') return v.replace(/\$(\d)/g, (_, n: string) => groups[Number(n)] ?? '');
    if (Array.isArray(v)) return v.map((x) => fill(x, groups));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, groups)]));
    return v;
};

export default function brain(pi: { registerProvider(p: unknown): void }) {
    const rules = JSON.parse(process.env.PI_TEST_RULES ?? '[]') as Rule[];
    const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'm1' }] });
    pi.registerProvider(faux.provider);
    const step = (context: { messages: Msg[]; systemPrompt?: unknown }) => {
        const last = context.messages.at(-1);
        const text = textOf(last);
        if (process.env.PI_TEST_BRAIN_LOG) {
            appendFileSync(process.env.PI_TEST_BRAIN_LOG, JSON.stringify({ role: last?.role, text, system: JSON.stringify(context.systemPrompt ?? context.messages.filter((m) => m.role === 'system')) }) + '\n');
        }
        for (const r of rules) {
            const m = new RegExp(r.when, 's').exec(text);
            if (!m) continue;
            if (r.call) return fauxAssistantMessage(fauxToolCall(r.call.name, fill(r.call.args, [...m]) as never));
            return fauxAssistantMessage(String(fill(r.say ?? 'ok', [...m])));
        }
        return fauxAssistantMessage('ok');
    };
    faux.setResponses(Array.from({ length: 500 }, () => step as never));
}
