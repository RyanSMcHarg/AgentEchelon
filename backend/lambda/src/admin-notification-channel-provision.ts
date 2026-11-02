/**
 * Custom-resource Lambda: provision the ADMIN NOTIFICATION channel (A6).
 *
 * The membership-audit (SPEC-CONVERSATION-SECURITY Layer 6) and admin-error alert paths post
 * findings into an admin conversation (in-app message + email fan-out). Without a channel configured
 * both degrade to log-only. This creates ONE dedicated "Admin Notifications" channel and returns its
 * ARN, which the stack surfaces so both alert paths post here.
 *
 * ── WHO DOES WHAT, AND WHY IT IS NOT ONE IDENTITY (DESIGN-ADMIN-AGENT-NOTIFICATIONS) ────────────
 *
 * The channel is CREATED BY THE ADMIN ASSISTANT'S BOT, which makes the bot its moderator and the only
 * identity that may legitimately post into it. This replaced creating it as the service
 * app-instance-admin, which cannot: a `SendChannelMessage` by that identity to a RESTRICTED, PRIVATE
 * channel it is not a member of is refused (verified live: `ForbiddenException`). Adding it as a
 * member to work around that is the wrong fix - it is the cross-channel administration identity that
 * reads and moderates WITHOUT membership, and as an email recipient it would be incorrect.
 *
 * MEMBERS ARE ADDED BY THE SERVICE ADMIN, because `CreateChannelMembership` cannot be called by a
 * bot. That is the whole of its role here: it is borrowed for one call and never joins.
 *
 * Idempotent: Create makes the channel (PhysicalResourceId = its ARN); Update reuses that ARN and
 * re-syncs the admin roster (picking up admins added since the last deploy). Delete removes it.
 */
