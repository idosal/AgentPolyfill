// Pi registers its native MCP catalog before extension tool hooks see it.
// Apply the same filter to the initial and refreshed native catalog, while
// Node loads the verified module. No installed Pi files are changed.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const releases = {
    '1.6.0': ['chunk-E6LJTZYC.js', '6129fa4537b28cfdc0669052d6f69d8b3563b52adc8c55132409ae3b3dbb7f97'],
    '1.6.1': ['chunk-VUZTGLGT.js', '2451dad9d2a61442579015572f103f5efc53bbcdf33586fa09ee278a19944f84'],
};
const sourceDigest = '1ed03790749c1c494f6ff3891652a4ad895cb25bf2ad4ed61202837c5e3055fb';
const installed = Symbol.for('agentpolyfill.pi.apps.model-catalog.v1');

export function isModelVisible(tool) {
    const visibility = tool._meta?.ui?.visibility;
    return visibility === undefined || (Array.isArray(visibility) && visibility.includes('model'));
}

export function protectModelCatalog(packageDir, version) {
    if (!Object.hasOwn(releases, version) || !nodeModule.registerHooks) {
        throw new Error('Pi Apps needs the supported Node build of Pi 1.6.0 or 1.6.1.');
    }
    const root = realpathSync(packageDir);
    const entry = realpathSync(process.argv[1]);
    const [chunk, bundleDigest] = releases[version];
    const bundled = entry === join(root, 'dist/bundle/cli.js') || entry === join(root, 'dist/bundle/rpc-entry.js');
    if (!bundled && entry !== join(root, 'dist/cli.js')) throw new Error('Pi Apps cannot verify this Pi entry point.');
    const path = bundled ? join(root, 'dist/bundle/chunks', chunk) : join(root, 'dist/extensions/mcp/runtime.js');
    const url = pathToFileURL(path).href;
    const known = globalThis[installed] ??= new Set();
    if (known.has(url)) return;

    // An unrecognized installation must be able to load its own MCP module.
    const source = readFileSync(path);
    if (createHash('sha256').update(source).digest('hex') !== (bundled ? bundleDigest : sourceDigest)) {
        throw new Error('Pi Apps does not recognize this MCP runtime build.');
    }
    const lookup = 'await client.listTools()';
    const parts = source.toString('utf8').split(lookup);
    if (parts.length !== 3) throw new Error('Pi Apps could not verify the native tool catalog.');
    let applied = false;
    const hook = nodeModule.registerHooks({ load(id, context, next) {
        const loaded = next(id, context);
        if (id !== url || !loaded.source || !source.equals(Buffer.from(loaded.source))) return loaded;
        applied = true;
        return { ...loaded, source: parts.join('(' + lookup + ').filter(' + isModelVisible.toString() + ')') };
    } });
    try {
        // Load before any connection or registration. A previously cached,
        // unfiltered module will skip the hook; require a fresh process then.
        nodeModule.createRequire(import.meta.url)(path);
        if (!applied) throw new Error('Restart Pi to enable MCP Apps tool visibility.');
        known.add(url);
    } finally { hook.deregister(); }
}
