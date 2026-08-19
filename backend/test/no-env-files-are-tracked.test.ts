/**
 * NO ENVIRONMENT FILE IS TRACKED, and the ignore rules that keep it that way actually cover the
 * names people use.
 *
 * The remote is PUBLIC, so a committed `.env` is not a defect that gets fixed by deleting it: the
 * value is disclosed the moment it is pushed, and it stays reachable in history afterwards. That
 * asymmetry is why this is a test and not a convention.
 *
 * WHY A TEST WHEN A HOOK ALREADY EXISTS. `.githooks/pre-commit` blocks these paths, but a hook only
 * runs where `core.hooksPath` has been pointed at `.githooks`. That is per-clone configuration: a
 * fresh clone, a second machine, or a contributor who never ran the setup step has NO protection
 * from it. CI runs this suite unconditionally, so this is the layer that survives an unconfigured
 * clone. The repository already states the doctrine in `.claude/hooks/reuse-first.js`: a hook that
 * nudges plus a test that refuses is the pair, and either alone is not enough.
 *
 * WHAT THE NARROW VERSION MISSED. Before this guard, `.gitignore` listed `.env`, `.env.local` and
 * `.env.*.local`, and the hook's exact-path list named `.env` and `frontend/.env`. So
 * `.env.production` and `.env.development` were covered by NEITHER - and those are Vite's own
 * convention, which makes them the likeliest names for a file holding real deployment values. The
 * per-package files the deployment actually generates (`frontend/packages/{chat,admin}/.env`) were
 * ignored but absent from the hook's list, so a `git add -f` reached them.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Any `.env` spelling at any depth: `.env`, `.env.production`, `packages/chat/.env.local`. */
const ENV_FILE = /(^|\/)\.env($|\.)/;

/** The one spelling that is deliberately tracked. Placeholders only, and every deployment copies it. */
const ALLOWED = '.env.example';

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });

const trackedFiles = (): string[] =>
  git(['ls-files']).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

describe('no environment file is tracked', () => {
  it('finds the tracked set at all (the assertions below are not vacuous)', () => {
    // Without this, a git failure or an empty listing would make every negative assertion pass while
    // proving nothing - the exact shape of green that hides a broken guard.
    expect(trackedFiles().length).toBeGreaterThan(500);
  });

  it('tracks no .env file except the example templates', () => {
    const offenders = trackedFiles()
      .filter((f) => ENV_FILE.test(f))
      .filter((f) => path.basename(f) !== ALLOWED);

    expect(offenders).toEqual([]);
  });

  it('still tracks the example templates, so the allow-list is doing real work', () => {
    // If the ignore rule ever stops negating `.env.example`, these drop out of the tree and every
    // deployment loses the file it is told to copy. The allow-list above would then be excusing
    // nothing, and the test above would pass for the wrong reason.
    const examples = trackedFiles().filter((f) => path.basename(f) === ALLOWED);

    expect(examples.length).toBeGreaterThan(0);
  });

  describe('the ignore rules cover the names people actually use', () => {
    // Asserted through `git check-ignore` rather than by reading `.gitignore`, because the question
    // is what GIT decides, not what the file appears to say. Precedence across the root and nested
    // ignore files is exactly the part a hand-read gets wrong.
    const isIgnored = (candidate: string): boolean => {
      try {
        git(['check-ignore', '-q', '--no-index', candidate]);
        return true;
      } catch (err) {
        const e = err as { status?: number };
        // 1 is the normal "not ignored" answer. Anything else (no git, not a repository) is a broken
        // environment, and reporting it as "not ignored" would fail the suite for the wrong reason.
        if (e.status === 1) return false;
        throw err;
      }
    };

    it.each([
      '.env',
      '.env.local',
      '.env.production',
      '.env.development',
      'frontend/.env',
      'frontend/packages/chat/.env',
      'frontend/packages/chat/.env.production',
      'frontend/packages/admin/.env',
      'backend/.env',
    ])('ignores %s', (candidate) => {
      expect(isIgnored(candidate)).toBe(true);
    });

    it.each([
      '.env.example',
      'frontend/packages/chat/.env.example',
      'frontend/packages/admin/.env.example',
    ])('does NOT ignore %s', (candidate) => {
      expect(isIgnored(candidate)).toBe(false);
    });
  });
});
