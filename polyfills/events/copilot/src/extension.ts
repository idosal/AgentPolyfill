// The entry Copilot starts. `@microsoft/copilot-sdk/extension` is provided by Copilot itself (it
// resolves the module for every extension), so it is left out of the bundle.

import { joinSession } from '@microsoft/copilot-sdk/extension';
import { start, type JoinSession } from './main.ts';

const running = await start(joinSession as unknown as JoinSession);
const end = () => void running.stop().then(() => process.exit(0));
process.on('SIGTERM', end);
process.on('SIGINT', end);
process.on('SIGHUP', end);
