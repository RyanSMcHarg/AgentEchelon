/**
 * Playwright global setup — runs once before the suite.
 *
 * Pre-onboards EVERY demo user so the standard-tier direct-answer specs (agent-intents, tier-context,
 * tasks, ...) are order-independent. Onboarding is once-per-user
 * (SPEC-USER-PROFILE-AND-ONBOARDING) and is keyed to the CHANNEL's classification (standard), but it
 * fires for whoever CREATED the channel. Different specs create standard-tier conversations signed in as
 * different demo users (e.g. tasks/agent-intents drive several tiers from one signed-in user), so every
 * demo user that might create a standard conversation must already be onboarded, or its first such
 * conversation opens with the intake and hijacks the turn. Marking them onboarded here mirrors the real
 * steady state (returning users who onboarded long ago).
 *
 * The onboarding-intake spec RESETS its own user in beforeAll and re-onboards them, so it still exercises
 * the full intake happy path; that reset/re-onboard is atomic within that spec file (workers:1, one spec
 * at a time), so no other spec observes the un-onboarded window.
 *
 * Best-effort: skips silently when the AWS wiring is absent (no profile store, no creds), so a purely
 * local run or a deployment without onboarding is unaffected.
 */
import { execFileSync } from 'child_process';
import { getTestCredentials } from './helpers/test-credentials';

const AWS_PROFILE = process.env.AWS_PROFILE || 'default';
const REGION = process.env.AWS_REGION || 'us-east-1';
const USER_POOL_ID = process.env.VITE_USER_POOL_ID || '';

function aws(args: string[]): string {
  return execFileSync('aws', [...args, '--region', REGION, '--profile', AWS_PROFILE], {
    encoding: 'utf8',
    timeout: 20000,
  }).trim();
}

/** Resolve a user's Cognito sub by email (username). Returns '' on any failure. */
function subForEmail(email: string): string {
  try {
    const sub = aws([
      'cognito-idp', 'admin-get-user', '--user-pool-id', USER_POOL_ID, '--username', email,
      '--query', "UserAttributes[?Name=='sub'].Value | [0]", '--output', 'text',
    ]);
    return sub && sub !== 'None' ? sub : '';
  } catch {
    return '';
  }
}

export default async function globalSetup(): Promise<void> {
  if (!process.env.E2E_BASE_URL || !USER_POOL_ID) return; // not a live run
  let table = '';
  try {
    table = aws([
      'ssm', 'get-parameter', '--name', '/agent-echelon/shared/tables/user-profile-name',
      '--query', 'Parameter.Value', '--output', 'text',
    ]);
  } catch {
    return; // no profile store on this deployment
  }
  if (!table || table === 'None') return;

  // Every distinct demo user in the test-credentials secret. Any of them may create a standard-tier
  // conversation, which triggers the standard onboarding intake for its creator.
  let emails: string[] = [];
  try {
    const creds = await getTestCredentials();
    emails = [...new Set([
      creds.basicUser?.email, creds.standardUser?.email, creds.premiumUser?.email, creds.testAdmin?.email,
    ].filter(Boolean) as string[])];
  } catch {
    return;
  }

  const now = new Date().toISOString();
  for (const email of emails) {
    const sub = subForEmail(email);
    if (!sub) continue;
    try {
      // if_not_exists keeps a real onboardedAt (and facts) intact if the user already onboarded.
      aws([
        'dynamodb', 'update-item', '--table-name', table,
        '--key', JSON.stringify({ userSub: { S: sub } }),
        '--update-expression', 'SET onboardedAt = if_not_exists(onboardedAt, :now), updatedAt = :now',
        '--expression-attribute-values', JSON.stringify({ ':now': { S: now } }),
      ]);
      console.log(`[global-setup] ensured ${email} (${sub}) is onboarded in ${table}`);
    } catch (err) {
      console.warn(`[global-setup] could not pre-onboard ${email} (continuing):`, (err as Error).message);
    }
  }
}
