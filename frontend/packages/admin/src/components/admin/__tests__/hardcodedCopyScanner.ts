/**
 * COUNT THE USER-FACING ENGLISH STILL HARDCODED IN THE ADMIN SOURCE.
 *
 * The console has 1,219 such strings across 43 files, against one fully localized component. A job
 * that size cannot land in one change, and nothing in this repo - no ESLint rule, no test, no CI step,
 * in either frontend package - currently stops a forty-fourth file being added. So the conversion is
 * held by a RATCHET rather than by a deadline: a per-file count that may fall and may not rise.
 *
 * ── WHY A HEURISTIC IS GOOD ENOUGH HERE, WHICH IS NOT USUALLY TRUE ───────────────────────────────
 *
 * Deciding "is this literal user-facing copy" properly needs a type-aware pass over JSX. This does
 * not attempt that, and it both over- and under-counts. It does not matter, and the reason is the
 * shape of the guard rather than charity about the scanner: the baseline stores the CURRENT OUTPUT of
 * this exact function per file, so a false positive is simply a number in the baseline, and what is
 * asserted is the DIRECTION of change. The only property the scanner must have is determinism.
 *
 * It is deliberately kept blunt for that reason.
 *
 * TWO KNOWN BLIND SPOTS, recorded because a count that is quoted as progress has to say what it cannot
 * see. The quoted-string patterns stop at 400 characters, so the LONGEST copy is invisible - which is why
 * `no-console-string-is-an-essay` exists as a separate guard. And every pattern excludes newlines, so a
 * wrapped JSX paragraph is never counted: 75 multi-line nodes were converted on 2026-10-01 and this
 * number moved by 3. Neither is a defect to tune away, because the baseline stores this function's exact
 * output and widening it would discard the record for 38 files - but neither may be forgotten either. A cleverer scanner that someone tunes later would
 * shift every count and invalidate the baseline, which is the one thing that would cost real work.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Source root scanned. Tests, fixtures and generated output are excluded by `shouldScan`. */
export const ADMIN_SRC = path.resolve(__dirname, '..', '..', '..');

const SKIP_DIR = new Set(['__tests__', 'test', '__mocks__', 'node_modules']);

/** A file whose copy a person could read. `.ts` counts too: the help maps and the registry live there. */
export const shouldScan = (file: string): boolean =>
  (file.endsWith('.tsx') || file.endsWith('.ts'))
  && !file.endsWith('.d.ts')
  && !/\.test\.tsx?$/.test(file)
  && !/\.stories\.tsx?$/.test(file);

/** Comments stripped first: a long explanatory comment is not copy, and this package is full of them. */
const stripComments = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * Prose, as opposed to an identifier, a class name, a key or a format string.
 *
 * Two words minimum and a lowercase letter somewhere, which is what separates "Needs work" from
 * `admin-metric-card`, `p95_total_ms` or `AgentEchelon`. The length floor is 12 characters because
 * below that the hit rate is mostly units and axis labels.
 */
const looksLikeProse = (s: string): boolean => {
  const t = s.trim();
  if (t.length < 12) return false;
  if (!/\s/.test(t)) return false;                       // one token is a name, not a sentence
  if (!/[a-z]{2}/.test(t)) return false;                 // SCREAMING_CASE / ids
  if (/^[a-z][\w.]*\.[a-z][\w.]*$/i.test(t)) return false; // already a translation key
  if (/^(https?:|\/|#|\.|\$\{)/.test(t)) return false;   // urls, paths, template heads
  if (/^[\w-]+(\s+[\w-]+)*$/.test(t) && !/[a-z] [a-z]/.test(t)) return false;
  if (/[{}<>]=|=>|\breturn\b|\bconst\b|SELECT |FROM /.test(t)) return false; // code and SQL
  return /[a-z]\s+[a-z]/i.test(t);
};

/** Count of prose literals and JSX text nodes in one file's source. */
export const countHardcodedCopy = (src: string): number => {
  const body = stripComments(src);
  const found = new Set<string>();

  // Quoted string literals (single, double, and backtick without an expression).
  for (const m of body.matchAll(/'([^'\\\n]{12,400})'|"([^"\\\n]{12,400})"|`([^`$\\\n]{12,400})`/g)) {
    const text = m[1] ?? m[2] ?? m[3];
    if (text && looksLikeProse(text)) found.add(text.trim());
  }

  // JSX text nodes: between a tag close and the next tag open, with no braces.
  for (const m of body.matchAll(/>([^<>{}\n]{12,400})</g)) {
    const text = m[1];
    if (text && looksLikeProse(text)) found.add(text.trim());
  }

  return found.size;
};

/** Every scannable file under the admin source, repo-relative to the admin package. */
export const scanAdminSource = (): Map<string, number> => {
  const counts = new Map<string, number>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIR.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (!shouldScan(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const n = countHardcodedCopy(fs.readFileSync(abs, 'utf8'));
      if (n > 0) counts.set(path.relative(ADMIN_SRC, abs).split(path.sep).join('/'), n);
    }
  };
  walk(ADMIN_SRC);
  return counts;
};
