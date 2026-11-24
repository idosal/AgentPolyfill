// GitHub releases, from a repository's public releases Atom feed (github.com/OWNER/REPO/releases.atom):
// the same page a feed reader polls, no API token, no REST API rate limit per address. It lists the
// ten most recent releases.

import { ArgError, object, str } from '../args.ts';
import type { Snapshot } from '../snapshot.ts';
import type { Source } from '../source.ts';
import { clip, decodeEntities, excerpt, iso } from '../text.ts';

const PAGE = 10;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

type Args = { owner: string; repo: string };

const field = (entry: string, tag: string) => new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry)?.[1];

/** Tags shown in an event: plain identifiers only (a tag is any string the repository's owner chose). */
export const SAFE_TAG = /^[A-Za-z0-9._@+/-]{1,100}$/;

/** Longest feed entry id used as an eventId as it is; longer ones are hashed. */
export const MAX_EVENT_ID = 100;

/**
 * The feed entry's own id ("tag:github.com,2008:Repository/<n>/<tag>") when it is short and holds a plain
 * tag; otherwise a hash of it, so no long or odd publisher-chosen text rides along in the eventId.
 */
export function releaseEventId(r: { id: string; tag: string }): string {
    if (SAFE_TAG.test(r.tag) && r.id.length <= MAX_EVENT_ID && /^tag:github\.com,2008:Repository\/\d{1,12}\/[A-Za-z0-9._@+/-]+$/.test(r.id)) return r.id;
    let h = 0x811c9dc5;
    for (const b of new TextEncoder().encode(r.id)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    return `github-release-${h.toString(36)}`;
}

export type Release = { id: string; ts: number; tag: string; title: string; author: string; url: string; notes: string };

/** The entries of a releases Atom feed. Throws when the text is not one. */
export function parseReleases(xml: string): Release[] {
    if (!/<feed\b[^>]*xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/.test(xml)) throw new Error('not an Atom feed');
    const out: Release[] = [];
    for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const e = m[1]!;
        const id = decodeEntities(field(e, 'id') ?? '').trim();
        const updated = Date.parse(field(e, 'updated') ?? '');
        const href = /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/.exec(e)?.[1];
        if (!id || id.length > 300 || !Number.isFinite(updated) || !href) continue;
        const url = decodeEntities(href);
        if (!url.startsWith('https://github.com/')) continue;
        const tagPart = /\/releases\/tag\/([^?#]+)$/.exec(url)?.[1];
        let tag = '';
        try {
            tag = tagPart ? decodeURIComponent(tagPart) : '';
        } catch {
            tag = tagPart ?? '';
        }
        out.push({
            id,
            ts: updated,
            tag: clip(tag, 100),
            title: excerpt(decodeEntities(field(e, 'title') ?? ''), 200),
            author: clip(decodeEntities(field(field(e, 'author') ?? '', 'name') ?? '').trim(), 39),
            url,
            // The content is HTML escaped inside XML: unescape once for the HTML, then make it plain text.
            notes: excerpt(decodeEntities(field(e, 'content') ?? ''), 1500)
        });
    }
    return out;
}

export const githubRelease: Source<Args> = {
    name: 'github.release',
    k: 'gr',
    description:
        'A new release (or tag) published in a public GitHub repository. Use it for "tell me when Bun cuts a release", "watch cloudflare/workers-sdk for new versions". ' +
        'Set `repo` to "owner/name" as in its github.com URL. Read from the repository\'s public releases feed, which shows the 10 newest; checked about every 2 minutes. An event carries the tag and a link only: read the title and notes with the read_event_text tool.',
    inputSchema: {
        type: 'object',
        properties: { repo: { type: 'string', maxLength: 140, pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$', description: 'The repository as "owner/name", e.g. "oven-sh/bun".' } },
        required: ['repo'],
        additionalProperties: false
    },
    payloadSchema: {
        type: 'object',
        properties: {
            repo: { type: 'string' },
            tag: { type: 'string', pattern: '^[A-Za-z0-9._@+/-]{1,100}$', description: 'The release\'s tag, when it is a plain identifier like v1.2.3. Title and notes: read_event_text.' },
            url: { type: 'string', format: 'uri' },
            updatedAt: { type: 'string', format: 'date-time' }
        },
        required: ['repo', 'url', 'updatedAt'],
        additionalProperties: false
    },
    nextPollMs: 120_000,
    parse(raw) {
        const o = object(raw, ['repo']);
        const full = str(o, 'repo', /^[^/\s]{1,39}\/[^/\s]{1,100}$/, true, 'a repository as "owner/name"');
        const [owner, repo] = full.split('/') as [string, string];
        if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') throw new ArgError(`"${full.slice(0, 80)}" is not a GitHub repository name ("owner/name")`, { argument: 'repo' });
        return { owner, repo: repo.replace(/\.git$/, '') };
    },
    load: (a, l) => l.text(`https://github.com/${a.owner}/${a.repo}/releases.atom`, 110, { accept: 'application/atom+xml' }),
    snapshot(body, a, now): Snapshot {
        if (typeof body !== 'string') throw new Error('not text');
        const all = parseReleases(body);
        const repo = `${a.owner}/${a.repo}`;
        const items = all.map((r) => ({
            id: r.id,
            ts: r.ts,
            occurrence: {
                eventId: releaseEventId(r),
                name: 'github.release',
                timestamp: iso(r.ts),
                // The repository (the subscriber's own argument), the tag when it is a plain identifier, a link
                // built here and a time. Title, author and notes are read with read_event_text.
                data: {
                    repo,
                    ...(SAFE_TAG.test(r.tag) ? { tag: r.tag } : {}),
                    url: SAFE_TAG.test(r.tag) ? `https://github.com/${repo}/releases/tag/${encodeURIComponent(r.tag)}` : `https://github.com/${repo}/releases`,
                    updatedAt: iso(r.ts)
                }
            }
        }));
        const covers = all.length < PAGE ? -Infinity : Math.min(...all.map((r) => r.ts));
        const watermark = all.length ? Math.max(...all.map((r) => r.ts)) : now;
        return { items, covers, watermark };
    },
    notFound: (a) => `GitHub has no public repository ${a.owner}/${a.repo}`
};
