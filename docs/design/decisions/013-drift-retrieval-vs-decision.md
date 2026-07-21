---
title: "ADR-013: Drift = pgvector retrieval + reasoning decision; reply handler stays out of the VPC"
status: Proposed 2026-06-07
date: 2026-06-07
related:
  - SPEC-DRIFT-CONVERGENCE.md
  - 006-drift-detection-shape.md
  - AURORA-MODE-GUIDE.md
  - "../../backend/lambda/src/lib/scoped-channels.ts"
  - "../../backend/lambda/src/lib/live-drift-flow.ts"
  - "../../backend/lib/stacks/analytics-stack-aurora.ts"
supersedes: |
  Amends the live-drift portion of SPEC-DRIFT-CONVERGENCE. The drift
  RESULT-SHAPE contract (ADR-006) is unchanged. What changes is (a) how the
  live signal is computed (retrieval vs decision split) and (b) where it
  runs (the reply handler leaves the VPC).
tracking: |
  Partially implemented. Done: the reasoning gate (`lib/drift-reasoning.ts`,
  unit-tested) and the `enableLiveDrift` default flipped to OFF. Remaining:
  Data-API/async retrieval, client-event outcome emission, the observability
  changes (drift_events schema migration + analytics query + ConversationsTab
  rationale rendering), and moving `auroraDriftWiring` off the VPC. Until that
  lands, live drift stays OFF in Aurora mode.
---

# ADR-013: Drift = pgvector retrieval + reasoning decision; reply handler stays out of the VPC

## Status

Proposed. Triggered by the first live Aurora-mode deploy, which surfaced a runtime failure that synth-only validation never could.

## Context

Underneath the machinery, this decision serves two things a user feels directly: the assistant should tell a genuine topic-change from a relevant tangent - so it only offers "want a separate conversation for this?" when that actually helps, not on every related follow-up - and any cross-conversation context it draws on must stay within the privacy boundary of who shares the conversation. Getting that judgment right, and safe, is the point. Three findings forced the decision on how.

**1. The live-drift re-homing broke agent replies in Aurora mode.** The live-drift re-homing (`auroraDriftWiring`) VPC-attaches each per-tier agent handler to `PRIVATE_ISOLATED` subnets so it can run a synchronous pgvector cosine query against Aurora in the reply path. The first live Aurora deploy proved this severs the handler's egress to Amazon Chime SDK Messaging: an isolated-subnet Lambda has no route to Amazon Chime SDK (Amazon Chime SDK exposes no PrivateLink endpoint, and the VPC is built with `natGateways: 0`). The handler reaches Bedrock fine (there is a `bedrock-runtime` VPC endpoint, so intent classification worked) but `SendChannelMessage` hangs until the 30s Lambda timeout, every turn. The e2e suite saw `{"Code":429}` and 3 agent-response tests failed; auth/signup/greeting passed. Un-VPCing the handlers (`enableLiveDrift=false`, deployed `--exclusively`) restored egress and the suite went 24/24.

**2. Cosine similarity is the wrong instrument for the drift DECISION.** Embedding similarity is too blunt -- semantically similar messages can mean very different things contextually, so the judgment needed is inherently reasoning, not similarity. Example: "Do they have consulting roles too?" inside a `job_opportunity` conversation is a relevant tangent, not drift, but cosine distance cannot tell a relevant tangent from real drift. The better pattern folds the drift signal into the existing Haiku `classifyIntent()` call (intent + drift in one call) and keeps pgvector only for cross-channel *search* (retrieval), not the decision. This critique applies directly to AE: SPEC-DRIFT-CONVERGENCE makes the live drift signal `cosine_distance(message_embedding, summary_embedding)` against a threshold -- i.e. AE uses similarity for the exact judgment that needs reasoning.

**3. Privacy scoping belongs in SQL, not per-processor app code.** When a user's other-conversation summaries are injected into the system prompt, the safe pattern guards the injection with a membership-intersection filter (inject a conversation only if every current-channel human is also a member of it, fail-safe exclude). The failure mode of doing this in app code is asymmetry: the guard gets applied in one processor and forgotten in another, which is exactly how per-processor app-code scoping drifts out of consistency. AE avoids the whole class by enforcing the scope at the SQL level: `scoped-channels.ts` computes the all-human-member intersection and applies it inside the vector-search `WHERE` clause (the channel-scoping privacy decision), so no caller can bypass it by forgetting a filter. This is a reason to keep AE's retrieval design. For completeness, AE's *other* cross-channel prompt path -- `buildCrossChannelTasksHint` -- is aggregate-only by design (it emits counts like "N active tasks in other conversations", never conversation names or ARNs), so it is not an equivalent exposure.

