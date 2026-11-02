/**
 * THE IDS A TRIAGE TURN IS JUDGED ON MUST BE THE IDS THE MODEL WAS SHOWN.
 *
 * `triage.ids` is not a list of messages, it is a CONTRACT. `triageContractDirective` demands one
 * `TRIAGE:` line per id, and `parseTriageProposal` refuses the reply WHOLE unless it gets exactly
 * that many. The message CONTENT reaches the model separately, in the user message that
 * `buildTriagePrompt` renders at dispatch.
 *
 * So the two are only ever correct together. Widening the id set after the prompt has been built
 * asks the model to classify a message it has never seen: it answers for the ones it can see, the
 * count does not match, and the reading is refused.
 *
 * -- WHY THIS GUARD EXISTS ----------------------------------------------------------------------
 *
 * It happened. The router re-read the queue on the way to the worker and appended anything that had
 * landed since dispatch to `triage.ids`, without rebuilding the prompt - which it cannot do, having
 * no in-flight label to put back. Every reading it touched was refused and fell to the derived floor
 * of one task per message, taking the priorities, the grouping and the offer to separate subjects
 * with it. The e2e that queues THREE messages failed on it while the one that queues two passed,
 * because the more messages arrive at once the likelier the dispatch is split.
 *
 * The refusal is correct and stays: a reading that covers some of the queue would have the caller
 * clear messages nothing triaged. It is the widening that was wrong.
 *
 * Late arrivals are folded by the processor instead, which re-dispatches through `dispatchTriageTurn`
 * so the prompt and the id set are rebuilt from the same messages and cannot disagree.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  parseTriageProposal,
  buildTriagePrompt,
  triageContractDirective,
} from '../../lambda/src/lib/turn-triage-proposal';

const ROOT = path.resolve(__dirname, '..', '..');

/** Message ids as Amazon Chime SDK Messaging issues them: long, opaque, and copied by hand. */
const DISPATCHED = [
  '9c1f7a2e4b8d40f1a3c5e7d9b1f3a5c7',
  'a1b2c3d4e5f60718293a4b5c6d7e8f90',
];
const LATE = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';

/** A reply that honors the contract for exactly the messages it was shown. */
function replyFor(ids: string[]): string {
  return [
    ...ids.map((id, i) => `TRIAGE: ${id} | new | normal | request ${i + 1}`),
    ...ids.map((id, i) => `TOPIC: subject ${i + 1} | ${id}`),
    'PROPOSAL:',
    'Here is what I understood.',
  ].join('\n');
}

describe('the reading contract names only what the prompt showed', () => {
  it('reads a reply that answers for exactly the dispatched messages', () => {
    const parsed = parseTriageProposal(replyFor(DISPATCHED), DISPATCHED);

    expect(parsed).not.toBeNull();
    expect(parsed!.items.map((i) => i.messageId)).toEqual(DISPATCHED);
    // Two subjects over two messages is a usable grouping, so the offer to separate them survives.
    expect(parsed!.topics?.length).toBe(2);
    expect(parsed!.derived).toBeUndefined();
  });

  it('REFUSES THE WHOLE READING when the contract names a message the model never saw', () => {
    // The model answers for what it was shown. The contract was widened behind it.
    const widened = [...DISPATCHED, LATE];
    const parsed = parseTriageProposal(replyFor(DISPATCHED), widened);

    // Not "two of three": nothing at all. This is the cost the router's fold was paying, and the
    // caller's only remaining option is the derived floor, which names no subjects and no split.
    expect(parsed).toBeNull();
  });

  it('asks the model for a line per id, so a widened set asks about a message with no content', () => {
    const prompt = buildTriagePrompt({
      queued: DISPATCHED.map((messageId, i) => ({ messageId, content: `request ${i + 1}` })),
    });
    const directive = triageContractDirective([...DISPATCHED, LATE]);

    // The prompt carries the content of what was dispatched, and nothing about the late arrival.
    for (const id of DISPATCHED) expect(prompt).toContain(id);
    expect(prompt).not.toContain(LATE);

    // The directive, keyed on the widened set, demands the late one be classified anyway.
    expect(directive).toContain(LATE);
  });

  /**
   * The mechanical half. The behavior above holds only while nothing widens the set in flight, and
   * that is a property of a file rather than of a function - so it is read from the source.
   */
  it('no handler between dispatch and the model call widens the contract', () => {
    const FILES = ['lambda/src/router-agent-handler.ts'];

    for (const file of FILES) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      // Assignment to the contract itself, in any spacing. Comment lines are skipped: the recorded
      // explanation of why this must not happen is the point of the revert, not a violation of it.
      const offending = src
        .split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*'))
        .filter(({ line }) => /\btriage\s*\.\s*ids\s*=[^=]/.test(line)
          || /\btriage\s*\.\s*ids\s*\.\s*push\s*\(/.test(line));

      expect(offending.map(({ n, line }) => `${file}:${n} ${line}`)).toEqual([]);
    }
  });
});

