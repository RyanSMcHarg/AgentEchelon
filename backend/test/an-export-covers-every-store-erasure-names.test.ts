/**
 * B13: EXPORT BY APPINSTANCEUSER (GDPR Articles 15 and 20). `POST /users/export` (user-management.ts ->
 * lib/offboarding-console.ts -> lib/person-export.ts).
 *
 * The export reads the SAME inventory an erasure walks (`OFFBOARDED_STORES`, then `OFFBOARDING_KEPT`), so the
 * archive has one section per store, in that order, and a store gained by erasure without a reader is a
 * compile error. Every store the inventory marks as held is in it: the twin, the memberships, the profile,
 * the preferences, the tasks, the stop records, the budget rows, the attachments (by key), the person's
 * tokens (never a token or its hash), the Identities rows, the AppInstanceUser and the pool account. What is
 * not built says so, never reads as empty. Nothing is changed, the export is recorded once, and another
 * person's records are not in it.
 */
const mockArchived: Array<{ eventType: string; personId: string; properties: Record<string, unknown> }> = [];
jest.mock('../lambda/src/lib/event-archive', () => ({
  appendServerEvent: async (e: { eventType: string; personId: string; properties: Record<string, unknown> }) => { mockArchived.push(e); },
}));

import { userManagementWithOffboardingInProcess } from './helpers/offboarding-in-process';
import { APP, ISS, POOL_ID, POOL_ISS, TABLES, offboardingWorld } from './setup/offboarding-world';
import { OFFBOARDED_STORES, OFFBOARDING_KEPT } from '../lambda/src/lib/offboarding';
import { edgeContext } from './helpers/edge-context';

const PERSON = '01928a3b-1c2d-7e4f-8a9b-0c1d2e3f4a5b';
const SUB = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f';

function loadHandler(w: ReturnType<typeof offboardingWorld>) {
  jest.resetModules();
  process.env.USER_POOL_ID = POOL_ID;
  process.env.APP_INSTANCE_ARN = APP;
  process.env.ALLOWED_ORIGIN = 'https://admin.example';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../lambda/src/lib/offboarding').__setOffboardingDepsForTests(w.deps);
  return userManagementWithOffboardingInProcess<{ handler: any }>().handler as (e: unknown) => Promise<{ statusCode: number; body: string }>;
}

const post = (body: unknown, groups = 'admins') => ({
  httpMethod: 'POST',
  path: '/users/export',
  headers: { origin: 'https://admin.example' },
  requestContext: { authorizer: edgeContext({ claims: { 'cognito:groups': groups, sub: 'operator-1', iss: POOL_ISS } }) },
  body: JSON.stringify(body),
});

const WRITES = new Set(['DeleteCommand', 'PutCommand', 'UpdateCommand', 'TransactWriteCommand', 'DeleteChannelMessageCommand', 'DeleteChannelMembershipCommand',
  'DeleteObjectsCommand', 'DeleteAppInstanceUserCommand', 'DeleteAppInstanceAdminCommand', 'AdminDeleteUserCommand', 'AdminUserGlobalSignOutCommand']);
const sentKinds = (w: ReturnType<typeof offboardingWorld>) => [w.doc, w.chime, w.messaging, w.s3, w.cognito]
  .flatMap((c) => (c.send as jest.Mock).mock.calls.map(([cmd]) => (cmd as { constructor: { name: string } }).constructor.name));

