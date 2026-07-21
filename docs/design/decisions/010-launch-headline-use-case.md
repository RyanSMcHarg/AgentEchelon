---
title: "ADR-010: Lead headline use case for the launch story"
status: Decided 2026-04-28
date: 2026-04-28
related:
  - 005-document-mode-timing.md
---

# ADR-010: Lead headline use case for the launch story

## Context

Open-source enterprise teams discovering AE will form their first impression from the README + landing copy. We need a single-sentence "what does this do?" that captures the differentiated value. Several candidate use cases compete:

- **A. Internal AI help desk** with tier-based model access (cost control + role-based)
- **B. Multi-user team chat with a shared agent** (the @assistant/@all routing privacy model)
- **C. Regulated / audit-trail chat** (drift detection, evaluation, compliance flags)
- **D. Agentic task automation** via Bedrock Agents Action Groups
- **E. Collaborative requirements / design-doc drafting** (Document Mode + RAG)

Each maps to real value, but the README can only have one headline.

## Options

### A) Internal AI help desk

**Pros:** Most universally applicable enterprise use case; everyone has IT/HR/Legal needs. Cost-control story is unique to AE.

**Cons:** Crowded space (every vendor pitches help desk). Differentiation requires explaining the tier model first, which is a lot of setup before the value is clear.

### B) Multi-user team chat with shared agent

**Pros:** The Target-based privacy + sticky-mention UX is genuinely differentiated. "Multi-user with privacy" is a clear contrast to ChatGPT-style 1:1 chat.

**Cons:** Use case is narrow - most teams already use Slack/Teams; "another chat client" is a hard sell. Better as a feature within a broader use case.

### C) Regulated / audit-trail chat

**Pros:** Strong appeal to financial / healthcare / regulated industries. Observability built-in is a real differentiator.

**Cons:** Niche audience; OSS community may filter past it. Compliance-heavy framing scares away exploratory users.

### D) Agentic task automation

**Pros:** Aligns with the broader "agentic workflows" zeitgeist. Bedrock Agents + Action Groups is the technical foundation.

**Cons:** Vague - "task automation" means everything and nothing. Hard to picture without a concrete example.

### E) Collaborative requirements / design-doc drafting (with RAG)

**Pros:** Concrete, visualizable use case. Maps to a real pain point teams have. Combines RAG + multi-user + agent into one story. Differentiates from generic chat.

**Cons:** Requires Document Mode to ship (gates v0.3 - see ADR-005). Until then, the headline is aspirational.

## Recommendation

**Two-phase headline:** **B (multi-user chat with shared agent)** for v0.2.x - it works demonstrably today after the recent sticky-mention + WS fixes - followed by **E (collaborative requirements drafting with RAG)** for v0.3+. Use cases A, C, D become *supported* but not *headlined*; readers find them in the use-case table without them dominating the README.

## Decision

**v0.2.x headline: B (multi-user chat with shared agent).** **v0.3+ headline: E (collaborative requirements drafting with RAG).**

Both phases share the supporting story: "tier-based cost control, mention-based privacy, observability, A/B experiments built in" - those are differentiators that ride along regardless of which use case is on the cover.

## Consequences

- **README.md** gets two passes - first revision for v0.2.x to make multi-user chat the lede; second revision for v0.3 to lead with collaborative drafting.
- **Use-case table** in README lists A, C, D, and earlier-version-of-E (RAG-only without Document Mode) as "also supported" with one-line examples.
- **v0.2.x copy:** *"AgentEchelon is the open-source reference for agentic chat on AWS. Multi-user channels with privacy-aware bot routing, tier-based model access, and observability built in. Fork it, replace the domain logic, deploy to your AWS account."*
- **v0.3+ copy:** *"AgentEchelon is the open-source reference for collaborative AI workflows on AWS. Teams draft requirements, design docs, and technical specs together with an agent that pulls from your wiki, transcripts, and stored files. Tier-based access, citations, observability - built in."*
- ADR-005 confirms Document Mode lands in v0.3 (required to make E real).
- Demo / screencast assets: v0.2.x demo shows multi-user channel + shared agent + privacy in action. v0.3 demo shows two users + agent co-drafting a requirements doc with citations to internal sources.
