const FAKE = new URL('./extension.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
    // Only the name VS Code's Copilot harness resolves too: an import by any other name fails here, as it would there.
    if (specifier === '@github/copilot-sdk/extension') return { url: FAKE, shortCircuit: true };
    return next(specifier, context);
}
