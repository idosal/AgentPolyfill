// The source checkout is a multi-extension Pi package. For an Apps-only release
// copy these two generated files into the root of a detached release checkout.
// Pi installs dependencies at the Git package root before loading its extensions.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = process.argv[2];
if (!directory) throw Error('Usage: node release-manifest.mjs EMPTY_OUTPUT_DIRECTORY');
const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const app = await readJson('../package.json');
const lock = await readJson('../../claude-code/mod/helper/package-lock.json');
const dependencies = Object.fromEntries(
    Object.keys(lock.packages[''].dependencies).map(name => [name, lock.packages['node_modules/' + name].version])
);
const manifest = {
    name: app.name,
    version: app.version,
    description: 'Interactive MCP Apps for the Pi terminal',
    license: 'Apache-2.0',
    repository: 'github:idosal/AgentPolyfill',
    type: 'module',
    keywords: ['pi-package'],
    pi: { extensions: ['./polyfills/apps/pi/index.ts'], prompts: [], skills: [], themes: [] },
    dependencies,
    peerDependencies: {
        '@earendil-works/pi-ai': '*',
        '@earendil-works/pi-coding-agent': '*',
        '@earendil-works/pi-tui': '*'
    }
};
const { name, version, license, peerDependencies } = manifest;
const packages = Object.fromEntries(Object.entries(lock.packages).filter(([path, info]) => path && !info.dev));
const runtimeLock = {
    name, version, lockfileVersion: lock.lockfileVersion, requires: true,
    packages: { '': { name, version, license, dependencies, peerDependencies }, ...packages }
};
for (const [file, data] of [['package.json', manifest], ['package-lock.json', runtimeLock]]) {
    await writeFile(join(directory, file), JSON.stringify(data, null, 2) + '\n', {flag: 'wx'});
}
