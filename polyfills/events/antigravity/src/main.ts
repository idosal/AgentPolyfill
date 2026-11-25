import { configureHost } from '../../core/src/host.ts';
import { LET_BE, readHookInput, runHook, runStop, stateDir } from '../../../server-cards/antigravity/src/gate.ts';
import { handlers } from './conversation.ts';
import { preInvocation } from './invocation.ts';
import { runSidecar } from './sidecar.ts';
import { logger, runServer } from './server.ts';
import { settings } from './settings.ts';
import { ANTIGRAVITY, SERVER, TOOLS } from './words.ts';

configureHost(ANTIGRAVITY);
const argv = process.argv;
const hook = argv.includes('--hook');
const mode = hook ? argv[argv.indexOf('--hook') + 1] : undefined;
if (hook) process.stdout.on('error', () => { process.exitCode = 0; });
const emit = (out: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(out)}\n`, e => e ? reject(e) : resolve());
});
/** The state folder and settings. A hook opens them only for what is this plugin's (gate.ts). */
const open = () => { const base = stateDir('mcp-events'); return { base, env: settings(base) }; };
try {
    if (mode === 'pre-invocation') {
        const input = await readHookInput();
        let state: ReturnType<typeof open> | undefined;
        try { state = open(); } catch {}
        if (state) await preInvocation(input, state.base, emit, state.env.MCP_EVENTS_OFF === '1');
        else await emit({});
    } else if (mode === 'stop') await runStop(() => stateDir('mcp-events'));
    else if (hook) await runHook({ server: SERVER, tools: TOOLS.map(t => t.name), gate: () => { const s = open(); return { handlers: handlers(s.env.MCP_EVENTS_OFF === '1'), dir: s.base }; } });
    else if (argv.includes('--sidecar')) { const s = open(); await runSidecar(s.base, process.env, logger(s.base)); }
    else { const s = open(); runServer(s.base, s.env, logger(s.base)); }
} catch {
    // runHook answers for itself; this is only for a failure around it. Another server's call is never denied.
    if (hook) await emit(mode === 'pre-invocation' || mode === 'stop' ? {} : { ...LET_BE }).catch(() => {});
    else process.exitCode = 1;
}
if (hook) process.exitCode = 0;
