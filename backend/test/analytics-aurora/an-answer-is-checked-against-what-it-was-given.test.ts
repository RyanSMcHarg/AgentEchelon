/**
 * AN ANSWER IS CHECKED AGAINST WHAT IT WAS GIVEN.
 *
 * A retrieval-augmented answer is normally judged on three questions: was the retrieved material
 * relevant, was the answer relevant, and is every claim SUPPORTED by what was retrieved. The
 * platform measured the second and not the third.
 *
 * Relevance asks whether the reply addressed the request, and a FABRICATED reply does address it. So
 * a confidently wrong answer citing a real document scored as excellent, and every column on the
 * Effectiveness surface read green on the one failure an operator most wants to catch.
 *
 * Three properties make this verdict trustworthy, and all three are ways it can quietly become a
 * lie instead:
 *
 *   1. NULL IS A STATE. A turn that retrieved nothing is UNRETRIEVED, not ungrounded. Coalescing
 *      either way invents a measurement.
 *   2. IT FAILS TO NULL. A judge that timed out has not found the reply unsupported; recording
 *      false would manufacture a breach out of an error.
 *   3. IT CHECKS AGAINST THE REAL PASSAGES, read from what the turn actually retrieved rather than
 *      from the reply's own citations - which is what made the existing "grounded" dimension in the
 *      flow rubric an unanchored opinion.
 */
import * as fs from 'fs';
import * as path from 'path';

const AURORA = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora');
const runner = fs.readFileSync(path.join(AURORA, 'evaluation-runner.ts'), 'utf8');
const migration = fs.readFileSync(
  path.join(AURORA, 'schema', '062-an-answer-is-checked-against-what-it-was-given.sql'),
  'utf8',
);
const core = fs.readFileSync(
  path.join(__dirname, '..', '..', 'lambda', 'src', 'lib', 'async-processor-core.ts'),
  'utf8',
);
const processor = fs.readFileSync(
  path.join(__dirname, '..', '..', 'lambda', 'src', 'assistant-async-processor.ts'),
  'utf8',
);

describe('the passages are persisted so the check can happen at all', () => {
  it('the turn records what it was given to answer from', () => {
    // They built the prompt and were then discarded, so nothing downstream could recompute what the
    // turn had seen - which is why the question could not be asked before.
    // `foundBy` names the retrieval leg (vector, lexical) that admitted the passage; the three fields
    // the evaluator reads are unchanged.
    expect(core).toContain(
      "retrievedPassages?: { sourceId: string; title: string; content: string; foundBy?: ('vector' | 'lexical')[] }[]",
    );
    expect(processor).toContain('retrievedPassages: grounding.retrievedContext.chunks.map');
  });

  it('rides the out-of-band record, never the size-capped Chime metadata', () => {
    const at = core.indexOf('const writeTurnAnalytics');
    expect(at).toBeGreaterThan(-1);
    expect(core.slice(at, at + 1600)).toContain('retrievedPassages: params.retrievedPassages');
  });

  it('is absent rather than empty when nothing was retrieved', () => {
    // An empty array reads as "retrieved nothing"; absence reads as "did not retrieve". The
    // evaluator distinguishes them, so the writer has to as well.
    const at = core.indexOf('const writeTurnAnalytics');
    expect(core.slice(at, at + 1600)).toContain('params.retrievedPassages?.length ?');
  });

  it('is scored in BATCH rather than on the reply path', () => {
    // Tenet D5: a best-effort side path never blocks a reply, and a groundedness judge is a second
    // model call. Persisting keeps evaluation re-runnable under a new rubric too.
    expect(processor).not.toContain('scoreGroundedness');
    expect(runner).toContain('async function scoreGroundedness');
  });
});

describe('the verdict has three states and NULL is one of them', () => {
  it('records NOT ASSESSED when the turn retrieved nothing', () => {
    const at = runner.indexOf('async function scoreGroundedness');
    const fn = runner.slice(at, at + 900);
    expect(fn).toContain('if (!passages.length) return NOT_ASSESSED(0);');
  });

  it('fails to NULL, never to a verdict', () => {
    // A judge that could not answer has not found the reply ungrounded.
    const at = runner.indexOf('async function scoreGroundedness');
    const fn = runner.slice(at, at + 3000);
    expect(fn).toContain('catch');
    expect(fn).toContain('NOT_ASSESSED(passages.length)');
    expect(fn).not.toMatch(/isGrounded:\s*false\s*[,}]/);
  });

  it('treats an omitted field as unanswered rather than unsupported', () => {
    const at = runner.indexOf('async function scoreGroundedness');
    expect(runner.slice(at, at + 3000)).toContain("typeof parsed.isGrounded !== 'boolean'");
  });

  it('records the passage count, so NULL can be read', () => {
    // Zero passages is WHY a row is null rather than false, and the count says whether a verdict was
    // made against enough material to mean anything.
    expect(runner).toContain('grounded.isGrounded, grounded.notes, grounded.passageCount, grounded.usedPassageCount,');
    expect(migration).toContain('retrieved_passage_count');
  });
});

describe('the judge checks against the real passages', () => {
  it('renders the retrieved passages into the prompt', () => {
    // The placeholder exists in the rubric, and the groundedness prompt is BUILT from it with the
    // passages supplied. Asserted on the render call rather than on `prompt = GROUNDEDNESS_PROMPT`
    // followed by a `.replace` chain: that pinned an assembly SHAPE, and the shape changed for a
    // reason this test should not fight. Every judge prompt now goes through `renderPrompt`, because
    // a chained `.replace` expands `$&` and `` $` `` in the substituted value - so a passage or a
    // message containing them spliced the surrounding rubric into the evidence.
    expect(runner).toContain('{{passages}}');
    expect(runner).toContain('renderPrompt(GROUNDEDNESS_PROMPT');
    // And the passages are what fills it. A rubric with the placeholder and no value would pass the
    // line above while sending the judge an empty evidence block.
    const at = runner.indexOf('renderPrompt(GROUNDEDNESS_PROMPT');
    expect(runner.slice(at, runner.indexOf('});', at))).toMatch(/passages\s*:/);
  });

  it('reads them from what the TURN retrieved, not from the reply', () => {
    // Scoring a reply against its own citations would be circular: a fabricated citation would
    // support a fabricated claim.
    expect(runner).toContain('function retrievedPassagesOf(metadata: unknown)');
    expect(runner).toContain('retrievedPassages');
  });

  it('treats an honest refusal as supported', () => {
    // Declining to invent is the correct behavior, and a rubric that scored it as unsupported would
    // punish the assistant for the thing this metric exists to encourage.
    expect(runner).toMatch(/does not know.*SUPPORTED|SUPPORTED.*Declining to invent/s);
  });

  it('carries its own rubric version, separate from relevance', () => {
    // A different prompt is a different measurement; sharing relevance's version would relabel rows
    // scored under a rubric that had not changed.
    expect(runner).toContain('const GROUNDEDNESS_RUBRIC_VERSION = componentVersion(GROUNDEDNESS_PROMPT);');
  });
});

describe('the migration says what NULL means', () => {
  it('adds the three columns', () => {
    for (const c of ['is_grounded', 'groundedness_notes', 'retrieved_passage_count']) {
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS ${c}`);
    }
  });

  it('states that unretrieved is not ungrounded', () => {
    expect(migration).toMatch(/unretrieved, not ungrounded/i);
  });

  it('is idempotent and transaction-safe', () => {
    const statements = migration.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    expect(statements).not.toContain('CONCURRENTLY');
    expect(statements.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).toHaveLength(3);
  });
});
