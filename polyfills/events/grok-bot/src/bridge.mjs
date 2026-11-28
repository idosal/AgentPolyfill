import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { EventsConnection, fingerprintOf } from '../../core/src/events-client.ts';
import { ProjectState } from '../../core/src/store.ts';
import { WatchManager } from '../../core/src/watcher.ts';
import { configureHost } from '../../core/src/host.ts';
import { describeError, secrets } from '../../core/src/untrusted.ts';
import { securePublisher } from '../../../../tools/muse-grok/config.ts';
import { privateFile } from './private-file.ts';
import { RoutineInbox, readBatch } from './inbox.mjs';
export { readBatch };
import { destination, notification } from './routine.mjs';
import example from '../config.example.json' with { type: 'json' };

const SESSION = 'agent';
const HOUR = 3600000;
function json(file) {
    const contents = privateFile(file);
    try {
        return JSON.parse(contents);
    } catch {
        throw Error('Invalid JSON in the watcher configuration.');
    }
}
const limit = (value, fallback, max) => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error('Invalid wake limit.');
    return value;
};

function privateProfile(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const mode = lstatSync(dir);
    if (!mode.isDirectory() || mode.mode & 0o077 || (process.getuid && mode.uid !== process.getuid()))
        throw Error('Use a private profile directory owned by the watcher account (chmod 700).');
}

function initialize(dir) {
    for (const [file, template] of [
        ['config.json', example],
        ['routine.json', { url: '', key: '' }]
    ]) {
        try {
            writeFileSync(join(dir, file), JSON.stringify(template, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            privateFile(join(dir, file), { secret: file === 'routine.json', checkOnly: true });
        }
    }
    console.log(
        'Watcher profile: ' + dir + '\nSet the publisher and watches in config.json and the Grok routine URL and key in routine.json.'
    );
}

function servers(config) {
    if (config.upstream || !config.servers || typeof config.servers !== 'object' || Array.isArray(config.servers))
        throw Error('Configure named servers.');
    const entries = Object.entries(config.servers);
    if (!entries.length) throw Error('Configure at least one server.');
    for (const [name, value] of entries) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || !value?.upstream) throw Error('Each server needs a short name and an upstream.');
    }
    for (const [, source] of entries) {
        if (source.upstream.url && !securePublisher(source.upstream.url)) throw Error('Use HTTPS or loopback HTTP without inline credentials, query or fragment.');
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
        const spec = { server: w.server, event: w.event, arguments: args };
        if (result.some((other) => sameWatch(other, spec))) throw Error('Duplicate watch for ' + w.server + '/' + w.event);
        if (w.name !== undefined) {
            if (typeof w.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(w.name)) throw Error('Watch names must be short identifiers.');
            if (result.some((other) => other.server === w.server && other.note === w.name))
                throw Error('Watch name already used on ' + w.server);
            spec.note = w.name;
        }
        if (w.includeTitle !== undefined && typeof w.includeTitle !== 'boolean') throw Error('includeTitle must be a boolean.');
        if (
            w.idField !== undefined &&
            (typeof w.idField !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(w.idField) || Object.hasOwn(Object.prototype, w.idField))
        )
            throw Error('Choose a simple ticket ID field.');
        spec.includeTitle = w.includeTitle === true;
        spec.idField = w.idField;
        result.push(spec);
    }
    return result;
}

function sameWatch(a, b) {
    return a.server === b.server && a.event === b.event && isDeepStrictEqual(a.arguments, b.arguments);
}

function connection(config, env, name) {
    if (!config.upstream?.url && !config.upstream?.command) throw Error('Configure an upstream URL or stdio command.');
    const cfg = { ...config.upstream };
    if (!cfg.url) secrets.add(...Object.values(cfg.env ?? {}));
    if (config.upstreamBearerEnv) {
        const token = env[config.upstreamBearerEnv];
        if (!cfg.url || !token) throw Error('Missing HTTP source or upstream bearer credential.');
        cfg.headers = { ...cfg.headers, Authorization: 'Bearer ' + token };
    }
    return new EventsConnection(name, cfg);
}

async function discover(conn) {
    if (!conn.connected) await conn.connect(15000);
    if (!conn.declaration) throw Error('The source does not declare MCP Events.');
    return conn.list();
}

