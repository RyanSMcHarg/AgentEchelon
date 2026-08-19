/**
 * Channel Creation Helper
 *
 * Extracted from create-conversation/index.js so the drift-confirm path can
 * create new channels without round-tripping through API Gateway. The existing
 * create-conversation Lambda continues to use its own logic; both call sites
 * will be consolidated to this helper post-v0.2.0 (TODO: dedupe).
 *
 * Per SPEC-DRIFT-CONVERGENCE.md "Live-Suggestion Flow": when a user confirms a drift suggestion, we create
 * a new channel here, add the user as moderator, and associate the channel flow.
 *
 * The new conversation's opening message is the ORDINARY composed welcome, fired by the assistant's
 * automatic channel membership (it is the CreateChannel bearer). This function posts nothing into the child;
 * it stamps the drift context into channel Metadata and lets the welcome composer render it. It does post
 * one message into the PARENT, carrying a durable link to the child in message Metadata.
 */

import { stripMessageMarkers } from './message-markers.js';
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
import { randomBytes } from 'crypto';
import { getConversationTypeConfig } from '../../../lib/config/conversation-types.js';
import { putChannelContext, getChannelContext } from './channel-context-client.js';
import { deriveFederatedSub } from './federated-identity.js';
import { derivedChannelArn, participantContextFor } from './participant-shape.js';

/** The AppInstanceUser id from a member ARN. '' when the ARN carries no `/user/` segment. */
function subFromUserArn(userArn: string): string {
  const marker = '/user/';
  const idx = (userArn || '').indexOf(marker);
  return idx === -1 ? '' : userArn.slice(idx + marker.length);
}



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
  /** Originating message id from the parent channel, for the deep link back to it */
  originatingMessageId: string;
  /**
   * The text of the message that caused the drift, quoted back in the new conversation's welcome so the
   * person can see the assistant picked up the right thread.
   *
   * This COPIES user text into a second channel, which the by-reference principle otherwise avoids. It is a
   * deliberate product decision, and it means erasing the original does not erase this copy.
   */
  originatingMessageText?: string;
}

export interface CreateConversationFromDriftResult {
  channelArn: string;
  channelId: string;
}

/**
 * A drift-spawned conversation's channel id.
 *
 * `randomBytes`, not `Math.random`: this id derives the channel ARN, which keys per-conversation context
 * written before the channel exists (SPEC-USER-PROFILE-AND-ONBOARDING §2), so a repeated id attaches one
 * conversation's participant context to another rather than merely losing a CreateChannel race. Exported so
 * the collision and Chime-legality properties are tested rather than assumed.
 */
export function newDriftChannelId(): string {
  return `conv-drift-${Date.now()}-${randomBytes(6).toString('hex')}`;
}

