/**
 * The shape of the e2e test-credentials secret, kept out of `provision-test-users.mjs` so the two
 * rules that govern it can be exercised without touching a live account.
 *
 * RULE 1 - THE SECRET ALWAYS CARRIES THE USER-POOL ID. `--only` mode used to withhold both pool and
 * client ids, so provisioning one login into a fresh secret produced a record with credentials and
 * no pool to present them to. The client id is a genuine choice (a pool publishes more than one app
 * client, and the existing value may deliberately be the other one), so it is filled in only when
 * the secret does not already have one. The POOL is not a choice: there is exactly one, the script
 * has just read it from the live stack outputs, and a secret without it cannot be used at all.
 *
 * RULE 2 - A WRITE MERGES, IT DOES NOT REPLACE. The user table here is not the whole secret: keys
 * this script has never written are read by the suite, and a wholesale replace would silently
 * un-provision them.
 */

/**
 * Build the patch a provisioning run writes into the secret.
 *
 * Returns `{ patch, fillIfAbsent }`: `patch` overwrites, `fillIfAbsent` is applied only to keys the
 * existing secret lacks.
 *
 * `users` are the selected rows of the script's user table (`{ key, email, tier }`); `tier` is the
 * secret's persisted field name and the e2e reads it by that name.
 */
function buildSecretPatch({ userPoolId, clientId, users, password, onlyMode = false }) {
  if (!userPoolId) throw new Error('buildSecretPatch: userPoolId is required (a secret without it cannot be used)');
  if (!password) throw new Error('buildSecretPatch: password is required');

  const patch = { cognitoUserPoolId: userPoolId };
  const fillIfAbsent = {};

  if (onlyMode) {
    // Do not overwrite a client id that may deliberately be the admin app client: tokens minted for
    // the wrong audience fail at the API, which is a confusing way for an unrelated suite to break
    // because someone added a login. Supply one only when there is none.
    if (clientId) fillIfAbsent.cognitoClientId = clientId;
  } else if (clientId) {
    patch.cognitoClientId = clientId;
  }

  for (const u of users || []) {
    patch[u.key] = { email: u.email, password, tier: u.tier };
  }
  return { patch, fillIfAbsent };
}

/** Merge a patch into the secret's current value. `fillIfAbsent` never overwrites. */
function mergeSecretValue(existing, patch, fillIfAbsent = {}) {
  const merged = { ...(existing || {}) };
  for (const [k, v] of Object.entries(fillIfAbsent)) {
    if (merged[k] === undefined || merged[k] === null || merged[k] === '') merged[k] = v;
  }
  return { ...merged, ...(patch || {}) };
}

module.exports = { buildSecretPatch, mergeSecretValue };
