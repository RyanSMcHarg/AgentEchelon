/**
 * Conversation-type configuration — the per-conversation policy bundle.
 *
 * A *conversation type* is a named, configurable profile that decides how a
 * conversation behaves: which agents are enrolled by default, which
 * communication channels are available, whether live drift detection runs, and
 * what security classification it maps to. Today's classifications (`basic` /
 * `standard` / `premium`) are simply the conversation types that ship; further
 * types (`guest`, `authenticated`, `engagement`, `support`, …) are additional
 * types a deployer can add HERE without touching handler code.
 *
 * **Conversation type ≠ Chime channel privacy.** Chime's `PRIVATE`/`PUBLIC`
 * mode (and the `conversationType: 'private'` channel tag) is an
 * orthogonal platform concept; this registry is OUR policy layer.
 *
 * **Conversation type ≠ classification (deliberately).** The IAM Layer-1
 * channel-join boundary (`agent-classification-common.classificationChannelScopedAllow` +
 * the router answering at the channel's classification) is fail-closed and depends on a CLOSED set of
 * classifications, each declaring the grants it reaches (ADR-046: a set, not a ladder - there is no
 * rank, and an undeclared grant set reaches nothing rather than falling back to a floor). Conversation
 * types are meant to proliferate and are not a closed set at all (what would `guest` versus
 * `engagement` even be compared on?). So each type *carries* a `classification` - the closed,
 * IAM-evaluated axis - rather than being one. This keeps the deny-tested security boundary intact
 * while the type catalogue grows. See SPEC-CONVERSATION-SECURITY.
 */

import type { Classification } from './model-strategy';
import type { ConnectorRef } from './connectors';
import { OPS_EVENT_SOURCE, OPS_INCIDENT_OPENED, PLATFORM_EVENT_FIELDS, type EventOpener } from './event-openers';

/** A conversation-type key. Open-ended (string) by design — deployers add types
 *  to {@link CONVERSATION_TYPES} without a type-system change. A type key is never
 *  a classification value: the two are different axes, and sharing a word made one
 *  read as the other (`conversation-type-keys-are-not-classifications.test.ts`). */
export type ConversationTypeKey = string;

/** What starts a conversation of this type. Default `'user'` (someone opens a
 *  chat). `'schedule'` = EventBridge (proactive briefing); `'system'`/`'alert'`
 *  = a service/alert webhook with NO human creator JWT (e.g. incident triage) —
 *  the trigger boundary must be authenticated and the assistant acts as bot bearer. */
export type Initiation = 'user' | 'system' | 'schedule' | 'alert';

/**
 * Which message flow a conversation associates, as a KEY the deployment resolves to a channel-flow ARN.
 *
 * Open string for growth, the same way {@link ConversationTypeKey} is: a deployment that publishes a
 * second flow names it here without a type-system change. `'default'` is the flow every deployment
 * publishes and every shipped conversation type names.
 *
 * NOT SETTABLE FROM AN ASSISTANT PROFILE, and that is a boundary rather than an omission. A profile is
 * behavior - what an assistant says and which tools it may pick - and it carries selections rather than
 * references precisely so scope cannot travel through it. Message routing is conversation
 * infrastructure: it decides whether anybody can be addressed at all, it is associated at creation by the
 * principal that created the conversation, and an assistant editing it would be an assistant editing the
 * room it sits in. `versioned-profile-omits-deploy-time-fields.test.ts` is where that is enforced.
 */
export type MessageFlowKey = 'default' | (string & {});

/**
 * ── TWO RETENTION AXES, AND THEY ARE NOT THE SAME NUMBER ─────────────────────────────────────────
 *
 * Amazon Chime SDK has two independent mechanisms, and one constant used to serve both - which is how
 * a deployed 90 day message limit got described as bounding a 15 year conversation lifetime. It does
 * not. Nothing about pruning messages stops a channel existing.
 *
 *   MESSAGE_RETENTION_DAYS      `ChannelRetentionSettings.RetentionDays`, set app-instance-wide by the
 *                               retention custom resource. Deletes MESSAGES older than this in every
 *                               channel. The channel survives, emptied of old content.
 *
 *   MAX_CONVERSATION_TTL_DAYS   the limit on a type's `ExpirationSettings.ExpirationDays`, applied
 *                               per channel at creation. Deletes the WHOLE CONVERSATION - membership,
 *                               name and all - once the criterion is met.
 *
 * THE LIVE WINDOW IS SHORTER THAN THE CONVERSATION, AND SHORTER THAN THE ARCHIVE. Three periods, each
 * sized for its own job, and they are deliberately not equal:
 *
 *   ninety days    how much conversation is LIVE in Amazon Chime SDK - what the client renders and what
 *                  the assistant reads for context. A working window, not a record.
 *   nine months    how long the CONVERSATION itself exists, counted from its last message.
 *   indefinite     the S3/Athena archive, which outlives both and is the durable record.
 *
 * ARCHIVE LENGTH ABOVE LIVE LENGTH IS THE POINT, not a gap to close. The archive is
 * the system of record for history, telemetry, compliance and analytics - it is NOT a read path for the
 * chat client, and nothing is missing because the client does not consult it. A reader who takes
 * "system of record" (tenet D7) to mean "what a person sees" will conclude a backfill is absent and be
 * wrong about the design rather than right about a defect. That mistake was made here once.
 *
 * All three periods are configurable per deployment: the live window by `MESSAGE_RETENTION_DAYS`, the
 * conversation by a type's `expiration` under `MAX_CONVERSATION_TTL_DAYS`, and the archive by its own
 * S3 lifecycle. A deployment wanting a longer live window raises the first, which is non-destructive.
 *
 * ONE RESIDUAL WORTH KNOWING, and it is a copy problem rather than a retention one: past the live
 * window the client's empty-transcript branch renders the NEW-conversation greeting, so an old
 * conversation reads as one that has never been used. That is worth fixing on its own terms and changes
 * none of the periods above.
 *
 * The ORDERING is asserted rather than assumed - see `no-type-exceeds-the-retention-limit`. The
 * reverse (messages outliving the conversation) would be incoherent: content with no room.
 */

