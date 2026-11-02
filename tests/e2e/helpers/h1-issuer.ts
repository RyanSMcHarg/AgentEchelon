/**
 * A PERSON FROM A FOREIGN OIDC ISSUER, FOR THE H1 SPECS.
 *
 * The H1 specs sign in through an issuer that is neither this deployment's own pool nor a pool at all: an
 * OIDC issuer the trusted-issuer registry declares with no directory of its own (`directory: 'claims'`),
 * reaching a fixed classification. The run is handed one verified ID token of that issuer, minted just
 * before it, and the registry id it is declared under:
 *
 *   AE_H1_ID_TOKEN    an ID token of the foreign issuer for a person who carries `email` and `name` claims
 *   AE_H1_ISSUER_ID   that issuer's registry id (default `h1-oidc`)
 *   AE_H1_REACHES     a classification its clearance source reaches (default `basic`)
 *
 * Without a token the specs skip with that reason: they are evidence against a deployment that declares
 * such an issuer, and a deployment that declares none has nothing for them to prove.
 */

export const H1_ID_TOKEN = process.env.AE_H1_ID_TOKEN || '';
export const H1_ISSUER_ID = process.env.AE_H1_ISSUER_ID || 'h1-oidc';
export const H1_REACHES = process.env.AE_H1_REACHES || 'basic';

export const H1_MISSING_REASON =
  'No foreign-issuer token: set AE_H1_ID_TOKEN to an ID token of an OIDC issuer the registry declares with '
  + 'directory "claims" (and AE_H1_ISSUER_ID to its registry id) to run the H1 specs.';

/** The claims of a JWT, unverified: what the test needs to compare, never a trust decision. */
export function claimsOf(token: string): Record<string, unknown> {
  const part = token.split('.')[1] || '';
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}
