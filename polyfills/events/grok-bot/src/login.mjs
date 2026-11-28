import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { privateFile } from './private-file.ts';

function escape(value) {
    if (/[\x00-\x1f]/.test(value)) throw Error('Use paths without control characters.');
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function loginJob(dir) {
    const id = 'org.agentpolyfill.grok-events.' + createHash('sha256').update(dir).digest('hex').slice(0, 24);
    const folder = join(homedir(), 'Library', 'LaunchAgents');
    const file = join(folder, id + '.plist');
    const marker = '<!-- AgentPolyfill watcher ' + id + ' -->';
    const domain = 'gui/' + process.getuid();
    const job = domain + '/' + id;
    const ctl = (...args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 10000 });
    const loaded = () => ctl('print', job).status === 0;
    const owned = () => existsSync(file) && privateFile(file, { secret: true }).includes(marker);
    const installed = () => existsSync(file) ? (owned() ? 'installed' : 'foreign file') : 'off';
    function change(enable) {
        if (process.platform !== 'darwin') throw Error('Start at login requires macOS.');
        if (existsSync(file) && !owned()) throw Error('Another file occupies the login job path.');
        const binary = resolve(process.argv[1]);
        const plist = '<?xml version="1.0" encoding="UTF-8"?>\n' + marker + '\n<plist version="1.0"><dict>' +
            '<key>Label</key><string>' + id + '</string><key>ProgramArguments</key><array>' +
            [process.execPath, binary, 'follow'].map(arg => '<string>' + escape(arg) + '</string>').join('') + '</array>' +
            '<key>EnvironmentVariables</key><dict><key>GROK_EVENTS_HOME</key><string>' + escape(dir) + '</string></dict>' +
            '<key>RunAtLoad</key><true/></dict></plist>\n';
        if (enable) {
            mkdirSync(folder, { recursive: true });
            if (!existsSync(file)) {
                if (loaded()) throw Error('Another service is using this login job label.');
                writeFileSync(file, plist, { flag: 'wx', mode: 0o600 });
            } else if (privateFile(file, { secret: true }) !== plist) throw Error('Disable the old login job before moving the kit.');
            if (!loaded() && ctl('bootstrap', domain, file).status !== 0 && !loaded())
                throw Error('Could not start the login job. Sign in to macOS and retry login enable, or disable it.');
            console.log('Start at login enabled. Use status to inspect the watcher.');
        } else if (existsSync(file)) {
            if (loaded() && ctl('bootout', job).status !== 0 && loaded()) throw Error('Could not stop the login job.');
            unlinkSync(file);
            console.log('Start at login disabled.');
        }
    }
    return { installed, change };
}
