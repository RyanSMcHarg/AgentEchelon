/**
 * Battle side resolution, ON the turn path.
 *
 * A `/battle` is an interactive A/B test, so a duel turn is only worth something if it is what a
 * production turn would have been (MESSAGE-FLOW §6.1). That is why this lives beside the handler
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
 * Everything downstream of the selected side is its PINNED VERSION (DESIGN-SEPARATE-ASSISTANTS §3.7):
 * model, persona addendum, tools, image model, display name and workflow selection, served the way any
 * assistant serves its version.
 *
 * A side classifying differently from its rival is a RESULT, not a defect: classification is part of
 * the flow under test. What must not differ is the CODE that classifies, which is why the intent is
 * passed IN, already produced by the handler's profile-aware classifier.
 */
import { DeliveryOption } from './delivery-options.js';
import { PLATFORM_TASK_MACHINE_KEYS } from './task-state-machines.js';
import { planBattleTaskDelivery } from './delivery-options.js';
import { withTurnDeclaration, type TurnEntry } from './turn-declaration.js';
import { liveBotArnsForClassification, altBotArnFor } from './default-agents.js';
import { resolveBattleSides, type BattleSide } from './experiment-manager.js';
import { duelChallengerOf } from './alt-assignment.js';
import { loadChannelBattleConfig } from './battle-state.js';

export { duelChallengerOf };

/**
 * May this turn answer AS `botArn`, for THIS (classification, role)?
 *
 * THE REASON THIS EXISTS. Under the handoff the caller tells the handler which identity to speak as,
 * because a duel has two sides and the handler otherwise resolves exactly one from its own
 * per-classification SSM parameter. A caller-supplied identity that is never checked is an
 * impersonation seam: anything able to invoke the handler could post as any bot in the app instance.
 *
 * Allowed: this handler's OWN bot (the ordinary case, and the duel's control side), the alt of the SAME
 * (classification, role) - the treatment side, named by its own assignment record (§3.7) - or the LIVE
 * assistant of any role in the same CLASSIFICATION. Nothing else, and an unreadable record set allows
 * only the handler's own bot.
 *
 * THE THIRD CASE IS WHY A SECOND ROLE CAN BE ADDRESSED AT ALL. Measured 2026-09-30: in a premium
 * conversation holding both `advisor` and `ops-premium`, a mention of the ops assistant resolved, the flow claimed the
 * turn and declared the ops identity, and this gate refused it - an ops bot is neither the primary
 * handler's own bot nor the alt of the primary role. The turn fell back to the primary, so Advisor
 * answered a question only Ops can answer, and the only trace was one SecurityEvent line. The intended
 * route - Amazon Chime SDK AUTO invoking the addressed bot's own Lex, where the invocation identifies
 * the assistant and no caller asserts anything - does not apply to a turn the FLOW claimed, and the
 * flow has to claim it to keep one responder per turn.
 *
 * WHAT IT WIDENS, stated correctly because the obvious phrasing is false. It is tempting to say this
 * widens which assistant may answer and never what it may reach; the assistant's vended credentials gate the
 * observability tool and the boundary denies telemetry to every role but `ops`, so a turn
 * admitted as the ops bot reaches telemetry the primary cannot. That IS the feature - an addressed
 * specialist answering with its own reach - so the honest statement is that this admits an assistant to
 * answer AS ITSELF, with its own reach.
 *
 * WHAT BOUNDS IT is the classification: every ARN comes from the deployment's own assignment records
 * read per classification, and the classification comes from the deploy-stamped environment rather than
 * from any caller, so ADR-042 holds. The admitted bot answers as its own assistant because the processor
 * resolves the assistant from the bot it was told to be.
 *
 * SCOPED TO THE PAIR, which is what an alt belongs to: the record read is the alt of this handler's own
 * classification and role, so a premium alt cannot answer in a basic room and, once a classification
 * declares a second role, one role's alt cannot answer for another. ADR-042 says an assistant acts in
 * exactly one classification, and an alt is an assistant.
 *
 * A HANDLER THAT CANNOT NAME ITS ROLE ADMITS NO ALT. An unset `CLASSIFICATION` or `ASSISTANT_ROLE`
 * yields no match. The own-bot path is unaffected: it compares ARNs.
 */
export async function isSanctionedBattleBot(
  botArn: string,
  classificationBotArn: string,
  classification: string,
  role: string,
): Promise<boolean> {
  if (!botArn) return false;
  if (botArn === classificationBotArn) return true;
  // THIS ROLE'S ALT, or A SECOND ROLE'S LIVE ASSISTANT, in this classification. Both read from the
  // assignment records, which are the authority on which assistant holds which role - so a deployment
  // with one assistant returns its own bot here and this case changes nothing for it.
  try {
    if (role && (await altBotArnFor(classification, role)) === botArn) return true;
    return (await liveBotArnsForClassification(classification)).includes(botArn);
  } catch (err) {
    // FAIL CLOSED, and say so. An unreadable record set must refuse rather than admit: the alternative is
    // that a records outage widens who may post.
    console.warn('[battle-turn] could not read the assignment records; admitting the own bot only', {
      classification, err: (err as Error)?.message,
    });
    return false;
  }
}

