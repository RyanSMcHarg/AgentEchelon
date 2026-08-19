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
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

// Installed like every other spec, and the suite guard enforces it. This one loads the app, so a
// console error here is a real signal about the deployed bundle — which is precisely what the spec is
// about.
guardConsoleErrors();

const BASE_URL = process.env.E2E_BASE_URL || '';

function headCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

test.describe('the deployed build matches the source under test', () => {
  guardBackendErrors('deployed-build');

  test('the chat bundle was built from the commit these tests run against', async ({ page }) => {
    test.skip(!BASE_URL, 'no E2E_BASE_URL — nothing deployed to compare against');

    await page.goto('/');
    const deployed = await page.evaluate(
      () => (window as unknown as { __BUILT_FROM_COMMIT__?: string }).__BUILT_FROM_COMMIT__ || '',
    );
    const local = headCommit();

    // No stamp at all: an older bundle, or one built outside a checkout. Say so rather than failing —
    // this guard is new, and a deployment that predates it is exactly the case it is here to report.
    if (!deployed || deployed === 'unknown') {
      console.warn(
        '[deployed-build] the deployed chat bundle carries no build stamp, so it CANNOT be compared '
        + 'to the source under test. Publish the chat app (node scripts/deploy-frontend.mjs) to make '
        + 'this checkable.',
      );
      test.skip(true, 'deployed bundle carries no build stamp');
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
    // The question that actually matters is narrower: did the FRONTEND change between what is
    // deployed and what these tests were written against? If it did not, the deployed UI is the one
    // under test whatever the commit says.
    let changed: string[];
    try {
      changed = execSync(
        `git diff --name-only ${deployed}..${local} -- frontend/packages/chat frontend/packages/shared`,
        { encoding: 'utf8' },
      ).split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      // The deployed commit is not in this checkout (another branch, a force-push, a shallow clone).
      // Cannot answer the question, so do not pretend to.
      console.warn(
        `[deployed-build] the deployed bundle names commit ${deployed.slice(0, 12)}, which is not in `
        + 'this checkout, so it cannot be compared. Treating as unknown.',
      );
      return;
    }

    expect(
      changed,
      `The deployed chat app was built from ${deployed.slice(0, 12)}; these tests run against `
      + `${local.slice(0, 12)}, and the frontend CHANGED in between (${changed.length} file(s), e.g. `
      + `${changed.slice(0, 3).join(', ')}). Those changes are untested here, and a spec updated to `
      + 'match source will fail against the live app for reasons that have nothing to do with the '
      + 'code under test. Publish the chat app: node scripts/deploy-frontend.mjs',
    ).toEqual([]);
  });
});
