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
 * `min(userClearance, channelClassification)`) is fail-closed and depends on a TOTAL ORDER of
 * classifications (`basic < standard < premium`). Conversation types are meant
 * to proliferate and need NOT be totally ordered (what's the order of `guest`
 * vs `engagement`?). So each type *carries* a `classification` — the small,
 * ordered, IAM-evaluated security level — rather than being one. This keeps the
 * deny-tested security boundary intact while the type catalogue grows. See
 * docs/SPEC-CONVERSATION-SECURITY.md §4.
 */

import type { Classification } from './model-strategy';
import type { ConnectorRef } from './connectors';

/** A conversation-type key. Open-ended (string) by design — deployers add types
 *  to {@link CONVERSATION_TYPES} without a type-system change. The shipped set
 *  happens to mirror the classifications. */
export type ConversationTypeKey = string;

/** What starts a conversation of this type. Default `'user'` (someone opens a
 *  chat). `'schedule'` = EventBridge (proactive briefing); `'system'`/`'alert'`
 *  = a service/alert webhook with NO human creator JWT (e.g. incident triage) —
 *  the trigger boundary must be authenticated and the assistant acts as bot bearer. */
export type Initiation = 'user' | 'system' | 'schedule' | 'alert';

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
}

/**
 * How a conversation type's welcome template becomes copy.
 *
 * `interpolated` substitutes the assembled orientation into the template with NO model call. It is the
 * deterministic path and the FALLBACK THAT KEEPS THE WELCOME LANDING: a welcome that always arrives is
 * the one property this surface cannot trade away.
 *
 * `generated` has the assistant fill in and ADJUST the template against the orientation it was given,
 * which is what a conversation type carrying arbitrary context (incident state, a prior conversation)
 * needs - no template can usefully summarise state it has never seen. It costs a Bedrock call per new
 * conversation, brings the output guardrail onto the welcome, and must fall back to `interpolated` on a
 * deadline miss or when the model is unavailable.
 *
 * Naming deliberately mirrors `AssistantProfile.classifierMode` (`'llm' | 'keyword'`): the platform
 * already has a "model or not" axis and should not grow a second vocabulary for it.
 */
export type WelcomeRenderMode = 'interpolated' | 'generated';

/**
 * Per-conversation-type welcome configuration. ABSENT means today's behaviour exactly: the built-in
 * clause assembly, interpolated, over the deployment orientation plus whatever the channel carries.
 *
 * This is the axis that makes a new use case configuration rather than code. An incident-escalation
 * meeting and a drift follow-up differ in which context orients them and in what the opening should
 * emphasise - not in which handler runs.
 */
export interface WelcomeConfig {
  /** Absent ⇒ `interpolated`. See {@link WelcomeRenderMode}. */
  mode?: WelcomeRenderMode;
  /**
   * The template the welcome is built from. Absent ⇒ the built-in clause assembly in
   * `welcome-orientation.ts`, so an un-configured type is byte-identical to today.
   */
  template?: string;
  /**
   * Context-source keys that orient this type's welcome, resolved against the published catalog at the
   * WelcomeIntent call site. Absent ⇒ the deployment orientation parameter alone.
   *
   * A source whose `availability` is unmet at WelcomeIntent is OMITTED, never awaited - the welcome
   * fires on the assistant's channel membership, before the creator's membership and channel metadata
   * converge, so waiting would trade promptness for data that may never arrive.
   */
  contextKeys?: string[];
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
   * The ordered security classification this type maps to — the value IAM
   * evaluates via the channel's `classification` tag (Layer 1). Multiple
   * conversation types may share one classification (e.g. `guest` and a future
   * `demo` could both be `basic`-classified). This is the ONLY closed/ordered
   * field; everything else is open/composable (forward-compat contract).
   */
  classification: Classification;
  /**
   * Whether the USER-FACING live drift flow (lib/live-drift-flow.ts) runs for
   * conversations of this type. Drift is conversation-level, so its on/off is a
   * property of the conversation type — NOT of the user's clearance. (Requires
   * Aurora mode regardless; this gate is layered on top of the Aurora hookup.)
   */
  driftEnabled: boolean;

  // ── Forward-compat dimension seams (OPTIONAL, not yet consumed) ───────────
  // Each has a safe default when absent (see docs/SPEC-CONVERSATION-TYPES.md §5).
  // Present so adding a use case (engagement / support / service / triage)
  // never requires a schema change or a handler `switch` — only config.