/**
 * A LATER PASS OF THE SAME TURN IS NOT A DUPLICATE DELIVERY OF IT.
 *
 * The fulfillment claim is idempotency for a Lex RETRY: same turn in, same response out. A triage
 * fold re-dispatches deliberately under the SAME correlation, because the next pass is meant to own
 * that correlation and update the same placeholder - so to that guard it looked exactly like a retry,
 * and it replayed the placeholder instead of running the turn.
 *
 * The two had never collided, because the fold could not fire while a six-second budget gated it.
 * Observed live the first time it did:
 *
 *     19:53:01.507  more arrived while reading; folding into one answer  (alreadyRead 1, arrived 2)
 *     19:53:01.586  duplicate fulfillment: replaying the same placeholder
 *
 * and the queue never drained. The handover could not rescue it either: the triage claim is held
 * across the drain, so it correctly stood down for a reader that was never going to run.
 */
/**
 * The suffix these assert on moved into `deliveryAttemptSuffix` when the AMENDMENT FOLD turned out
 * to need the same treatment as the pass (owner-reported, 2026-09-05) - two things re-enter the
 * router on one correlation id, and one shared suffix is what stops them drifting apart.
 *
 * These stay as SOURCE guards because that is what they are for: the behavior of the suffix itself
 * is covered properly by `a-fold-is-not-a-redelivery`, which calls the function. What cannot be
 * reached by calling it is whether the two key families still USE it - a fulfil key that stopped
 * being scoped would leave that unit test green while the guard it protects was gone.
 */
describe('the fulfillment claim is scoped to the attempt', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lambda/src/router-agent-handler.ts'), 'utf8');

  it('keys the claim on the attempt, so a re-entry is a different delivery from the first', () => {
    expect(src).toContain('const fulfilKey = `fulfil-${correlationId}${attemptSuffix}`;');
    expect(src).toContain('if (!(await claimCorrelation(fulfilKey))) {');
  });

  it('leaves a first attempt unsuffixed, so nothing about an ordinary turn changes', () => {
    // `#p2` only from the second pass, `#f1` only from the first fold; pass 1 and a non-triage,
    // non-folded turn key exactly as before. That is what keeps this a scoping change rather than a
    // new dedup scheme.
    expect(src).toMatch(/t\?\.pass && t\.pass > 1 \? `#p\$\{t\.pass\}` : ''/);
    expect(src).toMatch(/Number\.isFinite\(raw\) && raw > 0 \? `#f\$\{raw\}` : ''/);
  });

  it('scopes the gate-blocked twin the same way, from the same suffix', () => {
    // A block recorded against one attempt must not silence the next.
    expect(src).toContain('`fulfil-blocked-${correlationId}${attemptSuffix}`');
    expect(src).not.toContain('`fulfil-blocked-${correlationId}`');
    // ONE suffix for both key families. Two computations would be free to disagree, and the failure
    // would be a block silencing a delivery it was never recorded against.
    expect(src).not.toMatch(/fulfil-blocked-\$\{correlationId\}\$\{pass/);
  });
});

