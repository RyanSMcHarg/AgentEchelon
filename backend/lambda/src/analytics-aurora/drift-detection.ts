/**
 * Drift Detection (Hardened — per SPEC-DRIFT-CONVERGENCE.md)
 *
 * Detects when a conversation's topic has shifted from its running summary,
 * via cosine similarity between the latest user message and the summary
 * embedding (both Titan v2, 1024-dim).
 *
 * Key design properties (per the spec):
 *
 * - Single signal: cosine_distance(message_embedding, summary_embedding).
 *   No keyword overlap, no substring entity matching.
 * - Embedding failure → "no drift this turn" (signalAvailable:false).
 *   No string-matching fallback. The next message gets another shot.
 * - Explicit-routing fast-path (`detectExplicitRoutingRequest`) is the
 *   only place string matching survives — it routes immediately on
 *   unambiguous user intent without computing cosine.
 * - By-reference telemetry: writes to drift_events reference the
 *   originating message by id; never store the message body.
 * - Per-stage EMF metrics on every invocation (success or skip).
 */

import { embedText, EMBEDDING_TIMEOUT_LIVE_MS } from './embed-text.js';
import { query } from './db-client.js';
import { withReaderRole, withWriterRole } from './classification-boundary.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import {
  emitDriftTiming,
  emitDriftCounter,
  newCorrelationId,
} from '../lib/emf-metrics.js';
import { detectExplicitRoutingRequest } from '../lib/explicit-routing.js';
import type { Classification } from '../../../lib/config/model-strategy.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Intent =
  | 'GREETING'
  | 'ACKNOWLEDGMENT'
  | 'OFF_TOPIC'
  | 'GUIDED_TROUBLESHOOTING'
  | 'DATA_EXTRACTION'
  | 'REPORT_GENERATION'
  | 'GENERAL';

