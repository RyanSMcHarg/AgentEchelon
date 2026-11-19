/**
 * NEW WORK OF ANOTHER KIND IS NOT THE AWAITED ANSWER.
 *
 * Measured live: a report waited on its scope, and "Separately, walk me through diagnosing a failed
 * deployment" (classified `guided_troubleshooting`, high confidence) was worked as a report turn. It
 * was answered, and the troubleshooting it asked for was never opened, listed or tracked. A message
 * whose intent opens a different task type opens its own task; the waiting task stays where it was.
 */
import { opensOtherWorkThan, reopenableFollowUpSubject } from '../../lambda/src/lib/task-continuity';
import { intentKeptHere } from '../../lambda/src/lib/delegation';
import { PLATFORM_TASK_MACHINE_KEYS } from '../../lambda/src/lib/task-state-machines';

const report = { taskType: 'report_generation' };
/** This assistant's own taxonomy: it declares a report, as the advisor roommate does. */
const ownPack = { intents: [{ key: 'report_generation' }, { key: 'general' }] } as Parameters<typeof intentKeptHere>[1];
const opens = (task: Parameters<typeof opensOtherWorkThan>[0]['task'], turnOpensTaskType: string | undefined, namedByThePerson = false, inADuel = false) =>
  opensOtherWorkThan({
    task, turnOpensTaskType, namedByThePerson, platformTaskTypes: PLATFORM_TASK_MACHINE_KEYS, inADuel,
    keptHereAs: turnOpensTaskType ? intentKeptHere(turnOpensTaskType, ownPack) : undefined,
  });

describe('whether a message opens other work than the task waiting on its sender', () => {
  it('a request that opens a different task type is new work', () => {
    expect(opens(report, 'guided_troubleshooting')).toBe(true);
  });

  it('an answer of the same kind is the awaited answer', () => {
    expect(opens(report, 'report_generation')).toBe(false);
  });

  it('a message that opens no task is the awaited answer: "the audience is engineering leadership"', () => {
    expect(opens(report, undefined)).toBe(false);
  });

  it('an item the person NAMED is the one they are answering, whatever the intent', () => {
    expect(opens(report, 'guided_troubleshooting', true)).toBe(false);
  });

  it('an answer to a platform machine is the answer: a queue clarification is often a whole request', () => {
    for (const taskType of PLATFORM_TASK_MACHINE_KEYS) {
      expect(`${taskType}:${opens({ taskType }, 'report_generation')}`).toBe(`${taskType}:false`);
    }
  });

  it('in a conversation holding a live duel, the duel owns the exchange', () => {
    // Read from the battle record by the caller: the mirror rows the router holds carry no battleId.
    expect(opens(report, 'guided_troubleshooting', false, true)).toBe(false);
  });

  it("a roommate's key is another assistant's work, so it is other work", () => {
    expect(opens(report, 'delegate__ops-premium__deployment_health')).toBe(true);
  });

  it("a roommate's key for the waiting task's own kind of work is the awaited answer", () => {
    // The advisor advertises `report_generation` too. If the handover does not happen, the turn is kept
    // here as `report_generation` (`intentKeptHere`), so setting the waiting report aside would strand
    // its answer while the turn opened a second report.
    expect(opens(report, 'delegate__advisor__report_generation')).toBe(false);
  });

  it("a roommate's key that reads back to anything else is still other work", () => {
    // `deployment_health` is not this assistant's, so it reads back to `general`, not to the report.
    expect(opens(report, 'delegate__advisor__deployment_health')).toBe(true);
  });

  it('a finished report is still offered to a roommate key for the same work', () => {
    const base = {
      task: { taskType: 'report_generation', taskState: 'delivered', status: 'completed', assistantId: 'me', ownerPersonId: 'p1' },
      endedWithinWindow: true, assistantId: 'me', senderSub: 'p1', reopenTargets: () => ['drafting'],
    };
    const key = 'delegate__advisor__report_generation';
    expect(reopenableFollowUpSubject({ ...base, turnOpensTaskType: key, keptHereAs: intentKeptHere(key, ownPack) })).toBe(true);
    const other = 'delegate__advisor__deployment_health';
    expect(reopenableFollowUpSubject({ ...base, turnOpensTaskType: other, keptHereAs: intentKeptHere(other, ownPack) })).toBe(false);
  });

  it('nothing waiting is nothing to absorb the message', () => {
    expect(opens(null, 'guided_troubleshooting')).toBe(false);
  });
});

