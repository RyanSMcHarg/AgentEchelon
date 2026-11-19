/**
 * AN EVENT REACHES THE CONVERSATION THAT WATCHES ITS KEY (DESIGN-EVENT-TARGETS, SPEC-WORKFLOWS-AND-TASKS WT123 to WT126), against
 * the deployed stacks.
 *
 * The unit suites prove each check (`an-opener-records-the-key-it-watches.test.ts`,
 * `an-event-reaches-only-the-conversation-that-watches-its-key.test.ts`). What only a deployment proves is the path as AWS resources:
 *  - attaching a watch trigger in the console's API makes one rule, named per classification, whose tags carry its binding and whose
 *    one target is the relay with the key's path;
 *  - an ops event naming an incident opens an `ops` room whose row lists the incident's key and whose watch item names it;
 *  - a second opening event for the same incident opens no second room;
 *  - an update for the incident, which names no room, reaches that room and runs the version's `incident-updated` there, once per window.
 *
 * THE RUN OWNS WHAT IT TOUCHES: a helper rule whose pattern the trigger copies, the trigger, the rooms, their rows, the watch item,
 * the policy if it had to allow the update event, and the ops assistant's version, each returned.
 *
 * GATED: it changes a deployed assistant's active version, so it runs only with INCIDENT_TRIAGE_E2E=1 (validate.mjs --only=incident-triage).
 *
 * **Coverage:** `e2e/an-event-reaches-the-conversation-that-watches-its-key.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getOpsLeadUser, getTestCredentials, hasTestCredentials, missingUserReason, type TestUser } from './helpers/test-credentials';
import { exchange, signedCall, type VendedCredentials } from './helpers/admin-api';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';
import { idTokenFor, personArnOf } from './helpers/person';
import { liveAssistantFor } from './helpers/battle-setup';
import { messageRowsVisibleTo } from './helpers/third-party-view';
import { pollFor, unmarshalItem } from './helpers/task-backend';
import { INSTANCE, SSM_ROOT, STACK_PREFIX, physicalIdsInClassificationStacks } from './helpers/stack-prefix';
import { awsv, awsvText } from './helpers/aws';
import { SHIPPED_EVENT_WORKFLOWS, refWatchKey } from '../../backend/lambda/src/lib/event-workflow';
import { replacingDraft, draftIdOf } from './helpers/profile-draft';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The ops event builders `scripts/send-ops-event.mjs` sends with (CommonJS, shared with the operator script). */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const opsEvent = require('../../backend/scripts/lib/ops-event.cjs') as {
  OPS_EVENT_SOURCE: string;
  OPS_INCIDENT_UPDATED: string;
  opsEventEntry: (a: { instance: string; forPerson: string; concernedChannelArn: string; topicLabel?: string; summary?: string; incidentId?: string }) => Record<string, string>;
  opsUpdateEntry: (a: { instance: string; incidentId: string }) => Record<string, unknown>;
};

const RUN = process.env.INCIDENT_TRIAGE_E2E === '1';
const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STAMP = Date.now().toString(36);
const INCIDENT = `INC-e2e-${STAMP}`;
const KIND = 'ops-incident';
const TOPIC = `Watched incident e2e ${STAMP}`;
const TOPIC_AGAIN = `Watched incident e2e again ${STAMP}`;
const WORKFLOW = 'incident-updated';
const HELPER_RULE = `e2e-incident-updated-${STAMP}`;
const AT = 'premium';
/** The watched type, and a team room type a watch target is refused on: the routes' {typeKey}. */
const WATCHED = 'ops';
const TEAM = 'ops-team';

