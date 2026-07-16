---
title: "ADR-003: KB scoping - per-channel vs global"
status: Decided 2026-04-28
date: 2026-04-28
related:
  - 007-kb-permission-metadata-filters.md
blocks:
  - Phase 1 (RAG ships)
---

# ADR-003: KB scoping - per-channel vs global

## Context

When the agent retrieves, what corpus does it search? Two ends of a spectrum:

- **Global**: one KB per deployment; every channel sees everything (subject to user permissions).
- **Per-channel**: each channel binds to a specific subset of KBs; the Sales channel doesn't see Engineering wikis even if the user has access.

Most enterprises will want some scoping - a Legal channel mixing in Engineering docs is noise at best, leakage at worst. Per-channel scoping costs setup complexity and adds metadata to manage.

## Options

### A) Single global KB

**Pros:**
- Simplest: one KB, one S3 bucket, one ingestion config
- Cheapest to operate
- Easiest "fork and deploy" story for the OSS audience

**Cons:**
- No content isolation between channels
- Permission filtering happens only at user-tier level; no team/topic boundary
- Doesn't reflect how enterprises actually organize knowledge

### B) Per-channel KB binding (channel metadata: `knowledgeBaseIds: string[]`)

**Pros:**
- Reflects real org structure (Sales channel ≠ Eng channel)
- Aligns with how teams already segment Notion / Confluence / Sharepoint spaces
- Enables admin UI for "this channel can search KBs X, Y, Z"

**Cons:**
- Metadata management overhead (when creating a channel, also pick KBs)
- More CDK surface (multiple KB resources per deployment)
- Permission model gets harder: user-tier × KB-access × channel-scope

### C) Hybrid - one global KB with metadata filters

**Pros:**
- Single KB resource, zero new ops
- Per-channel scoping via Bedrock KB metadata filter at query time (e.g., `team: 'sales'`)
- Cheaper than B, more flexible than A

**Cons:**
- Metadata filter contract has to be enforced at ingest time (every doc tagged correctly)
- Larger index = slower retrieval at scale
- Admin UI for "this channel filters by team=sales" is per-channel anyway, so the metadata burden moves but doesn't disappear

## Recommendation

**Option C: hybrid - single global KB with metadata filters.** Simplest ops (one KB resource), reflects real org structure (every doc tagged at ingestion with team / topic / visibility), allows per-channel scoping at query time without proliferating CDK resources. Bedrock KB metadata filtering is sufficiently expressive for the foreseeable use cases.

## Decision

**Hybrid: one global KB per deployment, scoped at retrieval time via metadata filters.** Channel metadata adds an optional `kbFilters: { team?: string; topic?: string }` field; agent retrieval calls pass these as filter expressions to Bedrock KB.

## Consequences

- `KnowledgeBaseConstruct` deploys one KB resource per CDK stack instance. No multi-KB orchestration.
- Document ingestion must tag every chunk with metadata: minimum `{ visibility, team?, topic?, source_type, source_uri }`. Untagged docs are scoped to the broadest visibility tier only.
- Channel creation flow gets an optional "scope this channel's retrieval" picker. Default: no filter, agent searches all docs the user's tier can see.
- Frontend admin UI (`KnowledgeBasePanel`) needs a metadata editor for ingested docs.
- Phase 1.A and 1.B both implement the filter-passing logic in their respective invocation surfaces (Agent's `KnowledgeBaseAssociation` config vs Converse's `RetrieveAndGenerate` request).
- Promotion path: if a customer needs hard tenant isolation later, B (per-channel KB binding) is additive - keep this hybrid for the common case, deploy separate KBs for the isolation case.
