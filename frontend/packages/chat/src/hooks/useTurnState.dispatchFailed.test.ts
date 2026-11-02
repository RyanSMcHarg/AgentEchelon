/**
 * A TURN THAT NEVER RAN IS NOT A TURN THAT IS STILL RUNNING.
 *
 * The distinction is the whole point of this field. "Busy" tells a person to keep waiting; a dispatch
 * failure tells them their message was delivered and nothing is coming. A surface that conflated them
 * would leave somebody waiting indefinitely for a reply that was never started - which is exactly the
 * outcome the channel flow's old assistant-posted error existed to prevent, and this replaces.
 *
 * The failure is also SCOPED TO THIS PERSON: the server reads it per caller, so a room does not learn
 * that somebody else's turn failed. These assert the fold, which is where a multi-assistant room could
 * silently turn one person's failure into a claim about the conversation.
 */
import { describe, it, expect } from 'vitest';
import type { TurnState } from '../services/turnStateService';

/** The fold under test, extracted so it can be asserted without standing a React tree up. */
function foldDispatchFailed(answered: TurnState[]): TurnState['dispatchFailed'] {
  return answered.find((r) => r.dispatchFailed)?.dispatchFailed;
}

const ok = (over: Partial<TurnState> = {}): TurnState => ({ busy: false, queued: [], ...over });

describe('why nothing came back', () => {
  it('reports the reason when an assistant could not be reached', () => {
    expect(foldDispatchFailed([ok({ dispatchFailed: 'assistant_unreachable' })]))
      .toBe('assistant_unreachable');
  });

  it('is absent on the ordinary path, including while a turn is merely slow', () => {
    // A slow turn is `busy`. Reporting a failure here would tell somebody to give up on an answer
    // that is still being written.
    expect(foldDispatchFailed([ok({ busy: true })])).toBeUndefined();
    expect(foldDispatchFailed([ok()])).toBeUndefined();
  });

  it('takes the FIRST answer in a room with several assistants, not a list', () => {
    // A person addressed one assistant. "Two of your three assistants are unreachable" describes the
    // deployment rather than their turn.
    const out = foldDispatchFailed([
      ok(),
      ok({ dispatchFailed: 'handoff_failed' }),
      ok({ dispatchFailed: 'assistant_unreachable' }),
    ]);
    expect(out).toBe('handoff_failed');
  });

  it('does not invent a failure from an assistant that answered normally', () => {
    expect(foldDispatchFailed([ok({ busy: true }), ok({ queued: ['m1'] })])).toBeUndefined();
  });
});
