// The entry Copilot starts. The SDK is provided by Copilot itself (it resolves the module for every
// extension), so it is left out of the bundle. It is imported as `@github/copilot-sdk/extension`:
// Copilot CLI resolves that name and `@microsoft/copilot-sdk/extension` alike (1.0.115), while the
// runtime VS Code's Copilot harness bundles (VS Code 1.147, its SDK 1.0.33-preview.0) resolves only
// `@github/copilot-sdk`. With the other name the extension fails to load there.

import { joinSession } from '@github/copilot-sdk/extension';
import { start, type JoinSession } from './main.ts';

const running = await start(joinSession as unknown as JoinSession);
const end = () => void running.stop().then(() => process.exit(0));
process.on('SIGTERM', end);
process.on('SIGINT', end);
process.on('SIGHUP', end);
