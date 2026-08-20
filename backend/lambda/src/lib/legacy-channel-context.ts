/**
 * LEGACY PROMOTION: what a pre-move channel's Metadata may contribute to the server-only Channel
 * Context store, and under exactly what conditions.
 *
 * WHAT THIS EXISTS FOR. Six fields - `participantProfile`, `domainContext`, `otherContexts`,
 * `userName`, `userLanguage`, `segment` - used to live in member-readable channel Metadata. The P1
 * split moved them to the server-only store, and `host-grounding.ts` now reads them ONLY from there. A
 * conversation created BEFORE that move has its grounding in Metadata and no stored copy, so every turn
 * on it is served ungrounded and, because `userLanguage` and `segment` choose the model, in the
 * deployment's default language on the deployment's default model.
 *
 * WHY THE PROMOTION IS AN OPERATOR ACTION AND NOT A READ-TIME FALLBACK. Channel Metadata is member
 * WRITABLE: a channel's creator is a moderator of their own channel and holds `chime:UpdateChannel`,
 * which writes Name and Metadata in ONE call, and IAM cannot separate them. A read-time fallback would
 * therefore put attacker-controlled text into the assistant's system prompt on every turn, forever, and
 * would let a member pick the model that answers their own conversation. Promoting once, from a script
 * an operator runs deliberately, is a bounded decision instead: it happens at a known time, on a known
 * population, on a deployment whose operator can judge whether its Metadata was ever exposed to
 * untrusted writers, and it never runs again.
 *
 * WHAT THIS MODULE IS. The decision and the sanitising only - no AWS clients, no I/O. It is a library
 * rather than script-local code so the promotion can be unit-tested (the scripts run `main()` at
 * import) and so the write-path bounds are the SAME objects the write path uses, not copies that drift.
 *
 * THE PROMOTED VALUES ARE STILL TREATED AS UNTRUSTED. Every field is re-bounded exactly as the host API
 * bounds it, the two routing signals are additionally shape-validated (they choose a model, so a
 * malformed one is discarded rather than carried), and every free-text string is marker-stripped the
 * way `sanitiseValue` strips a context source - because this text reaches the system prompt and, unlike
 * a host API call, its provenance is a member-writable field.
 */
import {
  boundedDomainContext,
  boundedOtherContexts,
  PRIVATE_GROUNDING_FIELDS,
  type PrivateGroundingField,
} from './host-grounding.js';
import { stripMessageMarkers } from './message-markers.js';
import type { ChannelContextPatch } from './channel-context-client.js';

/** Why a channel is left alone. Each is reported, because a silent skip is how a backfill lies. */
export type PromotionSkipReason =
  /** The store already holds at least one of the six. Never overwrite the authority with a copy. */
  | 'already-grounded'
  /** A store writer has touched this row, so the absence of the six MIGHT be a decision. Operator call. */
  | 'store-owns-the-row'
  /** Nothing legacy in Metadata (or it is unparseable / malformed). Nothing to recover. */
  | 'nothing-to-promote';

/** How much the operator is willing to promote. */
export interface PromotionOptions {
  /**
   * Promote into a row a store writer has already touched (see rule 2). Off by default; the script
   * exposes it as an explicit flag after the dry run has told the operator how many channels it covers.
   */
  includeStoreOwned?: boolean;
  /** Prefix for the bounding logs. */
  logPrefix?: string;
}

/** What the backfill would do to one channel. */
export interface PromotionPlan {
  /** The fields this channel gains. Empty when `skipped` is set. */
  fields: PrivateGroundingField[];
  /** Exactly what to write. Empty when `skipped` is set. */
  patch: ChannelContextPatch;
  /** Set when nothing is written, with the reason. */
  skipped?: PromotionSkipReason;
}

/** A language tag the routing path can act on: `zh`, `en`, `pt-BR`. Anything else is discarded. */
const LANGUAGE_TAG = /^[A-Za-z]{2}(-[A-Za-z0-9]{2,4})?$/;
/** ISO-3166 alpha-2, matching what the host API accepts on the create path. */
const COUNTRY = /^[A-Z]{2}$/;
/** Deep enough for any plan the write path bounds, shallow enough that a hostile blob cannot recurse. */
const MAX_STRIP_DEPTH = 8;

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Marker-strip every string inside a structured value.
 *
 * The scalar fields are obvious; a `domainContext` plan is not, and it is the largest thing promoted.
 * Its item titles and notes land in the system prompt exactly as the scalars do, so a `<!--ACTIVE_TASK…-->`
 * or `NAVIGATE_CHANNEL:` marker buried in a plan item is the same injection with more room to hide.
 * Bounded by depth so a deeply nested blob cannot turn the sanitiser into a denial of service.
 *
 * PAST THE BOUND THE VALUE IS DROPPED, NOT RETURNED. Returning it was the wrong end of the trade: a
 * string is stripped before the depth test, so scalars were always safe, but an OBJECT at the bound
 * came back whole with every string inside it unstripped - so the way to defeat the sanitiser was to
 * nest the marker one level deeper than it looks. Dropping is safe in the direction that matters:
 * this input is member-writable Metadata being promoted into the server-only store, and losing a
 * field nested eight deep in a plan costs a fragment of recovered grounding, while keeping it
 * unstripped costs the injection defense the whole module exists to provide.
 */
function stripDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return stripMessageMarkers(value);
  if (depth >= MAX_STRIP_DEPTH) return typeof value === 'object' && value !== null ? undefined : value;
  if (Array.isArray(value)) return value.map((v) => stripDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    // NULL-PROTOTYPE, and `__proto__` skipped: this walks JSON parsed from MEMBER-WRITABLE channel
    // Metadata, so `{"__proto__": {...}}` would otherwise reassign this object's prototype through the
    // setter. Nothing inherited is marshalled to DynamoDB and this runs only in an operator-invoked
    // backfill, so it was not exploitable - but the input is attacker-controlled by definition and the
    // fix is two lines.
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '__proto__') continue;
      out[k] = stripDeep(v, depth + 1);
    }
    return { ...out };
  }
  return value;
}

/**
 * The promotable subset of one channel's Metadata, bounded and sanitised.
 *
 * Bounds come from the WRITE path (`boundedDomainContext`, `boundedOtherContexts`, and the same 80/600
 * character caps `federated-create-conversation.ts` applies), because the failure they prevent is on the
 * READ side: the router spreads the whole grounding into a 256KB `Event` invoke, and an oversized value
 * makes every turn in that conversation stick on the placeholder forever. A backfill that skipped the
 * bounds would recover a conversation into exactly that state.
 */
function promotableFrom(meta: Record<string, unknown>, logPrefix: string): ChannelContextPatch {
  const patch: ChannelContextPatch = {};

  const userName = typeof meta.userName === 'string'
    ? stripMessageMarkers(meta.userName).slice(0, 80) : '';
  if (userName) patch.userName = userName;

  const participantProfile = typeof meta.participantProfile === 'string'
    ? stripMessageMarkers(meta.participantProfile).slice(0, 600) : '';
  if (participantProfile) patch.participantProfile = participantProfile;

  // The two routing signals get a SHAPE check on top of the bound, which the host API does not apply.
  // They select the model and the reply language, so a malformed value is not a cosmetic problem: the
  // right failure is to leave the conversation on the deployment default rather than to route it
  // somewhere on a value nothing recognises.
  const userLanguage = typeof meta.userLanguage === 'string' ? meta.userLanguage.trim() : '';
  if (LANGUAGE_TAG.test(userLanguage)) patch.userLanguage = userLanguage;

  const rawSegment = meta.segment as { country?: unknown } | null | undefined;
  const country = rawSegment && typeof rawSegment === 'object'
    ? String(rawSegment.country ?? '').trim().toUpperCase()
    : '';
  if (COUNTRY.test(country)) patch.segment = { country };

  const domainContext = boundedDomainContext<Record<string, unknown>>(
    stripDeep(meta.domainContext), logPrefix,
  );
  if (domainContext) patch.domainContext = domainContext;

  const otherContexts = boundedOtherContexts(stripDeep(meta.otherContexts));
  if (otherContexts && otherContexts.length > 0) patch.otherContexts = otherContexts;

  return patch;
}

/**
 * Decide what one channel gets, from its raw Metadata string and its current store row.
 *
 * THE THREE RULES, IN ORDER:
 *
 *  1. The row already carries one of the six -> `already-grounded`. The store is the authority; a
 *     member-writable copy never corrects it. Unconditional - no flag reaches past this.
 *  2. The row carries `updatedAt` -> `store-owns-the-row`, unless the operator asks otherwise. That
 *     field is stamped only by the store's own writers, so SOMETHING has owned this row, and in one case
 *     the absence of the six is a deliberate statement: a host clears a field by sending `null`, which
 *     REMOVES the attribute. Promoting there could resurrect grounding a host deleted.
 *
 *     THE RULE IS DELIBERATELY OVERRIDABLE, because it is broad in the other direction: writers that
 *     never touch grounding stamp `updatedAt` too - the native create path recording the participant
 *     shape, and `recordMemberIdentity` appending an issuer hint when someone is added to an existing
 *     conversation. Those rows are the legacy population, not the decided one. Left unconditional, this
 *     rule would let the backfill enumerate every channel, recover none, and exit successfully, which is
 *     the failure a backfill must never have. So the default is the cautious answer and the dry run
 *     reports the size of this bucket, which turns it into a decision the operator makes with numbers.
 *
 *     `null` on the create/edit path also re-stamps the channel's Metadata WITHOUT the cleared field, so
 *     in practice a cleared field usually has nothing left in Metadata to resurrect and lands on rule 3
 *     regardless. The override is not reckless; it is narrower than it looks.
 *  3. Otherwise promote whatever Metadata still carries, bounded and sanitised. Unparseable Metadata,
 *     or Metadata carrying none of the six, is `nothing-to-promote`.
 *
 * @param metadata the channel's raw `Metadata` string from `DescribeChannel` (JSON, or not)
 * @param row      the current Channel Context item, or null when the channel has none
 * @param options  see {@link PromotionOptions}
 */
export function planLegacyPromotion(
  metadata: string | null | undefined,
  row: Record<string, unknown> | null | undefined,
  options: PromotionOptions = {},
): PromotionPlan {
  const logPrefix = options.logPrefix || '[backfill-channel-context]';
  const none = (skipped: PromotionSkipReason): PromotionPlan => ({ fields: [], patch: {}, skipped });

  if (row && PRIVATE_GROUNDING_FIELDS.some((f) => present(row[f]))) return none('already-grounded');
  if (row && present(row.updatedAt) && !options.includeStoreOwned) return none('store-owns-the-row');

  let meta: Record<string, unknown>;
  try {
    const parsed = JSON.parse(metadata || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return none('nothing-to-promote');
    meta = parsed as Record<string, unknown>;
  } catch {
    return none('nothing-to-promote');
  }

  const patch = promotableFrom(meta, logPrefix);
  const fields = PRIVATE_GROUNDING_FIELDS.filter((f) => present(patch[f]));
  if (fields.length === 0) return none('nothing-to-promote');
  return { fields, patch };
}
