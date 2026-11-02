/**
 * A classification value, one of the set the deployment declares (`GET /classifications`,
 * `config/classifications.ts`). A string, because a deployment names its own classifications.
 */
export type UserTier = string;

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
  /**
   * The classification channel Metadata claims, for display only. Absent when Metadata names none: it is
   * member-writable, so it is never defaulted and never decides access.
   */
  modelTier?: UserTier;
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
  /** Where this conversation's people come from when its type enforces it (`group:ops`), else absent.
   *  A DISPLAY HINT from channel Metadata: the client disables Share and says why; the server refuses
   *  the share from its own record whatever this says. */
  membershipSource?: string;
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
  /**
   * The conversation this one continued into, when this message announced a redirect (drift confirm).
   *
   * Carried on the message's Chime Metadata, NOT parsed from its content: the `NAVIGATE_CHANNEL:` marker that
   * drives the immediate switch is stripped before display, so it cannot be the durable record. This is what
   * lets the parent conversation stay followable after the fact.
   */
  driftRedirect?: { childChannelArn: string; label: string };
  /**
   * A PROPOSAL ADDRESSED TO THIS PERSON (ADR-061 decision 8, rule 8): the handle of something an assistant proposed and
   * only they may confirm, carried on the targeted message's Metadata and drawn as a confirmation card.
   */
  proposal?: { id: string; op: string; expiresAt: number };
  /**
   * A TASK A WORKFLOW ASSIGNED THIS PERSON (ADR-063 decision 2): the task's handle, the state the card was drawn in and the
   * choices it offers, carried on the targeted message's Metadata and drawn as a task card.
   */
  taskCard?: { id: string; state: string; choices: string[]; expiresAt?: number };
  // True when the SendChannelMessage Target included the current user's ARN —
  // i.e., the message was targeted to us (and is invisible to other channel
  // members). Used to drive the sticky-mention follow-up behavior.
  targetedToUser?: boolean;
  /**
   * WHICH STEP OF THE ANSWER THIS MESSAGE IS, as the backend declared it (`respPhase` in the Chime
   * metadata): `placeholder`, `interim`, `final`, `error`, `notice`.
   *
   * Carried through rather than inferred from the text, because "is this the settled answer?" is a
   * question several readers ask and only the writer can answer. A delivering turn now updates its
   * placeholder mid-flight ("Trimming the report to 1-2 pages..."), which looks exactly like a settled
   * short reply to anything reading the DOM - and an e2e that mistook one for the answer sent its next
   * message into a turn that was still generating, producing the report twice.
   *
   * Undefined for messages whose writer stamped no phase.
   */
  responsePhase?: string;
  /**
   * WHAT KIND OF MESSAGE THE TURN DECLARED THIS ONE TO BE (`turnKind` in the Chime metadata), when it
   * declared one. Read for `receipt`: a duel side's private placeholder that became the person's
   * receipt is no longer that side's answer, so it stops rendering as one (`battleAfterUpdate`).
   */
  turnKind?: string;
  /**
   * THE QUEUE'S STATE TOKEN, on a deferral notice (ADR-033). A count, never the queue itself.
   *
   * The notice is posted when messages start waiting, updated as more arrive, and updated to zero
   * when the drain reads them - so this changes exactly when the queue does. A client watches it to
   * know something CHANGED and then re-reads the record, which stays the only authority. Carrying the
   * waiting ids here instead would grow with the queue, need rewriting on every send, and still tell
   * a client that joined late nothing at all.
   */
  queueDepth?: number;
  /**
   * WHICH STAGE of working the queue this notice is reporting.
   *
   * Carried alongside the depth because the two answer different questions: the depth says how much
   * is waiting, the stage says whether anything is happening to it. A queue being worked and a queue
   * that is stuck look identical without this - the same messages, marked waiting, for as long as it
   * takes - and the difference is the whole of the waiting person's experience of it.
   *
   * The visible words are already in the notice text, so a client that renders nothing from this
   * still shows the person the stage. What it enables is BRANCHING on the stage without parsing
   * prose that a deployment is free to have reworded, or to have written in another language.
   */
  queueStatus?: string;
  /**
   * The deployment's own wording for that stage, when it configured any.
   *
   * Present only when somebody deliberately chose words. It WINS over the client's translation,
   * because a deployment that worded a stage on purpose must not have that replaced by a locale
   * file; absent means nobody chose, and the client says it in the reader's language.
   */
  queueStatusLabel?: string;
  // Multi-part response grouping
  responseGroup?: string;
  continuation?: boolean;
  /** The message a continuation part belongs to, so it is shown with it rather than wherever it was posted. */
  parentMessageId?: string;
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
    // The side's name from its profile, from the
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
  // A duel side waiting on the person (DESIGN-BATTLE, "A side parked on the person"): set while the
  // message the side parked on carries its `<!--battlewaiting-->` marker, and cleared when the resume
  // or the end of the duel takes the marker down. Drives the side's "Reply to this side" control;
  // `ownerId` is the person it waits on.
  battleWaiting?: { battleId: string; botArn: string; ownerId?: string };
  // /battle generation-out (SPEC-BATTLE.md) has no field of its own: a generated image arrives as
  // `attachment` like any other, and the scorecard's pick-the-winner works unchanged (the user
  // compares the two images). A failed/withheld reply simply carries no attachment.
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
  /** Lifecycle state derived from the archive: 'live', 'archived' (conversation
   *  archived, read-only), or 'deleted' (the Chime channel was deleted; archive
   *  rows persist). Absent on the Athena path → treat as 'live'. */
  state?: 'live' | 'archived' | 'deleted';
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
  /** WHO SENT IT IS A SEPARATE GRANT FROM WHAT WAS SENT, so this is OPTIONAL and a surface must not
   *  assume it (SPEC-ADMIN-CONSOLE FR41). `Name` on an `AppInstanceUser` is the person's email, so
   *  the server omits the field entirely for a caller without the identity capability rather than
   *  sending a null - absent cannot be confused with "the server forgot", and an older client renders
   *  nothing rather than the string "null". `senderArn` always identifies the sender: its last
   *  segment is the Cognito sub, which is what a person-bearing surface renders by default. */
  senderName?: string;
  timestamp: string;
  isBot: boolean;
  redacted?: boolean;
  /** True when a moderator DELETE removed the message (content blanked, like redacted but distinct). Aurora mode only. */
  deleted?: boolean;
  /** WHO redacted/deleted this message + when — from the moderation_actions audit (server-verified
   *  actor). Undefined when no audit row exists (bot self-delete, or pre-audit moderation). */
  moderatedByName?: string;
  moderatedByArn?: string;
  moderatedAt?: string;
  modelId?: string;
  intent?: string;
  /** True when an exchange claims this message as its answer. Only an answer can be flagged, because
   *  the Flagged list reaches a flag through its exchange. Aurora mode only. */
  answersTurn?: boolean;
  /** The reason a moderator raised a flag on this response (`human_flag`, migration 059), and when.
   *  Undefined when nobody has: unflagged is the absence of a flag, not a stored state. The closed
   *  set is shared with the chat client's `FeedbackReason`, so a moderator's reason and an end
   *  user's reason are the same vocabulary and count together. */
  flagReason?: 'wrong_assistant' | 'poor_answer' | 'asked_again';
  flaggedAt?: string;
  /** Every version of an edited message, the original first and the latest last. Absent on a message
   *  never edited, and on a removed one: a removal blanks every version with the message. */
  versions?: Array<{ at: string; content: string }>;
  metadata?: Record<string, unknown>;
  /** Full archived message Payload (all fields incl raw Metadata + MessageAttributes) — for the inspect/"info" panel. */
  raw?: Record<string, unknown>;
}

