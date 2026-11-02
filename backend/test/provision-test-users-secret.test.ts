/**
 * The e2e test-credentials secret's shape, as `provision-test-users.mjs` writes it.
 *
 * The script itself drives a live Cognito pool and Secrets Manager, so it cannot be exercised here.
 * The part that has been wrong is not the AWS calls but the RECORD: what goes into the secret, in
 * which mode. That is pure data shaping, it lives in scripts/lib/test-user-secret.cjs, and this
 * locks it.
 *
 * The defect being locked: `--only` mode wrote neither the user-pool id nor the app-client id, so
 * provisioning a single login against a fresh secret produced credentials with no pool to present
 * them to - a secret that cannot be used, written by a run that reported success.
 */
const { buildSecretPatch, mergeSecretValue, emailMoves, keptTestAdmin, identityPreconditionProblems } = require('../scripts/lib/test-user-secret.cjs');
const { resolveTestInbox, needsSsmLookup } = require('../scripts/lib/test-inbox-config.cjs');
const { opsDemoCast, presenterMailboxOf, OPS_DEMO_CAST } = require('../scripts/lib/demo-cast.cjs');

const USERS = [
  { key: 'basicUser', email: 'testuser-basic@example.test', tier: 'basic' },
  { key: 'testAdmin', email: 'testuser-admin@example.test', tier: 'premium' },
];

describe('test-credentials secret shape', () => {
  it('carries the user-pool id in a FULL run', () => {
    const { patch } = buildSecretPatch({
      userPoolId: 'us-east-1_POOL', clientId: 'CLIENT', users: USERS, password: 'pw',
    });
    expect(patch.cognitoUserPoolId).toBe('us-east-1_POOL');
    expect(patch.cognitoClientId).toBe('CLIENT');
  });

  it('carries the user-pool id in `--only` mode too', () => {
    const { patch } = buildSecretPatch({
      userPoolId: 'us-east-1_POOL', clientId: 'CLIENT', users: USERS, password: 'pw', onlyMode: true,
    });
    // The whole point: a secret without this is unusable, whichever mode wrote it.
    expect(patch.cognitoUserPoolId).toBe('us-east-1_POOL');
  });

  it('refuses to build a patch with no user-pool id, rather than writing an unusable secret', () => {
    expect(() => buildSecretPatch({ clientId: 'CLIENT', users: USERS, password: 'pw' })).toThrow(/userPoolId/);
  });

  it('writes every selected user with the run password and leaves the rest to the merge', () => {
    const { patch } = buildSecretPatch({
      userPoolId: 'us-east-1_POOL', clientId: 'CLIENT', users: USERS, password: 'run-password',
    });
    expect(patch.basicUser).toEqual({ email: 'testuser-basic@example.test', password: 'run-password', tier: 'basic' });
    expect(patch.testAdmin).toEqual({ email: 'testuser-admin@example.test', password: 'run-password', tier: 'premium' });
    expect(Object.keys(patch)).not.toContain('premiumUser');
  });

  it('does not overwrite an app client the deployer chose, in `--only` mode', () => {
    // A pool publishes more than one app client (chat + admin). The script reads whichever the CFN
    // output names, and the secret's existing value may deliberately be the other one: tokens minted
    // for the wrong audience fail at the API, which is a confusing way for an unrelated suite to
    // break because somebody added one login.
    const { patch, fillIfAbsent } = buildSecretPatch({
      userPoolId: 'us-east-1_POOL', clientId: 'FROM_CFN', users: USERS, password: 'pw', onlyMode: true,
    });
    const merged = mergeSecretValue({ cognitoClientId: 'CHOSEN_BY_DEPLOYER' }, patch, fillIfAbsent);
    expect(merged.cognitoClientId).toBe('CHOSEN_BY_DEPLOYER');
    expect(merged.cognitoUserPoolId).toBe('us-east-1_POOL');
  });

  it('supplies an app client in `--only` mode when the secret has none', () => {
    const { patch, fillIfAbsent } = buildSecretPatch({
      userPoolId: 'us-east-1_POOL', clientId: 'FROM_CFN', users: USERS, password: 'pw', onlyMode: true,
    });
    expect(mergeSecretValue({}, patch, fillIfAbsent).cognitoClientId).toBe('FROM_CFN');
    // An empty string is "none" as much as an absent key is: a secret carrying one is unusable.
    expect(mergeSecretValue({ cognitoClientId: '' }, patch, fillIfAbsent).cognitoClientId).toBe('FROM_CFN');
  });

  it('MERGES, so a key this script never writes survives the run', () => {
    // `onboardingUser` is read by the e2e and was written by nothing here for as long as the spec
    // existed. A wholesale replace would un-provision another suite silently.
    const existing = { onboardingUser: { email: 'o@example.test', password: 'x', tier: 'standard' } };
    const { patch, fillIfAbsent } = buildSecretPatch({
      userPoolId: 'us-east-1_POOL', clientId: 'CLIENT', users: USERS, password: 'pw', onlyMode: true,
    });
    const merged = mergeSecretValue(existing, patch, fillIfAbsent);
    expect(merged.onboardingUser).toEqual(existing.onboardingUser);
  });
});

