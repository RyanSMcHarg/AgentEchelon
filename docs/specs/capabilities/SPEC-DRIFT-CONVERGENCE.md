# SPEC: Drift Detection

**Status:** Implemented (Aurora mode; the live-suggestion path is behind `enableLiveDrift`).

**Problem and who it's for:** When a user pivots to a new topic mid-conversation, the thread's context and summary stop matching what they are asking, degrading replies and muddying analytics - and catching that reliably otherwise means building your own drift detection. This serves the end user (offered a clean "split this into a new conversation" flow) and the AI developer (who gets a deterministic, embedding-based drift signal with per-stage telemetry and an eval suite) without standing up that harness. It computes cosine distance between the message and conversation-summary embeddings via pgvector, scoped by the intersection of all members' access, and never falls back to keyword matching.

**Site section:** Core platform, capabilities (platform feature; not a pillar; the drift signal - its config seam, thresholds and live-drift enablement, is conversation-config).


Drift detection is an embedding-based drift path. The live-suggestion path is gated behind the `enableLiveDrift` CDK context flag (Aurora mode only); the post-hoc analytics drift signal runs by default in Aurora mode.

The signal is embedding-based throughout: no substring or keyword matching feeds a semantic signal (a project constraint). Embeddings are Titan v2 at 1024-dim, and pgvector provides the cosine search.

**Execution (project decision 018).** The embedding and pgvector work (`detectDrift`, `recordDriftFire`, `recordDriftOutcome`) runs inside the VPC-attached retrieval **data-plane Lambda**, which the non-VPC agent handler invokes synchronously. The handler orchestrates the suggestion and any conversation creation but is itself not VPC-attached. Retrieval (RAG) shares the same data-plane Lambda. See `docs/guides/developer/RAG.md` and `docs/guides/admin/INFRASTRUCTURE-COST.md`.

---

## What drift detection is

Drift detection - "the user pivoted to a different topic; offer to split the conversation" - is a flagship AE capability. It is built on embedding-based cosine similarity at the conversation level, with deterministic scoring, per-stage observability, and multi-member privacy scoping.

## Capabilities

1. AE provides **live drift detection** with a user-facing suggestion + confirm/decline + new-channel-creation flow, built on the embedding-based design (no substring matching).
2. The signal is **`cosine_distance(message_embedding, summary_embedding)`** computed via pgvector against Titan v2 embeddings. Single number. Deterministic.
3. On embedding-call failure, the fallback is **"no drift this turn"** - never a substring/keyword path. The signal is skipped; the next message gets another shot.
4. **String matching survives in exactly one place:** `detectExplicitRoutingRequest` as a fast-path optimization for unambiguous explicit user intent ("let's switch to a new conversation about X"). This skips the embedding round-trip and routes immediately. It is not a drift signal; it is a UX latency optimization for explicit user requests.
5. `drift_events` schema is **by-reference** - references the originating message by id, never stores the user message body. PII inheritance follows the existing exchanges-table erasure path.
6. Retrieval of related conversations (`findRelatedConversations`) uses cosine-NN over summary embeddings, **scoped at SQL level by the intersection of all human channel members' memberships** in the current channel. This is a security boundary (cross-user leakage) and a privacy boundary (multi-member channel leakage).
7. Per-stage EMF metrics + correlation IDs make every drift event traceable; an admin dashboard surfaces P50/P95/P99 by stage and per-event false-drift notifications.
8. AE owns the canonical `DriftResult` interface and runs the eval suite.

## Out of scope

