/**
 * THE REASON A TURN NEVER RAN HAS TO SURVIVE THE PARSE, AND IT DID NOT.
 *
 * Every other layer of this was built: the server sends `dispatchFailed` (`turn-state-api.ts` spreads
 * `failure.reason`), `TurnState` declares it, `useTurnState` folds it, and `ConversationInterface`
 * renders a banner off it. `fetchTurnState` returned only `busy`, `queued` and `noticeId`, so the field
 * was dropped on arrival - the banner was unreachable and a person whose message was never dispatched
 * was told nothing at all. They watched a conversation that looked idle.
 *
 * WHY NO TEST CAUGHT IT, WHICH IS THE PART WORTH KEEPING. `useTurnState.dispatchFailed.test.ts` asserts
 * the fold - and defines its OWN LOCAL COPY of that fold to avoid standing up a React tree. A copy of
 * the logic cannot observe the transport, so it passed for weeks while the field never arrived. Four
 * layers were tested and the seam between two of them was not.
 *
 * So these go through `fetchTurnState` itself. That is the only assertion that would have failed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchTurnState } from './turnStateService';

const BASE = 'https://person.example.test/';

/** A server body, as the API composes it. */
const body = (over: Record<string, unknown> = {}) => ({ busy: false, queued: [], ...over });

const respondWith = (payload: unknown, ok = true) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  }));
};

beforeEach(() => {
  vi.stubEnv('VITE_PERSON_API_URL', BASE);
  localStorage.setItem('idToken', 'test-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});

const read = () => fetchTurnState({ channelArn: 'arn:aws:chime:test:channel/abc', responderId: 'bot-1' });

describe('fetchTurnState surfaces why a turn never ran', () => {
  it.each(['assistant_unreachable', 'handoff_failed', 'reply_undeliverable'] as const)(
    'carries the %s reason through the parse',
    async (reason) => {
      respondWith(body({ dispatchFailed: reason }));
      expect((await read())?.dispatchFailed).toBe(reason);
    },
  );

  it('passes an UNRECOGNISED reason through, so a new server code is not silently dropped', async () => {
    // The type's contract is that an unknown code renders the generic line rather than nothing.
    // Narrowing here to the three current values would make the next server-side reason vanish - the
    // same drop-by-omission this field just came back from.
    respondWith(body({ dispatchFailed: 'some_future_reason' }));
    expect((await read())?.dispatchFailed).toBe('some_future_reason');
  });

  it('is absent when the server sends none, rather than invented', async () => {
    respondWith(body());
    const state = await read();
    expect(state).not.toBeNull();
    expect(state?.dispatchFailed).toBeUndefined();
  });

  it('ignores a non-string or empty reason instead of rendering an empty banner', async () => {
    for (const bad of [42, '', null, {}, []]) {
      respondWith(body({ dispatchFailed: bad }));
      expect((await read())?.dispatchFailed).toBeUndefined();
    }
  });

  it('still returns the rest of the state, so the field cannot break the ordinary read', async () => {
    respondWith(body({ busy: true, queued: ['m-1', 'm-2'], noticeId: 'n-1', dispatchFailed: 'handoff_failed' }));
    expect(await read()).toEqual({
      busy: true,
      queued: ['m-1', 'm-2'],
      noticeId: 'n-1',
      dispatchFailed: 'handoff_failed',
    });
  });

  it('still returns null on a malformed body, reason or no reason', async () => {
    // "I do not know" must not become a confident state just because a reason came with it.
    respondWith({ queued: [], dispatchFailed: 'handoff_failed' }); // no `busy`
    expect(await read()).toBeNull();
  });
});
