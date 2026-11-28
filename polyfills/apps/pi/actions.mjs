import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Use a platform launcher with an argument vector. The reviewed URL is the
// exact absolute URL passed to it. Report a launch error back to the view.
export async function openBrowser(url) {
    const [command, args] = process.platform === 'darwin' ? ['open', [url]] :
        process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
    await exec(command, args, {timeout:15000, cwd:process.platform === 'win32' ? undefined : '/'});
}

export function reviewText(value) {
    if (typeof value !== 'string' || value.length > 8000 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(value)) {
        throw Error('Pi cannot show this request in full.');
    }
    return value;
}

export function hostActions({confirm, send, setContext, display, copy, inspectImage, launch = openBrowser}) {
    // Do not stack independent native confirmation dialogs on top of one another.
    let reviewing = false;
    async function approve(title, text) {
        if (reviewing) throw Error('Another app request is waiting for review.');
        reviewing = true;
        try { return await confirm(title, reviewText(text)); }
        finally { reviewing = false; }
    }
    async function request(method, params) {
        switch (method) {
            case 'ui/request-display-mode': return {mode:await display(params.mode)};
            case 'ui/open-link': {
                const raw = reviewText(params.url);
                const url = new URL(raw);
                if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
                    !await approve('Open link in your browser?', url.href)) throw Error('Link declined.');
                await launch(url.href);
                return {};
            }
            case 'ui/message':
            case 'ui/update-model-context': {
                const message = method === 'ui/message';
                const blocks = params.content ?? [];
                if ((message && params.role !== 'user') || !Array.isArray(blocks)) throw Error('Unsupported Pi message.');
                const content = [], labels = [];
                for (const block of blocks) {
                    if (block?.type === 'text') {
                        const text = reviewText(block.text);
                        content.push({type:'text',text});
                        labels.push(text);
                    } else if (block?.type === 'image' && inspectImage && Array.isArray(block.cells)) {
                        if (reviewing) throw Error('Another app request is waiting for review.');
                        reviewing = true;
                        try { if (!await inspectImage(block)) throw Error('Image declined.'); }
                        finally { reviewing = false; }
                        content.push({type:'image',data:block.data,mimeType:'image/png'});
                        labels.push('[Reviewed image]');
                    } else throw Error('Pi cannot review this content type.');
                }
                if (!message && params.structuredContent !== undefined) {
                    const text = reviewText(JSON.stringify(params.structuredContent));
                    content.push({type:'text',text});
                    labels.push(text);
                }
                const text = labels.join('\n');
                if (message && !text.trim()) throw Error('The app message is empty.');
                if (!await approve(message ? 'Send this message to Pi?' : 'Use this app context in future turns?', text || 'Clear previous app context')) {
                    throw Error('App request declined.');
                }
                const value = content.some(b => b.type === 'image') ? content : text;
                if (message) send(value); else setContext(value);
                return {};
            }
            case 'ui/copy':
                if (!await approve('Copy app text to your clipboard?', params.text)) throw Error('Copy declined.');
                await copy(params.text);
                return {};
            case 'ui/allow-download':
                return {allow:await approve('Save to your Downloads folder?', params.files.map(f => f.name + ' (' + f.size + ' bytes)').join('\n'))};
            default: throw Error('Unsupported Pi host request.');
        }
    }
    return {request, approve};
}
