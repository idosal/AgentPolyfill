// Two things a server must not be able to do, each held by a test: have words
// of its own printed as a file's media type, and have a generated skill loaded
// with a text other than the one a person was shown for that load.

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { fileText } from '../src/format.ts';
import { contentOf, manifestHash, mediaTypeOf, SkillsHost, type SkillEntry } from '../src/skills.ts';
import { closeAll, connect, digest, Fixture, scenarioOf, sizeOf, skill, skillMd, startApp } from './harness.ts';

after(closeAll);

/** A value that begins as a media type and goes on as something else. */
const NOT_ONE = 'application/octet-stream)\nmore text from the server (';

describe("a server's media type", () => {
    test('is one only when the whole value is a type and a subtype', () => {
        for (const given of ['image/png', 'text/markdown', 'application/vnd.api+json', 'inode/directory', 'Image/PNG']) assert.equal(mediaTypeOf(given), given, given);
        const not = [
            NOT_ONE,
            'image/png trailing words',
            'image/png\n',
            'image/png\u001b[2K',
            'image/‮gnp',
            'image/png​',
            'image/png; charset=utf-8',
            'image/png;',
            'image',
            '/png',
            'image/',
            ' image/png',
            `image/${'p'.repeat(64)}`,
            '',
            7,
            undefined,
            null
        ];
        for (const given of not) assert.equal(mediaTypeOf(given), undefined, JSON.stringify(given));
    });

    test('is kept from a read whole, or not at all', () => {
        const read = (mimeType: unknown) => contentOf({ contents: [{ uri: 'skill://a/logo.png', mimeType, blob: 'AAEC' }] }, 'skill://a/logo.png').mimeType;
        assert.equal(read('image/png'), 'image/png');
        for (const given of [NOT_ONE, 'image/png\nx', 'image/png\u001b', 'image/png‮']) assert.equal(read(given), undefined, JSON.stringify(given));
    });

    test('is printed only when the whole of it is one', () => {
        const base = { label: 'docs', skillUri: 'skill://a/SKILL.md', uri: 'skill://a/logo.png', size: 3, isVerified: true, isNestedSkill: false };
        assert.match(fileText({ ...base, mimeType: 'image/png' }, 'a'), /binary file \(image\/png\)/);
        const text = fileText({ ...base, mimeType: NOT_ONE }, 'a');
        assert.doesNotMatch(text, /more text from the server/);
        assert.match(text, /It is a binary file, which this mod does not show\.$/);
    });

    test('of a binary file reaches the model as a media type or not at all, and the answer is one line', async () => {
        const s = skill('brand', { 'logo.bin': 'x' });
        // Bytes that are no text, with the digest and size a conforming server would publish for them.
        const bytes = Buffer.from([0xff, 0xd8, 0x00, 0x10]);
        Object.assign((s.entry.resources as { uri: string }[]).find((r) => r.uri === `${s.root}/logo.bin`)!, { digest: digest(bytes), size: bytes.length });
        const f = new Fixture(scenarioOf([s]));
        f.change((sc) => (sc.files![`${s.root}/logo.bin`] = { blob: bytes.toString('base64'), mimeType: NOT_ONE }));
        const app = await startApp({ docs: f });
        assert.ok(!(await app.call('load_skill', { server: 'docs', uri: s.uri })).isError);
        const r = await app.call('read_skill_file', { server: 'docs', skill: s.uri, path: 'logo.bin' });
        assert.ok(!r.isError, r.text);
        assert.doesNotMatch(r.text, /more text from the server/);
        // eslint-disable-next-line no-control-regex
        assert.doesNotMatch(r.text, /[\u0000-\u001f\u007f-\u009f]/, 'no line break and no control character');
        assert.match(r.text, /It is a binary file, which this mod does not show\.$/);
    });
});

