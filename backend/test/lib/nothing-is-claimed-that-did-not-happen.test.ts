/**
 * INVARIANT C (ADR-033): the assistant never claims something happened that did not.
 *
 * The ways this branch reached that, each from a different direction: a success reported because a
 * failure did not look like one, an answer half-delivered and then called stopped, a privacy write
 * whose failure was logged as something else entirely, and a task reported closed that the tool had
 * just said was not.
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

const lambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: (...a: unknown[]) => lambdaSend(...a) })),
  InvokeCommand: jest.fn((input: unknown) => ({ input })),
}));

describe('a split that did not happen is not reported as one', () => {
  let requestConversationSplit: any;

  const ARGS = {
    channelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c',
    responderId: 'bot',
    botArn: 'arn:aws:chime:us-east-1:1:app-instance/i/user/bot',
    userArn: 'arn:aws:chime:us-east-1:1:app-instance/i/user/ada',
    classification: 'premium',
    labels: ['Q3 headcount', 'Pricing page accuracy'],
    originatingMessageId: 'm1',
  };

  beforeAll(() => {
    process.env.CONVERSATION_SPLIT_FUNCTION_ARN = 'arn:aws:lambda:us-east-1:1:function:split';
    requestConversationSplit = require('../../lambda/src/lib/turn-topic-split').requestConversationSplit;
  });

  beforeEach(() => jest.clearAllMocks());

  it('refuses every label when the function timed out', async () => {
    // THE TRAP: a Lambda FunctionError is not a thrown SDK error. The invoke RESOLVES, 200, with a
    // payload of {"errorMessage":"...Task timed out..."}. Nothing threw, `created` and `refused` were
    // both absent and both defaulted to [], and a caller that only speaks when refused.length is
    // non-zero said nothing - while the reply had already told the person their subjects were moving.
    lambdaSend.mockResolvedValue({
      FunctionError: 'Unhandled',
      Payload: Buffer.from(JSON.stringify({
        errorMessage: '2026-08-31T05:00:00.000Z Task timed out after 30.03 seconds',
      })),
    });

    const out = await requestConversationSplit(ARGS);

    expect(out.created).toEqual([]);
    expect(out.refused).toEqual(ARGS.labels);
  });

  it('refuses every label when the answer is in a shape it cannot read', async () => {
    // Two empty arrays read as "everything moved, nothing was refused" - the one reading that must
    // never be reached by accident.
    lambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ ok: true })) });

    const out = await requestConversationSplit(ARGS);

    expect(out.refused).toEqual(ARGS.labels);
  });

  it('still reports a real split', async () => {
    lambdaSend.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({
        created: [{ label: 'Q3 headcount', channelArn: 'arn:...:channel/new' }],
        refused: ['Pricing page accuracy'],
      })),
    });

    const out = await requestConversationSplit(ARGS);

    expect(out.created).toHaveLength(1);
    expect(out.refused).toEqual(['Pricing page accuracy']);
  });
});

describe('an answer is not half-delivered and then called stopped', () => {
  const fs = require('fs');
  const CORE = path.resolve(ROOT, 'lambda/src/lib/async-processor-core.ts');

  it('asks about the stop before anything is delivered', () => {
    const src: string = fs.readFileSync(CORE, 'utf8');
    // The check now sits ABOVE the delivery and is passed into it. Previously it ran after
    // handleLongResponse had already posted chunks 2..N as separate persistent messages, so a
    // mid-turn /stop left "Stopped - I did not finish that." with the rest of the answer beneath it.
    const stopIdx = src.indexOf('const stopped = await wasStoppedSince(');
    // Anchored on the DECLARATION rather than its first branch: a reading now short-circuits ahead
    // of the attachment case, so the old literal named a line that no longer starts it. The rule
    // under test is the ORDER - the stop is read before anything is delivered - and that is
    // unchanged.
    const deliverIdx = src.indexOf('const longResponseResult =');
    expect(stopIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeLessThan(deliverIdx);
    expect(src).toContain('suppressContinuations?: boolean,');
    expect(src).toMatch(/if \(!suppressContinuations\) \{\s*try \{[\s\S]{0,200}await sendContinuations\(/);
  });
});

describe('a privacy write that failed says so', () => {
  const fs = require('fs');
  const CORE = path.resolve(ROOT, 'lambda/src/lib/async-processor-core.ts');

  it('does not report a failed markTaskPrivate as an untargeted reply', () => {
    // It sat inside the placeholder read's try, so a task-store failure logged "treating the reply as
    // untargeted" - false, replyIsTargeted is already set - and the task kept absent visibility,
    // which reads as conversation-visible. The label then surfaced in the room's task hints.
    const src: string = fs.readFileSync(CORE, 'utf8');
    expect(src).toContain('the task could not be marked private; its label may be visible in the room');
  });
});

describe('a queue that could not be read is not reported as empty', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const path = require('path');
  const CORE_SRC: string = fs.readFileSync(
    path.join(ROOT, 'lambda/src/lib/async-processor-core.ts'), 'utf8',
  );

  /**
   * `readTurnState` RETURNS `unreadable: true` FOR EXACTLY THIS DISTINCTION, and the caller threw it
   * away by taking `.queued.length` and catching to 0.
   *
   * Two things are gated on "nothing is waiting": the notice settles, telling the person their queue
   * is handled, and the drain task closes, telling the system the same. A throttled read made both
   * fire over a queue that still had messages in it - and the drain closing removes the thing that
   * would have come back for them, so the queue is stranded with an interface saying it is done.
   *
   * Source-level because the failure is a DynamoDB throttle, which this suite does not produce.
   */
  it('treats an unreadable queue as still waiting, not as settled', () => {
    expect(CORE_SRC).toContain('queueNow.unreadable ? 1 : queueNow.queued.length');
  });

  it('no longer collapses the read to a bare length with a catch to zero', () => {
    // The exact shape of the defect, pinned so it cannot come back as a tidy-looking one-liner.
    expect(CORE_SRC).not.toMatch(/readTurnState\([^)]*\)[\s\S]{0,120}\.then\(\(r\) => r\.queued\.length\)\.catch\(\(\) => 0\)/);
  });

  it('says so when it happens, because a silent hold looks like a stall', () => {
    expect(CORE_SRC).toContain('the queue could not be read after clearing');
  });
});

