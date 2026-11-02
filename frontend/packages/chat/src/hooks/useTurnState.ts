/**
 * THE WAITING STATE THE COMPOSER AND THE TRANSCRIPT BOTH RENDER FROM (ADR-033).
 *
 * One hook so there is ONE answer to "is anything waiting here". Two components deriving it
 * separately is how a transcript styles a message as queued while the composer believes the
 * conversation is idle.
 *
 * ── IT IS EVENT-DRIVEN, BECAUSE THE EVENT ALREADY EXISTS ────────────────────────────────────────
 *
 * This polled on an interval first, which is implementation tenet D6 waved at and stepped over: if a
 * system already emits an event for a state change, subscribe to it rather than asking again.
 *
 * The event was there the whole time. The deferral notice is an ordinary channel message, posted when
 * the queue starts, UPDATED on every further queued send, and updated again when the drain empties it
 * - so every queue change already produces a message event the SPA receives on its existing
 * subscription. Watching it is the ADR's own store-plus-notification shape, with the notification
 * riding a message the client is handed anyway instead of a new CONTROL type whose size limit this
 * codebase has never verified.
 *
 * The record stays authoritative: the event says something CHANGED and carries a depth, and the
 * client re-reads. It does not carry the queue, so a message event can never be mistaken for the
 * state itself.
 *
 * ── NOT YET READ IS A STATE OF ITS OWN ───────────────────────────────────────
 *
 * "Nothing is waiting" is a claim, and only a server answer may make it. Before any assistant in this
 * conversation has answered, the hook says `not-yet-read` and `busy` is `null`: no claim either way.
 * It used to start from an EMPTY state, which published "nothing is waiting" before anything had been
 * asked, published it again on every conversation switch, and again mid-conversation whenever the set
 * of assistants in a room changed. An assistant that has not answered is unknown, never empty, so a
 * room with several assistants is `partial` until each of them has.
 *
 * ── THE COMPOSER IS NEVER DISABLED ───────────────────────────────────────────────────────────────
 *
 * Disabling it while the assistant works is the obvious move and it is wrong: queueing exists so a
 * person CAN keep typing, a blocked composer turns a deferral into a refusal they cannot even
 * attempt, and it removes the only way to send `/stop`. This hook therefore reports state and never
 * gates input - there is deliberately no `disabled` in what it returns.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchTurnState, isTurnStateConfigured, type TurnState } from '../services/turnStateService';

const RETRY_AFTER_MS = 5000;

/**
 * How much of the conversation's waiting state a server has actually answered for.
 *
 * - `not-yet-read`: no assistant in this conversation has answered. Nothing may be claimed.
 * - `partial`: some have. What they reported may be shown; the others are unknown, not empty.
 * - `read`: every assistant in the conversation has answered at least once.
 */
export type TurnStateReadState = 'not-yet-read' | 'partial' | 'read';

export interface UseTurnStateResult {
  /**
   * True when a server said a turn is running for an assistant here; false only when EVERY assistant
   * has answered and none is busy; null when that is not known yet.
   */
  busy: boolean | null;
  /**
   * Message ids a server said are still waiting. Only positive claims: an id absent from this set is
   * not a claim that it is not waiting unless `readState` is `read`.
   */
  queuedIds: Set<string>;
  /** How much of this is a server's answer rather than the absence of one. */
  readState: TurnStateReadState;
  /**
   * WHY THIS USER'S LAST TURN NEVER RAN, when an assistant could not be reached at all.
   *
   * A reason code the surface renders through i18n, never a sentence from the server. It is absent on
   * the ordinary path: a turn that is merely slow is `busy`, not failed. A surface showing this is
   * saying "your message was delivered and nothing is coming", which is a different statement from
   * "still working" and has to be distinguishable from it.
   */
  dispatchFailed?: TurnState['dispatchFailed'];
  /** True when the last read told us nothing: what is reported is the LAST KNOWN state, not a
   *  current one, and a retry is already scheduled. */
  unreadable: boolean;
  /** Ask again now - after sending, or on reconnect. */
  refresh: () => void;
}

/** The answers held, and which conversation they belong to. */
interface Answers {
  channelArn: string | null;
  byResponder: Record<string, TurnState>;
}

/** When an answer's placeholder should have arrived after a person's send. */
export const FIRST_RESPONSE_DEADLINE_MS = 15_000;
/** When a turn that started should have answered: past the router's 30-second budget and a long answer. */
export const TURN_DEADLINE_MS = 120_000;

