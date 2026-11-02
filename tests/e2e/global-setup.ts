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
import { getTestCredentials, type TestUser } from './helpers/test-credentials';
import { ensureOnboarded, profileTable } from './helpers/profile-store';

export default async function globalSetup(): Promise<void> {
  if (!process.env.E2E_BASE_URL) return; // not a live run
  try {
    profileTable();
  } catch {
    return; // no profile store on this deployment
  }

  // Every distinct demo user in the test-credentials secret. Any of them may create a standard-tier
  // conversation, which triggers the standard onboarding intake for its creator.
  let users: TestUser[] = [];
  try {
    const creds = await getTestCredentials();
    const seen = new Set<string>();
    users = [creds.basicUser, creds.standardUser, creds.premiumUser, creds.testAdmin]
      .filter((u): u is TestUser => !!u?.email && !seen.has(u.email) && !!seen.add(u.email));
  } catch {
    return;
  }

  // The row is keyed by the person id the exchange minted, and `if_not_exists` keeps a real
  // onboardedAt (and facts) intact if the user already onboarded.
  for (const user of users) {
    if (await ensureOnboarded(user.email)) console.log(`[global-setup] ensured ${user.email} is onboarded`);
    else console.warn(`[global-setup] could not pre-onboard ${user.email} (continuing)`);
  }
}