/** Messages older than this are deleted from EVERY channel. Set once, app-instance-wide. */
export const MESSAGE_RETENTION_DAYS = 90;

/**
 * The limit on how long a CONVERSATION may live, in days. Nine months, counted from its last
 * message, which is the criterion every shipped type uses: an idle conversation ages out, an active
 * one does not.
 *
 * A TYPE'S OWN VALUE IS A MAXIMUM, NOT A DEFAULT. A conversation may elect to keep less than its type
 * allows and never more, so the two bounds compose: the type caps a conversation, and this caps the
 * type.
 *
 * LOWERING IT IS A ONE-WAY DOOR for conversations already created - their `ExpirationSettings` were
 * stamped at creation, so a reduction binds new conversations and leaves existing ones on the old
 * value until something updates them. Raising it is safe and binds new conversations only.
 */
export const MAX_CONVERSATION_TTL_DAYS = 270;

/**
 * @deprecated Use {@link MESSAGE_RETENTION_DAYS} for message pruning or
 * {@link MAX_CONVERSATION_TTL_DAYS} for how long a conversation lives. The single name served both and
 * made them look like one decision; it is kept only so an out-of-tree reader is pointed at the split
 * rather than at a missing export.
 */
export const MAX_CONVERSATION_RETENTION_DAYS = MESSAGE_RETENTION_DAYS;

/** The flow every deployment publishes, and the one every shipped conversation type names. */
export const DEFAULT_MESSAGE_FLOW: MessageFlowKey = 'default';

/**
 * Which flow a conversation gets, resolved through the levels that may declare one.
 *
 * THE PRECEDENCE, most specific first:
 *   1. the CONVERSATION - a single conversation overriding its type. **NOT DECLARABLE YET**; there is no
 *      field for it, because nothing stamps a per-conversation policy snapshot (FR13).
 *   2. the CONVERSATION TYPE - `messageFlow` below.
 *   3. the CLASSIFICATION - **NOT DECLARABLE YET.** A classification has no flow field today.
 *   4. the PROJECT default - {@link DEFAULT_MESSAGE_FLOW}, which is where every deployment sits now.
 *
 * Today every level that exists resolves to the same value, so this returns `'default'` for every
 * conversation on every deployment. That is the expected state rather than a placeholder: the function
 * exists so the two missing levels have one named place to go, instead of each caller growing its
 * own idea of precedence the first time a deployment needs two flows.
 */
export function resolveMessageFlowKey(typeKey: string): MessageFlowKey {
  return getConversationTypeConfig(typeKey).messageFlow || DEFAULT_MESSAGE_FLOW;
}

/** A communication transport available to a conversation. `'chat'` (Chime
 *  messaging) is the default + the hub. Non-chat transports are PROVIDED by a
 *  connector (Twilio voice/SMS, Chime SDK Meetings); their artifacts are
 *  summarized back INTO the conversation. Open string for growth. */
export type CommsChannel = 'chat' | 'voice' | 'sms' | 'video' | 'email' | 'briefing' | (string & {});

/** Feature toggles beyond drift. Open bag — drift stays its own top-level field
 *  (`driftEnabled`) because it shipped first and is consumed today; future
 *  capabilities (tasks/battle/…) land here without disturbing it. */
export interface Capabilities {
  tasks?: boolean;
  battle?: boolean;
  [capability: string]: boolean | undefined;
}

/**
 * WHERE A CONVERSATION'S PEOPLE COME FROM, AND WHAT KEEPS IT THAT WAY (DESIGN-CONVERSATION-TYPES §6).
 *
 * A type that declares a source has an ALLOWED SET - the members of an identity-provider `group`, the
 * subjects in a `list`, or the union of both - and declaring one means enforcing it: the creator adds
 * the set, and the membership reconcile keeps the conversation's HUMANS equal to it, adding a person who
 * joins the group and removing one who leaves. Assistants are never touched; they come from
 * `defaultAgents`. A person the conversation's classification does not admit is never added, and that
 * is a settled state rather than a discrepancy to retry.
 *
 * A TYPE THAT DECLARES NO SOURCE IS MANUAL: the opener is a member, everybody else is added by a person,
 * and nothing reconciles it. On a type that DOES declare one, sharing is refused, because an invited
 * person would be silently removed by the next reconcile (owner decision, 2026-10-05).
 */
export interface MembershipSource {
  /** An identity-provider group whose members are the conversation's people. */
  group?: string;
  /** Explicit subjects (identity-provider usernames / subs) admitted alongside, or instead of, a group. */
  list?: string[];
}

/** Who participates and how non-creator humans are brought in. `seed` = members
 *  admitted at creation; `mayAdmit` = roles that can be pulled in on demand;
 *  `resolveVia` = connectors that turn "bring in a <role>" into a concrete
 *  identity (Salesforce/ServiceNow routing, on-call rotation). All resolved
 *  participants are admitted at the channel's classification — connectors feed
 *  admission, never bypass it. */
export interface ParticipantPolicy {
  seed?: string[];
  mayAdmit?: string[];
  resolveVia?: ConnectorRef[];
  /**
   * The participant role a member holds when no source names them for any role (DESIGN-CONVERSATION-TYPES section
   * 6.1). Applied when the holdings are read, over the conversation's live members, so it is never stored.
   */
  defaultRole?: string;
  /** The participant roles people hold in a conversation of this type, by name. See {@link ParticipantRoleDeclaration}. */
  participantRoles?: Record<string, ParticipantRoleDeclaration>;
}

