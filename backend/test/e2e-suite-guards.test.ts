/**
 * Every e2e spec must install the guards that watch what its assertions cannot.
 *
 * WHY A LINT AND NOT A CONVENTION. An e2e test asserts what the user SEES, which leaves two blind
 * spots, and both have hidden real defects here. The classification handler was denied
 * `ssm:GetParameter` on its own `processor-arn` on EVERY request for an unknown period - it logged an
 * AccessDenied each time, and 1700+ unit tests plus the whole e2e suite stayed green, because the code
 * fell back and the UI still looked right. Separately, a coverage sweep found only 6 of 25 specs
 * watching the browser console, so a React error on sign-in, battle or the admin dashboard was
 * invisible.
 *
 * `guardBackendErrors` and `guardConsoleErrors` close both, with one call at the top of a spec. But a
 * guard that a new spec can forget to install is a guard most new specs will forget to install - which
 * is exactly the history above, repeating. So the installation is checked here, where a spec that
 * omits it fails the build in Tier 0 with no AWS account and no deployed stack.
 *
 * This is a source-text lint. It proves the call is PRESENT, not that the guard caught anything - the
 * guards' own correctness is their concern, and a spec can still assert nothing useful. Floor, again.
 */
import * as fs from 'fs';
import * as path from 'path';
import { listE2eSpecs, E2E_DIR } from '../lib/docs/spec-coverage';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const e2eSpecs = listE2eSpecs(REPO_ROOT);

function read(spec: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'tests', spec), 'utf8');
}

/**
 * Does this spec drive a browser at all?
 *
 * Keyed on the Playwright fixture rather than on the filename: a spec that destructures `{ page }` in
 * any test is running a browser, and only those can have a console to watch. `context-source-alarm`
 * drives CloudWatch and SNS with no page, so requiring a console guard there would be noise - and
 * noise in a lint gets suppressed, which is how the lint stops working.
 */
function drivesBrowser(src: string): boolean {
  return /\{\s*page\s*[,}]/.test(src) || /\bpage:\s*Page\b/.test(src);
}

describe('e2e guard installation', () => {
  it('finds the e2e suite (guards against a silently empty scan)', () => {
    expect(e2eSpecs.length).toBeGreaterThan(10);
  });

  it('every spec installs the backend-error guard', () => {
    // Every spec, browser-driving or not: the backend guard reads CloudWatch, so it applies equally to
    // a spec that drives the platform through an API.
    const missing = e2eSpecs.filter((f) => !/guardBackendErrors\s*\(/.test(read(f)));
    expect(missing).toEqual([]);
  });

  it('every browser-driving spec installs the console guard', () => {
    const missing = e2eSpecs.filter((f) => {
      const src = read(f);
      return drivesBrowser(src) && !/guardConsoleErrors\s*\(/.test(src);
    });
    expect(missing).toEqual([]);
  });

  it('the backend guard is given a label, so a CI failure names the suite', () => {
    // `guardBackendErrors()` with no argument compiles and runs, and reports a failure attributed to
    // "undefined" - readable in one terminal, useless in a CI log across 25 files.
    const unlabelled = e2eSpecs.filter((f) => /guardBackendErrors\s*\(\s*\)/.test(read(f)));
    expect(unlabelled).toEqual([]);
  });

  it('no spec widens the console guard globally instead of scoping an expected error', () => {
    // A negative-path test legitimately produces console errors. The scoped answer is
    // `allowConsoleError(...)` inside that test. Editing the monitor's shared ignore list from a spec
    // would blind every OTHER spec to real failed requests - which is how the monitor came to be
    // hiding genuine React defects before.
    const offenders = e2eSpecs.filter((f) => /IGNORE|ignorePatterns|addIgnore/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  // Falsification: the detectors must be able to say "no". Without this, a regex that matched nothing
  // (or everything) would produce an empty `missing` list and read as a clean suite.
  describe('the detectors actually discriminate', () => {
    it('recognises a browser-driving spec and a non-browser one', () => {
      const browserish = e2eSpecs.filter((f) => drivesBrowser(read(f)));
      expect(browserish.length).toBeGreaterThan(15);
      // context-source-alarm drives CloudWatch/SNS directly and opens no page.
      expect(browserish).not.toContain('e2e/context-source-alarm.spec.ts');
    });

    it('would flag a spec that omits the guard', () => {
      const fake = 'test("x", async ({ page }) => {});';
      expect(/guardConsoleErrors\s*\(/.test(fake)).toBe(false);
      expect(drivesBrowser(fake)).toBe(true);
    });
  });

  it('scans the directory the suite actually lives in', () => {
    // If E2E_DIR ever moves, every assertion above would pass over an empty list.
    expect(fs.existsSync(path.join(REPO_ROOT, E2E_DIR))).toBe(true);
  });
});
