import { appendFileSync } from 'node:fs';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export default function sessionProvider(pi: ExtensionAPI) {
    const fake = fauxProvider({provider:'session-test',models:[{id:'offline'}]});
    pi.registerProvider(fake.provider);
    let index = 0;
    const observe = (context: {messages:unknown[]}) => {
        const text = JSON.stringify(context.messages);
        appendFileSync(process.env.PI_APPS_OBSERVATIONS!, JSON.stringify({public:text.includes('Public receipt ready'),
            image:text.includes('"type":"image"'), private:text.includes('fixture-refresh') || text.includes('fixture-current') || text.includes('"receipt":') || text.includes('view data') || text.includes('Private diagnostic from the view'), latest:text.includes('Latest selection'),
            previous:text.includes('Previous selection'), message:text.includes('Explain my selection')}) + '\n');
        return index++ === 0 ? fauxAssistantMessage(fauxToolCall('mcp__fixture__start',{label:'originating call'}))
            : fauxAssistantMessage('Ready.');
    };
    fake.setResponses(Array(10).fill(observe));
}
