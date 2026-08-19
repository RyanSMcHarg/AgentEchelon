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

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { query } from './db-client.js';
import { withReaderRole } from './classification-boundary.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry.js';
import {
  emitDriftTiming,
  emitDriftCounter,
  newCorrelationId,
} from '../lib/emf-metrics.js';
import { detectExplicitRoutingRequest } from '../lib/explicit-routing.js';

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
  messageId: string;
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
  userClearance?: 'basic' | 'standard' | 'premium';
  /**
   * Set of `(distance ± 0.05)` cosine values the user has recently declined.
   * When the current distance falls inside any band, drift is suppressed.
   * The live drift flow (`lib/live-drift-flow.ts`, reached from the router) reads
   * these out of `routingState` and passes them in.
   */
  declinedDistances?: number[];
  /**
   * True when this channel has a LIVE task (status pending/in_progress) for this user.
   *
   * A live task means the assistant is mid-workflow and has asked the user for something -
   * requirements, an outline approval, symptoms. The user's turn is then an ANSWER, and an
   * answer is a continuation of the thread, not a pivot away from it. The cosine signal
   * cannot see that: an answer is often a short fragment ("Audience is engineering
   * leadership. Focus on delivery velocity and CI cost.") carrying none of the topic words
   * the summary embedding was built from, so it lands far from the summary and fires drift
   * on the one turn the assistant explicitly solicited.
   *
   * Suppression applies to the COSINE path only. The explicit-routing fast-path is checked
   * first and still fires, so a user who deliberately asks for a new conversation mid-task
   * still gets one.
   */
  activeTaskInProgress?: boolean;
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
  suggestionTemplate?: string;
  rivalConversationArn?: string;
  /** Internal — true iff the explicit-routing fast-path matched, never cosine. */
  viaExplicitIntent?: boolean;
  /** Internal — set when viaExplicitIntent is true. */
  explicitTopicHint?: string;
}

// ---------------------------------------------------------------------------
// Config (env-tunable; sensible defaults per spec)
// ---------------------------------------------------------------------------

const EMBEDDING_MODEL_ID = process.env.DRIFT_EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v2:0';
const EMBEDDING_DIM = 1024;
const EMBEDDING_TIMEOUT_MS = 500;
const DRIFT_DISTANCE_THRESHOLD = Number(process.env.DRIFT_DISTANCE_THRESHOLD || '0.35');
const REROUTE_SIMILARITY_THRESHOLD = Number(process.env.DRIFT_REROUTE_THRESHOLD || '0.80');
const DECLINED_DISTANCE_BAND = 0.05;

const SUGGESTION_CONFIRM_TEMPLATE =
  "It looks like you're shifting topics. Want me to start a separate conversation for this so we keep both threads clean? Reply 'yes' to create one, or anything else to keep going here.";
const SUGGESTION_REDIRECT_TEMPLATE =
  "It looks like you're shifting to something we covered in another conversation. Want me to take you there? Reply 'yes' to switch, or 'no' to keep going here.";

// ---------------------------------------------------------------------------
// Bedrock client (module-singleton; reused across warm invocations)
// ---------------------------------------------------------------------------

