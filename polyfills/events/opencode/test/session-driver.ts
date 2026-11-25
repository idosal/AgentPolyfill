// One OpenCode server's view of one session, for test/two-servers.test.ts: an OpenCodeSession over a
// shared state folder, driven by lines on stdin ("spoke", "start", "owner"), answering on stdout.
import { createInterface } from 'node:readline';
import { OpenCodeSession } from '../src/sessions.ts';

const [base, id] = process.argv.slice(2) as [string, string];
const s = new OpenCodeSession(id, { base, directory: '/project', connections: new Map(), unavailable: () => [], wake: async () => ({ ok: true }), log: () => {} });
const say = (v: unknown) => process.stdout.write(JSON.stringify(v) + '\n');
s.start();
say({ ready: true, owner: s.manager.owner });
createInterface({ input: process.stdin }).on('line', (line) => {
    if (line === 'spoke') s.spoke();
    if (line === 'start') s.start();
    say({ owner: s.manager.owner });
});
