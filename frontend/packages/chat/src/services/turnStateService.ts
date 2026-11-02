/**
 * WHAT IS WAITING IN THIS CONVERSATION (ADR-033).
 *
 * Frontend client for GET /turn-state. It answers two things the transcript cannot: whether the
 * assistant is busy, and which of the messages already on screen are still waiting to be read.
 *
 * ── WHY A FETCH AND NOT A DERIVATION FROM THE TRANSCRIPT ─────────────────────────────────────────
 *
 * Because ordering is not a reliable encoding of set membership. A client that reloaded with partial
 * history, joined the conversation late, or has scrolled a window that does not reach the message
 * which triggered the deferral all derive the wrong answer, and each of those is ordinary rather than
 * exotic. The record is authoritative and cannot be forged; this reads it.
 *
 * ── THE CLIENT BELIEVES THE RECORD ───────────────────────────────────────────────────────────────
 *
 * When the two disagree, the record wins, and a client holding queued state for a conversation the
 * record says is not busy treats it as ended. Between the two possible visible failures, a moment of
 * stale styling is better than a message that appears lost.
 *
 * ── UNCONFIGURED AND FAILED ARE DIFFERENT, AND NEITHER IS AN ERROR THE USER SEES ─────────────────
 *
 * A deployment that has not wired the endpoint simply has no queueing, and renders nothing. A failed
 * poll returns null - NOT an empty state - so the caller keeps whatever it last knew rather than
 * clearing the styling on messages that are still waiting. "Nothing is waiting" is a claim, and it
 * must come from the server rather than from a network error.
 */

import { personApiServes, personUrl } from '@ae/shared';

export interface TurnState {
  /** True when a turn is running for this assistant, whoever it belongs to. */
  busy: boolean;
  /** The waiting messages THIS user can see, in the order they were sent. */
  queued: string[];
  /** The deferral notice this conversation is showing, if one was posted. */
  noticeId?: string;
  /**
   * WHY THIS USER'S LAST TURN NEVER RAN, when one did not.
   *
   * A REASON CODE, never a sentence. The server deliberately sends no prose: the copy a person reads
   * has to carry their language, and the server cannot know it. The client resolves the code through
   * i18n, which is why this is a closed union rather than a string - an unrecognised code renders the
   * generic line rather than nothing, but the set is meant to be exhaustive.
   *
   * SCOPED TO THIS USER. The failure happened to whoever's message went unanswered; the rest of the
   * room neither saw it nor needs to, which is the thing a posted message could not do.
   */
  dispatchFailed?: 'assistant_unreachable' | 'handoff_failed' | 'reply_undeliverable';
}

export function isTurnStateConfigured(): boolean {
  return personApiServes('core');
}

/**
 * Read the conversation's waiting state.
 *
 * NULL MEANS "I DO NOT KNOW", and the caller keeps what it has. An empty `queued` means the server
 * said nothing is waiting, which is a different statement and the only one that may clear styling.
 *
 * The responder is required because busy is a property of a RESPONDER, not a conversation: two people
 * addressing two assistants in one room should both get answers. The server refuses a request without
 * one rather than answering about a key that does not exist.
 */
export async function fetchTurnState(args: {
  channelArn: string;
  responderId: string;
}): Promise<TurnState | null> {
  if (!personApiServes('core') || !args.channelArn || !args.responderId) return null;

  const idToken = localStorage.getItem('idToken');
  if (!idToken) return null;

  const url = personUrl(`/turn-state?channelArn=${encodeURIComponent(args.channelArn)}&responderId=${encodeURIComponent(args.responderId)}`);

  try {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    });
    if (!response.ok) {
      // 403 is a real answer - not a member - but it is still not "nothing is waiting", so it is
      // treated the same as any other failure: keep what we have and stop asking nothing of the user.
      console.warn('[turnState] fetch failed:', response.status);
      return null;
    }
    const body = (await response.json()) as Partial<TurnState>;
    // Guarded field by field. A malformed body must not become a confident empty state, for the same
    // reason a failed fetch must not.
    if (typeof body?.busy !== 'boolean' || !Array.isArray(body?.queued)) return null;
    return {
      busy: body.busy,
      queued: body.queued.filter((id): id is string => typeof id === 'string'),
      ...(typeof body.noticeId === 'string' ? { noticeId: body.noticeId } : {}),
      /**
       * THE FIELD THAT SAYS WHY THIS PERSON'S TURN NEVER RAN, WHICH THIS PARSE USED TO DROP.
       *
       * The server sends it (`turn-state-api.ts` spreads `dispatchFailed: failure.reason`), the type
       * above declares it, `useTurnState` folds it, and `ConversationInterface` renders a banner off
       * it - and this function returned only `busy`, `queued` and `noticeId`, so the banner was
       * unreachable and a person whose turn was never dispatched was told nothing at all.
       *
       * KEPT AS ANY NON-EMPTY STRING, not narrowed to the known codes. The type's own contract is that
       * "an unrecognised code renders the generic line rather than nothing", and filtering here to the
       * three current values would make a NEW server-side reason disappear silently - the same
       * drop-by-omission this field just came back from. The union is the set the UI has copy for, not
       * the set the client will accept.
       */
      ...(typeof body.dispatchFailed === 'string' && body.dispatchFailed
        ? { dispatchFailed: body.dispatchFailed as TurnState['dispatchFailed'] }
        : {}),
    };
  } catch (error) {
    console.warn('[turnState] fetch error:', error);
    return null;
  }
}
