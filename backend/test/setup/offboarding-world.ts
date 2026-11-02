/**
 * A deployment in memory for the offboarding tests: the Identities table, a person's stores, the Amazon
 * Chime SDK identities and memberships, the attachments bucket, a pool, and the archive. Each sender
 * answers the real AWS SDK command it is given, by its class name, so the code under test builds the
 * same commands it sends in production.
 */
import type { CognitoPoolDirectory, PoolRecord } from '../../lambda/src/lib/cognito-pool-directory';
import { poolIssuer } from '../../lambda/src/lib/cognito-pool-directory';
import type { OffboardingDeps } from '../../lambda/src/lib/offboarding';
import { hourKeyAt, userBudgetKey } from '../../lambda/src/lib/abuse-control-keys';

/** The hour the seeded budget rows are for: the hour before this file loaded, inside offboarding's horizon. */
const SEED_HOUR = hourKeyAt(new Date(Date.now() - 3_600_000));
/** A budget row of the seed hour, keyed as the writer keys it. */
export const budgetRowOf = (personId: string): string => userBudgetKey(personId, SEED_HOUR);

export const APP = 'arn:aws:chime:us-east-1:111111111111:app-instance/app-1';
export const POOL_ID = 'us-east-1_Pool';
export const OTHER_POOL_ID = 'us-east-1_HostPool';
/** The issuer a token of this deployment's pool carries as `iss`. */
export const POOL_ISS = poolIssuer(POOL_ID);
/**
 * The issuer half of every `Identities` key: each pool's trusted-issuer registry id, never its `iss`
 * (`lib/config/issuers.ts`). This deployment's own pool is `deployment`; the host pool is `host`.
 */
export const ISS = 'deployment';
export const OTHER_ISS = 'host';
export const SERVICE_ADMIN = `${APP}/user/service-admin`;
export const TABLES = {
  identities: 'Identities',
  userProfile: 'UserProfile',
  userTasks: 'UserTasks',
  turnState: 'TurnState',
  abuseControls: 'AbuseControls',
  bucket: 'attachments-bucket',
  tokens: 'Tokens',
  agentTasks: 'AgentTasks',
  channelContext: 'ChannelContext',
  battleConfig: 'ChannelBattleConfig',
};

const named = (name: string) => Object.assign(new Error(name), { name });
const kind = (cmd: unknown) => (cmd as { constructor: { name: string } }).constructor.name;
const input = (cmd: unknown) => (cmd as { input: any }).input;

interface Account { subject: string; username: string; enabled: boolean; email: string; name?: string }

