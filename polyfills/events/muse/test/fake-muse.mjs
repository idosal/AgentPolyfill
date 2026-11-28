#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const log = (o) => process.env.FAKE_MUSE_LOG && appendFileSync(process.env.FAKE_MUSE_LOG, JSON.stringify(o) + '\n');
const args = process.argv.slice(2);
log({ args, leaked: Object.keys(process.env).filter((k) => k.startsWith('MCP_EVENTS_')) });
// `muse config status --json`: Muse's enterprise configuration, absent unless FAKE_MUSE_POLICY=present.
if (args[0] === 'config' && args[1] === 'status') {
    const state = process.env.FAKE_MUSE_POLICY === 'present' ? 'present' : 'absent';
    process.stdout.write(JSON.stringify({ schema_version: 1, sources: [{ plane: 'defaults', source_class: 'system_file', state: 'absent' }, { plane: 'policy', source_class: 'system_file', state }] }) + '\n');
    process.exit(0);
}
process.exit(2);