describe('a reading is parsed, so it is never chunked into the conversation', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const path = require('path');
  const CORE_SRC: string = fs.readFileSync(
    path.join(ROOT, 'lambda/src/lib/async-processor-core.ts'), 'utf8',
  );

  /**
   * `handleLongResponse` updates the placeholder with the first chunk and SENDS the rest as their own
   * persistent messages. For an answer a person reads, that is the whole point. For a triage turn it
   * published the runtime's own machine-readable reading into the conversation, and then handed the
   * parser chunk 0 alone - so the per-id line count stopped matching the queued ids and the reading
   * was discarded as unparseable. A queue read, judged, and thrown away, with the publication as the
   * only visible trace.
   */
  it('takes the whole reply for a reading rather than the chunked first part', () => {
    expect(CORE_SRC).toContain('const isReadingTurn = !!event.triage?.ids.length;');
    expect(CORE_SRC).toMatch(/const longResponseResult = isReadingTurn\s*\n\s*\? \{ content: response \}/);
  });

  it('still chunks an ordinary answer, which is what the splitting is for', () => {
    // Non-vacuity: a change that skipped chunking everywhere would pass the assertion above and
    // truncate every long answer in the product.
    expect(CORE_SRC).toContain('await handleLongResponse(');
  });
});

/**
 * A TASK REPORTED CLOSED THAT THE TOOL SAID WAS NOT.
 *
 * Measured live on `conv-1790010890868-807ae3b58087`: a `data_extraction` task was told to the person
 * as closed twice, and the row sat at `formatting`, one step short of `completed`. The task's own
 * `stateHistory` shows `advance_task_state` called three times, every call succeeding, every call
 * moving ONE step, and every reason saying the model meant to close it.
 *
 * Nothing had failed. The tool answered `to: 'formatting'` with no `terminal` key, which was true -
 * and an absent key is not something a model acts on. What told it otherwise was the delivering block
 * in the turn's own prompt: "call advance_task_state to move this task to its final state". One call
 * is one step, and in `data_extraction` three separate states deliver, so the promise was made to the
 * model three times and believed three times.
 *
 * Both halves are pinned here because either alone leaves the defect reachable: a prompt that no
 * longer lies, and an answer that says "not finished" out loud rather than by omission.
 */
describe('a task is not reported closed unless the tool said it closed', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const fs = require('fs');
  const TOOLS_SRC: string = fs.readFileSync(path.join(ROOT, 'lambda/src/lib/task-tools.ts'), 'utf8');
  const TRACKING_SRC: string = fs.readFileSync(path.join(ROOT, 'lambda/src/lib/task-tracking.ts'), 'utf8');

  it('answers whether the work is finished on every advance, not only when it is', () => {
    // POSITIVELY. `...(terminal ? { terminal } : {})` alone is what made "not finished" invisible.
    expect(TOOLS_SRC).toContain('finished: Boolean(result.terminal)');
  });

  it('names what is still ahead when it is not finished, so the next step is knowable', () => {
    expect(TOOLS_SRC).toContain('next_states: nextStates');
    // Withheld once there is nowhere left to go: an empty list on a terminal state is a dead end the
    // model would have to interpret, and `finished: true` has already answered it.
    expect(TOOLS_SRC).toContain('result.terminal || nextStates.length === 0 ? {} : { next_states: nextStates }');
  });

  it('stops telling the model that one call reaches the final state', () => {
    // The sentence that caused it. Pinned as an ABSENCE because the wording is what misled, and a
    // future edit that reintroduces the promise should fail here rather than ship.
    // The claim that one call REACHES the final state is what misled the model three times. The
    // owner's rule that a delivered thing is complete is kept - it is true of report_generation,
    // where the next state IS the last one - and only the false mechanic is removed.
    expect(TRACKING_SRC).not.toContain('to move this task to its final state on the SAME turn');
    expect(TRACKING_SRC).toContain('ONE CALL IS ONE STEP');
    // Non-vacuity: the owner direction the delivering block exists for is still stated.
    expect(TRACKING_SRC).toContain('DELIVERING IT COMPLETES IT');
  });

  it('makes the claim conditional on the answer rather than on the intent', () => {
    expect(TRACKING_SRC).toContain('Only call it closed, done or complete when the');
    expect(TRACKING_SRC).toContain('finished: true');
    expect(TRACKING_SRC).toContain('finished: false');
  });
});

