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
 * How many HUMANS may be in the filter, given the serving assistant occupies one of the slots.
 *
 * The assistant is an intersection term (see resolveScopedChannelArns), so a 10-human room would build
 * an 11-value filter. Budgeting for it here rather than at the call site keeps the cap honest: the
 * alternative is a room that silently exceeds the bound and gets rejected by the service, which reads
 * as an outage rather than as the deliberate "too many members to express" case.
 */
const MAX_HUMANS_IN_FILTER = MAX_MEMBERS_IN_FILTER - 1;

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
    for (const m of res.ChannelMemberships || []) {
      const arn = m.Member?.Arn || '';
      if (arn && arn.includes('/user/')) arns.push(arn);
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
      + `filter cap (the serving assistant occupies one of the ${MAX_MEMBERS_IN_FILTER} slots); `
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

  // The bearer must be one of the MEMBERS (the service rejects any other: "AppInstanceUser must
  // include its own ARN for MEMBERS field"), and a bot is not an AppInstanceUser - so a HUMAN bears
  // the search while the assistant rides along as a filter term.
  //
  // WHICH human is bearer does not change the answer: every member of the intersection is in every
  // channel it contains. But only the BEARER is limit-checked, so when one member is too heavy we
  // simply ask a different one. Measured on this deployment: the search refuses at 1038 channels.
  const failures: string[] = [];
  for (const searchBearer of humans) {
    try {
      const arns: string[] = [];
      let nextToken: string | undefined;
      do {
        const res = await input.client.send(new SearchChannelsCommand({
          ChimeBearer: searchBearer,
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
    } catch (err) {
      const e = err as Error;
      // Only the membership limit is worth trying another bearer for; it is a property of that PERSON.
      // Anything else is about the request itself and would fail identically for every member.
      if (/exceeds channel membership limit/i.test(e.message || '')) {
        failures.push(`${searchBearer.split('/').pop()}: over the membership limit`);
        continue;
      }
      // Log the MESSAGE, not just the name. Three DIFFERENT causes have surfaced here as
      // BadRequestException, and the message is what distinguished them each time; `err.name` alone
      // reduced them all to one unattributable line and cost a session per occurrence.
      console.warn(
        `[scoped-channels] channel search failed; suggesting nothing (fail closed): ${e.name}: ${e.message}`,
        { bearer: searchBearer, memberCount: humans.length, channel: input.currentChannelArn },
      );
      return [];
    }
  }

  // EVERY human is over the limit. Fail closed.
  //
  // There IS a way to compute this without the search - intersect each member's own channel list - and
  // it was built and deployed on 2026-08-08. It is deliberately NOT used, for two reasons. It shipped
  // inert (the role carried no `chime:ListChannelMembershipsForAppInstanceUser` grant, so it threw
  // AccessDenied on first contact), and more importantly it intersected HUMANS ONLY: it could not
  // apply the assistant term above, so it would answer a WIDER question than the primary path on
  // exactly the heaviest accounts. A fallback that is less safe than the path it backs up is worse
  // than no fallback. Reinstating it requires a way to apply the assistant term.
  console.warn(
    '[scoped-channels] every human member exceeds the search membership limit; suggesting nothing '
    + '(fail closed). A per-member intersection cannot currently apply the assistant term, so it '
    + 'would widen the scope rather than narrow it.',
    { channel: input.currentChannelArn, members: failures },
  );
  return [];
}

