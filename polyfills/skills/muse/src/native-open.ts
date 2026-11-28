import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { museConfigDir, serverEnabled } from '../../../events/muse/src/muse-config.ts';
import { selectNative, turnChoice } from './activation.ts';
import type { nativeCatalog } from './routes.ts';

function onNativeRead() {
    const event = JSON.parse(readFileSync(0, 'utf8'));
    if (
        event.hook_event_name !== 'PostToolUse' ||
        event.tool_name !== 'read_skill' ||
        typeof event.tool_response !== 'string'
    )
        return;
    // Match the host-generated header, never text inside the skill document.
    const header =
        /^<read-skill-result [^>\n]*status="ok"[^>\n]*>\n<metadata>\npath: ([^\n]+)\nlocator: [^\n]+\nsource: user\n/.exec(
            event.tool_response,
        );
    if (
        !header ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(event.session_id ?? '') ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(event.turn_id ?? '')
    )
        return;
    const dir = process.env.MUSE_PLUGIN_DATA_DIR!;
    const routes = JSON.parse(readFileSync(join(dir, 'guide-routes.json'), 'utf8')) as ReturnType<typeof nativeCatalog>;
    const route = routes.find((r) => header[1] === join(museConfigDir(process.env), 'skills', r.folder, 'SKILL.md'));
    if (!route) return;
    const emit = (message: string) =>
        console.log(
            JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } }),
        );
    if (!serverEnabled(process.env, 'mcp-skill-reference', 'skills')) {
        emit('Publisher reader unavailable. No publisher guidance was loaded.');
        return;
    }
    const choice = turnChoice(dir, event.session_id, event.turn_id);
    if (choice && 'skip' in choice) {
        emit(
            'The user requested already-open material. Use the existing conversation. No publisher read is available on this turn.',
        );
        return;
    }
    const suggested =
        choice && choice.source === route.source && choice.uri === route.uri
            ? route.references.indexOf(choice.reference) + 1
            : 0;
    const selection = selectNative(dir, {
        source: route.source,
        uri: route.uri,
        references: route.references,
        session: event.session_id,
        turn: event.turn_id,
    });
    const action = suggested
        ? 'For the matching reference the next action is read_publisher_files with arguments ' +
          JSON.stringify({ selection, reference: suggested }) +
          '.'
        : 'Call read_publisher_files with selection ' +
          selection +
          ' and reference set to the number of the relevant file from the native skill. Use 0 for the guide alone.';
    emit(
        'Muse opened a native publisher skill. ' +
            action +
            ' The reader asks before fetching. After a decline continue without the guide. If the files omit the requested detail, say so.',
    );
}
try {
    onNativeRead();
} catch {
    /* A missing catalog never changes another tool result. */
}