function ssmValue(name: string): string {
  try { const v = awsvText(['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value', '--output', 'text'], { quiet: true }).trim(); return v === 'None' ? '' : v; } catch { return ''; }
}
function premiumResource(type: string, logicalId: RegExp): string {
  try { return physicalIdsInClassificationStacks({ type, logicalId })[0] || ''; } catch { return ''; }
}
function invokeCreator(fn: string, payload: Record<string, unknown>): { ok: boolean; channelArn?: string; error?: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inFile = path.join(os.tmpdir(), `watched-in-${stamp}.json`);
  const outFile = path.join(os.tmpdir(), `watched-out-${stamp}.json`);
  fs.writeFileSync(inFile, JSON.stringify(payload));
  awsv(['lambda', 'invoke', '--function-name', fn, '--cli-binary-format', 'raw-in-base64-out', '--payload', `fileb://${inFile}`, outFile]);
  try { return JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { return { ok: false, error: 'no response from the creator' }; }
}
function leadConversationNamed(leadArn: string, name: string): string {
  let next = '';
  for (let page = 0; page < 20; page += 1) {
    const r = awsv(['chime-sdk-messaging', 'list-channel-memberships-for-app-instance-user', '--app-instance-user-arn', leadArn, '--chime-bearer', leadArn, '--max-results', '50', ...(next ? ['--next-token', next] : [])]);
    const hit = ((r?.ChannelMemberships ?? []) as Array<{ ChannelSummary?: { Name?: string; ChannelArn?: string } }>).find((m) => m.ChannelSummary?.Name === name);
    if (hit?.ChannelSummary?.ChannelArn) return hit.ChannelSummary.ChannelArn;
    next = String(r?.NextToken || '');
    if (!next) return '';
  }
  return '';
}
function contextItem(table: string, key: string): Record<string, any> | undefined {
  const r = awsv(['dynamodb', 'get-item', '--table-name', table, '--key', JSON.stringify({ channelArn: { S: key } }), '--consistent-read']);
  return r?.Item ? unmarshalItem(r.Item) : undefined;
}
function deleteContextItem(table: string, key: string): void {
  awsv(['dynamodb', 'delete-item', '--table-name', table, '--key', JSON.stringify({ channelArn: { S: key } })]);
}
const visible = (content: string) => content.replace(/<!--[\s\S]*?-->/g, '').trim();
const updatesIn = (room: string, asArn: string) => messageRowsVisibleTo(room, asArn)
  .filter((m) => m.senderArn.includes('/bot/') && visible(m.content).includes(INCIDENT) && visible(m.content).includes(opsEvent.OPS_INCIDENT_UPDATED));
const putEntries = (entries: unknown[]) => {
  const put = awsv(['events', 'put-events', '--entries', JSON.stringify(entries)]);
  expect(put?.FailedEntryCount ?? 1, `the bus refused the event: ${JSON.stringify(put?.Entries)}`).toBe(0);
};

/**
 * THE VERSION'S OWN COPY OF `incident-updated`, told apart from the platform's by what the room reads: the platform's tells the
 * room once, and this copy tells it twice. A room that reads one update ran the platform's workflow, so the version was not read.
 */
function versionWorkflow(): Record<string, any> {
  const wf = JSON.parse(JSON.stringify(SHIPPED_EVENT_WORKFLOWS[WORKFLOW]));
  wf.states.tell = { ...wf.states.tell, onSuccess: 'again', onFailure: 'done' };
  wf.states.again = { send: { ...wf.states.tell.send }, onSuccess: 'done', onFailure: 'done' };
  return wf;
}
/** How many times one run of the version's workflow tells the room. */
const TOLD_PER_RUN = 2;

test.describe.serial('an event reaches the conversation that watches its key (incident-triage)', () => {
  guardBackendErrors('an-event-reaches-the-conversation-that-watches-its-key');

  let admin: VendedCredentials | undefined;
  /** The assistant that owns an ops room's workflows (ADR-061 decision 2): its version's `incident-updated` runs. */
  let owner = '';
  let previousVersion: number | undefined;
  let previousPolicy: unknown;
  let creator = '';
  let contextTable = '';
  let appInstanceAdmin = '';
  let lead: TestUser | null = null;
  let leadArn = '';
  let teamRoom = '';
  let room = '';
  let ruleId = '';

  test.beforeAll(async () => {
    test.skip(!RUN, 'changes a deployed assistant\'s active version; set INCIDENT_TRIAGE_E2E=1 to run it (validate.mjs --only=incident-triage)');
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL, 'VITE_ADMIN_API_URL is needed to reach the event triggers');
    const adminUser = await getAdminUser();
    test.skip(!adminUser.password, missingUserReason('testAdmin'));
    const opsLead = await getOpsLeadUser();
    test.skip(!opsLead, missingUserReason('opsLeadUser'));
    lead = opsLead;
    creator = premiumResource('AWS::Lambda::Function', /^TypedConversationFromEvent/);
    test.skip(!creator, 'no premium typed-conversation creator on this deployment');
    test.skip(!premiumResource('AWS::Events::Rule', /^OpensTypedConversationops0/), 'the premium stack has no rule for the ops event');
    test.skip(!ssmValue(`${SSM_ROOT}/assistant-assignments/premium/ops/assistants/ops-premium`), 'premium has no ops assistant on this deployment (npm run add-assistant-role)');
    contextTable = ssmValue(`${SSM_ROOT}/shared/tables/channel-context-name`);
    appInstanceAdmin = ssmValue(`${SSM_ROOT}/app-instance-admin-arn`);
    expect(contextTable, 'no channel-context table is published').toBeTruthy();
    leadArn = await personArnOf(opsLead!);
    expect(leadArn).toContain('/user/');
    owner = liveAssistantFor('premium', 'ops');
    const creds = await getTestCredentials();
    const session = await exchange(idTokenFor(adminUser.email, adminUser.password, creds.cognitoClientId), { identity: 'console' });
    expect(session.status, JSON.stringify(session.body).slice(0, 300)).toBe(200);
    admin = session.body.credentials;
  });

  test.afterAll(async () => {
    const tryTo = async (what: string, fn: () => unknown) => {
      try { await fn(); } catch (err) { console.warn(`cleanup: could not ${what}: ${(err as Error).message.slice(0, 200)}`); }
    };
    if (admin && ruleId) await tryTo('detach the trigger', () => signedCall(adminUrl('admin-conversations', `/admin/event-triggers/${WATCHED}/${AT}/${ruleId}/remove`), admin!, 'POST', {}));
    await tryTo('delete the helper rule', () => awsv(['events', 'delete-rule', '--name', HELPER_RULE]));
    if (contextTable) await tryTo('delete the watch item', () => deleteContextItem(contextTable, refWatchKey(AT, KIND, INCIDENT)));
    for (const arn of [room, teamRoom].filter(Boolean)) {
      await tryTo(`delete the room ${arn}`, () => awsv(['chime-sdk-messaging', 'delete-channel', '--channel-arn', arn, '--chime-bearer', appInstanceAdmin || leadArn]));
      if (contextTable) await tryTo(`delete the row of ${arn}`, () => deleteContextItem(contextTable, arn));
    }
    if (admin && previousPolicy !== undefined) await tryTo('return the event policy', () => signedCall(adminUrl('admin-conversations', '/admin/event-policy'), admin!, 'POST', previousPolicy));
    if (admin && previousVersion !== undefined) {
      const back = await signedCall(adminUrl('assistant-admin', '/admin/profiles/rollback'), admin, 'POST', { profileName: owner, version: previousVersion }).catch(() => undefined);
      if (back?.status !== 200) console.warn(`cleanup: ${owner} was not rolled back to version ${previousVersion}`);
    }
  });

  test('the ops assistant activates a version that runs incident-updated in ops rooms, and the policy allows the update event', async () => {
    test.setTimeout(180_000);
    const listing = await signedCall(adminUrl('assistant-admin', '/admin/profiles'), admin!);
    previousVersion = (listing.body?.profiles ?? []).find((p: any) => p.profileName === owner)?.activeVersion ?? undefined;
    expect(previousVersion, `${owner} has no active version to return to`).toBeDefined();
    const created = await replacingDraft((b) => signedCall(adminUrl('assistant-admin', '/admin/profiles/version'), admin!, 'POST', b), { profileName: owner });
    expect(created.status, JSON.stringify(created.body).slice(0, 400)).toBe(200);
    const exported = await signedCall(adminUrl('assistant-admin', '/admin/profiles/export'), admin!, 'POST', { profileName: owner, draft: true });
    const body = (exported.body?.manifest?.body ?? {}) as { eventWorkflows?: Record<string, any> };
    const patch = { eventWorkflows: { ...(body.eventWorkflows ?? {}), [WORKFLOW]: versionWorkflow() } };
    const edited = await signedCall(adminUrl('assistant-admin', '/admin/profiles/draft'), admin!, 'POST', { profileName: owner, patch, configId: draftIdOf(created) });
    expect(edited.status, JSON.stringify(edited.body).slice(0, 400)).toBe(200);
    const activated = await signedCall(adminUrl('assistant-admin', '/admin/profiles/activate'), admin!, 'POST', { profileName: owner, configId: draftIdOf(edited) });
    expect(activated.status, JSON.stringify(activated.body).slice(0, 400)).toBe(200);

    // THE UPDATE EVENT IS ALLOWED, adding it to the deployment's saved policy for this run when it is not.
    const policy = await signedCall(adminUrl('admin-conversations', '/admin/event-policy'), admin!);
    expect(policy.status, JSON.stringify(policy.body).slice(0, 300)).toBe(200);
    const p = policy.body.policy as { allowedEventTypes: Array<{ source: string; detailType: string }> };
    if (!p.allowedEventTypes.some((t) => t.source === opsEvent.OPS_EVENT_SOURCE && t.detailType === opsEvent.OPS_INCIDENT_UPDATED)) {
      previousPolicy = JSON.parse(JSON.stringify(p));
      const saved = await signedCall(adminUrl('admin-conversations', '/admin/event-policy'), admin!, 'POST',
        { ...p, allowedEventTypes: [...p.allowedEventTypes, { source: opsEvent.OPS_EVENT_SOURCE, detailType: opsEvent.OPS_INCIDENT_UPDATED }] });
      expect(saved.status, JSON.stringify(saved.body).slice(0, 300)).toBe(200);
    }
  });

  test('attaching a watch trigger makes one rule per classification, its binding in its tags and the key path in its target', async () => {
    test.setTimeout(120_000);
    // The update event is the platform's own, so no schema names it: the trigger copies a rule's pattern, one of the three choices.
    awsv(['events', 'put-rule', '--name', HELPER_RULE, '--state', 'DISABLED', '--description', 'AgentEchelon e2e: the watched-key spec owns and deletes this rule',
      '--event-pattern', JSON.stringify({ source: [opsEvent.OPS_EVENT_SOURCE], 'detail-type': [opsEvent.OPS_INCIDENT_UPDATED] })]);
    const attached = await signedCall(adminUrl('admin-conversations', `/admin/event-triggers/${WATCHED}/${AT}`), admin!, 'POST',
      { workflow: WORKFLOW, rule: HELPER_RULE, target: 'watched', kind: KIND, keyPath: '$.detail.incidentId' });
    expect(attached.status, JSON.stringify(attached.body).slice(0, 400)).toBe(200);
    ruleId = attached.body.id;
    const ruleName = `${STACK_PREFIX}-${AT}-watch-${ruleId}`;
    expect(String(attached.body.ruleArn)).toContain(`rule/${ruleName}`);
    // A PLATFORM SOURCE'S RULE MATCHES THIS DEPLOYMENT'S INSTANCE, as the ops opener does, so another instance's updates never reach it.
    expect(JSON.parse(awsv(['events', 'describe-rule', '--name', ruleName]).EventPattern)).toMatchObject({ source: [opsEvent.OPS_EVENT_SOURCE], detail: { instance: [INSTANCE] } });
    const tags = Object.fromEntries(((awsv(['events', 'list-tags-for-resource', '--resource-arn', attached.body.ruleArn])?.Tags ?? []) as Array<{ Key: string; Value: string }>).map((t) => [t.Key, t.Value]));
    expect(tags).toMatchObject({ classification: AT, workflow: WORKFLOW, 'conversation-type': 'ops', 'watch-kind': KIND, source: opsEvent.OPS_EVENT_SOURCE, 'detail-type': opsEvent.OPS_INCIDENT_UPDATED });
    const targets = awsv(['events', 'list-targets-by-rule', '--rule', ruleName]).Targets as Array<{ Arn: string; InputTransformer?: { InputPathsMap?: Record<string, string> } }>;
    expect(targets).toHaveLength(1);
    expect(targets[0].Arn).toContain('EventTriggerRelay');
    expect(targets[0].InputTransformer?.InputPathsMap?.key).toBe('$.detail.incidentId');

    // A TEAM ROOM TYPE'S TRIGGER CANNOT TARGET A WATCHED CONVERSATION, and a kind no opener of the type records is refused.
    const wrongType = await signedCall(adminUrl('admin-conversations', `/admin/event-triggers/${TEAM}/${AT}`), admin!, 'POST', { workflow: WORKFLOW, rule: HELPER_RULE, target: 'watched', kind: KIND, keyPath: '$.detail.incidentId' });
    expect(wrongType.status).toBe(400);
    const wrongKind = await signedCall(adminUrl('admin-conversations', `/admin/event-triggers/${WATCHED}/${AT}`), admin!, 'POST', { workflow: WORKFLOW, rule: HELPER_RULE, target: 'watched', kind: 'sales-lead', keyPath: '$.detail.incidentId' });
    expect(wrongKind.status, JSON.stringify(wrongKind.body)).toBe(409);
    const listed = await signedCall(adminUrl('admin-conversations', `/admin/event-triggers/${WATCHED}/${AT}`), admin!);
    expect((listed.body?.triggers ?? []).map((t: any) => ({ id: t.id, kind: t.kind, keyPath: t.keyPath }))).toContainEqual({ id: ruleId, kind: KIND, keyPath: '$.detail.incidentId' });
  });

  test('an ops event naming an incident opens a room that watches it, and a second one for the incident opens no second room', async () => {
    test.setTimeout(300_000);
    await sleep(35_000); // the served version is cached for 30 seconds
    const team = invokeCreator(creator, { conversationType: 'ops-team', forUserArn: leadArn, topicLabel: `Watched incident e2e team ${STAMP}` });
    expect(team.ok, `the standing room was refused: ${team.error}`).toBe(true);
    teamRoom = team.channelArn!;
    putEntries([opsEvent.opsEventEntry({ instance: INSTANCE, forPerson: lead!.email, concernedChannelArn: teamRoom, topicLabel: TOPIC, summary: 'An incident the e2e watches.', incidentId: INCIDENT })]);
    room = await pollFor(() => leadConversationNamed(leadArn, TOPIC), (arn) => Boolean(arn), { timeoutMs: 180_000, intervalMs: 5_000 });
    expect(room, `no conversation named "${TOPIC}" opened; read the TypedConversationFromEvent log`).toBeTruthy();

    const row = contextItem(contextTable, room);
    expect(row?.conversationType).toBe('ops');
    expect(row?.watchedRefs, 'the room\'s row lists the incident\'s key').toEqual([`${KIND}#${INCIDENT}`]);
    const watch = contextItem(contextTable, refWatchKey(AT, KIND, INCIDENT));
    expect({ room: watch?.room, classification: watch?.classification }, 'the key\'s watch item names the room').toEqual({ room, classification: AT });

    putEntries([opsEvent.opsEventEntry({ instance: INSTANCE, forPerson: lead!.email, concernedChannelArn: teamRoom, topicLabel: TOPIC_AGAIN, summary: 'The same incident again.', incidentId: INCIDENT })]);
    await sleep(60_000);
    expect(leadConversationNamed(leadArn, TOPIC_AGAIN), 'a second opening event for a watched incident opened a second room').toBe('');
    expect(contextItem(contextTable, refWatchKey(AT, KIND, INCIDENT))?.room, 'the key stays with the room that holds it').toBe(room);
  });

  test('an update for the incident, naming no room, reaches the room that watches it, once per window', async () => {
    test.setTimeout(300_000);
    putEntries([opsEvent.opsUpdateEntry({ instance: INSTANCE, incidentId: INCIDENT })]);
    const told = await pollFor(() => Promise.resolve(updatesIn(room, leadArn)), (m) => m.length >= TOLD_PER_RUN, { timeoutMs: 120_000, intervalMs: 5_000 });
    expect(told.length, "the update did not run the ops assistant's version of the workflow in the room that watches the incident (one post is the platform's copy); read the router log for [Router][watch-event]").toBe(TOLD_PER_RUN);
    expect(visible(told[0].content)).toBe(`${opsEvent.OPS_INCIDENT_UPDATED} for ${INCIDENT}, from ${opsEvent.OPS_EVENT_SOURCE}.`);
    expect(updatesIn(teamRoom, leadArn), 'the update reached the team room, which does not watch the incident').toHaveLength(0);

    // ONE RUN PER RULE, KEY AND WINDOW: a second update in the same window tells the room nothing more.
    putEntries([opsEvent.opsUpdateEntry({ instance: INSTANCE, incidentId: INCIDENT })]);
    await sleep(45_000);
    expect(updatesIn(room, leadArn), 'a second update in the window ran the workflow again').toHaveLength(TOLD_PER_RUN);
  });
});
