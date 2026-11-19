/**
 * A TASK STATE SAYS A NOTICE WHEN IT IS ENTERED (ADR-067 WT23).
 *
 * What it proves: a state declares `notice: { to: requester | worker, template }` and nothing else there; the task service
 * names a task whose current state declares one; and the router says it once per entry, privately, to the requester or
 * the person who works it, from the template the state names.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { validateTaskStateMachine, type TaskStateMachine } from '../../lambda/src/lib/task-state-machines';

const M = (notice: unknown): TaskStateMachine => ({
  initial: 'asked',
  states: {
    asked: { transitions: ['done'], awaits: { party: 'requester' }, notice } as never,
    done: { transitions: [], terminal: 'success' },
  },
});

describe('a notice on entry', () => {
  it('is { to: room, requester, worker or a participant role, template, email? }', () => {
    expect(() => validateTaskStateMachine('m', M({ to: 'requester', template: 'workflow-task-assigned' }))).not.toThrow();
    expect(() => validateTaskStateMachine('m', M({ to: 'worker', template: 'workflow-task-assigned' }))).not.toThrow();
    expect(() => validateTaskStateMachine('m', M({ to: 'room', template: 'workflow-task-assigned', email: true }))).not.toThrow();
    expect(() => validateTaskStateMachine('m', M({ to: { participantRole: 'on-call:ops' }, template: 'workflow-task-assigned' }))).not.toThrow();
    for (const bad of [{ to: 'everyone', template: 'x' }, { to: { participantRole: 'Bad Name' }, template: 'x' }, { to: 'room', template: 'x', email: 'yes' }, { to: 'requester' }, { to: 'requester', template: 'Bad Name' }, { to: 'requester', template: 'x', text: 'hi' }]) {
      expect(() => validateTaskStateMachine('m', M(bad))).toThrow(/declares a notice/);
    }
  });

  it('a Target is one person: several are addressed by mention, in a message the room reads', () => {
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).toMatch(/const onePerson = args\.to\.length === 1 \? args\.to : \[\];/);
    expect(router).toMatch(/const audience = onePerson\.length \? 'addressed' as const : 'room' as const;/);
    expect(router).toMatch(/onePerson\.length && \{ Target: onePerson\.map/);
    expect(router).not.toMatch(/Target: args\.to\.map/);
  });

  it('the task service names it, and the router says it once per entry to the reader it names', () => {
    const service = readFileSync(resolve(__dirname, '../../lambda/src/task-service.ts'), 'utf8');
    expect(service).toMatch(/\?\.states\[task\.taskState\]\?\.notice\) \{\s*await nameTaskThroughRouter\(SERVICE_CLASSIFICATION, \{ kind: 'notice'/);
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    const fn = router.slice(router.indexOf('async function stateNoticeAudience('), router.indexOf('async function handleStateNotice(') + 3600);
    // ONE ENTRY, ONE NOTICE: the entry is the shared sequence, so a return to the first state is a new entry (0, then 1).
    expect(fn).toMatch(/const entries = entrySequenceOf\(task\.stateHistory, state\);[\s\S]*const entry = actionRunKey\(state, entries\);/);
    expect(fn).toContain("claimEventStep({ runKey: at.claimKey, channelArn: task.channelArn, step: entry, outcome: 'posted' })");
    expect(fn).toMatch(/notice\.to === 'requester' \? \(task\.userArn/);
    expect(fn).toMatch(/to: audience\.to/);
    // A PRIVATE TASK'S UPDATE to the room or a role is withheld, before anything is said or emailed.
    expect(fn).toMatch(/if \(isPrivateVisibility\(task\.visibility\)\) return nobody\('withheld'\)/);
    // THE ROOM'S EMAIL IS ASKED FOR, NOT ADDRESSED: the bridge reads the membership, each verified address and each preference.
    expect(fn).toMatch(/emailKind: 'conversation' as const, emailRoom: notice\.to === 'room'/);
    expect(fn).not.toMatch(/emailTo/);
  });
});
