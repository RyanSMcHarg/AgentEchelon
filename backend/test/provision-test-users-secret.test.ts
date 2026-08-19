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
const { buildSecretPatch, mergeSecretValue } = require('../scripts/lib/test-user-secret.cjs');

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
