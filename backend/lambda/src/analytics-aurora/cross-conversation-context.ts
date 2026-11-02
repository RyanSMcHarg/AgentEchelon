/**
 * Cross-Conversation Context Module
 *
 * For a given user, finds related prior conversations to inject as context
 * into the current conversation. Supports both keyword matching and
 * pgvector similarity search when embeddings are available.
 *
 * ── THE WRITE IS LIVE. THE READ IS NOT. READ THIS BEFORE BUILDING ON IT. ─────────────────────
 * `updateConversationContext` IS CALLED ON THE ARCHIVAL PATH - `kinesis-archival.ts:30` imports it and
 * `:2544` calls it per conversation - so `cross_conversation_context` is written continuously in
 * service, and it has been since before this header was written.
 *
 * THIS PARAGRAPH PREVIOUSLY SAID THE OPPOSITE: that neither export had a caller, that the table was
 * NEVER WRITTEN, and that its reader returned empty by construction. It is called out rather than
 * quietly corrected because the wrong version is the more dangerous artifact - a header titled "read
 * this before building on it", telling a reader an accumulating table of user content is empty.
 *
 * What IS unwired is the READ: `findRelatedConversations` has no caller in `lambda/src`, so nothing
 * injects these rows into a prompt. The admin endpoint `GET /analytics/context` does read the table,
 * under `view-events`.
 *
 * ── A ROW HOLDS A REFERENCE, NEVER A COPY OF WHAT SOMEBODY SAID (migration 068) ─────────────────
 *
 * This table used to store the latest user message verbatim - its first 100 characters as `topic` and
 * its first 500 as `summary`. That was a second copy of a message, and a copy is precisely what the
 * redaction mechanism cannot reach: `-RED` and `-DEL` sibling rows resolve at READ time, which works
 * for a derived view of a message and not for a duplicate of one, so a redacted message's text simply
 * stayed here.
 *
 * The columns are gone. A row now records THAT a person has a conversation, WHICH classification it
 * belongs to, and the id of the message that last touched it. Text comes from
 * `conversation_summaries` at read time - the model's own summary and topic labels, in the one place
 * they live - so a redaction or a rewrite is seen by this read the moment it lands, and there is
 * nothing here to chase.
 *
 * The principle this follows: a person's exact words live only in the original message, the Aurora
 * archive and S3. Everywhere else a message is referenced by its id, so redaction stays complete by
 * construction.
 *
 * ── AND IT IS A BOUNDED TABLE ───────────────────────────────────────────────────────────────────
 *
 * `cross_conversation_context` is in `BOUNDED_TABLES` as of 068, so it carries a `classification`
 * column, per-classification reader grants, FORCE ROW LEVEL SECURITY and the scope policy that
 * `embeddings`, `summary_embeddings` and `conversation_topic_embeddings` already had under ADR-028.
 * Holding no message text is not a reason to skip that: "which conversations does this person have"
 * is itself a fact that must not cross a classification boundary, and it is read to decide what an
 * assistant is told about elsewhere. Reads run as the reader role and writes as the writer role, so a
 * statement issued unroled reads nothing rather than everything.
 *
 * The SEAM is the intended one - `drift-reasoning.ts` names `findRelatedConversations` as where the
 * "is this topic already live in another of the user's conversations" check belongs
 * (SPEC-DRIFT-CONVERGENCE decision-flow question 3). The read still has no caller in `lambda/src`.
 */

// NO UNROLED `query` IMPORT. Every statement in this module runs under `withReaderRole` or
// `withWriterRole`; the one bare `query()` that used to live here was the dead vector-gate probe, and
// under FORCE ROW LEVEL SECURITY it could only ever read zero rows. Re-adding the import is the first
// step of putting that bug back, so its absence is the guard.
import { withReaderRole, withWriterRole } from './classification-boundary.js';
import {
  embedText,
  toPgVector,
  EMBEDDING_TIMEOUT_LIVE_MS,
} from './embed-text.js';

