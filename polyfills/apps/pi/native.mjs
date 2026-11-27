// Only trusted Pi extension code receives these closures. The web view never
// receives a connection, a transport configuration, or a credential.
import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';

export const bridgeKey = 'agentpolyfill.pi.apps.native.v2';
const results = new WeakMap();
const catalogs = new WeakMap();
const catalogListeners = new WeakMap();
const dispatch = new AsyncLocalStorage();

export function modelVisible(tool) {
    const v = tool._meta?.ui?.visibility;
    return v === undefined || (Array.isArray(v) && v.includes('model'));
}
function appVisible(tool) {
    const v = tool?._meta?.ui?.visibility;
    return tool && (v === undefined || (Array.isArray(v) && v.includes('app')));
}
export function resourceUri(tool) {
    return tool?._meta?.ui?.resourceUri ?? tool?._meta?.['ui/resourceUri'];
}
function definition(client, name) {
    return catalogs.get(client)?.find(tool => tool.name === name);
}
export const nativeBridge = {
    interactive: false,
    started: undefined,
    capabilities() {
        return this.interactive ? { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } : {};
    },
    catalog(client, tools) {
        catalogs.set(client, tools);
        for (const listener of catalogListeners.get(client) ?? []) listener();
        return tools.filter(modelVisible);
    },
    async call(owner, client, name, args, options) {
        const expected = dispatch.getStore();
        if (expected && (expected.client !== client || expected.owner !== owner || expected.name !== name || !isDeepStrictEqual(expected.args, args) ||
            !appVisible(definition(client, name)) || !isDeepStrictEqual(expected.record, definition(client, name)))) throw Error('The approved Pi tool or connection changed.');
        const tool = definition(client, name);
        const uri = resourceUri(tool);
        if (!this.interactive || (!expected && (typeof uri !== 'string' || !uri.startsWith('ui://')))) {
            return client.callTool(name, args, options);
        }
        // The callback runs inside Pi's native executor after its permission checks.
        // An early view gets the original call even if another invocation finishes first.
        const outcome = Promise.withResolvers();
        const state = {result:undefined};
        const receipt = bind({owner, client, name, tool, args, state, outcome:outcome.promise, nested:Boolean(expected)});
        if (!expected) {
            // Losing the early-view UI must not cancel an already authorized native call.
            try { this.started?.(receipt); } catch { /* A completed result can still be opened. */ }
        }
        try {
            const result = await client.callTool(name, args, options);
            state.result = result;
            outcome.resolve({result});
            const content = [...result.content];
            results.set(content, receipt);
            return { content, ...(result.isError === undefined ? {} : { isError: result.isError }) };
        } catch (error) {
            outcome.resolve({cancelled:options?.signal?.aborted ? 'The call was cancelled.' : 'The call did not complete.'});
            throw error;
        }
    },
    lookup(content) { return results.get(content); },
    take(content) {
        const receipt = results.get(content);
        results.delete(content);
        return receipt;
    }
};

function bind({owner, client, name, tool, args, state, outcome, nested}) {
    const current = () => !owner.closed && owner.client === client && client.connectionState === 'connected' &&
        resourceUri(definition(client, name)) === resourceUri(tool);
    function check() { if (!current()) throw Error('The original Pi MCP connection or app changed. Run the tool again.'); }
    function reviewed(target, record) {
        check();
        const config = owner.entry.config;
        const live = definition(client, target);
        if (!appVisible(live) || JSON.stringify(live) !== JSON.stringify(record) ||
            (Object.hasOwn(config.toolExposure ?? {}, target) ? config.toolExposure[target] : config.exposure) === 'hidden') {
            throw Error('Pi does not grant this app access to the requested tool.');
        }
    }
    return {
        server: owner.entry.name, name, args, get result() { return state.result; }, outcome, tool, current, nested,
        matchesConfig: (config, trusted) => (owner.entry.scope !== 'project' || trusted) && isDeepStrictEqual(owner.entry.config, config),
        hasResources: Boolean(client.serverCapabilities?.resources),
        hasPrompts: Boolean(client.serverCapabilities?.prompts),
        changes: Object.fromEntries(['tools','resources','prompts'].map(key => [key, Boolean(client.serverCapabilities?.[key]?.listChanged)])),
        subscribe(callback, revoke) {
            const toolsChanged = () => {
                if (!current()) revoke();
                else if (client.serverCapabilities?.tools?.listChanged) callback('tools');
            };
            const listeners = catalogListeners.get(client) ?? new Set();
            catalogListeners.set(client, listeners);
            listeners.add(toolsChanged);
            const remove = ['resources','prompts'].filter(key => client.serverCapabilities?.[key]?.listChanged)
                .map(key => client.onNotification('notifications/' + key + '/list_changed', () => { if (current()) callback(key); }));
            remove.push(client.onClose(revoke), () => listeners.delete(toolsChanged));
            return () => remove.forEach(stop => stop());
        },
        definition(target) { check(); return definition(client, target); },
        async resource(method, params, signal) {
            check();
            const options = { signal };
            if (method === 'prompts/list' && client.serverCapabilities?.prompts) return client.request(method, params, options);
            if (method === 'tools/list') return {tools:(catalogs.get(client) ?? []).filter(appVisible).filter(tool =>
                (owner.entry.config.toolExposure?.[tool.name] ?? owner.entry.config.exposure) !== 'hidden')};
            if (!client.serverCapabilities?.resources) throw Error('The original server has no resources capability.');
            if (method === 'resources/read') return client.readResource(params.uri, options);
            if (method === 'resources/list') return client.listResourcesPage(params.cursor, options);
            if (method === 'resources/templates/list') return client.listResourceTemplatesPage(params.cursor, options);
            throw Error('Unsupported Pi resource request.');
        },
        async toolCall(record, args, signal, runPiTool) {
            const target = record.name;
            reviewed(target, record);
            if (!modelVisible(record)) return client.callTool(target, args, {signal});
            if (!runPiTool) throw Error('Open the view with open_mcp_app to use Pi tool permissions.');
            return dispatch.run({owner, client, name:target, args, record}, () => runPiTool(target, args));
        }
    };
}
