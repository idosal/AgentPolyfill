import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The packaged-adapter test records the same ordered actions after observing each result.
export const actions = ['Ask', 'Decline', 'Ask', 'Allow', 'ReadFile', 'Change', 'Reopen', 'Ask', 'Allow', 'ReadFile'];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const jar = resolve(process.env.TLA2TOOLS || 'tla2tools.jar');
    if (createHash('sha256').update(readFileSync(jar)).digest('hex') !== '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88') throw Error('Use the pinned TLC 1.7.4 jar.');
    const cwd = mkdtempSync(join(tmpdir(), 'skill-approval-replay-'));
    try {
        const file = process.env.MUSE_GROK_TEST_KIT ? join(process.env.MUSE_GROK_TEST_KIT, 'tools/muse-grok/model/SkillApproval.tla') : new URL('./model/SkillApproval.tla', import.meta.url);
        copyFileSync(file, join(cwd, 'SkillApproval.tla'));
        const constraints = ["request'[1] = 1", 'grants[1] = None', "request'[1] = 2", "grants'[2] = <<1,1>>",
            "disclosed' = {<<<<1,1>>,<<1,1>>,TRUE,TRUE>>}", "version' = 2 /\\ target' = 1", "grants'[2] = None",
            "request'[1] = 2", "grants'[2] = <<1,2>>", "disclosed' = {<<<<1,2>>,<<1,2>>,TRUE,TRUE>>}"];
        const steps = actions.map((a,i) => `    \\/ /\\ step = ${i} /\\ ${a} /\\ ${constraints[i]} /\\ step' = step + 1`);
        writeFileSync(join(cwd,'SkillReplay.tla'), ['---- MODULE SkillReplay ----','EXTENDS SkillApproval','VARIABLE step',
            'Start == Init /\\ step = 0','Advance ==',...steps,`Unreached == step # ${actions.length}`,'===='].join('\n'));
        writeFileSync(join(cwd,'SkillReplay.cfg'),'INIT Start\nNEXT Advance\nCONSTANT Fault = "none"\nINVARIANT ScopedVerifiedFile Unreached\nCHECK_DEADLOCK FALSE\n');
        const run=spawnSync(process.env.JAVA || 'java',['-Xmx256m','-cp',jar,'tlc2.TLC','-workers','1','-config','SkillReplay.cfg','SkillReplay'],{cwd,encoding:'utf8',timeout:60000});
        if(run.status!==12 || !run.stdout.includes('Invariant Unreached is violated.')) throw Error('Approval trace did not reach its final verified read. '+run.stdout.slice(-2000));
        console.log('SkillApproval reached a decline, a session-scoped verified read, a manifest change and a new verified read after reopening.');
    } finally { rmSync(cwd,{recursive:true,force:true}); }
}
