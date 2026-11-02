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

import { templateLine } from './message-lines.js';
import { conversationNameFor, conversationNameText, PLACEHOLDER_TITLE } from './conversation-name.js';
import { primaryTagFor } from './conversation-primary.js';
import { stripMessageMarkers } from './message-markers.js';
import {
  ChimeSDKMessagingClient,
  CreateChannelCommand,
  CreateChannelMembershipCommand,
  CreateChannelModeratorCommand,
  DeleteChannelMembershipCommand,
  DeleteChannelModeratorCommand,
  DeleteChannelCommand,
  AssociateChannelFlowCommand,
  DescribeChannelCommand,
  ListTagsForResourceCommand,
  ChannelMessageType,
  ChannelMessagePersistenceType,
} from '@aws-sdk/client-chime-sdk-messaging';
import { randomBytes } from 'crypto';
import {
  CONVERSATION_TYPES,
  DEFAULT_CONVERSATION_TYPE,
  GUEST_VISITOR_TYPE,
  classificationAllowedForType,
  getConversationTypeConfig,
  membershipSourceStamp,
  type ExpirationCriterion,
} from '../../../lib/config/conversation-types.js';
import {
  putChannelContext,
  getChannelContext,
  seedChannelContext,
  type ChannelContextPatch,
} from './channel-context-client.js';
import type { ResolvedAgent } from './default-agents.js';
import type { ParticipantRoleHoldings } from './participant-roles.js';
import { resolvePerson } from './person-identity.js';
import { issuerIdOf } from './trusted-issuers.js';
import { derivedChannelArn, participantContextFor } from './participant-shape.js';
import type { Classification } from '../../../lib/config/model-strategy.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionClient } from './assistant-session.js';
import { personIdFromArn } from './person-arn.js';
import { chimeMessagingClient } from './chime/clients.js';
import { timed, type PhaseTimer } from './cold-path.js';
import { readChannelTags, audienceTagFor } from './channel-classification.js';
import { sendInParts } from './chime/send.js';
import { conversationRef } from './notify-directive.js';
import { UPGRADE_SOURCE_PERSON_TAG, UPGRADE_SOURCE_TAG, visitWelcomeOf } from './upgrade.js';

/** The AppInstanceUser id from a member ARN. '' when the ARN carries no `/user/` segment. */
/**
 * The id the CLIENT knows a conversation by: the last segment of its channel ARN.
 *
 * Mirrors `ChannelArn.split('/').pop()` in `chimeService`, which is what every conversation in the
 * chat app carries as its `id` and what the app puts in `?conversation=` when reflecting its own URL.
 * A deep link naming anything else is a link the client cannot resolve.
 */
/** The channel tag that labels a room with its type key (a label; the context store is the authority). */
export const CONVERSATION_TYPE_TAG = 'conversationType';

function channelIdFromArn(channelArn: string): string {
  return channelArn.split('/').pop() || channelArn;
}

function subFromUserArn(userArn: string): string {
  return personIdFromArn(userArn) || '';
}



// OPENING A CONVERSATION IS A PLATFORM ACTION, done on the calling service's own role, which is scoped
// to its classification (`driftChannelCreateStatements`). It never goes out on an assistant session.
let messagingClient: ChimeSDKMessagingClient = chimeMessagingClient({ requestHandler: BOUNDED_REQUEST_HANDLER });

/**
 * CREATE THROUGH THE HANDLER'S OWN MESSAGING CLIENT. A cold function pays each client's first-call setup once,
 * so a creator that already holds one on its own role hands it here (`create-conversation-at-classification.ts`).
 * It must send as the calling service's role, never on an assistant session. Optional.
 */
export function useChannelCreationMessagingClient(client: ChimeSDKMessagingClient): void {
  messagingClient = client;
}
// THE LINK IN THE PARENT CONVERSATION IS SAID BY THE ASSISTANT, so it goes out on the assistant's session
// where the caller holds one - the router does (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b) - and on the caller's role where it does not.
const conversationClient = sessionClient(ChimeSDKMessagingClient, { requestHandler: BOUNDED_REQUEST_HANDLER });

export interface CreateConversationFromDriftInput {
  /**
   * Whether creation posts the link to the new conversation in the parent. True by default. The
   * conversation split passes false: the processor that asked for the split posts the link itself, as
   * part of the answer it is giving, so the split holds no assistant session at all.
   */
  postParentLink?: boolean;
  /** The assistant's copy, for the parent-side line (`topicMoved`). */
  copy?: { topicMoved?: string };
  appInstanceArn: string;
  botArn: string;
  userArn: string;
  /**
   * The identity that CREATES the channel, so no assistant is a member before the flow is attached:
   * the service admin. Absent or empty refuses the creation - see the block comment above
   * `createConversationFromDrift`.
   */
  creatorBearerArn?: string;
  /** Classification the new channel inherits — should not exceed the parent channel's classification.
   *  The shared union rather than a restatement: this value becomes the new channel's immutable tag,
   *  so a type that omits a deployed profile would make that profile unable to spawn a conversation. */
  modelTier: Classification;
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
  /**
   * Other people who belong in the new conversation, as AppInstanceUser ARNs.
   *
   * A conversation spawned from a subject the ROOM could already read has to carry the room with it,
   * or moving the subject out makes a shared thread vanish for everyone except the person who asked
   * for the split. Empty is the right answer for a private subject, which moves with its requester
   * and nobody else (DESIGN 2.4.2).
   */
  additionalMemberArns?: string[];
}

/**
 * An EVENT-INITIATED conversation of a declared TYPE (ADR-053 Phase 1).
 *
 * Distinct from the drift input above in three ways that matter, each of which is a thing the drift
 * path does that this one must not:
 *
 *   - IT NAMES A TYPE, and the type is what the creator looks its policy up by. The drift path always
 *     creates the ordinary type (`general`), because a split of an ordinary conversation is one, so a
 *     conversation created through it "of type `ops`" would get the ordinary retention and drift on.
 *   - IT TAKES THE CLASSIFICATION AS ITS OWN PARAMETER, and the type constrains it rather than
 *     supplying it. A creator that read the classification off a config file would be a
 *     create-at-any-classification primitive, and the classification tag is the only axis IAM
 *     evaluates.
 *   - IT POSTS NOTHING INTO THE CONVERSATION THE EVENT CONCERNED. The drift path posts "Moved X to its
 *     own conversation", which for an event-initiated creation would be a second bot message describing
 *     something that did not happen. The caller's notification is the only message.
 */
export interface CreateConversationFromEventInput {
  appInstanceArn: string;
  /** The assistant the conversation is created FOR. Never the `CreateChannel` bearer: it is added as a
   *  member and moderator after the flow is attached. */
  botArn: string;
  /**
   * The identity that CREATES the channel, so that no assistant is a member before the channel flow is
   * attached: the service admin. Absent or empty refuses the creation.
   */
  creatorBearerArn?: string;

  /** The person the conversation is created for, added as member and moderator. */
  userArn: string;
  /**
   * The conversation type's registry key. Its `expiration`, `driftEnabled`, `messageFlow` and
   * `defaultAgents` are what this conversation gets, and the key is STAMPED so a later turn resolves
   * the same policy rather than the classification's.
   */
  typeKey: string;
  /**
   * The classification this conversation carries, supplied by the caller and CHECKED against the type.
   * It becomes the channel's immutable tag.
   */
  classification: Classification;
  modelId: string;
  modelName: string;
  /** Short label (<=64 chars) describing what the conversation is about: the room's subject, and its name when no `name` is given. */
  topicLabel: string;
  /**
   * THE NAME THE ROOM IS CREATED WITH, from what opened it (`conversationNameFor`, `conversation-name.ts`): the type's
   * own `name`, the label, the alarm, the summary. Absent: the label.
   */
  name?: string;
  /**
   * WHAT THE ISSUE IS, in the event's own words, so the assistants can open on it rather than ask.
   *
   * A conversation opened because something happened has a subject from the instant it exists, and the
   * people arriving in it already know what it is - they were just told, in the conversation the event
   * concerned. An assistant that opens by asking what they need is the one participant who has not been
   * told, and it makes a room that was created to save a step cost one instead.
   *
   * It reaches two places with two jobs. The WELCOME names it, so the first line a person reads is the
   * reason they are here. The assistant's GROUNDING carries it, so the first question gets an answer
   * about this issue rather than a request to restate it.
   */
  issue?: string;
  /** The channel flow enabling `@assistant` / `@all`. Its absence is fatal here - see the core. */
  channelFlowArn?: string;
  /** The conversation the event concerned, for the link back. No message is posted into it here. */
  parentChannelArn?: string;
  /** Everyone else who belongs here, as AppInstanceUser ARNs - typically the concerned conversation's room. */
  additionalMemberArns?: string[];
  /**
   * The assistants the TYPE names, already resolved from handle to bot ARN (`lib/default-agents.ts`).
   *
   * Resolved by the caller rather than here so the refusal for an unresolvable handle happens before
   * anything is created. A SEPARATE LIST from `additionalMemberArns` on purpose: that loop is
   * individually tolerant of a failed add, because a person missing from a conversation is a
   * degradation, and an assistant missing from it is the feature absent.
   */
  agents?: ResolvedAgent[];
  /**
   * WHO HOLDS WHICH PARTICIPANT ROLE, as the creator resolved them from the type's declared sources
   * (`holdingsAtCreation`, DESIGN-CONVERSATION-TYPES section 6.1). Written with the rest of the context row, before
   * the channel exists, so the room's first workflow reads them.
   */
  participantRoles?: ParticipantRoleHoldings;
  /**
   * The holders of a role that confers `moderator`, other than the opener (a moderator by creation): made moderators
   * of this channel as the service admin, before it leaves (DESIGN-CONVERSATION-TYPES section 6.1).
   */
  roleModerators?: string[];
  /**
   * The CloudWatch alarm the opening event said the conversation is about (ADR-061, the incident watch), written to its
   * context row with the rest, so the router runs `alarm-state-changed` here.
   */
  watchedAlarm?: string;
}

export interface CreateConversationFromDriftResult {
  channelArn: string;
  channelId: string;
}

/** What both entries return: the ARN the server uses and the id the client knows it by. */
export type CreateConversationResult = CreateConversationFromDriftResult;

/**
 * WHY THERE IS ONE CORE AND NOT TWO CREATORS.
 *
 * Six implementations create a conversation in this repo, which is why a conversation type could mean
 * nothing until one of them owned creation (ADR-053). Adding a seventh `CreateChannelCommand` here to
 * serve a second origin would be arguing for consolidation while widening the split, and
 * `test/single-entry-point.test.ts` would be right to fail it. So the origins differ in the four places
 * they actually differ - the channel id, what goes in the context row, what goes in Metadata, and
 * whether a parent message is posted - and share everything else.
 */
type CreationOrigin = 'drift' | 'event' | 'person' | 'context' | 'briefing' | 'guest' | 'upgrade';

