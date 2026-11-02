/**
 * Scoped Channel ARNs (Security + Privacy)
 *
 * Per SPEC-DRIFT-CONVERGENCE.md "Scoping (Security + Privacy)":
 *
 * The related-conversation cosine-NN query is the highest-risk surface in drift detection. A bug here
 * leaks one user's conversation summaries to another via nearest-neighbor lookup. Two non-optional
 * requirements:
 *
 * 1. **Cross-user scoping (security):** `channel_arn IN (:scopedChannelArns)` is enforced INSIDE the
 *    WHERE clause of the vector search, never as a post-filter.
 * 2. **Multi-member intersection scoping (privacy, per ADR-012):** in multi-member channels, the
 *    scope is the intersection of all human channel members' memberships. A related conversation can
 *    only be suggested if EVERY current human member already has access to it.
 *
 * ## The authority is Amazon Chime SDK Messaging, not the archive
 *
 * This used to compute the intersection from the Aurora `channel_membership` table — a PROJECTION the
 * Kinesis archival path maintains asynchronously. That table is a perfectly good archive and it stays;
 * what was wrong was letting it decide. Both lag directions leak, and they leak precisely when
 * membership has just changed, which is when the control matters:
 *
 *   - a member who JOINED but has not been projected yet is left out of the intersection, so the
 *     scope comes out WIDER than the people in the room — a conversation is suggested that the new
 *     member cannot open;
 *   - a channel someone was REMOVED from but that is still projected stays in their set, so the
 *     intersection can include a conversation they no longer have access to.
 *
 * Stale in the other direction (someone who left still listed) only over-restricts, which is safe.
 * So the failure mode is exactly the one ADR-012 exists to prevent.
 *
 * `SearchChannels` with a `MEMBERS … INCLUDES` filter asks the service that OWNS membership for the
 * intersection directly — one call, no copy, no lag. It is the standard shape for the question
 * "channels where both of these two principals are members", and it is what this scoping is built on.
 *
 * ## Where this runs, and why it takes its client from the caller
 *
 * Drift detection itself executes in `DataPlaneLambda`, which is VPC-attached in the ISOLATED subnets:
 * no NAT, no internet gateway, and no Chime interface endpoint. A Chime call from there does not fail
 * — it HANGS until the function times out (the same shape as the classifier-replay invoke). So the
 * scoped set is resolved by the ROUTER, which is not VPC-attached, and passed into the data-plane
 * request. Outside does the AWS-API work; inside does the database work.
 */

