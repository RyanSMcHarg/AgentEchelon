/**
 * Every spec document must say which end-to-end test proves it - and the matrix must match.
 *
 * THE FAILURE THIS EXISTS FOR. A `**Status:** Implemented` line is read as a promise that the
 * behaviour works, and nothing connected that promise to a test. That is not a theoretical risk in
 * this repo: `emitEmfMetric` wrote `{name, unit}` where the EMF schema requires `{Name, Unit}`, so
 * CloudWatch discarded every document silently and NO metric in any AgentEchelon namespace had ever
 * existed - after months of drift detection emitting on every turn. All ~1900 unit tests passed
 * throughout, because a unit test can only assert the shape the code produces, and the schema is an
 * external contract. An end-to-end test is the only layer that sees that class of defect, and only if
 * someone wrote one.
 *
 * So the mapping from claim to test becomes a build-time fact rather than an exercise re-derived by
 * hand (twice, disagreeing with itself, and trusted anyway).
 *
 * WHAT THESE TESTS DO NOT CLAIM. That a named test is a good test, or that it ran. Much of the e2e
 * suite is gated on provisioned credentials and skips silently without them, so a "covered" row can
 * still correspond to a test that no-oped on the last execution. This is the floor.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  readSpecCoverage,
  listSpecDocs,
  listE2eSpecs,
  countTests,
  renderCoverageMatrix,
  validateCoverage,
  orphanE2eSpecs,
  parseSpecDoc,
  MATRIX_PATH,
} from '../lib/docs/spec-coverage';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const specs = readSpecCoverage(REPO_ROOT);
const e2eSpecs = listE2eSpecs(REPO_ROOT);
const render = (): string => renderCoverageMatrix(specs, e2eSpecs, (f) => countTests(REPO_ROOT, f));

describe('spec -> e2e coverage declarations', () => {
  it('finds the corpus at all (guards against a silently empty scan)', () => {
    // Without this, a moved docs/ or tests/ directory would make every assertion below pass over an
    // empty list - the exact "green having checked nothing" shape the rest of this file exists to stop.
    expect(specs.length).toBeGreaterThan(20);
    expect(e2eSpecs.length).toBeGreaterThan(10);
  });

  it('every spec document declares its coverage, and every named spec file exists', () => {
    const problems = validateCoverage(specs, e2eSpecs);
    if (problems.length) {
      const detail = problems
        .map((p) => `  [${p.kind}] ${p.spec}\n      ${p.detail}`)
        .join('\n');
      throw new Error(
        `${problems.length} spec document(s) have a coverage problem:\n\n${detail}\n\n`
        + 'Add or fix the `**Coverage:**` line under the document\'s `**Status:**` line. It names the\n'
        + 'e2e spec files that prove the document, or states `none - <why not>`. Declaring `none` with a\n'
        + 'real reason is a valid answer; saying nothing is not.',
      );
    }
    expect(problems).toEqual([]);
  });

  // Falsification. The validator must be capable of failing, or the assertion above proves only that
  // the function returned an empty array.
  describe('the validator actually rejects each bad shape', () => {
    const good = { path: 'x.md', title: 'x', status: 'Implemented', statusClass: 'implemented' as const };

    it('rejects a document with no Coverage line', () => {
      const out = validateCoverage(
        [{ ...good, coverage: [], uncoveredReason: null, declared: false }],
        e2eSpecs,
      );
      expect(out.map((p) => p.kind)).toEqual(['missing-coverage-line']);
    });

    it('rejects a named spec file that does not exist', () => {
      const out = validateCoverage(
        [{ ...good, coverage: ['e2e/does-not-exist.spec.ts'], uncoveredReason: null, declared: true }],
        e2eSpecs,
      );
      expect(out.map((p) => p.kind)).toEqual(['unknown-e2e-spec']);
    });

    it('rejects `none` with no usable reason', () => {
      // "none - n/a" would otherwise satisfy the guard while saying nothing, which is worse than a
      // missing line: it looks like a decision was made.
      const out = validateCoverage(
        [{ ...good, coverage: [], uncoveredReason: 'n/a', declared: true }],
        e2eSpecs,
      );
      expect(out.map((p) => p.kind)).toEqual(['unexplained-none']);
    });

    it('rejects a Coverage line that names nothing and is not `none`', () => {
      const out = validateCoverage(
        [{ ...good, coverage: [], uncoveredReason: null, declared: true }],
        e2eSpecs,
      );
      expect(out.map((p) => p.kind)).toEqual(['malformed-coverage']);
    });
  });

  it('parses a Status line that carries trailing bold runs', () => {
    // Many documents read `**Status:** Implemented **Layer:** ... **Plane:** ...`. A naive
    // to-end-of-line parse would classify the status as the whole metadata block.
    const withRuns = specs.find((s) => s.path.endsWith('SPEC-ADMIN-IDENTITY.md'));
    expect(withRuns).toBeDefined();
    expect(withRuns!.status).toMatch(/^Implemented/);
    expect(withRuns!.status).not.toContain('Layer:');
    expect(withRuns!.statusClass).toBe('implemented');
  });
});

describe('the generated coverage matrix', () => {
  it('the committed file matches what the declarations render', () => {
    const committed = fs.readFileSync(path.join(REPO_ROOT, MATRIX_PATH), 'utf8').replace(/\r\n/g, '\n');
    if (committed !== render()) {
      throw new Error(
        `${MATRIX_PATH.split(path.sep).join('/')} is out of date with the spec documents.\n`
        + 'The `**Coverage:**` lines are the source; this file is generated from them. Run:\n\n'
        + '    cd backend && npm run gen-coverage-matrix\n\n'
        + 'and commit the result. Do not hand-edit the document.',
      );
    }
    expect(committed).toBe(render());
  });

  // Falsification: the comparison must be capable of failing. Without this the test could pass
  // because both sides read the same file, or because the render is a constant.
  it('detects a drifted document', () => {
    expect(`${render()}\n<!-- hand-edited -->`).not.toBe(render());
  });

  it('is deterministic - two renders of the same inputs are byte-identical', () => {
    // A timestamp or a set-iteration order in the renderer would fail the build on every run and
    // train everyone to regenerate without reading the diff.
    expect(render()).toBe(render());
  });

  it('reports the reverse gap too: e2e specs no document claims', () => {
    // A test nobody knows is load-bearing is as much a documentation gap as an untested claim. It is
    // reported, never failed: sign-in and navigation journeys legitimately belong to no one spec.
    const out = render();
    expect(out).toContain('## e2e specs no document claims');
    const orphans = orphanE2eSpecs(specs, e2eSpecs);
    for (const o of orphans) expect(out).toContain(`\`${o}\``);
  });

  it('counts the same number of tests the suite declares', () => {
    // Cross-checks the counter against a second, independent walk of the files. A regex that silently
    // matched nothing would otherwise render "0 tests" against every row and read as a clean report.
    const total = e2eSpecs.reduce((n, f) => n + countTests(REPO_ROOT, f), 0);
    expect(total).toBeGreaterThan(80);
    expect(render()).toContain(`| e2e tests declared | ${total} |`);
  });

  it('counts NO disabled tests, because a disabled test must never read as coverage', () => {
    // `test.skip('name', fn)` DISABLES a test; `test.skip()` inside a body is a runtime gate on a test
    // that is otherwise real. Only the first form is a lie in this matrix, so it is asserted absent
    // rather than counted - and the counter above must not match it either.
    for (const f of e2eSpecs) {
      const src = fs.readFileSync(path.join(REPO_ROOT, 'tests', f), 'utf8');
      const disabled = src.match(/(?<![.\w])test\.(skip|fixme)\s*\(\s*['"`]/g) || [];
      expect(`${f}: ${disabled.join(', ')}`).toBe(`${f}: `);
    }
  });

  it('warns the reader not to hand-edit it, and names the command that regenerates it', () => {
    const out = render();
    expect(out).toContain('Do not edit by hand');
    expect(out).toContain('npm run gen-coverage-matrix');
  });
});

/**
 * A LIVE-BEHAVIOUR CLAIM MUST BE TIED TO AN END-TO-END TEST.
 *
 * The sibling gates ask weaker questions. PA-3 (`docs-drift-guard.test.ts`) asks whether an
 * `Implemented` claim names ANY verifying test - a unit test satisfies it. The `**Coverage:**`
 * validator above asks whether a document made a coverage DECISION - `none - <reason>` satisfies it.
 * Between them a document could say "Implemented", cite a mocked-table unit test, declare
 * `Coverage: none`, and pass the build while nothing had ever exercised the deployed path.
 *
 * That is not hypothetical. `SPEC-ABUSE-CONTROLS.md` did exactly this: unit tests against a mocked
 * table, `cdk-synth` assertions on the wiring, and a Status line claiming every phase - while the
 * spend budgets and circuit breaker were inert on the deployed environment and no test had ever
 * driven a request past a threshold. The unit tests could not see it; only reading the deployed
 * handler's env and driving a real turn could.
 *
 * So: a document claiming live behaviour (`Implemented` or `Partial`) must name at least one e2e
 * spec. The named spec is then also the regression gate - the same test that licensed the claim is
 * what re-proves it on every later change.
 *
 * RATCHET: `GRANDFATHERED_NO_E2E` lists the documents that already claimed live behaviour when this
 * gate landed and have no e2e spec yet. It may ONLY SHRINK. Writing the spec and naming it in the
 * document's `**Coverage:**` line means deleting the entry here (the test fails until you do both).
 * Do NOT add entries - that re-opens the hole. Each removal should be backed by a run of that spec
 * against a live deployment, which is the part this gate cannot check for you.
 */
