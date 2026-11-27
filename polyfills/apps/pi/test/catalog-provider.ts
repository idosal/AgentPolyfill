import { appendFileSync } from 'node:fs';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function catalogObserver(pi: ExtensionAPI) {
    const faux = fauxProvider({provider:'catalog-observer', models:[{id:'offline'}]});
    pi.registerProvider(faux.provider);
    let turn = 0;
    const observe = (context: {messages: unknown[]}) => {
        const visible = pi.getAllTools().filter(t => t.sourceInfo.path === 'builtin:mcp' && t.exposure !== 'hidden');
        appendFileSync(process.env.CATALOG_OBSERVATIONS!, JSON.stringify({
            registered: visible.map(t => t.name), active: pi.getActiveTools(),
            declarations: context.messages.flatMap(m => (m as {toolsAdded?: unknown[]}).toolsAdded ?? [])
        }) + '\n');
        return turn++ === 0 ? fauxAssistantMessage(fauxToolCall('mcp__catalog__switch_catalog', {})) : fauxAssistantMessage('Done');
    };
    faux.setResponses([observe, observe]);
}
