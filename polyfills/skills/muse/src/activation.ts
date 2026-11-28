import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ttl = 120_000;
const valid = /^[a-f0-9]{48}$/;
type Selection = { source: string; uri: string; references: string[]; session: string; turn: string };

function directory(data: string) {
    const path = join(data, 'native-selections');
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) {
        throw Error('The native selection directory must be private.');
    }
    return path;
}

// A selection permits asking for a read. It contains neither file contents nor an approval.
export function selectNative(data: string, selection: Selection): string {
    const dir = directory(data);
    let active = 0;
    for (const name of readdirSync(dir)) {
        if (!valid.test(name) && !/^(?:asked|turn)-[a-f0-9]{64}$/.test(name)) continue;
        const path = join(dir, name);
        const file = lstatSync(path, { throwIfNoEntry: false });
        if (!file) continue;
        const marker = name.includes('-');
        if (Date.now() - file.mtimeMs <= (marker ? 3_600_000 : ttl)) {
            if (!marker) active++;
            continue;
        }
        try {
            unlinkSync(path);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
    }
    if (active >= 128) throw Error('Too many pending native selections.');
    const id = randomBytes(24).toString('hex');
    writeFileSync(join(dir, id), JSON.stringify(selection), { flag: 'wx', mode: 0o600 });
    return id;
}

export function takeNative(data: string, id: unknown): Selection {
    if (typeof id !== 'string' || !valid.test(id)) throw Error('Open a publisher skill in Muse first.');
    const path = join(directory(data), id);
    try {
        const file = lstatSync(path);
        if (!file.isFile() || file.size > 32768 || Date.now() - file.mtimeMs > ttl) throw Error();
        const result = JSON.parse(readFileSync(path, 'utf8'));
        // Only the caller that removes this token can proceed to the owner dialog.
        unlinkSync(path);
        if (
            typeof result.source === 'string' &&
            typeof result.uri === 'string' &&
            Array.isArray(result.references) &&
            typeof result.session === 'string' &&
            typeof result.turn === 'string'
        )
            return result;
    } catch {
        /* Consumed, missing, expired or invalid. */
    }
    throw Error('This native selection expired or was used. Open the skill again.');
}

// This marker records that a prompt was attempted. It never grants access on a later call.
export function reservePrompt(data: string, selection: Selection) {
    const key = createHash('sha256')
        .update(JSON.stringify([selection.session, selection.turn, selection.source, selection.uri]))
        .digest('hex');
    try {
        writeFileSync(join(directory(data), 'asked-' + key), '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            throw Error('A read was already requested for this skill on this turn. Use its existing result.');
        throw error;
    }
}

type TurnChoice = { skip: true } | { source: string; uri: string; reference: string };

function turnPath(data: string, session: unknown, turn: unknown) {
    if (![session, turn].every((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id))) return;
    const key = createHash('sha256').update(JSON.stringify(session)).digest('hex');
    return join(directory(data), 'turn-' + key);
}

// Store the choice only. Prompts, publisher prose and authorization do not belong here.
export function saveTurnChoice(data: string, session: unknown, turn: unknown, choice?: TurnChoice) {
    const path = turnPath(data, session, turn);
    if (!path) return;
    const tmp = path + '.' + randomBytes(12).toString('hex');
    writeFileSync(tmp, JSON.stringify({ turn, choice }), { flag: 'wx', mode: 0o600 });
    try {
        renameSync(tmp, path);
    } catch (error) {
        unlinkSync(tmp);
        throw error;
    }
}

export function turnChoice(data: string, session: string, turn: string): TurnChoice | undefined {
    const path = turnPath(data, session, turn);
    if (!path) return;
    try {
        const current = JSON.parse(readFileSync(path, 'utf8'));
        return current.turn === turn ? current.choice : { skip: true };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}
