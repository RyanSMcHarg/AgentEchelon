#!/usr/bin/env node
/**
 * Delete conversations (Amazon Chime SDK channels) on a deployment, by one of two selections.
 *
 * Why: e2e runs created conversations and never removed them, so dev filled with duplicate subjects and
 * half-finished turns, and premium's assistant passed the `SearchChannels` bearer limit (1,389 memberships on
 * 2026-10-16). Deleting a channel removes it from Amazon Chime SDK only: the S3 archive is
 * the system of record and keeps every event and every analytics fact (tenet D7).
 *
 *   --archived                    every conversation tagged `archived=true` (conversation-management.ts)
 *   --created-since=<ISO time>    every conversation CREATED after that time that has a test user as a member.
 *                                 What an e2e run made: older rooms (the admin notification channel, demo
 *                                 rooms) are never selected, whoever is in them.
 *
 *   --only-test-people            with either: keep any room a real person is in (see onlyTestPeople), team rooms
 *                                 included, before anything is deleted or cleared.
 *   --clear-team-rooms            with --created-since: also clear the standing team rooms the test users are in
 *                                 (`team-<type>-<classification>`), which are kept: the room and its older history
 *                                 stay, and from the window only what the test users made goes (teamRoomClearing,
 *                                 lib/reset-demo.cjs). A message goes when a test user wrote it, or an assistant did
 *                                 in a room only test users are in; a message anyone else wrote never goes. The task
 *                                 rows created since that time go only from a room only test users are in, and a room
 *                                 holding an open task from the window is left as it is and named. The dry run lists,
 *                                 per author, how many of their messages would go and how many stay.
 *
 * THE ROOM'S TASKS GO WITH IT. A task row outlives its channel otherwise, and a person's open items then list
 * work in a conversation that no longer exists and cannot be answered. Each deleted room's rows are deleted from
 * the AgentTasks table and the UserTasks mirror, found through each table's channel index.
 *
 * A dry run is the default and deletes nothing. `--apply` deletes, bearing the app-instance admin.
 *
 * Usage:
 *   AWS_PROFILE=<profile> node backend/scripts/delete-conversations.mjs --archived
 *   AWS_PROFILE=<profile> node backend/scripts/delete-conversations.mjs --archived --apply
 *   AWS_PROFILE=<profile> node backend/scripts/delete-conversations.mjs --created-since=2026-10-16T18:00:00Z --apply
 */
import {
  ChimeSDKMessagingClient, ListChannelsCommand, ListTagsForResourceCommand, DescribeChannelCommand,
  DeleteChannelCommand, ListChannelMembershipsForAppInstanceUserCommand, ListChannelMembershipsCommand,
  ListChannelMessagesCommand, DeleteChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CognitoIdentityProviderClient, ListUsersCommand, ListUsersInGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient, QueryCommand, BatchWriteItemCommand, GetItemCommand, ScanCommand, UpdateItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { createRequire } from 'node:module';

const REGION = process.env.AWS_REGION || 'us-east-1';
// THE SAME INSTANCE validate.mjs resolves (AE_INSTANCE_NAME, E2E_INSTANCE_NAME, INSTANCE_NAME or SSM_ROOT), so a
// cleanup run by validate addresses the deployment under test and never the default one.
const { resolveInstanceName } = createRequire(import.meta.url)('./lib/stack-lookup.cjs');
const { appInstanceArnOf, personIdFromArn } = createRequire(import.meta.url)('./lib/person-arn.cjs');
const { isTeamRoom, teamRoomClearing, seededAccountTeamEmails, ACCOUNT_TEAM_GROUP, recordsNamingDeleted } = createRequire(import.meta.url)('./lib/reset-demo.cjs');
const INSTANCE = resolveInstanceName(process.env);
const SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';
const APPLY = process.argv.includes('--apply');
const ARCHIVED = process.argv.includes('--archived');
const CLEAR_TEAM_ROOMS = process.argv.includes('--clear-team-rooms');
const sinceArg = process.argv.find((a) => a.startsWith('--created-since='))?.slice('--created-since='.length);

if (ARCHIVED === Boolean(sinceArg)) {
  console.error('Name exactly one selection: --archived, or --created-since=<ISO time>.');
  process.exit(2);
}
if (CLEAR_TEAM_ROOMS && !sinceArg) {
  console.error('--clear-team-rooms clears what was posted since a time: name it with --created-since=<ISO time>.');
  process.exit(2);
}
const since = sinceArg ? new Date(sinceArg) : null;
if (since && Number.isNaN(since.getTime())) {
  console.error(`--created-since is not a time: ${sinceArg}`);
  process.exit(2);
}

const chime = new ChimeSDKMessagingClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });
const dynamo = new DynamoDBClient({ region: REGION });

