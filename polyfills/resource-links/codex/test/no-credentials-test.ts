// No code or script in this polyfill touches a host's stored credentials. The probe
// and proof scripts have the person sign in inside a throwaway home instead; nothing
// copies, reads or passes on a sign-in file, a keychain entry or a key. This test fails
// if any of them names one.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const polyfill = fileURLToPath(new URL('../..', import.meta.url));
const self = fileURLToPath(import.meta.url);
const CODE = new Set(['.sh', '.bash', '.py', '.mjs', '.cjs', '.js', '.ts', '.toml', '.json']);
const SKIP = new Set(['node_modules', 'runs', '.git']);
const rel = (p: string) => relative(polyfill, p).split(sep).join('/');

// Each host's credential stores, and the ways a script could take a credential along.
const CREDENTIALS: [string, RegExp][] = [
    ["Codex's sign-in file", /auth\.json/i],
    ["Claude Code's sign-in file", /\.?credentials\.json/i],
    ['a macOS keychain read', /\bsecurity\s+(find|dump|export)-/i],
    ["Claude Code's keychain entry", /Claude Code-credentials/i],
    ['a Linux secret store read', /\bsecret-tool\b/i],
    ['a key or token handed to a login', /--with-(api-key|access-token)\b/i],
    ['a key or token from the environment', /\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|CODEX_ACCESS_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)\b/],
    ['an option to name where a sign-in comes from', /\bCODEX_AUTH\w*/],
];
// Scripts that set up a host: nothing from the person's own host homes.
const HOMES: [string, RegExp][] = [["the person's own Codex or Claude Code home", /(~|\$HOME|\$\{HOME\})\/\.(codex|claude)\b/]];

function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return SKIP.has(e.name) ? [] : files(p);
        return CODE.has(extname(e.name)) && p !== self ? [p] : [];
    });
}

test("no code or script in the polyfill names a host's stored credentials", () => {
    const found: string[] = [];
    for (const p of files(polyfill)) {
        const lines = readFileSync(p, 'utf8').split('\n');
        const rules = /\.(sh|bash|py)$/.test(p) ? [...CREDENTIALS, ...HOMES] : CREDENTIALS;
        lines.forEach((line, i) => {
            for (const [what, re] of rules) if (re.test(line)) found.push(`${rel(p)}:${i + 1}: ${what}`);
        });
    }
    assert.deepEqual(found, []);
});

test('the check finds a script that copies a sign-in file', () => {
    const line = 'cp "$HOME/.codex/' + 'auth' + '.json" "$D/codex/"';
    assert.ok(CREDENTIALS.some(([, re]) => re.test(line)));
    assert.ok(HOMES.some(([, re]) => re.test(line)));
});

test('the probe and proof scripts are among the files checked', () => {
    const checked = files(polyfill).map(rel);
    for (const s of ['probe/run.sh', 'probe/summarize.py', 'codex/live/take-proof.sh']) assert.ok(checked.includes(s), s);
});
