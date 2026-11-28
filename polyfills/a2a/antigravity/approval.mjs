// Use the same host-issued, one-use approval as AgentPolyfill's Server Cards and Events.
import { digestOf, ownArgs, readHookInput, redeemTicket, runHook, runStop } from '../../server-cards/antigravity/src/gate.ts';

const [mode, server, dir] = process.argv.slice(2);
const tools = ['confirm_delegation', 'answer_delegation'];
if (mode === 'redeem') {
    const { tool, args } = await readHookInput();
    const ticket = redeemTicket(dir, args.agentpolyfill_ticket, tool, digestOf(ownArgs(args)));
    process.stdout.write(JSON.stringify(ticket));
} else if (mode === 'stop') {
    await runStop(() => dir);
} else {
    const handlers = Object.fromEntries(tools.map(tool => [tool, (args) => {
        const description = tool === 'confirm_delegation'
            ? JSON.stringify(args.message)
            : JSON.stringify({ question: args.prompt, answer: args.answer });
        if (typeof description !== 'string' || description.length > 6000) return { deny: 'The proposal is too long for review.' };
        return { ask: `A2A: ${tool === 'confirm_delegation' ? 'send a message' : 'send this answer'} to ${JSON.stringify(args.destination)}?\n${description}`,
            digest: digestOf(args) };
    }]));
    await runHook({ server, tools, gate: () => ({ handlers, dir }) });
}
