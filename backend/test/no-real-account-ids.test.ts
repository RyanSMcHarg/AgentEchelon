/**
 * No real AWS account id, and no real deployment identifier, in a tracked file.
 *
 * This repo is public. An account id is not a credential, but it is an identifier an attacker does not
 * otherwise have, and it is enumerable: paired with a resource name it makes bucket and role guessing
 * cheap, and it ties this repo to a specific person's account. The same goes for a live app-instance
 * id, user-pool id, or CloudFront distribution.
 *
 * WHY A TEST AND NOT A CONVENTION. The convention already existed - `cdk-synth.test.ts` and every other
 * synthesis test use the reserved placeholder 123456789012 - and two files still ended up carrying a
 * real account id and a real app-instance id, one of them for months. A convention nothing checks is a
 * convention that decays at exactly the rate people copy-paste from a live console, which is what both
 * of those were: an ARN lifted from a real deployment to get a test's shape right.
 *
 * The fix in each case was not to delete the ARN but to make it honest: the unit test only needed the
 * string's LENGTH, so a placeholder serves; the e2e needed the ARN to match the deployment under test,
 * so it now resolves it from SSM at runtime and works on anybody's account rather than one.
 *
 * Scope: git-tracked files only. Untracked local config (deploy.config.json, .env) legitimately holds
 * real values and is gitignored for that reason - this asserts what would be PUBLISHED.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Reserved / documentation values that are SUPPOSED to appear. */
const ALLOWED_ACCOUNT_IDS = new Set([
  // AWS's reserved DOCUMENTATION account ids. These appear throughout the official docs and are the
  // values a reader is meant to copy, so flagging them would train people to ignore this guard - and a
  // guard people route around is worse than none.
  '123456789012', // the convention this repo already used
  '111122223333', '222233334444', '333344445555', '444455556666', '555566667777',
  '111111111111', '000000000000',
]);

/** Files whose 12-digit runs are numeric constants, not identifiers. */
const NUMERIC_CONSTANT_FILES = [
  // Inverse-normal-CDF coefficients: long decimal literals that contain 12-digit runs.
  'backend/lambda/src/lib/experiment-stats.ts',
];

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Text files worth scanning — skip binaries and lockfiles, which cannot carry a hand-copied ARN. */
function isScannable(rel: string): boolean {
  if (/\.(png|jpg|jpeg|gif|ico|webp|pdf|zip|woff2?|ttf|eot|mp4)$/i.test(rel)) return false;
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(rel)) return false;
  return true;
}

describe('no real AWS identifiers in tracked files', () => {
  const files = trackedFiles().filter(isScannable);

  it('finds tracked files to scan (the scan itself must not silently cover nothing)', () => {
    // A guard that scans an empty list passes forever. This is the guard's guard.
    expect(files.length).toBeGreaterThan(100);
  });

  it('contains no real 12-digit AWS account id', () => {
    const offenders: string[] = [];
    for (const rel of files) {
      if (NUMERIC_CONSTANT_FILES.includes(rel)) continue;
      let body: string;
      try {
        body = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      } catch {
        continue; // unreadable / not a text file
      }
      // An account id in context: inside an ARN, or an `account:`/`Account=` assignment. A bare
      // 12-digit run elsewhere is far more likely to be a timestamp or a coefficient.
      const re = /(?:arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:|account["' :=]+)(\d{12})/gi;
      for (const m of body.matchAll(re)) {
        const id = m[1];
        if (!ALLOWED_ACCOUNT_IDS.has(id)) {
          const line = body.slice(0, m.index).split('\n').length;
          offenders.push(`${rel}:${line} -> ${id}`);
        }
      }
    }
    if (offenders.length) {
      throw new Error(
        'A real AWS account id is about to be published. Use the reserved placeholder 123456789012, or '
        + 'resolve the value at runtime (the moderation e2e reads its app-instance ARN from SSM) so the '
        + 'test works on any deployment rather than the one it was copied from.\n  '
        + offenders.join('\n  '),
      );
    }
    expect(offenders).toEqual([]);
  });

  it('contains no live Cognito user-pool id', () => {
    // Shape: <region>_<9-16 alnum>. The pool id names a real, reachable identity provider.
    const offenders: string[] = [];
    for (const rel of files) {
      let body: string;
      try {
        body = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      } catch {
        continue;
      }
      for (const m of body.matchAll(/\b((?:us|eu|ap|sa|ca|me|af)-[a-z]+-\d_([A-Za-z0-9]{6,16}))\b/g)) {
        const suffix = m[2];
        // Match the SHAPE of a live pool id rather than blocklisting placeholder words. A real
        // Cognito suffix is exactly 9 characters mixing upper case, lower case and digits - no
        // example is given here, because writing one that matched would leak the very thing this
        // guards, and this test caught exactly that when the first draft used a live id to explain
        // itself;
        // hand-written stand-ins are prose - partnerpool, TestPoolId, EXAMPLE - and fail at least one
        // of those conditions. Shape-matching keeps the guard quiet on invented values without a
        // growing list of exceptions, and a list nobody trusts is a guard nobody reads.
        const looksLive = suffix.length === 9 && /[0-9]/.test(suffix) && /[A-Z]/.test(suffix) && /[a-z]/.test(suffix);
        if (!looksLive) continue;
        const line = body.slice(0, m.index).split('\n').length;
        offenders.push(`${rel}:${line} -> ${m[1]}`);
      }
    }
    if (offenders.length) {
      throw new Error(
        'A live Cognito user-pool id is about to be published. Use a placeholder such as '
        + 'us-east-1_EXAMPLE, or read it from the environment.\n  ' + offenders.join('\n  '),
      );
    }
    expect(offenders).toEqual([]);
  });
});
