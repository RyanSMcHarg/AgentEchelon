/**
 * A TASK STEP'S DEADLINE IS ONE OF THREE KINDS (ADR-067 G5, WT21).
 *
 * What it proves: a deadline declares `kind` (timeout, due or remind) and, on remind only, `times` up to the cap; a due
 * time is shown on the task and schedules nothing that ends it; a reminder repeats up to its cap, says its template to the
 * person who holds the task, and moves nothing; and only a timeout is scheduled to end the task.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { taskStepErrors, MAX_TASK_REMINDERS } from '../../lambda/src/lib/task-step';
import { taskReminderFiringOf } from '../../lambda/src/lib/event-deadlines';

const step = (deadline: unknown) => ({ machine: 'acknowledgement', for: 'subject', by: 'subject', deadline });
const errs = (deadline: unknown) => taskStepErrors(step(deadline), 's', { personErrors: () => [] });

describe('a deadline\'s kind', () => {
  it('is timeout, due or remind, and only a reminder says how many', () => {
    expect(errs({ afterMinutes: 60 })).toEqual([]);
    expect(errs({ afterMinutes: 60, kind: 'due' })).toEqual([]);
    expect(errs({ afterMinutes: 60, kind: 'remind', times: MAX_TASK_REMINDERS })).toEqual([]);
    expect(errs({ afterMinutes: 60, kind: 'later' }).join()).toMatch(/deadline\.kind is timeout, due, remind/);
    expect(errs({ afterMinutes: 60, kind: 'due', times: 2 }).join()).toMatch(/times is on a remind deadline only/);
    expect(errs({ afterMinutes: 60, kind: 'remind', times: MAX_TASK_REMINDERS + 1 }).join()).toMatch(/times is on a remind deadline only/);
  });

  it('a reminder\'s schedule carries ids and which reminder it is, and nothing else', () => {
    expect(taskReminderFiringOf({ kind: 'remind', channelArn: 'arn:x/channel/c', taskId: 'evt-1', n: 2 })).toEqual({ kind: 'remind', channelArn: 'arn:x/channel/c', taskId: 'evt-1', n: 2 });
    expect(taskReminderFiringOf({ kind: 'remind', channelArn: 'arn:x/channel/c', taskId: 'evt-1', n: 6 })).toBeNull();
  });

  it('only a timeout is scheduled to end the task; a due time is shown; a reminder moves nothing and stops at its cap', () => {
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).toMatch(/kind === 'timeout' \? \{ deadlineAt: dueAt, ttlSeconds:/);
    expect(router).toMatch(/kind === 'due' \? \{ dueBy: new Date\(dueAt \* 1000\)\.toISOString\(\) \}/);
    expect(router).toMatch(/if \(kind === 'remind' && dueAt !== undefined\) await scheduleTaskReminder\(ctx\.channelArn, task\.taskId, 1, dueAt\);/);
    const fn = router.slice(router.indexOf('async function handleTaskReminderFired('), router.indexOf('async function handleTaskReminderFired(') + 2600);
    expect(fn).toMatch(/if \(firing\.n > remind\.times\) return/);
    expect(fn).toMatch(/template: 'workflow-task-reminder'/);
    expect(fn).toMatch(/if \(firing\.n < remind\.times\) await scheduleTaskReminder\(/);
    expect(fn).not.toMatch(/advance|cancelForDeadline|updateTaskStatus/);
  });
});
