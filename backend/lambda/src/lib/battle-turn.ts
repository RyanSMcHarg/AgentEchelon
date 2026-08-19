/**
 * Battle side resolution, ON the turn path.
 *
 * A `/battle` is an interactive A/B test, so a duel turn is only worth something if it is what a
 * production turn would have been (MESSAGE-FLOW §3.2). That is why this lives beside the handler
 * rather than in the fan-out: resolving a side's variant, its delivery option and its image model in
 * the flow made a SECOND resolution path, and a second path diverges silently - the duel still
 * answers, so nothing errors. It is the defect that let an image duel run as a text duel for three
 * sessions with nothing in any log to explain it.
 *
 * WHAT IS BATTLE-SPECIFIC HERE, STATED PLAINLY, because "the same as an ordinary turn" is not quite
 * true and the difference is the point of the feature:
 *   - variant SELECTION is deterministic (this side is the control, that side is the treatment)
 *     rather than probabilistic. That IS the experiment.
 *   - `DIRECT` is never chosen: a duel always produces a generated reply, so a greeting in a battle
 *     is still answered by the model.
 * Everything downstream of the selected variant - model, persona, tools, image model - is the
 * ordinary resolution the handler already performs, unchanged.
 *
 * A side classifying differently from its rival is a RESULT, not a defect: classification is part of
 * the flow under test. What must not differ is the CODE that classifies, which is why the intent is
 * passed IN, already produced by the handler's profile-aware classifier.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DeliveryOption } from './delivery-options.js';
import { planBattleTaskDelivery } from './delivery-options.js';
import {
  resolveBattleVariantBySlotArn,
  resolveBattleControlVariantByAltSlotArn,
  resolveBattleImageGenPair,
} from './experiment-manager.js';

const ALT_BOT_SLOTS_ROSTER_PARAM =
  process.env.ALT_BOT_SLOTS_ROSTER_PARAM || '/agent-echelon/alt-bot-slots/roster';

type BattleVariant =
  | Awaited<ReturnType<typeof resolveBattleVariantBySlotArn>>
  | Awaited<ReturnType<typeof resolveBattleControlVariantByAltSlotArn>>;

/** Cached per warm container: the roster changes only on deploy. */
let rosterCache: string[] | null = null;

/**
 * The alt-slot bot ARNs, from the roster the battle stack publishes.
 *
 * Fails CLOSED to an empty list: an unreadable roster must reject every caller-supplied identity
 * rather than wave them through. A battle that cannot validate its slot is a battle that does not
 * run, which is recoverable; an unvalidated identity is not.
 */
export async function altSlotBotArns(ssm: SSMClient): Promise<string[]> {
  if (rosterCache) return rosterCache;
  try {
    const resp = await ssm.send(new GetParameterCommand({ Name: ALT_BOT_SLOTS_ROSTER_PARAM }));
    const parsed = JSON.parse(resp.Parameter?.Value || '[]') as Array<{ botArn?: unknown }>;
    rosterCache = parsed
      .map((s) => (typeof s?.botArn === 'string' ? s.botArn : ''))
      .filter(Boolean);
    return rosterCache;
  } catch (err) {
    console.error('[battle-turn] alt-bot roster unreadable; rejecting caller-supplied identities', err);
    return [];
  }
}

/**
 * May this turn answer AS `botArn`?
 *
 * THE REASON THIS EXISTS. Under the handoff the caller tells the handler which identity to speak as,
 * because a duel has two sides and the handler otherwise resolves exactly one from its own
 * per-classification SSM parameter. A caller-supplied identity that is never checked is an
 * impersonation seam: anything able to invoke the handler could post as any bot in the app instance.
 *
 * Allowed: the classification's OWN bot (the ordinary case, and the duel's control side), or a bot in
 * the published alt-slot roster (the treatment side). Nothing else, and an unreadable roster allows
 * only the classification's own bot.
 */
export async function isSanctionedBattleBot(
  botArn: string,
  classificationBotArn: string,
  ssm: SSMClient,
): Promise<boolean> {
  if (!botArn) return false;
  if (botArn === classificationBotArn) return true;
  return (await altSlotBotArns(ssm)).includes(botArn);
}

/**
 * NOT YET HANDLED, and stated here rather than discovered later: when a side resolves to
 * `TASK_MULTI_STEP`, the handler's task branch calls `createTask`, not `createBattleTask`. A duel's
 * task must be assigned to THAT bot and carry the battle id, which is how the continuation router
 * tells a TASK_* duel from a placeholder one and how the orchestrator knows round 1 is terminal.
 * Routing a duel through the ordinary task path would produce a task with no battle binding - and it
 * would still answer, so nothing would error.
 *
 * The battle entry is therefore NOT ready for a task-shaped duel. Wiring the fan-out to it must land
 * together with battle-aware task creation. See DESIGN-BATTLE §8.
 */