export interface DetectDriftInput {
  channelArn: string;
  // NO messageId. It was required here and read nowhere in this function, so every caller had to
  // invent one - the live path minted a randomUUID() per turn and shipped it across a Lambda
  // invoke, and archival passed the real row id. A required field that nothing reads does not
  // merely waste a field: it looks like the id this drift row will be keyed on, and it is not.
  // The row is keyed by the id `recordDriftFire` is given separately, resolved for that purpose.
  latestMessage: string;
  intent: Intent;
  /**
   * UUIDv7 stitched into EMF metrics, log lines, and the bot's outbound
   * message metadata. Generated if not provided.
   */
  correlationId?: string;
  /**
   * Optional caller-supplied clearance dimension for EMF. When omitted, metrics
   * aggregate across clearances.
   */
  userClearance?: Classification;
  /**
   * KEEP THE MESSAGE EMBEDDING WHEN AN OFFER FIRES, so a decline can adopt it as a topic of this
   * conversation (`adoptOfferedTopic`, migration 044).
   *
   * Set only by the LIVE flow, and only when an offer will actually be shown. Archival scoring shows
   * nothing to anyone, so nothing it scores can be declined; a battle turn reports drift without
   * offering a split. Absent means nothing is stored, which is also what an older caller gets: its
   * declines simply adopt nothing.
   *
   * REPLACES `declinedDistances`. That list suppressed any message whose distance from the summary
   * sat within 0.05 of a declined one - a match on a NUMBER, not a subject, kept in the Amazon Lex
   * session. A declined topic is now part of the conversation and is compared as a topic.
   */
  retainOfferEmbedding?: boolean;
  /**
   * True when this CHANNEL has a LIVE task (status pending/in_progress), whichever principal holds it.
   *
   * A live task means the assistant is mid-workflow and has asked someone here for something -
   * requirements, an outline approval, symptoms. The turn is then an ANSWER, and an answer is a
   * continuation of the thread, not a pivot away from it. The cosine signal cannot see that: an answer
   * is often a short fragment ("Audience is engineering leadership. Focus on delivery velocity and CI
   * cost.") carrying none of the topic words the summary embedding was built from, so it lands far
   * from the summary and fires drift on the one turn the assistant explicitly solicited.
   *
   * NOT KEYED ON OWNERSHIP, and the narrower version is what shipped the failure. Ownership moves to
   * the person only at an `awaits` boundary, so a state that ends its turn on a question and does
   * not declare the flag left the task with the ASSISTANT - and a suppression that asked "does this
   * user hold a task" answered no. `report_generation.drafting_outline` was such a state, and "Can you
   * make it 1-2 pages?", a direct answer to the assistant's own outline question, was met with an
   * offer to split the conversation. The condition this field stands for is "the assistant is
   * mid-workflow here", which is true either way, so it no longer depends on a per-state flag.
   *
   * THE NAME IS THE WIRE CONTRACT and is deliberately unchanged: this input crosses a Lambda boundary
   * as JSON (the router calls into the data plane, ADR-013), so renaming the field would mean the two
   * disagree for as long as their deploys are apart, and the drift suppression would simply stop.
   *
   * Suppression applies to the COSINE path only. The explicit-routing fast-path is checked first and
   * still fires, so a user who deliberately asks for a new conversation mid-task still gets one. It
   * also lifts the moment the task reaches a terminal state: a follow-up ABOUT a finished task is not
   * covered here (SPEC-DRIFT-CONVERGENCE, "Active-Task Suppression").
   */
  activeTaskInProgress?: boolean;
  /**
   * WHICH EVIDENCE suppressed the turn, when `activeTaskInProgress` is set. Reporting only; it never
   * changes the decision.
   *
   * 'live'            - work is running here now.
   * 'recently_ended'  - work finished here within the deployment's recently-ended window, so the turn
   *                     is probably about what was just delivered ("Where is the file?").
   *
   * ADDITIVE ON PURPOSE. An older data plane that has never heard of this field still reads the
   * boolean and still suppresses; it loses only the finer counter. Carrying the distinction in a
   * SECOND boolean instead would have made an unrecognized field mean "do not suppress", which is the
   * silent-regression shape this input's own history is a record of.
   */
  taskSignal?: 'live' | 'recently_ended';
  /**
   * The channels this drift query may look in: those EVERY current human member of the conversation
   * also belongs to (ADR-012).
   *
   * **Resolved by the CALLER, from Amazon Chime SDK Messaging, and required.** Two reasons it cannot
   * be computed here:
   *
   *  - **Authority.** This is a privacy control. The only authoritative answer is the messaging
   *    service's own membership; the Aurora `channel_membership` table is an archive the Kinesis path
   *    fills asynchronously, and a member who joined seconds ago is missing from it — which widens
   *    the scope past the people actually in the room.
   *  - **Reachability.** This code runs in `DataPlaneLambda`, VPC-attached in the isolated subnets
   *    with no Chime endpoint and no NAT, so a Chime call from here hangs until the timeout.
   *
   * Absent ⇒ no related conversation is suggested. There is deliberately no fallback to the archive.
   */
  scopedChannelArns?: string[];
  /**
   * DO NOT LOOK FOR A RELATED CONVERSATION HERE; HAND THE QUESTION BACK.
   *
   * The scope above costs one `SearchChannels` page per 50 conversations the room shares with the
   * assistant, and the live flow used to resolve it on EVERY turn, before detection - although only a
   * turn that fires drift ever asks question 3. Measured 2026-10-05: a test person and the premium
   * assistant shared 597 conversations, so every turn paid 12 sequential searches, and a burst of turns
   * was throttled by the service.
   *
   * With this set, a turn that fires returns `relatedLookupPending` instead of running the lookup, and
   * the caller resolves the scope live only then and calls `resolveDriftRival`. The scope is still read
   * from Amazon Chime SDK Messaging at the moment it is used; nothing is cached.
   *
   * ADDITIVE ON THE WIRE. An older data plane ignores the field and runs the lookup against the absent
   * scope, which suggests nothing: the turn degrades to `confirm`, never wider.
   */
  deferRelatedLookup?: boolean;
  /**
   * REQUIRED. The current channel's classification, used to select the database reader role both
   * summary-embedding reads run as (ADR-028).
   *
   * WHY THIS IS NOT `userClearance` ABOVE, which carries the same value today. That field is a metric
   * DIMENSION and is optional; a boundary cannot be optional, and an absent value there would silently
   * become an absent role here. The names also mean different things on purpose - clearance is what a
   * PERSON holds, classification is what CONTENT is - and this one is deciding what content may be
   * read, so it is named for that.
   *
   * WHAT IT FIXES. Scoping by membership alone let drift point from a BASIC channel at a PREMIUM one:
   * two premium-cleared people talking in a basic channel have premium channels in their membership
   * intersection. Nobody learned anything they could not already open, but the platform's model is
   * that the CHANNEL's classification bounds what may surface in it. Membership protects the people;
   * it does not protect the channel. The reader role now bounds the candidate set as well.
   */
  classification: string;
}

export interface DriftResult {
  isDrift: boolean;
  driftScore: number;
  suggestedAction: 'continue' | 'confirm' | 'redirect';
  confidence: 'low' | 'medium' | 'high';
  signalAvailable: boolean;
  correlationId: string;
  /** The message template of the offer (`drift-offer` or `drift-redirect-offer`), which the router renders. */
  suggestionTemplate?: 'drift-offer' | 'drift-redirect-offer';
  rivalConversationArn?: string;
  /** Internal — true iff the explicit-routing fast-path matched, never cosine. */
  viaExplicitIntent?: boolean;
  /** Internal — set when viaExplicitIntent is true. */
  explicitTopicHint?: string;
  /**
   * Set only when the caller asked for `deferRelatedLookup` and drift fired: question 3 has not been
   * asked. The caller resolves the scope and passes this embedding to `resolveDriftRival`.
   */
  relatedLookupPending?: { messageEmbedding: number[] };
}

