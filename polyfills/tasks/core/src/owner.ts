import { randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = /^([1-9]\d*)-[0-9a-f-]{36}$/;
const LEGACY_BARRIER = 'mcp-tasks owner.v2\n';

function errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException).code;
}

function dead(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        return errorCode(error) === 'ESRCH';
    }
}

// Remove exactly the recorded token. A delayed reclaimer cannot remove a successor's
// different token, and rmdir cannot remove the successor's nonempty directory.
function removeToken(lock: string, token: string): void {
    try { unlinkSync(join(lock, token)); } catch { /* Already removed or inaccessible. */ }
    try { rmdirSync(lock); } catch { /* Absent, not empty, or inaccessible. */ }
}

function publishBarrier(path: string, prepared: string): void {
    try {
        linkSync(prepared, path);
    } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
    }
}

// An older helper uses an exclusive empty directory to serialize reclaims. A regular
// file at that name prevents it reclaiming while we migrate; an existing legacy
// directory is ambiguous, so leave it alone. Reserve the original PID path too, so
// a later old helper cannot acquire it by exclusive creation.
function migrateLegacy(session: string, prepared: string): boolean {
    const owner = join(session, 'owner.pid');
    try {
        if (readFileSync(owner, 'utf8') === LEGACY_BARRIER) return true;
    } catch (error) {
        if (errorCode(error) !== 'ENOENT') return false;
    }
    const reclaim = `${owner}.reclaim`;
    publishBarrier(reclaim, prepared);
    if (!lstatSync(reclaim).isFile() || readFileSync(reclaim, 'utf8') !== LEGACY_BARRIER) return false;
    let old: string | undefined;
    try {
        old = readFileSync(owner, 'utf8');
    } catch (error) {
        if (errorCode(error) !== 'ENOENT') return false;
    }
    if (old !== undefined && old !== LEGACY_BARRIER) {
        if (!/^[1-9]\d*$/.test(old) || !dead(Number(old))) return false;
        unlinkSync(owner);
    }
    publishBarrier(owner, prepared);
    return readFileSync(owner, 'utf8') === LEGACY_BARRIER;
}

export type ReleaseOwner = () => void;

/** Claim the local session until released or this process exits. */
export function claimSessionOwner(session: string): ReleaseOwner | undefined {
    const lock = join(session, 'owner.v2');
    let contents: string[];
    try {
        contents = readdirSync(lock);
    } catch (error) {
        if (errorCode(error) !== 'ENOENT') return;
        contents = [];
    }
    if (contents.length) {
        const token = contents[0]!;
        const match = contents.length === 1 ? TOKEN.exec(token) : null;
        if (!match || !dead(Number(match[1]))) return;
        removeToken(lock, token);
    } else {
        // A crash can leave an empty directory in the gap between unlink and rmdir.
        try { rmdirSync(lock); } catch (error) {
            if (errorCode(error) !== 'ENOENT') return;
        }
    }

    const token = `${process.pid}-${randomUUID()}`;
    let staging: string | undefined;
    let published = false;
    let held = false;
    try {
        staging = mkdtempSync(join(session, '.owner-'));
        const candidate = join(staging, 'lock');
        const barrier = join(staging, 'legacy');
        mkdirSync(candidate, { mode: 0o700 });
        writeFileSync(join(candidate, token), '', { mode: 0o600 });
        writeFileSync(barrier, LEGACY_BARRIER, { mode: 0o600 });
        renameSync(candidate, lock);
        published = true;
        held = migrateLegacy(session, barrier);
        if (held) return () => removeToken(lock, token);
    } catch {
        // Another claimant published first, the filesystem refused, or a legacy owner changed.
    } finally {
        if (published && !held) removeToken(lock, token);
        if (staging) {
            try { rmSync(staging, { recursive: true, force: true }); } catch { /* No published lock here. */ }
        }
    }
}