/** One raw archived event (any event_type) for the complete dev-persona event log. */
export interface AdminConversationEvent {
  eventType: string;
  messageId: string | null;
  /** Optional for the reason `AdminConversationMessage.senderName` is. Distinct from `null`, which
   *  this field already used to mean "the archived event carried no sender": absent means withheld. */
  senderName?: string | null;
  senderArn: string | null;
  targetArn: string | null;
  content: string | null;
  createdAt: string;
  isBot: boolean;
  metadata?: Record<string, unknown> | null;
}

/** One membership-change event (join/leave/moderator) from the archive — audit timeline. */
export interface AdminMembershipEvent {
  action: 'joined' | 'left' | 'granted_moderator' | 'revoked_moderator' | string;
  memberArn: string;
  /** Optional for the reason `AdminConversationMessage.senderName` is. */
  memberName?: string;
  /** The INVITER's display name, which is an email like every other `Name` here - so it is withheld
   *  under the same grant. Unlike the member it describes, no ARN accompanies it: the archive row
   *  carries only `sender_name`, so there is no id to fall back to and the surface omits the clause. */
  invitedBy?: string;
  timestamp: string;
  isBot: boolean;
  /** True for a member the others could not see. Absent where the archive row predates recording it. */
  hidden?: boolean;
  /** True for the creating identity's own join, moderator grant and leave while it assembled the room. */
  roomSetup?: boolean;
  /** A subject change (`subject_added`, `subject_dropped`): the summarizer's label. */
  subject?: string;
  /** A drift flag (`subject_flagged`): the message that raised it, and how the offer ended. */
  messageId?: string;
  subjectOutcome?: string;
}