// ---------------------------------------------------------------------------
// Config (env-tunable; sensible defaults per spec)
// ---------------------------------------------------------------------------

// The model, the dimension and the live timeout now live in `embed-text.ts`, which is the one Titan
// call every consumer of this vector space shares (ADR-002, ADR-004). They were declared here and
// again, identically, in `embedding-writer.ts`.
// THE THRESHOLD IS MEASURED, NOT ASSUMED (2026-10-15). Scored against the curated cases with
// `scripts/score-drift-fixture.mjs` under the nearest-anchor rule: at the former 0.35 every drift-negative case
// fired (100% false offers), because Titan distances between a question and an on-topic summary sit near 0.75;
// the turn-two skip and the 30-minute summary wait had hidden that. At 0.84, 92% of real pivots fire and 12%
// of on-topic messages do. 0.86 lowers false offers to 8% at the same catch rate, but live turn-two pivots
// measured 0.844, 0.867 and 0.904, so 0.86 would miss the lowest. Re-score after changing the embedding model.
const DRIFT_DISTANCE_THRESHOLD = Number(process.env.DRIFT_DISTANCE_THRESHOLD || '0.84');
const REROUTE_SIMILARITY_THRESHOLD = Number(process.env.DRIFT_REROUTE_THRESHOLD || '0.80');

// THE OFFER IS A MESSAGE TEMPLATE THE ROUTER SAYS (ADR-062 decision 6). The data plane holds no assistant's
// templates, so it names which offer applies and the router renders it in the assistant's words.
const SUGGESTION_CONFIRM_TEMPLATE = 'drift-offer';
const SUGGESTION_REDIRECT_TEMPLATE = 'drift-redirect-offer';

// The Bedrock client is a module-singleton inside `embed-text.ts`, reused across warm invocations
// exactly as it was here. This file no longer calls Bedrock directly.

// ---------------------------------------------------------------------------
// Public: detectDrift
// ---------------------------------------------------------------------------