export async function createConversationFromDrift(
  input: CreateConversationFromDriftInput,
): Promise<CreateConversationFromDriftResult> {
  const channelId = newDriftChannelId();
  const title = sanitizeTitle(input.topicLabel);

  // Participant shape written BEFORE the channel exists (SPEC-USER-PROFILE-AND-ONBOARDING §2). The assistant
  // is added to the channel by creation itself (it is the acting bearer), so there is no window afterwards in
  // which to write something the welcome will read. Writing ahead is possible because we supply the channel
  // id, so the ARN is derivable.
  //
  // A drift-spawned conversation has exactly one human: the person who accepted the suggestion. They are the
  // INITIATOR and also the sole participant here, so the shape is `single`. Those coincide on this path only;
  // the shape carries who is IN the conversation and never who triggered it.
  const derivedArn = derivedChannelArn(input.appInstanceArn, channelId);
  // CARRY THE MEMBER'S ISSUER HINT FROM THE PARENT.
  //
  // A federated member's AppInstanceUser id is `deriveFederatedSub(iss, sub)` — a one-way hash — so a
  // channel that does not record the raw pair has no way to recover which IdP the member came from.
  // This path only ever sees the DERIVED arn, and cannot reconstruct it; the parent conversation is
  // the only place it exists.
  //
  // Without this, a drift-spawned conversation silently loses the person it was spawned for: the
  // notification fan-out resolves them against the default pool, fails, and skips them, and host
  // grounding can name every other participant but not them. Native members need nothing (their id IS
  // their sub), so this is a no-op on a non-federated deployment.
  const memberSub = subFromUserArn(input.userArn);
  const parentCtx = input.parentChannelArn ? await getChannelContext(input.parentChannelArn) : null;
  const carriedIdentity = (parentCtx?.memberIdentities || []).find((p) => {
    if (!p?.sub) return false;
    return p.iss ? deriveFederatedSub(p.iss, p.sub) === memberSub : p.sub === memberSub;
  });

  await putChannelContext(derivedArn, {
    participants: participantContextFor([subFromUserArn(input.userArn)]),
    ...(carriedIdentity ? { memberIdentities: [carriedIdentity] } : {}),
    // The drift carry-over the welcome composer renders. Written HERE rather than stamped into channel
    // Metadata for the three reasons on `ChannelContext`: Metadata is not reliably readable at
    // `WelcomeIntent`, it is member-WRITABLE, and its ~1KB cap is what truncated the quoted message.
    // Same pre-create write and same consistent read as the participant shape above.
    ...(sanitizeTriggerContext(input.topicLabel)
      ? { priorSubject: sanitizeTriggerContext(input.topicLabel) }
      : {}),
    ...(input.originatingMessageText
      ? { priorMessage: sanitizeQuotedMessage(input.originatingMessageText) }
      : {}),
    // Composed at WRITE time so the reader does not have to reassemble a link from two Metadata
    // fields — which is what forced `parentChannelArn` and `originatingMessageId` to stay readable
    // there in the first place.
    ...(input.parentChannelArn
      ? {
        parentRef: `?conversation=${encodeURIComponent(input.parentChannelArn)}`
          + (input.originatingMessageId
            ? `#message=${encodeURIComponent(input.originatingMessageId)}`
            : ''),
      }
      : {}),
  });

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
        // WHY this conversation exists, for the welcome composer to read on WelcomeIntent
        // (SPEC-WELCOME-AND-CONTEXT). A short topic LABEL derived from what the person said, distinct from
        // the quoted body below: the label names what this conversation is about, the quote shows the words
        // that got them here.
        // Kept as the channel's short, member-readable topic LABEL. The welcome no longer sources it
        // from here — it reads `priorSubject` from the channel-context store (written above), and only
        // falls back to this field for channels created before that move.
        triggerContext: sanitizeTriggerContext(input.topicLabel),
        // NO `priorMessage` HERE. The person's quoted words live in the channel-context store now.
        // Metadata caps the WHOLE blob at ~1KB, shared with the model fields and the parent pointers,
        // which is the only reason the quote was ever truncated — and, being member-writable, Metadata
        // made it editable by the very person it quotes.
      }),
    }),
  );
  const channelArn = createResp.ChannelArn;
  if (!channelArn) {
    throw new Error('create-channel returned no ARN');
  }

  // 2. Associate the channel flow BEFORE any membership, and before anything can post.
  //
  // `CreateChannel` takes no channel-flow field, so immediately after is the earliest possible moment.
  // It has to be here rather than after the membership calls below: the assistant is a member from
  // `CreateChannel` itself (it is the acting bearer), so Lex can fire `WelcomeIntent` from that instant,
  // and every message created before this association bypasses the flow entirely — including the
  // welcome. The same reordering was applied to the primary `create-conversation` path; this drift path
  // was missed, so drift-spawned channels kept the defect after it was fixed next door.
  //
  // Best-effort: a failure here is non-fatal (the conversation still works, ungated) and is logged.
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

  // 3. Add the user as member + moderator.
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

  // 4. NO explicit assistant enrollment, and NO opening message posted here.
  //
  //    The assistant is a channel member from creation itself, because it is the `ChimeBearer` on
  //    CreateChannel, and that automatic membership is what fires its `WelcomeIntent`. VERIFIED against live
  //    Chime (2026-08-03): a channel created by a bot bearer with no `CreateChannelMembership` call at all
  //    receives the composed welcome within seconds. Chime owns that behaviour and it cannot be opted out of.
  //
  //    So this path gets the same welcome as any other conversation, composed from the deployment's
  //    orientation plus the drift context stamped in Metadata above: `triggerContext` as the by-reference
  //    subject, `parentChannelArn` + `originatingMessageId` as the link back.
  //
  //    This REPLACES a hardcoded "started from a drift suggestion" message that used to be sent here. That
  //    message was not filling a gap - the welcome was already arriving - so a drift conversation opened with
  //    TWO bot messages, one of them bypassing the composer entirely (no company, no access line, no example
  //    prompts, none of the config-driven behaviour or error recording).

  // 5. Point the PARENT conversation at the child, DURABLY.
  //
  //    The confirm reply the parent already receives comes back through Lex, and a Lex-delivered message
  //    cannot carry Chime message Metadata. It carries a `NAVIGATE_CHANNEL:` marker instead, which the client
  //    consumes once to switch conversations and `stripMessageMarkers` then removes for display - so scrolling
  //    back later shows the announcement with no way to reach the conversation it announced.
  //
  //    This follow-up message carries the link as METADATA, which survives marker stripping and stays
  //    followable. It deliberately does NOT repeat the marker: the Lex reply owns the one-shot navigation, so
  //    duplicating it here would switch the user's conversation twice.
  //
  //    Best-effort. The child exists and is usable; a failure here costs the back-reference from the parent,
  //    which is worth logging loudly and not worth failing the redirect over.
  try {
    await messagingClient.send(
      new SendChannelMessageCommand({
        ChannelArn: input.parentChannelArn,
        // "Moved that topic", NOT "continuing in a new conversation". This conversation is not over: the
        // point of the drift redirect is to keep both threads clean, so the original stays in place for
        // whatever else is live in it. Copy that implies the conversation moved tells the person their
        // thread ended, which is both wrong and the opposite of what the suggestion offered them.
        Content: `Moved ${title} to its own conversation. This one stays open for anything else.`,
        Metadata: JSON.stringify({
          driftRedirect: { childChannelArn: channelArn, label: title },
        }),
        Type: ChannelMessageType.STANDARD,
        Persistence: ChannelMessagePersistenceType.PERSISTENT,
        ChimeBearer: input.botArn,
      }),
    );
  } catch (err) {
    console.error('[channel-creation] parent-side link message failed; the redirect is not followable:', err);
  }

  return { channelArn, channelId };
}

/**
 * The drift subject, as a by-reference LABEL for the welcome.
 *
 * Capped at the 240 chars the welcome composer accepts, and marker-stripped, because it lands in channel
 * Metadata (member-readable and member-writable) and then in composed copy. It is the model's topic for the
 * drift, never the user's message body - SPEC-DRIFT-CONVERGENCE forbids copying that into a new conversation,
 * so the body is reached by link instead.
 */
function sanitizeTriggerContext(label: string): string {
  // stripMessageMarkers, not a local regex: the hand-rolled copy this replaces covered only the
  // comment pattern, so a NAVIGATE_CHANNEL marker - a deliberate injection defense - survived into
  // member-readable Metadata, and any future pattern added to the canonical list would have been
  // silently missed here.
  return stripMessageMarkers(label || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/** The quoted user message: marker-stripped and capped, since it reaches member-readable Metadata and
 *  then the composed welcome. */
function sanitizeQuotedMessage(text: string): string {
  return stripMessageMarkers(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
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
