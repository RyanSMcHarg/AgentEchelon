/**
 * POST-PROCESSING RULE: a task answer that reached no assistant (ADR-032, ADR-030).
 *
 * THE DEFECT IT MEASURES. A person answers a question an assistant asked them, in a conversation with
 * more than one member, and addresses nobody. `InvokedBy` routes on mentions and targeting, so nothing
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
 * It also could not run there. The channel flow callback carries no `Target` at all (tracker row 94,
 * and the table in MESSAGE-FLOW Appendix A), so the flow cannot tell an addressed message from an
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
import { getTask, principalIdFromArn, resolveTaskOwner } from './task-tracking.js';
import { claimCorrelation } from './abuse-controls.js';
import { resolveChannelClassificationTag } from './channel-classification.js';
import { resolveChannelSize } from './channel-size.js';
import { flowBypassToken } from './flow-bypass.js';
import type { MessageStreamEvent } from './message-stream-event.js';
import type { TurnRequest } from '../router-agent-handler.js';
import { routerArnForClassification } from './router-arn.js';
import { emitEmfMetric } from './emf-metrics.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const messagingClient = new ChimeSDKMessagingClient({ region: AWS_REGION });
const lambdaClient = new LambdaClient({ region: AWS_REGION });

/** EMF namespace. One metric name per outcome, so an alarm needs no log-metric-filter. */
const METRIC_NAMESPACE = 'AgentEchelon/TaskAnswerRepair';

/**
 * The message attribute Amazon Chime SDK routes mentions on. The frontend stamps it with the
 * mentioned member's ARN, and a mention naming a bot invokes that bot's Lex.
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
    // once cost months of a metric never materialising. The DIMENSIONLESS set is emitted alongside
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
  | 'bypass-token';

export type RepairDecision =
  | { repair: false; reason: SkipReason }
  | { repair: true; taskId: string; messageId: string; channelArn: string; senderArn: string; content: string };

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
  //   2. `CHIME.mentions`    -> the same, with NO `Target` on the message at all
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

  const content = p.Content ? safeDecode(p.Content) : '';
  // The SAME tokens the flow claims and the router stands down for, from the module that exists so
  // the two cannot drift (`flow-bypass.ts`). Post-processing is the third component in that seam, and
  // it stands down for the same reason the router does: something else already has this turn.
  if (p.Content && flowBypassToken(p.Content, content)) return { repair: false, reason: 'bypass-token' };

  return {
    repair: true,
    taskId: hint.taskId,
    messageId: p.MessageId,
    channelArn: p.ChannelArn,
    senderArn,
    content,
  };
}

/** Chime carries message content URL-encoded. A blob that will not decode is passed through as sent. */
function safeDecode(content: string): string {
  try {
    return decodeURIComponent(content);
  } catch {
    return content;
  }
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
 * every caller-supplied identity against this classification's own bot plus the published alt-slot
 * roster (`isSanctionedBattleBot`). A task carrying a junk or foreign `assistantId` therefore cannot
 * make a handler answer as an arbitrary bot; it fails the sanction check and the turn declines.
 */
export function botArnInChannel(channelArn: string, assistantId: string): string | undefined {
  const marker = '/channel/';
  const at = channelArn.indexOf(marker);
  if (at < 0 || !assistantId) return undefined;
  return `${channelArn.substring(0, at)}/bot/${assistantId}`;
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

  const { taskId, messageId, channelArn, senderArn, content } = decision;

  // ONCE PER MESSAGE, and it is a DURABLE claim rather than a per-container one: Kinesis delivery is
  // at-least-once and a retried batch runs on whichever container is free, so two deliveries of the
  // same message can be repaired by two containers that each believe they are the first. Fails OPEN
  // like every other claim on this platform - a control-table hiccup must not swallow a person's
  // answer, and the cost of the rare double is one duplicated turn.
  if (!(await claimCorrelation(`repair-${messageId}`))) {
    console.log('[TaskAnswerRepair] a duplicate delivery of a message already repaired', { messageId });
    return;
  }

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
    const owner = resolveTaskOwner(task);
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

    // A 1:1 IS NOT BROKEN AND MUST NOT BE REPAIRED. At that size Amazon Chime SDK's AUTO trigger routes
    // every message to Lex regardless of addressing, so the answer already reached the assistant and a
    // dispatch here would be the SECOND turn on one message. `resolveChannelSize` fails toward the
    // group shape for its own caller, so an unreadable count is checked explicitly and declines: the
    // cheaper mistake is a repair that did not happen, which leaves the person exactly where they were.
    const size = await resolveChannelSize(messagingClient, channelArn, botArn);
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
    // mutable channel metadata, which a member holding `UpdateChannel` could raise to put the turn on
    // a higher-classification assistant. Fails closed to `basic`.
    const classification = await resolveChannelClassificationTag(messagingClient, channelArn, '[TaskAnswerRepair]');
    const routerArn = routerArnForClassification(classification);
    if (!routerArn) {
      console.error('[TaskAnswerRepair] no router is wired for this classification; cannot repair', { classification });
      emit('Unresolved', { Reason: 'no-router' });
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
      trigger: 'orchestrator',
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

