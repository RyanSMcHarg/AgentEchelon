/**
 * POST-PROCESSING RULE: a task answer that reached no assistant (ADR-032, ADR-030).
 *
 * THE DEFECT IT MEASURES. A person answers a question an assistant asked them, in a conversation with
 * more than one member, and addresses nobody. `InvokedBy` (`StandardMessages: NONE`) invokes Lex only
 * for a targeted message, and above a 1:1 the channel flow dispatches only an addressed one, so nothing
 * is invoked: their answer sits in the channel, the chain it would unblock stays blocked, and nothing
 * errors. The conversation simply stops, and the person is left re-reading what they typed.
 *
 * WHY IT RUNS IN POST-PROCESSING AND NOT IN THE CHANNEL FLOW. The client addresses a task answer at
 * send - it rendered the item, so it knows which task is being answered - and a message arriving
 * without that address is a CLIENT defect. ADR-032 tenet 3: repairing a client defect on the critical
 * path makes the correct path and the broken path indistinguishable, so nobody fixes the client and
 * the repair becomes the primary path by default. Tenet 5 is the cost half of the same argument: after
 * the fact this costs time only in the broken case, where the same rule inline would cost every turn
 * in every conversation to buy nothing on the ones that were already right.
 *
 * It also could not run there. The channel flow callback carries no `Target` at all (* and the table in MESSAGE-FLOW Appendix B), so the flow cannot tell an addressed message from an
 * unaddressed one; the message stream carries both `Target` and `Metadata`. Any rule about how a
 * message was ADDRESSED can only run after the fact.
 *
 * WHAT IT IS NOT. Not a second implementation of a turn. It resolves who owes the answer and hands the
 * turn to that assistant's router over the same bypass every other entry uses, so a repaired turn is
 * the ordinary turn, late. Nothing about classification, profile, variant or delivery is decided here.
 *
 * TENET 6, AND IT IS THE REASON THIS FILE EMITS METRICS AT ALL. A fix that silently succeeds is
 * indistinguishable from the defect not existing. `Repairs` says how often the client is getting it
 * wrong, so the client defect stays measurable and someone can close it. A repair nobody can see is a
 * permanent one.
 */

import { ChimeSDKMessagingClient } from '@aws-sdk/client-chime-sdk-messaging';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { extractTaskAnswerHint } from './task-answer-metadata.js';
// TASKS GO THROUGH THE STORE SEAM, not the table. Same signatures; the boundary is inside.
import { getTask } from './task-store.js';
import { principalIdFromArn, resolveTaskAssignee } from './task-tracking.js';
import { claimCorrelation, flowDeliveryKey, hasCorrelationClaim } from './abuse-controls.js';
import { readChannelClassificationTag } from './channel-classification.js';
import { resolveChannelSize } from './channel-size.js';
import { flowBypassToken } from './flow-bypass.js';
import { parseTaskReference } from './task-reference.js';
import type { MessageStreamEvent } from './message-stream-event.js';
import type { TurnRequest } from '../router-agent-handler.js';
import { resolveRouterArn } from './router-arn.js';
import { emitEmfMetric } from './emf-metrics.js';
import { sessionClient } from './assistant-session.js';
import { appInstanceArnOf, botArnFor } from './person-arn.js';
import { decodeContent } from './chime/history.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const messagingClient = sessionClient(ChimeSDKMessagingClient, { region: AWS_REGION });
const lambdaClient = sessionClient(LambdaClient, { region: AWS_REGION });

/** EMF namespace. One metric name per outcome, so an alarm needs no log-metric-filter. */
const METRIC_NAMESPACE = 'AgentEchelon/TaskAnswerRepair';

/**
 * The message attribute that carries mentions. The frontend stamps it with the mentioned member's
 * ARN. Under `StandardMessages: NONE` it invokes no Lex; the channel flow routes the `@<member>`.
 */
const CHIME_MENTIONS_ATTRIBUTE = 'CHIME.mentions';

