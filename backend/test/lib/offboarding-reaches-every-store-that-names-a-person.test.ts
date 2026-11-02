/**
 * OFFBOARDING REACHES EVERY STORE THAT NAMES A PERSON (SPEC-CREDENTIAL-EXCHANGE §5b).
 *
 * Beyond the profile, the user-task partition and the stop records, a person is named by: the task records
 * (`AgentTasksTable`, as the requester, owner or assignee), the user-task rows they own in an assistant's
 * partition, a conversation's member identity lookup and onboarding intake (`ChannelContextTable`), the battle
 * setting they enabled (`ChannelBattleConfigTable.enabledBy`) and, in Aurora mode, their own rows in the
 * projection. Each is erased, and a bystander's records in the same stores are left alone.
 */
import { APP, ISS, POOL_ID, POOL_ISS, TABLES, offboardingWorld } from '../setup/offboarding-world';
import { offboardPerson, OFFBOARDED_STORES } from '../../lambda/src/lib/offboarding';
import { exportPerson } from '../../lambda/src/lib/person-export';
import { __resetTrustedIssuersForTests } from '../../lambda/src/lib/trusted-issuers';

jest.mock('../../lambda/src/lib/event-archive', () => ({
  ...jest.requireActual('../../lambda/src/lib/event-archive'),
  appendServerEvent: jest.fn(async () => undefined),
}));

const PERSON = 'person-1';
const SUB = 'sub-of-person-1';
const ARN = `${APP}/user/${PERSON}`;
const C1 = `${APP}/channel/c1`;
const C2 = `${APP}/channel/c2`;
const C3 = `${APP}/channel/c3`;

function world() {
  const w = offboardingWorld();
  const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
  w.deps.stores = async () => ({
    userProfile: TABLES.userProfile,
    userTasks: TABLES.userTasks,
    agentTasks: TABLES.agentTasks,
    turnState: TABLES.turnState,
    channelContext: TABLES.channelContext,
    battleConfig: TABLES.battleConfig,
    abuseControls: TABLES.abuseControls,
    attachmentsBucket: TABLES.bucket,
    tokens: TABLES.tokens,
  });
  // THE TASK RECORDS: asked by the person, owned by them, assigned to them, and one of a bystander's.
  w.agentTasks.set(`t1|${C1}`, { taskId: 't1', channelArn: C1, userArn: arn, userMessage: 'the person\'s words' });
  w.agentTasks.set(`t2|${C1}`, { taskId: 't2', channelArn: C1, userArn: `${APP}/user/bystander`, ownerId: PERSON, ownerType: 'user' });
  w.agentTasks.set(`t3|${C2}`, { taskId: 't3', channelArn: C2, userArn: `${APP}/user/bystander`, assigneePersonId: PERSON });
  w.agentTasks.set(`t4|${C2}`, { taskId: 't4', channelArn: C2, userArn: `${APP}/user/bystander`, assigneeId: 'bot-1', assigneeType: 'assistant', ownerPersonId: 'bystander' });
  // A mirror row in an assistant's partition, owned by the person.
  w.tasks.push({ principalId: 'bot-1', taskId: 't1', ownerPersonId: PERSON }, { principalId: 'bot-1', taskId: 't4', ownerPersonId: 'bystander' });
  // THE CONTEXT ROWS: the person named by registry id and by the pool's `iss`, a bystander, and their intake.
  w.channelContexts.set(C1, {
    channelArn: C1,
    memberIdentities: [{ sub: SUB, iss: ISS, role: 'buyer' }, { sub: 'bystander-sub', iss: ISS, role: 'seller' }],
    domainContext: 'kept',
  });
  w.channelContexts.set(C2, { channelArn: C2, memberIdentities: [{ sub: SUB, iss: POOL_ISS }], onboardingIntake: { subject: PERSON, cursor: 1 } });
  w.channelContexts.set(C3, { channelArn: C3, onboardingIntake: { subject: 'bystander', cursor: 0 } });
  // THE BATTLE SETTINGS: one the person enabled, one a bystander did.
  w.battleConfigs.set(C1, { channelArn: C1, enabled: true, enabledBy: arn, enabledAt: '2026-10-01T00:00:00.000Z' });
  w.battleConfigs.set(C2, { channelArn: C2, enabled: true, enabledBy: `${APP}/user/bystander` });
  return { w, arn };
}

