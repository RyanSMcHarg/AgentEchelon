/**
 * THE TEST-DOUBLE HOST SIGNER: what a host application (a Salesforce org's Apex) would sign, signed here
 * with a key the operator holds, for the deny-tests and the e2e suite.
 *
 * The real signer is the host's: Apex signing with the org certificate and the post into the widget frame
 * are **NOT BUILT** (O9). This stands in for it, and only for a registry entry whose pinned key is this
 * key's public half. Nothing here is a credential of a real org.
 *
 *   node backend/scripts/deny-test-host-assertion.mjs --generate-key <path>
 *
 * writes a new RSA-2048 private key to `<path>` (keep it outside the repository; `private/` is
 * gitignored) and prints the `hostAssertion.publicKeys` value to declare for it.
 */
const fs = require('fs');
const { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } = require('crypto');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A new key pair: the private PEM, written to `path` with owner-only permission, and the SPKI to pin. */
function generateKey(path) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(path, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}

/** The private key at `path`, and the SPKI of its public half (to match against the registry). */
function loadKey(path) {
  const key = createPrivateKey(fs.readFileSync(path, 'utf8'));
  return { key, spki: createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64') };
}

/**
 * A signed assertion. `claims` are laid over the defaults: `iss`, `aud` (the deployment id), `org`,
 * `sub`, a fresh `jti`, `iat` now and `exp` two minutes ahead. `header` is laid over `{ alg, typ, kid }`.
 */
function signAssertion({ key, kid, iss, aud, org, sub, claims = {}, header = {}, algorithm = 'RS256' }) {
  const now = Math.floor(Date.now() / 1000);
  const h = { alg: algorithm, typ: 'JWT', kid, ...header };
  const body = { iss, aud, org, sub, jti: randomUUID(), iat: now, nbf: now, exp: now + 120, ...claims };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
  const input = `${b64(h)}.${b64(body)}`;
  const sig = algorithm === 'ES256' ? sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }) : sign('sha256', Buffer.from(input), key);
  return { token: `${input}.${sig.toString('base64url')}`, claims: body };
}

module.exports = { generateKey, loadKey, signAssertion };