export interface BattleSideResolution {
  deliveryOption: DeliveryOption;
  taskType?: string;
  /** This side's variant. Null when nothing is bound - the worker then resolves normally. */
  selfVariant: BattleVariant;
  /** The rival's variant, for the display name woven into a rebuttal. */
  rivalVariant: BattleVariant;
  /** This side's image-generation model, on a generation-out duel only. */
  imageGenModelId?: string;
}

/**
 * Resolve everything this side of the duel needs, from the intent the handler already classified.
 *
 * Best-effort by design on the variant/image resolvers: a resolver hiccup must degrade to "the worker
 * resolves normally" rather than block the duel. The delivery option is not best-effort - it decides
 * whether a task exists - so a classification failure upstream is the caller's problem, not something
 * to paper over here.
 */
export async function resolveBattleSide(args: {
  /** The treatment slot. Empty ⇒ nothing is bound; both variants resolve null. */
  altSlotArn: string;
  selfBotArn: string;
  /** The intent the handler's profile-aware classifier produced for THIS side. */
  intent: string;
}): Promise<BattleSideResolution> {
  const plan = planBattleTaskDelivery(args.intent);
  const isAltSlot = !!args.altSlotArn && args.selfBotArn === args.altSlotArn;

  let control: BattleVariant = null;
  let treatment: BattleVariant = null;
  let imagePair: { controlModelId: string; treatmentModelId: string } | null = null;

  if (args.altSlotArn) {
    const [c, t, pair] = await Promise.all([
      resolveBattleControlVariantByAltSlotArn(args.altSlotArn).catch((err) => {
        console.warn('[battle-turn] control variant resolution failed; worker resolves normally:', err);
        return null;
      }),
      resolveBattleVariantBySlotArn(args.altSlotArn).catch((err) => {
        console.warn('[battle-turn] treatment variant resolution failed; worker resolves normally:', err);
        return null;
      }),
      resolveBattleImageGenPair(args.altSlotArn).catch((err) => {
        console.warn('[battle-turn] image pair resolution failed; text duel:', err);
        return null;
      }),
    ]);
    control = c;
    treatment = t;
    imagePair = pair;
  }

  // SAY SO when an image request degrades to a text duel. `null` is indistinguishable from "this is a
  // text battle", so an image duel whose experiment could not be resolved produced a normal-looking
  // duel with no image, no error and nothing to explain it - a full investigation cycle.
  if (args.intent === 'image_generation' && !imagePair) {
    console.warn(
      '[battle-turn] image_generation turn but NO image pair resolved; this side runs as TEXT. The '
      + 'bound experiment carries no imageGenModelKey on both variants, or no experiment is bound to '
      + 'the alt slot.',
      { altSlotArn: args.altSlotArn, selfBotArn: args.selfBotArn },
    );
  }

  return {
    deliveryOption: plan.deliveryOption,
    ...(plan.taskType && { taskType: plan.taskType }),
    selfVariant: isAltSlot ? treatment : control,
    rivalVariant: isAltSlot ? control : treatment,
    ...(imagePair && {
      imageGenModelId: isAltSlot ? imagePair.treatmentModelId : imagePair.controlModelId,
    }),
  };
}

/**
 * The placeholder a battle side posts, markers included.
 *
 * Composed HERE rather than by the caller because the `name=` part is the resolved variant's display
 * name, and resolving the variant is a turn decision. That coupling is the whole reason the fan-out
 * used to resolve variants at all; with the turn producing the placeholder, the caller only posts it.
 *
 * The frontend renders a working state ("<name> is drafting...") off `name=` immediately, without
 * waiting for the round-1 battlestats marker.
 */
export function battlePlaceholderContent(args: {
  correlationId: string;
  battleId: string;
  round: 1 | 2;
  totalRounds: number;
  rivalBotArn: string;
  displayName?: string;
  rivalReplyMsgId?: string;
  /**
   * The VISIBLE copy that precedes the markers. Defaults to the ordinary acknowledgment.
   *
   * A task-shaped duel side passes its task placeholder here (ADR-026), so a side that opened a
   * multi-step chain says so rather than claiming "One moment..." for work that will take several
   * exchanges. The markers are what the frontend parses; the lead is what the user reads, and the two
   * were fused only because no caller had ever needed a different lead.
   */
  lead?: string;
}): string {
  const namePart = args.displayName ? `,name=${encodeURIComponent(args.displayName)}` : '';
  const rivalRef = args.rivalReplyMsgId ? `,rivalReplyMsgId=${args.rivalReplyMsgId}` : '';
  const lead = args.lead?.trim() || 'One moment...';
  return (
    `${lead} <!--corr:${args.correlationId}-->`
    + `<!--battle:battleId=${args.battleId},round=${args.round},total=${args.totalRounds},`
    + `rivalArn=${args.rivalBotArn}${rivalRef}${namePart}-->`
  );
}

/** Test seam: drop the warm-container roster cache. */
export function __resetRosterCacheForTests(): void {
  rosterCache = null;
}
