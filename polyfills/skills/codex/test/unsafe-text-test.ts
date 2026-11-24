// SK1 of the security review: terminal, direction-changing and invisible characters a server
// writes never reach the person's question, the preview, or a tool result. A skill or file URI
// that holds one is refused where entries are checked (the shared core, so both forms); the
// SKILL.md shown before a load is cleaned of them, keeping line breaks and tabs, between marker lines.

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { checkEntry, resolveRef } from '../../core/src/skills.ts';
import { closeAll, digest, Fixture, scenarioOf, sizeOf, skill, startApp, type Entry } from './harness.ts';

after(closeAll);

/** One of each kind the rule refuses: C0 (ESC, BEL, NUL), DEL, C1 (CSI), bidi, zero-width, format marks. */
const UNSAFE = ['\u001b', '\u0007', '\u0000', '\u007f', '\u009b', '‮', '⁦', '​', '‏', '⁠', '﻿'];
const ESCAPES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/;

describe('SK1: unsafe characters in what a server sends', () => {
    test('a skill URI holding a control, direction-changing or invisible character is not a valid entry', () => {
        for (const c of UNSAFE) {
            const uri = `skill://acme${c}/release-notes/SKILL.md`;
            const r = checkEntry({ uri, frontmatter: { name: 'release-notes', description: 'Notes.' }, resources: [{ uri, digest: digest('x'), size: 1 }] });
            assert.ok('invalid' in r, `U+${c.codePointAt(0)!.toString(16).padStart(4, '0')} was accepted in a skill URI`);
        }
        const ok = checkEntry({ uri: 'skill://acme/release-notes/SKILL.md', frontmatter: { name: 'release-notes', description: 'Notes.' }, resources: [{ uri: 'skill://acme/release-notes/SKILL.md', digest: digest('x'), size: 1 }] });
        assert.ok('entry' in ok);
    });

    test('a file URI holding one is not a valid entry either, and a reference holding one resolves to nothing', () => {
        for (const c of UNSAFE) {
            const uri = 'skill://notes/SKILL.md';
            const r = checkEntry({ uri, frontmatter: { name: 'notes', description: 'Notes.' }, resources: [{ uri, digest: digest('x'), size: 1 }, { uri: `skill://notes/ref${c}s/a.md`, digest: digest('y'), size: 1 }] });
            assert.ok('invalid' in r, `U+${c.codePointAt(0)!.toString(16).padStart(4, '0')} was accepted in a file URI`);
            assert.throws(() => resolveRef(uri, `refs/a${c}.md`), `U+${c.codePointAt(0)!.toString(16).padStart(4, '0')} was accepted in a reference`);
        }
    });

    test('such a skill is not listed, gets no stub, and is never put to the person', async () => {
        const good = skill('release-notes');
        const uri = 'skill://acme\u001b[2K\u001b[1A\u001b]52;c;ZXZpbA==\u0007\u009b31m/x‮orez/release-notes/SKILL.md';
        const bad: Entry = { uri, frontmatter: { name: 'release-notes', description: 'Notes.' }, resources: [{ uri, digest: digest('x'), size: 1 }] };
        const f = new Fixture({ listed: [good.entry, bad], unlisted: [], files: { ...good.files, [uri]: { text: 'x' } } });
        const st = await startApp({ docs: f }, { answers: ['load', 'load'] });
        const listing = (await st.call('list_skills', {})).text;
        assert.doesNotMatch(listing, ESCAPES, 'list_skills carries none of them');
        assert.match(listing, /left out/);
        const a = await st.call('load_skill', { server: 'docs', uri });
        assert.ok(a.isError);
        assert.doesNotMatch(a.text, ESCAPES);
        assert.equal(st.questions.length, 0, 'never asked about');
        assert.equal(f.requests('resources/read').length, 0);
    });

    test('the SKILL.md shown before a load is cleaned of them, keeping line breaks and tabs, between marker lines', async () => {
        const body = 'Step one\u001b[2K\u001b[1A.\n\tIndented\u0007 line \u001b]52;c;ZXZpbA==\u0007\u009b31m‮desrever​ end.\n';
        const text = `---\nname: notes\ndescription: Notes.\n---\n\n${body}`;
        const s = skill('notes');
        const entry = { ...s.entry, frontmatter: { name: 'notes', description: 'Notes.' }, resources: [{ uri: s.uri, digest: digest(text), size: sizeOf(text) }] };
        const st = await startApp({ docs: new Fixture(scenarioOf([s], { listed: [entry], files: { [s.uri]: { text } } })) }, { answers: ['show', 'no'] });
        await st.call('load_skill', { server: 'docs', uri: s.uri });
        const shown = st.questions[1]!.message;
        assert.doesNotMatch(shown, ESCAPES, 'no control, bidi or invisible character');
        assert.match(shown, /Step one\[2K\[1A\.\n\tIndented line \]52;c;ZXZpbA==31mdesrever end\./, 'the rest of the text, line breaks and tabs kept');
        const lines = shown.split('\n');
        const start = lines.findIndex((l) => /^-{3,} The SKILL\.md of "notes" begins -{3,}$/.test(l));
        const end = lines.findIndex((l) => /^-{3,} The SKILL\.md of "notes" ends -{3,}$/.test(l));
        assert.ok(start >= 0 && end > start, 'between marker lines');
        assert.ok(lines.slice(start + 1, end).join('\n').includes('Step one'));
    });
});
