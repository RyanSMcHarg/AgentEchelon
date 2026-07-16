---
title: "ADR-007: KB permission gating via metadata filters"
status: Decided 2026-04-28
date: 2026-04-28
related:
  - 003-kb-scoping-per-channel-vs-global.md
blocks:
  - Phase 0
---

# ADR-007: KB permission gating via metadata filters

## Context

Bedrock Knowledge Base supports per-document metadata that can be used as a retrieval filter at query time. AE's permission model needs to map onto these filters: Cognito groups (`basic` / `standard` / `premium` / `admins`).

AE doesn't yet have a documented document-permission model. The metadata schema we settle on must map cleanly onto the Cognito-tier model and leave room for a future multi-party privacy intersection rule for cross-conversation context.

## Options

### A) Single `visibility` field - `public` / `internal` / `restricted`

**Pros:**
- Simple, three-tier mapping of common org access patterns
- Maps naturally to AE tiers (basic→public, standard→internal, premium→restricted)

**Cons:**
- Coarse-grained; no team-level isolation
- "Restricted" is overloaded (could mean "admin only" or "specific group only")

### B) Composite metadata: `visibility` + `team` + `roles[]`

**Pros:**
- Reflects real org access patterns (visibility AND team membership)
- Bedrock filter can combine: `visibility=internal AND team=sales`
- Future-flexible for new dimensions

**Cons:**
- Every ingested doc must be tagged on all dimensions or filters break
- Frontend admin UI to manage tags is non-trivial
- More moving parts during ingestion

### C) Defer permission gating to ADR-012-style intersection logic at retrieval time

**Pros:**
- Sophisticated: only retrieve docs visible to ALL channel members (multi-party privacy)
- Strongest leakage protection in multi-user contexts

**Cons:**
- Complex retrieval logic; not a simple metadata filter
- Requires the multi-party privacy intersection rule to be implemented in AE first (currently absent)

## Recommendation

**Option A: single `visibility` field with three values (`public` / `internal` / `restricted`).** Ships v0.2.1 fast, maps cleanly onto the AE Cognito-tier permission model, supports the metadata-filter scoping decided in ADR-003. Defer team-level isolation (B) and multi-party intersection (C) until customer feedback warrants.

## Decision

**Single `visibility` metadata field. Values: `public` | `internal` | `restricted`.** Maps as follows:

- AE: basic tier sees `public`; standard sees `public` + `internal`; premium and admins see all.

## Consequences

- Document ingestion requires `visibility` to be set per chunk. Default for untagged docs: `internal` (sensible-default; explicit ingestion can override).
- Bedrock KB metadata filter at retrieval time: `visibility IN [allowed_values_for_user_tier]`. Filter expressions are constructed in the agent invocation path based on the calling user's tier.
- ADR-003's optional channel-level filters (`team`, `topic`) are additive on top of `visibility` - both filters apply at retrieval.
- Frontend admin UI: ingestion form has a `visibility` dropdown (default: `internal`). Bulk-import tools require it as a column.
- Audit trail: log every retrieval with the user's tier and the filter expression, so cross-tier access attempts are visible. Lives in the existing analytics pipeline.
- Promotion path: when team-level isolation is needed, add `team: string` as a second metadata field. Existing `visibility` keeps working; `team` filters at retrieval. No schema break.
- The multi-party privacy intersection (option C) is genuinely future work - depends on implementing a `multi-party-privacy.ts` retrieval-scoping module in AE, slated post v0.3.