/**
 * How close a conversation has to be before it is worth surfacing.
 *
 * LOWER THAN DRIFT'S 0.80, and for a stated reason rather than by accident: drift's threshold decides
 * whether to MOVE a conversation, so a false positive relocates someone mid-thought. This one decides
 * whether to MENTION a prior discussion, where a false positive costs a line the reader ignores. The
 * two numbers answer different questions and should not be folded together.
 *
 * NOT A MEASURED VALUE. It is a starting floor whose only job is to keep unrelated conversations out;
 * tune it on the eval suite rather than on intuition, and record what moved it.
 */
const RELATED_SIMILARITY_FLOOR = Number(process.env.CROSS_CONVERSATION_SIMILARITY_FLOOR || '0.60');

export interface ConversationContext {
  channelArn: string;
  /** The model's own subject labels for that conversation, from `conversation_summaries.topics`. */
  topic: string;
  /** The model's own summary of that conversation, read live. Never a stored copy of a message. */
  summary: string;
  /** The message this row last recorded. A reference to follow, not content. */
  lastMessageId: string | null;
  relevanceScore: number;
  lastActivity: Date;
}

/**
 * Find related prior conversations, WITHIN A SCOPE THE CALLER HAS ALREADY RESOLVED.
 *
 * ── THE SCOPE IS THE ACCESS CONTROL, AND THIS READ CANNOT ESTABLISH IT ───────────────────────────
 *
 * These rows live in Aurora, where NO Amazon Chime SDK membership check applies. Scoping by
 * `person_id` alone - which is what this did - answers "every conversation this person has ever had",
 * including ones the SERVING ASSISTANT was never added to. `lib/scoped-channels.ts` states the rule
 * and proves it against the live API: the scope is `resolveScopedChannelArns`, the intersection of
 * every current human member of the conversation AND the serving assistant's own ARN.
 *
 * THE ASSISTANT TERM IS WHAT CARRIES THE CLASSIFICATION BOUNDARY, and it does so structurally rather
 * than by a column here. An assistant is bound to one classification (ADR-042) and can only be a
 * member of channels of that classification, so any channel surviving the intersection is one this
 * assistant is already in - same classification, by construction. Without that term, two people who
 * share a basic and a premium channel would let the premium assistant reach the basic one.
 *
 * SO THE SCOPE IS A REQUIRED ARGUMENT, not an optional filter. An empty or absent scope returns
 * NOTHING rather than everything: `resolveScopedChannelArns` already answers `[]` for every case it
 * cannot settle authoritatively - no human members, a room too large for one filter, a failed Chime
 * call - and "suggest nothing" has to survive the trip here. Making it a parameter this function
 * cannot run without is what stops a future caller reintroducing the unscoped read by forgetting it.
 *
 * AND THE CLASSIFICATION IS A REQUIRED ARGUMENT FOR THE SAME REASON. Since migration 068 the table is
 * bounded (ADR-028), so this read runs as that classification's reader role and row-level security
 * refuses anything outside it. The scope argument and the role are deliberately two mechanisms for
 * one boundary: a correct query AND a correct privilege, so either failing alone is survivable.
 *
 * @param personId - The person's AppInstanceUser id
 * @param currentTopic - The current conversation topic for relevance ranking
 * @param scopedChannelArns - From `resolveScopedChannelArns`. Empty means suggest nothing.
 * @param classification - The serving assistant's classification. Its reader role runs the query.
 * @param limit - Maximum number of results (default 5)
 */
