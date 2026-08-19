/**
 * The caller's classification clearance, from the server-verified Cognito group list.
 *
 * ONE implementation, shared by the router and the channel flow, because the two meter the SAME
 * person for the SAME spend: the router charges an ordinary turn at
 * `min(channelClassification, clearance)`, and the flow charges the `/battle` fan-out - the single
 * most expensive dispatch - for the same sender. While the flow had no clearance input it charged at
 * the CHANNEL's classification, so a basic-clearance member of a premium channel who was over their
 * own ceiling could keep spending via `/battle`, metered against a ceiling that was never theirs.
 *
 * `isAdmin` is the OPT-IN abuse exemption (SPEC-ABUSE-CONTROLS "Identity and exemptions"): false
 * unless the deployment set ABUSE_EXEMPT_ADMINS and the caller is in a trusted admin group. Both
 * facts are derived from one AdminListGroupsForUser call and cached together per container.
 *
 * Fail-closed: an unresolvable user (or an unset pool) clears for the floor classification.
 * FEDERATED senders (`fed_` subs) must never reach this - they do not exist in the pool, so the
 * lookup would wrongly downgrade them; their entitlement is the channel they were provisioned into,
 * and the caller applies that rule before calling here.
 */
import {
  CognitoIdentityProviderClient,
  AdminListGroupsForUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry.js';

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-east-1' });
const USER_POOL_ID = process.env.USER_POOL_ID || '';

const cache = new Map<string, { clearance: string; isAdmin: boolean; expires: number }>();
const CACHE_TTL_MS = 5 * 60_000;

// Abuse-control admin exemption: OPT-IN, default off. When enabled, a sender in a trusted admin
// group is exempt from the PER-USER rate limit and PER-USER spend budget only - never the global
// budget, which always protects the account. The signal is the server-verified group list (not a
// spoofable attribute), resolved in the same call as clearance.
const ABUSE_EXEMPT_ADMINS = process.env.ABUSE_EXEMPT_ADMINS === 'true' || process.env.ABUSE_EXEMPT_ADMINS === '1';
const EXEMPT_ADMIN_GROUPS = new Set(
  (process.env.ABUSE_EXEMPT_ADMIN_GROUPS || 'admins').split(',').map((s) => s.trim()).filter(Boolean),
);

export async function resolveUserClearance(userSub: string): Promise<{ clearance: string; isAdmin: boolean }> {
  if (!userSub || !USER_POOL_ID) return { clearance: 'basic', isAdmin: false };
  const cached = cache.get(userSub);
  if (cached && cached.expires > Date.now()) return { clearance: cached.clearance, isAdmin: cached.isAdmin };

  try {
    const resp = await cognitoClient.send(new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: userSub,
    }));
    const groups = (resp.Groups || []).map((g) => g.GroupName || '');
    // Highest classification the user's Cognito groups clear for (fail-closed floor if none).
    // The Lambda reads the raw group list, so the registry picks the max — group-resource
    // precedence controls the cognito:groups claim, which this path does not use.
    const clearance = profiles.clearanceForGroups(groups);
    // Abuse exemption: only when the deployment opted in AND the caller is in a trusted admin group.
    const isAdmin = ABUSE_EXEMPT_ADMINS && groups.some((g) => EXEMPT_ADMIN_GROUPS.has(g));

    cache.set(userSub, { clearance, isAdmin, expires: Date.now() + CACHE_TTL_MS });
    return { clearance, isAdmin };
  } catch (err) {
    console.warn('[UserClearance] failed to resolve clearance from groups:', err);
    return { clearance: 'basic', isAdmin: false };
  }
}
