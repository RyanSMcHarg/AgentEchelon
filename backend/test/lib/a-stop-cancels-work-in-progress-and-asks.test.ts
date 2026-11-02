/**
 * COMPLETED WORK IS KEPT, WORK IN PROGRESS IS CANCELLED, THEN THE PERSON IS ASKED HOW TO PROCEED
 * (ADR-033, owner 2026-09-14).
 *
 * `/stop` means "stop what you are doing". The work still running is what the assistant is doing, so
 * it is cancelled at the stop; the work already finished is not in the selection at all. What the
 * cancel cannot tell apart is whether they wanted the work abandoned or wanted it again in another
 * shape, and that is asked rather than guessed.
 *
 * ── THE TWO HALVES, AND WHY THEY MUST NOT SWAP PLACES ───────────────────────────────────────────
 *
 * The DETERMINISTIC half suppresses the running answer and cancels the work. It takes no model call and
 * must not: a person who says stop has removed the ambiguity themselves, and making them wait on a
 * judgement to have it honored is the design failing at its most visible moment.
 *
 * The JUDGED half asks how to proceed. It is dispatched BEHIND the acknowledgment, so a model call can
 * never sit between the person asking things to stop and being told they had.
 *
 * ── THE FAILURE THIS FILE EXISTS TO CATCH ───────────────────────────────────────────────────────
 *
 * A line that says something other than what happened: "cancelled" when the cancel failed, a promised
 * question when none was dispatched, or "holding it" when it is gone. Asserted against the router
 * SOURCE, because observing it needs a whole Lex turn and the property is a one-line edit away from
 * being untrue.
 */
import { shippedLineText } from '../../lambda/src/lib/message-lines';
import {
  buildStopEvaluationPrompt,
  parseStopEvaluationContext,
} from '../../lambda/src/lib/stop-evaluation';

describe('the context that marks the judged turn', () => {
  it('reads a well-formed count', () => {
    expect(parseStopEvaluationContext(JSON.stringify({ heldCount: 2 }))).toEqual({ heldCount: 2 });
  });

  it('accepts a stop that cancelled nothing', () => {
    // Legitimate rather than an error: the turn must be recognisable so it does not claim the
    // conversation.
    expect(parseStopEvaluationContext(JSON.stringify({ heldCount: 0 }))).toEqual({ heldCount: 0 });
  });

  it('refuses a malformed or absent context', () => {
    // Undefined means ORDINARY TURN, which is every turn but these. A half-parsed context would make
    // an ordinary message skip the turn claim, which is the duplicate-answer defect the lock exists
    // to prevent arriving through a parse.
    expect(parseStopEvaluationContext(undefined)).toBeUndefined();
    expect(parseStopEvaluationContext('not json')).toBeUndefined();
    expect(parseStopEvaluationContext(JSON.stringify({}))).toBeUndefined();
    expect(parseStopEvaluationContext(JSON.stringify({ heldCount: -1 }))).toBeUndefined();
    expect(parseStopEvaluationContext(JSON.stringify({ heldCount: 'two' }))).toBeUndefined();
  });
});

describe('what the assistant is asked to work out', () => {
  const prompt = buildStopEvaluationPrompt({
    cancelledLabels: ['the Q3 headcount report'],
    precedingMessage: 'actually, what was Q3 headcount?',
  });

  it('names the work that was cancelled', () => {
    expect(prompt).toContain('the Q3 headcount report');
  });

  it('tells the assistant the work in progress is cancelled and finished work is kept', () => {
    // If the prompt implied the work was still held, the assistant would offer to carry on with it,
    // and the reply would contradict what the stop did.
    expect(prompt).toMatch(/has been cancelled/i);
    expect(prompt).toMatch(/already\s+finished for them is kept/i);
    expect(prompt).not.toMatch(/not cancelled/i);
  });

  it('asks it to read WHY, and to admit when it cannot tell', () => {
    expect(prompt).toMatch(/what you think\s+prompted it/i);
    expect(prompt).toMatch(/not sure/i);
  });

  it('asks how to proceed and forbids starting it again on its own', () => {
    // The whole reason this turn exists is that the choice is theirs.
    expect(prompt).toMatch(/Ask them how they want to proceed/i);
    expect(prompt).toMatch(/leave it cancelled, or start it again/i);
    expect(prompt).toMatch(/Do NOT decide for them/);
    expect(prompt).toMatch(/do not start any of it again/i);
  });

  it('carries what they said just before stopping, when there is any', () => {
    expect(prompt).toContain('actually, what was Q3 headcount?');
    expect(buildStopEvaluationPrompt({ cancelledLabels: ['x'] })).not.toMatch(/just before stopping/);
  });

  it('says so plainly when nothing was in progress', () => {
    expect(buildStopEvaluationPrompt({ cancelledLabels: [] }))
      .toMatch(/no recorded piece of work in progress/i);
  });

  it('forbids naming a private request\'s contents, because the reply is room-visible', () => {
    expect(prompt).toMatch(/do not name or guess at its contents/i);
  });
});

