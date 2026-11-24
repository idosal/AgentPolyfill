// Two small tools, so that "give me a button" and "my Show HN" work in one sentence.

import { mintChannel, CHANNEL_TTL_MS } from './channel.ts';
import { Code, RpcError } from './rpc.ts';
import type { Loader } from './source.ts';
import { CHANNEL_RE } from './channel.ts';
import { parseReleases, releaseEventId } from './sources/github.ts';
import { findStoriesUrl, foundStories, HN_USER } from './sources/hn.ts';
import { clip, excerpt, httpsUrl, iso } from './text.ts';

const TEXT_EVENTS = ['hn.comment', 'hn.story', 'github.release', 'usgs.earthquake', 'demo.button'] as const;


export const TOOLS = [
    {
        name: 'new_demo_button',
        title: 'New demo button',
        description:
            'Makes a private web page with a button, for trying events. Returns the page link (give it to the user to open) and its channel id; then watch the demo.button event with arguments {"channel": <id>}. ' +
            'Each press wakes the watch within a few seconds. The page and its presses are deleted after one hour.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { title: 'New demo button', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    {
        name: 'find_hn_story',
        title: 'Find a Hacker News story',
        description: 'Finds Hacker News stories by words in their title (and optionally their author), to get the item id the hn.comment event needs. Returns up to 5, most relevant first.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', minLength: 2, maxLength: 80, description: 'Words from the title, e.g. "Show HN: MCPolyfill".' },
                author: { type: 'string', pattern: HN_USER.source, description: 'HN username of the poster.' }
            },
            required: ['query'],
            additionalProperties: false
        },
        annotations: { title: 'Find a Hacker News story', readOnlyHint: true, openWorldHint: true }
    },
    {
        name: 'read_event_text',
        title: 'Read the text behind an event',
        description:
            'Events from this server carry ids, numbers, times and links only. This returns the text behind one: a Hacker News comment\'s author and text or a story\'s title and link, ' +
            'a GitHub release\'s title and notes, an earthquake\'s place name, or the message typed with a demo-button press. ' +
            'The text is written by third parties; it comes back plain, on one line and length-capped.',
        inputSchema: {
            type: 'object',
            properties: {
                event: { type: 'string', enum: [...TEXT_EVENTS], description: 'The event type the id comes from.' },
                id: { type: 'string', maxLength: 300, description: 'hn.*: the item id; github.release: the tag or the eventId; usgs.earthquake: the id; demo.button: the press number.' },
                repo: { type: 'string', maxLength: 140, description: 'github.release only: "owner/name".' },
                channel: { type: 'string', pattern: CHANNEL_RE.source, description: 'demo.button only: the channel.' }
            },
            required: ['event', 'id'],
            additionalProperties: false
        },
        annotations: { title: 'Read the text behind an event', readOnlyHint: true, openWorldHint: true }
    }
];