/**
 * Emit one count on the EMF embedded-metric format.
 *
 * Never throws. This is the instrument that says the defect still exists (tenet 6), and an instrument
 * that can fail the thing it measures is worse than no instrument: it would turn a metrics hiccup into
 * a person's answer being dropped.
 */
function emit(metricName: string, dimensions: Record<string, string> = {}): void {
  try {
    // Delegated to the ONE EMF emitter, because a hand-rolled envelope here sat outside
    // emf-schema.test.ts's drift guard - and CloudWatch rejects a malformed document SILENTLY, which
    // once cost months of a metric never materializing. The DIMENSIONLESS set is emitted alongside
    // the per-classification one, and it is load-bearing: the post-processing stack's repair-rate
    // alarm watches the metric with no dimensions, and EMF dimension sets are distinct metrics - the
    // alarm over a dimensionless series that nothing published could structurally never fire.
    emitEmfMetric({
      namespace: METRIC_NAMESPACE,
      metrics: [{ name: metricName, unit: 'Count' }],
      dimensionSets: Object.keys(dimensions).length ? [Object.keys(dimensions), []] : [[]],
      properties: { ...dimensions, [metricName]: 1 },
    });
  } catch {
    // Measurement must never cost the repair.
  }
}

/** Why a message was not repaired. Every branch names itself, so a quiet path is still a legible one. */
export type SkipReason =
  | 'not-a-new-message'
  | 'no-message-id'
  | 'no-channel'
  | 'bot-authored'
  | 'no-task-hint'
  | 'targeted'
  | 'mentioned'
  | 'bypass-token'
  | 'task-reference';

export type RepairDecision =
  | { repair: false; reason: SkipReason }
  | { repair: true; taskId: string; messageId: string; channelArn: string; senderArn: string; content: string;
      /** When the PERSON sent it (epoch ms), so the repaired turn measures their wait and not the
       *  dispatch that happened after the detection delay. Absent when the record carried no
       *  timestamp - omitted rather than defaulted to now, which would report the wait as zero. */
      sentAtMs?: number };

/**
 * Everything that can be decided from the record alone, and nothing that needs a lookup.
 *
 * SEPARATE FROM THE DISPATCH ON PURPOSE. This runs on EVERY message in the deployment, so it must be
 * pure, cheap and testable without AWS; the reads that follow it run on the handful that get through.
 * The order below is the cost order: the free checks that reject ordinary traffic come first.
 */
