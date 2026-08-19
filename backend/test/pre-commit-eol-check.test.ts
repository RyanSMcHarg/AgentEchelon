/**
 * The pre-commit hook has to look at the files people EDIT.
 *
 * `.githooks/pre-commit` blocks two things: a staged secret, and a file whose line endings are half
 * CRLF and half LF. Both checks were fed a `git diff --cached --diff-filter=ACR` list, which selects
 * added, copied and renamed paths and EXCLUDES modified ones. Every defect either check exists to
 * catch arrives by editing: a CRLF file that a generator or an editor appended LF lines to, and a
 * secret file that was already tracked. So both checks skipped the one category that matters, and a
 * check that cannot fail is indistinguishable from one that passes.
 *
 * The hook is bash, run by git, and there is no harness in this repo that executes it. What can be
 * pinned is the property the finding was about: the paths it inspects include modifications and
 * exclude deletions (a file deleted in this commit has nothing to read). Asserted over EVERY
 * `--diff-filter` in the file so a future edit cannot reintroduce the gap in one of them.
 */
import * as fs from 'fs';
import * as path from 'path';

const HOOK = path.resolve(__dirname, '..', '..', '.githooks', 'pre-commit');

describe('pre-commit hook file selection', () => {
  const source = fs.readFileSync(HOOK, 'utf8');
  const filters = [...source.matchAll(/--diff-filter=([A-Za-z]+)/g)].map((m) => m[1]);

  it('selects staged files with an explicit diff filter (more than one check reads one)', () => {
    expect(filters.length).toBeGreaterThanOrEqual(2);
  });

  it('includes MODIFIED files in every staged-file selection', () => {
    const withoutM = filters.filter((f) => !f.includes('M'));
    expect(withoutM).toEqual([]);
  });

  it('excludes DELETED files, which have nothing left to inspect', () => {
    const withD = filters.filter((f) => f.includes('D'));
    expect(withD).toEqual([]);
  });

  it('asks git which staged files are binary rather than reading them blind', () => {
    // `--numstat` reports "-" for both counts on a binary blob. Without that the CR/LF counting
    // would run over image and font bytes and report a coin-flip verdict.
    expect(source).toMatch(/--numstat/);
  });
});