/**
 * WHERE A PARTICIPANT ROLE'S HOLDERS COME FROM (DESIGN-CONVERSATION-TYPES section 6.1). Tried in order; the first source
 * that names anyone decides. `lib/config/participant-roles.ts` holds the rules synthesis applies to each.
 */
export type ParticipantRoleSource =
  /** A person field the opening event names, which the creator resolves to an AppInstanceUser: `forPerson`. */
  | { event: 'forPerson' }
  /** A declared membership group's admitted members. */
  | { group: string }
  /** A lookup of who holds a role through a connector the type lists in `participants.resolveVia`. */
  | { resolveVia: string; op: 'lookupRole'; args?: Record<string, string> }
  /** The participant role an invitation records. */
  | { invitation: true }
  /** The person whose confirmed request created the conversation. */
  | { creator: true }
  /** Member trust: the role a creating application asserts. Read as `host:role` and never deciding. */
  | { host: true };

/** One participant role a type declares. A function a person holds in one conversation, never an assistant role or an IAM role. */
export interface ParticipantRoleDeclaration {
  /** Tried in order; the first source that names anyone decides. Empty only for the type's `defaultRole`. */
  from: ParticipantRoleSource[];
  /** Default `many`. */
  holders?: 'one' | 'many';
  /** A holder who is not yet a member is added, through admission. */
  adds?: boolean;
  /** An invitation may record it. Default false. */
  invitable?: boolean;
  /** Its holding may be said in a room a guest or a link session reads. Default false. */
  visibleToGuests?: boolean;
  confers?: {
    /** A moderator of this one channel, recorded with origin `participantRole:<name>`. Default false. */
    moderator?: boolean;
    /** The message template a workflow's `fromRole: template` greets the holder with. */
    template?: string;
    /** The prompt template an agent step's `fromRole: brief` drafts the holder's brief from. */
    brief?: string;
    /** Addressable as `{ participantRole: '<name>' }` and readable as `participantRole:<name>`. Default true. */
    audience?: boolean;
  };
}

/** Chime channel-expiration criterion: age since creation, or since the last message. */
export type ExpirationCriterion = 'CREATED_TIMESTAMP' | 'LAST_MESSAGE_TIMESTAMP';

/** A default channel TTL that maps directly to Chime's `ExpirationSettings`.
 *  `days` is 1–5475 (Chime's accepted range). */
export interface ChannelExpiration {
  days: number;
  criterion: ExpirationCriterion;
}

export interface ConversationTypeConfig {
  /**
   * The classifications a conversation of this type MAY carry - a CHECK, never a value the creator reads.
   * The classification is an INPUT at creation (a person's own clearance, or the conversation an event
   * concerned) and is the only axis IAM evaluates, via the channel's `classification` tag. ABSENT means
   * any conversational classification the deployment declares, which is what an ordinary conversation is.
   * Closed means the set of values is fixed by the deployment's declaration, not that they are ranked.
   */
  classifications?: Classification[];
  /** Where this type's people come from, enforced. Absent ⇒ manual. See {@link MembershipSource}. */
  membershipSource?: MembershipSource;
  /**
   * Whether the USER-FACING live drift flow (lib/live-drift-flow.ts) runs for
   * conversations of this type. Drift is conversation-level, so its on/off is a
   * property of the conversation type — NOT of the user's clearance. (Requires
   * Aurora mode regardless; this gate is layered on top of the Aurora hookup.)
   */
  driftEnabled: boolean;
  /**
   * WHICH message flow a conversation of this type associates - the Amazon Chime SDK channel flow that
   * makes the conversation addressable: `@assistant` and `@all` routing, marker stripping, and the
   * placeholder correlation map.
   *
   * A KEY, NOT AN ARN. The ARN is minted per deployment and already published to SSM; a config file that
   * held one would be a second place for it to be wrong. The key selects among the flows a deployment
   * publishes, and {@link DEFAULT_MESSAGE_FLOW} is the one every shipped type names today.
   *
   * WHY THE TYPE OWNS IT AND NOT THE CREATION PATH. Whether a conversation can be addressed at all is the
   * most basic functional fact about it, and today no creator reads this field: each of the five
   * CONVERSATION creators resolves the flow ARN from one unkeyed SSM parameter and associates it, so the
   * answer is uniform by coincidence rather than by declaration. The sixth `CreateChannel` site is the
   * admin notification channel, which associates none and is not a conversation of a type.
   *
   * That uniformity is a property of six code paths wearing the costume of a property of a conversation.
   * Six creators each deciding the same thing separately is six chances to decide it differently, and the
   * ordering requirement - associate before the first member - is already documented identically in four of
   * them. It belongs to the type because the type is the composition root, and it is another reason one
   * creator has to own creation.
   *
   * IT IS A SELECTOR RATHER THAN A SWITCH, deliberately. There is no value meaning "no flow": a
   * conversation nobody can address is broken rather than configured, so the type says WHICH flow and
   * never WHETHER. Every type naming the same flow today is the expected state, not a redundancy - the
   * dimension exists so a type can carry different routing later without a creator learning about it.
   */
  messageFlow?: MessageFlowKey;

  // ── Forward-compat dimension seams (OPTIONAL, not yet consumed) ───────────
  // Each has a safe default when absent (see docs/SPEC-CONVERSATION-TYPES.md §5).
  // Present so adding a use case (engagement / support / service / triage)
  // never requires a schema change or a handler `switch` — only config.

