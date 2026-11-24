// Per-skill enable and disable, as SEP-2640's host guidance describes it ("Hosts: End-to-End
// Integration": the model's context holds each *enabled* registry entry; the host's UI presents the
// merged list for inspection and per-skill enable/disable, with provenance). This file checks the
// helper's half: what it offers the model and what it reads for a skill the user disabled. The
// hooks module's half (the store, the commands, the permission check and the run) is checked in
// mod/hooks/gates.test.ts. H1 is the id in docs/conformance.md.

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeAll, Fixture, scenarioOf, skill, startApp } from './harness.ts';

after(closeAll);

const reads = (f: Fixture) => f.requests().filter((r) => ['resources/read', 'skills/get', 'resources/directory/read'].includes(r.method)).length;

describe('Per-skill enable and disable', () => {
    test('H1: a skill the user disabled is not in the listing the model reads, nor in list_skills; the others are, and the count is said', async () => {
        const [off, on] = [skill('release-notes'), skill('incident-review')];
        const app = await startApp({ docs: new Fixture(scenarioOf([off, on])) });
        assert.equal(app.setDisabled([{ server: 'docs', uri: off.uri }]), true);
        const listing = app.catalog();
        assert.doesNotMatch(listing.text, /release-notes/);
        assert.match(listing.text, /- incident-review \(MCP server "docs"/);
        assert.equal(listing.skills, 1);
        const listed = await app.call('list_skills', {});
        assert.doesNotMatch(listed.text, /release-notes/);
        assert.match(listed.text, /MCP server "docs": 1 skill, and 1 the user disabled \(not listed, not loadable\)/);
        // The same set again changes nothing.
        assert.equal(app.setDisabled([{ server: 'docs', uri: off.uri }]), false);
    });

    test('H1: a disabled skill is neither loaded nor read: nothing of it is asked of its server', async () => {
        const s = skill('release-notes', { 'references/codenames.md': 'CODENAMES\n' });
        const f = new Fixture(scenarioOf([s]));
        const app = await startApp({ docs: f });
        app.setDisabled([{ server: 'docs', uri: s.uri }]);
        const before = reads(f);
        const refused = await app.call('load_skill', { server: 'docs', uri: s.uri });
        assert.equal(refused.isError, true);
        assert.match(refused.text, /The user disabled the skill skill:\/\/release-notes\/SKILL\.md of the MCP server "docs"/);
        assert.equal(refused.acting, undefined);
        assert.equal(reads(f), before, 'no request about the skill reached its server');
        // Loaded while it was enabled, then disabled: its files are not read either.
        app.setDisabled([]);
        assert.equal((await app.call('load_skill', { server: 'docs', uri: s.uri })).isError, undefined);
        app.setDisabled([{ server: 'docs', uri: s.uri }]);
        const at = reads(f);
        for (const [name, input] of [
            ['read_skill_file', { server: 'docs', skill: s.uri, path: 'references/codenames.md' }],
            ['list_skill_directory', { server: 'docs', skill: s.uri }]
        ] as const) {
            const a = await app.call(name, input);
            assert.equal(a.isError, true, name);
            assert.match(a.text, /The user disabled the skill/);
            assert.doesNotMatch(a.text, /CODENAMES/);
        }
        assert.equal(reads(f), at);
        // Enabled again: it is listed and read as before.
        app.setDisabled([]);
        assert.match(app.catalog().text, /release-notes/);
        assert.match((await app.call('read_skill_file', { server: 'docs', skill: s.uri, path: 'references/codenames.md' })).text, /CODENAMES/);
    });

    test('H1: a skill is disabled by its identity, server and URI: the same URI on another server is another skill', async () => {
        const [a, b] = [skill('refunds', {}, { description: 'Refunds at A.' }), skill('refunds', {}, { description: 'Refunds at B.' })];
        const app = await startApp({ a: new Fixture(scenarioOf([a])), b: new Fixture(scenarioOf([b])) });
        app.setDisabled([{ server: 'a', uri: a.uri }]);
        assert.doesNotMatch(app.catalog().text, /Refunds at A/);
        assert.match(app.catalog().text, /Refunds at B/);
        assert.equal((await app.call('load_skill', { server: 'a', uri: a.uri })).isError, true);
        assert.equal((await app.call('load_skill', { server: 'b', uri: b.uri })).isError, undefined);
    });

    test('H1: a skill a server does not list is disabled by its URI alone, as it is loaded by it', async () => {
        const s = skill('hidden');
        const f = new Fixture({ listed: [], unlisted: [s.entry], files: s.files });
        const app = await startApp({ docs: f });
        app.setDisabled([{ server: 'docs', uri: s.uri }]);
        assert.equal((await app.call('load_skill', { server: 'docs', uri: s.uri })).isError, true);
        assert.equal(f.requests('skills/get').length, 0);
    });

    test('H1: for the person, a disabled skill can still be named, to show it or enable it: by name, server:name, URI or server:URI', async () => {
        const [s, hidden] = [skill('release-notes'), skill('hidden')];
        const app = await startApp({ docs: new Fixture({ ...scenarioOf([s]), unlisted: [hidden.entry] }) });
        app.setDisabled([{ server: 'docs', uri: s.uri }]);
        for (const what of ['release-notes', 'docs:release-notes', s.uri, `docs:${s.uri}`]) {
            assert.deepEqual(app.named(what), [{ server: 'docs', uri: s.uri, name: 'release-notes', isDisabled: true, isListed: true }], what);
        }
        // server:URI names a skill the server does not list (it is loadable by that URI).
        assert.deepEqual(app.named(`docs:${hidden.uri}`), [{ server: 'docs', uri: hidden.uri, name: 'hidden', isDisabled: false, isListed: false }]);
        // Not a server that serves skills, or not a SKILL.md: nothing.
        assert.deepEqual(app.named(`elsewhere:${hidden.uri}`), []);
        assert.deepEqual(app.named('docs:skill://hidden/notes.md'), []);
    });

    test('H1: what the hooks module sends is checked and bounded: anything but pairs of text is left out', async () => {
        const s = skill('release-notes');
        const app = await startApp({ docs: new Fixture(scenarioOf([s])) });
        app.setDisabled([7, null, 'docs', { server: 'docs' }, { uri: s.uri }, { server: 1, uri: s.uri }, { server: 'docs', uri: 'x'.repeat(5000) }]);
        assert.match(app.catalog().text, /release-notes/);
        app.setDisabled('not a list');
        assert.match(app.catalog().text, /release-notes/);
        // More than the hooks module ever keeps (2,000): the first ones are taken, the rest ignored.
        app.setDisabled([...Array.from({ length: 5000 }, (_, i) => ({ server: 'docs', uri: `skill://s${i}/SKILL.md` })), { server: 'docs', uri: s.uri }]);
        assert.match(app.catalog().text, /release-notes/);
    });
});
