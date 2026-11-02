/**
 * A14 `Scoped` cells (DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md section 10) — resolve
 * the caller's CLASSIFICATION SCOPE from their verified identity, so an admin
 * read can be narrowed to the classifications the caller is cleared for (the
 * one generic scope axis; ownership/membership scoping is deployment-specific).
 *
 * Resolved from the caller's ASSUMED-ROLE ARN (`event.requestContext.identity.userArn`):
 * the admin credential exchange already resolved the caller's groups to a per-clearance role at
 * credential-vend time (outside the VPC), so the assumed role is itself the authoritative,
 * already-resolved clearance. This mirrors how `credential-exchange` bakes clearance into the
 * assumed role rather than re-querying Cognito, and lets the VPC-attached analytics Lambda run
 * with NO network path to the Cognito API (no `cognito-idp` VPC endpoint or NAT needed).
 *
 * The role -> scope map is supplied by the AdminServices stack (it owns the per-clearance role
 * ARNs) via the `CLASSIFICATION_ROLE_SCOPES` env. Active ONLY under IAM enforcement; Cognito-JWT
 * calls keep the existing group-gate behavior.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { consoleSessionOf } from './auth.js';

/**
 * EVERY CLASSIFICATION QUESTION GOES TO THE REGISTRY, which is the one place that interprets a
 * classification value.
 *
 * This module kept its own `{ basic: 1, standard: 2, premium: 3 }` and returned 0 for anything else,
 * which is a copy of deployment config frozen at the moment it was written. The day a deployment
 * declared a fourth classification, that copy was wrong in BOTH directions at once:
 *
 *   - a row at the new classification scored 0, so it passed `item <= scope` for EVERY caller and
 *     was disclosed to all of them;
 *   - a caller whose scope was the new classification also scored 0, so every ordinary row failed
 *     the same test and their console went blank.
 *
 * A frozen copy of deployment config does not fail safe, because it does not know which end it is
 * missing. The registry does, so it answers.
 *
 * `classificationRank` IS DELETED, and so is the order it read. A rank is a position in an order and
 * these are peers: `legal` has no rank relative to `finance`. Everything the rank was used for is set
 * membership, which is what `classificationAllowed` below asks through `profiles.reaches`.
 *
 * THERE IS ALSO NO FLOOR TO DEFAULT AN ITEM TO. An item whose classification is absent is of UNKNOWN
 * classification and is refused, rather than treated as the least sensitive thing in the deployment -
 * which is what defaulting to the floor did, and it disclosed every untagged row to every reader.
 */
// Groups that read everything, unnarrowed.
const FULL_ACCESS_GROUPS = new Set(['admins', 'platform-admins']);

/**
 * A SCOPE: the classification whose `grants` set says what this caller may see, or `null` = Full
 * (no narrowing).
 *
 * The concept is a SET, not a height. What a caller sees is `grantsFor(scope)`: exactly the set that
 * classification declares, whatever shape the deployment gave it.
 */
export type ClassificationScope = string | null | undefined;

/**
 * May a caller scoped to `scope` see an item of `itemClassification`?
 *
 * AN ABSENT ITEM CLASSIFICATION IS REFUSED, AND THAT IS A REVERSAL. It used to be read as the floor,
 * so an untagged row was visible to everyone - the comment called that "permissive, and deliberate".
 * Deliberate it was; correct it was not, and with no floor there is no longer a value to read it as.
 * An item nobody classified is an item nobody has established the audience for, so it is withheld
 * rather than shown to all. This is the same reversal ADR-045 decision 2 made for the assistant
 * plane, applied to the admin read surfaces (ADR-045 decision 4).
 */
export function classificationAllowed(itemClassification: string | undefined, scope: ClassificationScope): boolean {
  if (scope === null) return true; // Full
  // NO SCOPE RESOLVED IS NOT FULL ACCESS, and `null` could not express that because it already means
  // Full. A caller whose scope could not be established sees nothing until it can be.
  if (scope === undefined) return false;
  if (!itemClassification) return false;
  return profiles.reaches(scope, itemClassification);
}

