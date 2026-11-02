/**
 * A request bound for the AWS clients on an assistant turn's path.
 *
 * THE PROBLEM THIS SOLVES. An AWS SDK v3 client sets no request timeout by default, so one stalled
 * socket waits for as long as the Lambda lives. Measured live 2026-10-05: a premium router turn
 * logged `[Router] Resolved`, then nothing, then `Task timed out after 30.00 seconds`; the person got
 * no reply and nothing named the call that hung. Tenet D5 asks the opposite: a failing dependency
 * degrades to a helpful response instead of failing silently.
 *
 * WHAT IT DOES. A request that has not connected in 2 s, or not completed in 5 s, fails with a
 * `TimeoutError`. The SDK's standard retry strategy treats `TimeoutError` as transient, so a stalled
 * socket is retried on a fresh one rather than consuming the turn, and a dependency that is really
 * down surfaces as an error the caller's existing handling sees, with a stack naming the call site.
 * Worst case for one call is three attempts plus backoff, well inside the router's 30 s.
 *
 * `throwOnRequestTimeout` is required, not decoration: without it `@smithy/node-http-handler` only
 * logs a warning when `requestTimeout` is exceeded and keeps waiting.
 *
 * WHERE IT APPLIES. Clients for services that answer in well under a second: DynamoDB, SSM, the
 * Amazon Chime SDK, Cognito, S3, and the router's asynchronous (`Event`) Lambda invokes. NOT model
 * calls (Bedrock streams for tens of seconds) and NOT synchronous Lambda invokes (the data plane
 * resuming Aurora legitimately takes longer than 5 s); those carry their own bounds where they have
 * one.
 */
export const BOUNDED_REQUEST_HANDLER = {
  connectionTimeout: 2_000,
  requestTimeout: 5_000,
  throwOnRequestTimeout: true,
} as const;
