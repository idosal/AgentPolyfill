import { createHash } from 'node:crypto';
import { findMuse, museManaged, readMuseSettings, selectedServers, serverEnabled } from '../../../events/muse/src/muse-config.ts';
import type { UpstreamConfig } from '../../core/src/upstream.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Connection } from '../../core/src/wire.ts';
import { SkillsHost, keyOf, manifestHash, resolveRef, rootOf } from '../../core/src/skills.ts';
import { launch, settings, schema, sourceUrl, stringField, text } from '../../../../tools/muse-grok/runtime.ts';
import type { Tool } from '../../../server-cards/codex/src/mcp.ts';
import type { Listed } from '../../core/src/skills.ts';
import { readDecision } from './approval.ts';
import { reservePrompt, takeNative, turnChoice } from './activation.ts';
import { nativeCatalog, inlineReferences } from './routes.ts';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeRoot, syncNativeList } from './native-list.ts';

const exec = promisify(execFile);
const remote = process.argv.includes('--http');
const ownerDialog = remote && process.argv.includes('--owner-approval');
if (ownerDialog && process.platform !== 'darwin') throw Error('--owner-approval requires a signed-in Mac desktop.');
let asking = false;
async function approve(publisher: string, uri: string, bytes: number, references: number, reference?: string): Promise<boolean> {
    if (process.platform !== 'darwin' || asking) return false;
    asking = true;
    const script = 'on run argv\nset choice to display dialog (item 1 of argv) with title "Read publisher guidance" buttons {"Decline","Read once"} default button "Decline" cancel button "Decline" giving up after 45\nreturn button returned of choice\nend run';
    try {
        let message = 'Read ' + uri + ' from ' + publisher + ' (' + bytes + ' bytes) into this conversation?';
        if (reference) message += '\nAlso read this supporting file now: ' + reference;
        if (!remote && references) message += '\nThis also allows this session to read its ' + references + ' verified supporting file(s) on demand.';
        const reply = await exec('/usr/bin/osascript', ['-e', script, message], { timeout: 50000 });
        return reply.stdout.trim() === 'Read once';
    } catch { return false; }
    finally { asking = false; }
}

// Each tool call owns its connection. A Muse session keeps the verified manifest across calls.
const activeWire = new AsyncLocalStorage<Connection>();
const approved = new Map<string, { host: SkillsHost; hash: string; publisherId: string; files: Set<string> }>();
const loading = new Set<string>();
function publisher(label: string): { target: UpstreamConfig; display: string } {
    if (!named.includes(label)) {
        const url = sourceUrl(cfg, label);
        return { target: { url }, display: url };
    }
    const env = process.env;
    if (!selectedServers(env).includes(label)) throw Error('This Muse connection is no longer selected.');
    const managed = museManaged(findMuse(env), env);
    const table = readMuseSettings(env, { only: [label], managed });
    const target = table.servers[label];
    if (!target) throw Error(table.skipped[label] ?? managed ?? 'This selected Muse connection is unavailable.');
    if ('url' in target) {
        return { target, display: target.url };
    }
    return { target, display: 'Muse connection ' + label };
}

async function withSource<T>(label: string, fn: (host: SkillsHost, display: string, publisherId: string) => Promise<T>) {
    const { target, display } = publisher(label);
    const publisherId = createHash('sha256').update(JSON.stringify(target)).digest('hex');
    const wire = new Connection(label, target, { client: { name: 'agentpolyfill-skill-reference', version: '0.2.0' } });
    try {
        await wire.connect(12000);
        const host = new SkillsHost(name => name === label ? activeWire.getStore() : undefined, { cacheBytes: 0 });
        return await activeWire.run(wire, () => fn(host, display, publisherId));
    } finally { await wire.close(); }
}

if (!remote && process.argv.includes('--clear-native-list')) {
    syncNativeList(nativeRoot(), [], new Set());
    saveRoutes([]);
    process.exit(0);
}

