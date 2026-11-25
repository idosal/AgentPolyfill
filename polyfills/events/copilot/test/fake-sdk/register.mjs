// Loaded with `node --import`: points `@github/copilot-sdk/extension`, which Copilot provides to
// every extension it starts, at the stand-in next to this file.
import { register } from 'node:module';
register(new URL('./hooks.mjs', import.meta.url));
