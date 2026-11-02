/**
 * WHAT IS WAITING, IN A ROOM WITH MORE THAN ONE ASSISTANT (ADR-033).
 *
 * Busy is a property of a RESPONDER, not of a conversation - the lock is keyed that way so two people
 * addressing two assistants both get answers. The consequence lands here: a room with several
 * assistants has several queues, and this hook is the only place they are combined.
 *
 * It read the FIRST bot member at first. That is indistinguishable from correct in every
 * one-assistant conversation, which is nearly all of them, and silently wrong in the rooms the
 * feature exists for: a message queued behind the SECOND assistant rendered as though nothing was
 * waiting, so the person saw their message sitting unanswered with no explanation at all - the exact
 * failure the deferral notice exists to prevent, arriving through the transcript instead.
 *
 * These tests pin the three properties that make the union right, and each of them fails on a
 * first-responder-only implementation or on a naive rewrite of it:
 *
 *   - a message waiting on ANY assistant is waiting
 *   - the conversation is busy when ANY assistant is
 *   - a read that FAILED is not an empty answer
 *
 * The last one is the one a rewrite gets wrong. "Nothing is waiting" is a claim, and a network error
 * is not evidence for it; clearing on a failed read drops the waiting styling off messages that are
 * still queued, which tells the person their message was dropped.
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchTurnState = vi.fn();
const isTurnStateConfigured = vi.fn(() => true);

vi.mock('../services/turnStateService', () => ({
  fetchTurnState: (...args: unknown[]) => fetchTurnState(...args),
  isTurnStateConfigured: () => isTurnStateConfigured(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { useTurnState } from './useTurnState';

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';

/** Answer per responder id, so a test says what EACH assistant reports rather than what one does. */
function answers(byResponder: Record<string, { busy: boolean; queued: string[] } | null>) {
  fetchTurnState.mockImplementation(
    ({ responderId }: { responderId: string }) => Promise.resolve(byResponder[responderId] ?? null),
  );
}

beforeEach(() => {
  fetchTurnState.mockReset();
  isTurnStateConfigured.mockReturnValue(true);
});

describe('several assistants, several queues', () => {
  it('asks EVERY assistant, not the first', async () => {
    answers({ atlas: { busy: false, queued: [] }, nova: { busy: false, queued: [] } });
    renderHook(() => useTurnState({ channelArn: CHANNEL, responderIds: ['atlas', 'nova'] }));

    await waitFor(() => expect(fetchTurnState).toHaveBeenCalledTimes(2));
    const asked = fetchTurnState.mock.calls.map((c) => c[0].responderId).sort();
    expect(asked).toEqual(['atlas', 'nova']);
  });

  it('a message queued behind the SECOND assistant is waiting', async () => {
    // The regression, stated as the user sees it. First-responder-only returns an empty set here and
    // the message renders as though nothing were happening to it.
    answers({
      atlas: { busy: false, queued: [] },
      nova: { busy: true, queued: ['m-behind-nova'] },
    });
    const { result } = renderHook(
      () => useTurnState({ channelArn: CHANNEL, responderIds: ['atlas', 'nova'] }),
    );

    await waitFor(() => expect(result.current.queuedIds.has('m-behind-nova')).toBe(true));
    expect(result.current.busy).toBe(true);
  });

  it('unions the queues rather than taking one of them', async () => {
    answers({
      atlas: { busy: true, queued: ['m1', 'shared'] },
      nova: { busy: true, queued: ['m2', 'shared'] },
    });
    const { result } = renderHook(
      () => useTurnState({ channelArn: CHANNEL, responderIds: ['atlas', 'nova'] }),
    );

    await waitFor(() => expect(result.current.queuedIds.size).toBe(3));
    expect([...result.current.queuedIds].sort()).toEqual(['m1', 'm2', 'shared']);
  });

  it('is idle only when every assistant is', async () => {
    answers({
      atlas: { busy: false, queued: [] },
      nova: { busy: false, queued: [] },
    });
    const { result } = renderHook(
      () => useTurnState({ channelArn: CHANNEL, responderIds: ['atlas', 'nova'] }),
    );
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.readState).toBe('read');
  });
});

