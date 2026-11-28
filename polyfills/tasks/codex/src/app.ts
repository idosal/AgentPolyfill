// Codex supplies the session and turn metadata that determines whether a wake is visible.
import { TaskApp } from '../../core/src/app.ts';
import type { CallContext } from '../../core/src/host.ts';
import { isThePersons, shownBy } from './meta.ts';

export * from '../../core/src/app.ts';

export class App extends TaskApp {
    override call(name: string, args: Record<string, unknown>, ctx: CallContext, thread: string | undefined) {
        if (thread && this.active && this.tools().some((tool) => tool.name === name)) {
            const shown = shownBy(ctx.meta);
            this.noteTurn(thread, { visible: shown === undefined ? undefined : shown === 'codex', userStarted: isThePersons(ctx.meta) });
        }
        return super.call(name, args, ctx, thread);
    }
}
