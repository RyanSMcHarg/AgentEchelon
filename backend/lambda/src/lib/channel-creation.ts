/**
 * Channel Creation Helper
 *
 * Extracted from create-conversation/index.js so the drift-confirm path can
 * create new channels without round-tripping through API Gateway. The existing
 * create-conversation Lambda continues to use its own logic; both call sites
 * will be consolidated to this helper post-v0.2.0 (TODO: dedupe).
 *
 * Per SPEC-DRIFT-CONVERGENCE.md "Live-Suggestion Flow": when a user confirms
 * a drift suggestion, we create a new channel here, add the user as
 * moderator, associate the channel flow, and post a first bot message that
 * references (NOT quotes) the originating user message.
 */

import {
  ChimeSDKMessagingClient,
  CreateChannelCommand,
  CreateChannelMembershipCommand,
  CreateChannelModeratorCommand,
  AssociateChannelFlowCommand,
  SendChannelMessageCommand,
  ChannelMessageType,
  ChannelMessagePersistenceType,
} from '@aws-sdk/client-chime-sdk-messaging';
import { getConversationTypeConfig } from '../../../lib/config/conversation-types.js';

const messagingClient = new ChimeSDKMessagingClient({});

export interface CreateConversationFromDriftInput {
  appInstanceArn: string;
  botArn: string;
  userArn: string;
  /** Classification the new channel inherits — should not exceed the parent channel's classification */
  modelTier: 'basic' | 'standard' | 'premium';
  /** modelId/modelName for the channel metadata; usually inherited from the parent */
  modelId: string;
  modelName: string;
  /** Short label (≤64 chars) describing what the new conversation is about */
  topicLabel: string;
  /** Optional ARN of the channel flow to associate (enables @all / @assistant routing) */
  channelFlowArn?: string;
  /** Parent channel ARN for the by-reference message link */
  parentChannelArn: string;
  /** Originating message id from the parent channel — referenced, never quoted */
  originatingMessageId: string;
}

export interface CreateConversationFromDriftResult {
  channelArn: string;
  channelId: string;
}

export async function createConversationFromDrift(
  input: CreateConversationFromDriftInput,
): Promise<CreateConversationFromDriftResult> {
  const channelId = `conv-drift-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const title = sanitizeTitle(input.topicLabel);

  // Platform-wide retention default for this conversation type (90-day
  // LAST_MESSAGE_TIMESTAMP today). Same source of truth as the primary
  // create-conversation path, so drift-spawned channels expire identically.
  const exp = getConversationTypeConfig(input.modelTier).expiration;

  // 1. Bot creates the channel.
  const createResp = await messagingClient.send(
    new CreateChannelCommand({
      AppInstanceArn: input.appInstanceArn,
      ChannelId: channelId,
      Name: title,
      Mode: 'RESTRICTED',
      Privacy: 'PRIVATE',
      ChimeBearer: input.botArn,
      ...(exp
        ? { ExpirationSettings: { ExpirationDays: exp.days, ExpirationCriterion: exp.criterion } }
        : {}),
      // SPEC-CONVERSATION-SECURITY Layer 1: the immutable `classification` tag
      // the IAM channel-join boundary keys on (aws:ResourceTag/classification).
      // MUST be set on every channel — the per-classification roles are fail-closed, so an
      // untagged channel is unreachable by any classification identity.
      Tags: [{ Key: 'classification', Value: input.modelTier }],
      Metadata: JSON.stringify({
        modelId: input.modelId,
        modelName: input.modelName,
        modelTier: input.modelTier,
        // No `createdBy`: owner derived from Chime membership, not copied (Tenet 6).
        createdViaDrift: true,
        parentChannelArn: input.parentChannelArn,
        originatingMessageId: input.originatingMessageId,
      }),
    }),
  );
  const channelArn = createResp.ChannelArn;
  if (!channelArn) {
    throw new Error('create-channel returned no ARN');
  }

  // 2. Add the user as member + moderator.
  await messagingClient.send(
    new CreateChannelMembershipCommand({
      ChannelArn: channelArn,
      MemberArn: input.userArn,
      Type: 'DEFAULT',
      ChimeBearer: input.botArn,
    }),
  );
  await messagingClient.send(
    new CreateChannelModeratorCommand({
      ChannelArn: channelArn,
      ChannelModeratorArn: input.userArn,
      ChimeBearer: input.botArn,
    }),
  );

  // 3. Associate channel flow (best-effort; failure is non-fatal).
  if (input.channelFlowArn) {
    try {
      await messagingClient.send(
        new AssociateChannelFlowCommand({
          ChannelArn: channelArn,
          ChannelFlowArn: input.channelFlowArn,
          ChimeBearer: input.botArn,
        }),
      );
    } catch (err) {
      console.warn('[channel-creation] Failed to associate channel flow:', err);
    }
  }

  // 4. Post a first bot message that references the originating message
  //    (per SPEC by-reference principle — never re-quote user text).
  const referenceUrl = `?conversation=${encodeURIComponent(input.parentChannelArn)}#message=${encodeURIComponent(input.originatingMessageId)}`;
  await messagingClient.send(
    new SendChannelMessageCommand({
      ChannelArn: channelArn,
      Content: `This conversation was started from a drift suggestion in [your previous chat](${referenceUrl}). I'm ready when you are — what would you like to focus on here?`,
      Type: ChannelMessageType.STANDARD,
      Persistence: ChannelMessagePersistenceType.PERSISTENT,
      ChimeBearer: input.botArn,
    }),
  );

  return { channelArn, channelId };
}

function sanitizeTitle(label: string): string {
  // Chime channel names: alphanumeric, hyphens, underscores. Length 1-256.
  // Topic labels from the user/model may include arbitrary characters.
  return (
    label
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'New Conversation'
  );
}
