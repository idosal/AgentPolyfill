/// <reference path="../../../events/copilot/src/sdk.d.ts" />
import { joinSession } from '@github/copilot-sdk/extension';
import { start, type Join } from './main.ts';

const runtime = await start(joinSession as unknown as Join);
const stop = () => void runtime.stop().finally(() => process.exit(0));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('SIGHUP', stop);
