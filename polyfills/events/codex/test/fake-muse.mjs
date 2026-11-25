#!/usr/bin/env node
// A stand-in for `muse` in the tests: `muse config status --json`, and `muse attach --stdio <session>`,
// which speaks the three MSP requests the helper sends (initialize, session/resume, turn/start) and
// records each message to FAKE_MUSE_LOG.
// FAKE_MUSE_MODE=refuse acts as a session that can't be attached to (Muse launched without its gates).
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (o) => process.env.FAKE_MUSE_LOG && appendFileSync(process.env.FAKE_MUSE_LOG, JSON.stringify(o) + '\n');
const args = process.argv.slice(2);
log({ args, leaked: Object.keys(process.env).filter((k) => k.startsWith('MCP_EVENTS_')) });
// `muse config status --json`: Muse's enterprise configuration, absent unless FAKE_MUSE_POLICY=present.
if (args[0] === 'config' && args[1] === 'status') {
    const state = process.env.FAKE_MUSE_POLICY === 'present' ? 'present' : 'absent';
    process.stdout.write(JSON.stringify({ schema_version: 1, sources: [{ plane: 'defaults', source_class: 'system_file', state: 'absent' }, { plane: 'policy', source_class: 'system_file', state }] }) + '\n');
    process.exit(0);
}
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
    // As muse 1.4.25 does: a client name that is not a machine identifier is refused.
    if (m.method === 'initialize' && !/^[a-z0-9_]+$/.test(String(m.params?.clientInfo?.name))) send({ id: m.id, error: { code: -32602, message: 'invalid initialize params: clientInfo.name must be a machine identifier matching ^[a-z0-9_]+$ (SS1.4.1)' } });
    else if (m.method === 'initialize') send({ id: m.id, result: { experimentalApi: true, grantedCapabilities: ['experimentalApi'] } });
    else if (m.method === 'session/resume') send({ id: m.id, result: { session: { sessionId: m.params.sessionId }, youDrive: true } });
    else if (m.method === 'turn/start') send({ id: m.id, result: { commandId: m.params.commandId, disposition: 'started' } });
    else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'not handled' } });
});
