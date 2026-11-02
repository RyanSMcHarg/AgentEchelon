/**
 * POST-PROCESSING BACKSTOP FOR A HANDOVER THE CHANNEL FLOW COULD NOT ROUTE
 * (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.4; MESSAGE-FLOW §5.1).
 *
 * The flow routes a handover from its address token and cannot see `Target`; the stream record carries
 * both. So this rule owns exactly the cases the flow cannot: a handover with NO token, and one whose token
 * names someone other than its `Target`. Both are defects in whatever composed the message, so each is
 * delivered to the assistant it was actually targeted at and logged as one.
 *
 * IT STANDS ASIDE WHEN THE TOKEN MATCHES THE TARGET, because the flow routes that case synchronously and
 * the stream can arrive before the flow has claimed it. Racing it would deliver the answer privately (this
 * rule cannot read the person's message to learn its audience) where the flow would answer in the room.
 *
 * Requires the handover MARKER, never a bare `Target`: a receipt or a reply that inherited targeting is an
 * assistant-authored targeted message too, and dispatching on those would be a loop.
 */
import { ChimeSDKMessagingClient } from '@aws-sdk/client-chime-sdk-messaging';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import type { MessageStreamEvent } from './message-stream-event.js';
import { parseHandover } from './assistant-handover.js';
import { parsePrivateAddress } from './private-prefix.js';
import { routeHandover, type HandoverDispatch } from './handover-routing.js';
import { resolveChannelSize } from './channel-size.js';
import { claimCorrelation } from './abuse-controls.js';
import { readChannelClassificationTag } from './channel-classification.js';
import { resolveRouterArn } from './router-arn.js';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import type { TurnRequest } from '../router-agent-handler.js';
import { sessionClient } from './assistant-session.js';

const messagingClient = sessionClient(ChimeSDKMessagingClient, { requestHandler: BOUNDED_REQUEST_HANDLER });
const lambdaClient = sessionClient(LambdaClient, {});

/** The token's id or name, when the body leads with one. */
function tokenOf(content: string): { id?: string; name: string } | null {
  let text = content;
  try { text = decodeURIComponent(content); } catch { /* raw */ }
  const address = parsePrivateAddress(text);
  return address ? { id: address.id, name: address.name } : null;
}

export async function deliverMissedHandover(event: MessageStreamEvent): Promise<void> {
  try {
    const m = event?.Payload;
    if (!m?.MessageId || !m.ChannelArn || !parseHandover(m.Metadata)) return;
    const target = m.Target ?? m.Targets ?? [];
    const targetIds = target.map((t) => (t.MemberArn || '').split('/').pop());
    const token = tokenOf(m.Content || '');
    // THE FLOW'S CASE: a token whose id is the Target. Stand aside.
    if (token?.id && targetIds.includes(token.id)) return;

    console.warn('[Handover] the flow could not route this handover; delivering it from the stream', {
      handoverMessageId: m.MessageId, reason: token ? 'token-target-mismatch' : 'no-token',
    });
    await routeHandover({
      source: 'backstop',
      channelArn: m.ChannelArn,
      handoverMessageId: m.MessageId,
      senderArn: m.Sender?.Arn || '',
      content: '',
      metadata: m.Metadata,
      streamTarget: target,
    }, backstopDeps);
  } catch (err) {
    console.error('[Handover] backstop failed:', err);
  }
}

const backstopDeps = {
  readMessage: async () => null,
  async listMembers(channelArn: string, bearerArn: string) {
    const size = await resolveChannelSize(messagingClient, channelArn, bearerArn);
    return size?.unknown ? null : (size?.members ?? null);
  },
  claim: (key: string) => claimCorrelation(key),
  async dispatch(turn: HandoverDispatch): Promise<boolean> {
    const classification = await readChannelClassificationTag(messagingClient, turn.channelArn, '[Handover]');
    // That classification's OWN router or nothing (ADR-046): an unreadable tag or an unwired router
    // declines the handover rather than answering it on another classification's router.
    const routerArn = classification ? await resolveRouterArn(classification) : undefined;
    if (!routerArn) {
      console.error('[Handover] no router for this conversation\'s classification; the handover is not dispatched', {
        channelArn: turn.channelArn, classification: classification ?? '(unreadable)',
      });
      return false;
    }
    const aeTurn: TurnRequest = {
      channelArn: turn.channelArn,
      senderArn: turn.marker.personSenderArn,
      userMessage: '',
      userMessageId: turn.marker.personMessageId,
      botArn: turn.receiverBotArn,
      targeted: turn.privateToPerson,
      trigger: 'handover',
      handoverMessageId: turn.handoverMessageId,
    };
    await lambdaClient.send(new InvokeCommand({
      FunctionName: routerArn,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify({ aeTurn })),
    }));
    return true;
  },
};
