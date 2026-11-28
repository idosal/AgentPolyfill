import { createHash } from 'node:crypto';
import { labelDir, MAX_STUBS, stubNames } from '../../codex/src/stubs.ts';
import { rootOf, type Listed } from '../../core/src/skills.ts';

export function nativeFolder({ label, entry }: Listed) {
    const digest = createHash('sha256').update(entry.uri).digest('hex').slice(0, 16);
    return 'mcp-skill-reference--' + labelDir(label) + '--' + digest;
}

export function nativeCatalog(items: Listed[]) {
    const shown = items.filter((item) => !item.declined && item.entry.resources !== 'dynamic').slice(0, MAX_STUBS);
    const names = stubNames(shown);
    const routes = shown.map((item) => ({
        name: names.get(item)!,
        folder: nativeFolder(item),
        source: item.label,
        uri: item.entry.uri,
        title: item.entry.frontmatter.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
        references: inlineReferences(item.entry),
        keywords: item.entry.frontmatter.name.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [],
    }));
    const counts = new Map<string, number>();
    for (const route of routes) {
        for (const word of new Set(route.keywords)) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    return routes.map((route) => ({ ...route, keywords: route.keywords.filter((word) => counts.get(word)! <= 3) }));
}

export function inlineReferences(entry: Listed['entry']): string[] {
    const root = rootOf(entry.uri) + '/';
    return entry.resources === 'dynamic'
        ? []
        : entry.resources
              .filter((r) => r.uri.startsWith(root) && r.size <= 65536)
              .map((r) => r.uri.slice(root.length))
              .filter(
                  (path) =>
                      /^references\/[A-Za-z0-9_./-]+\.(?:md|txt)$/i.test(path) &&
                      !path.split('/').some((p) => p === '..' || p === '.' || p.toLowerCase() === 'skill.md'),
              )
              .slice(0, 32);
}

// Rank only names already listed by the publisher. A tie or no match leaves the choice to Muse.
export function suggestedReference(prompt: string, references: string[], guideKeywords: string[] = []): string | undefined {
    const words = new Set(prompt.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    for (const word of guideKeywords) words.delete(word);
    const concurrent =
        /\b(?:concurren(?:t|cy)|parallel|simultaneous(?:ly)?|race condition|at the same time|each other[’']s)\b/i.test(
            prompt,
        ) || /\bshar(?:e|ed|ing)\b.{0,40}\bqueue\b/i.test(prompt);
    const ranked = references
        .map((path) => {
            const name = path
                .split('/')
                .pop()!
                .replace(/\.[^.]+$/, '')
                .toLowerCase();
            const terms = name.match(/[a-z0-9]{4,}/g) ?? [];
            let score = terms.reduce((total, term) => total + (words.has(term) ? 2 : 0), 0);
            if (concurrent && /(?:^|[-_.])(?:concurrency|concurrent|parallelism|parallel)(?:$|[-_.])/.test(name))
                score += 2;
            return { path, score };
        })
        .sort((a, b) => b.score - a.score);
    return ranked.length && ranked[0]!.score > (ranked[1]?.score ?? 0) ? ranked[0]!.path : undefined;
}