  /** What initiates this conversation. Default `'user'`. */
  initiation?: Initiation;
  /**
   * THE EVENTS THAT OPEN A CONVERSATION OF THIS TYPE (ADR-053 Phase 1), each one EventBridge rule targeting
   * the typed-conversation creator of the classification it resolves to. Absent: no event opens it. Only a
   * type an event or the platform opens may declare one, and no entry can name a classification for the
   * event to carry. See {@link EventOpener} (`lib/config/event-openers.ts`).
   */
  openedBy?: EventOpener[];
  /**
   * THE NAME A CONVERSATION OF THIS TYPE IS CREATED WITH, as a template in the `{{field}}` form over what opened it
   * ({@link CONVERSATION_NAME_FIELDS}): `{{label}}`, `{{summary}}`, `{{alarm}}`, `{{service}}` and `{{date}}`. It is the
   * builder's own text, in the builder's language, and it comes before the platform's default for the kind of room
   * (the `conversation-name` message template, `lambda/src/lib/conversation-name.ts`). A template that names a field
   * the opening does not carry is passed over, so the next name in that order answers. Absent: the platform's default.
   * A person's own conversation (`general`) declares none: it opens with the placeholder and is named from its first
   * message.
   */
  name?: string;
  /** Default agent handle(s) to enroll. Absent ⇒ the per-classification AppInstanceBot. */
  defaultAgents?: string[];
  /** Transports available to this type. Absent ⇒ `['chat']`. */
  commsChannels?: CommsChannel[];
  /** Feature toggles beyond drift. */
  capabilities?: Capabilities;
  /** Who participates + how non-creator humans are resolved/admitted. */
  participants?: ParticipantPolicy;
  /** External vendor systems this type may use (broad per-vendor connectors). */
  connectors?: ConnectorRef[];
  /** How a departed member appears in history: hard-`delete` (ARN stops resolving →
   *  render a placeholder) vs `deactivate` (keep the AppInstanceUser, flag it). Decided
   *  per type (SPEC-CREDENTIAL-EXCHANGE §6a / SPEC-ACCESS-AND-CONTROLS-AUDITING). Absent ⇒
   *  the deployer default (hard-delete). */
  offboardMode?: 'delete' | 'deactivate';
  /**
   * Default channel TTL for this type — maps directly to Chime `ExpirationSettings`.
   * Retention toggle 2 (docs/SPEC-ACCESS-AND-CONTROLS-AUDITING.md §4c): create-conversation
   * applies this when the request doesn't override it (toggle 3); absent ⇒ the conversation
   * never expires. This is whole-channel deletion (how long the conversation stays stored in
   * the SDK), NOT message trimming.
   */
  expiration?: ChannelExpiration;
  /**
   * Schema version stamped on a channel's policy snapshot at creation. Bump only
   * for ADDITIVE changes; lets an old channel read by new code default missing
   * fields and a new channel read by old code ignore unknown ones (no
   * retroactive behavior change ⇒ no backwards-compat break).
   */
  metadataSchemaVersion?: number;
  /**
   * HOW A VISITOR IN A CONVERSATION OF THIS TYPE BECOMES A PERSON (T2, PLAN §16.6). Absent: they do not.
   *
   *   `bind` (path A, P-11): the visitor signs in while their guest session is live, and one call
   *     presenting both makes the guest AppInstanceUser the account (`lambda/src/lib/guest-bind.ts`).
   *     Refused when the signing-in subject already has an `Identities` row: that is path B.
   *   `claim` (path B, P-12): the visitor registers, and a signed-in account redeems the registration's
   *     single-use claim token, which opens a new conversation of `into` for the account, tagged with this
   *     conversation's ARN (`lambda/src/guest-upgrade.ts`).
   *
   * Both are declared on the shipped `guest-visitor` type: which one applies is whether the account
   * already exists, which only the sign-in can say.
   */
  upgrade?: { paths: ReadonlyArray<'bind' | 'claim'>; into?: ConversationTypeKey };
  /**
   * The types a conversation of this type may be seeded from (V5): a `customer-engagement` conversation
   * opened by a path B claim carries what the visitor registered in the `guest-visitor` one. Absent: none.
   */
  seedFrom?: ConversationTypeKey[];
  /**
   * WHETHER A MEMBER MAY INVITE SOMEBODY NEW INTO A CONVERSATION OF THIS TYPE, AND HOW THE INVITATION IS
   * REDEEMED (M-10, T2). Absent: nobody is invited into it. See {@link InvitationPolicy}.
   */
  invitations?: InvitationPolicy;
  /**
   * THE ISSUERS A CONVERSATION OF THIS TYPE ADMITS (T1, FR23): registry ids (`lib/config/issuers.ts`). Absent:
   * every issuer whose people the classification admits.
   *
   * A NARROWING, NEVER A GRANT. Access is the classification, which IAM evaluates against the classifications
   * a person's issuer maps them to; this is the application-layer second check (tenet D3) for what a
   * classification cannot express: two issuers mapped to one classification where this experience admits
   * only one of them. The creator and every add-member path apply it AFTER the clearance check, so it can
   * only refuse somebody the classification already admits; a refused issuer is a settled state, never added
   * (`typeAdmitsIssuers`). A person signed in through several issuers is admitted when any of them is listed.
   */
  admitsIssuers?: string[];
}

/** How an invitation is redeemed (M-10). */
export type RedemptionMode = 'sign-in' | 'link';

