// Asking a rate limiter, in one place: the Worker and the mailboxes both do.
// Free of Workers-only APIs, so the tests can run it under Node.

/** `down`: the limit could not be checked, and this relay is set to refuse when that happens. */
export type Verdict = 'yes' | 'no' | 'down';

/** What a Workers rate-limit binding offers. */
export type Limiter = { limit: (o: { key: string }) => Promise<{ success: boolean }> };

/**
 * Whether a limit lets this request through.
 *
 * A relay behind an access key has no limits configured and needs none: `required` is false and a
 * missing limiter lets everything through. A relay anyone may use sets REQUIRE_LIMITS, and then a
 * limiter that is missing or cannot answer refuses the request: an open relay with its limits off
 * is free storage for whoever notices.
 */
export async function allowed(limit: Limiter | undefined, key: string, required: boolean): Promise<Verdict> {
    if (!limit) return required ? 'down' : 'yes';
    try {
        return (await limit.limit({ key })).success ? 'yes' : 'no';
    } catch {
        return required ? 'down' : 'yes';
    }
}

export const TOO_MANY = { status: 429, error: 'too many requests; try again in a minute', retryAfter: 60 } as const;
export const LIMITS_DOWN = { status: 503, error: 'this relay cannot check its limits right now; try again in a minute', retryAfter: 60 } as const;

/** The header a mailbox reads the sender's address from. The Worker sets it, whatever the request said. */
export const SENDER_HEADER = 'x-relay-sender';
