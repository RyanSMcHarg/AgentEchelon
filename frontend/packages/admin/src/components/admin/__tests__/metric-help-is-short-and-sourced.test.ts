/**
 * EVERY METRIC EXPLANATION IS SHORT, AND SAYS WHERE ITS NUMBER COMES FROM.
 *
 * ── WHAT WENT WRONG WITHOUT THIS ─────────────────────────────────────────────────────────────────
 *
 * The "Latency by interaction" help text for a handover read "a person's message answered work a
 * DIFFERENT assistant owned". True of the only producer that existed when it was written. A second
 * producer then began writing the same `trigger_kind` - a fresh question routed to a specialist,
 * which is not work anyone already owned - and the sentence became wrong about half the rows it
 * described. It stayed wrong, and nothing in the suite could have noticed, because the copy named no
 * code and the code named no copy.
 *
 * A length rule alone would not have caught that either. What catches it is the REQUIREMENT TO CITE:
 * a description must name the file and symbol that compute the number, so changing the computation
 * puts the author in the file the copy points at.
 *
 * ── WHAT THIS CAN AND CANNOT PROVE ───────────────────────────────────────────────────────────────
 *
 * It proves the shape: three sentences, a guide key that resolves, a file that exists, a symbol that
 * is really in that file, and a generated `publicLine` that is not stale. It CANNOT prove the sentence
 * is true - no test can read English against SQL. The honest claim is that a wrong sentence now has a
 * fixed address, and the next person to change the computation is pointed at it.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { METRIC_TARGETS, METRIC_DEFINITIONS, type MetricDefinition } from '../metricTargets';
import { DOC_LINKS } from '../../../config/docLinks';

/**
 * The repo root, seven levels up: __tests__ / admin / components / src / admin / packages / frontend.
 * Asserted rather than assumed, because an off-by-one here makes every file look absent and the guard
 * reports "no such file" for paths that are all fine - a failure that reads like a copy problem.
 */
const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', '..');

// Both halves of the glossary: the metrics with a band and the ones with only a definition.
const entries = [...Object.entries(METRIC_TARGETS), ...Object.entries(METRIC_DEFINITIONS)] as Array<[string, MetricDefinition]>;

it('resolves the repo root, so a path failure means a path failure', () => {
  // The anchor the file checks below depend on. Without this, a wrong REPO turns every provenance
  // check into "no such file" and sends the reader looking at the registry instead of at this line.
  expect(fs.existsSync(path.join(REPO, 'backend', 'lambda', 'src'))).toBe(true);
});

/**
 * Sentence count. Abbreviations with internal periods ("p95.", "e.g.") would each read as a sentence
 * end, so the common ones are neutralized first - a count that over-reports makes the rule arbitrary
 * and invites people to work around it rather than write shorter copy.
 */
const sentenceCount = (s: string): number => s
  // THE PERIOD IS REMOVED RATHER THAN MARKED. A sentinel character was the first approach and it did
  // not survive this file being rewritten by a script: the escape became a plain space, leaving
  // "e.g. " to split as a sentence end and the counter quietly over-reporting against its own rule.
  // Stripping the dots needs no escape to survive, so the same accident cannot recur.
  .replace(/\be\.g\./gi, 'eg')
  .replace(/\bi\.e\./gi, 'ie')
  .replace(/\b(?:etc|vs|approx|Inc|cf)\./gi, (m) => m.slice(0, -1))
  .replace(/\b\d+\.\d+/g, 'N')
  .split(/[.!?]+(?:\s|$)/)
  .filter((part) => part.trim().length > 0)
  .length;

/**
 * THE TEXT LIVES IN en.json, so the length rule is applied there rather than to the registry.
 *
 * One guard over the locale file covers every admin string as the console is converted, instead of one
 * guard per file holding copy. It is also the only place a translator's string can be checked: a rule
 * that only reads `metricTargets.ts` would pass a 700-character French description.
 */
const localeAdmin = (() => {
  const raw = fs.readFileSync(
    path.join(REPO, 'frontend', 'packages', 'shared', 'src', 'locales', 'en.json'),
    'utf8',
  );
  return (JSON.parse(raw) as { admin: Record<string, unknown> }).admin;
})();

