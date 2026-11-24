// The PostToolUse hook, run as Codex runs it: the built mod/dist/hook.js, with the hook
// input on stdin. The input is the shape Codex 0.172 sends (seen live: session_id,
// turn_id, transcript_path, cwd, hook_event_name, model, permission_mode, tool_name,
// tool_input, tool_response, tool_use_id).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '../../core/src/links.ts';
import { mcpToolOf, onPostToolUse } from '../src/hook.ts';
import { KEEP_MS, readNotes } from '../src/notes.ts';

const HOOK = fileURLToPath(new URL('../mod/dist/hook.js', import.meta.url));
const SESSION = '01a20f73-eab2-7923-8190-6d511c8ad4a4';

const input = (o: Record<string, unknown> = {}) => ({
    session_id: SESSION,
    turn_id: '01a20f74-1c8f-7311-92fb-98957c01155d',
    transcript_path: '/tmp/rollout.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'PostToolUse',
    model: 'gpt-6.2-sol',
    permission_mode: 'default',
    tool_name: 'mcp__docs__text_link',
    tool_input: {},
    tool_response: {
        content: [
            { type: 'text', text: 'The report is ready. Its full text is linked.' },
            { type: 'resource_link', uri: 'fixture://docs/report.txt', name: 'report.txt', title: 'Quarterly report', description: 'The full text', mimeType: 'text/plain', size: 112 },
        ],
    },
    tool_use_id: 'exec-8de960a0',
    ...o,
});

function runHook(payload: unknown, env: Record<string, string> = {}) {
    const state = mkdtempSync(join(tmpdir(), 'rl-hook-'));
    const r = spawnSync(process.execPath, [HOOK], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), env: { ...process.env, MCP_RESOURCE_LINKS_STATE: state, MCP_RESOURCE_LINKS_DISABLED: '', ...env }, encoding: 'utf8' });
    return { ...r, state };
}

test('the hook notes the links of an MCP tool result, prints nothing, and exits 0', () => {
    const r = runHook(input());
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.deepEqual(
        readNotes(r.state, SESSION).map(({ at: _at, ...l }) => l),
        [{ server: 'docs', tool: 'text_link', uri: 'fixture://docs/report.txt', name: 'report.txt', mimeType: 'text/plain', size: 112 }],
    );
    // Nothing else of the result is kept.
    const raw = readFileSync(join(r.state, 'sessions', `${SESSION}.jsonl`), 'utf8');
    assert.doesNotMatch(raw, /The report is ready|Quarterly report|The full text/);
});

test('the hook ignores tools that are not MCP tools, its own tool, and other events', () => {
    for (const o of [{ tool_name: 'exec_command' }, { tool_name: 'mcp__mcp-resource-links__read_resource_link' }, { hook_event_name: 'PreToolUse' }]) {
        const r = runHook(input(o));
        assert.equal(r.status, 0);
        assert.equal(existsSync(join(r.state, 'sessions')), false, JSON.stringify(o));
    }
});

test('the hook writes nothing for a session id that is not a plain id', () => {
    for (const session_id of ['../../etc/passwd', '', 'a/b', 'x'.repeat(200), 5]) {
        const r = runHook(input({ session_id }));
        assert.equal(r.status, 0);
        assert.equal(existsSync(join(r.state, 'sessions')), false, String(session_id));
    }
});

test('the hook exits 0 and prints nothing on input it cannot read', () => {
    for (const bad of ['not json', '[]', '{"tool_response": null}']) {
        const r = runHook(bad);
        assert.equal(r.status, 0);
        assert.equal(r.stdout, '');
    }
});

test('MCP_RESOURCE_LINKS_DISABLED turns the hook off', () => {
    const r = runHook(input(), { MCP_RESOURCE_LINKS_DISABLED: '1' });
    assert.equal(r.status, 0);
    assert.equal(existsSync(join(r.state, 'sessions')), false);
});

test('mcp__<server>__<tool> is read as the server up to the first __', () => {
    assert.deepEqual(mcpToolOf('mcp__docs__text_link'), { server: 'docs', tool: 'text_link' });
    assert.deepEqual(mcpToolOf('mcp__my-server__do__it'), { server: 'my-server', tool: 'do__it' });
    for (const bad of ['docs__x', 'mcp__', 'mcp____x', 'mcp__docs__', 5, undefined]) assert.equal(mcpToolOf(bad), undefined, String(bad));
});

test('a session keeps at most LIMITS.linksPerSession links', () => {
    const state = mkdtempSync(join(tmpdir(), 'rl-cap-'));
    const env = { MCP_RESOURCE_LINKS_STATE: state };
    const many = Array.from({ length: LIMITS.linksPerSession + 20 }, (_, i) => ({ type: 'resource_link', uri: `fixture://docs/${i}`, name: `${i}` }));
    onPostToolUse(input({ tool_response: { content: many.slice(0, 300) } }), env);
    onPostToolUse(input({ tool_response: { content: many.slice(300) } }), env);
    assert.equal(readNotes(state, SESSION).length, LIMITS.linksPerSession);
});

test("a session's notes are removed once they are older than KEEP_MS", () => {
    const state = mkdtempSync(join(tmpdir(), 'rl-prune-'));
    mkdirSync(join(state, 'sessions'), { recursive: true });
    const old = join(state, 'sessions', 'old-session.jsonl');
    writeFileSync(old, '{}\n');
    const past = (Date.now() - KEEP_MS - 60_000) / 1000;
    utimesSync(old, past, past);
    onPostToolUse(input(), { MCP_RESOURCE_LINKS_STATE: state });
    assert.equal(existsSync(old), false);
    assert.equal(readNotes(state, SESSION).length, 1);
});
