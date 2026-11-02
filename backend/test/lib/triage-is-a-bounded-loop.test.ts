/**
 * TRIAGE IS A BOUNDED LOOP, NOT A SINGLE CALL (ADR-033, DESIGN 2.3 and 7.4).
 *
 * The step this exists for is step 3: deciding it cannot yet return a reading. A reading assembled
 * from a queue the assistant only partly understands is worse than a slower one, because the person
 * corrects it by hand. The first build had no way to express "not yet" and so always returned its
 * first impression.
 *
 * ── THE TWO WAYS A LOOP GOES WRONG, AND BOTH ARE PINNED HERE ────────────────────────────────────
 *
 * IT NEVER STOPS. An unbounded loop on a path a person is waiting on is a latency defect wearing an
 * intelligence costume. Two bounds close it, and either one alone is enough: the wall clock is what
 * the person actually waits through, and the pass count caps the case where each pass returns fast
 * and learns nothing.
 *
 * IT NEVER STARTS. A `requested` that fires on hedged prose would spend the budget on a reading that
 * was already there, and a `requested` that fires on a reply carrying real `TRIAGE:` lines would
 * throw a finished reading away. Both are asserted below, because both are silent.
 */
import {
  buildTriagePrompt,
  mayTakeAnotherPass,
  parseAnotherPassRequest,
  parseTriageTurnContext,
  TRIAGE_MAX_PASSES,
} from '../../lambda/src/lib/turn-triage-proposal';

const IDS = ['m1'];
const READING = 'TRIAGE: m1 | new | normal | look up Q3 headcount';
const NOW = 1_800_000_000_000;

describe('the bound is one number: how deep the chain already is', () => {
  it('allows another pass while the chain has room', () => {
    expect(mayTakeAnotherPass({ pass: 1 })).toBe(true);
  });

  it('stops at the limit', () => {
    expect(mayTakeAnotherPass({ pass: TRIAGE_MAX_PASSES })).toBe(false);
    expect(mayTakeAnotherPass({ pass: TRIAGE_MAX_PASSES + 1 })).toBe(false);
  });

  it('treats an older payload that carried no pass as the first', () => {
    // Degrades to "bounded by passes", never to unbounded.
    expect(mayTakeAnotherPass({ pass: 1 })).toBe(true);
  });

  /**
   * THE INVARIANT THE WALL CLOCK BROKE, asserted directly.
   *
   * This question is asked TWICE about the same turn: once before it is dispatched, to decide
   * whether the contract may offer the option at all, and once after the model has answered, to
   * decide whether to honor it. A bound that can answer differently at those two moments grants an
   * option and then refuses it - which is exactly what six seconds did, every single time, because
   * the thing between the two questions is a model call longer than six seconds. The reply that took
   * the offer then carried no reading and the whole queue dropped to the derived floor.
   *
   * So: the answer must not depend on when it is asked.
   */
  it('answers identically before and after a turn has run', () => {
    const spy = jest.spyOn(Date, 'now');
    try {
      spy.mockReturnValue(NOW);
      const atDispatch = mayTakeAnotherPass({ pass: 1 });
      // A whole model call later, which is where the old bound flipped.
      spy.mockReturnValue(NOW + 60_000);
      const atReply = mayTakeAnotherPass({ pass: 1 });
      expect(atReply).toBe(atDispatch);
      expect(atReply).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('recognising a request for another pass', () => {
  it('reads the declared marker', () => {
    expect(parseAnotherPassRequest('ANOTHER_PASS: two of these may be one request', IDS))
      .toEqual({ requested: true, reason: 'two of these may be one request' });
  });

  it('does not fire on prose that merely sounds unsure', () => {
    // A model that SOUNDS uncertain has still produced a reading. Treating hedged prose as a request
    // to loop would spend the person's budget on something already finished.
    expect(parseAnotherPassRequest(`${READING}\nPROPOSAL: I am not entirely sure, but here goes`, IDS))
      .toEqual({ requested: false });
  });

  it('lets a real reading win over a contradictory marker', () => {
    // A reply carrying both is self-contradictory, and the safe reading of a contradiction is the one
    // that does not discard work.
    expect(parseAnotherPassRequest(`ANOTHER_PASS: unsure\n${READING}`, IDS)).toEqual({ requested: false });
  });

  it('ignores the marker when it appears in the part the person reads', () => {
    // The `PROPOSAL:` split is a security boundary, not a formatting convention: a proposal quoting
    // the marker back must not be able to spend a pass.
    expect(parseAnotherPassRequest('PROPOSAL: I was going to write ANOTHER_PASS: here', IDS))
      .toEqual({ requested: false });
  });

  it('is safe on an empty reply', () => {
    expect(parseAnotherPassRequest('', IDS)).toEqual({ requested: false });
  });
});

describe('the loop state travels with the turn', () => {
  const ctx = (extra: Record<string, unknown>) =>
    parseTriageTurnContext(JSON.stringify({ ids: IDS, visibility: 'conversation', ...extra }));

  it('carries the pass, which is the whole loop state now', () => {
    expect(ctx({ pass: 2 })).toMatchObject({ pass: 2 });
  });

  it('IGNORES a deadline an older dispatcher still sends', () => {
    // The clock is gone from the decision, so a payload minted before it went must not resurrect it
    // by arriving with the field set. Read field by field, so an unnamed field cannot enter.
    expect(ctx({ pass: 2, deadlineAt: NOW })).not.toHaveProperty('deadlineAt');
  });

  it('defaults a missing pass to the first rather than refusing', () => {
    // Unlike the visibility beside it, which refuses. A missing pass is an older dispatcher that
    // never looped, and defaulting it degrades to the single-call behavior that shipped before.
    expect(ctx({})).toMatchObject({ pass: 1 });
  });

  it('still refuses a missing visibility, which is a disclosure decision', () => {
    // The asymmetry is the point: the pass count cannot publish a private request and the visibility
    // can, so only one of them is allowed a default.
    expect(parseTriageTurnContext(JSON.stringify({ ids: IDS, pass: 2 }))).toBeUndefined();
  });

  it('ignores a malformed pass rather than trusting it', () => {
    expect(ctx({ pass: 0 })).toMatchObject({ pass: 1 });
    expect(ctx({ pass: 'two' })).toMatchObject({ pass: 1 });
  });
});

describe('the option is offered only while it is affordable', () => {
  const queued = [{ messageId: 'm1', content: 'and shorten it' }];

  it('offers another pass when the budget allows', () => {
    expect(buildTriagePrompt({ queued, mayAskForAnotherPass: true })).toContain('ANOTHER_PASS:');
  });

  it('does NOT offer it once the budget is spent', () => {
    // Describing an option the runtime would then refuse teaches the model to ask for something that
    // silently does not happen, and the reply that asks is a reply that produced no reading.
    expect(buildTriagePrompt({ queued, mayAskForAnotherPass: false })).not.toContain('ANOTHER_PASS:');
  });

  it('always asks for the queue to be read together', () => {
    // Several messages that are one request read as one request only when they are seen at once.
    expect(buildTriagePrompt({ queued, mayAskForAnotherPass: true })).toContain('TOGETHER');
  });
});

