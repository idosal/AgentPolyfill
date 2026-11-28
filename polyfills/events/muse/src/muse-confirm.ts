import { createHash, randomInt } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../../core/src/store.ts';
import { coordinationDir, withSessionLock } from './session-lock.ts';

export const CONFIRM_TTL_MS = 15 * 60 * 1000;
export const TYPEABLE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$/;
type Verb = 'watch' | 'unwatch';
type Pending = { key: string; phrase: string; code: string; summary: string; at: number; approvedAt?: number };
export type Typed = { approved: true } | { pending: string; code: string } | { unavailable: string };

function read(file: string): Pending | undefined {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
}

// Each watch or stop is approved by an exact message in the session that requested it.
export function askTyped(base: string, session: string | undefined, verb: Verb, question: string, now = Date.now(), subject: readonly string[] = [], endpoint = ''): Typed {
    if (!session) return { unavailable: 'Muse did not identify this session.' };
    if (subject.some(word => !TYPEABLE.test(word))) return { unavailable: 'A server or event name cannot be represented in a confirmation phrase.' };
    return withSessionLock<Typed>(base, session, dir => {
        const file = join(dir, verb + '-confirmation.json');
        const key = createHash('sha256').update(JSON.stringify([question, endpoint])).digest('hex');
        const previous = read(file);
        if (previous?.key === key && now - (previous.approvedAt ?? previous.at) <= CONFIRM_TTL_MS) {
            if (previous.approvedAt === undefined) return { pending: previous.phrase, code: previous.code };
            unlinkSync(file);
            return { approved: true };
        }
        // A replacement must use a different code even if the displayed names are the same.
        let code: string;
        do { code = String(randomInt(1000, 10000)); } while (code === previous?.code);
        const phrase = [verb, ...subject, code].join(' ');
        writeAtomic(file, JSON.stringify({ key, phrase, code, summary: question.split('\n')[0]!.slice(0, 300), at: now }));
        return { pending: phrase, code };
    }) ?? { unavailable: 'This session is handling another event request. Try again.' };
}

export function confirmFromPrompt(base: string, session: string, prompt: string, now = Date.now()): { verb: Verb; summary: string } | undefined {
    const said = prompt.trim().replace(/\s+/g, ' ');
    const verb = said.split(' ')[0];
    if (verb !== 'watch' && verb !== 'unwatch') return;
    const file = join(coordinationDir(base, session), verb + '-confirmation.json');
    if (!existsSync(file)) return;
    return withSessionLock(base, session, () => {
        const pending = read(file);
        if (!pending || pending.approvedAt !== undefined || now - pending.at > CONFIRM_TTL_MS || said !== pending.phrase) return;
        writeAtomic(file, JSON.stringify({ ...pending, approvedAt: now }));
        return { verb, summary: pending.summary };
    });
}
