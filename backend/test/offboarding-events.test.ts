/**
 * OFFBOARDING BY EVENT (offboarding-events.ts): a pool account deleted erases the person it signs in as,
 * from the CloudTrail record EventBridge delivers. A disable or an enable is not an event here: the
 * credential exchange asks the pool at every vend (SPEC-CREDENTIAL-EXCHANGE §4b), so nothing is recorded
 * and the row is left as it is.
 *
 * The handler acts on what the pool says NOW, so a replayed or out-of-order event converges; a pool this
 * deployment does not trust is ignored; and the daily sweep converges every subject as the backstop.
 */
import { APP, ISS, OTHER_ISS, OTHER_POOL_ID, POOL_ID, TABLES, offboardingWorld } from './setup/offboarding-world';
import { handleLifecycleEvent } from '../lambda/src/offboarding-events';
import { revokedMarkerKey, clearPersonCache } from '../lambda/src/lib/person-identity';
import { createDirectory } from '../lambda/src/lib/membership-source';
import { clearanceSourceFor, cognitoAdapter } from '../lambda/src/lib/issuer-seams';
import { poolIssuer } from './helpers/directory';

// The real reverse lookup, over the world's table, for the directory over the world's pool.
const { subjectsOfPerson } = jest.requireActual('../lambda/src/lib/person-identity');
const realResolve = jest.requireActual('../lambda/src/lib/person-identity').resolvePerson;

const PERSON = '01928a3b-1c2d-7e4f-8a9b-0c1d2e3f4a5b';
const SUB = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f';

const cloudTrail = (eventName: string, userPoolId: string, extra: Record<string, unknown> = {}) => ({
  source: 'aws.cognito-idp',
  'detail-type': 'AWS API Call via CloudTrail',
  detail: { eventName, requestParameters: { userPoolId, username: 'HIDDEN_DUE_TO_SECURITY_REASONS' }, additionalEventData: { sub: SUB }, ...extra },
});

function seeded() {
  const w = offboardingWorld();
  const arn = w.seedPerson(PERSON, [{ issuer: ISS, subject: SUB }]);
  w.seedAccount(POOL_ID, { subject: SUB, username: 'jane@example.com', email: 'jane@example.com', enabled: true });
  const account = w.pools.get(POOL_ID)!.get(SUB)!;
  const row = () => w.identities.get(`${ISS}|${SUB}`);
  const identityDeps = { doc: w.deps.doc, chime: w.deps.chime, table: TABLES.identities, appInstanceArn: APP };
  return { w, arn, account, row, identityDeps };
}

