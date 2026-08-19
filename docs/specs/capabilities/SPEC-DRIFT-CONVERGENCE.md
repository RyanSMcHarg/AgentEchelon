# SPEC: Drift Detection

**Status:** Partial. **Built:** the embedding-based signal, the confirm/decline and new-channel flow, the scheduled summary updater, related-conversation retrieval, the per-stage telemetry, the first-turn summary seed ([ADR-019](../../design/decisions/019-conversation-summary-seeded-on-first-turn.md), verified live 2026-07-29), active-task suppression, and the drift health surface (accuracy from post-hoc evaluation + acceptance) - all in Aurora mode, with the live-suggestion path behind `enableLiveDrift`. **Design, NOT built:** the known-topic suppression (decision-flow question 2) and the `conversation_topic_embeddings` store it needs; the `rejected_in_new_channel` outcome, which has no writer; erasure of the message reference on deletion (no scrubber exists); threshold alerting; and the nightly eval-suite CI gate. Sections describing those are marked inline.

**Coverage:** `e2e/drift-detection.spec.ts`

**Problem and who it's for:** When a user pivots to a new topic mid-conversation, the thread's context and summary stop matching what they are asking, degrading replies and muddying analytics - and catching that reliably otherwise means building your own drift detection. This serves the end user (offered a clean "split this into a new conversation" flow) and the AI developer (who gets a deterministic, embedding-based drift signal with per-stage telemetry and an eval suite) without standing up that harness. It computes cosine distance between the message and conversation-summary embeddings via pgvector, scoped by the intersection of all members' access, and never falls back to keyword matching.

**Site section:** Core platform, capabilities (platform feature; not a pillar; the drift signal - its config seam, thresholds and live-drift enablement, is conversation-config).


Drift detection is an embedding-based drift path. The live-suggestion path is gated behind the `enableLiveDrift` CDK context flag (Aurora mode only); the post-hoc analytics drift signal runs by default in Aurora mode.

The signal is embedding-based throughout: no substring or keyword matching feeds a semantic signal (a project constraint). Embeddings are Titan v2 at 1024-dim, and pgvector provides the cosine search.

**Execution (ADR-013).** The embedding and pgvector work (`detectDrift`, `recordDriftFire`, `recordDriftOutcome`) runs inside the VPC-attached retrieval **data-plane Lambda**, which the non-VPC agent handler invokes synchronously. The handler orchestrates the suggestion and any conversation creation but is itself not VPC-attached. Retrieval (RAG) shares the same data-plane Lambda. See `docs/guides/developer/RAG.md` and `docs/guides/admin/INFRASTRUCTURE-COST.md`.

**Where to look when debugging.** Because `detectDrift` executes in the data-plane Lambda, all drift EMF counters (namespace `AgentEchelon/Drift`) and `[Drift]` log lines land in the DATA-PLANE log group, not the agent handler's. Searching the handler's logs for drift returns nothing and looks exactly like the feature being switched off. Two consequences worth knowing: the handler bundle carries only the thin `invoke('detectDrift', ...)` client, so changing `analytics-aurora/drift-detection.ts` requires deploying the ANALYTICS stack (deploying only the assistant-profile stacks ships an inert change); and `logGateExit` in `live-drift-flow.ts` logs once per container, so its absence never proves drift ran.

---

## What drift detection is

Drift detection - "the user pivoted to a different topic; offer to split the conversation" - is a flagship AE capability. It is built on embedding-based cosine similarity at the conversation level, with deterministic scoring, per-stage observability, and multi-member privacy scoping.

## Capabilities

1. AE provides **live drift detection** with a user-facing suggestion + confirm/decline + new-channel-creation flow, built on the embedding-based design (no substring matching).
2. The signal is **`cosine_distance(message_embedding, summary_embedding)`** computed via pgvector against Titan v2 embeddings. Single number. Deterministic.
3. On embedding-call failure, the fallback is **"no drift this turn"** - never a substring/keyword path. The signal is skipped; the next message gets another shot.
4. **String matching survives in exactly one place:** `detectExplicitRoutingRequest` as a fast-path optimization for unambiguous explicit user intent ("let's switch to a new conversation about X"). This skips the embedding round-trip and routes immediately. It is not a drift signal; it is a UX latency optimization for explicit user requests.
5. `drift_events` schema is **by-reference** - references the originating message by id, never stores the user message body. (Erasure of that reference on a deletion request is designed, NOT built - see the schema section.) This applies to the ANALYTICS record. It does not apply to the new conversation's welcome, which quotes the message back to the person who wrote it - see the welcome section below and the erasure note there.
6. Retrieval of related conversations (`findRelatedConversations`) uses cosine-NN over summary embeddings, **scoped at SQL level by the intersection of all human channel members' memberships** in the current channel. This is a security boundary (cross-user leakage) and a privacy boundary (multi-member channel leakage).
7. Per-stage EMF metrics + correlation IDs make every drift event traceable end-to-end in CloudWatch. (The admin console surfaces the drift EVENT list and the health rates; a per-stage P50/P95/P99 latency view and per-event false-drift notifications are NOT built.)
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

### Decision flow

Every turn resolves four questions IN ORDER. Each one can end the turn, so the expensive steps only run when the cheap ones have already justified them.

