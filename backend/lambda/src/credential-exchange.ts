/**
 * Credential Exchange Service (docs/SPEC-CREDENTIAL-EXCHANGE.md — Step One).
 *
 * The backend that vends scoped, classification-capped AWS credentials for Chime
 * SDK Messaging, replacing the Identity-Pool-direct path (IDENTITY-PROVIDER-GUIDE
 * Approach 2). It exists for two reasons that are really one piece of work:
 *
 *   1. **Closes the ChimeBearer impersonation vector.** It `AssumeRole`s the
 *      caller's per-clearance role **with a `sub` session tag**, so that role's policy
 *      can pin the bearer to `…/user/${aws:PrincipalTag/sub}` — the caller can only
 *      act as their OWN AppInstanceUser. (AE's Identity-Pool path grants `…/user/*`
 *      unconditioned. memory
 *      `reference_chime_bearer_iam_pinning`.)
 *   2. **Is the federation substrate.** Validating an external IdP token here
 *      (later) + applying the classification ceiling is an additive change, not a
 *      new substrate (docs/SPEC-FEDERATED-PARTICIPANTS.md).
 *
 * This handler is the NATIVE path: the API Gateway Cognito authorizer has already
 * validated the ID token, so identity comes from `requestContext.authorizer.claims`
 * — NEVER from the request body (IDOR guard, same rule as create-conversation).
 *
 * Namespaces are current: chime-sdk-identity for AppInstanceUser.
 */

import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import {
  ChimeSDKIdentityClient,
  CreateAppInstanceUserCommand,
  UpdateAppInstanceUserCommand,
  CreateAppInstanceAdminCommand,
} from '@aws-sdk/client-chime-sdk-identity';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const SESSION_DURATION_SECONDS = Number(process.env.EXCHANGE_SESSION_SECONDS || '3600');
// Moderation creds are shorter-lived: enough to perform the action, then they expire
// (STS minimum is 900s). Bounds the window in which an elevated cred exists at all.
const MODERATION_SESSION_SECONDS = Number(process.env.EXCHANGE_MODERATION_SESSION_SECONDS || '1800');

// Per-clearance exchange role ARNs (the bearer-pinned roles assumed-by THIS Lambda with
// a `sub` session tag). Resolved from the caller's authoritative Cognito groups.
// The `admin` rung is the admin's CHAT identity (pinned to `${sub}`, never an
// app-instance-admin, no moderation) — the same membership-gated surface as any clearance.
const EXCHANGE_ROLE_ARNS: Record<string, string> = {
  basic: process.env.EXCHANGE_ROLE_BASIC || '',
  standard: process.env.EXCHANGE_ROLE_STANDARD || '',
  premium: process.env.EXCHANGE_ROLE_PREMIUM || '',
  admin: process.env.EXCHANGE_ROLE_ADMIN || '',
};
// The admin PLANE role. Pinned to the admin's SEPARATE identity `${sub}-admin` (a
// standing app-instance-admin), it carries the view + moderation ceiling. It is only
// ever assumed for a channel-scoped, short-lived, audited vend — never for chat — so
// cross-channel admin authority lives on an identity that never holds a `channel/*`
// chat cred. This is the two-identity split (SPEC-ADMIN-IDENTITY).
const EXCHANGE_ROLE_ADMIN_PLANE = process.env.EXCHANGE_ROLE_ADMIN_PLANE || '';

// Capability -> Chime action set. A request names capabilities; the exchange vends
// a session policy scoped to exactly those actions on the requested resource. The
// rung role is the ceiling, so a capability the rung does not grant is denied by the
// intersection. `view` + `participate` is the ordinary chat set (default).
const CAPABILITY_ACTIONS: Record<string, string[]> = {
  view: [
    'chime:GetChannelMessage', 'chime:ListChannelMessages',
    'chime:DescribeChannel', 'chime:ListChannelMemberships',
    // The channel's live moderator list, so the client reads "am I a moderator" from
    // the authoritative Chime source instead of inferring it from createdBy. Tag-gated
    // by the rung ceiling; a member may read who moderates a channel they can see.
    'chime:ListChannelModerators',
    // The user-scoped discovery action: lists the channels the caller is a member of
    // (their conversation list). Distinct from the channel-scoped ListChannelMemberships
    // above. Pinned to the caller's own user ARN by the role ceiling, so it can only ever
    // enumerate the caller's OWN memberships.
    'chime:ListChannelMembershipsForAppInstanceUser',
  ],
  participate: ['chime:SendChannelMessage', 'chime:UpdateChannelReadMarker'],
  redact: ['chime:RedactChannelMessage'],
  delete: ['chime:DeleteChannelMessage'],
  'manage-membership': [
    'chime:CreateChannelMembership', 'chime:DeleteChannelMembership', 'chime:CreateChannelModerator',
  ],
  'manage-channel': ['chime:UpdateChannel', 'chime:DeleteChannel'],
  // Owner rename: UpdateChannel WITHOUT delete, and deliberately NOT a moderation
  // cap, so it is allowed on the chat plane. Chime still authorizes the call on
  // ChannelModerator status — a conversation's creator is a moderator of their own
  // channel — so a member who is not a moderator is denied. Delete stays admin-only.
  rename: ['chime:UpdateChannel'],
};