/**
 * The scope implied by a set of Cognito groups (pure; unit-tested). This is the reference
 * semantics the Identity stack mirrors when it builds the role -> scope map: a full-access
 * group maps its role to Full, a classification group maps its role to that classification, and a
 * persona with no classification group maps to NO scope, which sees nothing. The last clause said
 * "maps to the floor", and there is no floor: the function returns `undefined`.
 */
export function scopeFromGroups(groups: string[]): ClassificationScope {
  if (groups.some((g) => FULL_ACCESS_GROUPS.has(g))) return null; // Full
  // THE SET THEY HOLD, THEN THE TOKEN THAT MEANS IT - not "the highest-ranked group". Somebody in
  // both `legal` and `finance` holds neither above the other, and picking one by rank was how a
  // person with two clearances got the reach of one of them (or, on a badly-ordered config, more
  // than either). `tokenForHeldClassifications` is the same resolver the credential exchange uses,
  // so the admin read surface and the vended credential agree by construction.
  // Through the group -> classification map, not by reading a group NAME as a classification: a
  // deployment that names its clearance groups after its directory holds a classification under a
  // different name, and the exchange resolves them through this same map.
  const held = profiles.clearancesForGroups(groups);
  if (held.length === 0) return undefined; // no classification group: no scope, sees nothing
  return profiles.tokenForHeldClassifications(held);
}

/** The IAM role NAME from an IAM role ARN or an STS assumed-role ARN.
 *   iam:  arn:aws:iam::<acct>:role/<path/><name>   (the vend roles are on `/<instance>/exchange/`)
 *   sts:  arn:aws:sts::<acct>:assumed-role/<name>/<session>   (an assumed role's ARN carries no path) */
export function roleNameFromArn(arn: string): string | null {
  const assumed = /:assumed-role\/([^/]+)/.exec(arn);
  if (assumed) return assumed[1];
  const role = /:role\/(?:[^:]*\/)?([^/]+)$/.exec(arn);
  return role ? role[1] : null;
}

// Role name -> scope, parsed once from CLASSIFICATION_ROLE_SCOPES (JSON array of
// { role: <arn>, scope: 'full' }, emitted by the admin backend): the roles an administrator acts through. A
// person's vend role is resolved from its name and the runtime registry instead (`vendRoleClassification`).
// 'full' -> null (Full). Absent/malformed -> empty map, so no caller resolves a scope and every one of
// them sees nothing.
type RoleScopeEntry = { role: string; scope: string };
let roleScopeByName: Map<string, ClassificationScope> | undefined;
function roleScopes(): Map<string, ClassificationScope> {
  if (roleScopeByName) return roleScopeByName;
  const map = new Map<string, ClassificationScope>();
  try {
    const arr = JSON.parse(process.env.CLASSIFICATION_ROLE_SCOPES || '[]') as RoleScopeEntry[];
    for (const { role, scope } of arr) {
      const name = roleNameFromArn(role);
      if (name) map.set(name, scope === 'full' ? null : scope);
    }
  } catch (err) {
    console.warn('[caller-scope] CLASSIFICATION_ROLE_SCOPES parse failed -> no caller resolves a scope, so every one of them sees nothing:', err);
  }
  roleScopeByName = map;
  return map;
}

/**
 * The classification scope to enforce for a request. Call ONLY when the request is IAM-enforced
 * (`isAdminIamEnforcedCall`). Resolved from the caller's assumed-role ARN with NO network call.
 * FAIL-CLOSED: if the role cannot be extracted or is not in the map, return `undefined` (no scope,
 * sees nothing) rather than `null` (Full) - a control that cannot identify the caller must narrow,
 * never widen. It used to say it returned the floor, which would have been a real classification's
 * worth of reach handed to a caller nothing could identify. This is the single seam, so the fail-open
 * cannot be reintroduced at a call site. Synchronous (no I/O); callers may `await` it harmlessly.
 */
