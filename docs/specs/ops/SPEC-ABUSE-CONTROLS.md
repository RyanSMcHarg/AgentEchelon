# SPEC: Abuse Controls (rate limiting, spend budgets, request dedup)

**Status:** Implemented (all phases).

**Problem and who it's for:** Without cost and abuse ceilings, one automated client, a traffic spike, or a bug can run up unbounded model spend and let a single user monopolize the assistant, while duplicate message deliveries double-bill and can corrupt task state - and the alternative is assembling your own rate-limiting, spend-budget, and dedup layer. This protects the admin/operator (who owns the account and its bill) and every end user (whose fair share of the assistant is preserved). It adds a shared, admin-exemptable control plane in front of every profile: per-user and global spend budgets with a circuit breaker, a per-rung hourly rate limit, request dedup, and an inbound length cap.

**Site section:** Core platform, ops (cross-cutting operations; not a pillar). **Scope:** A shared, admin-exempt control plane that bounds per-user and global request volume, caps model spend with a global circuit breaker, deduplicates duplicate message deliveries, and clamps oversized input. It sits in front of the per-tier async processors and shares one small DynamoDB table. Applies to every tier.

## Why

The platform's control model separates two concerns: *reliability* (how a model failure is handled) and *cost and abuse* (whether a call is allowed to happen at all). The stack implements the first and this spec defines the second, so the two compose in one place.

- **Present (reliability):** Bedrock retry with exponential backoff, a per-model circuit breaker that skips to the fallback model, model fallback, and a self-hosted-tool-loop iteration cap (`MAX_TOOL_ITERATIONS`). See `lambda/src/lib/bedrock-resilience.ts`.
- **This spec (cost / abuse):** a per-user rate limit, a per-user and global model-spend budget, request deduplication, and an inbound message-length cap.

The concerns this layer addresses, by impact:

1. **Global spend budget.** Without a global ceiling, a bug, an automated client, or a traffic spike drives model spend with nothing to trip. A global hourly budget plus a circuit breaker bounds total cost.
2. **Per-user rate limit.** Without a per-user ceiling, one client can monopolize the assistant, raising cost and degrading service for others. An hourly per-tier quota keeps usage fair.
3. **Request dedup.** Amazon Chime SDK and Lex deliver at least once, so a single user message can be fulfilled more than once. Each duplicate is a second model call (double cost) and can corrupt task state: two fulfillments of one message mint two random correlation ids, so the losing async invocation cannot find its placeholder and overwrites a `completed` task with `failed`. See "Request deduplication" below.
4. **Inbound length cap.** An oversized message inflates token cost and widens the prompt-injection surface.

## Design

### Shared control table

A single DynamoDB table, `AbuseControlsTable`, owned by `foundations-stack.ts` and published on the shared SSM contract next to the task tables (`resolveSharedSSM`). Generic schema so one table backs every control:

- Partition key `pk` (string). Namespaced per control: `dedup#<correlationId>`, `ratelimit#<userSub>#<hourKey>`, `budget#user#<userSub>#<hourKey>`, `budget#global#<hourKey>`.
- `ttl` (number, epoch seconds), with DynamoDB TTL enabled so entries self-expire. Every entry is short-lived (minutes to two hours); the table never accumulates.
- `PAY_PER_REQUEST` billing, `RemovalPolicy.DESTROY` in non-production (matches the task tables).

Each per-tier async processor gets `AbuseControlsTable` as `ABUSE_CONTROLS_TABLE` env plus `dynamodb:GetItem`, `dynamodb:PutItem`, and `dynamodb:UpdateItem` on it.

The control logic lives in one shared library (`lambda/src/lib/abuse-controls.ts`) called from the shared pipeline (`async-processor-core.ts:runSharedPipeline`) and, for rate limiting, from the router before it opens a task or invokes a processor.

### Identity and exemptions

The chat path is tier-only. `resolveUserTier` maps the sender's Cognito groups to `basic | standard | premium`, and the async-processor event carries that tier as `userType`; there is no `admin` user type in the request path (admin authority is a separate identity plane, `${sub}-admin`, see [`../interaction/identity-access/admin/SPEC-ADMIN-IDENTITY.md`](../interaction/identity-access/admin/SPEC-ADMIN-IDENTITY.md)). So controls key on the resolved tier, and an admin who is chatting is controlled as their own tier by default.

Admin exemption, when a deployment wants it, is an explicit opt-in: the router additionally checks the trusted `admins` Cognito group (from `cognito:groups`, not a spoofable attribute) and forwards an `isAdmin` flag the pipeline reads before any control. Absent that flag, every sender is controlled by tier. This keeps the default honest (admins still count against the global budget, which protects the account) while allowing an operator to exempt trusted staff.

### Request deduplication (P0)

At the top of `runSharedPipeline`, before any Bedrock or task work, claim the correlation id:

```
PutItem AbuseControlsTable
  Item: { pk: `dedup#${correlationId}`, ttl: now + 300 }   // 5-minute window
  ConditionExpression: attribute_not_exists(pk)
on ConditionalCheckFailedException -> log "duplicate, skipping", return null (no-op)
on any other error -> fail open (proceed); dedup is best-effort, never blocks real work
```

For dedup to collapse duplicate *deliveries of the same message*, the correlation id must be stable per message rather than random. The router derives it from the inbound Amazon Chime SDK message id, which the fulfillment event already carries (`event.requestAttributes['CHIME.message.id']`, used today by the live-drift flow), falling back to a random UUID only when absent:

```
const correlationId = event.requestAttributes?.['CHIME.message.id'] || randomUUID();
```

Two fulfillments of one message then share a correlation id, the second claim fails the condition, and only one invocation proceeds. This removes the double Bedrock call and the task-status clobber.

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

- **Router (`router-agent-handler.ts`):** derive the stable correlation id; enforce the per-user rate limit before opening a task or invoking a processor.
- **Shared pipeline (`async-processor-core.ts:runSharedPipeline`):** claim the dedup key first; check the spend budget before the Bedrock call; apply the length cap to the outgoing messages.

Keeping the checks in the shared pipeline means all three tiers inherit them from one code path, consistent with the per-tier ownership model ([`../interaction/assistant-config/SPEC-PER-PROFILE-OWNERSHIP.md`](../interaction/assistant-config/SPEC-PER-PROFILE-OWNERSHIP.md)) and the reuse tenet in [`../../overview/TENETS.md`](../../overview/TENETS.md).

## Configuration

Most controls are env-driven with fail-open defaults so a misconfiguration never blocks legitimate traffic (the per-profile request-rate ceiling is config-driven, see below):

- `ABUSE_CONTROLS_TABLE` - table name (from the shared SSM contract).
- Per-user hourly request ceiling: the `rateLimitPerHour` field on each assistant profile (`backend/lib/config/profiles.ts`), which replaced the former `RATE_LIMIT_<TIER>` env.
- `BEDROCK_USER_HOURLY_BUDGET`, `BEDROCK_GLOBAL_HOURLY_BUDGET` - hourly model-call ceilings.
- `BEDROCK_CIRCUIT_TRIP_THRESHOLD` - global count that flips the intake circuit.
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
