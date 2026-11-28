import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { serverEnabled } from '../../../events/muse/src/muse-config.ts';

// Only local, previously discovered identifiers enter the prompt. No publisher prose or network requests.
function suggest() {
    const dir = process.env.MUSE_PLUGIN_DATA_DIR;
    if (!dir || !serverEnabled(process.env, 'mcp-skill-reference', 'skills')) return;
    const input = JSON.parse(readFileSync(0, 'utf8'));
    if (typeof input.prompt !== 'string') return;
    const words = new Set(input.prompt.slice(0, 16000).toLowerCase().match(/[a-z0-9]+/g) ?? []);
    const file = join(dir, 'guide-routes.json');
    const stat = statSync(file);
    if (stat.size > 65536 || Date.now() - stat.mtimeMs > 86400000) return;
    const routes = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(routes)) return;
    const matches = routes.filter(r => /^consult_[a-z0-9_]{1,15}_[a-f0-9]{8}$/.test(r?.name) &&
        Array.isArray(r.keywords) && r.keywords.some((k: unknown) => typeof k === 'string' && words.has(k)));
    if (!matches.length || matches.length > 3) return;
    // A full product name such as "Hugging Face ZeroGPU" can identify a more specific
    // guide when the question also mentions a general framework with its own guide.
    const compact = input.prompt.slice(0, 16000).toLowerCase().replace(/[^a-z0-9]/g, '');
    const exact = matches.filter(r => typeof r.title === 'string' && r.title.length >= 4 && compact.includes(r.title));
    const ordered = [...exact].sort((a, b) => b.title.length - a.title.length);
    const names = ordered.length && ordered[0].title.length > (ordered[1]?.title.length ?? 0)
        ? [ordered[0].name] : matches.map(r => r.name);
    const name = names.join(' or ');
    process.stdout.write(JSON.stringify({ systemMessage: 'Publisher guide available: ' + name,
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext:
            'The connected publisher has a guide matching this question. For a how-to question, call ' + name +
            ' and choose the relevant supporting reference from its menu before answering. The reader handles approval. For a listing, use catalog metadata. Respect requests to skip or decline a read.' } }));
}
try { suggest(); } catch { /* Missing or stale metadata must never block the user’s turn. */ }
