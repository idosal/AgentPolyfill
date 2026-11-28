#!/usr/bin/env node
// Sets up your own Grok Bot MCP Events polyfill on your Cloudflare account.
//
//   npm run setup                                Deploy (or update) Worker, create/keep READER_KEY, verify /mcp
//   npm run setup -- --rotate                    Rotate READER_KEY (old connector key stops working)
//   npm run setup -- routine                     Set GROK_ROUTINE_URL and GROK_ROUTINE_KEY via hidden prompts
//   npm run setup -- add-server <name> <url>     Add/update an upstream MCP server (optional hidden bearer token)
//   npm run setup -- login <name> <url> [scope]  Connect an OAuth MCP server (e.g. T3 Code) via browser sign-in
//   npm run setup -- remove-server <name>        Remove an upstream MCP server
//   npm run setup -- list-servers                List configured upstream server names & URLs (never prints tokens)
//
// Secrets are stored encrypted in Cloudflare Wrangler secrets and locally in ~/.grok-events-worker.json (mode 600).
// No secret is ever printed to stdout.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const wrangler = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const stateFile = process.env.GROK_EVENTS_WORKER_FILE || join(homedir(), '.grok-events-worker.json');

const fail = (msg) => {
    console.error(`\n✗ ${msg}`);
    process.exit(1);
};

const run = (args, input) =>
    spawnSync(wrangler, args, {
        cwd: root,
        encoding: 'utf8',
        input,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }
    });

function loadLocal() {
    if (!existsSync(stateFile)) return { servers: {} };
    try {
        const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
        return { servers: {}, ...parsed };
    } catch {
        return { servers: {} };
    }
}

function saveLocal(data) {
    mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, stateFile);
}

function putSecret(name, value) {
    const res = run(['secret', 'put', name], value + '\n');
    if (res.status !== 0) fail(`Could not store secret ${name}:\n${res.stderr || res.stdout}`);
}

async function promptHidden(label) {
    if (!process.stdin.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
            return (await rl.question(label)).trim();
        } finally {
            rl.close();
        }
    }
    process.stderr.write(label);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    return new Promise((resolve) => {
        let buf = '';
        const onData = (chunk) => {
            const str = chunk.toString('utf8');
            for (const ch of str) {
                if (ch === '\r' || ch === '\n') {
                    stdin.setRawMode(false);
                    stdin.pause();
                    stdin.off('data', onData);
                    process.stderr.write('\n');
                    resolve(buf.trim());
                    return;
                }
                if (ch === '\u0003') {
                    stdin.setRawMode(false);
                    process.stderr.write('\n');
                    process.exit(130);
                }
                if (ch === '\u007f' || ch === '\b') {
                    buf = buf.slice(0, -1);
                } else {
                    buf += ch;
                }
            }
        };
        stdin.on('data', onData);
    });
}

function copyClipboard(text) {
    if (process.platform === 'darwin') {
        const res = spawnSync('pbcopy', [], { input: text });
        return res.status === 0;
    }
    return false;
}

if (!existsSync(wrangler)) fail('wrangler is not installed yet. Run `npm install` in this folder first.');
if (run(['whoami']).status !== 0) fail('wrangler is not signed in to Cloudflare. Run `npx wrangler login`, then try again.');

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'list-servers') {
    const local = loadLocal();
    const entries = Object.entries(local.servers ?? {});
    console.log('Default built-in server: demo -> https://event-feeds.idosalomon.workers.dev/mcp');
    if (!entries.length) {
        console.log('No extra servers configured yet. Add one with: npm run setup -- add-server <name> <url>');
    } else {
        for (const [name, cfg] of entries) {
            console.log(`- ${name}: ${cfg.url}${cfg.bearer ? ' (bearer token set)' : ''}`);
        }
    }
    process.exit(0);
}

if (cmd === 'add-server') {
    const [name, url] = rest;
    if (!name || !url || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        fail('Usage: npm run setup -- add-server <name> <https-mcp-url>');
    }
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') throw new Error('must be https');
    } catch {
        fail('Server URL must be a valid https:// URL.');
    }
    const bearer = process.env.UPSTREAM_BEARER ?? (await promptHidden('Bearer token (leave empty if public/no auth): '));
    const local = loadLocal();
    local.servers ??= {};
    local.servers[name] = bearer ? { url, bearer } : { url };
    putSecret('UPSTREAM_SERVERS', JSON.stringify(local.servers));
    saveLocal(local);
    console.log(`✓ saved server "${name}" (${url}) to Worker secret UPSTREAM_SERVERS`);
    process.exit(0);
}

if (cmd === 'login') {
    const [name, url, scope] = rest;
    if (!name || !url || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        fail('Usage: npm run setup -- login <name> <https-mcp-url> [scope]');
    }
    const local = loadLocal();
    if (!local.url || !local.readerKey) fail('Run `npm run setup` first to deploy the Worker.');
    const res = await fetch(`${local.url}/oauth/start`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + local.readerKey, 'content-type': 'application/json' },
        body: JSON.stringify({ name, url, ...(scope ? { scope } : {}) })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.authorizeUrl) {
        fail(`Could not start OAuth sign-in (${res.status}): ${body.error || 'unknown error'}`);
    }
    console.log(`Open this URL in any browser to connect "${name}":\n\n  ${body.authorizeUrl}\n`);
    console.log('Approve access there; the Worker will store the token directly (no copy-paste needed).');
    process.exit(0);
}