const GRANDFATHERED_NO_E2E = new Set<string>([]);

describe('a live-behaviour claim is tied to an e2e spec', () => {
  const liveClaims = specs.filter(
    (s) => s.statusClass === 'implemented' || s.statusClass === 'partial',
  );

  it('found the live-behaviour claims (guards against a silently empty scan)', () => {
    expect(liveClaims.length).toBeGreaterThan(10);
  });

  it('every Implemented/Partial document names an e2e spec, or is a shrinking grandfather entry', () => {
    const violations: string[] = [];
    const seen = new Set<string>();

    for (const s of liveClaims) {
      const rel = s.path.split(path.sep).join('/');
      const grandfathered = GRANDFATHERED_NO_E2E.has(rel);
      if (grandfathered) seen.add(rel);
      const hasE2e = s.coverage.length > 0;

      if (hasE2e && grandfathered) {
        violations.push(
          `${rel}\n    now names an e2e spec - REMOVE it from GRANDFATHERED_NO_E2E (the baseline `
          + `only shrinks).`,
        );
      } else if (!hasE2e && !grandfathered) {
        violations.push(
          `${rel}\n    claims live behaviour ("${s.status.slice(0, 60)}") but names no e2e spec. A `
          + `unit test cannot see a contract with a deployed system: assert the deployed wiring and `
          + `drive the real path, then name that spec in the document's **Coverage:** line.`,
        );
      }
    }

    const stale = Array.from(GRANDFATHERED_NO_E2E).filter((p) => !seen.has(p));
    for (const p of stale) {
      violations.push(
        `${p}\n    is in GRANDFATHERED_NO_E2E but is no longer an uncovered live-behaviour claim `
        + `(renamed, deleted, or its Status changed). Remove the entry.`,
      );
    }

    if (violations.length) {
      throw new Error(`${violations.length} coverage-tie violation(s):\n\n${violations.join('\n\n')}\n`);
    }
    expect(violations).toEqual([]);
  });

  // Falsification: the ratchet must be able to fail in both directions, or it is decoration.
  //
  // Deliberately self-contained - it names no real document. An earlier version asserted against a
  // specific grandfathered path, which meant that removing that entry (the whole point of the
  // ratchet) broke this test for an unrelated reason. A falsification test that fails when the
  // codebase improves teaches people to delete falsification tests.
  it('the ratchet classifies both failing shapes, on synthetic inputs', () => {
    const classify = (coverage: string[], grandfathered: boolean) => {
      if (coverage.length > 0 && grandfathered) return 'remove-stale-entry';
      if (coverage.length === 0 && !grandfathered) return 'needs-e2e-spec';
      return 'ok';
    };

    expect(classify([], false)).toBe('needs-e2e-spec');           // a new uncovered claim
    expect(classify(['e2e/x.spec.ts'], true)).toBe('remove-stale-entry'); // baseline must shrink
    expect(classify(['e2e/x.spec.ts'], false)).toBe('ok');        // covered, not grandfathered
    expect(classify([], true)).toBe('ok');                        // known gap, still grandfathered
  });
});

