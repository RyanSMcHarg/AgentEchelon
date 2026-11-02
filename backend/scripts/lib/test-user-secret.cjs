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
function buildSecretPatch({ userPoolId, clientId, users, password, onlyMode = false, testInbox = null }) {
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
  // Where the suite reads the test users' mail (lib/test-inbox-config.cjs). Written only when there is
  // one: a run without an inbox configured leaves a previously written one alone.
  if (testInbox) patch.testInbox = { bucket: testInbox.bucket, prefix: testInbox.prefix || '', domain: testInbox.domain };
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

/**
 * The users whose address CHANGES on this run, read off the secret's previous record.
 *
 * Moving test users to an inbox domain must not create a second set of users: the old ones would keep
 * their conversations, memberships and history while the suite signed in as strangers. So a user the
 * secret already records under another address is MOVED - its email attribute is changed in place and
 * its sub, and with it its Amazon Chime SDK identity, stays the same.
 */
function emailMoves(existingSecret, users) {
  const moves = [];
  for (const u of users || []) {
    const from = existingSecret && existingSecret[u.key] && existingSecret[u.key].email;
    if (from && from.toLowerCase() !== String(u.email).toLowerCase()) moves.push({ key: u.key, from, to: u.email });
  }
  return moves;
}

/**
 * THE ADMINISTRATOR IS ITS OWN IDENTITY. `seed-demo` re-points the secret's basic, standard and premium
 * users at the identities it creates, and none of those is an administrator. `testAdmin` belongs to
 * `provision-test-users.mjs`, which provisions a dedicated account in `admins`. So the seed keeps the
 * `testAdmin` it finds, unless that entry names one of the seed's own identities, in which case it is
 * dropped: an administrator the e2e signs in as must never be a person the seed holds out of `admins`.
 *
 * Returns the entry to keep, or null.
 */
function keptTestAdmin(existingSecret, seededEmails) {
  const entry = existingSecret && existingSecret.testAdmin;
  const email = String((entry && entry.email) || '').trim().toLowerCase();
  if (!email) return null;
  const seeded = new Set((seededEmails || []).map((e) => String(e).trim().toLowerCase()));
  return seeded.has(email) ? null : entry;
}

/**
 * The seed's identity preconditions, as problems to report. Each seeded identity holds its tier group
 * and NOT `admins`; the administrator the secret names exists apart from them and holds `admins`.
 *
 * `users` are `{ email, tier, groups }`; `admin` is `{ email, groups }`, or null when the secret names
 * no administrator. Returns one line per problem; an empty list means the preconditions hold.
 */
function identityPreconditionProblems(users, admin) {
  const problems = [];
  for (const u of users || []) {
    const groups = u.groups || [];
    if (!groups.includes(u.tier)) problems.push(`${u.email}: missing tier group '${u.tier}'`);
    if (groups.includes('admins')) problems.push(`${u.email}: holds 'admins'; a seeded ${u.tier} identity is not an administrator`);
  }
  const provision = 'run `npm run provision-test-users -- --only testAdmin`';
  if (!admin || !admin.email) {
    problems.push(`the test secret names no testAdmin; ${provision}`);
  } else if (!(admin.groups || []).includes('admins')) {
    problems.push(`testAdmin ${admin.email}: missing 'admins'; ${provision}`);
  }
  return problems;
}

module.exports = { buildSecretPatch, mergeSecretValue, emailMoves, keptTestAdmin, identityPreconditionProblems };