if (cmd === 'remove-server') {
    const [name] = rest;
    if (!name) fail('Usage: npm run setup -- remove-server <name>');
    const local = loadLocal();
    let removed = false;
    if (local.servers?.[name]) {
        delete local.servers[name];
        putSecret('UPSTREAM_SERVERS', JSON.stringify(local.servers));
        saveLocal(local);
        removed = true;
    }
    if (local.url && local.readerKey) {
        const res = await fetch(`${local.url}/servers/${encodeURIComponent(name)}`, {
            method: 'DELETE',
            headers: { authorization: 'Bearer ' + local.readerKey }
        }).catch(() => null);
        if (res?.ok) removed = true;
    }
    if (!removed) fail(`Server "${name}" was not found.`);
    console.log(`✓ removed server "${name}"`);
    process.exit(0);
}

if (cmd === 'routine') {
    const routineUrl = process.env.GROK_ROUTINE_URL ?? (await promptHidden('Grok routine POST to URL: '));
    const routineKey = process.env.GROK_ROUTINE_KEY ?? (await promptHidden('Grok routine key: '));
    try {
        const parsed = new URL(routineUrl);
        if (parsed.protocol !== 'https:') throw new Error('must be https');
    } catch {
        fail('Routine URL must be a valid https:// URL.');
    }
    if (!routineKey) fail('Routine key cannot be empty.');
    putSecret('GROK_ROUTINE_URL', routineUrl);
    putSecret('GROK_ROUTINE_KEY', routineKey);
    console.log('✓ stored GROK_ROUTINE_URL and GROK_ROUTINE_KEY as encrypted Worker secrets');
    process.exit(0);
}

// Default: full deploy + READER_KEY setup + live verification
const rotate = process.argv.includes('--rotate');
console.log('Deploying mcp-events-grok-bot Worker to your Cloudflare account…');
const deployed = run(['deploy']);
if (deployed.status !== 0) fail(`wrangler deploy failed:\n${deployed.stderr || deployed.stdout}`);
const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(deployed.stdout + deployed.stderr)?.[0];
if (!url) fail(`Deployed, but could not find workers.dev URL in wrangler output:\n${deployed.stdout}`);
console.log(`✓ deployed at ${url}`);

const local = loadLocal();
let readerKey = !rotate && local.url === url && typeof local.readerKey === 'string' && local.readerKey.length >= 32
    ? local.readerKey
    : undefined;
const fresh = !readerKey;
readerKey ??= randomBytes(32).toString('hex');
putSecret('READER_KEY', readerKey);
local.url = url;
local.readerKey = readerKey;
saveLocal(local);
console.log(`✓ READER_KEY ${fresh ? 'generated and ' : ''}stored as encrypted Worker secret (saved mode 600 in ${stateFile})`);

if (process.env.GROK_ROUTINE_URL && process.env.GROK_ROUTINE_KEY) {
    putSecret('GROK_ROUTINE_URL', process.env.GROK_ROUTINE_URL);
    putSecret('GROK_ROUTINE_KEY', process.env.GROK_ROUTINE_KEY);
    console.log('✓ stored GROK_ROUTINE_URL and GROK_ROUTINE_KEY from environment');
}

// Verify live Worker endpoints (new secrets can take a few seconds to propagate).
let health = 0;
let unauth = 0;
let authTools = 0;
for (let i = 0; i < 12; i++) {
    health = await fetch(`${url}/healthz`).then((r) => r.status, () => 0);
    unauth = await fetch(`${url}/mcp`, { method: 'POST', body: '{}' }).then((r) => r.status, () => 0);
    const listRes = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + readerKey, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    }).catch(() => null);
    if (listRes?.status === 200) {
        const body = await listRes.json().catch(() => null);
        authTools = Array.isArray(body?.result?.tools) ? body.result.tools.length : 0;
    }
    if (health === 200 && unauth === 401 && authTools >= 7) break;
    await new Promise((r) => setTimeout(r, 2000));
}

if (health !== 200) fail(`Health check failed at ${url}/healthz (HTTP ${health}).`);
if (unauth !== 401 || authTools < 7) {
    fail(`Auth check unexpected (unauth=${unauth}, tools=${authTools}). Wait a few seconds and rerun \`npm run setup\`.`);
}
console.log(`✓ verified live Worker: /healthz=200, unauthenticated /mcp=401, authenticated tools/list=${authTools} tools`);

const copied = copyClipboard(`Bearer ${readerKey}`);
console.log('\nNext steps in Grok Bot (2 minutes, one-time):');
console.log(`1. Connect apps → Add a custom connector → Remote HTTPS:`);
console.log(`   - Name:       MCP Events`);
console.log(`   - Server URL: ${url}/mcp`);
console.log(`   - Header:     Authorization  ->  ${copied ? 'already copied to your clipboard (press ⌘V)' : `Bearer <readerKey from ${stateFile}>`}`);
console.log('2. Create a webhook-only routine named "MCP Events" in Grok Bot (prompt in worker/README.md).');
console.log('3. Save the routine webhook URL & key once with:');
console.log('   npm run setup -- routine');
