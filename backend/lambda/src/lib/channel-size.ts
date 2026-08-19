/**
 * How many members a channel has, as BOTH sides of the `@all` handoff must agree it.
 *
 * WHY THIS IS ONE SHARED MODULE AND NOT TWO LOCAL READS. The channel flow decides whether to take the
 * `@all` bypass, and the router decides whether to stand down for it. Those two decisions must be the
 * exact complement of each other: if they disagree about the channel's size, either BOTH answer (the
 * duplicate this exists to remove) or NEITHER does (a turn that silently goes unanswered). That is the
 * same failure mode `lib/flow-bypass.ts` exists to prevent for the token itself, and it is solved the
 * same way - one definition, imported by both.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT CHANGED AND WHY, because this reverses a recorded decision.
 *
 * `@all` used to take the flow bypass at EVERY channel size, with the router silencing the Lex entry
 * to keep one responder. The comment in `router-agent-handler.ts` argued against a member-count branch
 * on the grounds that one path is simpler and costs no membership read.
 *
 * MEASURED 2026-08-12, that design produced two placeholders on a live 1:1 `@all`, 558ms apart, one of
 * them stranded at "One moment..." forever:
 *
 *   21:23:03.898  bot  "One moment... <!--corr:mention-75e945d5...-->"   <- never answered
 *   21:23:04.456  bot  "Fun fact about the moon: ..."                    <- the answer
 *   21:23:04.609  bot  {"Messages":[]}                                   <- the guard DID fire
 *
 * That third line is no longer reproducible, and the reason is not that the guard stopped firing: the
 * channel flow now DENIES an empty Lex envelope rather than persisting it (`lib/lex-envelope.ts`), so
 * a silent fulfillment leaves no message in the channel at all. The evidence above stands as recorded;
 * it just cannot be re-observed by reading channel history.
 *
 * The guard worked. What failed is subtler: the two entries derive correlation ids by DIFFERENT rules
 * (the flow has the inbound `MessageId`, the Lex path provably does not receive one), so the same turn
 * carried two incomparable identities and the duplicate-placeholder claim never saw a collision to
 * deny. Zero `duplicate placeholder denied` lines were logged for the incident.
 *
 * A member-count branch fixes that at the root rather than by luck: in a 1:1 only ONE entry runs, so
 * there is only one identity and nothing to reconcile.
 *
 * THE COST THE OLD COMMENT WARNED ABOUT IS REAL AND IS BOUNDED. The membership read happens only on a
 * turn that actually carries a bypass token, never on the ordinary path.
 * ---------------------------------------------------------------------------------------------
 */

import {
  ChimeSDKMessagingClient,
  ListChannelMembershipsCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
// There is no stored member count to read, and reintroducing one is a regression: see the note in
// `resolveChannelSize` for why a recorded count cannot serve this decision. The archival path
// publishes none, no read-side accessor exists, and the live read below is the only source.

/**
 * A channel with exactly the user and the assistant. At this size Amazon Chime SDK's AUTO trigger
 * routes EVERY message to Lex regardless of mentions, so the Lex entry is guaranteed to run and is
 * therefore the one that should answer - the flow stands aside.
 *
 * Above this size the assistant is in MENTIONS mode, `@all` is not a Chime mention value, and Lex is
 * NOT invoked - so the flow's bypass is the only thing that can answer.
 */
export const ONE_TO_ONE_MEMBER_COUNT = 2;

export interface ChannelSize {
  memberCount: number;
  /** True when the flow must stand aside and let the Lex entry answer. */
  isOneToOne: boolean;
  /** True when the count could not be read. See `resolveChannelSize`. */
  unknown: boolean;
}

/**
 * Read the channel's member count.
 *
 * FAILS TOWARD THE GROUP SHAPE, and the choice is deliberate. If the count cannot be read we report
 * `isOneToOne: false`, which means the flow keeps the bypass and the router keeps standing down - in
 * other words, EXACTLY the behaviour that shipped before this branch existed. An unreadable count
 * therefore degrades to the previous design rather than to silence, and a turn is always answered by
 * someone. Failing the other way would risk a conversation where nothing replies at all, which is the
 * worse outcome of the two: a duplicate is visible and annoying, an unanswered turn looks like the
 * product is broken.
 */
export async function resolveChannelSize(
  client: ChimeSDKMessagingClient,
  channelArn: string,
  bearerArn: string,
): Promise<ChannelSize> {
  // ONE SOURCE, AND IT IS THE LIVE READ. An event-written count from the Kinesis archival path is the
  // obvious way to spend a DynamoDB GetItem instead of an Amazon Chime SDK call, and it is rejected on
  // two independent grounds:
  //
  //  - IT COLLAPSES BOTS. A count derived from `channel_membership` sees only `/user/` ARNs, so it
  //    counts humans and adds a fixed one for the assistant. A battle channel is one user and TWO bots
  //    and reports 2, which answers "does this bot see exactly one other member?" with `true` for a
  //    3-member room. The flow then stands aside for `@all` while Amazon Chime SDK, seeing two other
  //    members, keeps the bot in MENTIONS mode and never invokes Lex - so nobody answers, the worse of
  //    the two failure directions this module names.
  //  - ONLY ONE CALLER COULD REACH IT. The channel flow has no `CHANNEL_CONTEXT_TABLE` env and no grant
  //    on that table, so it falls through to the live read regardless. The two halves of a decision that
  //    must be exact complements would compute it from different sources with different semantics - the
  //    precise failure this module exists to prevent.
  //
  // The live read counts what Amazon Chime SDK counts, which is what the routing rule is actually
  // about, and both callers run this same code against that same source. It is paid only on a turn
  // carrying a bypass token, and since `/battle` does not consult size at all (the flow owns it at
  // every size), that means `@all` turns alone.
  try {
    const resp = await client.send(
      new ListChannelMembershipsCommand({
        ChannelArn: channelArn,
        ChimeBearer: bearerArn,
        MaxResults: 50,
      }),
    );
    const memberCount = (resp.ChannelMemberships || []).length;
    // Zero is not a real answer: a channel always has at least its creator. Treat it as unreadable
    // rather than as "smaller than a 1:1", which would flip the branch on an empty response.
    if (memberCount === 0) {
      return { memberCount: 0, isOneToOne: false, unknown: true };
    }
    return {
      memberCount,
      isOneToOne: memberCount <= ONE_TO_ONE_MEMBER_COUNT,
      unknown: false,
    };
  } catch (err) {
    console.warn('[channel-size] ListChannelMemberships failed; treating the channel as a group', err);
    return { memberCount: 0, isOneToOne: false, unknown: true };
  }
}
