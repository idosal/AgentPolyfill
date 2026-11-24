// The demo button: a private page with a button; each press is an event on that page's channel only.

import { object, str } from '../args.ts';
import { CHANNEL_RE } from '../channel.ts';
import type { Press } from '../button-do.ts';
import type { Snapshot } from '../snapshot.ts';
import type { Source } from '../source.ts';
import { iso } from '../text.ts';

type Args = { channel: string };

export const demoButton: Source<Args> = {
    name: 'demo.button',
    k: 'db',
    description:
        'A press of a demo button on a private web page. Use it to try events: "give me a button and tell me when I press it". ' +
        'Get a page and its `channel` id from the new_demo_button tool (or from ' +
        'the server\'s web page), give the user the page link, and watch with that channel. A press may come with a short message typed on the page: read it with read_event_text {"event": "demo.button", "channel": <channel>, "id": <press number>}. ' +
        'A channel lasts one hour; checked every 2 seconds.',
    inputSchema: {
        type: 'object',
        properties: { channel: { type: 'string', pattern: CHANNEL_RE.source, description: 'The channel id from new_demo_button or from the button page (starts with "b", 31 characters).' } },
        required: ['channel'],
        additionalProperties: false
    },
    payloadSchema: {
        type: 'object',
        properties: {
            press: { type: 'integer', description: 'Which press on this channel: 1, 2, 3, ...' },
            hasMessage: { type: 'boolean', description: 'Whether the presser typed a message; read it with read_event_text.' },
            pressedAt: { type: 'string', format: 'date-time' }
        },
        required: ['press', 'hasMessage', 'pressedAt'],
        additionalProperties: false
    },
    nextPollMs: 2_000,
    parse(raw) {
        const o = object(raw, ['channel']);
        return { channel: str(o, 'channel', CHANNEL_RE, true, 'a channel id from new_demo_button: "b" and 30 letters, digits, - or _') };
    },
    load: (a, l) => l.presses(a.channel),
    snapshot(body, _a, now): Snapshot {
        if (!Array.isArray(body)) throw new Error('not a list of presses');
        const items = (body as Press[]).map((p) => ({
            id: String(p.n),
            ts: p.ts,
            occurrence: {
                eventId: `press-${p.n}`,
                name: 'demo.button',
                timestamp: iso(p.ts),
                // The press's number and time, and whether a message came with it: the message itself is
                // read with read_event_text (it is typed by whoever has the page).
                data: { press: p.n, hasMessage: Boolean(p.m), pressedAt: iso(p.ts) }
            }
        }));
        return { items, covers: -Infinity, watermark: now };
    },
    notFound: () => 'this demo button channel is not valid or has expired (channels last one hour): make a new one with new_demo_button'
};
