/**
 * Docs / comment DRIFT GUARD.
 *
 * Some facts about the platform are stated in prose (docs, ASCII diagrams, code comments) with no
 * compiler or unit test tying them to the authoritative source. Those claims drift: the code changes,
 * the prose does not, and a coherence-focused doc review does not diff every sentence against config.
 * This test makes a small set of load-bearing facts self-defending — it fails if a known-stale
 * assertion reappears anywhere on the shipped surface (README, docs/, source comments, e2e specs).
 *
 * SCOPE: it guards against a curated list of assertions we have already corrected and know to be
 * wrong. It is NOT a general fact-checker. When you correct a recurring stale claim, add its phrasing
 * here so it cannot silently come back.
 *
 * The authoritative source for every fact below is `backend/lib/config/profiles.ts`
 * (`DEFAULT_PROFILES_CONFIG`) and `backend/lambda/src/lib/intent-pack.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Roots to scan. Deliberately EXCLUDES backend/test (this file plus unit-test fixtures legitimately
// contain literal values like `taskSupport: 'lightweight'` for synthetic profiles) and any build
// output (*.d.ts / *.js / node_modules / cdk.out).
const SCAN_ROOTS = [
  'README.md',
  'docs',
  'backend/lambda/src',
  'backend/lib',
  'tests/e2e',
];

const SCAN_EXTENSIONS = new Set(['.md', '.ts']);

/**
 * Each entry is a stale assertion (matched case-insensitively as a substring) plus the correct fact.
 * Keep the phrase specific enough that ONLY the wrong assertion matches — the accurate replacements
 * we now ship (and legitimate historical "legacy basic was 'keyword'" / "deliberately NOT
 * keyword-classified" notes) must not trip it.
 */
const BANNED: Array<{ phrase: string; truth: string }> = [
  // --- Class A: basic is NOT keyword-classified. All default profiles use the LLM classifier;
  //     `classifierMode: 'keyword'` is an opt-in per-profile mode, not a tier behavior. ---
  { phrase: 'classifyintentbasic', truth: "renamed to classifyIntentByKeyword (the keyword classifier is not tied to the basic tier)" },
  { phrase: 'basic tier is keyword', truth: "basic uses classifierMode: 'llm' (profiles.ts)" },
  { phrase: 'basic is keyword-only', truth: "basic uses classifierMode: 'llm' (profiles.ts)" },
  { phrase: 'keyword-only for basic', truth: "basic uses classifierMode: 'llm' (profiles.ts)" },
  { phrase: 'keyword (basic)', truth: "basic uses the LLM classifier (profiles.ts)" },
  { phrase: 'basic tier skips it', truth: "basic runs the LLM classifier like every default profile (profiles.ts)" },

  // --- Class B: basic has FULL task support (taskSupport: 'full' for every profile). What basic
  //     lacks is the RICH processor output (richProcessor: false) — generated docs / battle / image
  //     gen — NOT task tracking. "lightweight" / "status-only" task support is the stale framing. ---
  { phrase: 'lightweight task support', truth: "basic has taskSupport: 'full' (profiles.ts); it lacks the rich processor output, not task tracking" },
  { phrase: 'basic is lightweight', truth: "basic has taskSupport: 'full' (profiles.ts)" },
  { phrase: 'basic gets lightweight', truth: "basic has taskSupport: 'full' (profiles.ts)" },
  { phrase: 'lightweight tasks (grounds', truth: "basic runs the full task loop (taskSupport: 'full'); richProcessor:false gates generated-doc output, not task tracking" },
];

function walk(abs: string, out: string[]): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return; // a scan root that does not exist in this checkout is skipped, not an error
  }
  if (stat.isFile()) {
    const ext = path.extname(abs);
    if (SCAN_EXTENSIONS.has(ext) && !abs.endsWith('.d.ts')) out.push(abs);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'cdk.out' || entry.name === 'dist') continue;
    walk(path.join(abs, entry.name), out);
  }
}

describe('docs / comment drift guard', () => {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(path.join(REPO_ROOT, root), files);
  const thisFile = path.resolve(__filename);

  it('scans a non-trivial number of files (guard is actually wired to the tree)', () => {
    // Cheap wiring check: if the scan roots move and nothing is found, the guard would be a silent
    // no-op that always passes. Assert it saw a realistic corpus.
    expect(files.length).toBeGreaterThan(50);
  });

  it('no known-stale assertion appears on the shipped surface', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (path.resolve(file) === thisFile) continue; // the guard names the banned phrases itself
      const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      lines.forEach((line, i) => {
        const lower = line.toLowerCase();
        for (const { phrase, truth } of BANNED) {
          if (lower.includes(phrase)) {
            violations.push(`${rel}:${i + 1}\n    stale: "${line.trim()}"\n    truth: ${truth}`);
          }
        }
      });
    }
    if (violations.length > 0) {
      throw new Error(
        `Stale assertion(s) found. Correct the prose to match the authoritative config, or if a phrase\n` +
          `is now a false positive, tighten its entry in BANNED. Findings:\n\n${violations.join('\n\n')}\n`,
      );
    }
    expect(violations).toEqual([]);
  });
});
