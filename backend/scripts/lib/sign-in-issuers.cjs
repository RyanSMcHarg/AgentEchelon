/**
 * WHAT THE SIGN-IN SCREEN IS TOLD ABOUT EACH ISSUER: `VITE_ISSUERS`, projected from the trusted-issuer
 * registry (`lib/config/issuers.ts`) by `gen-frontend-env.mjs`.
 *
 * Only the redirect kinds become a button: a provider on this deployment's own pool (`cognito-federated`,
 * through Cognito managed login) and a foreign OpenID Connect issuer (`oidc`, `oidc-entra`). The pool's
 * own people sign in with the password form, so `cognito-pool` is not listed. A `guest` and a
 * `host-assertion` issuer have no sign-in screen of their own (guest start, and an assertion the host
 * posts), so neither is listed either, and an `invitation-link` issuer has no sign-in at all: its person
 * joins from an invitation's landing page.
 *
 * PUBLIC FIELDS ONLY. The projection is an allowlist, because the result is baked into a bundle anyone
 * can download: the id, the kind, the display names, the discovery URL, the exact issuer, the OAuth
 * client id (the token audience, which every ID token carries in the clear), the provider name and the
 * admin flag. Clearance, mappings, classifications, tenants, groups and origins never travel.
 */

/** The issuer a Cognito pool's tokens carry. Mirrors `cognitoPoolIssuer` in `lib/config/issuers.ts`. */
function cognitoPoolIssuer(poolId, region) {
  return `https://cognito-idp.${region || String(poolId).split('_')[0]}.amazonaws.com/${poolId}`;
}

const discoveryOf = (issuer) => `${issuer}/.well-known/openid-configuration`;

/** The display names an entry declares, or the registry's own default, `{ en: <id> }`. */
function displayNameOf(e) {
  const names = e.displayName && typeof e.displayName === 'object' ? e.displayName : {};
  const kept = Object.fromEntries(Object.entries(names).filter(([, v]) => typeof v === 'string' && v));
  return Object.keys(kept).length ? kept : { en: e.id };
}

/** The one audience an OIDC entry's tokens carry for this deployment, or null when it is not one value. */
function oneAudience(e) {
  const aud = typeof e.audience === 'string' ? [e.audience] : Array.isArray(e.audience) ? e.audience : [];
  return aud.length === 1 && typeof aud[0] === 'string' && aud[0] ? aud[0] : null;
}

/**
 * The sign-in projection of a registry, and the entries left out with why.
 *
 * `selfPoolId` and `region` resolve `pool: 'self'`, as synth does. A redirect entry that cannot be offered
 * is reported in `skipped`, never offered half-formed: a button that cannot finish a sign-in is worse than
 * no button.
 */
function signInIssuers(issuers, { selfPoolId, region } = {}) {
  const entries = [];
  const skipped = [];
  for (const e of Array.isArray(issuers) ? issuers : []) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string') continue;
    const base = { id: e.id, kind: e.kind, displayName: displayNameOf(e), admin: e.admin === true };
    if (e.kind === 'cognito-federated') {
      if (e.pool !== 'self' && e.pool !== selfPoolId) {
        skipped.push({ id: e.id, reason: 'a provider on another pool signs in through that pool\'s own app client, which the registry does not declare (NOT BUILT)' });
        continue;
      }
      if (!selfPoolId) {
        skipped.push({ id: e.id, reason: 'the deployment\'s own pool id (output UserPoolId) is not known' });
        continue;
      }
      const issuer = cognitoPoolIssuer(selfPoolId, region);
      entries.push({ ...base, discoveryUrl: discoveryOf(issuer), issuer, providerName: e.providerName });
    } else if (e.kind === 'oidc' || e.kind === 'oidc-entra') {
      const clientId = oneAudience(e);
      if (!clientId) {
        skipped.push({ id: e.id, reason: 'the entry declares no single audience, so there is no one client id to sign in under' });
        continue;
      }
      // An Entra issuer is a template over the tenant; the client matches it against the discovery
      // document and the token's own tenant, so no fixed `issuer` travels for it.
      entries.push({
        ...base,
        discoveryUrl: e.discoveryUrl,
        ...(e.kind === 'oidc' ? { issuer: e.issuer } : {}),
        clientId,
      });
    }
  }
  return { entries, skipped };
}

/**
 * The `.env` line. Single-quoted so dotenv takes the JSON literally, with the two characters that could
 * still end or expand it written as JSON escapes, which the client's `JSON.parse` reads back unchanged.
 */
function viteIssuersLine(entries) {
  const json = JSON.stringify(entries).replace(/'/g, '\\u0027').replace(/\$/g, '\\u0024');
  return `VITE_ISSUERS='${json}'`;
}

module.exports = { signInIssuers, viteIssuersLine, cognitoPoolIssuer };
