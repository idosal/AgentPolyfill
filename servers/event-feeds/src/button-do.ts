// One Durable Object per demo-button channel. It holds that channel's presses (at most 50, each a
// number, a time and an optional short message typed on the page) and deletes all of it when the
// channel's hour is up. This is the only state the server keeps.

import { DurableObject } from 'cloudflare:workers';

export const MAX_PRESSES = 50;
export const MIN_PRESS_GAP_MS = 1000;
export const MAX_MESSAGE = 120;

export type Press = { n: number; ts: number; m?: string };
export type PressResult = { ok: true; n: number } | { ok: false; why: 'too_fast' | 'full' | 'expired' };

export class ButtonChannel extends DurableObject {
    async press(message: string | undefined, now: number, expiresAt: number): Promise<PressResult> {
        if (now >= expiresAt) return { ok: false, why: 'expired' };
        const presses = (await this.ctx.storage.get<Press[]>('p')) ?? [];
        const last = presses.at(-1);
        if (last && now - last.ts < MIN_PRESS_GAP_MS) return { ok: false, why: 'too_fast' };
        if (presses.length >= MAX_PRESSES) return { ok: false, why: 'full' };
        const p: Press = { n: (last?.n ?? 0) + 1, ts: now, ...(message ? { m: message } : {}) };
        presses.push(p);
        await this.ctx.storage.put('p', presses);
        // Everything goes a few minutes after the channel's hour is up.
        if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(expiresAt + 5 * 60_000);
        return { ok: true, n: p.n };
    }

    async presses(): Promise<Press[]> {
        return (await this.ctx.storage.get<Press[]>('p')) ?? [];
    }

    async alarm(): Promise<void> {
        await this.ctx.storage.deleteAll();
    }
}
