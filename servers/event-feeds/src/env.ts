import type { ButtonChannel } from './button-do.ts';
import type { UpstreamGate } from './gate-do.ts';

export type Env = {
    CHANNELS: DurableObjectNamespace<ButtonChannel>;
    GATES: DurableObjectNamespace<UpstreamGate>;
    RL_CLIENT: RateLimit;
    RL_PRESS: RateLimit;
    RL_PAGE: RateLimit;
    CHANNEL_SECRET: string;
    SOURCE_URL: string;
};
