/**
 * SIGN IN, THEN CALL THE CREDENTIAL EXCHANGE: how an operator script makes a person exist.
 *
 * Only the credential exchange creates a person (lambda/src/lib/person-identity.ts). It mints the
 * AppInstanceUser, with an opaque UUID v7 id, on the person's first exchange, and resolves the same one
 * on every exchange after. So a provisioning script never creates an AppInstanceUser itself: it signs
 * the user in and calls the exchange, which is the signed path every client takes, and records the
 * `userArn` the exchange answers with. Re-running converges, because a second exchange resolves the
 * same person.
 *
 * Nothing here prints or returns a password or a token. A failure names the user and the status only.
 */

/** The `userArn` the exchange vended for this user. Throws, naming the user, when it cannot. */
async function signInAndExchange({ cognito, InitiateAuthCommand, clientId, exchangeUrl, email, password, fetchImpl = fetch }) {
  if (!clientId) throw new Error('signInAndExchange: clientId is required');
  if (!exchangeUrl) throw new Error('signInAndExchange: the person API URL is required (PersonApi output PersonApiUrl)');
  const auth = await cognito.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  const idToken = auth?.AuthenticationResult?.IdToken;
  if (!idToken) {
    throw new Error(`${email} could not sign in (challenge ${auth?.ChallengeName || 'none'}); the exchange was not called`);
  }
  const base = String(exchangeUrl).replace(/\/+$/, '');
  const resp = await fetchImpl(`${base}/exchange-credentials`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!resp.ok) throw new Error(`the credential exchange refused ${email}: HTTP ${resp.status}`);
  const body = await resp.json();
  if (!body || typeof body.userArn !== 'string' || !body.userArn) {
    throw new Error(`the credential exchange answered ${email} with no userArn`);
  }
  return body.userArn;
}

/**
 * A SIGNED-IN OPERATOR'S CONSOLE SESSION: the credentials the admin console signs admin routes with.
 *
 * The exchanges are the only source of AWS credentials for a person (there is no Identity Pool), and an
 * admin route admits a console role alone, so a script that reads an admin API signs in, signs the
 * person in at the person exchange (the only minter), asks the admin exchange for
 * `identity: 'console'`, and signs with what it answers. Returns the SigV4 credentials; throws naming
 * the user and the status. Nothing here prints or returns a password or a token.
 */
async function signInForConsoleSession({ cognito, InitiateAuthCommand, clientId, exchangeUrl, adminExchangeUrl, email, password, fetchImpl = fetch }) {
  if (!clientId) throw new Error('signInForConsoleSession: clientId is required');
  if (!exchangeUrl) throw new Error('signInForConsoleSession: the person API URL is required (PersonApi output PersonApiUrl)');
  if (!adminExchangeUrl) throw new Error('signInForConsoleSession: the admin API URL is required (AdminApi output AdminApiUrl)');
  const auth = await cognito.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  const idToken = auth?.AuthenticationResult?.IdToken;
  if (!idToken) throw new Error(`${email} could not sign in (challenge ${auth?.ChallengeName || 'none'}); the exchange was not called`);
  const person = await fetchImpl(`${String(exchangeUrl).replace(/\/+$/, '')}/exchange-credentials`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!person.ok) throw new Error(`the credential exchange refused ${email}: HTTP ${person.status}`);
  const resp = await fetchImpl(`${String(adminExchangeUrl).replace(/\/+$/, '')}/exchange-credentials`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: 'console' }),
  });
  if (!resp.ok) throw new Error(`the admin credential exchange refused ${email} a console session: HTTP ${resp.status}`);
  const body = await resp.json();
  const c = body?.credentials;
  if (!c?.AccessKeyId || !c?.SecretAccessKey || !c?.SessionToken) {
    throw new Error(`the credential exchange answered ${email} with no console credentials`);
  }
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
}

module.exports = { signInAndExchange, signInForConsoleSession };
