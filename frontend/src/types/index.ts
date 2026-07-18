export type UserTier = 'premium' | 'standard' | 'basic';

export type MessageStatus = 'sending' | 'sent' | 'failed';

export interface User {
  id: string;
  name: string;
  email: string;
  tier: UserTier;
  userArn: string;
}

export interface Conversation {
  id: string;
  conversationArn: string;
  title: string;
  modelId: string;
  modelName: string;
  modelTier: UserTier;
  createdAt: Date;
  updatedAt: Date;
  lastMessage?: string;
  /** Timestamp of the most recent message in the channel. From
   *  channelSummary.LastMessageTimestamp — compared against lastReadAt +
   *  the local viewedAt map to derive unread state. */
  lastMessageAt?: Date;
  /** Chime SDK native per-member read marker. Returned on
   *  AppInstanceUserMembershipSummary.ReadMarkerTimestamp. Updated by
   *  chimeService.markConversationRead. Eventually consistent — combine
   *  with the in-memory viewedAt map for reliable comparison. */
  lastReadAt?: Date;
  /** Archived (SPEC-CONVERSATION-ARCHIVE, ADR-017): read-only, hidden from the
   *  active list by default (revealed by the "Show archived" toggle). Membership
   *  is retained, so members keep read-only access until the channel expires.
   *  Display mirror of the authoritative `archived` channel tag. */
  archived?: boolean;
}

export interface MessageSender {
  arn: string;
  name: string;
}

export interface Attachment {
  fileKey: string;
  name: string;
  size: number;
  type: string;
}

export interface ActiveTask {
  type: string;
  status: string;
  label: string;
}

export interface Message {
  id: string;
  content: string;
  sender: MessageSender;
  timestamp: Date;
  isBot: boolean;
  attachment?: Attachment;
  activeTask?: ActiveTask;
  status?: MessageStatus;
  modelId?: string;
  intent?: string;
  feedback?: 'up' | 'down' | null;
  // Experiment feedback join: the experiment +
  // variant that served this bot message, lifted from its Chime analytics
  // metadata. Carried so a thumbs vote can attribute itself per-variant live.
  // Undefined on messages not served by an experiment (the common case).
  experimentId?: string;
  variantId?: string;
  assignmentMode?: string;
  // True when the SendChannelMessage Target included the current user's ARN —
  // i.e., the message was targeted to us (and is invisible to other channel
  // members). Used to drive the sticky-mention follow-up behavior.
  targetedToUser?: boolean;
  // Multi-part response grouping
  responseGroup?: string;
  continuation?: boolean;
  part?: number;
  totalParts?: number;
  // Drift-confirm redirect — when the bot suggests switching/creating a
  // conversation, the message carries a NAVIGATE_CHANNEL marker. The
  // frontend auto-switches the active conversation when this is present.
  navigateChannel?: { channelArn: string; channelName: string };
  // /battle marker (SPEC-BATTLE.md) — set on per-bot placeholders
  // and round-2 rebuttal messages. Used by the conversation view to
  // render round dividers + variant chips.
  battle?: {
    battleId: string;
    round: 1 | 2;
    totalRounds: number;
    rivalArn?: string;
    rivalReplyMsgId?: string;
    // Compact per-variant round-1 metrics for the scorecard. Populated
    // by the emission-wiring work (SPEC-BATTLE.md Scope Revision
    // decision 4 — the small summary rides the Chime message; the full
    // steps[] goes via the analytics pipeline due to the ~1KB Metadata
    // cap). Absent until that lands → the scorecard renders "—".
    responseMs?: number;
    estCostUsd?: number | null;
    steps?: Array<{
      stepLabel: string;
      modelId: string;
      durationMs?: number;
      /** Human-readable model label per step ('Claude Sonnet 4.6',
       *  'Amazon Nova Canvas') — surfaced in the per-step expander since
       *  the actual models can vary per step within a single variant. */
      modelLabel?: string;
      /** Model provider per step ('anthropic', 'amazon', 'openai'). */
      provider?: string;
    }>;
    // Resolved variant displayName ("Atlas" / "Echo") from the
    // battlestats `name=` field. The scorecard + variant chip prefer
    // this over the bot's generic Chime AppInstanceUser name.
    label?: string;
    /** Most recent step's model provider (snapshot). Per-step values
     *  live on `steps[]`; this is for tooltips at the variant level. */
    provider?: string;
    /** Most recent step's model label (snapshot). Steps array carries
     *  per-step values for the expander. */
    modelLabel?: string;
    /** Bedrock prompt tokens in (text battles) - cost breakdown input. */
    tokensIn?: number;
    /** Bedrock output tokens out (text battles) - cost breakdown input. */
    tokensOut?: number;
    /** Generation-out: images produced - cost breakdown input. */
    imageCount?: number;
  };
  // /battle clarification (SPEC-BATTLE.md) — set while a bot is blocked
  // on the user (the placeholder shows "Assistant is waiting…" in place
  // of the privately-targeted question). Cleared when the same message
  // is updated with the resumed answer (2B-x-e reuses the placeholder),
  // which is the "waiting ended" signal. Drives the composer's
  // "Replying to:" affordance.
  battleWaiting?: { battleId: string; botArn: string };
  // /battle generation-out (SPEC-BATTLE.md) — set on a battle
  // reply that produced an image. The conversation view renders the
  // image(s) in the bot's message bubble; the scorecard's pick-the-
  // winner works unchanged (user compares the two images). Absent ⇒
  // a text/failed/withheld reply — render the text, never a broken img.
  battleImage?: { urls: string[]; modelId: string; count: number };
}

export interface ChannelMember {
  userArn: string;
  name: string;
  isBot: boolean;
}

/** Sticky-mention target — a real channel member, or the synthetic `@all` entry. */
export type StickyMentionTarget = ChannelMember & { isAll?: boolean };

export interface Model {
  id: string;
  name: string;
  tier: UserTier;
  description: string;
  costPerMillion: {
    input: number;
    output: number;
  };
  icon?: string;
  color?: string;
}

export interface AdminConversationSummary {
  channelArn: string;
  name: string;
  mode?: string;
  privacy?: string;
  messageCount: number;
  memberCount: number;
  lastMessageAt?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface AdminConversationMember {
  memberArn: string;
  name: string;
  type: 'DEFAULT' | 'HIDDEN';
  isBot: boolean;
}

export interface AdminConversationMessage {
  id: string;
  content: string;
  senderArn: string;
  senderName: string;
  timestamp: string;
  isBot: boolean;
  redacted?: boolean;
  /** True when a moderator DELETE removed the message (content blanked, like redacted but distinct). Aurora mode only. */
  deleted?: boolean;
  modelId?: string;
  intent?: string;
  metadata?: Record<string, unknown>;
  /** Full archived message Payload (all fields incl raw Metadata + MessageAttributes) — for the inspect/"info" panel. */
  raw?: Record<string, unknown>;
}

/** One membership-change event (join/leave/moderator) from the archive — audit timeline. */
export interface AdminMembershipEvent {
  action: 'joined' | 'left' | 'granted_moderator' | 'revoked_moderator' | string;
  memberArn: string;
  memberName: string;
  invitedBy?: string;
  timestamp: string;
  isBot: boolean;
}
