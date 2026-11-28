import { privateFile } from './private-file.ts';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { nextOccurrence } from '../../muse/src/poll.ts';
import { settings, sourceUrl } from '../../../../tools/muse-grok/runtime.ts';
import { deliverOnce, destination, receiptFor } from './deliver.ts';

async function main() {
    const cfg = settings({ sources: { publicFeed: 'https://event-feeds.idosalomon.workers.dev/mcp' } });
    const [source, event] = process.argv.slice(2);
    if (!source || !event || !process.argv.includes('--arm-once')) throw Error('Use SOURCE EVENT --arm-once and optionally --config FILE.');
    const endpoint = sourceUrl(cfg, source);
    const file = process.env.GROK_ROUTINE_FILE, state = process.env.GROK_RECEIPT_DIR;
    if (!file || !state || !isAbsolute(file) || !isAbsolute(state)) throw Error('Set absolute GROK_ROUTINE_FILE and GROK_RECEIPT_DIR paths.');
    const secret = JSON.parse(privateFile(file, { secret: true }));
    const url = destination(secret.url);
    if (existsSync(receiptFor(url, state))) throw Error('This routine has already consumed its one attempt.');
    const signal = AbortSignal.timeout(600000);
    const item = await nextOccurrence(endpoint, source, event, signal);
    signal.throwIfAborted();
    if (!item) throw Error('No new matching event arrived.');
    const status = await deliverOnce(url, secret.key, state);
    console.log('One attempt reserved. Routine returned HTTP ' + status + '. Check the Bot run before rearming.');
    if (status < 200 || status >= 300) process.exitCode = 1;
}
main().catch(err => {
    const known = ['Use a private receipt', 'Use SOURCE', 'Use the HTTPS', 'Set absolute', 'Restrict the', 'This routine has', 'Choose a configured', 'No new matching'];
    const reason = String(err?.message ?? '');
    console.error(known.some(prefix => reason.startsWith(prefix)) ? reason : 'Watch ended. Check the receipt and Bot history. No automatic retry.');
    process.exitCode = 1;
});
