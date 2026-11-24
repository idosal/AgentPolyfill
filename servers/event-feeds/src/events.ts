// The Events extension (SEP-3415), server side: events/list and events/poll. Poll is the only
// delivery mode offered (see README, "Delivery modes"); events/stream answers Unsupported, and
// events/subscribe / events/unsubscribe answer Forbidden, because webhook delivery needs an
// authenticated principal and this server has no sign-in.

import { ArgError } from './args.ts';
import { argsHash, CursorError, decodeCursor, type CursorBody } from './cursor.ts';
import { Code, invalidParams, RpcError } from './rpc.ts';
import { pollSnapshot } from './snapshot.ts';
import type { AnySource, Loader } from './source.ts';
import { demoButton } from './sources/button.ts';
import { githubRelease } from './sources/github.ts';
import { hnComment, hnStory } from './sources/hn.ts';
import { npmRelease } from './sources/npm.ts';
import { usgsEarthquake } from './sources/quakes.ts';

export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events';
export const SOURCES: AnySource[] = [demoButton, hnComment, hnStory, npmRelease, githubRelease, usgsEarthquake];

export const DEFAULT_MAX_EVENTS = 20;
export const MAX_EVENTS = 50;
/** nextPollMs after an upstream failure: back off, and keep the client's place. */
export const BACKOFF_MS = 120_000;

export function listEvents(params: Record<string, unknown> | undefined): Record<string, unknown> {
    // One page holds every event type; a pagination cursor can only be one we never issued.
    if (params?.cursor !== undefined && params.cursor !== null) throw invalidParams('invalid cursor: events/list has a single page');
    return {
        resultType: 'complete',
        events: SOURCES.map((s) => ({ name: s.name, description: s.description, delivery: ['poll'], inputSchema: s.inputSchema, payloadSchema: s.payloadSchema }))
    };
}

export function findSource(name: unknown): AnySource {
    if (typeof name !== 'string') throw invalidParams('params.name must be the name of an event type');
    const s = SOURCES.find((x) => x.name === name);
    if (!s) throw new RpcError(Code.NotFound, `no event type named "${name.slice(0, 80)}"`, { kind: 'event' });
    return s;
}

function parseArgs(s: AnySource, raw: unknown, now: number): { a: unknown; h: string } {
    try {
        const a = s.parse(raw, now);
        return { a, h: argsHash(a as Record<string, unknown>) };
    } catch (e) {
        if (e instanceof ArgError) throw invalidParams(e.message, e.data);
        throw e;
    }
}

const optInt = (v: unknown, name: string, min: number): number | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw invalidParams(`${name} must be an integer of at least ${min}`);
    return v;
};

export async function pollEvents(params: Record<string, unknown>, loader: Loader, now: number): Promise<Record<string, unknown>> {
    const s = findSource(params.name);
    const { a, h } = parseArgs(s, params.arguments, now);
    const raw = params.cursor;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') throw invalidParams('cursor must be a string or null');
    const maxAgeMs = optInt(params.maxAgeMs, 'maxAgeMs', 0);
    const maxEvents = Math.min(optInt(params.maxEvents, 'maxEvents', 1) ?? DEFAULT_MAX_EVENTS, MAX_EVENTS);
    let cursor: CursorBody | null = null;
    if (typeof raw === 'string') {
        try {
            cursor = decodeCursor(raw, s.k, h);
        } catch (e) {
            if (e instanceof CursorError) throw invalidParams(`invalid cursor: ${e.message}`, { argument: 'cursor' });
            throw e;
        }
    }
    try {
        if (cursor === null && s.check) await s.check(a, loader);
    } catch (e) {
        if (e instanceof ArgError) throw invalidParams(e.message, e.data);
        throw e;
    }
    const loaded = await s.load(a, loader, now).catch(() => null);
    const empty = (why: string) => {
        // Nothing could be read this time: no events, the client's place kept, a longer wait.
        if (cursor === null) throw new RpcError(Code.InternalError, `the upstream feed is ${why} right now; try again in a minute`, { reason: 'upstream_unavailable', retryAfterMs: 60_000 });
        return { resultType: 'complete', events: [], cursor: raw, truncated: false, hasMore: false, nextPollMs: BACKOFF_MS };
    };
    if (!loaded || !loaded.ok) {
        const why = loaded?.why ?? 'unavailable';
        // An upstream that says "no such thing" when a subscription starts (or a button channel that has
        // expired, at any time) means the arguments are wrong; later on it is treated as a passing failure.
        if (why === 'not_found' && (cursor === null || s === demoButton)) throw invalidParams(s.notFound(a), { reason: 'not_found' });
        return empty(why === 'busy' ? 'busy' : 'unavailable');
    }
    // A stale copy (a fresh read was refused or failed) can start a subscription, but an existing one keeps
    // its place: its cursor may already be ahead of the copy. It is asked back at the usual interval.
    if (loaded.stale && cursor !== null) return { resultType: 'complete', events: [], cursor: raw, truncated: false, hasMore: false, nextPollMs: s.nextPollMs };
    let snap;
    try {
        snap = s.snapshot(loaded.body, a, now);
    } catch {
        return empty('unavailable');
    }
    const out = pollSnapshot(s.k, h, cursor, snap, { now, maxEvents, maxAgeMs, stale: loaded.stale === true });
    return { resultType: 'complete', events: out.events, cursor: out.cursor, truncated: out.truncated, hasMore: out.hasMore, nextPollMs: s.nextPollMs };
}

/** events/stream: push is not offered here. */
export function streamEvents(params: Record<string, unknown>, now: number): never {
    const s = findSource(params.name);
    parseArgs(s, params.arguments, now);
    throw new RpcError(Code.Unsupported, `${s.name} is delivered by poll only (events/poll)`, { feature: 'deliveryMode', value: 'push' });
}

/** events/subscribe and events/unsubscribe: webhook delivery needs an authenticated principal (SEP-3415, Subscription identity). */
export function webhookEvents(): never {
    throw new RpcError(Code.Forbidden, 'webhook delivery needs a signed-in principal, and this server has no sign-in: use events/poll', { reason: 'unauthenticated', feature: 'deliveryMode', value: 'webhook' });
}
