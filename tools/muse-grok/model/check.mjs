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
    ['NativeSkillRead', ['SingleRequest','ApprovedBytes'], { 'reuse':'SingleRequest','other-file':'ApprovedBytes','stale':'ApprovedBytes' }],
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
    // Replay the same ordered actions asserted by the packaged watcher test. TLC must reach
    // the final observation as well as satisfy the ordinary safety invariants on the way.
    const trace = JSON.parse(readFileSync(new URL('lost-ack.json', import.meta.url)));
    const next = trace.map((action, i) => {
        if (!['Append', 'Reserve', 'Post', 'Crash', 'Restart', 'Accept', 'Read'].includes(action)) throw Error('Unknown trace action');
        return `    \\/ /\\ step = ${i} /\\ ${action} /\\ step' = step + 1`;
    }).join('\n');
    const replay = ['---- MODULE LostAckReplay ----', 'EXTENDS RoutineDelivery', 'VARIABLE step',
        'Start == Init /\\ step = 0', 'Advance ==', next,
        `Unreached == ~(step = ${trace.length} /\\ through = 2 /\\ {1} \\in exposed)`, '===='].join('\n');
    writeFileSync(join(cwd, 'LostAckReplay.tla'), replay);
    writeFileSync(join(cwd, 'LostAckReplay.cfg'), 'INIT Start\nNEXT Advance\nCONSTANT Fault = "none"\nINVARIANT NoAutomaticReplay ExactRetryBody OnlyAcceptedReads UnsentRetained Unreached\nCHECK_DEADLOCK FALSE\n');
    const reached = spawnSync(process.env.JAVA || 'java', ['-Xmx256m', '-cp', resolve(jar), 'tlc2.TLC', '-workers', '1', '-config', 'LostAckReplay.cfg', 'LostAckReplay'], { cwd, encoding: 'utf8', timeout: 60000 });
    if (reached.status !== 12 || !reached.stdout.includes('Invariant Unreached is violated.')) throw Error('Lost-ack observation was unreachable: ' + reached.stdout.slice(-2500));
    console.log('Lost-ack replay reached the operator-confirmed first batch and accepted second batch.');

} finally {
    rmSync(cwd, { recursive: true, force: true });
}
