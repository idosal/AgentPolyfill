// The first line of every hand-over (a Codex wake, a Muse context block): the text lands in the
// conversation, so it says whose it is. Kept on its own so the Muse hook bundles nothing else.

import { LINE_PREFIX } from '../../core/src/format.ts';

export const WAKE_HEADER = `${LINE_PREFIX} (Sent by the mcp-events plugin, not typed by the user.)`;
