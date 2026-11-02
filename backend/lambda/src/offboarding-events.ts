/**
 * OFFBOARDING BY EVENT: a person deleted at their issuer is erased by that event, not when someone
 * remembers to click delete (ADR-058). A disable is not an event here: the credential exchange asks the
 * issuer at every vend and refuses a disabled account (SPEC-CREDENTIAL-EXCHANGE §4b), so nothing on the
 * platform's side records it.
 *
 * Two inputs, one function:
 *  - a CloudTrail-recorded Cognito call (`COGNITO_LIFECYCLE_EVENTS`) for one of this deployment's pools,
 *    delivered by EventBridge from the platform trail (conversations-stack.ts, `PlatformTrail`);
 *  - the low-frequency schedule, which sweeps every pool as the backstop for a dropped event (tenet D6).
 *
 * The event says only that something changed. What to do is read from the pool's current state for the
 * subject (`convergeSubject`), which is what makes a replayed or out-of-order event converge. A record
 * that does not name its subject (a deleted account's sub cannot be read back from the pool, and Cognito
 * may hide the username) sweeps that one pool instead. A pool this deployment does not trust is ignored.
 *
 * THE CONSOLE ASKS THIS SAME FUNCTION. A delete, a re-admission or an export from the admin console
 * (`user-management.ts`, in the `AdminServices` stack) invokes it with a console request
 * (`lib/offboarding-console.ts`), so the console and the issuer's events run one code path on one role.
 */
import {
  convergeSubject,
  defaultOffboardingDeps,
  sweepPool,
  type Convergence,
  type OffboardingDeps,
} from './lib/offboarding.js';
import { COGNITO_LIFECYCLE_EVENTS } from './lib/issuer-lifecycle.js';
import type { CognitoPoolDirectory } from './lib/cognito-pool-directory.js';
import { consoleOffboarding, isConsoleOffboardingRequest, type ConsoleOffboardingAnswer, type ConsoleOffboardingRequest } from './lib/offboarding-console.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

export interface LifecycleEvent {
  source?: string;
  'detail-type'?: string;
  detail?: {
    eventName?: string;
    requestParameters?: { userPoolId?: string; username?: string } | null;
    additionalEventData?: { sub?: string } | null;
  };
}

export type LifecycleOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'converged'; result: Convergence }
  | { action: 'swept'; pools: number; result: Record<Convergence, number> };

const LIFECYCLE = new Set<string>(COGNITO_LIFECYCLE_EVENTS);

function poolsOf(deps: OffboardingDeps): CognitoPoolDirectory[] {
  return [deps.primary, ...(deps.others || [])].filter((p) => p.poolId);
}

function merge(a: Record<Convergence, number>, b: Record<Convergence, number>): Record<Convergence, number> {
  const out = { ...a };
  for (const k of Object.keys(b) as Convergence[]) out[k] = (out[k] || 0) + b[k];
  return out;
}

async function sweep(pools: CognitoPoolDirectory[], deps: OffboardingDeps): Promise<LifecycleOutcome> {
  let result: Record<Convergence, number> = { erased: 0, 'pool-account-removed': 0, unchanged: 0 };
  for (const pool of pools) result = merge(result, await sweepPool(pool, deps));
  return { action: 'swept', pools: pools.length, result };
}

/** A username Cognito chose not to record, so it names nobody. */
const HIDDEN = /^HIDDEN/;

export async function handleLifecycleEvent(event: LifecycleEvent, deps: OffboardingDeps = defaultOffboardingDeps()): Promise<LifecycleOutcome> {
  const pools = poolsOf(deps);
  if (event?.['detail-type'] === 'Scheduled Event') return sweep(pools, deps);

  const detail = event?.detail;
  if (!detail?.eventName || !LIFECYCLE.has(detail.eventName)) return { action: 'ignored', reason: 'not a lifecycle event' };
  const pool = pools.find((p) => p.poolId === detail.requestParameters?.userPoolId);
  if (!pool) return { action: 'ignored', reason: 'not one of this deployment\'s pools' };

  const actor = { arn: 'issuer-event' };
  let subject = typeof detail.additionalEventData?.sub === 'string' ? detail.additionalEventData.sub : '';
  if (!subject) {
    const username = detail.requestParameters?.username;
    if (username && !HIDDEN.test(username)) subject = (await pool.record(username))?.subject || '';
  }
  if (!subject) return sweep([pool], deps);
  return { action: 'converged', result: await convergeSubject(pool, subject, actor, deps) };
}

export async function handler(event: ConsoleOffboardingRequest): Promise<ConsoleOffboardingAnswer>;
export async function handler(event: LifecycleEvent): Promise<LifecycleOutcome>;
export async function handler(event: LifecycleEvent | ConsoleOffboardingRequest): Promise<LifecycleOutcome | ConsoleOffboardingAnswer> {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  if (isConsoleOffboardingRequest(event)) {
    const answer = await consoleOffboarding(event);
    // The request and its status only: never a subject, a username or an address.
    console.log('[OffboardingEvents]', JSON.stringify({ console: event.console, status: answer.status }));
    return answer;
  }
  const outcome = await handleLifecycleEvent(event);
  // Counts and the action only: never a subject, a username or an address.
  console.log('[OffboardingEvents]', JSON.stringify({ eventName: event?.detail?.eventName ?? event?.['detail-type'], ...outcome }));
  return outcome;
}
