// A global cap on how often each upstream host is read, whatever the number of clients or of
// Cloudflare locations: one Durable Object per upstream host counts the fetches that missed the edge
// cache in the current minute, and refuses past the cap or past one client's share of it. It holds
// this minute's counters in memory (per client address or IPv6 /64) and nothing on disk.

import { DurableObject } from 'cloudflare:workers';
import { gateTake, type GateAnswer, type GateState } from './limits.ts';

export class UpstreamGate extends DurableObject {
    #state: GateState = { minute: 0, count: 0, per: new Map() };

    async take(cap: number, perClient: number, client: string, now: number): Promise<GateAnswer> {
        return gateTake(this.#state, cap, perClient, client, now);
    }
}
