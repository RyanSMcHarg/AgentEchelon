/**
 * THE TRUSTED-ISSUER REGISTRY, AS A LAMBDA READS IT.
 *
 * The registry is declared in `deploy.config.json` and validated at synth (`lib/config/issuers.ts`);
 * every function that reads a token or keys a person is handed its runtime form as `TRUSTED_ISSUERS`
 * (`grantCallerResolution`, `grantDirectoryRead`, the exchange). This module reads it and answers the
 * questions those functions ask: which entry a token comes from, which registry id a pool or a
 * host-supplied `iss` is, and which entry a registry id names.
 *
 * ── WHEN THE VARIABLE IS ABSENT ──────────────────────────────────────────────────────────────────
 *
 * A function with no `TRUSTED_ISSUERS` trusts its own pool (`USER_POOL_ID`) alone, at every
 * classification, with its admins as admins: the registry a deployment gets by declaring none. Every
 * deployed function that resolves a caller is given the variable, so this is the default registry and
 * never a wider one.
 *
 * ── HOW LONG A REMOVED ISSUER KEEPS RESOLVING ────────────────────────────────────────────────────
 *
 * The parsed registry is cached for at most `REGISTRY_TTL_MS` (the edge authorizer's cache bound), and
 * read again at once when the configuration it was read from changes. Removing an issuer is a deploy,
 * which replaces every warm container's configuration, so in a deployed function a removed issuer's
 * tokens are refused from the first request after it, and no reading of the registry is trusted for
 * longer than the TTL.
 */
import {
  DEPLOYMENT_ISSUER_ID,
  cognitoPoolIssuer,
  expandIssuer,
  issuerForClaims,
  type TrustedIssuer,
} from '../../../lib/config/issuers.js';

export const REGISTRY_TTL_MS = 300_000;

let cached: { until: number; key: string; list: TrustedIssuer[] } | null = null;

/** The registry a function with no `TRUSTED_ISSUERS` uses: its own pool alone. */
function defaultRegistry(): TrustedIssuer[] {
  // With no pool set either, the entry matches only a token naming no issuer (see `issuerOfToken`).
  const pool = (process.env.USER_POOL_ID || '').trim();
  const adminGroups = (process.env.ADMIN_GROUP_NAMES || '').split(',').map((g) => g.trim()).filter(Boolean);
  return [{
    id: DEPLOYMENT_ISSUER_ID,
    kind: 'cognito-pool',
    ...(pool ? { pool, iss: cognitoPoolIssuer(pool) } : {}),
    subject: ['sub'],
    // No list: its people reach whatever their groups clear for, in the runtime registry (`issuerClassificationsOf`).
    clearance: { groups: true },
    admin: true,
    ...(adminGroups.length ? { adminGroups } : {}),
    groupsClaim: 'cognito:groups',
    directory: pool ? 'cognito' : 'none',
  }];
}

function parse(raw: string): TrustedIssuer[] {
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) throw new Error('not a list');
    // The travelling form leaves every default out (`compactIssuers`); each entry is expanded here.
    return list.map(expandIssuer).filter((t): t is TrustedIssuer => t !== null);
  } catch (err) {
    // FAIL CLOSED: an unreadable registry trusts nobody, so every token is refused and the logs say why.
    console.error('[trusted-issuers][SecurityEvent] TRUSTED_ISSUERS is not a readable registry; no issuer is trusted', {
      message: (err as Error)?.message,
    });
    return [];
  }
}

/** Every issuer this function trusts. */
export function trustedIssuers(now: number = Date.now()): TrustedIssuer[] {
  const raw = process.env.TRUSTED_ISSUERS;
  // A configuration that changed is read again at once; an unchanged one at most every TTL.
  const key = `${raw ?? ''}\u0000${process.env.USER_POOL_ID ?? ''}\u0000${process.env.ADMIN_GROUP_NAMES ?? ''}`;
  if (cached && cached.key === key && cached.until > now) return cached.list;
  const list = raw === undefined || raw === '' ? defaultRegistry() : parse(raw);
  cached = { until: now + REGISTRY_TTL_MS, key, list };
  return list;
}

/** Forget the cached registry. For tests. */
export function __resetTrustedIssuersForTests(): void {
  cached = null;
}

/** The entry a registry id names, or null. */
export function issuerById(id: string, now?: number): TrustedIssuer | null {
  return trustedIssuers(now).find((t) => t.id === id) ?? null;
}

/**
 * The entry a token's verified claims come from, or null for an issuer the registry does not declare.
 *
 * A token with no `iss` is read as this deployment's own pool. A Cognito token always carries one, so
 * this is reached only by a hand-built event (a test, a direct invoke behind IAM), never by a token a
 * gateway verified.
 */
export function issuerOfToken(claims: Record<string, unknown>, now?: number): TrustedIssuer | null {
  const list = trustedIssuers(now);
  if (typeof claims.iss !== 'string' || !claims.iss) return list.find((t) => t.id === DEPLOYMENT_ISSUER_ID) ?? null;
  return issuerForClaims(list, claims);
}

/** The registry id of a Cognito pool's own entry, or null when the registry does not trust the pool. */
export function issuerIdForPool(poolId: string, now?: number): string | null {
  if (!poolId) return null;
  return trustedIssuers(now).find((t) => t.kind === 'cognito-pool' && t.pool === poolId)?.id ?? null;
}

/**
 * Every registry id whose people are accounts in a Cognito pool: the pool's own entry first, then each
 * `cognito-federated` entry on it. A person who signs in through a provider on the pool is a pool account
 * like any other, keyed under the federated entry's id, so a reader asking for "this pool's people" asks
 * for all of them (SPEC-CREDENTIAL-EXCHANGE §4b).
 */
export function issuerIdsForPool(poolId: string, now?: number): string[] {
  if (!poolId) return [];
  const on = trustedIssuers(now).filter((t) => t.pool === poolId);
  return [...on.filter((t) => t.kind === 'cognito-pool'), ...on.filter((t) => t.kind === 'cognito-federated')].map((t) => t.id);
}

/**
 * The registry id a host-supplied issuer names: a registry id as it stands, or an `iss` URL matched to
 * a `cognito-pool` or `oidc` entry. Null for anything the registry does not declare, which resolves to
 * nobody.
 */
export function issuerIdOf(issuerOrId: string, now?: number): string | null {
  const value = String(issuerOrId || '').trim();
  if (!value) return null;
  const list = trustedIssuers(now);
  if (list.some((t) => t.id === value)) return value;
  return list.find((t) => (t.kind === 'cognito-pool' || t.kind === 'oidc') && t.iss === value)?.id ?? null;
}