describe('a load that follows a showing (the core, as a host that shows a skill before asking uses it)', () => {
    const OTHER = 'Text the person was not shown.';
    const other = skillMd('live-notes').replace('Body of live-notes.', OTHER);
    const start = async (dynamic: boolean) => {
        const s = skill('live-notes', {}, { dynamic });
        const b = skill('side-notes', {}, { dynamic: true });
        const f = new Fixture(scenarioOf([s, b]));
        const wire = await connect('docs', f);
        const host = new SkillsHost(() => wire);
        await host.list('docs');
        const serveOther = () => f.change((sc) => (sc.files![s.uri] = { text: other }));
        /** The server now publishes the skill with a manifest, whose digest matches the other text. */
        const serveOtherWithManifest = () =>
            f.change((sc) => {
                sc.files![s.uri] = { text: other };
                sc.listed![0]!.resources = [{ uri: s.uri, digest: digest(other), size: sizeOf(other) }];
            });
        return { s, b, f, host, serveOther, serveOtherWithManifest };
    };

    test('a generated skill is loaded from the read that was shown: the server is not asked again', async () => {
        const { s, f, host, serveOther } = await start(true);
        const shown = await host.preview('docs', s.uri, { keep: true });
        serveOther();
        const loaded = await host.load('docs', s.uri, { shown: true });
        assert.equal(loaded.body, shown.body);
        assert.doesNotMatch(loaded.body, new RegExp(OTHER));
        assert.equal(f.requests('resources/read').filter((r) => r.params.uri === s.uri).length, 1, 'one read: the one that was shown');
        assert.equal(host.held().length, 1);
    });

    test('what was kept is used once, and only by a load that says the user was shown it', async () => {
        const { s, host, serveOther } = await start(true);
        await host.preview('docs', s.uri, { keep: true });
        serveOther();
        // A load that follows no showing reads the skill as it is now, as it always did.
        assert.match((await host.load('docs', s.uri)).body, new RegExp(OTHER));
        host.release();
        // Nothing is kept any more: a load said to follow a showing has nothing to hold the skill to.
        await assert.rejects(host.load('docs', s.uri, { shown: true }), /cannot be held to what the user was shown, so it is not loaded/);
        assert.equal(host.held().length, 0);
    });

    test('a showing that was not for a load keeps nothing', async () => {
        const { s, host } = await start(true);
        await host.preview('docs', s.uri);
        await assert.rejects(host.load('docs', s.uri, { shown: true }), /cannot be held to what the user was shown/);
    });

    test('a skill with a manifest is loaded after a showing only under the approval of the files that were shown: its digests then hold it to that text', async () => {
        const { s, host, serveOther } = await start(false);
        const shown = await host.preview('docs', s.uri, { keep: true });
        const hash = await manifestHash(shown.entry as SkillEntry);
        serveOther();
        assert.equal((await host.load('docs', s.uri, { shown: true, expect: hash })).body, shown.body);
        // Shown again, and then said to be approved for another set of files, or for none: not loaded.
        await host.preview('docs', s.uri, { keep: true });
        await assert.rejects(host.load('docs', s.uri, { shown: true, expect: 'sha256:0000' }), /changed on the server after it was put to the user/);
        await host.preview('docs', s.uri, { keep: true });
        await assert.rejects(host.load('docs', s.uri, { shown: true }), /changed on the server after it was put to the user/);
    });

    test('a skill that is already loaded is held to a new showing as any other: the load reads nothing more, whatever the server would answer', async () => {
        const { s, f, host, serveOtherWithManifest } = await start(true);
        await host.load('docs', s.uri);
        const shown = await host.preview('docs', s.uri, { keep: true });
        const before = f.requests().length;
        serveOtherWithManifest();
        const loaded = await host.load('docs', s.uri, { shown: true });
        assert.equal(loaded.body, shown.body);
        assert.equal(loaded.isVerified, false, 'it is said to be what it is: the generated text that was shown');
        assert.equal(f.requests().length, before, 'nothing was asked of the server for the load');
    });

    test('with the showing no longer at hand, a load said to follow it is refused before anything is read, loaded already or not', async () => {
        const { s, b, f, host, serveOtherWithManifest } = await start(true);
        await host.load('docs', s.uri);
        await host.preview('docs', s.uri, { keep: true });
        // Another showing takes its place: one is kept at a time.
        await host.preview('docs', b.uri, { keep: true });
        serveOtherWithManifest();
        const before = f.requests().length;
        await assert.rejects(host.load('docs', s.uri, { shown: true }), /cannot be held to what the user was shown, so it is not loaded/);
        assert.equal(f.requests().length, before);
        assert.deepEqual(host.held().map((h) => h.entry.resources), ['dynamic'], 'what is held is still the earlier load');
    });
});

describe('what is shown as text', () => {
    const cases: [string, string][] = [['ESC', '\u001b[2K'], ['a C1 control', '\u009b2K'], ['DEL', '\u007f'], ['a unit separator', '\u001f']];

    test('a file that holds a control character a terminal acts on is not shown: it is treated as the binary file it is', async () => {
        const files = Object.fromEntries(cases.map(([, c], i) => [`f${i}.txt`, `before${c}after\n`]));
        const s = skill('logs', { ...files, 'plain.txt': 'tab\there, and a line\nbreak\r\n' });
        const app = await startApp({ docs: new Fixture(scenarioOf([s])) });
        assert.ok(!(await app.call('load_skill', { server: 'docs', uri: s.uri })).isError);
        for (const [i, [what]] of cases.entries()) {
            const r = await app.call('read_skill_file', { server: 'docs', skill: s.uri, path: `f${i}.txt` });
            assert.ok(!r.isError, r.text);
            assert.match(r.text, /It is a binary file.*which this mod does not show\.$/, what);
            // eslint-disable-next-line no-control-regex
            assert.doesNotMatch(r.text, /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/, what);
        }
        const plain = await app.call('read_skill_file', { server: 'docs', skill: s.uri, path: 'plain.txt' });
        assert.match(plain.text, /tab\there, and a line\nbreak/, 'tabs and line breaks are text');
    });
});
