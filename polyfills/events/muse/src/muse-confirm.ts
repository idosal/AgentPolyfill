// The person's yes in Muse Code, typed as a message of their own (used by mcp-events' watches and
// mcp-skills' loads in their Muse forms).
//
// Muse gives a plugin no way to put a question to the person: its MCP client offers no
// elicitation, and a tool call that is not read-only, or a hook's "ask", goes to Muse's approval
// judge, a model that may approve it with nobody asked. What only the person can do is type their
// own message: Muse ran a plugin's UserPromptSubmit hook for those, and none of the ways a model can
// put text into a session ran it when each was checked (cron, monitors, subagents, peer messages,
// goals, workflows). So a tool that needs a yes records the question for the session with a
// four-digit code and answers with the question and a phrase that names what it approves
// (`watch tickets ticket.created 4821`, `load hf datasets 4821`): someone misled about the question
// still types the names of what they say yes to. When a message of the person's is exactly that
// phrase, the plugin's hook approves the question (confirmFromPrompt), and the tool's next call for
// the same question goes ahead, once.
//
// The records are the plugin's own (muse-confirm.json in its data folder), one waiting question per
// session and verb, kept 15 minutes.

import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** How long a question waits for the person's phrase, and how long their yes waits for the next call. */
export const CONFIRM_TTL_MS = 15 * 60 * 1000;
const FILE = 'muse-confirm.json';
type Pending = { session: string; verb: string; code: string; phrase?: string; key: string; summary: string; at: number; approvedAt?: number };

function read(dir: string): Record<string, Pending> {
    try {
        const j = JSON.parse(readFileSync(join(dir, FILE), 'utf8')) as unknown;
        return typeof j === 'object' && j !== null && !Array.isArray(j) ? (j as Record<string, Pending>) : {};
    } catch {
        return {};
    }
}

function write(dir: string, all: Record<string, Pending>, now: number): void {
    for (const [k, v] of Object.entries(all)) if (now - (v.approvedAt ?? v.at) > CONFIRM_TTL_MS) delete all[k];
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${FILE}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmp, join(dir, FILE));
}

/** What the person types to say yes: the whole message, nothing else. `subject`: the names of what it approves. */
export const confirmPhrase = (verb: string, code: string, subject: readonly string[] = []) => [verb, ...subject, code].join(' ');

/** A name that can go in a phrase: plain letters, digits and `._:/@+-`, nothing that looks like something else. */
export const TYPEABLE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$/;

export type Typed = { approved: true } | { pending: string; code: string } | { unavailable: string };

/**
 * Asks `question` of the person, in Muse. The first time it is recorded for this session with a new
 * code (the same code while it waits), and the answer says what the person types: the verb, the
 * `subject` names and the code. Once a message of theirs was exactly that phrase, the same question
 * is approved, once. A name that can't be typed plainly (TYPEABLE) isn't asked about at all.
 */
export function askTyped(dir: string, session: string | undefined, verb: string, question: string, now = Date.now(), subject: readonly string[] = []): Typed {
    if (!session) return { unavailable: 'Muse did not say which session this is (MUSE_SESSION_ID), so the person cannot answer by typing' };
    if (subject.some((w) => !TYPEABLE.test(w))) return { unavailable: 'a name in it has characters that the phrase the person types to confirm it can\'t hold' };
    const all = read(dir);
    const slot = `${session} ${verb}`;
    const key = sha256(question);
    const mine = all[slot];
    if (mine && mine.key === key && mine.approvedAt !== undefined && now - mine.approvedAt <= CONFIRM_TTL_MS) {
        delete all[slot];
        write(dir, all, now);
        return { approved: true };
    }
    const code = mine && mine.key === key && mine.approvedAt === undefined && now - mine.at <= CONFIRM_TTL_MS ? mine.code : String(randomInt(1000, 10000));
    const phrase = confirmPhrase(verb, code, subject);
    all[slot] = { session, verb, code, phrase, key, summary: question.split('\n')[0]!.slice(0, 300), at: now };
    write(dir, all, now);
    return { pending: phrase, code };
}

/**
 * Called by a hook with the person's own message: when it is exactly the phrase of a question
 * waiting in this session, that question is approved. Returns its verb and first line, or undefined.
 */
export function confirmFromPrompt(dir: string, session: string, prompt: string, now = Date.now()): { verb: string; summary: string } | undefined {
    const all = read(dir);
    const said = prompt.trim().replace(/\s+/g, ' ').toLowerCase();
    for (const p of Object.values(all)) {
        if (p.session !== session || p.approvedAt !== undefined || now - p.at > CONFIRM_TTL_MS) continue;
        if (said !== (p.phrase ?? confirmPhrase(p.verb, p.code)).toLowerCase()) continue;
        p.approvedAt = now;
        write(dir, all, now);
        return { verb: p.verb, summary: p.summary };
    }
    return undefined;
}
