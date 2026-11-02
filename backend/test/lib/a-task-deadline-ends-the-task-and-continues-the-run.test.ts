/**
 * A TASK DEADLINE ENDS THE TASK AND CONTINUES THE RUN (ADR-063 slice T4, decision 4).
 *
 * What it proves: a task step's deadline is one one-shot schedule on the classification's own group, named from the
 * conversation and the task, whose input carries ids only and which deletes itself once fired; a firing is read as a
 * task firing only in its own shape; the router checks the firing against the records before anything runs and has the
 * task service cancel the task with the deadline's ending, which the settlement reads as `task:deadline`; settling and
 * archiving delete the schedule by name; and the run continues on `onDeadline`, else `onFailure`.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  createTaskDeadlineSchedule, deleteTaskDeadlineSchedule, deadlineFiringOf, taskDeadlineFiringOf, taskDeadlineScheduleName,
} from '../../lambda/src/lib/event-deadlines';
import { continueAfter, type EventRunDeps, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import { settlementOutcome, TASK_DEADLINE_ENDING } from '../../lambda/src/lib/workflow-task';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const CH = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const WIRING = { group: 'ae-standard-event-deadlines', roleArn: 'arn:aws:iam::1:role/sched', routerArn: 'arn:aws:lambda:us-east-1:1:function:router' };

describe('the schedule (decision 4)', () => {
  it('one schedule per task, ids only in its input, deleting itself once fired, on the classification\'s own group', async () => {
    const sent: any[] = [];
    const client = { send: async (c: any) => { sent.push(c.input); return {}; } };
    expect(await createTaskDeadlineSchedule(WIRING, { kind: 'task', channelArn: CH, taskId: 'evt-1' }, new Date('2027-01-01T00:00:00Z'), client)).toBe('created');
    const input = sent[0];
    expect(input.GroupName).toBe(WIRING.group);
    expect(input.Name).toBe(taskDeadlineScheduleName(CH, 'evt-1'));
    expect(input.Name).toMatch(/^tk-[0-9a-f]{20}-[0-9a-f]{20}$/);
    expect(input.ActionAfterCompletion).toBe('DELETE');
    expect(input.ScheduleExpression).toBe('at(2027-01-01T00:00:00)');
    expect(input.Target).toMatchObject({ Arn: WIRING.routerArn, RoleArn: WIRING.roleArn });
    expect(JSON.parse(input.Target.Input)).toEqual({ aeDeadline: { kind: 'task', channelArn: CH, taskId: 'evt-1' } });
  });

  it('a schedule already there is the same deadline, and one already gone is not an error', async () => {
    const conflict = { send: async () => { throw Object.assign(new Error('x'), { name: 'ConflictException' }); } };
    expect(await createTaskDeadlineSchedule(WIRING, { kind: 'task', channelArn: CH, taskId: 'evt-1' }, new Date(), conflict)).toBe('exists');
    const gone = { send: async () => { throw Object.assign(new Error('x'), { name: 'ResourceNotFoundException' }); } };
    expect(await deleteTaskDeadlineSchedule(WIRING, CH, 'evt-1', gone)).toBe('absent');
  });

  it('a task firing is read in its own shape, and never as an invitation\'s', () => {
    expect(taskDeadlineFiringOf({ kind: 'task', channelArn: CH, taskId: 'evt-1' })).toEqual({ kind: 'task', channelArn: CH, taskId: 'evt-1' });
    expect(taskDeadlineFiringOf({ kind: 'task', channelArn: 'nope', taskId: 'evt-1' })).toBeNull();
    expect(taskDeadlineFiringOf({ kind: 'task', channelArn: CH, taskId: 'a b' })).toBeNull();
    expect(deadlineFiringOf({ kind: 'task', channelArn: CH, taskId: 'evt-1' })).toBeNull();
  });
});

describe('firing means nothing until the router checks it, and the run continues on onDeadline (decision 4, F1)', () => {
  it('the deadline\'s cancel is read back as task:deadline', () => {
    expect(settlementOutcome({ taskType: 'acknowledgement', taskState: 'asked', status: 'cancelled', error: TASK_DEADLINE_ENDING }, DEFAULT_TASK_STATE_MACHINES)).toBe('task:deadline');
  });

  it('the router checks the conversation and the task, and has the task service cancel it; settled and archived delete the schedule', () => {
    const router = read('router-agent-handler.ts');
    const fired = router.slice(router.indexOf('export async function handleTaskDeadlineFired('), router.indexOf('export async function handleDeadlineFired('));
    expect(fired).toMatch(/tags\[CLASSIFICATION_TAG\] !== STATIC_CLASSIFICATION/);
    expect(fired).toMatch(/tags\.archived === 'true'/);
    expect(fired.indexOf('settlementOutcome(')).toBeLessThan(fired.indexOf('cancelForDeadline('));
    const settled = router.slice(router.indexOf('export async function handleTaskNaming('));
    expect(settled.indexOf('deleteTaskDeadline(')).toBeLessThan(settled.indexOf('handleEventContinuation('));
    expect(router).toMatch(/workflowTasksOf\(cancel\.channelArn\)/);
    const service = read('task-service.ts');
    expect(service).toMatch(/updateTaskStatus\(task\.taskId, task\.channelArn, 'cancelled', undefined, TASK_DEADLINE_ENDING\)/);
  });

  const WF: EventWorkflow = {
    on: 'assistant-joined', initial: 'ask',
    states: {
      ask: { task: { machine: 'acknowledgement', for: 'subject', by: 'subject', deadline: { afterMinutes: 5 } }, onSuccess: 'thanks', onFailure: 'done', onDeadline: 'chase' },
      thanks: { send: { to: 'subject', template: 'workflow-subject-welcome' }, onSuccess: 'done', onFailure: 'done' },
      chase: { send: { to: 'subject', template: 'workflow-subject-welcome' }, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  };
  const deps = () => {
    const sent: string[] = [];
    const claims = new Set<string>();
    const d: EventRunDeps = {
      claimRun: async () => true, claimStep: async (s) => !claims.has(s) && !!claims.add(s),
      mentionName: async () => 'Sam', send: async ({ step }) => { sent.push(step); return true; }, dispatchAgent: async () => true,
    };
    return { d, sent };
  };
  const ctx = { event: 'assistant-joined' as const, channelArn: CH, subject: 'arn:x/user/s', values: {} };

  it('the run takes onDeadline, and onFailure where the step declares none', async () => {
    const a = deps();
    await continueAfter('w', WF, ctx, { step: 'ask', outcome: 'task:deadline' }, a.d);
    expect(a.sent).toEqual(['chase']);
    const without = JSON.parse(JSON.stringify(WF));
    delete without.states.ask.onDeadline;
    const b = deps();
    await continueAfter('w', without, ctx, { step: 'ask', outcome: 'task:deadline' }, b.d);
    expect(b.sent).toEqual([]);
  });
});
