/**
 * THE DUEL'S CHALLENGER, read from its assignment record.
 *
 * A duel is the room's primary against the alt of the same role (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION
 * §3.7, ADR-050). The alt is the assistant `alt-{role}-{classification}`, provisioned by its classification's
 * stack like the live assistants: its own `AppInstanceBot` and its own Amazon Lex bot on that classification's
 * router. Its record, `/{root}/assistant-assignments/{classification}/{role}/alt`, names the bot it answers
 * as and the Lex bot a targeted reply arrives on, and names the assistant only while an experiment holds it.
 *
 * One challenger per `(classification, role)` is structural: it is the record's key.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { AssignmentRecord } from './runtime-assistant.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { altBotArnFor } from './default-agents.js';

/** The role a duel's two sides hold: the room's primary and that role's alt. */
export const DUEL_ROLE = 'primary';

/**
 * THE ATTRIBUTES A BATTLE ROW CARRIED BEFORE IT NAMED ITS CHALLENGER BY ASSISTANT ID.
 *
 * Experiment and conversation battle config rows written before the re-key hold a console handle
 * (`altBotSlotId`) and the challenger's bot ARN (`altBotSlotArn`). They are persisted DynamoDB
 * attribute names, so they keep their spelling, and the readers accept both. Every write stores
 * `challengerAssistant` only (`withoutLegacyBinding`), so a fresh deployment holds no row of the earlier shape.
 */
export interface LegacyBattleBinding {
  altBotSlotId?: string;
  altBotSlotArn?: string;
}

/**
 * THE CHALLENGER A BATTLE ROW NAMES: its assistant id, `alt-{role}-{classification}` (ADR-050).
 *
 * A row written after the re-key names it (`challengerAssistant`). A row written before names a console
 * handle instead, and a battle runs in exactly one classification and one role (`DUEL_ROLE`), so the
 * handle's presence means "this classification's alt" and the id is derived from the classification.
 * Undefined for a row that binds no challenger.
 */
export function challengerOf(
  row: { challengerAssistant?: string; 'tiers'?: unknown } & LegacyBattleBinding,
): string | undefined {
  if (row.challengerAssistant) return row.challengerAssistant;
  if (!row.altBotSlotId) return undefined;
  const classification = Array.isArray(row.tiers) && row.tiers.length === 1 ? String(row.tiers[0]) : '';
  return classification ? profiles.altAssistantName(classification, DUEL_ROLE) : undefined;
}

/**
 * THE DUEL'S CHALLENGER IN `classification`: its assistant id and the bot it answers as, both read from
 * the deployment rather than from any caller. The id is the registry's (`alt-{role}-{classification}`),
 * and the bot is the one the alt's assignment record names (`altBotArnFor`). Null when the classification
 * declares no alt, or the record names no bot. A record set that cannot be read throws.
 */
export async function duelChallengerOf(classification: string): Promise<{ assistant: string; botArn: string } | null> {
  const assistant = profiles.altAssistantName(classification, DUEL_ROLE);
  if (!assistant) return null;
  const botArn = await altBotArnFor(classification, DUEL_ROLE);
  return botArn ? { assistant, botArn } : null;
}

/** The row without the attributes the re-key retires, so a write never carries them forward. */
export function withoutLegacyBinding<T extends object>(row: T & LegacyBattleBinding): T {
  const { altBotSlotId: _handle, altBotSlotArn: _arn, ...rest } = row;
  return rest as T;
}

/** The alt's record as the classification stack writes it and an armed experiment rewrites it. */
export interface AltAssignment extends AssignmentRecord {
  classification: string;
  role: string;
  occupancy: 'alt';
  botArn: string;
  /** The alt's assistant name while an experiment holds it; null between battles. */
  assistant: string | null;
  /** The experiment that put the assistant there, cleared with it. */
  experimentId?: string | null;
}

/** The parameter holding the alt's record for one `(classification, role)`. */
export function altAssignmentName(ssmRoot: string, classification: string, role: string = DUEL_ROLE): string {
  return `${ssmRoot}/assistant-assignments/${classification}/${role}/alt`;
}

/**
 * The alt's record, or null when the classification provisions no alt for the role (battle is not wired
 * there) or the record does not name a bot. A read that fails for any other reason throws, so a caller
 * never mistakes an outage for an alt that does not exist.
 */
export async function readAltAssignment(
  ssm: Pick<SSMClient, 'send'>,
  ssmRoot: string,
  classification: string,
  role: string = DUEL_ROLE,
): Promise<AltAssignment | null> {
  if (!classification || !role) return null;
  let raw: string | undefined;
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: altAssignmentName(ssmRoot, classification, role) }));
    raw = res.Parameter?.Value;
  } catch (err) {
    if ((err as { name?: string })?.name === 'ParameterNotFound') return null;
    throw err;
  }
  let parsed: Partial<AltAssignment>;
  try {
    parsed = JSON.parse(raw || '{}') as Partial<AltAssignment>;
  } catch {
    return null;
  }
  if (!parsed.botArn) return null;
  return {
    ...parsed,
    classification,
    role,
    occupancy: 'alt',
    botArn: parsed.botArn,
    assistant: parsed.assistant ?? null,
  };
}