export async function detectDrift(input: DetectDriftInput): Promise<DriftResult> {
  // The classification selects the database reader role both summary reads run as (ADR-028). Checked
  // HERE, at the entry point, because the data-plane dispatch hands this input across a Lambda
  // boundary as `any`, which erases the required type - so a caller that omits it is a runtime
  // condition, not a compile-time one.
  //
  // THIS CHECK IS HERE BECAUSE ITS ABSENCE SHIPPED. Without it the missing value flowed all the way to
  // `readerRoleFor`, which built `ae_reader_undefined` and failed on the database once per turn. Two
  // Lambdas, one contract: the data-plane enforced the new field before the router that supplies it
  // was redeployed. Fail fast, with the caller named, rather than constructing a role that cannot exist.
  if (!profiles.isKnownClassification(input?.classification)) {
    throw new Error(
      `[drift] classification is required and must be declared by this deployment; got `
      + `${JSON.stringify(input?.classification)}. Drift reads summary embeddings as a per-classification `
      + 'database role (ADR-028). If this is the live path, the ROUTER is older than the data-plane.',
    );
  }
  const correlationId = input.correlationId || newCorrelationId();
  const tStart = Date.now();

  const baseResult: DriftResult = {
    isDrift: false,
    driftScore: NaN,
    suggestedAction: 'continue',
    confidence: 'low',
    signalAvailable: true,
    correlationId,
  };

  const emfOpts = { userClearance: input.userClearance, intent: input.intent };

  // Skip: intent-based short-circuits.
  if (input.intent === 'GREETING' || input.intent === 'ACKNOWLEDGMENT' || input.intent === 'OFF_TOPIC') {
    emitDriftCounter('drift_skipped_intent', correlationId, emfOpts);
    emitDriftTiming('total', Date.now() - tStart, correlationId, emfOpts);
    return baseResult;
  }

  // Skip: empty/whitespace-only message.
  const text = (input.latestMessage || '').trim();
  if (!text) {
    emitDriftCounter('drift_skipped_intent', correlationId, emfOpts);
    emitDriftTiming('total', Date.now() - tStart, correlationId, emfOpts);
    return baseResult;
  }

  // Fast-path: explicit-routing request. The only legitimate string match
  // in this module (per SPEC, no other path uses substring/keyword logic).
  const explicit = detectExplicitRoutingRequest(text);
  if (explicit.matched) {
    emitDriftCounter('drift_fastpath_explicit_intent', correlationId, emfOpts);
    emitDriftTiming('total', Date.now() - tStart, correlationId, emfOpts);
    return {
      ...baseResult,
      isDrift: true,
      driftScore: 1.0,
      suggestedAction: 'confirm',
      confidence: 'high',
      suggestionTemplate: SUGGESTION_CONFIRM_TEMPLATE,
      viaExplicitIntent: true,
      explicitTopicHint: explicit.topicHint,
    };
  }

  // Skip: the assistant is mid-workflow in this conversation, so this turn is an ANSWER. Checked
  // AFTER the explicit-routing fast-path (a deliberate "start a new conversation about X" still
  // routes) and BEFORE the summary fetch + embed, so a suppressed turn also costs no Bedrock call.
  // See `activeTaskInProgress` for why cosine mis-reads answers, and why the caller resolves this
  // without reference to who currently owns the task.
  //
  // THIS IS A DELIBERATE INTERIM, NOT THE INTENDED RULE. It treats ANY live task as a reason to
  // continue here, so while a task is open a genuinely new subject is never offered a conversation of
  // its own. The target design separates the two questions this collapses: is the message unrelated
  // to the TASK (break out of the task, carry on in this conversation), and is it ALSO unrelated to
  // the CONVERSATION (that, and only that, is drift). The interim errs toward continuity because
  // continuity is the cheaper failure - the person can still ask outright, which takes the fast path
  // above. Do not read this branch as the product decision; `lib/task-continuity.ts` holds it, along
  // with what the two-axis version needs and does not have.
  if (input.activeTaskInProgress) {
    emitDriftCounter(
      input.taskSignal === 'recently_ended' ? 'drift_skipped_recent_task' : 'drift_skipped_active_task',
      correlationId,
      emfOpts,
    );
    emitDriftTiming('total', Date.now() - tStart, correlationId, emfOpts);
    return baseResult;
  }

  // Fetch summary embedding (PK lookup; fast).
  // ── EVERY TURN IS COMPARED WITH THE CONVERSATION'S OWN SUBJECTS ────────────
  //
  // The decision used to be the distance from the summary alone, an AVERAGE that no single subject sits
  // near, with the subjects consulted only once that distance was already past the threshold, and turn two
  // skipped outright because its summary was the one-exchange seed. That missed the plainest pivot there
  // is ("What is AgentEchelon?" then a revenue figure) and left the subjects as an afterthought.
  //
  // Now every turn measures the message against each subject the conversation has (those a summary
  // established, those the person kept by declining a split, and the opening seed's) and against the
  // summary, and is the same subject when it is near ANY of them. A message far from all of them is a new
  // subject. Including the summary only ever fires less often than the subjects alone: a subject is a
  // short label, and a full question can sit far from a label it is plainly about.
  //
  // The seed is compared against, not skipped. The thin-anchor skip (2026-09-23) existed because the seed
  // summary was the only anchor; the seed's subjects now stand beside it, so a second message continuing
  // the first sits near one of them, and a second message on a new subject is far from all of them.
  //
  // A FAILED READ DOES NOT SUPPRESS: with no anchor readable there is nothing to compare, so the turn
  // continues and says why; with some anchors readable, the comparison uses those.
  const tSummaryStart = Date.now();
  let summaryEmbedding: number[] | null = null;
  try {
    summaryEmbedding = (await loadSummaryEmbedding(input.channelArn, input.classification))?.embedding ?? null;
  } catch (err) {
    console.warn('[drift] summary_embeddings lookup failed:', err);
  }
  let subjects: number[][] = [];
  try {
    subjects = await loadAdoptedTopicEmbeddings(input.channelArn, input.classification);
  } catch (err) {
    console.warn('[drift] subject lookup failed; comparing against the summary alone:', err);
  }
  emitDriftTiming('summary_fetch', Date.now() - tSummaryStart, correlationId, emfOpts);

  const anchors = summaryEmbedding ? [summaryEmbedding, ...subjects] : subjects;
  if (anchors.length === 0) {
    // Nothing to compare against: the conversation's first turn, before its seed is written.
    emitDriftCounter('drift_skipped_no_summary', correlationId, emfOpts);
    emitDriftTiming('total', Date.now() - tStart, correlationId, emfOpts);
    return baseResult;
  }

  // Embed the latest message (Bedrock Titan v2 call with hard timeout).
  const tEmbedStart = Date.now();
  let messageEmbedding: number[] | null = null;
  try {
    messageEmbedding = await embedText(text, { timeoutMs: EMBEDDING_TIMEOUT_LIVE_MS });
  } catch (err) {
    console.warn('[drift] message embedding failed:', err);
  }
  emitDriftTiming('message_embed', Date.now() - tEmbedStart, correlationId, emfOpts);

  if (!messageEmbedding) {
    // Embedding failure. Per spec: skip the signal, do NOT fall back to
    // substring/keyword. The next message gets another shot.
    emitDriftCounter('drift_skipped_unavailable', correlationId, emfOpts);
    emitDriftTiming('total', Date.now() - tStart, correlationId, emfOpts);
    return { ...baseResult, signalAvailable: false };
  }

  // The nearest anchor decides. Computed in-process: every vector is already in memory.
  const tCmpStart = Date.now();
  let distance = Number.POSITIVE_INFINITY;
  for (const anchor of anchors) {
    const d = cosineDistance(messageEmbedding, anchor);
    if (Number.isFinite(d) && d < distance) distance = d;
  }
  emitDriftTiming('comparison', Date.now() - tCmpStart, correlationId, emfOpts);

  if (!(distance > DRIFT_DISTANCE_THRESHOLD)) {
    emitDriftCounter('drift_skipped_known_topic', correlationId, emfOpts);
    emitDriftTiming('total', Date.now() - tStart, correlationId, emfOpts);
    return { ...baseResult, driftScore: Number.isFinite(distance) ? distance : NaN };
  }

  emitDriftCounter('drift_fired', correlationId, emfOpts);

  // The offer's embedding, kept so a decline can adopt it. Best-effort: losing it costs only the
  // adoption of this one topic, never the offer itself.
  if (input.retainOfferEmbedding) {
    try {
      await storeOfferedTopicEmbedding({
        channelArn: input.channelArn,
        correlationId,
        embedding: messageEmbedding,
        classification: input.classification,
      });
    } catch (err) {
      console.warn('[drift] could not keep the offered topic embedding (non-fatal):', err);
    }
  }

  // Confidence is derived from how far past the threshold we are.
  const margin = distance - DRIFT_DISTANCE_THRESHOLD;
  // Bands over the range left above the threshold (distance tops out near 1), not fixed widths.
  const headroom = Math.max(1 - DRIFT_DISTANCE_THRESHOLD, 0.01);
  const confidence: DriftResult['confidence'] = margin < headroom / 3 ? 'low' : margin < (2 * headroom) / 3 ? 'medium' : 'high';

  // Question 3 deferred to the caller, which resolves the scope only now that it is needed.
  if (input.deferRelatedLookup) {
    emitDriftTiming('total', Date.now() - tStart, correlationId, emfOpts);
    return {
      ...baseResult,
      isDrift: true,
      driftScore: distance,
      suggestedAction: 'confirm',
      confidence,
      suggestionTemplate: SUGGESTION_CONFIRM_TEMPLATE,
      relatedLookupPending: { messageEmbedding },
    };
  }

  // Related-conversation lookup. May upgrade `confirm` → `redirect` if an
  // existing channel matches well enough.
  const tRelStart = Date.now();
  let rivalConversationArn: string | undefined;
  try {
    rivalConversationArn = await findRelatedConversation({
      currentChannelArn: input.channelArn,
      messageEmbedding,
      scopedChannelArns: input.scopedChannelArns,
      classification: input.classification,
    });
  } catch (err) {
    console.warn('[drift] related-conversation lookup failed:', err);
  }
  emitDriftTiming('related_conv_lookup', Date.now() - tRelStart, correlationId, emfOpts);

  const total = Date.now() - tStart;
  emitDriftTiming('total', total, correlationId, emfOpts);

  if (rivalConversationArn) {
    return {
      ...baseResult,
      isDrift: true,
      driftScore: distance,
      suggestedAction: 'redirect',
      confidence,
      suggestionTemplate: SUGGESTION_REDIRECT_TEMPLATE,
      rivalConversationArn,
    };
  }

  return {
    ...baseResult,
    isDrift: true,
    driftScore: distance,
    suggestedAction: 'confirm',
    confidence,
    suggestionTemplate: SUGGESTION_CONFIRM_TEMPLATE,
  };
}