export async function findRelatedConversations(
  personId: string,
  currentTopic: string,
  scopedChannelArns: readonly string[],
  classification: string,
  limit: number = 5
): Promise<ConversationContext[]> {
  if (!Array.isArray(scopedChannelArns) || scopedChannelArns.length === 0) {
    console.warn('[CrossConversationContext] no scope resolved; returning nothing (fail closed)');
    return [];
  }
  if (typeof classification !== 'string' || classification.length === 0) {
    // No classification means no reader role to run as, and running as anything else is how a
    // cross-boundary read happens. Refuse rather than pick one.
    console.warn('[CrossConversationContext] no classification supplied; returning nothing (fail closed)');
    return [];
  }
  // ── SEMANTIC FIRST, KEYWORD AS THE FALLBACK (ADR-004 surface 3) ─────────────────────────────────
  //
  // THE SELECTOR IS THE RESULT, NOT A PROBE. This used to ask a separate question first - does the
  // `embeddings` table hold any row with `source_type = 'conversation_context'` - and branch on the
  // answer. That probe was wrong three ways at once and every one of them failed CLOSED, so the
  // vector path could never run and nothing said so:
  //
  //   - wrong TABLE. Conversation vectors live in `summary_embeddings` (migration 005, 1024-dim per
  //     ADR-002), not in the dormant 1536-dim `embeddings` table.
  //   - wrong SOURCE_TYPE. Nothing in the codebase has ever written `'conversation_context'`.
  //   - UNROLED. It used the pooled `query()` while every other read here runs under
  //     `withReaderRole`. Under FORCE ROW LEVEL SECURITY the owner has no policy, so that COUNT
  //     returns zero for every source type regardless - the identical trap `document-ingestion.ts`
  //     documents for its own ingest COUNT.
  //
  // Asking the vector query itself and falling back on an empty result removes all three: there is
  // no second question to get wrong, and the one question that remains runs under the reader role
  // like the rest of this module. The cost of the attempt is one indexed HNSW lookup.
  const semantic = await findRelatedByEmbedding(
    personId, currentTopic, scopedChannelArns, classification, limit,
  );
  if (semantic.length > 0) return semantic;

  return findRelatedByKeyword(personId, currentTopic, scopedChannelArns, classification, limit);
}

/**
 * The latest summary for the row's channel, joined rather than copied.
 *
 * LATERAL AND `version DESC`, because `conversation_summaries` keeps every version of a channel's
 * summary (`UNIQUE(channel_arn, version)`). A plain join would return one row per version and
 * multiply the result set by however many times a conversation has been summarized. LEFT, because a
 * conversation that has not been summarized yet is still a conversation this person has - it simply
 * has no text to match on, and dropping it would make the read quietly disagree with the table.
 */
const LATEST_SUMMARY_JOIN = `LEFT JOIN LATERAL (
       SELECT s.summary, s.topics
       FROM conversation_summaries s
       WHERE s.channel_arn = ccc.channel_arn
       ORDER BY s.version DESC
       LIMIT 1
     ) cs ON TRUE`;

/** The conversation's subject labels as one string, for display and for keyword matching. */
const SUMMARY_TOPIC_EXPR = `COALESCE(array_to_string(cs.topics, ', '), '')`;

/**
 * Find related conversations using keyword matching over the conversation's own summary.
 */