describe('a new spec document cannot ship without a coverage decision', () => {
  it('every document under docs/specs is parsed by the guard, not just the ones it knows', () => {
    // The rule is enforced by ENUMERATION, not by an allowlist: a document added tomorrow is scanned
    // by the same walk, so it fails the build until it declares. Asserted explicitly because an
    // allowlist-shaped guard is the usual way this kind of check quietly stops covering new files.
    const walked = listSpecDocs(REPO_ROOT);
    expect(walked.length).toBe(specs.length);
    for (const p of walked) {
      const parsed = parseSpecDoc(REPO_ROOT, p);
      expect(parsed.declared).toBe(true);
    }
  });
});

describe("the README's e2e headline cannot drift from the generated matrix", () => {
  /**
   * WHY THIS GUARD EXISTS, AND WHY IT IS SLIGHTLY EMBARRASSING. The README paragraph that carries
   * these numbers ALSO warns, in its own prose, that "a hand-maintained inventory in this file drifted
   * to '~55 tests across 8 spec files' ... and nothing failed while it was wrong". It then carried a
   * second hand-maintained pair of numbers, unguarded, which drifted again: it read 144 tests / 39
   * spec files when the generated matrix said 151 / 41.
   *
   * Writing the lesson down in the same paragraph as the defect did not prevent the defect. A check
   * that can fail does. The README is the public front door, so the numbers are worth keeping - they
   * just have to be derived facts rather than remembered ones.
   */
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const HEADLINE = /\*\*(\d+) e2e tests across (\d+) spec files\*\*/;

  it('states the headline in the form this guard can check', () => {
    // Non-vacuity: if the sentence is reworded, this fails rather than silently checking nothing.
    expect(readme).toMatch(HEADLINE);
  });

  it('matches the counts computed from the specs and the e2e tree', () => {
    const [, tests, files] = HEADLINE.exec(readme)!;
    const expectedFiles = e2eSpecs.length;
    const expectedTests = e2eSpecs.reduce((n, f) => n + countTests(REPO_ROOT, f), 0);
    expect({ tests: Number(tests), files: Number(files) })
      .toEqual({ tests: expectedTests, files: expectedFiles });
  });
});
