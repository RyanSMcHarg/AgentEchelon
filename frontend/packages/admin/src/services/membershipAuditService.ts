// Membership Audit (SPEC-CONVERSATION-SECURITY Layer 6) admin API client.
// Endpoints hang off the analytics API (VITE_ANALYTICS_API_URL stage base), admin-authed.
import { apiCall } from '@ae/shared';

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

export async function listFindings(): Promise<MembershipAuditFinding[]> {
  const r = await apiCall<{ findings?: MembershipAuditFinding[] }>(getApiUrl(), 'membership-audit/findings');
  return r.findings || [];
}

export async function getEnforce(): Promise<boolean> {
  const r = await apiCall<{ enabled?: boolean }>(getApiUrl(), 'membership-audit/enforce');
  return !!r.enabled;
}

export async function setEnforce(enabled: boolean): Promise<boolean> {
  const r = await apiCall<{ enabled?: boolean }>(getApiUrl(), 'membership-audit/enforce', {
    method: 'POST',
    body: { enabled },
  });
  return !!r.enabled;
}

export async function revokeFinding(channelArn: string, memberArn: string, sk?: string): Promise<void> {
  await apiCall(getApiUrl(), 'membership-audit/revoke', {
    method: 'POST',
    body: { channelArn, memberArn, sk },
  });
}
