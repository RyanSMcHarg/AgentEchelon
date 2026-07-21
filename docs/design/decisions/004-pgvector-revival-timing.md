---
title: "ADR-004: Pgvector revival timing for analytics"
status: Decided 2026-04-28
date: 2026-04-28
related:
  - 002-embedding-model.md
blocks:
  - Phase 3 (analytics revival workstream)
---

# ADR-004: Pgvector revival timing for analytics

## Context

Two user-facing behaviors depend on the assistant *understanding* meaning rather than matching keywords: noticing when a conversation has genuinely drifted to a new topic, and surfacing "similar past discussions" that are actually related. Delivering those well is the user problem here - the kind of semantic recall a team would otherwise expect from a dedicated search or memory product. The question this ADR settles is *when* to build it, and current state shapes the answer: the deployment has pgvector schemas defined but no embedding pipeline running, so today -

- `cross-conversation-context` Lambda doesn't actually use semantic similarity (despite the name suggesting it should)
- `drift-detection` uses keyword-Jaccard scoring instead of cosine distance
- Admin "similar past discussions" features can't be built because the data isn't there

Reviving pgvector for these analytics surfaces is independent of document RAG (Phase 1) - different consumers, potentially different vector space.

## Options

### A) Bundle with v0.2.1 RAG

**Pros:**
- Single embedding pipeline pattern shipped at once
- Story is cleaner: "RAG over docs + over conversations" in one release
- Reuses Phase 0 embedding-model decision immediately

**Cons:**
- Doubles the v0.2.1 scope; delays RAG ship date
- Conflates two distinct use cases (retrieval vs analytics drift)
- Forces a decision about whether KB and analytics share a vector space - a question that doesn't need to be answered now

### B) Separate post-RAG release (v0.2.2 or v0.3 parallel track)

**Pros:**
- v0.2.1 ships RAG fast, focused
- Pgvector revival becomes a contained "make analytics actually semantic" workstream
- Decouples scheduling

**Cons:**
- Two embedding pipelines briefly (KB-managed for docs; new Lambda for conversation summaries)
- Story has to acknowledge "drift detection is still keyword-based until v0.2.2"

### C) Defer indefinitely

**Pros:**
- No additional scope
- The current keyword/Jaccard implementations work, even if poorly

**Cons:**
- The dormant schemas remain dormant; technical debt accumulates
- Open-source readers see "pgvector schema, no pipeline" as confusing

## Recommendation

**Option B: separate post-RAG release (v0.2.2).** RAG ships first as a contained feature; pgvector revival is a follow-on workstream that makes analytics actually semantic. Pairs with ADR-002 (Titan v2 1024-dim) so document and conversation embeddings share a vector space.

## Decision

**v0.2.2 follow-on, after RAG ships.** Three independent surfaces in this workstream:
1. Embed conversation summaries on insert into `conversation_summaries` (or sibling table)
2. Replace `drift-detection`'s keyword-Jaccard with cosine-distance drift on conversation summaries
3. Wire `cross-conversation-context` to use semantic similarity for related-conversation lookup

Each can ship independently inside the v0.2.2 release window.

## Consequences

- v0.2.1 (RAG) ships without pgvector-revival scope; the existing `cross-conversation-context` and `drift-detection` Lambdas remain on their current keyword/Jaccard implementations until v0.2.2.
- v0.2.2 introduces a conversation-summary embedding Lambda triggered by inserts/updates on `conversation_summaries`. Uses Titan v2 1024-dim per ADR-002.
- The dormant `embeddings` table from migration `002-pgvector.sql` becomes the storage for conversation embeddings. Document embeddings live in Bedrock KB's own table (separate concern).
- Drift detection becomes more accurate but slightly slower (one Bedrock embedding call per drift check); cache embeddings to mitigate.
- Admin dashboard gets a "similar past discussions" feature in v0.2.2; design it as a simple top-K display alongside the existing conversation list.
- Honest framing in v0.2.1 release notes: "Drift detection is keyword-based today; v0.2.2 makes it semantic."