import {
  ChimeSDKMessagingClient,
  CreateChannelModeratorCommand,
  DeleteChannelMembershipCommand,
  DescribeChannelCommand,
  TagResourceCommand,
  CreateChannelMembershipCommand,
  UpdateChannelCommand,
  DeleteChannelCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { ADMIN_CHANNEL_TAG_KEY, ADMIN_CHANNEL_TAG_VALUE } from './lib/admin-channel-kind.js';
import { personIdFromArn } from './lib/person-arn.js';
import { defaultDirectory, type Directory } from './lib/membership-source.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { createAdminNotificationChannel } from './lib/channel-creation.js';
import { audienceTagFor } from './lib/channel-classification.js';
import { primaryTagFor } from './lib/conversation-primary.js';
import { conversationNameFor } from './lib/conversation-name.js';
import { loadMessageTemplateSet } from './lib/message-template-selection.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const region = process.env.AWS_REGION || 'us-east-1';
const chime = chimeMessagingClient({ region });

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
/**
 * The service app-instance-admin. USED FOR `CreateChannelMembership` AND NOTHING ELSE, because that
 * call is not available to a bot. It is never added as a member (design section 5.2).
 */
const ADMIN_BEARER_ARN = process.env.ADMIN_BEARER_ARN || '';
/**
 * The admin assistant's AppInstanceBot: the channel's creator, therefore its moderator, and the bearer
 * for every write that shapes it. Also the identity both alert paths post with.
 */
const ADMIN_AGENT_BOT_ARN = process.env.ADMIN_AGENT_BOT_ARN || '';
const ADMIN_GROUP_NAME = process.env.ADMIN_GROUP_NAME || 'admins';
/**
 * THE CHANNEL'S NAME: the `conversation-name` template's `label.adminNotifications` section (`conversation-name.ts`), worded
 * by the admin plane's own stored templates, so an edit made in the console names the channel at the next provisioning,
 * unless the deployment names one (`CHANNEL_NAME`). A store that cannot be read leaves the shipped wording, never the
 * provisioning.
 */
async function adminChannelName(): Promise<string> {
  if (process.env.CHANNEL_NAME) return process.env.CHANNEL_NAME;
  const templates = await loadMessageTemplateSet({ classification: adminChannelClassification() }).catch((err) => {
    console.warn('[AdminNotifChannel] the name templates could not be read; the shipped wording names the channel', { err: (err as Error)?.name });
    return undefined;
  });
  return conversationNameFor({ kind: 'adminNotifications', ...(templates ? { words: { templates } } : {}) });
}
/**
 * What marks this channel as the admin notification channel, for IAM rather than for people.
 *
 * IDENTITY, NOT BOUNDARY. It answers "which channel is the admin one" so the alert grant can name it
 * without knowing its ARN at synth time. It does NOT answer "who may be in it" - see
 * `adminChannelClassification` below, which is the tag that does.
 */

/**
 * THE ADMIN NOTIFICATION CHANNEL IS A CONVERSATION, AND CARRIES A CLASSIFICATION.
 *
 * This used to carry no `classification` tag at all, on the reasoning that it "is not a conversation"
 * and that putting a value in the closed axis would corrupt the comparison the boundary
 * depends on. That reasoning was wrong twice over:
 *
 *  1. It IS a conversation. People and an assistant share a channel and talk in it, which is the
 *     definition used everywhere else in this codebase.
 *  2. An untagged channel is not outside the axis, it is UNJUDGED BY it. The fail-closed Layer-1
 *     policies allow a channel only when `aws:ResourceTag/classification` is in the caller's set, so
 *     an untagged channel matches no Allow - and this one was reachable anyway, by the bot through
 *     the `aeChannelKind` grant and by admins through the AppInstanceAdmin read identity. The
 *     classification boundary was simply not applied to it.
 *
 * THE ADMIN PLANE'S CLASSIFICATION, resolved from the registry rather than written as a value, so a
 * deployment that declares its own classifications gets its own admin plane. Admin alerts are derived
 * from every classification's traffic, so the room that carries them is tagged with the admin plane's
 * classification and holds only people cleared for it: anyone else would be shown content they are not
 * cleared for, which is the exact violation the membership audit exists to catch.
 *
 * WHO IS CLEARED FOR IT: the `admins` group clears for the admin plane classification (`groupClearance`), and the
 * admin plane grants itself alone, so a chat identity holding it reaches admin conversations and no member
 * conversation (SPEC-ADMIN-IDENTITY FR1). A person holding it beside a member classification reaches both, through
 * the `adminPlane` session tag on their member vend role.
 */
// THE DECLARED ADMIN PLANE, not "the most restrictive classification". Those coincided in the shipped
// configuration and the `adminPlane` flag exists because they are not the same idea - a deployment with `legal`
// and `finance` has an admin plane and no most-restrictive one.
// Read when a channel is provisioned, never while the module loads: the registry is loaded by the handler.
const adminChannelClassification = (): string => profiles.adminPlaneValues()[0];

/**
 * The admin group's ENABLED members, as the people they sign in as (`Directory.personsInGroup`).
 *
 * A DISABLED admin stays in the group, and this used to add them anyway: the roster ignored `Enabled`,
 * so disabling an administrator left them a member of the channel that carries every security finding.
 * A group member who has never signed in has no AppInstanceUser yet and cannot be a member; they are
 * added on the next provisioning after their first sign-in, and the admin-conversation sync keeps the
 * roster current between deploys.
 */
export async function listAdminUserArns(directory: Directory = defaultDirectory()): Promise<string[]> {
  // Every issuer declaring `admin: true` (C2), each through its own directory and admin groups.
  const { persons, unminted } = await directory.admins();
  if (unminted.length) {
    console.log('[AdminNotifChannel] admins who have never signed in are added after their first sign-in', { count: unminted.length });
  }
  return persons;
}

/**
 * Add every admin as a channel member, then stamp the roster into `Metadata.participants`.
 *
 * THE STAMP IS A RECORD, NOT THE RECIPIENT LIST, and that distinction is load-bearing. The design
 * asks for the roster and it is written here. What is deliberately NOT done is pointing the email
 * fan-out back at it: `lib/channel-notify.ts` resolves recipients from live `ListChannelMemberships`
 * because channel Metadata is member-WRITABLE - a channel moderator holds `chime:UpdateChannel`,
 * which rewrites Name and Metadata in one call IAM cannot split - so a roster-derived recipient list
 * is a member-controlled path to having conversation content emailed to somebody of their choosing.
 * That fan-out is shared by every channel, not just this one, so reverting it would re-open that on
 * ordinary user conversations where every person moderates their own.
 *
 * Membership cannot be forged the same way: adding a member is `CreateChannelMembership`, a separate
 * moderated operation that shows up in the conversation. So membership is the authority, and here
 * the two sets are identical by construction.
 *
 * Best-effort per member.
 */
async function syncAdmins(channelArn: string, channelName: string): Promise<number> {
  const adminArns = await listAdminUserArns();
  for (const memberArn of adminArns) {
    try {
      await chime.send(new CreateChannelMembershipCommand({
        ChannelArn: channelArn,
        MemberArn: memberArn,
        Type: 'DEFAULT',
        ChimeBearer: ADMIN_BEARER_ARN,
      }));
    } catch (err) {
      // ConflictException = already a member; any other error is logged and skipped, never fatal.
      console.warn('[AdminNotifChannel] add member skipped:', memberArn, (err as { name?: string }).name);
    }
  }
  try {
    await chime.send(new UpdateChannelCommand({
      ChannelArn: channelArn,
      Name: channelName,
      Mode: 'RESTRICTED',
      // THE ROSTER IS BACK, AND IT IS NOT THE RECIPIENT LIST. It was removed once because a
      // roster-derived recipient list is member-controlled; the fan-out has since been moved to live
      // membership and STAYS there, so this is a record of the provisioned set rather than an input
      // to sending. These are person ids (each admin's AppInstanceUser id), and the audience is
      // the admins who are already members.
      Metadata: JSON.stringify({
        kind: 'admin-notifications',
        // The design's roster (section 2). A RECORD of who was provisioned, readable only by the
        // admins who are already members and can already list each other. Not the recipient list -
        // see the note on this function.
        participants: adminArns.map((arn) => personIdFromArn(arn)).filter(Boolean),
      }),
      // AS THE BOT. UpdateChannel is a moderator action and the bot is the channel's creator.
      ChimeBearer: ADMIN_AGENT_BOT_ARN,
    }));
  } catch (err) {
    console.warn('[AdminNotifChannel] metadata stamp failed:', (err as { name?: string }).name);
  }
  return adminArns.length;
}

/**
 * Give the admin assistant authority over a channel it did not create, and take the service admin out.
 *
 * Called for an existing channel only. See the note at the call site for why the channel is adopted
 * rather than replaced: it holds every alert the admins have been sent.
 *
 * MEMBER **AND** MODERATOR. Membership is what lets the agent send into a RESTRICTED channel;
 * moderation is what lets it update the channel. The design gives it both by making it the creator,
 * and on an adopted channel both have to be granted explicitly.
 *
 * THE SERVICE ADMIN IS REMOVED LAST, and only after the agent is in. Removing it first would leave
 * a window with no identity able to act on the channel if the adds then failed.
 */
async function adoptChannelForAgent(channelArn: string, primaryTag: { Key: string; Value: string }): Promise<void> {
  const swallow = (what: string) => (err: unknown) => {
    const name = (err as { name?: string })?.name;
    // Already done is the ordinary case on every redeploy after the first.
    if (name === 'ConflictException' || name === 'NotFoundException') return;
    console.warn('[AdminNotifChannel] ' + what + ' failed:', name ?? err);
  };

  await chime.send(new CreateChannelMembershipCommand({
    ChannelArn: channelArn,
    MemberArn: ADMIN_AGENT_BOT_ARN,
    Type: 'DEFAULT',
    ChimeBearer: ADMIN_BEARER_ARN,
  })).catch(swallow('adding the agent as a member'));

  // ── THE ONE PLACE A BOT IS MADE A MODERATOR (declared in single-entry-point.test.ts) ────────
  //
  // SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP says the assistant must never be a moderator, because
  // moderation decides who may archive, rename or re-open a CONVERSATION. This is not a conversation:
  // it is the admin notification channel, the agent owns it by design, and it is already the
  // moderator of every one it created. Only an adopted channel - made by the previous version, as the
  // service app-instance-admin - lacks that, and this restores it so the agent can post and stamp.
  //
  // The ARN can only ever be this resource's own recorded channel, so no user conversation is
  // reachable from here.
  await chime.send(new CreateChannelModeratorCommand({
    ChannelArn: channelArn,
    ChannelModeratorArn: ADMIN_AGENT_BOT_ARN,
    ChimeBearer: ADMIN_BEARER_ARN,
  })).catch(swallow('promoting the agent to moderator'));

  // AND THE SERVICE ADMIN LEAVES. It became a member by creating the channel, and the design is
  // explicit that it must not be one: it is the cross-channel administration identity that reads
  // and moderates WITHOUT membership, and as a member it is also an address the email fan-out would
  // try to resolve.
  await chime.send(new DeleteChannelMembershipCommand({
    ChannelArn: channelArn,
    MemberArn: ADMIN_BEARER_ARN,
    ChimeBearer: ADMIN_BEARER_ARN,
  })).catch(swallow('removing the service admin from the channel'));

  // AND ITS TAGS, because an adopted channel predates them. The kind tag is what the alert grant is
  // written against - without it the agent could speak in the channel and the processor still could
  // not. The classification tag is what puts the channel inside the Layer-1 boundary at all. The
  // primary tag names the admin assistant as the room's primary, as every room names its own.
  //
  // THIS IS ALSO THE REPAIR PATH. The channels currently logging a missing-classification
  // SecurityEvent on every membership event are adopted ones; re-provisioning re-tags them, so the
  // finding clears without anybody deleting a live conversation to fix a tag.
  await chime.send(new TagResourceCommand({
    ResourceARN: channelArn,
    Tags: [
      { Key: ADMIN_CHANNEL_TAG_KEY, Value: ADMIN_CHANNEL_TAG_VALUE },
      { Key: 'classification', Value: adminChannelClassification() },
      audienceTagFor(adminChannelClassification()),
      primaryTag,
    ],
  })).catch(swallow('tagging the channel as the admin notification channel'));

  console.log('[AdminNotifChannel] adopted the existing channel for the admin assistant', { channelArn });
}
export const handler = async (event: CloudFormationCustomResourceEvent) => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  console.log('[AdminNotifChannel]', event.RequestType, { APP_INSTANCE_ARN, ADMIN_GROUP_NAME });
  if (!APP_INSTANCE_ARN || !ADMIN_BEARER_ARN || !ADMIN_AGENT_BOT_ARN) {
    // FAILS THE DEPLOY rather than falling back to the service admin. A channel created by the wrong
    // identity looks provisioned and cannot be posted to, which is the failure this rework exists to
    // end - and it would be discovered only when an alert was owed.
    throw new Error('APP_INSTANCE_ARN, ADMIN_BEARER_ARN and ADMIN_AGENT_BOT_ARN env are required');
  }

  if (event.RequestType === 'Delete') {
    const arn = event.PhysicalResourceId;
    if (arn && arn.includes('/channel/')) {
      // AS THE CREATOR FIRST, THEN AS THE SERVICE ADMIN. The bot moderates what it made, so it is
      // the right bearer for any channel this version provisioned. A channel left by the PREVIOUS
      // version was created by the service app-instance-admin and the bot cannot touch it, so the
      // teardown would fail and leave it behind - visible to every admin, named "Admin
      // Notifications", and never posted to again. Trying both is what lets an existing deployment
      // migrate without an operator hunting for an orphan.
      let deleted = false;
      for (const bearer of [ADMIN_AGENT_BOT_ARN, ADMIN_BEARER_ARN]) {
        if (!bearer) continue;
        try {
          await chime.send(new DeleteChannelCommand({ ChannelArn: arn, ChimeBearer: bearer }));
          deleted = true;
          break;
        } catch (err) {
          console.warn('[AdminNotifChannel] delete attempt failed', {
            bearer, name: (err as { name?: string }).name,
          });
        }
      }
      if (!deleted) {
        console.warn('[AdminNotifChannel] the channel could not be deleted by either identity; it may need removing by hand', { arn });
      }
    }
    return { PhysicalResourceId: arn || 'admin-notifications-none' };
  }

  // Set by the operator only after the consuming stacks have stopped importing the channel ARN.
  // See the throw below for why this cannot be inferred here.
  const allowReplacement = String((event as { ResourceProperties?: Record<string, unknown> })
    .ResourceProperties?.AllowReplacement ?? '') === 'true';

  // Update reuses the existing channel (its ARN is the PhysicalResourceId); Create makes a new one.
  let channelArn = event.RequestType === 'Update' ? event.PhysicalResourceId : '';

  // ── AN EXISTING CHANNEL IS ADOPTED, NOT REPLACED (2026-09-09) ───────────────────────────────
  //
  // A channel provisioned by the PREVIOUS version was created by the service app-instance-admin,
  // so the agent is neither its moderator nor a member and cannot post into it. The obvious fix -
  // make a new channel the agent owns - would hand the admins an empty channel and strand every
  // alert and reply in the old one. The ARN is what the admins already read; it stays the same.
  //
  // So the AUTHORITY moves instead of the channel. The agent is added as a member and a moderator
  // of the channel that already exists, which is what lets it post, and the service admin is then
  // removed from the membership it acquired by creating the channel. The end state is the one the
  // design describes - the agent may speak here, the service admin is not a member - reached
  // without moving the admins to a new channel.
  //
  // Idempotent: adding an existing member or moderator is a ConflictException, and removing an
  // absent membership is a NotFound. Both are swallowed, so a redeploy is a no-op.
  if (channelArn && channelArn.includes('/channel/')) {
    try {
      await chime.send(new DescribeChannelCommand({
        ChannelArn: channelArn,
        ChimeBearer: ADMIN_BEARER_ARN,
      }));
    } catch (err) {
      // ── NEVER SILENTLY PROVISION A REPLACEMENT ON UPDATE (2026-09-09) ───────────────────────
      //
      // An unreadable channel is not proof it is gone: a throttle, a revoked bearer or a wrong region
      // reads the same. A new channel on any of those would move the admins off the one they read,
      // silently. An UPDATE therefore has one default outcome for this resource: the same ARN it was
      // handed, and an unreadable one fails the deploy with what to do.
      //
      // UNLESS THE OPERATOR SAYS TO REPLACE IT. Only they can know the channel is really lost. The
      // new ARN reaches the alert poster and the SSM parameter in the same deploy, because no other
      // stack reads it.
      if (allowReplacement) {
        console.warn('[AdminNotifChannel] the recorded channel is unreadable and replacement was authorised; provisioning a new one', {
          channelArn, name: (err as { name?: string }).name,
        });
        channelArn = '';
      } else {
        throw new Error(
          '[AdminNotifChannel] the recorded admin notification channel ' + channelArn + ' cannot be read ('
          + ((err as { name?: string }).name ?? 'unknown')
          + '). This handler does not replace the channel the admins read on its own. If the channel is'
          + ' really lost, redeploy AdminServices with -c replaceAdminNotificationChannel=true.',
        );
      }
    }
  }

  // THE ROOM'S PRIMARY IS THE ADMIN ASSISTANT (ADR-062 decision 6: the admin notices are its templates), named
  // by the one resolver every creator uses, so the channel is created and kept with the tag every room
  // carries. The agent's seed is this resource's dependency, so its assignment record exists; a
  // classification with no live primary throws, as it does for any room.
  const [primaryTag, channelName] = await Promise.all([primaryTagFor(adminChannelClassification(), ADMIN_AGENT_BOT_ARN), adminChannelName()]);

  if (channelArn && channelArn.includes('/channel/')) {
    await adoptChannelForAgent(channelArn, primaryTag);
  }
  if (!channelArn || !channelArn.includes('/channel/')) {
    // THE BOT CREATES IT, through the one creator module (`createAdminNotificationChannel`), which is
    // what makes the bot its moderator and the one identity that may post into it, and sets the kind and
    // classification tags at creation rather than by a following TagResource: a provision that died in
    // between used to leave a permanently untagged channel.
    channelArn = await createAdminNotificationChannel({
      client: chime,
      appInstanceArn: APP_INSTANCE_ARN,
      botArn: ADMIN_AGENT_BOT_ARN,
      name: channelName,
      classification: adminChannelClassification(),
      kindTag: { key: ADMIN_CHANNEL_TAG_KEY, value: ADMIN_CHANNEL_TAG_VALUE },
      primaryTag,
    });
  }

  const count = await syncAdmins(channelArn, channelName);
  console.log('[AdminNotifChannel] ready:', channelArn, `(${count} admins)`);
  return { PhysicalResourceId: channelArn, Data: { ChannelArn: channelArn } };
};
