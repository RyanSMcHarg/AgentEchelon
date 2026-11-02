/**
 * Keep every live conversation of a group-sourced type equal to its group (DESIGN-CONVERSATION-TYPES §6).
 *
 * ONE PER CLASSIFICATION (owner decision, 2026-10-05). Membership writes authorize against the user
 * resource, which carries no classification tag, so they cannot be tag-conditioned in IAM. Running one
 * reconcile per classification, acting as that classification's own assistant - which moderates only
 * the conversations created at its classification, and Amazon Chime SDK refuses a membership change to
 * anyone else - keeps a classification boundary on the platform's most consequential write.
 *
 * EVENT-DRIVEN, WITH A BACKSTOP (tenet D6). A Cognito group change reaches EventBridge through the
 * platform's CloudTrail trail, and the rule invokes this with that event, so a person joining or leaving
 * the group is reflected within seconds. A daily schedule invokes it with no event and it reconciles
 * every group-sourced type, which is the correctness backstop for an event that was dropped, never the
 * primary mechanism.
 *
 * WHAT IT DECIDES, per conversation: humans named by the source and admitted by the classification are
 * added; humans not in the set are removed, with their moderation; a person the classification refuses
 * is never added (settled); a person whose standing cannot be read this pass is left alone. Every change
 * is recorded with the person, the conversation and the source that decided it.
 */
import { ChimeSDKMessagingClient, ListChannelMembershipsCommand, ListTagsForResourceCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { classificationAllowedForType } from '../../lib/config/conversation-types.js';
import { groupSourcedRoles, roleGroups } from '../../lib/config/participant-roles.js';
import { groupRoleHoldings, moderationOrigin, parseHoldings, setRoleHoldings, type ParticipantRoleHolding } from './lib/participant-roles.js';
import { addInvitedMember, setParticipantRoleModerator } from './lib/channel-creation.js';
import { personJoinedThroughRouter } from './lib/say-through-router.js';
import { rosterOf, userArnFor } from './lib/person-arn.js';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  membershipSourceFor,
  membershipSourceGroups,
  membershipSourceStamp,
  typesSourcedFromGroup,
  sourcedTypes,
} from '../../lib/config/conversation-types.js';
import { defaultDirectory, resolveAllowedSet, type AllowedSet, type Directory } from './lib/membership-source.js';
import { reconcileHumans } from './lib/membership-reconcile.js';
import { listChannelsOfType } from './lib/channel-context-client.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { readChannelTags } from './lib/channel-classification.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const CLASSIFICATION = process.env.CLASSIFICATION || '';
const BOT_ARN_PARAM = process.env.BOT_ARN_PARAM || '';

const messaging = chimeMessagingClient({});
const ssm = new SSMClient({});

/** The CloudTrail-delivered Cognito call that changed a group, as EventBridge passes it. */
export interface GroupChangeEvent {
  source?: string;
  'detail-type'?: string;
  detail?: {
    eventName?: string;
    requestParameters?: { userPoolId?: string; groupName?: string; username?: string };
  };
}

/**
 * Which groups this invocation reconciles. A group add or remove names its group; anything else - the
 * daily schedule, or a user being deleted or disabled, which changes every group they were in -
 * reconciles every group a type at this classification sources from.
 */
export function groupsToReconcile(event: GroupChangeEvent | undefined, classification: string): string[] {
  // A group a participant role is sourced from is reconciled too: its holdings follow the group (section 6.1).
  const all = [...new Set([...membershipSourceGroups(classification), ...roleGroups(classification)])].sort();
  const name = event?.detail?.eventName;
  const group = event?.detail?.requestParameters?.groupName;
  if ((name === 'AdminAddUserToGroup' || name === 'AdminRemoveUserFromGroup') && group) {
    return all.includes(group) ? [group] : [];
  }
  return all;
}

const errName = (e: unknown): string => (e as { name?: string })?.name || '';


/** What keeping a group-sourced role's holdings needs, each one a seam a test supplies. */
export interface RoleReconcileDeps {
  classification: string;
  appInstanceArn: string;
  /** This classification's assistant, the bearer of every read and write here, a moderator of its rooms. */
  bearer: string;
  directory: Directory;
  listChannels: (typeKey: string) => Promise<string[]>;
  classificationOf: (channelArn: string) => Promise<string>;
  /** The room's people now (assistants excluded). */
  members: (channelArn: string) => Promise<string[]>;
  readHoldings: (channelArn: string) => Promise<unknown>;
  writeHoldings: (channelArn: string, role: string, holdings: Record<string, ParticipantRoleHolding>) => Promise<void>;
  addMember: (channelArn: string, personArn: string) => Promise<void>;
  setModerator: (channelArn: string, personArn: string, moderator: boolean) => Promise<void>;
  /** Names `person-joined` for the people a role added, as every path that adds a person does. */
  nameJoined: (channelArn: string, people: string[]) => Promise<unknown>;
  resolveAllowed?: typeof resolveAllowedSet;
}

