// npm: a package's dist-tags (`latest`, `next`, `beta`, ...), from the registry's small dist-tags
// endpoint (a few hundred bytes, unlike the full package document). An event is a tag now pointing
// at a version it did not point at when the subscription last looked.

import { ArgError, object, str } from '../args.ts';
import type { Snapshot } from '../snapshot.ts';
import type { Source } from '../source.ts';
import { iso } from '../text.ts';

// npm's own rules for names (validate-npm-package-name, new packages): lowercase, URL-safe, at most 214.
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const MAX_TAGS = 32;

type Args = { package: string; tag: string };

export const npmRelease: Source<Args> = {
    name: 'npm.release',
    k: 'np',
    description:
        'A new version of an npm package: fires when the package\'s `latest` dist-tag (or the tag you name, such as `next` or `beta`, or "*" for every tag) moves to a new version. ' +
        'Use it for "tell me when React 20 ships", "watch for a new release of wrangler", "tell me when @modelcontextprotocol/sdk publishes a beta". ' +
        'If several versions are published between two checks, you hear about the newest. Checked about every 60 seconds.',
    inputSchema: {
        type: 'object',
        properties: {
            package: { type: 'string', minLength: 1, maxLength: 214, pattern: NAME.source, description: 'Package name as on npm, e.g. "react" or "@modelcontextprotocol/sdk".' },
            tag: { type: 'string', maxLength: 64, default: 'latest', description: 'Dist-tag to watch: "latest" (default), "next", "beta", ... or "*" for all of them.' }
        },
        required: ['package'],
        additionalProperties: false
    },
    payloadSchema: {
        type: 'object',
        properties: {
            package: { type: 'string' },
            version: { type: 'string' },
            tag: { type: 'string', description: 'The dist-tag that now points at this version.' },
            url: { type: 'string', format: 'uri' }
        },
        required: ['package', 'version', 'tag', 'url']
    },
    nextPollMs: 60_000,
    parse(raw) {
        const o = object(raw, ['package', 'tag']);
        const pkg = str(o, 'package', /^.{1,214}$/su, true, 'an npm package name');
        if (!NAME.test(pkg) || pkg.length > 214) throw new ArgError(`"${pkg.slice(0, 60)}" is not a valid npm package name (lowercase, like "react" or "@scope/name")`, { argument: 'package' });
        const tag = str(o, 'tag', /^(\*|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/, false, 'a dist-tag such as "latest", "next", or "*"') ?? 'latest';
        return { package: pkg, tag };
    },
    load: (a, l) => l.json(`https://registry.npmjs.org/-/package/${a.package.replace('/', '%2f')}/dist-tags`, 55),
    snapshot(body, a, now): Snapshot {
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('not a dist-tags document');
        const tags = Object.entries(body as Record<string, unknown>)
            .filter(([t, v]) => TAG.test(t) && typeof v === 'string' && VERSION.test(v))
            .filter(([t]) => a.tag === '*' || t === a.tag)
            .slice(0, MAX_TAGS) as [string, string][];
        const items = tags.map(([tag, version]) => ({
            id: `${tag}@${version}`,
            ts: now,
            occurrence: {
                // Stable for this upstream change: the same tag moving to the same version is the same event.
                eventId: `${a.package}@${version}#${tag}`,
                name: 'npm.release',
                timestamp: iso(now),
                data: { package: a.package, version, tag, url: `https://www.npmjs.com/package/${a.package}/v/${encodeURIComponent(version)}` }
            }
        }));
        return { items, covers: -Infinity, watermark: now };
    },
    notFound: (a) => `npm has no package named "${a.package}"`
};
