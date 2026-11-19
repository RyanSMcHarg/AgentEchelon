/**
 * THE ONE RULE FOR A FAILURE ANOTHER ATTEMPT MAY NOT MEET: a throttle, a timeout, a server error or a dropped connection.
 * A request that does not validate, a resource that is not there and an access denial answer the same way however often
 * they are asked, so they are never tried again. Every caller that tries a call again asks this rule, so a change to what
 * counts as passing reaches all of them.
 */

/** Whether a failure is one another attempt may not meet. */
export function isTransientReadError(err: unknown): boolean {
  const e = err as { name?: string; code?: string; $retryable?: unknown; $metadata?: { httpStatusCode?: number } } | undefined;
  if (e?.$retryable) return true;
  const status = e?.$metadata?.httpStatusCode;
  if (typeof status === 'number' && (status === 429 || status >= 500)) return true;
  return /Throttl|TooManyRequests|RequestLimitExceeded|Timeout|TimedOut|NetworkingError|ECONNRESET|InternalServerError|ServiceUnavailable|ServiceFailure|InternalFailure/i
    .test(`${e?.name ?? ''} ${e?.code ?? ''}`);
}

/** Attempts for a transient failure: the call and two more, after `delayMs` and twice that. */
export const TRANSIENT_ATTEMPTS = 3;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Run `call`, and again after a pause while it fails transiently (`isTransientReadError`), at most
 * {@link TRANSIENT_ATTEMPTS} times; any other failure, and `final` ones, throw at once.
 */
export async function readWithRetry<T>(
  call: () => Promise<T>, delayMs: number,
  opts: { pause?: (ms: number) => Promise<void>; final?: (err: unknown) => boolean } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (opts.final?.(err) || !isTransientReadError(err) || attempt >= TRANSIENT_ATTEMPTS) throw err;
      if (delayMs > 0) await (opts.pause ?? sleep)(delayMs * attempt);
    }
  }
}