describe('a failed read is not an empty answer', () => {
  it('keeps what it knew when EVERY read fails', async () => {
    // "Nothing is waiting" must come from the server. Clearing on a network error takes the waiting
    // styling off a message that is still queued, which reads as the message having been dropped.
    answers({ atlas: { busy: true, queued: ['m1'] } });
    const { result, rerender } = renderHook(
      ({ signal }: { signal: string }) => useTurnState({
        channelArn: CHANNEL, responderIds: ['atlas'], changeSignal: signal,
      }),
      { initialProps: { signal: 'a' } },
    );
    await waitFor(() => expect(result.current.queuedIds.has('m1')).toBe(true));

    answers({ atlas: null });
    rerender({ signal: 'b' });

    // Given a moment to have cleared it, and it must not have.
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.queuedIds.has('m1')).toBe(true);
    expect(result.current.busy).toBe(true);
  });

  it('believes ONE assistant that answered when the other failed', async () => {
    // A partial answer is still an answer about the assistant that gave it. Discarding the whole read
    // because one responder was unreachable would blind the room to the queue it can see.
    answers({ atlas: { busy: true, queued: ['m1'] }, nova: null });
    const { result } = renderHook(
      () => useTurnState({ channelArn: CHANNEL, responderIds: ['atlas', 'nova'] }),
    );
    await waitFor(() => expect(result.current.queuedIds.has('m1')).toBe(true));
    expect(result.current.busy).toBe(true);
  });
});

