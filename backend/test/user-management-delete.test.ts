/**
 * OFFBOARDING FROM THE CONSOLE: `POST /users/delete` (user-management.ts -> lib/offboarding.ts).
 *
 * Offboarding runs by AppInstanceUser for every issuer (ADR-058). It removes every store the person's
 * records live in, replaces each `Identities` row with a `revoked` marker so the subject is never minted
 * again, deletes this deployment's pool account only when one exists, keeps battle votes and thumbs
 * feedback, and appends exactly one `offboarding` event to the archive. Nothing to remove is 404.
 */
import { userManagementWithOffboardingInProcess } from './helpers/offboarding-in-process';
import {
  APP, ISS, OTHER_ISS, POOL_ID, POOL_ISS, SERVICE_ADMIN, TABLES, budgetRowOf, offboardingWorld,
} from './setup/offboarding-world';
import { revokedMarkerKey, mintOrResolvePerson, PersonNotActive } from '../lambda/src/lib/person-identity';
import { hourKeyAt, userBudgetKey } from '../lambda/src/lib/abuse-control-keys';
import { BUDGET_ROW_HORIZON_HOURS } from '../lambda/src/lib/offboarding';
import { edgeContext } from './helpers/edge-context';
import { registrationKeyOf } from '../lambda/src/lib/upgrade';

const PERSON = '01928a3b-1c2d-7e4f-8a9b-0c1d2e3f4a5b';
const OTHER_PERSON = '01928a3b-1c2d-7e4f-8a9b-0c1d2e3f4a5c';
const SUB = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f';
const HOST_SUB = 'host-subject-1';

function loadHandler(w: ReturnType<typeof offboardingWorld>) {
  jest.resetModules();
  process.env.USER_POOL_ID = POOL_ID;
  process.env.APP_INSTANCE_ARN = APP;
  process.env.ALLOWED_ORIGIN = 'https://admin.example';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../lambda/src/lib/offboarding').__setOffboardingDepsForTests(w.deps);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return userManagementWithOffboardingInProcess<{ handler: any }>().handler as (e: unknown) => Promise<{ statusCode: number; body: string }>;
}

function post(path: string, body: unknown, groups = 'admins') {
  return {
    httpMethod: 'POST',
    path,
    headers: { origin: 'https://admin.example' },
    requestContext: { authorizer: edgeContext({ claims: { 'cognito:groups': groups, sub: 'operator-1', iss: POOL_ISS } }) },
    body: JSON.stringify(body),
  };
}

const bodyOf = (res: { body: string }) => JSON.parse(res.body);

