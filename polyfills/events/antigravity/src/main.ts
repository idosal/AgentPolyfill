import { configureHost } from '../../core/src/host.ts';
import { runHook, stateDir } from '../../../server-cards/antigravity/src/gate.ts';
import { handlers } from './conversation.ts';
import { preInvocation } from './invocation.ts';
import { runSidecar } from './sidecar.ts';
import { logger, runServer } from './server.ts';
import { settings } from './settings.ts';
import { ANTIGRAVITY } from './words.ts';

configureHost(ANTIGRAVITY);
const hook = process.argv.includes('--hook');
const invocation = hook && process.argv[process.argv.indexOf('--hook') + 1] === 'pre-invocation';
if (hook) process.stdout.on('error', () => { process.exitCode = 0; });
const emit = (out: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(out)}\n`, e => e ? reject(e) : resolve());
});
try {
    const base = stateDir('mcp-events');
    const env = settings(base);
    if (invocation) {
        let text = '';
        for await (const chunk of process.stdin) { if (text.length < 4 * 1024 * 1024) text += chunk; }
        let input: unknown;
        try { input = JSON.parse(text); } catch {}
        await preInvocation(input, base, emit, env.MCP_EVENTS_OFF === '1');
    } else if (hook) await runHook(handlers(env.MCP_EVENTS_OFF === '1'), base);
    else if (process.argv.includes('--sidecar')) await runSidecar(base, process.env, logger(base));
    else runServer(base, env, logger(base));
} catch {
    if (hook) await emit(invocation ? {} : { decision: 'deny', reason: 'mcp-events could not read its state; the call was refused.' }).catch(() => {});
    else process.exitCode = 1;
}
if (hook) process.exitCode = 0;
