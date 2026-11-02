/**
 * TYPING A PASSWORD THAT NEVER REACHES A TRACE.
 *
 * A Playwright trace records a password three ways, and `locator.fill(password)` hits all of them:
 *
 *   1. The action itself. `Frame.fill` is titled `Fill "{value}"`, so the value is in the trace's
 *      action list and in the step title every step-aware reporter prints.
 *   2. The DOM snapshot. The snapshotter copies every `<input>`'s live value into the snapshot
 *      (`__playwright_value_`), `type="password"` included, so the next action's snapshot holds it.
 *   3. The network. With snapshots on, the trace keeps every request body, and the sign-in posts the
 *      password to Amazon Cognito (`USER_PASSWORD_AUTH`) in the clear.
 *
 * Pausing the trace around the sign-in covers only the first two: the network recorder runs for the
 * whole context and writes the request into the next chunk anyway. So the password never enters the
 * browser at all. `fillSecret` types a STAND-IN (random, made per run) into the field, and a context
 * route swaps the stand-in for the real value in the request body on its way to the identity provider.
 * The page, its snapshots and the recorded request hold only the stand-in; the trace records the
 * route's original request, not the override (`recordRequestOverrides: false` in Playwright's tracer).
 *
 * `trace-holds-no-password.spec.ts` produces a trace with each mechanism and reads it back, so a change
 * to this file, or a Playwright upgrade that starts recording overrides, fails there.
 */
import { randomBytes } from 'crypto';
import type { BrowserContext, Locator, Route } from '@playwright/test';

/** Where a browser sign-in sends a password: Amazon Cognito's API in any region. */
export const IDENTITY_PROVIDER_ENDPOINT = /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\//;

/** Per context: stand-in to real value, and real value to its stand-in. */
interface Swap { byStandIn: Map<string, string>; bySecret: Map<string, string> }
const swaps = new WeakMap<BrowserContext, Swap>();

/**
 * A stand-in that passes the sign-up form's own checks (upper, lower, digit, symbol, length), so a
 * form that validates a new password accepts it and still sends it.
 */
function newStandIn(): string {
  return `Ae1!unrecorded${randomBytes(12).toString('hex')}`;
}

/** The secret as it appears inside a JSON string, which is how every Cognito body carries it. */
function asJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

async function substitute(route: Route, swap: Swap): Promise<void> {
  const body = route.request().postData();
  if (!body) return route.fallback();
  let out = body;
  for (const [standIn, secret] of swap.byStandIn) {
    if (out.includes(standIn)) out = out.split(standIn).join(asJsonString(secret));
  }
  return out === body ? route.fallback() : route.fallback({ postData: out });
}

/**
 * Fill a password field without the password appearing in a trace, a snapshot, or a step title.
 *
 * `endpoint` is where the form posts the password; the default is Amazon Cognito, which every sign-in,
 * sign-up and password reset in the app calls. The first call on a context decides it.
 */
export async function fillSecret(
  field: Locator,
  secret: string,
  opts: { endpoint?: RegExp } = {},
): Promise<void> {
  const context = field.page().context();
  let swap = swaps.get(context);
  if (!swap) {
    const fresh: Swap = { byStandIn: new Map(), bySecret: new Map() };
    swaps.set(context, fresh);
    swap = fresh;
    await context.route(opts.endpoint ?? IDENTITY_PROVIDER_ENDPOINT, (route) => substitute(route, fresh));
  }
  let standIn = swap.bySecret.get(secret);
  if (!standIn) {
    standIn = newStandIn();
    swap.bySecret.set(secret, standIn);
    swap.byStandIn.set(standIn, secret);
  }
  await field.fill(standIn);
}
