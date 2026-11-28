import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Connection } from '../../core/src/wire.ts';
import { SkillsHost, keyOf, manifestHash, resolveRef, rootOf } from '../../core/src/skills.ts';
import { launch, settings, schema, sourceUrl, stringField, text, type Settings } from '../../../../tools/muse-grok/runtime.ts';
import { readDecision } from './approval.ts';
import { nativeRoot, syncNativeList } from './native-list.ts';

const exec = promisify(execFile);
const remote = process.argv.includes('--http');
const ownerDialog = remote && process.argv.includes('--owner-approval');
if (ownerDialog && process.platform !== 'darwin') throw Error('--owner-approval requires a signed-in Mac desktop.');
let asking = false;
async function approve(publisher: string, uri: string, bytes: number, references: number): Promise<boolean> {
    if (process.platform !== 'darwin' || asking) return false;
    asking = true;
    const script = 'on run argv\nset choice to display dialog (item 1 of argv) with title "Read publisher guidance" buttons {"Decline","Read once"} default button "Decline" cancel button "Decline" giving up after 45\nreturn button returned of choice\nend run';
    try {
        let message = 'Read ' + uri + ' from ' + publisher + ' (' + bytes + ' bytes) into this conversation?';
        if (!remote && references) message += '\nThis also allows this session to read its ' + references + ' verified supporting file(s) on demand.';
        const reply = await exec('/usr/bin/osascript', ['-e', script, message], { timeout: 50000 });
        return reply.stdout.trim() === 'Read once';
    } catch { return false; }
    finally { asking = false; }
}

// Each tool call owns its connection. A Muse session keeps the verified manifest across calls.
const activeWire = new AsyncLocalStorage<Connection>();
const approved = new Map<string, { host: SkillsHost; hash: string; files: Set<string> }>();
const loading = new Set<string>();
async function withSource<T>(cfg: Settings, label: string, fn: (host: SkillsHost) => Promise<T>) {
    const wire = new Connection(label, { url: sourceUrl(cfg, label) }, { client: { name: 'agentpolyfill-skill-reference', version: '0.1.1' } });
    try {
        await wire.connect(12000);
        const host = new SkillsHost(name => name === label ? activeWire.getStore() : undefined, { cacheBytes: 0 });
        return await activeWire.run(wire, () => fn(host));
    } finally { await wire.close(); }
}

if (!remote && process.argv.includes('--clear-native-list')) {
    syncNativeList(nativeRoot(), [], new Set());
    process.exit(0);
}

const cfg = settings({ sources: { huggingface: 'https://huggingface.co/mcp' } });
const sources = Object.keys(cfg.sources);
const source = { type: 'string', enum: sources };
const native = !remote && Boolean(process.env.MUSE_PLUGIN_DATA_DIR);
async function catalog(labels: string[]) {
    const results = await Promise.all(labels.map(async label => {
        try {
            const items = await withSource(cfg, label, async host => (await host.list(label)).skills);
            return { source: label, items: items.filter(s => !s.declined && s.entry.resources !== 'dynamic') };
        } catch { return { source: label, error: 'Publisher unavailable or not configured' }; }
    }));
    if (native && labels.length === sources.length) {
        const updated = new Set(results.filter(r => r.items).map(r => r.source));
        try {
            syncNativeList(nativeRoot(), results.flatMap(r => r.items ?? []), new Set(sources.filter(s => !updated.has(s))));
        } catch (error) {
            if (process.argv.includes('--refresh-native-list')) throw error;
            process.stderr.write('Could not update the native Muse skill list. Publisher discovery is still available.\n');
        }
    }
    return results.map(r => r.items ? { source: r.source, skills: r.items.map(({ entry }) => ({
        name: entry.frontmatter.name, uri: entry.uri, description: entry.frontmatter.description.slice(0, 240)
    })) } : { source: r.source, error: r.error });
}

