/**
 * Channel Battle Service
 *
 * Frontend client for the channel-battle admin API
 * (POST /channels/battle/enable, /disable; GET /channels/battle).
 *
 * Used by the MembersPanel "Battle Mode" toggle. The routes are on the person API
 * (VITE_PERSON_API_URL), served when VITE_PERSON_API_CAPABILITIES names `battle`.
 */
import { personApiServes, personUrl } from '@ae/shared';

export interface ChannelBattleConfig {
  channelArn: string;
  enabled: boolean;
  /** Whether this conversation MAY battle, from the profile's `battleEligible` flag - the same source
   *  the enable and invocation paths gate on. Distinct from `enabled`, which is whether a moderator has
   *  actually turned it on.
   *
   *  Callers read it asymmetrically, deliberately. The CAPABILITY gate (the members-panel toggle)
   *  requires `=== true` and so fails closed on an absent field. The briefing BANNER, which already
   *  requires `enabled`, only checks `!== false`, so a missing field does not blank the briefing on a
   *  battle that is demonstrably running. */
  battleEligible?: boolean;
  /**
   * Whether the assistant in this conversation can READ a file the sender attaches.
   *
   * From the profile's `attachmentsReadable` flag, which is the same fact that decides whether the
   * turn's IAM role carries `s3:GetObject` on the attachments prefix - so this is not a second
   * opinion about the boundary, it is the boundary reporting itself.
   *
   * FAILS CLOSED ON ABSENT: a client talking to an older backend reads `undefined` as "cannot read".
   *
   * ── WHAT THE CLIENT ACTUALLY DOES WITH IT, WHICH IS NOT HIDING THE CONTROL ──────────────────────
   *
   * This said the composer hides the paperclip. It does not, and must not: sending a colleague a file
   * needs no assistant, so hiding it would trade an invisible wrong answer for a visible missing
   * capability. The file always stages; what changes is that `MessageInput` renders a NOTICE beside
   * it saying the assistant here cannot read files.
   *
   * And the notice is withheld while the capability is still in flight (`useAttachmentCapability`
   * returns `undefined`, not `false`, until the answer lands), because the notice is a statement of
   * fact and there is no fact yet. Fail-closed is right for withholding an affordance and wrong for
   * asserting a limitation.
   */
  attachmentsReadable?: boolean;
  experimentId?: string;
  /** The challenger's assistant id, `alt-{role}-{classification}`. */
  challengerAssistant?: string;
  enabledBy?: string;
  enabledAt?: string;
}

export interface EnableBattleResult {
  enabled: true;
  channelArn: string;
  experimentId: string;
  challengerAssistant: string;
  /** The challenger's name, from its profile (the server's `battleSideNames`); never an experiment alias. */
  altBotDisplayName: string;
}

/**
 * The battle routes are served only when `VITE_PERSON_API_CAPABILITIES` names `battle`; without it
 * there is no battle, and a call refuses with that named.
 */
function requireBattle(): void {
  if (!personApiServes('battle')) throw new Error('Battle is not served here (VITE_PERSON_API_CAPABILITIES does not name battle)');
}

function getIdToken(): string {
  const idToken = localStorage.getItem('idToken');
  if (!idToken) throw new Error('Not authenticated');
  return idToken;
}

async function apiCall<T>(url: () => string, init: RequestInit = {}): Promise<T> {
  requireBattle();
  const idToken = getIdToken();
  const response = await fetch(url(), {
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
  return apiCall<ChannelBattleConfig>(() => personUrl(`/channels/battle?channelArn=${encodeURIComponent(channelArn)}`));
}

/**
 * Enable Battle Mode on a channel. experimentId is optional: there is one
 * battle per classification, so omitting it lets the backend auto-resolve the
 * single active battle-enabled experiment for the channel's classification.
 */
export async function enableBattle(channelArn: string, experimentId?: string): Promise<EnableBattleResult> {
  return apiCall<EnableBattleResult>(() => personUrl('/channels/battle/enable'), {
    method: 'POST',
    body: JSON.stringify(experimentId ? { channelArn, experimentId } : { channelArn }),
  });
}

export async function disableBattle(channelArn: string): Promise<{ enabled: false; channelArn: string }> {
  return apiCall<{ enabled: false; channelArn: string }>(() => personUrl('/channels/battle/disable'), {
    method: 'POST',
    body: JSON.stringify({ channelArn }),
  });
}