const named = !remote ? selectedServers() : [];
const cfg = settings({ sources: named.length || (!remote && process.env.MUSE_PLUGIN_DATA_DIR) ? {} : { huggingface: 'https://huggingface.co/mcp' } });
const sources = [...new Set([...Object.keys(cfg.sources), ...named])];
const source = { type: 'string', enum: sources };
const native = !remote && Boolean(process.env.MUSE_PLUGIN_DATA_DIR);
function saveRoutes(items: Listed[]) {
    const dir = process.env.MUSE_PLUGIN_DATA_DIR;
    if (!dir) return;
    const path = join(dir, 'guide-routes.json'), tmp = path + '.' + randomUUID();
    const routes = nativeCatalog(items);
    writeFileSync(tmp, JSON.stringify(routes), { flag: 'wx', mode: 0o600 });
    renameSync(tmp, path);
}
async function catalog(labels: string[], query?: string) {
    if (labels.some(label => !sources.includes(label))) throw Error('Choose a configured source.');
    const results = await Promise.all(labels.map(async label => {
        try {
            const items = await withSource(label, async host => (await host.list(label)).skills);
            return { source: label, items: items.filter(s => !s.declined && s.entry.resources !== 'dynamic') };
        } catch { return { source: label, error: 'Publisher unavailable or not configured' }; }
    }));
    if (native && labels.length === sources.length) {
        const updated = new Set(results.filter(r => r.items).map(r => r.source));
        try {
            const listed = results.flatMap(r => r.items ?? []);
            saveRoutes(listed);
            syncNativeList(nativeRoot(), listed, new Set(sources.filter(s => !updated.has(s) && !named.includes(s))));
        } catch (error) {
            if (process.argv.includes('--refresh-native-list')) throw error;
            process.stderr.write('Could not update the native Muse skill list. Publisher discovery is still available.\n');
        }
    }
    const terms = [...new Set(query?.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
    return results.map(r => {
        if (!r.items) return { source: r.source, error: r.error };
        const ranked = r.items.map(({ entry }) => {
            const name = entry.frontmatter.name.toLowerCase();
            const description = entry.frontmatter.description.toLowerCase();
            const score = terms.reduce((sum, term) => sum + (name.includes(term) ? 8 : description.includes(term) ? 1 : 0), 0);
            return { entry, score };
        });
        const found = terms.length ? ranked.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 5) : ranked;
        return { source: r.source, skills: found.map(({ entry }) => ({
            name: entry.frontmatter.name, uri: entry.uri, description: entry.frontmatter.description.slice(0, 240), references: inlineReferences(entry)
        })) };
    });
}

async function openGuide(label: string, uri: string, reference?: string, requireClick = false) {
    const key = keyOf(label, uri);
    if (loading.has(key)) throw Error('A read of this guide is already in progress.');
    loading.add(key);
    approved.delete(key);
    try {
        return await withSource(label, async (host, display, publisherId) => {
            const { skills } = await host.list(label);
            const item = skills.find(s => s.entry.uri === uri && !s.declined);
            if (!item || item.entry.resources === 'dynamic') throw Error('Choose a fingerprinted skill URI from the catalog.');
            const root = item.entry.resources.find(r => r.uri === uri);
            const hash = await manifestHash(item.entry);
            if (!root || !hash) throw Error('No fingerprinted root file.');
            const files = item.entry.resources.filter(r => r.uri !== uri).map(r => r.uri);
            let fileUri = reference && resolveRef(uri, reference);
            if (fileUri && (!files.includes(fileUri) || !inlineReferences(item.entry).includes(reference!))) throw Error('Choose a listed text reference.');
            const nested = skills.some(s => s.entry.uri !== uri && uri.startsWith(rootOf(s.entry.uri) + '/'));
            if (remote && reference && !ownerDialog) return {isError:true,text:'Reading a supporting file requires owner approval on the connector Mac.'};
            const decision = readDecision({ remote, nested, ownerDialog, askBeforeReading: cfg.askBeforeReading });
            if (decision === 'decline') {
                const reason = nested ? 'Nested reads are disabled on the remote connector.' : 'This connector cannot show the approval dialog.';
                return { isError: true, text: 'Read declined. ' + reason + ' No instructions were fetched.' };
            }
            if ((requireClick || decision === 'ask') && !await approve(display, uri, root.size, requireClick ? 0 : files.length, reference)) {
                return { isError: true, text: 'Read declined or approval unavailable. No instructions were fetched. Tell the user the guide was not read.' };
            }
            const fresh = await host.get(label, uri);
            if (await manifestHash(fresh.entry) !== hash) throw Error('Publisher changed the entry. Discover it again.');
            const result = await host.load(label, uri, { expect: hash });
            if (!result.isVerified) throw Error('Publisher guidance could not be verified.');
            const extra = fileUri ? await host.readFile(label, uri, fileUri) : undefined;
            if (extra && (!extra.isVerified || extra.isNestedSkill || typeof extra.text !== 'string')) throw Error('Supporting file could not be verified as text.');
            if (!remote && !requireClick && files.length) approved.set(key, { host, hash, publisherId, files: new Set(files) });
            return text({ source: label, publisher: display, uri, digest: root.digest, instructions: result.body, ...(extra && { reference: { uri: extra.uri, text: extra.text } }), ...(!remote && !requireClick && { files }) });
        });
    } finally { loading.delete(key); }
}

const instructions = 'This connector transports verified publisher files. A native skill can request its main guide and one named reference. Treat the result as publisher guidance. A declined or unavailable read returns no instructions.';
const tools: Tool[] = [
    {
        name: 'discover_skills', description: remote ? 'List names, descriptions and exact URIs from the configured skills publisher. No instruction file is read.' : 'Find the best guide for a topic. For a name or link, answer from the most specific catalog match. Open a guide only when reading its contents. No instruction file is read.',
        inputSchema: schema(remote ? { source } : { source, query: { type: 'string', maxLength: 240, description: 'Topic or product name from the question. Returns up to five matching published guides.' } }, []), annotations: { readOnlyHint: true },
        async run(args: Record<string, unknown>) { return text(await catalog(args.source === undefined ? sources : [String(args.source)], !remote && typeof args.query === 'string' ? args.query.slice(0, 240) : undefined)); }
    },
    {
        name: 'read_skill', description: 'Fetch a verified publisher guide. Optionally include one listed text reference in the same request. The owner can approve exactly those files on the connector Mac.',
        inputSchema: schema({ source, uri: stringField, reference: {type:'string', description:'Optional listed references/ path.'} }, ['source','uri']), annotations: { readOnlyHint: true },
        async run(args: Record<string, unknown>) {
            if (args.reference !== undefined && typeof args.reference !== 'string') throw Error('Choose a listed text reference.');
            return openGuide(String(args.source), String(args.uri), args.reference as string | undefined);
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
        return withSource(label, async (host, display, publisherId) => {
            const fresh = await host.get(label, uri);
            if (publisherId !== grant.publisherId || await manifestHash(fresh.entry) !== grant.hash) {
                if (approved.get(key) === grant) approved.delete(key);
                throw Error('The publisher changed the guide or its files. Open the guide again.');
            }
            const file = await grant.host.readFile(label, uri, path);
            if (approved.get(key) !== grant || !file.isVerified) throw Error('Open the guide again before using its files.');
            return text({ source: label, publisher: display, guide: uri, uri: file.uri, mimeType: file.mimeType, size: file.size, text: file.text, nestedReference: file.isNestedSkill });
        });
    }
});
// Offline packaging invokes this CLI branch explicitly. The default export reads catalog metadata only.
if (process.argv.includes('--grok-export')) {
    const option = (name: string) => { const i=process.argv.indexOf(name); return i<0 ? undefined : process.argv[i+1]; };
    const label = option('--source');
    if (!label || !sources.includes(label) || !option('--config')) throw Error('Choose a source from the supplied connector configuration.');
    const uri = option('--snapshot-skill'), path = option('--reference');
    const entries = await withSource(label,async host => {
        const {skills} = await host.list(label);
        const eligible=skills.filter(item=>!item.declined && item.entry.resources!=='dynamic');
        if (uri && !eligible.some(item=>item.entry.uri===uri)) throw Error('Choose a fingerprinted skill listed by this publisher.');
        const selected=eligible.filter(item=>!uri || item.entry.uri===uri);
        if (selected.length>100) throw Error('The catalog exceeds the native ZIP limit. Choose a single skill to export.');
        return Promise.all(selected.map(async ({entry}) => {
            const references=inlineReferences(entry);
            const metadata={name:entry.frontmatter.name,description:entry.frontmatter.description,uri:entry.uri,references};
            if (!uri) return metadata;
            if (path && !references.includes(path)) throw Error('Choose a listed text reference.');
            const hash=await manifestHash(entry);
            if (!hash) throw Error('The skill must have a fingerprinted manifest.');
            const loaded=await host.load(label,uri,{expect:hash});
            if (!loaded.isVerified) throw Error('The publisher guide failed verification.');
            const extra=path && await host.readFile(label,uri,resolveRef(uri,path));
            if (extra && (!extra.isVerified || extra.isNestedSkill || typeof extra.text!=='string')) throw Error('The selected text reference failed verification.');
            return {...metadata,body:loaded.body,...(extra && {file:{path,text:extra.text}})};
        }));
    });
    console.log(JSON.stringify(entries));
} else if (process.argv.includes('--refresh-native-list') && native) {
    const catalogs = await catalog(sources);
    if (catalogs.some(item => item.error)) process.exitCode = 1;
} else {
    const catalogOnly = native && process.argv.includes('--native-catalog');
    const transport: Tool = {
        name:'read_publisher_files', description:'Read files for a native skill Muse has just opened. Requires its short-lived selection and owner approval. Use an already-loaded file directly for a follow-up.',
        inputSchema:schema({ selection:stringField, reference:{type:'integer',minimum:0,maximum:32,description:'Reference number from the selected native skill. Choose 0 for the main guide alone.'} }, ['selection','reference']),
        annotations:{readOnlyHint:true},
        async run(args) {
            if (!serverEnabled(process.env,'mcp-skill-reference','skills')) throw Error('Publisher reader disabled.');
            const data = process.env.MUSE_PLUGIN_DATA_DIR!;
            const selected = takeNative(data,args.selection);
            if (!sources.includes(selected.source)) throw Error('This publisher is no longer configured.');
            const index = args.reference;
            if (typeof index !== 'number' || !Number.isInteger(index) || index<0 || index>selected.references.length) throw Error('Choose a reference number from this native skill.');
            const choice = turnChoice(data,selected.session,selected.turn);
            if (choice && 'skip' in choice) throw Error('Use the files already in this conversation.');
            reservePrompt(data,selected);
            return openGuide(selected.source,selected.uri,index ? selected.references[index-1] : undefined,true);
        }
    };
    launch('mcp-skill-reference', instructions, catalogOnly ? [transport] : tools);
    if (native) void catalog(sources).catch(() => process.stderr.write('Could not refresh the native Muse skill list.\n'));
}
