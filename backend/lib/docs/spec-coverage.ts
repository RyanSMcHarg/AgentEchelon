/**
 * Spec-to-e2e coverage: the parser, the rules, and the rendered matrix.
 *
 * WHY THIS EXISTS. Every spec document carries a machine-readable `**Status:**` line, and a document
 * that says `Implemented` is read as a promise that the behaviour works. Nothing connected that claim
 * to a test. The mapping lived in one person's head and in four specs that happened to name their e2e
 * file in prose, so "is this covered?" was answerable only by re-deriving it - which is how a coverage
 * matrix gets written twice, disagrees with itself, and is trusted anyway.
 *
 * The failure this guards against is specific to this repo and has already happened twice. Unit tests
 * assert the shape the code produces, so a contract with an external system can be wrong in every
 * deployment while the whole suite is green: `emitEmfMetric` emitted `{name, unit}` where EMF requires
 * `{Name, Unit}`, and CloudWatch discarded every document silently - no metric in any AgentEchelon
 * namespace had ever existed. Only an end-to-end test can see that class of defect, and only if one is
 * written. So the question "which spec has one, and which does not" has to be a build-time fact.
 *
 * WHAT IT PROVES, EXACTLY. That a named e2e spec file EXISTS for a claim. Not that the test is good,
 * not that it ran on the last execution (a credential-gated test that skipped still reads as covered),
 * and not that it asserts anything meaningful. It is the floor, not the ceiling - a spec can declare
 * `none - <reason>` and the reason is recorded in the matrix rather than argued about in review. What
 * the guard removes is the third option: saying nothing.
 *
 * The generated document is the artifact a reader trusts, so it is rendered from the specs rather than
 * maintained beside them - same rationale, and the same enforcement, as
 * `docs/reference/context-catalog-reference.md` (see `context-catalog-reference.test.ts`).
 *
 * RELATIONSHIP TO THE `Verified by:` GATE. `docs-drift-guard.test.ts` enforces a different and older
 * rule: a spec that says `Implemented` must cite a verifying test AT ANY LEVEL, with a ratchet of
 * grandfathered entries that may only shrink. The two are complementary, not redundant. That gate asks
 * "is this claim tied to a test at all"; this one asks "does an END-TO-END test exist, and if not, has
 * someone written down why" - which is the question a unit test cannot answer for itself, and it is
 * asked of every document, including the ones that say Design.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Where the spec corpus lives, relative to the repo root. */
export const SPECS_DIR = path.join('docs', 'specs');
/** Where the e2e suite lives, relative to the repo root. Coverage paths are relative to `tests/`. */
export const E2E_DIR = path.join('tests', 'e2e');
/** The generated matrix, relative to the repo root. */
export const MATRIX_PATH = path.join('docs', 'reference', 'e2e-coverage-matrix.md');

/** Documents in the spec tree that are navigation, not claims about behaviour. */
const NON_SPEC_FILES = new Set(['_README.md']);

/**
 * How a spec's `Status:` line reads, reduced to the only distinction the guard acts on.
 *
 * `implemented` and `partial` are claims that some behaviour is live, so an unnamed coverage decision
 * is a gap. `design` documents describe something not built, where "no test" is the expected answer -
 * they still have to SAY so, because a design doc that quietly ships is exactly how an untested
 * feature reaches a deployment.
 */
export type StatusClass = 'implemented' | 'partial' | 'design' | 'unknown';

export interface SpecRecord {
  /** Repo-relative path with forward slashes, e.g. `docs/specs/ops/SPEC-ABUSE-CONTROLS.md`. */
  path: string;
  /** The `# ` heading, or the filename when a document has none. */
  title: string;
  /** The Status line's leading clause, trimmed - enough to read, not the whole paragraph. */
  status: string;
  statusClass: StatusClass;
  /** Declared e2e specs, `tests/`-relative (`e2e/tasks.spec.ts`). Empty when the spec declares none. */
  coverage: string[];
  /** The stated reason when coverage is declared as `none`; null when specs are named. */
  uncoveredReason: string | null;
  /** False when the document carries no `**Coverage:**` line at all - the one unforgivable case. */
  declared: boolean;
}

