import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { EventsConnection, fingerprintOf } from '../../core/src/events-client.ts';
import { ProjectState, Spool, writeAtomic } from '../../core/src/store.ts';
import { WatchManager } from '../../core/src/watcher.ts';
import { configureHost } from '../../core/src/host.ts';
import { describeError, secrets } from '../../core/src/untrusted.ts';
import { InboxReader, maxWakeEvents } from './inbox.mjs';
import { serveInbox } from './connector.mjs';
import { destination } from './routine.mjs';

const SESSION = 'agent';
const HOUR = 3600000;
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const limit = (value, fallback, max) => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error('Invalid wake limit.');
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
    const watches = config.watches;
    if (!Array.isArray(watches) || !watches.length) throw Error('Configure at least one watch.');
    const result = [];
    for (const w of watches) {
        if (!sources.has(w?.server) || typeof w.event !== 'string' || !w.event.trim())
            throw Error('Each watch needs a configured server and an event name.');
        const args = w.arguments ?? {};
        if (typeof args !== 'object' || Array.isArray(args)) throw Error('Watch arguments must be an object.');
        const spec = {server: w.server, event: w.event, arguments: args};
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
    return a.server === b.server && a.event === b.event && isDeepStrictEqual(a.arguments, b.arguments);
}

function connection(config, env, name) {
    if (!config.upstream?.url && !config.upstream?.command) throw Error('Configure an upstream URL or stdio command.');
    const cfg = {...config.upstream};
    secrets.add(...Object.values(cfg.env ?? {}));
    if (config.upstreamBearerEnv) {
        const token = env[config.upstreamBearerEnv];
        if (!cfg.url || !token) throw Error('Missing HTTP source or upstream bearer credential.');
        cfg.headers = {...cfg.headers, Authorization: 'Bearer ' + token};
    }
    return new EventsConnection(name, cfg);
}

async function discover(conn) {
    if (!conn.connected) await conn.connect(15000);
    if (!conn.declaration) throw Error('The source does not declare MCP Events.');
    return conn.list();
}

export function readBatch(dir, batch) {
    return new InboxReader(dir).read(batch);
}

