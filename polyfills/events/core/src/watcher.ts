// Runs each watch: one SEP-3415 subscription and its delivery loop.
//
//   push     one `events/stream` per watch. On Streamable HTTP, a stream with no message for
//            three times the granted heartbeat is reconnected with its last cursor.
//   poll     `events/poll` at the server's `nextPollMs` (never sooner than a floor, 1 s by
//            default), and at once while `hasMore`.
//   webhook  `events/subscribe` to an address for this watch, refreshed before `refreshBefore`.
//            With a relay the address lasts: the subscription is kept when the session
//            closes, and what the server delivers meanwhile is collected on the next start.
//            Without one the address is the local receiver's (a public forwarder of
//            yours) and dies with the session, so the watch unsubscribes on exit.
//
// The mode is chosen as the SEP's client guidance orders them: webhook where a webhook address
// is set up, the connection is authenticated and the server lists it; then push; then poll.
// Every occurrence is deduplicated by eventId within its watch, written to the
// session spool (which the monitor prints), and its cursor saved.

import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { errorCode, EventsConnection, EventsError, type DeliveryMode, type Occurrence } from './events-client.ts';
import { shownEvent } from './format.ts';
import { mailboxIdOf } from './relay-protocol.ts';
import { dropLegacyMailboxKey, legacyMailboxKey, readRelaySettings, RelayClient, serverMailboxKey } from './relay.ts';
import { host } from './host.ts';
import { publicAddress } from './tunnel.ts';
import { describeError, isoDate, LocalError, secrets } from './untrusted.ts';
import { MAX_CURSOR, newSecret, Receiver, ReplayGuard, type Hook } from './webhooks.ts';
import { alive, peekSpool, saveDeliveredPosition, type ProjectState, type Spool, type SpoolRecord, type Watch } from './store.ts';

type Json = Record<string, unknown>;
/** How soon a poll may follow the last one, whatever the server says (MCP_EVENTS_MIN_POLL_MS). */
const DEFAULT_POLL_FLOOR_MS = 1000;
/** What a poll waits when the server recommends nothing. */
const DEFAULT_POLL_MS = 30000;
/** How long an opened stream may stay silent before its first message. */
const FIRST_MESSAGE_MS = 60000;
const MAX_BACKOFF_MS = 60000;
const SEEN_LIMIT = 500;
/** The largest event taken (the SEP's webhook examples stop at 256 KiB), and the deepest nesting. */
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_EVENT_DEPTH = 24;
const tooDeep = (v: unknown, left = MAX_EVENT_DEPTH): boolean => typeof v === 'object' && v !== null && (left === 0 || Object.values(v).some((x) => tooDeep(x, left - 1)));
/** Errors that end a subscription: a retry of the same request will not fix them. */
const FATAL = new Set<number>([EventsError.NotFound, EventsError.Forbidden, EventsError.Unsupported, -32602, -32601]);
/** Of those, the ones that mean the event type itself went away or changed: list again, and subscribe to what is there now. */
const RELIST = new Set<number>([EventsError.NotFound, EventsError.Unsupported]);
/** The cursor of one polled event is the response's, not the event's: leave the watch's cursor alone. */
const KEEP = Symbol('keep');

/** A time a server gave, as milliseconds this plugin will actually wait: finite, and within bounds. */
const within = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        const onAbort = () => {
            clearTimeout(t);
            resolve();
        };
        const t = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, within(ms, 0, 2 ** 31 - 1, 1000));
        signal?.addEventListener('abort', onAbort, { once: true });
    });
const jitter = (ms: number) => Math.round(ms * (0.5 + Math.random() / 2));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Where webhook deliveries arrive: the relay, or the local receiver behind a public URL. */
type Sink = {
    kind: 'relay' | 'configured';
    /** The public base address, for messages. */
    url: string;
    /** What every address this sink gives begins with (for the relay, its mailbox's addresses). */
    prefix: string;
    /** Whether an address outlives this process (the relay's do). */
    lasting: boolean;
    /** Gives a hook an address. `id` reuses the address a watch already has. */
    add(hook: Hook, id?: string): Promise<{ id: string; url: string }>;
    /** Stops receiving for an address; `forget` retires it for good. */
    remove(id: string, forget: boolean): Promise<void>;
    close(): Promise<void>;
};

/** A subscription's time to live: a lasting address is worth keeping across a night with the laptop closed. */
const TTL_LASTING_MS = 24 * 3600 * 1000;
const TTL_SESSION_MS = 15 * 60000;
/** However long a subscription was granted, it is refreshed at least this often: the refresh is also where delivery problems show. */
const MAX_REFRESH_WAIT_MS = 3600 * 1000;

export type ManagerOptions = {
    connections: Map<string, EventsConnection>;
    project: ProjectState;
    spool: Spool;
    session: string;
    log?: (s: string) => void;
    env?: NodeJS.ProcessEnv;
    connectTimeoutMs?: number;
    /** Told every secret this manager makes, so the log never shows one. */
    redact?: { add: (...secrets: (string | undefined)[]) => void };
};