describe('the test inbox: an existing one declared or named, or the one the TestInbox stack published', () => {
  const SSM = { domain: 'inbox.example.com', bucket: 'stack-bucket', prefix: 'inbox/' };
  const CONFIG = { testInboxDomain: 'Declared.Example.net', testInboxBucket: 'declared-bucket', testInboxPrefix: 'test-emails/app/' };

  it('uses an EXISTING inbox named in the environment, over the one the stack published', () => {
    const r = resolveTestInbox({
      env: { TEST_INBOX_BUCKET: 'mine', TEST_INBOX_PREFIX: 'test-emails/', TEST_EMAIL_DOMAIN: 'Mail.Example.org' },
      ssm: SSM,
    });
    expect(r).toEqual({ inbox: { bucket: 'mine', prefix: 'test-emails/', domain: 'mail.example.org' }, emailDomain: 'mail.example.org', source: 'environment', problem: '' });
  });

  it("uses the stack's inbox, and puts the test users on its domain", () => {
    expect(resolveTestInbox({ env: {}, ssm: SSM })).toEqual({ inbox: SSM, emailDomain: 'inbox.example.com', source: 'TestInbox stack', problem: '' });
  });

  it('has no inbox when neither is configured, and the users keep the default domain', () => {
    expect(resolveTestInbox({ env: {}, ssm: {} })).toEqual({ inbox: null, emailDomain: 'agentechelon.test', source: '', problem: '' });
  });

  it('uses an EXISTING inbox declared in deploy.config.json, so a fresh deploy keeps it with no environment set', () => {
    expect(resolveTestInbox({ env: {}, config: CONFIG, ssm: {} })).toEqual({
      inbox: { bucket: 'declared-bucket', prefix: 'test-emails/app/', domain: 'declared.example.net' },
      emailDomain: 'declared.example.net',
      source: 'deploy.config.json',
      problem: '',
    });
  });

  it('prefers the environment to the config, and the config to SSM', () => {
    const env = { TEST_INBOX_BUCKET: 'mine', TEST_EMAIL_DOMAIN: 'mail.example.org' };
    expect(resolveTestInbox({ env, config: CONFIG, ssm: SSM }).source).toBe('environment');
    expect(resolveTestInbox({ env: {}, config: CONFIG, ssm: SSM }).source).toBe('deploy.config.json');
    // testInboxDomain alone is the TestInbox stack's domain, not a declared inbox: SSM names its bucket.
    expect(resolveTestInbox({ env: {}, config: { testInboxDomain: 'inbox.example.com' }, ssm: SSM }).source).toBe('TestInbox stack');
  });

  it('refuses a declared bucket with no domain, because it cannot know which addresses land there', () => {
    const r = resolveTestInbox({ env: {}, config: { testInboxBucket: 'declared-bucket' } });
    expect(r.inbox).toBeNull();
    expect(r.problem).toMatch(/testInboxBucket.*testInboxDomain/);
  });

  it('reads SSM only when neither the environment nor the config names a bucket, and never on a dry run', () => {
    expect(needsSsmLookup({ env: {}, config: {} })).toBe(true);
    expect(needsSsmLookup({ env: {}, config: { testInboxDomain: 'inbox.example.com' } })).toBe(true);
    expect(needsSsmLookup({ env: {}, config: CONFIG })).toBe(false);
    expect(needsSsmLookup({ env: { TEST_INBOX_BUCKET: 'mine' }, config: {} })).toBe(false);
    expect(needsSsmLookup({ env: {}, config: {}, dryRun: true })).toBe(false);
  });

  it('refuses a bucket with no domain, because it cannot know which addresses land there', () => {
    expect(resolveTestInbox({ env: { TEST_INBOX_BUCKET: 'mine' } }).problem).toMatch(/TEST_EMAIL_DOMAIN/);
  });

  it('refuses users on one domain and an inbox on another, where every delivery test would time out', () => {
    const r = resolveTestInbox({ env: { TEST_EMAIL_DOMAIN: 'elsewhere.test' }, ssm: SSM });
    expect(r.inbox).toBeNull();
    expect(r.problem).toMatch(/elsewhere\.test.*inbox\.example\.com/);
  });

  it('writes the inbox into the secret only when there is one', () => {
    const base = { userPoolId: 'us-east-1_POOL', clientId: 'C', users: USERS, password: 'pw' };
    expect(buildSecretPatch({ ...base, testInbox: SSM }).patch.testInbox).toEqual(SSM);
    // A run without one leaves a previously written inbox alone, through the merge.
    const { patch } = buildSecretPatch(base);
    expect(mergeSecretValue({ testInbox: SSM }, patch).testInbox).toEqual(SSM);
  });
});