// The actor that holds the project claim is the only writer to the delivery ledger.
// A recorded attempt whose outcome is unknown stays held across restarts.
export async function startBridge({
    dir,
    config,
    env = process.env,
    post,
    retry = false,
    acceptedBatch,
    once = false,
    onDone = () => {},
    log = console.error
}) {
    privateProfile(dir);
    const sources = servers(config);
    const wanted = watchPlan(config, sources);
    const activeServers = [...new Set(wanted.map((w) => w.server))];
    const gap = limit(config.minGapSeconds, 60, 86400) * 1000;
    const cap = limit(config.maxWakesPerHour, 6, 3600);
    const batchMs = limit(config.batchMs, 1000, 60000);
    const credentials =
        env.GROK_ROUTINE_FILE || env.GROK_ROUTINE_URL || env.GROK_ROUTINE_KEY
            ? env
            : { ...env, GROK_ROUTINE_FILE: resolve(dir, 'routine.json') };
    const dest = destination(credentials, post);
    const bindings = new Map();
    for (const name of activeServers) {
        const cfg = sources.get(name);
        // A source alias identifies the same endpoint across restarts and historical reads.
        bindings.set(name, fingerprintOf(cfg.upstream));
    }
    const binding = dest.identity;
    const connections = new Map();
    const retentionMs = limit(config.retentionHours, 24, 24 * 30) * HOUR;
    if (config.payload !== undefined && !['summary', 'reference'].includes(config.payload))
        throw Error('Choose summary or reference for payload.');
    configureHost({
        name: 'Grok Bot',
        kind: 'grok-bot',
        client: { name: 'mcp-events-grok-bot', version: '0.1.0' },
        noPublicUrl: 'This event needs a webhook receiver. Configure a private relay or MCP_EVENTS_PUBLIC_URL.'
    });
    const project = new ProjectState(dir, dir);
    if (!project.claim(SESSION).owner) throw Error('Another bridge is already running for this profile.');
    let timer,
        sending,
        stopped = false;
    let manager, spool, cleanup, shutdown;
    const retries = new Set();
    const starting = new Set();
    function stop() {
        return (shutdown ??= close());
    }
    async function close() {
        stopped = true;
        clearTimeout(timer);
        clearInterval(cleanup);
        for (const handle of retries) clearTimeout(handle);
        await Promise.allSettled(starting);
        await sending;
        try {
            if (manager?.owner) await manager.stop();
        } finally {
            await Promise.allSettled([...connections.values()].map((conn) => conn.close()));
            spool?.close();
            project.release();
        }
    }
    try {
        spool = new RoutineInbox(dir, binding, { retentionMs });
        const known = new Map(Object.entries(spool.state.sources ?? {}));
        for (const [name, fingerprint] of bindings) {
            if (known.has(name) && known.get(name) !== fingerprint)
                throw Error('Server ' + name + ' changed endpoint. Give the new endpoint its own name.');
            known.set(name, fingerprint);
        }
        spool.state.sources = Object.fromEntries(known);
        spool.put('delivery', spool.state);
        const ref = (attempt) => spool.reference(spool.state, attempt.first, attempt.last);
        if (acceptedBatch) spool.accept(acceptedBatch);
        if (once && (spool.state.through || spool.state.attempt || spool.pending(1).length))
            throw Error('This profile already attempted a wake. Inspect the routine before using follow.');
        if (once) spool.armedAt = Date.now();
        const summaries = config.payload ? config.payload === 'summary' : !spool.state.referenceOnly;
        const watchSettings = new Map();
        let held = !!spool.state.attempt && !retry;
        cleanup = setInterval(() => {
            try {
                spool.prune();
            } catch {
                log('Could not expire delivered batches. Will retry in one minute.');
            }
        }, 60000);
        cleanup.unref();
        const schedule = (delay = batchMs) => {
            if (stopped || timer || sending || held || !spool.pending(1).length) return;
            timer = setTimeout(() => {
                timer = undefined;
                sending = flush()
                    .catch((e) => {
                        held = true;
                        if (once) onDone(e);
                        log('Delivery held: ' + secrets.scrub(e.message) + '. Inspect the destination before restarting with --retry.');
                    })
                    .finally(() => {
                        sending = undefined;
                        schedule();
                    });
            }, delay);
        };
        async function flush() {
            const now = Date.now();
            const wakes = spool.state.wakes.filter((t) => t > now - HOUR);
            const due = Math.max((wakes.at(-1) ?? 0) + gap, wakes.length >= cap ? wakes[0] + HOUR : 0);
            if (now < due) {
                timer = setTimeout(() => {
                    timer = undefined;
                    schedule(1);
                }, due - now);
                return;
            }
            // Reuse the exact batch on an explicit retry.
            const records = spool.pending(once ? 1 : 20);
            if (!records.length) return;
            const body = spool.reserve(records, (batch, rows) => notification(batch, rows, watchSettings, summaries));
            const batch = ref(spool.state.attempt);
            await dest.send(body);
            spool.accept(batch);
            if (once) {
                held = true;
                onDone();
            }
            log('Accepted batch ' + batch);
        }
        spool.onAppend = (r) => {
            if (r.kind === 'notice') log('Subscription notice: ' + r.text);
            else schedule();
        };
        manager = new WatchManager({ project, spool, session: SESSION, env, connections, log, redact: secrets });
        // Begin with no live connections so a removed watch cannot resume during reconciliation.
        if (!manager.start()) throw Error('Lost ownership of this profile.');
        for (const saved of [...manager.watches]) {
            const spec = wanted.find((w) => sameWatch(w, saved));
            if (!spec) await manager.remove(saved.id);
            else {
                saved.note = spec.note;
                watchSettings.set(saved.id, spec);
            }
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
            for (const spec of wanted.filter((w) => w.server === name)) {
                if (stopped) return;
                if (manager.watches.some((saved) => sameWatch(spec, saved))) continue;
                try {
                    const watch = await manager.add(spec);
                    watchSettings.set(watch.id, spec);
                    log('Watching ' + name + '/' + watch.event + ' via ' + watch.mode + '.');
                } catch (error) {
                    problems.push(describeError(error));
                }
            }
            if (problems.length) throw Error(problems.join(', '));
        }
        async function startSource(name) {
            try {
                await attach(name);
            } catch (error) {
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
        if (held && spool.state.attempt)
            log('Held batch ' + ref(spool.state.attempt) + '. Check the destination, then use --accepted BATCH or --retry.');
        schedule();
        return stop;
    } catch (error) {
        await stop();
        throw error;
    }
}

export async function runCli([command, ...args]) {
    const dir = resolve(process.env.GROK_EVENTS_HOME || join(homedir(), '.grok-events'));
    privateProfile(dir);
    if (command === 'init' && !args.length) {
        initialize(dir);
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
            } finally {
                await conn.close();
            }
        }
        console.log(JSON.stringify(results, null, 2));
    } else if (command === 'read' && args.length === 1) {
        console.log(JSON.stringify({ untrustedEvents: readBatch(dir, args[0]) }, null, 2));
    } else if (
        (command === 'once' && !args.length) ||
        (['follow', 'run'].includes(command) &&
            (!args.length || args.join(' ') === '--retry' || (args.length === 2 && args[0] === '--accepted')))
    ) {
        const once = command === 'once';
        let done;
        const ended = new Promise((resolve) => {
            done = resolve;
        });
        const signal = () => done();
        process.once('SIGINT', signal);
        process.once('SIGTERM', signal);
        const timer = once
            ? setTimeout(() => done(new Error('No accepted wake within ten minutes. Check the inbox and routine.')), 600000)
            : undefined;
        let stop;
        try {
            stop = await startBridge({
                dir,
                config: json(join(dir, 'config.json')),
                once,
                onDone: done,
                retry: args[0] === '--retry',
                acceptedBatch: args[1]
            });
            const error = await ended;
            if (error) throw error;
        } finally {
            clearTimeout(timer);
            process.off('SIGINT', signal);
            process.off('SIGTERM', signal);
            await stop?.();
        }
    } else throw Error('Usage: watch.mjs init | list [SERVER] | once | follow [--retry | --accepted BATCH] | read BATCH');
}
