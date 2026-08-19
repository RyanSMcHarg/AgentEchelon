# SPEC: Abuse Controls (rate limiting, spend budgets, request dedup)

**Status:** Implemented, with two of the five controls opt-in and OFF unless configured, and **one control partially implemented**. Request dedup covers replays of a single dispatch on every path, and covers duplicate *deliveries* of one user message on `/battle` (a durable claim on `deriveBattleId`), within a single warm container on `@all`, and on the normal path through the router's derived correlation id ([ADR-022](../../design/decisions/022-message-identity-is-established-at-the-channel-flow.md)). **The normal-path claim is asserted at unit level only** and has not been exercised end to end against a deployment, so it is not described as verified. The property it rests on - that a retried fulfillment replays the same transcript - is confirmed from production logs (two fulfillments of one turn, 2.6 seconds apart, byte-identical transcript); what remains unproven is the suppression path as a whole. **Always on** (no configuration required beyond the shared table): the per-user hourly rate limit (the ceiling is the profile's `rateLimitPerHour` - basic 60, standard 120, premium 240), and the inbound length cap. **Opt-in, and inert until set**: the per-user and global spend budgets (`BEDROCK_USER_HOURLY_BUDGET` / `BEDROCK_GLOBAL_HOURLY_BUDGET`, both `0` by default) and the SSM circuit breaker (`ABUSE_CIRCUIT_PARAM`, unset by default). A deployment that leaves the budgets at `0` has a request-rate ceiling but **no spend ceiling**. Every control is additionally a no-op when `ABUSE_CONTROLS_TABLE` is unset.

**Coverage:** `e2e/abuse-controls.spec.ts` - asserts the shared control table is wired to the deployed handler (without it every control silently returns "allowed"), and that a user at the hourly ceiling receives the rate-limit notice instead of a model answer. The spend budgets and the SSM circuit are opt-in and reported rather than asserted, since a deployment may legitimately leave them unset.

**Verified by:** `backend/test/lib/abuse-controls.test.ts` asserts the control-plane behavior against a mocked table - request dedup (first-claim true, duplicate false, fail-open), the per-user + global spend budget (fail-open per-user vs fail-safe global), the per-user hourly rate limit, the inbound length cap, and the shared `evaluateAbuseGate` order (rate before budget, message selection, admin exemption). `backend/test/cdk-synth.test.ts` asserts the wiring: the shared table env + DynamoDB write grant + length cap on the classification handlers and the channel-flow processor, and that the spend budget + SSM circuit are opt-in (no value / no grant unless a global budget is set).

**Not established by that coverage:** the dedup tests assert the claim mechanism against a mocked table, passing the key in directly. They do not exercise how the key is DERIVED at runtime, so they pass whether or not the derived key is stable, and they did not detect that the normal path derives a fresh key per delivery. Closing the inbound gap above requires coverage that drives a duplicate delivery through the derivation, not a unit test of the claim.

**Problem and who it's for:** Without cost and abuse ceilings, one automated client, a traffic spike, or a bug can run up unbounded model spend and let a single user monopolize the assistant, while duplicate message deliveries double-bill and can corrupt task state - and the alternative is assembling your own rate-limiting, spend-budget, and dedup layer. This protects the admin/operator (who owns the account and its bill) and every end user (whose fair share of the assistant is preserved). It adds a shared, admin-exemptable control plane in front of every profile: per-user and global spend budgets with a circuit breaker, a per-rung hourly rate limit, request dedup, and an inbound length cap.

**Site section:** Core platform, ops (cross-cutting operations; not a pillar). **Scope:** A shared, admin-exempt control plane that bounds per-user and global request volume, caps model spend with a global circuit breaker, deduplicates duplicate message deliveries, and clamps oversized input. It sits in front of the per-tier async processors and shares one small DynamoDB table. Applies to every tier.

## Why

The platform's control model separates two concerns: *reliability* (how a model failure is handled) and *cost and abuse* (whether a call is allowed to happen at all). The stack implements the first and this spec defines the second, so the two compose in one place.

