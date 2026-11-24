// What an event type is made of. Each one reads one page from one upstream (built from checked
// arguments only), turns it into items, and leaves the rest to `pollSnapshot`.

import type { Snapshot } from './snapshot.ts';

export type Json = Record<string, unknown>;

/** What a source gets to read its page with. In the Worker it is the edge-cached fetch in upstream.ts. */
export type Loader = {
    json(url: string, ttlSec: number, headers?: Record<string, string>): Promise<Loaded>;
    text(url: string, ttlSec: number, headers?: Record<string, string>): Promise<Loaded>;
    /** The demo button's presses, from its channel's Durable Object. */
    presses(channel: string): Promise<Loaded>;
};

/** `stale`: the last good copy (up to an hour old), given when a fresh read was refused or failed. */
export type Loaded = { ok: true; body: unknown; stale?: true } | { ok: false; why: 'not_found' | 'unavailable' | 'busy' };

export type Source<A> = {
    /** The event name, as in events/list. */
    name: string;
    /** A short tag for cursors. */
    k: string;
    description: string;
    inputSchema: Json;
    payloadSchema: Json;
    /** What the server recommends between polls (SEP-3415, nextPollMs). */
    nextPollMs: number;
    /** Checks and normalises the subscription's arguments; throws ArgError. */
    parse(raw: unknown, now: number): A;
    /** Optional: checks the arguments against the upstream when a subscription starts (cursor null); throws ArgError. */
    check?(a: A, l: Loader): Promise<void>;
    /** Reads the upstream page for these arguments (`now`: server time, for sources whose URL names a time window). */
    load(a: A, l: Loader, now: number): Promise<Loaded>;
    /** Turns the page into a snapshot. Throws on a page it cannot read (treated as unavailable). */
    snapshot(body: unknown, a: A, now: number): Snapshot;
    /** Said when the upstream has no such thing (an unknown package, a private repository). */
    notFound: (a: A) => string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySource = Source<any>;
