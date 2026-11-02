/**
 * THE PROFILE A TURN RUNS UNDER IS THE ADDRESSED ASSISTANT'S, resolved once from the bot's assignment record.
 *
 * A profile belongs to an ASSISTANT, and a classification can have several: `premium` holds `advisor`
 * (its primary) and `ops-premium` (the `ops` role). So every per-assistant setting a turn reads - the
 * classifier mode, the rate limit, the classifier model, the onboarding intake, the copy - has to come
 * from the assistant the turn was addressed to. Reading them from `requireProfileFor(classification)`
 * reads the classification's primary, which answers a turn addressed to `ops-premium` with `advisor`'s
 * settings.
 *
 * ONE RESOLUTION, MANY READERS. The router resolves this once per turn and passes the result to every
 * per-assistant read of that turn. The paths that speak outside the router (`triage-on-arrival`,
 * `private-command`, `conversation-management`) resolve the speaking bot through `turnAssistantProfileForBot`,
 * which applies the same decision to the same assignment records.
 *
 * Deployment-time fields (`classifierMode`, `rateLimitPerHour`, ...) are read from the returned
 * `profile` directly; versioned fields (`models.classifier`, `onboarding`, `persona`, `copy`) are read
 * from `resolveActiveProfile(profile.name)`.
 *
 * ── WHEN A TURN IS DECLINED ─────────────────────────────────────────────────────────────────────
 *
 * The decision never substitutes one assistant's settings for another's (tenet P4, ADR-046). A turn
 * whose assistant cannot be named is declined, and the caller ends it with no reply and a
 * `[SecurityEvent]` log:
 *
 * - `no-classification`: the classification is unset or not declared by this deployment.
 * - `undeclared-assistant`: the bot's assignment record names an assistant this deployment neither
 *   declares nor assigns at runtime.
 * - `assistant-index-unreadable`: the assignment records could not be read and the classification has
 *   more than one assistant, so the addressed one is unknown.
 * - `no-assignment-record`: the records were read, no record names an assistant for the bot, and the bot is
 *   not the classification's own primary bot.
 *
 * One case answers on the classification's primary, and it is not a substitution: a classification that
 * has ONE assistant answers when its records cannot be read, because the primary IS that assistant.
 *
 * A RUNTIME ASSISTANT (ADR-048) is assigned by its own record, which the caller turns into a seed
 * (`runtimeSeedFor`) and passes as `runtimeSeed`. It answers on that seed and its own active version.
 *
 * THE ALT (a duel's challenger) is the assistant `alt-{role}-{classification}` (ADR-050), with its own
 * profile published through its experiment. It answers on that profile; a role whose alt this deployment
 * does not declare is declined like any other undeclared assistant. Whether an alt bot may take a turn at
 * all is decided before this, by the battle sanction (`isSanctionedBattleBot`).
 */
import type { AssistantProfile } from '../../../lib/config/profiles.js';

/** The registry reads this needs, so a test can pass a registry of its own. */
export interface TurnAssistantRegistry {
  profileByName(name: string): AssistantProfile | undefined;
  /** The classification's primary, or undefined for a classification this deployment does not declare. */
  profileFor(classification: string): AssistantProfile | undefined;
  /** The roles the classification has, `primary` included. One entry means one assistant. */
  rolesFor(classification: string): string[];
  /** The alt's name for a role (`alt-{role}-{classification}`), or undefined for an undeclared role. */
  altAssistantName(classification: string, role: string): string | undefined;
  /** The alt's deploy-time descriptor, under its own name. */
  altSeedFor(name: string): AssistantProfile | undefined;
}

export type AssistantDeclineReason =
  | 'no-classification'
  | 'undeclared-assistant'
  | 'assistant-index-unreadable'
  | 'no-assignment-record';

export type TurnAssistantProfile =
  | {
    decision: 'answer';
    /** The profile every per-assistant read of this turn uses. */
    profile: AssistantProfile;
    /**
     * `assigned`: the addressed assistant's own record. `primary`: the classification's own primary bot,
     * or the only assistant of a single-assistant classification. `alt`: a duel's challenger.
     */
    source: 'assigned' | 'primary' | 'alt';
  }
  | { decision: 'decline'; reason: AssistantDeclineReason };