// The actor that holds the project claim is the only writer to the delivery ledger.
// A recorded attempt whose outcome is unknown stays held across restarts.
export async function startBridge({dir, config, env = process.env, post, retry = false, acceptedBatch, log = console.error}) {
    const sources = servers(config);
    const wanted = watchPlan(config, sources);
    const activeServers = [...new Set(wanted.map(w => w.server))];
    const gap = limit(config.minGapSeconds, 60, 86400) * 1000;
    const cap = limit(config.maxWakesPerHour, 6, 3600);
    const batchMs = limit(config.batchMs, 1000, 60000);
    secrets.add(env.GROK_ROUTINE_KEY, env.GROK_ROUTINE_URL, env.GROK_EVENTS_READER_KEY);
    const dest = destination(env, post);
    const bindings = new Map();
    for (const name of activeServers) {
        const cfg = sources.get(name);
        // A source alias identifies the same endpoint across restarts and historical reads.
        bindings.set(name, fingerprintOf(cfg.upstream));
    }
    const binding = dest.identity;
    const connections = new Map();
    const ledgerFile = join(dir, 'delivery.json');
    mkdirSync(dir, {recursive: true, mode: 0o700});
    configureHost({name: 'Grok Bot', kind: 'grok-bot', client: {name: 'mcp-events-grok-bot', version: '0.1.0'},
        noPublicUrl: 'This event needs a webhook receiver. Configure a private relay or MCP_EVENTS_PUBLIC_URL.'});
    const project = new ProjectState(dir, dir);
    if (!project.claim(SESSION).owner) throw Error('Another bridge is already running for this profile.');
    let timer, sending, stopped = false;
    let manager;
    const retries = new Set();
    const starting = new Set();
    async function stop() {
        stopped = true;
        clearTimeout(timer);
        for (const handle of retries) clearTimeout(handle);
        await Promise.allSettled(starting);
        await sending;
        if (manager?.owner) await manager.stop();
        await Promise.allSettled([...connections.values()].map(conn => conn.close()));
        project.release();
    }
    try {
        const state = existsSync(ledgerFile) ? json(ledgerFile) : {binding, through: 0, wakes: [], attempt: null};
        if (state.binding !== binding) throw Error('The routine URL changed. Use a new profile directory.');
        const known = new Map(Object.entries(state.sources ?? {}));
        for (const [name, fingerprint] of bindings) {
            if (known.has(name) && known.get(name) !== fingerprint)
                throw Error('Server ' + name + ' changed endpoint. Give the new endpoint its own name.');
            known.set(name, fingerprint);
        }
        state.sources = Object.fromEntries(known);
        state.inbox ??= randomUUID().replaceAll('-', '');
        const batchRef = ({first, last}) => (state.inbox + '.') + 'e' + first + '-e' + last;
        const save = () => writeAtomic(ledgerFile, JSON.stringify(state));
        if (acceptedBatch) {
            const a = state.attempt;
            if (!a || acceptedBatch !== batchRef(a)) throw Error('Batch does not match the held delivery.');
            state.through = a.last;
            state.wakes.push(Date.now());
            state.attempt = null;
        }
        save();
        const spool = new Spool(dir, SESSION);
        const waiting = [];
        const queue = r => {
            if (r.kind === 'notice') { log('Subscription notice: ' + r.text); return; }
            const id = Number(r.id.slice(1));
            if (id > state.through) waiting.push(id);
        };
        for (const r of spool.all()) queue(r);
        let held = !!state.attempt && !retry;
        const schedule = (delay = batchMs) => {
            if (stopped || timer || sending || held || !waiting.length) return;
            timer = setTimeout(() => {
                timer = undefined;
                sending = flush().catch(e => {
                    held = true;
                    log('Delivery held: ' + secrets.scrub(e.message) + '. Inspect the destination before restarting with --retry.');
                }).finally(() => { sending = undefined; schedule(); });
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
            // Reuse the exact batch on an explicit retry.
            const attempt = state.attempt ?? {first: waiting[0], last: waiting[Math.min(waiting.length, maxWakeEvents) - 1]};
            const batch = batchRef(attempt);
            state.attempt = attempt;
            save();
            await dest.send(batch);
            state.through = attempt.last;
            state.wakes.push(Date.now());
            state.attempt = null;
            save();
            while (waiting.length && waiting[0] <= state.through) waiting.shift();
            log('Accepted batch ' + batch);
        }
        spool.onAppend = r => { queue(r); schedule(); };
        manager = new WatchManager({project, spool, session: SESSION, env, connections, log, redact: secrets});
        // Begin with no live connections so a removed watch cannot resume during reconciliation.
        if (!manager.start()) throw Error('Lost ownership of this profile.');
        for (const saved of [...manager.watches]) {
            const spec = wanted.find(w => sameWatch(w, saved));
            if (!spec) await manager.remove(saved.id);
            else saved.note = spec.note;
        }
        async function attach(name) {
            let conn = connections.get(name);
            if (!conn) {
                conn = connection(sources.get(name), env, name);
                connections.set(name, conn);
            }
            await discover(conn);
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
                log('Source ' + name + ': ' + secrets.scrub(describeError(error)) + '. Retrying setup in 60s.');
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
        await Promise.all(activeServers.map(startSource));
        if (held) log('Held batch ' + batchRef(state.attempt) + '. Check the destination, then use --accepted BATCH or --retry.');
        schedule();
        return stop;
    } catch (error) {
        await stop();
        throw error;
    }
}

async function main() {
    const [command, ...args] = process.argv.slice(2);
    const dir = resolve(process.env.GROK_EVENTS_HOME || join(homedir(), '.grok-events'));
    if (command === 'serve' && !args.length) {
        await serveInbox(dir, process.env);
    } else if (command === 'list' && args.length <= 1) {
        const config = json(join(dir, 'config.json'));
        const sources = servers(config);
        if (args.length && !sources.has(args[0])) throw Error('Unknown server name.');
        const results = Object.create(null);
        for (const name of args.length ? args : sources.keys()) {
            const conn = connection(sources.get(name), process.env, name);
            try {
                const types = await discover(conn);
                results[name] = types.map(({name, delivery, inputSchema}) => ({name, delivery, inputSchema}));
            } finally { await conn.close(); }
        }
        console.log(JSON.stringify(results, null, 2));
    } else if (command === 'read' && args.length === 1) {
        console.log(JSON.stringify({untrustedEvents: readBatch(dir, args[0])}, null, 2));
    } else if (command === 'run' && (!args.length || args.join(' ') === '--retry' || (args.length === 2 && args[0] === '--accepted'))) {
        const stop = await startBridge({dir, config: json(join(dir, 'config.json')), retry: args[0] === '--retry', acceptedBatch: args[1]});
        let stopping = false;
        const close = () => { if (!stopping) { stopping = true; void stop().catch(() => { process.exitCode = 1; }); } };
        process.on('SIGINT', close);
        process.on('SIGTERM', close);
    } else throw Error('Usage: node bridge.mjs serve | list [SERVER] | run [--retry | --accepted BATCH] | read INBOX.eFIRST-eLAST');
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
    main().catch(e => { console.error(secrets.scrub(e instanceof Error ? e.message : describeError(e))); process.exitCode = 1; });
