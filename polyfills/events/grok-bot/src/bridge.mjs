import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { EventsConnection, fingerprintOf, preStandardPolicy } from '../../core/src/events-client.ts';
import { ProjectState, Spool, writeAtomic } from '../../core/src/store.ts';
import { WatchManager } from '../../core/src/watcher.ts';
import { configureHost } from '../../core/src/host.ts';
import { describeError, secrets } from '../../core/src/untrusted.ts';
import { InboxReader, maxSpoolBytes, maxWakeEvents } from './inbox.mjs';
import { readKeyFile, serveInbox } from './connector.mjs';
import { destination, RoutineError } from './routine.mjs';

const SESSION = 'agent';
const HOUR = 3600000;
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const limit = (value, fallback, max, min = 1) => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw Error('Invalid wake limit.');
    return value;
};

function servers(config) {
    if (config.upstream || !config.servers || typeof config.servers !== 'object' || Array.isArray(config.servers))
        throw Error('Configure named servers.');
    const entries = Object.entries(config.servers);
    if (!entries.length) throw Error('Configure at least one server.');
    for (const [name, value] of entries) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || !value?.upstream)
            throw Error('Each server needs a short name and an upstream.');
    }
    return new Map(entries);
}

function watchPlan(config, sources) {
    const watches = config.watches ?? [];
    if (!Array.isArray(watches)) throw Error('Watches must be an array.');
    const result = [];
    for (const w of watches) {
        if (!sources.has(w?.server) || typeof w.event !== 'string' || !w.event.trim())
            throw Error('Each watch needs a configured server and an event name.');
        const args = w.arguments ?? {};
        if (typeof args !== 'object' || Array.isArray(args)) throw Error('Watch arguments must be an object.');
        const spec = { server: w.server, event: w.event, arguments: args };
        if (result.some(other => sameWatch(other, spec))) throw Error('Duplicate watch for ' + w.server + '/' + w.event);
        if (w.name !== undefined) {
            if (typeof w.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(w.name))
                throw Error('Watch names must be short identifiers.');
            if (result.some(other => other.server === w.server && other.note === w.name))
                throw Error('Watch name already used on ' + w.server);
            spec.note = w.name;
        }
        result.push(spec);
    }
    return result;
}

function sameWatch(a, b) {
    return a.server === b.server && a.event === b.event && isDeepStrictEqual(a.arguments ?? {}, b.arguments ?? {});
}

function connection(config, env, name) {
    if (!config.upstream?.url && !config.upstream?.command) throw Error('Configure an upstream URL or stdio command.');
    const cfg = { ...config.upstream };
    secrets.add(...Object.values(cfg.env ?? {}));
    if (cfg.headers) secrets.add(...Object.values(cfg.headers));
    if (config.upstreamBearerEnv) {
        const token = env[config.upstreamBearerEnv];
        if (!cfg.url || !token) throw Error('Missing HTTP source or upstream bearer credential.');
        secrets.add(token);
        cfg.headers = { ...cfg.headers, Authorization: 'Bearer ' + token };
    }
    const allowPreStandard = preStandardPolicy(env.MCP_EVENTS_PRE_STANDARD)(name);
    return new EventsConnection(name, cfg, { preStandard: allowPreStandard });
}

async function discover(conn) {
    if (!conn.connected) await conn.connect(15000);
    if (!conn.declaration) throw Error(conn.outsideTheSpec || 'The source does not declare MCP Events.');
    return conn.list();
}

export function readBatch(dir, batch) {
    return new InboxReader(dir).read(batch);
}

