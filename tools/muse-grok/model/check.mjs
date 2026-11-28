import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const jar = process.env.TLA2TOOLS;
if (!jar || createHash('sha256').update(readFileSync(jar)).digest('hex') !== '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88') {
    throw Error('Set TLA2TOOLS to the pinned TLC 1.7.4 JAR.');
}
const models = [
    ['RoutineDelivery', ['NoAutomaticReplay', 'ExactRetryBody', 'OnlyAcceptedReads', 'UnsentRetained'],
        { 'automatic-retry': 'NoAutomaticReplay', 'rebuilt-retry': 'ExactRetryBody', 'read-held': 'OnlyAcceptedReads' }],
    ['TaskHandles', ['EnabledOnly', 'BoundHandle'], {
        'global-allowlist': 'EnabledOnly', 'expired-handle': 'BoundHandle', 'wrong-publisher': 'BoundHandle' }],
    ['DiscoveryHandoff', ['DiscoveredEndpoint', 'ReadOnlyPlan'], {
        'unseen-endpoint': 'DiscoveredEndpoint', 'apply-plan': 'ReadOnlyPlan' }],
    ['SkillApproval', ['ScopedVerifiedFile'], {
        'other-session': 'ScopedVerifiedFile', 'wrong-source': 'ScopedVerifiedFile',
        'unlisted-file': 'ScopedVerifiedFile', 'unchecked-bytes': 'ScopedVerifiedFile' }],
    ['WatchConfirmation', ['OneUseAtNamedEndpoint'], {
        'ignore-endpoint': 'OneUseAtNamedEndpoint', 'keep-confirmation': 'OneUseAtNamedEndpoint' }]
];
const cwd = mkdtempSync(join(tmpdir(), 'host-kit-tlc-'));
try {
    for (const [model, invariants, faults] of models) {
        writeFileSync(join(cwd, model + '.tla'), readFileSync(new URL(model + '.tla', import.meta.url)));
        for (const [fault, expected] of [['none', null], ...Object.entries(faults)]) {
            const config = model + '-' + fault + '.cfg';
            writeFileSync(join(cwd, config), ['INIT Init', 'NEXT Next', 'CONSTANT Fault = "' + fault + '"',
                'INVARIANT ' + invariants.join(' '), 'CHECK_DEADLOCK FALSE', ''].join('\n'));
            const run = spawnSync(process.env.JAVA || 'java', ['-Xmx384m', '-XX:+UseParallelGC', '-cp', resolve(jar), 'tlc2.TLC',
                '-workers', '1', '-fp', '0', '-metadir', model + '-' + fault, '-config', config, model], { cwd, encoding: 'utf8', timeout: 180000 });
            const log = run.stdout + run.stderr;
            const passed = expected
                ? run.status === 12 && log.includes('Invariant ' + expected + ' is violated.')
                : run.status === 0 && log.includes('Model checking completed. No error has been found.');
            if (!passed) throw Error(model + '/' + fault + ': ' + (run.error?.message || '') + '\n' + log.slice(-5000));
            const count = log.match(/([\d,]+) distinct states found/);
            console.log(model + ' / ' + fault + ' — ' + (expected ? 'detected ' + expected : 'all invariants hold') +
                (count ? ' (' + count[1] + ' distinct states)' : ''));
        }
    }
} finally {
    rmSync(cwd, { recursive: true, force: true });
}