// ---------------------------------------------------------------------------
// Public: recordDriftFire — write a drift_events row at fire time
// ---------------------------------------------------------------------------

export interface RecordDriftInput {
  result: DriftResult;
  channelArn: string;
  messageId: string;
  personId?: string;
  intent: Intent;
  /**
   * Which path produced this row, and it is REQUIRED because the two mean different things.
   *
   * 'live'     - a suggestion was shown to the user, who can accept or decline it. An OFFER.
   * 'archival' - post-hoc scoring of an archived message. Nothing was shown to anyone.
   *
   * Every question about user response ("did they accept?") is answerable only over 'live'
   * rows: archival rows have nobody to accept them, never settle, and would silently deflate
   * any acceptance rate they were counted in. See migration 016.
   */
  source: 'live' | 'archival';
}

export async function recordDriftFire(input: RecordDriftInput): Promise<string> {
  const { result, channelArn, messageId, personId, intent, source } = input;
  // A MOVE REJECTED WHERE IT LANDED (migration 077). When a live offer fires in a conversation that was
  // created by accepting one, and that move is not yet settled, the person moved and at once raised another
  // subject there: the parent offer is `rejected_in_new_channel`. In the same statement as the flag, so the
  // turn pays no extra round trip.
  const rows = await query<{ event_id: string }>(
    `WITH rejected AS (
       UPDATE drift_events
          SET outcome = 'rejected_in_new_channel', outcome_at = NOW(), engagement_settled = TRUE
        WHERE new_channel_arn = $2
          AND outcome = 'accepted'
          AND engagement_settled = FALSE
          AND $10::text = 'live'
     )
     INSERT INTO drift_events (
       outcome, cosine_distance, parent_channel_arn, rival_conversation_arn,
       person_id, originating_message_id, intent, confidence, correlation_id,
       created_via_explicit_intent, source
     ) VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING event_id`,
    [
      Number.isFinite(result.driftScore) ? result.driftScore : null,
      channelArn,
      result.rivalConversationArn || null,
      personId || null,
      messageId,
      intent,
      result.confidence,
      result.correlationId,
      Boolean(result.viaExplicitIntent),
      source,
    ],
  );
  return rows.rows[0].event_id;
}

