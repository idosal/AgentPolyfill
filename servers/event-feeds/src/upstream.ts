// Reading the upstreams politely. Every page is cached at the edge for about as long as the server
// asks clients to wait between polls, so one location reads each upstream page at most once per
// interval however many clients watch it; cache misses are capped per upstream host for the whole
// service (gate-do.ts); bodies are capped; only these hosts are ever fetched, from URLs the sources
// build out of checked values. No URL a client sends is ever fetched.

import { checkChannel } from './channel.ts';
import type { Env } from './env.ts';
import type { Loaded, Loader } from './source.ts';

export const HOSTS = new Set(['hn.algolia.com', 'hacker-news.firebaseio.com', 'registry.npmjs.org', 'github.com', 'earthquake.usgs.gov']);
/** Fetches a minute, per upstream host, across the whole service. */
export const UPSTREAM_CAPS: Record<string, number> = {
    'hn.algolia.com': 120,
    'hacker-news.firebaseio.com': 120,
    'registry.npmjs.org': 120,
    'github.com': 120,
    'earthquake.usgs.gov': 60
};
export const MAX_BODY = 1_000_000;
const TIMEOUT_MS = 6000;
const UA = 'event-feeds/0.1 (public MCP Events demo server; +https://github.com/idosal/AgentPolyfill/tree/main/servers/event-feeds)';

// A small per-isolate cache in front of the edge cache, and one fetch in flight per URL.
const memo = new Map<string, { exp: number; v: Loaded }>();
const inflight = new Map<string, Promise<Loaded>>();
/** For tests: forget the per-isolate copies. */
export const forgetMemo = () => memo.clear();

export async function readCapped(res: Response): Promise<string | undefined> {
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > MAX_BODY) return undefined;
    const reader = res.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > MAX_BODY) {
            await reader.cancel();
            return undefined;
        }
        chunks.push(value);
    }
    const all = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) {
        all.set(c, o);
        o += c.byteLength;
    }
    return new TextDecoder().decode(all);
}

/** Fetches one client may cause per upstream host per minute (its share of that host's cap). */
export const PER_CLIENT_MISSES = 10;
/** How long the stale copy of an upstream page is kept, to answer with when a fresh read is refused or fails. */
export const STALE_SEC = 3600;

/** The cache key of a page's stale copy: the page's own URL with a marker (it is never fetched). */
export const staleKeyOf = (url: string) => `${url}${url.includes('?') ? '&' : '?'}__event_feeds_stale=1`;

/** `client` is the requesting client's limit key (address or IPv6 /64): it is counted, never stored. */
export function workerLoader(env: Env, ctx: ExecutionContext, client = 'unknown'): Loader {
    const get = async (url: string, ttlSec: number, headers: Record<string, string>, parse: (t: string) => unknown): Promise<Loaded> => {
        const u = new URL(url);
        if (u.protocol !== 'https:' || !HOSTS.has(u.hostname)) return { ok: false, why: 'unavailable' };
        const now = Date.now();
        const m = memo.get(url);
        if (m && m.exp > now) return m.v;
        const running = inflight.get(url);
        if (running) return running;
        const p = (async (): Promise<Loaded> => {
            const key = new Request(url, { method: 'GET' });
            const staleKey = new Request(staleKeyOf(url), { method: 'GET' });
            const cache = (caches as unknown as { default: Cache }).default;
            // When a fresh read is refused (the host's minute, or this client's share of it, is spent) or
            // fails, the last good copy (up to an hour old) answers instead, marked stale.
            const stale = async (why: 'busy' | 'unavailable'): Promise<Loaded> => {
                const s = await cache.match(staleKey).catch(() => undefined);
                if (!s) return { ok: false, why };
                try {
                    return { ok: true, body: parse(await s.text()), stale: true };
                } catch {
                    return { ok: false, why };
                }
            };
            let res = await cache.match(key);
            if (!res) {
                // The host's global cap and this client's share of it; if the gate cannot be asked, nothing
                // is fetched (fail closed).
                const cap = UPSTREAM_CAPS[u.hostname] ?? 0;
                let answer = 'host';
                try {
                    if (cap > 0) answer = await env.GATES.get(env.GATES.idFromName(u.hostname)).take(cap, PER_CLIENT_MISSES, client, Date.now());
                } catch {
                    answer = 'host';
                }
                if (answer !== 'ok') return stale('busy');
                let up: Response;
                try {
                    up = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
                } catch {
                    return stale('unavailable');
                }
                // A redirect may only land on another allowed host (GitHub sends renamed repositories on).
                const landed = new URL(up.url || url);
                if (landed.protocol !== 'https:' || !HOSTS.has(landed.hostname)) return { ok: false, why: 'unavailable' };
                if (up.status === 404) {
                    res = new Response('', { status: 404, headers: { 'cache-control': `max-age=${ttlSec}` } });
                } else if (!up.ok) {
                    await up.body?.cancel();
                    return stale(up.status === 429 ? 'busy' : 'unavailable');
                } else {
                    const text = await readCapped(up).catch(() => undefined);
                    if (text === undefined) return stale('unavailable');
                    const type = up.headers.get('content-type') ?? 'text/plain';
                    res = new Response(text, { status: 200, headers: { 'content-type': type, 'cache-control': `max-age=${ttlSec}` } });
                    ctx.waitUntil(cache.put(staleKey, new Response(text, { status: 200, headers: { 'content-type': type, 'cache-control': `max-age=${STALE_SEC}` } })));
                }
                ctx.waitUntil(cache.put(key, res.clone()));
            }
            if (res.status === 404) return { ok: false, why: 'not_found' };
            const text = await res.text();
            let body: unknown;
            try {
                body = parse(text);
            } catch {
                return { ok: false, why: 'unavailable' };
            }
            return { ok: true, body };
        })();
        inflight.set(url, p);
        try {
            const v = await p;
            if ((v.ok && !v.stale) || (!v.ok && v.why === 'not_found')) {
                if (memo.size > 300) memo.clear();
                memo.set(url, { exp: now + Math.min(ttlSec, 20) * 1000, v });
            }
            return v;
        } finally {
            inflight.delete(url);
        }
    };
    return {
        json: (url, ttl, headers = {}) => get(url, ttl, { accept: 'application/json', ...headers }, JSON.parse),
        text: (url, ttl, headers = {}) => get(url, ttl, headers, (t) => t),
        async presses(channel) {
            if (!env.CHANNEL_SECRET) return { ok: false, why: 'unavailable' };
            const c = await checkChannel(env.CHANNEL_SECRET, channel, Date.now());
            if (!c.ok) return { ok: false, why: 'not_found' };
            try {
                const stub = env.CHANNELS.get(env.CHANNELS.idFromName(channel));
                return { ok: true, body: await stub.presses() };
            } catch {
                return { ok: false, why: 'unavailable' };
            }
        }
    };
}
