#!/usr/bin/env node
// mcp-events for T3 Code: the MCP server the agent starts for each T3 Code thread.
//
// Codex, run by T3 Code, starts the MCP servers in its configuration for each thread,
// over stdio, and T3 Code tells each one which thread it serves (T3CODE_THREAD_ID in
// its environment). This server offers the six tools and passes every call on to the
// watcher (watcher.ts), which runs the watches of every thread and outlives the
// agent's sessions. It starts the watcher when none is running.
//
// Started outside T3 Code (no T3CODE_THREAD_ID), it offers no tools at all, so it never
// stands beside another form of mcp-events in the same agent.
//
//   node server.js            the MCP server (what the agent's configuration runs)
//   node server.js --watcher  the watcher (started by the line above, detached)
//   node server.js --stop     ends the watcher; the next call starts it again

import { spawn } from 'node:child_process';
import { serve } from '../../codex/src/mcp-server.ts';
import { ask, socketPath } from './ipc.ts';
import { openLog, stateDir } from './state.ts';
import { VERSION } from './version.ts';
import { THREAD_ID } from './waker.ts';
import { runWatcher } from './watcher.ts';
import { INSTRUCTIONS, NOT_IN_T3, SERVER_NAME, TOOLS } from './words.ts';

const env = process.env;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stopWatcher(): Promise<void> {
    try {
        await ask(socketPath(stateDir(env)), { op: 'stop' }, 5000);
        process.stdout.write('The watcher is stopping. Its watches are kept and start again with the next call.\n');
    } catch {
        process.stdout.write('No watcher is running.\n');
    }
}

function runServer(): void {
    const off = env.MCP_EVENTS_OFF === '1';
    const raw = env.T3CODE_THREAD_ID?.trim() ?? '';
    const thread = THREAD_ID.test(raw) ? raw : undefined;
    const base = stateDir(env);
    const log = openLog(base, 'mcp-events.log', `thread …${(thread ?? 'none').slice(-8)}`);
    log(`mcp-events ${VERSION} for T3 Code started${off ? ' (MCP_EVENTS_OFF=1: doing nothing)' : thread ? '' : ' outside a T3 Code thread: offering no tools'}`);
    const path = socketPath(base);

    let starting: Promise<void> | undefined;
    /** Reaches the watcher, starting it if nobody answers. */
    const watcher = (): Promise<void> =>
        (starting ??= (async () => {
            try {
                await ask(path, { op: 'ping' }, 3000);
                return;
            } catch {
                // not running: start it
            }
            // It outlives this process and the agent's session: detached, in a process group of its
            // own, with nothing of this thread's in its environment.
            const childEnv = { ...env };
            delete childEnv.T3CODE_THREAD_ID;
            const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, '--watcher'], { env: childEnv, detached: true, stdio: 'ignore', windowsHide: true });
            child.unref();
            log(`started the watcher (pid ${child.pid})`);
            for (let i = 0; i < 100; i++) {
                await sleep(100);
                try {
                    await ask(path, { op: 'ping' }, 2000);
                    return;
                } catch {
                    // not up yet
                }
            }
            throw new Error('the watcher did not start; its log (mcp-events.log in the state folder) says why');
        })().finally(() => {
            starting = undefined;
        }));

    const server = serve({
        name: SERVER_NAME,
        title: 'MCP Events for T3 Code',
        version: VERSION,
        instructions: off ? 'mcp-events-t3 is installed but turned off (MCP_EVENTS_OFF=1).' : thread ? INSTRUCTIONS : NOT_IN_T3,
        tools: () => (off || !thread ? [] : TOOLS),
        log,
        onClose: () => {
            server.close();
            process.exit(0);
        },
        async call(name, args) {
            if (off) return { text: 'mcp-events-t3 is turned off (MCP_EVENTS_OFF=1).', isError: true };
            if (!thread) return { text: NOT_IN_T3, isError: true };
            try {
                await watcher();
                const a = await ask(path, { op: 'call', thread, name, args });
                return 'text' in a ? a : { text: 'The watcher answered something unexpected.', isError: true };
            } catch (e) {
                log(`${name}: ${e instanceof Error ? e.message : String(e)}`);
                return { text: `mcp-events-t3 could not reach its watcher (${e instanceof Error ? e.message : String(e)}).`, isError: true };
            }
        }
    });
}

const mode = process.argv[2];
if (mode === '--watcher') void runWatcher(env);
else if (mode === '--stop') void stopWatcher();
else runServer();
