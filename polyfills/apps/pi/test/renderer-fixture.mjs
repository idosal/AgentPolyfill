// Supply the same narrow connection interface as the Pi extension. These
// browser-only tests intentionally do not invoke the model's originating tool.
import { Client } from '../../claude-code/mod/helper/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../claude-code/mod/helper/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { openRenderer } from '../renderer.mjs';

export async function fixtureRenderer(options) {
    const client = new Client({name:'pi-browser-fixture',version:'1'}, {capabilities:{
        extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}
    }});
    try {
        await client.connect(new StdioClientTransport(options.config));
        const {tools} = await client.listTools();
        const definition = name => tools.find(tool => tool.name === name);
        const native = {tool:definition(options.tool), definition, current:() => true, hasResources:true,
            resource(method, params) {
                if (method !== 'resources/read') throw Error('Unexpected resource method in this test.');
                return client.readResource(params);
            },
            toolCall(record,args,_,run) { return run(record.name,args); }
        };
        const view = await openRenderer({...options,config:{command:'stdio'},native});
        if (view) void view.closed.then(() => client.close()); else await client.close();
        return view;
    } catch (error) {
        await client.close();
        throw error;
    }
}
