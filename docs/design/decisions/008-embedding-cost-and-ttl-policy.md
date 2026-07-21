---
title: "ADR-008: Embedding cost and TTL policy for transcripts and growing corpora"
status: Decided 2026-04-28
date: 2026-04-28
related:
  - 002-embedding-model.md
blocks:
  - Phase 2 (static-context migration including transcripts)
---

# ADR-008: Embedding cost and TTL policy for growing corpora

## Context

A team's RAG corpus is not static - meeting transcripts pile up week over week - and the user wants two things as it grows: the cost to stay predictable, and answers to stay *fresh* rather than dredging up a stale meeting note from a year ago. Keeping RAG affordable and current at scale is the user problem this policy serves. Static documents (resume, blog posts, response-guidance) embed once and are cheap; meeting transcripts grow unbounded - a 30-minute meeting can produce 5 - 15K tokens, and a busy deployment may produce dozens of meetings per week - so without a policy the KB grows forever and re-indexing on schema changes becomes prohibitively expensive.

Two cost vectors: (1) initial embedding ($0.00002 / 1K tokens for Titan v2 → ~$2/month at 100 meetings if all transcripts indexed), (2) retrieval (per-query, much smaller). The bigger concern is *staleness* - old meeting transcripts may not deserve to be retrieved indefinitely.

## Options

### A) Index all transcripts forever, no TTL

**Pros:**
- Simple
- Maximum recall - old discussions stay queryable
- Lowest cognitive load for users

**Cons:**
- Index grows unbounded
- Stale content drifts retrieval relevance over time
- Cost grows linearly with org age

### B) TTL-based eviction (e.g., 90 days)

**Pros:**
- Bounded index size and cost
- Forces fresher retrieval results
- Configurable per-source-type (transcripts: 90d; blog posts: never)

**Cons:**
- "Why did the agent forget our Q1 design discussion?" - surprises users
- Requires lifecycle Lambda to evict + re-index when needed

### C) Tiered: hot (7d), warm (90d, same KB but lower priority), cold (S3 only, agent-inaccessible)

**Pros:**
- Mirrors how human memory works
- Recent content prioritized in retrieval
- Old content preserved as evidence but not noise

**Cons:**
- Complex implementation (boost/dampen by recency at query time)
- Bedrock KB doesn't natively support tiered relevance

### D) Importance-flagged retention

**Pros:**
- "Pin this transcript" UI lets users mark important meetings as never-evict
- Default eviction with manual override

**Cons:**
- UI affordance to build
- Most users won't bother flagging anything

## Recommendation

**Option A: no TTL initially.** With Titan v2 at $0.00002/1K tokens, even 100 meetings/month at 10K tokens each costs ~$0.20/month to embed. Aurora pgvector has no per-record retention cost (just storage). The actual operational pain doesn't appear until index size starts affecting retrieval latency - likely tens of thousands of chunks before HNSW slows down materially. Add TTL when monitoring shows it's needed.

## Decision

**No TTL on embeddings in v0.2.x.** Add monitoring (chunk-count + retrieval p99 latency) so we know when to revisit. Per-source-type TTL becomes a future enhancement when monitoring data justifies it.

## Consequences

- Phase 2 transcript ingestion runs without an eviction policy. All meeting transcripts are queryable forever from day one.
- Add a CloudWatch metric `kb_chunk_count` published by the ingestion Lambda. Alarm threshold to be tuned but starting at 50K chunks.
- Add a CloudWatch metric `kb_retrieval_p99_ms` from the retrieval call sites. Alarm at 500ms to trigger a TTL design review.
- Cost monitoring: include Bedrock embedding spend in the existing analytics dashboard, added in v0.2.x.
- Roadmap entry: "Add per-source-type TTL when monitoring justifies" - gated by the alarm thresholds above, not on a fixed date.
- Document Mode artifacts (Phase 3) are separate from this - artifacts are durable user content, never auto-evicted regardless of TTL policy.
- Future-importance flagging (option D): defer until users request it. Pinning UX is non-trivial frontend work.
