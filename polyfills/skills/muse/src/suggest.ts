import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { saveTurnChoice } from './activation.ts';
import { suggestedReference } from './routes.ts';
import { serverEnabled } from '../../../events/muse/src/muse-config.ts';

// Only local, previously discovered identifiers enter the prompt. No publisher prose or network requests.
function suggest() {
    const dir = process.env.MUSE_PLUGIN_DATA_DIR;
    if (!dir || !serverEnabled(process.env, 'mcp-skill-reference', 'skills')) return;
    const input = JSON.parse(readFileSync(0, 'utf8'));
    if (typeof input.prompt !== 'string') return;
    if (
        /\b(?:already (?:opened|read|loaded)|no (?:more |new )?(?:reads?|lookups?)|without (?:re)?(?:opening|reading)|do not (?:open|read)|don't (?:open|read))\b/i.test(
            input.prompt,
        )
    ) {
        saveTurnChoice(dir, input.session_id, input.turn_id, { skip: true });
        return;
    }
    saveTurnChoice(dir, input.session_id, input.turn_id);
    const words = new Set(
        input.prompt
            .slice(0, 16000)
            .toLowerCase()
            .match(/[a-z0-9]+/g) ?? [],
    );
    const file = join(dir, 'guide-routes.json');
    const stat = statSync(file);
    if (stat.size > 65536 || Date.now() - stat.mtimeMs > 86400000) return;
    const routes = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(routes)) return;
    const catalog = routes.filter(
        (route) => /^mcp-skills:[a-z0-9_.:@-]{1,64}:[a-z0-9_.:-]+$/i.test(route?.name) && Array.isArray(route.keywords),
    );
    const compact = input.prompt
        .slice(0, 16000)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    const exact = catalog.filter(
        (route) => typeof route.title === 'string' && route.title.length >= 4 && compact.includes(route.title),
    );
    exact.sort((a, b) => b.title.length - a.title.length);
    const matches =
        exact.length && exact[0].title.length > (exact[1]?.title.length ?? 0)
            ? [exact[0]]
            : catalog.filter((route) =>
                  route.keywords.some((key: unknown) => typeof key === 'string' && words.has(key)),
              );
    if (!matches.length || matches.length > 3) return;
    const names = matches.map((route) => route.name);
    if (matches.length === 1) {
        const route = matches[0];
        const reference = suggestedReference(input.prompt.slice(0, 16000), route.references, route.keywords);
        if (reference)
            saveTurnChoice(dir, input.session_id, input.turn_id, { source: route.source, uri: route.uri, reference });
    }
    const name = names.join(' or ');
    const activation =
        names.length === 1
            ? 'The next action for a how-to question is Muse’s built-in read_skill with arguments ' +
              JSON.stringify({ name: names[0] }) +
              '.'
            : 'For a how-to question, select the most relevant native entry with Muse’s built-in read_skill.';
    process.stdout.write(
        JSON.stringify({
            systemMessage: 'Publisher skill available: ' + name,
            hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext:
                    'Muse found a native skill matching the named publisher and product. ' +
                    activation +
                    ' Open the skill before giving publisher-specific advice. For a catalog listing or material already present, use the existing context. Respect requests to skip a read.',
            },
        }),
    );
}
try {
    suggest();
} catch {
    /* Missing or stale metadata must never block the user’s turn. */
}