interface CoreInput {
  /**
   * The identity that CREATES the channel, so that no assistant is a member before the channel flow is
   * attached: the service admin. Absent or empty refuses the creation.
   */
  creatorBearerArn?: string;

  origin: CreationOrigin;
  appInstanceArn: string;
  botArn: string;
  /**
   * The person the conversation is opened for, added before anyone else. Empty when nobody opened it
   * (a scheduled briefing): then every person is in `additionalMemberArns`.
   */
  userArn: string;
  /**
   * Whether the opener is also made a moderator. True by default: the person who opens a conversation
   * moderates it. False where the person is enrolled rather than opening (a host's add-member, which
   * never hands an enrolled member a moderator role).
   */
  openerModerator?: boolean;
  classification: Classification;
  /** The type key whose config supplies this conversation's policy. */
  typeKey: string;
  /**
   * A caller-supplied channel TTL, which overrides the type's own.
   *
   * ONLY THE PERSON-FACING API HAS ONE, and it is retention toggle 3: a person opening a conversation
   * may ask for a shorter life than their deployment's default. The type's `expiration` is the default
   * (toggle 2) and stays the default - this is applied over it, never under it, and the limit that
   * bounds what may be asked for is enforced at the API surface where the request arrives rather than
   * here, because a refusal has to reach the caller as a 400 with a reason.
   */
  expirationOverride?: { days: number; criterion: ExpirationCriterion };
  channelId: string;
  /**
   * CREATE-OR-GET: the channel id is DETERMINISTIC, so a repeat call names a channel that already exists.
   *
   * The context origin and a path A bind's continuation set it. Two things change, both so that a repeat call writes nothing:
   *   - the context row is written AFTER `CreateChannel` succeeds rather than before it. Written ahead,
   *     a repeat call would overwrite the participant shape and grounding of a conversation that already
   *     exists before learning that it does, and the caller decides who may touch an existing one.
   *   - `ConflictException` from `CreateChannel` reaches the caller untouched, as the signal that the
   *     conversation exists. Nothing has been written by then.
   *
   * Writing after creation is still before any assistant is a member, because the service admin creates,
   * so the welcome reads the row as it does on every other origin.
   */
  createOrGet?: boolean;
  title: string;
  modelId: string;
  modelName: string;
  channelFlowArn?: string;
  parentChannelArn?: string;
  /** The message in the parent this conversation came from, for the deep link. Drift only. */
  originatingMessageId?: string;
  additionalMemberArns?: string[];
  /** People made moderators after they are added, for a participant role that confers it. Event origin only. */
  roleModerators?: string[];
  agents: ResolvedAgent[];
  /** Origin-specific private context, merged over the participant shape this core derives. */
  contextExtras: ChannelContextPatch;
  /** Origin-specific member-readable Metadata, merged over the model fields. */
  metadataExtras: Record<string, unknown>;
  /**
   * Origin-specific channel TAGS, added beside the `classification` tag every conversation carries.
   *
   * PER-ORIGIN RATHER THAN SHARED, because the one tag that uses it was only ever on one origin. The
   * retired person-facing handler tagged its channels `conversationType: 'private'` and this core never
   * did, so drift and event conversations have never carried it. Putting it in the shared tag list to
   * "be consistent" would silently start tagging two populations that never had it, and would label an
   * `ops` conversation `private`, which is a different concept from the registry's type key - the
   * registry says so in its own header. Restoring it where it was lost adds nothing anywhere else.
   */
  tagExtras?: Array<{ Key: string; Value: string }>;
  /**
   * A parent-side message to post after creation, or none. Best-effort when present.
   *
   * A FUNCTION rather than a value because the only thing worth saying in it is where the new
   * conversation is, which is not known until it exists.
   */
  parentMessage?: (created: CreateConversationResult) => {
    content: string;
    metadata: Record<string, unknown>;
  };
  /** Records how long each step took, for the caller's one timing line per request. Optional. */
  timer?: PhaseTimer;
}

/**
 * A drift-spawned conversation's channel id.
 *
 * `randomBytes`, not `Math.random`: this id derives the channel ARN, which keys per-conversation context
 * written before the channel exists (SPEC-USER-PROFILE-AND-ONBOARDING §2), so a repeated id attaches one
 * conversation's participant context to another rather than merely losing a CreateChannel race. Exported so
 * the collision and Chime-legality properties are tested rather than assumed.
 */
/**
 * A person-opened conversation's channel id.
 *
 * THE FORMAT IS UNCHANGED FROM THE HANDLER THIS REPLACES, deliberately. Channel ids appear in
 * `?conversation=` links people have bookmarked and in every archived row, so a new shape would be a
 * silent break in the one identifier that travels outside this system.
 *
 * `randomBytes` rather than `Math.random`, for the reason the old handler recorded: the participant
 * context row is written under the DERIVED arn BEFORE the channel exists, so a repeated id would attach
 * one request's participant shape to another's conversation - a cross-user leak rather than a retryable
 * conflict.
 */
export function newConversationChannelId(): string {
  return `conv-${Date.now()}-${randomBytes(6).toString('hex')}`;
}

export function newDriftChannelId(): string {
  return `conv-drift-${Date.now()}-${randomBytes(6).toString('hex')}`;
}

/**
 * An event-initiated conversation's channel id, named after its TYPE.
 *
 * NOT `conv-drift-...`, which is why this exists rather than reusing the function above. The id is the
 * last segment of the channel ARN, which is what the client carries as a conversation's id and reflects
 * into its own URL - so it is member-visible, and an `ops` conversation branded a drift child is
 * something an audience reads on screen. It also says the wrong thing to whoever debugs it later.
 *
 * `randomBytes` for the same reason as the drift id: this derives the channel ARN that keys the
 * per-conversation context written BEFORE the channel exists, so a repeated id attaches one
 * conversation's private grounding to another rather than merely losing a `CreateChannel` race.
 *
 * The type key is sanitized into the id rather than trusted: Chime accepts alphanumerics, hyphens and
 * underscores in a channel id, and a registry key is a string a deployer writes.
 */