/**
 * A TURN THIS SYSTEM DISPATCHED TO ITSELF IS NOT A CANDIDATE ANSWER.
 *
 * SPEAKING IS NEVER THE ANSWER; only a relevant message is. The task-response region used to say the
 * opposite in prose - "the queue has already brought them to this conversation; speaking here is the
 * answer" - and that rule is wrong for a person too, not only for a machine. Somebody with a task
 * awaiting them can ask about something else entirely, and arrival is not assent.
 *
 * The code was already more careful than its comment: `applyUserResponseToTask` judges relevance and
 * declines what it cannot settle. So what this guards is narrower than the first version of it
 * claimed - a self-dispatched turn is not a candidate for that judgement at all.
 *
 * Observed live: a fold re-dispatched pass 2; an awaited task existed by then, because the turn being
 * triaged behind had asked its own question; and the region took the turn - NOT by applying the
 * prompt to the task, which it correctly declined, but by matching the chain-resume path and
 * dispatching it onward as an ordinary turn. The triage context never reached the processor, so no
 * reading ran and the queue stayed put. Pass 1 escaped only because nothing was awaiting yet when it
 * went, which is why this survived every earlier run.
 */
describe('a self-dispatched triage turn is not read as an answer', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lambda/src/router-agent-handler.ts'), 'utf8');

  it('is recognised from the request attribute, not the turn context', () => {
    // The turn context is assembled a thousand lines after these branches decide what the turn is.
    expect(src).toContain('function isSelfDispatchedTriage(');
    expect(src).toContain('parseTriageTurnContext(event.requestAttributes?.[BYPASS_TRIAGE_ATTR])?.ids.length');
  });

  it('does not apply it to an awaited task', () => {
    // WIDENED to `isMachineWrittenTurn`, which is triage OR a stop evaluation. A stop evaluation has
    // the same shape - machine-written `userMessage`, real person as sender - and was excluded
    // nowhere, so a `/stop` applied the machine-written prompt as the person's answer to an awaiting
    // task. The rule this asserts is unchanged; the set it covers is larger.
        expect(src).toContain('if (answered && !isMachineWrittenTurn(event) && !isAmendmentFold(event)) {');
  });

  it('does not advance a chain with it', () => {
    expect(src).toContain('} else if (isSelfDispatchedTriage(event)) {');
  });

  it('still applies a real person response, which is the behaviour being protected', () => {
    // The guard must narrow to machine dispatches only: an ordinary turn carries no triage attribute,
    // so `isSelfDispatchedTriage` is false and both paths behave exactly as before.
    expect(src).toContain('const applied = await applyUserResponseToTask({');
  });
});

/**
 * AND IT MUST NOT ENTER THE REGION AT ALL, not merely decline to act inside it.
 *
 * Declining to APPLY the response was not enough. The turn still entered the task-resume region,
 * matched the chain-resume path, and was DISPATCHED from there as an ordinary turn - so the triage
 * context never reached the processor. Observed live: pass 2 ran, loaded history, got a Bedrock
 * response, and produced no reading at all, because by then nothing knew it was a triage turn.
 *
 * The guards inside stop the task being mutated. This one stops the turn being misrouted, and it was
 * the routing that swallowed the reading.
 */
describe('a self-dispatched triage turn skips the task-resume region entirely', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lambda/src/router-agent-handler.ts'), 'utf8');

  it('gates the region entry, not just the writes inside it', () => {
    expect(src).toContain(
      'if ((battleCtx || channelArn || !shortAcknowledgment) && !isMachineWrittenTurn(event)) {',
    );
  });

  it('keeps the inner guards too, because they answer a different failure', () => {
    // Region entry is about ROUTING; the inner ones are about MUTATION. A future change that reopens
    // the region for some machine turn should still not close somebody's task with a prompt.
    // WIDENED to `isMachineWrittenTurn`, which is triage OR a stop evaluation. A stop evaluation has
    // the same shape - machine-written `userMessage`, real person as sender - and was excluded
    // nowhere, so a `/stop` applied the machine-written prompt as the person's answer to an awaiting
    // task. The rule this asserts is unchanged; the set it covers is larger.
        expect(src).toContain('if (answered && !isMachineWrittenTurn(event) && !isAmendmentFold(event)) {');
    expect(src).toContain('} else if (isSelfDispatchedTriage(event)) {');
  });
});
