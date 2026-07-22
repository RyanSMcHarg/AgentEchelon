/**
 * Channel Battle Service
 *
 * Frontend client for the channel-battle admin API
 * (POST /channels/battle/enable, /disable; GET /channels/battle).
 *
 * Used by the MembersPanel "Battle Mode" toggle. The endpoint URL
 * comes from VITE_CHANNEL_BATTLE_API_URL (CDK output).
 */

export interface ChannelBattleConfig {
  channelArn: string;
  enabled: boolean;
  experimentId?: string;
  altBotSlotArn?: string;
  altBotSlotId?: string;
  enabledBy?: string;
  enabledAt?: string;
}

export interface EnableBattleResult {
  enabled: true;
  channelArn: string;
  experimentId: string;
  altBotSlotArn: string;
  altBotDisplayName: string;
}

function getApiUrl(): string {
  const url = import.meta.env.VITE_CHANNEL_BATTLE_API_URL;
  if (!url) throw new Error('VITE_CHANNEL_BATTLE_API_URL not configured');
  return url;
}

function getIdToken(): string {
  const idToken = localStorage.getItem('idToken');
  if (!idToken) throw new Error('Not authenticated');
  return idToken;
}

async function apiCall<T>(path: string, init: RequestInit = {}): Promise<T> {
  const idToken = getIdToken();
  const response = await fetch(`${getApiUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string; code?: string };
    const err = new Error(body.error || `Request failed: ${response.status}`) as Error & { code?: string };
    if (body.code) err.code = body.code;
    throw err;
  }
  return response.json() as Promise<T>;
}

export async function getBattleConfig(channelArn: string): Promise<ChannelBattleConfig> {
  return apiCall<ChannelBattleConfig>(`?channelArn=${encodeURIComponent(channelArn)}`);
}

/**
 * Enable Battle Mode on a channel. experimentId is optional: there is one
 * battle per classification, so omitting it lets the backend auto-resolve the
 * single active battle-enabled experiment for the channel's classification.
 */
export async function enableBattle(channelArn: string, experimentId?: string): Promise<EnableBattleResult> {
  return apiCall<EnableBattleResult>('/enable', {
    method: 'POST',
    body: JSON.stringify(experimentId ? { channelArn, experimentId } : { channelArn }),
  });
}

export async function disableBattle(channelArn: string): Promise<{ enabled: false; channelArn: string }> {
  return apiCall<{ enabled: false; channelArn: string }>('/disable', {
    method: 'POST',
    body: JSON.stringify({ channelArn }),
  });
}
