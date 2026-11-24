const FAKE = new URL('./extension.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
    if (specifier === '@microsoft/copilot-sdk/extension') return { url: FAKE, shortCircuit: true };
    return next(specifier, context);
}
