/**
 * THE NOTIFICATION BRIDGE: reach the people who are not in the room (ADR-041, SPEC-NOTIFICATION-BRIDGE).
 *
 * An assistant message whose `Metadata` carries a `notify` directive is fanned out to the
 * conversation's members over the requested transport. Email is the only transport wired today; SMS
 * and voice arrive on the same fan-out.
 *
 * ── WHY IT RUNS HERE AND NOT IN THE CHANNEL FLOW ─────────────────────────────────────────────────
 *
 * It used to run in the flow's assistant pass, awaited in front of `ChannelFlowCallback`. The comment
 * above it said "never blocks the callback", which was true of its FAILURES, because the catch
 * swallowed them, and false of its LATENCY, because the callback was strictly downstream of the
 * awaited call. Inside that call: one `chime:ListTagsForResource` paid even in the conversations that
 * will send nothing, a paginated `chime:ListChannelMemberships`, then one `cognito-idp:AdminGetUser`
 * per recipient and one SES send per recipient, both serial. So everybody in the room waited to see
 * the assistant's message while the platform looked up and emailed people who were not there.
 *
 * AND IT COULD COST THE TURN, NOT ONLY MILLISECONDS. A fan-out slow enough to carry the flow past its
 * 35 second deadline leaves the message to `FallbackAction: CONTINUE`, which delivers it UNPROCESSED -
 * with the raw Amazon Lex envelope rather than the unwrapped text the assistant pass computed. That
 * failure direction argues for the move independently of the milliseconds, and nothing measures the
 * milliseconds.
 *
 * ── THE TRIGGER IS THE DELIVERED MESSAGE ─────────────────────────────────────────────────────────
 *
 * The Kinesis mirror carries `Metadata` intact and carries the message as it was STORED, which is the
 * unwrapped text the flow released - the same string the fan-out used to build by unwrapping the
 * envelope itself. So the stream hands this rule everything the directive needs, and the recipient
 * list is still resolved LIVE at send time (tenet D7): membership is current state, so it is read from
 * the Amazon Chime SDK rather than carried on the trigger, where it could only be stale.
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────────────────────────────────
 *
 * Like every stream consumer, it never throws: a throw on the stream stalls the shard for every message
 * behind it. `fanOutChannelNotification` already collects its own send failures rather than throwing,
 * so the try/catch covers the reads around them.
 *
 * AND IT IS COUNTED (ADR-041 decision 7, ADR-032 tenet 6). A side effect nobody can see failing is
 * indistinguishable from one that is not running, and this one had no metric on either path: the flow
 * logged the result object and moved on. Moving a silent failure to the stream without counting it
 * would only move it somewhere quieter.
 */

import { parseNotifyDirective, fanOutChannelNotification, mentionedMemberIds } from './channel-notify.js';
import { emitEmfMetric } from './emf-metrics.js';
import type { MessageStreamEvent } from './message-stream-event.js';
import { decodeContent } from './chime/history.js';
// Which directories a contact may be read from is the directory's configuration (the trusted-issuer
// registry, `TRUSTED_ISSUERS`, read by `lib/membership-source.ts`), not this module's.
import { trustedIssuers } from './trusted-issuers.js';


/** EMF namespace. One metric name per outcome, so an alarm needs no log-metric-filter. */
const METRIC_NAMESPACE = 'AgentEchelon/Notifications';


/**
 * What one fan-out reached, skipped and failed to reach, on the EMF embedded-metric format.
 *
 * DIMENSIONLESS, and deliberately: dimension sets are distinct metrics in CloudWatch, so an alarm
 * over a dimensionless series that nothing publishes can never fire, and the Notifications stack's
 * `NotificationFailuresAlarm` watches exactly that series. A zero is not emitted, because a count of nothing is not a
 * measurement of anything and every message in the deployment would carry three of them.
 *
 * Exported so the emitter is exercised for real rather than through a fan-out that would have to
 * reach AWS to produce a number. Never throws: an instrument that can fail the thing it measures is
 * worse than no instrument.
 */
export function recordNotificationOutcome(outcome: {
  emailed: number;
  skipped: number;
  failed: number;
}): void {
  try {
    for (const [metricName, value] of [
      ['Emailed', outcome.emailed],
      ['Skipped', outcome.skipped],
      ['Failed', outcome.failed],
    ] as const) {
      if (!value) continue;
      emitEmfMetric({
        namespace: METRIC_NAMESPACE,
        metrics: [{ name: metricName, unit: 'Count' }],
        dimensionSets: [[]],
        properties: { [metricName]: value },
      });
    }
  } catch {
    // Measurement must never cost the notification.
  }
}