export function offboardingWorld() {
  const identities = new Map<string, Record<string, any>>();
  const profiles = new Map<string, Record<string, any>>();
  const tasks: Array<{ principalId: string; taskId: string; ownerPersonId?: string }> = [];
  /** Task records, keyed `<taskId>|<channelArn>`; conversation context rows and battle settings, by channel. */
  const agentTasks = new Map<string, Record<string, any>>();
  const channelContexts = new Map<string, Record<string, any>>();
  const battleConfigs = new Map<string, Record<string, any>>();
  const turn = new Map<string, Record<string, any>>();
  const abuse = new Map<string, Record<string, any>>();
  const battleVotes = new Map<string, Record<string, any>>();
  const feedback = new Map<string, Record<string, any>>();
  const users = new Map<string, { tags: Array<{ Key: string; Value: string }> }>();
  const admins = new Set<string>();
  const memberships = new Map<string, Set<string>>();
  /** Channel tags, by channel ARN, and each channel's messages (the sender's ARN). */
  const channelTags = new Map<string, Array<{ Key: string; Value: string }>>();
  const channelMessages = new Map<string, Array<{ MessageId: string; Sender: { Arn: string } }>>();
  const tokens = new Map<string, Record<string, any>>();
  const objects: Array<{ Key: string; VersionId: string }> = [];
  const pools = new Map<string, Map<string, Account>>([[POOL_ID, new Map()], [OTHER_POOL_ID, new Map()]]);
  const archived: Array<{ personId: string; properties: Record<string, string | number | boolean> }> = [];
  const audit: any[] = [];
  const tablesTouched = new Set<string>();
  const cognitoCalls: Array<{ command: string; input: any }> = [];

  const doc = {
    send: jest.fn(async (cmd: unknown) => {
      const i = input(cmd);
      const k = kind(cmd);
      if (i?.TableName) tablesTouched.add(i.TableName);
      const store = (name: string) => ({
        [TABLES.identities]: identities, [TABLES.userProfile]: profiles, [TABLES.turnState]: turn, [TABLES.abuseControls]: abuse, [TABLES.tokens]: tokens,
      } as Record<string, Map<string, any>>)[name];
      if (k === 'GetCommand' && i.TableName === TABLES.channelContext) return { Item: structuredClone(channelContexts.get(i.Key.channelArn)) };
      if (k === 'GetCommand') {
        // By the table's own key: an export reads the profile, its contact copies and preferences, and the budget rows.
        if (i.TableName === TABLES.userProfile) return { Item: profiles.get(i.Key.personId) };
        if (i.TableName === TABLES.abuseControls) return { Item: abuse.get(i.Key.pk) };
        return { Item: identities.get(i.Key.issuerSubject) };
      }
      if (k === 'QueryCommand') {
        if (i.TableName === TABLES.identities) {
          return { Items: [...identities.values()].filter((r) => r.personArn === i.ExpressionAttributeValues[':p']) };
        }
        if (i.TableName === TABLES.userTasks && i.IndexName === 'ownerPersonId-index') return { Items: tasks.filter((t) => t.ownerPersonId === i.ExpressionAttributeValues[':p']) };
        if (i.TableName === TABLES.userTasks) return { Items: tasks.filter((t) => t.principalId === i.ExpressionAttributeValues[':p']) };
        throw new Error(`unexpected query on ${i.TableName}`);
      }
      if (k === 'ScanCommand') {
        const v = i.ExpressionAttributeValues;
        if (i.TableName === TABLES.identities) {
          // `#i IN (:i0, :i1, ...)`: the sweep asks for every issuer whose people are the pool's accounts.
          const issuers = Object.entries(v).filter(([k]) => /^:i\d*$/.test(k)).map(([, x]) => x);
          return { Items: [...identities.values()].filter((r) => issuers.includes(r.issuer)) };
        }
        if (i.TableName === TABLES.turnState) return { Items: [...turn.values()].filter((r) => r.pk.startsWith(v[':stop']) && r.pk.includes(v[':person'])) };
        if (i.TableName === TABLES.abuseControls) return { Items: [...abuse.values()].filter((r) => r.pk.startsWith(v[':b'])) };
        if (i.TableName === TABLES.agentTasks) {
          return { Items: [...agentTasks.values()].filter((t) => t.userArn === v[':arn'] || t.ownerPersonId === v[':p'] || t.assigneePersonId === v[':p']
            || (t.ownerType === v[':user'] && t.ownerId === v[':p']) || (t.assigneeType === v[':user'] && t.assigneeId === v[':p'])) };
        }
        if (i.TableName === TABLES.channelContext) {
          return { Items: [...channelContexts.values()].filter((r) => r.memberIdentities !== undefined || r.onboardingIntake?.subject === v[':p']).map((r) => structuredClone(r)) };
        }
        if (i.TableName === TABLES.battleConfig) return { Items: [...battleConfigs.values()].filter((r) => r.enabledBy === v[':arn']) };
        if (i.TableName === TABLES.tokens) {
          return { Items: [...tokens.values()].filter((r) => (r.personArn === v[':person'] || r.inviterArn === v[':person']) && Object.entries(v).some(([k, kind]) => k.startsWith(':k') && r.kind === kind)) };
        }
        throw new Error(`unexpected scan on ${i.TableName}`);
      }
      if (k === 'DeleteCommand') {
        if (i.TableName === TABLES.agentTasks) { agentTasks.delete(`${i.Key.taskId}|${i.Key.channelArn}`); return {}; }
        if (i.TableName === TABLES.userTasks) {
          const at = tasks.findIndex((t) => t.principalId === i.Key.principalId && t.taskId === i.Key.taskId);
          if (at >= 0) tasks.splice(at, 1);
          return {};
        }
        const m = store(i.TableName);
        const key = i.Key.issuerSubject ?? i.Key.personId ?? i.Key.pk;
        const old = m.get(key);
        m.delete(key);
        return i.ReturnValues === 'ALL_OLD' && old ? { Attributes: old } : {};
      }
      if (k === 'UpdateCommand' && i.TableName === TABLES.channelContext) {
        const row = channelContexts.get(i.Key.channelArn);
        const v = i.ExpressionAttributeValues;
        if (!row) throw named('ConditionalCheckFailedException');
        if (':read' in v && JSON.stringify(row.memberIdentities) !== JSON.stringify(v[':read'])) throw named('ConditionalCheckFailedException');
        if (':p' in v && row.onboardingIntake?.subject !== v[':p']) throw named('ConditionalCheckFailedException');
        if (':kept' in v) row.memberIdentities = v[':kept'];
        if (/REMOVE #i/.test(i.UpdateExpression)) delete row.onboardingIntake;
        return {};
      }
      if (k === 'UpdateCommand' && i.TableName === TABLES.battleConfig) {
        const row = battleConfigs.get(i.Key.channelArn);
        if (!row || row.enabledBy !== i.ExpressionAttributeValues[':arn']) throw named('ConditionalCheckFailedException');
        delete row.enabledBy;
        return {};
      }
      // OFFBOARDING NEVER CHANGES AN Identities ROW: it deletes rows and writes markers, and its role holds no
      // update there. An update reaching this fake is a regression.
      if (k === 'UpdateCommand') throw new Error(`offboarding updated ${i.TableName}, which it never does`);
      if (k === 'TransactWriteCommand') {
        for (const item of i.TransactItems) {
          if (item.Delete) identities.delete(item.Delete.Key.issuerSubject);
          if (item.Put) identities.set(item.Put.Item.issuerSubject, item.Put.Item);
        }
        return {};
      }
      throw new Error(`unexpected ${k}`);
    }),
  };

  const chime = {
    send: jest.fn(async (cmd: unknown) => {
      const i = input(cmd);
      const k = kind(cmd);
      const arn = i.AppInstanceUserArn ?? i.ResourceARN ?? i.AppInstanceAdminArn;
      if (k === 'DescribeAppInstanceUserCommand') {
        if (!users.has(arn)) throw named('NotFoundException');
        return { AppInstanceUser: { AppInstanceUserArn: arn } };
      }
      if (k === 'ListTagsForResourceCommand') {
        if (!users.has(arn)) throw named('NotFoundException');
        return { Tags: users.get(arn)!.tags };
      }
      if (k === 'DeleteAppInstanceAdminCommand') {
        if (!admins.delete(arn)) throw named('NotFoundException');
        return {};
      }
      if (k === 'DeleteAppInstanceUserCommand') {
        if (!users.delete(arn)) throw named('NotFoundException');
        return {};
      }
      if (k === 'ListAppInstanceUsersCommand') {
        return { AppInstanceUsers: [...users.keys()].map((a) => ({ AppInstanceUserArn: a })) };
      }
      if (k === 'TagResourceCommand') return {};
      throw new Error(`unexpected ${k}`);
    }),
  };

  const messaging = {
    send: jest.fn(async (cmd: unknown) => {
      const i = input(cmd);
      const k = kind(cmd);
      // A channel's tags are read with no bearer, as Amazon Chime SDK tagging takes none.
      if (k === 'ListTagsForResourceCommand') return { Tags: channelTags.get(i.ResourceARN) ?? [] };
      if (i.ChimeBearer !== SERVICE_ADMIN) throw named('ForbiddenException');
      if (k === 'ListChannelMessagesCommand') {
        if (!channelMessages.has(i.ChannelArn)) throw named('NotFoundException');
        return { ChannelMessages: [...channelMessages.get(i.ChannelArn)!] };
      }
      if (k === 'DeleteChannelMessageCommand') {
        const list = channelMessages.get(i.ChannelArn) ?? [];
        const at = list.findIndex((m) => m.MessageId === i.MessageId);
        if (at < 0) throw named('NotFoundException');
        list.splice(at, 1);
        return {};
      }
      if (k === 'ListChannelMembershipsForAppInstanceUserCommand') {
        return { ChannelMemberships: [...(memberships.get(i.AppInstanceUserArn) || [])].map((c) => ({ ChannelSummary: { ChannelArn: c } })) };
      }
      if (k === 'DeleteChannelMembershipCommand') {
        memberships.get(i.MemberArn)?.delete(i.ChannelArn);
        return {};
      }
      throw new Error(`unexpected ${k}`);
    }),
  };

  const s3 = {
    send: jest.fn(async (cmd: unknown) => {
      const i = input(cmd);
      const k = kind(cmd);
      if (k === 'ListObjectsV2Command') {
        // A listing under one conversation's person prefix (an export's) names its current objects.
        if (!i.Delimiter && i.Prefix !== 'attachments/') {
          const current = new Map(objects.filter((o) => o.Key.startsWith(i.Prefix)).map((o) => [o.Key, o]));
          return { Contents: [...current.keys()].map((Key) => ({ Key, Size: 10 })) };
        }
        const convs = new Set(objects.map((o) => o.Key.split('/').slice(0, 2).join('/') + '/'));
        return { CommonPrefixes: [...convs].map((Prefix) => ({ Prefix })) };
      }
      if (k === 'ListObjectVersionsCommand') {
        return { Versions: objects.filter((o) => o.Key.startsWith(i.Prefix)), DeleteMarkers: [], IsTruncated: false };
      }
      if (k === 'DeleteObjectsCommand') {
        for (const o of i.Delete.Objects) {
          const at = objects.findIndex((x) => x.Key === o.Key && x.VersionId === o.VersionId);
          if (at >= 0) objects.splice(at, 1);
        }
        return {};
      }
      throw new Error(`unexpected ${k}`);
    }),
  };

  const cognito = {
    send: jest.fn(async (cmd: unknown) => {
      const i = input(cmd);
      const k = kind(cmd);
      cognitoCalls.push({ command: k, input: i });
      const accounts = pools.get(i.UserPoolId)!;
      const account = [...accounts.values()].find((a) => a.username === i.Username || a.subject === i.Username);
      if (!account) throw named('UserNotFoundException');
      if (k === 'AdminUserGlobalSignOutCommand') return {};
      if (k === 'AdminDeleteUserCommand') { accounts.delete(account.subject); return {}; }
      throw new Error(`unexpected ${k}`);
    }),
  };

  const recordOf = (a: Account): PoolRecord => ({
    subject: a.subject, username: a.username, enabled: a.enabled, email: a.email, name: a.name ?? null, attributes: { sub: a.subject, email: a.email },
  });
  const poolOf = (poolId: string): CognitoPoolDirectory => ({
    poolId,
    issuer: poolId === POOL_ID ? ISS : OTHER_ISS,
    issuers: [poolId === POOL_ID ? ISS : OTHER_ISS],
    async usersInGroup() { return []; },
    async record(s) {
      const a = [...pools.get(poolId)!.values()].find((x) => x.subject === s || x.username === s);
      return a ? recordOf(a) : null;
    },
    async byEmail() { return []; },
    async byUsername(u) {
      const a = [...pools.get(poolId)!.values()].find((x) => x.username === u);
      return a ? recordOf(a) : null;
    },
    async listPage() { return { users: [...pools.get(poolId)!.values()].map(recordOf) }; },
    async groupNames() { return []; },
    async groupExists() { return true; },
  });

  const primary = poolOf(POOL_ID);
  const other = poolOf(OTHER_POOL_ID);
  const deps: OffboardingDeps = {
    doc, chime, messaging, s3, cognito,
    identitiesTable: TABLES.identities,
    appInstanceArn: APP,
    primary,
    others: [other],
    adminBearer: async () => SERVICE_ADMIN,
    stores: async () => ({
      userProfile: TABLES.userProfile,
      userTasks: TABLES.userTasks,
      turnState: TABLES.turnState,
      abuseControls: TABLES.abuseControls,
      attachmentsBucket: TABLES.bucket,
      tokens: TABLES.tokens,
    }),
    archive: jest.fn(async (e) => { archived.push(e); }),
    audit: jest.fn(async (line) => { audit.push(line); }),
  };

  /** A person: their AppInstanceUser, one Identities row per subject, and records in every store. */
  function seedPerson(id: string, subjects: Array<{ issuer: string; subject: string; status?: string }>, opts: { twin?: boolean; records?: boolean } = {}) {
    const arn = `${APP}/user/${id}`;
    users.set(arn, { tags: [] });
    for (const s of subjects) {
      identities.set(`${s.issuer}|${s.subject}`, {
        issuerSubject: `${s.issuer}|${s.subject}`, personArn: arn, issuer: s.issuer, status: s.status ?? 'active', createdAt: '2026-10-01T00:00:00.000Z',
      });
    }
    memberships.set(arn, new Set([`${APP}/channel/c1`, `${APP}/channel/c2`]));
    if (opts.twin) {
      const twinArn = `${APP}/user/${id}-admin`;
      users.set(twinArn, { tags: [{ Key: 'owner', Value: arn }] });
      admins.add(twinArn);
      memberships.set(twinArn, new Set([`${APP}/channel/admin-room`]));
    }
    if (opts.records !== false) {
      profiles.set(id, { personId: id, onboarded: true });
      profiles.set(`${id}#notices`, { personId: `${id}#notices`, personArn: arn, muted: { 'email:briefing': '2026-10-01T00:00:00.000Z' } });
      tokens.set(`reply#${id}`, { pk: `reply#${id}`, kind: 'reply', personArn: arn, channelArn: `${APP}/channel/c1` });
      tokens.set(`claim#${id}`, { pk: `claim#${id}`, kind: 'claim', personArn: arn, channelArn: `${APP}/channel/c1` });
      // An invitation they issued, naming somebody else: deleted with them, so it can no longer be redeemed.
      tokens.set(`invitation#${id}`, { pk: `invitation#${id}`, kind: 'invitation', personArn: `${APP}/user/invitee-of-${id}`, inviterArn: arn, channelArn: `${APP}/channel/c1` });
      // A token of a kind offboarding does not delete with the person (a guest's refresh family is its own).
      tokens.set(`guest-family#${id}`, { pk: `guest-family#${id}`, kind: 'guest-family', personArn: arn });
      tasks.push({ principalId: id, taskId: 't1' }, { principalId: id, taskId: 't2' });
      turn.set(`stop#${APP}/channel/c1#${id}#bot-1`, { pk: `stop#${APP}/channel/c1#${id}#bot-1` });
      abuse.set(budgetRowOf(id), { pk: budgetRowOf(id) });
      objects.push({ Key: `attachments/c1/${id}/a.pdf`, VersionId: 'v1' }, { Key: `attachments/c1/${id}/a.pdf`, VersionId: 'v2' });
      // Their votes and thumbs, which offboarding keeps.
      battleVotes.set('battle-1', { battleId: 'battle-1', votes: { [id]: { winner: 'A' } } });
      feedback.set('fb-1', { feedbackId: 'fb-1', userSub: id, feedback: 'up' });
    }
    return arn;
  }

  function seedAccount(poolId: string, a: Account) {
    pools.get(poolId)!.set(a.subject, a);
  }

  // Another person's records, which offboarding must leave alone.
  function seedBystander() {
    tasks.push({ principalId: 'bystander', taskId: 't9' });
    tokens.set('reply#bystander', { pk: 'reply#bystander', kind: 'reply', personArn: `${APP}/user/bystander` });
    tokens.set('invitation#bystander', { pk: 'invitation#bystander', kind: 'invitation', personArn: `${APP}/user/someone`, inviterArn: `${APP}/user/bystander` });
    turn.set(`stop#${APP}/channel/c1#bystander#bot-1`, { pk: `stop#${APP}/channel/c1#bystander#bot-1` });
    abuse.set(budgetRowOf('bystander'), { pk: budgetRowOf('bystander') });
    objects.push({ Key: 'attachments/c1/bystander/b.pdf', VersionId: 'v1' });
  }

  return {
    deps, doc, chime, messaging, s3, cognito, identities, agentTasks, channelContexts, battleConfigs, channelTags, channelMessages, tokens, profiles, tasks, turn, abuse, battleVotes, feedback, users, admins, memberships, objects, pools,
    archived, audit, tablesTouched, cognitoCalls, primary, other, seedPerson, seedAccount, seedBystander,
  };
}