1. **Is the user moving off the current topic?** Compare the message embedding against this conversation's summary embedding. Below threshold, the turn ends here and nothing else is computed. This is the only question that runs on every turn, and the only context it needs is the current conversation's own topic (plus any in-progress task, which anchors the turn just as the summary does - a user answering a task's clarifying question is on-topic by definition, however far the wording sits from the conversation summary).

2. **Is the new topic already a topic of THIS conversation?** A conversation legitimately covers several topics, and returning to an earlier one is not drift. Compare the message embedding against the per-topic embeddings held for THIS conversation and take the nearest. If it sits within the same-topic threshold of any topic already established here, do NOT offer a new conversation - the user is circling back, not leaving. This is cosine over embeddings, exactly like every other stage; it is NOT `topics[]` string overlap (see "String matching in the design", which rejects topics-array matching by name).

3. **Is the topic already discussed in another of the user's conversations?** Only if steps 1 and 2 agree this is a genuine pivot. Cosine-NN over `summary_embeddings`, scoped by the member-intersection boundary. On a match, ask whether they want to CONTINUE there (`suggestedAction: 'redirect'`, `rivalConversationArn` set) rather than creating a duplicate thread.

4. **Otherwise, offer to create a new conversation** and redirect the user into it (`suggestedAction: 'confirm'`).

Step 1 is the foundation: steps 2 through 4 are all refinements of what to DO about a pivot, and none of them run until step 1 has established that a pivot happened. Build and validate step 1 first.

### Summary Updater (Prerequisite)

Drift detection requires `conversation_summaries` rows to compare against; without a summary updater, every drift call hits `drift_skipped_no_summary` and the feature cannot function. A summary-updater Lambda writes these rows.

**Trigger** - two paths, seed then incremental:

**1. First turn (seed).** The `conversation_summaries` row is created on the conversation's FIRST turn, at the same point the conversation is named. Naming and summarising describe the same first exchange, so they are one write, and the conversation carries a comparison anchor from turn one onward. This is the load-bearing path for drift: without it a new conversation has nothing to compare against, and the early turns - exactly the window where a user is most likely to pivot - all skip with `drift_skipped_no_summary`.

The seed writes the same `{name, summary, purpose, topics[], key_points[]}` shape as an incremental update, at `version = 1`, from the first user message and the assistant's reply alone. It is a genuine summary of a one-exchange conversation, not a placeholder, so the embedding it produces is directly comparable to later versions.

**The seed does not read a message store.** The reply handler ALREADY HOLDS the first user message and the assistant's reply in memory at the moment it responds, so the seed is composed from those directly. Reading them back from Aurora `messages` would be both redundant and self-defeating: that table is a derived projection fed by Kinesis then the archival Lambda, so a seed that waited for it would inherit exactly the lag that leaves early turns without an anchor. The authoritative conversation is Amazon Chime SDK Messaging; Aurora is a projection of it, and neither needs to be consulted for content the handler is already carrying.

Mechanically the seed rides the existing data-plane seam (ADR-013): the non-VPC reply handler calls a `seedSummary` op on the VPC-attached data-plane Lambda, which owns the Aurora write, the Bedrock summarisation, and the embedding. No new VPC endpoint or egress path is introduced - this is the same seam `detectDrift` and `getSummary` already use.

**2. Incremental updates (time-based scan).** EventBridge fires the Lambda on a fixed schedule (`SUMMARY_UPDATER_INTERVAL_MIN`, default 30). On each run, the Lambda finds channels whose newest message is newer than their newest summary:

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

The scan still handles a channel that has never been summarized, so it remains the backstop if the first-turn seed failed (Bedrock error, cold Aurora). Channels with no activity since their last summary are excluded - no wasted Bedrock calls.

No fire-and-forget invocation from kinesis-archival. The kinesis archival path stays a pure write to `messages`; the first-turn seed and the time-based scan own all summary generation. (Archival could not trigger summarisation in any case: it runs VPC-attached in isolated subnets with `natGateways: 0` and there is no `lambda` interface endpoint, so it has no way to invoke anything. The seed is initiated from the NON-VPC reply handler instead, which is both the component that already holds the content and the one with an existing path to the data plane.)

**Open question - the source for INCREMENTAL summaries.** The scheduled updater reads Aurora `messages`, a derived projection. Summary quality, and therefore drift sensitivity, silently degrades whenever archival is incomplete, with no signal distinguishing "the conversation covered little" from "we did not receive the messages." Amazon Chime SDK Messaging (or the S3 conversation archive, which is the system of record) is authoritative and would remove that failure mode. Not resolved here; the seed above is unaffected either way because it never reads a store.

**Latency implication:** drift is available from the second turn onward, because the first-turn seed guarantees an anchor. The FIRST turn always skips with `drift_skipped_no_summary` - drift is evaluated in the reply path before that turn's exchange has been summarised - so that counter is expected to track the new-conversation rate rather than sit at zero (see Observability). What the schedule bounds is summary FRESHNESS, not availability: between scheduled runs the stored summary can lag the newest messages by up to one interval, so a conversation that has already wandered over many turns is compared against a slightly older anchor. That affects sensitivity, not whether the signal runs. Deployers who need tighter freshness lower `SUMMARY_UPDATER_INTERVAL_MIN`.

**Algorithm** (per channel):

1. SELECT recent messages from `messages` table since the last summary's `updated_at`, capped at the most recent 50 (Haiku context is fine for 50 turns).
2. SELECT the current `conversation_summaries` row (if any) for the channel - used as anchor context so the LLM does incremental summarization rather than re-summarizing from scratch.
3. Call Bedrock Haiku with a structured prompt that returns JSON: `{summary, purpose, topics[], key_points[]}`. Temperature 0 for determinism.
4. UPSERT into `conversation_summaries` with `version = previous + 1`, `message_count = total_messages_in_channel`, `updated_at = NOW()`. Race-safe via `WHERE version = previous_version` conditional update.
5. Generate Titan v2 embedding of the new `summary` text, UPSERT into `summary_embeddings` with `embedded_from_version = version`.
   - *(NOT BUILT - design, for the known-topic check.)* Then embed each entry of `topics[]` individually and replace this channel's rows in `conversation_topic_embeddings` at the same `embedded_from_version`, so step 6b compares against topics rather than against their average. Topic embedding batches in one Bedrock call set per summary write, so the added cost scales with topic count (typically 3-6), not with turns.
6. Emit EMF metrics: `summary_updater_run`, `summary_updater_skipped_no_changes`, `summary_updater_bedrock_failure`, per-stage latencies.

**Idempotency** - the embedding write checks `WHERE embedded_from_version < $newVersion` so duplicate invocations don't re-embed. The summary write uses `WHERE version = $previousVersion` so the second concurrent writer gets a no-op (the first writer wins the increment).

**Failure modes** - every step is best-effort. If Bedrock fails, the channel keeps its previous summary and the writer tries again on the next trigger. Per-channel circuit-breaker state is not needed; the threshold trigger naturally rate-limits retries.

**Cost** - at the reference-deployment scale (100 channels, 1k messages/day), this runs ~10 times/day. Bedrock Haiku is ~$0.25/M input tokens; one summary call is ~3k input tokens ≈ $0.0008. Daily cost: ~$0.01. Negligible.

### Detection Algorithm

```typescript
async function detectDrift(input: DetectDriftInput): Promise<DriftResult>

interface DetectDriftInput {
  channelArn: string;
  messageId: string;
  latestMessage: string;
  intent: IntentType;           // Skip drift on GREETING, ACKNOWLEDGMENT, OFF_TOPIC
  correlationId?: string;       // UUIDv7. Generated when omitted
  userClearance?: 'basic' | 'standard' | 'premium'; // EMF dimension; metrics aggregate across clearances when omitted
  declinedDistances?: number[]; // Cosine values recently declined; a distance inside any +/-0.05 band suppresses
  activeTaskInProgress?: boolean; // Skip the cosine path while a task awaits this user's answer
}
```

Algorithm:

1. **Skip conditions** (early-return `{isDrift:false, suggestedAction:'continue', signalAvailable:true}`):
 - Intent in `{GREETING, ACKNOWLEDGMENT, OFF_TOPIC}`.
 - Channel has no `conversation_summaries` row yet (no anchor to compare against). Emits `drift_skipped_no_summary`. This is the NORMAL path on a conversation's first user turn: drift runs before that turn's exchange has been summarised, and the seed is written afterwards. Drift is live from turn two onward - see Summary Updater.
 - User previously declined a drift suggestion with a cosine distance within ±0.05 of what this turn's distance will be (decline-suppression - see below).
 - **A live task exists for this user in this channel** (status `pending` or `in_progress`). Emits `drift_skipped_active_task`. Checked AFTER the explicit-routing fast-path and BEFORE the summary fetch and the embed call, so a suppressed turn costs no Bedrock round-trip. See "Active-task suppression" below.

2. **Explicit routing fast-path:** if `detectExplicitRoutingRequest(latestMessage)` matches (e.g., regex like `/^(let'?s\s+)?(start|switch to|move to|open) a (new|separate) (conversation|channel|chat)\s+(about|for|on)\s+(.+)$/i`), return `{isDrift:true, suggestedAction:'redirect', confidence:'high', signalAvailable:true}` immediately. Emit `drift_fastpath_explicit_intent` EMF metric. This is the **only** string-matching path. Pattern lives in `lib/explicit-routing.ts` with a unit-tested allowlist.

3. **Embed the latest message.** Call Bedrock `InvokeModelCommand` for Titan v2 at 1024-dim. Hard timeout 500ms.

4. **Load the conversation's summary embedding** from the `summary_embeddings` table (PK `channelArn`). If absent, fall back to computing it on the fly from `conversation_summaries.summary` (rare path - only happens before the embedding writer has caught up on a brand-new conversation; emit `drift_summary_embedding_lazy_compute` EMF).

5. **Compute cosine distance** in SQL via pgvector (`<->` operator) or in Lambda - Lambda is simpler since both vectors are already available; pgvector is needed only for the related-conversation NN lookup (step 7).

6. **Threshold decision.** Compare distance against the `DRIFT_DISTANCE_THRESHOLD` environment variable (default `0.35`, sensible range 0.25-0.45, tuned by the eval suite). Above threshold → drift; below → continue. This answers decision-flow question 1. (This spec previously documented an SSM param `/agent-echelon/drift/distance-threshold`; no code reads that path, so tuning it had no effect. The knob is deploy-time env config on the data-plane Lambda - `analytics-aurora/drift-detection.ts`, `DRIFT_DISTANCE_THRESHOLD`. Moving it to SSM would make it runtime-tunable, which is worth doing, but the doc must not describe it as if it already is.)

6b. **Known-topic check (decision-flow question 2). NOT BUILT - design.** Before treating an over-threshold distance as a pivot, compare the message embedding against the per-topic embeddings for THIS conversation (`conversation_topic_embeddings`, below) and take the minimum distance. If that nearest-topic distance is within the same-topic threshold, return `{isDrift:false, suggestedAction:'continue'}` and emit `drift_skipped_known_topic`.

  This is a cosine comparison against stored vectors, not a `topics[]` string or array-overlap test - the `topics[]` field is the LLM's human-readable labelling of what got embedded, never the matching key. Keeping it embedding-based is what preserves the spec's single-string-matching-site invariant.

  Why the extra comparison exists: the summary embedding is an AVERAGE over everything the conversation covers, so in a genuinely multi-topic conversation every individual topic sits some distance from that average. Distance-from-summary therefore rises whenever the user moves between the conversation's OWN subjects, and step 6 alone would fire a suggestion each time they switch back and forth. Comparing against the topics individually is what separates "returning to something we already discuss here" from "leaving for something new."

7. **Related-conversation lookup (decision-flow question 3, only if drift fires and 6b did not suppress it).** SQL cosine-NN against `summary_embeddings`:

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
- A dedicated unit test (`backend/test/lib/scoped-channels.test.ts`) covers two users whose summaries would embed close together; it fails if A's scope includes B's channel (or vice versa).

**Multi-member intersection scoping (privacy):**
- 1:1 channel (sender + bot): scope = sender's channel memberships. Same as today's behavior.
- Multi-member channel (sender + other human(s) + bot): scope = **intersection** of every human member's channel memberships **and the serving assistant's**. A related conversation can only be suggested if every current human member already has access to it AND the assistant answering is itself in it.

**The serving assistant is an intersection term, not an exclusion.** Leaving it out makes the scope "channels every human shares", which can include a conversation this assistant was never added to - and the related-conversation lookup reads summaries directly from Aurora, where no Amazon Chime SDK membership check applies. The scope IS the access control, so an assistant could surface a conversation it is not in, including across profiles (two people sharing a basic and a premium channel would let the premium assistant reach the basic one). Adding a term to an AND can only NARROW the result, so this is strictly safer; an earlier rationale that excluded bots "because they are in many channels" had it backwards - that argument applies to using a bot as the search SEED, never as an intersection term. Other bots in the room are still not seeds: one bot's membership says nothing about who may see what.

Verified against the live API (2026-08-08): a bot ARN is accepted as a `MEMBERS` value and genuinely AND-filters. Same user and bearer - human alone returned 29 channels; human plus each of two bots sharing those channels returned 29; human plus each of two bots that share none returned 0. The zeros are the control: an ignored term would leave every count at 29, and an OR would never fall below it.

Because the assistant occupies one of the filter's value slots, the cap is on HUMANS (`MAX_HUMANS_IN_FILTER`), one below the filter bound.

**Implementation: `resolveScopedChannelArns(input): Promise<string[]>`** (`backend/lambda/src/lib/scoped-channels.ts`). It lists the current channel's members live via `ListChannelMemberships`, keeps only `/user/` ARNs (bots are in many channels; including them would defeat the boundary), and asks Amazon Chime SDK for the intersection.

**The intersection is never computed from the Aurora archive.** The archive is filled asynchronously by the Kinesis path, and **both lag directions leak, precisely when membership has just changed**: a member who joined but is not projected yet is left out, so the scope comes out WIDER than the people in the room; a channel someone was removed from that is still projected stays in their set. The one failure mode this control exists to prevent is the one a lagging copy produces. The archive remains useful for analytics; it is never the authority for a live access decision (ADR-012).

Two paths, both live and both authoritative:

1. **`SearchChannels` with `MEMBERS ... INCLUDES` (primary).** Several values are an AND - "channels that include ALL of these members" - so the intersection is computed by the service that OWNS membership. The search must bear one of the members: the service rejects any other bearer (`AppInstanceUser must include its own ARN for MEMBERS field`), and a bot is not an AppInstanceUser. Which member does not change the answer, since every member of the intersection is in every channel it contains.
2. **Retry with a different bearer.** `SearchChannels` refuses when the SEARCHING user belongs to too many channels (`Primary search user ... exceeds channel membership limit to perform search`; measured on the reference deployment, the refusal came at **1038 channels**). Only the BEARER is limit-checked, and the answer is bearer-independent - every member of the intersection is in every channel it contains - so the same question is simply put to the next member. Any other error is about the request itself and would fail identically for every member, so it is not retried.

**When EVERY human is over the limit, the scope is empty and drift suggests nothing.** A per-member intersection (each member's own channel list) can compute the human part without the search, and was built and deployed on 2026-08-08 - then removed. Two reasons, and the second is the one that matters: it shipped inert (the role carried no `chime:ListChannelMembershipsForAppInstanceUser` grant, so it threw `AccessDeniedException` on first contact), and it intersected HUMANS ONLY, so it could not apply the assistant term and would answer a WIDER question than the primary path on exactly the heaviest accounts. A fallback less safe than the path it backs up is worse than no fallback. Reinstating it requires a way to apply the assistant term.

**Every case it cannot answer returns an empty scope, meaning suggest nothing:** no human members, more members than one filter can express, a failed membership read, a failed search whose cause is not the membership limit, or a member whose own list cannot be read. Dropping an unreadable member would WIDEN the intersection, which is the one direction that discloses.

**It runs on the ROUTER, not in the data plane.** `detectDrift` executes in `DataPlaneLambda` (isolated subnets, no Chime endpoint, no NAT), where a Chime call would hang to the timeout. `DetectDriftInput.scopedChannelArns` is supplied by the caller; absent means no suggestion, by design.

A second case in the same suite: a 3-member channel (user A + user B + bot) where A is in some channel C that B is not in. The test fails if C appears in the multi-member scope.

### Active-Task Suppression

A live task (`pending` or `in_progress`) means the assistant is mid-workflow and has asked this
user for something: report requirements, an outline approval, troubleshooting symptoms, a
scheduling slot. The user's next turn is the ANSWER, and an answer is a continuation of the
thread - not a pivot away from it.

The cosine signal cannot see that, because it compares one message against the summary. An
answer is typically a short fragment that repeats none of the summary's topic words
("Audience is engineering leadership. Focus on delivery velocity, code ownership, and CI
cost."), so it lands FAR from the anchor and fires drift on the exact turn the assistant
solicited. Observed once on 2026-07-30 mid-`report_generation`, where it cost the flow a turn and
interrupted the user with an offer to split the conversation. Not reproduced since: the same e2e
path across three later runs recorded `drift_fired = 0` with the suppression active, which is the
expected result but does not by itself re-demonstrate the original failure.

The router resolves the live task for task continuation anyway, so it passes
`activeTaskInProgress` into `detectDrift` and no extra read is incurred.

Scope of the suppression, deliberately narrow:

- It suppresses the COSINE path only. The explicit-routing fast-path is checked FIRST, so a
  user who deliberately says "start a separate conversation about X" mid-task still gets one.
  A long-running task must never become a trap.
- It does not touch the pending-suggestion branch. A user answering an outstanding yes/no is
  always honoured.
- It is per-channel and per-user, and it lifts as soon as the task reaches a terminal state.

`drift_skipped_active_task` is expected to be nonzero on any deployment that uses multi-turn
tasks; unlike `drift_skipped_no_summary` it is not an alertable condition. A drift precision
dashboard should read it as "correctly declined to interrupt", not as lost coverage.

### A fired suggestion ANSWERS the turn

A fired suggestion is not an annotation on the reply. It IS the reply: `runLiveDriftFlow` returns a
Lex response and the router returns it immediately, so the agent flow never runs. The turn is served
without conversation history, without a model call, and without the assistant's persona. That is the
intended shape - a pivot is worth interrupting for - but it makes a false positive expensive, because
the question the user actually asked is never answered at all.

Two consequences follow, and both are properties to design against rather than defects to fix:

- **A false positive costs a whole turn.** The user must decline before their question is answered.
  The e2e suites reflect this: a spec asserting an answer has to recognise the suggestion text
  ("shifting topics", "separate conversation") and decline before re-asking.
- **The interception is logged.** The router logs its delivery decision only AFTER the drift check
  returns, so an intercepted turn previously left a log trace identical to a turn that failed to
  dispatch - the same absence of a `deliveryOption` line and the same absence of a processor
  invocation. `runLiveDriftFlow` logs the fire (intent, suggested action, distance, event id) so the
  two are distinguishable. Without it, a "the assistant forgot the previous turn" report cannot be
  told apart from "drift answered instead", and the natural reading of the logs is the wrong one.

**The first follow-up is the highest-risk turn.** The first-turn summary seed
([ADR-019](../../design/decisions/019-conversation-summary-seeded-on-first-turn.md)) gives drift an
anchor from turn one, closing the `drift_skipped_no_summary` window. The anchor it provides
summarises a SINGLE exchange, and the turn immediately after it is the one most likely to be a short
question referring BACKWARDS into that exchange. Measured on the reference deployment: a summary
seeded four seconds after the opening reply, then a follow-up asking for a detail stated in that
opening turn, which scored past the threshold and fired (`drift_fired`, intent `GENERAL`).

This is the same false-positive class as active-task suppression above: cosine reads a short
referential question as distant because it repeats none of the anchor's topic words, and cannot
distinguish "asking about what we just discussed" from "changing the subject". Active-task
suppression covers that class only while a task is live. The uncovered case - a backward-referencing
follow-up in an ordinary conversation, against a single-exchange anchor - is not currently
suppressed, and widening the threshold is not the answer to it: the distance is genuinely large, and
what is wrong is treating a one-exchange anchor as equally authoritative as an established topic.

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
 - "yes" / "yeah" / "sure" / "please do" → confirm. Create the channel (for `confirm`) or navigate (for `redirect`). The new conversation opens with the ORDINARY composed welcome, carrying the drift context - see "What the new conversation opens with" below.
 - "no" / anything else recognizable as decline → store cosine distance in `declinedDistances`, clear pending state, proceed with normal agent response to the user's actual message.
 - Anything ambiguous → ask once for clarification, then default to continuing in the current channel.

4. **`drift_events` row written** with outcome `accepted` | `declined` (at the prompt), or `abandoned` (via the abandonment detector, see below). `rejected_in_new_channel` is in the enum but **no code path writes it** - see the health-metric section.

### What the new conversation opens with

A drift-created conversation opens with the **ordinary composed welcome**, not a message written by the drift flow. `createConversationFromDrift` posts nothing into the child: it stamps the drift context into channel `Metadata` and the assistant's `WelcomeIntent` renders it through the same composer every other conversation uses (see [`SPEC-WELCOME-AND-CONTEXT.md`](../interaction/assistant-config/SPEC-WELCOME-AND-CONTEXT.md)).

`WelcomeIntent` fires on the assistant's **automatic** channel membership, which it acquires by being the `CreateChannel` bearer. No explicit `CreateChannelMembership` is needed or made, and this is not opt-out-able: verified against live Chime, a channel created by a bot bearer with no membership call at all receives the welcome within seconds.

The welcome carries four things, each from channel `Metadata` written at creation:

| Metadata field | In the welcome |
|---|---|
| `triggerContext` | the topic: "This conversation continues from `<topic>`" |
| `priorMessage` | the user's own message, quoted under "You asked:" |
| `parentChannelArn` | a link back to the conversation this continued from |
| `originatingMessageId` | anchors that link to the specific message |

**How the originating message is identified.** Amazon Chime SDK sends exactly three Lex request attributes - `CHIME.channel.arn`, `CHIME.sender.arn` and `x-amz-lex:channels:platform` (WelcomeIntent omits the sender) - measured across every classification. `CHIME.message.id` is not among them, so the id cannot be passed through and is instead read back from the parent channel and matched **by the exact text of the message being handled**, newest first. It is deliberately not "the sender's most recent message": that is a near-miss for the same thing, and a second message sent while the turn is in flight would anchor the link to the wrong one. A link that points at the wrong message is worse than no link, because it still looks live - so when no content match is found in the recent window the id is left empty and the welcome links to the conversation instead. This requires `chime:ListChannelMessages` on the assistant role, classification-scoped like its other channel reads.

The topic is derived from the triggering message with its conversational preamble removed, so "let's start a new conversation about quarterly revenue forecasting" titles the conversation `quarterly revenue forecasting`. A fixed placeholder was used before, which made every drift conversation identical in the sidebar.

**The user's message IS quoted here, and that is a deliberate exception to the by-reference principle.** Showing someone their own words is how they confirm the assistant picked up the right thread rather than having to trust a paraphrase. The consequence has to be carried: this is a second copy of text that already exists in the parent, so **redacting or deleting the original does not remove it**. Anything that erases a message must reach the copies. The by-reference rule still holds where it was aimed - the `drift_events` analytics row stores an id, never a body.

### Navigating between the two conversations

Both directions are needed, and they use different mechanisms because only one of them is durable.

- **Child to parent:** the welcome's link, built from `parentChannelArn` and `originatingMessageId`. Part of the message body, so it survives any re-read.
- **Parent to child:** a message the drift flow posts into the parent carrying `driftRedirect: { childChannelArn, label }` in **message Metadata**.

The parent side needs Metadata rather than link text because the confirm reply reaches the parent through Lex, and a Lex-delivered message cannot carry Chime message Metadata. That reply instead carries a `NAVIGATE_CHANNEL:` marker, which the client consumes once to switch conversations and `stripMessageMarkers` then removes for display - so on a later re-read the announcement is there and the way to reach what it announced is not. The Metadata-carrying follow-up is what makes the link durable, and it deliberately does not repeat the marker, so the switch still happens exactly once.

### `drift_events` Schema (By-Reference)

The `drift_events` table (migration `006-drift-events-hardened.sql`):

```sql
CREATE TABLE drift_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  outcome VARCHAR(32) CHECK (outcome IN ('declined','rejected_in_new_channel','abandoned','accepted')),
  cosine_distance NUMERIC(6,4),                   -- distance at fire time; null for non-fire telemetry
  parent_channel_arn VARCHAR(256) NOT NULL,
  new_channel_arn VARCHAR(256),                    -- null when outcome IS 'declined'
  rival_conversation_arn VARCHAR(256),             -- for redirect (existing channel match); null for confirm
  user_sub VARCHAR(128),                           -- the BARE sub, never the full AppInstanceUser ARN
  originating_message_id VARCHAR(128),             -- reference; never message body
  intent VARCHAR(64),                              -- classified intent at fire time
  confidence VARCHAR(16) CHECK (confidence IN ('low','medium','high')),
  correlation_id UUID,                             -- stitches with EMF + log lines
  signal_disagreement BOOLEAN DEFAULT FALSE,       -- reserved; LLM +DRIFT sidecar can populate this
  created_via_explicit_intent BOOLEAN DEFAULT FALSE  -- true when fast-path matched, not cosine
);
CREATE INDEX ON drift_events (occurred_at DESC);
CREATE INDEX ON drift_events (outcome, occurred_at DESC);
CREATE INDEX ON drift_events (parent_channel_arn);
```

**No `user_message` column.** Drift telemetry references the originating message by id; the body is read on-demand from the conversation archive when a human inspects the event.

**Erasure - NOT BUILT (design).** The intended path is: when a user requests deletion, an archive
scrubber nulls `originating_message_id` on `drift_events` rows for matching `parent_channel_arn` in
the same transaction. **No scrubber exists** - there is no erasure Lambda anywhere in the codebase,
so nothing currently removes the message reference. The by-reference design limits the exposure to an
id rather than message text, but it does not by itself satisfy a deletion request. The same claim is
asserted as built in the `COMMENT ON TABLE drift_events` in migration `006`; that comment is wrong
and should be corrected when the scrubber lands or the comment is next touched.

The new `summary_embeddings` table (migration `005-summary-embeddings.sql`) is keyed by `channel_arn` and stores a `vector(1024)` column with the latest summary embedding plus `embedded_at` and `embedded_from_version` for cache-invalidation tracking.

**NOT BUILT - design.** `conversation_topic_embeddings` would hold ONE ROW PER TOPIC per conversation: `(channel_arn, topic_key, embedding vector(1024), topic_label, embedded_from_version)`, PK `(channel_arn, topic_key)`, HNSW index on `embedding`. It backs the known-topic check (algorithm step 6b). Each entry is the embedding of one topic the summariser identified; `topic_label` is the human-readable string carried for display and debugging only and is never used as a matching key. Rows are replaced for a channel whenever a new summary version is written, so the topic set tracks the conversation as it grows. Being per-conversation and member-scoped by the same channel boundary as `summary_embeddings`, it introduces no new access surface.

The distinction from `summary_embeddings` is the point: one averaged vector per conversation cannot answer "is this one of the things we already talk about here," because the average is not near any single topic in a conversation that covers several.

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

Plus counters: `drift_fired`, `drift_skipped_intent` (the intent short-circuit of algorithm step 1), `drift_skipped_unavailable`, `drift_skipped_declined_neighborhood`, `drift_skipped_no_summary`, `drift_skipped_active_task`, `drift_fastpath_explicit_intent`, `drift_summary_embedding_lazy_compute`, and `drift_signal_disagreement` (the `+DRIFT` sidecar's disagreement with the cosine call) - all defined in `lib/emf-metrics.ts`. (`drift_skipped_known_topic` is referenced by the unbuilt step 6b and does NOT exist yet; it lands with that work.)

`drift_skipped_no_summary` needs care to alarm on, because **a nonzero rate is normal**. Drift runs
in the reply path on the FIRST user turn, before that turn's exchange exists to summarise; the seed
is written afterwards, by the async processor, once the reply is composed. So every new conversation
contributes exactly one `drift_skipped_no_summary`, and the counter tracks the new-conversation rate.
Verified live 2026-07-30: 6 new conversations produced 6 skips and 6 successful seeds.

The alertable condition is therefore **skips materially exceeding new conversations**, or skips
without a matching `[summary-updater][seed] seeded v1`, which means seeds are failing and drift is
silently inert for those conversations - that presents exactly like the feature being switched off.
Alarming on "nonzero" instead will fire on healthy traffic.

### The metric that matters: was the offer right, and was it taken

Drift volume answers "how often did users change topic", which is a fact about users, not about this
feature. It is not a health metric and must not be presented as one: a high number is not a problem
and a low number is not success.

Health is two questions about an offer that was made, and nothing else:

| Question | Metric | Source |
|---|---|---|
| **1. Was the detection accurate?** | `evaluated_correct / evaluated` | The evaluation runner's Pass C judges each offer post-hoc and writes the verdict to `drift_events` |
| **2. Did the user accept it?** | `accepted / offered` | `drift_events`: one row per offer, `outcome='accepted'` set at the prompt |

They are kept SEPARATE on purpose. A user can decline a perfectly correct call (busy, mid-thought)
and can accept a bad one; blending them into a single number hides which half is failing, which is
the one thing an operator needs to know. Anything richer (decline vs abandon breakdowns, per-intent
slicing) is a later refinement, not the headline.

**Accuracy is a judgement about the CALL, so it comes from evaluation, not from user reaction.** Pass
C of the evaluation runner selects live offers with `evaluated_at IS NULL`, reads the originating
message BY REFERENCE from `messages` (the same by-reference principle the schema is built on) plus
the conversation summary that was the detector's anchor, and asks the judge one question: was this
message genuinely a new subject deserving its own conversation. The prompt deliberately does NOT
include the outcome - telling the judge the user declined would turn accuracy into a second measure
of user reaction. A judge response that cannot be parsed, or that omits a boolean verdict, leaves
`evaluated_at` NULL so the offer stays unmeasured and is retried, rather than being recorded as a
wrong call.

Accuracy's denominator is offers **judged**, not offers made, so a growing unjudged backlog cannot
read as falling accuracy. The console shows that backlog separately.

**Only `source='live'` rows count.** `recordDriftFire` is called from two places: the live path,
where a suggestion is shown to a user, and the kinesis archival pass, which scores historical
messages and shows nothing to anyone. Both wrote identical rows until migration 016. Counting the
archival rows would inflate the denominator with offers nobody could accept and that never settle
(the abandonment detector only touches rows with a `new_channel_arn`), and a message that fired live
drift is re-scored on archival, so the same event produced two rows. Rows written before 016 have
`source` NULL and are excluded rather than guessed at.

Two presentational rules the surface MUST hold, because breaking either recreates the exact problem
this section exists to remove:

- A rate with a **zero denominator renders "No data", never 0%**. An empty window is not a perfect one.
- A metric with **nothing judged yet renders "Not measured", never a number**. For accuracy
  specifically, both 0% and 100% would be claims no evaluation supports.

**Status: Implemented.** Both rates are computed and surfaced on the Conversations > Drift view, and
`drift_score` is demoted to per-event detail. No good/bad colouring is applied, because no target has
been agreed for either rate and colouring one would assert a threshold the product has not set.

**On `rejected_in_new_channel`:** the outcome exists in the enum and the schema CHECK constraint but
**no code path writes it**, and its definition is contradictory - the migration's column comment says
"user accepted, then declined again in the new channel" while the working plan says "accepted, moved,
then came BACK". Neither question above needs it, since accuracy comes from evaluation. If it is ever
wired, settle the definition first and make the schema comment agree.

**Verified by:** `backend/test/analytics-aurora/drift-offer-eval.test.ts` (Pass C judges only live
offers with an archived message body, records the verdict, and records NOTHING when the judge output
is unparseable or omits a boolean - so an unjudgeable offer stays unmeasured rather than counted
wrong; and the prompt carries the summary and message but never the outcome) and
`frontend/packages/admin/src/components/admin/driftHealth.test.ts` (both rates, zero-denominator
handling, accuracy measured over the judged subset, and that acceptance is never blended into
accuracy).

Correlation ID (UUIDv7, time-ordered) attaches to every metric dimension + log line + the bot's outbound message metadata, so a single user message is traceable end-to-end.

**Threshold alerting - NOT BUILT (design).** The intent is to reuse the existing admin-notification pattern (post to admin channel with `metadata.notify={email,sms}`), with tiers Warn (P95 > 800ms over 10 min; TPR < 90% on nightly eval) and Critical (P95 > 2000ms; TPR < 80%). No drift alarms exist today, and the TPR tiers additionally depend on the nightly eval run, which is also not built.

### Evaluation Suite

`tests/e2e/drift-detection.spec.ts` runs the curated dataset at `tests/e2e/fixtures/drift-detection-cases.json`:

- ≥50 drift-positive anchor→pivot pairs covering different topics, common-substring topics, abbreviations, non-English entities, technical-topic pivots, adversarial framings.
- ≥50 drift-negative messages including mention-in-passing, ambiguous referents, on-topic deeper questions.
- ≥10 prompt-injection inputs that must reach the OFF_TOPIC rejection path, not the routing path.
- Targets: ≥95% TPR, ≤5% FPR.

The spec and the fixture agree: it ships exactly 50 drift-positive, 50 drift-negative and 10
prompt-injection cases.

**Not built: the CI gating.** `.github/workflows/ci.yml` has no drift reference, so there is no
nightly run against the dev account, no deploy-gate pre-flight check, and no SHA gate on the fixture.
The suite exists and can be run on demand; nothing runs it automatically or fails a build on it, so
the TPR/FPR targets above are aspirations rather than enforced thresholds.

AE owns the canonical fixture at `tests/e2e/fixtures/drift-detection-cases.json`.

### Scope

Drift is a **per-conversation-type** property (`driftEnabled` / `isDriftEnabledForType` in `backend/lib/config/conversation-types.ts`), not a per-user-tier property; the shipped types mirror the basic/standard/premium set, so drift effectively runs across them, provided Aurora mode is enabled. Drift does not run in Athena-mode deployments - the module gates on `analyticsMode === 'aurora'` at the call-site level. This is a documentation/operational decision, not a code branch; Athena-mode just doesn't have the `summary_embeddings` table or the embedding writer Lambda.

### Interaction with `/battle`: the battle blocks the ACTION, not the detection

**A battle turn is an ordinary turn, so detection runs exactly as it does anywhere else.** What a battle changes is what happens when drift fires: instead of offering to split the conversation, the assistant says the duel is still running and names the two ways out - let the battle finish, or have a moderator turn Battle Mode off - and then answers the user's question in place. Nothing is recorded: no drift row, no durable task, no pending suggestion, because there is no offer to accept or decline and an outcome would be a fiction. If the user persists, the next turn detects again.

An acceptance made BEFORE Battle Mode was switched on is **held, not honoured and not discarded**: acting on it would create the new conversation and walk the user out of a duel in progress, so the pending suggestion stays in place and a later "yes" still works.

`runLiveDriftFlow` (`lib/live-drift-flow.ts`) reads `isBattleEnabled(channelArn)` against `ChannelBattleConfig` once per turn and threads the result, so detection and both branches agree even if a moderator toggles Battle Mode mid-turn.

**This replaced a blanket gate** that returned before `detectDrift()` ran. It was cheaper and it was silent: a user who changed the subject mid-duel got no suggestion and no explanation, which reads as the product ignoring them, so they retype the pivot. Suppressing the whole capability was also a battle-specific divergence in a feature that is meant to behave identically everywhere.

Why the OFFER is withheld:

- Two competing flows ("here are two answers, compare them" and "want to start a new conversation about a new topic?") leave the user unsure what the conversation is for, and acting on the second abandons a duel whose sides are mid-round.
- Assistant replies are not what drift measures. The signal is `cosine_distance(message_embedding, summary_embedding)` over the USER's latest message, so two variants answering at length do not themselves move it; the earlier "guaranteed false-positive stream" rationale attributed the firing to the wrong side of the conversation.

Why the EXPLANATION is given rather than silence: the user asked for something and got nothing back, with no way to tell whether the request was heard, refused, or lost. Naming the state and its two exits is the difference between a rule and a dead end.

Implementation: `backend/lambda/src/lib/battle-state.ts` exports `isBattleEnabled(channelArn)` with a 60-second in-memory cache. Reads `ChannelBattleConfig` from DDB. **Fails open** (returns `false` on table missing / AccessDenied / etc.) so the helper works correctly in deployments where `/battle` hasn't shipped yet - the worst case is "drift fires in a battle-enabled channel that hasn't been registered with the helper," which is a soft failure the user can ignore.

The post-hoc analytics path (kinesis-archival's `detectDrift` call) does *not* short-circuit on battle - it records analytic drift events for all messages, including battle. Rollup queries can filter on `drift_events.parent_channel_arn` against the battle-enabled channel list if the noise becomes a problem in practice; a separate `created_during_battle` column on `drift_events` can promote that filter if needed.

## Implementation

### Code

| File | Change |
|------|--------|
| `backend/lambda/src/analytics-aurora/drift-detection.ts` | Cosine similarity over pgvector embeddings. `detectDrift()` takes the single `DetectDriftInput` object above. No substring fallback - embedding failure returns `signalAvailable:false`. |
| `backend/lambda/src/lib/explicit-routing.ts` (new) | The only legitimate string-matching path. `detectExplicitRoutingRequest(text): { matched: boolean; extractedTopic?: string }`. Unit-tested regex allowlist for unambiguous "switch to a new conversation" patterns. |
| `backend/lambda/src/lib/emf-metrics.ts` (new) | An EMF metrics utility. Namespace `AgentEchelon/Drift`. |
| `backend/lambda/src/analytics-aurora/embedding-writer.ts` (new) | Lambda that subscribes to summary-update events (existing `conversation_summaries` insert/update path in `kinesis-archival.ts`) and writes Titan v2 embeddings to `summary_embeddings`. |
| `backend/lambda/src/analytics-aurora/schema/005-summary-embeddings.sql` (new) | New `summary_embeddings` table (PK `channel_arn`, vector(1024) embedding, embedded_at, embedded_from_version). HNSW index on embedding. |
| `backend/lambda/src/analytics-aurora/schema/006-drift-events-hardened.sql` | The `drift_events` table per the by-reference design (no user message body): `correlation_id`, `signal_disagreement`, `created_via_explicit_intent`, `rival_conversation_arn`. |
| `backend/lambda/src/analytics-aurora/schema/007-conversation-creation-tasks.sql` (new) | Pending drift-suggestion state for resilience across Lex session resets. |
| `backend/lambda/src/lib/intent-classifier.ts` | Add optional `isDrift` flag derivation as a sanity-check sidecar (NOT a primary signal). Pin temperature to 0 for intent extraction. |
| `backend/lambda/src/lib/routing-state.ts` (new) | Serializes/deserializes pending drift state in Lex session attributes; reads/writes the `conversation_creation_tasks` table for backup. |
| `backend/lambda/src/lib/scoped-channels.ts` | `resolveScopedChannelArns(input)` - multi-member intersection scoping, computed LIVE by Amazon Chime SDK (`SearchChannels`, falling back to per-member channel lists above the search-user membership limit). Excludes bot ARNs from the intersection set. Never reads the Aurora archive. Runs on the router, not the data plane. |
| `backend/lambda/src/analytics-aurora/kinesis-archival.ts` | Wire the embedding-writer trigger on summary-update events. |
| `backend/lambda/src/router-agent-handler.ts` + `backend/lambda/src/lib/live-drift-flow.ts` | The Lex fulfillment path for user messages. The router is the single fulfillment hook for every classification; it classifies intent and delegates the drift turn to `runLiveDriftFlow`, which checks the explicit-routing fast-path, suppresses on a battle-enabled channel or a live task, calls `detectDrift()`, emits the suggestion and persists `routingState`, completes the confirm/decline on the next turn, and otherwise leaves the turn to the per-profile async processor. Feature-flagged by `enableLiveDrift` CDK context (default `false`; flip to `true` after dev validation). |
| `backend/lambda/src/analytics-aurora/abandonment-detector.ts` (new) | Scheduled Lambda (EventBridge every 5 min) that writes `outcome='abandoned'` to stale `drift_events` rows. |
| `backend/lib/stacks/analytics-stack-aurora.ts` | Wire the new Lambdas + scheduled rule + IAM grants. |
| `backend/lib/stacks/agent-classification-common.ts` | Wire the Lex intents + the shared router fulfillment hook (the FallbackIntent → shared router path) and the data-plane invoke grant, gated by the `enableLiveDrift` flag. The per-classification stacks (`{basic,standard,premium}-classification-stack.ts`) are thin wrappers that pass their classification into this shared construct. |
| `frontend/packages/shared/src/utils/messageParser.ts` | Parse `NAVIGATE_CHANNEL:<arn>\|<name>` marker for redirect suggestions. |
| `frontend/packages/chat/src/providers/ConversationProvider.chime.tsx` | On a message carrying a NAVIGATE_CHANNEL marker, switch the active conversation when the user confirms. |

### Tests

| Test | Behavior |
|------|----------|
| Unit: `drift-detection` cosine path | Same input produces same `DriftResult` over ≥50 consecutive runs |
| Unit: `drift-detection` embedding-failure path | Bedrock 5xx → `signalAvailable:false`, no substring fallback path is exercised |
| Unit: `detectExplicitRoutingRequest` regex allowlist | Comprehensive positive + negative cases; no false matches on common phrases like "let's talk about" |
| Unit: `scoped-channels.resolveScopedChannelArns` | 1:1 channel scope = sender's memberships; 3-member channel scope = intersection; bot ARNs excluded; every unanswerable case returns an EMPTY scope (failed membership read, failed search, no humans, over the filter cap, unreadable member list); the membership-limit fallback intersects per-member lists and an unrelated `BadRequestException` does NOT take it. **Verified by:** `backend/test/lib/scoped-channels.test.ts` (10) |
| Integration: cross-user leakage prevention | Two synthetic users with similar summaries; A's drift query never returns B's channels |
| Integration: 3-member channel privacy | User A in private channel C; A+B+bot in current channel; drift in current channel never suggests C |
| Integration: confirm/decline flow | Full live path with confirm creates a new channel; decline stores the cosine distance in `declinedDistances` |
| Integration: bare-ack fallback | "yes please" after a drift suggestion creates the channel using `originatingMessageId` reference, not the literal "yes please" text |
| Integration: abandonment detector | Drift accepted but no follow-up message → `outcome='abandoned'` written within 10 min |
| Integration: decline-suppression | Decline at distance 0.40, next message at distance 0.41 → no re-fire; next message at distance 0.50 → re-fires |
| Unit: active-task suppression | A far-from-summary answer with `activeTaskInProgress:true` does NOT fire and costs no DB/Bedrock call; the SAME message with `false` DOES fire; an explicit routing request still fires while a task is live. **Verified by:** `backend/test/analytics-aurora/drift-detection.test.ts` ("a live task suppresses the cosine signal") |
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
| **Large** | 50k - 500k | 500k - 5M | Aurora memory pressure: pgvector HNSW index outgrows the minimum-ACU shared_buffers (~1GB at 0.5 ACU). At ~250k summary embeddings × 4KB/row + 2-3× index overhead, the index no longer fits in memory and queries hit disk | Raise Aurora Serverless v2 min ACU (config in `analytics-stack-aurora.ts`); document the breakpoint in `docs/guides/admin/AURORA-MODE-GUIDE.md` |
| **Large** (parallel) | - | Same | Bedrock per-account/region TPS throttling on Titan v2 - sustained throttle = drift skipped per-message via the `signalAvailable:false` path. Bedrock resilience layer handles retries but sustained throttle is a real signal degradation | Request a quota increase, or move to Bedrock provisioned throughput for embedding endpoints |
| **Huge** | >500k | >5M | Multi-member intersection scoping fan-out. For a 50-member channel where each user has 1000+ channels, the per-member FALLBACK path makes one paginated `ListChannelMembershipsForAppInstanceUser` call per human (the primary `SearchChannels` path makes one call regardless of member count, so this cost applies only above the search-user membership limit). This adds ~500ms-1s of latency to the critical path | Per-user-memberships cache (Aurora or DDB), invalidated on `CreateChannelMembership` / `DeleteChannelMembership` events. Or: precompute a `scoped_channels_cache` table keyed by `(channelArn, computed_at)` and refresh on a TTL |

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