const adminArn = (await ssm.send(new GetParameterCommand({ Name: `/${INSTANCE}/app-instance-admin-arn` }))).Parameter?.Value || '';
if (!adminArn.includes('/user/')) {
  console.error('The app-instance admin ARN could not be read; nothing can be addressed.');
  process.exit(2);
}
const appInstanceArn = appInstanceArnOf(adminArn);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every call, retried with backoff when the service throttles: a sweep over thousands of rooms is throttled on dev. */
async function send(command) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await chime.send(command);
    } catch (err) {
      const throttled = err?.name === 'ThrottledClientException' || err?.name === 'ThrottlingException'
        || err?.Code === 'Throttling' || err?.$metadata?.httpStatusCode === 429;
      if (!throttled || attempt >= 8) throw err;
      await pause(Math.min(8000, 400 * 2 ** attempt));
    }
  }
}

/** Every channel in the app instance, both privacies, as the admin. */
async function allChannels() {
  const out = [];
  for (const Privacy of ['PRIVATE', 'PUBLIC']) {
    let NextToken;
    do {
      const r = await send(new ListChannelsCommand({ AppInstanceArn: appInstanceArn, ChimeBearer: adminArn, Privacy, MaxResults: 50, NextToken }));
      for (const c of r.Channels || []) if (c.ChannelArn) out.push(c.ChannelArn);
      NextToken = r.NextToken;
    } while (NextToken);
  }
  return [...new Set(out)];
}

async function archivedChannels() {
  const all = await allChannels();
  console.log(`${all.length} conversation(s) listed; reading their tags...`);
  const picked = [];
  // EIGHT AT A TIME, with a retry on throttling: one at a time took longer than ten minutes on dev.
  const readTags = async (arn) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { return (await send(new ListTagsForResourceCommand({ ResourceARN: arn }))).Tags || []; }
      catch (err) { if (err?.name !== 'ThrottledClientException' && err?.name !== 'ThrottlingException') throw err; await pause(500 * (attempt + 1)); }
    }
    throw new Error(`tags for ${arn} stayed throttled`);
  };
  for (let i = 0; i < all.length; i += 8) {
    const batch = all.slice(i, i + 8);
    const tags = await Promise.all(batch.map(readTags));
    batch.forEach((arn, j) => { if (tags[j].some((t) => t.Key === 'archived' && t.Value === 'true')) picked.push(arn); });
    if ((i / 8) % 50 === 0) console.log(`  ${Math.min(i + 8, all.length)}/${all.length} read, ${picked.length} archived so far`);
  }
  console.log(`${all.length} conversation(s) in the app instance; ${picked.length} tagged archived=true.`);
  return picked;
}

/**
 * The test users' AppInstanceUser ARNs: each test user's Cognito `sub`, resolved through the Identities row the
 * credential exchange wrote at their first sign-in (`deployment|<sub>`, lambda/src/lib/person-identity.ts). The
 * AppInstanceUser id is minted, never the sub. A test user with no active row (never signed in, or offboarded)
 * is in no conversation and is skipped with its reason.
 */
