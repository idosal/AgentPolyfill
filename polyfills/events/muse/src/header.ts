// The first line of every batch the Muse form hands over, as the Codex form writes it
// (../../codex/src/threads.ts WAKE_HEADER; test/muse-test.ts checks they are equal). Here on its
// own so the UserPromptSubmit hook bundles only the core's format, not the whole Events client.
import { LINE_PREFIX } from '../../core/src/format.ts';

export const WAKE_HEADER = `${LINE_PREFIX} (Sent by the mcp-events plugin, not typed by the user.)`;
