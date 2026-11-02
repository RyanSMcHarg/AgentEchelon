/**
 * GUARDS FOR THE REVIEW FINDINGS WHOSE BEHAVIOR IS EXPENSIVE TO STAGE.
 *
 * Each of these is a property of a call site rather than of a function, so it is read from the source
 * the way the other structural guards in this suite are. Where a behavioral test was cheap, it lives
 * with its own subject instead; this file is only the remainder.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.resolve(ROOT, rel), 'utf8');

describe('an operator read observes the classification scope', () => {
  const src = read('lambda/src/task-service.ts');

  it('applies refusesChannel to both admin ops', () => {
    // IAM bounds which SERVICE a role may invoke and cannot condition on an `op` string, so a role
    // with invoke on its own service could reach any conversation's tasks by choosing an op that
    // skipped the check - and all three services share one table, so the row was there to read.
    expect(src).toContain('if (!channelArn || await refusesChannel(channelArn)) return [];');
    expect(src).toContain('if (!taskId || !channelArn || await refusesChannel(channelArn)) return false;');
  });

  it('costs the operator nothing, because admin-tasks asks every classification', () => {
    // The reason this is safe: the owning service still answers exactly as before.
    expect(read('lambda/src/admin-tasks.ts')).toMatch(/ASKED OF EVERY CLASSIFICATION/);
  });
});

describe('a finished task is not reopened by a late write', () => {
  const src = read('lambda/src/lib/task-tracking.ts');

  it('refuses a non-terminal status over a terminal one', () => {
    // The status write is dispatched asynchronously, and an async invoke is neither ordered nor
    // exactly-once: a retried `in_progress` can land after the `completed` that followed it.
    expect(src).toContain('ConditionExpression: TERMINAL_TASK_STATUS[status]');
    expect(src).toContain('NOT #status IN (:tCompleted, :tFailed, :tCancelled)');
  });

  it('declares those values ONLY when the condition uses them', () => {
    // A declared value no expression references is rejected by DynamoDB outright - the defect this
    // branch has already paid for once, in `a-command-declares-only-what-it-uses`.
    expect(src).toContain('if (!TERMINAL_TASK_STATUS[status]) {');
  });
});

describe('a message with nothing left in it still leaves the queue', () => {
  it('carries the emptied ids to the clear', () => {
    const triage = read('lambda/src/lib/turn-triage.ts');
    const core = read('lambda/src/lib/async-processor-core.ts');
    // Dropped silently, the id sat in `queued` forever: the notice never settled, the client kept
    // showing the wait, and every later notice re-entered triage to produce nothing.
    expect(triage).toContain('emptiedIds.push(messageId)');
    expect(core).toContain('triagedIds: [...event.triage.ids, ...(event.triage.accountedIds ?? [])]');
  });
});

describe('a broadcast answer does not go half private', () => {
  it('drops the placeholder target when delivery was moved to a public message', () => {
    // `broadcastTheAnswer` moves delivery to a NEW public message precisely BECAUSE the placeholder
    // was targeted, so it is exactly the case where the target is non-empty. Passing it made the
    // first chunk public and every chunk after it targeted.
    expect(read('lambda/src/lib/async-processor-core.ts'))
      .toContain('delivery.broadcastTheAnswer ? undefined : (answerTarget ?? placeholderTarget),');
  });
});

describe('the operator can actually cancel a task', () => {
  it('allows POST in the admin API preflight', () => {
    // The route existed and the authorizer was right; the browser refused the signed JSON POST
    // before it was ever sent, because the preflight answered Allow-Methods: GET,OPTIONS.
    // The preflight is derived from the routes the API serves, so the POST cancel route puts POST in it;
    // the synthesized Allow-Methods of both APIs is asserted in each-http-api-allows-the-origins-that-call-it.
    expect(read('lib/stacks/admin-services-stack.ts')).toContain("conversations('POST', '/admin/tasks/channel/{channelId}/cancel', tasksFn);");
    expect(read('lib/constructs/http-api.ts')).toContain("allowMethods: [...new Set(props.routes.map((r) => r.method as string)), 'OPTIONS']");
  });
});