beforeEach(() => {
  clearPersonCache();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('a disable and an enable are not offboarding events', () => {
  it('ignores a disable: the row stays active, nothing is audited, and the pool is asked instead', async () => {
    const { w, arn, account, row, identityDeps } = seeded();
    account.enabled = false;
    expect(await handleLifecycleEvent(cloudTrail('AdminDisableUser', POOL_ID), w.deps)).toMatchObject({ action: 'ignored' });
    expect(row()!.status).toBe('active');
    expect(w.users.has(arn)).toBe(true);
    expect(w.audit).toEqual([]);
    expect(w.doc.send).not.toHaveBeenCalled();
    // The subject still resolves: the access decision is the exchange's live read of the pool.
    expect(await realResolve(ISS, SUB, identityDeps)).toBe(arn);

    const directory = createDirectory({
      appInstanceArn: APP,
      issuers: [poolIssuer(ISS, POOL_ID)],
      seams: (issuer) => {
        const directory = cognitoAdapter(ISS, w.primary, { name: 'none', groupsFor: async () => [] });
        return { issuer, directory, clearance: clearanceSourceFor(issuer, directory) };
      },
      identities: { resolve: async () => null, subjectsOf: (p: string) => subjectsOfPerson(p, { doc: w.deps.doc, table: TABLES.identities }) },
    });
    // The pool answers for the account, and a disabled one is reached by nothing.
    expect(await directory.accountState(ISS, SUB)).toBe('disabled');
    expect(await directory.contactFor(arn, 'email')).toBeNull();
    account.enabled = true;
    expect(await directory.accountState(ISS, SUB)).toBe('active');
    expect(await directory.contactFor(arn, 'email')).toMatchObject({ route: 'email', address: 'jane@example.com' });
  });

  it('ignores an enable, and changes nothing', async () => {
    const { w, row } = seeded();
    expect(await handleLifecycleEvent(cloudTrail('AdminEnableUser', POOL_ID), w.deps)).toMatchObject({ action: 'ignored' });
    expect(row()!.status).toBe('active');
    expect(w.audit).toEqual([]);
  });
});

describe('a delete erases', () => {
  it('offboards the person the deleted account signed in as, once', async () => {
    const { w, arn } = seeded();
    w.pools.get(POOL_ID)!.delete(SUB);
    expect(await handleLifecycleEvent(cloudTrail('AdminDeleteUser', POOL_ID), w.deps)).toEqual({ action: 'converged', result: 'erased' });
    expect(w.users.has(arn)).toBe(false);
    expect([...w.identities.keys()]).toEqual([revokedMarkerKey(ISS, SUB)]);
    expect(w.archived).toHaveLength(1);
    expect(w.archived[0].properties).toMatchObject({ actorArn: 'issuer-event', subjectArn: arn, removed_poolAccount: 0 });

    // Replayed: nothing left to do, and no second event.
    expect(await handleLifecycleEvent(cloudTrail('AdminDeleteUser', POOL_ID), w.deps)).toEqual({ action: 'converged', result: 'unchanged' });
    expect(w.archived).toHaveLength(1);
  });

  it('erases nothing for a delete whose account the pool still holds, disabled or not', async () => {
    const { w, arn, account, row } = seeded();
    // A delete record for an account the pool answers for now: the pool's state wins over the event's name.
    account.enabled = false;
    expect(await handleLifecycleEvent(cloudTrail('AdminDeleteUser', POOL_ID), w.deps)).toEqual({ action: 'converged', result: 'unchanged' });
    expect(w.users.has(arn)).toBe(true);
    expect(row()!.status).toBe('active');
    expect(w.archived).toHaveLength(0);
  });

  it('never revives an erased subject, whatever arrives after', async () => {
    const { w } = seeded();
    w.pools.get(POOL_ID)!.delete(SUB);
    await handleLifecycleEvent(cloudTrail('AdminDeleteUser', POOL_ID), w.deps);
    expect(await handleLifecycleEvent(cloudTrail('AdminEnableUser', POOL_ID), w.deps)).toMatchObject({ action: 'ignored' });
    expect(await handleLifecycleEvent(cloudTrail('DeleteUser', POOL_ID), w.deps)).toEqual({ action: 'converged', result: 'unchanged' });
    expect([...w.identities.keys()]).toEqual([revokedMarkerKey(ISS, SUB)]);
  });

  it('erases a person of the federated host pool, and deletes no account there', async () => {
    const w = offboardingWorld();
    const arn = w.seedPerson(PERSON, [{ issuer: OTHER_ISS, subject: SUB }]);
    expect(await handleLifecycleEvent(cloudTrail('AdminDeleteUser', OTHER_POOL_ID), w.deps)).toEqual({ action: 'converged', result: 'erased' });
    expect(w.users.has(arn)).toBe(false);
    expect(w.cognitoCalls).toEqual([]);
  });
});

describe('what the handler ignores', () => {
  it('ignores a pool this deployment does not trust, and makes no call', async () => {
    const { w } = seeded();
    expect(await handleLifecycleEvent(cloudTrail('AdminDeleteUser', 'us-east-1_Stranger'), w.deps)).toMatchObject({ action: 'ignored' });
    expect(w.doc.send).not.toHaveBeenCalled();
    expect(w.chime.send).not.toHaveBeenCalled();
  });

  it('ignores a call that is not a lifecycle change', async () => {
    const { w } = seeded();
    expect(await handleLifecycleEvent(cloudTrail('AdminAddUserToGroup', POOL_ID), w.deps)).toMatchObject({ action: 'ignored' });
  });

  it('sweeps the one pool when the record names no subject it can read', async () => {
    const { w, arn } = seeded();
    w.pools.get(POOL_ID)!.delete(SUB);
    const out = await handleLifecycleEvent(cloudTrail('AdminDeleteUser', POOL_ID, { additionalEventData: null }), w.deps);
    expect(out).toMatchObject({ action: 'swept', pools: 1, result: expect.objectContaining({ erased: 1 }) });
    expect(w.users.has(arn)).toBe(false);
  });
});

describe('the sweep, the backstop for a dropped event', () => {
  it('converges every pool: erases, leaves a disabled account as it is, and removes an account whose offboarding did not finish', async () => {
    const w = offboardingWorld();
    const gone = w.seedPerson('01928a3b-0000-7000-8000-000000000001', [{ issuer: ISS, subject: 'sub-gone' }]);
    const disabled = w.seedPerson('01928a3b-0000-7000-8000-000000000002', [{ issuer: ISS, subject: 'sub-disabled' }], { records: false });
    w.seedAccount(POOL_ID, { subject: 'sub-disabled', username: 'd', email: 'd@x', enabled: false });
    w.seedPerson('01928a3b-0000-7000-8000-000000000003', [{ issuer: ISS, subject: 'sub-live' }], { records: false });
    w.seedAccount(POOL_ID, { subject: 'sub-live', username: 'b', email: 'b@x', enabled: true });
    // Offboarded, but the pool delete never ran: a marker and a live account.
    w.identities.set(revokedMarkerKey(ISS, 'sub-left'), { issuerSubject: revokedMarkerKey(ISS, 'sub-left') });
    w.seedAccount(POOL_ID, { subject: 'sub-left', username: 'l', email: 'l@x', enabled: true });
    // Never signed in: left alone.
    w.seedAccount(POOL_ID, { subject: 'sub-new', username: 'n', email: 'n@x', enabled: true });

    const out = await handleLifecycleEvent({ source: 'aws.events', 'detail-type': 'Scheduled Event' }, w.deps);
    expect(out).toEqual({
      action: 'swept',
      pools: 2,
      result: { erased: 1, 'pool-account-removed': 1, unchanged: 2 },
    });
    expect(w.users.has(gone)).toBe(false);
    expect(w.users.has(disabled)).toBe(true);
    expect(w.identities.get(`${ISS}|sub-disabled`)!.status).toBe('active');
    expect(w.identities.get(`${ISS}|sub-live`)!.status).toBe('active');
    expect([...w.pools.get(POOL_ID)!.keys()].sort()).toEqual(['sub-disabled', 'sub-live', 'sub-new']);

    // A second sweep finds nothing left to do.
    const again = await handleLifecycleEvent({ source: 'aws.events', 'detail-type': 'Scheduled Event' }, w.deps);
    expect(again).toMatchObject({ result: { erased: 0, 'pool-account-removed': 0 } });
  });
});