export class WatchManager {
    readonly connections: Map<string, EventsConnection>;
    readonly project: ProjectState;
    readonly spool: Spool;
    readonly session: string;
    #log: (s: string) => void;
    #env: NodeJS.ProcessEnv;
    #timeout: number;
    #runs = new Map<string, { ac: AbortController; done: Promise<void>; unwatch: boolean }>();
    /** When a watch last had its event type listed again after the server ended it, so that it does not loop. */
    #relisted = new Map<string, number>();
    /** Where webhooks arrive: with a relay, one mailbox per MCP server (by name); otherwise one receiver (''). */
    #sinks = new Map<string, Promise<Sink>>();
    /** The project's one mailbox from before 0.7.0, opened only to move the watches still there to their servers' mailboxes. */
    #legacy?: Promise<{ client: RelayClient; prefix: string } | undefined>;
    #saveTimer?: NodeJS.Timeout;
    #redact?: ManagerOptions['redact'];
    #saidNoSocket = false;
    owner = false;
    holder?: { session: string; pid: number };
    /** Where webhook deliveries go, once a webhook watch has set it up. */
    webhookAddress?: { url: string; kind: Sink['kind']; isPublic?: true };

    constructor(o: ManagerOptions) {
        this.connections = o.connections;
        this.project = o.project;
        this.spool = o.spool;
        this.session = o.session;
        this.#log = o.log ?? (() => {});
        this.#env = o.env ?? process.env;
        this.#timeout = o.connectTimeoutMs ?? 15000;
        this.#redact = o.redact;
        for (const w of this.watches) this.#redact?.add(w.webhook?.secret, w.webhook?.url);
    }

    get watches(): Watch[] {
        return this.project.watches;
    }

    /** Claims the project and resumes its saved watches from their cursors. Returns whether this session runs them; a session that does not may ask again later. */
    start(): boolean {
        if (this.owner) return true;
        const c = this.project.claim(this.session);
        this.owner = c.owner;
        if (!c.owner) {
            this.holder = c.holder;
            for (const w of this.watches) w.status = 'elsewhere';
            return false;
        }
        this.holder = undefined;
        this.project.reload();
        for (const w of this.watches) this.#redact?.add(w.webhook?.secret, w.webhook?.url);
        try {
            this.#recover();
        } catch {
            this.#log('what earlier sessions left behind could not be read; nothing was taken from it');
        }
        for (const w of this.watches) if (w.status !== 'ended') this.#run(w);
        return true;
    }