beforeEach(() => {
  process.env.USER_POOL_ID = POOL_ID;
  delete process.env.TRUSTED_ISSUERS;
  __resetTrustedIssuersForTests();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('the stores a person is named in beyond their own partition', () => {
  it('names each one in the inventory, before the identity is touched', () => {
    for (const s of ['agentTasks', 'channelContext', 'battleConfig', 'auroraProjection'] as const) {
      expect(OFFBOARDED_STORES.indexOf(s)).toBeGreaterThan(-1);
      expect(OFFBOARDED_STORES.indexOf(s)).toBeLessThan(OFFBOARDED_STORES.indexOf('identities'));
    }
  });

  it('erases the task records naming the person, and the mirror rows they own in an assistant\'s partition', async () => {
    const { w, arn } = world();
    const res = await offboardPerson(arn, { arn: 'sweep' }, w.deps);
    expect(res.removed.agentTasks).toBe(3);
    expect([...w.agentTasks.keys()]).toEqual([`t4|${C2}`]);
    expect(w.tasks.filter((t) => t.principalId === 'bot-1').map((t) => t.taskId)).toEqual(['t4']);
    expect(w.tasks.some((t) => t.principalId === PERSON)).toBe(false);
  });

  it('removes the person from each conversation\'s member identity lookup and their onboarding intake, nothing else', async () => {
    const { w, arn } = world();
    const res = await offboardPerson(arn, { arn: 'sweep' }, w.deps);
    expect(res.removed.channelContext).toBe(3);
    expect(w.channelContexts.get(C1)).toEqual({ channelArn: C1, memberIdentities: [{ sub: 'bystander-sub', iss: ISS, role: 'seller' }], domainContext: 'kept' });
    expect(w.channelContexts.get(C2)).toEqual({ channelArn: C2, memberIdentities: [] });
    expect(w.channelContexts.get(C3)!.onboardingIntake).toEqual({ subject: 'bystander', cursor: 0 });
  });

  it('reads a context row again when a host changed it meanwhile', async () => {
    const { w, arn } = world();
    const send = w.doc.send.getMockImplementation()!;
    let raced = false;
    w.doc.send.mockImplementation(async (cmd: any) => {
      if (!raced && cmd.constructor.name === 'UpdateCommand' && cmd.input.TableName === TABLES.channelContext && cmd.input.Key.channelArn === C1) {
        raced = true;
        w.channelContexts.get(C1)!.memberIdentities.push({ sub: 'late-sub', iss: ISS });
      }
      return send(cmd);
    });
    await offboardPerson(arn, { arn: 'sweep' }, w.deps);
    expect(w.channelContexts.get(C1)!.memberIdentities.map((e: { sub: string }) => e.sub)).toEqual(['bystander-sub', 'late-sub']);
  });

  it('removes the person\'s name from the battle setting they enabled, and keeps the setting', async () => {
    const { w, arn } = world();
    const res = await offboardPerson(arn, { arn: 'sweep' }, w.deps);
    expect(res.removed.battleConfig).toBe(1);
    expect(w.battleConfigs.get(C1)).toEqual({ channelArn: C1, enabled: true, enabledAt: '2026-10-01T00:00:00.000Z' });
    expect(w.battleConfigs.get(C2)!.enabledBy).toBe(`${APP}/user/bystander`);
  });

  it('erases the person\'s own projection rows in Aurora mode, by their id, and counts them', async () => {
    const { w, arn } = world();
    const projection = jest.fn(async () => 4);
    w.deps.auroraProjection = projection;
    const res = await offboardPerson(arn, { arn: 'sweep' }, w.deps);
    expect(projection).toHaveBeenCalledWith(PERSON);
    expect(res.removed.auroraProjection).toBe(4);
    expect(w.archived[0].properties).toMatchObject({ removed_auroraProjection: 4, removed_agentTasks: 3, removed_channelContext: 3, removed_battleConfig: 1 });
  });

  it('a deployment with no projection (Athena mode) removes nothing there and completes', async () => {
    const { w, arn } = world();
    w.deps.auroraProjection = async () => null;
    const res = await offboardPerson(arn, { arn: 'sweep' }, w.deps);
    expect(res.found).toBe(true);
    expect(res.removed.auroraProjection).toBe(0);
  });

  it('a failed projection erasure stops the run before the identity is touched', async () => {
    const { w, arn } = world();
    w.deps.auroraProjection = async () => { throw new Error('data plane down'); };
    await expect(offboardPerson(arn, { arn: 'sweep' }, w.deps)).rejects.toMatchObject({ code: 'OFFBOARDING_INCOMPLETE', step: 'auroraProjection' });
    expect(w.identities.has(`${ISS}|${SUB}`)).toBe(true);
    expect(w.users.has(arn)).toBe(true);
  });

  it('the export reads the same rows the erasure removes', async () => {
    const { w, arn } = world();
    const { archive } = await exportPerson(arn, { arn: `${APP}/user/admin` }, w.deps);
    const of = (store: string) => archive.sections.find((s) => s.store === store)!;
    expect(of('agentTasks').rows.map((r: any) => r.taskId).sort()).toEqual(['t1', 't2', 't3']);
    expect(of('userTasks').rows.map((r: any) => `${r.principalId}/${r.taskId}`).sort()).toEqual(['bot-1/t1', `${PERSON}/t1`, `${PERSON}/t2`]);
    expect(of('channelContext').rows).toEqual([
      { channelArn: C1, memberIdentities: [{ sub: SUB, iss: ISS, role: 'buyer' }] },
      { channelArn: C2, memberIdentities: [{ sub: SUB, iss: POOL_ISS }], onboardingIntake: { subject: PERSON, cursor: 1 } },
    ]);
    expect(of('battleConfig').rows.map((r: any) => [r.channelArn, r.enabledBy])).toEqual([[C1, arn]]);
    // Nothing was removed by reading.
    expect(w.agentTasks.size).toBe(4);
  });
});