/**
 * KEEP EVERY GROUP-SOURCED PARTICIPANT ROLE EQUAL TO ITS GROUP (DESIGN-CONVERSATION-TYPES section 6.1), in each live
 * conversation of a type that declares one, at this classification. A person who leaves the group loses the holding, and
 * the moderation the role gave them; a person who joins it holds the role once they are a member, or is added first where
 * the role `adds` (FR31), and their arrival is named as `person-joined`. A group that cannot be listed changes nothing,
 * so a failed read never empties a role, and a person whose groups cannot be read keeps what they held. Membership itself
 * is never removed here: a role does not decide who is in the room.
 */
export async function reconcileGroupRoles(deps: RoleReconcileDeps, groups: readonly string[]): Promise<{ conversations: number; changed: number; failed: number }> {
  const totals = { conversations: 0, changed: 0, failed: 0 };
  const roles = groupSourcedRoles((k) => classificationAllowedForType(k, deps.classification)).filter((r) => groups.includes(r.group));
  for (const { typeKey, role, group, decl } of roles) {
    let allowed: AllowedSet;
    try {
      allowed = await (deps.resolveAllowed ?? resolveAllowedSet)({ group }, deps.classification, deps.appInstanceArn, deps.directory, typeKey);
    } catch (err) {
      console.error('[group-membership] a participant role\'s group could not be resolved; its holdings are left as they are', { typeKey, role, message: (err as Error)?.message });
      totals.failed += 1;
      continue;
    }
    for (const channelArn of await deps.listChannels(typeKey)) {
      try {
        if ((await deps.classificationOf(channelArn)) !== deps.classification) continue;
        totals.conversations += 1;
        let members = await deps.members(channelArn);
        if (decl.adds) {
          const added = [...allowed.admitted].filter((arn) => !members.includes(arn));
          for (const arn of added) await deps.addMember(channelArn, arn);
          if (added.length) {
            members = [...members, ...added];
            await deps.nameJoined(channelArn, added).catch(() => undefined);
          }
        }
        const current = parseHoldings(await deps.readHoldings(channelArn), typeKey)[role] ?? {};
        const next = groupRoleHoldings(current, { admitted: allowed.admitted, undetermined: allowed.undetermined, members });
        if (decl.confers?.moderator) {
          for (const [id, h] of Object.entries(next)) {
            // Only a person the group admits now is made a moderator; one whose groups cannot be read is left as they are.
            if (h.origin !== 'group' || h.moderation || !allowed.admitted.has(userArnFor(deps.appInstanceArn, id))) continue;
            await deps.setModerator(channelArn, userArnFor(deps.appInstanceArn, id), true);
            next[id] = { ...h, moderation: moderationOrigin(role) };
          }
        }
        // ONLY A MODERATION OF THE ROLE'S ORIGIN goes with the holding; one made at creation or by an administrator stays.
        for (const [id, h] of Object.entries(current)) {
          if (!next[id] && h.moderation === moderationOrigin(role)) await deps.setModerator(channelArn, userArnFor(deps.appInstanceArn, id), false);
        }
        if (JSON.stringify(current) !== JSON.stringify(next)) {
          await deps.writeHoldings(channelArn, role, next);
          totals.changed += 1;
          console.log(JSON.stringify({
            _auditEvent: 'participant_role_reconciled', channelArn, conversationType: typeKey, classification: deps.classification, participantRole: role,
            held: Object.keys(next).filter((id) => !current[id]), released: Object.keys(current).filter((id) => !next[id]),
          }));
        }
      } catch (err) {
        if (errName(err) === 'NotFoundException') continue;
        totals.failed += 1;
        console.error('[group-membership] could not reconcile a participant role', { channelArn, typeKey, role, message: (err as Error)?.message });
      }
    }
  }
  return totals;
}