export function useTurnState(args: {
  channelArn: string | null;
  /**
   * EVERY assistant in the conversation, not one.
   *
   * Busy is a property of a responder, so a room with several has several queues. Reading one of them
   * - the first bot member, which is what this did first - reports that assistant and silently styles
   * a message queued behind any OTHER assistant as not waiting.
   */
  responderIds: string[];
  /**
   * A value that CHANGES whenever the queue might have. The caller derives it from the deferral
   * notice already in its message list - the notice is posted when the queue starts, updated on every
   * further queued send, and updated again when the drain empties it, so it changes exactly when the
   * state does.
   *
   * The signal says something HAPPENED; it never carries the queue. The record stays the only
   * authority, so a message event can never be mistaken for the state itself.
   */
  changeSignal?: string;
  /**
   * When this person's newest message was sent, while no assistant message has arrived after it; undefined
   * otherwise. A turn that cannot start, or an answer that cannot be delivered, posts nothing, so no message
   * event would ever trigger the read that shows why. So the state is read once more at each of two known
   * deadlines after the send, and an assistant's message arriving clears this and cancels both. Bounded
   * waits on a deadline the turn already has, not polling (tenet D6): nothing streams "nothing arrived".
   */
  awaitingReplySince?: number;
}): UseTurnStateResult {
  const { channelArn, responderIds, changeSignal, awaitingReplySince } = args;
  // SORTED AND DEDUPLICATED, so the same assistants in a different order are the same room. The caller
  // builds the list from the roster and the transcript, and an order change alone used to look like a
  // different set of assistants and discard what they had said.
  const key = Array.from(new Set(responderIds.filter(Boolean))).sort().join(',');
  /**
   * WHAT EACH ASSISTANT LAST SAID, rather than one merged answer. A union cannot be un-unioned: once
   * "queued" is folded into a single set, nothing left in it says WHICH assistant is holding that
   * message, so a later read cannot tell what it is entitled to take back. Keeping the answers apart
   * is what lets a responder retract its own ids without touching one that did not answer, and what
   * lets an assistant that has not answered stay unknown rather than empty.
   *
   * Held in state so the surface re-renders, and mirrored in a ref so a read can build on the latest
   * answers without re-creating itself on every one.
   */
  const [held, setHeld] = useState<Answers>({ channelArn, byResponder: {} });
  const answersRef = useRef<Answers>(held);
  const publish = useCallback((next: Answers) => {
    answersRef.current = next;
    setHeld(next);
  }, []);
  /**
   * The last read told us nothing, so what is shown is STALE rather than current.
   *
   * The surface needs to be able to say so. Holding the previous state is the right call about the
   * data - a failed read is not evidence that a queue emptied - but on its own it shows a queue that
   * has stopped moving, which is indistinguishable from one nobody is working on.
   */
  const [unreadable, setUnreadable] = useState(false);
  /** The pending retry, cleared on unmount and whenever a read succeeds or supersedes one. */
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // WHICH READ IS THE LATEST. Reads are fired by events, so two can be in flight and they can come
  // back in either order: one issued while a message was queued, resolving AFTER the drain's read
  // returned empty, re-installed the queue that had just gone - and nothing corrects it, because
  // the next read only happens on the next event. The waiting styling then stays for the life of
  // the conversation. The same gap writes one conversation's state into another after a switch.
  const latest = useRef(0);
  // The retry fires later than the closure that armed it, so it calls through a ref rather than
  // capturing a stale `read` - and `scheduleRetry` therefore has no dependency on it.
  const readRef = useRef<(() => Promise<void>) | null>(null);

  /**
   * Try again after a failed read, once, at a fixed interval.
   *
   * NOT A POLL. It is armed only by a read that told us nothing and disarmed by one that did, so a
   * working conversation never schedules one - the subscription on the notice remains how this stays
   * current. A fixed delay rather than a backoff because the failure it recovers from is a throttle
   * or a stale token, both of which clear in seconds, and because a growing delay on a surface
   * somebody is watching reads as the queue having stopped.
   */
  const scheduleRetry = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      void readRef.current?.();
    }, RETRY_AFTER_MS);
  }, []);

  const read = useCallback(async () => {
    const mine = latest.current + 1;
    latest.current = mine;
    // NOTHING TO ASK, SO NOTHING IS CLAIMED. An unconfigured deployment has no queueing, and a
    // conversation with no assistant has nobody to answer; neither is an empty queue.
    if (!channelArn || !key || !isTurnStateConfigured()) {
      publish({ channelArn, byResponder: {} });
      return;
    }
    // ONE READ PER ASSISTANT, then unioned. A message is waiting if ANY assistant is holding it, and
    // the conversation is busy if any of them is - which is what the styling and the composer copy
    // both need. Concurrent, because they are independent questions about independent queues.
    const ids = key.split(',');
    const results = await Promise.all(
      ids.map((responderId) => fetchTurnState({ channelArn, responderId })),
    );
    // A LATER READ HAS ALREADY SPOKEN, so this one is history and must not overwrite it.
    if (latest.current !== mine) return;
    // ── A READ MAY RETRACT WHAT IT ASKED, AND ONLY THAT (code review, 2026-09-04) ───────────────
    //
    // `results` is positional against the responder list, so every answer has an author. An answer
    // REPLACES that responder's previous one - retraction included, since an assistant reporting an
    // empty queue is the authority on its own queue - and a responder that did not answer keeps what
    // it last said, or stays unknown if it never said anything.
    const previous = answersRef.current.channelArn === channelArn ? answersRef.current.byResponder : {};
    const byResponder: Record<string, TurnState> = {};
    let answers = 0;
    ids.forEach((responderId, i) => {
      const fresh = results[i];
      if (fresh) { byResponder[responderId] = fresh; answers += 1; return; }
      // Built from `ids` rather than from the previous map, so the set never grows beyond the
      // assistants being asked.
      const last = previous[responderId];
      if (last) byResponder[responderId] = last;
    });

    // EVERY read failing means we know nothing new, so the last state stands. Clearing here would
    // drop the waiting styling off messages that are still queued each time a read happened to fail.
    //
    // AND IT IS SAID OUT LOUD, then tried again. `unreadable` lets the surface
    // say the state could not be read rather than implying it is current.
    if (!answers) {
      setUnreadable(true);
      scheduleRetry();
      return;
    }
    setUnreadable(false);
    publish({ channelArn, byResponder });
  }, [channelArn, key, publish, scheduleRetry]);

  // The retry calls through this, so it always runs the CURRENT read rather than the one that was
  // in scope when the failure happened.
  readRef.current = read;

  // THE RETRY, and it exists because nothing else would fire one. The subscription re-reads when the
  // NOTICE changes, and a failed read changes nothing - so without this the stale state stands until
  // the queue happens to move again, which for a queue nobody is draining is never.
  //
  // One pending attempt at a time, and it is cleared on unmount: a timer that outlives the
  // conversation would call `read` against a room the person has left, which is the same mistake the
  // token below guards against for in-flight requests.
  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);

  // A CONVERSATION SWITCH RETURNS TO NOT-YET-READ, never to empty, and carries nothing across: the
  // ids would be styled against a transcript they do not belong to.
  //
  // A CHANGE IN WHICH ASSISTANTS ARE HERE, in the same conversation, keeps what the remaining ones
  // said and drops only the departed ones'. The newcomer is unknown until it answers. Resetting the
  // whole room here is what published "nothing is waiting" mid-conversation every time another
  // assistant spoke for the first time.
  useEffect(() => {
    // Bumping the token drops anything already in flight for the room or roster being left.
    latest.current += 1;
    const current = answersRef.current;
    const kept: Record<string, TurnState> = {};
    if (current.channelArn === channelArn) {
      for (const responderId of key ? key.split(',') : []) {
        if (current.byResponder[responderId]) kept[responderId] = current.byResponder[responderId];
      }
    }
    publish({ channelArn, byResponder: kept });
    setUnreadable(false);
    void read();
  }, [channelArn, key, publish, read]);

  // THE TWO DEADLINES. The first is when an answer's placeholder should have arrived (a turn that could not
  // start is recorded within a second or two); the second is when a turn that started should have answered
  // (an undeliverable answer is recorded after the model runs). Each is one read.
  useEffect(() => {
    if (awaitingReplySince === undefined) return undefined;
    const timers = [FIRST_RESPONSE_DEADLINE_MS, TURN_DEADLINE_MS].map((deadline) => {
      const wait = Math.max(0, awaitingReplySince + deadline - Date.now());
      return setTimeout(() => { void readRef.current?.(); }, wait);
    });
    return () => timers.forEach(clearTimeout);
  }, [awaitingReplySince]);

  // THE SUBSCRIPTION, such as it is. The caller's signal changes when the notice does, which is when
  // the queue does - so this re-reads on the event rather than on a timer.
  useEffect(() => {
    if (changeSignal === undefined) return;
    void read();
  }, [changeSignal, read]);

  // DERIVED FOR THE CONVERSATION AND ASSISTANTS BEING ASKED NOW, so a render between a switch and
  // the reset effect above can never show one room's answers in another.
  const derived = useMemo(() => {
    const ids = key ? key.split(',') : [];
    const answered = held.channelArn === channelArn
      ? ids.map((id) => held.byResponder[id]).filter((r): r is TurnState => Boolean(r))
      : [];
    const readState: TurnStateReadState = answered.length === 0
      ? 'not-yet-read'
      : answered.length < ids.length ? 'partial' : 'read';
    const anyBusy = answered.some((r) => r.busy);
    return {
      readState,
      // Busy is known the moment one assistant says so; idle only once every one has answered.
      busy: anyBusy ? true : readState === 'read' ? false : null,
      queuedIds: new Set(answered.flatMap((r) => r.queued)),
      // WHY NOTHING CAME BACK, when an assistant could not be reached at all.
      //
      // FIRST ANSWER WINS rather than a list. In a room with several assistants a person addressed
      // one of them, and telling them "two of your three assistants are unreachable" describes the
      // deployment rather than their turn. One honest line about the turn that did not happen.
      dispatchFailed: answered.find((r) => r.dispatchFailed)?.dispatchFailed,
    };
  }, [held, channelArn, key]);

  return {
    busy: derived.busy,
    queuedIds: derived.queuedIds,
    readState: derived.readState,
    dispatchFailed: derived.dispatchFailed,
    /**
     * True when the last attempt to read the queue told us nothing.
     *
     * What is reported alongside it is the LAST KNOWN state, not a current one. A surface should say
     * so rather than present it as fact - and a retry is already scheduled, so it clears itself
     * without the person doing anything.
     */
    unreadable,
    refresh: () => { void read(); },
  };
}
