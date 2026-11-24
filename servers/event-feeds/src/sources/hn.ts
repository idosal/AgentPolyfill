// Hacker News, through the Algolia HN Search API (https://hn.algolia.com/api), which usually indexes
// an item within a few minutes and can list a thread's comments newest first in one request.
// The page fetched for a subscription depends only on its story (or its search), never on its cursor,
// so every client watching the same thread shares one edge-cached response.

import { ArgError, int, object, oneOf, str } from '../args.ts';
import type { Snapshot } from '../snapshot.ts';
import type { Source } from '../source.ts';
import { clip, excerpt, iso } from '../text.ts';

const ALGOLIA = 'https://hn.algolia.com/api/v1';
const COMMENT_PAGE = 50;
const STORY_PAGE = 30;
const COMMENT_FIELDS = 'attributesToRetrieve=author,comment_text,created_at_i,objectID,parent_id,story_id,story_title&attributesToHighlight=none';
const STORY_FIELDS = 'attributesToRetrieve=author,created_at_i,objectID,title,url,points,num_comments&attributesToHighlight=none';
const USER = /^[A-Za-z0-9_-]{2,15}$/;
const itemUrl = (id: string | number) => `https://news.ycombinator.com/item?id=${id}`;

/**
 * Algolia's API caches its answer to an identical query for several minutes (measured: a thread's
 * comments seven minutes stale). The query therefore names a time window, the past 7 days, whose start is
 * rounded to `bucketSec`: the URL changes once per poll interval, so the answer is fresh, and every client
 * polling in the same interval still shares one cached read.
 */
export function freshWindow(now: number, bucketSec: number): string {
    const start = Math.floor(now / 1000 / bucketSec) * bucketSec - 7 * 86400;
    return `numericFilters=${encodeURIComponent(`created_at_i>${start}`)}`;
}

type Hit = { objectID?: unknown; created_at_i?: unknown; author?: unknown; comment_text?: unknown; parent_id?: unknown; story_id?: unknown; story_title?: unknown; title?: unknown; url?: unknown; points?: unknown; num_comments?: unknown };

function hits(body: unknown): Hit[] {
    const h = (body as { hits?: unknown })?.hits;
    if (!Array.isArray(h)) throw new Error('not an Algolia result');
    return h.filter((x): x is Hit => typeof x === 'object' && x !== null && /^\d{1,12}$/.test(String((x as Hit).objectID)) && typeof (x as Hit).created_at_i === 'number');
}

/** The page is complete back to its oldest item when it is full; when it is not, it holds everything. */
function covers(all: Hit[], size: number): number {
    if (all.length < size) return -Infinity;
    return Math.min(...all.map((x) => (x.created_at_i as number) * 1000));
}

const watermark = (all: Hit[], now: number) => (all.length ? Math.max(...all.map((x) => (x.created_at_i as number) * 1000)) : now);

// ---------------------------------------------------------------------------------------------

type CommentArgs = { story: number; author?: string; repliesTo?: number };