export function decideRepair(event: MessageStreamEvent): RepairDecision {
  // An edit or a redaction is not someone answering. Only a new message can be an unanswered one, and
  // re-running the rule on an UPDATE would dispatch a second turn for a message already repaired.
  if (event.EventType !== 'CREATE_CHANNEL_MESSAGE') return { repair: false, reason: 'not-a-new-message' };

  const p = event.Payload || {};
  if (!p.MessageId) return { repair: false, reason: 'no-message-id' };
  if (!p.ChannelArn) return { repair: false, reason: 'no-channel' };

  // An assistant's own message is never a person answering a task, whatever it carries. This also
  // closes the loop the repair would otherwise be able to open with itself.
  const senderArn = p.Sender?.Arn || '';
  if (!senderArn || senderArn.includes('/bot/')) return { repair: false, reason: 'bot-authored' };

  // Parsed BEFORE the address checks so the value is available on the one return that needs it, and
  // NaN-guarded: an unparseable timestamp is an absent one, never a 1970 instant that would report a
  // wait of fifty-odd years.
  const parsed = p.CreatedTimestamp ? Date.parse(p.CreatedTimestamp) : NaN;
  const sentAtMs = Number.isFinite(parsed) ? parsed : undefined;

  const hint = extractTaskAnswerHint(p.Metadata);
  if (!hint) return { repair: false, reason: 'no-task-hint' };

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // ADDRESSED ⇒ DELIVERED, BY ANY OF THE THREE ROUTES A MESSAGE CAN TAKE.
  //
  // This component exists for messages that reached NOBODY. A message that reached someone by any
  // route already has a turn, and dispatching a second one answers the person twice - two model
  // calls, two answers, and the same task chain advanced twice on one reply, with nothing erroring.
  //
  // Each route is checked because each is invisible in the others' field. All three were measured on
  // the live stream rather than assumed:
  //
  //   1. `Target`            -> Chime routes it to the addressed bot's Lex (`TargetedMessages: ALL`)
  //   2. `CHIME.mentions`    -> NO `Target`; the CHANNEL FLOW routes the `@<member>` it carries
  //   3. `@all` / `/battle`  -> neither field is set; the CHANNEL FLOW claims the turn from content
  //
  // THE CHECKS ARE DELIBERATELY OVER-INCLUSIVE, and the asymmetry is the reason. Skipping something
  // that should have been repaired leaves the person exactly where they already were - waiting, with
  // the item still open in their queue, recoverable by addressing an assistant directly. Repairing
  // something already delivered spends twice and corrupts the chain, invisibly. So a message
  // addressed at a PERSON counts as addressed too, and that is not merely the cheap direction: a
  // targeted message is a private delivery, and this repair's answer is posted publicly (ADR-030), so
  // dispatching one into a private aside would surface it to the room.
  //
  // This is also exactly what the composer does - it stands down for a mention, `@all` and a slash
  // command alike - so the client and the server now state one rule instead of the server trusting
  // the client to hold it.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  const targets = [...(p.Target || []), ...(p.Targets || [])].filter((t) => t?.MemberArn);
  if (targets.length > 0) return { repair: false, reason: 'targeted' };

  const mentions = p.MessageAttributes?.[CHIME_MENTIONS_ATTRIBUTE]?.StringValues || [];
  if (mentions.length > 0) return { repair: false, reason: 'mentioned' };

  const content = p.Content ? decodeContent(p.Content) : '';
  // The SAME tokens the flow claims and the router stands down for, from the module that exists so
  // the two cannot drift (`flow-bypass.ts`). Post-processing is the third component in that seam, and
  // it stands down for the same reason the router does: something else already has this turn.
  if (p.Content && flowBypassToken(p.Content, content)) return { repair: false, reason: 'bypass-token' };
  // A MESSAGE THAT STARTS WITH A TASK REFERENCE BELONGS TO THE CHANNEL FLOW (ADR-035). The flow routes
  // it after the task service confirms the sender may answer that item, and a reference it declined to
  // route is one the sender may not answer, so a repair here would either answer the message twice or
  // answer what the flow refused. Measured live as a double entry: the second turn found the first one
  // busy and queued the message behind its own answer.
  if (parseTaskReference(content)) return { repair: false, reason: 'task-reference' };

  return {
    repair: true,
    taskId: hint.taskId,
    messageId: p.MessageId,
    channelArn: p.ChannelArn,
    senderArn,
    content,
    ...(sentAtMs !== undefined ? { sentAtMs } : {}),
  };
}


/**
 * The bot ARN of an assistant in this channel's app instance.
 *
 * DERIVED FROM THE CHANNEL, not from configuration. A channel ARN and a bot ARN differ only in their
 * last two segments (`.../app-instance/<id>/channel/<cid>` and `.../app-instance/<id>/bot/<bid>`), so
 * the channel the message arrived in already names the app instance the assistant must live in. A
 * stored prefix would be a second copy of that fact, free to disagree with the wiring it describes.
 *
 * DERIVING IT IS NOT TRUSTING IT. The ARN goes to the router as `TurnRequest.botArn`, which validates
 * every caller-supplied identity against this classification's own bot plus its classification's
 * roster (`isSanctionedBattleBot`). A task carrying a junk or foreign `assistantId` therefore cannot
 * make a handler answer as an arbitrary bot; it fails the sanction check and the turn declines.
 */
