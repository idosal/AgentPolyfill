// A paginated label catalog. Switching editions sends an ordinary list_changed.
import { createInterface } from 'node:readline';
const send = message => console.log(JSON.stringify({jsonrpc:'2.0', ...message}));
const label = (name, visibility) => ({
    name, inputSchema:{type:'object', properties:{}},
    ...(visibility === undefined ? {} : {_meta:{ui:{visibility}}})
});
let switched = false, pending;
for await (const line of createInterface({input:process.stdin})) {
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    switch (m.method) {
        case 'initialize':
            send({id:m.id, result:{protocolVersion:'2025-11-25', capabilities:{tools:{listChanged:true}}, serverInfo:{name:'catalog',version:'1'}}});
            break;
        case 'tools/list':
            if (!m.params?.cursor) {
                send({id:m.id,result:{tools:[label('switch_catalog'), label('app_label',['app'])],nextCursor:'labels'}});
            } else {
                send({id:m.id,result:{tools:[label('retired',switched ? ['app'] : ['model','app']),
                    label('new_label',switched ? ['model'] : ['app']), label('unlisted',[]), label('default_label')]}});
                if (pending !== undefined) {
                    const id = pending;
                    pending = undefined;
                    setTimeout(() => send({id,result:{content:[{type:'text',text:'Catalog updated'}]}}), 50);
                }
            }
            break;
        case 'tools/call':
            if (m.params.name === 'switch_catalog') {
                switched = true;
                pending = m.id;
                send({method:'notifications/tools/list_changed'});
            } else send({id:m.id, error:{code:-32601,message:'Listing-only label'}});
            break;
        default:
            send({id:m.id, error:{code:-32601,message:'Unsupported'}});
    }
}