## Decision

Keep AE's pgvector investment, but use each tool for the sub-problem it actually fits, and stop running it inside the VPC-bound reply handler.

1. **Split retrieval from decision.**
 - **Retrieval** ("which of the user's other conversations relate to this
     message?") is a *similarity* problem. Keep **pgvector cosine** over Titan
     v2 embeddings. It is deterministic, measurable, model-independent (the
     basic tier gets the same rigor as premium), scales past the context
     window, and is eval-suite-able. **AE already has this half**:
     `findRelatedConversations` is a cosine-NN retrieval, SQL-scoped by the
     member intersection (`SPEC-DRIFT-CONVERGENCE.md` step 6). So this ADR does
     not build retrieval -- it keeps `findRelatedConversations` and changes only
     the decision instrument below.
 - **Drift decision** ("is this drift, or a relevant tangent?") is a
     *reasoning* problem. Gate the user-facing "you've drifted -- want a
     separate conversation?" suggestion on an **LLM judgment**, ideally
     piggybacked on the existing intent-classify call, so it adds ~no extra
     model hop. Cosine becomes the cheap pre-filter that selects candidates;
     reasoning makes the call.

2. **The reply handler stays OUT of the VPC.** Reach Aurora for the retrieval query via the **RDS Data API** (HTTPS, no VPC attachment) or via an **async** signal (the already-isolated embedding/archival Lambda computes the retrieval result and writes a lightweight, **TTL'd** flag -- e.g. a DynamoDB item with a short expiry, since the drift signal is ephemeral and single-turn; the next non-VPC turn reads the flag and surfaces the suggestion). Either way the handler keeps its Amazon Chime SDK egress. No NAT gateway (it would force a VPC topology change that replaces the VPC and the Aurora cluster).

3. **Privacy scope stays enforced in SQL**, never in per-processor app code. Keep `scoped-channels.ts` and the all-human-member intersection inside the vector-search `WHERE` clause.

4. **`enableLiveDrift` defaults to `false`.** Revert `bin/backend.ts` so a plain `cdk deploy --all -c analyticsMode=aurora` does not silently enable the broken live path. This matches `AURORA-MODE-GUIDE.md`, which already documents the default as `false` (opt-in). The async/archival drift telemetry path is unaffected and stays on in Aurora mode.

5. **Record the outcome as a client-event, not an Aurora write in the reply path.** `recordDriftFire` / `recordDriftOutcome` currently write to Aurora `drift_events` from inside `live-drift-flow.ts` -- a SECOND Aurora coupling in the reply handler (beyond the cosine read), and another reason the handler was VPC-attached. The cleaner pattern measures drift via a `drift` **client-event** emitted through the existing telemetry path. AE should adopt it: the reply handler emits a drift client-event (fire + chosen outcome) through the already-built client-events pipeline (`eventTrackingService` -> `/events` -> Firehose), so the reply path makes **no Aurora write** and needs no VPC for observability. The richer `drift_events` row (for the admin analytics layer) is persisted **async** off that stream, not synchronously in the handler.

## Consequences

- Drift becomes a hybrid that is strictly better than today: measurable, SQL-scoped retrieval plus a reasoning decision.
- Athena-mode deployments can get a baseline drift for the first time -- the reasoning gate needs no pgvector, only the conversation's *purpose* to judge against, and that lives in **channel metadata** (the `topic` set at creation by `create-conversation`, see SPEC-WELCOME-AND-CONTEXT), not the Aurora summary. So the prompt/reasoning signal can ship in Athena mode; pgvector retrieval remains the Aurora-mode advanced layer. This fits the analytics-mode contract (Athena = basic, Aurora = advanced). (Without a per-conversation purpose in metadata, the reasoning gate degrades to generic-topic judgment -- still usable, less precise.)
- The reply path no longer pays a synchronous DB round-trip; retrieval is Data-API or async.
- Work required: move the drift DB access off the direct VPC/pg connection to the Data API (or async signal), add the reasoning gate, remove the VPC attachment from the tier handlers, and revert the bin default. Then redeploy Aurora mode and re-run the eval suite + e2e with live drift ON.

## Observability and admin-console / API impact

Moving the decision from a cosine score to a reasoning verdict ripples into the observability surface, which the first cut of this ADR missed. The point of the "measurability" pro is only real if the admin console actually surfaces drift effectiveness, and effectiveness is the **outcome** (suggested -> accepted / declined / abandoned), not the raw signal.

**What exists today (AE):**
- Schema `drift_events` (migration 006) stores `cosine_distance NUMERIC(6,4)` as the fire-time signal, plus `outcome` (`accepted` / `declined` / `rejected_in_new_channel` / `abandoned`), `rival_conversation_arn`, `was_explicit`, `correlation_id`.
- Admin console: `frontend/packages/admin/src/components/admin/ConversationsTab.tsx` has a "Drift Detection" view; `driftBadge(score)` buckets the **cosine score** (>=0.7 High Drift / >=0.4 Moderate / else On Topic) and an unresolved-count badge. So the UI is coupled to a cosine number that the reasoning gate no longer produces.

**The target pattern:** no cosine `drift_events` table for the decision -- track a `drift` client-event (frontend telemetry of the outcome) and a retrieval analytics action for the redirect lookup. Effectiveness is the aggregated outcome, not a score. This fits a reasoning decision (there is no score to store) and keeps the reply path Aurora-free.

**Required changes (this is part of ADR-013, not a follow-on):**
1. **Schema migration.** Make `cosine_distance` nullable / decision-irrelevant and add the reasoning fields the decision now produces: `verdict` (drift / stay), `rationale TEXT` (the human-auditable reason -- this is what makes effectiveness *inspectable*, which a cosine score never was), and `confidence`. Keep `outcome` and the redirect fields unchanged. If a retrieval similarity is recorded for the redirect target, store it in its own column, clearly scoped to retrieval, not the decision.
2. **Analytics query / API.** The `drift_events` query that feeds the admin console returns the new shape (rationale + outcome instead of a cosine score). Keep the queryType name stable; change the projected columns.
3. **Admin console.** Replace `driftBadge(score)` with a verdict + **rationale** display, and make the effectiveness view the outcome rates (fire count, accept / decline / abandon %) over time, with the rationale available for spot-checking false positives. This is strictly better for "observing effectiveness" than a cosine bucket -- a deployer can read *why* the model called drift and judge it.
4. **Outcome emission.** Per Decision item 5, the fire + outcome are emitted as a `drift` client-event through the existing client-events pipeline; the `drift_events` row is persisted async off that stream, not synchronously in the reply handler.

`docs/specs/capabilities/SPEC-DRIFT-CONVERGENCE.md` (which specs the cosine-signal `DriftResult` and the `drift_events` shape) and `metricTargets.ts` (drift targets) must be updated alongside the schema. ADR-006 (the cross-repo `DriftResult` shape) is affected: the result gains a `rationale` and the cosine field becomes retrieval-scoped -- note the contract change there when this lands.

## Alternatives rejected

- **Pure pgvector cosine for the drift decision (current SPEC).** The bluntness critique holds: similarity is the wrong instrument for the tangent-vs-drift judgment. Retained only for retrieval.
- **NAT gateway / Amazon Chime SDK VPC endpoint to keep the handler VPC-attached.** No Amazon Chime SDK PrivateLink exists. Adding NAT means giving the isolated VPC public subnets + IGW + NAT, which replaces the VPC and the Aurora cluster -- destructive and ~$32/mo -- to solve a problem that decoupling removes for free.
- **Prompt-only drift (drop pgvector entirely).** Loses AE's determinism, measurability, model-independence, and SQL-level privacy scoping. AE's retrieval rigor is a genuine advantage worth keeping.

## Open doc/code gaps surfaced by this ADR

- The channel-scoping privacy decision referenced in `scoped-channels.ts` + `SPEC-DRIFT-CONVERGENCE.md` step 6 has no dedicated ADR file yet. It should be filed (it is the privacy invariant this ADR depends on).
- `bin/backend.ts` defaults `enableLiveDrift` ON in Aurora mode while `AURORA-MODE-GUIDE.md` documents the default as `false`. Decision item 4 reconciles them in favor of the doc.