describe('a domain change moves the users the secret knows, rather than creating a second set', () => {
  it("names each user whose recorded address differs from this run's, case-insensitively", () => {
    const existing = {
      basicUser: { email: 'testuser-basic@agentechelon.test' },
      testAdmin: { email: 'TESTUSER-ADMIN@example.test' },
    };
    expect(emailMoves(existing, USERS)).toEqual([
      { key: 'basicUser', from: 'testuser-basic@agentechelon.test', to: 'testuser-basic@example.test' },
    ]);
  });

  it('moves nobody on a first run', () => {
    expect(emailMoves({}, USERS)).toEqual([]);
  });
});

describe('the demo cast: every login is a mailbox something can read', () => {
  type Row = { key: string; email: string; tier: string; groups: string[]; name: string };
  const byKey = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.key, r.email]));
  const cast = (env: Record<string, string>, inboxDomain: string): Row[] => opsDemoCast({ env, inboxDomain });

  it('puts every cast member on the inbox domain when an inbox resolves', () => {
    expect(byKey(cast({}, 'Dev.Example.com'))).toEqual({
      onCallLead: 'demo-oncall@dev.example.com',
      platformEngA: 'demo-priya@dev.example.com',
      platformEngB: 'demo-marcus@dev.example.com',
      engManager: 'demo-dana@dev.example.com',
      demoAdmin: 'demo-admin@dev.example.com',
      basicDemo: 'demo-basic@dev.example.com',
      salesVp: 'demo-sales@dev.example.com',
    });
  });

  it("never collides with the seed's tier users or the e2e users on the same domain", () => {
    for (const r of cast({}, 'dev.example.com')) {
      const local = r.email.split('@')[0];
      expect(local).toMatch(/^demo-/);
      expect(['basic', 'standard', 'premium']).not.toContain(local);
      expect(local).not.toMatch(/^testuser-/);
    }
    expect(new Set(OPS_DEMO_CAST.map((p: { local: string }) => p.local)).size).toBe(OPS_DEMO_CAST.length);
  });

  it('lets a DEMO_*_EMAIL variable override one person and leaves the rest on the inbox domain', () => {
    const rows = byKey(cast({ DEMO_LEAD_EMAIL: 'me@elsewhere.org', DEMO_SALES_EMAIL: ' ' }, 'dev.example.com'));
    expect(rows.onCallLead).toBe('me@elsewhere.org');
    // A blank variable is no override.
    expect(rows.salesVp).toBe('demo-sales@dev.example.com');
    expect(rows.engManager).toBe('demo-dana@dev.example.com');
  });

  it("keeps the presenter's plus-addresses when no inbox resolves, on the placeholder mailbox by default", () => {
    const rows = byKey(cast({}, ''));
    expect(rows.onCallLead).toBe('presenter+oncall@example.com');
    expect(rows.engManager).toBe('presenter+dana@example.com');
  });

  it('takes the presenter mailbox from deploy.config.json, and refuses one that is not a plain address', () => {
    const rows = byKey(opsDemoCast({ env: {}, inboxDomain: '', config: { presenterMailbox: ' Host@Presenter.Example.org ' } }));
    expect(rows.onCallLead).toBe('host+oncall@presenter.example.org');
    // An inbox still wins: the presenter's mailbox is the fallback only.
    expect(byKey(opsDemoCast({ env: {}, inboxDomain: 'dev.example.com', config: { presenterMailbox: 'host@presenter.example.org' } })).onCallLead)
      .toBe('demo-oncall@dev.example.com');
    expect(presenterMailboxOf({})).toEqual({ local: 'presenter', domain: 'example.com' });
    for (const bad of ['host', 'host+x@presenter.example.org', 'a@b@c.org']) {
      expect(() => presenterMailboxOf({ presenterMailbox: bad })).toThrow(/presenterMailbox/);
    }
  });

  it('keeps the tiers, groups and names the demo script relies on', () => {
    const rows = cast({ DEMO_LEAD_NAME: 'Alex Kim' }, '');
    expect(rows.find((r) => r.key === 'onCallLead')).toMatchObject({ tier: 'premium', groups: ['premium'], name: 'Alex Kim' });
    expect(rows.find((r) => r.key === 'demoAdmin')).toMatchObject({ groups: ['premium', 'admins'] });
    expect(rows.find((r) => r.key === 'basicDemo')).toMatchObject({ tier: 'basic', groups: ['basic'] });
    // Nobody is in `ops`: the presenter ticks it on camera.
    expect(rows.every((r) => !r.groups.includes('ops'))).toBe(true);
  });

  it('moves a cast already provisioned on the plus-addresses onto the inbox domain, in place', () => {
    const existing = Object.fromEntries(cast({}, '').map((r) => [r.key, { email: r.email }]));
    const moves = emailMoves(existing, cast({}, 'dev.example.com'));
    expect(moves).toHaveLength(OPS_DEMO_CAST.length);
    expect(moves).toContainEqual({ key: 'engManager', from: 'presenter+dana@example.com', to: 'demo-dana@dev.example.com' });
  });

  it('records the inbox in the demo secret, as it does in the e2e one', () => {
    const inbox = { bucket: 'declared-bucket', prefix: 'test-emails/app/', domain: 'dev.example.com' };
    const { patch } = buildSecretPatch({
      userPoolId: 'us-east-1_POOL', clientId: 'C', users: cast({}, inbox.domain), password: 'pw', testInbox: inbox,
    });
    expect(patch.testInbox).toEqual(inbox);
    expect(patch.engManager).toEqual({ email: 'demo-dana@dev.example.com', password: 'pw', tier: 'premium' });
  });
});