async function findRelatedByKeyword(
  personId: string,
  currentTopic: string,
  scopedChannelArns: readonly string[],
  classification: string,
  limit: number
): Promise<ConversationContext[]> {
  // Extract keywords from current topic for matching
  const keywords = currentTopic
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (keywords.length === 0) {
    // No keywords to match -- return most recent conversations
    const result = await withReaderRole(classification, (client) => client.query<{
      channel_arn: string;
      topic: string;
      summary: string;
      last_message_id: string | null;
      relevance_score: string;
      updated_at: string;
    }>(
      // THE SCOPE IS AN AND, NOT A RANKING HINT. `person_id` alone answers "every conversation this
      // person ever had"; the channel filter is what keeps the answer inside the set this assistant
      // and these people share. See the header on findRelatedConversations.
      `SELECT ccc.channel_arn, ${SUMMARY_TOPIC_EXPR} AS topic, cs.summary,
              ccc.last_message_id, ccc.relevance_score::text, ccc.updated_at
       FROM cross_conversation_context ccc
       ${LATEST_SUMMARY_JOIN}
       WHERE ccc.person_id = $1
         AND ccc.channel_arn = ANY($3)
       ORDER BY ccc.updated_at DESC
       LIMIT $2`,
      [personId, limit, [...scopedChannelArns]]
    ));

    return result.rows.map(mapRow);
  }

  // Build a query that scores by keyword overlap. THE TEXT BEING MATCHED IS THE SUMMARY'S, not a
  // stored copy of a message: migration 068 removed the copy, so the match reads the one place the
  // summary lives and sees a redaction or a rewrite the moment it lands.
  const matched = (i: number) =>
    `(LOWER(COALESCE(cs.summary, '')) LIKE $${i + 3} OR LOWER(${SUMMARY_TOPIC_EXPR}) LIKE $${i + 3})`;
  const likeConditions = keywords.map((_, i) => matched(i)).join(' OR ');

  const likeParams = keywords.map((k) => `%${k}%`);

  const result = await withReaderRole(classification, (client) => client.query<{
    channel_arn: string;
    topic: string;
    summary: string;
    last_message_id: string | null;
    relevance_score: string;
    updated_at: string;
    match_count: string;
  }>(
    `SELECT
       ccc.channel_arn,
       ${SUMMARY_TOPIC_EXPR} AS topic,
       cs.summary,
       ccc.last_message_id,
       ccc.relevance_score::text,
       ccc.updated_at,
       (${keywords.map((_, i) => `CASE WHEN ${matched(i)} THEN 1 ELSE 0 END`).join(' + ')})::text as match_count
     FROM cross_conversation_context ccc
     ${LATEST_SUMMARY_JOIN}
     WHERE ccc.person_id = $1
       AND ccc.channel_arn = ANY($${keywords.length + 3})
       AND (${likeConditions})
     ORDER BY match_count DESC, ccc.updated_at DESC
     LIMIT $2`,
    // The scope goes LAST so the keyword placeholders keep their $3.. numbering. Adding it at $3
    // instead would silently shift every LIKE onto the wrong parameter.
    [personId, limit, ...likeParams, [...scopedChannelArns]]
  ));

  return result.rows.map(mapRow);
}

/**
 * Find related conversations by cosine distance over `summary_embeddings` (ADR-004 surface 3).
 *
 * THE SAME VECTOR SPACE DRIFT ALREADY USES, deliberately. `summary_embeddings` holds one Titan v2
 * 1024-dim row per conversation, written by `embedding-writer` on every `conversation_summaries`
 * version bump, and migration 005 names this lookup as its second consumer. Drift compares a message
 * against one conversation's vector; this ranks a topic against many. One embedding of one fact, two
 * questions asked of it - not two pipelines.
 *
 * BOTH BOUNDS STILL APPLY, and they restrict different things (ADR-028, and the same pairing
 * `drift-detection` states at its own reroute lookup). `scopedChannelArns` is MEMBERSHIP - the
 * channels every current human member of this conversation shares with the serving assistant,
 * resolved live from Amazon Chime SDK by `resolveScopedChannelArns`. The reader role is
 * CLASSIFICATION - what this conversation is permitted to surface at all. Neither subsumes the
 * other: membership alone would let a basic room point at a premium one whenever the people happen
 * to hold premium elsewhere, and classification alone would ignore who is actually present.
 *
 * WHY RETURNING THE SUMMARY IS NOT A LEAK HERE. Every member of this conversation is a member of
 * every channel that survives the intersection, so its summary is text they can already open
 * (SPEC-CONTEXT-SOURCES-AND-STORES: the content is "which channels a set of principals are all
 * members of"). The classification term is what protects the CONVERSATION rather than the people -
 * "membership protects the people; it does not protect the conversation."
 *
 * AN EMPTY RESULT IS THE FALLBACK SIGNAL, not an error. No embedding for the topic (Titan slow or
 * refused), no embedded conversation in scope yet, or nothing above the floor all return `[]`, and
 * the caller then asks the keyword path. That keeps a cold deployment - summaries written but not
 * yet embedded - answering exactly as it did before this landed.
 */