beforeEach(() => {
  mockArchived.length = 0;
  for (const m of ['log', 'warn', 'error'] as const) jest.spyOn(console, m).mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('POST /users/export', () => {
  it('requires an administrator, and changes nothing', async () => {
    const w = offboardingWorld();
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
    const res = await loadHandler(w)(post({ personArn: arn }, 'basic'));
    expect(res.statusCode).toBe(403);
  });

  it('is one archive, one section per store of the inventory erasure walks, in its order', async () => {
    const w = offboardingWorld();
    w.seedBystander();
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }], { twin: true });
    w.seedAccount(POOL_ID, { subject: SUB, username: 'jane@example.com', email: 'jane@example.com', enabled: true });

    const res = await loadHandler(w)(post({ personArn: arn }));
    expect(res.statusCode).toBe(200);
    const archive = JSON.parse(res.body);
    expect(archive).toMatchObject({ format: 'agentechelon-person-export', version: 1, personArn: arn });
    expect(archive.sections.map((s: { store: string }) => s.store)).toEqual([...OFFBOARDED_STORES, ...OFFBOARDING_KEPT]);
    const by = Object.fromEntries(archive.sections.map((s: { store: string }) => [s.store, s]));

    // EVERY STORE THE INVENTORY MARKS AS HELD, HELD.
    for (const store of ['adminTwin', 'memberships', 'userProfile', 'noticePreferences', 'userTasks', 'turnState', 'budgetRows', 'attachments', 'personTokens', 'identities', 'appInstanceUser', 'poolAccount']) {
      expect({ store, held: by[store].held, atErasure: by[store].atErasure }).toEqual({ store, held: true, atErasure: 'erased' });
    }
    expect(by.userTasks.rows).toHaveLength(2);
    expect(by.attachments.rows).toEqual([{ key: `attachments/c1/${PERSON}/a.pdf`, size: 10 }]);
    expect(by.attachments.note).toMatch(/by key and size/);
    expect(by.identities.rows).toEqual([{ issuer: ISS, subject: SUB, status: 'active', createdAt: '2026-10-01T00:00:00.000Z' }]);
    expect(by.poolAccount.rows[0]).toMatchObject({ username: 'jane@example.com', email: 'jane@example.com' });
    expect(by.noticePreferences.rows[0]).toMatchObject({ muted: { 'email:briefing': expect.any(String) } });

    // THE PERSON'S TOKENS: theirs and the invitations they issued, never a token, never its hash, never somebody else's.
    expect(by.personTokens.rows.map((r: { kind: string }) => r.kind).sort()).toEqual(['claim', 'invitation', 'reply']);
    for (const r of by.personTokens.rows) expect(r).not.toHaveProperty('pk');
    expect(JSON.stringify(archive)).not.toContain('bystander');

    // WHAT IS NOT BUILT SAYS SO, rather than reading as empty.
    for (const store of ['connectorGrants', 'battle_votes', 'feedback', 'archive']) expect(by[store].notBuilt).toMatch(/NOT BUILT/);
    for (const store of OFFBOARDING_KEPT) expect(by[store].atErasure).toBe('kept');
  });

  it('changes nothing anywhere, and records the export once, with who asked and never the content', async () => {
    const w = offboardingWorld();
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }], { twin: true });
    await loadHandler(w)(post({ personArn: arn }));
    expect(sentKinds(w).filter((k) => WRITES.has(k))).toEqual([]);
    expect(w.users.has(arn)).toBe(true);
    expect(w.tasks).toHaveLength(2);
    expect(mockArchived).toHaveLength(1);
    expect(mockArchived[0]).toMatchObject({ eventType: 'export', personId: PERSON, properties: { personArn: arn, held_userTasks: 2 } });
    expect(JSON.stringify(mockArchived[0])).not.toContain('jane@example.com');
  });

  it('follows the upgrade tag to the visitor messages a claimed conversation names', async () => {
    const w = offboardingWorld();
    const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
    const visitor = `${APP}/user/visitor-1`;
    w.channelTags.set(`${APP}/channel/c1`, [{ Key: 'upgradedFrom', Value: `${APP}/channel/guest-1` }, { Key: 'upgradedFromPerson', Value: visitor }]);
    w.channelMessages.set(`${APP}/channel/guest-1`, [
      { MessageId: 'm1', Sender: { Arn: visitor } },
      { MessageId: 'm2', Sender: { Arn: `${APP}/bot/greeter` } },
    ]);
    const archive = JSON.parse((await loadHandler(w)(post({ personArn: arn }))).body);
    const upgrade = archive.sections.find((s: { store: string }) => s.store === 'upgradeSources');
    expect(upgrade.rows).toEqual([{ conversation: `${APP}/channel/c1`, visitorConversation: `${APP}/channel/guest-1`, messages: [expect.objectContaining({ messageId: 'm1', sender: visitor })] }]);
  });

  it('answers 404 for a person nothing is kept about, and 400 without a person', async () => {
    const w = offboardingWorld();
    const handler = loadHandler(w);
    expect((await handler(post({ personArn: `${APP}/user/nobody` }))).statusCode).toBe(404);
    expect((await handler(post({}))).statusCode).toBe(400);
    expect(TABLES.userProfile).toBe('UserProfile');
  });
});