describe('the administrator is an identity of its own, never a seeded tier user', () => {
  const SEEDED = ['basic@dev.example.com', 'standard@dev.example.com', 'premium@dev.example.com'];
  const ADMIN = { email: 'testuser-admin@dev.example.com', password: 'pw', tier: 'premium' };

  it('the seed keeps the dedicated testAdmin provision-test-users wrote', () => {
    expect(keptTestAdmin({ testAdmin: ADMIN }, SEEDED)).toEqual(ADMIN);
  });

  it('the seed drops a testAdmin that names one of its own identities, case-insensitively', () => {
    expect(keptTestAdmin({ testAdmin: { email: 'Premium@Dev.Example.com', password: 'pw' } }, SEEDED)).toBeNull();
  });

  it('the seed names no administrator when the secret has none', () => {
    expect(keptTestAdmin({}, SEEDED)).toBeNull();
    expect(keptTestAdmin({ testAdmin: { email: '' } }, SEEDED)).toBeNull();
  });

  const seeded = (premiumGroups: string[]) => [
    { email: SEEDED[0], tier: 'basic', groups: ['basic'] },
    { email: SEEDED[1], tier: 'standard', groups: ['standard'] },
    { email: SEEDED[2], tier: 'premium', groups: premiumGroups },
  ];

  it('holds when each seeded identity has its tier group alone and testAdmin holds admins', () => {
    expect(identityPreconditionProblems(seeded(['premium']), { email: ADMIN.email, groups: ['admins', 'premium'] })).toEqual([]);
  });

  it('refuses a seeded premium identity in admins', () => {
    const problems = identityPreconditionProblems(seeded(['premium', 'admins']), { email: ADMIN.email, groups: ['admins'] });
    expect(problems).toEqual([expect.stringMatching(/premium@dev.example.com: holds 'admins'/)]);
  });

  it('refuses a missing or non-admin testAdmin, naming the command that provisions it', () => {
    expect(identityPreconditionProblems(seeded(['premium']), null)).toEqual([expect.stringMatching(/no testAdmin.*--only testAdmin/)]);
    expect(identityPreconditionProblems(seeded(['premium']), { email: ADMIN.email, groups: ['premium'] }))
      .toEqual([expect.stringMatching(/testuser-admin@dev.example.com: missing 'admins'.*--only testAdmin/)]);
  });

  it('refuses a seeded identity missing its tier group', () => {
    const users = [{ email: SEEDED[0], tier: 'basic', groups: [] }];
    expect(identityPreconditionProblems(users, { email: ADMIN.email, groups: ['admins'] })).toEqual([expect.stringMatching(/missing tier group 'basic'/)]);
  });
});