/** Every leaf string under `admin.*`, as dotted key -> text. */
const adminStrings = (() => {
  const out = new Map<string, string>();
  const walk = (node: unknown, prefix: string) => {
    if (typeof node === 'string') { out.set(prefix, node); return; }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) walk(v, prefix ? `${prefix}.${k}` : k);
  };
  walk(localeAdmin, 'admin');
  return out;
})();

describe('a metric explanation is at most three sentences', () => {
  it('every admin.metrics description is within the limit', () => {
    const over: string[] = [];
    for (const [key, text] of adminStrings) {
      if (!/^admin\.metrics\..*\.description$/.test(key)) continue;
      const n = sentenceCount(text);
      if (n > 3) over.push(`  ${key}: ${n} sentences\n    ${text.slice(0, 120)}…`);
    }
    if (over.length) {
      throw new Error(
        'A metric description is read while interpreting a number, not while studying. Keep what it '
        + 'measures, what population it is over, and the one thing that would otherwise be misread; '
        + 'move the rest into the guide its provenance names.\n\n'
        + over.join('\n'),
      );
    }
  });

  it('every metric that names a description key has that key in en.json', () => {
    // A missing key renders as the key itself on screen - i18next has no missing-key handler here - so
    // a typo is a visible `admin.metrics.foo.description` in a tooltip and nothing else goes wrong.
    const missing = entries
      .filter(([, t]) => t.descriptionKey && !adminStrings.has(t.descriptionKey))
      .map(([k, t]) => `${k} -> ${t.descriptionKey}`);
    expect(missing).toEqual([]);
  });

  it('keeps no orphaned metric description in the locale file', () => {
    // The other direction: a description for a metric the registry no longer has is copy nobody can
    // reach, and it would go on passing the length rule forever.
    const keys = new Set(entries.map(([, t]) => t.descriptionKey).filter(Boolean));
    const orphans = [...adminStrings.keys()]
      .filter((k) => /^admin\.metrics\..*\.description$/.test(k) && !keys.has(k));
    expect(orphans).toEqual([]);
  });
});

describe('a metric explanation says where its number comes from', () => {
  it('every described metric carries provenance', () => {
    const missing = entries
      .filter(([, t]) => t.descriptionKey && !t.provenance)
      .map(([k]) => k);
    expect(missing).toEqual([]);
  });

  // ONE TEST ITERATING, rather than `it.each` over a filtered list: `it.each([])` is itself a failure
  // in vitest, so an empty filter - no metric carrying provenance yet - would report as a broken guard
  // instead of an empty one. Collecting into a list also names every offender in a single run rather
  // than stopping at the first.
  it('cites a guide key that resolves', () => {
    const bad = entries
      .filter(([, t]) => t.provenance && !(t.provenance.guide in DOC_LINKS))
      .map(([k, t]) => `${k} -> ${t.provenance!.guide}`);
    expect(bad).toEqual([]);
  });

  it('cites a file that exists, holding the symbol it names', () => {
    const bad: string[] = [];
    for (const [key, t] of entries) {
      if (!t.provenance) continue;
      const { file, symbol } = t.provenance;
      const abs = path.join(REPO, file);
      if (!fs.existsSync(abs)) { bad.push(`${key}: no such file ${file}`); continue; }
      // THE SYMBOL IS THE DURABLE HALF of the reference: line numbers move on every edit above them,
      // a name does not. If this fails, the computation was renamed or moved and the copy describing
      // it is now unanchored - which is the moment to re-read the sentence, not just repoint it.
      if (!fs.readFileSync(abs, 'utf8').includes(symbol)) {
        bad.push(`${key}: ${file} no longer contains ${symbol}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('carries only generated public lines, never a hand-typed zero', () => {
    // `publicLine` is resolved against the PUBLIC tree by scripts/gen-metric-provenance.mjs, because
    // that is what the link resolves against. This cannot re-run git, so it asserts the weaker
    // property it can: a line, if present, is a plausible 1-based line. `#L0` is the signature of a
    // generator that found nothing and wrote the result anyway.
    const bad = entries
      .filter(([, t]) => t.provenance?.publicLine !== undefined)
      .filter(([, t]) => !Number.isInteger(t.provenance!.publicLine) || t.provenance!.publicLine! < 1)
      .map(([k, t]) => `${k} -> ${t.provenance!.publicLine}`);
    expect(bad).toEqual([]);
  });
});
