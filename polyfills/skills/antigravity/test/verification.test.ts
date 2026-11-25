import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { checkEntry, resolveRef } from '../../core/src/skills.ts';
import { plain } from '../../codex/src/stubs.ts';
import { Store } from '../../codex/src/store.ts';
import { renderStub, stubRootOf } from '../src/stubs.ts';
import { closeAll, Fixture, scenarioOf, skill, startApp, tempHome, writeConfig } from './harness.ts';
import { App } from '../src/app.ts';

after(closeAll);

test('X1: control, bidi and invisible characters cannot enter URIs, descriptions, questions or stubs', async () => {
    const hidden = ['\u001b', '\u0007', '\u0000', '\u007f', '\u009b', '\u202e', '\u2066', '\u200b', '\ufeff', '\u061c', '\u034f', '\ufe0f', String.fromCodePoint(0xe0041)];
    for (const c of hidden) {
        const uri = `skill://bad${c}/SKILL.md`;
        assert.ok('invalid' in checkEntry({ ...skill('bad').entry, uri }));
        assert.throws(() => resolveRef('skill://good/SKILL.md', `a${c}.md`));
    }
    const description = `Clean${hidden.join('')} description`;
    const s = skill('notes', {}, { description });
    const st = await startApp({ docs: new Fixture(scenarioOf([s])) }, { answers: ['no'] });
    await st.call('load_skill', { server: 'docs', uri: s.uri });
    for (const text of [renderStub(st.app.offered[0]!), (await st.call('list_skills', {})).text, st.questions[0]!.message]) {
        for (const c of hidden) assert.ok(!text.includes(c));
        assert.match(text, /Clean description/);
    }
    assert.equal(plain('a\u034fb\ufe0f', 30), 'ab');
});

test('X1: loaded text keeps verified bytes with a warning for hidden characters', async () => {
    const s = skill('notes', { 'SKILL.md': `---\nname: notes\ndescription: What notes does.\n---\nHidden${String.fromCodePoint(0xe0041, 0xe0042)}\n` });
    const st = await startApp({ docs: new Fixture(scenarioOf([s])) }, { answers: ['load'] });
    const r = await st.call('load_skill', { server: 'docs', uri: s.uri });
    assert.ok(!r.isError, r.text); assert.match(r.text, /holds 2 hidden characters/);
});

test('L3: generated skill reads cannot exceed the cumulative 16 MiB limit', async () => {
    const s = skill('generated', { 'a.txt': 'a'.repeat(9 * 1024 * 1024), 'b.txt': 'b'.repeat(9 * 1024 * 1024) }, { dynamic: true });
    const st = await startApp({ docs: new Fixture(scenarioOf([s])) }, { answers: ['load'] });
    assert.ok(!(await st.call('load_skill', { server: 'docs', uri: s.uri })).isError);
    assert.ok(!(await st.call('read_skill_file', { server: 'docs', skill: s.uri, path: 'a.txt' })).isError);
    const r = await st.call('read_skill_file', { server: 'docs', skill: s.uri, path: 'b.txt' });
    assert.ok(r.isError); assert.match(r.text, /16777216|16 MiB/); assert.doesNotMatch(r.text, /bbbb/);
});

test('W1, V4, Y2: a changed listing does not extend a loaded manifest; cached approved bytes stay usable', async () => {
    let now = 1000000;
    const s = skill('notes', { 'a.md': 'A\n' });
    const f = new Fixture(scenarioOf([s]));
    const st = await startApp({ docs: f }, { answers: ['load'], now: () => now });
    await st.call('load_skill', { server: 'docs', uri: s.uri });
    await st.call('read_skill_file', { server: 'docs', skill: s.uri, path: 'a.md' });
    const next = skill('notes', { 'a.md': 'B\n', 'new.md': 'NEW\n' });
    f.change(sc => { sc.listed = [next.entry]; sc.files = next.files; }); now += 60000;
    await st.call('list_skills', {});
    const read = await st.call('read_skill_file', { server: 'docs', skill: s.uri, path: 'a.md' });
    assert.match(read.text, /\nA\n/);
    const dir = await st.call('list_skill_directory', { server: 'docs', skill: s.uri });
    assert.doesNotMatch(dir.text, /new.md/);
    assert.ok((await st.call('read_skill_file', { server: 'docs', skill: s.uri, path: 'new.md' })).isError);
});

test('X14: URI-only manifest changes revoke approval, even if supporting file digest and bytes are unchanged', async () => {
    const store = new Store(tempHome()), s = skill('notes', { 'a.md': 'A\n' }), f = new Fixture(scenarioOf([s]));
    const st = await startApp({ docs: f }, { store, answers: ['load', 'no'] });
    assert.ok(!(await st.call('load_skill', { server: 'docs', uri: s.uri })).isError);
    f.change(sc => { (sc.listed![0]!.resources as any[])[1].uri = `${s.root}/renamed.md`; sc.files![`${s.root}/renamed.md`] = { text: 'A\n' }; });
    assert.ok((await st.call('load_skill', { server: 'docs', uri: s.uri })).isError);
    assert.equal(st.questions.length, 2); assert.match(st.questions[1]!.message, /changed/);
});

test('Settings skip takes effect before a previously loaded skill can be read', async () => {
    const s = skill('notes', { 'a.md': 'A\n' }), st = await startApp({ docs: new Fixture(scenarioOf([s])) }, { answers: ['load'] });
    await st.call('load_skill', { server: 'docs', uri: s.uri });
    writeFileSync(join(st.store.dir, 'settings.json'), '{"skip":["docs"]}');
    const r = await st.call('read_skill_file', { server: 'docs', skill: s.uri, path: 'a.md' });
    assert.ok(r.isError); assert.match(r.text, /left out by settings/);
});

test('No-extension cache avoids reconnecting for a day; a changed command is probed again', async () => {
    const f = new Fixture(scenarioOf([skill('notes')], { caps: 'none' })), store = new Store(tempHome());
    await startApp({ docs: f }, { store });
    const count = f.requests().length;
    const again = await startApp({ docs: f }, { store });
    assert.equal(f.requests().length, count); assert.deepEqual(again.app.skipped, ['docs']);
    const home = tempHome(); writeConfig(home, { docs: { ...f.config, args: [...f.config.args!, '--moved'] } });
    const moved = new App({ env: { HOME: home }, store, stubRoot: stubRootOf(home) });
    try { await moved.start(); assert.ok(f.requests().length > count); } finally { await moved.stop(); }
});

test('A moved server is asked about and reconnected; old held files do not carry across origins', async () => {
    const s = skill('notes', { 'a.md': 'A\n' }), first = new Fixture(scenarioOf([s])), second = new Fixture(scenarioOf([s]));
    const st = await startApp({ docs: first }, { answers: ['load', 'load'] });
    await st.call('load_skill', { server: 'docs', uri: s.uri });
    writeConfig(st.env.HOME!, { docs: { ...second.config, args: [...second.config.args!, '--new-server'] } });
    assert.ok((await st.call('read_skill_file', { server: 'docs', skill: s.uri, path: 'a.md' })).isError);
    const result = await st.call('load_skill', { server: 'docs', uri: s.uri });
    assert.ok(!result.isError, result.text);
    assert.equal(st.questions.length, 2); assert.match(st.questions[1]!.message, /server has moved/);
    assert.deepEqual(second.requests('resources/read').map(r => r.params.uri), [s.uri]);
});
