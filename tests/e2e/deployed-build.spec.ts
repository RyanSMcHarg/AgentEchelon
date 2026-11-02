/**
 * Is the DEPLOYED app the one these tests were written against?
 *
 * Every browser spec here runs against a deployed origin, and nothing used to establish that the
 * deployed bundle matched the source in the working tree. On 2026-08-07 it did not: the chat app on
 * the dev deployment predated `6a55eb6`, which had replaced a header control, so `mentions.spec.ts`
 * asserted a class the live bundle did not contain. Updating the spec to match SOURCE made it fail
 * harder, because source and deployment disagreed. Establishing that took hand-diffing class names
 * out of the served JavaScript.
 *
 * This turns that into one assertion that names the cause. It is deliberately a WARNING for an
 * unknown stamp and a FAILURE only for a definite mismatch, because "cannot tell" and "wrong build"
 * deserve different answers - the first is a bundle built outside a git checkout, the second is a
 * deployment that is genuinely behind.
 */
import { test, expect } from './helpers/fixtures';
import { execSync } from 'child_process';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

// Installed like every other spec, and the suite guard enforces it. This one loads the app, so a
// console error here is a real signal about the deployed bundle — which is precisely what the spec is
// about.
guardConsoleErrors();

const BASE_URL = process.env.E2E_BASE_URL || '';

/**
 * THE REPO ROOT, BECAUSE A PATHSPEC IS RESOLVED AGAINST THE CURRENT DIRECTORY AND PLAYWRIGHT RUNS IN
 * `tests/` (2026-10-02).
 *
 * `git diff ... -- frontend/packages/chat` from `tests/` asks about `tests/frontend/packages/chat`,
 * which does not exist, so git returned NOTHING and the assertion below held for a deployment that
 * was genuinely behind. This guard exists to catch exactly that, and it had become the thing it warns
 * about: measured on 2026-10-02 it passed while the deployed bundle was a commit behind on
 * `chimeService.ts` and `ConversationProvider.chime.tsx`.
 *
 * Every git call here is therefore anchored to the top level rather than to the caller's directory.
 */
function repoRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function headCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', cwd: repoRoot() || undefined }).trim();
  } catch {
    return '';
  }
}

/** The admin console's own origin. A DIFFERENT distribution from the chat app's. */
const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || '';

/**
 * ONE RULE, ASKED BY BOTH APPS.
 *
 * The chat and admin bundles are separate build and deploy targets, and each can be behind
 * independently - the chat app was published on 2026-10-02 while the console was not. Two copies of
 * the reasoning below would be two places for it to drift, and the half that drifted would be the one
 * nobody was looking at. `packages` is what differs: each app is compared against ITS OWN sources
 * plus `shared`, so a change to the chat client does not demand an admin republish and the reverse.
 */
async function assertDeployedMatchesSource(
  page: import('@playwright/test').Page,
  app: { label: string; origin: string; packages: string[]; publish: string },
): Promise<void> {
  await page.goto(app.origin);
  const deployed = await page.evaluate(
    () => (window as unknown as { __BUILT_FROM_COMMIT__?: string }).__BUILT_FROM_COMMIT__ || '',
  );
  const local = headCommit();

  // No stamp at all: an older bundle, or one built outside a checkout. Say so rather than failing —
  // a deployment that predates the stamp is exactly the case this is here to report.
  if (!deployed || deployed === 'unknown') {
    console.warn(
      `[deployed-build] the deployed ${app.label} bundle carries no build stamp, so it CANNOT be `
      + `compared to the source under test. Publish it (${app.publish}) to make this checkable.`,
    );
    test.skip(true, `deployed ${app.label} bundle carries no build stamp`);
  }
  if (!local) {
    test.skip(true, 'not a git checkout — no HEAD to compare against');
  }

  if (deployed === local) return;

  // DIFFERENT COMMITS ARE NOT AUTOMATICALLY WRONG, and this is the part that decides whether the
  // guard is usable day to day. A branch is ahead of its deployment constantly - every backend
  // commit puts it there - and failing on that would make the check noise everyone learns to
  // ignore, which is worse than no check.
  //
  // The question that actually matters is narrower: did THIS APP change between what is deployed and
  // what these tests were written against? If it did not, the deployed UI is the one under test
  // whatever the commit says.
  let changed: string[];
  try {
    changed = execSync(
      `git diff --name-only ${deployed}..${local} -- ${app.packages.join(' ')}`,
      // The pathspec resolves against the CURRENT directory and Playwright runs in `tests/`, so
      // without this it asked about `tests/frontend/...`, matched nothing, and passed for any
      // deployment at all. Measured on 2026-10-02: it held while the chat bundle was a commit behind.
      { encoding: 'utf8', cwd: repoRoot() || undefined },
    ).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    // The deployed commit is not in this checkout (another branch, a force-push, a shallow clone).
    // Cannot answer the question, so do not pretend to.
    console.warn(
      `[deployed-build] the deployed ${app.label} bundle names commit ${deployed.slice(0, 12)}, which `
      + 'is not in this checkout, so it cannot be compared. Treating as unknown.',
    );
    return;
  }

  expect(
    changed,
    `The deployed ${app.label} app was built from ${deployed.slice(0, 12)}; these tests run against `
    + `${local.slice(0, 12)}, and it CHANGED in between (${changed.length} file(s), e.g. `
    + `${changed.slice(0, 3).join(', ')}). Those changes are untested here, and a spec updated to `
    + 'match source will fail against the live app for reasons that have nothing to do with the '
    + `code under test. Publish it: ${app.publish}`,
  ).toEqual([]);
}

test.describe('the deployed build matches the source under test', () => {
  guardBackendErrors('deployed-build');

  test('the chat bundle was built from the commit these tests run against', async ({ page }) => {
    test.skip(!BASE_URL, 'no E2E_BASE_URL — nothing deployed to compare against');
    await assertDeployedMatchesSource(page, {
      label: 'chat',
      origin: BASE_URL,
      packages: ['frontend/packages/chat', 'frontend/packages/shared'],
      publish: 'node scripts/deploy-frontend.mjs',
    });
  });

  /**
   * THE CONSOLE, which until 2026-10-02 could not be checked at all.
   *
   * It matters more than the chat half rather than less: this is where the operator surfaces live -
   * profiles, effectiveness, experiments, conversations - so a console a commit behind shows an
   * operator the wrong behaviour while the backend answers correctly. The two apps deploy separately,
   * and on the day this was written the chat app had been published and the console had not.
   */
  test('the admin console was built from the commit these tests run against', async ({ page }) => {
    test.skip(!ADMIN_BASE_URL, 'no E2E_ADMIN_BASE_URL — the console origin is not known');
    await assertDeployedMatchesSource(page, {
      label: 'admin',
      origin: ADMIN_BASE_URL,
      packages: ['frontend/packages/admin', 'frontend/packages/shared'],
      publish: 'node scripts/deploy-frontend.mjs --admin',
    });
  });
});