let testUserArnsRead;
function testUserArns() {
  testUserArnsRead ??= readTestUserArns();
  return testUserArnsRead;
}
async function readTestUserArns() {
  const secret = JSON.parse((await new SecretsManagerClient({ region: REGION }).send(new GetSecretValueCommand({ SecretId: SECRET_NAME }))).SecretString || '{}');
  const emails = Object.values(secret).map((v) => (v && typeof v === 'object' ? v.email : null)).filter(Boolean);
  // The pool the test users are in: validate.mjs exports it from the Identity stack's outputs.
  const pool = process.env.VITE_USER_POOL_ID;
  if (!pool) throw new Error('VITE_USER_POOL_ID is not set; it names the pool the test users are in.');
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  // THE SEED'S ACCOUNT TEAMS ARE TEST PEOPLE TOO, so the meeting conversations they are in go with a reset.
  const groupEmails = [];
  let groupToken;
  do {
    const r = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: pool, GroupName: ACCOUNT_TEAM_GROUP, NextToken: groupToken })).catch(() => ({}));
    for (const u of r.Users || []) groupEmails.push(u.Attributes?.find((a) => a.Name === 'email')?.Value || '');
    groupToken = r.NextToken;
  } while (groupToken);
  emails.push(...seededAccountTeamEmails(secret, groupEmails, { emailDomain: process.env.TEST_EMAIL_DOMAIN }));
  const identitiesParam = `/${INSTANCE}/shared/tables/identities-name`;
  const identities = (await ssm.send(new GetParameterCommand({ Name: identitiesParam }))).Parameter?.Value;
  if (!identities) throw new Error(`${identitiesParam} is not published; the test users' AppInstanceUsers cannot be resolved.`);
  const arns = [];
  for (const email of emails) {
    const u = (await cognito.send(new ListUsersCommand({ UserPoolId: pool, Filter: `email = "${email}"`, Limit: 1 }))).Users?.[0];
    const sub = u?.Attributes?.find((a) => a.Name === 'sub')?.Value;
    if (!sub) { console.log(`  skipped a test user: no account in the pool`); continue; }
    const row = (await dynamo.send(new GetItemCommand({ TableName: identities, Key: { issuerSubject: { S: `deployment|${sub}` } }, ConsistentRead: true }))).Item;
    const arn = row?.personArn?.S || '';
    const status = row?.status?.S || 'active';
    if (!row || !personIdFromArn(arn)) { console.log(`  skipped test user ${sub}: no Identities row (never signed in)`); continue; }
    if (status !== 'active') { console.log(`  skipped test user ${sub}: Identities row is ${status}`); continue; }
    if (appInstanceArnOf(arn) === appInstanceArn) arns.push(arn);
    else console.log(`  skipped test user ${sub}: its AppInstanceUser is in another app instance`);
  }
  return [...new Set(arns)];
}

/**
 * The team rooms the test users are in: kept whenever they were created, and cleared with --clear-team-rooms. A team room
 * has a fixed id that alarm triggers and room tags name, so it stands and only what the window added to it goes.
 */
const standingTeamRooms = [];

async function createdSinceWithTestUsers() {
  const users = await testUserArns();
  const candidates = new Set();
  for (const user of users) {
    let NextToken;
    try {
      do {
        const r = await send(new ListChannelMembershipsForAppInstanceUserCommand({ AppInstanceUserArn: user, ChimeBearer: adminArn, MaxResults: 50, NextToken }));
        for (const m of r.ChannelMemberships || []) if (m.ChannelSummary?.ChannelArn) candidates.add(m.ChannelSummary.ChannelArn);
        NextToken = r.NextToken;
      } while (NextToken);
    } catch (err) {
      // A test user whose AppInstanceUser is gone (a disposable user a deny test deleted) belongs to nothing.
      if (err?.name !== 'ForbiddenException' && err?.name !== 'NotFoundException') throw err;
      console.log(`  skipped ${user}: ${err.name} (${err.message})`);
    }
  }
  const picked = [];
  for (const arn of candidates) {
    if (isTeamRoom(arn)) { standingTeamRooms.push(arn); continue; }
    const c = (await send(new DescribeChannelCommand({ ChannelArn: arn, ChimeBearer: adminArn }))).Channel;
    if (c?.CreatedTimestamp && new Date(c.CreatedTimestamp) > since) picked.push(arn);
  }
  console.log(`${users.length} test user(s), ${candidates.size} conversation(s) they belong to; ${picked.length} created after ${since.toISOString()}.`);
  return picked;
}

/**
 * KEEP A ROOM ANY REAL PERSON IS IN. With `--only-test-people`, a selected room is deleted only when every
 * HUMAN member is a test user (assistants and the service admin are not people). The admin notification
 * channel and demo rooms have real people in them, so they are kept however old they are.
 */
