/**
 * An assistant can see what its task has already handed over.
 *
 * A turn knew everything about the document it was writing and nothing about the one it wrote last
 * time. So an assistant asked "is this task complete?" could not see that it had already delivered the
 * report - and answered by starting the work again, while the finished document sat in the conversation
 * above it and the work item stayed open.
 *
 * CONTEXT, NOT A TRIGGER. Completion keeps its single path: the model calls `advance_task_state` and the
 * machine reaches terminal (invariant AT6, owner 2026-08-18 - "do not reintroduce a walker that
 * completes a task the model did not complete"). What was missing was never the authority to close a
 * task, it was knowing there was anything to close.
 */
import { buildTaskContextForPrompt } from '../../lambda/src/lib/task-tracking';
import type { Task } from '../../lambda/src/lib/task-tracking';
import { DeliveryOption } from '../../lambda/src/lib/delivery-options';

const base: Task = {
  taskId: 't-1',
  channelArn: 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1',
  userArn: 'arn:aws:chime:us-east-1:111:app-instance/i/user/u1',
  status: 'in_progress',
  deliveryOption: DeliveryOption.TASK_MULTI_STEP,
  taskType: 'report_generation',
  taskState: 'generating',
  requestExcerpt: 'Compile a report on our Q2 ARR performance',
  createdAt: '2026-08-20T18:00:00.000Z',
  updatedAt: '2026-08-20T20:47:35.450Z',
  ttl: 0,
};

describe('the task prompt carries what has already been delivered', () => {
  it('names the delivered file, when it went out, and the step it came from', () => {
    const prompt = buildTaskContextForPrompt({
      ...base,
      deliveries: [{ name: 'report-2026-08-20.md', at: '2026-08-20T20:47:35.450Z', fromState: 'generating' }],
    });

    expect(prompt).toContain('ALREADY DELIVERED');
    expect(prompt).toContain('report-2026-08-20.md');
    expect(prompt).toContain('2026-08-20T20:47:35.450Z');
    // The state it came from separates a draft from a final, which the model cannot infer from a name.
    expect(prompt).toContain('generating');
  });

  it('tells the assistant not to produce it again, and what to do instead', () => {
    const prompt = buildTaskContextForPrompt({
      ...base,
      deliveries: [{ name: 'report.md', at: '2026-08-20T20:47:35.450Z' }],
    });

    // The three things the live failure got wrong: it re-generated, it did not close, and it could not
    // answer the question that was actually asked.
    expect(prompt).toMatch(/do not produce it again/i);
    expect(prompt).toMatch(/advance the task to its final state/i);
    expect(prompt).toMatch(/asking whether it is\s*\n?done/i);
  });

  it('says nothing at all when the task has delivered nothing', () => {
    // A task mid-collection must not be told it delivered something, and an unchanged prompt is what
    // keeps this from disturbing every other turn.
    const prompt = buildTaskContextForPrompt({ ...base, taskState: 'collecting_requirements' });
    expect(prompt).not.toContain('ALREADY DELIVERED');
  });

  it('carries the most recent deliveries when a task delivered more than once', () => {
    // A revision delivers again. Both matter: the person has two files, and which one is current is
    // the question they are most likely to ask.
    const prompt = buildTaskContextForPrompt({
      ...base,
      deliveries: [
        { name: 'first.md', at: '2026-08-20T18:00:00.000Z' },
        { name: 'revised.md', at: '2026-08-20T20:00:00.000Z' },
      ],
    });
    expect(prompt).toContain('first.md');
    expect(prompt).toContain('revised.md');
  });
});
