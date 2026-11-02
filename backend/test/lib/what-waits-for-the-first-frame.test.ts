/**
 * TWO PIECES OF WORK LEFT THE PRE-PLACEHOLDER PATH, AND MUST NOT COME BACK.
 *
 * The router's Lex return IS the placeholder, so everything the handler does before returning is
 * inside TTFF. Two things on that path were never inputs to the return:
 *
 *  - RETRIEVAL AND THE RUNNING SUMMARY, two data-plane round trips whose result nothing reads until
 *    the model call, which happens in the processor.
 *  - THE HOLDER RECORD, a `ListChannelMessages` to recover the inbound id plus a DynamoDB write, read
 *    by a queue drain seconds later.
 *
 * Both now happen in the processor. Nothing about that is enforced by a type: the router still has the
 * channel, the classification and the message, so re-adding either call is a two-line change that
 * breaks no build, fails no test, and shows up only as TTFF drifting back up on a deployment nobody is
 * measuring that week. Hence a ratchet, in the family of `task-shaped-battle-parity.test.ts`.
 *
 * The gates themselves are behavior, and are tested as behavior below: a deployment with no data
 * plane, and a message not worth grounding, must both cost nothing.
 */
import { stripComments } from '../helpers/strip-comments';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const router = stripComments(fs.readFileSync(path.join(SRC, 'router-agent-handler.ts'), 'utf8'));
const processor = stripComments(fs.readFileSync(path.join(SRC, 'assistant-async-processor.ts'), 'utf8'));

const count = (code: string, needle: string): number => code.split(needle).length - 1;

describe('the router does not pay for what the answer needs', () => {
  it('fetches neither retrieval nor the running summary', () => {
    // The names in the assertion value, not a message: "expected 0, received 1" would not say which
    // of the two came back.
    expect({
      retrieval: count(router, 'retrieveContext('),
      summary: count(router, 'getLatestSummary('),
    }).toEqual({ retrieval: 0, summary: 0 });
  });

  it('does not write the holder record, and does not resolve an id in order to', () => {
    expect(count(router, 'rememberHolderMessage(')).toBe(0);
  });

  it('hands over the decision instead, on both dispatch branches', () => {
    // The router is the component that CLAIMS, so it is the only one that can say whether this turn
    // owes the record. One definition, spread into both dispatches - a second branch that assembled
    // its own would be a turn whose queue reads "the work already in progress" and nothing more.
    expect(count(router, '...holderRecordFields()')).toBe(2);
  });

  it('gates the hand-off on the queue flag, which the claim result does not', () => {
    // `claimTurn` returns `claimed: true` when the queue is off, so a hand-off gated on the claim
    // alone would have a queue-off deployment pay a channel read in the processor for a write that
    // then no-ops on its own flag check.
    expect(router).toContain('turnQueueEnabled() && turnClaim.claimed');
  });
});

describe('the processor does the work, and settles it before it can return', () => {
  it('fetches its own grounding', () => {
    expect(count(processor, 'resolveTurnGrounding(')).toBe(1);
  });

  it('writes the holder record from the shared matcher', () => {
    expect(count(processor, 'rememberHolderMessage(')).toBe(1);
    expect(count(processor, 'findInboundMessage(')).toBe(1);
  });

  it('settles the record in the finally, so no exit can abandon it', () => {
    // AN UNRESOLVED PROMISE IN LAMBDA IS NOT A BACKGROUND TASK. The environment freezes when the
    // handler returns, so a write that is started and not awaited is never sent - which is exactly
    // how the router's first version of this silently did nothing.
    //
    // THE `finally` RATHER THAN A LINE AFTER THE PIPELINE, because this handler leaves that block
    // three ways: the early return when the placeholder never resolved, a throw the catch handles,
    // and the ordinary end. An await placed after the pipeline covers the first and abandons the
    // second. The promise is declared outside the try for exactly that reason.
    const declared = processor.indexOf('let holderRecorded');
    const started = processor.indexOf('holderRecorded = event.rememberHolder');
    const tryBlock = processor.indexOf('  try {', declared);
    const awaited = processor.indexOf('await holderRecorded');
    const finallyBlock = processor.indexOf('  } finally {');
    expect(declared).toBeGreaterThan(-1);
    expect(declared).toBeLessThan(tryBlock);
    expect(started).toBeGreaterThan(tryBlock);
    expect(awaited).toBeGreaterThan(finallyBlock);
  });

  it('does not pay for the record on a failure announcement', () => {
    // The recovery's cheapest path - no model, no tools, no retrieval - reached only after three
    // failures of the expensive one, and it releases the lock moments later. A channel read there
    // buys a record nothing gets to read. `turn-lock-release-on-failure` re-invokes with the ORIGINAL
    // payload spread, so `rememberHolder` survives into it unless this guard names it.
    expect(processor).toContain('event.rememberHolder && !event.announceFailure');
  });
});