/** The part of a typed conversation's channel id that names its type. */
const typedChannelSlug = (typeKey: string): string => (typeKey || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'typed';

export function newTypedChannelId(typeKey: string): string {
  return `conv-${typedChannelSlug(typeKey)}-${Date.now()}-${randomBytes(6).toString('hex')}`;
}

/**
 * A drift-spawned conversation: one person, the subject they accepted a suggestion for, and a link
 * back into the conversation it came from.
 *
 * THE TYPE IS THE ORDINARY ONE ON THIS PATH, and that is a statement rather than an omission. Drift
 * spawns an ordinary conversation from an ordinary one, so the key passed to the core is `general`; the
 * classification is a separate input, the parent's own.
 */
/**
 * WHO CREATES THE CHANNEL, AND WHY IT MUST NOT BE AN ASSISTANT.
 *
 * Amazon Chime SDK adds the acting `ChimeBearer` as a member of the channel it creates, and
 * `CreateChannel` takes NO channel-flow field - its input is AppInstanceArn, Name, Mode, Privacy,
 * Metadata, ClientRequestToken, Tags, ChimeBearer, ChannelId, MemberArns, ModeratorArns,
 * ElasticChannelConfiguration, ExpirationSettings. So the flow can only be attached by a second call,
 * and for the whole of that round trip the bearer is a member who can be sent `WelcomeIntent`.
 *
 * WHEN THE BEARER WAS THE ASSISTANT, ITS WELCOME ALWAYS ESCAPED THE FLOW. Measured 2026-08-06 on the
 * primary creation path (welcome delivered, zero flow invocations) and again 2026-10-03 on an
 * event-opened room holding two assistants, which is what finally made it visible: the flow unwrapped
 * the Lex envelope for the assistant added AFTER the association and never saw the bearer's, so one
 * assistant's welcome was stored as rendered text and the other's as `{"Messages":[...]}`. Reordering
 * cannot fix it - the association is already the first thing after creation - because the leak is the
 * bearer's implicit membership rather than a membership this code adds.
 *
 * SO THE SERVICE ADMIN CREATES, and it is the right identity for a different reason too: creating a
 * conversation is an administrative act on the app instance, not something an assistant does on its own
 * behalf. The assistant is then added like any other member, after the flow, so its welcome goes
 * through the flow like any other message. The admin is made to leave once the room is assembled, so no
 * conversation carries a member nobody put there - which also keeps it out of the roster the AUTO
 * trigger counts.
 *
 * ABSENT, NO CONVERSATION IS CREATED. A deployment with no service admin
 * configured, or a read of it that failed, refuses the creation before anything is written rather than
 * creating as the assistant. No creator's role holds a `CreateChannel`, a tag or a membership change
 * bearing an assistant for this path, so an assistant-borne creation would be refused by IAM part way
 * through anyway; refusing first leaves nothing behind and names the cause.
 */
export async function createConversationFromDrift(
  input: CreateConversationFromDriftInput,
): Promise<CreateConversationResult> {
  // NEVER AT AN ADMIN-PLANE CLASSIFICATION. Its assistant has no conversational
  // runtime, so the spawned conversation would be held by an assistant that never answers. Thrown before
  // anything is written: both callers already treat a failed create as a refusal the person is told of.
  if (!profiles.isConversational(input.modelTier)) {
    throw new Error(`a conversation cannot be created at classification "${input.modelTier}"`);
  }
  const title = sanitizeTitle(input.topicLabel);
  const priorSubject = sanitizeTriggerContext(input.topicLabel);
  return createConversationCore({
    origin: 'drift',
    appInstanceArn: input.appInstanceArn,
    botArn: input.botArn,
    userArn: input.userArn,
    classification: input.modelTier,
    // AN ORDINARY CONVERSATION, SPLIT FROM ONE. The classification is the input above; the type is never
    // derived from it. Only an ordinary conversation can drift (`ops` declares drift off), so its split
    // is ordinary too.
    typeKey: DEFAULT_CONVERSATION_TYPE,
    channelId: newDriftChannelId(),
    title,
    modelId: input.modelId,
    modelName: input.modelName,
    channelFlowArn: input.channelFlowArn,
    parentChannelArn: input.parentChannelArn,
    originatingMessageId: input.originatingMessageId,
    additionalMemberArns: input.additionalMemberArns,
    agents: [],
    creatorBearerArn: input.creatorBearerArn,
    contextExtras: {
      // The drift carry-over the welcome composer renders. Written to the context store rather than
      // stamped into channel Metadata for the three reasons on `ChannelContext`: Metadata is not
      // reliably readable at `WelcomeIntent`, it is member-WRITABLE, and its ~1KB cap is what
      // truncated the quoted message.
      ...(priorSubject ? { priorSubject } : {}),
      ...(input.originatingMessageText
        ? { priorMessage: sanitizeQuotedMessage(input.originatingMessageText) }
        : {}),
    },
    metadataExtras: {
      createdViaDrift: true,
      parentChannelArn: input.parentChannelArn,
      originatingMessageId: input.originatingMessageId,
      // WHY this conversation exists, for the welcome composer to read on WelcomeIntent
      // (SPEC-WELCOME-AND-CONTEXT). A short topic LABEL derived from what the person said, distinct from
      // the quoted body: the label names what this conversation is about, the quote shows the words that
      // got them here. The welcome no longer sources it from here - it reads `priorSubject` from the
      // channel-context store - and only falls back to this field for channels created before that move.
      triggerContext: priorSubject,
      // NO `priorMessage` HERE. The person's quoted words live in the channel-context store now.
      // Metadata caps the WHOLE blob at ~1KB, shared with the model fields and the parent pointers,
      // which is the only reason the quote was ever truncated - and, being member-writable, Metadata
      // made it editable by the very person it quotes.
    },
    ...(input.postParentLink === false ? {} : { parentMessage: (created: CreateConversationResult) => topicMovedLink(title, created.channelArn, input.copy) }),
  });
}

/**
 * The line a conversation carries when one of its subjects moved to a conversation of its own, with the
 * link the client follows (`driftRedirect`). One definition for every poster: the router's live-drift
 * confirm, and the processor after a split.
 *
 * "Moved that topic", NOT "continuing in a new conversation". This conversation is not over: the point of
 * the redirect is to keep both threads clean, so the original stays in place for whatever else is live in
 * it. The assistant's own copy (`topicMoved`) replaces the shipped English when its profile sets one.
 */
export function topicMovedLink(
  title: string,
  childChannelArn: string,
  copy?: { topicMoved?: string },
): { content: string; metadata: Record<string, unknown> } {
  return {
    content: templateLine('topic-moved', { copy }, { values: { title } }),
    metadata: { driftRedirect: { childChannelArn, label: title } },
  };
}

export interface CreateConversationForPersonInput {
  appInstanceArn: string;
  /** The assistant this conversation is for: the classification's primary. Added after the flow. */
  botArn: string;
  /** The person opening it, from their JWT claims and never from the request body. */
  userArn: string;
  classification: Classification;
  /** What they called it. Sanitized into a channel name. */
  title: string;
  /** Display-only model labels on the channel's Metadata. Nothing decides anything from them. */
  modelId: string;
  modelName?: string;
  /** Durable "what this conversation is about", which the welcome grounds on. */
  topic?: string;
  /** One-shot "what brought this conversation into existence", weighed above `topic` by the welcome. */
  triggerContext?: string;
  channelFlowArn: string;
  /** Retention toggle 3: a caller-supplied TTL, already bounded by the API surface. */
  expirationOverride?: { days: number; criterion: ExpirationCriterion };
  /** The service admin, so no assistant is a member before the flow is attached. */
  creatorBearerArn?: string;
  /** Records how long each step took. Optional. */
  timer?: PhaseTimer;
}

/**
 * A PERSON OPENS A CONVERSATION. The third origin, and the one an actual human uses.
 *
 * WHY IT IS HERE RATHER THAN IN THE HANDLER. This path predates the helper and created its own channel,
 * which is the split ADR-053 names: a conversation type could mean nothing while the person-facing path
 * honored none of it. Routing it through the core is what makes a type apply to the conversations people
 * actually open - its retention, its assistants, its flow - rather than only to the ones a
 * trigger opens.
 *
 * WHAT MOVING IT HERE CHANGED, stated because "consolidation" sounds like it should change nothing.
 * The conversation is created by the service admin, so every assistant's welcome passes through the
 * channel flow; its context row is written by the same writer every other origin uses; and its default
 * retention is the TYPE's `expiration` rather than an env var mirrored into the handler. The caller's
 * own TTL still wins where it sends one.
 *
 * WHAT IT DOES NOT CHANGE: who is added. The ordinary type declares no `defaultAgents` - only `ops`
 * names any - so `agents` is empty here and the classification's primary is added as the bot this
 * conversation is for, exactly as before. Its membership is manual: the opener is added, and everyone
 * else is added by a person.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It performs no authorization. The reach gate, the admin-plane
 * refusal and the TTL limit are the API surface's, because each has to reach the caller as a specific
 * status and code - and a library that returned those would be inventing an HTTP contract. It throws,
 * and the handler maps.
 */
export async function createConversationForPerson(
  input: CreateConversationForPersonInput,
): Promise<CreateConversationResult> {
  // The same refusal every other origin makes, for the same reason: an admin-plane classification has
  // no conversational runtime, so the conversation would be held by an assistant that never answers.
  // The handler refuses this first with a 400 so a caller is told; this is the backstop for any other
  // caller of the library.
  if (!profiles.isConversational(input.classification)) {
    throw new Error(`a conversation cannot be created at classification "${input.classification}"`);
  }
  return createConversationCore({
    origin: 'person',
    appInstanceArn: input.appInstanceArn,
    botArn: input.botArn,
    userArn: input.userArn,
    classification: input.classification,
    // A PERSON OPENS AN ORDINARY CONVERSATION. The classification is the opener's input above; the type
    // is `general` whatever that classification is, and its membership is manual - the opener is added
    // and everybody else is added by a person. When the client can name a type, it is this argument that
    // changes and nothing else here.
    typeKey: DEFAULT_CONVERSATION_TYPE,
    channelId: newConversationChannelId(),
    title: sanitizeTitle(input.title),
    modelId: input.modelId,
    modelName: input.modelName ?? '',
    channelFlowArn: input.channelFlowArn,
    additionalMemberArns: [],
    agents: [],
    expirationOverride: input.expirationOverride,
    creatorBearerArn: input.creatorBearerArn,
    timer: input.timer,
    contextExtras: {
      // The welcome's grounding fields, on the context store rather than Metadata for the reason
      // `ChannelContext` gives: Metadata is member-WRITABLE and is not reliably readable at
      // `WelcomeIntent`. `topic` is NOT one of them - see `metadataExtras` below.
      ...(input.triggerContext ? { priorSubject: sanitizeTriggerContext(input.triggerContext) } : {}),
      // Read CONSISTENTLY by the welcome; see the note on `topic` in `metadataExtras` below.
      ...(input.topic ? { topic: sanitizeTriggerContext(input.topic) } : {}),
    },
    metadataExtras: {
      // Display-only, and member-readable. Nothing routes on these.
      createdVia: 'person',
      // RESTORED, AND NOTHING IN THE CODE READS IT TODAY. Attribution only: the creator's
      // AppInstanceUser ARN, server-set from the validated JWT claim and never from the request body.
      // Every former reader moved to the Amazon Chime SDK moderator list deliberately, and
      // `channel-battle.ts` records why in its own comments: Metadata is member-WRITABLE, so this value
      // can be rewritten by another member and must never key a per-user decision or grant anything. It
      // is kept because it is the only record on the channel itself of who opened it, which an admin
      // view or an operator reading `DescribeChannel` can use, and because dropping it was a silent
      // reduction rather than a decision. Worst case this blob is 525 bytes of the 1024-byte cap.
      createdBy: input.userArn,
      // THE TOPIC GOES ON METADATA, AND IT IS THE ONE GROUNDING FIELD HERE THAT DOES.
      //
      // Routing it to `contextExtras` alongside `priorSubject` looks more consistent and loses it
      // completely: `topic` is not a field `ChannelContext` owns, and `OWNED_FIELDS`
      // (`channel-context-client.ts`) says in its own comment that "a field absent from this list is
      // SILENTLY DISCARDED on write". `putChannelContext` also swallows write failures, so the drop
      // raised nothing anywhere. The only reader is `router-agent-handler.ts`, which takes it from
      // `channelMeta.topic`, and the chat client sends it on create - so a topic-seeded conversation
      // opened with no topic grounding at all.
      //
      // IT IS ALSO WRITTEN TO THE CONTEXT STORE, in `contextExtras` above, and Metadata alone was not
      // enough. The only reader is `WelcomeIntent`, which fires on the assistant's automatic membership
      // at creation - the one moment the router's own comment calls Metadata "eventually consistent
      // (verified empirically against live Chime)", and the stated reason `priorSubject` moved to the
      // store. Metadata-only would have left the symptom intermittent instead of constant, which is the
      // worse of the two. The store leg is authoritative and this one is the member-editable copy and
      // the fallback for channels created before the move, exactly as `triggerContext` works.
      //
      // Member-writable is acceptable for exactly this field and not for its neighbors: a topic is the
      // subject the member themselves typed into the create form, so a member editing their own
      // conversation's subject is not an escalation. `priorSubject` carries what happened in ANOTHER
      // conversation, which is why it stays server-owned.
      ...(input.topic ? { topic: sanitizeTriggerContext(input.topic) } : {}),
    },
  });
}

export interface CreateConversationForGuestInput {
  appInstanceArn: string;
  /** The guest classification's primary assistant. Added after the flow, like every conversation's. */
  botArn: string;
  /** The visitor guest start minted, composed by the exchange and never taken from a request body. */
  userArn: string;
  classification: Classification;
  modelId: string;
  channelFlowArn: string;
  creatorBearerArn?: string;
  /**
   * The name the room is created with, which the creator words from the room's assistant's templates
   * (`conversationNameFor`). Absent: the type's `name`, then the shipped `conversation-name` template's `label.visitor`.
   */
  name?: string;
  /** Records how long each step took. Optional. */
  timer?: PhaseTimer;
}

/**
 * AN ANONYMOUS VISITOR'S CONVERSATION (A7), opened by guest start through the guest classification's
 * creator. The type is `guest-visitor`, which permits the guest classification alone; the visitor is a
 * member and NOT a moderator, so nothing at the Amazon Chime SDK layer lets them add anyone or change the
 * channel, whatever a credential might later carry; and nobody else is added.
 */
export async function createConversationForGuest(input: CreateConversationForGuestInput): Promise<CreateConversationResult> {
  if (!profiles.isConversational(input.classification) || !profiles.outsideClassificationValues().includes(input.classification)) {
    throw new Error(`a visitor's conversation is created at an outside classification, not "${input.classification}"`);
  }
  if (!classificationAllowedForType(GUEST_VISITOR_TYPE, input.classification)) {
    throw new Error(`conversation type "${GUEST_VISITOR_TYPE}" does not permit classification "${input.classification}"`);
  }
  return createConversationCore({
    origin: 'guest',
    appInstanceArn: input.appInstanceArn,
    botArn: input.botArn,
    userArn: input.userArn,
    openerModerator: false,
    classification: input.classification,
    typeKey: GUEST_VISITOR_TYPE,
    channelId: newTypedChannelId(GUEST_VISITOR_TYPE),
    title: conversationNameText(input.name) || conversationNameFor({ kind: 'visitor', typeKey: GUEST_VISITOR_TYPE }),
    modelId: input.modelId,
    modelName: '',
    channelFlowArn: input.channelFlowArn,
    additionalMemberArns: [],
    agents: [],
    creatorBearerArn: input.creatorBearerArn,
    timer: input.timer,
    contextExtras: {},
    metadataExtras: { createdVia: 'guest' },
  });
}

export interface CreateConversationForUpgradeInput {
  appInstanceArn: string;
  /** The target classification's primary assistant. Added after the flow, like every conversation's. */
  botArn: string;
  /** The account that redeemed the claim, resolved from its own session and never from a body. */
  userArn: string;
  classification: Classification;
  /** The type the claim opens (`claimTargetOf`): `customer-engagement`. */
  typeKey: string;
  /** The visitor's conversation and AppInstanceUser, written as the channel's two upgrade tags. */
  sourceChannelArn: string;
  sourcePersonArn: string;
  /** What the visit carries over, as the assistant's grounding (`visitSeedOf`). */
  seed: Record<string, unknown>;
  /**
   * A DETERMINISTIC channel id (`boundChannelIdOf`), for a path A bind: creation is then create-or-get,
   * and a `ConflictException` reaches the caller as the signal that the conversation exists. Absent (a
   * claim), the id is fresh.
   */
  channelId?: string;
  modelId: string;
  channelFlowArn: string;
  creatorBearerArn?: string;
  /**
   * The name the room is created with, which the creator words from the room's assistant's templates
   * (`conversationNameFor`). Absent: the type's `name`, then the shipped `conversation-name` template's `label.customer`.
   */
  name?: string;
  /** Records how long each step took. Optional. */
  timer?: PhaseTimer;
}

/**
 * A CUSTOMER'S CONVERSATION, OPENED BY A PATH B CLAIM (V5, P-12), OR A BOUND VISITOR'S CONTINUATION,
 * OPENED BY A PATH A BIND (P-11). The account is a member and its moderator, as an opener is; the channel carries `upgradedFrom` and `upgradedFromPerson` beside the
 * classification tag, set at creation and never by a member, which is the only relation between it and the
 * visitor's conversation (D13). The type must permit the classification and declare it is seeded from
 * the source's type.
 */
export async function createConversationForUpgrade(input: CreateConversationForUpgradeInput): Promise<CreateConversationResult> {
  if (!profiles.isConversational(input.classification)) {
    throw new Error(`a conversation cannot be created at classification "${input.classification}"`);
  }
  if (!classificationAllowedForType(input.typeKey, input.classification)) {
    throw new Error(`conversation type "${input.typeKey}" does not permit classification "${input.classification}"`);
  }
  const prefix = `${input.appInstanceArn}/`;
  if (!input.sourceChannelArn.startsWith(`${prefix}channel/`) || !input.sourcePersonArn.startsWith(`${prefix}user/`)) {
    throw new Error('an upgrade names the visitor\'s conversation and AppInstanceUser in this app instance');
  }
  return createConversationCore({
    origin: 'upgrade',
    appInstanceArn: input.appInstanceArn,
    botArn: input.botArn,
    userArn: input.userArn,
    classification: input.classification,
    typeKey: input.typeKey,
    channelId: input.channelId ?? newTypedChannelId(input.typeKey),
    createOrGet: input.channelId !== undefined,
    title: conversationNameText(input.name) || conversationNameFor({ kind: 'customer', typeKey: input.typeKey }),
    modelId: input.modelId,
    modelName: '',
    channelFlowArn: input.channelFlowArn,
    additionalMemberArns: [],
    agents: [],
    creatorBearerArn: input.creatorBearerArn,
    timer: input.timer,
    // THE SEED IS GROUNDING, AND ITS ONE LINE IS THE WELCOME'S (FR26): the assistant's own sentence about
    // the visit, which the composer renders; absent when the visit was not assessed.
    contextExtras: { domainContext: input.seed, ...(visitWelcomeOf(input.seed) ? { visitSummary: visitWelcomeOf(input.seed) } : {}) },
    metadataExtras: { createdVia: 'upgrade' },
    tagExtras: [
      { Key: UPGRADE_SOURCE_TAG, Value: input.sourceChannelArn },
      { Key: UPGRADE_SOURCE_PERSON_TAG, Value: input.sourcePersonArn },
    ],
  });
}

/** The channel id every visitor's conversation is created with: the `guest-visitor` type's slug. */
export const VISITOR_CHANNEL_ID_PREFIX = `conv-${typedChannelSlug(GUEST_VISITOR_TYPE)}-`;

/**
 * WHETHER A CHANNEL IS A VISITOR'S CONVERSATION OF THIS CLASSIFICATION: of this app instance, created with
 * the visitor type's id, and tagged with the outside classification asking. The tag is the creator's, never
 * a member's, so the answer is trusted. Throws when the tags cannot be read.
 */
export async function isVisitorConversation(
  messaging: { send(command: unknown): Promise<any> },
  input: { appInstanceArn: string; channelArn: string; classification: string },
): Promise<boolean> {
  if (!profiles.outsideClassificationValues().includes(input.classification)) return false;
  const prefix = `${input.appInstanceArn}/channel/${VISITOR_CHANNEL_ID_PREFIX}`;
  if (!input.channelArn.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(input.channelArn.slice(prefix.length))) return false;
  const tags = await readChannelTags(messaging as never, input.channelArn);
  return tags.classification === input.classification;
}

/**
 * A VISITOR'S CONVERSATION, RETIRED ONCE ITS VISIT HAS CARRIED OVER (P-12, FR26): deleted as the service
 * admin, after the new conversation and its seed exist. The visitor's AppInstanceUser is not touched; it
 * lapses on its own expiration. Erasure needs nothing from the deleted channel: it follows the new
 * conversation's `upgradedFrom` tag, and a source that no longer exists has nothing left to remove
 * (`lib/offboarding.ts`). A channel already gone is done; anything else that refuses is a throw.
 */
export async function retireVisitorConversation(
  messaging: { send(command: unknown): Promise<any> },
  input: { appInstanceArn: string; channelArn: string; classification: string; bearerArn: string },
): Promise<void> {
  try {
    if (!(await isVisitorConversation(messaging, input))) throw new Error('only a visitor\'s conversation of this classification is retired here');
    await messaging.send(new DeleteChannelCommand({ ChannelArn: input.channelArn, ChimeBearer: input.bearerArn }));
  } catch (err) {
    if ((err as { name?: string })?.name === 'NotFoundException') return;
    throw err;
  }
}

/**
 * AN EVENT-INITIATED CONVERSATION OF A DECLARED TYPE (ADR-053 Phase 1).
 *
 * The type is honored here and only here. A conversation opened through the person-facing API honors no
 * type at all - not its retention, not its agents, not its flow - which is the consolidation ADR-053
 * describes and not a defect of this entry.
 *
 * THE TYPE CONSTRAINS THE CLASSIFICATION RATHER THAN SUPPLYING IT. Refused before a channel exists,
 * because a creator that took the classification from a config file would be able to mint a conversation
 * at any classification that file names, and the classification tag is the only axis IAM evaluates
 * (tenet P4). The caller's own principal is pinned to one classification besides, so this check and that
 * pin have to agree for a creation to happen at all.
 */
export async function createConversationFromEvent(
  input: CreateConversationFromEventInput,
): Promise<CreateConversationResult> {
  if (!CONVERSATION_TYPES[input.typeKey]) {
    throw new Error(`unknown conversation type "${input.typeKey}"`);
  }
  if (!classificationAllowedForType(input.typeKey, input.classification)) {
    throw new Error(
      `conversation type "${input.typeKey}" does not permit classification "${input.classification}"`,
    );
  }
  // The same refusal the drift path makes, for the same reason: an admin-plane assistant has no
  // conversational runtime, so the conversation would be held by an assistant that never answers.
  if (!profiles.isConversational(input.classification)) {
    throw new Error(`a conversation cannot be created at classification "${input.classification}"`);
  }
  // A CONVERSATION NOBODY CAN ADDRESS IS BROKEN RATHER THAN DEGRADED, and this is the last point at
  // which saying so costs nothing. An `ops` conversation exists so a second assistant can be addressed
  // in it; with no flow the conversation comes up named, populated and inert, and no person is sitting
  // in it to notice. Checked HERE rather than in the core because by the time the core could check, the
  // channel exists - and a refusal then would abandon it.
  if (!input.channelFlowArn) {
    throw new Error(
      'an event-initiated conversation needs a channel flow: without one no assistant in it can be '
      + 'addressed, so the conversation would be created inert',
    );
  }
  return createConversationCore({
    origin: 'event',
    appInstanceArn: input.appInstanceArn,
    botArn: input.botArn,
    userArn: input.userArn,
    classification: input.classification,
    typeKey: input.typeKey,
    // NOT `conv-drift-...`. The drift id is member-visible in every client that shows a conversation id,
    // and an `ops` conversation branded a drift child is a thing an audience reads on screen.
    channelId: newTypedChannelId(input.typeKey),
    title: conversationNameText(input.name) || sanitizeTitle(input.topicLabel),
    modelId: input.modelId,
    modelName: input.modelName,
    channelFlowArn: input.channelFlowArn,
    parentChannelArn: input.parentChannelArn,
    additionalMemberArns: input.additionalMemberArns,
    ...(input.roleModerators?.length ? { roleModerators: input.roleModerators } : {}),
    agents: input.agents ?? [],
    // The service admin, so no assistant is a member before the flow is attached. See the block comment
    // above `createConversationFromDrift` for the measurement. Absent refuses the creation.
    creatorBearerArn: input.creatorBearerArn,
    // ── THE CONVERSATION CARRIES ITS OWN REASON FOR EXISTING ──────────────────────────────────────
    //
    // An earlier version of this path deliberately carried nothing, on the reasoning that `priorSubject`
    // is drift carry-over and an event-opened conversation has no prior subject to refer to. That was
    // wrong, and wrong in a way that cost the thing the conversation is for: it HAS a subject from the
    // instant it exists - the event - and everybody arriving already knows what it is, because they were
    // just told in the conversation the event concerned. An assistant opening with a generic greeting is
    // the only participant who has not been told.
    //
    // `priorSubject` IS THE RIGHT FIELD, and the sentence it renders is right too: "this conversation
    // picks up <subject>, so the other thread can carry on" is exactly what happened - a specialist room
    // was opened for the issue and the original conversation continues. It also suppresses the
    // introduce-the-company lead, which is correct here: nobody arrived cold.
    //
    // THE LABEL, NOT THE SENTENCE. That clause reads as a noun phrase, so it takes the topic label
    // ("error rate above threshold") rather than the event's full line ("The platform error rate crossed
    // its threshold."), which would render as a sentence inside a sentence.
    //
    // AND THE GROUNDING TAKES THE FULL LINE, because that is the half the model reads. The welcome is
    // composed rather than generated, so a person seeing the subject does not mean the assistant knows
    // it: without this, the first question is answered by an assistant that has to ask what the issue
    // is. `domainContext.title` is the primary grounding field and "what this conversation is about" is
    // what it means.
    //
    // ONLY WHERE THERE IS ANOTHER THREAD. A type the platform opens on its own (`initiation: 'system'`,
    // e.g. `ops-team`) has no conversation the event concerned, so "picks up <subject>, so the other
    // thread can carry on" names a thread that does not exist. With no
    // parent the label is the room's `topic` instead, which renders as what the room is for.
    contextExtras: {
      ...(input.participantRoles && Object.keys(input.participantRoles).length ? { participantRoles: input.participantRoles } : {}),
      ...(input.watchedAlarm ? { watchedAlarm: input.watchedAlarm } : {}),
      ...(sanitizeTriggerContext(input.topicLabel)
        ? (input.parentChannelArn
          ? { priorSubject: sanitizeTriggerContext(input.topicLabel) }
          : { topic: sanitizeTriggerContext(input.topicLabel) })
        : {}),
      ...(input.issue?.trim()
        ? {
            domainContext: { title: sanitizeQuotedMessage(input.issue) },
            // AND THE SAME LINE WHERE THE WELCOME CAN REACH IT.
            //
            // `domainContext.title` is grounding: the model reads it, the composer does not, and the
            // paragraph above is explicit that the split is deliberate. What it did not anticipate is a
            // type whose welcome should SAY what happened rather than only know it. `eventSummary` is a
            // conversation field, so it is carried on the channel and never settable from the deployment
            // parameter, and it renders only where a type's template asks for it - an un-templated type
            // is byte-identical to before.
            eventSummary: sanitizeQuotedMessage(input.issue),
          }
        : {}),
    },
    // NO `createdViaDrift`, and nothing claiming an originating message. This conversation has a parent
    // in the sense that an event concerned it, which the context row's `parentRef` carries as a link.
    metadataExtras: {
      ...(input.parentChannelArn ? { parentChannelArn: input.parentChannelArn } : {}),
    },
    // NO PARENT MESSAGE. The caller posts the notification, and a creator that also posted would put two
    // bot messages in the concerned conversation, one of them describing something that did not happen.
  });
}

/**
 * THE CHANNEL ID OF A HOST'S CONTEXT CONVERSATION: deterministic from the classification and the host's
 * context, so the same context always names the same channel (create-or-get), and charset-safe for an
 * Amazon Chime SDK ChannelId (`[A-Za-z0-9_-]`, at most 64). Classification-scoped, so a deployment that
 * changes the classification its oneChannel issuers name creates fresh channels carrying the new
 * classification's tag rather than re-opening ones its assistant cannot act in.
 */
export function contextChannelId(classification: string, contextType: string, contextId: string): string {
  return `ctx-${classification}-${contextType}-${contextId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
}

export interface CreateConversationForContextInput {
  appInstanceArn: string;
  /** The classification's primary assistant. Added after the flow, like every other origin. */
  botArn: string;
  /** The person, as the AppInstanceUser the credential exchange resolved them to. */
  userArn: string;
  /** The context classification the registry's oneChannel issuers name, never the request's. */
  classification: Classification;
  /** DETERMINISTIC from the host's context, so a repeat call names the same channel (create-or-get). */
  channelId: string;
  /** The host's title, used as given: it can be any script. */
  title: string;
  /** The context binding (`contextType`, `contextId`, `topic`): member-readable, so labels only. */
  metadataExtras: Record<string, unknown>;
  /** Channel tags beside `classification`, the primary and the type (the `contextType` label). */
  tagExtras?: Array<{ Key: string; Value: string }>;
  /** The host's private grounding and roster, for the server-only context row. */
  contextExtras: ChannelContextPatch;
  channelFlowArn?: string;
  /** The service admin, so no assistant is a member before the flow is attached. */
  creatorBearerArn?: string;
  /**
   * Whether the person is made a moderator. True for the host user opening their own conversation;
   * false for a member the host enrolls (`membershipHandler` in `conversation-management.ts`), who is
   * never handed a moderator role.
   */
  openerModerator?: boolean;
  /** Records how long each step took. Optional. */
  timer?: PhaseTimer;
}

/**
 * A HOST APP OPENS A CONTEXT-BOUND CONVERSATION FOR ITS OWN USER. The fourth origin.
 *
 * It creates the way every other origin does: the service admin creates, the flow is attached, the
 * assistant and the person are added, and the admin leaves.
 *
 * WHAT LEGITIMATELY DIFFERS, and nothing else does: the channel id is deterministic from the host's
 * context (`contextChannelId`), so creation is create-or-get and a `ConflictException` is returned to
 * the caller to decide who may re-open the existing conversation; the context binding goes in Metadata
 * and the host's grounding in the context row; and the classification is the one the trusted-issuer
 * registry's oneChannel issuers name, never the request's.
 */
export async function createConversationForContext(
  input: CreateConversationForContextInput,
): Promise<CreateConversationResult> {
  // The same backstop every origin has. The registry refuses a oneChannel classification that is not
  // conversational at synth.
  if (!profiles.isConversational(input.classification)) {
    throw new Error(`a conversation cannot be created at classification "${input.classification}"`);
  }
  return createConversationCore({
    origin: 'context',
    appInstanceArn: input.appInstanceArn,
    botArn: input.botArn,
    userArn: input.userArn,
    classification: input.classification,
    // An ordinary conversation: a context room records no type of its own.
    typeKey: DEFAULT_CONVERSATION_TYPE,
    channelId: input.channelId,
    createOrGet: true,
    title: input.title,
    // Display-only labels nothing decides from; a context room is not opened for a chosen model.
    modelId: '',
    modelName: '',
    channelFlowArn: input.channelFlowArn,
    additionalMemberArns: [],
    agents: [],
    creatorBearerArn: input.creatorBearerArn,
    openerModerator: input.openerModerator,
    timer: input.timer,
    contextExtras: input.contextExtras,
    metadataExtras: input.metadataExtras,
    tagExtras: input.tagExtras,
  });
}

export interface CreateConversationForBriefingInput {
  appInstanceArn: string;
  /** The classification's primary assistant. Added after the flow, like every other origin. */
  botArn: string;
  /** Everyone the briefing is for, as AppInstanceUser ARNs. Each is added as a member, none as a moderator. */
  memberArns: string[];
  classification: Classification;
  channelId: string;
  title: string;
  /** Member-readable labels for the briefing (when and why it was generated). */
  metadataExtras: Record<string, unknown>;
  channelFlowArn?: string;
  /** The service admin, so no assistant is a member before the flow is attached. */
  creatorBearerArn?: string;
}

/**
 * A SCHEDULED BRIEFING OPENS A CONVERSATION FOR ITS RECIPIENTS. The fifth origin, and the one nobody asks for.
 *
 * It creates the way every other origin does: the service admin creates, the flow is attached, the
 * assistant is added and made a moderator, the recipients are added, and the admin leaves. What differs
 * is that it has no opener: nobody asked for the conversation, so no person is made its moderator, and
 * each recipient is added individually tolerant of failure, as a room's other members are on every
 * origin. A briefing room records no type of its own, so it is the ordinary `general` type.
 */
export async function createConversationForBriefing(
  input: CreateConversationForBriefingInput,
): Promise<CreateConversationResult> {
  if (!profiles.isConversational(input.classification)) {
    throw new Error(`a conversation cannot be created at classification "${input.classification}"`);
  }
  return createConversationCore({
    origin: 'briefing',
    appInstanceArn: input.appInstanceArn,
    botArn: input.botArn,
    userArn: '',
    classification: input.classification,
    typeKey: DEFAULT_CONVERSATION_TYPE,
    channelId: input.channelId,
    title: input.title,
    modelId: '',
    modelName: '',
    channelFlowArn: input.channelFlowArn,
    additionalMemberArns: input.memberArns,
    agents: [],
    creatorBearerArn: input.creatorBearerArn,
    contextExtras: {},
    metadataExtras: input.metadataExtras,
  });
}

/**
 * COMPLETE AN EXISTING CONTEXT CONVERSATION, idempotently: its flow, its context row, then its members.
 *
 * A re-open reaches a conversation whose first creation may have stopped part way, in the order creation
 * runs: the channel created and the flow never attached (`AssociateChannelFlow` failed, which is logged and
 * not fatal for this origin, or the creation died between the two calls), the context row unwritten, the
 * assistant or the person not yet added. The retry's `CreateChannel` answers `ConflictException`, so this
 * is the only code that ever sees that room again, and it finishes it in the order creation would have:
 *
 *   1. THE FLOW, BEFORE ANY MEMBER. Read from the channel (`DescribeChannel`) and associated when missing.
 *      Adding the assistant to a room with no flow is the defect creation's ordering exists to prevent:
 *      its welcome, and every message after, would bypass the flow. A flow that cannot be read or attached
 *      throws, so no member is added to an unflowed room.
 *   2. THE CONTEXT ROW, where it is missing (`seedChannelContext` writes only absent fields, so a complete
 *      row is unchanged). Before the assistant joins, because its welcome reads the participants.
 *   3. THE ASSISTANT AND THE OPENER. Each add tolerates `ConflictException`, the already-there answer.
 *
 * The caller has already decided this person may re-open it; this function decides nothing. The bearer is
 * the service admin: an AppInstanceAdmin may describe, associate and add in any channel of the instance
 * without being in it, so the assistant is never the identity acting here.
 */
export async function reseatContextOpener(input: {
  channelArn: string;
  botArn: string;
  userArn: string;
  bearerArn: string;
  /** The deployment's channel flow, attached when the room has none. */
  channelFlowArn?: string;
}): Promise<void> {
  const tolerateConflict = async (send: () => Promise<unknown>) => {
    try {
      await send();
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConflictException') throw err;
    }
  };
  if (input.channelFlowArn) {
    const described = await messagingClient.send(new DescribeChannelCommand({ ChannelArn: input.channelArn, ChimeBearer: input.bearerArn }));
    const attached = described.Channel?.ChannelFlowArn;
    if (!attached) {
      console.warn('[channel-creation] a re-opened context conversation has no channel flow; attaching it before any member is added', {
        channelArn: input.channelArn,
      });
      await messagingClient.send(new AssociateChannelFlowCommand({
        ChannelArn: input.channelArn, ChannelFlowArn: input.channelFlowArn, ChimeBearer: input.bearerArn,
      }));
    } else if (attached !== input.channelFlowArn) {
      console.error('[channel-creation] a re-opened context conversation carries a different channel flow; left as it is', {
        channelArn: input.channelArn, attached, expected: input.channelFlowArn,
      });
    }
  }
  await seedChannelContext(input.channelArn, sharedContextFields(DEFAULT_CONVERSATION_TYPE, [subFromUserArn(input.userArn)]));
  for (const arn of [input.botArn, input.userArn]) {
    await tolerateConflict(() => messagingClient.send(new CreateChannelMembershipCommand({
      ChannelArn: input.channelArn, MemberArn: arn, Type: 'DEFAULT', ChimeBearer: input.bearerArn,
    })));
    await tolerateConflict(() => messagingClient.send(new CreateChannelModeratorCommand({
      ChannelArn: input.channelArn, ChannelModeratorArn: arn, ChimeBearer: input.bearerArn,
    })));
  }
}

/**
 * ENROL A PERSON THE HOST ADDS IN AN EXISTING CONTEXT CONVERSATION, idempotently: the room's assistant,
 * then the person, each as a DEFAULT member and never a moderator. The bearer is the service admin: an
 * AppInstanceAdmin may add members to any channel of the instance without being in it, so no assistant
 * is the identity acting here. The room's flow was attached when it was created. The caller has already
 * checked the room is of its own classification; this function decides nothing.
 */
export async function addContextMember(input: {
  channelArn: string;
  botArn: string;
  userArn: string;
  bearerArn: string;
}): Promise<void> {
  for (const arn of [input.botArn, input.userArn]) {
    try {
      await messagingClient.send(new CreateChannelMembershipCommand({
        ChannelArn: input.channelArn, MemberArn: arn, Type: 'DEFAULT', ChimeBearer: input.bearerArn,
      }));
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConflictException') throw err;
    }
  }
}

/**
 * ADD AN INVITEE (M-10): the AppInstanceUser an invitation was minted for becomes a DEFAULT member of the
 * one conversation it was invited to, and never a moderator, at invite time. Idempotent. The bearer is the
 * service admin, so no assistant and no person is the identity acting here. The caller has already
 * checked that the inviter is a member, that the conversation's type declares invitations, and that its
 * classification is the one the invitation records; this function decides nothing.
 *
 * MEMBERSHIP BEFORE REDEMPTION REACHES NOTHING: no credential is ever vended as the invitee until its
 * invitation is redeemed, so a member nobody can act as reads and posts nothing.
 */
export async function addInvitedMember(input: { channelArn: string; inviteeArn: string; bearerArn: string }): Promise<void> {
  try {
    await messagingClient.send(new CreateChannelMembershipCommand({
      ChannelArn: input.channelArn, MemberArn: input.inviteeArn, Type: 'DEFAULT', ChimeBearer: input.bearerArn,
    }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConflictException') throw err;
  }
}

/**
 * REMOVE AN INVITEE: a revocation removes the membership the invitation gave (M-10), whether or not it
 * was redeemed, as the service admin. A membership already gone is not an error. A `link` session vended
 * before the revocation lives out its own minutes, and every channel call it makes is refused from here on.
 */
export async function removeInvitedMember(input: { channelArn: string; inviteeArn: string; bearerArn: string }): Promise<void> {
  try {
    await messagingClient.send(new DeleteChannelMembershipCommand({
      ChannelArn: input.channelArn, MemberArn: input.inviteeArn, ChimeBearer: input.bearerArn,
    }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'NotFoundException') throw err;
  }
}

/**
 * A PARTICIPANT ROLE'S MODERATION (DESIGN-CONVERSATION-TYPES section 6.1): a holder of a role that confers `moderator`
 * is made a moderator of this one channel, and unmade when they stop holding it, as the bearer the caller names (the
 * service admin on the invitations path). Already a moderator, or already not one, is not an error. The caller records
 * the moderation's origin `participantRole:<name>` on the holding, so only a moderation of that origin is ever undone.
 */
export async function setParticipantRoleModerator(input: { channelArn: string; personArn: string; bearerArn: string; moderator: boolean }): Promise<void> {
  try {
    await messagingClient.send(input.moderator
      ? new CreateChannelModeratorCommand({ ChannelArn: input.channelArn, ChannelModeratorArn: input.personArn, ChimeBearer: input.bearerArn })
      : new DeleteChannelModeratorCommand({ ChannelArn: input.channelArn, ChannelModeratorArn: input.personArn, ChimeBearer: input.bearerArn }));
  } catch (err) {
    if ((err as { name?: string }).name !== (input.moderator ? 'ConflictException' : 'NotFoundException')) throw err;
  }
}

/**
 * THE ADMIN NOTIFICATION CHANNEL, created through the one creator module like every other conversation
 * (DESIGN-ADMIN-AGENT-NOTIFICATIONS).
 *
 * It differs from a person's conversation on purpose, and the differences are this function's whole
 * contract: the ADMIN ASSISTANT'S BOT creates it, which makes the bot its moderator and the one identity that
 * may post into it; no channel flow is attached, because nothing in it is a turn; and its people are the
 * admins, added afterwards by the provisioner as the service admin. Both tags are set at creation, never
 * by a following `TagResource`: `aeChannelKind` is its identity (what the alert grant names), and
 * `classification` is its boundary, so it is judged on the same closed axis as every other conversation.
 */
export async function createAdminNotificationChannel(input: {
  client: Pick<ChimeSDKMessagingClient, 'send'>;
  appInstanceArn: string;
  /** The admin assistant's AppInstanceBot: the creator, therefore the moderator. */
  botArn: string;
  name: string;
  classification: string;
  kindTag: { key: string; value: string };
  /** The room's primary assistant (`primaryTagFor`): the admin assistant, which speaks for this room as for every other. */
  primaryTag: { Key: string; Value: string };
}): Promise<string> {
  const created = await input.client.send(new CreateChannelCommand({
    AppInstanceArn: input.appInstanceArn,
    Name: input.name,
    Mode: 'RESTRICTED',
    Privacy: 'PRIVATE',
    ChimeBearer: input.botArn,
    Tags: [
      { Key: input.kindTag.key, Value: input.kindTag.value },
      { Key: 'classification', Value: input.classification },
      // Its audience beside it, in the same call: the creator's grant requires both (`createOwnClassificationOnly`).
      audienceTagFor(input.classification),
      input.primaryTag,
    ],
    ClientRequestToken: randomBytes(16).toString('hex'),
    Metadata: JSON.stringify({ kind: 'admin-notifications' }),
  }));
  const arn = created.ChannelArn || '';
  if (!arn) throw new Error('CreateChannel returned no ARN');
  return arn;
}

/** The refusal when no service admin is configured or readable: a conversation is never created as an assistant. */
export class NoServiceAdminError extends Error {
  constructor() {
    super('no service admin is configured to create conversations, so none is created; '
      + 'a conversation is never created as an assistant');
    this.name = 'NoServiceAdminError';
  }
}

/** The service admin that creates, or a refusal. An assistant is never accepted as the creator. */
export function requireServiceAdmin(arn: string | undefined): string {
  const admin = arn?.trim() ?? '';
  if (!admin || admin.includes('/bot/')) throw new NoServiceAdminError();
  return admin;
}

/**
 * The refusal when a conversation opened from another one would not carry the origin's classification
 *: a drift split, a typed or ops conversation an event opened from a
 * conversation, is of the origin's classification or is not created.
 */
export class OriginClassificationMismatchError extends Error {
  constructor(readonly origin: string, readonly requested: string) {
    super(`a conversation opened from a ${origin || 'unclassified'} conversation cannot be created at ${requested}; `
      + 'it carries its origin\'s classification');
    this.name = 'OriginClassificationMismatchError';
  }
}

/**
 * THE ORIGIN'S CLASSIFICATION, read from its immutable tag, must be the one being created. Read as the
 * creating role (whose read is held only on a channel of its own classification, so a mismatched origin
 * is refused by IAM as well); a read that fails, or an origin with no `classification` tag, refuses too.
 */
async function requireOriginClassification(originChannelArn: string, classification: string): Promise<void> {
  let origin = '';
  try {
    origin = (await readChannelTags(messagingClient, originChannelArn)).classification || '';
  } catch (err) {
    console.error('[channel-creation] could not read the origin conversation\'s classification; refusing', {
      originChannelArn, name: (err as { name?: string })?.name,
    });
  }
  if (origin !== classification) throw new OriginClassificationMismatchError(origin, classification);
}

/**
 * THE CONTEXT EVERY NEW CONVERSATION'S ROW CARRIES, whatever its origin: who is in it, its type, when it
 * began, and its enforced membership source. One definition, so a re-open that finishes a half-created
 * room (`reseatContextOpener`) writes exactly what creation would have.
 */
function sharedContextFields(typeKey: string, humanSubs: string[]): ChannelContextPatch {
  return {
    participants: participantContextFor(humanSubs),
    // THE TYPE, so a later turn resolves this conversation's policy rather than its classification's.
    //
    // Without it every consumer resolves a type config by classification, so a conversation created of
    // type `ops` would get premium's retention and drift ON despite the type declaring it off - a
    // dimension that looks configured and is read by nobody. Written for BOTH origins: on the drift path
    // the key equals the classification, so the stamp states what was already true rather than changing
    // it, and the read path then has one answer to find instead of two ways of not finding one.
    //
    // THE ALLOWLIST IN `channel-context-client.ts` HAS TO NAME THIS FIELD. That store silently discards a
    // key it does not own, and swallows write failures, so a missing entry looks exactly like a working
    // write - and this stamp would be a no-op that passes review.
    conversationType: typeKey,
    // WHEN IT BEGAN, which decides the profile experiment it is enrolled in (ADR-050). Written once.
    createdAt: new Date().toISOString(),
    // THE ENFORCED MEMBERSHIP SOURCE, for the share Lambda and the reconcile (see the field note).
    ...(membershipSourceStamp(typeKey) ? { membershipSource: membershipSourceStamp(typeKey) } : {}),
  };
}

/**
 * THE SERVICE ADMIN DROPS ITS MODERATOR RECORD AND ITS MEMBERSHIP, together, each retried once on its own
 * after a failure. Best-effort: a step that fails twice is logged loudly and the creation stands. See step 4
 * in `createConversationCore` for why both records go and why their order does not matter.
 */
async function adminLeaves(channelArn: string, bearer: string): Promise<void> {
  const steps = [
    {
      send: async () => messagingClient.send(new DeleteChannelModeratorCommand({
        ChannelArn: channelArn, ChannelModeratorArn: bearer, ChimeBearer: bearer,
      })),
      failed: 'the service admin created this conversation and could not drop its moderator record, so the room '
        + 'names a moderator nobody chose',
    },
    {
      send: async () => messagingClient.send(new DeleteChannelMembershipCommand({
        ChannelArn: channelArn, MemberArn: bearer, ChimeBearer: bearer,
      })),
      failed: 'the service admin created this conversation and could not leave it, so the room carries a member '
        + 'nobody added',
    },
  ];
  const first = await Promise.allSettled(steps.map((s) => s.send()));
  for (const [i, outcome] of first.entries()) {
    if (outcome.status === 'fulfilled') continue;
    try {
      await steps[i].send();
    } catch (err) {
      console.error(`[channel-creation] ${steps[i].failed}`, {
        channelArn,
        message: (err as Error)?.message,
        firstAttempt: (outcome.reason as Error)?.message,
      });
    }
  }
}

async function createConversationCore(core: CoreInput): Promise<CreateConversationResult> {
  const { channelId, title } = core;
  // FIRST, BEFORE ANYTHING IS WRITTEN: the identity that creates. See the block comment above
  // `createConversationFromDrift`.
  const creatorBearer = requireServiceAdmin(core.creatorBearerArn);
  // AND A CONVERSATION OPENED FROM ANOTHER ONE CARRIES ITS CLASSIFICATION (step 39), checked before
  // anything is written.
  if (core.parentChannelArn) await requireOriginClassification(core.parentChannelArn, core.classification);
  const input = {
    appInstanceArn: core.appInstanceArn,
    botArn: core.botArn,
    userArn: core.userArn,
    modelId: core.modelId,
    modelName: core.modelName,
    modelTier: core.classification,
    channelFlowArn: core.channelFlowArn,
    parentChannelArn: core.parentChannelArn,
    originatingMessageId: core.originatingMessageId,
    additionalMemberArns: core.additionalMemberArns,
  };

  // Participant shape written BEFORE the channel exists (SPEC-USER-PROFILE-AND-ONBOARDING §2). The assistant
  // is added moments after creation, and its welcome reads this, so it is written first. Writing ahead is
  // possible because we supply the channel id, so the ARN is derivable.
  //
  // The shape is DERIVED from how many humans are in the conversation rather than asserted: one human
  // reads `single`, several read `group`, and the shape carries who is IN the conversation and never who
  // triggered it. A drift-spawned conversation has exactly one human - the person who accepted the
  // suggestion - so those coincide on that path and on no other.
  const derivedArn = derivedChannelArn(input.appInstanceArn, channelId);
  // CARRY THE MEMBERS' RECORDED ROLES FROM THE PARENT, for EVERY human, not only the creator.
  //
  // The parent's `memberIdentities` holds the host-supplied role of each member it recorded, under the
  // issuer subject the host named them by. Where to reach a member is not carried: the directory
  // resolves every person's contact and name through `Identities` at send time. A subject is matched to
  // a member here the way it is at sign-in, through `resolvePerson`, never by recomputing an id.
  //
  // EVERY HUMAN matters because `participantContextFor` derives the shape from the COUNT: one human reads
  // `single` and the onboarding gate keys on them, so a room of four recorded as one would be onboarded
  // as though it were a 1:1.
  const humanArns = [input.userArn, ...(input.additionalMemberArns || [])].filter(Boolean);
  const humanSubs = humanArns.map(subFromUserArn);
  const parentCtx = input.parentChannelArn ? await getChannelContext(input.parentChannelArn) : null;
  const carriedIdentities: NonNullable<NonNullable<typeof parentCtx>['memberIdentities']> = [];
  for (const p of parentCtx?.memberIdentities || []) {
    if (!p?.sub) continue;
    // The host names the issuer by its `iss` (or registry id); one the registry does not declare is nobody.
    const issuerId = p.iss ? issuerIdOf(p.iss) : null;
    const id = p.iss
      ? (issuerId ? personIdFromArn(await resolvePerson(issuerId, p.sub).catch(() => null)) : null)
      : p.sub;
    if (id && humanSubs.includes(id)) carriedIdentities.push(p);
  }

  // A create-or-get origin writes this once the channel is known to be new; see `createOrGet`.
  const timer = core.timer;
  const writeContext = () => timed(timer, 'contextWrite', () => putChannelContext(derivedArn, {
    ...sharedContextFields(core.typeKey, humanSubs),
    ...(carriedIdentities.length ? { memberIdentities: carriedIdentities } : {}),
    // Composed at WRITE time so the reader does not have to reassemble a link from two Metadata
    // fields — which is what forced `parentChannelArn` and `originatingMessageId` to stay readable
    // there in the first place.
    // THE CHANNEL ID, NOT THE ARN, because that is what `?conversation=` means to the client.
    //
    // The chat app identifies a conversation by `ChannelArn.split('/').pop()` and reflects exactly
    // that into the URL itself (`reflectConversationInUrl`), so `selectConversation` compares an id
    // against its loaded list and, failing that, describes a channel BUILT from an id. Handed a full
    // ARN it matched nothing, then asked for a channel whose ARN was assembled from an ARN, got
    // nothing back, and returned - so the link rendered, was clickable, and did nothing. Measured
    // live: the header stayed on the child conversation for 30 seconds after the click.
    ...(input.parentChannelArn
      ? {
        parentRef: `?${conversationRef(channelIdFromArn(input.parentChannelArn))}`
          + (input.originatingMessageId
            ? `#message=${encodeURIComponent(input.originatingMessageId)}`
            : ''),
      }
      : {}),
    // Origin-specific private grounding LAST, so an origin can override what the shared shape wrote.
    ...core.contextExtras,
  }));
  if (!core.createOrGet) await writeContext();

  // The retention this conversation gets, from THE TYPE rather than from the classification.
  //
  // That distinction is the whole of item 3 in ADR-053 Phase 1. Looking the type up by the classification
  // is what every consumer once did, and it is why a conversation "of type `ops`" carried the ordinary
  // retention rather than the 30 days its own type declares. No type is named after a classification any
  // more, so that lookup cannot be written by accident.
  // The caller's own TTL wins over the type's default: the type says how long a conversation of this
  // kind lives, and a person asking for less is asking for their own retention rather than contradicting
  // the type. Nothing may ask for MORE - that is bounded where the request arrives.
  const exp = core.expirationOverride ?? getConversationTypeConfig(core.typeKey).expiration;

  // 1. The SERVICE ADMIN creates the channel, so no assistant is a member before the flow is attached.
  //    See CREATOR_BEARER_ARN for the measurement behind this. Resolved at the top of this function,
  //    which refuses the creation when there is none.
  // THE ROOM'S PRIMARY, resolved BEFORE the room exists (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.8): the
  // assistant it is created for must be a live assistant of its classification, or no room is created.
  const primaryTag = await timed(timer, 'primaryTag', () => primaryTagFor(input.modelTier, input.botArn));
  // THE BEARER FOR THE ADDS BELOW is the admin that created the room: it has been a moderator since
  // `CreateChannel`, whereas the assistant is made one a moment before, and acting on that grant at once
  // depends on the service having applied it.
  const addBearer = creatorBearer;
  const createResp = await timed(timer, 'createChannel', () => messagingClient.send(
    new CreateChannelCommand({
      AppInstanceArn: input.appInstanceArn,
      ChannelId: channelId,
      Name: title,
      Mode: 'RESTRICTED',
      Privacy: 'PRIVATE',
      ChimeBearer: creatorBearer,
      ...(exp
        ? { ExpirationSettings: { ExpirationDays: exp.days, ExpirationCriterion: exp.criterion } }
        : {}),
      // SPEC-CONVERSATION-SECURITY Layer 1: the immutable `classification` tag
      // the IAM channel-join boundary keys on (aws:ResourceTag/classification).
      // MUST be set on every channel — the per-classification roles are fail-closed, so an
      // untagged channel is unreachable by any classification identity.
      Tags: [
        { Key: 'classification', Value: input.modelTier },
        // WHO THE CONVERSATION IS FOR, from the classification's declared audience and as immutable as it: a role
        // serving the deployment's own people in every conversation is denied a channel whose audience is
        // `outside` or absent (`neverAnOutsideConversation`), and the creator's grant requires it here.
        audienceTagFor(input.modelTier),
        // In the same call, so no room exists for an instant without its primary.
        primaryTag,
        // THE ROOM'S TYPE KEY, as a label an operator filters on in the console and cost allocation
        // reports by. A label only: the type that decides policy is the context store's (`conversationType`
        // in `channel-context-client.ts`), which no member can write, and nothing reads this tag to decide.
        // Not `private`: that is the channel's `Privacy`, which DescribeChannel already reports.
        { Key: CONVERSATION_TYPE_TAG, Value: core.typeKey },
        ...(core.tagExtras ?? []),
      ],
      Metadata: JSON.stringify({
        modelId: input.modelId,
        modelName: input.modelName,
        modelTier: input.modelTier,
        // `createdBy` is not set HERE: an origin that records it (the person path) does so in its
        // `metadataExtras`, as attribution only. The owner is derived from Amazon Chime SDK membership,
        // never from that member-writable copy (Tenet P5).
        //
        // NO `conversationType` HERE EITHER, and for a sharper reason than privacy. Metadata is
        // member-WRITABLE - a channel's creator is a moderator of their own channel and holds
        // `chime:UpdateChannel` - so a type stamped here would be a member able to pick their own
        // conversation's policy. It goes in the context store above, which no member can write.
        //
        // THE MEMBERSHIP SOURCE, AS A DISPLAY HINT ONLY: it lets the client show Share disabled with
        // the reason. Rewriting it changes nothing that matters - it can only re-enable a button whose
        // request the share Lambda still refuses from the server-side stamp in the context store.
        ...(membershipSourceStamp(core.typeKey) ? { membershipSource: membershipSourceStamp(core.typeKey) } : {}),
        // Origin-specific fields follow. Everything in here is member-readable and member-writable, so
        // an origin may only place things a member seeing or rewriting would not matter.
        ...core.metadataExtras,
      }),
    }),
  ));
  const channelArn = createResp.ChannelArn;
  if (!channelArn) {
    throw new Error('create-channel returned no ARN');
  }
  // The channel is new, so the row is this conversation's to write. Still before the flow and before any
  // assistant is added, so a welcome fired by that membership reads it.
  if (core.createOrGet) await writeContext();

  // 2. Associate the channel flow BEFORE any membership, and before anything can post.
  //
  // `CreateChannel` takes no channel-flow field, so immediately after is the earliest possible moment.
  // It has to be here rather than after the membership calls below: Lex fires `WelcomeIntent` the moment
  // the assistant becomes a member, and every message created before this association bypasses the flow
  // entirely, including the welcome. The service admin is the only member until this has run.
  //
  // BEST-EFFORT FOR A DRIFT CONVERSATION AND FATAL FOR AN EVENT-INITIATED ONE, which is a real
  // difference in what the two conversations are for rather than inconsistency.
  //
  // A drift conversation has the person who asked for it sitting in it. Without a flow it is a room they
  // can still type in, and they will say so. An event-initiated conversation of type `ops` exists so a
  // SECOND assistant can be addressed in it - `@ops` is the entire point - and with no flow nothing can
  // be addressed at all: the conversation is created, named, correctly populated, and inert, with nobody
  // waiting on it to notice.
  //
  // A MISSING FLOW ARN IS REFUSED BY THE ENTRY RATHER THAN HERE, because by this line the channel
  // exists: throwing would leave an abandoned conversation behind, which is worse than the inert one it
  // was trying to prevent. Only a FAILING association can be discovered this late, and that one is fatal
  // here - the channel is abandoned either way, and the alternative is shipping it broken.
  if (input.channelFlowArn) {
    try {
      await timed(timer, 'associateFlow', () => messagingClient.send(
        new AssociateChannelFlowCommand({
          ChannelArn: channelArn,
          ChannelFlowArn: input.channelFlowArn,
          ChimeBearer: creatorBearer,
        }),
      ));
    } catch (err) {
      // ERROR, NOT WARN, AND IT NAMES THE RESOURCES (2026-09-22).
      //
      // The conversation still works, so this stays non-fatal - but what it comes up WITHOUT is the
      // channel flow, which means no addressing, no marker stripping, no private-address enforcement
      // and no duplicate-placeholder claim, in a room that otherwise looks fine. That is not a warning.
      //
      // It was one for long enough to hide a policy bug: six creations, six denials, across days,
      // visible only because the e2e backend-error guard greps for `AccessDenied`. At error level the
      // guard fails the run on the first occurrence, which is the behavior this deserved all along.
      //
      // The ARNs are logged because the denial does not say which of the three resources it was, and
      // without them the next occurrence is as undiagnosable as this one was.
      console.error('[channel-creation] Failed to associate channel flow; the conversation has NO flow', {
        channelArn,
        channelFlowArn: input.channelFlowArn,
        // THE BEARER THAT ACTUALLY MADE THE CALL, which is the service admin wherever one is
        // configured. Logging `input.botArn` here pointed the reader at an identity that was not the
        // denied principal - the opposite of what the note above asks these ARNs to do.
        bearer: creatorBearer,
        err: (err as { name?: string })?.name ?? err,
      });
      if (core.origin === 'event') throw err;
    }
  }

  // THE ADMIN LEAVES WHATEVER HAPPENS BELOW. A creation that throws after `CreateChannel` (a member or
  // assistant that cannot be added) used to skip the leave, so the half-built room kept the service admin
  // as a member and moderator, where every human count reads it as a person.
  try {
    // 2b. THE PRIMARY ASSISTANT, ADDED AFTER THE FLOW AND MADE A MODERATOR.
    //
    // It used to get both from being the `CreateChannel` bearer. With the admin creating, it gets them
    // explicitly - and moderator matters: the rest of this function acts as the bot, and a bot that is not
    // a moderator of a RESTRICTED channel cannot add the members below.
    if (input.botArn) {
      await timed(timer, 'addAssistant', async () => {
        await messagingClient.send(
          new CreateChannelMembershipCommand({
            ChannelArn: channelArn,
            MemberArn: input.botArn,
            Type: 'DEFAULT',
            ChimeBearer: creatorBearer,
          }),
        );
        await messagingClient.send(
          new CreateChannelModeratorCommand({
            ChannelArn: channelArn,
            ChannelModeratorArn: input.botArn,
            ChimeBearer: creatorBearer,
          }),
        );
      });
    }

    // 3. Add the opener as member and, unless the origin enrolls rather than opens, moderator. A
    //    conversation nobody opened (a briefing) has no opener; its people are all added below.
    if (input.userArn) {
      await timed(timer, 'addOpener', async () => {
        await messagingClient.send(
          new CreateChannelMembershipCommand({
            ChannelArn: channelArn,
            MemberArn: input.userArn,
            Type: 'DEFAULT',
            ChimeBearer: addBearer,
          }),
        );
        if (core.openerModerator !== false) {
          await messagingClient.send(
            new CreateChannelModeratorCommand({
              ChannelArn: channelArn,
              ChannelModeratorArn: input.userArn,
              ChimeBearer: addBearer,
            }),
          );
        }
      });
    }

    // 3b. AND THE REST OF THE ROOM, when the subject was the room's to read.
    //
    // Added one at a time and INDIVIDUALLY tolerant of failure: a person who cannot be added is a
    // person missing from a conversation, which is worth a loud line, but failing the whole creation
    // over it would lose the conversation for everybody rather than for one. The creator is already a
    // member from the call above, so they are skipped rather than re-added.
    for (const memberArn of input.additionalMemberArns ?? []) {
      if (!memberArn || memberArn === input.userArn) continue;
      try {
        await messagingClient.send(
          new CreateChannelMembershipCommand({
            ChannelArn: channelArn,
            MemberArn: memberArn,
            Type: 'DEFAULT',
            ChimeBearer: addBearer,
          }),
        );
      } catch (err) {
        console.error('[channel-creation] could not carry a member into the new conversation', {
          channelArn, memberArn, message: (err as Error)?.message,
        });
      }
    }

    // 3b'. A PARTICIPANT ROLE'S MODERATORS (DESIGN-CONVERSATION-TYPES section 6.1), made while the service admin is still
    //      here; the holdings already name each moderation's origin. Individually tolerant, like the adds above.
    for (const arn of core.roleModerators ?? []) {
      if (!arn || arn === input.userArn) continue;
      await setParticipantRoleModerator({ channelArn, personArn: arn, bearerArn: addBearer, moderator: true }).catch((err) => {
        console.error('[channel-creation] could not make a participant role\'s holder a moderator', { channelArn, message: (err as Error)?.message });
      });
    }

    // 3c. THE ASSISTANTS THE TYPE NAMES, and a failure to add one FAILS THE CREATION.
    //
    //     A SEPARATE LOOP FROM THE HUMANS ABOVE, with the opposite failure semantics, and the asymmetry is
    //     the point. A person who cannot be added is a conversation that is missing somebody; an assistant
    //     that cannot be added is the conversation's REASON missing. An `ops` conversation without its ops
    //     assistant is a premium conversation with an alarming name: it looks right, it answers, and the
    //     thing it was opened for is absent. Riding the tolerant loop above would have delivered exactly
    //     that, logged, to nobody.
    //
    //     THE PRIMARY IS ALREADY A MEMBER BY THE TIME THIS LOOP RUNS, which is why it is skipped
    //     unconditionally: step 2b adds it explicitly after the flow association.
    //
    //     A `adminCreated ? false : ...` SKIP WAS NOT MERELY REDUNDANT, IT WAS FATAL. A conversation type
    //     names its assistants by HANDLE, and a type may name the classification's own primary:
    //     `CONVERSATION_TYPES.ops` lists `['advisor', 'ops-premium']`, and `advisor` resolves through the
    //     primary assignment record to exactly the `botArn` step 2b just added. The second
    //     `CreateChannelMembership` then returns `ConflictException`, and the `catch` below RETHROWS - so
    //     the creation failed after the channel existed, leaving an orphaned room with no assistant that
    //     answers. The retired handler lived with this by catching the conflict by name; not adding the
    //     member twice is the better answer, because a conflict swallowed by name also swallows the real one.
    for (const agent of core.agents) {
      if (!agent.botArn) continue;
      if (agent.botArn === input.botArn) continue;
      try {
        await messagingClient.send(
          new CreateChannelMembershipCommand({
            ChannelArn: channelArn,
            MemberArn: agent.botArn,
            Type: 'DEFAULT',
            ChimeBearer: addBearer,
          }),
        );
      } catch (err) {
        console.error('[channel-creation] could not add an assistant the conversation type names; '
          + 'failing the creation rather than delivering the conversation without it', {
          channelArn, handle: agent.handle, role: agent.role, message: (err as Error)?.message,
        });
        throw err;
      }
    }

    // 4. NO explicit primary-assistant enrollment, and NO opening message posted here.
    //
    //    The primary's membership, added in step 2b, is what fires its `WelcomeIntent`, after the flow is
    //    attached, so the welcome passes through the flow like any other message.
    //
    //    So this path gets the same welcome as any other conversation, composed from the deployment's
    //    orientation plus whatever context the origin stamped above: on the drift path `triggerContext` as
    //    the by-reference subject, `parentChannelArn` + `originatingMessageId` as the link back.
    //
    //    This REPLACES a hardcoded "started from a drift suggestion" message that used to be sent here. That
    //    message was not filling a gap - the welcome was already arriving - so a drift conversation opened with
    //    TWO bot messages, one of them bypassing the composer entirely (no company, no access line, no example
    //    prompts, none of the config-driven behavior or error recording).
  } finally {
    // 5. Point the PARENT conversation at the child, DURABLY - when the origin asks for it.
    //
    //    The drift path does. Its confirm reply comes back through Lex, and a Lex-delivered message cannot
    //    carry Chime message Metadata. It carries a `NAVIGATE_CHANNEL:` marker instead, which the client
    //    consumes once to switch conversations and `stripMessageMarkers` then removes for display - so scrolling
    //    back later shows the announcement with no way to reach the conversation it announced.
    //
    //    That follow-up message carries the link as METADATA, which survives marker stripping and stays
    //    followable. It deliberately does NOT repeat the marker: the Lex reply owns the one-shot navigation, so
    //    duplicating it here would switch the user's conversation twice.
    //
    //    AN EVENT-INITIATED CONVERSATION ASKS FOR NONE, because its caller posts the notification that
    //    announces it. Two messages would mean one of them describing something that did not happen.
    //
    //    Best-effort. The child exists and is usable; a failure here costs the back-reference from the parent,
    //    which is worth logging loudly and not worth failing the creation over.
    // 4. THE ADMIN LEAVES, once the room is assembled.
    //
    //    It was here to create the channel and attach the flow before any assistant could speak. A
    //    conversation must not carry a member nobody put there: it shows in the roster and it counts
    //    toward the AUTO trigger's member test, which decides whether an assistant answers an untargeted
    //    message. Removing a membership sends no welcome, so this cannot disturb what was just said.
    //
    //    BEST-EFFORT AND LOGGED LOUDLY. The conversation works either way, so failing the creation here
    //    would discard a working room over a tidying step - but an extra admin member is a real defect in
    //    the roster, so it must not pass silently.
    //
    //    AND ITS MODERATOR RECORD GOES WITH IT. Amazon Chime SDK makes the CreateChannel bearer a moderator,
    //    and deleting a membership leaves that record behind (measured: ListChannelModerators kept listing
    //    the admin after it left; lib/membership-reconcile.ts records the same behavior). Left, the room
    //    names a moderator nobody chose, which every moderator list shows.
    //
    //    THE TWO CALLS RUN AT ONCE, because neither depends on the other. The bearer is the app-instance
    //    admin, whose authority over the channel comes from the instance rather than from its membership
    //    or its moderator record, and the two records are independent: deleting the membership leaves the
    //    moderator record (above), and the reconcile drops a moderator after its membership is already gone
    //    (`lib/membership-reconcile.ts`). A call that fails while the other is in flight is tried once more
    //    on its own, so a conflict between the two can cost a round trip but never leaves the admin behind.
    await timed(timer, 'adminLeaves', () => adminLeaves(channelArn, creatorBearer));
  }

  const created: CreateConversationResult = { channelArn, channelId };
  const parentMessage = core.parentMessage?.(created);
  if (parentMessage && input.parentChannelArn) {
    try {
      await sendInParts(conversationClient, {
          ChannelArn: input.parentChannelArn,
          text: parentMessage.content,
          Metadata: JSON.stringify(parentMessage.metadata),
          Type: ChannelMessageType.STANDARD,
          Persistence: ChannelMessagePersistenceType.PERSISTENT,
          ChimeBearer: input.botArn,
        });
    } catch (err) {
      console.error('[channel-creation] parent-side link message failed; the redirect is not followable:', err);
    }
  }

  return created;
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

/**
 * A NAME A CALLER OR A MODEL SUPPLIED, KEPT IN ITS OWN SCRIPT (`conversationNameText`): an Amazon Chime SDK channel name
 * takes any printable text, so a topic in Japanese or Arabic is a name rather than an empty string. With nothing readable
 * left it is the placeholder, which the first message then replaces as it does in a person's own conversation.
 */
export function sanitizeTitle(label: string): string {
  return conversationNameText(label) || PLACEHOLDER_TITLE;
}
