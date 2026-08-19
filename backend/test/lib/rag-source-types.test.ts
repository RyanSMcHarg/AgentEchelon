/**
 * Every ingested corpus must be RETRIEVABLE, not merely embedded.
 *
 * A `source_type` is the first path segment under `rag/` (`document-ingestion.ts:deriveSourceType`), so
 * uploading to a new prefix mints a new type without touching any code. Retrieval, meanwhile, filters
 * on an explicit list. When the two disagree the corpus is embedded, stored, billed - and unreachable.
 *
 * THAT HAPPENED. `rag/agentechelon/` (the platform's own documentation) was ingested in full, 79 docs,
 * zero errors, and returned ZERO chunks for every live query because the router asked only for
 * wiki/doc/company. Verified against the deployed database: the same query returned 0 chunks with the
 * router's list and 4 chunks at 0.48-0.58 similarity once `agentechelon` was included.
 *
 * The failure is silent by construction, which is why it needs a guard rather than a review. Retrieval
 * returning nothing is indistinguishable from "no relevant content", the assistant still answers (from
 * the curated summaries), and no error is logged anywhere.
 */
import { RAG_SOURCE_TYPES } from '../../lambda/src/router-agent-handler';

/**
 * The corpora this deployment actually ingests, and who writes each. A new entry here without a
 * matching entry in RAG_SOURCE_TYPES is the defect this file exists to catch.
 */
const INGESTED_CORPORA: Array<{ sourceType: string; prefix: string; writtenBy: string }> = [
  { sourceType: 'company', prefix: 'rag/company/{classification}/', writtenBy: 'seed-demo.ts uploadCompanyRag' },
  { sourceType: 'agentechelon', prefix: 'rag/agentechelon/basic/', writtenBy: 'sync-project-knowledge.mjs --rag' },
];

describe('RAG source types', () => {
  it.each(INGESTED_CORPORA)(
    'the router retrieves the $sourceType corpus ($prefix)',
    ({ sourceType, prefix, writtenBy }) => {
      if (!(RAG_SOURCE_TYPES as readonly string[]).includes(sourceType)) {
        throw new Error(
          `${writtenBy} ingests ${prefix}, giving source_type '${sourceType}', but the router does not `
          + 'ask for it. Those documents are embedded and stored and can never be retrieved. Nothing '
          + 'errors: retrieval just returns no chunks, which is indistinguishable from "nothing '
          + `relevant". Add '${sourceType}' to RAG_SOURCE_TYPES in router-agent-handler.ts.`,
        );
      }
      expect(RAG_SOURCE_TYPES as readonly string[]).toContain(sourceType);
    },
  );

  it('keeps the operator-uploaded corpus types', () => {
    // `wiki` and `doc` are what RAG.md tells a deployer to upload under. Dropping either would make
    // the documented "upload your corpus" path silently return nothing.
    expect(RAG_SOURCE_TYPES as readonly string[]).toEqual(expect.arrayContaining(['wiki', 'doc']));
  });

  it('names each type once', () => {
    expect(new Set(RAG_SOURCE_TYPES).size).toBe(RAG_SOURCE_TYPES.length);
  });
});