let logs: string[];
beforeEach(() => {
  logs = [];
  const capture = (...args: unknown[]) => { logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  jest.spyOn(console, 'log').mockImplementation(capture);
  jest.spyOn(console, 'warn').mockImplementation(capture);
  jest.spyOn(console, 'error').mockImplementation(capture);
});
afterEach(() => jest.restoreAllMocks());

describe('POST /users/delete', () => {
  it('requires an administrator', async () => {
    const w = offboardingWorld();
    w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
    const res = await loadHandler(w)(post('/users/delete', { personArn: `${APP}/user/${PERSON}` }, 'basic'));
    expect(res.statusCode).toBe(403);
    expect(w.users.has(`${APP}/user/${PERSON}`)).toBe(true);
  });

  it('offboards a pool person by AppInstanceUser: every store, then a marker per row, then the pool account', async () => {
    const w = offboardingWorld();
    w.seedBystander();
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }], { twin: true });
    w.seedAccount(POOL_ID, { subject: SUB, username: 'jane@example.com', email: 'jane@example.com', enabled: true });
    const votesBefore = JSON.stringify([...w.battleVotes.values()]);
    const feedbackBefore = JSON.stringify([...w.feedback.values()]);

    const res = await loadHandler(w)(post('/users/delete', { personArn: arn }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({
      removed: {
        adminTwin: 1, upgradeSources: 0, memberships: 3, userProfile: 1, contactCopies: 0, noticePreferences: 1, userTasks: 2, agentTasks: 0, turnState: 1, channelContext: 0, battleConfig: 0, budgetRows: 1,
        attachments: 1, auroraProjection: 0, connectorGrants: 0, personTokens: 3, identities: 1, appInstanceUser: 1, poolAccount: 1,
      },
      kept: ['battle_votes', 'feedback', 'archive'],
      archived: true,
    });

    // Every store is empty of the person, and the bystander's records are untouched.
    expect(w.users.has(arn)).toBe(false);
    expect(w.users.has(`${APP}/user/${PERSON}-admin`)).toBe(false);
    expect(w.admins.size).toBe(0);
    expect([...w.memberships.values()].every((m) => m.size === 0)).toBe(true);
    expect(w.profiles.has(PERSON)).toBe(false);
    // Their email preferences, their reply token, their claim and the invitation they issued go with them; another
    // kind of token, and a bystander's, stay.
    expect(w.profiles.has(`${PERSON}#notices`)).toBe(false);
    expect([...w.tokens.keys()].sort()).toEqual([`guest-family#${PERSON}`, 'invitation#bystander', 'reply#bystander']);
    expect(w.tasks).toEqual([{ principalId: 'bystander', taskId: 't9' }]);
    expect([...w.turn.keys()]).toEqual([`stop#${APP}/channel/c1#bystander#bot-1`]);
    expect([...w.abuse.keys()]).toEqual([budgetRowOf('bystander')]);
    expect(w.objects).toEqual([{ Key: 'attachments/c1/bystander/b.pdf', VersionId: 'v1' }]);

    // The row is gone, replaced by a marker that holds a hash of the subject and nothing else.
    expect([...w.identities.values()]).toEqual([{ issuerSubject: revokedMarkerKey(ISS, SUB) }]);
    expect(revokedMarkerKey(ISS, SUB)).not.toContain(SUB);

    // The pool account: signed out, then deleted.
    expect(w.cognitoCalls.map((c) => c.command)).toEqual(['AdminUserGlobalSignOutCommand', 'AdminDeleteUserCommand']);
    expect(w.pools.get(POOL_ID)!.size).toBe(0);

    // Votes and thumbs are kept, and offboarding never reached their tables.
    expect(JSON.stringify([...w.battleVotes.values()])).toBe(votesBefore);
    expect(JSON.stringify([...w.feedback.values()])).toBe(feedbackBefore);
    expect([...w.tablesTouched].sort()).toEqual([TABLES.abuseControls, TABLES.identities, TABLES.tokens, TABLES.turnState, TABLES.userProfile, TABLES.userTasks].sort());
  });

  it('follows the upgrade tag (P-12): the visit\'s messages by the person and the visitor go, the registration with them, and nothing else', async () => {
    const w = offboardingWorld();
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
    const visit = `${APP}/channel/guest-visit`;
    const visitor = `${APP}/user/visitor-1`;
    // c1 is the customer conversation a claim opened; c2 is an ordinary one, whose tags name nothing.
    w.channelTags.set(`${APP}/channel/c1`, [
      { Key: 'classification', Value: 'customer' },
      { Key: 'upgradedFrom', Value: visit },
      { Key: 'upgradedFromPerson', Value: visitor },
    ]);
    w.channelMessages.set(visit, [
      { MessageId: 'm1', Sender: { Arn: visitor } },
      { MessageId: 'm2', Sender: { Arn: `${APP}/bot/greeter` } },
      { MessageId: 'm3', Sender: { Arn: visitor } },
      { MessageId: 'm4', Sender: { Arn: `${APP}/user/someone-else` } },
    ]);
    w.channelMessages.set(`${APP}/channel/c2`, [{ MessageId: 'keep', Sender: { Arn: arn } }]);
    w.tokens.set(registrationKeyOf(visit), { pk: registrationKeyOf(visit), kind: 'registration' });
    w.tokens.set('registration#other', { pk: 'registration#other', kind: 'registration' });

    const res = await loadHandler(w)(post('/users/delete', { personArn: arn }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).removed.upgradeSources).toBe(2);
    expect(w.channelMessages.get(visit)!.map((m) => m.MessageId)).toEqual(['m2', 'm4']);
    expect(w.channelMessages.get(`${APP}/channel/c2`)!.map((m) => m.MessageId)).toEqual(['keep']);
    // Another registration stays, and so does a kind offboarding does not delete with the person (a guest's refresh family).
    expect([...w.tokens.keys()].sort()).toEqual([`guest-family#${PERSON}`, 'registration#other']);
  });

  it('follows the upgrade tag of a bind\'s continuation (P-11): the visitor is the person, and the visit\'s messages they sent go', async () => {
    const w = offboardingWorld();
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
    const visit = `${APP}/channel/guest-visit`;
    // c1 is the conversation a bind continued the visit in, at the person's own classification. Under path A
    // the visitor's AppInstanceUser became the account, so both tags name the visit and the person.
    w.channelTags.set(`${APP}/channel/c1`, [
      { Key: 'classification', Value: 'basic' },
      { Key: 'upgradedFrom', Value: visit },
      { Key: 'upgradedFromPerson', Value: arn },
    ]);
    w.channelMessages.set(visit, [
      { MessageId: 'm1', Sender: { Arn: arn } },
      { MessageId: 'm2', Sender: { Arn: `${APP}/bot/greeter` } },
      { MessageId: 'm3', Sender: { Arn: arn } },
    ]);
    w.tokens.set(registrationKeyOf(visit), { pk: registrationKeyOf(visit), kind: 'registration' });

    const res = await loadHandler(w)(post('/users/delete', { personArn: arn }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).removed.upgradeSources).toBe(2);
    expect(w.channelMessages.get(visit)!.map((m) => m.MessageId)).toEqual(['m2']);
    expect(w.tokens.has(registrationKeyOf(visit))).toBe(false);
    expect(w.users.has(arn)).toBe(false);
  });

  it('follows the upgrade tag when the visit was retired once its seed was written (FR26): nothing is left there, and the registration still goes', async () => {
    const w = offboardingWorld();
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
    // The visitor's conversation was deleted after the carry-over, so it has no messages to list: the
    // tag still names it, and erasure still follows it to the registration record.
    const visit = `${APP}/channel/conv-guest-visitor-retired`;
    w.channelTags.set(`${APP}/channel/c1`, [
      { Key: 'classification', Value: 'customer' },
      { Key: 'upgradedFrom', Value: visit },
      { Key: 'upgradedFromPerson', Value: `${APP}/user/visitor-1` },
    ]);
    w.tokens.set(registrationKeyOf(visit), { pk: registrationKeyOf(visit), kind: 'registration' });

    const res = await loadHandler(w)(post('/users/delete', { personArn: arn }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).removed.upgradeSources).toBe(0);
    expect(w.tokens.has(registrationKeyOf(visit))).toBe(false);
    expect(w.users.has(arn)).toBe(false);
  });

  it('records exactly one offboarding event, naming the actor and the subject and counting each store', async () => {
    const w = offboardingWorld();
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
    w.seedAccount(POOL_ID, { subject: SUB, username: 'jane@example.com', email: 'jane@example.com', enabled: true });
    await loadHandler(w)(post('/users/delete', { personArn: arn }));
    expect(w.archived).toHaveLength(1);
    expect(w.archived[0]).toEqual({
      personId: PERSON,
      properties: expect.objectContaining({
        actorArn: `${APP}/user/operator-1`,
        subjectArn: arn,
        kept: 'battle_votes,feedback,archive',
        removed_identities: 1,
        removed_poolAccount: 1,
        removed_userTasks: 2,
      }),
    });
    // No address and no username in the event, or in any line logged on the way.
    expect(JSON.stringify(w.archived)).not.toMatch(/jane|example\.com/);
    expect(logs.join('\n')).not.toMatch(/jane|example\.com/);
  });

  it('offboards a person of another issuer: a marker, and no pool account touched', async () => {
    const w = offboardingWorld();
    const arn = w.seedPerson(OTHER_PERSON, [{ issuer: OTHER_ISS, subject: HOST_SUB }]);
    // The host pool holds an account for the subject; offboarding never deletes another pool's account.
    w.seedAccount('us-east-1_HostPool', { subject: HOST_SUB, username: 'host-user', email: 'h@host.example', enabled: true });
    const res = await loadHandler(w)(post('/users/delete', { personArn: arn }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).removed).toMatchObject({ identities: 1, appInstanceUser: 1, poolAccount: 0 });
    expect([...w.identities.keys()]).toEqual([revokedMarkerKey(OTHER_ISS, HOST_SUB)]);
    expect(w.cognitoCalls).toEqual([]);
    expect(w.pools.get('us-east-1_HostPool')!.size).toBe(1);
  });

  it('writes a marker for every row a person signs in through', async () => {
    const w = offboardingWorld();
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }, { issuer: OTHER_ISS, subject: HOST_SUB, status: 'pending' }]);
    const res = await loadHandler(w)(post('/users/delete', { personArn: arn }));
    expect(bodyOf(res).removed.identities).toBe(2);
    expect([...w.identities.keys()].sort()).toEqual([revokedMarkerKey(ISS, SUB), revokedMarkerKey(OTHER_ISS, HOST_SUB)].sort());
    expect(w.audit.filter((l) => l._auditEvent === 'identity_revoked')).toHaveLength(2);
  });

  it('answers 404 for nobody, and 404 again for a person already offboarded, with no second event', async () => {
    const w = offboardingWorld();
    const handler = loadHandler(w);
    expect((await handler(post('/users/delete', { personArn: `${APP}/user/${OTHER_PERSON}` }))).statusCode).toBe(404);
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
    expect((await handler(post('/users/delete', { personArn: arn }))).statusCode).toBe(200);
    expect((await handler(post('/users/delete', { personArn: arn }))).statusCode).toBe(404);
    expect(w.archived).toHaveLength(1);
  });

  it('refuses a twin, an ARN of another app instance, and a body naming nobody', async () => {
    const w = offboardingWorld();
    const handler = loadHandler(w);
    expect((await handler(post('/users/delete', { personArn: `${APP}/user/${PERSON}-admin` }))).statusCode).toBe(400);
    expect((await handler(post('/users/delete', { personArn: `arn:aws:chime:us-east-1:1:app-instance/other/user/${PERSON}` }))).statusCode).toBe(400);
    expect((await handler(post('/users/delete', {}))).statusCode).toBe(400);
  });

  it('removes a pool account that never signed in, named by username, and answers 404 for an unknown one', async () => {
    const w = offboardingWorld();
    w.seedAccount(POOL_ID, { subject: SUB, username: 'pending@example.com', email: 'pending@example.com', enabled: true });
    const handler = loadHandler(w);
    const res = await handler(post('/users/delete', { username: 'pending@example.com' }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).removed).toMatchObject({ poolAccount: 1, appInstanceUser: 0, identities: 0 });
    expect(w.pools.get(POOL_ID)!.size).toBe(0);
    expect(w.archived).toHaveLength(1);
    expect((await handler(post('/users/delete', { username: 'nobody@example.com' }))).statusCode).toBe(404);
  });

  it('offboards the person a pool username signs in as', async () => {
    const w = offboardingWorld();
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
    w.seedAccount(POOL_ID, { subject: SUB, username: 'jane@example.com', email: 'jane@example.com', enabled: true });
    const res = await loadHandler(w)(post('/users/delete', { username: 'jane@example.com' }));
    expect(res.statusCode).toBe(200);
    expect(w.users.has(arn)).toBe(false);
    expect(w.archived[0].properties.subjectArn).toBe(arn);
  });

  it('stops before the identity is touched when a store cannot be cleared, and a retry completes', async () => {
    const w = offboardingWorld();
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
    const handler = loadHandler(w);
    w.s3.send.mockRejectedValueOnce(Object.assign(new Error('slow down'), { name: 'SlowDown' }));
    const res = await handler(post('/users/delete', { personArn: arn }));
    expect(res.statusCode).toBe(503);
    expect(bodyOf(res)).toMatchObject({ code: 'OFFBOARDING_INCOMPLETE', step: 'attachments' });
    expect(w.users.has(arn)).toBe(true);
    expect(w.identities.has(`${ISS}|${SUB}`)).toBe(true);
    expect(w.archived).toHaveLength(0);

    expect((await handler(post('/users/delete', { personArn: arn }))).statusCode).toBe(200);
    expect(w.users.has(arn)).toBe(false);
    expect(w.archived).toHaveLength(1);
  });

  it("removes a person's budget rows by key, for every hour a row can still be present, and never scans that table", async () => {
    const w = offboardingWorld();
    w.seedBystander();
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
    // A row six days old has expired but may not have been swept yet; it is still the person's.
    const oldRow = userBudgetKey(PERSON, hourKeyAt(new Date(Date.now() - 6 * 24 * 3_600_000)));
    w.abuse.set(oldRow, { pk: oldRow });
    expect((await loadHandler(w)(post('/users/delete', { personArn: arn }))).statusCode).toBe(200);
    expect([...w.abuse.keys()]).toEqual([budgetRowOf('bystander')]);
    const onAbuse = w.doc.send.mock.calls.map(([c]) => c as { constructor: { name: string }; input: { TableName?: string } })
      .filter((c) => c.input.TableName === TABLES.abuseControls);
    expect(onAbuse.some((c) => c.constructor.name === 'ScanCommand')).toBe(false);
    expect(onAbuse).toHaveLength(BUDGET_ROW_HORIZON_HOURS + 1);
  });

  it("removes the person's attachments in every conversation, and leaves everyone else's", async () => {
    const w = offboardingWorld();
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
    for (let c = 2; c <= 30; c++) {
      w.objects.push({ Key: `attachments/c${c}/${PERSON}/f.txt`, VersionId: 'v1' }, { Key: `attachments/c${c}/other/f.txt`, VersionId: 'v1' });
    }
    const res = await loadHandler(w)(post('/users/delete', { personArn: arn }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).removed.attachments).toBe(30);
    expect(w.objects.every((o) => !o.Key.includes(`/${PERSON}/`))).toBe(true);
    expect(w.objects).toHaveLength(29);
  });

  it('completes the erasure when the event cannot be archived, and says so as a security event', async () => {
    const w = offboardingWorld();
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
    (w.deps.archive as jest.Mock).mockRejectedValue(new Error('firehose down'));
    const res = await loadHandler(w)(post('/users/delete', { personArn: arn }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).archived).toBe(false);
    expect(w.users.has(arn)).toBe(false);
    expect(logs.some((l) => l.includes('[Offboarding][SecurityEvent]'))).toBe(true);
  });
});

