# DESIGN: Battle Mode (`/battle`) - Technical Design

**Status:** Implemented (premium-gated) **Layer:** Core platform (capability - a platform feature, not an interaction pillar; its MECHANISM lives here, its variant CONFIG is assistant-config, pillar 2) **Plane:** core **Product spec:** [SPEC-BATTLE.md](./SPEC-BATTLE.md)

## 1. Overview

This document describes how Battle Mode is built. For the problem, personas, use cases, and acceptance criteria, see the product spec above.

Design anchor: a battle does not introduce a parallel persona infrastructure. The "alternative assistant" is the **treatment variant of an existing A/B experiment**, surfaced as a real Amazon Chime SDK channel member. Routing that used to pick one variant stochastically instead fans out to both, reusing the machinery that already powers A/B testing.

## 2. Architecture

Battle Mode is self-contained within AgentEchelon. The moving parts:

- **`backend/lib/stacks/battle-stack.ts`** - provisions a fixed pool of "alt-bot slots" (`ALT_BOT_SLOT_COUNT`, ships at 2), each a `CfnAppInstanceBot` with no static persona; the `BattleState` and `ChannelBattleConfig` DynamoDB tables; and IAM grants. Each slot ARN is published to SSM (`/agent-echelon/alt-bot-slots/{i}/bot-arn`, plus a `roster`).
- **`backend/lambda/src/channel-battle.ts`** - API handler for the enable / disable / get-config endpoints; calls Amazon Chime SDK `CreateChannelMembership` and `DeleteChannelMembership` for the alt-slot.
- **`backend/lambda/src/channel-flow-processor.ts`** - detects `/battle`, gates on classification and battle-enablement, lists channel members, and fans out a round-1 invocation per bot member.
- **`backend/lambda/src/lib/async-processor-core.ts`** - per-bot generation: resolves the variant config, assembles the system prompt with battle awareness, writes battle state, and handles the `NO_REBUTTAL` sentinel.
- **`backend/lambda/src/battle-orchestrator.ts`** - fires round 2 once both sides reach round-1 completion.
- **`backend/lambda/src/lib/battle-state.ts`** - the state and config data layer (see below): `deriveBattleId`, `isBattleEnabled`, per-bot state transitions, the orchestrator claim, and continuation planning.
- **`backend/lambda/src/lib/experiment-manager.ts`** - the A/B experiment schema and cache, extended with battle fields and the slot-to-variant resolvers.
- **Frontend** (`frontend/packages/chat`, `frontend/packages/admin`) - marker parsing, round dividers, variant chips, the scorecard, the live tally, the admin arming form, and the per-step steps view.

## 3. Data Model

**`ChannelBattleConfig`** (DynamoDB) - per-channel enablement. PK `channelArn`; attributes `enabled`, `experimentId`, `altBotSlotArn`, `enabledBy`, `enabledAt`. Read at `/battle` time via `isBattleEnabled(channelArn)` (cached), so it is load-bearing at runtime, not admin/UI-only.

**`BattleState`** (DynamoDB, TableName `AgentEchelon-BattleState`) - per-bot round state. PK `battleId`, SK `botArn`. Attributes: `state` in `{INVOKED, WAITING_FOR_USER, COMPLETED, FAILED}`, `round1Reply`, `round1MessageId`, `correlationId`, `enteredStateAt`, and a `ttl` of 600 seconds. A sentinel SK (`__orchestrator__`) provides exactly-once round-2 firing.

`battleId` derivation is the single source of truth, computed the same way by the channel-flow-processor and the async-processor (`deriveBattleId` in `battle-state.ts`):

```
sha256(`${channelArn}:${userMessageId}`).hex.slice(0, 16)
```

`userMessageId` is the stable Amazon Chime SDK message id of the `/battle` message, so the id is retry-stable.

**Experiment schema extension** (`experiment-manager.ts`) - the alt-slot to variant binding lives on the experiment row itself; there is no separate binding table (the existing 60-second experiment cache makes the lookup free):

