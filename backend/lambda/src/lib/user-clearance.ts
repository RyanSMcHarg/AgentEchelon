/**
 * A person's classification clearance, through each issuer they sign in with: that issuer's Q5
 * clearance source (`clearance-source.ts`, chosen by the seam factory `issuer-seams.ts`), within its
 * declared classifications (`Directory.clearanceOf`, `membership-source.ts`). Cognito pool groups are one source of four.
 *
 * ONE implementation, shared by the router and the channel flow, because the two meter the SAME
 * person for the SAME spend: the router admits an ordinary turn only
 * when the sender's grant set reaches the channel's classification, and the flow charges the `/battle` fan-out - the single
 * most expensive dispatch - for the same sender. While the flow had no clearance input it charged at
 * the CHANNEL's classification, so a basic-clearance member of a premium channel who was over their
 * own limit could keep spending via `/battle`, metered against a limit that was never theirs.
 *
 * `isAdmin` is the OPT-IN abuse exemption (SPEC-ABUSE-CONTROLS "Identity and exemptions"): false
 * unless the deployment set ABUSE_EXEMPT_ADMINS and the caller is in a trusted admin group of an issuer
 * declaring `admin: true`. Both facts are derived from one read and cached together per container.
 *
 * Fail-closed: an unresolvable person resolves to no clearance, never a floor.
 *
 * ASKED BY PERSON. The person's subjects are found through `Identities`. A person whose issuers cannot
 * be read without a token (a `mapping` source), or who signs in through no issuer the registry declares,
 * is reported as `fromIssuer: false` rather than guessed at: the caller decides what it means (the
 * router answers at the channel's classification, which IAM already decided the person may act in).
 */
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { DEPLOYMENT_ISSUER_ID, expandIssuer, type TrustedIssuer } from '../../../lib/config/issuers.js';
import type { ClearanceSource } from './clearance-source.js';
import { createDirectory, defaultDirectory, type ClearanceEvidence, type Directory } from './membership-source.js';
import { groupsOnlySeams } from './issuer-seams.js';

let directory: Directory | null = null;
let sourceName: string | undefined;
function dir(): Directory {
  return directory ?? defaultDirectory();
}

/**
 * Test seam: replace the provider of this deployment's own pool's groups, for a person who signs in as
 * the subject of their own id. Passing `undefined` restores the deployment's directory, and `null`
 * leaves the deployment no issuer to ask.
 */
export function __setClearanceSourceForTests(s: ClearanceSource | null | undefined): void {
  // The deployment's own pool, every default of the entry restored by the registry.
  const self = expandIssuer({ id: DEPLOYMENT_ISSUER_ID, kind: 'cognito-pool', admin: true, clearance: { groups: true, classifications: profiles.classificationValues() } }) as TrustedIssuer;
  directory = s === undefined ? null : createDirectory({
    appInstanceArn: process.env.APP_INSTANCE_ARN || '',
    issuers: s === null ? [] : [self],
    seams: groupsOnlySeams(s as ClearanceSource),
    identities: {
      resolve: async () => null,
      subjectsOf: async (arn) => [{ issuer: DEPLOYMENT_ISSUER_ID, subject: arn.split('/').pop() || '' }],
    },
  });
  sourceName = s?.name;
  cache.clear();
}

const cache = new Map<string, { clearance: string | undefined; adminPlane?: boolean; isAdmin: boolean; fromIssuer: boolean; lastSignIn?: ClearanceEvidence[]; expires: number }>();
const CACHE_TTL_MS = 5 * 60_000;

// Abuse-control admin exemption: OPT-IN, default off. When enabled, a sender in a trusted admin
// group is exempt from the PER-USER rate limit and PER-USER spend budget only - never the global
// budget, which always protects the account. The signal is the server-verified group list (not a
// spoofable attribute), resolved in the same call as clearance.
const ABUSE_EXEMPT_ADMINS = process.env.ABUSE_EXEMPT_ADMINS === 'true' || process.env.ABUSE_EXEMPT_ADMINS === '1';
const EXEMPT_ADMIN_GROUPS = new Set(
  (process.env.ABUSE_EXEMPT_ADMIN_GROUPS || 'admins').split(',').map((s) => s.trim()).filter(Boolean),
);