describe('an offboarded person is never minted again', () => {
  it('refuses their next sign-in and creates no AppInstanceUser; re-admission lifts the refusal', async () => {
    const w = offboardingWorld();
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
    const handler = loadHandler(w);
    await handler(post('/users/delete', { personArn: arn }));

    const createdBefore = w.chime.send.mock.calls.length;
    await expect(mintOrResolvePerson({ issuer: ISS, subject: SUB }, { doc: w.deps.doc, chime: w.deps.chime, table: TABLES.identities, appInstanceArn: APP }))
      .rejects.toBeInstanceOf(PersonNotActive);
    expect(w.chime.send.mock.calls.length).toBe(createdBefore);
    expect(w.users.size).toBe(0);

    const readmit = await handler(post('/users/readmit', { issuer: ISS, subject: SUB }));
    expect(readmit.statusCode).toBe(200);
    expect(w.identities.size).toBe(0);
    expect(w.audit.some((l) => l._auditEvent === 'identity_readmitted')).toBe(true);
    expect((await handler(post('/users/readmit', { issuer: ISS, subject: SUB }))).statusCode).toBe(404);
  });
});

it('bears the service admin for every membership removal', async () => {
  const w = offboardingWorld();
  const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
  await loadHandler(w)(post('/users/delete', { personArn: arn }));
  // A channel's tags are read with no bearer (tagging takes none); every call that takes one bears the service admin.
  const removals = w.messaging.send.mock.calls.map((c: unknown[]) => c[0] as { constructor: { name: string }; input: { ChimeBearer: string } })
    .filter((c) => c.constructor.name !== 'ListTagsForResourceCommand').map((c) => c.input);
  expect(removals.length).toBeGreaterThan(0);
  expect(removals.every((i: { ChimeBearer: string }) => i.ChimeBearer === SERVICE_ADMIN)).toBe(true);
});