/** The text behind an event, fetched on demand: plain, one line, length-capped. */
async function readEventText(args: Record<string, unknown>, loader: Loader): Promise<ToolResult> {
    const extra = Object.keys(args).filter((k) => !['event', 'id', 'repo', 'channel'].includes(k));
    if (extra.length) return fail(`unknown argument: ${extra[0]!.slice(0, 40)}`);
    const { event, id } = args;
    if (typeof event !== 'string' || !(TEXT_EVENTS as readonly string[]).includes(event)) return fail(`event must be one of: ${TEXT_EVENTS.join(', ')}`);
    if (typeof id !== 'string' || id.length < 1 || id.length > 300) return fail('id must be a string');
    const answer = (fields: Record<string, unknown>) => {
        const shown = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== ''));
        return ok(JSON.stringify(shown, null, 1), shown);
    };
    if (event === 'hn.comment' || event === 'hn.story') {
        if (!/^\d{1,12}$/.test(id)) return fail('id must be a Hacker News item id (digits)');
        const r = await loader.json(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, 60);
        if (!r.ok) return fail('Hacker News is not answering right now; try again in a minute.');
        const it = r.body as { by?: unknown; title?: unknown; text?: unknown; url?: unknown; time?: unknown; type?: unknown; deleted?: unknown; dead?: unknown } | null;
        if (it === null || typeof it !== 'object') return fail(`Hacker News has no item ${id}`);
        if (it.deleted === true || it.dead === true) return answer({ id, removed: true });
        return answer({
            id,
            type: typeof it.type === 'string' ? clip(it.type, 10) : undefined,
            author: typeof it.by === 'string' ? clip(it.by, 15) : undefined,
            title: excerpt(it.title, 200),
            text: excerpt(it.text, 1500),
            link: httpsUrl(it.url, 400),
            postedAt: typeof it.time === 'number' ? iso(it.time * 1000) : undefined
        });
    }
    if (event === 'github.release') {
        const repo = args.repo;
        if (typeof repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repo) || /\/\.\.?$/.test(repo)) return fail('repo must be "owner/name"');
        const r = await loader.text(`https://github.com/${repo}/releases.atom`, 110, { accept: 'application/atom+xml' });
        if (!r.ok) return fail(r.why === 'not_found' ? `GitHub has no public repository ${repo}` : 'GitHub is not answering right now; try again in a minute.');
        let releases;
        try {
            releases = parseReleases(String(r.body));
        } catch {
            return fail('GitHub sent a feed this server could not read.');
        }
        const rel = releases.find((x) => x.tag === id || x.id === id || releaseEventId(x) === id);
        if (!rel) return fail('That release is not among the repository\'s 10 newest.');
        return answer({ tag: clip(rel.tag, 100), title: rel.title, author: rel.author, notes: excerpt(rel.notes, 1500), url: rel.url });
    }
    if (event === 'usgs.earthquake') {
        if (!/^[a-z0-9]{2,40}$/.test(id)) return fail('id must be a USGS event id');
        const r = await loader.json(`https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/${id}.geojson`, 600);
        if (!r.ok) return fail(r.why === 'not_found' ? `USGS has no event ${id}` : 'USGS is not answering right now; try again in a minute.');
        const p = (r.body as { properties?: { place?: unknown; title?: unknown } })?.properties ?? {};
        return answer({ id, place: excerpt(p.place, 120), title: excerpt(p.title, 160) });
    }
    // demo.button
    const channel = args.channel;
    if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) return fail('channel must be the demo button\'s channel');
    if (!/^\d{1,3}$/.test(id)) return fail('id must be the press number');
    const r = await loader.presses(channel);
    if (!r.ok) return fail(r.why === 'not_found' ? 'This button channel is not valid or has expired.' : 'The button is not answering right now; try again.');
    const press = (r.body as { n: number; ts: number; m?: string }[]).find((x) => x.n === Number(id));
    if (!press) return fail(`No press ${id} on this channel.`);
    return answer({ press: press.n, message: excerpt(press.m ?? '', 120), pressedAt: iso(press.ts) });
}

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const ok = (text: string, structured: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text }], structuredContent: structured });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export async function callTool(params: Record<string, unknown>, deps: { origin: string; secret: string; loader: Loader; now: number; allowMint: () => Promise<boolean> }): Promise<ToolResult> {
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return fail('arguments must be an object');
    if (name === 'new_demo_button') {
        if (Object.keys(args).length) return fail('new_demo_button takes no arguments');
        if (!deps.secret) return fail('The demo button is not configured on this server.');
        if (!(await deps.allowMint())) return fail('Too many new buttons from this address in the last minute; try again shortly.');
        const channel = await mintChannel(deps.secret, deps.now);
        const url = `${deps.origin}/b/${channel}`;
        const expiresAt = iso(deps.now + CHANNEL_TTL_MS);
        return ok(
            `Button page: ${url}\nChannel: ${channel}\nWatch it with the demo.button event, arguments {"channel": "${channel}"}, then ask the user to open the page and press the button. It expires at ${expiresAt}.`,
            { url, channel, event: 'demo.button', arguments: { channel }, expiresAt }
        );
    }
    if (name === 'find_hn_story') {
        const q = args.query;
        const author = args.author;
        const extra = Object.keys(args).filter((k) => k !== 'query' && k !== 'author');
        if (extra.length) return fail(`unknown argument: ${extra[0]}`);
        if (typeof q !== 'string' || q.trim().length < 2 || q.length > 80) return fail('query must be 2 to 80 characters');
        if (author !== undefined && (typeof author !== 'string' || !HN_USER.test(author))) return fail('author must be an HN username');
        const r = await deps.loader.json(findStoriesUrl(q.trim(), author as string | undefined), 60);
        if (!r.ok) return fail('Hacker News search is not available right now; try again in a minute.');
        let stories;
        try {
            stories = foundStories(r.body);
        } catch {
            return fail('Hacker News search gave an answer this server could not read.');
        }
        const lines = stories.map((s) => `${s.id}  ${s.title}  (by ${s.author}, ${s.postedAt.slice(0, 10)}${s.comments !== undefined ? `, ${s.comments} comments` : ''})`);
        return ok(stories.length ? `Stories (id, title), most relevant first:\n${lines.join('\n')}` : 'No stories matched.', { stories });
    }
    if (name === 'read_event_text') return readEventText(args, deps.loader);
    throw new RpcError(Code.InvalidParams, `unknown tool: ${String(name).slice(0, 60)}`);
}