- **Present (reliability):** Bedrock retry with exponential backoff, a per-model circuit breaker that skips to the fallback model, model fallback, and a self-hosted-tool-loop iteration cap (`MAX_TOOL_ITERATIONS`). See `lambda/src/lib/bedrock-resilience.ts`.
- **This spec (cost / abuse):** a per-user rate limit, a per-user and global model-spend budget, request deduplication, and an inbound message-length cap.

The concerns this layer addresses, by impact:

1. **Global spend budget.** Without a global ceiling, a bug, an automated client, or a traffic spike drives model spend with nothing to trip. A global hourly budget plus a circuit breaker bounds total cost.
2. **Per-user rate limit.** Without a per-user ceiling, one client can monopolize the assistant, raising cost and degrading service for others. An hourly per-tier quota keeps usage fair.
3. **Request dedup.** Amazon Chime SDK and Lex deliver at least once, so a single user message can be fulfilled more than once. Each duplicate is a second model call (double cost) and can corrupt task state: without a key shared by both, two fulfillments of one message carry two independent correlation ids, so the losing async invocation cannot find its placeholder and overwrites a `completed` task with `failed`. See "Request deduplication" below.
4. **Inbound length cap.** An oversized message inflates token cost and widens the prompt-injection surface.

## Design

### Shared control table

A single DynamoDB table, `AbuseControlsTable`, owned by `foundations-stack.ts` and published on the shared SSM contract next to the task tables (`resolveSharedSSM`). Generic schema so one table backs every control:

- Partition key `pk` (string). Namespaced per control: `dedup#fulfil-<correlationId>` (fulfillment claim, written by the router), `dedup#<correlationId>` (dispatch claim, written by the async processor), `corr#<correlationId>` (placeholder mapping, written by the channel flow, see [ADR-022](../../design/decisions/022-message-identity-is-established-at-the-channel-flow.md)), `ratelimit#<userSub>#<hourKey>`, `budget#user#<userSub>#<hourKey>`, `budget#global#<hourKey>`.
- `ttl` (number, epoch seconds), with DynamoDB TTL enabled so entries self-expire. Every entry is short-lived (minutes to two hours); the table never accumulates.
- `PAY_PER_REQUEST` billing, `RemovalPolicy.DESTROY` in non-production (matches the task tables).

Each per-tier async processor gets `AbuseControlsTable` as `ABUSE_CONTROLS_TABLE` env plus `dynamodb:GetItem`, `dynamodb:PutItem`, and `dynamodb:UpdateItem` on it.

The control logic lives in one shared library (`lambda/src/lib/abuse-controls.ts`) called from the shared pipeline (`async-processor-core.ts:runSharedPipeline`) and, for rate limiting, from the router before it opens a task or invokes a processor.

### Identity and exemptions

The chat path is tier-only. `resolveUserTier` maps the sender's Cognito groups to `basic | standard | premium`, and the async-processor event carries that tier as `userType`; there is no `admin` user type in the request path (admin authority is a separate identity plane, `${sub}-admin`, see [`../interaction/identity-access/admin/SPEC-ADMIN-IDENTITY.md`](../interaction/identity-access/admin/SPEC-ADMIN-IDENTITY.md)). So controls key on the resolved tier, and an admin who is chatting is controlled as their own tier by default.

Admin exemption is an opt-in, default off. Enable it with `-c abuseExemptAdmins=true` (optionally `-c abuseExemptAdminGroups=admins,staff`, default `admins`). When enabled, the router resolves the sender's trusted admin group from the server-verified Cognito group list (the same `AdminListGroupsForUser` call it makes for clearance, not a spoofable attribute) and forwards an `isAdmin` flag; a matching sender is exempt from the per-user rate limit and the per-user spend budget only. The **global** budget still counts and can still block them, so an exempt admin is never a path to unbounded account spend. Out of the box (flag unset) every sender, admins included, is controlled by tier.

### Request deduplication (P0)

Deduplication needs a key that is the same for both deliveries of one message. A Lex fulfillment does not receive the Chime `MessageId`, so the key cannot be the message id. The paths the **channel flow** dispatches itself (`@all`, `/battle`) key on the stable id it already holds; the normal path keys on an id derived from the turn. See [ADR-022](../../design/decisions/022-message-identity-is-established-at-the-channel-flow.md).

