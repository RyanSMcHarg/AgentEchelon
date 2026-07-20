// Membership Audit (SPEC-CONVERSATION-SECURITY Layer 6) admin API client.
// Endpoints hang off the analytics API (VITE_ANALYTICS_API_URL stage base), admin-authed.
// A14 view-security: under IAM enforcement these routes are AWS_IAM-authorized, so
// the calls are SigV4-signed with the operator's sign-on creds instead of a JWT.
import { apiCall, ADMIN_IAM_ENFORCEMENT } from '@ae/shared';
import { identityPoolCredentials, sigv4GetJson, sigv4PostJson } from './sigv4Fetch';

export interface MembershipAuditFinding {
  pk: string;
  sk: string;
  kind: 'member' | 'assistant';
  channelArn: string;
  memberArn: string;
  subjectTier: string;
  channelTier: string;
  action: 'reported' | 'revoked';
  ts: string;
  status: 'open' | 'revoked';
  reviewedBy?: string;
  reviewedAt?: string;
}

function getApiUrl(): string {
  const url = import.meta.env.VITE_ANALYTICS_API_URL;
  if (!url) throw new Error('VITE_ANALYTICS_API_URL not configured');
  return url; // API Gateway stage base, ends with '/'
}

function auditUrl(path: string): string {
  return `${getApiUrl().replace(/\/$/, '')}/${path}`;
}

export async function listFindings(): Promise<MembershipAuditFinding[]> {
  if (ADMIN_IAM_ENFORCEMENT) {
    const r = await sigv4GetJson<{ findings?: MembershipAuditFinding[] }>(auditUrl('membership-audit/findings'), {}, await identityPoolCredentials());
    return r.findings || [];
  }
  const r = await apiCall<{ findings?: MembershipAuditFinding[] }>(getApiUrl(), 'membership-audit/findings');
  return r.findings || [];
}

export async function getEnforce(): Promise<boolean> {
  if (ADMIN_IAM_ENFORCEMENT) {
    const r = await sigv4GetJson<{ enabled?: boolean }>(auditUrl('membership-audit/enforce'), {}, await identityPoolCredentials());
    return !!r.enabled;
  }
  const r = await apiCall<{ enabled?: boolean }>(getApiUrl(), 'membership-audit/enforce');
  return !!r.enabled;
}

export async function setEnforce(enabled: boolean): Promise<boolean> {
  if (ADMIN_IAM_ENFORCEMENT) {
    const r = await sigv4PostJson<{ enabled?: boolean }>(auditUrl('membership-audit/enforce'), { enabled }, await identityPoolCredentials());
    return !!r.enabled;
  }
  const r = await apiCall<{ enabled?: boolean }>(getApiUrl(), 'membership-audit/enforce', {
    method: 'POST',
    body: { enabled },
  });
  return !!r.enabled;
}

export async function revokeFinding(channelArn: string, memberArn: string, sk?: string): Promise<void> {
  if (ADMIN_IAM_ENFORCEMENT) {
    await sigv4PostJson(auditUrl('membership-audit/revoke'), { channelArn, memberArn, sk }, await identityPoolCredentials());
    return;
  }
  await apiCall(getApiUrl(), 'membership-audit/revoke', {
    method: 'POST',
    body: { channelArn, memberArn, sk },
  });
}