export function initProfile(dir, { demoChannel, log = console.log } = {}) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* ignore on platforms without POSIX modes */ }

    const keyFile = join(dir, 'reader.key');
    let createdKey = false;
    if (!existsSync(keyFile)) {
        writeFileSync(keyFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
        createdKey = true;
    }

    const configFile = join(dir, 'config.json');
    let createdConfig = false;
    if (!existsSync(configFile)) {
        const config = {
            servers: {
                demo: {
                    upstream: { url: 'https://event-feeds.idosalomon.workers.dev/mcp' }
                }
            },
            watches: demoChannel
                ? [{ server: 'demo', name: 'button', event: 'demo.button', arguments: { channel: demoChannel } }]
                : []
        };
        writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
        createdConfig = true;
    }

    log('Profile directory: ' + dir);
    log('  reader.key: ' + (createdKey ? 'created (mode 600)' : 'kept existing'));
    log('  config.json: ' + (createdConfig ? 'created' : 'kept existing'));
    log('');
    log('Next steps:');
    log('1. Copy the Grok Remote HTTPS connector Authorization header (never prints the key):');
    log("   { printf 'Bearer '; tr -d '\\n' < " + JSON.stringify(keyFile) + '; } | pbcopy');
    log('2. Start the unified watcher + MCP connector:');
    log('   GROK_EVENTS_HOME=' + JSON.stringify(dir) + ' GROK_ROUTINE_URL=... GROK_ROUTINE_KEY=... node plugin/dist/bridge.mjs start');
    log('3. Expose http://127.0.0.1:8787 over HTTPS (e.g. cloudflared tunnel --url http://127.0.0.1:8787) and connect https://<your-host>/mcp in Grok Bot.');
    return { dir, keyFile, configFile, createdKey, createdConfig };
}