/**
 * A TYPE'S INVITATIONS (M-10, T2). An invitation names its invitee by an AppInstanceUser minted for it at
 * invite time, which is added as a member and reaches nothing until the invitation is redeemed
 * (`lambda/src/invitations.ts`). Each invitation is redeemed in one mode, the type's `default` unless the
 * inviter names another the type declares:
 *
 *   `sign-in`: a signed-in session with no account yet redeems it, and that sign-in becomes the invitee's
 *     (the exchange binds it, `lambda/src/lib/invitation-redemption.ts`). An account that already exists is
 *     refused (`wrong_account`): it is added by sharing, never by binding.
 *   `link`: the landing page's Join redeems it with no sign-in, and the exchange vends a one-conversation
 *     session pinned to the invitee for at most 15 minutes, through the `invitation-link` issuer. Only at a
 *     classification in `linkClassifications` and in that issuer's declared set; a deployment that declares no
 *     `invitation-link` issuer redeems no link.
 *
 * A type whose people come from a membership source declares none: the reconcile would remove an invitee.
 */
export interface InvitationPolicy {
  /** The modes an invitation of this type may be redeemed in. */
  modes: ReadonlyArray<RedemptionMode>;
  /** The mode an invitation is redeemed in when the inviter names none. One of `modes`. */
  default: RedemptionMode;
  /** The classifications a `link` invitation of this type may be redeemed at. Required with `link`. */
  linkClassifications?: Classification[];
  /** How long an invitation is redeemable, in days. Default 7. */
  expiresInDays?: number;
}

/**
 * The fields a type's `name` may insert, each what the opening carries: the event's label, its one-line summary, the
 * CloudWatch alarm the room watches and the service that alarm is about, and the date the room opened (ISO, so it reads
 * the same in every language).
 */
export const CONVERSATION_NAME_FIELDS = ['label', 'summary', 'alarm', 'service', 'date'] as const;
export type ConversationNameField = (typeof CONVERSATION_NAME_FIELDS)[number];

/** What is wrong with each declared `name`: a field it inserts that no opening carries. Empty when every one is valid. */
export function conversationNameErrors(types: Readonly<Record<string, Pick<ConversationTypeConfig, 'name'>>>): string[] {
  const errors: string[] = [];
  for (const [typeKey, type] of Object.entries(types)) {
    if (type.name === undefined) continue;
    if (!type.name.trim()) {
      errors.push(`conversation type "${typeKey}" declares an empty name`);
      continue;
    }
    for (const [, field] of type.name.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
      if (!(CONVERSATION_NAME_FIELDS as readonly string[]).includes(field)) {
        errors.push(`conversation type "${typeKey}" names "{{${field}}}", which no opening carries (${CONVERSATION_NAME_FIELDS.join(', ')})`);
      }
    }
  }
  return errors;
}

/** How long an invitation is redeemable when its type says nothing. */
export const DEFAULT_INVITATION_DAYS = 7;
/** The most a type may declare: an invitation is a credential, and a credential is short-lived. */
export const MAX_INVITATION_DAYS = 30;

/**
 * The shipped conversation types. A type key is never a classification value, so a conversation's
 * classification and its type are always two separate facts and every call site reads unambiguously. To turn drift off for a
 * type, add default agents, or change retention, edit THIS map - no handler change. Keys are matched
 * against the conversation's stamped type (see {@link resolveConversationTypeKey}).
 */