/**
 * A PRIVATE TASK IS VISIBLE IN THAT IT EXISTS, NOT IN WHAT IT IS (maintainer decision, 2026-08-23).
 *
 * The evaluation's reply posts to the room. A cancelled private task must reach its prompt as a
 * neutral label - existence, never the excerpt - or the stop of a targeted request publishes the one
 * thing targeting withheld.
 */
describe('a cancelled private task is named without being described', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');

  it('withholds the excerpt unless the row EXPLICITLY says conversation', () => {
    const labels = /cancelledLabels:[\s\S]{0,900}?\)\),/.exec(SRC)?.[0] || '';

    // ABSENT MEANS PRIVATE HERE, through the one rule every reader uses (`task-visibility.ts`, pinned
    // in task-visibility.test.ts). A task opened from a targeted message can carry no visibility at
    // creation and is narrowed only later in the turn - the window /stop is used in.
    expect(labels).toContain('!isPrivateVisibility(full.visibility)');
    expect(labels).not.toContain("?? 'conversation'");
    expect(labels.indexOf('!isPrivateVisibility(full.visibility)')).toBeLessThan(labels.indexOf('requestExcerpt'));
    expect(labels).toContain('a private request');
  });

  it('selects the work AS the requester, so their own private task is findable', () => {
    const sel = require('fs').readFileSync(
      require('path').join(__dirname, '../../lambda/src/lib/task-tracking.ts'), 'utf8');
    expect(sel).toMatch(/selectStoppableTasks[\s\S]{0,900}?viewerId: requesterPersonId/);
  });
});

/**
 * THE JUDGED TURN IS REAL WHEN DEPLOYED, AND ITS REPLY IS A QUESTION.
 *
 * Both halves shipped wrong once, in ways every unit test missed: the router had no way to learn its
 * own ARN, so every deployed stop logged "the stop goes unexplained" - unit-green, typechecked, inert.
 * And the evaluation's reply would have posted `final`, closing a turn on a message that answers
 * nothing.
 */
