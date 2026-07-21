/**
 * A14 `Scoped` cells (SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md section 10) — resolve
 * the caller's CLASSIFICATION CEILING from their verified identity, so an admin
 * read can be narrowed to the classification tier the caller is entitled to (the
 * one generic scope axis; ownership/membership scoping is deployment-specific).
 *
 * Resolved from the caller's ASSUMED-ROLE ARN (`event.requestContext.identity.userArn`):
 * the Identity Pool already mapped the caller's Cognito groups to a per-clearance role at
 * credential-vend time (outside the VPC), so the assumed role is itself the authoritative,
 * already-resolved clearance. This mirrors how `credential-exchange` bakes clearance into the
 * assumed role rather than re-querying Cognito, and lets the VPC-attached analytics Lambda run
 * with NO network path to the Cognito API (no `cognito-idp` VPC endpoint or NAT needed).
 *
 * The role -> ceiling map is supplied by the CognitoAuth stack (it owns the per-clearance role
 * ARNs) via the `CLASSIFICATION_ROLE_CEILINGS` env. Active ONLY under IAM enforcement; Cognito-JWT
 * calls keep the existing group-gate behavior.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

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

/**
 * The ceiling implied by a set of Cognito groups (pure; unit-tested). This is the reference
 * semantics the CognitoAuth stack mirrors when it builds the role -> ceiling map: a full-access
 * group maps its role to Full, a classification group maps its role to that tier, and a persona
 * with no classification group maps to the floor.
 */
export function ceilingFromGroups(groups: string[]): ClassificationCeiling {
  if (groups.some((g) => FULL_ACCESS_GROUPS.has(g))) return null; // Full
  let best: string | null = null;
  for (const g of groups) {
    if (CLASSIFICATION_ORDER.includes(g) && (!best || classificationRank(g) > classificationRank(best))) best = g;
  }
  // A persona with no classification group is fail-closed to the floor.
  return best ?? FLOOR_CLASSIFICATION;
}

/** The IAM role NAME from an IAM role ARN or an STS assumed-role ARN.
 *   iam:  arn:aws:iam::<acct>:role/<name>
 *   sts:  arn:aws:sts::<acct>:assumed-role/<name>/<session> */
function roleNameFromArn(arn: string): string | null {
  const m = /:(?:role|assumed-role)\/([^/]+)/.exec(arn);
  return m ? m[1] : null;
}

// Role name -> ceiling, parsed once from CLASSIFICATION_ROLE_CEILINGS (JSON array of
// { role: <arn>, ceiling: <classification | 'full'> }, emitted by the CognitoAuth stack).
// 'full' -> null (Full). Absent/malformed -> empty map, so every caller fail-closes to the floor.
type RoleCeilingEntry = { role: string; ceiling: string };
let roleCeilingByName: Map<string, ClassificationCeiling> | undefined;
function roleCeilings(): Map<string, ClassificationCeiling> {
  if (roleCeilingByName) return roleCeilingByName;
  const map = new Map<string, ClassificationCeiling>();
  try {
    const arr = JSON.parse(process.env.CLASSIFICATION_ROLE_CEILINGS || '[]') as RoleCeilingEntry[];
    for (const { role, ceiling } of arr) {
      const name = roleNameFromArn(role);
      if (name) map.set(name, ceiling === 'full' ? null : ceiling);
    }
  } catch (err) {
    console.warn('[caller-scope] CLASSIFICATION_ROLE_CEILINGS parse failed -> callers fail-closed to floor:', err);
  }
  roleCeilingByName = map;
  return map;
}

/**
 * The classification ceiling to enforce for a request. Call ONLY when the request is IAM-enforced
 * (`isAdminIamEnforcedCall`). Resolved from the caller's assumed-role ARN with NO network call.
 * FAIL-CLOSED: if the role cannot be extracted or is not in the map, return the floor rather than
 * `null` (Full) - a control that cannot identify the caller must narrow, never widen. This is the
 * single seam so the fail-open cannot be reintroduced at a call site. Synchronous (no I/O); callers
 * may `await` it harmlessly.
 */
export function ceilingForRequest(event: APIGatewayProxyEvent, _userPoolId?: string): ClassificationCeiling {
  const userArn = (event.requestContext?.identity as { userArn?: string | null } | undefined)?.userArn;
  const roleName = userArn ? roleNameFromArn(userArn) : null;
  if (!roleName) {
    console.warn('[caller-scope] IAM-enforced call with no resolvable role ARN -> fail-closed to floor');
    return FLOOR_CLASSIFICATION;
  }
  const map = roleCeilings();
  if (!map.has(roleName)) {
    console.warn(`[caller-scope] role "${roleName}" not in the ceiling map -> fail-closed to floor`);
    return FLOOR_CLASSIFICATION;
  }
  return map.get(roleName)!;
}

/** Test-only: reset the parsed role-ceiling map so a test can re-set the env. */
export function __clearCeilingCache(): void {
  roleCeilingByName = undefined;
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
