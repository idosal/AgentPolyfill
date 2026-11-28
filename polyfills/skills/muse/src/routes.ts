import { createHash } from 'node:crypto';
import { keyOf, type Listed } from '../../core/src/skills.ts';

export function namedGuides(items: Listed[]) {
    const shown = items.filter(item => !item.declined && item.entry.resources !== 'dynamic').slice(0, 32);
    const words = (name: string) => name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const frequency = new Map<string, number>();
    for (const item of shown) for (const word of new Set(words(item.entry.frontmatter.name))) {
        frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
    return shown.map(item => {
        const {entry, label} = item;
        const suffix = createHash('sha256').update(keyOf(label, entry.uri)).digest('hex').slice(0, 8);
        // Muse shortens long names after prepending its server namespace. Keep the distinctive
        // product word visible even when multiple guides start with the publisher's name.
        const tokens = words(entry.frontmatter.name);
        const rarest = Math.min(...tokens.map(word => frequency.get(word)!));
        const topic = tokens.filter(word => frequency.get(word) === rarest).join('_').slice(0, 15) || 'guide';
        const name = 'consult_' + topic + '_' + suffix;
        return { item, name, keywords: tokens.filter(word => frequency.get(word) === 1 && word.length >= 4) };
    });
}