Dedup is therefore two claims on the shared table, at two different layers, guarding two different things.

**Fulfillment claim (router).** A claim collapses two fulfillments only if both carry the same key, so the router derives the correlation id from the turn (`turnCorrelationId`: channel, sender, transcript, and a 90 second bucket) rather than minting a random one, and a retried fulfillment reuses it. Every input is one a retry provably replays; the Lex `sessionId` is deliberately excluded because it discriminates nothing that channel and sender do not, while making the control depend on Amazon Chime SDK replaying the same session. The router then claims `dedup#fulfil-<correlationId>` before doing any work. A fulfillment that loses the claim returns a Lex response with an empty `messages` array, which the client suppresses, so the retry produces no second placeholder and no second answer.

Claiming before the work rather than after is a deliberate trade: a fulfillment that fails midway is not retried until the claim expires. It is chosen because a claim expires and a stranded placeholder does not.

No claim is taken on the inbound message at the channel flow. The duplicate on the normal path is a retried Lex *fulfillment*, which happens after the flow released the message and is beyond its reach, and the only way a flow can stop a message reaching Lex is `callbackDeny`, which would remove the user's own message from the conversation.

**Duplicate placeholder suppression (channel flow).** A retried fulfillment still causes Amazon Chime SDK to post a second placeholder. The flow writes the `corr#<correlationId>` mapping conditionally when a bot message carrying the marker passes through; if the key already exists this is a second placeholder for a turn already in flight, and the flow denies it. Denying a *bot* message is safe. The result is one placeholder, updated in place, with no stranded "One moment..." above the answer.

**Trade.** Two byte-identical messages from the same sender in the same Lex session inside the window resolve to one turn and receive one answer. The window is sized for a retry, not a conversation.

**Pipeline claim (async processor).** At the top of `runSharedPipeline`, before any Bedrock or task work, the correlation id is claimed under `dedup#${correlationId}` with the same condition and failure policy. This collapses a replay of one dispatch, such as an asynchronous Lambda retry, which carries an identical event and therefore an identical correlation id.

The two are not redundant. The fulfillment claim collapses *two fulfillments of one user message*; the pipeline claim collapses *two executions of one dispatch*.

The correlation id is derived rather than random, and serves both jobs at once: it keys those claims, and it labels the placeholder so the processor can resolve it. It is not a message identifier, and deduplication depends on it being stable across a retry of the same turn.

### Per-user rate limit (P1)

Keyed `ratelimit#<userSub>#<hourKey>` (hour granularity), an atomic counter incremented per request with a two-hour TTL. A per-tier hourly ceiling is enforced before the processor runs; over-limit turns receive a short "rate limit reached, try again in N minutes" reply and do not call Bedrock. Senders carrying the `isAdmin` flag skip the check (see Identity and exemptions).

Reference defaults (hourly requests per user; tune from observed traffic):

| Tier | Limit |
| --- | --- |
| basic | 60 |
| standard | 120 |
| premium | 240 |

### Model-spend budget with global circuit breaker (P0)

Two atomic hourly counters, `budget#user#<userSub>#<hourKey>` and `budget#global#<hourKey>`, incremented per model call (a request-count proxy for spend; a token-weighted variant is a later refinement). When a ceiling is crossed, the turn returns a canned response instead of calling Bedrock:

- Per-user hourly budget exceeded -> canned response to that user only.
- Global hourly budget exceeded -> canned response to everyone (protects the account).
- Global count above a circuit-trip threshold -> flip a circuit SSM parameter that the frontend/API intake reads, shedding load at the edge until it resets.

By default admins count against these budgets so the global ceiling always protects the account; the `isAdmin` flag exempts only the per-user budget (see Identity and exemptions).

Unlike the other controls, the global budget does not fail open: if the counter read or write errors, the pipeline serves the canned response rather than proceeding, so a control-table outage cannot become an unbounded-spend path. Dedup and rate limiting fail open, because their worst case is a duplicate or an over-quota call, not unbounded cost.

