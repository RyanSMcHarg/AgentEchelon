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

import type { BypassMember } from './flow-bypass.js';
import { isAccessDenial } from './access-denial.js';
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

/**
 * How many pages of membership to read. At 50 per page this is 500 members, which is past any
 * conversation this product is shaped for, and it bounds a read that sits on a request path.
 */
const MEMBERSHIP_PAGE_LIMIT = 10;

export interface ChannelSize {
  memberCount: number;
  /**
   * The roster this count was taken from, for resolving an `@<member>` token (ADR-034).
   *
   * CARRIED RATHER THAN RE-READ. The membership list is already fetched to count it and was
   * previously discarded, so both callers - the flow deciding whether to act, the handler deciding
   * whether to stand down - get the names for nothing. A second read would also be a second ANSWER:
   * two reads moments apart can disagree about who is in the room, and the two sides would then
   * resolve the same mention differently, which is the drift `flowOwnsTheTurn` exists to prevent.
   *
   * EMPTY WHEN THE COUNT COULD NOT BE READ, alongside `unknown`. A mention then resolves to nobody
   * and the flow does not claim the turn, which is the same direction `isOneToOne: false` fails in:
   * the ordinary Lex path still answers.
   */
  members: BypassMember[];
  /** True when the flow must stand aside and let the Lex entry answer. */
  isOneToOne: boolean;
  /** True when the count could not be read. See `resolveChannelSize`. */
  unknown: boolean;
  /**
   * True when the read was REFUSED rather than merely failing: the classification boundary spoke.
   *
   * SEPARATE FROM `unknown` BECAUSE THEY POINT OPPOSITE WAYS. `unknown` means "carry on with the
   * group shape", which is this module's deliberate fail-toward-answering choice and is right for a
   * throttle. A refusal is not a degraded read of a channel this assistant may act in; it is AWS
   * saying the assistant may not act in this channel at all. Continuing then is not resilience, it
   * is the boundary being enforced and ignored (ADR-045 decision 1).
   *
   * Every refusal is also `unknown: true`, so a caller that has not been taught about `refused`
   * keeps its previous behavior rather than silently reading a refusal as a successful count of
   * zero. Callers that must stop check this field.
   */
  refused: boolean;
}

/**
 * Read the channel's member count.
 *
 * FAILS TOWARD THE GROUP SHAPE, and the choice is deliberate. If the count cannot be read we report
 * `isOneToOne: false`, which means the flow keeps the bypass and the router keeps standing down - in
 * other words, EXACTLY the behavior that shipped before this branch existed. An unreadable count
 * therefore degrades to the previous design rather than to silence, and a turn is always answered by
 * someone. Failing the other way would risk a conversation where nothing replies at all, which is the
 * worse outcome of the two: a duplicate is visible and annoying, an unanswered turn looks like the
 * product is broken.
 *
 * WITH ONE EXCEPTION, AND IT IS NOT A DEGRADATION (ADR-045 decision 1). The paragraph above weighs a
 * duplicate against a silence, and both of those assume the assistant is entitled to answer this
 * channel at all. When the read is REFUSED it is not. `refused: true` is then set alongside
 * `unknown`, and a caller that honors it ends the turn: silence is the correct outcome, not the
 * lesser evil. The trade this makes is stated once so it is not rediscovered as a bug - an assistant
 * refused by the boundary says nothing, which to a person looks the same as the flow-failure silence
 * that has no monitoring answer yet. The SecurityEvent and the count are what
 * distinguish them to an operator.
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
  // PAGINATED, WHICH IT DID NOT USED TO BE. One page answered the only question this module asked -
  // "is this channel exactly two members?" - because a first page of 50 settles that for every channel
  // that exists. It does NOT settle WHO is in the room. Stopping at one page would make the 51st
  // member unmentionable: their name resolves to nobody, the flow does not claim the turn, and
  // nothing says so. Bounded below rather than unbounded, because this runs on a request path.
  const members: BypassMember[] = [];
  let memberCount = 0;
  try {
    let nextToken: string | undefined;
    for (let page = 0; page < MEMBERSHIP_PAGE_LIMIT; page++) {
      const resp = await client.send(
        new ListChannelMembershipsCommand({
          ChannelArn: channelArn,
          ChimeBearer: bearerArn,
          MaxResults: 50,
          ...(nextToken ? { NextToken: nextToken } : {}),
        }),
      );
      for (const m of resp.ChannelMemberships || []) {
        memberCount++;
        const arn = m.Member?.Arn;
        const name = m.Member?.Name;
        if (arn && name) members.push({ arn, name, isBot: arn.includes('/bot/') });
      }
      nextToken = resp.NextToken;
      if (!nextToken) break;
    }
    if (nextToken) {
      // A channel larger than the bound. The count is still right for the 1:1 branch (it is far past
      // it), and the roster is a prefix - so a mention of somebody on a later page resolves to nobody.
      // Said out loud rather than discovered by a person being ignored in front of the room.
      console.warn(
        '[channel-size] roster truncated at',
        members.length,
        'members; an @ mention of a later member will not resolve',
      );
    }
    // Zero is not a real answer: a channel always has at least its creator. Treat it as unreadable
    // rather than as "smaller than a 1:1", which would flip the branch on an empty response.
    if (memberCount === 0) {
      return { memberCount: 0, members: [], isOneToOne: false, unknown: true, refused: false };
    }
    return {
      memberCount,
      members,
      isOneToOne: memberCount <= ONE_TO_ONE_MEMBER_COUNT,
      unknown: false,
      refused: false,
    };
  } catch (err) {
    // A REFUSAL IS NOT A FAILED READ. This is the first channel-scoped action most turns take, so for
    // an assistant in a room of another classification it is where IAM's exactly-own grant fires
    // (ADR-042). Measured live on 2026-09-17: the deployed premium router is implicitDeny here for a
    // basic-tagged channel and allowed for a premium one. Before ADR-045 this catch reported that
    // denial as "treat the channel as a group" and the turn ran to completion.
    if (isAccessDenial(err)) {
      console.error(
        '[channel-size] ListChannelMemberships REFUSED; the channel classification boundary denied '
        + 'this assistant. The caller must end the turn rather than degrade.',
        err,
      );
      return { memberCount: 0, members: [], isOneToOne: false, unknown: true, refused: true };
    }
    console.warn('[channel-size] ListChannelMemberships failed; treating the channel as a group', err);
    return { memberCount: 0, members: [], isOneToOne: false, unknown: true, refused: false };
  }
}
