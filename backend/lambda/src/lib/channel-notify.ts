/**
 * Conversation → transport notification fan-out (SPEC-NOTIFICATION-BRIDGE Phase 1, outbound).
 *
 * A channel message tagged with a `notify` directive in its Metadata is fanned out to the
 * conversation's PARTICIPANTS over the requested transport (email in v1; SMS/voice are the same
 * fan-out later). The recipient list comes from the channel's participant ROSTER — `{sub,name,role}[]`
 * stamped into channel Metadata by create-conversation — NOT from raw channel membership, because
 * federated AppInstanceUser ids are derived and are not the IDP subs we resolve contacts by. Email is
 * resolved from the IDP (`AdminGetUser`) by sub at send time (never stored). Best-effort: reuses
 * `lib/notification.sendEmailNotifications`; failures are collected, never thrown.
 *
 * The on-channel message stays in the conversation (the in-app surface); this just adds the
 * out-of-band transport for members who aren't watching it.
 */
import { ChimeSDKMessagingClient, DescribeChannelCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { sendEmailNotifications, type EmailRecipient } from './notification.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

export interface NotifyOptions {
  email?: boolean;
  sms?: boolean;
}

/** A delivery target: an IDP subject plus (optionally) the issuer it belongs to. `iss` is what makes
 *  a `sub` unambiguous when members come from MULTIPLE IDPs — for a Cognito issuer the user pool id is
 *  embedded in it (see poolIdFromIssuer). Absent `iss` ⇒ resolve against the deployment's primary
 *  pool (the single-IDP common case). It's a routing key, never identity content, so carrying it does
 *  not violate "don't persist email/name". */
export interface NotifyTarget {
  sub: string;
  iss?: string;
}

/** A notify directive parsed off a channel message's Metadata. */
export interface NotifyDirective {
  notify: NotifyOptions;
  /** Email subject; a sensible default is used when absent. */
  subject?: string;
  /** Limit delivery to these targets (e.g. a task assignee, or a just-shared member); omit ⇒ all
   *  participants. Each target may name its issuer so cross-IDP sends resolve the right pool. */
  targets?: NotifyTarget[];
}

/** A participant from the channel roster. Membership + role + home-IDP pointer only — identity
 *  (name/email) is NOT here; it's resolved from the IDP by (iss, sub) at send time (single source of
 *  truth). `iss` is optional for back-compat (absent ⇒ primary pool). */
export interface RosterParticipant {
  sub: string;
  iss?: string;
  role?: string;
}

/** Trusted-pool resolution config: the primary pool to use when a target has no `iss`, plus the set
 *  of pools an issuer is allowed to resolve to. IAM is the hard boundary, but we also gate here so a
 *  crafted `iss` can't steer a lookup at an unintended pool. */
export interface PoolResolution {
  defaultPoolId: string;
  allowedPoolIds: Set<string>;
}

/** Map an OIDC issuer to a Cognito user pool id. Cognito issuers embed the pool:
 *    https://cognito-idp.<region>.amazonaws.com/<poolId>
 * Returns null for non-Cognito issuers (Google/Okta/etc.) — those can't be resolved via AdminGetUser
 * and need an account-level contact fallback (SPEC-NOTIFICATION-BRIDGE, not yet built). */
export function poolIdFromIssuer(iss?: string): string | null {
  if (!iss) return null;
  const m = /cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/([A-Za-z0-9_-]+)\/?$/.exec(iss);
  return m ? m[1] : null;
}

/**
 * Parse a notify directive from a channel message's Metadata string. Returns null when there is no
 * actionable directive (no metadata, bad JSON, or no transport requested) — the common case, so the
 * channel flow skips the fan-out cheaply.
 */
export function parseNotifyDirective(metadata?: string): NotifyDirective | null {
  if (!metadata) return null;
  try {
    const m = JSON.parse(metadata) as Record<string, unknown>;
    const n = m.notify as { email?: unknown; sms?: unknown } | undefined;
    if (!n || (!n.email && !n.sms)) return null;
    // Preferred multi-IDP shape: notifyTargets = [{sub, iss}]. Legacy single-pool shape:
    // notifyTargetSubs = [sub] (iss omitted ⇒ resolved against the primary pool).
    let targets: NotifyTarget[] | undefined;
    if (Array.isArray(m.notifyTargets)) {
      targets = (m.notifyTargets as unknown[])
        .map((t) => (t && typeof t === 'object' ? (t as Record<string, unknown>) : {}))
        .filter((t) => typeof t.sub === 'string' && t.sub)
        .map((t) => ({ sub: t.sub as string, ...(typeof t.iss === 'string' ? { iss: t.iss as string } : {}) }));
    } else if (Array.isArray(m.notifyTargetSubs)) {
      targets = (m.notifyTargetSubs as unknown[])
        .filter((s): s is string => typeof s === 'string' && !!s)
        .map((sub) => ({ sub }));
    }
    return {
      notify: { email: !!n.email, sms: !!n.sms },
      subject: typeof m.notifySubject === 'string' ? (m.notifySubject as string) : undefined,
      ...(targets && targets.length ? { targets } : {}),
    };
  } catch {
    return null;
  }
}

/** Pure: the roster participants to notify — deduped by sub, requiring a sub, filtered to `targetSubs`
 *  when given (an empty/absent targetSubs means "all participants"). */
export function selectNotifyRecipients(
  roster: RosterParticipant[],
  targetSubs?: string[],
): RosterParticipant[] {
  const seen = new Set<string>();
  const out: RosterParticipant[] = [];
  for (const p of roster) {
    if (!p || !p.sub || seen.has(p.sub)) continue;
    if (targetSubs && targetSubs.length && !targetSubs.includes(p.sub)) continue;
    seen.add(p.sub);
    out.push(p);
  }
  return out;
}

/** Read the participant roster off a channel's Metadata (best-effort). Keeps `iss` when present so a
 *  multi-IDP roster resolves each member against their own pool. */
async function readRoster(
  chime: ChimeSDKMessagingClient,
  channelArn: string,
  bearerArn: string,
): Promise<RosterParticipant[]> {
  try {
    const r = await chime.send(new DescribeChannelCommand({ ChannelArn: channelArn, ChimeBearer: bearerArn }));
    const meta = JSON.parse(r.Channel?.Metadata || '{}') as { participants?: unknown };
    return Array.isArray(meta.participants)
      ? (meta.participants as RosterParticipant[]).filter((p) => p && typeof p.sub === 'string')
      : [];
  } catch (err) {
    console.warn('[channel-notify] failed to read roster:', err);
    return [];
  }
}

/** Resolve which trusted pool a target belongs to: its issuer's pool when given + allowed, else the
 *  primary pool. Returns null when the issuer maps to a pool we don't trust (or a non-Cognito IDP we
 *  can't query) — the caller then skips that recipient rather than guessing. */
export function resolvePoolForTarget(target: NotifyTarget, pools: PoolResolution): string | null {
  if (target.iss) {
    const poolId = poolIdFromIssuer(target.iss);
    if (!poolId) return null; // non-Cognito issuer — needs account-level fallback (not yet built)
    return pools.allowedPoolIds.has(poolId) ? poolId : null;
  }
  return pools.allowedPoolIds.has(pools.defaultPoolId) ? pools.defaultPoolId : null;
}

/** Resolve a target's contact (email + display name) from the IDP by (iss, sub) via AdminGetUser at
 *  send time — the single source of truth; nothing is persisted. `email` is null when not found or the
 *  target's IDP is untrusted/unqueryable. */
async function resolveContact(
  cognito: CognitoIdentityProviderClient,
  target: NotifyTarget,
  pools: PoolResolution,
): Promise<{ email: string | null; name: string }> {
  const poolId = resolvePoolForTarget(target, pools);
  if (!poolId) {
    console.warn(
      `[channel-notify] no trusted pool for sub ${target.sub.slice(0, 8)}… (iss=${target.iss || 'default'}); skipping`,
    );
    return { email: null, name: 'Member' };
  }
  try {
    const u = await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: target.sub }));
    const attr = (u.UserAttributes || []).reduce<Record<string, string>>((a, x) => {
      if (x.Name && x.Value !== undefined) a[x.Name] = x.Value;
      return a;
    }, {});
    const name =
      attr.name ||
      [attr.given_name, attr.family_name].filter(Boolean).join(' ').trim() ||
      'Member';
    return { email: attr.email || null, name };
  } catch (err) {
    console.warn(`[channel-notify] contact lookup failed for sub ${target.sub.slice(0, 8)}…:`, err);
    return { email: null, name: 'Member' };
  }
}