async function findRelatedByEmbedding(
  personId: string,
  currentTopic: string,
  scopedChannelArns: readonly string[],
  classification: string,
  limit: number
): Promise<ConversationContext[]> {
  if (!currentTopic || currentTopic.trim().length === 0) return [];

  // THE LIVE TIMEOUT, because this runs inside somebody's turn. A slow embedding degrades to keyword
  // matching rather than making the person wait for a better ranking.
  const embedding = await embedText(currentTopic, {
    timeoutMs: EMBEDDING_TIMEOUT_LIVE_MS,
    label: 'CrossConversationContext',
  });
  if (!embedding) return [];

  const result = await withReaderRole(classification, (client) => client.query<{
    channel_arn: string;
    topic: string;
    summary: string;
    last_message_id: string | null;
    relevance_score: string;
    updated_at: string;
    similarity: string;
  }>(
    // JOINED TO `cross_conversation_context`, not read from `summary_embeddings` alone. The embedding
    // table is keyed by channel only; `person_id` is what says this person is part of why the row
    // exists, and `last_message_id` is the reference a caller follows. Migration 068 removed the
    // stored summary copy, so the text comes from the one place it lives - a redaction or a rewrite
    // is visible the moment it lands.
    //
    // `se.channel_arn = ANY($4)` AS WELL AS the join, because the index that makes this fast is on
    // `summary_embeddings` and the planner needs the bound on that side to use it.
    `SELECT ccc.channel_arn,
            ${SUMMARY_TOPIC_EXPR} AS topic,
            cs.summary,
            ccc.last_message_id,
            ccc.relevance_score::text,
            ccc.updated_at,
            (1 - (se.embedding <=> $1::vector))::text AS similarity
       FROM summary_embeddings se
       JOIN cross_conversation_context ccc ON ccc.channel_arn = se.channel_arn
       ${LATEST_SUMMARY_JOIN}
      WHERE ccc.person_id = $2
        AND ccc.channel_arn = ANY($4)
        AND se.channel_arn = ANY($4)
        AND (1 - (se.embedding <=> $1::vector)) >= $5
      ORDER BY se.embedding <=> $1::vector
      LIMIT $3`,
    [toPgVector(embedding), personId, limit, [...scopedChannelArns], RELATED_SIMILARITY_FLOOR],
  ));

  return result.rows.map(mapRow);
}

/**
 * Record that a person has a conversation, which classification it belongs to, and the message that
 * last touched it.
 *
 * NO MESSAGE TEXT IS A PARAMETER, which is the point (migration 068). There is nowhere to put it: the
 * `topic` and `summary` columns are dropped, so a caller that meant to store a caption cannot, and
 * the invariant holds without everyone remembering it.
 *
 * Runs as the write role. Under FORCE ROW LEVEL SECURITY the same statement issued unroled reports
 * success and writes nothing, which would present as "this person has no other conversations" rather
 * than as a fault.
 */
export async function updateConversationContext(
  personId: string,
  channelArn: string,
  classification: string,
  lastMessageId: string | null
): Promise<void> {
  await withWriterRole((client) => client.query(
    `INSERT INTO cross_conversation_context (person_id, channel_arn, classification, last_message_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (person_id, channel_arn) DO UPDATE SET
       classification = EXCLUDED.classification,
       last_message_id = EXCLUDED.last_message_id,
       updated_at = NOW()`,
    [personId, channelArn, classification, lastMessageId]
  ));
}

/**
 * Map a database row to ConversationContext
 */
function mapRow(row: {
  channel_arn: string;
  topic: string;
  summary: string;
  last_message_id: string | null;
  relevance_score: string;
  updated_at: string;
}): ConversationContext {
  return {
    channelArn: row.channel_arn,
    topic: row.topic || '',
    summary: row.summary || '',
    lastMessageId: row.last_message_id ?? null,
    relevanceScore: parseFloat(row.relevance_score) || 0,
    lastActivity: new Date(row.updated_at),
  };
}
