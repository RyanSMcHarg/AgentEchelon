---
title: "ADR-005: Document Mode in v0.3 vs v0.4"
status: Decided 2026-04-28
date: 2026-04-28
related:
  - 010-launch-headline-use-case.md
blocks:
  - Phase 3 (Document Mode)
---

# ADR-005: Document Mode in v0.3 vs v0.4

## Context

Document Mode (collaborative drafting where teams co-author requirements/design docs with an agent that pulls from RAG-indexed sources) is the use case that drove this whole plan. It's a substantial scope:

- New tables (`artifacts`, `artifact_versions`)
- New Action Group (`manage_artifact`)
- Channel `mode` flag
- Frontend split-pane (chat left, artifact right) with diff rendering and version history
- Export pipeline (markdown / Confluence / Notion / SharePoint)
- Multi-user concurrent-edit conflict resolution (OT vs CRDT vs LWW)

Estimated 2-3 weeks AE.

## Options

### A) v0.3 - bundle with first major post-launch release

**Pros:**
- Headline-feature alignment: "AE adds RAG + collaborative drafting" is one story
- Forces the architectural pieces (artifacts, conflict resolution) to land while RAG context is fresh
- Strong narrative for the OSS launch follow-up

**Cons:**
- Significant scope; v0.3 release date pushes out
- Concurrent-editing strategy is a design/test commitment we may not be ready for

### B) v0.4 - defer to a focused release

**Pros:**
- v0.3 stays tight (RAG + pgvector revival)
- Document Mode gets dedicated design + prototype time

**Cons:**
- The use case the user described as motivation gets pushed further out
- "AE has RAG but no doc-creation flow" is a weaker pitch than "AE has RAG + doc-creation"

### C) v0.3 minimal - artifact persistence only, no collaborative-editing UI

**Pros:**
- Ships the storage + Action Group quickly
- Frontend is just a "show current artifact" panel, not split-pane diff
- Multi-user editing deferred

**Cons:**
- Half-feature; doesn't deliver the headline use case
- Risk of looking like an unfinished product

## Recommendation

**Option A: v0.3 with full multi-user collaborative editing.** ADR-010 selects collaborative requirements drafting as the v0.3+ headline narrative; that pitch fails without Document Mode shipping in the same release. Concurrent-editing strategy is the riskiest piece - pick last-write-wins (LWW) with optimistic-UI section locks for v0.3 to keep scope realistic; defer CRDT/OT to a future ADR if collisions become a real complaint.

## Decision

**v0.3, scope A. Concurrent-editing strategy: LWW with optimistic UI section locks** (when one user starts editing a section, the UI shows "Sarah is editing this section" to others; on commit, latest write wins with a merge prompt for true conflicts).

## Consequences

- v0.3 release scope locks in: artifacts CRUD + `manage_artifact` Action Group + split-pane UI + version history + LWW concurrent-edit handling + export pipeline (markdown / Confluence / Notion / SharePoint plug-in points).
- Estimated 2 - 3 weeks AE engineering. Frontend split-pane + diff rendering is the largest line item.
- LWW means edits can clobber each other if two users type into the same section simultaneously. Mitigation: section-level optimistic lock UI. Acceptable for v0.3; revisit if collisions become a real complaint.
- Export to Confluence / Notion / SharePoint defined as outbound Action Group plug-in points in v0.3 with stub implementations. Real wire-up to those services is a v0.3.x or v0.4 effort, depending on customer demand.
- ADR-010's v0.3 narrative ("AE: collaborative requirements drafting where teams co-author with an AI that knows your wiki") becomes the launch headline.