const bedrockClient = new BedrockRuntimeClient({});

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

  // Skip: the assistant is mid-task and asked this user for something, so this turn is an
  // ANSWER. Checked AFTER the explicit-routing fast-path (a deliberate "start a new
  // conversation about X" still routes) and BEFORE the summary fetch + embed, so a suppressed
  // turn also costs no Bedrock call. See `activeTaskInProgress` for why cosine mis-reads answers.
  if (input.activeTaskInProgress) {
    emitDriftCounter('drift_skipped_active_task', correlationId, emfOpts);
    emitDriftTiming('total', Date.now() - tStart, correlationId, emfOpts);
    return baseResult;
  }

  // Fetch summary embedding (PK lookup; fast).
  const tSummaryStart = Date.now();
  let summaryEmbedding: number[] | null = null;
  try {
    summaryEmbedding = await loadSummaryEmbedding(input.channelArn, input.classification);
  } catch (err) {
    console.warn('[drift] summary_embeddings lookup failed:', err);
  }
  emitDriftTiming('summary_fetch', Date.now() - tSummaryStart, correlationId, emfOpts);

  if (!summaryEmbedding) {
    // No anchor to compare against. Either the conversation is brand-new,
    // or the embedding-writer hasn't caught up. In either case: skip the
    // signal. Lazy-compute is a future optimization — for now, we trust
    // the writer to land within seconds of summary updates.
    emitDriftCounter('drift_skipped_no_summary', correlationId, emfOpts);
    emitDriftTiming('total', Date.now() - tStart, correlationId, emfOpts);
    return baseResult;
  }

  // Embed the latest message (Bedrock Titan v2 call with hard timeout).
  const tEmbedStart = Date.now();
  let messageEmbedding: number[] | null = null;
  try {
    messageEmbedding = await embedText(text);
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

  // Compute cosine distance in-process — both vectors are already in memory.
  // (The cosine-NN related-conversation lookup uses pgvector since it ranks
  // many candidates; the single message-vs-summary comparison is cheaper here.)
  const tCmpStart = Date.now();
  const distance = cosineDistance(messageEmbedding, summaryEmbedding);
  emitDriftTiming('comparison', Date.now() - tCmpStart, correlationId, emfOpts);

  // Decline-suppression: if the distance is inside a previously-declined
  // band, suppress the suggestion. The user has already said no in this
  // neighborhood recently.
  if (input.declinedDistances && input.declinedDistances.length > 0) {
    for (const declined of input.declinedDistances) {
      if (Math.abs(distance - declined) <= DECLINED_DISTANCE_BAND) {
        emitDriftCounter('drift_skipped_declined_neighborhood', correlationId, emfOpts);
        emitDriftTiming('total', Date.now() - tStart, correlationId, emfOpts);
        return { ...baseResult, driftScore: distance };
      }
    }
  }

  // Threshold check.
  const isDrift = distance > DRIFT_DISTANCE_THRESHOLD;
  if (!isDrift) {
    emitDriftTiming('total', Date.now() - tStart, correlationId, emfOpts);
    return { ...baseResult, driftScore: distance };
  }

  emitDriftCounter('drift_fired', correlationId, emfOpts);

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

  // Confidence is derived from how far past the threshold we are.
  const margin = distance - DRIFT_DISTANCE_THRESHOLD;
  const confidence: DriftResult['confidence'] = margin < 0.1 ? 'low' : margin < 0.2 ? 'medium' : 'high';

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
  userSub?: string;
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
  const { result, channelArn, messageId, userSub, intent, source } = input;
  const rows = await query<{ event_id: string }>(
    `INSERT INTO drift_events (
       outcome, cosine_distance, parent_channel_arn, rival_conversation_arn,
       user_sub, originating_message_id, intent, confidence, correlation_id,
       created_via_explicit_intent, source
     ) VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING event_id`,
    [
      Number.isFinite(result.driftScore) ? result.driftScore : null,
      channelArn,
      result.rivalConversationArn || null,
      userSub || null,
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
  await query(
    `UPDATE drift_events
       SET outcome = $1,
           new_channel_arn = COALESCE($2, new_channel_arn)
     WHERE event_id = $3`,
    [input.outcome, input.newChannelArn || null, input.eventId],
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
// Internals
// ---------------------------------------------------------------------------

async function loadSummaryEmbedding(channelArn: string, classification: string): Promise<number[] | null> {
  // pgvector returns the embedding as a string like "[0.1,0.2,...]".
  // We cast to text and parse rather than relying on a pgvector node driver.
  //
  // ADR-028: read as this channel's reader role. This is the channel's OWN anchor, so its row sits at
  // this very classification and is in scope by construction - the role changes nothing here in the
  // normal case. It matters when the row is NOT what it should be: a summary stamped fail-closed to
  // the most restrictive value (because the Chime-sourced classification never arrived) becomes
  // invisible to a lower-classification channel, and drift skips rather than comparing against an
  // anchor whose provenance is unknown.
  const result = await withReaderRole(classification, (client) => client.query<{ embedding_text: string | null }>(
    `SELECT embedding::text AS embedding_text
       FROM summary_embeddings
      WHERE channel_arn = $1`,
    [channelArn],
  ));
  const text = result.rows[0]?.embedding_text;
  if (!text) return null;
  return parsePgVector(text);
}

async function embedText(text: string): Promise<number[] | null> {
  // Truncate to the model's input cap; Titan v2 takes up to ~8k tokens
  // but we don't need anywhere near that for a single chat message.
  const input = text.slice(0, 8000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

  try {
    const response = await bedrockClient.send(
      new InvokeModelCommand({
        modelId: EMBEDDING_MODEL_ID,
        body: JSON.stringify({ inputText: input, dimensions: EMBEDDING_DIM, normalize: true }),
        contentType: 'application/json',
        accept: 'application/json',
      }),
      { abortSignal: controller.signal },
    );
    clearTimeout(timer);

    const body = JSON.parse(new TextDecoder().decode(response.body));
    const embedding = body?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
      return null;
    }
    return embedding as number[];
  } catch {
    clearTimeout(timer);
    return null;
  }
}

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
  const vectorLiteral = `[${input.messageEmbedding.join(',')}]`;
  const result = await withReaderRole(input.classification, (client) => client.query<{ channel_arn: string; similarity: number }>(
    `SELECT channel_arn,
            1 - (embedding <=> $1::vector) AS similarity
       FROM summary_embeddings
      WHERE channel_arn = ANY($2::text[])
      ORDER BY embedding <=> $1::vector
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