/** The router is not invocable from a unit test, so what is held here is where the rule is applied. */
describe('the router applies the rule to both waiting lookups', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const router: string = fs.readFileSync(
    path.resolve(__dirname, '../..', 'lambda/src/router-agent-handler.ts'),
    'utf8',
  );

  it("the person's waiting tasks are tried in order, and one the message is other work for is passed over", () => {
    expect(router).toContain('for (const t of waitingCandidates) {');
    expect(router).toContain('if (!(await otherWorkThan(t, duelHere))) { answered = t; break; }');
    // An item the person named is fixed.
    expect(router).toContain('let answered = referenced ?? null;');
  });

  it("the assistant's own waiting chain is not resumed by it", () => {
    expect(router).toContain('if (mine && blockedOnAPerson && !(await otherWorkThan(mine, duelHere))) {');
  });

  it('one helper asks the rule for both waiting lookups, and reads the duel only when the rule sets a task aside', () => {
    expect(router.match(/opensOtherWorkThan\(\{/g)?.length).toBe(1);
    expect(router).toMatch(/inADuel: false,\s*\}\);\s*return other && !\(await inADuel\(\)\);/);
  });

  it("the classifier's decision on a task it was offered comes first; the rule decides only where it was not offered", () => {
    expect(router).toContain('const placed = placementSetsAside(classification, task, { opens: turnOpensOtherWorkKey(), keptHere: turnKeptHereAs() });');
    expect(router).toMatch(/const other = placed !== undefined\s*\? placed\s*: opensOtherWorkThan\(\{/);
  });

  it("a placement elsewhere that names the waiting task's own work continues that task, so no second one of its kind opens", () => {
    const { placementSetsAside } = require('../../lambda/src/router-agent-handler');
    const A = { taskId: 'task-a', taskType: 'report_generation' };
    expect(placementSetsAside({ waitingWorkDecided: ['task-a'] }, A, { opens: 'report_generation', keptHere: 'report_generation' })).toBe(false);
    expect(placementSetsAside({ waitingWorkDecided: ['task-a'] }, A, { opens: 'data_extraction', keptHere: 'data_extraction' })).toBe(true);
    expect(placementSetsAside({}, A, { keptHere: 'report_generation' })).toBeUndefined();
  });

  it("a message the classifier placed in one of two waiting tasks of a kind is that one's, never the newer one's", () => {
    const { placementSetsAside } = require('../../lambda/src/router-agent-handler');
    const newer = { taskId: 'task-a', taskType: 'report_generation' };
    const older = { taskId: 'task-b', taskType: 'report_generation' };
    const decision = { waitingWorkDecided: ['task-a', 'task-b'], continuesTask: { taskId: 'task-b', taskType: 'report_generation' } };
    const turn = { opens: 'report_generation', keptHere: 'report_generation' };
    expect(placementSetsAside(decision, newer, turn)).toBe(true);
    expect(placementSetsAside(decision, older, turn)).toBe(false);
  });

  it('a turn that continues an offered task is recorded as continuing it, whether the classifier named its place or its label', () => {
    expect(router).toContain("return routed ? { routedAs: routed === 'own_intent' && continued ? 'continues_task' as const : routed } : {};");
    expect(router).toContain('const continued = !isNewTaskForBattle && activeTask && classification.waitingWorkDecided?.includes(activeTask.taskId);');
  });

  it('every caller reads the same rule, roommate keys included', () => {
    expect(router).not.toContain('turnOpensTaskType: turnMachines[classification.intent]');
    expect(router).not.toContain('turnOpensTaskType: turnOpensTaskType()');
    // The other-work helper, the finished-report follow-up and the stalled-step lookup.
    expect(router.match(/turnOpensTaskType: turnOpensOtherWorkKey\(\)/g)?.length).toBe(3);
    // Each compares what a roommate key reads back to here, the mapping the kept turn uses.
    expect(router.match(/keptHereAs: turnKeptHereAs\(\)/g)?.length).toBe(3);
  });
});