export const CONVERSATION_TYPES: Record<ConversationTypeKey, ConversationTypeConfig> = {
  // ── AN ORDINARY CONVERSATION, AT WHATEVER CLASSIFICATION IT WAS OPENED AT ─────────────────────────
  //
  // Every conversation a person opens, and every one a drift split spawns from it. No `classifications`
  // list: the classification is the creator's INPUT (the opener's own clearance, or the conversation it
  // split from), and the creator separately refuses an admin-plane one. Membership is MANUAL - it declares
  // no source - so the opener is a member and everybody else is added by a person. This one entry replaces the three that used to
  // be named after the classifications, which made `premium` mean a classification and a type at once.
  //
  // Retention: the platform maximum, counted from the last message, so an idle or archived conversation
  // ages out and an active one does not - the "eventual hard delete" ADR-017 composes with.
  //
  // Invitations: a member may invite somebody new. Redeemed by signing in unless the inviter asks for a
  // link, which a deployment's `invitation-link` issuer admits at `basic` and `standard` alone: a link
  // session is a person nobody signed in, so it never reaches the more sensitive classifications.
  //
  // Seeded from a visitor's conversation: a path A bind continues the visit in an ordinary conversation at
  // the account's own classification (`bindTargetOf`).
  general: {
    driftEnabled: true,
    messageFlow: DEFAULT_MESSAGE_FLOW,
    expiration: { days: MAX_CONVERSATION_TTL_DAYS, criterion: 'LAST_MESSAGE_TIMESTAMP' },
    invitations: { modes: ['sign-in', 'link'], default: 'sign-in', linkClassifications: ['basic', 'standard'], expiresInDays: DEFAULT_INVITATION_DAYS },
    seedFrom: ['guest-visitor'],
  },

  // ── A CONVERSATION OPENED BECAUSE SOMETHING HAPPENED ─────────────────────────────────────────────
  //
  // `ops` is a conversation opened because something happened - an alert, an event - rather than
  // because a person opened it, and it adds a SECOND assistant alongside the classification's primary.
  // That is the whole reason the type dimension exists (ADR-053).
  //
  // WHAT EACH FIELD IS DOING HERE, because most of them are the type earning its keep:
  //
  //   `classifications: ['premium']` is the ONE classification a conversation of this type may carry. It
  //     is a CHECK rather than a value to be read: the creator is given the classification by its caller
  //     and refuses one this type does not allow (`classificationAllowedForType`). Its second assistant
  //     exists only at premium, so no other value could add it.
  //   `membershipSource: { group: 'ops' }` makes the room the operations group's: its members are added
  //     at creation and kept in sync afterwards, so someone who joins the rotation is added to the open
  //     ops rooms and someone who leaves it is removed. Not the people of the conversation the event
  //     concerned - an incident is the operations team's, whoever happened to be in the room it affected.
  //   `driftEnabled: false` because an ops conversation is already about one subject: the event that
  //     opened it. Offering to split it is offering to split the thing it was opened for. This is also
  //     the dimension that proves the type is not inert - drift is ON for `general`, so a conversation
  //     that lost its stamp would drift.
  //   `defaultAgents` names BOTH assistants rather than only the second one, so the type states its
  //     whole roster instead of "the primary, plus". The primary is a member by creation (it is the
  //     `CreateChannel` bearer), so adding it is a no-op - and a type whose roster reads as one name
  //     would be a type that silently depends on which principal happened to create the conversation.
  //   `expiration` is 30 days rather than the platform's 90. An alert conversation is disposable and
  //     data minimization is the direction; the deployment's own limit
  //     ({@link MAX_CONVERSATION_TTL_DAYS}) still bounds it above.
  //
  // ITS ASSISTANT ONLY EXISTS ON A DEPLOYMENT THAT DECLARES IT. `ops-premium` is built where the
  // deployment names it in `profiles`; without that there is no Amazon Lex bot and no assignment record, so
  // the resolver finds nothing and creation is REFUSED rather than producing a conversation with one
  // assistant in it. That refusal is the intended behavior and it is why declaring the role is a
  // precondition of using this type rather than a detail of deploying it.
  ops: {
    classifications: ['premium'],
    membershipSource: { group: 'ops' },
    driftEnabled: false,
    messageFlow: DEFAULT_MESSAGE_FLOW,
    defaultAgents: ['advisor', 'ops-premium'],
    initiation: 'alert',
    // OPENED BY THE PLATFORM'S OWN OPS EVENT, on the default bus, for this deployment's instance only
    // (`scripts/send-ops-event.mjs` puts one). Its fields are where the event carries the person, the label,
    // the summary and the concerned conversation. A CloudWatch alarm or a vendor's partner bus is declared
    // the same way, as another entry with its own paths and fixed values (`lib/config/event-openers.ts`).
    openedBy: [{ source: OPS_EVENT_SOURCE, detailType: OPS_INCIDENT_OPENED, matchInstance: true, fields: { ...PLATFORM_EVENT_FIELDS } }],
    expiration: { days: 30, criterion: 'LAST_MESSAGE_TIMESTAMP' },
    // THE ROOM'S SHAPE (DESIGN-CONVERSATION-TYPES section 6.1): the person the opening event names leads it, and every
    // other member responds. The lead is a moderator; as the person the room was opened for they already are one by
    // creation, so the conferral records nothing of its own here. `responder` names nobody by a source: it is the
    // default, held by each member no source names, read over the live roster.
    participants: {
      participantRoles: {
        lead: { from: [{ event: 'forPerson' }], holders: 'one', confers: { moderator: true } },
        responder: { from: [] },
      },
      defaultRole: 'responder',
    },
  },

  // ── THE OPERATIONS TEAM'S STANDING CONVERSATION ──────────────────────────────────────────────────
  //
  // Where the operations group works day to day, and the conversation an `ops` event usually concerns.
  // Opened once by the platform (`initiation: 'system'`, through the same creator an event uses, with no
  // conversation concerned), and its people are the `ops` group, kept in sync exactly as an `ops` room's
  // are. Drift stays on: a team room carries many subjects, which is what drift is for.
  'ops-team': {
    classifications: ['premium'],
    membershipSource: { group: 'ops' },
    driftEnabled: true,
    messageFlow: DEFAULT_MESSAGE_FLOW,
    defaultAgents: ['advisor'],
    initiation: 'system',
    expiration: { days: MAX_CONVERSATION_TTL_DAYS, criterion: 'LAST_MESSAGE_TIMESTAMP' },
  },

  // ── AN ANONYMOUS VISITOR'S CONVERSATION (A7, L17) ────────────────────────────────────────────────
  //
  // Opened by guest start (`lambda/src/guest-session.ts`) for the visitor it mints, at the guest
  // classification and no other, and never by a person through `/create-conversation`. The visitor is a
  // member and never a moderator, and nobody else is added: membership is the guest-session credential's
  // second layer, so the visitor reaches this conversation and no other.
  //
  //   `capabilities` turns off what a guest may not do in it (L17): attachments, sharing and tasks. What
  //     holds that today is the guest's reach rather than this field: the edge admits a guest token on the
  //     credential exchange and the registration alone (`GUEST_ROUTES`), so the upload, share and task routes refuse it, and the
  //     guest-session role grants no S3 and no task write. The field is the type's statement of it.
  //   `expiration` is one day from the last message: an abandoned visit leaves nothing
  //     behind for long, and the AppInstanceUser it was minted for expires one day after its creation.
  //   `driftEnabled: false`: a visitor's one conversation is the only one they have, so there is nowhere
  //     to split a subject off to.
  'guest-visitor': {
    classifications: ['guest'],
    driftEnabled: false,
    messageFlow: DEFAULT_MESSAGE_FLOW,
    initiation: 'user',
    capabilities: { tasks: false, attachments: false, sharing: false, battle: false },
    expiration: { days: 1, criterion: 'LAST_MESSAGE_TIMESTAMP' },
    // T2: a visitor without an account binds (path A); one with an account claims into a customer
    // conversation (path B). The sample in the plan names path B alone; both are declared so a visitor
    // is never told to make a second account or refused for having one.
    upgrade: { paths: ['bind', 'claim'], into: 'customer-engagement' },
  },

  // ── A CUSTOMER'S CONVERSATION, OPENED BY A PATH B CLAIM (V5, P-12) ───────────────────────────────
  //
  // Opened by the customer classification's creator when a signed-in account redeems a visitor's
  // registration claim (`lambda/src/guest-upgrade.ts`), and never through `/create-conversation`. The
  // account is its member, and the channel carries the `upgradedFrom` tag naming the visitor's
  // conversation, which is the only relation between the two (D13): the funnel joins them by it and
  // erasure follows it (`lib/offboarding.ts`). Seeded from what the visitor registered, in the server-only
  // channel context (`eventSummary`).
  //
  //   `classifications: ['customer']`: the outside audience path B targets.
  //   `capabilities` keeps a customer's room to chat, as a visitor's is: attachments, sharing and tasks
  //     are the deployment's own people's tools.
  //   `expiration` is the platform maximum from the last message, like an ordinary conversation.
  'customer-engagement': {
    classifications: ['customer'],
    driftEnabled: false,
    messageFlow: DEFAULT_MESSAGE_FLOW,
    initiation: 'user',
    capabilities: { tasks: false, attachments: false, sharing: false, battle: false },
    seedFrom: ['guest-visitor'],
    expiration: { days: MAX_CONVERSATION_TTL_DAYS, criterion: 'LAST_MESSAGE_TIMESTAMP' },
  },
};

