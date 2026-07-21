---
title: "ADR-002: Embedding model selection"
status: Decided 2026-04-28
date: 2026-04-28
related:
  - 001-kb-backing-aurora-vs-oss.md
blocks:
  - Phase 0 (shared `KnowledgeBaseConstruct`)
---

# ADR-002: Embedding model selection

## Context

The RAG capability a deployer wants (ADR-001) only answers well if the embedding model behind it gives good-enough retrieval quality at a cost that does not surprise them - and without forcing them to sign up for a separate embedding provider. So the user problem is **affordable, decent-quality semantic search over a team's own content**, with multilingual reach available to those who need it. Bedrock Knowledge Base supports several embedding models that trade quality, cost, dimensionality, and language coverage against each other; the choice also shapes downstream compatibility (cross-conversation context analytics in Phase 3 should use the same model for consistency).

Current state qualifies the answer: AE's dormant pgvector schemas declare 1536-dim columns (consistent with OpenAI `text-embedding-3-small` defaults), and none of the Bedrock-native options match 1536 - so whichever model wins, the empty schema is altered, dropped, or paired with a second embedding space.

## Options

### A) Amazon Titan Text Embeddings v2 (1024-dim)

**Pros:**
- Cheapest Bedrock-native option ($0.00002 / 1K tokens)
- Configurable output dim (256, 512, 1024)
- Bedrock-native (no cross-region or cross-account hops)
- AWS account-level model access; same surface as inference models

**Cons:**
- English-first quality; multilingual support exists but isn't its strength
- 1024 ≠ existing schema's 1536; schema migration required

### B) Cohere Embed Multilingual (1024-dim)

**Pros:**
- Strong multilingual coverage
- Bedrock-native
- Good performance on technical/code content

**Cons:**
- Higher cost than Titan
- Cohere model access is a separate Bedrock model-access checkbox; users must enable
- 1024-dim, same schema migration as Titan

### C) Titan Text Embeddings v1 (1536-dim) - schema-compatible

**Pros:**
- Matches existing 1536-dim schema; no migration
- Bedrock-native, well-understood

**Cons:**
- Older model, lower quality than v2 on most benchmarks
- Locks us in to the 1536-dim choice the schema author probably picked arbitrarily

### D) Two parallel spaces (KB-managed + Aurora-owned for analytics)

**Pros:**
- KB uses whatever Bedrock recommends (Titan v2)
- Aurora pgvector keeps 1536 schema for conversation analytics
- Decouples document RAG from cross-conversation context evolution

**Cons:**
- Two embedding pipelines to maintain
- "Similar past discussions" can't trivially join with document chunks (different vector space)

## Recommendation

**Titan Text Embeddings v2 at 1024-dim.** Cheapest, AWS-native, no extra Bedrock model-access flag (Cohere requires a separate enable). The 1024-dim ≠ schema-1536 mismatch is solved with a one-time migration; the existing schema is dormant so there's no data to preserve. English-first is fine for the launch; multilingual users can override the embedding-model context variable.

## Decision

**Titan Text Embeddings v2, output dim 1024.** Embedding model is selected via CDK context (`--context embeddingModel=titan-v2-1024`) with that as the default; users can override to Cohere or Titan v1 if needed.

## Consequences

- New migration `005-embeddings-titan-v2.sql` alters the `embeddings.embedding` column from `vector(1536)` to `vector(1024)` (or drops + recreates since the table is empty in the deployment today).
- The `KnowledgeBaseConstruct` accepts an `embeddingModel` prop with Titan v2 as default; OpenAPI / CDK code references the Bedrock model ID `amazon.titan-embed-text-v2:0`.
- Cost projection for typical corpora: Titan v2 charges $0.00002 / 1K tokens. A 10K-page wiki at ~500 tokens/page = ~$0.10 to embed once. Re-embedding on schema changes is cheap; not a TTL driver.
- Phase 3 (pgvector revival) embeds conversation summaries with the same model, keeping document and conversation vectors in the same space - enables future unified queries without dual-space complexity.
- Multilingual support: deferred. If a customer requests it, the override path to Cohere is documented and the schema doesn't need to change (Cohere also outputs 1024-dim).