import {
  ChimeSDKMessagingClient,
  ListChannelMembershipsCommand,
  SearchChannelsCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { rosterOf } from './person-arn.js';

/**
 * The most human members we will build a MEMBERS filter from.
 *
 * `SearchChannels` bounds the values on a search field, and a conversation with more members than
 * that cannot have its intersection expressed in one query. Above the cap we return NO scope, which
 * suppresses the suggestion. That is the safe direction: a drift suggestion is a convenience, and
 * withholding one costs nothing next to surfacing a conversation somebody in the room cannot open.
 */
const MAX_MEMBERS_IN_FILTER = 10;

/**
 * How many HUMANS may be in the filter, given the serving assistant takes one of the places.
 *
 * The assistant is an intersection term (see resolveScopedChannelArns), so a 10-human room would build
 * an 11-value filter. Budgeting for it here rather than at the call site keeps the cap honest: the
 * alternative is a room that silently exceeds the bound and gets rejected by the service, which reads
 * as an outage rather than as the deliberate "too many members to express" case.
 */
const MAX_HUMANS_IN_FILTER = MAX_MEMBERS_IN_FILTER - 1;

/**
 * The most `SearchChannels` pages one scope may read (50 conversations a page).
 *
 * The cost of a scope otherwise grows with the history the room shares with the assistant, without
 * bound: 597 shared conversations measured 12 sequential searches (2026-10-05), and a person with
 * thousands would pay dozens on a live turn, inside the router's time budget and against the
 * service's rate.
 *
 * STOPPING EARLY CAN ONLY NARROW. Every page holds conversations that satisfy the full filter, so a
 * truncated scope is a SUBSET of the true intersection: it may miss a related conversation, and it can
 * never include one somebody in the room cannot open. That is the direction FR9 allows. Which subset
 * is the service's page order, which it does not document, so a long history may lose a match that
 * would have been suggested.
 */
export const MAX_SCOPE_PAGES = 10;

export interface ScopeInput {
  currentChannelArn: string;
  /** Bearer for the MEMBERSHIP read. The classification's bot is a member of every conversation it serves. */
  bearerArn: string;
  client: ChimeSDKMessagingClient;
}

/** Human member ARNs of a channel, live. Bots (`/bot/`) are excluded from the intersection seed. */
async function humanMemberArns(input: ScopeInput): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await input.client.send(new ListChannelMembershipsCommand({
      ChannelArn: input.currentChannelArn,
      ChimeBearer: input.bearerArn,
      MaxResults: 50,
      NextToken: nextToken,
    }));
    for (const m of rosterOf(res.ChannelMemberships)) {
      if (m.kind === 'person') arns.push(m.arn);
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return arns;
}

/**
 * The channel ARNs the drift query may look in: those that EVERY current human member of
 * `currentChannelArn` is also a member of.
 *
 * Returns [] — meaning "suggest nothing" — for every case it cannot answer authoritatively: no human
 * members, more members than one filter can express, or a failed Chime call. **Never falls back to
 * the archive.** A fallback would reintroduce exactly the lag this exists to remove, and would do it
 * silently, on the path where the consequence is disclosure.
 */
export async function resolveScopedChannelArns(input: ScopeInput): Promise<string[]> {
  let humans: string[];
  try {
    humans = await humanMemberArns(input);
  } catch (err) {
    console.warn('[scoped-channels] membership read failed; suggesting nothing (fail closed):', (err as Error).name);
    return [];
  }

  // An all-bot channel has nobody whose access could be intersected. Drift should not run.
  if (humans.length === 0) return [];
  if (humans.length > MAX_HUMANS_IN_FILTER) {
    console.warn(
      `[scoped-channels] ${humans.length} human members exceeds the ${MAX_HUMANS_IN_FILTER}-human `
      + `filter cap (the serving assistant takes one of the ${MAX_MEMBERS_IN_FILTER} places); `
      + 'suggesting nothing rather than scoping on a subset of the room.',
    );
    return [];
  }

  // THE SERVING ASSISTANT IS PART OF THE INTERSECTION.
  //
  // Without it the scope is "channels every human shares", which can include a conversation THIS
  // assistant was never added to - and the related-conversation lookup reads summaries straight from
  // Aurora, where no Chime membership check applies. The scope IS the access control, so an assistant
  // could surface a conversation it is not in (and across profiles: two people sharing a basic and a
  // premium channel would let the premium assistant reach the basic one).
  //
  // Adding a term to an AND can only NARROW the result, never widen it - the older "bots are in many
  // channels, so including them would defeat the boundary" reasoning had this backwards; it applies to
  // using a bot as the SEED, not as an intersection term.
  //
  // Verified against the live API 2026-08-08: a bot ARN is accepted as a MEMBERS value and genuinely
  // AND-filters. Same user, same bearer: human alone = 29 channels, human + each of two bots the user
  // shares channels with = 29, human + each of two bots it does not = 0. The zeros are the control -
  // an ignored term would leave every count at 29, and an OR would never go below it.
  const values = [...humans, input.bearerArn];

  // THE ASSISTANT BEARS THE SEARCH.
  //
  // This used to rotate over the humans, on the stated ground that "a bot is not an AppInstanceUser"
  // and so cannot bear. MEASURED AGAINST THE LIVE API 2026-09-30 AND THAT IS NOT TRUE: a bot bears
  // `SearchChannels` and AND-filters exactly as a human bearer does. The error the old comment cited,
  // "AppInstanceUser must include its own ARN for MEMBERS field", is about the BEARER needing its own
  // ARN among the values - which the assistant already satisfies, because it is an intersection term.
  //
  // Same app instance, same filter, counted to exhaustion rather than to a page:
  //   bot bearer, bot only          388 channels
  //   bot bearer, bot AND human     265
  //   human bearer, bot AND human   265   <- the bearer does not change the answer
  //   human bearer, human only      265
  // The middle pair is the control: switching the bearer is behavior-preserving, and the first line
  // is the AND doing its work.
  //
  // THE LIMIT, AND WHY A HUMAN BACKS IT UP. Only the BEARER is limit-checked, and the assistant is
  // the principal that grows fastest: one membership per conversation of its classification, where a
  // person grows only as fast as they are invited. It was at 388 against a refusal measured at 1038 on
  // this deployment. So the assistant asks first and, IF AND ONLY IF the service refuses it for the
  // membership limit, a human asks the same question instead.
  //
  // THIS IS NOT THE FALLBACK THAT WAS REJECTED, and the difference is the whole of why it is safe. The
  // rejected one intersected each member's own channel list, which could not carry the assistant term,
  // so it answered a WIDER question on exactly the heaviest accounts - less safe than the path it
  // backed up. Changing the BEARER changes only who asks: `values` still carries the assistant, so the
  // filter is identical and the answer is identical. Measured above, line for line: human bearer with
  // [human, bot] returned the same 265 as bot bearer with [human, bot].
  //
  // ONLY THE LIMIT ERROR FALLS BACK. Anything else is a property of the REQUEST and would fail the same
  // way for every bearer, so retrying would multiply one failure instead of answering.
  const searchAs = async (bearer: string): Promise<string[]> => {
    const arns: string[] = [];
    let nextToken: string | undefined;
    let pages = 0;
    do {
      if (pages === MAX_SCOPE_PAGES) {
        console.warn(
          `[scoped-channels] scope stopped at ${MAX_SCOPE_PAGES} pages (${arns.length} conversations) with `
          + 'more available; suggesting from that subset, which can only narrow the scope.',
          { bearer, channel: input.currentChannelArn },
        );
        break;
      }
      pages += 1;
      const res = await input.client.send(new SearchChannelsCommand({
        ChimeBearer: bearer,
        Fields: [{ Key: 'MEMBERS', Values: values, Operator: 'INCLUDES' }],
        MaxResults: 50,
        NextToken: nextToken,
      }));
      for (const ch of res.Channels || []) {
        if (ch.ChannelArn) arns.push(ch.ChannelArn);
      }
      nextToken = res.NextToken;
    } while (nextToken);
    return arns;
  };
  const isOverLimit = (e: Error) => /exceeds channel membership limit/i.test(e.message || '');

  try {
    return await searchAs(input.bearerArn);
  } catch (err) {
    const e = err as Error;
    if (isOverLimit(e)) {
      // The assistant is too heavy to bear its own search. Ask a human the SAME question: the filter
      // is unchanged, so this narrows nothing and widens nothing, and only the bearer is limit-checked.
      console.warn(
        '[scoped-channels] the serving assistant is over the channel membership limit; re-asking the '
        + 'identical filter as a human member.',
        { bearer: input.bearerArn, humans: humans.length, channel: input.currentChannelArn },
      );
      const refused: string[] = [];
      for (const human of humans) {
        try {
          return await searchAs(human);
        } catch (retryErr) {
          const re = retryErr as Error;
          // Only the limit is worth asking somebody else about; it is a property of that PERSON.
          if (isOverLimit(re)) { refused.push(human.split('/').pop() || human); continue; }
          console.warn(
            `[scoped-channels] fallback search failed; suggesting nothing (fail closed): ${re.name}: ${re.message}`,
            { bearer: human, channel: input.currentChannelArn },
          );
          return [];
        }
      }
      // THE ASSISTANT AND EVERY HUMAN ARE OVER THE LIMIT. Worth an error rather than a warning: the
      // assistant being over it takes drift out everywhere at once, and it arrives as silence.
      console.error(
        '[scoped-channels] THE SERVING ASSISTANT IS OVER THE CHANNEL MEMBERSHIP LIMIT and so is every '
        + 'human member, so this conversation can scope nothing. While the assistant stays over it, '
        + 'every conversation it serves depends on a human under it. Suggesting nothing (fail closed).',
        { bearer: input.bearerArn, refused, channel: input.currentChannelArn },
      );
      return [];
    }
    // Log the MESSAGE, not just the name. Three DIFFERENT causes have surfaced here as
    // BadRequestException, and the message is what distinguished them each time; `err.name` alone
    // reduced them all to one unattributable line and cost a session per occurrence.
    console.warn(
      `[scoped-channels] channel search failed; suggesting nothing (fail closed): ${e.name}: ${e.message}`,
      { bearer: input.bearerArn, memberCount: humans.length, channel: input.currentChannelArn },
    );
    return [];
  }
}

