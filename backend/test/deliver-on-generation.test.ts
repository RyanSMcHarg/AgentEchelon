/**
 * Deliver-on-generation completion — the "report stuck in generating" fix.
 *
 * A document-producing task (report_generation / data_extraction) that DELIVERS its deliverable must
 * reach its terminal `completed` state. The model reliably WRITES the report/extraction but does not
 * reliably emit `advance_task_state` on the delivery turn, so the runtime walks the LEGAL transition
 * path to completion (advanceDeliveredTaskToCompletion). The pre-existing tests only asserted that the
 * lifecycle status FOLLOWS the machine terminal (shouldMarkTaskCompleted) — they never asserted that a
 * delivery actually ADVANCES the machine to `completed`, which is the gap that let the bug ship. These
 * tests assert the PROPER END STATE (taskState + the derived lifecycle status), the multi-hop walk, and
 * that already-terminal / machine-less tasks are left untouched (no double- or over-completion).
 *
 * Exercised with no persistence backend (TASKS_TABLE unset): advanceTaskStateTo authorizes + moves the
 * in-memory task, and the walk updates task.taskState between hops.
 */
import {
  advanceDeliveredTaskToCompletion,
  shouldMarkTaskCompleted,
  type Task,
} from '../lambda/src/lib/task-tracking.js';
import { DeliveryOption } from '../lambda/src/lib/delivery-options.js';
import { isDeliverableDocument } from '../lambda/src/lib/async-processor-core.js';

const task = (over: Partial<Task> = {}): Task => ({
  taskId: 't1',
  channelArn: 'arn:chan',
  userArn: 'arn:user',
  userMessage: 'make a board-ready report',
  status: 'in_progress',
  deliveryOption: DeliveryOption.TASK_MULTI_STEP,
  taskType: 'report_generation',
  taskState: 'generating',
  details: {},
  createdAt: 'x',
  updatedAt: 'x',
  ttl: 0,
  ...over,
});

describe('advanceDeliveredTaskToCompletion — a delivered report/extraction reaches its terminal state', () => {
  it('report_generation in `generating` advances to `completed` (the reported bug: was left in generating)', async () => {
    const t = task({ taskState: 'generating' });
    const r = await advanceDeliveredTaskToCompletion({ task: t });
    expect(r.ok).toBe(true);
    expect(r.hops).toBe(1); // generating -> completed, one legal hop
    expect(t.taskState).toBe('completed'); // PROPER END STATE
    // ...and the lifecycle status derived from that end state is now Completed (the whole point).
    expect(shouldMarkTaskCompleted(t.taskType, t.taskState)).toBe(true);
  });

  it('report_generation delivered from `drafting_outline` walks all the way to `completed` (the live-stuck case)', async () => {
    // The model reliably delivers the report but often never advances past drafting_outline, so this is
    // the state a delivered report is actually found in (verified live). The walk must reach completed.
    const t = task({ taskState: 'drafting_outline' });
    const r = await advanceDeliveredTaskToCompletion({ task: t });
    expect(r.ok).toBe(true);
    expect(r.hops).toBe(2); // drafting_outline -> generating -> completed
    expect(t.taskState).toBe('completed');
    expect(shouldMarkTaskCompleted(t.taskType, t.taskState)).toBe(true);
  });

  it('report_generation in `revising` advances to `completed` (a delivered revision closes the task)', async () => {
    const t = task({ taskState: 'revising' });
    const r = await advanceDeliveredTaskToCompletion({ task: t });
    expect(r.hops).toBe(1); // revising -> completed
    expect(t.taskState).toBe('completed');
  });

  it('data_extraction in `formatting` advances to `completed` (one hop)', async () => {
    const t = task({ taskType: 'data_extraction', taskState: 'formatting' });
    const r = await advanceDeliveredTaskToCompletion({ task: t });
    expect(r.hops).toBe(1);
    expect(t.taskState).toBe('completed');
    expect(shouldMarkTaskCompleted(t.taskType, t.taskState)).toBe(true);
  });

  it('data_extraction in `extracting` walks the FULL legal path to `completed` (no illegal jump)', async () => {
    const t = task({ taskType: 'data_extraction', taskState: 'extracting' });
    const r = await advanceDeliveredTaskToCompletion({ task: t });
    expect(r.hops).toBe(3); // extracting -> validating -> formatting -> completed
    expect(t.taskState).toBe('completed');
  });

  it('prefers the DIRECT completion edge over the `revising` detour (shortest legal path)', async () => {
    // generating -> {completed, revising}: the walk must take generating -> completed (1 hop),
    // never generating -> revising -> completed (2 hops).
    const t = task({ taskState: 'generating' });
    const r = await advanceDeliveredTaskToCompletion({ task: t });
    expect(r.hops).toBe(1);
    expect(t.taskState).toBe('completed');
  });

  it('is a no-op when already terminal (idempotent — never double-completes)', async () => {
    const t = task({ taskState: 'completed' });
    const r = await advanceDeliveredTaskToCompletion({ task: t });
    expect(r.hops).toBe(0);
    expect(t.taskState).toBe('completed');
  });

  it('is a no-op for a task with no state machine (leaves it untouched)', async () => {
    const t = task({ taskType: 'general', taskState: undefined });
    const r = await advanceDeliveredTaskToCompletion({ task: t });
    expect(r.hops).toBe(0);
    expect(t.taskState).toBeUndefined();
  });
});

describe('completeOnDelivery gate — only a REAL deliverable completes the task, not a long non-deliverable', () => {
  // The async processor sets `completeOnDelivery = isDeliverableDocument(response) && !battle` — deliberately
  // NOT on `generate`, whose length fallback (inDeliveryState && len>=400) also fires for a long status or
  // clarifying reply emitted WHILE already in a delivery state. These lock in that boundary: such a reply
  // must upload its doc but leave the task OPEN, never walk it to `completed`.

  it('a long plain-prose clarifying reply (no structure) is NOT a deliverable — task stays open', () => {
    // ~900 chars: would pass generate's len>=400 fallback, but has no heading/table/list.
    const longProse = (
      'I am still pulling the figures together and wanted to confirm one thing before I finalize. '
      + 'The revenue you asked about spans three regions and I need to know whether to break it out by '
      + 'month or just report quarterly totals, and whether to include the pipeline forecast alongside. '
    ).repeat(3);
    expect(longProse.length).toBeGreaterThanOrEqual(500); // clears generate's length fallback
    expect(isDeliverableDocument(longProse)).toBe(false);  // but is NOT completion-worthy
  });

  it('a substantial, STRUCTURED report (markdown heading) IS a deliverable — task completes', () => {
    const report = '# Q3 Revenue Report\n\n## Summary\n\n'
      + 'Revenue rose across all three regions this quarter versus the prior period. '.repeat(10);
    expect(report.length).toBeGreaterThanOrEqual(500);
    expect(isDeliverableDocument(report)).toBe(true);
  });

  it('length alone never qualifies: 600 chars of unstructured text is not a deliverable', () => {
    const bulk = 'the quarter went well and the numbers are strong '.repeat(13); // >600 chars, no structure
    expect(bulk.length).toBeGreaterThan(500);
    expect(isDeliverableDocument(bulk)).toBe(false);
  });
});
