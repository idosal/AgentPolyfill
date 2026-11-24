// What a recorded run keeps (live/runs/*) must show nothing of the recording account or machine:
// tools/scrub-run.py is what takes it out. These tests feed it screens as Claude Code draws them
// and check what is left, and check the runs already committed.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const SCRUB = join(ROOT, 'tools', 'scrub-run.py');
const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const skip = python ? false : 'no python3 on this machine';

/** Runs the scrubber over a run folder holding these files, and returns them as it left them. */
function scrub(files: Record<string, string>): Record<string, string> {
    const run = mkdtempSync(join(tmpdir(), 'mcp-skills-scrub-'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(run, name), text);
    const done = spawnSync(python!, [SCRUB, run, ROOT], { encoding: 'utf8' });
    assert.equal(done.status, 0, done.stderr);
    return Object.fromEntries(Object.keys(files).map((name) => [name, readFileSync(join(run, name), 'utf8')]));
}

const RULE = '─'.repeat(88);
const NOTE = "[names of the recording account's claude.ai connectors removed]";
/** What /mcp-skills printed at 88 columns, with the session's other servers named. */
const screen = [
    ' ▐▛███▛█   Claude Code v2.1.329',
    "▝▜██████▀  Fable 5.2 · Claude Max · someone@example.com's Organization",
    ` ▝▝   ▝▝   ${homedir()}/clients/acme-secret/project`,
    '',
    "  You've used 83% of your weekly limit · resets Thu 3am (Asia/Jerusalem)",
    '❯ /mcp-skills',
    '  ⎿  mcp-skills: MCP server "huggingface": 25 skills, lists directories.',
    '       hf-cli  Hugging Face Hub CLI (hf) for downloading, uploading, and managing…',
    "     Not looked at, because they are not in your MCP configuration files (a plugin's",
    '     servers, claude.ai connectors): "claude_ai_Gmail", "claude_ai_Google_Calendar",',
    '     "plugin_figma_figma", "claude-in-chrome", "easel", "claude_ai_Linear",',
    '     "claude_ai_Notion", "claude_ai_Slack", "plugin_github_github", "claude_ai_Asana",',
    '     "claude_ai_Box", "claude_ai_Drive" and 7 more.',
    '     Read one before it is loaded: /mcp-skills show <name>. Have Claude use one:',
    '     /mcp-skills use <name> [what to do].',
    '',
    RULE,
    '❯ /mcp-sk',
    RULE,
    '  /mcp-skills            Skills your MCP servers serve: list them, read one (show), h…',
    '  /mcp                   Manage MCP servers',
    '  /my-private-skill      Something only the recording account has',
    '',
].join('\n');

describe('tools/scrub-run.py', { skip }, () => {
    test("takes out the names of the session's other servers, and how many more there are", () => {
        const { 'a.txt': out } = scrub({ 'a.txt': screen });
        for (const name of ['claude_ai_', 'plugin_', 'claude-in-chrome', 'easel', '7 more']) assert.ok(!out.includes(name), `${name} is left in:\n${out}`);
        assert.ok(out.includes(NOTE), out);
        // The sentence before the names stays, and so does what follows it.
        assert.match(out, /Not looked at, because they are not in your MCP configuration files \(a plugin's\n {5}servers, claude\.ai connectors\):\n {5}\[names/);
        assert.match(out, /Read one before it is loaded/);
        assert.match(out, /MCP server "huggingface": 25 skills/);
    });

    test('takes out the names on one line, as a wide screen draws them', () => {
        const wide = `     Not looked at, because they are not in your MCP configuration files (a plugin's servers, claude.ai connectors): "claude_ai_Gmail", "easel".\n     Read one before it is loaded: /mcp-skills show <name>.\n`;
        const { 'a.txt': out } = scrub({ 'a.txt': wide });
        assert.equal(out, `     Not looked at, because they are not in your MCP configuration files (a plugin's servers, claude.ai connectors):\n     ${NOTE}\n     Read one before it is loaded: /mcp-skills show <name>.\n`);
    });

    test('takes out names whose sentence begins above the top of the screen', () => {
        const top = ['===== 02-preview @ 09:54:37', '     "claude_ai_Notion", "claude_ai_Slack" and 2 more.', '     Read one before it is loaded: /mcp-skills show <name>.', ''].join('\n');
        const { 'transcript.txt': out } = scrub({ 'transcript.txt': top });
        assert.ok(!/claude_ai_|2 more/.test(out), out);
        assert.ok(out.includes(NOTE), out);
    });

    test('takes out a connector or plugin server named anywhere else', () => {
        const { 'a.txt': out } = scrub({ 'a.txt': '  ⎿  Called mcp__claude_ai_Gmail__search and mcp__plugin_figma_figma__get\n' });
        assert.ok(!/Gmail|figma/.test(out), out);
    });

    test("takes out the banner's plan and the folder it ran in, and the usage line", () => {
        const { 'a.txt': out } = scrub({ 'a.txt': screen });
        assert.match(out, /^▝▜██████▀ {2}Fable 5\.2$/m);
        assert.ok(!/Claude Max|someone@|Organization/.test(out), out);
        assert.match(out, /^ ▝▝ {3}▝▝ {3}<project folder>$/m);
        assert.ok(!/acme-secret|clients/.test(out), out);
        assert.ok(!/You've used|weekly limit|Asia\/Jerusalem/.test(out), out);
    });

    test('takes out the command menu under the prompt, and keeps the prompt', () => {
        const { 'a.txt': out } = scrub({ 'a.txt': screen });
        assert.ok(!/my-private-skill|Manage MCP servers/.test(out), out);
        assert.match(out, new RegExp(`${RULE}\n❯ /mcp-sk\n${RULE}\n  \\[command menu removed\\]\n`));
        // The footer under an empty prompt is no menu.
        const idle = `${RULE}\n❯\n${RULE}\n  ⏸ manual mode on · ? for shortcuts\n`;
        assert.equal(scrub({ 'a.txt': idle })['a.txt'], idle);
    });

    test('keeps a folder inside the repository, and changes nothing on a second pass', () => {
        const inside = ` ▝▝   ▝▝   ${ROOT}/live/runs/demo/project\n`;
        const once = scrub({ 'a.txt': inside, 'b.txt': screen });
        assert.equal(once['a.txt'], ' ▝▝   ▝▝   <repo>/live/runs/demo/project\n');
        const twice = scrub(once);
        assert.deepEqual(twice, once);
    });

    test('writes \\n line endings wherever it runs, and reads a file with \\r\\n as one with \\n', () => {
        // Python writes text files with the platform's line ending unless told otherwise: on Windows,
        // \r\n. Run the scrubber with that default forced, as Windows has it, wherever this test runs.
        const windowsText = [
            'import builtins, runpy, sys',
            '_open = builtins.open',
            'def _windows_open(file, mode="r", *args, **kwargs):',
            '    if ("w" in mode or "a" in mode) and "b" not in mode and "newline" not in kwargs and len(args) < 4:',
            '        kwargs["newline"] = "\\r\\n"',
            '    return _open(file, mode, *args, **kwargs)',
            'builtins.open = _windows_open',
            'sys.argv = sys.argv[1:]',
            'runpy.run_path(sys.argv[0], run_name="__main__")'
        ].join('\n');
        const run = mkdtempSync(join(tmpdir(), 'mcp-skills-scrub-'));
        writeFileSync(join(run, 'lf.txt'), screen);
        writeFileSync(join(run, 'crlf.txt'), screen.replace(/\n/g, '\r\n'));
        const done = spawnSync(python!, ['-c', windowsText, SCRUB, run, ROOT], { encoding: 'utf8' });
        assert.equal(done.status, 0, done.stderr);
        const [lf, crlf] = ['lf.txt', 'crlf.txt'].map((n) => readFileSync(join(run, n), 'utf8'));
        assert.ok(!lf.includes('\r'), 'no \\r written');
        assert.equal(crlf, lf, 'a file with \\r\\n is scrubbed as the same file with \\n');
        assert.equal(lf, scrub({ 'a.txt': screen })['a.txt']);
    });

    test('the committed runs show none of it, and are as the scrubber leaves them', () => {
        const runs = join(ROOT, 'live', 'runs');
        for (const run of readdirSync(runs)) {
            const names = readdirSync(join(runs, run)).filter((n) => n.endsWith('.txt'));
            const files = Object.fromEntries(names.map((n) => [n, readFileSync(join(runs, run, n), 'utf8')]));
            for (const [name, text] of Object.entries(files)) {
                assert.ok(!/claude_ai_|plugin_|· Claude \w+|You've used|\\'/.test(text), `${run}/${name}`);
                assert.ok(!text.includes(homedir()), `${run}/${name}`);
            }
            assert.deepEqual(scrub(files), files, run);
        }
    });
});