// The actor that holds the project claim is the only writer to the delivery ledger.
// Definite transient webhook errors (408/429/5xx) retry with exponential backoff using the exact same batch reference.
// Non-retryable errors (400/401/403/404) or strict ambiguous errors stay held until operator intervention (--retry / --accepted).
export async function startRuntime({ dir, config, env = process.env, post, retry = false, acceptedBatch, log = console.error }) {
    const off = env.MCP_EVENTS_OFF === '1';
    const sources = servers(config);
    const wanted = watchPlan(config, sources);
    const allServers = [...sources.keys()];
    const gap = limit(config.minGapSeconds, 60, 86400) * 1000;
    const cap = limit(config.maxWakesPerHour, 6, 3600);
    const batchMs = limit(config.batchMs, 1000, 60000);
    const retryBaseMs = limit(config.retryBaseMs, 10000, 300000, 10);
    const retryMaxMs = limit(config.retryMaxMs, 300000, 3600000, 10);
    const holdOnAmbiguous = config.holdOnAmbiguous === true;
    secrets.add(env.GROK_ROUTINE_KEY, env.GROK_ROUTINE_URL, env.GROK_EVENTS_READER_KEY, readKeyFile(dir));
    const dest = off ? null : destination(env, post);
    const bindings = new Map();
    for (const name of allServers) {
        const cfg = sources.get(name);
        // A source alias identifies the same endpoint across restarts and historical reads.
        bindings.set(name, fingerprintOf(cfg.upstream));
    }
    const binding = dest?.identity ?? 'off';
    const connections = new Map();
    const unavailable = new Map();
    const ledgerFile = join(dir, 'delivery.json');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    configureHost({
        name: 'Grok Bot',
        kind: 'grok-bot',
        client: { name: 'mcp-events-grok-bot', version: '0.2.0' },
        other: 'Grok Bot watcher',
        scope: "this profile's",
        signIn: 'give the server credentials in config.json (upstreamBearerEnv or upstream.headers)',
        noPublicUrl: 'This event needs a webhook receiver. Configure a private relay or MCP_EVENTS_PUBLIC_URL.',
        afterWatch: ' Matching events will wake your Grok Bot webhook routine, which reads them via read_batch.'
    });
    const project = new ProjectState(dir, dir);
    if (!project.claim(SESSION).owner) throw Error('Another bridge is already running for this profile.');

    let timer;
    let retryTimer;
    let sending;
    let stopped = false;
    let manager;
    let retryAttempt = 0;
    let nextRetryAt = null;
    let lastWakeAt = null;
    let lastError = null;
    const retries = new Set();
    const starting = new Set();
    const reader = new InboxReader(dir);

    async function stop() {
        stopped = true;
        clearTimeout(timer);
        clearTimeout(retryTimer);
        for (const handle of retries) clearTimeout(handle);
        await Promise.allSettled(starting);
        await sending;
        if (manager?.owner) await manager.stop();
        await Promise.allSettled([...connections.values()].map(conn => conn.close()));
        project.release();
    }

    try {
        const state = existsSync(ledgerFile) ? json(ledgerFile) : { binding, through: 0, wakes: [], attempt: null };
        if (!off && state.binding !== binding) throw Error('The routine URL changed. Use a new profile directory.');
        const known = new Map(Object.entries(state.sources ?? {}));
        for (const [name, fingerprint] of bindings) {
            if (known.has(name) && known.get(name) !== fingerprint)
                throw Error('Server ' + name + ' changed endpoint. Give the new endpoint its own name.');
            known.set(name, fingerprint);
        }
        state.sources = Object.fromEntries(known);
        state.inbox ??= randomUUID().replaceAll('-', '');
        const batchRef = ({ first, last }) => (state.inbox + '.') + 'e' + first + '-e' + last;
        const save = () => writeAtomic(ledgerFile, JSON.stringify(state));

        if (acceptedBatch) {
            const a = state.attempt;
            if (!a || acceptedBatch !== batchRef(a)) throw Error('Batch does not match the held delivery.');
            state.through = a.last;
            state.wakes.push(Date.now());
            lastWakeAt = new Date().toISOString();
            state.attempt = null;
        }
        if (retry && state.attempt) {
            delete state.attempt.held;
            delete state.attempt.ambiguous;
        }

        const spool = new Spool(dir, SESSION);
        const waiting = [];
        const queue = r => {
            if (r.kind === 'notice') log('Subscription notice: ' + r.text);
            const id = Number(r.id.slice(1));
            if (id > state.through) waiting.push({ id, kind: r.kind });
        };
        for (const r of spool.all()) queue(r);

        let held = !retry && !!state.attempt && (state.attempt.held === true || (state.attempt.ambiguous === true && holdOnAmbiguous));

        const pickBatch = () => {
            if (state.attempt) return { first: state.attempt.first, last: state.attempt.last };
            let eventCount = 0;
            let endIdx = 0;
            for (let i = 0; i < waiting.length; i++) {
                if (waiting[i].kind === 'event') {
                    if (eventCount === maxWakeEvents) break;
                    eventCount++;
                }
                endIdx = i;
                if (i + 1 >= maxWakeEvents * 2) break;
            }
            return { first: waiting[0].id, last: waiting[endIdx].id };
        };

        const schedule = (delay = batchMs) => {
            if (stopped || off || timer || retryTimer || sending || held) return;
            if (!state.attempt && !waiting.length) return;
            timer = setTimeout(() => {
                timer = undefined;
                sending = flush().catch(e => {
                    const msg = secrets.scrub(e instanceof Error ? e.message : describeError(e));
                    lastError = msg;
                    const isRoutineErr = e instanceof RoutineError;
                    const ambiguous = isRoutineErr ? e.ambiguous : true;
                    const canRetry = (isRoutineErr ? e.retryable : true) && (!ambiguous || !holdOnAmbiguous);
                    const ref = state.attempt ? batchRef(state.attempt) : 'none';
                    if (canRetry) {
                        retryAttempt++;
                        const backoff = Math.min(retryMaxMs, retryBaseMs * Math.pow(2, Math.min(retryAttempt - 1, 10)));
                        const jitter = retryBaseMs >= 1000 ? Math.floor(Math.random() * Math.min(1000, backoff * 0.1)) : 0;
                        const waitMs = (isRoutineErr && e.retryAfterMs !== null) ? Math.max(e.retryAfterMs, 10) : backoff + jitter;
                        if (state.attempt) {
                            state.attempt.ambiguous = ambiguous;
                            save();
                        }
                        nextRetryAt = new Date(Date.now() + waitMs).toISOString();
                        log('Delivery failed (' + msg + '); retrying batch ' + ref + ' in ' + Math.max(1, Math.round(waitMs / 1000)) + 's (attempt ' + retryAttempt + ').');
                        if (!stopped) {
                            retryTimer = setTimeout(() => {
                                retryTimer = undefined;
                                nextRetryAt = null;
                                schedule(1);
                            }, waitMs);
                        }
                    } else {
                        held = true;
                        nextRetryAt = null;
                        if (state.attempt) {
                            state.attempt.held = true;
                            state.attempt.ambiguous = ambiguous;
                            save();
                        }
                        log('Delivery held: ' + msg + '. Inspect the destination before restarting with --retry or --accepted ' + ref + '.');
                    }
                }).finally(() => {
                    sending = undefined;
                    schedule();
                });
            }, delay);
        };

        async function flush() {
            const now = Date.now();
            state.wakes = state.wakes.filter(t => t > now - HOUR);
            const due = Math.max((state.wakes.at(-1) ?? 0) + gap, state.wakes.length >= cap ? state.wakes[0] + HOUR : 0);
            if (now < due) {
                timer = setTimeout(() => { timer = undefined; schedule(1); }, due - now);
                return;
            }
            // Reuse the exact batch on retry so Foxbot never sees a shifted range.
            const attempt = pickBatch();
            const batch = batchRef(attempt);
            state.attempt = { first: attempt.first, last: attempt.last };
            save();
            await dest.send(batch);
            state.through = attempt.last;
            state.wakes.push(Date.now());
            state.attempt = null;
            retryAttempt = 0;
            nextRetryAt = null;
            lastError = null;
            lastWakeAt = new Date().toISOString();
            save();
            while (waiting.length && waiting[0].id <= state.through) waiting.shift();
            log('Accepted batch ' + batch);
        }

        spool.onAppend = r => { queue(r); schedule(); };
        manager = new WatchManager({ project, spool, session: SESSION, env, connections, log, redact: secrets });
        // Begin with no live connections so removed config watches cannot resume during reconciliation.
        if (!manager.start()) throw Error('Lost ownership of this profile.');

        // Reconcile declarative config.watches while preserving dynamic watches added via MCP watch_event.
        const prevConfigWatches = Array.isArray(state.configWatches) ? state.configWatches : null;
        for (const saved of [...manager.watches]) {
            const inWanted = wanted.find(w => sameWatch(w, saved));
            if (inWanted) {
                saved.note = inWanted.note;
            } else if (prevConfigWatches === null || prevConfigWatches.some(prev => sameWatch(prev, saved))) {
                // Previously declared in config.json (or legacy profile before dynamic watches) and now removed from config.
                await manager.remove(saved.id);
            }
        }
        state.configWatches = wanted.map(({ server, event, arguments: args }) => ({ server, event, arguments: args }));
        save();

        async function attach(name) {
            if (!sources.has(name)) throw Error('Unknown server name: ' + name);
            let conn = connections.get(name);
            if (!conn) {
                conn = connection(sources.get(name), env, name);
                connections.set(name, conn);
            }
            await discover(conn);
            unavailable.delete(name);
            if (stopped) return;
            manager.resume(name);
            const problems = [];
            for (const spec of wanted.filter(w => w.server === name)) {
                if (stopped) return;
                if (manager.watches.some(saved => sameWatch(spec, saved))) continue;
                try {
                    const watch = await manager.add(spec);
                    log('Watching ' + name + '/' + watch.event + ' via ' + watch.mode + '.');
                } catch (error) { problems.push(describeError(error)); }
            }
            if (problems.length) throw Error(problems.join(', '));
        }

        async function startSource(name) {
            try { await attach(name); }
            catch (error) {
                const reason = secrets.scrub(describeError(error));
                unavailable.set(name, reason);
                log('Source ' + name + ': ' + reason + '. Retrying setup in 60s.');
                if (stopped) return;
                const handle = setTimeout(() => {
                    retries.delete(handle);
                    const pending = startSource(name);
                    starting.add(pending);
                    void pending.finally(() => starting.delete(pending));
                }, 60000);
                retries.add(handle);
            }
        }

        if (off) {
            log('MCP_EVENTS_OFF=1 is set; standing down (no upstream connections or watches started).');
        } else {
            await Promise.all(allServers.map(startSource));
            if (held) log('Held batch ' + batchRef(state.attempt) + '. Check the destination, then use --accepted BATCH or --retry.');
            schedule();
        }

        return {
            stop,
            manager,
            connections,
            spool,
            reader,
            off,
            unavailableList: () => [...unavailable.entries()].map(([name, why]) => ({ name, why })),
            findDuplicateWatch: (server, event, args) => manager.watches.find(w => w.status !== 'ended' && sameWatch(w, { server, event, arguments: args })),
            async ensureServer(name) {
                if (!sources.has(name)) throw Error('Unknown server "' + name + '". Configured: ' + allServers.join(', '));
                const existing = connections.get(name);
                if (existing?.connected && existing.declaration) return existing;
                await attach(name);
                return connections.get(name);
            },
            async refreshUnavailable() {
                await Promise.allSettled([...unavailable.keys()].map(name => attach(name).catch(() => {})));
            },
            status: () => ({
                pending: waiting.length,
                held,
                retrying: retryAttempt > 0,
                retryAttempt,
                nextRetryAt,
                lastWakeAt,
                lastError,
                ...reader.stats()
            })
        };
    } catch (error) {
        await stop();
        throw error;
    }
}

