#!/usr/bin/env node
// A stand-in for `muse attach --stdio <session>` in the tests: it speaks the three MSP requests the
// helper sends (initialize, session/resume, turn/start) and records each message to FAKE_MUSE_LOG.
// FAKE_MUSE_MODE=refuse acts as a session that can't be attached to (Muse launched without its gates).
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (o) => process.env.FAKE_MUSE_LOG && appendFileSync(process.env.FAKE_MUSE_LOG, JSON.stringify(o) + '\n');
const args = process.argv.slice(2);
log({ args, leaked: Object.keys(process.env).filter((k) => k.startsWith('MCP_EVENTS_')) });
if (args[0] !== 'attach' || args[1] !== '--stdio' || !args[2]) {
    process.stderr.write('usage: muse attach --stdio <session>\n');
    process.exit(2);
}
if (process.env.FAKE_MUSE_MODE === 'refuse') {
    process.stderr.write(`error: session ${args[2]} is not attachable\n`);
    process.exit(1);
}
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    log({ in: m });
    if (m.method === 'initialize') send({ id: m.id, result: { serverInfo: { name: 'fake-muse' }, capabilities: { experimentalApi: true } } });
    else if (m.method === 'session/resume') send({ id: m.id, result: { session: { sessionId: m.params.sessionId }, youDrive: true } });
    else if (m.method === 'turn/start') send({ id: m.id, result: { commandId: m.params.commandId, disposition: 'started' } });
    else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'not handled' } });
});