  /** What initiates this conversation. Default `'user'`. */
  initiation?: Initiation;
  /** Default agent handle(s) to enroll. Absent ⇒ the per-classification AppInstanceBot. */
  defaultAgents?: string[];
  /** Transports available to this type. Absent ⇒ `['chat']`. */
  commsChannels?: CommsChannel[];
  /** Feature toggles beyond drift. */
  capabilities?: Capabilities;
  /** Who participates + how non-creator humans are resolved/admitted. */
  participants?: ParticipantPolicy;
  /**
   * How this type opens a conversation: which context orients the welcome, and how the template becomes
   * copy. Absent ⇒ the built-in interpolated assembly over the deployment orientation (today's
   * behaviour, unchanged). See {@link WelcomeConfig} and {@link resolveWelcomeConfig}.
   */
  welcome?: WelcomeConfig;
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
}

/**
 * The shipped conversation types. Mirrors the classifications today (so behavior
 * is unchanged: every classification had drift on-by-default). To turn drift off
 * for a type, add a non-classification type, or wire default agents/channels, edit THIS map — no
 * handler change. Keys are matched against the channel's resolved conversation
 * type (see {@link resolveConversationTypeKey}).
 */
export const CONVERSATION_TYPES: Record<ConversationTypeKey, ConversationTypeConfig> = {
  // Platform-wide retention: every conversation hard-expires 90 days after its
  // last message (user directive 2026-07-16). LAST_MESSAGE_TIMESTAMP freezes the
  // clock at the final real message, so an archived (now-inactive) conversation
  // auto-deletes 90 days later — the "eventual hard delete" ADR-017 composes with.
  basic: { classification: 'basic', driftEnabled: true, expiration: { days: 90, criterion: 'LAST_MESSAGE_TIMESTAMP' } },
  standard: { classification: 'standard', driftEnabled: true, expiration: { days: 90, criterion: 'LAST_MESSAGE_TIMESTAMP' } },
  premium: { classification: 'premium', driftEnabled: true, expiration: { days: 90, criterion: 'LAST_MESSAGE_TIMESTAMP' } },
};

/**
 * The conversation type assumed when a channel carries no explicit type. We
 * default the type to the conversation's CLASSIFICATION axis, so a channel with
 * no explicit type behaves as its classification dictates. `standard` is
 * the registry fallback only if even the classification is unknown.
 */
export const DEFAULT_CONVERSATION_TYPE: ConversationTypeKey = 'standard';

/**
 * Resolve the conversation-type key for a turn. Prefers an explicit type
 * stamped on the channel (metadata/tag); otherwise falls back to the
 * classification (type ≡ classification today). An explicit type that isn't in
 * the registry is ignored (fall back to classification) so a typo can't
 * silently disable policy.
 */
export function resolveConversationTypeKey(opts: {
  explicitType?: string;
  classification: string;
}): ConversationTypeKey {
  const { explicitType, classification } = opts;
  if (explicitType && CONVERSATION_TYPES[explicitType]) return explicitType;
  if (CONVERSATION_TYPES[classification]) return classification;
  return DEFAULT_CONVERSATION_TYPE;
}

/** Look up a type's config, falling back to the default type's config for an
 *  unknown key (never returns undefined). */
export function getConversationTypeConfig(typeKey: string): ConversationTypeConfig {
  return CONVERSATION_TYPES[typeKey] ?? CONVERSATION_TYPES[DEFAULT_CONVERSATION_TYPE];
}

/** Is the user-facing live drift flow enabled for this conversation type? */
export function isDriftEnabledForType(typeKey: string): boolean {
  return getConversationTypeConfig(typeKey).driftEnabled;
}

/** A {@link WelcomeConfig} with every default applied, so no caller has to know them. */
export interface ResolvedWelcomeConfig {
  mode: WelcomeRenderMode;
  /** Undefined ⇒ use the built-in clause assembly. */
  template?: string;
  contextKeys: string[];
}

/**
 * Resolve a conversation type's welcome configuration, defaults applied.
 *
 * Exists as its own function rather than as inline `??` at the call site so the DEFAULTS ARE TESTABLE
 * independently of the router. The default has to be byte-identical to today's behaviour: adding this
 * field must not change a single existing deployment's welcome, and "no config" is the state every
 * shipped conversation type is in.
 *
 * `mode` degrades to `interpolated` for an unrecognised value rather than throwing or guessing
 * `generated`. Failing towards the deterministic, no-model path costs richness; failing towards the
 * model path would spend Bedrock on every new conversation because of a typo in a config file.
 */
export function resolveWelcomeConfig(typeKey: string): ResolvedWelcomeConfig {
  const configured = getConversationTypeConfig(typeKey).welcome ?? {};
  const mode: WelcomeRenderMode = configured.mode === 'generated' ? 'generated' : 'interpolated';
  const template = configured.template?.trim() ? configured.template : undefined;
  const contextKeys = (configured.contextKeys ?? [])
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  return { mode, template, contextKeys };
}
