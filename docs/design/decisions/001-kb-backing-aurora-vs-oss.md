---
title: "ADR-001: Bedrock Knowledge Base backing store - Aurora pgvector vs OpenSearch Serverless"
status: Decided 2026-04-28
date: 2026-04-28
blocks:
  - Phase 0 (shared `KnowledgeBaseConstruct`)
---

# ADR-001: KB backing store - Aurora pgvector vs OpenSearch Serverless

## Context

Bedrock Knowledge Base requires a vector store. AWS-supported options are Aurora PostgreSQL (pgvector), OpenSearch Serverless, OpenSearch Service (managed), Pinecone, and a few others. We're choosing between the two AWS-managed options that fit our existing stack.

AE has Aurora as opt-in (`--context analyticsMode=aurora`), with a dormant pgvector schema already in place.

## Options

### A) Aurora pgvector

**Pros:**
- Reuses the Aurora cluster the deployment already provisions (no new ops surface)
- No baseline cost beyond what Aurora already incurs (Serverless v2 0.5 - 4 ACU)
- Same DB powers analytics, drift detection, evaluation - single retrieval surface
- Schema evolution is in our hands

**Cons:**
- Requires VPC + RDS Proxy (Aurora-mode prerequisites)
- Bedrock KB → Aurora integration requires specific PG extension setup; conflicts possible with custom pgvector schemas
- Forces AE deployments to opt into Aurora mode (changes the default-on/off question)
- Connection scaling under heavy retrieval load is a Lambda-with-RDS-Proxy concern

### B) OpenSearch Serverless (OSS)

**Pros:**
- Zero VPC requirement - works in AE's default Athena mode
- Native Bedrock KB integration (the AWS-promoted path)
- Independent scaling from Aurora; retrieval load doesn't affect analytics queries
- Simpler "deploy and go" for users who don't need Aurora's analytics

**Cons:**
- Baseline cost: ~$0.24/hour per OCU (~$175/month minimum for 1 OCU each indexing + search)
- New ops surface (index lifecycle, backup, monitoring)
- Two stores to manage (OSS for docs, Aurora for analytics) - dual cost line

## Recommendation

**Aurora pgvector.** AE Aurora-mode users have already accepted the VPC + RDS Proxy footprint. OpenSearch Serverless's $175/month baseline is a real disincentive for OSS evaluators and adds an ops surface we don't otherwise need. Pgvector's HNSW + cosine-distance retrieval is more than sufficient for the corpus sizes we're targeting (low-thousands of documents, not millions).

## Decision

**Aurora pgvector.** AE deployments wanting RAG must opt into Aurora-mode (`--context analyticsMode=aurora`). RAG and Aurora-mode-analytics share the same backing cluster.

## Consequences

- The README and quickstart docs flag that RAG requires Aurora-mode. The default-Athena mode remains for evaluators who only need chat without RAG.
- The shared `KnowledgeBaseConstruct` (Phase 0) takes the Aurora cluster ARN + database name as inputs; no OSS branch in CDK to maintain.
- Bedrock KB → Aurora pgvector requires the `vector` extension (already enabled per migration `002-pgvector.sql`) plus Bedrock-specific table schema (KB writes to its own table; coexists with our existing `embeddings` table).
- Future option: OSS as an alternative backing for users who explicitly cannot run Aurora - defer until a customer asks.
- Aurora ACU autoscaling needs sanity-checking under retrieval load; baseline 0.5 - 4 ACU should cover small/medium deployments.

**Outcome:** RAG shipped as a **direct pgvector implementation** (no Bedrock Knowledge Base wrapper / `KnowledgeBaseConstruct`) reusing the Aurora cluster. The Aurora-pgvector-over-OpenSearch-Serverless decision here still holds; see `docs/guides/developer/RAG.md` for the as-built design.
