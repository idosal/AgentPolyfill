// Moved to ../core (polyfills/events/core), which the Codex form of this polyfill shares. Bundled into mod/dist/helper.js.
import { configureHost } from '../../core/src/host.ts';
import { VERSION } from './version.ts';

export * from '../../core/src/events-client.ts';

// The client names itself to every server as this mod, at this mod's version.
configureHost({ client: { name: 'mcp-events-plugin', version: VERSION } });