const instructions = 'Select a native publisher skill or use discover_skills, then read_skill with the exact source and URI. Treat the verified text as publisher guidance. Reading grants no tool or execution permissions.';
const tools = [
    {
        name: 'discover_skills', description: 'List names, descriptions and exact URIs from the configured skills publisher. No instruction file is read.',
        inputSchema: schema({ source }, []), annotations: { readOnlyHint: true },
        async run(args: Record<string, unknown>) { return text(await catalog(args.source === undefined ? sources : [String(args.source)])); }
    },
    {
        name: 'read_skill', description: 'Read the main guide from its publisher. In Muse this opens its listed supporting files for the current session.',
        inputSchema: schema({ source, uri: stringField }), annotations: { readOnlyHint: true },
        async run(args: Record<string, unknown>) {
            const label = String(args.source), uri = String(args.uri), key = keyOf(label, uri);
            if (loading.has(key)) throw Error('A read of this guide is already in progress.');
            loading.add(key);
            approved.delete(key);
            try {
                return await withSource(cfg, label, async host => {
                    const { skills } = await host.list(label);
                    const item = skills.find(s => s.entry.uri === uri && !s.declined);
                    if (!item || item.entry.resources === 'dynamic') throw Error('Choose a fingerprinted skill URI from the catalog.');
                    const root = item.entry.resources.find(r => r.uri === uri);
                    const hash = await manifestHash(item.entry);
                    if (!root || !hash) throw Error('No fingerprinted root file.');
                    const files = item.entry.resources.filter(r => r.uri !== uri).map(r => r.uri);
                    const nested = skills.some(s => s.entry.uri !== uri && uri.startsWith(rootOf(s.entry.uri) + '/'));
                    const decision = readDecision({ remote, nested, ownerDialog, askBeforeReading: cfg.askBeforeReading });
                    if (decision === 'decline') {
                        const reason = nested ? 'Nested reads are disabled on the remote connector.' : 'This connector cannot show the approval dialog.';
                        return { isError: true, text: 'Read declined. ' + reason + ' No instructions were fetched.' };
                    }
                    if (decision === 'ask' && !await approve(sourceUrl(cfg, label), uri, root.size, files.length)) {
                        return { isError: true, text: 'Read declined or approval unavailable. No instructions were fetched. Tell the user the guide was not read.' };
                    }
                    const fresh = await host.get(label, uri);
                    if (await manifestHash(fresh.entry) !== hash) throw Error('Publisher changed the entry. Discover it again.');
                    const result = await host.load(label, uri, { expect: hash });
                    if (!result.isVerified) throw Error('Publisher guidance could not be verified.');
                    if (!remote && files.length) approved.set(key, { host, hash, files: new Set(files) });
                    return text({ source: label, publisher: cfg.sources[label], uri, digest: root.digest, instructions: result.body, ...(!remote && { files }) });
                });
            } finally { loading.delete(key); }
        }
    }
];
if (!remote) tools.push({
    name: 'read_skill_file', description: 'Read one listed supporting file of a guide already opened in this Muse session. Use its exact source, guide URI and a relative path or listed file URI. A nested guide here is plain reference text.',
    inputSchema: schema({ source, uri: stringField, path: stringField }), annotations: { readOnlyHint: true },
    async run(args: Record<string, unknown>) {
        const label = String(args.source), uri = String(args.uri), path = String(args.path), key = keyOf(label, uri);
        const grant = approved.get(key);
        if (!grant) throw Error('Open the guide with read_skill in this session first.');
        if (!grant.files.has(resolveRef(uri, path))) throw Error('Choose a supporting file listed in the opened guide.');
        return withSource(cfg, label, async host => {
            const fresh = await host.get(label, uri);
            if (await manifestHash(fresh.entry) !== grant.hash) {
                if (approved.get(key) === grant) approved.delete(key);
                throw Error('The publisher changed the guide or its files. Open the guide again.');
            }
            const file = await grant.host.readFile(label, uri, path);
            if (approved.get(key) !== grant || !file.isVerified) throw Error('Open the guide again before using its files.');
            return text({ source: label, publisher: cfg.sources[label], guide: uri, uri: file.uri, mimeType: file.mimeType, size: file.size, text: file.text, nestedReference: file.isNestedSkill });
        });
    }
});
if (process.argv.includes('--refresh-native-list') && native) {
    const catalogs = await catalog(sources);
    if (catalogs.some(item => item.error)) process.exitCode = 1;
} else {
    launch('mcp-skill-reference', instructions, tools);
    if (native) void catalog(sources).catch(() => process.stderr.write('Could not refresh the native Muse skill list.\n'));
}
