// Copilot provides this module to every extension it starts; only what src/main.ts uses is typed here.
declare module '@microsoft/copilot-sdk/extension' {
    export function joinSession(config?: unknown): Promise<unknown>;
}