    /**
     * What earlier helpers of this project left behind, read before the watches run:
     *   - an event already in a listed session's spool counts as seen, though its watch was not
     *     saved after it (the helper stopped between the two writes), so it is not written again;
     *   - an event an earlier session stored and never handed over (Claude Code closed while its
     *     wake waited) is appended to this session's spool, in one write, unless it was handed over
     *     somewhere or is here already; then that session counts it as handed over and is taken off
     *     the list. A session whose helper still runs is left alone.
     * Everything is read, and the carry worked out, before anything is written; the seen ids are
     * saved before any session is taken off the list, since after that nothing else would say the
     * events in its spool were seen. If they cannot be saved, nothing is taken off: the next helper
     * reads it all again. A crash between the append and the marking can show such an event twice;
     * it cannot lose it. (model/delivery.qnt: recovery, Carry, SaveSeen and Settle.)
     */
    #recover(): void {
        const base = dirname(dirname(this.spool.dir));
        const mine = new Set(this.watches.map((w) => w.id));
        this.project.list(this.session);
        const key = (r: SpoolRecord) => `${r.watch}\0${r.eventId}`;
        const isEvent = (r: SpoolRecord) => r.kind === 'event' && typeof r.watch === 'string' && mine.has(r.watch) && typeof r.eventId === 'string';
        const here = new Set(this.spool.all().filter(isEvent).map(key));
        const handed = new Set<string>();
        const found = new Map<string, Set<string>>();
        const waiting: SpoolRecord[] = [];
        const settle: { session: string; dir: string; size: number }[] = [];
        for (const { session, pid } of this.project.listed()) {
            if (session === this.session) continue;
            // Still running (another window that lost the claim a moment ago): not ours to take from.
            if (pid !== process.pid && alive(pid)) continue;
            const peek = peekSpool(base, session);
            for (const { rec, end } of peek.records) {
                if (!isEvent(rec)) continue;
                let ids = found.get(rec.watch!);
                if (!ids) found.set(rec.watch!, (ids = new Set()));
                ids.add(rec.eventId!);
                if (end <= peek.delivered) handed.add(key(rec));
                else waiting.push(rec);
            }
            settle.push({ session, dir: peek.dir, size: peek.size });
        }
        for (const r of this.spool.all()) if (isEvent(r)) (found.get(r.watch!) ?? found.set(r.watch!, new Set()).get(r.watch!)!).add(r.eventId!);
        let changed = false;
        for (const w of this.watches) {
            const have = new Set(w.seen);
            // In spool order, so that the latest are the ones kept.
            for (const id of found.get(w.id) ?? []) {
                if (have.has(id)) continue;
                have.add(id);
                w.seen.push(id);
                changed = true;
            }
            if (w.seen.length > SEEN_LIMIT) w.seen.splice(0, w.seen.length - SEEN_LIMIT);
        }
        const carry: SpoolRecord[] = [];
        for (const r of waiting) {
            if (handed.has(key(r)) || here.has(key(r))) continue;
            here.add(key(r));
            carry.push(r);
        }
        if (carry.length) {
            this.spool.appendMany(carry.map(({ id: _id, ...r }) => r));
            this.#log(`${carry.length} event(s) an earlier session stored and never showed are shown in this one`);
        }
        // Saved first: taken off the list before the ids were saved, an event in an earlier spool
        // could be stored and shown again (the model found this in 0.5.0).
        if (changed && !this.#saveNow()) {
            this.#log('the watches could not be saved; what earlier sessions left behind stays listed, to be read again');
            return;
        }
        for (const s of settle) {
            try {
                saveDeliveredPosition(s.dir, s.size);
            } catch {
                // its folder is gone: nothing left there to take
            }
        }
        this.project.unlist(settle.map((s) => s.session));
    }

    async stop(): Promise<void> {
        for (const r of this.#runs.values()) r.ac.abort();
        await Promise.race([Promise.allSettled([...this.#runs.values()].map((r) => r.done)), sleep(5000)]);
        this.#saveNow();
        for (const sink of this.#sinks.values()) await (await sink.catch(() => undefined))?.close();
        if (this.#legacy) await (await this.#legacy.catch(() => undefined))?.client.close();
        if (this.owner) this.project.release();
    }

    async add(p: { server: string; event: string; arguments?: Json; note?: string; maxAgeMs?: number }): Promise<Watch> {
        if (!this.owner) throw new LocalError(`another ${host.other} (pid ${this.holder?.pid}) runs ${host.scope} watches; watch from there, or close it`);
        const conn = this.connections.get(p.server);
        if (!conn) throw new LocalError(`no MCP server by that name offers events. Known: ${[...this.connections.keys()].join(', ') || 'none'}`);
        const type = conn.eventTypes.find((t) => t.name === p.event);
        if (!type) throw new LocalError(`server "${conn.name}" has no event type by that name. It has: ${conn.eventTypes.map((t) => t.name).join(', ')}`);
        const mode = this.#mode(conn, type.delivery);
        if (mode === 'webhook') await this.#rx(p.server); // fail now, not later, if no public URL can be had
        const w: Watch = {
            id: 'w-' + randomBytes(3).toString('hex'),
            server: p.server,
            fingerprint: conn.fingerprint,
            event: p.event,
            arguments: p.arguments ?? {},
            note: p.note,
            ...(typeof p.maxAgeMs === 'number' && Number.isSafeInteger(p.maxAgeMs) && p.maxAgeMs > 0 ? { maxAgeMs: p.maxAgeMs } : {}),
            mode,
            cursor: null, // null = from now on
            createdAt: new Date().toISOString(),
            events: 0,
            status: 'starting',
            seen: []
        };
        this.watches.push(w);
        this.#saveNow();
        this.#run(w);
        return w;
    }

    /**
     * The host no longer lets this session use `server` (switched off or removed mid-session): its
     * watches stop listening, as when the process stops (a lasting webhook subscription stays with
     * its relay), and wait, saved, until a session has the server again. Nothing is removed.
     */
    async suspend(server: string): Promise<void> {
        const runs = this.watches.filter((w) => w.server === server).map((w) => [w, this.#runs.get(w.id)] as const);
        for (const [, r] of runs) r?.ac.abort();
        await Promise.race([Promise.allSettled(runs.map(([, r]) => r?.done)), sleep(5000)]);
        for (const [w] of runs) if (w.status !== 'ended') this.#status(w, 'error', 'its server is not available in this session');
        if (this.owner) this.#saveNow();
    }

    /**
     * Starts the saved watches of `server` that are not running: its connection arrived after they
     * were loaded (they were marked unavailable then), or it is back. Only in the process that runs them.
     */
    resume(server: string): void {
        if (!this.owner) return;
        for (const w of this.watches) if (w.server === server && w.status !== 'ended' && !this.#runs.has(w.id) && this.connections.has(server)) this.#run(w);
    }

    async remove(id: string): Promise<Watch> {
        if (!this.owner) throw new LocalError(`another ${host.other} (pid ${this.holder?.pid}) runs ${host.scope} watches; stop the watch from there`);
        const w = this.watches.find((x) => x.id === id);
        if (!w) throw new LocalError('no watch by that id');
        const run = this.#runs.get(id);
        if (run) {
            run.unwatch = true;
            run.ac.abort();
            await Promise.race([run.done, sleep(5000)]);
        }
        w.status = 'ended';
        this.project.watches = this.watches.filter((x) => x.id !== id);
        this.#saveNow();
        return w;
    }

    // ---- internals -----------------------------------------------------------------

    /** Whether a webhook address is set up at all (a relay, or a public forwarder of the user's). */
    #webhookConfigured(): boolean {
        return !!this.#relay() || !!this.#env.MCP_EVENTS_PUBLIC_URL;
    }

    /**
     * The relay's settings, where it can be used. It is reached over a WebSocket, which Node has
     * built in from version 22 (and Bun has): on an older Node the relay is left alone, said once.
     */
    #relay(): ReturnType<typeof readRelaySettings> {
        const relay = readRelaySettings(this.#env, this.#log);
        if (relay && typeof WebSocket === 'undefined') {
            if (!this.#saidNoSocket) this.#log('a relay is set up, but webhook delivery through it needs Node 22 or newer (or Bun); push and poll are used instead');
            this.#saidNoSocket = true;
            return undefined;
        }
        return relay;
    }

    /**
     * The delivery mode for an event type, in the SEP's order of preference: webhook where a
     * webhook address is set up; then push; then poll. Webhook needs an authenticated connection
     * (`events/subscribe` must be called with an authenticated principal).
     */
    #mode(conn: EventsConnection, delivery: DeliveryMode[]): DeliveryMode {
        const authenticated = conn.authenticated || this.#env.MCP_EVENTS_DEV === '1';
        if (delivery.includes('webhook') && authenticated && this.#webhookConfigured()) return 'webhook';
        if (delivery.includes('push')) return 'push';
        if (delivery.includes('poll')) return 'poll';
        if (!authenticated) throw new LocalError('this event type is delivered by webhook only, and a webhook subscription needs a connection that carries your credentials (the Events extension requires an authenticated caller); this one has none');
        return 'webhook';
    }

    #run(w: Watch): void {
        const conn = this.connections.get(w.server);
        // A server this session may not use (switched off, no longer approved, removed) is not listened
        // to either: a watch saved earlier stays put until the server is back.
        if (!conn) {
            this.#status(w, 'error', 'its server is not available in this session');
            return;
        }
        if (conn.fingerprint !== w.fingerprint) {
            this.#fail(w, `the server named "${w.server}" now points somewhere else; watch it again to confirm`);
            return;
        }
        // `events/subscribe` must be called by an authenticated principal. That was checked when the
        // watch was made; a saved watch is checked again, in case the credentials have since been
        // taken out of the server's configuration.
        if (w.mode === 'webhook' && !(conn.authenticated || this.#env.MCP_EVENTS_DEV === '1')) {
            this.#fail(w, 'a webhook subscription needs a connection that carries your credentials (the Events extension requires an authenticated caller); this one no longer has any. Watch it again once it does');
            return;
        }
        const ac = new AbortController();
        const loop = w.mode === 'push' ? this.#push(w, ac.signal) : w.mode === 'poll' ? this.#poll(w, ac.signal) : this.#webhook(w, ac.signal);
        const entry = { ac, unwatch: false, done: Promise.resolve() };
        entry.done = loop
            .catch((e) => void this.#fail(w, describeError(e)))
            .then((again) => {
                this.#runs.delete(w.id);
                // The event type changed under the watch: it starts again, against what the server offers now.
                if (again === 'restart' && !ac.signal.aborted && this.owner) this.#run(w);
            });
        this.#runs.set(w.id, entry);
    }

    async #conn(name: string): Promise<EventsConnection> {
        const conn = this.connections.get(name);
        if (!conn) throw new LocalError(`server ${name} is not configured`);
        if (!conn.connected) {
            await conn.connect(this.#timeout);
            await conn.list();
        }
        // Nothing is sent to a server that does not (or no longer does) advertise the extension.
        if (!conn.declaration) throw new LocalError('the server does not advertise the Events extension');
        return conn;
    }

    /** `events/unsubscribe`. If the server says the routing headers did not match its declaration, the event types are listed again and it is tried once more. */
    async #unsubscribe(conn: EventsConnection, w: Watch, url: string): Promise<void> {
        const params = { name: w.event, arguments: w.arguments, delivery: { url } };
        try {
            await conn.unsubscribe(params);
        } catch (e) {
            if (errorCode(e) !== EventsError.HeaderMismatch) throw e;
            await conn.list();
            await conn.unsubscribe(params);
        }
    }

    #status(w: Watch, status: Watch['status'], error?: string): void {
        if (w.status === status && w.error === error) return;
        w.status = status;
        w.error = error;
        this.#saveSoon();
    }

    #fail(w: Watch, why: string): void {
        this.#status(w, 'error', why);
        this.notice(`Watch ${w.id} (${w.server} · ${shownEvent(w.event)}) stopped: ${why}`, w.id);
    }

    notice(text: string, watch?: string): void {
        try {
            this.spool.append({ kind: 'notice', text, watch });
        } catch {
            this.#log('a notice could not be written to the session\'s event store');
        }
    }

    /**
     * The server ended the subscription (or refused it for good). If the event type was removed
     * or changed, the list is read again and, where the type is still offered, the watch starts
     * over against it. Otherwise the watch is removed, and the session is told.
     */
    async #ended(w: Watch, code: number | undefined, how: string): Promise<'restart' | undefined> {
        if (code !== undefined && RELIST.has(code) && Date.now() - (this.#relisted.get(w.id) ?? 0) > 60000) {
            this.#relisted.set(w.id, Date.now());
            const conn = this.connections.get(w.server);
            try {
                if (conn?.connected) await conn.list();
                const type = conn?.eventTypes.find((t) => t.name === w.event);
                if (conn && type) {
                    w.mode = this.#mode(conn, type.delivery);
                    this.notice(`Watch ${w.id} (${w.server} · ${shownEvent(w.event)}): ${how} (error ${code}); the event type is still offered, so the watch starts again against it as it is now.`, w.id);
                    this.#status(w, 'starting');
                    return 'restart';
                }
            } catch {
                // the list could not be read, or no mode fits any more: the watch ends below
            }
        }
        this.notice(`Watch ${w.id} (${w.server} · ${shownEvent(w.event)}) ended: ${how}${code !== undefined ? ` (${describeError({ code }).replace(/^the server answered /, '')})` : ''}. It has been removed.`, w.id);
        w.status = 'ended';
        this.project.watches = this.watches.filter((x) => x.id !== w.id);
        this.#relisted.delete(w.id);
        this.#saveNow();
        return undefined;
    }

    /** Takes the position a server gave. An absent cursor is a `null` cursor: there is nothing to resume from. */
    #cursor(w: Watch, c: string | null | undefined): void {
        const next = typeof c === 'string' && c.length <= MAX_CURSOR ? c : null;
        if (next === w.cursor) return;
        w.cursor = next;
        this.#saveSoon();
    }

    async #deliver(w: Watch, o: Occurrence, cursor: string | null | undefined | typeof KEEP): Promise<void> {
        if (!o || typeof o.eventId !== 'string' || o.eventId.length > 512) return;
        // A session that no longer runs this project's watches takes nothing (and so acknowledges nothing).
        if (!this.#stillOwner()) throw new LocalError('another session runs this project\'s watches now');
        const position = cursor === KEEP ? w.cursor : typeof cursor === 'string' && cursor.length <= MAX_CURSOR ? cursor : null;
        if (!w.seen.includes(o.eventId)) {
            // An event too big or too deeply nested to handle safely is not shown; it is noted, and not asked for again.
            let size = Infinity;
            try {
                size = tooDeep(o) ? Infinity : JSON.stringify(o).length;
            } catch {
                // cannot be measured: treated as too large
            }
            if (size > MAX_EVENT_BYTES) {
                this.notice(`Watch ${w.id} (${w.server} · ${shownEvent(w.event)}): one event was too large or too deeply nested to show, and was skipped.`, w.id);
                w.seen.push(o.eventId);
                if (w.seen.length > SEEN_LIMIT) w.seen.splice(0, w.seen.length - SEEN_LIMIT);
                w.cursor = position;
                this.#saveNow();
                return;
            }
            // A server that echoes back a token it was given does not get it shown.
            const data = secrets.scrubDeep(typeof o.data === 'object' && o.data !== null && !Array.isArray(o.data) ? o.data : {});
            const meta = (o as { _meta?: unknown })._meta;
            // Written down first, and only then marked seen: if the write throws, the delivery is retried.
            // The event's name is the watch's own (the server's copy of it is not repeated).
            this.spool.append({ kind: 'event', watch: w.id, server: w.server, event: w.event, eventId: secrets.scrub(o.eventId), timestamp: isoDate(o.timestamp), data, ...(typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? { meta: secrets.scrubDeep(meta as Json) } : {}), note: w.note });
            w.seen.push(o.eventId);
            if (w.seen.length > SEEN_LIMIT) w.seen.splice(0, w.seen.length - SEEN_LIMIT);
            w.events++;
            w.lastEventAt = new Date().toISOString();
        }
        w.cursor = position;
        // Saved before the delivery is acknowledged. A crash between the two writes can show an
        // event twice after a restart (delivery is at least once); it cannot lose one.
        if (!this.#saveNow()) throw new LocalError('the watch could not be saved');
    }

    /** A failed request: the subscription is over (the code is returned), or it is worth trying again. */
    async #failed(w: Watch, e: unknown): Promise<{ ended: number } | undefined> {
        const code = errorCode(e);
        if (code !== undefined && FATAL.has(code)) return { ended: code };
        // The headers sent no longer match what the server expects of this event type: read its descriptor again.
        if (code === EventsError.HeaderMismatch) await this.connections.get(w.server)?.list().catch(() => undefined);
        this.#status(w, 'retrying', describeError(e));
        return undefined;
    }

    async #push(w: Watch, signal: AbortSignal): Promise<'restart' | undefined> {
        let backoff = 1000;
        while (!signal.aborted) {
            let conn: EventsConnection;
            try {
                conn = await this.#conn(w.server);
            } catch (e) {
                this.#status(w, 'retrying', describeError(e));
                await sleep(jitter(backoff), signal);
                backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
                continue;
            }
            // On Streamable HTTP a dead connection is told from a quiet one by the heartbeat: no message
            // for three times the granted interval, counted from `active`. On stdio the end of the
            // server's output is the signal, and the heartbeat only moves the cursor.
            const watchdog = !conn.stdio;
            let last = Date.now();
            let heartbeat: number | undefined;
            // A server "sends a heartbeat whenever heartbeatMs passes without any other message", so
            // the quiet before each heartbeat is the interval it keeps. Used only when `active` grants
            // none: a grant is authoritative.
            let kept: number | undefined;
            let flowed = false;
            let terminated: { code?: number } | undefined;
            const sent = w.cursor;
            /** Whether the server has confirmed this stream once: from then on, `truncated` is a gap whatever the stream was opened with. */
            let confirmed = false;
            // Events are taken one at a time, in order. If one cannot be written down, nothing after it
            // is taken and the cursor stays where it was: the stream is reopened from there, so the
            // event comes again instead of being passed over by a later cursor.
            let chain: Promise<void> = Promise.resolve();
            let broken: { error: unknown } | undefined;
            const inOrder = (step: () => void | Promise<void>) => {
                chain = chain.then(async () => {
                    if (broken) return;
                    try {
                        await step();
                    } catch (e) {
                        broken = { error: e };
                        s.cancel();
                    }
                });
            };
            const s = conn.stream(
                { name: w.event, arguments: w.arguments, cursor: w.cursor, heartbeatMs: 15000, ...(w.maxAgeMs ? { maxAgeMs: w.maxAgeMs } : {}) },
                {
                    active: (a) => {
                        last = Date.now();
                        flowed = true;
                        // The grant is the server's to make, and is taken as given.
                        if (typeof a.heartbeatMs === 'number' && Number.isFinite(a.heartbeatMs) && a.heartbeatMs > 0) heartbeat = a.heartbeatMs;
                        // With no cursor supplied there was no position to be skipped past when the stream opened.
                        // Once it is open there is one: `active` again mid-stream with `truncated` is a gap.
                        if (a.truncated && (sent !== null || confirmed)) this.notice(`Watch ${w.id} (${w.server} · ${shownEvent(w.event)}): some events were skipped; the server could not replay from where this watch left off.`, w.id);
                        confirmed = true;
                        inOrder(() => {
                            this.#cursor(w, a.cursor);
                            this.#status(w, 'active');
                        });
                    },
                    event: (o) => {
                        last = Date.now();
                        inOrder(() => this.#deliver(w, o, o.cursor));
                    },
                    heartbeat: (h) => {
                        const now = Date.now();
                        if (flowed) kept = Math.max(kept ?? 0, now - last);
                        last = now;
                        inOrder(() => this.#cursor(w, h.cursor));
                    },
                    error: (p) => {
                        last = Date.now();
                        this.#log(`watch ${w.id}: the server reported a transient error (${describeError(p.error)})`);
                    },
                    terminated: (t) => {
                        terminated = { code: typeof t.error?.code === 'number' ? t.error.code : undefined };
                        // The subscription is over; the server ends the stream. If it does not, the request is let go.
                        setTimeout(() => s.cancel(), 2000).unref();
                    }
                }
            );
            const onAbort = () => s.cancel();
            signal.addEventListener('abort', onAbort, { once: true });
            const dog = setInterval(() => {
                if (!watchdog || terminated) return;
                const quiet = Date.now() - last;
                const interval = heartbeat ?? kept;
                if (interval === undefined ? quiet > FIRST_MESSAGE_MS : quiet > 3 * interval) {
                    this.#log(`watch ${w.id}: stream silent for ${quiet} ms; reconnecting`);
                    s.cancel();
                }
            }, 500);
            let failure: unknown;
            try {
                await s.done;
            } catch (e) {
                failure = e;
            } finally {
                clearInterval(dog);
                signal.removeEventListener('abort', onAbort);
            }
            await chain;
            if (signal.aborted) return undefined;
            if (broken) {
                // Not the server's doing: try again from the same place, slowly.
                this.#status(w, 'retrying', describeError(broken.error));
                await sleep(jitter(backoff), signal);
                backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
                continue;
            }
            if (terminated) return this.#ended(w, terminated.code, 'the server ended the subscription');
            if (failure !== undefined) {
                const f = await this.#failed(w, failure);
                if (f) return this.#ended(w, f.ended, 'the server refused the subscription');
            } else this.#status(w, 'retrying', 'stream closed by the server');
            if (flowed) backoff = 1000;
            // A random wait, so that a server coming back is not met by every client at once.
            await sleep(jitter(backoff), signal);
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
        return undefined;
    }

    async #poll(w: Watch, signal: AbortSignal): Promise<'restart' | undefined> {
        let backoff = 1000;
        const floor = within(Number(this.#env.MCP_EVENTS_MIN_POLL_MS), 100, 3600 * 1000, DEFAULT_POLL_FLOOR_MS);
        while (!signal.aborted) {
            try {
                const conn = await this.#conn(w.server);
                const sent = w.cursor;
                const r = await conn.poll({ name: w.event, arguments: w.arguments, cursor: w.cursor, maxEvents: 100, ...(w.maxAgeMs ? { maxAgeMs: w.maxAgeMs } : {}) });
                // With no cursor supplied there was no position to be skipped past.
                if (r.truncated && sent !== null) this.notice(`Watch ${w.id} (${w.server} · ${shownEvent(w.event)}): some events were skipped; the server could not replay from where this watch left off.`, w.id);
                const before = w.events;
                let taken = 0;
                for (const o of r.events) {
                    await this.#deliver(w, o, KEEP);
                    // A very long answer does not keep everything else waiting.
                    if (++taken % 25 === 0) await new Promise((r) => setImmediate(r));
                }
                this.#cursor(w, r.cursor);
                this.#status(w, 'active');
                backoff = 1000;
                // More is waiting: poll again at once with the new cursor, ignoring `nextPollMs`, to drain
                // it. A batch that brought nothing new still drains, but no faster than the floor, so that
                // a server which always says "more" cannot spin this loop.
                if (r.hasMore) {
                    if (w.events <= before) await sleep(floor, signal);
                    continue;
                }
                // Otherwise wait as long as the server recommends, and never less than the floor.
                await sleep(typeof r.nextPollMs === 'number' && Number.isFinite(r.nextPollMs) ? Math.max(floor, r.nextPollMs) : Math.max(floor, DEFAULT_POLL_MS), signal);
            } catch (e) {
                if (signal.aborted) return undefined;
                // For poll, an error answer is how a server ends a subscription.
                const f = await this.#failed(w, e);
                if (f) return this.#ended(w, f.ended, 'the server refused the poll');
                await sleep(jitter(backoff), signal);
                backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
            }
        }
        return undefined;
    }

    /**
     * Where a server's webhooks arrive. With a relay, each MCP server has a mailbox of its own: what a
     * server posts to its addresses (junk included) can fill its own mailbox, never another's, while
     * nobody collects. Without one, every watch's address is on the one local receiver.
     */
    #rx(server: string): Promise<Sink> {
        const relay = this.#relay();
        const slot = relay ? server : '';
        let sink = this.#sinks.get(slot);
        if (sink) return sink;
        sink = (async (): Promise<Sink> => {
            if (relay) {
                const key = serverMailboxKey(this.project.dir, relay.url, server);
                // The key opens this server's mailbox: it is kept out of the log and of anything shown.
                this.#redact?.add(key);
                const client = new RelayClient({ settings: relay, key, log: this.#log, backoffMs: Number(this.#env.MCP_EVENTS_RELAY_BACKOFF_MS) || undefined, owner: () => this.project.owns(this.session) });
                await client.connect(); // fail now, with the reason, if the relay will not have us
                this.#log(`webhooks of ${server} arrive through the ${relay.isPublic ? 'public relay' : 'relay'} at ${relay.url} (settings from ${relay.source})`);
                this.webhookAddress = { url: relay.url, kind: 'relay', ...(relay.isPublic ? { isPublic: true as const } : {}) };
                return {
                    kind: 'relay',
                    url: relay.url,
                    prefix: `${relay.url}/hooks/${await mailboxIdOf(key)}/`,
                    lasting: true,
                    add: async (hook, id = randomBytes(18).toString('base64url')) => ({ id, url: await client.add(id, hook) }),
                    remove: (id, forget) => client.remove(id, forget),
                    close: () => client.close()
                };
            }
            // Checked before anything is opened: with no public address there is nowhere to deliver to.
            const address = publicAddress(this.#env);
            const receiver = new Receiver();
            receiver.log = this.#log;
            const port = await receiver.start(Number(this.#env.MCP_EVENTS_RECEIVER_PORT ?? 0));
            this.#log(`webhook receiver on 127.0.0.1:${port}, reached at ${address.url}`);
            this.webhookAddress = { url: address.url, kind: address.kind };
            return {
                kind: address.kind,
                url: address.url,
                prefix: address.url,
                lasting: false,
                add: async (hook) => {
                    const path = receiver.add(hook);
                    return { id: path, url: address.url + path };
                },
                remove: async (path) => receiver.remove(path),
                close: () => receiver.close()
            };
        })();
        this.#sinks.set(slot, sink);
        sink.catch(() => this.#sinks.delete(slot));
        return sink;
    }

    /** The project's mailbox from before 0.7.0, if it is kept: opened when a watch still has an address there. */
    #legacyMailbox(): Promise<{ client: RelayClient; prefix: string } | undefined> {
        this.#legacy ??= (async () => {
            const relay = this.#relay();
            const key = relay && legacyMailboxKey(this.project.dir, relay.url);
            if (!relay || !key) return undefined;
            this.#redact?.add(key);
            const client = new RelayClient({ settings: relay, key, log: this.#log, backoffMs: Number(this.#env.MCP_EVENTS_RELAY_BACKOFF_MS) || undefined, owner: () => this.project.owns(this.session) });
            await client.connect();
            return { client, prefix: `${relay.url}/hooks/${await mailboxIdOf(key)}/` };
        })();
        this.#legacy.catch(() => (this.#legacy = undefined));
        return this.#legacy;
    }

    /** Whether an address is in the project's mailbox from before 0.7.0. */
    async #isLegacy(url: string): Promise<boolean> {
        const relay = this.#relay();
        const key = relay && legacyMailboxKey(this.project.dir, relay.url);
        return !!relay && !!key && url.startsWith(`${relay.url}/hooks/${await mailboxIdOf(key)}/`);
    }

    /**
     * Moves a watch from the project's mailbox of before 0.7.0 to its server's own, losing nothing:
     * what the old mailbox holds for its address is collected first (through the same checks as
     * anything else, with the watch's secret and replay memory), and collected meanwhile, until the
     * server has been told to end that subscription; only then is the old address retired. The watch
     * then subscribes from its cursor at a new address in its server's mailbox, as it would after a
     * relay change. Once no watch is left at the old mailbox, its key is forgotten.
     */
    async #migrate(w: Watch, kept: NonNullable<Watch['webhook']>): Promise<void> {
        const legacy = await this.#legacyMailbox();
        if (legacy) {
            const replay = new ReplayGuard(kept.replay);
            await legacy.client.add(kept.hook, {
                secret: kept.secret,
                onEvent: async (o) => {
                    await this.#deliver(w, o, o.cursor);
                },
                onGap: (cursor) => this.#cursor(w, cursor),
                replay,
                accepted: () => {
                    if (w.webhook) w.webhook.replay = replay.state;
                    if (!this.#saveNow()) throw new LocalError('the watch could not be saved');
                }
            });
            await Promise.race([this.#conn(w.server).then((c) => this.#unsubscribe(c, w, kept.url)).catch(() => undefined), sleep(3000)]);
            await legacy.client.remove(kept.hook, true).catch(() => undefined);
        }
        this.#log(`watch ${w.id}: moved to ${w.server}'s own mailbox at the relay`);
        delete w.webhook;
        this.#saveNow();
        const relay = this.#relay();
        if (relay && !(await Promise.all(this.watches.map((x) => (x.webhook ? this.#isLegacy(x.webhook.url) : false)))).some(Boolean)) {
            dropLegacyMailboxKey(this.project.dir, relay.url);
            const closing = this.#legacy;
            this.#legacy = undefined;
            await (await closing?.catch(() => undefined))?.client.close();
        }
    }

    async #webhook(w: Watch, signal: AbortSignal): Promise<'restart' | undefined> {
        const sink = await this.#rx(w.server);
        let kept = w.webhook;
        // A watch at the project's one mailbox of before 0.7.0 moves to its server's own.
        if (kept && sink.kind === 'relay' && (await this.#isLegacy(kept.url))) {
            await this.#migrate(w, kept);
            kept = undefined;
        }
        // A watch last subscribed at an address that is no longer ours (the relay changed, or was
        // turned off): end that subscription, and start over at a new address.
        if (kept && !(sink.lasting && kept.url.startsWith(sink.prefix))) {
            const old = kept.url;
            await Promise.race([this.#conn(w.server).then((c) => this.#unsubscribe(c, w, old)).catch(() => undefined), sleep(3000)]);
            kept = undefined;
            delete w.webhook;
        }
        const secret = kept?.secret ?? newSecret();
        this.#redact?.add(secret);
        // A lasting address is collected from the relay, whose word on timing is not enough: the watch
        // remembers what it has taken. A session-only address is judged by the clock alone.
        const replay = new ReplayGuard(sink.lasting ? kept?.replay : undefined);
        // Set when the server says the subscription is over (a `terminated` envelope).
        let over: { code?: number } | undefined;
        const wake = new AbortController();
        const onAbort = () => wake.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        const { id, url } = await sink.add(
            {
                secret,
                // The address and its secret are this watch's alone, so anything that verifies here is for
                // it, whatever subscription id the server has given it by now.
                onEvent: async (o) => {
                    await this.#deliver(w, o, o.cursor);
                },
                onGap: (cursor) => {
                    this.#cursor(w, cursor);
                    this.notice(`Watch ${w.id} (${w.server} · ${shownEvent(w.event)}): some events were skipped (the server reported a gap).`, w.id);
                },
                onTerminated: (err) => {
                    over = { code: err?.code };
                    wake.abort();
                },
                replay,
                accepted: () => {
                    if (w.webhook) w.webhook.replay = replay.state;
                    if (!this.#saveNow()) throw new LocalError('the watch could not be saved');
                }
            },
            kept?.hook
        );
        // The address is a capability (whoever knows it can post to it): out of the log and of anything
        // shown from the moment it exists, not from the next start.
        this.#redact?.add(url, id);
        if (sink.lasting) {
            // The address outlives this process, so the watch keeps what it needs to use it again.
            w.webhook = { hook: id, url, secret, replay: replay.state };
            this.#saveNow();
        }
        let backoff = 2000;
        let subscribed = false;
        let ended: number | undefined;
        let refused = false;
        try {
            while (!signal.aborted && !over && !refused) {
                try {
                    const conn = await this.#conn(w.server);
                    const sent = w.cursor;
                    const r = await conn.subscribe({ name: w.event, arguments: w.arguments, delivery: { mode: 'webhook', url, secret }, cursor: w.cursor, ttlMs: sink.lasting ? TTL_LASTING_MS : TTL_SESSION_MS, ...(w.maxAgeMs ? { maxAgeMs: w.maxAgeMs } : {}) });
                    subscribed = true;
                    w.subscriptionId = r.id;
                    // With no cursor supplied there was no position to be skipped past.
                    if (r.truncated && sent !== null) this.notice(`Watch ${w.id} (${w.server} · ${shownEvent(w.event)}): some events were skipped; the server could not replay from where this watch left off.`, w.id);
                    this.#cursor(w, r.cursor);
                    const ds = r.deliveryStatus as { active?: boolean; lastError?: string; throttled?: boolean } | undefined;
                    if (ds && ds.active === false) this.#log(`watch ${w.id}: delivery suspended by the server (${['connection_refused', 'timeout', 'tls_error', 'http_4xx', 'http_5xx', 'challenge_failed'].includes(String(ds.lastError)) ? ds.lastError : 'no known reason given'}); refreshing to resume`);
                    if (ds?.throttled === true) this.#log(`watch ${w.id}: the server is limiting deliveries for now`);
                    this.#status(w, 'active');
                    backoff = 2000;
                    // The grant is the server's: refresh well before it runs out, however short it is. A grant
                    // with no end (not asked for here) is still checked on now and then.
                    const until = typeof r.refreshBefore === 'string' ? Date.parse(r.refreshBefore) : NaN;
                    const left = Number.isFinite(until) ? until - Date.now() : MAX_REFRESH_WAIT_MS / 0.6;
                    await sleep(Math.min(MAX_REFRESH_WAIT_MS, Math.max(250, left * 0.6)), wake.signal);
                } catch (e) {
                    if (signal.aborted) break;
                    if (errorCode(e) === EventsError.CallbackEndpointError) this.#status(w, 'retrying', `the server could not reach or verify the address at ${sink.url}`);
                    else {
                        const f = await this.#failed(w, e);
                        if (f) {
                            ended = f.ended;
                            refused = true;
                            break;
                        }
                    }
                    await sleep(jitter(backoff), wake.signal);
                    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
                }
            }
        } finally {
            signal.removeEventListener('abort', onAbort);
            // A session-only address dies with this process, so its subscription ends either way.
            // A lasting one ends only when the watch does: unwatched, or ended by the server.
            const gone = !!over || refused;
            const ending = !sink.lasting || this.#runs.get(w.id)?.unwatch === true || gone;
            // After the server has ended it, there is no subscription left to end.
            if (subscribed && ending && !gone) {
                const conn = this.connections.get(w.server);
                await Promise.race([conn ? this.#unsubscribe(conn, w, url).catch(() => undefined) : undefined, sleep(3000)]);
            }
            await sink.remove(id, ending).catch(() => undefined);
            if (ending) delete w.webhook;
        }
        if (signal.aborted) return undefined;
        if (over) return this.#ended(w, (over as { code?: number }).code, 'the server ended the subscription');
        if (refused) return this.#ended(w, ended, 'the server refused the subscription');
        return undefined;
    }

    #saveSoon(): void {
        if (this.#saveTimer) return;
        this.#saveTimer = setTimeout(() => this.#saveNow(), 250);
    }

    /** Whether this session still holds the project's claim. If it has lost it, it stops running the watches. */
    #stillOwner(): boolean {
        if (!this.owner) return false;
        if (this.project.owns(this.session)) return true;
        this.owner = false;
        this.#log('another session holds this project\'s watches now; this one stops running them');
        for (const r of this.#runs.values()) r.ac.abort();
        for (const w of this.watches) w.status = 'elsewhere';
        return false;
    }

    /** Saves the watches. Returns whether they were saved (only the session that runs them may). */
    #saveNow(): boolean {
        if (this.#saveTimer) clearTimeout(this.#saveTimer);
        this.#saveTimer = undefined;
        if (!this.#stillOwner()) return false;
        try {
            this.project.save();
            return true;
        } catch {
            this.#log('the watches could not be saved');
            return false;
        }
    }
}
