// Polling a feed that the server reads as a page of recent items (newest comments in a thread, the
// releases feed of a repository, the past hour of earthquakes).
//
// The cursor holds three things:
//   w  the watermark: how far the subscription has read, in upstream time (ms);
//   s  the ids, on the last page read, that matched the subscription;
//   p  when that page was read (server time, ms), which is what `maxAgeMs` is measured against;
//   f  (only for a subscription started from a stale copy of the page) its start: nothing older is new.
// An item is new when it is on the page, matches, and is not in `s`. That catches items the upstream
// indexes late (an older id appearing after a newer one) as long as they are still on the page, and
// needs no state on the server: the page is shared (cached at the edge), the cursor is the client's.
//
// A gap is possible only when the page no longer reaches back to the watermark (the feed moved on by
// more than a page between two polls). Then `truncated: true`, as SEP-3415 asks, and the subscription
// resumes from the oldest point the page covers.

import { CursorError, encodeCursor, type CursorBody } from './cursor.ts';

export type Occurrence = { eventId: string; name: string; timestamp: string; data: Record<string, unknown> };
export type Item = { id: string; ts: number; occurrence: Occurrence };

export type Snapshot = {
    /** Items on the page that match the subscription's arguments, in any order. */
    items: Item[];
    /** The earliest upstream time from which the page is known to be complete (-Infinity: all of it). */
    covers: number;
    /** Where the feed stands now, in upstream time: the next watermark once everything is delivered. */
    watermark: number;
};

export type PollOptions = { now: number; maxEvents: number; maxAgeMs?: number; stale?: boolean };
export type PollOutcome = { events: Occurrence[]; cursor: string; truncated: boolean; hasMore: boolean };

/** Largest number of ids a snapshot cursor carries (a page is never larger). */
export const MAX_SEEN = 100;

function readCursor(body: CursorBody): { w: number; s: string[]; p: number; f?: number } {
    const { w, s, p, f } = body as { w?: unknown; s?: unknown; p?: unknown; f?: unknown };
    if (f !== undefined && (typeof f !== 'number' || !Number.isFinite(f))) throw new CursorError('cursor is not one this server issued');
    if (typeof w !== 'number' || !Number.isFinite(w)) throw new CursorError('cursor is not one this server issued');
    if (p !== undefined && (typeof p !== 'number' || !Number.isFinite(p))) throw new CursorError('cursor is not one this server issued');
    if (!Array.isArray(s) || s.length > MAX_SEEN || !s.every((x) => typeof x === 'string' && x.length <= 200)) throw new CursorError('cursor is not one this server issued');
    return { w, s: s as string[], p: (p as number | undefined) ?? w, ...(f !== undefined ? { f: f as number } : {}) };
}

const byTime = (a: Item, b: Item) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function pollSnapshot(k: string, h: string, cursor: CursorBody | null, snap: Snapshot, o: PollOptions): PollOutcome {
    const ids = snap.items.map((i) => i.id).slice(0, MAX_SEEN);
    if (cursor === null) {
        // `null` means "start from now": no events, a fresh cursor (SEP-3415, events/poll).
        // Started from a stale copy of the page: items it does not show yet but that are older than this
        // moment happened before the subscription, so they are not new (`f`).
        return { events: [], cursor: encodeCursor({ k, h, w: snap.watermark, s: ids, p: o.now, ...(o.stale ? { f: o.now } : {}) }), truncated: false, hasMore: false };
    }
    const prev = readCursor(cursor);
    const seen = new Set(prev.s);
    const fresh = snap.items.filter((i) => !seen.has(i.id) && !(prev.f !== undefined && i.ts < prev.f)).sort(byTime);
    const gap = prev.w < snap.covers;
    // maxAgeMs: replay starts from the later of the cursor and now - maxAgeMs (SEP-3415, Bounding
    // replay). It matters only when the cursor is older than that floor; when it is, the floor has
    // advanced past the cursor, which is reported as truncated (events older than it are skipped).
    const floorPassed = o.maxAgeMs !== undefined && prev.p < o.now - o.maxAgeMs;
    const floor = floorPassed ? o.now - o.maxAgeMs! : -Infinity;
    const keep = fresh.filter((i) => i.ts >= floor);
    const batch = keep.slice(0, o.maxEvents);
    const rest = new Set(keep.slice(o.maxEvents).map((i) => i.id));
    const hasMore = rest.size > 0;
    const next = {
        k,
        h,
        // Draining a partial batch keeps the old watermark (moved up to where the page begins after a gap),
        // so the rest stays reachable; a complete batch moves it to where the feed stands.
        w: hasMore ? Math.max(prev.w, snap.covers) : Math.max(prev.w, snap.watermark),
        s: ids.filter((id) => !rest.has(id)),
        p: o.now,
        ...(prev.f !== undefined ? { f: prev.f } : {})
    };
    return { events: batch.map((i) => i.occurrence), cursor: encodeCursor(next), truncated: gap || floorPassed, hasMore };
}
