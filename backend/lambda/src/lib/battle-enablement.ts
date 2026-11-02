/**
 * ── MAY A DUEL RUN IN THIS CLASSIFICATION? TWO QUESTIONS, ASKED IN ORDER ────────────────────────
 *
 * ADR-049. `battleEligible` on an assistant profile asked both at once and its two answers disagreed:
 * it was `true` for every conversational profile INCLUDING basic, whose stack wires no battle plumbing
 * at all (`battleCapable: false`). So `channel-battle.ts` accepted an enable on a basic channel whose
 * processor holds none of the grants a duel needs, and the failure arrived later as a permissions
 * error rather than as a refusal anybody could act on.
 *
 *   CAPABLE  - does this classification's DEPLOYMENT wire the battle plumbing (battle-state grant,
 *              orchestrator invoke, image guardrail). A deploy-time fact, read from the registry,
 *              and the same field the stack itself builds from, so the surface and the grant cannot
 *              drift apart again.
 *   ON       - has an operator TURNED BATTLE ON for this classification. Runtime policy, held in SSM,
 *              classification-level rather than per assistant, and OFF unless somebody says otherwise.
 *
 * THE ORDER IS THE POINT. Capability is checked first and the toggle is never offered for a
 * classification that lacks it, so an operator cannot switch on something with no grant behind it.
 * Policy alone can never widen what the deployment built.
 *
 * WHY OFF BY DEFAULT: battle is "typically only used for internal users", so a
 * deployment that has not asked for it does not get it. Every conversational classification was
 * eligible before this, which is the behavior change.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { sessionClient } from './assistant-session.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const ssm = sessionClient(SSMClient, { region: AWS_REGION });

/** Matches the profile-definition read (`active-profile.ts`), so an operator's toggle takes effect on
 *  the same timescale as an operator's profile edit and nobody has to learn a second number. */
const BATTLE_ON_TTL_MS = 30_000;

/** The parameter an operator's toggle writes. One per classification, which is the level the setting
 *  is defined at - not per assistant, because a room has one classification and any number of
 *  assistants in it. */
export function battleOnParamName(classification: string): string {
  return `${SSM_ROOT}/battle/${classification}/enabled`;
}

const cache = new Map<string, { value: boolean; at: number }>();

/** TEST SEAM, and the same one `active-profile` exposes for the same reason: a cached answer that
 *  outlives a test makes the next one assert the previous one's state. */
export function __clearBattleEnablementCache(): void {
  cache.clear();
}

/**
 * Does the DEPLOYMENT support a duel here. Synchronous: it is compiled classification config, which
 * ADR-048 keeps in the registry precisely because it is a deploy-time fact read at runtime.
 */
export function isBattleCapable(classification: string | null | undefined): boolean {
  return profiles.isBattleCapable(classification);
}

/**
 * Has an operator turned battle ON here.
 *
 * FAIL CLOSED, LOUDLY ENOUGH TO FIND. An unreadable parameter answers false, because "we could not
 * tell" and "it is on" must never be the same answer for a feature that puts a second assistant in
 * somebody's conversation. `ParameterNotFound` is the ordinary not-configured case and stays quiet;
 * anything else is a real fault and is logged.
 */
export async function isBattleOn(classification: string | null | undefined): Promise<boolean> {
  if (!classification) return false;
  // CAPABILITY FIRST, so a classification the deployment never wired cannot be switched on by a
  // parameter somebody wrote by hand. This is also what makes the read cheap for basic: no SSM call.
  if (!isBattleCapable(classification)) return false;

  const hit = cache.get(classification);
  if (hit && Date.now() - hit.at < BATTLE_ON_TTL_MS) return hit.value;

  let value = false;
  try {
    const resp = await ssm.send(new GetParameterCommand({ Name: battleOnParamName(classification) }));
    value = resp.Parameter?.Value === 'true';
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name !== 'ParameterNotFound') {
      console.warn('[battle-enablement] could not read the battle setting; treating battle as OFF', {
        classification, err: name ?? err,
      });
    }
  }
  cache.set(classification, { value, at: Date.now() });
  return value;
}

/**
 * THE ONE QUESTION EVERY CALLER ACTUALLY HAS: may a duel run in this classification right now.
 *
 * Both halves, in order, so no caller can accidentally ask only the policy half and offer a surface
 * the deployment cannot serve. That mistake is the entire reason this module exists.
 */
export async function canRunBattle(classification: string | null | undefined): Promise<boolean> {
  return isBattleOn(classification);
}