describe('the judged half is wired end to end', () => {
  const read = (rel: string) => require('fs').readFileSync(
    require('path').join(__dirname, '../../', rel), 'utf8');

  it('the stack gives the ROUTER the parameter name and the right to read it', () => {
    const stack = read('lib/stacks/assistant-profile-stack.ts');
    expect(stack).toMatch(/agentHandler\.addEnvironment\('ROUTER_ARN_PARAM'/);
    expect(/AgentHandlerSelfInvoke[\s\S]{0,1200}?ssm:GetParameter/.test(stack)).toBe(true);
  });

  it('the router forwards the context to the worker', () => {
    const router = read('lambda/src/router-agent-handler.ts');
    expect(router).toMatch(/\.\.\.\(stopEvaluation \? \{ stopEvaluation \} : \{\}\),/);
  });

  it('the worker stamps the reply as a question, never final', () => {
    const core = read('lambda/src/lib/async-processor-core.ts');
    expect(core).toMatch(/event\.stopEvaluation \? 'interim' : 'final'/);
  });
});

describe('the router cancels the work in progress at the stop', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
  const stopBlock = SRC.slice(
    SRC.indexOf('const parsedStop = parseStopCommand'),
    SRC.indexOf('const turnAttachment = bypassAttachment(event);'),
  );

  it('the stop path is not empty, so the assertions below are not vacuous', () => {
    expect(stopBlock.length).toBeGreaterThan(500);
  });

  it('cancels exactly the selected work, through the seam, by id', () => {
    // By id through `cancelStoppedTasks`: it skips anything finished and takes the per-user mirror
    // with the row. The channel-wide cancel would take other people's work in the same room.
    expect(stopBlock).toContain('selectStoppableTasks');
    expect(stopBlock).toContain("cancelStoppedTasks(channelArn, held.map(({ summary }) => summary.taskId))");
    expect(stopBlock).not.toContain('cancelActiveTasksInChannel');
    expect(stopBlock).not.toContain('cancelTasksForStop');
  });

  it('suppresses the running answer BEFORE the cancel can cost it anything', () => {
    // The suppression is the only part of a stop the person can see working.
    const record = stopBlock.indexOf('await recordStop(channelArn, personId, stopTarget.responderId)');
    const cancel = stopBlock.indexOf('await cancelStoppedTasks(');
    expect(record).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(record);
  });

  it('keeps finished work, because the cancel skips it', () => {
    const tracking = require('fs').readFileSync(
      require('path').join(__dirname, '../../lambda/src/lib/task-tracking.ts'), 'utf8');
    const at = tracking.indexOf('export async function cancelStoppedTasks(');
    expect(at).toBeGreaterThan(-1);
    expect(tracking.slice(at, at + 1200)).toContain("full.status === 'completed'");
    expect(tracking.slice(at, at + 1200)).toContain('cancelOneTask(full)');
  });

  it('asks how to proceed only when something was actually cancelled', () => {
    // A failed cancel leaves the work open; asking "leave it cancelled, or start again?" about work
    // that has not stopped would misinform the person.
    expect(stopBlock).toMatch(/if \(held\.length && !cancelFailed\)[\s\S]{0,200}dispatchStopEvaluationTurn/);
    expect(stopBlock).toContain('const cancelFailed = held.length > 0 && cancelled === 0;');
  });

  it('says the cancel failed when it did, and never calls that a success', () => {
    const failed = stopBlock.slice(stopBlock.indexOf("templateLine('stop-cancel-failed'"));
    expect(failed.slice(0, 200)).toMatch(/stop-cancel-failed/);
    expect(shippedLineText('stop-cancel-failed', 'chat.other')).toMatch(/could not cancel/);
  });

  it('promises a question only when one was dispatched', () => {
    // The same rule `queueWriteFailed` is written under.
    expect(stopBlock).toMatch(/const askedLine = templateLine\('stopped', stopWords/);
    expect(stopBlock).toMatch(/const notAskedLine = templateLine\('stop-cancelled-but-not-asked', stopWords/);
    const from = stopBlock.lastIndexOf('return formatLexResponse');
    const tail = stopBlock.slice(from, stopBlock.indexOf('\n      );', from));
    expect(tail).toContain('asked ? askedLine : notAskedLine');
    expect(tail).not.toMatch(/holding/i);
    // The acknowledgment posted up front promised a question; with none dispatched it is corrected.
    const corrected = stopBlock.slice(stopBlock.indexOf('if (postedAckId) {'));
    expect(corrected).toMatch(/if \(!asked\) \{[\s\S]*UpdateChannelMessageCommand[\s\S]*notAskedLine/);
  });

  it('posts the acknowledgment before the question turn exists, so the order is not a race', () => {
    // Returned to Lex, the acknowledgment is posted only after the handler returns - after the
    // question turn was already started - so the question often landed first (measured live).
    const post = stopBlock.indexOf('postedAckId = posted.MessageId;');
    expect(post).toBeGreaterThan(-1);
    expect(post).toBeLessThan(stopBlock.indexOf('dispatchStopEvaluationTurn({'));
    // Nothing waits: no timer or poll sits between them.
    expect(stopBlock.slice(post, stopBlock.indexOf('dispatchStopEvaluationTurn({'))).not.toMatch(/setTimeout|sleep|poll/i);
    // And the Lex reply stays silent, so the acknowledgment is not posted twice.
    expect(stopBlock).toMatch(/if \(postedAckId\) \{[\s\S]*return formatLexSilentResponse\(event\);/);
  });

  it('refuses a stop sent privately in a group, before anything is stopped', () => {
    // A stop pauses the assistant for everyone; sent privately, the room sees it stop with no reason.
    const at = stopBlock.indexOf("console.log('[Router] /stop was sent privately in a group; refusing it'");
    expect(at).toBeGreaterThan(-1);
    const guard = stopBlock.slice(stopBlock.lastIndexOf('if (!isFlowEntry(event) && channelArn) {', at), at);
    expect(guard).toContain('!room.unknown && !room.isOneToOne');
    // Refused before the stop is recorded or any work is selected or cancelled.
    expect(at).toBeLessThan(stopBlock.indexOf('await recordStop('));
    expect(at).toBeLessThan(stopBlock.indexOf('selectStoppableTasks('));
    const refusal = stopBlock.slice(at, stopBlock.indexOf('}]);', at));
    expect(refusal).toContain("templateLine('stop-must-be-public', stopWords)");
    expect(shippedLineText('stop-must-be-public')).toMatch(/Nothing has been stopped/);
    // The acknowledgment that follows a public stop is posted to the room, never targeted.
    const ack = stopBlock.slice(stopBlock.indexOf('postedAckId = posted.MessageId;') - 600, stopBlock.indexOf('postedAckId = posted.MessageId;'));
    expect(ack).not.toContain('Target:');
  });

  it('records the question only after the person was actually asked', () => {
    // A record of a question nobody heard would make a later unrelated message be read as its answer.
    const at = stopBlock.indexOf('await rememberStopDecision({');
    expect(at).toBeGreaterThan(-1);
    expect(stopBlock.slice(0, at)).toContain('dispatchStopEvaluationTurn({');
    expect(stopBlock.slice(at - 200, at)).toContain('if (asked)');
  });

  it('acknowledges BEFORE the judged half can delay it', () => {
    // The LAST return, deliberately: the ambiguous branch returns earlier without stopping anything.
    expect(stopBlock.indexOf('dispatchStopEvaluationTurn'))
      .toBeLessThan(stopBlock.lastIndexOf('return formatLexResponse'));
  });

  it('asks which assistant, and stops nothing, when the room is ambiguous', () => {
    const ambiguous = stopBlock.slice(
      stopBlock.indexOf("if (stopTarget.kind === 'ambiguous')"),
      stopBlock.indexOf('const held ='),
    );
    expect(ambiguous).toContain('return formatLexResponse');
    expect(ambiguous).not.toContain('recordStop');
    expect(ambiguous).not.toContain('selectStoppableTasks');
    expect(ambiguous).not.toContain('cancelStoppedTasks');
  });
});
