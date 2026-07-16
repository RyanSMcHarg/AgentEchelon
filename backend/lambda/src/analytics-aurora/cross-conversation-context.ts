/**
 * Cross-Conversation Context Module
 *
 * For a given user, finds related prior conversations to inject as context
 * into the current conversation. Supports both keyword matching and
 * pgvector similarity search when embeddings are available.
 */

import { query } from './db-client.js';

export interface ConversationContext {
  channelArn: string;
  topic: string;
  summary: string;
  relevanceScore: number;
  lastActivity: Date;
}

/**
 * Find related prior conversations for a user.
 *
 * Strategy:
 * 1. If pgvector embeddings exist, use cosine similarity search
 * 2. Otherwise, fall back to keyword matching on topic and summary fields
 *
 * @param userSub - The user's Cognito sub
 * @param currentTopic - The current conversation topic for relevance ranking
 * @param limit - Maximum number of results (default 5)
 */
export async function findRelatedConversations(
  userSub: string,
  currentTopic: string,
  limit: number = 5
): Promise<ConversationContext[]> {
  // Check if embeddings table has data for vector search
  const embeddingsCheck = await query<{ count: string }>(
    `SELECT COUNT(*)::text as count FROM embeddings
     WHERE source_type = 'conversation_context' LIMIT 1`
  ).catch(() => ({ rows: [{ count: '0' }] }));

  const hasEmbeddings = parseInt(embeddingsCheck.rows[0]?.count || '0', 10) > 0;

  if (hasEmbeddings) {
    return findRelatedByEmbedding(userSub, currentTopic, limit);
  }

  return findRelatedByKeyword(userSub, currentTopic, limit);
}

/**
 * Find related conversations using keyword matching on topic and summary.
 */
async function findRelatedByKeyword(
  userSub: string,
  currentTopic: string,
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
    const result = await query<{
      channel_arn: string;
      topic: string;
      summary: string;
      relevance_score: string;
      updated_at: string;
    }>(
      `SELECT channel_arn, topic, summary, relevance_score::text, updated_at
       FROM cross_conversation_context
       WHERE user_sub = $1
       ORDER BY updated_at DESC
       LIMIT $2`,
      [userSub, limit]
    );

    return result.rows.map(mapRow);
  }

  // Build a query that scores by keyword overlap
  const likeConditions = keywords
    .map((_, i) => `(LOWER(ccc.topic) LIKE $${i + 3} OR LOWER(ccc.summary) LIKE $${i + 3})`)
    .join(' OR ');

  const likeParams = keywords.map((k) => `%${k}%`);

  const result = await query<{
    channel_arn: string;
    topic: string;
    summary: string;
    relevance_score: string;
    updated_at: string;
    match_count: string;
  }>(
    `SELECT
       ccc.channel_arn,
       ccc.topic,
       ccc.summary,
       ccc.relevance_score::text,
       ccc.updated_at,
       (${keywords
         .map(
           (_, i) =>
             `CASE WHEN (LOWER(ccc.topic) LIKE $${i + 3} OR LOWER(ccc.summary) LIKE $${i + 3}) THEN 1 ELSE 0 END`
         )
         .join(' + ')})::text as match_count
     FROM cross_conversation_context ccc
     WHERE ccc.user_sub = $1
       AND (${likeConditions})
     ORDER BY match_count DESC, ccc.updated_at DESC
     LIMIT $2`,
    [userSub, limit, ...likeParams]
  );

  return result.rows.map(mapRow);
}

/**
 * Find related conversations using pgvector cosine similarity.
 * Requires embeddings to be populated for conversation contexts.
 */
async function findRelatedByEmbedding(
  userSub: string,
  currentTopic: string,
  limit: number
): Promise<ConversationContext[]> {
  // For pgvector search, we need an embedding of the current topic.
  // If we do not have one, fall back to keyword search.
  // In a full implementation, we would call Bedrock/Titan for embedding.
  // For now, fall back to keyword matching.
  return findRelatedByKeyword(userSub, currentTopic, limit);
}

/**
 * Update or insert conversation context for a user.
 * Called after conversations are summarized.
 */
export async function updateConversationContext(
  userSub: string,
  channelArn: string,
  topic: string,
  summary: string
): Promise<void> {
  await query(
    `INSERT INTO cross_conversation_context (user_sub, channel_arn, topic, summary)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_sub, channel_arn) DO UPDATE SET
       topic = EXCLUDED.topic,
       summary = EXCLUDED.summary,
       updated_at = NOW()`,
    [userSub, channelArn, topic, summary]
  );
}

/**
 * Map a database row to ConversationContext
 */
function mapRow(row: {
  channel_arn: string;
  topic: string;
  summary: string;
  relevance_score: string;
  updated_at: string;
}): ConversationContext {
  return {
    channelArn: row.channel_arn,
    topic: row.topic || '',
    summary: row.summary || '',
    relevanceScore: parseFloat(row.relevance_score) || 0,
    lastActivity: new Date(row.updated_at),
  };
}