/** The type guest start opens a visitor's conversation as. */
export const GUEST_VISITOR_TYPE: ConversationTypeKey = 'guest-visitor';

/** The upgrade paths a type declares (T2). An unknown type declares none. */
export function upgradePathsOf(typeKey: string): ReadonlyArray<'bind' | 'claim'> {
  return CONVERSATION_TYPES[typeKey]?.upgrade?.paths ?? [];
}

/**
 * WHERE A PATH B CLAIM FROM A CONVERSATION OF THIS TYPE LANDS: the type it opens, and the one
 * classification that type permits. Null when the type declares no claim or names no target, and when
 * the target permits other than one classification or does not name this type in its `seedFrom`.
 */
export function claimTargetOf(typeKey: string): { typeKey: ConversationTypeKey; classification: Classification } | null {
  const upgrade = CONVERSATION_TYPES[typeKey]?.upgrade;
  if (!upgrade?.paths.includes('claim') || !upgrade.into) return null;
  const target = CONVERSATION_TYPES[upgrade.into];
  if (!target?.classifications || target.classifications.length !== 1) return null;
  if (!target.seedFrom?.includes(typeKey)) return null;
  return { typeKey: upgrade.into, classification: target.classifications[0] };
}

/**
 * WHERE A PATH A BIND FROM A CONVERSATION OF THIS TYPE CONTINUES (P-11): the type of the new conversation
 * the account is given, at the account's own classification, or null when there is none.
 *
 * The bound AppInstanceUser is vended at its sign-in's classification, which never includes the visitor's,
 * so the visitor's conversation is out of its reach and the visit continues in a new one, seeded from it
 * as a claim's is. The type is the one that names this type in its `seedFrom` and permits the
 * classification, a type that lists its classifications before one that permits any (`customer` lands in
 * `customer-engagement`, `basic` in `general`). Null when the type declares no `bind`, and for a
 * classification the visitor's own type permits: a bind never continues at the visitor's classification.
 * Choosing the continuation per type is **ROADMAP**.
 */
export function bindTargetOf(typeKey: string, classification: string): { typeKey: ConversationTypeKey; classification: Classification } | null {
  if (!upgradePathsOf(typeKey).includes('bind')) return null;
  if (classificationAllowedForType(typeKey, classification)) return null;
  const seeded = Object.entries(CONVERSATION_TYPES)
    .filter(([key, config]) => key !== typeKey && config.seedFrom?.includes(typeKey) && classificationAllowedForType(key, classification));
  const target = seeded.find(([, config]) => config.classifications) ?? seeded.find(([, config]) => !config.classifications);
  return target ? { typeKey: target[0], classification: classification as Classification } : null;
}

/** A type's invitations with every default applied. */
export interface ResolvedInvitationPolicy {
  modes: ReadonlyArray<RedemptionMode>;
  default: RedemptionMode;
  linkClassifications: Classification[];
  expiresInDays: number;
}

/**
 * THE INVITATIONS A TYPE DECLARES, with its defaults, or null when nobody may be invited into it: an
 * unknown type (a typo must never open a conversation to invitations), a type that declares none, and a
 * type whose people come from a membership source, whose reconcile would remove the invitee.
 */
export function invitationPolicyOf(typeKey: string): ResolvedInvitationPolicy | null {
  const config = CONVERSATION_TYPES[typeKey];
  const p = config?.invitations;
  if (!p || !p.modes?.length || membershipSourceFor(typeKey)) return null;
  return {
    modes: [...p.modes],
    default: p.modes.includes(p.default) ? p.default : p.modes[0],
    linkClassifications: p.modes.includes('link') ? [...(p.linkClassifications ?? [])] : [],
    expiresInDays: Math.min(Math.max(1, p.expiresInDays ?? DEFAULT_INVITATION_DAYS), MAX_INVITATION_DAYS),
  };
}

/**
 * The type of a conversation that carries no registered type: an ordinary one.
 *
 * A CONVERSATION STAMPED BEFORE TYPES STOPPED BEING NAMED AFTER CLASSIFICATIONS resolves here too. Its
 * stamp reads `basic`, `standard` or `premium`, none of which is a registered type any more, and every
 * one of those conversations was an ordinary conversation - so this fallback is the right answer for
 * them, with no migration and no alias table. The CLASSIFICATION is never consulted to choose a type.
 */
export const DEFAULT_CONVERSATION_TYPE: ConversationTypeKey = 'general';

