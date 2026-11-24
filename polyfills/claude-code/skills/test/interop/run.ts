// Interop with an implementation this repository did not write: the official
// TypeScript SDK's Skills extension, server side (demo/server.ts is ten lines
// of wiring around `@modelcontextprotocol/server/ext/skills`) and client side
// (`SkillsClient`), as a second opinion on what this mod's own client does.
//
//   1. stdio: list, load, read every file, list a directory.
//   2. Streamable HTTP with a bearer token from the config (a static header, and
//      a headersHelper), and the same server with no token: left alone, as a
//      sign-in is.
//   3. For every skill and file, what this mod verified and returned equals what
//      the SDK's own client verified and returned.
//
//   npm run interop

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { App } from '../../src/app.ts';
import type { ServerTable } from '../../src/config.ts';
import { relativeTo } from '../../src/format.ts';

const SERVER = fileURLToPath(new URL('../../demo/server.ts', import.meta.url));
const SKILLS = fileURLToPath(new URL('../../demo/skills/', import.meta.url));
const stdio = { command: process.execPath, args: ['--no-warnings', SERVER] };
let checks = 0;
const check = (what: string) => console.log(`  ok ${++checks}  ${what}`);
const start = async (table: ServerTable) => {
    const app = new App({ table, verdict: async () => ({ ok: true }), connectTimeoutMs: 10_000 });
    await app.start();
    return app;
};

console.log('1. stdio, against the official TypeScript SDK\'s Skills server');
{
    const app = await start({ servers: { handbook: stdio }, skipped: {} });
    const c = app.conns.get('handbook')!;
    assert.equal(c.revision, '2026-07-28');
    check(`connected on protocol revision ${c.revision}; the server declared ${JSON.stringify((c.capabilities!.extensions as Record<string, unknown>)['io.modelcontextprotocol/skills'])}`);
    assert.deepEqual(app.skills.map((l) => l.entry.frontmatter.name).sort(), ['incident-review', 'release-notes']);
    check('skills/list: 2 skills, both entries valid');
    for (const listed of app.skills) {
        const { entry } = listed;
        const loaded = await app.host.load('handbook', entry.uri);
        assert.equal(loaded.isVerified, true);
        const onDisk = readFileSync(`${SKILLS}${entry.frontmatter.name}/SKILL.md`, 'utf8');
        assert.ok(onDisk.endsWith(loaded.body), 'the body is the file\'s text after its frontmatter');
        check(`load ${entry.uri}: size, digest and frontmatter verified`);
        for (const r of entry.resources as { uri: string }[]) {
            if (r.uri === entry.uri) continue;
            const file = await app.host.readFile('handbook', entry.uri, relativeTo(entry.uri, r.uri));
            assert.equal(file.text, readFileSync(`${SKILLS}${entry.frontmatter.name}/${relativeTo(entry.uri, r.uri)}`, 'utf8'));
            assert.equal(file.isVerified, true);
            check(`read ${r.uri}: verified, and equal to the file the server serves from`);
        }
    }
    const dir = await app.call('list_skill_directory', { server: 'handbook', skill: 'skill://release-notes/SKILL.md', path: 'templates' });
    assert.match(dir.text, /templates\/customer\.md \(124 bytes\)\n- templates\/internal\.md \(147 bytes\)/);
    check('directory of a loaded skill');
    const missing = await app.call('load_skill', { server: 'handbook', uri: 'skill://no-such-skill/SKILL.md' });
    assert.ok(missing.isError);
    assert.match(missing.text, /serves no skill at that URI/);
    check('skills/get for a skill the server does not serve: -32602, said in the mod\'s own words');

    console.log('3. the same server through the SDK\'s own SkillsClient');
    const sdk = new Client({ name: 'interop', version: '0' }, { versionNegotiation: { mode: 'auto' } } as never);
    await sdk.connect(new StdioClientTransport({ ...stdio, stderr: 'ignore' }));
    const theirs = new SkillsClient(sdk);
    const listing = await theirs.list();
    assert.deepEqual(listing.skills.map((s) => s.uri).sort(), app.skills.map((l) => l.entry.uri).sort());
    assert.deepEqual(JSON.parse(JSON.stringify(listing.skills.toSorted((a, b) => a.uri.localeCompare(b.uri)))), app.skills.map((l) => l.entry).toSorted((a, b) => a.uri.localeCompare(b.uri)));
    check('both clients hold the same entries');
    for (const skill of listing.skills) {
        const md = await theirs.read(skill);
        const mine = await app.host.load('handbook', skill.uri);
        assert.equal(mine.body, md.body);
        for (const r of skill.resources as { uri: string }[]) {
            if (r.uri === skill.uri) continue;
            const file = await theirs.read(skill, r.uri);
            assert.equal((await app.host.readFile('handbook', skill.uri, r.uri)).text, file.text);
        }
    }
    check('every SKILL.md body and every file read is the same from both');
    await sdk.close();
    await app.stop();
}

console.log('2. Streamable HTTP with a static bearer token');
{
    const port = await new Promise<number>((done) => {
        const s = createServer().listen(0, '127.0.0.1', () => {
            const { port } = s.address() as { port: number };
            s.close(() => done(port));
        });
    });
    const token = `interop-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    const server = spawn(process.execPath, ['--no-warnings', SERVER], { env: { ...process.env, PORT: String(port), DEMO_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'] });
    try {
        await new Promise<void>((ready, fail) => {
            server.stderr.on('data', (d: Buffer) => /http:\/\//.test(String(d)) && ready());
            server.on('exit', () => fail(new Error('the demo server exited')));
        });
        const url = `http://127.0.0.1:${port}/mcp`;
        const app = await start({ servers: { handbook: { url, headers: { Authorization: `Bearer ${token}` } }, 'no-token': { url } }, skipped: {} });
        assert.equal(app.skills.length, 2);
        check('with the token from the config: 2 skills listed');
        const loaded = await app.call('load_skill', { server: 'handbook', uri: 'skill://release-notes/SKILL.md' });
        assert.ok(!loaded.isError, loaded.text);
        const file = await app.call('read_skill_file', { server: 'handbook', skill: 'skill://release-notes/SKILL.md', path: 'references/codenames.md' });
        assert.match(file.text, /Saffron Heron/);
        check('load and read over HTTP, verified');
        assert.ok(!app.conns.has('no-token'));
        assert.match(app.status(), /Not used: "no-token": it needs a sign-in this mod cannot do .*give the server a header or a headersHelper/);
        check('the same server without a token answers 401: left alone, and the user is told it needs a sign-in');
        assert.ok(!app.status().includes(token) && !loaded.text.includes(token));
        await app.stop();

        // The token from a command of the user's, as Claude Code's `headersHelper` gives it.
        const helper = { command: `"${process.execPath}" -e "console.log(JSON.stringify({Authorization:'Bearer '+process.env.INTEROP_TOKEN}))"`, cwd: process.cwd(), fromRepo: false };
        process.env.INTEROP_TOKEN = token;
        const helped = await start({ servers: { handbook: { url, headersHelper: helper } }, skipped: {} });
        assert.equal(helped.skills.length, 2);
        const viaHelper = await helped.call('load_skill', { server: 'handbook', uri: 'skill://incident-review/SKILL.md' });
        assert.ok(!viaHelper.isError, viaHelper.text);
        check('with the header a headersHelper prints: 2 skills listed, one loaded and verified');
        await helped.stop();
    } finally {
        server.kill();
    }
}
console.log(`\ninterop: ${checks} checks passed`);
process.exit(0);