/**
 * BOTH SIDES OF A DUEL, AS PINNED VERSIONS (DESIGN-SEPARATE-ASSISTANTS §3.7).
 *
 * `self` is the side this turn answers as; `rival` is the other side, read for one thing only: the name
 * a rebuttal and the round-1 awareness note call it by. Each is null when its pin is absent or does not
 * resolve (`battleSideOf`).
 */
export interface DuelSides {
  self: BattleSide | null;
  rival: BattleSide | null;
  /**
   * The duel's experiment is no longer active: paused, completed, deleted or past its end date.
   * A duel turn that reads this ends the duel instead of answering, so an unjudged or decided
   * treatment never keeps answering. Never set on a read failure, which serves the sides as they are.
   */
  ended?: boolean;
}

/**
 * Resolve both sides of the duel in `classification`, from `selfBotArn`'s point of view.
 *
 * The challenger is this classification's alt, named by assistant id and found by the bot its record
 * names; nothing about which side is which rides the caller's payload. Best-effort: a resolver failure
 * degrades to "the side serves its assistant as it is" rather than blocking the duel, and says so.
 *
 * ONE READ OF THE EXPERIMENT PER CALL (`resolveBattleSides`): whether it is still active, the control and
 * the treatment all come from the same row. With `channelArn`, that row is read by the id the conversation's
 * battle config bound at enable (a GetItem); without one, by a scan of the active rows.
 */
export async function resolveDuelSides(args: { classification: string; selfBotArn: string; channelArn?: string }): Promise<DuelSides> {
  let challenger: { assistant: string; botArn: string } | null;
  try {
    challenger = await duelChallengerOf(args.classification);
  } catch (err) {
    console.warn('[battle-turn] the challenger\'s record could not be read; both sides serve their assistants as they are:', err);
    return { self: null, rival: null };
  }
  if (!challenger) return { self: null, rival: null };
  const isChallenger = args.selfBotArn === challenger.botArn;
  // The experiment the conversation's battle was enabled against, when its config names one. The config read
  // is the 60s-cached one every battle turn already makes; a failed read leaves the scan to find the row.
  const experimentId = args.channelArn
    ? (await loadChannelBattleConfig(args.channelArn).catch(() => null))?.experimentId
    : undefined;
  let sides;
  try {
    sides = await resolveBattleSides(challenger.assistant, experimentId ? { experimentId } : {});
  } catch (err) {
    // NEVER READ AS ENDED: an unreadable experiment is not a decision to stop the duel.
    console.warn('[battle-turn] the duel\'s experiment could not be read; both sides serve their assistants as they are:', err);
    return { self: null, rival: null };
  }
  if (!sides.active) return { self: null, rival: null, ended: true };
  const { control, treatment } = sides;
  return { self: isChallenger ? treatment : control, rival: isChallenger ? control : treatment };
}

/**
 * A TASK-SHAPED DUEL IS HANDLED, through ONE creation door (ADR-024, DESIGN-BATTLE §8). When a side
 * resolves to `TASK_MULTI_STEP` the handler calls the ordinary `createTask` with an ASSISTANT owner
 * and the battle id attached. `createBattleTask` is deleted: it was a near-duplicate that existed
 * only to force those two things, and because it was a separate branch it was tested BEFORE the
 * ordinary active-task lookup - so a resumed side created a fresh task every turn and restarted its
 * state machine from state 0.
 *
 * What keeps two sides' chains apart is the OWNER being that side. The battle id is descriptive.
 */
export interface BattleSideResolution {
  deliveryOption: DeliveryOption;
  taskType?: string;
  /** This side's pinned version. Null when nothing is bound - the side then serves its assistant as it is. */
  selfVariant: BattleSide | null;
  /** The rival side's name, from its profile (`battleSideNames`). Undefined when it does not resolve. */
  rivalName?: string;
  /** The duel's experiment is no longer active (DuelSides.ended): the caller ends the duel and does not answer. */
  ended?: boolean;
}

/**
 * Resolve everything this side of the duel needs, from the intent the handler already classified.
 *
 * WHAT THE SIDE SERVES IS ITS PINNED VERSION, whole: model, persona and addendum, tools, image model,
 * display name and workflow selection all come from the one version, exactly as they would for any
 * assistant serving that version. Nothing about the variant rides the turn beside it.
 */
