/**
 * NO USER-FACING STRING IN THE CONSOLE IS AN ESSAY, WHEREVER IT LIVES.
 *
 * ── WHY THIS IS A SECOND GUARD AND NOT A CLAUSE IN AN EXISTING ONE ───────────────────────────────
 *
 * The three-sentence rule is enforced on `admin.metrics.*.description` in en.json, which covers the
 * metric registry and nothing else. The localization ratchet counts hardcoded strings per file - but its
 * scanner matches `{12,400}` characters, so a literal LONGER than 400 characters is invisible to it.
 * Those are exactly the strings the rule exists for: the two worst offenders found in ProfilesTab were
 * 498 and 413 characters, and the ratchet had never counted either. A guard blind to the extreme of the
 * thing it guards is worse than no guard, because its green reads as coverage.
 *
 * Fixing the scanner's cap was the obvious move and the wrong one: the baseline stores that function's
 * exact output for 38 files, so widening it would shift every number and discard the record of what has
 * been converted. A separate check with its own threshold costs nothing and keeps both honest.
 *
 * ── WHAT IT CHECKS ───────────────────────────────────────────────────────────────────────────────
 *
 * Every single-line quoted literal in the admin source that reads like prose, against a CHARACTER
 * limit rather than a sentence count. Characters because this runs over source rather than over
 * resolved copy: it cannot tell a sentence from an abbreviation reliably in a template literal, and a
 * limit in characters is a blunt rule that is hard to argue with. Multi-line JSX prose is out of
 * scope - it needs a parser, and the strings this catches are the ones that hid from everything else.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ADMIN_SRC, shouldScan } from './hardcodedCopyScanner';

/**
 * The limit. Three sentences of console copy runs to roughly 350-400 characters, so 420 admits a
 * long-but-compliant string and refuses an essay. It is a backstop for what the sentence rule cannot
 * see, not a replacement for it.
 */
const MAX_CHARS = 420;

/** Prose rather than a key, a class name, a URL or code. Deliberately the same shape as the scanner's. */
const looksLikeProse = (s: string): boolean => {
  const t = s.trim();
  if (t.length < 12 || !/\s/.test(t) || !/[a-z]{2}/.test(t)) return false;
  if (/^[a-z][\w.]*\.[a-z][\w.]*$/i.test(t)) return false;
  if (/^(https?:|\/|#|\$\{)/.test(t)) return false;
  if (/[{}<>]=|=>|\breturn\b|\bconst\b|SELECT |FROM /.test(t)) return false;
  return /[a-z]\s+[a-z]/i.test(t);
};

const offenders: string[] = [];

const walk = (dir: string) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!['__tests__', 'test', '__mocks__', 'node_modules'].includes(entry.name)) {
        walk(path.join(dir, entry.name));
      }
      continue;
    }
    if (!shouldScan(entry.name)) continue;
    const rel = path.relative(ADMIN_SRC, path.join(dir, entry.name)).split(path.sep).join('/');
    const lines = fs.readFileSync(path.join(dir, entry.name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
      .split('\n');
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      // A quoted run with no escape in it. The inner class permits the OTHER quote character, because
      // real copy contains apostrophes ("the answer's tool loop") and quoted phrases ("Needs work") -
      // a class excluding both stops at the first one and misses the string entirely, which is the
      // mistake that made two of these invisible while they were being hunted by hand.
      for (const m of line.matchAll(/'([^'\\]{200,})'|"([^"\\]{200,})"/g)) {
        const text = m[1] ?? m[2];
        if (!text || !looksLikeProse(text)) continue;
        if (text.length > MAX_CHARS) {
          offenders.push(`  ${rel}:${i + 1} — ${text.length} chars\n    ${text.slice(0, 100)}…`);
        }
      }
    });
  }
};
walk(ADMIN_SRC);

describe('console copy is not documentation', () => {
  it(`has no user-facing literal over ${MAX_CHARS} characters`, () => {
    if (offenders.length) {
      throw new Error(
        `A console string is documentation, not UI copy (limit ${MAX_CHARS} characters).\n\n`
        + 'Keep what it measures, what population it is over, and the one thing that would otherwise be '
        + 'misread. Move the rest into the guide the panel links, and put the copy in en.json under '
        + '`admin.<surface>.*`.\n\n'
        + offenders.join('\n'),
      );
    }
    expect(offenders).toEqual([]);
  });
});