Canned response: a neutral "experiencing high demand, please try again later" message. All thresholds are env-configured with conservative defaults (see Configuration).

### Inbound message-length cap (P2)

Truncate any user message longer than `MAX_USER_MESSAGE_LENGTH` before it reaches Bedrock, logging the truncation. Cheap, inline, no table access.

## Enforcement points

- **Channel flow (`channel-flow-processor.ts`):** claim the inbound message by its Chime `MessageId` before any dispatch, on every path; write the `corr#<correlationId> -> MessageId` placeholder mapping when a bot message passes through. This is the only layer that sees a stable message id, so both belong here and nowhere else.
- **Router (`router-agent-handler.ts`):** mint a fresh correlation id to label the placeholder; enforce the per-user rate limit before opening a task or invoking a processor.
- **Shared pipeline (`async-processor-core.ts:runSharedPipeline`):** claim the dispatch by correlation id first; check the spend budget before the Bedrock call; apply the length cap to the outgoing messages.

Keeping the checks in the shared pipeline means all three tiers inherit them from one code path, consistent with the per-tier ownership model ([`../interaction/assistant-config/SPEC-PER-PROFILE-OWNERSHIP.md`](../interaction/assistant-config/SPEC-PER-PROFILE-OWNERSHIP.md)) and the reuse tenet in [`../../overview/TENETS.md`](../../overview/TENETS.md).

## Configuration

Most controls are env-driven with fail-open defaults so a misconfiguration never blocks legitimate traffic (the per-profile request-rate ceiling is config-driven, see below):

- `ABUSE_CONTROLS_TABLE` - table name (from the shared SSM contract).
- Per-user hourly request ceiling: the `rateLimitPerHour` field on each assistant profile (`backend/lib/config/profiles.ts`), which replaced the former `RATE_LIMIT_<TIER>` env.
- `BEDROCK_USER_HOURLY_BUDGET`, `BEDROCK_GLOBAL_HOURLY_BUDGET` - hourly model-call ceilings.
- `ABUSE_CIRCUIT_TRIP_THRESHOLD` - global count that flips the intake circuit. (The CDK context key that sets it is `bedrockCircuitTripThreshold`; the env var the Lambda reads is the name above.)
- `BUDGET_CANNED_RESPONSE` - the high-demand reply text.
- `MAX_USER_MESSAGE_LENGTH` - inbound truncation length.

When a control's env is unset the control is simply off, so partial rollout is safe. Runtime errors follow each control's policy above: dedup and rate limiting fail open (proceed), the global spend budget fails to the canned response.

## Relationship to existing controls

This layer is additive to `bedrock-resilience.ts`, which stays responsible for *reliability* (retry, backoff, per-model circuit breaker, fallback). Abuse controls own *cost and volume* (rate limit, spend budget, dedup, length). The two compose: resilience decides how to handle a Bedrock failure; abuse controls decide whether the call is allowed to happen at all.

## Phased plan

Everything rides on the shared table, so Phase 0 lands the table and the two highest-value controls together.

- **Phase 0 (foundational) - IMPLEMENTED:** `AbuseControlsTable` (foundations + SSM + per-tier grants/env); request dedup (the guard plus the stable correlation id); global and per-user spend budget with the canned response. Establishes the table every other control reuses, and closes the duplicate-processing bug. Dedup active on deploy; budgets opt-in via context.
- **Phase 1 - IMPLEMENTED:** per-user rate limit (default on, per-tier hourly ceilings); the intake circuit trip (SSM param flipped when the global count crosses the threshold; wired only when a global budget is set).
- **Phase 2 - IMPLEMENTED:** inbound length cap (default 16000 chars). Remaining refinements: token-weighted budget; per-tier tuning of all thresholds from observed traffic; a frontend/API reader for the circuit SSM param (today it is written but AE has no edge consumer yet).

## Open questions

- Budget accounting: request-count is simple and matches the reference implementation, but a token-weighted budget tracks real spend better. Start with count, revisit after launch.
- Circuit reset: automatic on the next hour window, or an explicit admin reset. Automatic is simpler; an admin override is a later addition.
- Rate-limit reply UX: a plain message versus a structured control message the frontend can render distinctly.
