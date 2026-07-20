/**
 * A14 `Scoped` cells (SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md section 6.4) — resolve
 * the caller's CLASSIFICATION CEILING from their verified identity, so an admin
 * read can be narrowed to the classification tier the caller is entitled to (the
 * one generic scope axis; ownership/membership scoping is deployment-specific).
 *
 * The ceiling is the caller's highest classification group. A caller in a
 * full-access group (the `admins` group, or the `platform-admins` persona) has NO
 * ceiling (Full). A caller with a persona but no classification group is
 * fail-closed to the floor, so a scope is a grant a deployer adds (a classification
 * group on the role's members), never an accident.
 *
 * Active ONLY under IAM enforcement (the handler passes the verified sub from
 * `iamCallerSub`). Cognito-JWT calls keep the existing behavior.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminListGroupsForUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { iamCallerSub } from './auth.js';

const cognito = new CognitoIdentityProviderClient({});

const CLASSIFICATION_RANK: Record<string, number> = { basic: 1, standard: 2, premium: 3 };
const CLASSIFICATION_ORDER = ['basic', 'standard', 'premium'];
const FLOOR_CLASSIFICATION = 'basic';
// Groups that read everything, unnarrowed.
const FULL_ACCESS_GROUPS = new Set(['admins', 'platform-admins']);

export function classificationRank(c: string): number {
  return CLASSIFICATION_RANK[c] ?? 0;
}

/**
 * A ceiling: a classification string (the caller sees that tier and below), or
 * `null` = Full (no narrowing). `undefined`/empty item classifications are treated
 * as the floor so an untagged row is never hidden from a floor-ceiling caller and
 * never leaked to one above it by being unclassified.
 */
export type ClassificationCeiling = string | null;

export function classificationAllowed(itemClassification: string | undefined, ceiling: ClassificationCeiling): boolean {
  if (ceiling === null) return true; // Full
  const item = classificationRank(itemClassification || FLOOR_CLASSIFICATION);
  return item <= classificationRank(ceiling);
}

/** The ceiling implied by a set of Cognito groups (pure; unit-tested). */
export function ceilingFromGroups(groups: string[]): ClassificationCeiling {
  if (groups.some((g) => FULL_ACCESS_GROUPS.has(g))) return null; // Full
  let best: string | null = null;
  for (const g of groups) {
    if (CLASSIFICATION_ORDER.includes(g) && (!best || classificationRank(g) > classificationRank(best))) best = g;
  }
  // A persona with no classification group is fail-closed to the floor.
  return best ?? FLOOR_CLASSIFICATION;
}

// Short-lived cache: the ceiling is stable for a session and the resolution costs
// two Cognito calls. Keyed by sub, TTL-bounded so a group change takes effect soon.
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { ceiling: ClassificationCeiling; at: number }>();

/** The caller's Cognito groups, resolved from their sub (the pool aliases email, so
 *  the username is a distinct UUID: find the user by sub, then list their groups). */
async function groupsForSub(sub: string, userPoolId: string): Promise<string[]> {
  const found = await cognito.send(new ListUsersCommand({
    UserPoolId: userPoolId,
    Filter: `sub = "${sub}"`,
    Limit: 1,
  }));
  const username = found.Users?.[0]?.Username;
  if (!username) return [];
  const g = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: username }));
  return (g.Groups || []).map((x) => x.GroupName || '').filter(Boolean);
}

/**
 * The caller's classification ceiling. `null` = Full. Cached per sub. On any Cognito
 * error, fail-closed to the floor (never widen access on a lookup failure).
 */
export async function resolveCallerCeiling(sub: string, userPoolId: string): Promise<ClassificationCeiling> {
  const hit = cache.get(sub);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.ceiling;
  let ceiling: ClassificationCeiling;
  try {
    ceiling = ceilingFromGroups(await groupsForSub(sub, userPoolId));
  } catch (err) {
    console.warn('[caller-scope] ceiling lookup failed, fail-closed to floor:', err);
    ceiling = FLOOR_CLASSIFICATION;
  }
  cache.set(sub, { ceiling, at: now });
  return ceiling;
}

/**
 * The classification ceiling to enforce for a request. Call ONLY when the request
 * is IAM-enforced (`isAdminIamEnforcedCall`). FAIL-CLOSED: if the verified sub
 * cannot be extracted from the signed principal (an unexpected
 * `cognitoAuthenticationProvider` shape, or a non-Identity-Pool principal), return
 * the floor rather than `null` (Full) - a control that cannot identify the caller
 * must narrow, never widen. This is the single seam so the fail-open cannot be
 * reintroduced at a call site.
 */
export async function ceilingForRequest(event: APIGatewayProxyEvent, userPoolId: string): Promise<ClassificationCeiling> {
  if (!userPoolId) {
    console.warn('[caller-scope] no USER_POOL_ID configured under enforcement -> fail-closed to floor');
    return FLOOR_CLASSIFICATION;
  }
  const sub = iamCallerSub(event);
  if (!sub) {
    console.warn('[caller-scope] IAM-enforced call with no resolvable sub -> fail-closed to floor');
    return FLOOR_CLASSIFICATION;
  }
  return resolveCallerCeiling(sub, userPoolId);
}

/** Test-only: clear the module cache. */
export function __clearCeilingCache(): void {
  cache.clear();
}

// A14 Scoped for the ANALYTICS plane: drop result rows whose classification
// DIMENSION exceeds the ceiling. Generic (no per-query SQL) — a row is filtered
// only if it carries a field that both names a classification axis AND holds a real
// tier value, so a global aggregate (no tier column) passes through unscoped, and a
// field literally named `classification` that holds a quality grade
// (excellent/good/...) is NOT mistaken for a tier. Documented limitation: cross-tier
// aggregates with no tier column are not narrowed (a deployer choice).
const TIER_VALUES = new Set(['basic', 'standard', 'premium']);
const CLASSIFICATION_FIELDS = new Set([
  'classification', 'tier', 'user_type', 'channel_tier', 'channeltier', 'modeltier', 'channelclassification',
]);

export function scopeAnalyticsRows<T>(rows: T[], ceiling: ClassificationCeiling): T[] {
  if (ceiling === null || !Array.isArray(rows)) return rows;
  return rows.filter((row) => {
    if (!row || typeof row !== 'object') return true;
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (typeof v === 'string' && CLASSIFICATION_FIELDS.has(k.toLowerCase()) && TIER_VALUES.has(v)) {
        return classificationAllowed(v, ceiling);
      }
    }
    return true; // no tier dimension -> global aggregate, not narrowed
  });
}