```typescript
interface ExperimentVariant {
  variantId: string;
  modelKey: BackendModelKey;
  weight: number;
  displayName?: string;          // surfaced in UI and rival prompt; required when battleEnabled
  systemPromptAddendum?: string; // sanitized; see APIs
}
interface Experiment {
  // ...existing...
  battleEnabled?: boolean;
  altBotSlotId?: string;         // "slot-0", "slot-1", ...
  altBotSlotArn?: string;        // denormalized for hot-path resolution
  boundBy?: string; boundAt?: string;
}
```

`variants[0]` is control (served by the default bot); `variants[1]` is treatment (served by the alt-slot bot).

**`analyticsMetadata`** gains a top-level `assignmentMode: 'probabilistic' | 'battle'` and, when battle, a `battleContext` carrying `battleId`, `round`, `selfBotArn`, `rivalBotArn`, `optedOutOfRound2?`, and a `steps[]` array. Each step is `{ stepLabel, modelId, startedAt, endedAt, tokensIn?, tokensOut?, imageCount?, estCostUsd? }`. `assignmentMode` is deliberately top-level so variant-comparison rollups can filter out battle traffic *before* per-variant aggregation.

**`battleOutcome`** record (one per battle) - `battleId`, `winner: 'A'|'B'|'tie'`, `chosenByUserSub`, `chosenAt`, plus `experimentId` / `variantId` / `intent` so the pick aggregates per variant. Descriptive only; never read back into selection.

Large `steps[]` arrays persist out of band in the message-analytics record keyed by message id (not on the <=1KB Amazon Chime SDK Metadata), and archival merges them into Aurora's `messages.metadata` JSONB, queryable with no cap.

## 4. APIs, Interfaces, and Markers

**Endpoints** (existing admin/user-management API Gateway, Cognito-scoped, handled by `channel-battle.ts`):
- `POST /channels/battle/enable` - body `{ channelArn, experimentId }`; validates battle-eligibility and classification/intent match, calls `CreateChannelMembership` with the alt-slot ARN, writes `ChannelBattleConfig`, posts an announce message. Premium-classification only; channel-moderator only.
- `POST /channels/battle/disable` - body `{ channelArn }`; removes membership, deletes the config row, posts a leave message.
- `GET /channels/battle?channelArn=...` - returns the config or 404.

**Experiment write validation** (`createExperiment` / `updateExperiment`, 4xx on violation): `battleEnabled` requires exactly 2 variants, a defined `altBotSlotId`, and a display name on each variant; a slot bound to another active battle experiment returns 409 with `{ conflictingExperimentId, slotId }`; disabling battle while a `ChannelBattleConfig` references the experiment returns 409 with the affected channel ARNs.

**System-prompt addendum sanitization** (server-side, before storage): cap 500 chars after whitespace normalization; strip ASCII control characters; reject the literal `</persona_addendum>` (the assembly delimiter) case-insensitively; collapse whitespace runs.

**Markers** (in raw message content, stripped before display by the frontend parser and the Bedrock Guardrail metadata filter):
- `<!--corr:{id}-->` - existing correlation marker, unchanged.
- `<!--battle:round={n},total={total},rivalArn={arn},rivalReplyMsgId={msgId?}-->`
 - parsed into a `battle` field `{ round, rivalBotArn, rivalReplyMsgId? }` used for round dividers and rebuttal linking.
- `<!--battleimage:{json}-->` - generation-out image payload marker.

**Hot-path resolvers** (`experiment-manager.ts`): `resolveBattleVariantBySlotArn` (treatment side, from the alt-slot ARN), `resolveBattleControlVariantByAltSlotArn` (control side, keyed by the same alt-slot ARN so the control honors its configured variant), and `resolveBattleImageGenPair`.

## 5. Key Flows and Algorithms

**Detection.** `channel-flow-processor.ts` tests `/@all\b/i` and `/\/battle\b/i`; they are mutually exclusive and `/battle` wins. `/battle` is parsed only at message start (a command, not an inline mention). Both are processor-side bypasses, not native Amazon Chime SDK mentions.

**Round 1 (parallel).** After detection: strip the leading `/battle` token; gate on the channel's classification tag (premium by default, per `profile.battleEligible`); gate on `isBattleEnabled` (else post the one-line not-enabled hint and return, no `@all` fallback); list memberships and filter to bot ARNs. If battle is enabled but fewer than 2 bot members exist (internal inconsistency only), fall back to a single default-bot broadcast with no error. Otherwise send a per-bot placeholder as that bot and invoke the async processor per bot in parallel (`Promise.all`) with a `battleContext` `{ round: 1, totalRounds: 2, selfBotArn, rivalBotArn, rivalReply: undefined }`.