export interface CoverageProblem {
  spec: string;
  kind: 'missing-coverage-line' | 'unknown-e2e-spec' | 'unexplained-none' | 'malformed-coverage';
  detail: string;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Every spec document in the corpus, sorted, repo-relative, POSIX-separated. */
export function listSpecDocs(repoRoot: string): string[] {
  const root = path.join(repoRoot, SPECS_DIR);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md') && !NON_SPEC_FILES.has(entry.name)) {
        out.push(toPosix(path.relative(repoRoot, full)));
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Every e2e spec file, as the `tests/`-relative path a `Coverage:` line names. */
export function listE2eSpecs(repoRoot: string): string[] {
  const dir = path.join(repoRoot, E2E_DIR);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.spec.ts'))
    .map((f) => `e2e/${f}`)
    .sort();
}

/**
 * Active `test(...)` declarations in an e2e file.
 *
 * Counted for the matrix so a one-assertion spec is visibly different from a fifteen-test one - naming
 * a file proves a file exists, and the count is the cheapest signal of how much is behind the name.
 * `test.skip(` in the DECLARATION position would be a disabled test and is excluded; `test.skip()` in a
 * body is a runtime gate on a test that is otherwise real, and is not matched by this pattern.
 */
export function countTests(repoRoot: string, e2eSpec: string): number {
  const file = path.join(repoRoot, 'tests', e2eSpec);
  const src = fs.readFileSync(file, 'utf8');
  const matches = src.match(/(?<![.\w])test(?:\.only)?\s*\(\s*['"`]/g);
  return matches ? matches.length : 0;
}

function classifyStatus(status: string): StatusClass {
  const s = status.trim().toLowerCase();
  if (/^(implemented|built|live|shipped)/.test(s)) return 'implemented';
  if (/^partial/.test(s)) return 'partial';
  if (/^(design|draft|proposed|planned|not built)/.test(s)) return 'design';
  return 'unknown';
}

/**
 * Read one spec document's Status and Coverage declarations.
 *
 * Both lines are prose-heavy by design - a Status line often carries Layer/Plane/Summary bold runs
 * after it - so parsing stops at the next `**bold**` marker rather than at the end of the line.
 */
export function parseSpecDoc(repoRoot: string, specPath: string): SpecRecord {
  const raw = fs.readFileSync(path.join(repoRoot, specPath), 'utf8').replace(/\r\n/g, '\n');

  const heading = raw.match(/^#\s+(.+)$/m);
  const title = heading ? heading[1].trim() : path.basename(specPath, '.md');

  const statusLine = raw.match(/^\*\*Status:\*\*\s*(.+)$/m);
  // Stop at the next bold run: `**Status:** Implemented **Layer:** ...` must not read as a status of
  // "Implemented **Layer:** ...".
  const status = statusLine ? statusLine[1].split(/\s*\*\*/)[0].trim().replace(/\s+/g, ' ') : '';

  const coverageLine = raw.match(/^\*\*Coverage:\*\*\s*(.+)$/m);
  if (!coverageLine) {
    return { path: specPath, title, status, statusClass: classifyStatus(status), coverage: [], uncoveredReason: null, declared: false };
  }

  const body = coverageLine[1].split(/\s*\*\*/)[0].trim();
  const noneMatch = body.match(/^none\b\s*[-–—:]?\s*(.*)$/i);
  if (noneMatch) {
    return {
      path: specPath,
      title,
      status,
      statusClass: classifyStatus(status),
      coverage: [],
      uncoveredReason: noneMatch[1].trim(),
      declared: true,
    };
  }

  // Otherwise: a comma-separated list of backticked `tests/`-relative spec paths.
  //
  // Only tokens that LOOK like a spec file count. A Coverage line is prose as well as a list, and
  // treating every backticked token as a filename made ordinary writing fail the build — a line
  // mentioning `state: archived` or `membershipHistory` was reported as naming a spec that "does not
  // exist under tests/". That fired three times while writing these declarations, and the fix each
  // time was to degrade the prose, which is the wrong direction.
  //
  // The useful half of the check survives: a MISSPELLED spec path still ends in `.spec.ts`, so it is
  // still matched, still looked up, and still fails when it does not exist.
  const named = Array.from(body.matchAll(/`([^`]+)`/g))
    .map((m) => m[1].trim())
    .filter((t) => /\.spec\.ts$/.test(t));
  return {
    path: specPath,
    title,
    status,
    statusClass: classifyStatus(status),
    coverage: named,
    uncoveredReason: null,
    declared: true,
  };
}

export function readSpecCoverage(repoRoot: string): SpecRecord[] {
  return listSpecDocs(repoRoot).map((p) => parseSpecDoc(repoRoot, p));
}

/** Shortest reason that says anything. Below this, `none - n/a` would satisfy the guard vacuously. */
const MIN_REASON_LENGTH = 12;

/**
 * Every rule the build enforces, as data.
 *
 * Deliberately NOT a rule: "an Implemented spec must name an e2e spec". That would be enforcement by
 * coercion - the cheapest way to satisfy it is to name a file that asserts nothing, which converts a
 * visible gap into an invisible one. The rule is that the decision must be WRITTEN DOWN and the
 * reasons collected where a reader sees them all at once.
 */
export function validateCoverage(specs: SpecRecord[], e2eSpecs: string[]): CoverageProblem[] {
  const known = new Set(e2eSpecs);
  const problems: CoverageProblem[] = [];

  for (const spec of specs) {
    if (!spec.declared) {
      problems.push({
        spec: spec.path,
        kind: 'missing-coverage-line',
        detail:
          'no `**Coverage:**` line. Add one naming the e2e spec(s) that prove this document, '
          + 'e.g. "**Coverage:** `e2e/tasks.spec.ts`", or "**Coverage:** none - <why not>".',
      });
      continue;
    }

    if (spec.uncoveredReason !== null) {
      if (spec.uncoveredReason.length < MIN_REASON_LENGTH) {
        problems.push({
          spec: spec.path,
          kind: 'unexplained-none',
          detail: `declares no coverage without a usable reason (got "${spec.uncoveredReason}"). `
            + 'State what stands in for an e2e test, or why one cannot exist.',
        });
      }
      continue;
    }

    if (spec.coverage.length === 0) {
      problems.push({
        spec: spec.path,
        kind: 'malformed-coverage',
        detail: 'a `**Coverage:**` line that names no `backticked` spec file and is not `none - <reason>`.',
      });
      continue;
    }

    for (const named of spec.coverage) {
      if (!known.has(named)) {
        problems.push({
          spec: spec.path,
          kind: 'unknown-e2e-spec',
          detail: `names \`${named}\`, which does not exist under tests/. Renamed or deleted?`,
        });
      }
    }
  }

  return problems;
}

/** e2e specs that no document claims. Reported, never failed - see the renderer's note. */
export function orphanE2eSpecs(specs: SpecRecord[], e2eSpecs: string[]): string[] {
  const claimed = new Set(specs.flatMap((s) => s.coverage));
  return e2eSpecs.filter((f) => !claimed.has(f));
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

/**
 * Render the matrix.
 *
 * Contains NO timestamp and no run-specific value: the document is compared byte-for-byte against a
 * fresh render, so anything that changes between two identical runs would fail the build every time
 * and train everyone to regenerate without reading.
 */
export function renderCoverageMatrix(
  specs: SpecRecord[],
  e2eSpecs: string[],
  testCount: (e2eSpec: string) => number,
): string {
  const lines: string[] = [];
  const covered = specs.filter((s) => s.coverage.length > 0);
  const uncovered = specs.filter((s) => s.declared && s.uncoveredReason !== null);
  const liveClaims = specs.filter((s) => s.statusClass === 'implemented' || s.statusClass === 'partial');
  const liveUncovered = liveClaims.filter((s) => s.coverage.length === 0);
  const totalTests = e2eSpecs.reduce((n, f) => n + testCount(f), 0);

  lines.push('# End-to-end coverage matrix');
  lines.push('');
  lines.push('Do not edit by hand. Generated from the `**Coverage:**` line of every document under');
  lines.push('`docs/specs/` and the spec files under `tests/e2e/`. Regenerate with:');
  lines.push('');
  lines.push('```');
  lines.push('cd backend && npm run gen-coverage-matrix');
  lines.push('```');
  lines.push('');
  lines.push('`e2e-coverage-matrix.test.ts` fails the build when this file stops matching, when a document');
  lines.push('carries no coverage declaration, or when a declaration names a spec file that does not exist.');
  lines.push('');
  lines.push('**What a "covered" row means, exactly:** a named e2e spec file exists. It does not mean the');
  lines.push('test is a good one, and it does not mean the test RAN - much of the suite is gated on');
  lines.push('provisioned credentials and skips silently without them. Read this as the floor.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Spec documents | ${specs.length} |`);
  lines.push(`| ...naming at least one e2e spec | ${covered.length} |`);
  lines.push(`| ...declaring none, with a reason | ${uncovered.length} |`);
  lines.push(`| Documents claiming live behaviour (Implemented / Partial) | ${liveClaims.length} |`);
  lines.push(`| ...of those, with no e2e spec | ${liveUncovered.length} |`);
  lines.push(`| e2e spec files | ${e2eSpecs.length} |`);
  lines.push(`| e2e tests declared | ${totalTests} |`);
  lines.push('');
  lines.push('## Specifications');
  lines.push('');
  lines.push('| Specification | Status | e2e coverage | Tests |');
  lines.push('|---|---|---|---|');
  for (const s of specs) {
    const rel = s.path.replace(/^docs\//, '../');
    const name = `[${escapeCell(truncate(s.title, 64))}](${rel})`;
    const status = escapeCell(truncate(s.status || '(none)', 48));
    let cover: string;
    let tests: string;
    if (s.coverage.length) {
      cover = s.coverage.map((c) => `\`${c}\``).join('<br>');
      tests = String(s.coverage.reduce((n, c) => n + (e2eSpecs.includes(c) ? testCount(c) : 0), 0));
    } else {
      cover = `none - ${escapeCell(truncate(s.uncoveredReason ?? '', 90))}`;
      tests = '-';
    }
    lines.push(`| ${name} | ${status} | ${cover} | ${tests} |`);
  }
  lines.push('');
  lines.push('## e2e specs no document claims');
  lines.push('');
  lines.push('Not a failure: a spec file may prove a journey (sign-in, navigation) that no single');
  lines.push('specification owns. It is listed so the reverse gap - a test nobody knows is load-bearing -');
  lines.push('is as visible as the forward one.');
  lines.push('');
  const orphans = orphanE2eSpecs(specs, e2eSpecs);
  if (orphans.length === 0) {
    lines.push('_None - every e2e spec is claimed by at least one document._');
  } else {
    for (const o of orphans) {
      const n = testCount(o);
      lines.push(`- \`${o}\` (${n} test${n === 1 ? '' : 's'})`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
