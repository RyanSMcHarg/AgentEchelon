/**
 * THE JUDGE IS NOT TOLD THE INTENT IT IS CHECKING.
 *
 * Pass A used to render `intent=${ex.intent}` into the prompt as established fact and ask the judge
 * to score the reply's contribution to that task. Handing a judge the label it is assessing is a
 * documented failure mode, and the cost here was specific: if routing was wrong, the judge was
 * anchored to the wrong frame and could score a reply as highly relevant TO AN INTENT THE PERSON
 * NEVER WANTED.
 *
 * WHY THAT MATTERED MORE THAN A BIAS. The console reports three readings of quality and presents
 * them as independent. Routing confidence is the classifier grading itself. Post-hoc evaluation was
 * meant to be the second, independent reading, and with the intent in the prompt it inherited the
 * decision it was supposed to check. That left the user signal - voluntary, and so a floor rather
 * than a measurement - as the only reading able to contradict a bad routing decision.
 *
 * WHAT DELIBERATELY STAYS: the task framing. That a turn is a step in a longer task is a fact about
 * SHAPE, not about routing, and removing it would reintroduce the isolated-exchange bias where a
 * correct partial step is marked down for being partial.
 */
import * as fs from 'fs';
import * as path from 'path';

const RUNNER = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'evaluation-runner.ts');
const runner = fs.readFileSync(RUNNER, 'utf8');

/** The source with comment lines removed: prose explaining the removal is not the prompt. */
const code = runner
  .split('\n')
  .filter((l) => {
    const t = l.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

describe('the relevance judge is not handed the classifier conclusion', () => {
  it('does not interpolate the intent into the prompt', () => {
    // The exact shape of the defect, asserted against code rather than the whole file so the
    // comment recording why it was removed does not satisfy it.
    expect(code).not.toMatch(/intent=\$\{/);
  });

  it('does not pass ex.intent into the task framing at all', () => {
    const at = code.indexOf('const taskContext =');
    expect(at).toBeGreaterThan(-1);
    expect(code.slice(at, at + 400)).not.toContain('ex.intent');
  });

  it('still tells the judge the turn is part of a multi-step task', () => {
    // Shape, not routing. Without it a correct partial step is scored down for being partial.
    const at = code.indexOf('const taskContext =');
    const block = code.slice(at, at + 400);
    expect(block).toContain('multi-step task');
    expect(block).toContain('contribution to that task at this step');
  });

  it('keeps the framing conditional on there being a task', () => {
    // A one-shot turn gets no task line, so nothing invites the judge to look for a step that does
    // not exist.
    const at = code.indexOf('const taskContext =');
    expect(code.slice(at, at + 400)).toContain('ex.task_id');
  });
});

describe('the change is safe to make because the rubric is versioned', () => {
  it('the version is derived from this prompt, so the wording change relabels the rows', () => {
    // This is the whole reason the prompt could be touched. Rows scored under the old wording carry
    // a different rubric_version, so a reader can segregate instead of comparing across the change.
    expect(code).toContain('const RELEVANCE_RUBRIC_VERSION = componentVersion(RELEVANCE_PROMPT);');
  });

  it('the intent is still RECORDED on the row, just not shown to the judge', () => {
    // Removing it from the prompt must not remove it from the record: the dashboard groups by
    // intent, and a score that cannot be attributed to one is not usable.
    const at = code.indexOf('INSERT INTO evaluation_results');
    expect(at).toBeGreaterThan(-1);
    expect(code.slice(at, at + 900)).toContain('intent');
    expect(code).toContain('ex.intent,');
  });
});

// ── THE RULE BINDS PASS B TOO, AND THIS HALF WAS UNGUARDED ──────────────────────────────────────
//
// The assertions above match `intent=${...}`, the shape Pass A used. Pass B renders a `{{intent}}`
// PLACEHOLDER instead, so every check in this file passed while `FLOW_PROMPT` handed the flow judge
// the classifier's conclusion as established fact - the exact thing the file is named for, in the
// other judge, invisible to a guard written against one spelling.
//
// A rule enforced against one syntax is a rule enforced against one author's habit.
describe('Pass B is not told the intent either', () => {
  it('FLOW_PROMPT does not carry the intent, in either spelling', () => {
    const at = code.indexOf('const FLOW_PROMPT =');
    expect(at).toBeGreaterThan(-1);
    const end = code.indexOf('`;', at);
    const flowPrompt = code.slice(at, end);
    expect(flowPrompt).not.toMatch(/\{\{\s*intent\s*\}\}/);
    expect(flowPrompt).not.toMatch(/intent=\$\{/);
    // The heading it sat under is gone with it, so a reader cannot conclude the label is implied.
    expect(flowPrompt).not.toMatch(/^Intent:/m);
  });

  it('the flow render passes no intent field', () => {
    // The placeholder and the value are two edits. Removing one and not the other leaves a prompt
    // that reads clean and a renderer still handing the value over for the next placeholder to use.
    const at = code.indexOf('renderPrompt(FLOW_PROMPT');
    expect(at).toBeGreaterThan(-1);
    const call = code.slice(at, code.indexOf('});', at));
    expect(call).not.toMatch(/\bintent\s*:/);
  });

  it('the flow row still records the intent it was grouped under', () => {
    // Same contract as Pass A: withheld from the judge, kept on the record.
    const at = code.indexOf('INSERT INTO intent_flows');
    expect(at).toBeGreaterThan(-1);
    expect(code.slice(at, at + 900)).toContain('intent');
  });

  it('the flow version is derived from the flow prompt, so the change relabels those rows', () => {
    expect(code).toContain('const FLOW_RUBRIC_VERSION = componentVersion(FLOW_PROMPT');
  });
});
