/**
 * A TASK REPORTS WHERE IT ENDED, not the alphabetically greatest value it ever held.
 *
 * THE DEFECT. The task list aggregated a task's turns with `MAX(task_status)`. `MAX` on a text column
 * is lexicographic, and of `pending | in_progress | completed | failed | cancelled | abandoned`,
 * `in_progress` sorts above every terminal value. So a task that had ever been in progress reported
 * `in_progress` for ever - and since a multi-step task is in progress by construction, EVERY report
 * showed `in_progress` while the state column beside it correctly showed `completed`. The column was
 * answering "was this ever started" under the label "Status (lifecycle)".
 *
 * The same shape sat on `MAX(intent)` in two places, where the consequence is quieter and worse: a
 * task's later turns classify on their own text, so a `data_extraction` task holding one `general`
 * turn reported `general`, because 'g' sorts above 'd'. The flow was then judged against the wrong
 * intent's expectations with nothing to show it had happened.
 *
 * WHAT THIS ASSERTS is the rule rather than the symptom: an aggregate over a task's turns takes the
 * value from a NAMED turn - the latest for a lifecycle, the first for the thing that opened it - and
 * never the value that happens to sort highest. These are string assertions over the SQL because the
 * bug is in the aggregate itself; a test that ran the query against fixture rows would pass on the old
 * code for any task whose turns happened to sort favourably, which is how it survived.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora');
const analyticsQuery = fs.readFileSync(path.join(SRC, 'analytics-query.ts'), 'utf8');
const evaluationRunner = fs.readFileSync(path.join(SRC, 'evaluation-runner.ts'), 'utf8');

/** The aggregates that must never be a bare MAX over a task's turns, and why. */
const ORDERED_NOT_MAX: Array<{ file: string; src: string; column: string; reason: string }> = [
  {
    file: 'analytics-query.ts',
    src: analyticsQuery,
    column: 'task_status',
    reason: 'in_progress sorts above every terminal status, so every multi-turn task reads in_progress for ever',
  },
  {
    file: 'analytics-query.ts',
    src: analyticsQuery,
    column: 'intent',
    reason: 'a data_extraction task holding one general turn reads general, because g sorts above d',
  },
  {
    file: 'evaluation-runner.ts',
    src: evaluationRunner,
    column: 'e.intent',
    reason: 'the flow is then judged against the wrong intent\'s expectations',
  },
];

describe('an aggregate over a task\'s turns names the turn it takes from', () => {
  it.each(ORDERED_NOT_MAX)('$file does not aggregate $column with a bare MAX', ({ src, column, reason }) => {
    const bare = new RegExp(`MAX\\(\\s*${column.replace('.', '\\.')}\\s*\\)`);
    if (bare.test(src)) {
      throw new Error(
        `MAX(${column}) picks by spelling, not by position: ${reason}. `
        + 'Take the value from a named turn instead - ARRAY_AGG(... ORDER BY created_at DESC)[1] for '
        + 'the latest, ASC for the one that opened the task.',
      );
    }
    expect(bare.test(src)).toBe(false);
  });

  it('the task list takes its status from the LATEST turn', () => {
    expect(analyticsQuery).toMatch(/ARRAY_AGG\(task_status ORDER BY created_at DESC\)\)\[1\] AS status/);
  });

  it('the task list takes its type from the turn that OPENED the task', () => {
    // ASC, not DESC: the opening turn is the one whose classification decided the task type. The last
    // turn of a report is often a confirmation that classifies as something else entirely.
    expect(analyticsQuery).toMatch(/ARRAY_AGG\(intent ORDER BY created_at ASC\)\)\[1\]/);
  });

  it('the flow scorer takes its intent from the turn that OPENED the flow', () => {
    expect(evaluationRunner).toMatch(/ARRAY_AGG\(e\.intent ORDER BY e\.created_at ASC\)\)\[1\] AS intent/);
  });

  it('the state column keeps taking the latest turn, which was always right', () => {
    // The line that got this right first, and the one whose comment named the reason. Kept asserted so
    // a future edit does not "make them consistent" by reverting it to MAX.
    expect(analyticsQuery).toMatch(/ARRAY_AGG\(task_state ORDER BY created_at DESC\)\)\[1\] AS task_state/);
  });
});

describe('the aggregates that ARE safe stay explained', () => {
  it('assistant is grouped per channel, so its MAX has one distinct value to pick', () => {
    // Not a bug, and worth pinning: this MAX is safe only because the GROUP BY includes channel_arn
    // and a channel carries one classification. If the grouping ever loses channel_arn, this becomes
    // the same defect as the ones above.
    expect(evaluationRunner).toMatch(/GROUP BY e\.task_id, e\.channel_arn/);
    expect(evaluationRunner).toMatch(/MAX\(e\.assistant\) AS assistant/);
  });
});
