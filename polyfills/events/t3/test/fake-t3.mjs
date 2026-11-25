#!/usr/bin/env node
// Stands in for `t3` in the tests: records each `t3 thread send` it is given (its arguments
// and the message it read from standard input), and answers as T3 Code 0.1.11 does.
// FAKE_T3_LOG is where; FAKE_T3_MODE names a file whose content picks the answer: "ok"
// (default), "down" (no T3 Code server is running), "gone" (no such thread), "fail",
// "hang" (it records the message, then never answers).

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const mode = process.env.FAKE_T3_MODE && existsSync(process.env.FAKE_T3_MODE) ? readFileSync(process.env.FAKE_T3_MODE, 'utf8').trim() : 'ok';
const args = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
    if (process.env.FAKE_T3_LOG) {
        appendFileSync(
            process.env.FAKE_T3_LOG,
            JSON.stringify({ at: Date.now(), pid: process.pid, args, stdin, mode, leaked: Object.keys(process.env).filter((k) => k.startsWith('MCP_EVENTS_') || k === 'T3CODE_THREAD_ID') }) + '\n'
        );
    }
    if (mode === 'down') {
        process.stderr.write('No running T3 Code server uses /home/someone/.t3. Start T3 Code, then retry.\n');
        process.exit(1);
    }
    if (mode === 'gone') {
        process.stderr.write(`Thread ${args[args.length - 2]} was not found.\n`);
        process.exit(1);
    }
    if (mode === 'fail') {
        process.stderr.write('Something else went wrong.\n');
        process.exit(1);
    }
    if (mode === 'hang') {
        setTimeout(() => {}, 1e9);
        return;
    }
    const thread = args[args.length - 2];
    process.stdout.write(JSON.stringify({ threadId: thread, runId: `run:${thread}:1`, delivery: 'started' }) + '\n');
});
