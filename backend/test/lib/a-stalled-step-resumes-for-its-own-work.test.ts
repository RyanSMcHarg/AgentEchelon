/**
 * A STALLED STEP OF THE SPEAKER'S OWN WORK RESUMES; A RUNNING ONE, OR A DELIVERED ONE, STILL DECLINES.
 *
 * Measured live: a data extraction's turn showed the records and stopped at `extracting` without
 * advancing. The person's "the results look right, format the table and deliver it" then opened a second
 * task, and the extraction never delivered. The one-thread rule exists for the opposite case ("is this
 * task complete?" about a delivered report wrote it again), so the line is drawn on facts the platform
 * keeps: whether a turn holds the conversation, who owns the task, what the classifier labeled the
 * message, and whether anything was delivered.
 *
 * The router is not invocable from a unit test, so the decision is pinned here and its wiring is read
 * from the router's source, as `one-thread-per-piece-of-work.test.ts` does.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { isStalledStepCandidate, resumesAStalledStep } from '../../lambda/src/lib/task-continuity';

const PERSON = 'person-1';
const IDLE = { enabled: true, busy: false };

/** The stalled extraction from the live run: owed, idle, the owner speaking, labeled as the work, nothing delivered. */
const STALLED = {
  assistantOwesTheStep: true,
  turnQueue: IDLE,
  taskOwnerPersonId: PERSON,
  speakerPersonId: PERSON,
  labeledAsThisWork: true,
  deliveries: 0,
};

describe('the three cases', () => {
  it('a message while the step\'s turn is still running is declined: a second turn would do the work twice', () => {
    expect(resumesAStalledStep({ ...STALLED, turnQueue: { enabled: true, busy: true } })).toBe(false);
  });

  it('a stalled step, asked for by its owner as exactly that work, resumes', () => {
    expect(resumesAStalledStep(STALLED)).toBe(true);
  });

  it('a finished report the assistant owes only its close is declined: "is this task complete?" must not write it again', () => {
    expect(resumesAStalledStep({ ...STALLED, deliveries: 1 })).toBe(false);
  });
});

describe('anything the platform cannot vouch for keeps the decline', () => {
  it('the queue off, or its state unreadable, cannot tell running from stalled', () => {
    expect(resumesAStalledStep({ ...STALLED, turnQueue: null })).toBe(false);
    expect(resumesAStalledStep({ ...STALLED, turnQueue: { enabled: false, busy: false } })).toBe(false);
    expect(resumesAStalledStep({ ...STALLED, turnQueue: { enabled: true, busy: false, unreadable: true } })).toBe(false);
  });

  it('someone other than the task\'s owner does not resume it', () => {
    expect(resumesAStalledStep({ ...STALLED, speakerPersonId: 'person-2' })).toBe(false);
    expect(resumesAStalledStep({ ...STALLED, taskOwnerPersonId: undefined })).toBe(false);
    expect(resumesAStalledStep({ ...STALLED, speakerPersonId: undefined, taskOwnerPersonId: undefined })).toBe(false);
  });

  it('a message the classifier did not place as this work does not resume it', () => {
    expect(resumesAStalledStep({ ...STALLED, labeledAsThisWork: false })).toBe(false);
  });

  it('a task row that could not be read does not resume it', () => {
    expect(resumesAStalledStep({ ...STALLED, deliveries: null })).toBe(false);
  });

  it('a step the assistant does not owe is not this rule\'s to decide', () => {
    expect(resumesAStalledStep({ ...STALLED, assistantOwesTheStep: false })).toBe(false);
  });
});

