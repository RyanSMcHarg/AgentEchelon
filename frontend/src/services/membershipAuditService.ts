// Membership Audit (SPEC-CONVERSATION-SECURITY Layer 6) admin API client.
// Endpoints hang off the analytics API (VITE_ANALYTICS_API_URL stage base), admin-authed.

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

async function apiCall(path: string, method = 'GET', body?: unknown) {
  const idToken = localStorage.getItem('idToken');
  if (!idToken) throw new Error('Not authenticated');
  const response = await fetch(`${getApiUrl()}membership-audit${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export async function listFindings(): Promise<MembershipAuditFinding[]> {
  const r = await apiCall('/findings');
  return r.findings || [];
}

export async function getEnforce(): Promise<boolean> {
  const r = await apiCall('/enforce');
  return !!r.enabled;
}

export async function setEnforce(enabled: boolean): Promise<boolean> {
  const r = await apiCall('/enforce', 'POST', { enabled });
  return !!r.enabled;
}

export async function revokeFinding(channelArn: string, memberArn: string, sk?: string): Promise<void> {
  await apiCall('/revoke', 'POST', { channelArn, memberArn, sk });
}