**Per-bot generation.** The default bot resolves the configured control variant (`resolveBattleControlVariantByAltSlotArn` on the rival alt-slot ARN), falling back to normal classification+intent resolution only if none resolves. The alt-slot bot resolves its treatment variant (`resolveBattleVariantBySlotArn`). Prompt assembly order: classification base prompt, then `<persona_addendum>{sanitized addendum}</persona_addendum>`, then battle-mode constraints last so they override any contradictory addendum. Round-1 constraints permit exactly one `NEED_CLARIFICATION`-gated question; round 2 forbids it. Response length is intent-aware: `prepareBattleInvocation` takes `longForm` (`taskType === 'report_generation' || isDocumentRequest(userMessage)`) and emits a ~150-word focus clause when concise, or a "produce the complete deliverable as an attachment" clause when long-form, so the prompt and the delivery mechanism never disagree.

**Round-1 completion is intent-aware.** Round 2 must not fire until each bot has *completed the intent*, not merely posted a first update: `DIRECT` on send; `PLACEHOLDER_UPDATE` on the update landing; `TASK_UPDATE_IN_PLACE` on task `completed`/`failed`; `TASK_MULTI_STEP` on a terminal task-graph state. A rebuttal mid-task-chain is nonsensical, so the orchestrator tracks intent completion.

**Exactly-once round 2.** Each async-processor invocation writes its own `(battleId, botArn)` row idempotently (`ConditionExpression` allows the write only if absent or not yet terminal), then reads the full `battleId` partition. When `allBotsTerminal` (every row in `{COMPLETED, FAILED}`), the writer claims the fire via a conditional put on the `__orchestrator__` sentinel (`tryClaimOrchestratorFire` in `battle-state.ts`); exactly one writer wins. The orchestrator (`battle-orchestrator.ts`) then, per bot, sends a round-2 placeholder and invokes the async processor with `round: 2` and the rival's round-1 reply text; the prompt invites rebut / build / concede, or the single token `NO_REBUTTAL` to stay silent. On `NO_REBUTTAL` (trimmed, case-insensitive, optional trailing punctuation), the round-2 placeholder is UPDATED in place to a `No rebuttal.` state (via `UpdateChannelMessage`) rather than deleted - the opt-out is shown honestly, nothing appears-then-vanishes, and it needs no `chime:DeleteChannelMessage` grant (an earlier delete-based approach failed silently for lack of that permission and left the placeholder orphaned as a stale "waiting" bubble). Both opting out is valid.

**Clarification routing.** Clarification is a measured dimension, not forbidden. A bot that needs input asks exactly one question and emits the explicit `NEED_CLARIFICATION` sentinel; it transitions `INVOKED -> WAITING_FOR_USER` per-bot (`markBotWaitingForUser`), which suppresses the round-2 orchestrator until it later completes, and captures `clarificationCount` and `activeResponseMs`. The user's answer is routed only to the bot it `@`-mentioned (via `CHIME.mentions` + the "Replying to" composer selector and `planBattleContinuation`), so a bot that failed to ask never benefits from its rival's clarification. `resumeBotFromWaiting` returns it to `INVOKED`.

**Task isolation.** Two bots can each run a task chain for the same user prompt, so `UserTasksTable` uses a `userSub-botArn-taskType-index` GSI and `hasActiveTaskForBot(userSub, botArn)`; continuation messages route per-bot.

**Drift interaction.** In a battle-enabled channel the router's live drift- suggestion path is fully suppressed (two competing "compare these" vs "start a new conversation" flows would confuse the user). The post-hoc analytics `detectDrift` still runs but tags rows with `battle_id` so known-divergent battle exchanges are excluded from TPR/FPR rollups by default. A system-prompt clause is defense in depth against a bot emitting drift-flavored text itself.

**Fail modes.** A crashed async processor leaves a state row that the 600s TTL reaps; the orchestrator treats a missing row as `FAILED` for the "all terminal" check, so the surviving bot still rebuts against an implicit empty rival. A single-active-battle-per-channel lock (the state table doubles as the lock) answers a second concurrent `/battle` with "a battle is already in progress."