// Capabilities that mutate a channel. They are vended ONLY on the admin plane (the
// `${sub}-admin` identity) and always require a channelArn scope, so a moderation cred
// is always confined to one channel (enforced in the handler).
const MODERATION_CAPS = new Set(['redact', 'delete', 'manage-membership', 'manage-channel']);

const sts = new STSClient({ region: AWS_REGION });
const chimeIdentity = new ChimeSDKIdentityClient({ region: AWS_REGION });

const CLASSIFICATION_RANK: Record<string, number> = { basic: 1, standard: 2, premium: 3 };

/** Parse the `cognito:groups` claim, which arrives from the REST API Cognito
 *  authorizer as an array, a JSON-ish `[a b]` string, or a comma/space list. */
export function parseGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((g) => String(g).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    return raw
      .replace(/^\[|\]$/g, '')
      .split(/[\s,]+/)
      .map((g) => g.trim())
      .filter(Boolean);
  }
  return [];
}

/** Authoritative clearance from Cognito groups (admins win; else highest clearance; else
 *  basic — the fail-safe floor). Mirrors router-agent-handler's resolution. */
export function resolveRoleKey(groups: string[]): 'basic' | 'standard' | 'premium' | 'admin' {
  if (groups.includes('admins')) return 'admin';
  let best: 'basic' | 'standard' | 'premium' = 'basic';
  for (const g of groups) {
    if ((g === 'standard' || g === 'premium') && CLASSIFICATION_RANK[g] > CLASSIFICATION_RANK[best]) best = g;
  }
  return best;
}

interface ExchangeResult {
  credentials: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string; Expiration?: string };
  userArn: string;
  tier: string;
  identity: 'chat' | 'admin';
  scopedTo?: string | null;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Content-Type': 'application/json',
  };
}

/** Create the AppInstanceUser, or UPDATE its Name if it already exists. The update-on-conflict is
 *  load-bearing: early users were created with Name = their sub (no display name), which then shows
 *  as a GUID in the @mention menu + message senders. Refreshing the Name on every exchange backfills
 *  those as users reconnect. */