export const hnComment: Source<CommentArgs> = {
    name: 'hn.comment',
    k: 'hc',
    description:
        'A new comment in a Hacker News thread. Use it for "tell me when someone replies to my Show HN", "watch the comments on this HN post", "tell me if dang comments on the launch thread". ' +
        'Set `story` to the thread\'s item id: the number after item?id= in its news.ycombinator.com link (the find_hn_story tool can look it up by title). ' +
        'Optionally narrow to one commenter (`author`) or to direct replies to one item (`repliesTo`: the story itself, or one of its comments). ' +
        'Checked about every 30 seconds; a comment usually arrives within a few minutes of being posted (as fast as Hacker News search indexes it). An event carries ids and a link only: read a comment\'s author and text with the read_event_text tool.',
    inputSchema: {
        type: 'object',
        properties: {
            story: { type: 'integer', minimum: 1, maximum: 999999999999, description: 'Item id of the Hacker News story (the thread), e.g. 50611576 for news.ycombinator.com/item?id=50611576.' },
            author: { type: 'string', pattern: USER.source, description: 'Only comments by this HN username.' },
            repliesTo: { type: 'integer', minimum: 1, maximum: 999999999999, description: 'Only direct replies to this item id (the story, or a comment in it). Leave out for every comment in the thread.' }
        },
        required: ['story'],
        additionalProperties: false
    },
    payloadSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', pattern: '^[0-9]+$', description: 'Comment item id. Its author and text: read_event_text.' },
            url: { type: 'string', format: 'uri', description: 'The comment on news.ycombinator.com.' },
            parentId: { type: 'string', pattern: '^[0-9]+$', description: 'Item the comment replies to.' },
            storyId: { type: 'string', pattern: '^[0-9]+$' },
            postedAt: { type: 'string', format: 'date-time' }
        },
        required: ['id', 'url', 'storyId', 'postedAt'],
        additionalProperties: false
    },
    nextPollMs: 30_000,
    parse(raw) {
        const o = object(raw, ['story', 'author', 'repliesTo']);
        return {
            story: int(o, 'story', 1, 999999999999, true, 'the item id of the HN story')!,
            author: str(o, 'author', USER, false, 'an HN username (2 to 15 letters, digits, - or _)'),
            repliesTo: int(o, 'repliesTo', 1, 999999999999, false, 'an HN item id')
        };
    },
    async check(a, l) {
        // Only when a subscription starts: is `story` a story? A model may pass a comment's id instead.
        const r = await l.json(`https://hacker-news.firebaseio.com/v0/item/${a.story}.json`, 3600);
        if (!r.ok) return; // the check is a courtesy: if the HN API is down, carry on
        const item = r.body as { type?: unknown; dead?: unknown } | null;
        if (item === null) throw new ArgError(`Hacker News has no item ${a.story}`, { argument: 'story' });
        if (item.type === 'comment') throw new ArgError(`item ${a.story} is a comment, not a story: pass the id of its story as "story" (and ${a.story} as "repliesTo" for replies to that comment only)`, { argument: 'story' });
        if (item.type !== 'story' && item.type !== 'poll') throw new ArgError(`item ${a.story} is a ${String(item.type)}, not a story`, { argument: 'story' });
    },
    load: (a, l, now) => l.json(`${ALGOLIA}/search_by_date?tags=comment,story_${a.story}&hitsPerPage=${COMMENT_PAGE}&${freshWindow(now, 30)}&${COMMENT_FIELDS}`, 25),
    snapshot(body, a, now): Snapshot {
        const all = hits(body);
        const items = all
            .filter((x) => (a.author === undefined || x.author === a.author) && (a.repliesTo === undefined || Number(x.parent_id) === a.repliesTo))
            .map((x) => {
                const id = String(x.objectID);
                const ts = (x.created_at_i as number) * 1000;
                return {
                    id,
                    ts,
                    occurrence: {
                        eventId: id,
                        name: 'hn.comment',
                        timestamp: iso(ts),
                        // Ids, a time and a link built here: no text anyone on HN wrote (read_event_text has it).
                        data: {
                            id,
                            url: itemUrl(id),
                            ...(/^\d{1,12}$/.test(String(x.parent_id)) ? { parentId: String(x.parent_id) } : {}),
                            storyId: String(a.story),
                            postedAt: iso(ts)
                        }
                    }
                };
            });
        return { items, covers: covers(all, COMMENT_PAGE), watermark: watermark(all, now) };
    },
    notFound: (a) => `Hacker News has no story ${a.story}`
};

// ---------------------------------------------------------------------------------------------

type StoryArgs = { query?: string; kind: 'any' | 'show_hn' | 'ask_hn'; author?: string };

