/**
 * Make a conversation's HUMAN members equal an allowed set (DESIGN-CONVERSATION-TYPES §6).
 *
 * ONE IMPLEMENTATION, TWO CALLERS: the admin-conversation sync (the `admins` group onto the admin
 * conversations) and the group-membership reconcile (a type's membership source onto every live
 * conversation of that type). It was written first for the admin sync, and its measured behavior and
 * the reasons for each step moved here with it.
 *
 * HUMANS ONLY, AND THAT FILTER IS LOAD-BEARING. An assistant is a channel member - the bot that creates
 * or moderates a conversation is one - and no membership source names a bot. A loop without this filter
 * removes every assistant on its first pass, which is the feature deleting itself.
 *
 * Membership IS the roster: nothing else is written. `channel-notify.ts` derives recipients from live
 * `ListChannelMemberships`, so a membership change here is the whole update - there is no Metadata copy
 * to keep in step (identity in Metadata is on METADATA-AND-TAGS' never list, and a copy drifts).
 */
import {
  ChimeSDKMessagingClient,
  ListChannelMembershipsCommand,
  CreateChannelMembershipCommand,
  DeleteChannelMembershipCommand,
  ListChannelModeratorsCommand,
  CreateChannelModeratorCommand,
  DeleteChannelModeratorCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { rosterOf } from './person-arn.js';

const errName = (e: unknown): string => (e as { name?: string })?.name || '';

export interface ReconcileResult {
  added: string[];
  removed: string[];
  moderatorsAdded: string[];
  moderatorsRemoved: string[];
}

export interface ReconcileArgs {
  messaging: ChimeSDKMessagingClient;
  channelArn: string;
  /** The identity the calls are made as: a moderator of the channel, or an AppInstanceAdmin. */
  bearer: string;
  /** The humans who belong, as AppInstanceUser ARNs. */
  allowed: Set<string>;
  /**
   * Humans whose standing could not be decided this pass. Neither added nor removed - removing somebody
   * over a failed read would be an access decision failing open in the other direction.
   */
  undetermined?: Set<string>;
  /**
   * `all-allowed`: every allowed human is also a moderator (an admin conversation's people administer it).
   * `revoke-only`: moderators are not granted here, only taken from a human who is no longer allowed.
   */
  moderators: 'all-allowed' | 'revoke-only';
}

export async function reconcileHumans(args: ReconcileArgs): Promise<ReconcileResult> {
  const { messaging, channelArn, bearer, allowed, moderators } = args;
  const undetermined = args.undetermined ?? new Set<string>();
  const result: ReconcileResult = { added: [], removed: [], moderatorsAdded: [], moderatorsRemoved: [] };

  const currentHumans = new Set<string>();
  let NextToken: string | undefined;
  do {
    const res = await messaging.send(new ListChannelMembershipsCommand({
      ChannelArn: channelArn, ChimeBearer: bearer, MaxResults: 50, NextToken,
    }));
    for (const m of rosterOf(res.ChannelMemberships)) {
      if (m.kind === 'person') currentHumans.add(m.arn); // humans only; never touch bots
    }
    NextToken = res.NextToken;
  } while (NextToken);

  // THE HUMAN MODERATORS, read rather than inferred from the roster.
  //
  // DELETING A MEMBERSHIP DOES NOT CLEAR MODERATOR STATUS. Measured 2026-09-28 on a scratch
  // RESTRICTED/PRIVATE channel: a member was added, made a `ChannelModerator`, then had their
  // membership deleted. `ListChannelMemberships` omitted them; `ListChannelModerators` STILL LISTED
  // THEM. The Amazon Chime SDK API reference states the coupling in neither direction, so this had to
  // be measured rather than read. So the revoke loop below is load-bearing, not defensive: a removed
  // person would otherwise keep moderation - rename, archive, redact - over a room they left.
  const currentModerators = new Set<string>();
  let modToken: string | undefined;
  do {
    const modRes = await messaging.send(new ListChannelModeratorsCommand({
      ChannelArn: channelArn, ChimeBearer: bearer, MaxResults: 50, NextToken: modToken,
    }));
    for (const m of modRes.ChannelModerators || []) {
      const arn = m.Moderator?.Arn;
      if (arn?.includes('/user/')) currentModerators.add(arn); // humans only; never touch the agent
    }
    modToken = modRes.NextToken;
  } while (modToken);

  for (const arn of allowed) {
    if (!currentHumans.has(arn)) {
      try {
        await messaging.send(new CreateChannelMembershipCommand({
          ChannelArn: channelArn, MemberArn: arn, Type: 'DEFAULT', ChimeBearer: bearer,
        }));
        result.added.push(arn);
      } catch (e) { if (errName(e) !== 'ConflictException') throw e; }
    }
    if (moderators === 'all-allowed' && !currentModerators.has(arn)) {
      try {
        await messaging.send(new CreateChannelModeratorCommand({
          ChannelArn: channelArn, ChannelModeratorArn: arn, ChimeBearer: bearer,
        }));
        result.moderatorsAdded.push(arn);
      } catch (e) { if (errName(e) !== 'ConflictException') throw e; }
    }
  }
  for (const arn of currentHumans) {
    if (allowed.has(arn) || undetermined.has(arn)) continue;
    try {
      await messaging.send(new DeleteChannelMembershipCommand({
        ChannelArn: channelArn, MemberArn: arn, ChimeBearer: bearer,
      }));
      result.removed.push(arn);
    } catch (e) { if (errName(e) !== 'NotFoundException') throw e; }
  }
  // Driven from the moderator list rather than the membership list, so whatever the observed state is -
  // including a moderator the roster no longer holds - it converges.
  for (const arn of currentModerators) {
    if (allowed.has(arn) || undetermined.has(arn)) continue;
    try {
      await messaging.send(new DeleteChannelModeratorCommand({
        ChannelArn: channelArn, ChannelModeratorArn: arn, ChimeBearer: bearer,
      }));
      result.moderatorsRemoved.push(arn);
    } catch (e) { if (errName(e) !== 'NotFoundException') throw e; }
  }
  return result;
}
