// Membership Audit (SPEC-CONVERSATION-SECURITY Layer 6) admin API client.
// Endpoints are on the analytics surface of AdminApi (mounted at `/query`), admin-authed.
// A14 view-security: these routes are AWS_IAM-authorized, so the calls are SigV4-signed
// with the operator's sign-on creds instead of a JWT.
import i18n from '@ae/shared/i18n';
import { consoleCredentials, sigv4GetJson, sigv4PostJson } from './sigv4Fetch';
import { adminApiConfigured, adminUrl } from './adminApi';

export interface MembershipAuditFinding {
  pk: string;
  sk: string;
  kind: 'member' | 'assistant';
  channelArn: string;
  memberArn: string;
  /**
   * THE PERSISTED KEY NAMES, which these did not match.
   *
   * `membership-audit.ts` writes a finding by spreading its own argument object, so the stored item
   * carries `subjectClearance` and `channelClassification`. This interface declared `subjectTier` and
   * `channelTier`, so both columns rendered EMPTY for every finding - a security audit whose two most
   * load-bearing fields were blank, with nothing failing.
   *
   * Fixed on the READ side deliberately: the writer's names are already correct under ADR-046 (a
   * clearance is what a holder has, a classification is what a channel is) and renaming them there
   * would need a migration of every stored finding to gain nothing.
   */
  subjectClearance: string;
  channelClassification: string;
  action: 'reported' | 'revoked';
  /**
   * `recorded-sign-in`: the member's issuer decides only from a token, and this finding was read from the
   * credential exchange's record of their last sign-in rather than a live clearance. Always `reported`.
   */
  basis?: 'recorded-sign-in';
  ts: string;
  status: 'open' | 'revoked';
  reviewedBy?: string;
  reviewedAt?: string;
}

/** Throws the named configuration error when `AdminApi` is unconfigured. */
function requireApi(): void {
  if (!adminApiConfigured()) throw new Error(i18n.t('admin.membershipAuditService.vite_analytics_api_urlNotConfigured'));
}

export async function listFindings(): Promise<MembershipAuditFinding[]> {
  requireApi();
  const r = await sigv4GetJson<{ findings?: MembershipAuditFinding[] }>(adminUrl('analytics', '/membership-audit/findings'), {}, await consoleCredentials());
  return r.findings || [];
}

export async function getEnforce(): Promise<boolean> {
  requireApi();
  const r = await sigv4GetJson<{ enabled?: boolean }>(adminUrl('analytics', '/membership-audit/enforce'), {}, await consoleCredentials());
  return !!r.enabled;
}

export async function setEnforce(enabled: boolean): Promise<boolean> {
  requireApi();
  const r = await sigv4PostJson<{ enabled?: boolean }>(adminUrl('analytics', '/membership-audit/enforce'), { enabled }, await consoleCredentials());
  return !!r.enabled;
}

export async function revokeFinding(channelArn: string, memberArn: string, sk?: string): Promise<void> {
  requireApi();
  await sigv4PostJson(adminUrl('analytics', '/membership-audit/revoke'), { channelArn, memberArn, sk }, await consoleCredentials());
}