/**
 * Update an existing drift_events row with the outcome the user chose
 * (declined / accepted / rejected_in_new_channel). The 'abandoned' outcome
 * is written by the scheduled abandonment-detector Lambda.
 */
export async function recordDriftOutcome(input: {
  eventId: string;
  outcome: 'declined' | 'rejected_in_new_channel' | 'accepted';
  newChannelArn?: string;
}): Promise<void> {
  // WHEN IT WAS DECIDED (migration 077), and a decline is final at once. An acceptance is a move whose
  // engagement the abandonment detector still checks, so it stays unsettled.
  //
  // SETTLED IS ITS OWN PARAMETER. Reusing `$1` for the comparison made Postgres deduce two types for one
  // parameter (`varchar(32)` from the column, `text` from the literal), and it refuses the statement
  // with "inconsistent types deduced for parameter $1". The router swallows the failure, so no outcome
  // was ever recorded.
  await query(
    `UPDATE drift_events
       SET outcome = $1,
           new_channel_arn = COALESCE($2, new_channel_arn),
           outcome_at = NOW(),
           engagement_settled = $4
     WHERE event_id = $3`,
    [input.outcome, input.newChannelArn || null, input.eventId, input.outcome !== 'accepted'],
  );
}

/**
 * Latest running summary text for a channel (ADR-017: summary as consumable
 * context). The scheduled summary updater only writes a row once a conversation
 * has grown past the recent-history window, so a non-null result IS the "this
 * conversation is long enough to need its earlier thread" signal. Returns null
 * for short/unsummarized conversations.
 */
export async function getLatestSummary(channelArn: string): Promise<string | null> {
  const result = await query<{ summary: string | null }>(
    `SELECT summary
       FROM conversation_summaries
      WHERE channel_arn = $1
      ORDER BY version DESC
      LIMIT 1`,
    [channelArn],
  );
  return result.rows[0]?.summary ?? null;
}

// ---------------------------------------------------------------------------
// Public: adoptOfferedTopic - a declined offer's subject becomes a topic of the conversation
// ---------------------------------------------------------------------------

/**
 * Make the subject of a declined drift offer one of this conversation's topics.
 *
 * Declining to split a subject out is the person saying it belongs here, so a later message about it
 * must not be offered as drift again - for the life of the conversation, not for a window.
 *
 * Returns whether a topic was adopted. False is not an error: the offer may predate migration 044, the
 * fire may have failed to keep its embedding, or the offer was already adopted by a redelivered turn.
 */