- Algorithmic judging of drift correctness (the eval suite measures TPR/FPR but doesn't auto-correct decisions in production)
- Cross-channel drift correlation (anchor a single channel; out-of-scope for this spec)
- Athena-mode drift (drift requires Aurora pgvector; Athena-mode deployments don't get live drift - matches existing module gating)

## String matching in the design

The drift signal is entirely embedding-based; no keyword, substring, or Jaccard matching feeds it. String matching lives in exactly one place: `detectExplicitRoutingRequest` (in `lib/explicit-routing.ts`), an explicit-intent fast-path for unambiguous user requests like "let's start a new conversation about X" or "switch to talking about Y." It skips the embedding round-trip and routes immediately. It is not a drift signal; it is a UX latency optimization for explicit user intent, backed by a unit-tested allowlist.

Everything else in the drift path is embedding-based:

- Topic extraction and similarity use conversation-level cosine over Titan v2 embeddings, not an `extractTopic()` keyword regex or Jaccard keyword overlap.
- Related-conversation retrieval uses cosine-NN, not topics-array `&&` overlap or a company-name filter (semantic retrieval handles that naturally).
- On an embedding-call failure the signal returns "no drift this turn"; there is no substring or keyword fallback, and no separate LLM entity-extraction pass (the conversation-level cosine makes it redundant).

## Design

### Interface

`DriftResult` has this shape:

```typescript
export interface DriftResult {
  isDrift: boolean;
  driftScore: number;                  // cosine_distance (0-2 range, lower = more similar). NaN if unavailable
  suggestedAction: 'continue' | 'confirm' | 'redirect';

  // Observability + flow fields
  confidence: 'low' | 'medium' | 'high';
  signalAvailable: boolean;             // false if embedding call failed → suggestedAction='continue', no suggestion
  correlationId: string;                // UUIDv7
  suggestionTemplate?: string;          // Set when suggestedAction='confirm' and live-path consumer asked for it
  rivalConversationArn?: string;        // Set when an existing related conversation matched (suggest_switch rather than offer_create)
}
```

Fields intentionally absent: `originalTopic`, `currentTopic`, `topicType`. These would represent entity-extracted topic strings; the conversation-level cosine comparison replaces them. The user-facing suggestion is templated and does not interpolate a topic name.

### Summary Updater (Prerequisite)

Drift detection requires `conversation_summaries` rows to compare against; without a summary updater, every drift call hits `drift_skipped_no_summary` and the feature cannot function. A summary-updater Lambda writes these rows.

**Trigger** - time-only:

EventBridge fires the Lambda on a fixed schedule (`SUMMARY_UPDATER_INTERVAL_MIN`, default 30). On each run, the Lambda finds channels whose newest message is newer than their newest summary:

```sql
SELECT DISTINCT m.channel_arn
  FROM messages m
  LEFT JOIN (
    SELECT channel_arn, MAX(updated_at) AS last_summary_at
      FROM conversation_summaries
     GROUP BY channel_arn
  ) cs ON cs.channel_arn = m.channel_arn
 WHERE m.created_at > COALESCE(cs.last_summary_at, 'epoch'::timestamptz)
```

This single query handles both cases: channels that had a summary before but have new activity, and channels that have never been summarized. Channels with no activity since their last summary are excluded - no wasted Bedrock calls.

No fire-and-forget invocation from kinesis-archival. The kinesis archival path stays a pure write to `messages`; the time-based scan owns all summary generation.

**Latency implication:** new conversations or fresh topic-shifts go without an updated summary for up to one scheduling interval (~30 min by default). Drift detection on such a conversation will hit `drift_skipped_no_summary` until the next summary run. This is acceptable - drift is a "shifting topic over time" detector, not a "first-message classifier." Deployers who need faster freshness lower `SUMMARY_UPDATER_INTERVAL_MIN`.

**Algorithm** (per channel):

1. SELECT recent messages from `messages` table since the last summary's `updated_at`, capped at the most recent 50 (Haiku context is fine for 50 turns).
2. SELECT the current `conversation_summaries` row (if any) for the channel - used as anchor context so the LLM does incremental summarization rather than re-summarizing from scratch.
3. Call Bedrock Haiku with a structured prompt that returns JSON: `{summary, purpose, topics[], key_points[]}`. Temperature 0 for determinism.
4. UPSERT into `conversation_summaries` with `version = previous + 1`, `message_count = total_messages_in_channel`, `updated_at = NOW()`. Race-safe via `WHERE version = previous_version` conditional update.
5. Generate Titan v2 embedding of the new `summary` text, UPSERT into `summary_embeddings` with `embedded_from_version = version`.
6. Emit EMF metrics: `summary_updater_run`, `summary_updater_skipped_no_changes`, `summary_updater_bedrock_failure`, per-stage latencies.

**Idempotency** - the embedding write checks `WHERE embedded_from_version < $newVersion` so duplicate invocations don't re-embed. The summary write uses `WHERE version = $previousVersion` so the second concurrent writer gets a no-op (the first writer wins the increment).

**Failure modes** - every step is best-effort. If Bedrock fails, the channel keeps its previous summary and the writer tries again on the next trigger. Per-channel circuit-breaker state is not needed; the threshold trigger naturally rate-limits retries.

**Cost** - at the reference-deployment scale (100 channels, 1k messages/day), this runs ~10 times/day. Bedrock Haiku is ~$0.25/M input tokens; one summary call is ~3k input tokens ≈ $0.0008. Daily cost: ~$0.01. Negligible.

### Detection Algorithm

```typescript
async function detectDrift(input: {
  channelArn: string;
  messageId: string;
  latestMessage: string;
  intent: IntentType;           // Skip drift on GREETING, ACKNOWLEDGMENT, OFF_TOPIC
  correlationId?: string;
}): Promise<DriftResult>
```

Algorithm:

1. **Skip conditions** (early-return `{isDrift:false, suggestedAction:'continue', signalAvailable:true}`):
 - Intent in `{GREETING, ACKNOWLEDGMENT, OFF_TOPIC}`.
 - Channel has no `conversation_summaries` row yet (cold-start - no anchor to compare against).
 - User previously declined a drift suggestion with a cosine distance within ±0.05 of what this turn's distance will be (decline-suppression - see below).

2. **Explicit routing fast-path:** if `detectExplicitRoutingRequest(latestMessage)` matches (e.g., regex like `/^(let'?s\s+)?(start|switch to|move to|open) a (new|separate) (conversation|channel|chat)\s+(about|for|on)\s+(.+)$/i`), return `{isDrift:true, suggestedAction:'redirect', confidence:'high', signalAvailable:true}` immediately. Emit `drift_fastpath_explicit_intent` EMF metric. This is the **only** string-matching path. Pattern lives in `lib/explicit-routing.ts` with a unit-tested allowlist.

3. **Embed the latest message.** Call Bedrock `InvokeModelCommand` for Titan v2 at 1024-dim. Hard timeout 500ms.

4. **Load the conversation's summary embedding** from the `summary_embeddings` table (PK `channelArn`). If absent, fall back to computing it on the fly from `conversation_summaries.summary` (rare path - only happens before the embedding writer has caught up on a brand-new conversation; emit `drift_summary_embedding_lazy_compute` EMF).

5. **Compute cosine distance** in SQL via pgvector (`<->` operator) or in Lambda - Lambda is simpler since both vectors are already available; pgvector is needed only for the related-conversation NN lookup (step 7).

6. **Threshold decision.** Compare distance against `/agent-echelon/drift/distance-threshold` SSM param (default `0.35`, range 0.25-0.45, tuned by the eval suite). Above threshold → drift; below → continue.

7. **Related-conversation lookup (only if drift fires).** SQL cosine-NN against `summary_embeddings`:

   ```sql
   SELECT channel_arn, 1 - (embedding <=> :messageEmbedding::vector) AS similarity
   FROM summary_embeddings
   WHERE channel_arn IN (:scopedChannelArns)
     AND channel_arn != :currentChannelArn
   ORDER BY embedding <=> :messageEmbedding::vector
   LIMIT 5;
   ```

 `:scopedChannelArns` is the **intersection of all human channel members' memberships** in the current channel (security + privacy boundary - see "Scoping" section).

 If top result's similarity ≥ re-route threshold (default 0.80, SSM-tunable): `suggestedAction='redirect'`, set `rivalConversationArn`. Otherwise `suggestedAction='confirm'`.

8. **Fallback on any embedding failure** (Bedrock 5xx, timeout >500ms, empty response): return `{isDrift:false, suggestedAction:'continue', signalAvailable:false}`. Emit `drift_skipped_unavailable` EMF metric. **No substring fallback.** The next user message gets another shot.

9. **Emit per-stage EMF metrics** (per "Observability" section) for every invocation, regardless of outcome.

### Scoping (Security + Privacy)

The related-conversation query is the highest-risk surface here - a bug here leaks one user's summaries to another via nearest-neighbor lookup. Two requirements that are **not optional**:

**Cross-user scoping (security):**
- `channel_arn IN (:scopedChannelArns)` is enforced **inside** the WHERE clause of the vector search, never as a post-filter on results.
- A dedicated integration test creates two synthetic users (A and B) whose summaries embed close together; the test fails if A's drift query returns B's summary (or vice versa).

**Multi-member intersection scoping (privacy):**
- 1:1 channel (sender + bot): scope = sender's channel memberships. Same as today's behavior.
- Multi-member channel (sender + other human(s) + bot): scope = **intersection** of every human member's channel memberships. A related conversation can only be suggested if every current human member already has access to it. Bot/assistant memberships are excluded from the intersection set (bots are in many channels; including them would defeat the privacy boundary).

Implementation: `getScopedChannelArns(currentChannelArn): Promise<string[]>` - lists current channel members via Amazon Chime SDK, filters out bots by ARN segment (`/bot/`), takes the intersection of remaining humans' memberships via Aurora `channel_memberships` table.

A second integration test: a 3-member channel (user A + user B + bot) where A is in some channel C that B is not in, and C has a summary that would otherwise match the drift query. The test fails if drift suggests C.

### Decline-Suppression

When a user declines a drift suggestion, the auth handler stores the cosine distance value in their Lex session attributes alongside the existing `declinedTopics` list (which becomes `declinedDistances` post-rewrite - the topic name is no longer reified, so suppression keys off distance).

For the next N=3 user turns, drift won't re-fire if the new distance is within ±0.05 of any declined distance. Prevents the user from being asked twice about the same neighborhood.

### Live-Suggestion Flow

When `detectDrift()` returns `isDrift=true && suggestedAction ∈ {confirm, redirect}`:

1. **Bot emits a templated suggestion** as the user-facing reply. Two templates:
 - `confirm` (no related channel found): "It looks like you're shifting topics. Want me to start a separate conversation for this so we keep both threads clean? Reply 'yes' to create one, or anything else to keep going here."
 - `redirect` (related channel exists): "It looks like you're shifting to something we covered in another conversation. Want me to take you there? Reply 'yes' to switch, or 'no' to keep going here." Includes `NAVIGATE_CHANNEL:<arn>|<name>` marker that the frontend uses for navigation.

2. **State persists across turns** in Lex session attributes (`routingState: {pendingDriftSuggestion: {correlationId, action, rivalConversationArn?, originalUserMessageId, createdAt}}`). Backed by `conversation_creation_tasks` table for resilience across Lex session resets.

3. **Next user message:**
 - "yes" / "yeah" / "sure" / "please do" → confirm. Create the channel (for `confirm`) or navigate (for `redirect`). Original user message is passed by **reference** (the new channel's first bot message says "you were asking about [message ref]"; the user's actual text is not copied - see by-reference principle).
 - "no" / anything else recognizable as decline → store cosine distance in `declinedDistances`, clear pending state, proceed with normal agent response to the user's actual message.
 - Anything ambiguous → ask once for clarification, then default to continuing in the current channel.

4. **`drift_events` row written** with outcome `accepted` | `declined` | `rejected_in_new_channel` | `abandoned` (the last via the abandonment detector, see below).

### `drift_events` Schema (By-Reference)

The `drift_events` table (migration `006-drift-events-hardened.sql`):

```sql
CREATE TABLE drift_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  outcome TEXT CHECK (outcome IN ('declined','rejected_in_new_channel','abandoned','accepted')),
  cosine_distance NUMERIC(6,4),                   -- distance at fire time; null for non-fire telemetry
  parent_channel_arn TEXT NOT NULL,
  new_channel_arn TEXT,                            -- null when outcome IS 'declined'
  rival_conversation_arn TEXT,                     -- for redirect (existing channel match); null for confirm
  user_sub TEXT,
  originating_message_id TEXT,                     -- reference; never message body
  intent TEXT,                                     -- classified intent at fire time
  confidence TEXT CHECK (confidence IN ('low','medium','high')),
  correlation_id UUID,                             -- stitches with EMF + log lines
  signal_disagreement BOOLEAN DEFAULT FALSE,       -- reserved; LLM +DRIFT sidecar can populate this
  created_via_explicit_intent BOOLEAN DEFAULT FALSE  -- true when fast-path matched, not cosine
);
CREATE INDEX ON drift_events (occurred_at DESC);
CREATE INDEX ON drift_events (outcome, occurred_at DESC);
CREATE INDEX ON drift_events (parent_channel_arn);
```

**No `user_message` column.** Drift telemetry references the originating message by id; the body is read on-demand from the conversation archive when a human inspects the event. Erasure: when a user requests deletion, the archive scrubber Lambda nulls `originating_message_id` on `drift_events` rows for matching `parent_channel_arn` in the same transaction.

The new `summary_embeddings` table (migration `005-summary-embeddings.sql`) is keyed by `channel_arn` and stores a `vector(1024)` column with the latest summary embedding plus `embedded_at` and `embedded_from_version` for cache-invalidation tracking.

### Abandonment Detector

A scheduled Lambda runs every 5 minutes, queries `drift_events` rows where `outcome IS NULL AND new_channel_arn IS NOT NULL AND occurred_at < NOW() - INTERVAL '5 minutes'`. For each, checks message count in `new_channel_arn`; if ≤ 1 (just the bot's WelcomeIntent message, no user reply), updates `outcome='abandoned'`. The 5-minute window is conservative; tune later based on observed accept-then-engage timing.

### Per-Stage Observability (EMF)

`backend/lambda/src/lib/emf-metrics.ts` is an EMF metrics utility. Namespace `AgentEchelon/Drift`. Stage dimensions:

- `summary_fetch` - pgvector lookup latency for the summary embedding
- `message_embed` - Titan v2 call latency for the message
- `comparison` - cosine + threshold check
- `related_conv_lookup` - only when drift fires; the cosine-NN query
- `suggestion_emit` - bot's SendChannelMessage call
- `total` - wall-clock from `detectDrift()` entry to return

Plus counters: `drift_fired`, `drift_skipped_unavailable`, `drift_skipped_declined_neighborhood`, `drift_fastpath_explicit_intent`, `drift_summary_embedding_lazy_compute`.

Correlation ID (UUIDv7, time-ordered) attaches to every metric dimension + log line + the bot's outbound message metadata, so a single user message is traceable end-to-end.

Threshold alerting reuses the existing admin-notification pattern (post to admin channel with `metadata.notify={email,sms}`). Tiers: Warn (P95 > 800ms over 10 min; TPR < 90% on nightly eval) and Critical (P95 > 2000ms; TPR < 80%).

### Evaluation Suite

`tests/e2e/drift-detection.spec.ts` runs the curated dataset at `tests/e2e/fixtures/drift-detection-cases.json`:

- ≥50 drift-positive anchor→pivot pairs covering different topics, common-substring topics, abbreviations, non-English entities, technical-topic pivots, adversarial framings.
- ≥50 drift-negative messages including mention-in-passing, ambiguous referents, on-topic deeper questions.
- ≥10 prompt-injection inputs that must reach the OFF_TOPIC rejection path, not the routing path.
- Targets: ≥95% TPR, ≤5% FPR.
- Nightly CI run against dev account; deploy gate pre-flight check.

AE owns the canonical fixture at `tests/e2e/fixtures/drift-detection-cases.json`. CI gates on its SHA so the curated dataset can't drift unnoticed.

### Scope

Drift is a **per-conversation-type** property (`driftEnabled` / `isDriftEnabledForType` in `backend/lib/config/conversation-types.ts`), not a per-user-tier property; the shipped types mirror the basic/standard/premium set, so drift effectively runs across them, provided Aurora mode is enabled. Drift does not run in Athena-mode deployments - the module gates on `analyticsMode === 'aurora'` at the call-site level. This is a documentation/operational decision, not a code branch; Athena-mode just doesn't have the `summary_embeddings` table or the embedding writer Lambda.

### Interaction with `/battle` (suppression)

Drift detection is **fully suppressed in battle-enabled channels**, even when `enableLiveDrift=true` and Aurora is available. The router-agent-handler checks `ChannelBattleConfig` (the table provisioned by `/battle` per `docs/specs/capabilities/SPEC-BATTLE.md`) before invoking `detectDrift()`; if the channel has battle enabled, the live drift block is skipped entirely.

Rationale:

- Battle channels are an intentionally divergent comparison mode. Multiple variants produce responses that may semantically wander from the channel's summary on every turn; firing drift on those is a guaranteed false-positive stream.
- Two competing UI flows ("here are two answers, compare them" and "want to start a new conversation about a new topic?") confuse the user about what the channel is for.
- The user invoked battle explicitly to allow divergence; suggesting they split the conversation undercuts the feature they asked for.

Implementation: `backend/lambda/src/lib/battle-state.ts` exports `isBattleEnabled(channelArn)` with a 60-second in-memory cache. Reads `ChannelBattleConfig` from DDB. **Fails open** (returns `false` on table missing / AccessDenied / etc.) so the helper works correctly in deployments where `/battle` hasn't shipped yet - the worst case is "drift fires in a battle-enabled channel that hasn't been registered with the helper," which is a soft failure the user can ignore.

The post-hoc analytics path (kinesis-archival's `detectDrift` call) does *not* short-circuit on battle - it records analytic drift events for all messages, including battle. Rollup queries can filter on `drift_events.parent_channel_arn` against the battle-enabled channel list if the noise becomes a problem in practice; a separate `created_during_battle` column on `drift_events` can promote that filter if needed.

## Implementation

### Code

| File | Change |
|------|--------|
| `backend/lambda/src/analytics-aurora/drift-detection.ts` | Cosine similarity over pgvector embeddings. `detectDrift()` signature `(channelArn, messageId, latestMessage, intent, correlationId?)`. No substring fallback - embedding failure returns `signalAvailable:false`. |
| `backend/lambda/src/lib/explicit-routing.ts` (new) | The only legitimate string-matching path. `detectExplicitRoutingRequest(text): { matched: boolean; extractedTopic?: string }`. Unit-tested regex allowlist for unambiguous "switch to a new conversation" patterns. |
| `backend/lambda/src/lib/emf-metrics.ts` (new) | An EMF metrics utility. Namespace `AgentEchelon/Drift`. |
| `backend/lambda/src/analytics-aurora/embedding-writer.ts` (new) | Lambda that subscribes to summary-update events (existing `conversation_summaries` insert/update path in `kinesis-archival.ts`) and writes Titan v2 embeddings to `summary_embeddings`. |
| `backend/lambda/src/analytics-aurora/schema/005-summary-embeddings.sql` (new) | New `summary_embeddings` table (PK `channel_arn`, vector(1024) embedding, embedded_at, embedded_from_version). HNSW index on embedding. |
| `backend/lambda/src/analytics-aurora/schema/006-drift-events-hardened.sql` | The `drift_events` table per the by-reference design (no user message body): `correlation_id`, `signal_disagreement`, `created_via_explicit_intent`, `rival_conversation_arn`. |
| `backend/lambda/src/analytics-aurora/schema/007-conversation-creation-tasks.sql` (new) | Pending drift-suggestion state for resilience across Lex session resets. |
| `backend/lambda/src/lib/intent-classifier.ts` | Add optional `isDrift` flag derivation as a sanity-check sidecar (NOT a primary signal). Pin temperature to 0 for intent extraction. |
| `backend/lambda/src/lib/routing-state.ts` (new) | Serializes/deserializes pending drift state in Lex session attributes; reads/writes the `conversation_creation_tasks` table for backup. |
| `backend/lambda/src/lib/scoped-channels.ts` | `getScopedChannelArns(currentChannelArn)` - multi-member intersection scoping. Excludes bot ARNs from the intersection set. |
| `backend/lambda/src/analytics-aurora/kinesis-archival.ts` | Wire the embedding-writer trigger on summary-update events. |
| `backend/lambda/src/lex-fulfillment.ts` (new) | Custom Lex fulfillment Lambda for the user-message path. Classifies intent → checks for explicit-routing fast-path → calls `detectDrift()` if not skipped → on drift, emits suggestion + persists `routingState` → on confirm/decline next turn, completes the flow → otherwise dispatches to the per-tier async processor via the shared router (`router-agent-handler.ts`). Feature-flagged by `enableLiveDrift` CDK context (default `false`; flip to `true` after dev validation). |
| `backend/lambda/src/analytics-aurora/abandonment-detector.ts` (new) | Scheduled Lambda (EventBridge every 5 min) that writes `outcome='abandoned'` to stale `drift_events` rows. |
| `backend/lib/stacks/analytics-aurora-stack.ts` | Wire the new Lambdas + scheduled rule + IAM grants. |
| `backend/lib/stacks/{basic,standard,premium}-classification-stack.ts` | Wire the custom Lex intent + fulfillment Lambda into each tier's Lex bot (the FallbackIntent → shared router path), gated by the `enableLiveDrift` flag. |
| `frontend/packages/shared/src/utils/messageParser.ts` | Parse `NAVIGATE_CHANNEL:<arn>\|<name>` marker for redirect suggestions. |
| `frontend/packages/chat/src/providers/ConversationProvider.chime.tsx` | On a message carrying a NAVIGATE_CHANNEL marker, switch the active conversation when the user confirms. |

### Tests

| Test | Behavior |
|------|----------|
| Unit: `drift-detection` cosine path | Same input produces same `DriftResult` over ≥50 consecutive runs |
| Unit: `drift-detection` embedding-failure path | Bedrock 5xx → `signalAvailable:false`, no substring fallback path is exercised |
| Unit: `detectExplicitRoutingRequest` regex allowlist | Comprehensive positive + negative cases; no false matches on common phrases like "let's talk about" |
| Unit: `scoped-channels.getScopedChannelArns` | 1:1 channel scope = sender's memberships; 3-member channel scope = intersection; bot ARNs excluded |
| Integration: cross-user leakage prevention | Two synthetic users with similar summaries; A's drift query never returns B's channels |
| Integration: 3-member channel privacy | User A in private channel C; A+B+bot in current channel; drift in current channel never suggests C |
| Integration: confirm/decline flow | Full live path with confirm creates a new channel; decline stores the cosine distance in `declinedDistances` |
| Integration: bare-ack fallback | "yes please" after a drift suggestion creates the channel using `originatingMessageId` reference, not the literal "yes please" text |
| Integration: abandonment detector | Drift accepted but no follow-up message → `outcome='abandoned'` written within 10 min |
| Integration: decline-suppression | Decline at distance 0.40, next message at distance 0.41 → no re-fire; next message at distance 0.50 → re-fires |
| E2E: full drift flow against dev account | Playwright test that sends a pivot message in a seeded channel, confirms the suggestion, lands in the new channel |
| Eval suite: drift-detection-cases.json | ≥95% TPR / ≤5% FPR on the curated dataset; nightly CI gate |

## Design notes

- **Why a Lex intent, not a Bedrock Agent Action Group.** The confirm/decline flow uses a custom Lex intent + fulfillment Lambda because it gives deterministic confirm/decline state. A Bedrock Agent Action Group would push that determinism into the agent's reasoning, which is harder to make reproducible.
- **Threshold tuning.** The 0.35 distance / 0.80 redirect-similarity values are stake-in-the-ground defaults, tuned empirically against the eval suite.
- **`+DRIFT` sanity-check sidecar.** Reserved: the LLM's drift flag is stored on `drift_events.signal_disagreement` when it disagrees with the cosine signal, but does not override the cosine decision. It feeds eval-suite calibration and is not a gating signal.

## Scale - Where This Design Breaks

Drift detection is per-message overhead on the live path: one embedding call + one PK lookup + one cosine-NN query + N ListChannelMembership calls. The per-message cost stays constant; the bottlenecks emerge at scale on specific dimensions.

| Scale tier | Channel count | Daily message volume | First bottleneck | Mitigation |
|---|---|---|---|---|
| **Small** | <1k channels | <10k msgs/day | None - design works as specified | n/a |
| **Medium** | 1k - 50k | 10k - 500k | Bedrock Titan v2 embedding latency on the critical path (~50-100ms per call adds to TTFR) | Add a summary-embedding DDB cache (write-through, 24h TTL backstop). The first post-launch optimization |
| **Large** | 50k - 500k | 500k - 5M | Aurora memory pressure: pgvector HNSW index outgrows the minimum-ACU shared_buffers (~1GB at 0.5 ACU). At ~250k summary embeddings × 4KB/row + 2-3× index overhead, the index no longer fits in memory and queries hit disk | Raise Aurora Serverless v2 min ACU (config in `analytics-aurora-stack.ts`); document the breakpoint in `docs/guides/admin/AURORA-MODE-GUIDE.md` |
| **Large** (parallel) | - | Same | Bedrock per-account/region TPS throttling on Titan v2 - sustained throttle = drift skipped per-message via the `signalAvailable:false` path. Bedrock resilience layer handles retries but sustained throttle is a real signal degradation | Request a quota increase, or move to Bedrock provisioned throughput for embedding endpoints |
| **Huge** | >500k | >5M | Multi-member intersection scoping fan-out. For a 50-member channel where each user has 1000+ channels, `getScopedChannelArns()` makes 50 Amazon Chime SDK `ListChannelMemberships` calls (each paginated). This adds ~500ms-1s of latency to the critical path | Per-user-memberships cache (Aurora or DDB), invalidated on `CreateChannelMembership` / `DeleteChannelMembership` events. Or: precompute a `scoped_channels_cache` table keyed by `(channelArn, computed_at)` and refresh on a TTL |

### Specific load math

**Storage (linear in channel count):**
- 1024-dim Titan v2 float embeddings: 4KB raw per summary embedding row
- HNSW index overhead: ~2-3x raw data size
- At 1M channels: ~4GB embeddings + ~10GB index. Aurora Serverless v2 needs ≥4 ACU (8GB RAM) to keep the working set hot; otherwise queries page from disk and P95 climbs from <50ms to seconds

**Bedrock TPS:**
- Default Titan v2 quotas are typically 100-300 TPS per region per account at launch
- One embedding call per non-skipped user message. Premium-tier users at peak: ~1 message every 30s on average; bursts higher
- At sustained 200 concurrent premium users sending continuously: ~6-7 TPS. Well under quota. Burst protection (1000 users hitting Enter simultaneously) is what trips throttling
- **Practical breakpoint:** sustained traffic of ~50+ messages/second through drift starts approaching default quotas. Quota increase request is straightforward AWS support ticket

**Aurora cosine-NN query cost:**
- HNSW index lookup on scoped set is `O(log N)` in the scoped set size, not the full table
- Single user with 1000 channels (their scope = their 1000 summary embeddings): ~5-10ms typical
- Multi-member channel with intersection of 50 users × 1000 channels each: intersection may shrink to <100 channels (the channels everyone shares), making the actual query *faster*; but the membership intersection computation itself is the slow part

**Per-user channel-list growth (the real long pole at extreme scale):**
- A user accumulating channels over years: 10k channels per user means 10k-row scope per query
- Each Amazon Chime SDK `ListChannelMemberships` page is 50 channels = 200 paginated calls for that user
- Per-call latency ~50ms = 10s of latency added to the critical path
- This is the strongest argument for a per-user-memberships cache. Not in launch scope: launch deployers won't have users with 10k channels

### What this design does *not* address

- **Multi-tenant scale.** A single AE deployment serving many tenants will hit Aurora limits before any single tenant does. Per-tenant scaling requires the v1.0+ multi-tenant Aurora architecture (currently P3 in ROADMAP).
- **Cross-region replication of summary embeddings.** Drift is region-local. Cross-region failover would lose drift state until the embedding writer Lambda backfills. Acceptable for a launch product; revisit when there's a customer running multi-region.
- **Embedding model churn.** Titan v2 → v3 (when Amazon releases it) requires re-embedding all existing summaries. The migration is offline-rebuild. No mitigation needed pre-launch; document the operational procedure when relevant.

### Pre-launch operational targets (conservative)

For reference-deployment cost estimates in the README, target these load assumptions:

- 100 active channels
- ≤1k daily messages across all channels
- P95 drift TTFR < 500ms (single-digit % overhead on top of bot response latency)
- Aurora min ACU: 0.5 (default); summary_embeddings + index well under 50MB at this scale
- Bedrock Titan v2 cost at 1k embeddings/day ≈ $0.02/day (negligible)

These are baseline numbers. The Scale tiers table above shows what changes as deployers grow beyond the reference deployment.

## Rollback

Every behavior change sits behind an SSM-parameter feature flag mirroring the `FORMS_CIRCUIT_PARAM` pattern.

| Item | Flag | Default | Rollback action |
|------|------|---------|-----------------|
| Live drift path | `DRIFT_LIVE_ENABLED` (also CDK context `enableLiveDrift`) | `closed` (open after dev validation) | Set `closed` to revert to analytics-only drift |
| Templated suggestion | (always on; no flag) | n/a | Revert the templated copy if it fails user testing |
| Embedding writer | `DRIFT_EMBEDDING_WRITER_ENABLED` | `closed` (open after backfill) | Set `closed` to halt writes; reads fall back to lazy-compute path |
| `drift_events` schema migration | n/a - schema change is not flagged | Applied during CDK deploy | Forward-only; rollback = revert the migration + redeploy |

After each flag flip, watch the per-stage EMF metrics for ≥30 min before declaring the rollback successful.

## Validation

- `summary_embeddings` populates within 60s of a `conversation_summaries` insert. HNSW index used by EXPLAIN ANALYZE.
- `detectDrift()` over identical inputs produces identical `DriftResult` (excluding `correlationId`) across ≥50 consecutive runs. The embedding-failure path returns `signalAvailable:false` and emits the skip metric.
- Integration tests: the A→B leakage test fails with a deliberate bug and passes with the SQL `IN` filter; the multi-member test prevents cross-member channel disclosure.
- With `DRIFT_LIVE_ENABLED=open`, posting a pivot message triggers a templated suggestion; confirming creates a new channel; declining stores the distance and stays put; bare "yes please" creates the channel with the original message reference.
- An accepted-but-abandoned drift transitions to `outcome='abandoned'` within 10 minutes of the 5-minute window expiring.
- The eval suite reports ≥95% TPR / ≤5% FPR on the curated dataset in CI, passing on two consecutive nights.

## References

- Project constraint: no string-matching for semantic signals
- Titan v2 embeddings at 1024-dim; pgvector cosine search
