---
title: "ADR-006: Drift detection result shape (stable interface)"
status: Decided 2026-05-22
date: 2026-05-22
related:
  - SPEC-DRIFT-CONVERGENCE.md
  - 002-embedding-model.md
  - 004-pgvector-revival-timing.md
  - "../../backend/lambda/src/analytics-aurora/drift-detection.ts"
---

# ADR-006: Drift detection result shape (stable interface)

## Context

SPEC-DRIFT-CONVERGENCE.md establishes the hardened drift design (path C).
The eval-suite fixture (`tests/e2e/fixtures/drift-detection-cases.json`) is the CI gate that
keeps drift behaviour stable across refactors.

For the eval suite to stay stable, **the `DriftResult` shape must be stable**. This ADR pins
the interface so a consumer can depend on the drift module without translation overhead, and so
a future refactor can't silently desync the shape the eval suite asserts against.

This is not a design decision in the "which approach do we take" sense - the design is already
locked in the spec. This ADR exists to prevent drift (heh) in the *interface*.

## Decision

The contract is the `DriftResult` interface in
`backend/lambda/src/analytics-aurora/drift-detection.ts`:

```typescript
export interface DriftResult {
  /** Whether the signal indicates the user has shifted topic. */
  isDrift: boolean;

  /**
   * Cosine distance between the latest message embedding and the
   * conversation summary embedding. Range 0-2 (lower = more similar).
   * `NaN` when `signalAvailable` is false (no embedding could be
   * computed). When the explicit-routing fast-path matched, this is
   * the sentinel value `1.0` — drift is not "scored" in that path.
   */
  driftScore: number;

  /**
   * What the live consumer should do.
   *   `continue`  → no user-facing suggestion; respond normally
   *   `confirm`   → suggest "want me to start a new conversation about this?"
   *   `redirect`  → suggest "this looks like a topic we covered in another
   *                  channel; want me to take you there?" (set
   *                  `rivalConversationArn`)
   */
  suggestedAction: 'continue' | 'confirm' | 'redirect';

  /**
   * Distance-from-threshold derived confidence band. Used by the
   * live-suggestion consumer to soften or harden the templated copy.
   * Always `low` when `signalAvailable` is false.
   */
  confidence: 'low' | 'medium' | 'high';

  /**
   * `false` when the embedding call failed (Bedrock 5xx, timeout, empty
   * response) and no signal could be produced this turn. The consumer
   * MUST treat this as "no drift this turn" and proceed with normal
   * response. There is no substring/keyword fallback by design (see
   * SPEC §"String matching in the design").
   */
  signalAvailable: boolean;

  /**
   * UUIDv7 (time-ordered). Stitches together: per-stage EMF metric
   * dimensions, log lines for this drift evaluation, and the bot's
   * outbound message metadata when a suggestion is emitted. End-to-end
   * traceability for a single user message.
   */
  correlationId: string;

  /**
   * Templated suggestion text. Present only when `suggestedAction !==
   * 'continue'`. The consumer SHOULD emit this verbatim — no string
   * interpolation of user-derived content (no topic name, no entity
   * extraction) per the by-reference principle.
   */
  suggestionTemplate?: string;

  /**
   * The ARN of the related channel that should receive the user.
   * Present only when `suggestedAction === 'redirect'`. Embedded in
   * the bot's outbound message as a `NAVIGATE_CHANNEL:<arn>|<name>`
   * marker the frontend uses for navigation.
   */
  rivalConversationArn?: string;

  /**
   * Internal: true iff the result came from the explicit-routing
   * fast-path (`detectExplicitRoutingRequest`), not the embedding-
   * cosine path. Recorded on `drift_events.created_via_explicit_intent`
   * so eval-suite analysis can separate the two channels.
   */
  viaExplicitIntent?: boolean;

  /**
   * Internal: when `viaExplicitIntent` is true, the topic phrase the
   * regex captured (e.g., "the Q4 budget" from "let's start a new
   * conversation about the Q4 budget"). Not interpolated into the
   * user-facing suggestion (the suggestion is still templated); used
   * only for telemetry + future eval-suite calibration.
   */
  explicitTopicHint?: string;
}
```

The input shape is also pinned:

```typescript
export interface DetectDriftInput {
  channelArn: string;
  messageId: string;
  latestMessage: string;
  intent: Intent;            // GREETING | ACKNOWLEDGMENT | OFF_TOPIC | ...
  correlationId?: string;    // Generated if not provided
  userTier?: 'basic' | 'standard' | 'premium';
  declinedDistances?: number[];
}
```

## Stability boundary

The fields above are **stable**. Adding new optional fields is allowed; renaming, removing, or
changing the semantics of existing fields is a breaking change to the interface and requires a
documented note explaining the divergence and its migration.

Changes to `DriftResult` MUST update the eval-suite fixture's `$schema` field accordingly so
version drift is caught by CI.

## What is NOT part of the contract

These are AE-internal and may change without coordination:

- **Bedrock model id** for embedding (currently `amazon.titan-embed-text-v2:0`).
  The contract assumes 1024-dim cosine-comparable embeddings; the specific
  model is an implementation detail.
- **Threshold values** (`DRIFT_DISTANCE_THRESHOLD` default 0.35,
  `REROUTE_SIMILARITY_THRESHOLD` default 0.80). Both are SSM-tunable and
  expected to vary between deployments; the eval suite converges them.
- **EMF namespace** (currently `AgentEchelon/Drift`). The *dimension* names and metric shapes
  per the SPEC observability section are what stays stable, not the namespace string.
- **Internal Lambda boundaries**. The logic currently lives in a single
  `analytics-aurora/drift-detection.ts` module, but may be split or merged across Lambdas. The
  function-level signature above is what crosses the wire.

## Why this is a separate ADR (not just a SPEC pointer)

The SPEC describes design intent. This ADR describes the *commitment* that the result shape is a
stable interface. The eval-suite SHA check is the enforcement mechanism, but it only catches
behavioral drift after the fact. This ADR is the declaration that lets a future contributor look
at the file and know that changing the `DriftResult` shape is a breaking interface change, not a
unilateral refactor.

## Consequences

- The type lives in TypeScript source as the single source of truth. Any PR touching
  `DriftResult` needs an entry in this ADR's revision history below.
- A consumer's `DriftResult` declaration MUST match the canonical interface block in this file.
  A simple `diff` in CI is sufficient - the comparison runs on the canonical interface block
  only, identified by fenced code markers.

## Revision history

- Locks the `DriftResult` shape as of AE's drift-convergence implementation.