export async function resolveBattleSide(args: {
  /** The duel's classification: its challenger is that classification's alt. */
  classification: string;
  selfBotArn: string;
  /** The duel's conversation, so its experiment is read by the id its battle config bound (`resolveDuelSides`). */
  channelArn?: string;
  /** The intent the handler's profile-aware classifier produced for THIS side. */
  intent: string;
  /** What that intent needs, from its definition in the served pack (`needsOf`). Absent ⇒ the platform's. */
  need?: string;
  /**
   * The workflow selection of the version the turn resolved, used only when this side has no pinned
   * version (ADR-047). A side with a pinned version is gated by that version's own selection, the way
   * any assistant's turn is gated by the version it serves.
   */
  workflowSelection?: string[];
  /** Both sides, when the caller already resolved them, so they are read once per turn. */
  sides?: DuelSides;
}): Promise<BattleSideResolution> {
  const sides = args.sides ?? await resolveDuelSides(args);
  const { self, rival } = sides;

  // A SIDE WITH NO IMAGE MODEL FOR AN IMAGE INTENT IS REFUSED AT ARMING (ADR-064 decision 7, `battleImageRefusal` in
  // manage-profiles.ts), so a duel never reaches a turn that would have to say so.

  // ── THE GATE READS THE VERSION THAT WILL ACTUALLY SERVE THIS SIDE (ADR-047) ──────────────────
  //
  // The pinned version's own selection, unset meaning every available workflow, as it means for any
  // version. Only a side with no pinned version falls back to the selection the turn resolved.
  const selection = self ? self.variantProfile.workflows : args.workflowSelection;
  const mayOpen = (t: string): boolean => !selection?.length
    || (PLATFORM_TASK_MACHINE_KEYS as readonly string[]).includes(t)
    || selection.includes(t);
  const plan = planBattleTaskDelivery(args.intent, mayOpen);

  return {
    deliveryOption: plan.deliveryOption,
    ...(plan.taskType && { taskType: plan.taskType }),
    selfVariant: self,
    ...(rival?.displayName && { rivalName: rival.displayName }),
    ...(sides.ended && { ended: true }),
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
 *
 * ── AND IT DECLARES WHAT IT ANSWERS, ON THE SAME CARRIER EVERY OTHER PLACEHOLDER USES ───────────
 *
 * A duel side is the population where the id is FREE and the turn is SLOW, which is the worst
 * possible combination to leave undeclared. The round-1 fan-out hands the turn the user's
 * `MessageId` (`channel-flow-processor.ts` sets `userMessageId`, which the router reads back as
 * `AE.message.id`), so the side already holds the fact; and a duel runs two model calls per round,
 * so its time to first feedback routinely exceeds the five second Kinesis batching window. Beyond
 * that window the in-batch pairer never sees the turn and the cross-batch sweep mints the exchange
 * from the placeholder CREATE alone, where an undeclared pairing is recorded `paired_by = 'swept'`
 * and excluded from TTFF by design (migration 042). The slowest turns in the system were therefore
 * the ones dropped from the measurement that exists to catch them.
 *
 * Declared here rather than at the two call sites so both duel branches of the router - the
 * task-shaped one and the placeholder-shaped one - cannot drift apart, which is the same reason the
 * `name=` part is composed here.
 *
 * NO PHASE AND NO KIND ARE DECLARED. This message is a placeholder and the worker's update closes
 * it, so `phase` would close the response the instant it opened; and `kind` is a closed set of
 * non-answers (`turn-declaration.ts`), which a duel side is not - it is an answer, delivered twice.
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
  /**
   * The `MessageId` this side answers, WHEN THE CALLER ALREADY HOLDS IT. Omitted or empty declares
   * nothing, which leaves the turn exactly where it was: paired by the sweep's heuristic.
   *
   * ONLY A PERSON'S MESSAGE BELONGS HERE. Round 1 answers the `/battle` message and names it. A
   * round-2 rebuttal answers the RIVAL'S reply - nobody asked for it and nobody is waiting on it -
   * so naming the originating message would file the rebuttal as a declared answer to a question
   * that had already been answered, at a latency spanning both rounds. That is the number
   * LATENCY-TARGETS excludes a rebuttal from, arriving through the door marked "declared, therefore
   * exact". The orchestrator's round-2 placeholder passes nothing here for that reason.
   *
   * Never bought: no call site may read the channel to fill this in. A turn that does not know
   * declares nothing and the update fold repairs it later (`backfillFromUpdateEvents`), which costs
   * a late repair rather than a channel read in front of the person's first frame.
   */
  answersMessageId?: string;
  /**
   * HOW THE SIDE'S TURN ENTERED (`TurnEntry`), declared on the placeholder for the reason the ordinary
   * placeholder declares it: a placeholder a side closes out as a receipt carries no analytics of its own,
   * and the content declaration is the carrier archival reads last. The orchestrator's round-2
   * placeholder passes nothing; that turn is the platform's and its processor records so.
   */
  entry?: TurnEntry;
}): string {
  const namePart = args.displayName ? `,name=${encodeURIComponent(args.displayName)}` : '';
  const rivalRef = args.rivalReplyMsgId ? `,rivalReplyMsgId=${args.rivalReplyMsgId}` : '';
  const lead = args.lead?.trim() || 'One moment...';
  const content = `${lead} <!--corr:${args.correlationId}-->`
    + `<!--battle:battleId=${args.battleId},round=${args.round},total=${args.totalRounds},`
    + `rivalArn=${args.rivalBotArn}${rivalRef}${namePart}-->`;
  return withTurnDeclaration(
    content,
    {
      ...(args.answersMessageId ? { answers: args.answersMessageId } : {}),
      ...(args.entry ? { entry: args.entry } : {}),
    },
  );
}