export function botArnInChannel(channelArn: string, assistantId: string): string | undefined {
  const appInstanceArn = channelArn.includes('/channel/') ? appInstanceArnOf(channelArn) : null;
  if (!appInstanceArn || !assistantId) return undefined;
  return botArnFor(appInstanceArn, assistantId);
}

/**
 * Repair one message, or explain why it was left alone.
 *
 * NEVER THROWS. A Kinesis handler that throws blocks its shard until the retries are exhausted, and
 * this component's whole justification is that it costs nothing on the traffic it does not act on.
 * A repair that fails is counted and dropped: the person is left where they already were - waiting -
 * and the item stays visibly open in their queue.
 */
export async function repairTaskAnswer(event: MessageStreamEvent): Promise<void> {
  const decision = decideRepair(event);
  if (!decision.repair) return;

  const { taskId, messageId, channelArn, senderArn, content, sentAtMs } = decision;

  try {
    // THE TASK IS THE AUTHORITY, and the hint is only what made us look. A hint naming a task that
    // does not exist in this channel repairs nothing: the key is (taskId, channelArn), so a task id
    // lifted from another conversation cannot be used to make an assistant act in this one.
    const task = await getTask(taskId, channelArn);
    if (!task) {
      console.warn('[TaskAnswerRepair] the hint names no task in this channel; nothing to repair', { taskId, messageId });
      emit('Unresolved', { Reason: 'no-task' });
      return;
    }
    if (!task.assistantId) {
      // Rows written before the ownership split carry no assistant. Nothing here can invent one, and
      // guessing would dispatch a turn to whichever assistant the channel happens to default to.
      console.warn('[TaskAnswerRepair] the task records no assistant; nothing to repair', { taskId, messageId });
      emit('Unresolved', { Reason: 'no-assistant' });
      return;
    }
    // THE SPEAKER MUST BE THE ONE THE TASK IS WAITING ON. The owner is who must act NEXT (ADR-024), so
    // this is the check that stops a bystander's remark - stamped with a task id their client could
    // see - from advancing someone else's work. It is the stream-side equivalent of the refusal the
    // router gets structurally: its person-owed lookup can only ever return a chain THIS person holds,
    // and here the same question has to be asked out loud because the task was named rather than found.
    const owner = resolveTaskAssignee(task);
    if (owner?.type !== 'user' || owner.id !== principalIdFromArn(senderArn)) {
      console.log('[TaskAnswerRepair] the speaker does not hold this task; leaving it alone', { taskId, messageId });
      emit('Unresolved', { Reason: 'not-the-owner' });
      return;
    }

    const botArn = botArnInChannel(channelArn, task.assistantId);
    if (!botArn) {
      console.warn('[TaskAnswerRepair] could not derive the assistant identity from the channel', { channelArn, taskId });
      emit('Unresolved', { Reason: 'no-bot-arn' });
      return;
    }

    // A 1:1 IS NOT BROKEN AND MUST NOT BE REPAIRED. At that size the channel flow owns every turn
    // (`flowOwnsTheTurn`) and dispatches an unaddressed message to the primary assistant
    // (`claimedWithoutAToken`), so the answer already reached the assistant and a dispatch here would
    // be the SECOND turn on one message. `resolveChannelSize` fails toward the
    // group shape for its own caller, so an unreadable count is checked explicitly and declines: the
    // cheaper mistake is a repair that did not happen, which leaves the person exactly where they were.
    const size = await resolveChannelSize(messagingClient, channelArn, botArn);
    if (size.refused) {
      // Separated from `size-unknown` because it is a different thing to chase: the boundary refused
      // this component the read, rather than the service failing it (ADR-045 decision 1).
      console.error('[TaskAnswerRepair][SecurityEvent] refused by the channel classification boundary; not repairing', {
        channelArn, messageId,
      });
      emit('Unresolved', { Reason: 'refused' });
      return;
    }
    if (size.unknown) {
      console.warn('[TaskAnswerRepair] the channel size could not be read; not repairing', { channelArn, messageId });
      emit('Unresolved', { Reason: 'size-unknown' });
      return;
    }
    if (size.isOneToOne) {
      console.log('[TaskAnswerRepair] a 1:1 answer already reached the assistant; nothing to repair', { messageId });
      return;
    }

    // The channel's IMMUTABLE classification tag, exactly as every other component reads it - never
    // mutable channel metadata, which a member holding `UpdateChannel` could rewrite to put the turn on
    // another classification's assistant.
    //
    // IT NO LONGER FAILS CLOSED TO `basic`, BECAUSE THE FLOOR IS NOT A SAFE ANSWER HERE (ADR-045
    // decision 2). This path re-drives a transcript through the router it names, so substituting the
    // floor on an unreadable tag put a PREMIUM conversation's transcript through the BASIC router.
    // An unreadable tag now declines the repair, which leaves the person exactly where they were -
    // the same cheaper-mistake argument the size check above already makes.
    const classification = await readChannelClassificationTag(messagingClient, channelArn, '[TaskAnswerRepair]');
    if (!classification) {
      console.warn('[TaskAnswerRepair] the channel classification could not be read; not repairing', {
        channelArn, messageId,
      });
      emit('Unresolved', { Reason: 'classification-unreadable' });
      return;
    }
    const routerArn = await resolveRouterArn(classification);
    if (!routerArn) {
      console.error('[TaskAnswerRepair] no router is wired for this classification; cannot repair', { classification });
      emit('Unresolved', { Reason: 'no-router' });
      return;
    }

    // ONCE PER MESSAGE, and it is a DURABLE claim rather than a per-container one: Kinesis delivery is
    // at-least-once and a retried batch runs on whichever container is free, so two deliveries of the
    // same message can be repaired by two containers that each believe they are the first. Fails OPEN
    // like every other claim on this platform - a control-table hiccup must not swallow a person's
    // answer, and the cost of the rare double is one duplicated turn.
    //
    // TAKEN AFTER THE CHECKS, NOT BEFORE THEM (ADR-045 decision 2). It used to be the first thing this
    // function did, so a repair refused by the classification boundary or by an unreadable size still
    // burned the message's only claim - and the retry that should have succeeded once the throttle
    // passed was then declined as a duplicate of a repair that never happened. Everything above this
    // line is reads, so paying for them twice on a genuine duplicate is cheaper than losing the
    // person's answer to a claim taken on behalf of work that was never done.
    // ── THE CHANNEL FLOW MAY ALREADY HAVE DISPATCHED THIS MESSAGE ──────────────────────────────
    //
    // LOSING means the flow owns this turn and this repair must stand down; WINNING means nothing
    // dispatched and the message really did reach nobody, which is what this component exists for.
    //
    // THIS COMMENT USED TO CLAIM THE ORDER GUARANTEED IT, and that was wrong (code review,
    // 2026-09-22). It read "the flow claims `flow-<MessageId>` before it releases", so the claim
    // "either exists or never will" by the time this runs. The flow releases FIRST on the ordinary
    // path (`channel-flow-processor.ts`, `releasedEarly`) and claims only at the dispatch decision,
    // after the roster read - so a message could reach this stream with the claim not yet taken, and
    // whoever won dispatched. No double answer, because the claim is a real mutex, but the two
    // dispatch differently: this one posts publicly under the assignee-only rule (ADR-030), and the
    // flow standing down also swallows the private-address notice it owes the sender.
    //
    // The flow now holds its release until after the claim for exactly the shape this component acts
    // on - a message whose `Metadata` names an item - so the ordering the old comment asserted is now
    // true for the messages it needed to be true for, and is stated there rather than assumed here.
    //
    // WHY THIS REPLACED A CONTENT CHECK. `decideRepair` stands down for a message whose TEXT starts
    // with a `#<n>`, because the flow routes those (ADR-035). The flow now routes on the task id in
    // `Metadata` as well, and that message's text carries no reference at all - so the content check
    // saw an unaddressed message and this would have dispatched a SECOND turn for one the flow had
    // already dispatched. The free checks cannot see the flow's decision; this claim is the decision.
    //
    // Fails OPEN like the claim below, in the same direction and for the same reason.
    if (!(await claimCorrelation(flowDeliveryKey(messageId)))) {
      // ── WHOSE CLAIM IS IT, BECAUSE A REDELIVERY FINDS ITS OWN ────────────────────────────────
      //
      // Kinesis delivery is at-least-once, so a message this component already repaired comes back -
      // and on the second pass it reads the `flow-` claim IT took on the first, then reported the
      // dispatch as the channel flow's. Harmless to behavior, because the `repair-` claim below
      // stands it down either way, and corrupting to the one number this key exists to produce: the
      // count of turns the flow took from under the repair.
      //
      // Read rather than claimed, so asking the question does not answer it.
      if (await hasCorrelationClaim(`repair-${messageId}`)) {
        console.log('[TaskAnswerRepair] a duplicate delivery of a message already repaired', { messageId });
        return;
      }
      console.log('[TaskAnswerRepair] the channel flow already dispatched this message; nothing to repair', {
        messageId,
      });
      emit('Unresolved', { Reason: 'flow-dispatched' });
      return;
    }

    if (!(await claimCorrelation(`repair-${messageId}`))) {
      console.log('[TaskAnswerRepair] a duplicate delivery of a message already repaired', { messageId });
      return;
    }

    // THE SAME ENTRY EVERY OTHER BYPASS USES. `botArn` names the assistant whose work this is, read off
    // the task; `userMessageId` is the inbound message, so the turn's correlation id is declared rather
    // than derived and a redelivery collapses on the handler's own claim as well as this one.
    //
    // Fire and forget: the repair is finished the moment the work is somewhere it can be done, and the
    // turn posts its own acknowledgement (ADR-025) and its own answer (ADR-030). Nothing is posted from
    // here - a component that answered would be a second implementation of a turn.
    const aeTurn: TurnRequest = {
      channelArn,
      senderArn,
      userMessage: content,
      userMessageId: messageId,
      botArn,
      // The repair is machine-initiated, seconds after the message it re-drives. Without this
      // declaration the turn archives as user-triggered and is measured as one very slow answer -
      // the exact misread the trigger field's contract says it exists to prevent. This is one of the
      // two producers 'orchestrator' shipped without.
      // NAMED BY INTERACTION (interaction-kinds.ts). This was 'orchestrator', which named the
      // dispatcher and made a repair indistinguishable from a battle rebuttal - two turns with
      // opposite answers to 'is somebody waiting for this?'. A repair re-drives a message a PERSON
      // sent and is still waiting on; a rebuttal answers another assistant.
      trigger: 'repair',
      // THEIR SEND, NOT THIS DISPATCH. Everything between the two - the Kinesis hop and the
      // detection - is wait they experienced, and it is the largest part of a repaired turn's
      // latency. Measuring from here would report the repair as fast and hide the delay it exists
      // to recover from.
      ...(sentAtMs !== undefined ? { triggerAtMs: sentAtMs } : {}),
    };
    await lambdaClient.send(new InvokeCommand({
      FunctionName: routerArn,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify({ aeTurn })),
    }));

    // TENET 6. This is the count of how often the client failed to address a task answer, which is the
    // only thing that keeps the client defect visible now that it no longer strands anyone.
    emit('Repairs', { Classification: classification });
    console.log('[TaskAnswerRepair] dispatched the turn the message never reached', {
      messageId, taskId, assistantId: task.assistantId, classification,
    });
  } catch (error) {
    // Counted, not rethrown. See the contract on this function: a throw would stall the shard for
    // every other consumer of the stream, and this path exists to be free when it is not needed.
    console.error('[TaskAnswerRepair] repair failed:', error);
    emit('Failures');
  }
}

