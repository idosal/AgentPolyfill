#!/usr/bin/env node
// Sets up your own relay, on your own Cloudflare account, and tells the plugin where it is.
//
//   npm run setup            deploy (or update) the relay, give it an access key, write the settings file
//   npm run setup -- --rotate   the same, with a new access key (the old one stops working)
//
// What it does, in order:
//   1. checks that wrangler is signed in (run `npx wrangler login` yourself first);
//   2. `wrangler deploy`: creates or updates the Worker and its Durable Object in your account;
//   3. makes a random access key and stores it as the Worker's ACCESS_KEY secret;
//   4. writes ~/.mcp-events/relay.json ({ url, accessKey }), readable only by you, which the plugin reads;
//   5. checks the deployed relay: it answers, refuses a socket without the key, and accepts one with it.
// The access key is never printed.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const wrangler = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const file = process.env.MCP_EVENTS_RELAY_FILE || join(homedir(), '.mcp-events', 'relay.json');
const rotate = process.argv.includes('--rotate');
const fail = (msg) => {
    console.error(`\n✗ ${msg}`);
    process.exit(1);
};
const run = (args, input) => spawnSync(wrangler, args, { cwd: root, encoding: 'utf8', input, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });

if (!existsSync(wrangler)) fail('wrangler is not installed here yet. Run `npm install` in this folder first.');
if (run(['whoami']).status !== 0) fail('wrangler is not signed in to Cloudflare. Run `npx wrangler login` in this folder (it opens your browser), then run this again.');

console.log('Deploying the relay to your Cloudflare account…');
const deployed = run(['deploy']);
if (deployed.status !== 0) fail(`wrangler deploy failed:\n${deployed.stderr || deployed.stdout}`);
const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(deployed.stdout + deployed.stderr)?.[0];
if (!url) fail(`The relay was deployed, but its address was not in wrangler's output. Find it in the Cloudflare dashboard and put it in ${file} as "url".\n${deployed.stdout}`);
console.log(`✓ deployed at ${url}`);

let accessKey;
if (!rotate && existsSync(file)) {
    try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (saved.url === url && typeof saved.accessKey === 'string') accessKey = saved.accessKey;
    } catch {
        // unreadable: make a new key
    }
}
const fresh = !accessKey;
accessKey ??= randomBytes(32).toString('base64url');
// Set the secret every time: it is the one thing that must match the file.
const secret = run(['secret', 'put', 'ACCESS_KEY'], accessKey + '\n');
if (secret.status !== 0) fail(`Could not store the access key as the Worker's secret:\n${secret.stderr || secret.stdout}`);
console.log(`✓ access key ${fresh ? 'made and ' : ''}stored as the Worker's ACCESS_KEY secret`);

mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
const tmp = `${file}.${process.pid}.tmp`;
writeFileSync(tmp, JSON.stringify({ url, accessKey }, null, 2) + '\n', { mode: 0o600 });
chmodSync(tmp, 0o600);
renameSync(tmp, file);
console.log(`✓ wrote ${file} (readable only by you)`);

// A mailbox of our own, to check the deployed relay end to end without touching anyone's.
const key = randomBytes(32).toString('base64url');
const mailbox = createHash('sha256').update(key).digest('base64url');
const status = (protocols) =>
    new Promise((resolve) => {
        const req = request(`${url}/mailboxes/${mailbox}/socket`, { method: 'GET', headers: { 'sec-websocket-protocol': protocols.join(', ') }, timeout: 15000 }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(0));
        req.end();
    });
const health = await fetch(`${url}/healthz`).then((r) => r.status, () => 0);
// A new secret can take a few seconds to reach the Worker.
let withKey = 0;
let without = 0;
for (let i = 0; i < 10; i++) {
    without = await status(['mcp-events-relay.v1', `key.${key}`]);
    withKey = await status(['mcp-events-relay.v1', `key.${key}`, `access.${accessKey}`]);
    if (without === 403 && withKey === 426) break;
    await new Promise((r) => setTimeout(r, 2000));
}
if (health !== 200) fail(`The relay does not answer at ${url}/healthz (status ${health}). A new workers.dev address can take a minute; run this again.`);
if (without !== 403 || withKey !== 426) fail(`The relay answered, but its access key check is not as expected (without the key: ${without}, with it: ${withKey}; expected 403 and 426). Run this again in a minute.`);
console.log('✓ the relay answers, refuses a connection without the access key, and accepts one with it');
console.log('\nDone. Restart Claude Code: webhook-only event types now work, and their events are kept while Claude Code is closed.');
