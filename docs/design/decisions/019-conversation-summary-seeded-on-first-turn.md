---
title: "ADR-019: Conversation summaries are seeded on the first turn, from the exchange in memory"
status: Accepted 2026-07-29
date: 2026-07-29
related:
  - "SPEC-DRIFT-CONVERGENCE.md"
  - "013-drift-retrieval-vs-decision.md"
  - "../../overview/TENETS.md"
  - "../../../backend/lambda/src/analytics-aurora/summary-updater.ts"
  - "../../../backend/lambda/src/lib/data-plane-client.ts"
supersedes: |
  Reverses the latency position in SPEC-DRIFT-CONVERGENCE's Summary Updater section, which held that
  a new conversation going up to one scheduler interval without a summary was acceptable because
  "drift is a shifting-topic-over-time detector, not a first-message classifier". The drift RESULT
  contract (ADR-006) and the execution split (ADR-013) are unchanged.
tracking: |
  Implemented and verified live 2026-07-29: four consecutive conversations each logged
  `[summary-updater][seed] seeded v1 for <channel>` on their first turn, with zero AccessDenied.
  Shipping it took three fixes, only the first of which was findable from the code - see Consequences.
---

# ADR-019: Conversation summaries are seeded on the first turn, from the exchange in memory

## Status

Accepted. Triggered by a live report that drift never fired: a user asked about the platform, pivoted
to requesting a report, and got no suggestion.

## Context

Drift is scored as the cosine distance between the incoming message and the conversation's SUMMARY
embedding. A conversation with no summary row therefore has no anchor, and `detectDrift` exits early
on `drift_skipped_no_summary`.

Summaries were written only by a scheduled scan (`SUMMARY_UPDATER_INTERVAL_MIN`, default 30). The
spec treated the resulting gap as acceptable. It is not, for two reasons:

1. **The gap covers the window where drift matters most.** A conversation's first minutes are exactly
   when a user is establishing, and then changing, what they want. Being blind for the first half hour
   is being blind for the part that counts.
2. **The failure is silent and looks like the feature being off.** `drift_skipped_no_summary` is an
   EMF counter on a VPC-attached Lambda. The reply path logs nothing on a no-drift turn, so from the
   handler logs and the UI an inert drift is indistinguishable from a correctly-quiet one. This is how
   the condition survived: the deployment was fully wired, the flag was on, and the feature did
   nothing.

The obvious implementation - have the archival path summarise once a channel's first messages land -
is not available. Archival runs VPC-attached in isolated subnets with `natGateways: 0` and there is no
`lambda` interface endpoint, so it cannot invoke anything.

## Decision

1. **The summary row is SEEDED on the conversation's first turn**, at `version = 1`, alongside the
   point the conversation is named. The scheduled scan is demoted to incremental updates plus a
   backstop for a failed seed.

2. **The seed reads no message store.** The reply path already holds the first user message and the
   assistant's reply in memory when it responds, and those are passed directly. Reading them back from
   Aurora `messages` would reintroduce exactly the Kinesis-plus-archival lag the seed exists to
   remove, and the Amazon Chime SDK is the authoritative record in any case (TENETS 8). When the
   caller already has the data, consult neither store.

3. **It runs on the existing data-plane seam** (ADR-013): a `seedSummary` op on the VPC-attached
   data-plane Lambda, invoked by the non-VPC processor through `data-plane-client`. No new VPC
   endpoint, no new egress path, no recurring cost (TENETS 9).

4. **It is initiated from the ASYNC PROCESSOR, not the router.** Only the processor holds both the
   user message and the reply; the router dispatches and returns before an answer exists.

5. **It is idempotent and non-blocking.** The data-plane side no-ops when any summary exists, so the
   caller need not track first-ness. The invoke is `Event` so the turn never waits on Bedrock, but it
   IS awaited: an async Lambda freezes when its handler resolves, so an un-awaited SDK call is often
   suspended before the request is sent.

6. **`drift_skipped_no_summary` becomes an alertable condition** rather than an expected cold start.

## Consequences

- Drift has an anchor from turn two onward. The scheduler now bounds summary FRESHNESS, not
  availability.
- Cost is one extra Haiku call per conversation, once. Negligible against per-turn model spend.
- The seed summarises a single exchange, so early drift is scored against a thin anchor. This is
  correct: it describes what the conversation is actually about so far.

**The wiring lesson, recorded because it cost three deploys.** The feature shipped twice while doing
nothing, and both times every signal was green:

1. The seed logic - unit tested 10/10, typecheck clean.
2. **The processors had no `AURORA_DATA_PLANE_ARN`.** `auroraDriftWiring` wires only the Lex handler,
   so `hasDataPlane()` was false and the call returned silently.
3. **The data-plane role lacked `bedrock:InvokeModel` on Haiku.** It had Titan embed for vectors; the
   summarisation grant existed only on the scheduled summary-updater.

Tests proved the FUNCTION worked; nothing proved it was REACHABLE where it runs. For anything crossing
a Lambda boundary, verify the deployed env and IAM, then exercise the path and read the logs - silence
is not success, because a gated no-op is indistinguishable from "not triggered".