export async function startBridge(opts) {
    const runtime = await startRuntime(opts);
    return runtime.stop;
}

async function main() {
    const [command, ...args] = process.argv.slice(2);
    const dir = resolve(process.env.GROK_EVENTS_HOME || join(homedir(), '.grok-events'));

    if (command === 'init') {
        let demoChannel;
        if (args.length === 2 && args[0] === '--demo') demoChannel = args[1];
        else if (args.length !== 0) throw Error('Usage: node bridge.mjs init [--demo CHANNEL]');
        initProfile(dir, { demoChannel });
        return;
    }

    if (command === 'start' && (!args.length || args.join(' ') === '--retry' || (args.length === 2 && args[0] === '--accepted'))) {
        const runtime = await startRuntime({
            dir,
            config: json(join(dir, 'config.json')),
            retry: args[0] === '--retry',
            acceptedBatch: args[1]
        });
        let http;
        try {
            http = await serveInbox(dir, process.env, { runtime });
        } catch (error) {
            await runtime.stop();
            throw error;
        }
        let stopping = false;
        const close = () => {
            if (stopping) return;
            stopping = true;
            void Promise.allSettled([http.close(), runtime.stop()]).catch(() => { process.exitCode = 1; });
        };
        process.on('SIGINT', close);
        process.on('SIGTERM', close);
        return;
    }

    if (command === 'serve' && !args.length) {
        const http = await serveInbox(dir, process.env);
        let stopping = false;
        const close = () => { if (!stopping) { stopping = true; void http.close(); } };
        process.on('SIGINT', close);
        process.on('SIGTERM', close);
    } else if (command === 'list' && args.length <= 1) {
        const config = json(join(dir, 'config.json'));
        const sources = servers(config);
        if (args.length && !sources.has(args[0])) throw Error('Unknown server name.');
        const results = Object.create(null);
        for (const name of args.length ? args : sources.keys()) {
            const conn = connection(sources.get(name), process.env, name);
            try {
                const types = await discover(conn);
                results[name] = types.map(({ name, delivery, inputSchema }) => ({ name, delivery, inputSchema }));
            } finally { await conn.close(); }
        }
        console.log(JSON.stringify(results, null, 2));
    } else if (command === 'read' && args.length === 1) {
        console.log(JSON.stringify({ untrustedEvents: readBatch(dir, args[0]) }, null, 2));
    } else if (command === 'run' && (!args.length || args.join(' ') === '--retry' || (args.length === 2 && args[0] === '--accepted'))) {
        const stop = await startBridge({ dir, config: json(join(dir, 'config.json')), retry: args[0] === '--retry', acceptedBatch: args[1] });
        let stopping = false;
        const close = () => { if (!stopping) { stopping = true; void stop().catch(() => { process.exitCode = 1; }); } };
        process.on('SIGINT', close);
        process.on('SIGTERM', close);
    } else {
        throw Error('Usage: node bridge.mjs init [--demo CHANNEL] | start [--retry | --accepted BATCH] | run [--retry | --accepted BATCH] | serve | list [SERVER] | read INBOX.eFIRST-eLAST');
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
    main().catch(e => { console.error(secrets.scrub(e instanceof Error ? e.message : describeError(e))); process.exitCode = 1; });