async function ensureAppInstanceUser(sub: string, name: string): Promise<void> {
  try {
    await chimeIdentity.send(new CreateAppInstanceUserCommand({
      AppInstanceArn: APP_INSTANCE_ARN,
      AppInstanceUserId: sub,
      Name: name,
    }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConflictException') throw err;
    // Already exists — refresh the display name (best-effort; never fail the exchange on it).
    try {
      await chimeIdentity.send(new UpdateAppInstanceUserCommand({
        AppInstanceUserArn: `${APP_INSTANCE_ARN}/user/${sub}`,
        Name: name,
        Metadata: '', // required by the API; these users carry no metadata
      }));
    } catch (e) {
      console.warn('[CredentialExchange] UpdateAppInstanceUser name refresh failed (non-fatal):', e);
    }
  }
}

/** Register an app-instance-user (by id) as an app-instance-admin. Idempotent. */
async function ensureAppInstanceAdmin(userId: string): Promise<void> {
  try {
    await chimeIdentity.send(new CreateAppInstanceAdminCommand({
      AppInstanceArn: APP_INSTANCE_ARN,
      AppInstanceAdminArn: `${APP_INSTANCE_ARN}/user/${userId}`,
    }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConflictException') throw err;
    // already registered — fine.
  }
}

/**
 * Provision a console admin's SEPARATE admin identity `${sub}-admin` and register it as
 * an app-instance-admin. This is the elevated identity used ONLY for channel-scoped,
 * audited admin actions — it is NEVER the chat identity, so its standing elevation can
 * never attach to a broad `channel/*` chat cred (an AppInstanceAdmin's reads are not
 * membership-gated; a standing elevation on the CHAT identity would be a silent snoop
 * vector — auth-by-role.html). De-provisioned on demotion by the reconcile sweep.
 * Idempotent.
 */
async function ensureAdminIdentity(sub: string, displayName: string): Promise<string> {
  const adminUserId = `${sub}-admin`;
  await ensureAppInstanceUser(adminUserId, `${displayName} (admin)`.slice(0, 100));
  await ensureAppInstanceAdmin(adminUserId);
  return adminUserId;
}
export const handler = async (event: any): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> => {
  if (event?.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }

  // Identity comes ONLY from the validated Cognito-authorizer claims — never the body.
  const claims = event?.requestContext?.authorizer?.claims || {};
  const sub: string = claims.sub || '';
  if (!sub) {
    return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: 'Unauthenticated' }) };
  }

  // Per-request scope: the client names the capabilities it needs (default: the
  // ordinary chat set) and, optionally, a single channel. The exchange vends a
  // session policy scoped to exactly those actions on that resource. STS session
  // policies only NARROW, so taking these from the body is safe (a forged value can
  // only reduce access), and the channel must belong to this app instance.
  let scopeChannelArn = '';
  let requestedCaps: string[] = [];
  let requestedIdentity: 'chat' | 'admin' = 'chat';
  try {
    const body = event?.body ? JSON.parse(event.body) : {};
    if (typeof body?.channelArn === 'string' && body.channelArn) scopeChannelArn = body.channelArn;
    if (Array.isArray(body?.capabilities)) requestedCaps = body.capabilities.map((c: unknown) => String(c));
    if (body?.identity === 'admin') requestedIdentity = 'admin';
  } catch {
    /* malformed body: ignore and vend the default chat identity */
  }
  if (scopeChannelArn && !scopeChannelArn.startsWith(`${APP_INSTANCE_ARN}/channel/`)) {
    return {
      statusCode: 400,
      headers: cors(),
      body: JSON.stringify({ error: 'channelArn must be a channel of this app instance' }),
    };
  }
  const unknownCaps = requestedCaps.filter((c) => !(c in CAPABILITY_ACTIONS));
  if (unknownCaps.length) {
    return {
      statusCode: 400,
      headers: cors(),
      body: JSON.stringify({ error: `unknown capabilities: ${unknownCaps.join(', ')}` }),
    };
  }
  const requestsModeration = requestedCaps.some((c) => MODERATION_CAPS.has(c));
  const groups = parseGroups(claims['cognito:groups']);
  const roleKey = resolveRoleKey(groups);

  // Two planes.
  //  - CHAT (default): the caller's OWN identity `${sub}` on their clearance/admin rung. Never
  //    an app-instance-admin, so Chime membership-gates it; long-lived, may be `channel/*`.
  //  - ADMIN: the SEPARATE `${sub}-admin` identity — a STANDING app-instance-admin that
  //    only ever receives a channel-scoped, short-lived, AUDITED cred. Cross-channel admin
  //    authority thus lives on an identity that never holds a broad chat cred, so a chatting
  //    admin can never silently read another conversation (admin reads are not membership-
  //    gated; auth-by-role.html).
  const adminPlane = requestedIdentity === 'admin';
  if (adminPlane) {
    if (roleKey !== 'admin') {
      return { statusCode: 403, headers: cors(), body: JSON.stringify({ error: 'admin plane requires the admins group' }) };
    }
    if (!scopeChannelArn) {
      return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'admin plane requires a channelArn scope' }) };
    }
  } else if (requestsModeration) {
    // Moderation is never on the chat plane: the chat identity carries no moderation
    // authority. It must be requested on the admin plane, which is always channel-scoped.
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'moderation capabilities require plane:admin with a channelArn scope' }) };
  }

  const roleArn = adminPlane ? EXCHANGE_ROLE_ADMIN_PLANE : EXCHANGE_ROLE_ARNS[roleKey];
  if (!roleArn) {
    console.error('[CredentialExchange] No exchange role ARN configured for', adminPlane ? 'admin-plane' : roleKey);
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: 'Exchange misconfigured' }) };
  }
  // Reported access class: admins report 'admin', otherwise the caller's clearance.
  const accessClass = roleKey === 'admin' ? 'admin' : roleKey;

  try {
    // AppInstanceUserId == sub (AE convention). Display name, best-first: a real name claim; else
    // the email LOCAL part (e.g. "ryan" — name-like, far better than a GUID in the @mention menu);
    // else cognito:username if it isn't a UUID; else the sub.
    const emailLocal =
      typeof claims.email === 'string' && claims.email.includes('@') ? claims.email.split('@')[0] : '';
    const uname = (claims['cognito:username'] || '').toString();
    const unameUsable = uname && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(uname) ? uname : '';
    const displayName = (claims.name || emailLocal || unameUsable || sub).toString().slice(0, 100);
    // Provision the identity this vend acts as. CHAT: the caller's own `${sub}` — never an
    // app-instance-admin, membership-gated. ADMIN: the standing-elevated `${sub}-admin`,
    // created + registered here (idempotent); it only ever receives the scoped, short cred
    // below, so its standing elevation never attaches to a broad chat cred.
    let bearerUserId: string;
    if (adminPlane) {
      bearerUserId = await ensureAdminIdentity(sub, displayName);
    } else {
      await ensureAppInstanceUser(sub, displayName);
      bearerUserId = sub;
    }
    const bearerArn = `${APP_INSTANCE_ARN}/user/${bearerUserId}`;

    // Vend a session policy scoped to exactly the requested capabilities on the
    // requested resource. The rung role is the CEILING (a capability the rung does
    // not grant is denied by the intersection), so this only narrows. Connect and the
    // session endpoint are always allowed. The default (view + participate) equals the
    // current broad behavior, so existing clients that send no capabilities are unaffected.
    // Admin-plane default is `view` (review a conversation); chat default is the ordinary
    // view + participate. Either way the session policy only NARROWS the role ceiling.
    const caps = requestedCaps.length ? requestedCaps : (adminPlane ? ['view'] : ['view', 'participate']);
    const requestedActions = [...new Set(caps.flatMap((c) => CAPABILITY_ACTIONS[c]))];
    const channelResource = scopeChannelArn || `${APP_INSTANCE_ARN}/channel/*`;
    const sessionPolicy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'SessionAndConnect',
          Effect: 'Allow',
          Action: ['chime:GetMessagingSessionEndpoint', 'chime:Connect'],
          Resource: '*',
        },
        {
          Sid: 'RequestedActions',
          Effect: 'Allow',
          Action: requestedActions,
          Resource: [channelResource, bearerArn],
        },
      ],
    });

    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `chime-${bearerUserId}`.slice(0, 64),
      DurationSeconds: adminPlane ? MODERATION_SESSION_SECONDS : SESSION_DURATION_SECONDS,
      // The session tag the role's policy pins the bearer on. Chat roles pin
      // `${appInstanceArn}/user/${sub}`; the admin-plane role pins `.../user/${sub}-admin`.
      Tags: [{ Key: 'sub', Value: sub }],
      Policy: sessionPolicy,
    }));

    const c = assumed.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
      throw new Error('AssumeRole returned no credentials');
    }

    // Record every admin-plane vend: which human, which admin identity, which channel,
    // which capabilities, when. This is the audit trail that makes cross-channel admin
    // access accountable — an admin reading or moderating a conversation they are not a
    // member of always leaves a scoped, attributable record here.
    if (adminPlane) {
      console.log(JSON.stringify({
        _auditEvent: 'admin_scoped_credential_vend',
        timestamp: new Date().toISOString(),
        adminSub: sub,
        adminIdentity: bearerArn,
        channelArn: scopeChannelArn,
        capabilities: caps,
        moderation: requestsModeration,
        ttlSeconds: MODERATION_SESSION_SECONDS,
      }));
    }

    const result: ExchangeResult = {
      credentials: {
        AccessKeyId: c.AccessKeyId,
        SecretAccessKey: c.SecretAccessKey,
        SessionToken: c.SessionToken,
        Expiration: c.Expiration ? new Date(c.Expiration).toISOString() : undefined,
      },
      userArn: bearerArn,
      tier: accessClass, // wire field stays `tier` (frontend reads response.tier); value is the caller's clearance/admin class
      identity: requestedIdentity,
      scopedTo: scopeChannelArn || null,
    };
    return { statusCode: 200, headers: cors(), body: JSON.stringify(result) };
  } catch (err) {
    console.error('[CredentialExchange] failed:', err);
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: 'Credential exchange failed' }) };
  }
};