/**
 * Fan a channel notification out to the conversation's participants over the requested transports.
 * v1 = email (SMS is logged as not-yet-wired). Best-effort; returns who was reached/skipped/failed.
 */
export async function fanOutChannelNotification(args: {
  channelArn: string;
  bearerArn: string;
  /** Primary/default pool — used for targets without an explicit issuer (the single-IDP case). */
  userPoolId: string;
  /** Additional trusted pools for cross-IDP rosters; the primary is always trusted. */
  allowedPoolIds?: string[];
  messageText: string;
  directive: NotifyDirective;
  deps?: {
    chime?: ChimeSDKMessagingClient;
    cognito?: CognitoIdentityProviderClient;
    send?: typeof sendEmailNotifications;
  };
}): Promise<{ emailed: string[]; skipped: string[]; failed: string[] }> {
  const { channelArn, bearerArn, userPoolId, messageText, directive } = args;
  const chime = args.deps?.chime ?? new ChimeSDKMessagingClient({ region: AWS_REGION });
  const cognito = args.deps?.cognito ?? new CognitoIdentityProviderClient({ region: AWS_REGION });
  const send = args.deps?.send ?? sendEmailNotifications;
  const pools: PoolResolution = {
    defaultPoolId: userPoolId,
    allowedPoolIds: new Set([userPoolId, ...(args.allowedPoolIds || [])].filter(Boolean)),
  };

  if (directive.notify.sms) console.log('[channel-notify] SMS transport requested — not yet wired (email only in v1)');
  if (!directive.notify.email) return { emailed: [], skipped: [], failed: [] };
  if (!userPoolId) {
    console.warn('[channel-notify] no userPoolId — cannot resolve emails');
    return { emailed: [], skipped: [], failed: [] };
  }

  // Recipients: explicit `targets` resolve DIRECTLY (a targeted recipient — e.g. a just-shared
  // member — may not be in the channel roster yet); otherwise notify the whole roster. Each target
  // keeps its `iss` so cross-IDP sends hit the right pool.
  let targets: NotifyTarget[];
  if (directive.targets && directive.targets.length) {
    const seen = new Set<string>();
    targets = directive.targets.filter((t) => t.sub && !seen.has(t.sub) && seen.add(t.sub));
  } else {
    targets = selectNotifyRecipients(await readRoster(chime, channelArn, bearerArn)).map((p) => ({
      sub: p.sub,
      ...(p.iss ? { iss: p.iss } : {}),
    }));
  }
  if (!targets.length) return { emailed: [], skipped: [], failed: [] };

  const toSend: EmailRecipient[] = [];
  const skipped: string[] = [];
  for (const target of targets) {
    const { email, name } = await resolveContact(cognito, target, pools);
    if (email) toSend.push({ email, name });
    else skipped.push(target.sub);
  }
  if (!toSend.length) return { emailed: [], skipped, failed: [] };

  const res = await send(toSend, {
    subject: directive.subject || 'An update from your assistant',
    bodyText: messageText,
  });
  return { emailed: res.sent, skipped, failed: res.failed.map((f) => f.email) };
}
