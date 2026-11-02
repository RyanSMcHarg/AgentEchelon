/**
 * A SCORE NAMES THE RUBRIC IT WAS JUDGED UNDER.
 *
 * `evaluator_model` records WHICH MODEL judged. It did not record what the model was ASKED, and the
 * two are different questions: the same model against a changed prompt produces scores that are not
 * comparable with the ones before it, under the same column name.
 *
 * Compliance solved this at migration 047 (`rule_set_version`). Migration 060 does it for the
 * relevance and flow rubrics, and this pins the properties that make the column trustworthy:
 *
 *   - it is DERIVED from the prompt, so it cannot drift from what was actually sent;
 *   - the flow version covers the WEIGHTS too, because re-weighting the five dimensions changes
 *     every composite without changing a word of the prompt;
 *   - a re-scored flow takes the CURRENT version, never keeping the old one;
 *   - the two rubrics version independently.
 *
 * Source assertions, because the column cannot be exercised without a database - and a mocked one
 * has no schema, which is how a uuid was compared to a varchar in this same file earlier today.
 */
import * as fs from 'fs';
import * as path from 'path';
import { componentVersion } from '../../lambda/src/lib/config-identity';

const AURORA = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora');
const runner = fs.readFileSync(path.join(AURORA, 'evaluation-runner.ts'), 'utf8');
const migration = fs.readFileSync(
  path.join(AURORA, 'schema', '060-a-score-names-the-rubric-it-was-judged-under.sql'),
  'utf8',
);

describe('the rubric version is derived, not declared', () => {
  it('derives the relevance version from the prompt itself', () => {
    expect(runner).toContain('const RELEVANCE_RUBRIC_VERSION = componentVersion(RELEVANCE_PROMPT);');
  });

  it('folds the dimension WEIGHTS into the flow version', () => {
    // Re-weighting outcome/information/efficiency/context/ux changes every composite while leaving
    // the prompt text identical. A version over the text alone would call those two runs the same.
    expect(runner).toContain(
      'const FLOW_RUBRIC_VERSION = componentVersion(FLOW_PROMPT + JSON.stringify(FLOW_WEIGHTS));',
    );
  });

  it('carries no hand-maintained version constant to forget', () => {
    // The failure mode this avoids: an edited prompt and an unbumped constant, so the column names
    // a rubric that did not produce the score. That is worse than no column, because it is trusted.
    expect(runner).not.toMatch(/RUBRIC_VERSION\s*=\s*['"`]v?\d/);
  });

  it('reuses the helper that already stamps a turn, rather than a second hash', () => {
    expect(runner).toContain("import { componentVersion } from '../lib/config-identity.js';");
  });
});

describe('both rubrics are recorded, independently', () => {
  it('Pass A writes the version of the rubric the row was ACTUALLY judged under', () => {
    const at = runner.indexOf('INSERT INTO evaluation_results');
    expect(at).toBeGreaterThan(-1);
    const stmt = runner.slice(at, at + 900);
    expect(stmt).toContain('rubric_version');
    // The version is passed with the score. NOT anchored on a trailing bracket: groundedness and
    // the sample stratum were added after this and moved it, failing a test about a different thing.
    //
    // A VARIABLE, NOT THE RELEVANCE CONSTANT. This asserted `RELEVANCE_RUBRIC_VERSION` literally,
    // which pinned the defect it was written to prevent: Pass A has TWO rubrics, and an
    // image_generation turn is judged by the vision judge under `IMAGE_RELEVANCE_PROMPT` and was
    // stamped with the relevance version anyway. The row then named a rubric it never saw, and
    // editing the image rubric moved no version at all, so old and new image scores pooled - inside
    // the one column whose whole job is to stop exactly that.
    expect(runner).toContain('verdict.ruleSetVersion, rubricVersion,');
  });

  it('the image judge carries its own version, so the two rubrics cannot pool', () => {
    // Two rubrics in one pass need two versions. One constant covering both is the same defect in a
    // different shape: indistinguishable rows, and a silent re-baseline whenever either is edited.
    expect(runner).toContain('const IMAGE_RELEVANCE_RUBRIC_VERSION = componentVersion(IMAGE_RELEVANCE_PROMPT);');
    expect(runner).toContain('rubricVersion = IMAGE_RELEVANCE_RUBRIC_VERSION;');
  });

  it('Pass B writes the flow version onto intent_flows', () => {
    const at = runner.indexOf('INSERT INTO intent_flows');
    expect(at).toBeGreaterThan(-1);
    const stmt = runner.slice(at, at + 1800);
    expect(stmt).toContain('rubric_version');
    expect(runner).toContain('FLOW_RUBRIC_VERSION,');
  });

  it('a re-scored flow takes the CURRENT rubric, not the one it was first scored under', () => {
    // A flow is re-scored when it gains turns. Leaving the old version would produce a row whose
    // scores came from one prompt and whose version names another.
    const at = runner.indexOf('INSERT INTO intent_flows');
    expect(runner.slice(at, at + 1800)).toContain('rubric_version = EXCLUDED.rubric_version');
  });

  it('the two versions differ, so one rubric changing does not relabel the other', () => {
    // Guards against both columns being fed the same constant, which would make the version useless
    // for telling which of the two prompts moved.
    const relevance = componentVersion('a relevance rubric');
    const flow = componentVersion('a flow rubric' + JSON.stringify({ outcome: 0.3 }));
    expect(relevance).not.toBe(flow);
  });
});

describe('the migration', () => {
  it('adds the column to BOTH tables the two rubrics write to', () => {
    expect(migration).toContain('ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS rubric_version');
    expect(migration).toContain('ALTER TABLE intent_flows ADD COLUMN IF NOT EXISTS rubric_version');
  });

  it('is idempotent and transaction-safe, because migrations apply at runtime in one transaction', () => {
    // STATEMENTS ONLY. The header explains why there is no CREATE INDEX CONCURRENTLY here, so a
    // whole-file search for the word matches the explanation and fails on a correct migration -
    // the same comment-versus-code confusion this suite has hit before.
    const statements = migration
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');

    expect(statements).not.toContain('CONCURRENTLY');
    expect(statements.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).toHaveLength(2);
    expect(statements.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).toHaveLength(2);
  });

  it('says what NULL means, so a reader segregates rather than coalesces', () => {
    // The pre-migration backlog is not "the current rubric", and a comparison across that boundary
    // is exactly what this column exists to let somebody refuse.
    expect(migration).toMatch(/NULL means/i);
    expect(migration.toLowerCase()).toContain('segregate');
  });
});