/**
 * AND THE SAME CASE AGAIN, FROM THE ONLY SIDE THAT IS A GUARANTEE.
 *
 * Everything above is a mitigation. A prompt that no longer lies and a tool that says `finished: false`
 * both still route through a model choosing what to say, and the turn that believes it has finished the
 * work is exactly the turn that will not correct itself - which is how the live case produced the same
 * false claim three times over three honest tool answers.
 *
 * So the platform states it. `taskStillOpenLine` is pinned as a unit in
 * `an-unfinished-item-says-so.test.ts`; what is pinned HERE is that it is actually wired into the turn,
 * and on what. A correct function nobody calls is the shape this branch has shipped before.
 */
describe('and the item states its own condition, whatever the reply said', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const fs = require('fs');
  const PROCESSOR_SRC: string = fs.readFileSync(
    path.join(ROOT, 'lambda/src/assistant-async-processor.ts'), 'utf8',
  );
  const REFERENCE_SRC: string = fs.readFileSync(
    path.join(ROOT, 'lambda/src/lib/task-reference.ts'), 'utf8',
  );

  it('appends the line to the reply the person reads', () => {
    // Not merely imported: the append is the whole behavior.
    expect(PROCESSOR_SRC).toContain('taskStillOpenLine');
    expect(PROCESSOR_SRC).toMatch(/response = `\$\{response\}\\n\\n\$\{stillOpen\}`/);
  });

  it('fires on the transition that was written, not on anything the reply contains', () => {
    // THE RULE. `taskContext.transitions` is populated BY the tool loop with what it actually applied,
    // so the line is decided by the row's own history.
    expect(PROCESSOR_SRC).toContain('taskContext?.transitions?.some((t) => !t.taskId)');
  });

  it('speaks only for the item THIS turn moved, not one it redirected to', () => {
    // A transition carries `taskId` when the model redirected and advanced a DIFFERENT item
    // (`async-processor-core.ts:2587`). That path updates the target's state and leaves
    // `taskContext.task` untouched, so counting those made a redirected turn report the ACTIVE item's
    // stale state as though this turn had just moved it - the same false claim, aimed at a second item.
    //
    // Pinned as an absence of the unfiltered read, because the defect was the missing filter rather
    // than a wrong expression: `transitions?.length` alone is what shipped and what a later edit would
    // most naturally write again.
    expect(PROCESSOR_SRC).not.toContain('taskContext.transitions?.length && !event.triage');

    // And the three readers that always filtered still do, so this is one rule rather than four.
    expect(PROCESSOR_SRC).toContain('(taskContext?.transitions ?? []).filter((t) => !t.taskId)');
    const core: string = fs.readFileSync(
      path.join(ROOT, 'lambda/src/lib/async-processor-core.ts'), 'utf8',
    );
    expect(core).toContain("params.taskContext?.transitions?.filter((t) => !t.taskId)");
    // Non-vacuity: the tag this all turns on is really written, so the filters are not sorting on a
    // field nothing sets.
    expect(core).toContain('...(redirected ? { taskId: targetTask.taskId } : {})');
  });

  it('cannot consult the reply, because the function has nowhere to put it', () => {
    // NON-VACUITY FOR THE DESIGN, AND THE LOAD-BEARING ASSERTION IN THIS FILE. Scanning a reply for
    // "closed" or "done" is the output-shape heuristic this codebase has retired twice: it misses
    // every phrasing nobody anticipated and fires on quotes and questions. The signature carries no
    // response text, so reintroducing a content scan means changing it - and failing here first.
    const start = REFERENCE_SRC.indexOf('export function taskStillOpenLine(');
    const end = REFERENCE_SRC.indexOf('}): string {', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const signature = REFERENCE_SRC.slice(start, end);
    // The slice really is the argument list: a rename or refactor that emptied it would otherwise
    // satisfy the absence below on nothing at all.
    expect(signature).toContain('advanced: boolean');
    expect(signature).not.toMatch(/response|reply|text|content/i);
  });

  it('says nothing about a turn that finished its work, or that advanced nothing', () => {
    // The same defect pointing the other way would be telling a person their finished work is open.
    const {
      taskStillOpenLine,
    } = require('../../lambda/src/lib/task-reference');
    expect(taskStillOpenLine({
      advanced: true, state: 'completed', nextStates: [], terminal: 'success',
    })).toBe('');
    expect(taskStillOpenLine({
      advanced: false, state: 'formatting', nextStates: ['completed'],
    })).toBe('');
    // And it does speak for the live case, so the guard above is not passing on silence.
    expect(taskStillOpenLine({
      advanced: true, state: 'formatting', nextStates: ['completed'],
    })).toContain('formatting');
  });
});