export async function adoptOfferedTopic(input: {
  channelArn: string;
  correlationId: string;
}): Promise<{ adopted: boolean }> {
  if (!input?.channelArn || !input?.correlationId) return { adopted: false };
  const result = await withWriterRole((client) => client.query(
    `UPDATE conversation_topic_embeddings
        SET status = 'adopted', adopted_at = NOW()
      WHERE channel_arn = $1 AND topic_key = $2 AND status = 'offered'`,
    [input.channelArn, offerTopicKey(input.correlationId)],
  ));
  return { adopted: (result.rowCount ?? 0) > 0 };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The topic key a drift offer's embedding is stored under. */
function offerTopicKey(correlationId: string): string {
  return `drift:${correlationId}`;
}

async function storeOfferedTopicEmbedding(input: {
  channelArn: string;
  correlationId: string;
  embedding: number[];
  classification: string;
}): Promise<void> {
  // ADR-028: written as the writer role and stamped with the channel's classification, so the row is
  // readable only by roles whose ladder includes it. ON CONFLICT DO NOTHING: a redelivered turn that
  // fires the same offer must not reset a topic that has already been adopted.
  await withWriterRole((client) => client.query(
    `INSERT INTO conversation_topic_embeddings
       (channel_arn, topic_key, origin, status, embedding, classification)
     VALUES ($1, $2, 'drift_offer', 'offered', $3::vector, $4)
     ON CONFLICT (channel_arn, topic_key) DO NOTHING`,
    [input.channelArn, offerTopicKey(input.correlationId), `[${input.embedding.join(',')}]`, input.classification],
  ));
}

async function loadAdoptedTopicEmbeddings(channelArn: string, classification: string): Promise<number[][]> {
  // Read as the channel's reader role, like the summary anchor: the rows are this channel's own, so the
  // role narrows nothing in the normal case and hides a row whose classification is not what it should be.
  // ANYTHING THAT IS NOT A PENDING OFFER IS A SUBJECT OF THIS CONVERSATION (FR5).
  //
  // This read `status = 'adopted'`, which was the whole of the truth while the only rows were declined
  // offers. The summarizer now writes its `topics[]` as `established` rows (migration 067), and those
  // are subjects by the plainest reading - the conversation is about them - so an equality on
  // `adopted` would have silently ignored every one of them and left FR5 "Partly" with the writer
  // built.
  //
  // Stated as "not `offered`" rather than a list of the two accepted values, because that IS the rule:
  // a row is a subject unless it is a proposal still waiting on an answer. A new status added later is
  // then included by default, which is the safe direction here - more subjects means more suppression,
  // and the spec records continuity as the cheaper failure (section 366).
  const result = await withReaderRole(classification, (client) => client.query<{ embedding_text: string }>(
    `SELECT embedding::text AS embedding_text
       FROM conversation_topic_embeddings
      WHERE channel_arn = $1 AND status <> 'offered'`,
    [channelArn],
  ));
  return result.rows
    .map((row) => (row.embedding_text ? parsePgVector(row.embedding_text) : []))
    .filter((vector) => vector.length > 0);
}

async function loadSummaryEmbedding(
  channelArn: string,
  classification: string,
): Promise<{ embedding: number[] | null; fromVersion: number; generatedBy: string } | null> {
  // pgvector returns the embedding as a string like "[0.1,0.2,...]".
  // We cast to text and parse rather than relying on a pgvector node driver.
  //
  // ADR-028: read as this channel's reader role. This is the channel's OWN anchor, so its row sits at
  // this very classification and is in scope by construction - the role changes nothing here in the
  // normal case. It matters when the row is NOT what it should be: a summary stamped fail-closed to
  // the most restrictive value (because the Chime-sourced classification never arrived) becomes
  // invisible to every channel whose classification does not reach it, and drift skips rather than comparing against an
  // anchor whose provenance is unknown.
  // WHO WROTE THE SUMMARY comes back with it, in the same round trip. The caller's decision is about
  // whether this anchor is a topic or a single message, and the version alone cannot answer that: a
  // conversation SPLIT OUT of another one has its topic before its first message, and is seeded at
  // version 1 from that topic. `generated_by` separates the two version-1 cases; the join is on the
  // exact version the embedding was built from, so it describes THAT summary and not a later one.
  // READ FROM THE ANCHOR ALONE, AND THE JOIN THAT WAS HERE IS THE REASON.
  //
  // This ran as the channel's reader role and joined `conversation_summaries` for `generated_by`.
  // Reader roles hold SELECT on the three BOUNDED tables only, and that is not one of them, so the
  // whole statement was refused - `permission denied for table conversation_summaries` - and the
  // caller's catch turned a refusal into a null anchor. Drift then compared against nothing and
  // reported no drift, which is indistinguishable from a conversation that has not changed subject.
  //
  // It cannot be fixed by widening the grant: `conversation_summaries` carries no classification, so
  // RLS has nothing to scope it by and every reader would see every classification's summary text.
  // The provenance moved onto the anchor instead (migration 065), which is already classification-
  // keyed and already bounded.
  const result = await withReaderRole(classification, (client) => client.query<{
    embedding_text: string | null;
    embedded_from_version: number | null;
    generated_by: string | null;
  }>(
    `SELECT se.embedding::text AS embedding_text,
            se.embedded_from_version,
            se.generated_by
       FROM summary_embeddings se
      WHERE se.channel_arn = $1`,
    [channelArn],
  ));
  const row = result.rows[0];
  const text = row?.embedding_text;
  if (!text) return null;
  return {
    embedding: parsePgVector(text),
    fromVersion: Number(row?.embedded_from_version ?? 0),
    // An anchor whose summary row cannot be read is treated as the thin case. The alternative is
    // firing on an anchor of unknown provenance, which is the failure this gate exists to stop.
    generatedBy: row?.generated_by ?? 'summary-seed',
  };
}

export interface ResolveDriftRivalInput {
  /** The result `detectDrift` returned with `relatedLookupPending` set. */
  result: DriftResult;
  channelArn: string;
  messageEmbedding: number[];
  /** Resolved live by the caller, at the moment of use (see `deferRelatedLookup`). */
  scopedChannelArns?: string[];
  /** Selects the reader role, exactly as in `detectDrift` (ADR-028). */
  classification: string;
  userClearance?: Classification;
  intent?: Intent;
}

/**
 * Question 3 on its own: is the subject this turn moved to already a conversation the room can open?
 *
 * The second half of a deferred `detectDrift`. Upgrades `confirm` to `redirect` when a scoped
 * conversation is close enough, and otherwise returns the offer unchanged. Never returns the pending
 * embedding, so the result can be logged and stored like any other.
 */
export async function resolveDriftRival(input: ResolveDriftRivalInput): Promise<DriftResult> {
  if (!profiles.isKnownClassification(input?.classification)) {
    throw new Error(
      `[drift] classification is required and must be declared by this deployment; got `
      + `${JSON.stringify(input?.classification)}.`,
    );
  }
  const { relatedLookupPending: _pending, ...offer } = input.result;
  const tRelStart = Date.now();
  let rivalConversationArn: string | undefined;
  try {
    rivalConversationArn = await findRelatedConversation({
      currentChannelArn: input.channelArn,
      messageEmbedding: input.messageEmbedding,
      scopedChannelArns: input.scopedChannelArns,
      classification: input.classification,
    });
  } catch (err) {
    console.warn('[drift] related-conversation lookup failed:', err);
  }
  emitDriftTiming('related_conv_lookup', Date.now() - tRelStart, offer.correlationId, {
    userClearance: input.userClearance, intent: input.intent,
  });
  if (!rivalConversationArn) return offer;
  return {
    ...offer,
    suggestedAction: 'redirect',
    suggestionTemplate: SUGGESTION_REDIRECT_TEMPLATE,
    rivalConversationArn,
  };
}

// `embedText` moved to `embed-text.ts` byte-for-byte, with the timeout as its argument. It stays
// SILENT on failure here - no `label` is passed - because this runs inside a live turn and the caller
// already records the skip through its own metric; a warning per slow Titan call would be noise on a
// path that is designed to degrade.

interface FindRelatedInput {
  currentChannelArn: string;
  messageEmbedding: number[];
  scopedChannelArns?: string[];
  classification: string;
}

async function findRelatedConversation(input: FindRelatedInput): Promise<string | undefined> {
  // Scoping (security + privacy): intersection of all human channel members' memberships in the
  // current channel. Enforced INSIDE the WHERE clause — pgvector ranks within the scoped set, not on
  // the full table with a post-filter. See SPEC-DRIFT-CONVERGENCE.md "Scoping (Security + Privacy)".
  //
  // The set arrives from the caller, resolved live from Amazon Chime SDK Messaging. No scope means no
  // suggestion: the archive is NOT consulted as a fallback, because a lagging copy widens the scope
  // beyond the people actually in the conversation — which is the disclosure this control prevents.
  const scopedArns = input.scopedChannelArns;
  if (!scopedArns || scopedArns.length === 0) return undefined;

  // Exclude the current channel itself from the scope (it would always be
  // the nearest neighbor to its own summary).
  const candidateArns = scopedArns.filter((arn) => arn !== input.currentChannelArn);
  if (candidateArns.length === 0) return undefined;

  // ADR-028: TWO independent bounds now, and they restrict different things. The ARN list above is
  // MEMBERSHIP - who is in the room, resolved live from Chime. The reader role here is
  // CLASSIFICATION - what this channel is permitted to surface. Membership alone let a basic channel
  // point at a premium one whenever the members happened to hold premium elsewhere; classification
  // alone would ignore who is actually present. Neither subsumes the other, so both are applied.
  // THE SAME ANCHORS AS THE DRIFT CHECK: a conversation is near the message when its summary OR any of its
  // subjects is. Matching the summary alone missed a conversation whose summary is about something broader
  // than the one subject the message names. A pending offer (`offered`) is not yet a subject, as in step 6b.
  const vectorLiteral = `[${input.messageEmbedding.join(',')}]`;
  const result = await withReaderRole(input.classification, (client) => client.query<{ channel_arn: string; similarity: number }>(
    `SELECT channel_arn, 1 - MIN(distance) AS similarity
       FROM (
         SELECT channel_arn, embedding <=> $1::vector AS distance
           FROM summary_embeddings
          WHERE channel_arn = ANY($2::text[])
         UNION ALL
         SELECT channel_arn, embedding <=> $1::vector AS distance
           FROM conversation_topic_embeddings
          WHERE channel_arn = ANY($2::text[]) AND status <> 'offered'
       ) anchors
      GROUP BY channel_arn
      ORDER BY MIN(distance)
      LIMIT 1`,
    [vectorLiteral, candidateArns],
  ));
  const top = result.rows[0];
  if (!top) return undefined;
  if (top.similarity < REROUTE_SIMILARITY_THRESHOLD) return undefined;
  return top.channel_arn;
}

function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) return NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return NaN;
  const sim = dot / denom;
  return 1 - sim;
}

function parsePgVector(text: string): number[] {
  // Format: "[0.1,0.2,0.3,...]"
  const trimmed = text.replace(/^\[/, '').replace(/\]$/, '');
  if (!trimmed) return [];
  return trimmed.split(',').map((s) => Number(s));
}
