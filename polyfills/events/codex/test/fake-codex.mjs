#!/usr/bin/env node
// Stands in for `codex` in the tests: records each `codex queue` it is given, and answers as
// Codex 0.170 does. FAKE_CODEX_LOG is where; FAKE_CODEX_MODE names a file whose content picks
// the answer: "ok" (default), "noresume" (queued, but no daemon to resume on), "fail", "old"
// (a Codex without `queue`), "norollout" (a ChatGPT desktop-app chat, not a local session).

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const mode = process.env.FAKE_CODEX_MODE && existsSync(process.env.FAKE_CODEX_MODE) ? readFileSync(process.env.FAKE_CODEX_MODE, 'utf8').trim() : 'ok';
const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_LOG) {
    appendFileSync(
        process.env.FAKE_CODEX_LOG,
        JSON.stringify({ at: Date.now(), args, mode, leaked: Object.keys(process.env).filter((k) => k.startsWith('MCP_EVENTS_')) }) + '\n'
    );
}
if (mode === 'old') {
    process.stderr.write("error: unrecognized subcommand 'queue'\n");
    process.exit(2);
}
if (mode === 'norollout') {
    // What Codex answers for a ChatGPT desktop-app chat, whose thread is not a local rollout.
    const t = args[args.indexOf('--thread') + 1];
    process.stderr.write(`Error: failed to queue session message: thread/queue/add failed: failed to read thread: invalid thread-store request: no rollout found for thread id ${t} (code -32603)\n`);
    process.exit(1);
}
if (mode === 'fail') {
    process.stderr.write('Error: failed to queue session message\n');
    process.exit(1);
}
const thread = args[args.indexOf('--thread') + 1];
if (mode === 'noresume') process.stderr.write(`Warning: message was queued, but could not resume thread ${thread}: start a local daemon or specify a server with --remote\n`);
process.stdout.write(`Queued message q-${Date.now()} for thread ${thread}.\n`);
