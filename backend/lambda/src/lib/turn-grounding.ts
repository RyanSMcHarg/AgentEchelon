/**
 * WHAT THE TURN IS GROUNDED IN: the retrieved chunks and the conversation's running summary.
 *
 * ── WHY IT LIVES HERE AND NOT IN THE ROUTER ──
 *
 * Both of these are data-plane round trips - an embedding call and a database read - and until now
 * both were made by the router, BEFORE it returned the first frame. Every millisecond they cost was
 * inside TTFF, on a turn where nothing about the first frame depends on them: the placeholder says
 * the assistant is working, and the grounding is read by the model call that happens afterwards, in
 * the processor.
 *
 * So the processor fetches its own. It already holds everything the fetch needs - the channel, the
 * classification, the intent and the message - which is the test for whether a step belongs to a
 * component at all. The end-to-end time is unchanged; what moves is WHICH leg pays it, from the one
 * the SLO is about to the one that was always going to run for seconds.
 *
 * The gates are unchanged and stay in one place: no data plane means no grounding, and a greeting or
 * an acknowledgment buys neither - there is nothing to retrieve for "hi", and the summary exists to
 * carry a long conversation's earlier thread into an answer that has one.
 *
 * ONE CONSEQUENCE, ACCEPTED. A turn that is RETRIED - Lambda re-delivering an async invocation - used
 * to read the router's single fetch off the payload for free, and now fetches again. That is two more
 * data-plane calls on a turn that has already failed twice, and it is the right way round: a retry
 * that replays a snapshot answers from what the conversation looked like before the failure, and the
 * summary in particular may have moved. The recovery's own failure announcement fetches nothing at
 * all - it runs no model, so there is nothing for grounding to reach.
 */

import { retrieveContext, getLatestSummary, type RetrieveContextResult } from './data-plane-client.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { IntentType } from './intent-classifier.js';

export type { RetrieveContextResult };

/**
 * Every corpus the turn pre-fetches from, by `source_type`.
 *
 * A source_type is the FIRST PATH SEGMENT under `rag/` (`document-ingestion.ts:deriveSourceType`), so
 * uploading to a new prefix silently mints a new type - and a type absent from this list is embedded,
 * stored, and never retrieved. That is not a hypothetical: `rag/agentechelon/` (the platform's own
 * documentation, ingested by `sync-project-knowledge.mjs --rag`) was fully embedded and returned ZERO
 * chunks on every live query, because this list named only wiki/doc/company. Nothing errored - the
 * assistant kept answering platform questions from the curated `load_platform_info` summaries, which
 * reads as a thin answer rather than as an unreachable corpus.
 *
 * So: ADDING A PREFIX MEANS ADDING IT HERE. The list is exported for the guard that pins it
 * (`rag-source-types.test.ts`).
 *
 *  - `wiki` / `doc` - the operator's own uploaded reference corpus.
 *  - `company` - the classification-gated business/financial corpus (ADR-017), embedded under
 *    `rag/company/{classification}/` and pre-fetched here so a classification's own facts reach the
 *    model without depending on it electing to call a tool.
 *  - `agentechelon` - the platform's own docs, so "how does this work?" is answered from the
 *    documentation rather than from titles and summaries. Ingested at the classification EVERY other
 *    one grants (public product information), so every scope admits it. On a deployment whose
 *    classifications are peers there may be no such value, and then this corpus reaches only the
 *    classification it was ingested at.
 *
 * Classification scope is the same fail-closed SQL metadata filter for all of them.
 */
export const RAG_SOURCE_TYPES = ['wiki', 'doc', 'company', 'agentechelon'] as const;

/** An intent that buys neither retrieval nor a summary. */
function isTrivial(intent: string | undefined): boolean {
  return intent === IntentType.GREETING || intent === IntentType.ACKNOWLEDGMENT;
}

async function maybeRetrieveContext(
  userMessage: string,
  classification: string,
  intent: string | undefined,
): Promise<RetrieveContextResult | null> {
  if (process.env.ENABLE_LIVE_DRIFT !== 'true') return null;

  // Skip trivial intents — no point spending an embedding call on "hi".
  if (isTrivial(intent)) return null;

  try {
    // Classification-scope: the classifications this one GRANTS, which every classification declares,
    // behind the fail-closed SQL metadata filter (ADR-007). The same set the reader role and the S3
    // context prefixes are generated from; retrieval refuses a scope that differs from it.
    const classificationScope = profiles.grantsFor(classification);

    const result = await retrieveContext({
      query: userMessage,
      sourceTypes: [...RAG_SOURCE_TYPES],
      topK: 6,
      classificationScope,
      // The classification itself, not just the ladder derived from it: it selects the database
      // reader role the query runs as (ADR-028). Passed independently so a mistake in the ladder
      // above cannot also widen the privilege - retrieval rejects the pair if they disagree.
      classification,
    });

    // Honest empty — no matches above the similarity threshold.
    if (result.chunks.length === 0) return null;
    return result;
  } catch (err) {
    console.warn('[Grounding] RAG retrieval failed (non-fatal):', err);
    return null;
  }
}

/**
 * Fetch the conversation's running summary as consumable context (ADR-017).
 * Gated exactly like retrieval: needs the data-plane (ENABLE_LIVE_DRIFT), a real
 * channel, and a non-trivial intent. The summary only exists once a conversation
 * has grown past the recent-history window, so a non-null result is also the
 * "this conversation is long enough to need its earlier thread" signal.
 * Best-effort; null when unavailable.
 */
async function maybeGetSummary(
  channelArn: string | undefined,
  intent: string | undefined,
): Promise<string | null> {
  if (process.env.ENABLE_LIVE_DRIFT !== 'true') return null;
  if (!channelArn) return null;
  if (isTrivial(intent)) return null;
  return getLatestSummary(channelArn);
}

/** What a turn is grounded in. Both members absent means the turn is grounded in nothing, which is ordinary. */
export interface TurnGrounding {
  retrievedContext?: RetrieveContextResult;
  conversationSummary?: string;
}

/**
 * Resolve both, in parallel, and NEVER REJECT.
 *
 * Both underlying calls degrade to a safe value of their own (an honest-empty retrieval, a null
 * summary), so this promise settles whatever the data plane does. That matters more here than it did
 * in the router: the caller starts it early and awaits it later, and a promise that rejects before
 * anything is awaiting it is an unhandled rejection rather than a missing hint.
 *
 * Parallel because both hit the same data-plane Lambda, so the pair costs one round trip's wall clock
 * rather than two.
 */
export async function resolveTurnGrounding(args: {
  channelArn?: string;
  userMessage: string;
  classification: string;
  intent?: string;
}): Promise<TurnGrounding> {
  const [retrievedContext, conversationSummary] = await Promise.all([
    maybeRetrieveContext(args.userMessage, args.classification, args.intent),
    maybeGetSummary(args.channelArn, args.intent),
  ]);
  return {
    ...(retrievedContext ? { retrievedContext } : {}),
    ...(conversationSummary ? { conversationSummary } : {}),
  };
}
