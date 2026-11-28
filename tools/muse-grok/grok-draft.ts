import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

function endpoint(value: string) {
    const u = new URL(value);
    if (
        u.protocol !== 'https:' ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) ||
        /(?:^|\.)(?:localhost|local|internal)$/.test(u.hostname) ||
        isIP(u.hostname) ||
        !/^\/[A-Za-z0-9._~/-]*$/.test(u.pathname)
    ) {
        throw Error('Draft setup requires an HTTPS hostname and a plain path without credentials or URL parameters.');
    }
    return u.href;
}

export function installDraft(bot: string, message: string) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bot))
        throw Error('Supply the UUID of the Bot that should receive the draft.');
    const text =
        'Set up this account-wide MCP connector. ' + message + ' Stop after setup and report whether it connected.';
    if (text.length > 1000) throw Error('This setup exceeds the Grok draft length limit. Use the form.');
    const link = new URL('grokbot://app/v1/prompt');
    link.searchParams.set('id', bot);
    link.searchParams.set('text', text);
    return { text, link: link.href.replaceAll('+', '%20') };
}

export function cardDraft(
    bot: string,
    connector: { url: string; headers: unknown[]; urlSecrets: string[] },
    oauth: { kind: string },
) {
    if (connector.headers.length || connector.urlSecrets.length || oauth.kind !== 'none') {
        throw Error('Use the connector form for sign-in or headers. Drafts contain only credential-free endpoints.');
    }
    return installDraft(bot, 'Use Remote HTTPS at ' + endpoint(connector.url) + '.');
}

export function taskDraft(bot: string, node: string, module: string, publisher: string, tool: string) {
    if (
        ![node, module].every(
            (v) =>
                /^\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(v) &&
                !v.split('/').some((s) => s === '.' || s === '..'),
        ) ||
        !node.endsWith('/node') ||
        !module.endsWith('/polyfills/tasks/muse/plugin/dist/server.mjs')
    ) {
        throw Error('Use absolute paths to Node and the extracted kit’s Tasks module on the Bot computer.');
    }
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(tool)) throw Error('Supply one reviewed publisher tool name.');
    return installDraft(
        bot,
        'Use Command with the already-staged Node executable ' +
            node +
            ' and these five separate arguments: ' +
            JSON.stringify([module, '--publisher', endpoint(publisher), '--allow-tool', tool]) +
            '.',
    );
}

if (
    import.meta.url.endsWith('/grok-draft.ts') &&
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    try {
        const [mode, ...args] = process.argv.slice(2);
        if (mode !== 'tasks' || args.length !== 5)
            throw Error(
                'Usage: node grok-draft.ts tasks BOT_UUID NODE_PATH MODULE_PATH PUBLISHER_HTTPS_URL ALLOWED_TOOL',
            );
        const { text, link } = taskDraft(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!);
        console.log(text + '\n\nOpen the draft, review it, then choose Send in Grok.\n' + link);
    } catch (e) {
        console.error(e instanceof Error ? e.message : 'Could not prepare draft.');
        process.exitCode = 1;
    }
}
