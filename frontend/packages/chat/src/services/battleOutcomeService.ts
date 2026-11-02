/**
 * Battle Outcome Service
 *
 * Frontend client for the pick-the-winner API
 * (POST /channels/battle/outcome, GET /channels/battle/outcome?battleId=).
 *
 * Used by the inline battle scorecard's quality axis. The routes are on the
 * person API (VITE_PERSON_API_URL), served when VITE_PERSON_API_CAPABILITIES
 * names `battle`. chosenByPersonId is derived server-side from the verified
 * token, never sent from here.
 */
import { personApiServes, personUrl } from '@ae/shared';

export type BattleWinner = 'A' | 'B' | 'tie';

export interface BattleOutcome {
  battleId: string;
  /** A = control variant, B = treatment variant */
  winner: BattleWinner;
  chosenByPersonId: string;
  chosenAt: string;
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
    const body = await response
      .json()
      .catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string; code?: string };
    const err = new Error(body.error || `Request failed: ${response.status}`) as Error & { code?: string };
    if (body.code) err.code = body.code;
    throw err;
  }
  return response.json() as Promise<T>;
}

/** Read the recorded pick for a battle, or null if none yet. */
export async function getBattleOutcome(battleId: string): Promise<BattleOutcome | null> {
  const res = await apiCall<{ outcome: BattleOutcome | null }>(
    () => personUrl(`/channels/battle/outcome?battleId=${encodeURIComponent(battleId)}`),
  );
  return res.outcome;
}

/**
 * Record (or overwrite, last-write-wins) this user's pick for a battle.
 * Returns the stored outcome (chosenAt server-stamped).
 */
export async function recordBattleOutcome(
  battleId: string,
  winner: BattleWinner,
  channelArn: string,
): Promise<BattleOutcome> {
  // channelArn is REQUIRED by the API (M2 membership check) — without it the
  // POST is rejected 400 MISSING_CHANNEL_ARN.
  const res = await apiCall<{ outcome: BattleOutcome }>(() => personUrl('/channels/battle/outcome'), {
    method: 'POST',
    body: JSON.stringify({ battleId, winner, channelArn }),
  });
  return res.outcome;
}