export const hnStory: Source<StoryArgs> = {
    name: 'hn.story',
    k: 'hs',
    description:
        'A new story posted to Hacker News, optionally only those whose title contains a word or phrase (`query`), only Show HN or Ask HN posts (`kind`), or only by one user (`author`). ' +
        'Use it for "tell me when something about Rust is posted on HN", "watch for new Show HNs", "tell me when pg posts". ' +
        'With no arguments it fires for every new story, about one a minute. Checked about every 60 seconds. An event carries ids and a link only: read the title with the read_event_text tool.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', minLength: 2, maxLength: 80, description: 'Word or phrase the title must contain (matched by Algolia, whole words, no typos).' },
            kind: { type: 'string', enum: ['any', 'show_hn', 'ask_hn'], default: 'any', description: 'Only Show HN or Ask HN posts.' },
            author: { type: 'string', pattern: USER.source, description: 'Only stories by this HN username.' }
        },
        additionalProperties: false
    },
    payloadSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', pattern: '^[0-9]+$', description: 'Story item id. Its title, author and link: read_event_text.' },
            url: { type: 'string', format: 'uri', description: 'The HN discussion page.' },
            points: { type: 'integer' },
            comments: { type: 'integer' },
            postedAt: { type: 'string', format: 'date-time' }
        },
        required: ['id', 'url', 'postedAt'],
        additionalProperties: false
    },
    nextPollMs: 60_000,
    parse(raw) {
        const o = object(raw, ['query', 'kind', 'author']);
        const q = str(o, 'query', /^[^\u0000-\u001f]{2,80}$/u, false, '2 to 80 characters');
        const query = q?.trim().replace(/\s+/g, ' ');
        if (q !== undefined && (query!.length < 2 || !/[\p{L}\p{N}]/u.test(query!))) throw new ArgError('argument "query" needs at least two characters and a letter or digit', { argument: 'query' });
        return { query, kind: oneOf(o, 'kind', ['any', 'show_hn', 'ask_hn'] as const, 'any'), author: str(o, 'author', USER, false, 'an HN username') };
    },
    load(a, l, now) {
        const tags = [a.kind === 'any' ? 'story' : a.kind, ...(a.author ? [`author_${a.author}`] : [])].join(',');
        const q = a.query ? `&query=${encodeURIComponent(a.query.toLowerCase())}&typoTolerance=false&restrictSearchableAttributes=title` : '';
        return l.json(`${ALGOLIA}/search_by_date?tags=${tags}${q}&hitsPerPage=${STORY_PAGE}&${freshWindow(now, 60)}&${STORY_FIELDS}`, 50);
    },
    snapshot(body, _a, now): Snapshot {
        const all = hits(body);
        const items = all.map((x) => {
            const id = String(x.objectID);
            const ts = (x.created_at_i as number) * 1000;
            return {
                id,
                ts,
                occurrence: {
                    eventId: id,
                    name: 'hn.story',
                    timestamp: iso(ts),
                    // Ids, counts, a time and a link built here: the title, author and submitted link are read with read_event_text.
                    data: {
                        id,
                        url: itemUrl(id),
                        ...(Number.isInteger(x.points) ? { points: x.points } : {}),
                        ...(Number.isInteger(x.num_comments) ? { comments: x.num_comments } : {}),
                        postedAt: iso(ts)
                    }
                }
            };
        });
        return { items, covers: covers(all, STORY_PAGE), watermark: watermark(all, now) };
    },
    notFound: () => 'Hacker News search is not available'
};

// ---------------------------------------------------------------------------------------------

/** For the find_hn_story tool: stories matching a title, most relevant first. */
export function findStoriesUrl(query: string, author?: string): string {
    const tags = ['story', ...(author ? [`author_${author}`] : [])].join(',');
    return `${ALGOLIA}/search?tags=${tags}&query=${encodeURIComponent(query.toLowerCase())}&hitsPerPage=5&${STORY_FIELDS}`;
}

export function foundStories(body: unknown): { id: string; title: string; author: string; postedAt: string; comments?: number; url: string }[] {
    return hits(body).map((x) => ({
        id: String(x.objectID),
        title: excerpt(x.title, 200),
        author: clip(String(x.author ?? ''), 15),
        postedAt: iso((x.created_at_i as number) * 1000),
        ...(Number.isInteger(x.num_comments) ? { comments: x.num_comments as number } : {}),
        url: itemUrl(String(x.objectID))
    }));
}

export const HN_USER = USER;