/** Whether every HUMAN member of a room is a test user, and it has at least one. */
async function hasOnlyTestPeople(arn, tests) {
  const humans = [];
  let NextToken;
  do {
    const r = await send(new ListChannelMembershipsCommand({ ChannelArn: arn, ChimeBearer: adminArn, MaxResults: 50, NextToken }));
    for (const m of r.ChannelMemberships || []) {
      const a = m.Member?.Arn || '';
      if (a.includes('/user/') && a !== adminArn) humans.push(a);
    }
    NextToken = r.NextToken;
  } while (NextToken);
  return humans.length > 0 && humans.every((h) => tests.has(h));
}

async function onlyTestPeople(arns) {
  const tests = new Set(await testUserArns());
  const kept = [];
  for (let i = 0; i < arns.length; i += 8) {
    const batch = arns.slice(i, i + 8);
    const verdicts = await Promise.all(batch.map((arn) => hasOnlyTestPeople(arn, tests)));
    batch.forEach((arn, j) => { if (verdicts[j]) kept.push(arn); });
  }
  console.log(`${kept.length} of ${arns.length} have only test users as their people; the rest are kept.`);
  return kept;
}

/** The task tables, by the names the classification stacks publish. Missing on a deployment without tasks. */
const tableName = async (kind) => (await ssm.send(new GetParameterCommand({ Name: `/${INSTANCE}/shared/tables/${kind}-name` }))
  .catch(() => null))?.Parameter?.Value || '';
const TASK_TABLES = [
  { name: await tableName('agent-tasks'), index: 'channelArn-updatedAt-index', keys: ['taskId', 'channelArn'] },
  { name: await tableName('user-tasks'), index: 'channelArn-assistantId-index', keys: ['principalId', 'taskId'] },
].filter((t) => t.name);