/**
 * Resolve the conversation-type key for a turn: the type stamped on the conversation when it is a
 * registered one, otherwise {@link DEFAULT_CONVERSATION_TYPE}. An unregistered stamp (a typo, or a key
 * from before the rename) degrades to the ordinary type rather than disabling policy.
 */
export function resolveConversationTypeKey(opts: { explicitType?: string }): ConversationTypeKey {
  const { explicitType } = opts;
  if (explicitType && CONVERSATION_TYPES[explicitType]) return explicitType;
  return DEFAULT_CONVERSATION_TYPE;
}

/** Look up a type's config, falling back to the default type's config for an
 *  unknown key (never returns undefined). */
export function getConversationTypeConfig(typeKey: string): ConversationTypeConfig {
  return CONVERSATION_TYPES[typeKey] ?? CONVERSATION_TYPES[DEFAULT_CONVERSATION_TYPE];
}

/**
 * MAY a conversation of this type carry this classification? (ADR-053 decision 1.)
 *
 * The type's declaration is a CHECK, not a value the creator reads. Classification arrives at creation
 * as its own parameter - from a person's own group membership, or from the conversation an event
 * concerned - and the type says which values it permits. Reading the classification OFF the type
 * instead would make a creator able to mint a conversation at any classification a config file names,
 * which is the one thing that must not be possible while the tag is the only axis IAM evaluates
 * (tenet P4).
 *
 * A TYPE WITH NO `classifications` LIST PERMITS ANY, and that is what an ordinary conversation is: the
 * opener's own clearance decides its classification. Refusing an ADMIN-PLANE classification is the
 * creator's job (`profiles.isConversational`), not the type's, because it is true of every type.
 *
 * AN UNKNOWN TYPE PERMITS NOTHING. {@link getConversationTypeConfig} falls back to the default type for
 * an unknown key, which is right for reading a policy dimension and wrong for an authorization check:
 * it would let a typo'd type key be created at the default type's classification.
 */
export function classificationAllowedForType(typeKey: string, classification: string): boolean {
  const config = CONVERSATION_TYPES[typeKey];
  if (!config) return false;
  if (!config.classifications) return true;
  return config.classifications.includes(classification as Classification);
}

/**
 * THE ISSUERS A TYPE NARROWS ADMISSION TO (T1, FR23), or null when it narrows nothing. An unknown type admits
 * no issuer: a typo must never open a conversation wider than the type it meant.
 */
export function admittedIssuersOf(typeKey: string): readonly string[] | null {
  const config = CONVERSATION_TYPES[typeKey];
  if (!config) return [];
  const list = (config.admitsIssuers ?? []).map((x) => x.trim()).filter(Boolean);
  return config.admitsIssuers === undefined ? null : list;
}

/**
 * MAY A PERSON SIGNED IN THROUGH THESE ISSUERS BE ADMITTED TO A CONVERSATION OF THIS TYPE? (T1, FR23.)
 *
 * Applied after the clearance check and never in place of it: true does not admit anybody the
 * classification refuses. A type that declares no issuer list admits every issuer; one that declares a list
 * admits a person when any issuer they sign in through is on it, and a person with no issuer at all (an
 * invitee before redemption, a service principal) only when it declares none.
 */
export function typeAdmitsIssuers(typeKey: string, issuerIds: readonly string[]): boolean {
  const admitted = admittedIssuersOf(typeKey);
  if (admitted === null) return Boolean(CONVERSATION_TYPES[typeKey]);
  return issuerIds.some((id) => admitted.includes(id));
}

/**
 * The membership source a type ENFORCES, or `undefined` for a manual type. An unknown key is manual: a
 * typo must never make a conversation remove its members.
 */
export function membershipSourceFor(typeKey: string): MembershipSource | undefined {
  const src = CONVERSATION_TYPES[typeKey]?.membershipSource;
  if (!src) return undefined;
  const group = src.group?.trim() || undefined;
  const list = (src.list ?? []).map((x) => x.trim()).filter(Boolean);
  if (!group && !list.length) return undefined;
  return { ...(group ? { group } : {}), ...(list.length ? { list } : {}) };
}

/** Every group some type sources its membership from - what a group-change event is matched against. */
export function membershipSourceGroups(classification?: string): string[] {
  const groups = new Set<string>();
  for (const [key] of Object.entries(CONVERSATION_TYPES)) {
    if (classification && !classificationAllowedForType(key, classification)) continue;
    const g = membershipSourceFor(key)?.group;
    if (g) groups.add(g);
  }
  return [...groups].sort();
}

/** The registered types whose membership is sourced from `group` and which permit `classification`. */
export function typesSourcedFromGroup(group: string, classification: string): string[] {
  return Object.keys(CONVERSATION_TYPES).filter((key) =>
    membershipSourceFor(key)?.group === group && classificationAllowedForType(key, classification));
}

/** Every registered type that enforces a membership source and permits `classification`. */
export function sourcedTypes(classification: string): string[] {
  return Object.keys(CONVERSATION_TYPES).filter((key) =>
    !!membershipSourceFor(key) && classificationAllowedForType(key, classification));
}

/** Is the user-facing live drift flow enabled for this conversation type? */
export function isDriftEnabledForType(typeKey: string): boolean {
  return getConversationTypeConfig(typeKey).driftEnabled;
}




/**
 * The membership source as the short string stamped on a conversation at creation - `group:ops`, `list`,
 * or `group:ops+list` - for the paths that read the stamp rather than the registry. `undefined` is manual.
 */
export function membershipSourceStamp(typeKey: string): string | undefined {
  const src = membershipSourceFor(typeKey);
  if (!src) return undefined;
  return [src.group ? `group:${src.group}` : '', src.list?.length ? 'list' : ''].filter(Boolean).join('+');
}