export function turnAssistantProfile(args: {
  /** The classification the turn runs at. Empty means unset, which declines. */
  classification: string;
  /** False when the assignment records could not be read. */
  assistantIndexLoaded: boolean;
  /** The assistant the bot's assignment record names, if any. */
  assignedAssistant: string | undefined;
  /** The seed of a runtime assistant, built from the bot's own record. Absent for a deploy-time assistant. */
  runtimeSeed?: AssistantProfile;
  /** True when the bot's record is an `alt` occupancy (a duel's challenger). */
  isAltAssistant: boolean;
  /** The role the alt challenges, from its assignment record. Required to name the alt. */
  altRole?: string;
  /** True when the bot is the classification's own primary bot. */
  primaryBot: boolean;
  registry: TurnAssistantRegistry;
}): TurnAssistantProfile {
  const primary = args.classification ? args.registry.profileFor(args.classification) : undefined;
  if (!primary) return { decision: 'decline', reason: 'no-classification' };
  if (args.isAltAssistant) {
    const altName = args.altRole ? args.registry.altAssistantName(args.classification, args.altRole) : undefined;
    const altProfile = altName ? args.registry.altSeedFor(altName) : undefined;
    return altProfile
      ? { decision: 'answer', profile: altProfile, source: 'alt' }
      : { decision: 'decline', reason: 'undeclared-assistant' };
  }
  if (!args.assistantIndexLoaded) {
    return args.registry.rolesFor(args.classification).length === 1
      ? { decision: 'answer', profile: primary, source: 'primary' }
      : { decision: 'decline', reason: 'assistant-index-unreadable' };
  }
  if (args.assignedAssistant) {
    const own = args.registry.profileByName(args.assignedAssistant)
      ?? (args.runtimeSeed?.name === args.assignedAssistant ? args.runtimeSeed : undefined);
    return own
      ? { decision: 'answer', profile: own, source: 'assigned' }
      : { decision: 'decline', reason: 'undeclared-assistant' };
  }
  return args.primaryBot
    ? { decision: 'answer', profile: primary, source: 'primary' }
    : { decision: 'decline', reason: 'no-assignment-record' };
}

/**
 * The `[SecurityEvent]` line for a declined turn, in one shape for every caller, so an operator searching
 * for one finds them all.
 */
export function logAssistantDecline(
  logPrefix: string,
  reason: AssistantDeclineReason,
  detail: Record<string, unknown>,
): void {
  console.error(`${logPrefix}[SecurityEvent] the addressed assistant cannot be named; the turn is declined `
    + 'with no reply rather than answered on another assistant\'s settings', { reason, ...detail });
}

/** One live assignment record, as `liveAssistantsByHandleOrThrow` returns it. */
interface LiveAssistant { botArn: string; role: string; runtimeSeed?: AssistantProfile }

/**
 * The same decision for a path outside the router: the assignment record of the bot that is about to speak, read from
 * the live assignment records (`default-agents`).
 *
 * Alts are not in the live records, so an alt bot resolves to `no-assignment-record` here; none of these
 * paths speaks as a duel's challenger.
 */
export async function turnAssistantProfileForBot(args: {
  botArn: string;
  classification: string;
  /** The classification's own primary bot, when the caller knows it. */
  classificationBotArn?: string;
  registry: TurnAssistantRegistry;
  /** The live assistants by handle. Throws when the records cannot be read. */
  liveAssistants: (classification: string) => Promise<Map<string, LiveAssistant>>;
}): Promise<TurnAssistantProfile & { role?: string }> {
  let assignedAssistant: string | undefined;
  let runtimeSeed: AssistantProfile | undefined;
  let role: string | undefined;
  let assistantIndexLoaded = false;
  if (args.classification) {
    try {
      const live = await args.liveAssistants(args.classification);
      assistantIndexLoaded = true;
      for (const [handle, assistant] of live) {
        if (assistant.botArn === args.botArn) { assignedAssistant = handle; role = assistant.role; runtimeSeed = assistant.runtimeSeed; break; }
      }
    } catch {
      assistantIndexLoaded = false;
    }
  }
  const decision = turnAssistantProfile({
    classification: args.classification,
    assistantIndexLoaded,
    assignedAssistant,
    runtimeSeed,
    isAltAssistant: false,
    primaryBot: !!args.classificationBotArn && args.botArn === args.classificationBotArn,
    registry: args.registry,
  });
  return decision.decision === 'answer' && role ? { ...decision, role } : decision;
}