/** Delete every task row of one room, in both tables. Returns how many rows went. */
async function deleteTasksOf(channelArn) {
  let removed = 0;
  for (const t of TASK_TABLES) {
    const keys = [];
    let ExclusiveStartKey;
    do {
      const r = await dynamo.send(new QueryCommand({
        TableName: t.name, IndexName: t.index,
        KeyConditionExpression: 'channelArn = :c',
        ExpressionAttributeValues: { ':c': { S: channelArn } },
        ExclusiveStartKey,
      }));
      for (const item of r.Items || []) keys.push(Object.fromEntries(t.keys.map((k) => [k, item[k]])));
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    for (let i = 0; i < keys.length; i += 25) {
      let RequestItems = { [t.name]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
      for (let attempt = 0; RequestItems[t.name]?.length && attempt < 6; attempt += 1) {
        const r = await dynamo.send(new BatchWriteItemCommand({ RequestItems }));
        RequestItems = r.UnprocessedItems || {};
        if (RequestItems[t.name]?.length) await pause(200 * 2 ** attempt);
      }
      if (RequestItems[t.name]?.length) throw new Error(`${RequestItems[t.name].length} task row(s) in ${t.name} stayed unprocessed`);
    }
    removed += keys.length;
  }
  return removed;
}

/** Every message in a room since the window, as the admin and as each member: a targeted message is listed only to the person it targets. */
async function messagesSince(channelArn) {
  const bearers = [adminArn];
  let NextToken;
  do {
    const r = await send(new ListChannelMembershipsCommand({ ChannelArn: channelArn, ChimeBearer: adminArn, MaxResults: 50, NextToken }));
    for (const m of r.ChannelMemberships || []) if (m.Member?.Arn?.includes('/user/') && m.Member.Arn !== adminArn) bearers.push(m.Member.Arn);
    NextToken = r.NextToken;
  } while (NextToken);
  const out = [];
  for (const ChimeBearer of bearers) {
    let token;
    do {
      const r = await send(new ListChannelMessagesCommand({ ChannelArn: channelArn, ChimeBearer, NotBefore: since, SortOrder: 'DESCENDING', MaxResults: 50, NextToken: token }));
      for (const m of r.ChannelMessages || []) out.push({ MessageId: m.MessageId, CreatedTimestamp: m.CreatedTimestamp, author: m.Sender?.Arn || '' });
      token = r.NextToken;
    } while (token);
  }
  return out;
}

/**
 * A task row has ended when its status is a terminal one (`TERMINAL_TASK_STATUS`, lambda/src/lib/task-tracking.ts).
 * `abandoned` is not: an abandoned task can be resumed, so it is open.
 */
const ENDED_STATUS = new Set(['completed', 'failed', 'cancelled']);

/** A room's task rows in both tables, with what the clearing reads. */
async function taskRowsOf(channelArn) {
  const rows = [];
  for (const t of TASK_TABLES) {
    let ExclusiveStartKey;
    do {
      const r = await dynamo.send(new QueryCommand({
        TableName: t.name, IndexName: t.index, KeyConditionExpression: 'channelArn = :c',
        ExpressionAttributeValues: { ':c': { S: channelArn } }, ExclusiveStartKey,
      }));
      for (const item of r.Items || []) {
        rows.push({
          table: t.name, key: Object.fromEntries(t.keys.map((k) => [k, item[k]])),
          taskId: item.taskId?.S, createdAt: item.createdAt?.S, terminal: ENDED_STATUS.has(item.status?.S),
        });
      }
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }
  return rows;
}

/** Clear one standing team room of the window's messages and task rows. Returns true when it could not be cleared. */
async function clearTeamRoom(channelArn) {
  const id = channelArn.split('/').pop();
  const cast = new Set(await testUserArns());
  const onlyCastInRoom = await hasOnlyTestPeople(channelArn, cast);
  const rows = await taskRowsOf(channelArn);
  const plan = teamRoomClearing(await messagesSince(channelArn), rows, since, { cast, onlyCastInRoom });
  if (!plan.clear) {
    console.log(`  ${id}: kept as it is; task(s) from the window still open: ${plan.open.join(', ')}. Settle them, then run again.`);
    return true;
  }
  console.log(`  ${id}: ${plan.messageIds.length} message(s) and ${plan.taskIds.length} task(s) since ${since.toISOString()}${APPLY ? '' : ' would go'}${onlyCastInRoom ? '' : '; a person outside the test users is in the room, so its tasks and its assistants\x27 messages stay'}`);
  for (const a of plan.authors) {
    const who = a.kind === 'cast' ? `test user ${personIdFromArn(a.author) || a.author}` : a.kind === 'assistant' ? `assistant ${a.author.split('/').pop()}` : `${personIdFromArn(a.author) || a.author.split('/').pop() || 'unknown sender'} (not a test user)`;
    console.log(`    ${who}: ${a.included} message(s)${APPLY ? ' deleted' : ' would go'}, ${a.kept} kept`);
  }
  if (!APPLY) return false;
  let failed = false;
  for (const MessageId of plan.messageIds) {
    try { await send(new DeleteChannelMessageCommand({ ChannelArn: channelArn, MessageId, ChimeBearer: adminArn })); }
    catch (err) {
      if (err?.name === 'NotFoundException') continue;
      failed = true;
      console.warn(`  could not delete a message in ${id}: ${err?.name}: ${err?.message}`);
    }
  }
  const going = new Set(plan.taskIds);
  for (const row of rows.filter((r) => going.has(r.taskId))) {
    const r = await dynamo.send(new BatchWriteItemCommand({ RequestItems: { [row.table]: [{ DeleteRequest: { Key: row.key } }] } }));
    if (r.UnprocessedItems?.[row.table]?.length) { failed = true; console.warn(`  could not delete task ${row.taskId} in ${row.table}`); }
  }
  return failed;
}

let picked = ARCHIVED ? await archivedChannels() : await createdSinceWithTestUsers();
const ONLY_TEST_PEOPLE = process.argv.includes('--only-test-people');
if (ONLY_TEST_PEOPLE) picked = await onlyTestPeople(picked);
let teamRoomFailures = 0;
if (CLEAR_TEAM_ROOMS) {
  let teamRooms = standingTeamRooms;
  // A team room a real person is in is kept as it is, as every other room is under --only-test-people.
  if (ONLY_TEST_PEOPLE) teamRooms = await onlyTestPeople(teamRooms);
  console.log(`${teamRooms.length} standing team room(s) the test users are in to clear:`);
  for (const arn of teamRooms) if (await clearTeamRoom(arn)) teamRoomFailures += 1;
}
if (!APPLY) {
  for (const arn of picked.slice(0, 10)) console.log(`  would delete ${arn.split('/').pop()}`);
  if (picked.length > 10) console.log(`  ... and ${picked.length - 10} more`);
  if (teamRoomFailures) console.log(`${teamRoomFailures} team room(s) could not be cleared.`);
  console.log(`Dry run: nothing was deleted. With --apply each room's task rows go too (${TASK_TABLES.map((t) => t.name).join(', ') || 'no task tables found'}).`);
  process.exit(teamRoomFailures ? 1 : 0);
}

let deleted = 0;
let tasksDeleted = 0;
const failed = [];
const taskFailures = [];
/** The tasks go only with a room that is gone, so a room that could not be deleted keeps its work. */
const afterRoomDeleted = async (arn) => {
  try { tasksDeleted += await deleteTasksOf(arn); }
  catch (err) { taskFailures.push(arn); console.warn(`  could not delete the tasks of ${arn.split('/').pop()}: ${err?.name}: ${err?.message}`); }
};
for (const arn of picked) {
  try {
    await send(new DeleteChannelCommand({ ChannelArn: arn, ChimeBearer: adminArn }));
    deleted += 1;
    await afterRoomDeleted(arn);
  } catch (err) {
    if (err?.name === 'NotFoundException') { deleted += 1; await afterRoomDeleted(arn); continue; }
    if (err?.name === 'ThrottledClientException') { await pause(1000); failed.push(arn); continue; }
    failed.push(arn);
    console.warn(`  could not delete ${arn.split('/').pop()}: ${err?.name}: ${err?.message}`);
  }
  if (deleted % 25 === 0) await pause(250);
}
for (const arn of [...failed]) {
  try {
    await send(new DeleteChannelCommand({ ChannelArn: arn, ChimeBearer: adminArn }));
    deleted += 1;
    failed.splice(failed.indexOf(arn), 1);
    await afterRoomDeleted(arn);
  } catch { /* reported below */ }
}
console.log(`Deleted ${deleted} of ${picked.length} conversation(s).${failed.length ? ` ${failed.length} could not be deleted.` : ''}`);

// WHAT THE DELETED CONVERSATIONS LEAVE BEHIND in the conversation-context table: a parent's `children` entry, which its
// open-incident count reads, and a watch record naming one as its room. Each goes under a condition that it still names
// the deleted room, so a record written since is kept.
let staleFailures = 0;
const goneArns = picked.filter((a) => !failed.includes(a));
const contextTable = await tableName('channel-context');
if (contextTable && goneArns.length) {
  const rows = [];
  let ExclusiveStartKey;
  do {
    const page = await dynamo.send(new ScanCommand({
      TableName: contextTable, ProjectionExpression: 'channelArn, children, room',
      FilterExpression: 'attribute_exists(children) OR begins_with(channelArn, :w)', ExpressionAttributeValues: { ':w': { S: 'watch#' } },
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }));
    rows.push(...(page.Items ?? []).map((i) => unmarshall(i)));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  const stale = recordsNamingDeleted(rows, goneArns);
  for (const c of stale.children) {
    try {
      await dynamo.send(new UpdateItemCommand({
        TableName: contextTable, Key: { channelArn: { S: c.channelArn } }, UpdateExpression: `REMOVE children[${c.index}]`,
        ConditionExpression: `children[${c.index}].channelId = :id`, ExpressionAttributeValues: { ':id': { S: c.channelId } },
      }));
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') { staleFailures += 1; console.warn(`  could not forget ${c.channelId} in ${c.channelArn.split('/').pop()}: ${err?.name}`); }
    }
  }
  for (const w of stale.watches) {
    try {
      await dynamo.send(new DeleteItemCommand({
        TableName: contextTable, Key: { channelArn: { S: w.key } }, ConditionExpression: 'room = :room', ExpressionAttributeValues: { ':room': { S: w.room } },
      }));
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') { staleFailures += 1; console.warn(`  could not drop ${w.key}: ${err?.name}`); }
    }
  }
  console.log(`Forgot ${stale.children.length} child entr(ies) and ${stale.watches.length} watch record(s) naming a deleted conversation.${staleFailures ? ` ${staleFailures} could not be changed.` : ''}`);
}
console.log(`Deleted ${tasksDeleted} task row(s) across ${TASK_TABLES.map((t) => t.name).join(', ') || 'no task tables'}.${taskFailures.length ? ` The tasks of ${taskFailures.length} room(s) could not be deleted.` : ''}`);
if (teamRoomFailures) console.log(`${teamRoomFailures} team room(s) could not be cleared.`);
process.exit(failed.length || taskFailures.length || teamRoomFailures || staleFailures ? 1 : 0);
