import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
export async function buildGrok(build, check = false) {
    const result = await build({
        absWorkingDir: dir,
        entryPoints: ['src/cli.mjs'],
        platform: 'node',
        target: 'node22',
        format: 'esm',
        bundle: true,
        minify: true,
        preserveSymlinks: true,
        write: false,
        banner: { js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);' }
    });
    const output = result.outputFiles[0].text;
    for (const file of ['dist/watch.mjs', 'plugin/dist/bridge.mjs']) {
        const path = resolve(dir, file);
        if (check) {
            if (readFileSync(path, 'utf8') !== output) throw Error('Rebuild ' + file);
        } else {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, output);
        }
    }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
    await buildGrok((await import('esbuild')).build, process.argv.includes('--check'));