describe('it re-reads on the event, and does not poll', () => {
  it('reads again when the notice changes', async () => {
    // The deferral notice is posted when the queue starts, updated on every further queued send, and
    // updated again when it drains - so it changes exactly when the state does. Watching it IS the
    // subscription (implementation tenet D6).
    answers({ atlas: { busy: true, queued: ['m1'] } });
    const { rerender } = renderHook(
      ({ signal }: { signal: string }) => useTurnState({
        channelArn: CHANNEL, responderIds: ['atlas'], changeSignal: signal,
      }),
      { initialProps: { signal: 'notice-1:1' } },
    );
    await waitFor(() => expect(fetchTurnState).toHaveBeenCalled());
    const before = fetchTurnState.mock.calls.length;

    rerender({ signal: 'notice-1:2' });
    await waitFor(() => expect(fetchTurnState.mock.calls.length).toBeGreaterThan(before));
  });

  it('sets no timer, so an idle conversation costs nothing', async () => {
    // A guard on the tenet rather than on a line of source: an interval would keep calling with no
    // signal change at all, which is what this measures.
    vi.useFakeTimers();
    try {
      answers({ atlas: { busy: false, queued: [] } });
      renderHook(() => useTurnState({ channelArn: CHANNEL, responderIds: ['atlas'] }));
      await vi.advanceTimersByTimeAsync(0);
      const settled = fetchTurnState.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchTurnState.mock.calls.length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('switching conversations', () => {
  it('does not carry the previous room\'s queued ids for even one frame', async () => {
    // The ids would be styled against a transcript they do not belong to - a message in the new
    // conversation whose id happened to match, or more commonly a stale highlight that never clears.
    answers({ atlas: { busy: true, queued: ['m-in-c1'] } });
    const { result, rerender } = renderHook(
      ({ arn }: { arn: string }) => useTurnState({ channelArn: arn, responderIds: ['atlas'] }),
      { initialProps: { arn: CHANNEL } },
    );
    await waitFor(() => expect(result.current.queuedIds.has('m-in-c1')).toBe(true));

    // The new room is not busy, and it must not inherit the old room's set even before its own read
    // lands.
    answers({ atlas: { busy: false, queued: [] } });
    rerender({ arn: `${CHANNEL}-other` });
    expect(result.current.queuedIds.has('m-in-c1')).toBe(false);
  });

  it('renders nothing at all on a deployment that has not wired the endpoint', async () => {
    // Absent configuration means the deployment has no queueing, not that it has an empty queue.
    isTurnStateConfigured.mockReturnValue(false);
    const { result } = renderHook(
      () => useTurnState({ channelArn: CHANNEL, responderIds: ['atlas'] }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchTurnState).not.toHaveBeenCalled();
    // No claim either way: nothing was asked, so nothing is idle and nothing is waiting.
    expect(result.current.readState).toBe('not-yet-read');
    expect(result.current.busy).toBeNull();
    expect(result.current.queuedIds.size).toBe(0);
  });

  it('returns to NOT YET READ on a switch, rather than to an empty queue', async () => {
    answers({ atlas: { busy: false, queued: [] } });
    const { result, rerender } = renderHook(
      ({ arn }: { arn: string }) => useTurnState({ channelArn: arn, responderIds: ['atlas'] }),
      { initialProps: { arn: CHANNEL } },
    );
    await waitFor(() => expect(result.current.readState).toBe('read'));
    expect(result.current.busy).toBe(false);

    // The new room's read has not landed: "nothing is waiting" there is a claim nobody has made.
    let resolve: (v: { busy: boolean; queued: string[] }) => void = () => {};
    fetchTurnState.mockImplementation(() => new Promise((r) => { resolve = r; }));
    rerender({ arn: `${CHANNEL}-other` });
    expect(result.current.readState).toBe('not-yet-read');
    expect(result.current.busy).toBeNull();

    await act(async () => { resolve({ busy: true, queued: ['m-in-c2'] }); });
    await waitFor(() => expect(result.current.readState).toBe('read'));
    expect(result.current.busy).toBe(true);
    expect(result.current.queuedIds.has('m-in-c2')).toBe(true);
  });
});

/**
 * NOT YET READ IS A STATE OF ITS OWN.
 *
 * The hook started from an EMPTY state, so it said "nothing is waiting" before any server had
 * answered - at mount, on every switch, and whenever the set of assistants in a room changed.
 */
describe('no queue claim before a server answers', () => {
  it('starts not-yet-read, with busy unknown rather than false', () => {
    fetchTurnState.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(
      () => useTurnState({ channelArn: CHANNEL, responderIds: ['atlas'] }),
    );
    expect(result.current.readState).toBe('not-yet-read');
    expect(result.current.busy).toBeNull();
    expect(result.current.queuedIds.size).toBe(0);
  });

  it('claims idle once the server answers that nothing is waiting', async () => {
    answers({ atlas: { busy: false, queued: [] } });
    const { result } = renderHook(
      () => useTurnState({ channelArn: CHANNEL, responderIds: ['atlas'] }),
    );
    await waitFor(() => expect(result.current.readState).toBe('read'));
    expect(result.current.busy).toBe(false);
  });

  it('stays not-yet-read when every read fails, and says the state could not be read', async () => {
    answers({ atlas: null });
    const { result } = renderHook(
      () => useTurnState({ channelArn: CHANNEL, responderIds: ['atlas'] }),
    );
    await waitFor(() => expect(result.current.unreadable).toBe(true));
    expect(result.current.readState).toBe('not-yet-read');
    expect(result.current.busy).toBeNull();
  });

  it('does not treat an assistant that has not answered as empty', async () => {
    // Atlas answers idle; Nova's read fails. The room is not idle: Nova is unknown.
    answers({ atlas: { busy: false, queued: [] }, nova: null });
    const { result } = renderHook(
      () => useTurnState({ channelArn: CHANNEL, responderIds: ['atlas', 'nova'] }),
    );
    await waitFor(() => expect(result.current.readState).toBe('partial'));
    expect(result.current.busy).toBeNull();

    // Once Nova answers, the room may be called idle.
    answers({ atlas: { busy: false, queued: [] }, nova: { busy: false, queued: [] } });
    await act(async () => { result.current.refresh(); });
    await waitFor(() => expect(result.current.readState).toBe('read'));
    expect(result.current.busy).toBe(false);
  });

  it('a partial answer still shows what the assistant that answered holds', async () => {
    answers({ atlas: { busy: true, queued: ['m1'] }, nova: null });
    const { result } = renderHook(
      () => useTurnState({ channelArn: CHANNEL, responderIds: ['atlas', 'nova'] }),
    );
    await waitFor(() => expect(result.current.queuedIds.has('m1')).toBe(true));
    expect(result.current.readState).toBe('partial');
    expect(result.current.busy).toBe(true);
  });

  it('keeps what the room already knew when another assistant joins mid-conversation', async () => {
    // The re-fire: a second assistant speaking for the first time changed the responder list, and the
    // hook reset the whole room to EMPTY, dropping the waiting styling off a message still queued.
    answers({ atlas: { busy: true, queued: ['m-atlas'] } });
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useTurnState({ channelArn: CHANNEL, responderIds: ids }),
      { initialProps: { ids: ['atlas'] } },
    );
    await waitFor(() => expect(result.current.queuedIds.has('m-atlas')).toBe(true));

    fetchTurnState.mockImplementation(() => new Promise(() => {}));
    rerender({ ids: ['atlas', 'nova'] });
    // Atlas's answer stands; Nova is unknown, so the room is partial rather than empty or idle.
    expect(result.current.queuedIds.has('m-atlas')).toBe(true);
    expect(result.current.readState).toBe('partial');
    expect(result.current.busy).toBe(true);
  });

  it('treats the same assistants in a different order as the same room', async () => {
    answers({ atlas: { busy: true, queued: ['m1'] }, nova: { busy: false, queued: [] } });
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useTurnState({ channelArn: CHANNEL, responderIds: ids }),
      { initialProps: { ids: ['atlas', 'nova'] } },
    );
    await waitFor(() => expect(result.current.readState).toBe('read'));
    const calls = fetchTurnState.mock.calls.length;

    rerender({ ids: ['nova', 'atlas'] });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchTurnState.mock.calls.length).toBe(calls);
    expect(result.current.readState).toBe('read');
    expect(result.current.queuedIds.has('m1')).toBe(true);
  });
});

/**
 * A PARTIAL READ IS PARTIAL KNOWLEDGE.
 *
 * `fetchTurnState` maps a network error, a 403 and a 5xx all to null, so "Nova did not answer" and
 * "Nova has nothing queued" arrive here identically unless the count is checked. The all-failed guard
 * covered only the case where NOBODY answered; one assistant answering empty while the other's read
 * failed produced the same union as both answering empty, and the message queued behind the one that
 * failed lost its waiting styling until the next transcript event.
 */
describe('a failed read is not an empty answer, even when another responder answered', () => {
  it('keeps a queued id when the responder that held it did not answer', async () => {
    answers({
      atlas: { busy: true, queued: ['m-behind-nova'] },
      nova: { busy: true, queued: ['m-behind-nova'] },
    });
    const { result } = renderHook(
      () => useTurnState({ channelArn: CHANNEL, responderIds: ['atlas', 'nova'] }),
    );
    await waitFor(() => expect(result.current.queuedIds.has('m-behind-nova')).toBe(true));

    // Nova's read now fails and Atlas reports nothing. Atlas alone cannot retract Nova's queue.
    answers({ atlas: { busy: false, queued: [] }, nova: null });
    await act(async () => { result.current.refresh(); });

    await waitFor(() => expect(fetchTurnState).toHaveBeenCalledTimes(4));
    expect(result.current.queuedIds.has('m-behind-nova')).toBe(true);
    expect(result.current.busy).toBe(true);
  });

  it('STILL clears the id once every responder has answered and none holds it', async () => {
    // The other direction, so the fix cannot be "never clear anything" - which would strand the
    // waiting styling on messages that have long since been answered.
    answers({
      atlas: { busy: true, queued: ['m1'] },
      nova: { busy: true, queued: ['m1'] },
    });
    const { result } = renderHook(
      () => useTurnState({ channelArn: CHANNEL, responderIds: ['atlas', 'nova'] }),
    );
    await waitFor(() => expect(result.current.queuedIds.has('m1')).toBe(true));

    answers({ atlas: { busy: false, queued: [] }, nova: { busy: false, queued: [] } });
    await act(async () => { result.current.refresh(); });

    await waitFor(() => expect(result.current.queuedIds.has('m1')).toBe(false));
  });
});

/**
 * THE HALF THE RULE ABOVE WAS MISSING (code review, 2026-09-04).
 *
 * "A partial read may add and may never retract" was implemented against the MERGED set, so a single
 * responder failing steadily froze what every OTHER responder had ever reported. The two tests above
 * both pass on that implementation, because in each of them the id belongs to the responder that
 * failed. Nothing pinned the case where it does not.
 *
 * A read is entitled to take back exactly what it asked about. An assistant reporting an empty queue
 * is the authority on its own queue, whatever happened to somebody else's.
 */
describe('a read retracts what it asked, and only that', () => {
  it('drops the id held by the responder that answered, while keeping the other', async () => {
    answers({
      atlas: { busy: true, queued: ['m-atlas'] },
      nova: { busy: true, queued: ['m-nova'] },
    });
    const { result } = renderHook(
      () => useTurnState({ channelArn: CHANNEL, responderIds: ['atlas', 'nova'] }),
    );
    await waitFor(() => expect(result.current.queuedIds.has('m-atlas')).toBe(true));
    expect(result.current.queuedIds.has('m-nova')).toBe(true);

    // Atlas finishes and says so. Nova's read fails - a stale token, a misconfigured route - and goes
    // on failing, which is the condition that used to pin the styling for the life of the room.
    answers({ atlas: { busy: false, queued: [] }, nova: null });
    await act(async () => { result.current.refresh(); });

    await waitFor(() => expect(result.current.queuedIds.has('m-atlas')).toBe(false));
    // And Nova's is untouched: nothing asked it, so nothing may speak for it.
    expect(result.current.queuedIds.has('m-nova')).toBe(true);
    expect(result.current.busy).toBe(true);
  });

  // A TEST FOR A DEPARTED ASSISTANT WAS REMOVED HERE, because it could not fail (code review,
  // 2026-09-04). Changing `responderIds` changes `key`, which changes `read`, which fires the mount
  // effect that clears `perResponder` and resets state before any carry-forward runs. The test
  // passed whatever the carry-forward did, and a test that cannot fail is worse than none: it
  // reports coverage of a rule nothing is checking.
  //
  // The property still holds - the reset is what delivers it - so it is stated where the reset is.
});
