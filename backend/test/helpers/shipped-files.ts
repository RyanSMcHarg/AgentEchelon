/**
 * The SHIPPED surface: the files a reader of this repository can actually get.
 *
 * The doc guards exist to keep what we PUBLISH honest. They scan `docs/`, and a gitignored file
 * sitting in `docs/` is not published - it is a private working file that happens to live there.
 * Scanning it produces findings nobody can act on and, worse, findings that are correct to leave
 * alone: a forensic note whose whole job is to quote a stale symbol ("`tierChannelScopedAllow` was
 * renamed") reads to a banned-phrase guard exactly like the drift it describes.
 *
 * This was not hypothetical. Moving the durable tracker into `docs/` so it would appear in an editor
 * broke three guards at once, all of them on the tracker's own record of drift it had already fixed.
 *
 * Authority is `git check-ignore`, not a hardcoded list of prefixes. A list would drift from
 * `.gitignore` the moment either changed, and the question being asked - "will a reader get this
 * file?" - is precisely the question git already answers.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

/**
 * Drop every path git ignores. Order is preserved and paths are returned unchanged.
 *
 * One subprocess for the whole set: `check-ignore --stdin` is linear and per-file invocation over a
 * few hundred docs is not worth the wall clock in a suite this size.
 */
export function excludeIgnored(paths: string[], repoRoot: string): string[] {
  if (paths.length === 0) return paths;

  // REPO-RELATIVE, POSIX-SEPARATED, and both halves are load-bearing on Windows. Handing
  // `check-ignore` an absolute `C:\...` path fails the whole batch with exit 128 ("Invalid path"),
  // which the catch below turns into "nothing is ignored" - so the filter silently did nothing and
  // the guards kept scanning private files. A fail-open is right here, but it hides a wiring bug
  // perfectly, so the input has to be in the form git accepts.
  const rel = paths.map((p) => path.relative(repoRoot, p).replace(/\\/g, '/'));

  let ignoredList = '';
  try {
    ignoredList = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: repoRoot,
      input: rel.join('\n'),
      encoding: 'utf8',
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    // Exit 1 means "nothing matched", which is a normal answer and not a failure. Any other status
    // (no git, not a repository) leaves the set untouched: a guard that cannot resolve this question
    // must scan MORE rather than less, or a broken environment would silently disable it.
    if (e.status === 1) ignoredList = e.stdout ?? '';
    else return paths;
  }

  const ignored = new Set(
    ignoredList.split(/\r?\n/).map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean),
  );
  if (ignored.size === 0) return paths;
  return paths.filter((_p, i) => !ignored.has(rel[i]));
}