export async function reconcileClassification(args: {
  event?: GroupChangeEvent;
  classification: string;
  appInstanceArn: string;
  bearer: string;
  directory: Directory;
  messaging: ChimeSDKMessagingClient;
  listChannels: (typeKey: string) => Promise<string[]>;
  classificationOf: (channelArn: string) => Promise<string>;
}): Promise<{ conversations: number; added: number; removed: number; failed: number }> {
  const totals = { conversations: 0, added: 0, removed: 0, failed: 0 };
  const groups = groupsToReconcile(args.event, args.classification);
  const types = args.event && groups.length === 1
    ? typesSourcedFromGroup(groups[0], args.classification)
    : sourcedTypes(args.classification).filter((t) => {
      const g = membershipSourceFor(t)?.group;
      return !g || groups.includes(g);
    });

  for (const typeKey of types) {
    const source = membershipSourceFor(typeKey)!;
    // ONE RESOLUTION PER TYPE PER INVOCATION. A group that cannot be listed skips this type entirely:
    // reconciling against an empty set would remove everybody.
    let allowed: AllowedSet;
    try {
      allowed = await resolveAllowedSet(source, args.classification, args.appInstanceArn, args.directory, typeKey);
    } catch (err) {
      console.error('[group-membership] the membership source could not be resolved; this type is left as it is', {
        typeKey, message: (err as Error)?.message,
      });
      totals.failed += 1;
      continue;
    }
    // A RECORDED DECISION IS EVIDENCE, REPORTED HERE AND ACTED ON NOWHERE: a person whose last sign-in's
    // record does not reach this classification, or is older than its issuer allows, stays undetermined
    // (neither added nor removed) and is named for a person to look at.
    if (allowed.flagged.length) {
      console.warn('[group-membership][SecurityEvent] a recorded clearance decision is flagged; nothing was changed for it', JSON.stringify({
        _auditEvent: 'clearance_record_flagged',
        conversationType: typeKey,
        classification: args.classification,
        flagged: allowed.flagged,
      }));
    }
    const channels = await args.listChannels(typeKey);
    for (const channelArn of channels) {
      try {
        // AT THIS CLASSIFICATION ONLY. The index spans classifications; a conversation at another one is
        // that classification's reconcile's, and this one's assistant does not moderate it anyway.
        if ((await args.classificationOf(channelArn)) !== args.classification) continue;
        totals.conversations += 1;
        const res = await reconcileHumans({
          messaging: args.messaging,
          channelArn,
          bearer: args.bearer,
          allowed: allowed.admitted,
          undetermined: allowed.undetermined,
          moderators: 'revoke-only',
        });
        totals.added += res.added.length;
        totals.removed += res.removed.length;
        if (res.added.length || res.removed.length || res.moderatorsRemoved.length) {
          console.log(JSON.stringify({
            _auditEvent: 'conversation_membership_reconciled',
            channelArn,
            conversationType: typeKey,
            classification: args.classification,
            source: membershipSourceStamp(typeKey),
            added: res.added,
            removed: res.removed,
            moderatorsRemoved: res.moderatorsRemoved,
            refusedByClassification: allowed.refused.length,
          }));
        }
      } catch (err) {
        // An expired conversation still has a context row; its channel is simply gone.
        if (errName(err) === 'NotFoundException') continue;
        totals.failed += 1;
        console.error('[group-membership] could not reconcile a conversation', {
          channelArn, typeKey, message: (err as Error)?.message,
        });
      }
    }
  }
  return totals;
}

let cachedBot = '';
async function botArn(): Promise<string> {
  if (cachedBot) return cachedBot;
  const r = await ssm.send(new GetParameterCommand({ Name: BOT_ARN_PARAM }));
  cachedBot = r.Parameter?.Value || '';
  return cachedBot;
}

export const handler = async (event?: GroupChangeEvent) => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  if (!APP_INSTANCE_ARN || !CLASSIFICATION || !BOT_ARN_PARAM) {
    console.warn('[group-membership] not configured; nothing reconciled');
    return { ok: false };
  }
  const totals = await reconcileClassification({
    event,
    classification: CLASSIFICATION,
    appInstanceArn: APP_INSTANCE_ARN,
    bearer: await botArn(),
    directory: defaultDirectory(),
    messaging,
    listChannels: listChannelsOfType,
    classificationOf: async (channelArn) => {
      return (await readChannelTags(messaging, channelArn)).classification || '';
    },
  });
  const bearer = await botArn();
  const table = process.env.CHANNEL_CONTEXT_TABLE || '';
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const roles = await reconcileGroupRoles({
    classification: CLASSIFICATION, appInstanceArn: APP_INSTANCE_ARN, bearer, directory: defaultDirectory(),
    listChannels: listChannelsOfType,
    classificationOf: async (channelArn) => (await readChannelTags(messaging, channelArn)).classification || '',
    members: async (channelArn) => {
      const out: string[] = [];
      let NextToken: string | undefined;
      do {
        const res = await messaging.send(new ListChannelMembershipsCommand({ ChannelArn: channelArn, ChimeBearer: bearer, MaxResults: 50, NextToken }));
        for (const m of rosterOf(res.ChannelMemberships)) if (m.kind === 'person') out.push(m.arn);
        NextToken = res.NextToken;
      } while (NextToken);
      return out;
    },
    readHoldings: async (channelArn) => (await doc.send(new GetCommand({ TableName: table, Key: { channelArn }, ProjectionExpression: 'participantRoles' })))?.Item?.participantRoles,
    writeHoldings: (channelArn, role, holdings) => setRoleHoldings(doc, table, channelArn, role, holdings),
    addMember: (channelArn, personArn) => addInvitedMember({ channelArn, inviteeArn: personArn, bearerArn: bearer }),
    setModerator: (channelArn, personArn, moderator) => setParticipantRoleModerator({ channelArn, personArn, bearerArn: bearer, moderator }),
    nameJoined: (channelArn, people) => personJoinedThroughRouter(CLASSIFICATION, channelArn, people),
  }, groupsToReconcile(event, CLASSIFICATION));
  console.log('[group-membership] reconciled', { classification: CLASSIFICATION, trigger: event?.detail?.eventName || 'schedule', ...totals, roles });
  return { ok: true, ...totals, roles };
};
