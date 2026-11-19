/**
 * A REOPENED TASK STARTS ITS OWN RUN, ONCE PER REOPEN (ADR-067 decision 2, WT104, WT111).
 *
 * What it proves: \`task-reopened\` is an event a version declares one workflow on, whose person is the task's requester;
 * each reopen is its own run, keyed by the task and which reopen it is; the task service names a move from an ending into
 * a state with a way on, and only that; the router runs the version's workflow on it, read back from the row, with the
 * task's visibility; and the continuation reads the reopened task's row.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { eventWorkflowErrors, EVENTS_NAMING_A_PERSON, EVENTS_SELECTING_THEIR_WORKFLOW, TASK_REOPENED, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import { eventNaturalKey } from '../../lambda/src/lib/event-natural-key';

const APPROVE_AGAIN: EventWorkflow = {
  on: 'task-reopened',
  initial: 'tell',
  states: {
    tell: { send: { to: { people: 'event:person' }, template: 'workflow-step-withheld' }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
} as EventWorkflow;

describe('task-reopened', () => {
  it('is an event a version declares one workflow on, naming the task\'s requester as its person', () => {
    expect(TASK_REOPENED).toBe('task-reopened');
    expect(EVENTS_SELECTING_THEIR_WORKFLOW).toContain('task-reopened');
    expect(EVENTS_NAMING_A_PERSON).toContain('task-reopened');
    expect(eventWorkflowErrors('again', APPROVE_AGAIN)).toEqual([]);
  });

  it('keys each reopen as its own run, and names none without the task and its count', () => {
    expect(eventNaturalKey('task-reopened', 'arn:ch', undefined, undefined, undefined, { taskId: 't1', n: 1 })).toBe('reopen-t1-1');
    expect(eventNaturalKey('task-reopened', 'arn:ch', undefined, undefined, undefined, { taskId: 't1', n: 2 })).toBe('reopen-t1-2');
    expect(eventNaturalKey('task-reopened', 'arn:ch')).toBeUndefined();
    expect(eventNaturalKey('task-reopened', 'arn:ch', undefined, undefined, undefined, { taskId: 't1', n: 0 })).toBeUndefined();
  });

  it('the task service names a move from an ending into a state with a way on, and the router runs it from the row', () => {
    const service = readFileSync(resolve(__dirname, '../../lambda/src/task-service.ts'), 'utf8');
    expect(service).toMatch(/const wasEnding = [\s\S]{0,200}const nowOpen = [\s\S]{0,120}if \(wasEnding && nowOpen\) \{\s*await nameTaskThroughRouter\(SERVICE_CLASSIFICATION, \{ kind: 'reopened'/);
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).toMatch(/if \(r\.kind === 'reopened'\) return handleTaskReopened\(task\);/);
    const fn = router.slice(router.indexOf('async function handleTaskReopened('), router.indexOf('async function handleTaskReopened(') + 2500);
    expect(fn).toMatch(/declaredWorkflowOn\(served\?\.version\.eventWorkflows, 'task-reopened'\)/);
    expect(fn).toMatch(/privateRun: isPrivateVisibility\(task\.visibility\)/);
    expect(fn).toMatch(/reopened: \{ taskId: task\.taskId, n \}/);
    // Its continuation reads the reopened task's row, never the hand-back's word for who asked.
    expect(router).toMatch(/const reopenedTask = wf\.on === 'task-reopened' && req\.reopened\?\.taskId \? await getTask\(req\.reopened\.taskId, channelArn\) : undefined;/);
  });
});
