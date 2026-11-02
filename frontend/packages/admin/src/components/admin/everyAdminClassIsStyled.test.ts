/**
 * EVERY `admin-` CLASS IN THE MARKUP HAS A RULE SOMEWHERE.
 *
 * A class name that matches no CSS rule is invisible in the worst way: nothing errors, nothing logs,
 * and the element renders as whatever its parent happened to do. This has now been found twice by
 * hand - once for `.admin-metrics-row`, `.admin-metric-drill` and `.admin-latency-legend` (a metric
 * row laid out by inheritance instead of as a grid, which is why fourteen cards read as an
 * undifferentiated block), and again for `.admin-metric-card`, `.admin-metric-value` and
 * `.admin-metric-label`, which left the Ground Truth agreement rate and its error rendering as bare
 * text. Those two are the numbers a judge's trustworthiness is read off.
 *
 * Twice by hand is the point at which a check is cheaper than a third sweep. This one is mechanical,
 * so the next hand-rolled class fails here instead of shipping unstyled.
 *
 * SCOPE, deliberately narrow: only the `admin-` prefix, only literal `className` strings, and only
 * this package's own stylesheets. A broader scan would drag in component-library classes, utility
 * classes and computed names, and a guard with a long exemption list is one nobody trusts.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const HERE = __dirname;
const SRC = path.resolve(HERE, '..', '..');

function filesUnder(dir: string, ext: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...filesUnder(abs, ext));
    } else if (ext.some((e) => entry.name.endsWith(e))) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * A SHRINKING BASELINE, NOT AN APPROVED LIST.
 *
 * Turning this guard on revealed 23 more unstyled classes than the three it was written for, which is
 * the finding: the family is much larger than two hand sweeps suggested. They are grandfathered so the
 * guard can bind NOW on the thing that matters - no NEW unstyled class - rather than waiting on 23
 * design decisions that are not this commit's to make.
 *
 * WHAT IS AND IS NOT CLAIMED HERE. Three were verified as real defects and are fixed
 * (`admin-metric-card`, `-value`, `-label`, which left the Ground Truth agreement rate as bare text).
 * The entries below are NOT verified as intentional - each is "unstyled, unexamined". Some will be
 * genuine defects, and some may be elements happy to inherit. Tracked as a row rather than left as a
 * silent list, and every removal from here is a surface that got looked at.
 *
 * So the rule for a reader: adding a name here needs a reason. Removing one needs a rule.
 */
const DELIBERATELY_UNSTYLED = new Set<string>([
  'admin-alert-row',
  'admin-filter-bar',
  'admin-filter-clear',
  'admin-flag-chip',
  'admin-help-text',
  'admin-inline-label',
  'admin-mini-table',
  'admin-modal-overlay',
  'admin-review-compliance',
  'admin-review-message',
  'admin-review-messages',
  'admin-review-panel',
  'admin-review-reasoning',
  'admin-scoring-form',
  'admin-timeline-row',
]);

/**
 * ONLY WHAT IS ACTUALLY IN A `className`, which the first version of this got wrong.
 *
 * Scanning whole sources for the `admin-` prefix flagged 29 names, and a third of them were not class
 * names at all: `admin-conversations-aurora` is a FILENAME cited in a comment, `admin-plane` is prose
 * about the admin plane, `admin-in-chat` is part of a sentence. A guard that fires on things that are
 * not defects gets muted or deleted, so it reads className VALUES and nothing else.
 *
 * It therefore misses a class assembled at runtime from fragments, and that is the right trade: a
 * guard that under-reports is still useful, and one that over-reports is not.
 */
const markupClasses = (): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  for (const file of filesUnder(SRC, ['.tsx'])) {
    if (file.endsWith('.test.tsx')) continue;
    const src = fs.readFileSync(file, 'utf-8');
    // className="a b", className={'a b'}, className={`a ${x}`} - the literal parts of each.
    const values: string[] = [];
    for (const m of src.matchAll(/className\s*=\s*(?:"([^"]*)"|\{\s*`([^`]*)`|\{\s*'([^']*)')/g)) {
      values.push(m[1] ?? m[2] ?? m[3] ?? '');
    }
    for (const value of values) {
      for (const token of value.split(/[\s${}()?:|&'"`,]+/)) {
        if (!/^admin-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(token)) continue;
        if (!found.has(token)) found.set(token, []);
        const where = found.get(token)!;
        const rel = path.relative(SRC, file).replace(/\\/g, '/');
        if (!where.includes(rel)) where.push(rel);
      }
    }
  }
  return found;
};

const styledClasses = (): Set<string> => {
  const styled = new Set<string>();
  for (const file of filesUnder(SRC, ['.css'])) {
    for (const m of fs.readFileSync(file, 'utf-8').matchAll(/\.(admin-[a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
      styled.add(m[1]);
    }
  }
  return styled;
};

describe('every admin- class in the markup is styled somewhere', () => {
  it('finds a realistic number of classes on both sides, so the guard is wired rather than empty', () => {
    expect(markupClasses().size).toBeGreaterThan(20);
    expect(styledClasses().size).toBeGreaterThan(20);
  });

  it('has a CSS rule for every admin- class the markup uses', () => {
    const styled = styledClasses();
    const unstyled = [...markupClasses().entries()]
      .filter(([cls]) => !styled.has(cls) && !DELIBERATELY_UNSTYLED.has(cls))
      .map(([cls, where]) => `${cls}  (used in ${where.join(', ')})`);

    // Named in the failure rather than counted, because the fix is per class and the reader needs to
    // know which file to open.
    expect(unstyled).toEqual([]);
  });

  it('keeps the three that were missed styled, by name', () => {
    const styled = styledClasses();
    for (const cls of ['admin-metric-card', 'admin-metric-value', 'admin-metric-label']) {
      expect(styled.has(cls)).toBe(true);
    }
  });

  it('shrinks the baseline rather than carrying it: a styled class must leave the list', () => {
    // Without this, styling a class would leave its name behind and the list would stop describing
    // anything - the same way a grandfather list rots into a permanent exemption.
    const styled = styledClasses();
    const nowStyled = [...DELIBERATELY_UNSTYLED].filter((cls) => styled.has(cls));
    expect(nowStyled).toEqual([]);
  });

  it('does not carry a name the markup no longer uses', () => {
    // A baseline entry for a deleted class hides the fact that the list is shorter than it looks.
    const used = new Set(markupClasses().keys());
    expect([...DELIBERATELY_UNSTYLED].filter((cls) => !used.has(cls))).toEqual([]);
  });
});