/** Why a message was not fanned out. Every branch names itself, so a quiet path is still legible. */
export type NotifySkipReason =
  | 'not-a-new-message'
  | 'no-channel'
  | 'no-sender'
  | 'person-mentions-no-one'
  | 'no-directive';

export type NotifyDecision =
  | { notify: false; reason: NotifySkipReason }
  | { notify: true; channelArn: string; senderArn: string; messageText: string; personSent: boolean;
      directive: NonNullable<ReturnType<typeof parseNotifyDirective>> };

/**
 * Everything decidable from the record alone, and nothing that needs a lookup.
 *
 * SEPARATE FROM THE FAN-OUT ON PURPOSE. This runs on every message in the deployment, so it must be
 * pure, cheap and testable without AWS; the reads run on the handful that get through. The order is
 * the cost order: the free checks that reject ordinary traffic come first, and `parseNotifyDirective`
 * (a JSON parse) comes last.
 */
export function decideNotify(event: MessageStreamEvent): NotifyDecision {
  // An UPDATE is not a new notification. The flow's assistant pass ran on an updated bot message as
  // well as a created one, so an assistant that posted a directive-carrying acknowledgment and then
  // wrote its answer over it could fan out twice. The stream says which event this is, so the rule
  // that could not be stated there is stated here.
  if (event.EventType !== 'CREATE_CHANNEL_MESSAGE') return { notify: false, reason: 'not-a-new-message' };

  const p = event.Payload || {};
  if (!p.ChannelArn) return { notify: false, reason: 'no-channel' };

  const senderArn = p.Sender?.Arn || '';
  if (!senderArn) return { notify: false, reason: 'no-sender' };

  // The STORED text. The flow unwrapped the Amazon Lex envelope before releasing, so what the stream
  // carries is already the text a reader with no unwrapper can read.
  const messageText = decodeContent(p.Content || '');

  // A PERSON'S MESSAGE MAY EMAIL ONLY THE PEOPLE IT MENTIONS. Their Metadata is
  // theirs to write, so a hand-crafted `notify` must not reach the room: it needs a delimited mention
  // to address anyone, and the fan-out then emails only mentioned members (`channel-notify.ts`). An
  // assistant's message is written by the platform and keeps every shape it had. Checked before the
  // directive parse, because it rejects most of the people's traffic for less.
  const personSent = !senderArn.includes('/bot/');
  if (personSent && !mentionedMemberIds(messageText).length) return { notify: false, reason: 'person-mentions-no-one' };

  const directive = parseNotifyDirective(p.Metadata);
  if (!directive) return { notify: false, reason: 'no-directive' };

  return { notify: true, channelArn: p.ChannelArn, senderArn, messageText, personSent, directive };
}

/**
 * Fan a delivered assistant message out over its requested transports.
 *
 * Every exit is a no-op and almost every message takes one: `decideNotify` rejects ordinary traffic
 * without a single call.
 */
export async function notifyOnDelivery(event: MessageStreamEvent): Promise<void> {
  const decision = decideNotify(event);
  if (!decision.notify) return;

  // WITHOUT A DIRECTORY THAT HOLDS CONTACTS THERE IS NOBODY TO RESOLVE: no trusted issuer reads a pool or
  // keeps a contact copy (C5), so there is no contact lookup and no send.
  if (!trustedIssuers().some((t) => t.directory !== 'none')) {
    console.log('[notify-on-delivery] no trusted issuer holds contacts; the notification bridge is off', {
      channelArn: decision.channelArn,
    });
    return;
  }

  try {
    const res = await fanOutChannelNotification({
      channelArn: decision.channelArn,
      // WHOEVER POSTED IT IS THE BEARER, exactly as on the flow's pass: assistant or person, they are a
      // member of the channel, so they may read the membership that decides who is reached.
      bearerArn: decision.senderArn,
      senderArn: decision.senderArn,
      personSent: decision.personSent,
      messageText: decision.messageText,
      directive: decision.directive,
    });
    console.log('[notify-on-delivery] notify fan-out', res);
    recordNotificationOutcome({
      emailed: res.emailed.length,
      skipped: res.skipped.length,
      failed: res.failed.length,
    });
  } catch (e) {
    // Swallowed, like every stream consumer. A notification that fails must not fail the turn, and on this
    // seam the turn is already over - but a throw would stall the shard for the messages behind it.
    console.warn('[notify-on-delivery] notify fan-out failed (non-fatal):', e);
    recordNotificationOutcome({ emailed: 0, skipped: 0, failed: 1 });
  }
}