**Marker survival.** The round-1 placeholder CREATE carries the `battle` marker; the async-processor UPDATE overwrites content with no marker. The frontend `ConversationProvider` update handler does a selective field merge that deliberately excludes `battle` from the override list, so chips, the round-2 divider, and the scorecard keep rendering after the reply lands. The scorecard summary fields (`responseMs`, `estCostUsd`, `steps`) are merged into the existing battle object from the UPDATE.

## 6. Security / IAM

- **Bounded bot growth.** Alt-bot slots are pre-provisioned at deploy time, not created per experiment. Runtime `chime:CreateAppInstanceBot` is avoided; growth is capped by `ALT_BOT_SLOT_COUNT`, and every slot ARN is statically known to Lex and handler resource policies. Raising the count is a CDK deploy, no schema change.
- **Cost gate.** A battle is up to 4 model invocations (2 variants x 2 rounds). `/battle` requires a battle-eligible classification (premium by default), resolved from the immutable `classification` tag, plus the single-active-battle lock. Existing `bedrock-resilience.ts` retry and circuit-breaking apply unchanged.
- **Authorization.** Enable/disable is channel-moderator only and premium-classification only. Addendum text is sanitized server-side and wrapped in a delimiter so the model treats it as a distinct authorial layer, with battle constraints appended last.
- **Image-output moderation** ships as a basic default guardrail; production-grade tuning is the deployer's documented responsibility (open-source posture), not an internal sign-off gate.

## 7. Testing

Backend unit tests (`backend/test/lib/` and `backend/test/`):
- `battle-state.test.ts` - id derivation, state transitions, `allBotsTerminal`, the orchestrator claim.
- `battle-round1-complete.test.ts` - intent-aware round-1 completion.
- `battle-orchestrator.test.ts` - pairs both completions, fires round 2 once.
- `async-processor-battle.test.ts` - prompt assembly, `NO_REBUTTAL`, long-form.
- `experiment-manager.battle.test.ts` - slot/variant resolution, validation.
- `battle-clarification.test.ts` - `NEED_CLARIFICATION` routing and suppression.
- `battle-task.test.ts`, `battle-task-delivery.test.ts` - `TASK_*` battles.
- `battle-vision-plan.test.ts`, `vision-battle-action.test.ts`, `battle-generation-out-plan.test.ts`, `battle-attachment.test.ts` - image modes.
- `battle-outcome.test.ts`, `battle-outcome-api.test.ts`, `analytics-metadata.battle.test.ts` - outcome record and analytics metadata.
- `channel-battle.test.ts`, `battle-alt-slot-handler.test.ts` - the API handlers.

Frontend unit tests (`frontend/packages/`):
- `chat/src/utils/battleTally.test.ts` - `computeBattleTally` aggregation.
- `chat/src/services/channelBattleService.test.ts`, `battleOutcomeService.test.ts` - client calls.
- `admin/src/components/admin/EffectivenessTab.test.tsx` - the per-step admin view (the turn-timeline drill that surfaces `execution_steps`).

End-to-end (`tests/e2e/battle.spec.ts`): the behavioral cases run under `BATTLE_E2E=1` against a battle-enabled deploy (never in the default unit suite) - round-1 chip survival + a working scorecard pick, the round-2 divider, multi-turn duels, server-side outcome persistence, the not-enabled hint, `/battle` start-of-message detection, generation-out (both variants render a decoded image, honest text otherwise), and clarification routing (an ambiguous `/battle` produces the neutral private waiting state instead of broadcasting the question). The full answer-then-resume completion of the clarification round-trip stays live/model-timing-dependent and is not asserted in CI.

## 8. Open Technical Questions

- `steps[].tokensIn` accounting for vision-in image tokens, and binding a specific attachment to a `/battle` turn when a channel holds several.
- The exact `MODEL_RATE_TABLE` values and image-gen cost granularity (approximate and deployer-tunable by design).
- The generation-out model choice (Titan Image Generator vs Nova Canvas) and the precise default image-output guardrail config to ship.
- Whether Aurora should add a generated column / index for `assignmentMode` or `battle_id` if rollup performance degrades (currently rides the JSON metadata column, no migration).