export function scopeForRequest(event: APIGatewayProxyEvent, _userPoolId?: string): ClassificationScope {
  const userArn = (event.requestContext?.identity as { userArn?: string | null } | undefined)?.userArn;
  const roleName = userArn ? roleNameFromArn(userArn) : null;
  if (!roleName) {
    console.warn('[caller-scope] IAM-enforced call with no resolvable role ARN -> no scope, sees nothing');
    return undefined;
  }
  // A TEAM CONSOLE SESSION IS BOUNDED BY THE PERSON'S CLEARANCE, read from the session name the
  // exchange gave it (`console-<personId>@<clearance>`). Owning an assistant does not raise clearance: an
  // assistant that served a conversation above the person's clearance does not show them that
  // conversation, or its rows. A team session with no clearance in its name sees nothing.
  if (/-team-console$/.test(roleName)) {
    const session = consoleSessionOf(userArn);
    const clearance = session?.kind === 'team' ? session.clearance : null;
    if (!clearance || !profiles.isKnownClassification(clearance)) {
      console.warn('[caller-scope] team console session without a known clearance -> no scope, sees nothing');
      return undefined;
    }
    return clearance;
  }
  const map = roleScopes();
  // A PERSON'S VEND ROLE, by its fixed name (`exchangeRoleName`, `lib/constructs/exchange-role.ts`): its
  // classification, read from the runtime registry, so a classification added later resolves with no edit here.
  // The admin plane's CHAT vend role is the admin plane's value, never Full: Full is admin access, which is the
  // console session and the admin twin's role in the scope map (SPEC-ADMIN-IDENTITY FR1).
  const vended = vendRoleClassification(roleName);
  if (vended !== undefined) return vended;
  if (!map.has(roleName)) {
    console.warn(`[caller-scope] role "${roleName}" not in the scope map -> no scope, sees nothing`);
    return undefined;
  }
  return map.get(roleName)!;
}

/**
 * The scope of a person's vend role, from its name (`<instance>-exchange-<classification>`, the prefix told in
 * `EXCHANGE_ROLE_NAME_PREFIX`) and the runtime registry: its classification, the admin plane's included.
 * Undefined for any other role, and for a name whose classification this deployment does not declare.
 */
function vendRoleClassification(roleName: string): ClassificationScope | undefined {
  const prefix = process.env.EXCHANGE_ROLE_NAME_PREFIX;
  if (!prefix || !roleName.startsWith(prefix)) return undefined;
  const token = roleName.slice(prefix.length);
  if (!profiles.isKnownClassification(token)) return undefined;
  return profiles.resolveClassification(token)!;
}

/** Test-only: reset the parsed role-scope map so a test can re-set the env. */
export function __clearScopeCache(): void {
  roleScopeByName = undefined;
}

// A14 Scoped for the ANALYTICS plane: drop result rows whose classification
// DIMENSION is outside the scope. Generic (no per-query SQL) — a row is filtered
// only if it carries a field that both names a classification axis AND holds a real
// tier value, so a global aggregate (no tier column) passes through unscoped, and a
// field literally named `classification` that holds a quality grade
// (excellent/good/...) is NOT mistaken for a tier. Documented limitation: cross-tier
// aggregates with no tier column are not narrowed (a deployer choice).
// THE DECLARED CLASSIFICATION VALUES, from the registry.
//
// This was a hardcoded three, and unlike every other frozen ladder in this codebase it failed OPEN.
// The set decides which row VALUES count as a classification at all; a value it does not recognise is
// not narrowed, so an `admin`-classified analytics row passed through to every caller regardless of
// their scope. Every other copy of this list denies someone wrongly - this one discloses.
const classificationValues = (): Set<string> => new Set(profiles.classificationValues());
const CLASSIFICATION_FIELDS = new Set([
  'classification', 'conversation_classification', 'tier', 'user_type', 'channel_tier', 'channeltier', 'modeltier',
  'channelclassification',
]);

export function scopeAnalyticsRows<T>(rows: T[], scope: ClassificationScope): T[] {
  if (scope === null || !Array.isArray(rows)) return rows;
  return rows.filter((row) => {
    if (!row || typeof row !== 'object') return true;
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (typeof v === 'string' && CLASSIFICATION_FIELDS.has(k.toLowerCase()) && classificationValues().has(v)) {
        return classificationAllowed(v, scope);
      }
    }
    return true; // no tier dimension -> global aggregate, not narrowed
  });
}