describe('the candidate: a step this assistant holds, of the speaker\'s own work, labeled as that work', () => {
  const SELF = 'assistant-1';
  /** The live run's task: account_brief at `researching`, filed under its requester, looked up, never advanced. */
  const HELD = {
    task: { taskType: 'account_brief', ownerPersonId: PERSON, assistantId: SELF },
    awaitsAParty: false,
    selfAssistantId: SELF,
    speakerPersonId: PERSON,
    turnOpensTaskType: 'account_brief',
    keptHereAs: 'account_brief',
  };

  it('a held step of the speaker\'s work, asked for as that work, is a candidate', () => {
    expect(isStalledStepCandidate(HELD)).toBe(true);
    expect(isStalledStepCandidate({ ...HELD, turnOpensTaskType: undefined })).toBe(true);
    expect(isStalledStepCandidate({ ...HELD, task: { ...HELD.task, assistantId: undefined } })).toBe(true);
  });

  it('a step waiting on a party belongs to the awaited-answer path', () => {
    expect(isStalledStepCandidate({ ...HELD, awaitsAParty: true })).toBe(false);
  });

  it('another assistant\'s step, or another person\'s work, is not a candidate', () => {
    expect(isStalledStepCandidate({ ...HELD, task: { ...HELD.task, assistantId: 'assistant-2' } })).toBe(false);
    expect(isStalledStepCandidate({ ...HELD, speakerPersonId: 'person-2' })).toBe(false);
    expect(isStalledStepCandidate({ ...HELD, speakerPersonId: undefined })).toBe(false);
  });

  it('a message placed as other work is not a candidate', () => {
    expect(isStalledStepCandidate({ ...HELD, turnOpensTaskType: 'report_generation', keptHereAs: 'report_generation' })).toBe(false);
    expect(isStalledStepCandidate({ ...HELD, task: null })).toBe(false);
  });
});

describe('the router wires it as decided', () => {
  const router = readFileSync(resolve(__dirname, '../..', 'lambda/src/router-agent-handler.ts'), 'utf8');

  it('marks a candidate through one predicate, wherever the turn finds the task', () => {
    // In this assistant's own partition, and in the person's, where a task opened at a step the assistant
    // works is filed under its requester (the live account_brief run, declined at `researching`).
    expect(router).toContain('const stalled = ownLive.find((t) => stalledStepCandidateHere(t));');
    expect(router).toContain("applied.reason === 'not_awaiting' && stalledStepCandidateHere(answered)");
    const at = router.indexOf('const stalledStepCandidateHere =');
    expect(at).toBeGreaterThan(0);
    const def = router.slice(at, router.indexOf('});', at));
    expect(def).toContain('isStalledStepCandidate({');
    expect(def).toContain('awaitsAParty: !!awaitedPartyOf(');
    expect(def).toContain('selfAssistantId: principalIdFromArn(botArn)');
    expect(def).toContain('speakerPersonId: personId');
    // The same turn value every caller of the other-work rule reads (`new-work-is-not-the-awaited-answer.test.ts`).
    expect(def).toContain('turnOpensTaskType: turnOpensOtherWorkKey()');
    expect(def).toContain('keptHereAs: turnKeptHereAs()');
  });

  it('marks the candidate in the person\'s partition before the one-thread rule decides it', () => {
    const mark = router.indexOf("applied.reason === 'not_awaiting' && stalledStepCandidateHere(answered)");
    const decide = router.indexOf('resumesAStalledStep({');
    expect(mark).toBeGreaterThan(0);
    expect(mark).toBeLessThan(decide);
    expect(router.slice(mark, mark + 900)).toContain('stalledStepCandidate = true');
  });

  it('decides at the one-thread rule, reading the lock and the row\'s deliveries, before the decline', () => {
    const resume = router.indexOf('resumesAStalledStep({');
    const decline = router.indexOf('a turn is already owed on this task; declining to start a second');
    expect(resume).toBeGreaterThan(0);
    expect(resume).toBeLessThan(decline);
    const block = router.slice(router.lastIndexOf('const owedHere =', resume), decline);
    expect(block).toContain('stalledStepCandidate');
    expect(block).toContain('readTurnState({ channelArn, responderId: principalIdFromArn(botArn) })');
    expect(block).toContain('declineRow.deliveries?.length');
    expect(block).toContain('resumedWaitingWork = true');
  });

  it('names the held work to the classifier, so the label can be that work', () => {
    expect(router).toContain('(prefetchedOwnTasks?.live ?? []).filter((t) => t.ownerPersonId === personId)');
    expect(router).toContain('waitingWork: openWorkForThisPerson.map(');
  });
});
