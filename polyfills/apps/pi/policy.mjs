// Each declaration must be a single CSP host source. Keep paths and port
// restrictions intact when copying an accepted source to the response header.
const hostSource = /^(?:(?:https?|wss?):\/\/)?(?:\*\.)?(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:]+\])(?::(?:[0-9]+|\*))?(?:\/[a-z0-9._~!$&()*+,=:@%/-]*)?$/i;
export function piDomainSources(declared) {
    const result = {};
    for (const key of ['connectDomains','resourceDomains','frameDomains','baseUriDomains']) {
        if (Array.isArray(declared?.[key])) {
            result[key] = declared[key].filter(source => typeof source === 'string' &&
                !/\s/u.test(source) && hostSource.test(source));
        }
    }
    return result;
}

// The stable MCP Apps host default also applies when all requested destinations
// are filtered out. Declared destinations only expand their own directives.
export function piContentSecurityPolicy(csp) {
    const sources = (values, fallback) => values?.length ? values.join(' ') : fallback;
    const assets = csp.resourceDomains?.length ? ' ' + csp.resourceDomains.join(' ') : '';
    return [
        "default-src 'none'",
        "script-src 'self' 'unsafe-inline'" + assets,
        "style-src 'self' 'unsafe-inline'" + assets,
        "img-src 'self' data:" + assets,
        "media-src 'self' data:" + assets,
        "connect-src " + sources(csp.connectDomains, "'none'"),
        ...(assets ? ["font-src 'self'" + assets] : []),
        "frame-src " + sources(csp.frameDomains, "'none'"),
        "base-uri " + sources(csp.baseUriDomains, "'self'"),
        "object-src 'none'",
        "form-action 'none'",
    ].join('; ');
}

export function reviewMessage(server, tool, csp) {
    const destinations = [...new Set(Object.values(csp).flat())].sort();
    const quoted = value => JSON.stringify(value);
    const lines = [
        'Share the original input and result of ' + quoted(tool) + ' with its app?',
        'The app can list and read resources from ' + quoted(server) + '.',
        destinations.length ? 'External destinations: ' + destinations.map(quoted).join(', ') : 'External destinations: none.',
    ];
    const message = lines.join('\n');
    if (message.length > 3000 || /[\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(message)) {
        throw new Error('Pi cannot display the complete access request for this app.');
    }
    return message;
}
