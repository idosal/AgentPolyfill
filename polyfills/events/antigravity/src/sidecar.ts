import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { alive, ProjectState } from '../../core/src/store.ts';
import { WakeBudget, wakeLimits } from '../../core/src/wake.ts';
import { writePrivate } from '../../../server-cards/antigravity/src/gate.ts';
import { conversationId } from './conversation.ts';
import { pending, readNumber, requestsDir } from './pending.ts';
import { settings } from './settings.ts';
import { WAKE_HEADER, WAKE_PROMPT } from './words.ts';

export const HEARTBEAT_MS = 5000;
export function findAgentapi(env: NodeJS.ProcessEnv = process.env): string | undefined {
    for (const dir of (env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
        const file = join(dir, process.platform === 'win32' ? 'agentapi.exe' : 'agentapi');
        try { if (statSync(file).isFile()) { accessSync(file, constants.X_OK); return file; } } catch {}
    }
}
type Sent = { ok: true } | { ok: false; why: string; maybe?: true };
/** No shell, no inferred conversation, no .cmd/.bat fallback. Output is never repeated. */
export function sendMessage(bin: string, id: string, text: string, env: NodeJS.ProcessEnv, timeoutMs = 60000): Promise<Sent> {
    if (!conversationId(id)) return Promise.resolve({ ok: false, why: 'not a UUID conversationId' });
    if (!isAbsolute(bin) || /\.(cmd|bat)$/i.test(bin)) return Promise.resolve({ ok: false, why: 'agentapi must be an executable, never a shell shim' });
    return new Promise(resolve => {
        let settled = false;
        const finish = (r: Sent) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
        const childEnv = Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !k.startsWith('MCP_EVENTS_') && k !== 'AGENTPOLYFILL_STATE_DIR'));
        const child = spawn(bin, ['send-message', id, text], { shell: false, env: childEnv, stdio: 'ignore', windowsHide: true });
        const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, why: 'agentapi timed out; it may have accepted the message', maybe: true }); }, timeoutMs);
        child.once('error', () => finish({ ok: false, why: 'agentapi could not be started' }));
        child.once('close', code => finish(code === 0 ? { ok: true } : { ok: false, why: `agentapi exited ${code ?? 'by signal'}; acceptance is unknown`, maybe: true }));
    });
}

export function wakeAvailability(base: string, now = Date.now()): string {
    try {
        const h = JSON.parse(readFileSync(join(base, 'wake-heartbeat.json'), 'utf8'));
        if (Number.isInteger(h.pid) && h.pid > 0 && alive(h.pid) && typeof h.at === 'number' && h.at <= now && now - h.at < HEARTBEAT_MS * 3) {
            if (h.available === true) return 'Idle wakes are available: the App wake sidecar has a recent heartbeat and agentapi on PATH.';
            return 'Idle wakes are unavailable: the sidecar has no agentapi executable on PATH. Events wait for this conversation\'s next model call.';
        }
    } catch {}
    return 'Idle wakes are unavailable: no recent App sidecar heartbeat. Events wait for this conversation\'s next model call (CLI, IDE, or sidecar not enabled). Enable mcp-events/wake in ~/.gemini/config/config.json for App wakes.';
}

/** One sidecar owns all wake budgets. Hook delivery never changes those budgets. */
export class WakeSidecar {
    readonly claim: ProjectState;
    constructor(readonly base: string, readonly env: NodeJS.ProcessEnv, readonly log: (s: string) => void = () => {}) {
        this.claim = new ProjectState(base, 'Antigravity wake sidecar', { dir: join(base, 'wake-owner') });
    }
    heartbeat(bin: string | undefined) {
        writePrivate(join(this.base, 'wake-heartbeat.json'), JSON.stringify({ pid: process.pid, at: Date.now(), available: !!bin }));
    }
    async tick(): Promise<void> {
        const env = settings(this.base, this.env);
        if (env.MCP_EVENTS_OFF === '1' || !this.claim.claim('wake').owner) return;
        const bin = findAgentapi(env);
        this.heartbeat(bin);
        if (!bin) return;
        let names: string[];
        try { names = readdirSync(requestsDir(this.base)); } catch { return; }
        for (const name of names) {
            const id = conversationId(name.slice(0, -5));
            if (!name.endsWith('.json') || !id || name !== `${id}.json`) continue;
            try {
                const request = JSON.parse(readFileSync(join(requestsDir(this.base), name), 'utf8'));
                if (request.conversationId !== id || !Number.isFinite(request.after) || request.after > Date.now()) continue;
                await this.wake(id, bin, env);
            } catch { this.log('a wake request could not be processed; events remain stored'); }
        }
    }
    async wake(id: string, bin: string, env: NodeJS.ProcessEnv): Promise<void> {
        if (!conversationId(id)) return;
        const p = pending(this.base, id);
        if (!p) return;
        const positionFile = join(p.spool.dir, 'wake.pos');
        const errorFile = join(p.spool.dir, 'wake-error.json');
        const budget = new WakeBudget(wakeLimits(env), join(p.spool.dir, 'wakes.json'), { liftAfterMs: 3600_000 });
        // A crash during a send counts it once, even if the host never answered.
        const handed = budget.handed;
        if (handed) {
            const wasNotice = budget.noticeHanded;
            writePrivate(positionFile, JSON.stringify({ bytes: Math.max(readNumber(positionFile), handed.upto) }));
            budget.woke(handed.watches);
            if (wasNotice) budget.pause();
        }
        const batch = p.delivery.take();
        if (!batch || batch.upto <= readNumber(positionFile)) return;
        const gate = budget.gate(batch.watches);
        if (gate.kind === 'wait' || gate.kind === 'paused') return;
        // A notice also uses handBatch: its boolean and position are flushed together.
        // After a crash it counts once and restores the pause, without claiming delivery.
        if (gate.kind === 'notice') budget.handNotice();
        if (!budget.handBatch(batch.watches, batch.upto)) return;
        const result = await sendMessage(bin, id, gate.kind === 'notice' ? `${WAKE_HEADER}\n${budget.notice(batch.events)}` : WAKE_PROMPT, env);
        if (!result.ok) {
            writePrivate(errorFile, JSON.stringify({ why: result.why }));
            this.log(result.why);
            if (!result.maybe) { budget.dropHanded(); budget.dropNotice(); return; }
        } else rmSync(errorFile, { force: true });
        writePrivate(positionFile, JSON.stringify({ bytes: batch.upto }));
        budget.woke(batch.watches);
        if (gate.kind === 'notice') budget.pause();
        // No delivery.ack here: the next PreInvocation supplies the actual batch.
    }
    close() {
        if (this.claim.owns('wake')) {
            rmSync(join(this.base, 'wake-heartbeat.json'), { force: true });
            this.claim.release();
        }
    }
}

export async function runSidecar(base: string, env: NodeJS.ProcessEnv, log: (s: string) => void) {
    const sidecar = new WakeSidecar(base, env, log);
    let stopping = false;
    const stop = () => { stopping = true; };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    const heartbeat = setInterval(() => {
        try { if (sidecar.claim.owns('wake') && settings(base, env).MCP_EVENTS_OFF !== '1') sidecar.heartbeat(findAgentapi(env)); } catch {}
    }, HEARTBEAT_MS);
    try {
        while (!stopping) {
            try { await sidecar.tick(); } catch { log('wake sidecar could not read its state; retrying'); }
            await new Promise(r => setTimeout(r, 1000));
        }
    } finally { clearInterval(heartbeat); sidecar.close(); }
}