describe('POST /users/provision (P-13)', () => {
  function loadWithProvisioner(w: ReturnType<typeof offboardingWorld>, answer: Record<string, unknown> | null, functionName = 'provisioner') {
    if (functionName) process.env.PROVISION_FUNCTION_NAME = functionName;
    else delete process.env.PROVISION_FUNCTION_NAME;
    const handler = loadHandler(w);
    const asked: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../lambda/src/user-management').__setProvisionerForTests(async (req: Record<string, unknown>) => { asked.push(req); return answer ?? {}; });
    return { handler, asked };
  }
  afterEach(() => { delete process.env.PROVISION_FUNCTION_NAME; });

  it('relays an administrator\'s pre-assignment to the admin provisioner, naming the administrator', async () => {
    const w = offboardingWorld();
    const { handler, asked } = loadWithProvisioner(w, { ok: true, state: 'provisioned', personArn: `${APP}/user/${PERSON}` });
    const res = await handler(post('/users/provision', { issuer: 'salesforce-org', subject: '00D:005', personArn: `${APP}/user/${PERSON}` }));
    expect(res.statusCode).toBe(201);
    expect(asked).toEqual([{ op: 'provisionSubject', issuer: 'salesforce-org', subject: '00D:005', appInstanceUserArn: `${APP}/user/${PERSON}`, actor: expect.stringContaining(`${APP}/user/`) }]);
  });

  it('requires an administrator, and says when no provisioned-only issuer is declared', async () => {
    const w = offboardingWorld();
    const { handler, asked } = loadWithProvisioner(w, { ok: true, state: 'provisioned' });
    expect((await handler(post('/users/provision', { issuer: 'salesforce-org', subject: '00D:005' }, 'basic'))).statusCode).toBe(403);
    expect(asked).toEqual([]);
    const none = loadWithProvisioner(offboardingWorld(), null, '');
    const res = await none.handler(post('/users/provision', { issuer: 'salesforce-org', subject: '00D:005' }));
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res).code).toBe('NO_PROVISIONED_ISSUER');
  });

  it('answers the provisioner\'s refusal with its code, and an existing row as a conflict', async () => {
    const refused = loadWithProvisioner(offboardingWorld(), { ok: false, code: 'ISSUER_NOT_PROVISIONABLE', error: 'no' });
    const r = await refused.handler(post('/users/provision', { issuer: 'deployment', subject: 'x' }));
    expect([r.statusCode, bodyOf(r).code]).toEqual([400, 'ISSUER_NOT_PROVISIONABLE']);
    const exists = loadWithProvisioner(offboardingWorld(), { ok: true, state: 'exists', status: 'active' });
    expect((await exists.handler(post('/users/provision', { issuer: 'salesforce-org', subject: '00D:005' }))).statusCode).toBe(409);
  });
});
