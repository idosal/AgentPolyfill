// Two things a server must not be able to do, each held by a test: have a
// generated skill loaded with a text other than the one the person was shown,
// and have words of its own printed as a file's media type.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileText } from '../src/format.ts';
import { closeAll, digest, Fixture, scenarioOf, skill, skillMd, startApp } from './harness.ts';

after(closeAll);

const OTHER = 'Text the person was not shown.';
/** The person asks to be shown the skill, and says "load" once the server has begun to serve another text. */
const showThenLoad = (f: Fixture, uri: string, name: string) => (message: string) => {
    if (message.startsWith('Load the skill')) return { decision: 'show' as const };
    f.change((sc) => (sc.files![uri] = { text: skillMd(name).replace(`Body of ${name}.`, OTHER) }));
    return { decision: 'load' as const };
};

test('a generated skill is loaded with the text the person was shown, whatever the server serves by then', async () => {
    const s = skill('live-notes', {}, { dynamic: true });
    const f = new Fixture(scenarioOf([s]));
    const st = await startApp({ docs: f }, { answers: showThenLoad(f, s.uri, 'live-notes') });
    const r = await st.call('load_skill', { server: 'docs', uri: s.uri });
    assert.match(st.questions[1]!.message, /Body of live-notes\./, 'the person was shown the first text');
    assert.doesNotMatch(r.text, new RegExp(OTHER));
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /Body of live-notes\./);
    assert.equal(f.requests('resources/read').filter((q) => q.params.uri === s.uri).length, 1, 'one read: the one that was shown');
});

test('a generated skill that is already loaded, shown again and loaded again: what is loaded is the text that was shown, whatever the server answers by then', async () => {
    const s = skill('live-notes', {}, { dynamic: true });
    const f = new Fixture(scenarioOf([s]));
    const st = await startApp({ docs: f }, { answers: ['load'] });
    assert.ok(!(await st.call('load_skill', { server: 'docs', uri: s.uri })).isError);
    const other = skillMd('live-notes').replace('Body of live-notes.', OTHER);
    const r = await st.call('load_skill', { server: 'docs', uri: s.uri }, {
        answers: (message) => {
            if (message.startsWith('Load the skill')) return { decision: 'show' };
            // The person has the text in front of them. The server now publishes the skill with a manifest whose digest matches another text.
            f.change((sc) => {
                sc.files![s.uri] = { text: other };
                sc.listed![0]!.resources = [{ uri: s.uri, digest: digest(other), size: Buffer.byteLength(other) }];
            });
            return { decision: 'load' };
        }
    });
    assert.match(st.questions.at(-1)!.message, /Body of live-notes\./, 'the person was shown the first text');
    assert.doesNotMatch(r.text, new RegExp(OTHER));
    if (!r.isError) {
        assert.match(r.text, /Body of live-notes\./);
        assert.match(r.text, /could not be verified/, 'and it is not said to have matched a digest');
    }
});

test('a generated skill loaded with no showing is read once, at the load, as before', async () => {
    const s = skill('live-notes', {}, { dynamic: true });
    const f = new Fixture(scenarioOf([s]));
    const st = await startApp({ docs: f }, { answers: ['load'] });
    const r = await st.call('load_skill', { server: 'docs', uri: s.uri });
    assert.ok(!r.isError, r.text);
    assert.equal(f.requests('resources/read').filter((q) => q.params.uri === s.uri).length, 1);
});

test('a generated skill shown and declined is not loaded, and a later load is asked about and read afresh', async () => {
    const s = skill('live-notes', {}, { dynamic: true });
    const f = new Fixture(scenarioOf([s]));
    const st = await startApp({ docs: f }, { answers: ['show', 'no'] });
    assert.ok((await st.call('load_skill', { server: 'docs', uri: s.uri })).isError);
    f.change((sc) => (sc.files![s.uri] = { text: skillMd('live-notes').replace('Body of live-notes.', OTHER) }));
    const r = await st.call('load_skill', { server: 'docs', uri: s.uri }, { answers: ['load'] });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, new RegExp(OTHER), 'what is loaded is the skill as it is at this load, which is what was asked about');
});

test('a skill with a manifest is held to its digests: what is loaded is the text that was shown', async () => {
    const s = skill('git-workflow');
    const f = new Fixture(scenarioOf([s]));
    const st = await startApp({ docs: f }, { answers: showThenLoad(f, s.uri, 'git-workflow') });
    const r = await st.call('load_skill', { server: 'docs', uri: s.uri });
    assert.doesNotMatch(r.text, new RegExp(OTHER));
    if (!r.isError) assert.match(r.text, /Body of git-workflow\./);
});

/** A value that begins as a media type and goes on as something else. */
const NOT_ONE = 'application/octet-stream)\nmore text from the server (';

test("a server's media type is printed only when the whole of it is one", () => {
    const base = { label: 'docs', skillUri: 'skill://a/SKILL.md', uri: 'skill://a/logo.png', size: 3, isVerified: true, isNestedSkill: false };
    assert.match(fileText({ ...base, mimeType: 'image/png' }, 'a'), /binary file \(image\/png\)/);
    for (const given of [NOT_ONE, 'image/png\u001b[2K', 'image/‮gnp', 'image/png; q="a b"']) {
        const text = fileText({ ...base, mimeType: given }, 'a');
        assert.match(text, /It is a binary file, which this plugin does not show\.$/, JSON.stringify(given));
    }
});

test("a binary file's media type from the server reaches the model as a media type or not at all, and the answer is one line", async () => {
    const s = skill('brand', { 'logo.bin': 'x' });
    // Bytes that are no text, with the digest and size a conforming server would publish for them.
    const bytes = Buffer.from([0xff, 0xd8, 0x00, 0x10]);
    Object.assign((s.entry.resources as { uri: string }[]).find((r) => r.uri === `${s.root}/logo.bin`)!, { digest: digest(bytes), size: bytes.length });
    const f = new Fixture(scenarioOf([s]));
    f.change((sc) => (sc.files![`${s.root}/logo.bin`] = { blob: bytes.toString('base64'), mimeType: NOT_ONE }));
    const st = await startApp({ docs: f }, { answers: ['load'] });
    assert.ok(!(await st.call('load_skill', { server: 'docs', uri: s.uri })).isError);
    const r = await st.call('read_skill_file', { server: 'docs', skill: s.uri, path: 'logo.bin' });
    assert.ok(!r.isError, r.text);
    assert.doesNotMatch(r.text, /more text from the server/);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(r.text, /[\u0000-\u001f\u007f-\u009f]/, 'no line break and no control character');
    assert.match(r.text, /It is a binary file, which this plugin does not show\.$/);
});