export interface PersonClearance {
  clearance: string | undefined;
  /** True when the admin plane classification is held beside (or as) `clearance`: admin conversations. */
  adminPlane?: boolean;
  isAdmin: boolean;
  /**
   * False when nothing can be read about the person without a token: their issuers decide only from a
   * token, or none of them is declared. `clearance` is then undefined because there is nothing to read,
   * not because a read failed.
   */
  fromIssuer: boolean;
  /**
   * For a person whose issuer decides only from a token: what the exchange recorded it decided at their
   * last sign-in through it, and whether that record is stale. Evidence for the caller to flag a mismatch
   * with; never a clearance (`clearance` stays undefined).
   */
  lastSignIn?: ClearanceEvidence[];
}

/**
 * A person's clearance, or `undefined` when it cannot be established.
 *
 * IT USED TO ANSWER THE FLOOR, AND THERE IS NO FLOOR. "Unknown clearance" and
 * "cleared for the least-privileged classification" were the same value, so a directory outage and a
 * genuinely basic person were indistinguishable to every caller - and the caller then served the
 * outage as if it were an answer. With peer classifications there is not even a least-privileged one
 * to name. An unresolvable clearance is now `undefined` and the caller refuses the turn.
 */
export async function resolveUserClearance(personArn: string): Promise<PersonClearance> {
  if (!personArn) return { clearance: undefined, isAdmin: false, fromIssuer: true };
  const cached = cache.get(personArn);
  if (cached && cached.expires > Date.now()) {
    return { clearance: cached.clearance, ...(cached.adminPlane ? { adminPlane: true } : {}), isAdmin: cached.isAdmin, fromIssuer: cached.fromIssuer, ...(cached.lastSignIn ? { lastSignIn: cached.lastSignIn } : {}) };
  }

  try {
    const answer = await dir().clearanceOf(personArn);
    if (answer.state !== 'held') {
      const lastSignIn = answer.state === 'undetermined' ? answer.lastSignIn : undefined;
      cache.set(personArn, { clearance: undefined, isAdmin: false, fromIssuer: false, ...(lastSignIn ? { lastSignIn } : {}), expires: Date.now() + CACHE_TTL_MS });
      return { clearance: undefined, isAdmin: false, fromIssuer: false, ...(lastSignIn ? { lastSignIn } : {}) };
    }
    // ── THE HOLDER TOKEN, the same value the credential exchange vends and stamps ───────────────
    //
    // The token that names exactly the set the holder is cleared for, never one group picked from
    // it: a holder's grant set need not match any single group, and this value is compared against a
    // channel classification by the caller. One resolver everywhere, or the comparison is between
    // two kinds of answer.
    const clearance = answer.token;
    const isAdmin = ABUSE_EXEMPT_ADMINS && answer.admin && answer.groups.some((g) => EXEMPT_ADMIN_GROUPS.has(g));

    // CACHED EVEN WHEN UNDEFINED, because "this person's groups name no declared combination" is a
    // stable fact about the deployment's config, not a transient read failure - re-asking on every
    // turn would not change the answer.
    const adminPlane = answer.adminPlane === true;
    cache.set(personArn, { clearance, ...(adminPlane ? { adminPlane } : {}), isAdmin, fromIssuer: true, expires: Date.now() + CACHE_TTL_MS });
    return { clearance, ...(adminPlane ? { adminPlane } : {}), isAdmin, fromIssuer: true };
  } catch (err) {
    // NAMES THE PROVIDER, so a failure here is attributable rather than just "clearance failed".
    console.warn(`[UserClearance] ${sourceName ?? 'the issuer\'s'} source failed to resolve groups:`, err);
    // The provider failed, so nothing is known about this person. Not the floor: see the header.
    return { clearance: undefined, isAdmin: false, fromIssuer: true };
  }
}
