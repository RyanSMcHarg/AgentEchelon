# SPEC: `/battle` - Multi-Assistant Adversarial Reply

**Status:** Implemented (premium-gated). Covers single-turn, `TASK_*`, and image (vision-in + generation-out) battles, the three-axis scorecard, and per-step telemetry.
**Image-output safety:** ships as a basic default; production-grade moderation is the deployer's responsibility (open-source posture), not an internal sign-off gate.
**Author:** Ryan McHarg
**Related:**
- `backend/lambda/src/channel-flow-processor.ts` - existing `@all` / `@assistant` fan-out + the `/battle` branch
- `backend/lambda/src/lib/async-processor-core.ts` - placeholder + update pattern
- `backend/lambda/src/lib/experiment-manager.ts` - A/B testing variant resolver (extended for battle)
- `frontend/src/components/admin/ExperimentsTab.tsx` - admin UI with the battle controls
- `backend/lib/stacks/{basic,standard,premium}-tier-stack.ts` - each tier provisions its own `CfnAppInstanceBot`; `backend/lib/stacks/battle-stack.ts` provisions the alt-bot slot pool
- `backend/lambda/create-conversation/index.js` - channel creation + flow association
- `docs/guides/admin/GUIDE-AB-TESTING-AND-BATTLES.md` - deployer/operator guide
- `docs/specs/analytics-eval/SPEC-DRIFT-CONVERGENCE.md` - battle messages bypass the live-suggestion path; the drift-detection schema carries a `battle_id` tag
- `backend/lambda/src/lib/task-state-machines.ts` - the declared task-state graphs (`DEFAULT_TASK_STATE_MACHINES`, `authorizeTransition`)
- `backend/lambda/src/lib/task-tracking.ts` - task persistence + `stateHistory`; `UserTasksTable` GSI changes documented under Task-Tracking Implications

## Design Anchor

A `/battle` does not introduce a parallel persona infrastructure. **The "alternative assistant" is the treatment variant of an existing A/B experiment**, surfaced as a real channel member. /battle can be turned on/off in any conversation where there is an active /battle for the primary assistant in a given tier. 

- The admin defines experiment variants today (control model vs treatment model, weighted). This spec extends that schema with `battleEnabled`, `displayName`, and an optional `systemPromptAddendum` per variant.
- When a channel's "Enable Battle" toggle flips on, the channel adds the active experiment's **treatment variant** as a second `AppInstanceBot` member. That bot principal is the alternative assistant. Both variants are now channel members in the literal Amazon Chime SDK sense.
- `/battle` then fans out routing to *all bot members of the channel* (1 default bot + 1+ alt-slot bots), exactly as `@all` does today but per-bot rather than to a single bot. Each invocation carries its own variant config (model + system-prompt addendum) so the two responses are visibly different - same machinery that already powers A/B testing, but the routing decision changes from "pick one stochastically" to "fan out to both."
- This unifies `/battle` with A/B testing as one feature: instead of probabilistically picking a variant per conversation, the user can compare both on the same prompt within a single channel.

## Delivered scope

The full feature set below is implemented. Four capability groups make up the delivered scope:

1. **`TASK_*` battles.** The supported progression is: single-turn battle →
   **report-creation** battle → **document-creation** battle (attachments
   supported) → **image** battle. The
   `Round-1 Completion Semantics (Intent-Aware)` table - including the
   `TASK_UPDATE_IN_PLACE` and `TASK_MULTI_STEP` rows - is load-bearing. The
   `WAITING_FOR_USER` state, the per-bot reply UX ("Replying to:" composer
   selector + `CHIME.mentions` routing), and the `UserTasksTable` →
   `userSub-botArn-taskType-index` GSI change are all part of it.

2. **Image battles, both directions.** Two battle modalities:
   - **Vision-in** - battle two vision-capable models on an uploaded image or
     scanned document (OCR-style understanding). Reuses the existing
     attachment pipeline (`PresignedUrl` Lambda + S3); no new model needed if
     the battle variants are already vision-capable Claude models.
   - **Generation-out** - battle two image-generation models on a prompt.
     It uses an image-gen model on Bedrock (Titan Image Generator or Nova
     Canvas), a **basic default image-output guardrail** (the text-only
     Guardrail config is extended with a sensible default following the
     existing Bedrock Guardrails pattern), an IAM path for the model, a
     per-image cost model, and a frontend renderer for image messages in the
     round/variant layout. **Open-source posture (not an internal gate):**
     production-grade image moderation is the responsibility of whoever
     deploys this code; that responsibility is stated explicitly in the
     docs, not enforced by an AppSec sign-off.

3. **Three-axis scorecard, no forced composite.** Battle results are scored on
   three independent dimensions shown side by side per variant - never folded
   into one number:
   - **Response time** - wall-clock per round and per step (see decision 4).
   - **Estimated cost** - `tokensIn/out × model-rate` for text; per-image rate
     for generation-out; summed across the steps a variant took for the turn.
   - **Quality** - **explicit human pick-the-winner per battle** (A / B / tie),
     captured by a new post-battle control in the conversation UI after both
     variants' round-1 replies land. This is distinct from the existing
     per-message Helpful / Needs-work thumbs (which stay as-is for granular
     signal); the winner-pick is the decisive head-to-head signal. Storage:
     a new battle-outcome record keyed by `battleId`, carrying
     `winner: 'A' | 'B' | 'tie'`, `chosenByUserSub`, `chosenAt`. Not an
     algorithmic judge - see the Non-Goal.

4. **Per-step latency + model, exposed to admins AND users.** A battle turn is
   not one timing - it is a sequence of steps (round-1 generation; for
   `TASK_*`, each task-chain step; round-2 rebuttal; for image, the gen call).
   Each step records `{ stepLabel, modelId, startedAt, endedAt, tokensIn,
   tokensOut | imageCount }`. Admins see the **full per-step breakdown** in
   the Experiments/battle analytics surface. Users see a **compact scorecard**
   inline in the battle (the three axes from decision 3, with the per-step
   latency/model breakdown available on expand) - this is intentionally
   user-visible, not admin-only. The `analyticsMetadata.battleContext` is
   extended with a `steps[]` array (see the Analytics section).

**Invariants that hold across the feature:** the Design Anchor (battle = treatment
variant of an A/B experiment, surfaced as a real channel member), the AE-only
repo scope, the 2-variant-per-battle cap, the no-streaming constraint,
the alt-bot-slot-pool model, and "no algorithmic judge that affects selection".

---

## Scope

**`/battle` is an AgentEchelon feature.** It is self-contained within this
repository: the `ChannelBattleConfig` DDB table, the alt-bot slot pool, the
channel-flow `/battle` branch, the orchestrator Lambda, the experiment-schema
`battleEnabled` extension, and the admin UI controls are all part of
AgentEchelon. The one cross-feature interaction - drift suppression in
battle-enabled channels - is implemented entirely here (see
`docs/specs/analytics-eval/SPEC-DRIFT-CONVERGENCE.md` "Interaction with `/battle`" and
`backend/lambda/src/lib/battle-state.ts`'s fail-open `isBattleEnabled` helper).

---

## Problem

AgentEchelon's narrative is "an enterprise AI harness where every assistant is a first-class channel member." A single-bot-per-channel product demonstrates that with **one** bot per channel; `/battle` adds the moment where two assistants visibly argue the same prompt in one channel, which requires routing that no longer assumes a single bot ARN per channel.

A `/battle` mention should:

1. Invoke **every bot member** of the channel against the same user prompt in parallel (round 1).
2. After both round-1 replies post, give each bot the option to **rebut, agree with, or ignore** the other's reply (round 2). Bot decides.
3. Make each bot **aware it is in a battle**, so its first reply isn't generic and its second reply can directly engage the other.
4. Surface no algorithmic judging - the human reads both and decides.

It also exercises a harness primitive that is genuinely useful beyond the demo: *the channel can have N bot members, each with its own persona, and routing fans out by membership*.

## Goal

After this spec is implemented:

1. **Admins can mark an A/B experiment as battle-eligible.** The Experiments tab gains three new fields per variant: `battleEnabled` (experiment-level flag), `displayName` (per-variant; what users see - e.g. "Atlas" vs "Echo"), and `systemPromptAddendum` (per-variant; short style instruction layered onto the tier's base prompt).
2. **Channel owners can enable battle on any premium channel** that has an active battle-eligible experiment matching the channel's tier + intent. Toggling on calls a new endpoint that adds the treatment variant's `AppInstanceBot` slot as a real channel member. Toggling off removes it.
3. **A user typing `/battle <prompt>` in a battle-enabled channel** triggers the round-1 parallel reply + round-2 rebuttal flow described below, fanning out to every bot member.
4. **Each bot's invocation includes a structured `battleContext`** so the bot's system prompt is augmented with awareness ("you are in a battle with `<rivalName>`; the user invoked `/battle`; in round 2 you may engage with their reply or stay silent").
5. **The frontend renders the rounds distinctly** (round divider + per-variant avatar/color derived from the experiment config) without changing the message storage shape.
6. **Channels without battle enabled** see `/battle` reply with a one-line hint - *"Battle Mode isn't enabled on this channel. Ask a moderator to flip the toggle in the members panel, then try /battle again."* - and nothing is broadcast. A slash command that can't run should explain itself, not silently fan out to `@all`. (`/battle` is a command, not a mention, so an inert command is a visible no-op with a reason, never an error.)

## Non-Goals

- **Algorithmic judging.** No third-model judge, and no win-rate signal that *feeds back into automated bot/variant selection*. Scoring is descriptive, not a control loop. Note (per delivered-scope item 3): explicit **human** pick-the-winner and objective response-time / cost telemetry ARE first-class and user-visible - that is human judgement and instrumentation, not an algorithmic judge, and it never auto-routes future traffic.
- **Arbitrary persona authoring by end users.** End users can only enable/disable battle on a channel. The variants themselves are authored by admins via the existing Experiments tab.
- **Dynamically created `AppInstanceBot`s.** Pre-provision a small pool of "alt-bot slots" at deploy time; the admin binds an experiment variant to a slot. Per-experiment runtime bot creation is rejected on IAM-policy and unbounded-growth grounds (see Risks).
- **Cross-tier `/battle`.** Variants in a battle must both be allowed at the channel's tier. The existing `experiment-manager` tier-safety check applies unchanged.
- **More than 2 variants per battle.** The experiment schema supports N variants with weights; `/battle` runs 2-variant experiments (control + treatment). N>2 is out of scope.
- **Streaming.** Both rounds use the existing placeholder + update pattern, not streaming.
- **Battle for non-experiment channels.** Battle requires an active battle-eligible experiment. Free-form "pick any two models" battle is not in scope; experiments are the authoring surface.

## Provisioning baseline

**Per-tier default bots.** Each per-tier stack (`backend/lib/stacks/{basic,standard,premium}-tier-stack.ts`) provisions its own tier's `CfnAppInstanceBot` and publishes its ARN via that tier's SSM contract; `channel-flow-processor.ts`, `create-conversation/index.js`, and `add-agent-to-conversation/index.js` resolve the tier's default bot from that contract. The alt-bot slot pool that `/battle` fans out to is owned by `backend/lib/stacks/battle-stack.ts` (see the Alt-Bot Slot Pool section).

**Channel membership.** `create-conversation/index.js` creates the channel with the bot as moderator and adds the human user. `add-agent-to-conversation/index.js` adds the same bot (idempotent) on demand.

**Routing.** `channel-flow-processor.ts` recognizes `@all` and broadcasts a bot reply. `@assistant` is routed by Amazon Chime SDK's native `CHIME.mentions` attribute via `AUTO` + `TargetedMessages: ALL`. `/battle` fans out to every bot member of the channel.

**Async processor.** `async-processor-core.ts` handles placeholder + update. The processor reads `userMessage`, `botArn`, `senderArn`, `intent`, `deliveryOption`, and `responseTarget` from the invoke payload. There is no `battleContext` field today.

## Target State

### Alt-Bot Slot Pool (CDK)

Pre-provision a fixed pool of "alt-bot slots" at deploy time. Each slot is a `CfnAppInstanceBot` with **no static persona** - the model + system-prompt addendum it uses on each invocation is read at runtime from the bound experiment variant's config.

```typescript
// backend/lib/stacks/battle-stack.ts
const ALT_BOT_SLOT_COUNT = 2;  // ships 2 alt slots; raise later if many concurrent battle experiments are needed

for (let i = 0; i < ALT_BOT_SLOT_COUNT; i++) {
  // Each slot creates a CfnAppInstanceBot pointing at the same Lex bot
  // alias as the default bot. Disambiguation happens at the async-processor
  // layer via experiment-manager.resolveBattleVariantBySlotArn (see below).
}
```

Each slot ARN is written to SSM under `/agent-echelon/alt-bot-slots/{slotIndex}/bot-arn` and the full roster to `/agent-echelon/alt-bot-slots/roster`.

### Experiment Schema Extension

Extend the existing `Experiment` and `ExperimentVariant` interfaces in `backend/lambda/src/lib/experiment-manager.ts`. **The binding from alt-bot slot → variant config lives on the experiment row itself** - no separate `BattleVariantBindingTable`. (Decision: avoids a second table + IAM grant; the existing 60s in-memory cache in `experiment-manager` makes the slot-lookup hot-path free since experiments are already loaded.)

```typescript
export interface ExperimentVariant {
  variantId: string;
  modelKey: BackendModelKey;
  weight: number;
  displayName?: string;            // e.g. "Atlas" — surfaced in UI and rival prompt; max 16 chars; required when battleEnabled
  systemPromptAddendum?: string;   // Sanitized; see "Prompt Addendum Sanitization" below
}

export interface Experiment {
  // ...existing fields...
  battleEnabled?: boolean;         // If true, this experiment can power /battle
  /** Stable id of the alt-bot pool slot the treatment variant occupies. Format: "slot-0", "slot-1", ... */
  altBotSlotId?: string;
  /** Denormalized slot ARN for fast async-processor lookup. Computed by the admin-API write path from altBotSlotId + the SSM roster. */
  altBotSlotArn?: string;
  /** User ARN of the admin who last bound this experiment to its slot. Required when battleEnabled. */
  boundBy?: string;
  /** ISO timestamp of the last binding write. */
  boundAt?: string;
}
```

Constraints (enforced in `createExperiment` / `updateExperiment`, returning 4xx on violation):
- `battleEnabled: true` requires exactly 2 variants and a defined `altBotSlotId`.
- Both variants must have a non-empty `displayName` when `battleEnabled: true`.
- An `altBotSlotId` can be bound to at most one active battle-enabled experiment at a time. Conflict returns 409 with `{ conflictingExperimentId, slotId }`.
- Disabling battle (setting `battleEnabled: false`) is rejected with 409 if any `ChannelBattleConfig` row references this experiment. The 409 body lists the affected channel ARNs.

**Hot-path resolution** (in async-processor-core, on every alt-bot invocation):

```typescript
// experiment-manager.ts — new export
export async function resolveBattleVariantBySlotArn(slotArn: string)
  : Promise<{ experimentId, variantId, modelKey, displayName, systemPromptAddendum } | null> {
  const experiments = await loadExperiments();  // 60s cached
  const exp = experiments.find(e => e.battleEnabled && e.altBotSlotArn === slotArn);
  if (!exp) return null;
  const treatmentVariant = exp.variants[1];  // variants[0] = control (default bot), variants[1] = treatment (alt slot)
  return { experimentId: exp.experimentId, variantId: treatmentVariant.variantId,
           modelKey: treatmentVariant.modelKey, displayName: treatmentVariant.displayName!,
           systemPromptAddendum: treatmentVariant.systemPromptAddendum };
}
```

The async processor calls this when `senderBotArn` is an alt-bot slot ARN (membership lookup also reveals this).

### Prompt Addendum Sanitization

`systemPromptAddendum` is admin-authored text concatenated into the LLM system prompt. Even when authored by trusted admins, treat it like adversarial input for defense in depth.

**Server-side validation in `createExperiment` / `updateExperiment`** (reject with 4xx on violation):

1. **Length cap:** maximum 500 characters after whitespace normalization. Enforced server-side; client-side enforcement is advisory only.
2. **Character class:** strip ASCII control characters (`\x00-\x08`, `\x0B-\x0C`, `\x0E-\x1F`, `\x7F`) before storage. These have no legitimate use in a system prompt and could be exploited for injection in some tokenizers.
3. **No closing delimiter:** the string must not contain the literal sequence `</persona_addendum>` (the delimiter we use during prompt assembly - see below). Reject with 4xx so an addendum cannot break out of its container. Case-insensitive match.
4. **Whitespace normalization:** collapse runs of `\s+` to a single space; trim leading/trailing whitespace. Store the normalized form.

**Prompt assembly order** in `async-processor-core.ts` when building the system prompt for a battle invocation:

```
1. Tier base system prompt (existing — defines the bot's role for the deployment's tier)
2. <persona_addendum>{sanitized variant.systemPromptAddendum}</persona_addendum>
3. Battle-mode constraints (always last, take precedence over addendum):
   "You are in a battle with {rivalDisplayName}. Do not ask clarifying questions.
    State your assumptions clearly and produce your best complete answer in a single reply.
    Do not propose starting a separate conversation or suggest the user is off-topic —
    the user invoked /battle intentionally; divergence is the point.
    {round-2 only:} In this rebuttal turn, you may engage with the rival's reply, build on it,
    or stay silent. To stay silent, respond with the single token NO_REBUTTAL."
```

The battle-mode constraints come **after** the addendum so they override any contradictory instructions the admin (or a future compromised admin) injected. The delimiter tags around the addendum let the model treat it as a distinct authorial layer rather than as direct system instructions.

> **Note.** The `"Do not ask clarifying questions"` text above applies to round 2 only. For round 1, `BATTLE_CONSTRAINTS_ROUND1` permits **exactly one** `NEED_CLARIFICATION`-gated question (clarification is a measured dimension; the wording permits but does not encourage). **Round 2 forbids it** (rebuttal turn; round-2 `WAITING_FOR_USER` is intentionally not wired). The full detection → state → per-bot routing → continuation (PLACEHOLDER + TASK_*) → telemetry → frontend path is implemented; see "Clarification Routing in Multi-Bot Channels" below.

### BattleStateTable Schema and Conditional-Write Contract

```
TableName: AgentEchelon-BattleState
PK: battleId (string)
SK: botArn (string)
Attributes:
  state: 'INVOKED' | 'WAITING_FOR_USER' | 'COMPLETED' | 'FAILED'  (string)
  round1Reply: string | null              (populated when state ∈ {COMPLETED, FAILED})
  round1MessageId: string | null          (populated when state ∈ {COMPLETED, FAILED})
  correlationId: string                   (per-bot correlation id used in the marker)
  enteredStateAt: string                  (ISO timestamp of the last state transition)
  ttl: number                             (epoch seconds; 600s after row creation)
```

**`battleId` derivation** (single source of truth, used everywhere):

```typescript
import { createHash } from 'crypto';

export function deriveBattleId(channelArn: string, userMessageId: string): string {
  return createHash('sha256')
    .update(`${channelArn}:${userMessageId}`)
    .digest('hex')
    .slice(0, 16);  // 64 bits of entropy is plenty for a per-channel scope
}
```

Both the channel-flow-processor (when fanning out round 1) and the async-processor (when transitioning state) derive `battleId` from the same inputs. The `userMessageId` is the Amazon Chime SDK message id of the `/battle` user message - stable across retries.

**State-transition contract** (each async-processor invocation, on round-1 completion):

```typescript
// 1. The processor writes its own (battleId, botArn) row idempotently:
PutItem({
  TableName: 'AgentEchelon-BattleState',
  Item: { battleId, botArn: thisBotArn, state: 'COMPLETED' | 'FAILED',
          round1Reply, round1MessageId, correlationId, enteredStateAt: now(), ttl: now+600 },
  ConditionExpression: 'attribute_not_exists(botArn) OR #state IN (:invoked, :waiting)',
  ExpressionAttributeNames: { '#state': 'state' },
  ExpressionAttributeValues: { ':invoked': 'INVOKED', ':waiting': 'WAITING_FOR_USER' },
});
// Condition: writing this row only succeeds if it doesn't already exist, OR
// if it does exist but is not yet in a terminal state. This makes retries idempotent
// and prevents a duplicate state machine transition from re-firing round 2.

// 2. Read the full battleId partition:
Query({ TableName: 'AgentEchelon-BattleState', KeyConditionExpression: 'battleId = :id' });

// 3. If ALL rows for this battleId have state ∈ {COMPLETED, FAILED}, this writer
//    invokes the orchestrator. Otherwise, it returns — the other writer will fire.
//    The orchestrator itself does a duplicate-fire guard on its first action by
//    writing a sentinel row (battleId, '__orchestrator__'):
PutItem({
  Item: { battleId, botArn: '__orchestrator__', state: 'COMPLETED', enteredStateAt: now(), ttl: now+600 },
  ConditionExpression: 'attribute_not_exists(battleId)',
});
// If the conditional-put fails (the sentinel already exists), the orchestrator
// has already fired for this battleId; this invocation no-ops.
```

This gives exactly-once orchestrator firing without a separate lock table. The conditional-put on a sentinel SK is the standard DDB idiom for "exactly one of N parallel writers wins."

**State row leaks** on async-processor crash: handled by the 10-minute TTL. If a row never transitions to a terminal state, it expires. On orchestrator read, missing rows are treated as `FAILED` for the "all terminal?" check, so the surviving bot's round 2 still fires (with a one-bot rebuttal, against an implicit empty rival reply that round 2's system prompt handles as "your rival did not produce a reply").

### Per-Channel Battle Enablement

A new table `ChannelBattleConfig` tracks per-channel battle state:

```
PK: channelArn (string)
Attributes:
  enabled: boolean,
  experimentId: string,         // The bound experiment
  altBotSlotArn: string,        // The slot added as a channel member
  enabledBy: string,            // User Arn
  enabledAt: ISO timestamp
```

New API endpoints (on the existing admin/user-management API Gateway, scoped by Cognito):
- `POST /channels/battle/enable` - body: `{ channelArn, experimentId }`. Validates the experiment is battle-enabled, matches the channel's tier + intent (or has no intent constraint), then calls `CreateChannelMembership` with the alt-bot slot ARN as `MemberArn`. Writes `ChannelBattleConfig`. Posts a system message in the channel announcing the addition.
- `POST /channels/battle/disable` - body: `{ channelArn }`. Calls `DeleteChannelMembership` for the alt-bot slot, deletes the config row, posts a system message.
- `GET /channels/battle?channelArn=...` - returns the current config (or 404). The channel ARN is a query-string parameter.

Tier gate: only premium-tier channels accept enable. Authorization: only channel moderators (the channel creator) can toggle.

### Channel Membership as Source of Truth

At `/battle` invocation time, the channel-flow-processor gates on tier, then reads
`ChannelBattleConfig` via `isBattleEnabled(channelArn)`, then lists memberships and
filters bot ARNs. This means:
- A battle-enabled channel has ≥2 bot members (default + alt-slot bound to treatment variant) → fan out.
- A channel where `ChannelBattleConfig.enabled === false` → the one-line "not enabled here" hint (Goal #6 / delivered-scope item 1). No `@all` fallback.
- **Degenerate case only:** battle *is* enabled but `botMembers.length < 2` (the alt-slot bot somehow isn't a member). This single internal-inconsistency path falls back to a single default-bot broadcast and surfaces no error.
- **Runtime read:** the processor reads `isBattleEnabled` so the not-enabled case produces the explanatory hint rather than a silent broadcast. `ChannelBattleConfig` is load-bearing at runtime, not admin/UI-only.

### `/battle` Detection

Channel-flow-processor extends the existing detection block:

```typescript
const mentionsAll = /@all\b/i.test(decodedContent);
const mentionsBattle = //battle\b/i.test(decodedContent);
```

Both `@all` and `/battle` are processor-side bypasses (not native Amazon Chime SDK mentions). The detection is mutually exclusive - if both are present, `/battle` wins.

### Fan-Out - Round 1 (Parallel)

When `/battle` is detected:

1. Strip the leading `/battle` command token from the message (`/^\s*\/battle\b/i`) to produce `cleanMessage`. `/battle` is parsed only at message start - it is a command, not an inline mention.
2. Tier gate: read channel metadata; if `modelTier !== 'premium'`, post a targeted bot reply to the sender explaining "battles are premium-only" and return.
3. **Battle-enabled gate:** `isBattleEnabled(channelArn)` (reads `ChannelBattleConfig`). If `false`, post the targeted one-line "not enabled here - ask a moderator" hint and return (Goal #6 / delivered-scope item 1). No `@all` fallback.
4. List channel memberships via `ListChannelMembershipsCommand` (with the default bot as `ChimeBearer`, since it's always present).
5. Filter to bot ARNs (members whose ARN contains `/bot/`).
6. **Degenerate-only:** if `botMembers.length < 2` (battle enabled but the alt-slot bot isn't a member - an internal inconsistency, not the not-enabled case), fall back to a single default-bot broadcast. Surface no error.
7. For each bot member, generate a per-bot `correlationId` (`battle-r1-<slotOrDefault>-<timestamp>-<rand>`) and send a placeholder message **as that bot**: `"One moment... <!--corr:{correlationId}--><!--battle:round=1,total=2,rivalArn={rivalArn}-->"`. The `Sender` of each placeholder is the bot itself (the processor calls `SendChannelMessageCommand` with `ChimeBearer: thisBotArn`).
8. For each bot member, invoke the async processor with the same payload shape used for `@all` plus a new `battleContext`:

```typescript
{
  channelArn,
  correlationId,
  userMessage: cleanMessage,
  userType: 'standard',
  botArn: thisBotArn,           // each bot's own ARN — default or alt-slot
  senderArn,
  intent: 'general',
  deliveryOption: 'PLACEHOLDER_UPDATE',
  battleContext: {
    round: 1,
    totalRounds: 2,
    selfBotArn: thisBotArn,
    rivalBotArn: rivalBotArn,
    // Round 1: rival reply not known yet
    rivalReply: undefined,
  },
}
```

Both invocations happen in parallel via `Promise.all`.

In the async processor:

- If `thisBotArn === defaultBotArn`: this is the **control** side. Call `experiment-manager.resolveBattleControlVariantByAltSlotArn(battleContext.rivalBotArn)` (from the default bot's invocation the rival ARN *is* the alt-slot ARN, and the experiment is keyed by it) to get the **configured control variant** `variants[0]` (`modelKey` + `displayName` + `systemPromptAddendum`). Use that model and the same prompt-assembly ordering as the treatment side. **Only if no battle/control variant resolves** does it fall back to the channel's normal tier+intent model resolution and the generic "the default assistant" name.
- If `thisBotArn` is an alt-bot slot: call `experiment-manager.resolveBattleVariantBySlotArn(thisBotArn)` to get the bound **treatment variant** `variants[1]` (`modelKey` + `systemPromptAddendum` + `displayName`). Use that model and assemble the system prompt per the "Prompt Addendum Sanitization" section's ordering.

> **Control-side resolution.** The control side honors the **configured control variant** (model + displayName + addendum), mirroring the treatment side - per the **Design Anchor** that *a `/battle` is the configured A/B experiment's two variants compared head-to-head*. It degrades to tier+intent behavior **only** when the channel has no resolvable battle/control variant, so non-battle chat and unbound channels are unchanged. Implemented in `experiment-manager.resolveBattleControlVariantByAltSlotArn` + `async-processor-core.prepareBattleInvocation`; pinned by `backend/test/lib/{experiment-manager,async-processor}-battle.test.ts`.

The `battleContext.rivalBotArn` is used in the next subsection to resolve the rival's `displayName` (the treatment's binding for the control side; the **control variant's `variants[0].displayName`** for the treatment side - resolved via the alt-slot ARN - each falling back to "the default assistant"/"the other assistant" only when unresolvable) for inclusion in the system prompt.

### Response Length - Intent-Aware

A /battle reply has two competing requirements. A conversational
comparison must be CONCISE: the human reads two answers side by side, so
a fast ~150-word answer is readable and low-latency (unconstrained
battles were generating 4-6k-char essays at 28-40s). A report/document
battle must instead produce the COMPLETE deliverable, delivered as a
downloadable attachment via the existing generateAndUploadDocument path,
and must NOT be truncated.

`prepareBattleInvocation` takes `longForm`, set by the caller as
`longForm = event.taskType === 'report_generation' || isDocumentRequest(userMessage)`
- the exact trigger the attachment-generation path already uses, so the
prompt instruction and the delivery mechanism never disagree.
`BATTLE_CONSTRAINTS_ROUND1` emits the ~150-word focus clause when
`!longForm`, and a "produce the COMPLETE deliverable; it is delivered as
a downloadable attachment; open with a 1-2 sentence approach summary so
the side-by-side stays scannable" clause when `longForm`. Relying on the
model to ignore a blanket conciseness cap for reports is explicitly
rejected as fragile - the distinction is deterministic. Round-2 rebuttal
stays concise for both (it is commentary; the deliverable is round-1).
Pinned by `backend/test/lib/async-processor-battle.test.ts`.

### Round-1 Completion Semantics (Intent-Aware)

Round 2 must not fire until **each bot has fully completed the intent** for the round-1 prompt - not merely posted its first `UpdateChannelMessage`. This matters because AE's `delivery-options` framework already supports multi-step intents:

| `DeliveryOption` | What "round-1 complete" means |
|------------------|------------------------------|
| `DIRECT` | The single direct reply is posted (no async invocation; round-1 complete the moment the bot's `SendChannelMessage` returns) |
| `PLACEHOLDER_UPDATE` | The async processor's `UpdateChannelMessage` lands (the existing case) |
| `TASK_UPDATE_IN_PLACE` | The task transitions to status `completed` or `failed` |
| `TASK_MULTI_STEP` | The task chain reaches a terminal `task_state` (a declared-graph state with no outgoing edges, i.e. disposition success/failure/handoff - e.g. `completed`, `resolved`, `escalated`), distinct from the `task_status` lifecycle. May span many user turns |

A rebuttal mid-task-chain is nonsensical - the rebutting bot doesn't yet know what the rival is producing. The orchestrator therefore tracks **intent completion**, not message-write completion.

**All delivery options are supported.** There is **no `TASK_*` refusal** - `DIRECT`, `PLACEHOLDER_UPDATE`, `TASK_UPDATE_IN_PLACE`, and `TASK_MULTI_STEP` are all in battle scope, and the completion-semantics table above is load-bearing for the report/document battles.

### Fan-Out - Round 2 (Rebuttals, Bot Opt-In)

A new orchestrator Lambda - `battle-orchestrator` - coordinates round 2. The trigger is **both bots reaching round-1 completion** as defined above.

Implementation:

1. The `BattleStateTable` (DDB) is keyed by `battleId` (a deterministic id derived from the user message id + channelArn). Each row carries two slots - `selfDone` and `rivalDone`. When a bot's async processor reaches round-1 completion, it writes its slot conditionally on the corresponding flag being unset.
2. After each conditional write, the processor reads the row back. If both flags are now set, this writer invokes the orchestrator (passing both round-1 reply texts and message ids). If only one is set, the other will fire it on its own completion.
3. For `PLACEHOLDER_UPDATE`, this fires from the async-processor's tail. For `TASK_*`, the write fires from the task-state-machine's terminal transition.

The orchestrator then, for each bot:

1. Sends a round-2 placeholder: `"<!--corr:{newCorrId}--><!--battle:round=2,rivalReplyMsgId={msgId}-->"`.
2. Invokes the async processor with `battleContext.round=2` and `battleContext.rivalReply={text}`.
3. The async processor augments the variant's system prompt (control or treatment) with:
   - The original user prompt
   - This bot's own round-1 reply
   - The rival's round-1 reply
   - The rival's display name
   - Instruction: *"You may rebut, build on, or concede to the rival's reply. You may also choose not to add anything - respond with the single token `NO_REBUTTAL` if so. The human is reading both replies; they do not need filler."*
4. If the model returns `NO_REBUTTAL` (case-insensitive, trimmed, possibly with trailing punctuation), the processor calls `DeleteChannelMessageCommand` on the round-2 placeholder for that bot. No round-2 message from that bot persists. Both bots opting out is a valid outcome.

The `BattleStateTable` entry is deleted (or TTL-expires after 10 minutes) once round 2 completes.

### Per-Assistant State Model

Each bot in a battle runs its own independent state machine for the round-1 prompt. The two machines do not share state; the orchestrator is the only component that knows about both.

States (per bot, per battle):

| State | Meaning | Triggered by | Next state |
|-------|---------|--------------|------------|
| `INVOKED` | Async processor has the payload, generating | Channel-flow-processor fan-out | `COMPLETED` (PLACEHOLDER_UPDATE finished) / `FAILED` (Bedrock error after retries) / `WAITING_FOR_USER` (clarification asked) |
| `COMPLETED` | Round-1 reply posted, no pending clarification | Async-processor tail | Orchestrator checks pair, fires round 2 when both done |
| `WAITING_FOR_USER` | Bot asked a clarifying question and is waiting for the user's reply | TASK_* state machine `awaiting_input` transition | Returns to `INVOKED` when user replies, then `COMPLETED` when full intent finishes |
| `FAILED` | Bot's round 1 errored irrecoverably | Bedrock failure after retries / circuit-breaker open | Treated as `COMPLETED` for orchestrator purposes (failure message stays as the round-1 reply; rival can still rebut or stay silent) |

State is stored in `BattleStateTable` per-bot row alongside the round-1 reply text and message id:

```
PK: battleId (string)         // sha256(channelArn + ':' + userMessageId).hex.slice(0,16)
SK: botArn (string)           // per-bot row
Attributes:
  state: 'INVOKED' | 'WAITING_FOR_USER' | 'COMPLETED' | 'FAILED',
  round1Reply: string,        // populated when COMPLETED
  round1MessageId: string,    // populated when COMPLETED
  enteredStateAt: ISO,
  ttl: epoch + 600
```

The orchestrator queries the `battleId` partition. Round 2 fires when **all** rows have `state ∈ {COMPLETED, FAILED}` - exactly the "both done" trigger but explicit about which terminal states count.

### Clarification Routing in Multi-Bot Channels

The hard case: one bot finishes round 1 with a complete answer; the other asks a clarifying question. How does the user reply to the asker without confusing the finisher?

**Clarification is a *measured* dimension, not a forbidden one.** How often each model asks a good clarifying question vs. wrongly forges ahead on an ambiguous prompt is *part of what a battle measures*. Forbidding the question would destroy that signal. The clarification-routing problem is therefore solved, not avoided.

A battle bot that genuinely needs input asks exactly **one** concise question and emits the explicit `NEED_CLARIFICATION` sentinel on its own line (the same explicit-model-signal design as `NO_REBUTTAL` - never substring inference). On a round-1 reply:

- **Sentinel present →** the asking bot transitions `INVOKED → WAITING_FOR_USER` (per-bot, *not* broadcast). It is **not** round-1-complete, so the round-2 orchestrator is **suppressed** until this bot later completes. `clarificationCount` (an idempotent atomic counter) and `activeResponseMs` (elapsed − time spent waiting on the user) are captured as metrics.
- **No sentinel →** the reply *is* the bot's complete answer; the normal round-1-complete / orchestrator path runs unchanged.

Broadcasting one user answer to every waiting bot would contaminate the measurement (a bot that failed to ask would still benefit from its rival's clarification), so the loop stays per-bot isolated: the user's answer is routed only to the bot it `@`-mentioned.

The full path is in place: detection `parseBattleClarification`; state `markBotWaitingForUser` + `clarificationCount` and async-tail engage + orchestrator suppression; per-bot routing `planBattleContinuation`; targeted-question delivery (show waiting state, not the question); resume state `resumeBotFromWaiting` + `waitedMs`; channel→battle pointer; `taskId` on the row; continuation engage PLACEHOLDER + TASK_* chain resume; same-placeholder reuse so no orphan waiting message; telemetry `clarificationCount` / `activeResponseMs` → analytics; frontend parser/provider/composer; and the round-1 prompt that permits the gated question. E2E round-trip cases are declared in `tests/e2e/battle.spec.ts` (fixme until a battle-enabled deploy, same as the rest of that scaffold). **Not captured:** the verbatim Q&A *text* recap in the end-of-battle summary (needs answer-text retention; `resumeBotFromWaiting` clears `clarificationQuestion`); the quantitative measured dimension (`clarificationCount` / `activeResponseMs`) is captured.

**Per-bot reply UX (the continuation/resume path).** The composer has an inline "Replying to:" selector when any bot in the channel is `WAITING_FOR_USER` (single-select: defaults to the most-recent waiter, switchable when several wait; multi-select/"all" needs a `targetArns[]` send-path extension, which the backend `planBattleContinuation` already supports):

- Default selection: the most recent bot to enter `WAITING_FOR_USER`.
- User can toggle to any subset of waiting bots (or "all").
- Selection emits `MessageAttributes.CHIME.mentions = [...selectedBotArns]` so native Amazon Chime SDK routing delivers to the right bots.
- A small "1 of 2 assistants is waiting for your reply" affordance shows above the composer.

The router uses the `CHIME.mentions` set + each bot's state to decide who consumes the user's reply. A bot in `WAITING_FOR_USER` consumes a directed reply and transitions back to `INVOKED`. A bot not in `WAITING_FOR_USER` ignores the reply unless explicitly addressed - it has already finished its round 1.

### Task-Tracking Implications

Today `UserTasksTable` (PK `userSub`, SK `taskId`, GSI `userSub-taskType-index`) treats "is there an active task for this user?" as a single answer per user. In `/battle`, two bots may independently spawn tasks on the same user prompt.

Because `TASK_*` battles are supported and clarification is a measured dimension, the per-bot task isolation below is implemented:
- Add `botArn` (or a stable `botId`) to `Task` and `UserTask` records.
- Replace the `userSub-taskType-index` GSI with `userSub-botArn-taskType-index`, so `hasActiveTask` becomes `hasActiveTaskForBot(userSub, botArn)`. Two bots can each have an active task chain for the same user concurrently.
- Continuation message routing uses the per-bot reply UX from the previous section (`CHIME.mentions` + `WAITING_FOR_USER` state). A continuation message addressed to bot X resumes X's task and is invisible to bot Y's task state.
- The `experiment-manager` cache and analytics metadata fields gain `botArn` consistently.

The `BattleStateTable` design is forward-compatible with `TASK_*` round-1 completion semantics - only the trigger point changes (task terminal transition vs. async-processor tail), not the table shape.

### Battle-Context Marker

Two metadata markers participate:

- `<!--corr:{id}-->` - existing correlation marker, unchanged.
- `<!--battle:round={n},total={total},rivalArn={arn},rivalReplyMsgId={msgId?}-->` - new. Visible in raw content; stripped by `messageParser.ts` and the Bedrock Guardrail metadata filter before display.

`messageParser.ts` gains a `battle` field on the parsed message: `{ round: 1|2, rivalBotArn, rivalReplyMsgId? }`. The frontend uses this to render round dividers and to link rebuttals back to the message they're responding to.

### Admin UI - Experiments Tab Extension

The existing `frontend/src/components/admin/ExperimentsTab.tsx` gets three new fields on the create/edit form:

1. **`Battle Enabled` checkbox** (experiment-level). Disabled when `variants.length !== 2`.
2. **Per-variant `Display Name`** (max ~16 chars, defaults to model name). What end users see ("Atlas" vs "Echo").
3. **Per-variant `System Prompt Addendum`** (textarea, max ~500 chars). Layered on top of the tier's base system prompt for invocations served by this variant.

When `Battle Enabled` is checked, a fourth control appears: **`Alt-Bot Slot`** dropdown listing available slots from `/agent-echelon/alt-bot-slots/roster` minus any that are already bound to another active battle experiment. Saving with no available slots surfaces an actionable error ("Free a slot by disabling another battle experiment, or raise `ALT_BOT_SLOT_COUNT` in the next deploy").

Save flow on a battle-enabled experiment:
1. Resolve the chosen `altBotSlotId` → `altBotSlotArn` from the SSM roster.
2. Persist the experiment record including `altBotSlotArn`, `boundBy: callerArn`, `boundAt: now()`.
3. Cache invalidation (existing path) - the next async-processor invocation reloads.

Disabling battle on an experiment (or deleting it) requires no channels to currently have it enabled - the API surfaces a 409 listing the affected channels and the admin must disable battle on each first. This is the same shape as `@all`'s pre-existing channel-flow association cleanup.

### Channel UI - Enable Battle Toggle

In the channel's settings or members panel (existing `MembersPanel.tsx` is the simplest home):

- A new "Battle Mode" section, visible only to channel moderators of premium-tier channels.
- Off by default. When toggled on, the UI calls `POST /channels/battle/enable` with a body containing the channel ARN and the experiment id (if multiple battle experiments match the channel's intent, the UI shows a picker).
- The new alt-bot slot member appears in the members list with its `displayName` from the binding.
- A small inline hint in the composer: "Battle enabled - try `/battle <your prompt>`."

### Frontend Rendering

`ConversationProvider.chime.tsx` and the message list component get three changes:

1. **Variant-aware avatar/color** - bot messages carry the sender ARN. Map each bot ARN: default bot keeps its current look; alt-bot slot uses the `displayName` from the binding and gets a distinct color from the existing tier-color tokens (no new design tokens).
2. **Round divider** - when consecutive messages from one battle invocation carry `battle.round=1` followed by `battle.round=2`, render a thin " - Round 2: rebuttals - " divider between them. If a bot opted out of round 2, the divider still renders if the other bot did respond.
3. **Sticky mention UX** - extends the existing `@all` / `@assistant` autocomplete in the composer. `/battle` shows in the suggestion list only when (a) the channel is premium-tier and (b) `ChannelBattleConfig.enabled === true`.

Storage shape and message API are unchanged; the additions are purely render-time concerns reading the existing `Metadata` field.

### `@all` and `@<displayName>` Semantics in Multi-Bot Channels

When a channel has ≥2 bot members, the existing routing tokens carry these semantics:

| Token | 1-bot channel (today) | Battle-enabled channel (≥2 bots) |
|-------|----------------------|----------------------------------|
| `@all` | Default bot broadcasts a reply | **Default bot broadcasts a short clarification** asking which assistant should respond (e.g., "Both Atlas and Echo are listening. Mention `@Atlas`, `@Echo`, or `/battle` to compare them"). The clarification reply is broadcast (visible to all members), is generated without an LLM call (deterministic templated text), and does **not** consume a turn against the bound model variant. |
| `/battle` | One-line "Battle Mode isn't enabled here - ask a moderator" hint to the sender; nothing broadcast (delivered-scope item 1) | Fan-out to all bot members with round-1 + opt-in round-2 (this spec's main flow) |
| `@<displayName>` (e.g., `@Atlas`) | N/A | Frontend autocomplete lists channel bot members by display name. Selecting one inserts the bot's ARN into `CHIME.mentions` and Amazon Chime SDK's native `AUTO + ALL` routing delivers the message to that bot specifically. No processor-side bypass needed - this is the same path `@assistant` uses today |
| `@assistant` | Default bot reply via native `CHIME.mentions` | Default bot reply via native `CHIME.mentions` (unchanged - `assistant` always resolves to the default bot ARN for backward compatibility) |

**Rationale for the clarification path on `@all`:** doing nothing (only the default bot replies) trains users that the alt-bot is invisible to broadcasts and undercuts the value of having both members present. Having both bots auto-respond to `@all` doubles cost on every broadcast and is what `/battle` is *for*. The clarification keeps the addressee explicit, costs almost nothing, and makes `/battle` discoverable.

**Implementation:**

- `channel-flow-processor.ts` `@all` branch (`mentionsAll === true`): list memberships, count bot members. If `botCount === 1`, existing single-bot broadcast behavior. If `botCount >= 2`, send the clarification template from the default bot as a broadcast (`Target` unset) and do **not** invoke the async processor.
- Composer autocomplete in the frontend already knows the channel members (used for `@assistant` today). Extend it to list display names for all bot members. Selecting `@Atlas` etc. emits a regular `SendChannelMessage` with `MessageAttributes.CHIME.mentions = [botArn]`. The processor and bot's `AUTO + ALL` config route it correctly without changes.

### Tier and Cost Guard

A battle is up to **4 model invocations per `/battle` token** (2 personas × 2 rounds). To protect against runaway cost:

- `/battle` requires `modelTier === 'premium'`. Enforced in the channel-flow-processor.
- A simple per-channel rate limit: max 1 active battle at a time (the `BattleStateTable` doubles as a lock). A second `/battle` while one is in flight gets a targeted bot reply: "A battle is already in progress; please wait."
- `bedrock-resilience.ts` already covers retries and circuit breaking; no battle-specific resilience needed.

### Drift Detection Interaction

AE has a drift-detection module (`backend/lambda/src/analytics-aurora/drift-detection.ts`). Both its analytics path (post-hoc, from the kinesis-archival pipeline) and its live-suggestion path (from router-agent-handler, gated by `enableLiveDrift`) interact with battle messages - but differently.

Battle is, by definition, an intentionally divergent mode. Each variant is asked to produce its own answer to the same prompt, and rebuttals are expected to wander. Drift detection's purpose ("the user has shifted topic; offer to start a new conversation") would fire constant false positives on battle exchanges if run unchanged.

**Live path - fully suppressed.** When a channel has `ChannelBattleConfig.enabled === true`, the router-agent-handler skips its entire live drift block (see `SPEC-DRIFT-CONVERGENCE.md` "Interaction with `/battle`" and `backend/lambda/src/lib/battle-state.ts`). No drift suggestions are emitted to users in battle-enabled channels - neither during a `/battle` invocation nor on regular (non-`/battle`) messages in the same channel.

Rationale: two competing UI flows ("compare these two answers" vs "want to start a new conversation about a new topic?") confuse the user about what the channel is for. The user enabled battle explicitly; drift suggestions undercut that.

**Analytics path - runs but tagged.** The post-hoc `detectDrift()` call in `kinesis-archival.ts` still runs on battle messages so historical drift telemetry remains complete. Battle-mode drift events should be filtered out of quality-metric rollups (TPR/FPR) since they're known divergent. Channel-level filtering is available via joining `drift_events.parent_channel_arn` against the battle-enabled channel list; a dedicated `created_during_battle` column on `drift_events` is an optimization if rollups get noisy.

**System prompt suppression** - defense in depth, since the battle-mode bots could still emit drift-flavored text on their own initiative. The round-1 augmentation includes:

> *"You are in a battle. Do not propose starting a separate conversation or suggest the user is off-topic. The user invoked `/battle` intentionally; divergence between you and your rival is the point."*

This prevents the variant itself from emitting drift-style suggestions ("This sounds like it should be its own conversation...") in round-1 or round-2 responses - orthogonal to the router-level suppression, since the bot can produce that text directly without the module being involved.

### Analytics

Battle invocations write two new fields into `analyticsMetadata` for every bot response:

```typescript
analyticsMetadata: {
  // ...existing fields (intent, modelId, latency, wasFallback, retryCount, experimentId, variantId, etc)...

  /** How was the model variant chosen for this response? */
  assignmentMode: 'probabilistic' | 'battle',

  /** Set iff assignmentMode === 'battle' */
  battleContext?: {
    battleId: string,            // sha256(channelArn + ':' + userMessageId)[:16]
    round: 1 | 2,
    selfBotArn: string,
    rivalBotArn: string,
    optedOutOfRound2?: boolean,  // true if this row records a NO_REBUTTAL deletion

    /** delivered-scope item 4 — per-step breakdown for this variant's
     *  contribution to the turn. One entry per generation/task/image step. */
    steps?: Array<{
      stepLabel: string,         // e.g. 'round1-generate', 'task:report-section-2', 'round2-rebuttal', 'image-gen'
      modelId: string,           // the model that actually ran this step (may differ from variant default on fallback)
      startedAt: string,         // ISO
      endedAt: string,           // ISO
      tokensIn?: number,
      tokensOut?: number,
      imageCount?: number,       // generation-out only
      estCostUsd?: number,       // tokensIn/out × model-rate, or per-image rate; computed at write time
    }>,
  },
}
```

Plus a **battle-outcome record** (delivered-scope item 3), one per battle,
written when the user makes the head-to-head pick:

```typescript
battleOutcome: {
  battleId: string,
  winner: 'A' | 'B' | 'tie',   // A = control variant, B = treatment variant
  chosenByUserSub: string,
  chosenAt: string,            // ISO

  // Join the pick to the experiment so it counts as a per-variant signal in
  // the Experiments results, not just a per-battle record (Battle Objectives, below).
  experimentId?: string,
  variantId?: 'control' | 'treatment',  // resolved from `winner` + the bound experiment
  intent?: string,
}
```

This is descriptive only - it is never read back into variant/model selection
(see the "Algorithmic judging" Non-Goal). The `experimentId` /
`variantId` / `intent` fields do not change that: they let the pick be
*aggregated* per variant in the results table, not auto-routed.

**Why `assignmentMode` is at the top level, not nested under `battleContext`:** the Experiments tab's variant-comparison rollups must be able to filter out battle invocations *before* per-variant aggregation. If `assignmentMode` were nested under `battleContext`, every rollup would need to "is `battleContext` present?" - a foot-gun the moment someone forgets. Promoting it to a top-level enum forces every query that compares variants to explicitly opt into one mode.

**Default rollup behavior:**
- Variant comparison dashboards (response quality, latency, error rate by variant) filter `WHERE assignmentMode = 'probabilistic'` by default. Toggle "include battle data" surfaces the union.
- Battle-specific dashboards (round-2 opt-out rate, time-to-both-complete, persona-vs-persona response patterns) filter `WHERE assignmentMode = 'battle'`.
- Default tier/intent dashboards (not variant-comparison) include both modes since the data is real user-facing traffic.

This lands in both Athena and Aurora pipelines (additive - no schema migration; the fields ride on the existing JSON metadata column. Aurora can add a generated column / index later if rollup performance becomes an issue).

Admin dashboard work surfaces battle-specific stats: the per-step latency/model/cost breakdown to admins, and the compact three-axis scorecard to users. Data capture, the `assignmentMode` filter, the per-step admin breakdown, and the user-facing scorecard all ship together.

### Battle Scoring & Per-Step Telemetry (UI)

Per delivered-scope items 3 and 4. Two surfaces, one data source
(`battleContext.steps[]` + `battleOutcome`):

**User-facing - compact scorecard, inline in the battle.** After both variants'
round-1 replies land, render a scorecard between/under the pair:

| | A · _controlDisplayName_ | B · _treatmentDisplayName_ |
|---|---|---|
| Response time | round-1 wall-clock (sum of step durations) | " |
| Est. cost | Σ `step.estCostUsd` for the turn | " |
| Quality | - pick control of: **[ A better ]  [ Tie ]  [ B better ]** - | (single shared control) |

- Three columns, **no composite number** - the user reads the trade-off
  themselves (fast+cheap vs. slow+expensive, then their own quality call).
- The "pick the winner" control writes the `battleOutcome` record. It is the
  *only* interactive part; time/cost are display-only. One pick per battle per
  user; re-picking overwrites (last write wins, `chosenAt` updated).
- An expander ("Show steps") reveals the per-step rows (`stepLabel`, `modelId`,
  duration) - the same data admins see, available to the user on demand. This
  is the explicit "made visible to users" requirement; it is not admin-gated.
- Cost is shown as an **estimate** with a tooltip ("based on published model
  rates; not a bill"). Rates live in a small `MODEL_RATE_TABLE` constant
  (text: $/1k in+out; image: $/image) - keep it in one place; it is
  approximate by design and must not be presented as authoritative billing.

**Admin-facing - full per-step breakdown.** The Experiments tab (or a battle
sub-view) lists battles with: per-variant total time, total est. cost, the
expandable `steps[]` table (every step's model + duration + tokens/images),
the `battleOutcome.winner`, and aggregates (win rate by variant **for display
only**, mean time, mean cost). Filter `WHERE assignmentMode = 'battle'` as the
existing Analytics section already specifies. **No ranking feeds back into
selection** - see the Non-Goal.

> **`steps[]` capture - generalized beyond battle.** Per-step
> telemetry is produced for EVERY turn, not just battles: `invokeBedrock`
> instruments each Converse iteration of the self-hosted tool loop
> (`generate` / `tool:<names>` / `tool-propose:<name>`) as a `ConverseStep`
> (`makeConverseStep`), the standard external (Chinese) path synthesizes one
> `generate` step, and `finalizePlaceholderResponse` persists the array **out of
> band** in the message-analytics record keyed by message id - NOT on the
> ≤1024 Amazon Chime SDK Metadata. Archival merges that record into Aurora's
> `messages.metadata` JSONB, so `steps[]` is queryable there with no cap and no
> schema change. This resolves the open item below ("how `steps[]` is assembled")
> for the tool-loop case; each TASK_* state-machine transition is a separate
> processor invocation, so it already emits its own per-message step record.
> Design + rationale: `docs/specs/conversation-messaging/SPEC-MESSAGE-METADATA-CODEBOOK.md` (Phase 1).
> **Admin steps table.** The admin console surfaces the
> per-step breakdown: `frontend/src/components/admin/StepsTab.tsx` (Models section,
> Aurora-only) lists recent bot turns that carry steps and expands each into the
> full per-step table (label, model, duration, tokens, est. cost). Backed by
> `getExecutionSteps` (GET `/analytics/execution-steps` + the `execution_steps`
> POST queryType) reading `messages.metadata->'steps'`. Tests: `StepsTab.test.tsx`.

**Approximate / deployer-tunable details:** exact
`MODEL_RATE_TABLE` values; whether the user scorecard is one block under the
pair or a sticky element; `steps[]` assembly for `TASK_*` (each task
state-machine transition emits a step) vs. the simple round-1/round-2 case;
image-gen step cost granularity.

### Battle Objectives - Feedback Capture and Live Decision

Battle Mode has two jobs the probabilistic A/B split does slowly or not at all:
**(1) collect direct human feedback**, and **(2) give administrators and users a
real-time, tangible experience they can use to drive a decision.** The scorecard +
pick-the-winner start both; the live tally (Objective 2) closes the gap. Companion:
`docs/guides/admin/GUIDE-AB-TESTING-AND-BATTLES.md`.

**Objective 1 - drive more user feedback.**

- **Join the pick to the variant.** The `battleOutcome` record gains
  `experimentId` / `variantId` / `intent` (above). `winner` maps to a variant
  (`A`→control, `B`→treatment, `tie`→both credited). With that join, every pick
  becomes a per-variant quality signal in `experiment_results`, feeding the
  experiment's Quality objective - not just a per-battle row. This is the same
  feedback-join linchpin as thumbs; battle
  picks and thumbs land in the same per-variant feedback aggregate.
- **One-tap thumbs after a round.** Alongside the A/B/tie pick, offer a quick
  thumbs up / thumbs down on each side's reply. The pick is comparative (which
  was better); thumbs are absolute (was this one good), and the two answer
  different questions. Thumbs carry the same `experimentId` / `variantId` join.
- **Make the ask legible.** Surface a "**N picks collected toward a confident
  call**" progress line in the scorecard (target = the experiment's
  minimum-sample rule), so users see their input matters and admins see how
  close the battle is to a decision.

**Objective 2 - a real-time, tangible decision experience.**

- **Running tally tied to the objective.** - implemented. `BattleTallyBar`
  (`frontend/src/components/BattleTallyBar.tsx`) renders a sticky per-conversation
  tally above the message stream that updates live as rounds are answered and the
  user picks: per-side wins, the speed/cost/preferred leaders, ties, and an "N / target
  picks toward a confident call" progress nudge. The aggregation is a pure,
  unit-tested helper (`frontend/src/utils/battleTally.ts` `computeBattleTally`,
  keyed by stable bot label so a flipped per-round A/B order can't mix the sides);
  each `BattleScorecard` reports its pick up via `onOutcomeChange` so the bar is
  live, not a post-hoc report. The soft confidence target (`BATTLE_CONFIDENCE_TARGET`,
  picks) is a UX nudge distinct from the admin A/B statistical threshold
  (MIN_SAMPLE_PER_VARIANT, exchanges). Binding the framing to a specific declared
  `objective` metric (vs. showing all three axis leaders) is out of scope; the
  objective lives on the Experiment record, not the conversation surface.
- **Admin live view.** - implemented via the per-variant `battle_wins` column in
  `experiment_results`: the Experiments tab's
  "Battle wins" row shows accumulating picks per variant alongside thumbs, the
  slow cross-conversation counterpart to the in-conversation live tally. Same
  experiment, same picks, two speeds.

**Non-goal unchanged.** None of this auto-routes. Objectives are advisory;
a leading variant produces a recommendation,
and promotion stays the deliberate manual path. The feedback join makes the
signal *visible and aggregated*, never a control loop.

### Image Battles - Vision-In and Generation-Out

> Both modalities are in place. Vision-in reuses the
> attachment pipeline. Generation-out covers: the basic-default image-output
> guardrail; the image-gen registry + shaper/parser + per-image rates + live
> `invokeImageGenModel` (throttle/quota retry only, **no cross-model fallback**)
> + guardrail instantiation/IAM/env; a per-attempt timeout cost guard; S3
> `persistImageGenOutput` + presigned GET (honest no-image path); premium-battle
> wiring (`resolveBattleGenerationOutPlan`, `<!--battleimage:{json}-->` marker,
> per-image battlestats cost); frontend marker parse + in-bubble renderer; the
> variant `imageGenModelKey` + resolver + fan-out population + `battle-images/*`
> IAM; the admin per-variant image-gen selector (both-or-neither); and the
> deployer count/dimension cost cap (`min(registry, cap)`). See
> `docs/guides/admin/IMAGE-GEN-PROVIDERS.md`. The e2e behavioral cases
> (`tests/e2e/battle.spec.ts`) require a battle-enabled deploy.

Per delivered-scope item 2. Two distinct modalities; they share the battle
fan-out machinery but differ in payload and rendering.

**Vision-in (battle two vision models on an uploaded image / scanned doc).**
- Reuses the existing attachment pipeline (`PresignedUrl` Lambda + S3). The
  `/battle` turn's payload, for each variant, includes the attachment
  reference; each vision-capable variant model receives the image as input
  (Bedrock Converse image content block).
- No new model is required *if* both battle variants are already
  vision-capable Claude models. If a variant is text-only, the battle-enable
  check must reject the pairing with an actionable message (analogous to the
  existing tier-safety reject).
- Renders like a normal text battle (the answer is text *about* the image);
  the round/variant layout is unchanged.
- Open: per-variant image-token accounting in `steps[].tokensIn`; binding a
  specific attachment to a `/battle` turn when the channel has several.

**Generation-out (battle two image-generation models on a prompt).** The
single largest sub-workstream - **net-new modality, zero precedent in the
codebase**:
- Needs a Bedrock image-gen model (Titan Image Generator or Nova Canvas - 
  **model choice is an explicit open decision**, not assumed here), new IAM
  for that model, and a cost path (per-image, not per-token).
- **Guardrails - basic default + documented deployer responsibility.** The
  current Bedrock Guardrail config covers text I/O only. Generation-out
  ships a **basic default image-output guardrail** following the existing
  Bedrock Guardrails construct pattern (a reasonable content-moderation
  baseline on generated images). It is **not** gated on an internal AppSec
  sign-off - this is open-source software; production-grade image moderation
  tuned to a deployer's risk profile is **the deployer's responsibility**,
  and the README / deploy docs must say so explicitly. Scope here = the
  basic default + the responsibility note, nothing organizational.
- Frontend: a new image message renderer that fits the existing round-divider
  + variant-chip layout (variant A's image vs variant B's image, side by
  side, each chip-labelled). No new design tokens if avoidable; reuse the
  battle-message container.
- `steps[]` carries `imageCount` and per-image `estCostUsd`; the scorecard's
  "Response time" and "Est. cost" axes work unchanged, "Quality" pick-the-
  winner works unchanged (the user compares two images instead of two texts).
- Async pattern: image gen is slower than text - reuse placeholder + update
  (the existing `PLACEHOLDER_UPDATE` mechanism), with the placeholder showing
  a generating-image affordance.
- Open: model choice; output storage (S3 + presigned read, mirroring
  attachments); max resolution / count caps for the cost guard; the exact
  basic-default image-guardrail config to ship + the deploy-doc wording
  that hands production tuning to the deployer.

**Capability progression:**
single-turn (`DIRECT`/`PLACEHOLDER_UPDATE`) → report-creation (`TASK_*`) →
document-creation (`TASK_*` + attachment output) → image vision-in → image
generation-out. The scorecard + pick-the-winner appears from the first battle
onward, so every stage of the progression shows time/cost/quality.

## Specific Changes

### Code

| File | Change |
|------|--------|
| `backend/lib/stacks/battle-stack.ts` | Provision `ALT_BOT_SLOT_COUNT` `CfnAppInstanceBot` slots; write per-slot SSM ARN params + roster JSON param; provision `BattleStateTable` (DDB, PK: `battleId`, SK: `botArn`, TTL: 10 min) + `ChannelBattleConfigTable`; grant IAM to async processor + orchestrator + admin/user-mgmt APIs |
| `backend/lambda/src/lib/experiment-manager.ts` | Extend `Experiment` + `ExperimentVariant` with `battleEnabled`, `altBotSlotId`, `altBotSlotArn`, `boundBy`, `boundAt`, `displayName`, `systemPromptAddendum`; add validation (2 variants + slot + displayName required when battle-enabled, conflict 409 when slot already bound); sanitize `systemPromptAddendum` server-side per the rules; export `deriveBattleId()` and `resolveBattleVariantBySlotArn()` |
| `backend/lambda/src/channel-flow-processor.ts` | Add `/battle` detection branch; tier guard; member listing; fan-out invocation of async processor per bot member |
| `backend/lambda/src/lib/async-processor-core.ts` | Accept `battleContext` from invoke payload; resolve variant config from `BattleVariantBinding` when `botArn` is an alt slot; augment system prompt with addendum + rival display name + battle-mode constraints (no clarifying questions, no drift suggestions); write per-bot row to `BattleStateTable` with state transitions; handle `NO_REBUTTAL` sentinel by deleting the round-2 placeholder |
| `backend/lambda/src/analytics-aurora/drift-detection.ts` | Accept optional `battleContext` parameter; tag `drift_detection` rows with `battle_id` when present; `detectDriftWithSuggestion()` short-circuits when `battleContext` is set |
| `backend/lambda/src/analytics-aurora/schema/` | Add migration (e.g., `005-battle-tagging.sql`) adding `battle_id` nullable column to `drift_detection` |
| `backend/lambda/src/battle-orchestrator.ts` (new) | Reads `BattleStateTable`, fires round 2 for each bot member once both round-1 replies are in |
| `backend/lambda/src/channel-battle.ts` (new) | API handler for `POST /channels/battle/enable`, `POST /channels/battle/disable`, `GET /channels/battle` (channel ARN in the request body for POST, query string for GET); writes `ChannelBattleConfigTable`; calls Amazon Chime SDK `CreateChannelMembership` / `DeleteChannelMembership` for the alt-slot ARN |
| `backend/lambda/user-management.ts` (or `cognito-auth-stack.ts` API) | Wire the new channel-battle endpoints into the existing admin API Gateway |
| `frontend/src/services/experimentService.ts` | Extend `Experiment` + `Variant` types with the new fields; add `setBattleBinding` call |
| `frontend/src/services/channelService.ts` (new or existing) | Add `enableBattle(channelArn, experimentId)` and `disableBattle(channelArn)` |
| `frontend/src/components/admin/ExperimentsTab.tsx` | Add Battle Enabled checkbox, per-variant Display Name + System Prompt Addendum, Alt-Bot Slot picker |
| `frontend/src/utils/messageParser.ts` | Parse `<!--battle:...-->` marker into a `battle` field on `Message` |
| `frontend/src/types/index.ts` (or wherever `Message` lives) | Add optional `battle: { round, rivalBotArn, rivalReplyMsgId? }` field |
| `frontend/src/components/MessageList.tsx` (or equivalent) | Render round divider + variant avatar/color |
| `frontend/src/components/MessageComposer.tsx` (or equivalent) | Add `/battle` to mention autocomplete; gate on premium-tier + battle-enabled |
| `frontend/src/components/MembersPanel.tsx` | "Battle Mode" toggle for moderators of premium channels; picker when multiple battle experiments match |

### Documentation

| File | Change |
|------|--------|
| `docs/specs/experiments-battle/SPEC-BATTLE.md` | This document |
| `docs/guides/admin/GUIDE-AB-TESTING-AND-BATTLES.md` | Deployer/operator guide for arming and running battles |
| `docs/overview/ARCHITECTURE.md` | Mention-routing table includes `/battle`; documents the persona membership model |
| `CLAUDE.md` | The channel-flow-processor table shows the `/battle` row; notes the 2-persona Premium gate |

### Tests

| Test | Behavior |
|------|----------|
| Unit: `channel-flow-processor` `/battle` detection | Detects `/battle` only at message start (not mid-message), gates on premium tier, returns the "not enabled" hint when `isBattleEnabled` is false, degenerate single-bot fallback only when battle is enabled but <2 bot members |
| Unit: `battle-orchestrator` | Pairs the two round-1 completions correctly; fires round 2 exactly once |
| Unit: `async-processor-core` battleContext handling | System prompt augmentation is deterministic; `NO_REBUTTAL` triggers placeholder deletion; per-bot state row transitions INVOKED → COMPLETED |
| Unit: `BattleStateTable` orchestrator trigger | Two bots transitioning to COMPLETED concurrently produces exactly one orchestrator invocation; one COMPLETED + one FAILED also fires round 2 |
| Unit: drift-detection battle bypass | When `battleContext` is set, `detectDriftWithSuggestion()` short-circuits without an LLM call; analytics-path `detectDrift()` runs but tags the row with `battle_id` |
| Unit: `messageParser` battle marker | Parses round, rivalId, rivalReplyMsgId; strips marker from displayed content |
| E2E: `tests/e2e/battle.spec.ts` (new) | Two-persona premium channel; `/battle <prompt>` produces round-1 from both, round-2 dividers render, one persona opts out and no orphan placeholder remains |
| E2E: `/battle` in a channel without Battle Mode enabled | Sender gets the one-line "not enabled - ask a moderator" hint; nothing is broadcast (delivered-scope item 1) |
| E2E: `/battle` in non-premium channel | Returns targeted "premium-only" reply to sender |

## Capability groups

The feature comprises the following capability groups (all implemented). The
table records their dependency structure and risk profile.

| Group | Scope | Depends on | Risk |
|---|---|---|---|
| **0 - Foundation** | Single-turn `/battle`: end-to-end wiring, `tests/e2e/battle.spec.ts`, alt-bot slot pool provisioned. | - | Low |
| **1 - Scorecard + per-step telemetry** | Backend: `battleContext.steps[]`, `battleOutcome` record, `MODEL_RATE_TABLE`. User UI: 3-axis scorecard + "Show steps" expander + pick-the-winner. Admin: per-step breakdown + display-only aggregates. | Group 0 | Low - Med (cost-estimate accuracy; "not a bill" framing) |
| **2 - `TASK_*` battles** | `UserTasksTable` → `userSub-botArn-taskType-index` GSI + per-bot task isolation; `WAITING_FOR_USER` + per-bot continuation routing ("Replying to:" composer + `CHIME.mentions`); report-creation battle; document-creation battle (`TASK_*` + attachment output). | Group 0; uses Group 1 | **High** (GSI migration on a live table; two-bot task concurrency; continuation UX) |
| **3 - Image vision-in** | Attachment → per-variant `/battle` payload (Converse image block); vision-capable-variant guard on battle-enable; per-variant image-token accounting. | Group 0; uses Group 1 | Low - Med |
| **4 - Image generation-out** | Basic default image-output guardrail (Bedrock Guardrails construct pattern) + the deployer-responsibility note; IAM + Bedrock image-model integration + per-image cost in rate table; S3 output + presigned read + image message renderer + placeholder→image; resolution/count caps for the cost guard. | Group 0 + Group 1 | Med (net-new modality; cost; model choice) |

**Top risks:** (1) `UserTasksTable` GSI migration on a
live table - backfill/dual-read vs clean cutover. (2) Image-gen model choice
(region/cost/quality). (3) Cost: `TASK_*` is multi-step × 2 bots; generation-out
is per-image - the cost guard + scorecard est-cost both ride on
`MODEL_RATE_TABLE`. Image-output safety is **not** a risk gate: a basic default
ships; production tuning is the deployer's documented responsibility.

---

### Marker-survival path

The single-turn battle marker survives end-to-end:

- Round-1 placeholder is sent by `channel-flow-processor.ts`
  (`handleBattleMessage` fan-out) as
  `One moment... <!--corr:battle-r1-…--><!--battle:battleId=…,round=1,total=2,rivalArn=…-->`
 - a CREATE. Round-2 placeholder is the orchestrator's, round=2.
- `async-processor-core.ts` `updateMessage` overwrites Content with the
  model reply and **no** battle marker - an UPDATE. So the UPDATE-parsed
  `msg.battle` is null.
- **Frontend `ConversationProvider.chime.tsx` `handleMessageUpdate` does
  a selective field merge** (`{ ...updated[idx], content, activeTask, … }`)
 - `battle` is deliberately NOT in the override list, so it is
  preserved from the placeholder CREATE. **Result: variant chips, the
  round-2 divider, and the scorecard keep rendering after the reply
  lands. No marker-loss bug.** The merge invariant is documented at
  the site and pinned by `tests/e2e/battle.spec.ts` so a future
  refactor can't silently regress it.

**Scorecard summary delivery:** because the merge does not
copy `msg.battle` from the UPDATE, the compact per-variant summary is delivered
by merging the UPDATE's battle *summary* fields into the existing battle in
`handleMessageUpdate` (`battle: msg.battle ? { ...updated[idx].battle,
...msg.battle } : updated[idx].battle`) - keeping placeholder identity and
adding `responseMs`/`estCostUsd`/`steps`. The backend appends the compact
summary on a Content marker (not the ≤1KB Metadata); large multi-step
`steps[]` persist out of band via the message-analytics record.

The `tests/e2e/battle.spec.ts` `test.fixme` behavioral cases require a
battle-enabled deploy to exercise.

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Round-2 orchestration race: both async processors think they're "last writer" | DDB conditional update with `attribute_exists(round1Self) AND attribute_exists(round1Rival)` - exactly one passes; the other no-ops |
| Cost surprise from accidental high-volume battles | Premium tier gate + single-active-battle-per-channel lock + circuit breaker (existing) |
| Variants produce indistinguishable output (the demo flops) | Admin UI shows a "preview both replies on a test prompt" affordance before saving the experiment; addendum field has a placeholder suggesting style cues; we ship default-experiment templates ("Atlas vs Echo") so a launch demo works out of the box |
| Slot exhaustion (admin wants more battle experiments than `ALT_BOT_SLOT_COUNT`) | `ALT_BOT_SLOT_COUNT = 2` is a calculated bet (one battle experiment plus headroom). Raising the count requires a CDK deploy but no schema change. Admin save errors cleanly with an actionable message |
| Why the design pre-provisions a slot pool instead of creating bots dynamically | Create-on-save would need a Lambda with `chime:CreateAppInstanceBot` permission, would accumulate bots over time with no teardown path, and would require each new bot ARN to be added to Lex and handler resource policies. The slot pool keeps IAM static and growth bounded |
| `NO_REBUTTAL` sentinel collides with legitimate model output | Strict match: trimmed, case-insensitive, exact match (or with trailing period); also accept JSON `{"rebuttal": null}` as a future-proofing alternative |
| Frontend renders rounds out-of-order if updates arrive late | Sort by `createdAt`, not arrival; round divider keyed off `battle.round` transition rather than position |
| Multi-user channel with `/battle` fires for many humans | Single-active-battle lock applies per-channel, not per-user. The lock makes the second user's `/battle` get a "already in progress" reply |
| The orchestrator Lambda fails between round-1 and round-2 | Round 1 is durable in Amazon Chime SDK regardless of round 2; the worst case is no rebuttals (graceful degradation). DDB TTL cleans up state |
| Channel members confused by a new bot suddenly appearing | The enable endpoint posts a system message announcing the new bot's display name and a one-line description ("Echo joined to battle. Try `/battle`."). The disable endpoint posts a corresponding leave message |
| Admin disables a battle-enabled experiment while channels are using it | Disable returns 409 with the affected channel list. Admin must disable battle per-channel first. Bulk-disable is out of scope |
| Probabilistic experiment routing conflicts with battle membership | When a channel has battle enabled, the existing `experiment-manager.resolveExperimentModel` is bypassed (both variants serve concurrently as members). Non-battle channels still see the normal stochastic assignment. No experiment double-counts |
| Bot ignores "no clarifying questions" instruction and asks one anyway | Treat the question as the round-1 reply; state transitions to `COMPLETED`. Rival can rebut/engage. User addresses by `@<displayName>` or broadcast. No special handling - system-prompt compliance is the model's job |
| Drift detection module fires on legitimate-looking battle topic shift, polluting analytics | Module short-circuits the live-suggestion path on `battleContext`; analytics path tags rows with `battle_id` so rollups exclude them by default. Belt-and-suspenders with the system-prompt instruction |
| Variant prompt-addendum contains contradictory instructions to the battle-context constraints (e.g., "always ask a clarifying question first") | The battle-context instructions are appended *after* the variant addendum in the final prompt, so they take precedence in standard prompting practice. Document the ordering. Conflicting addenda surface during admin's "preview both replies" check |
| State row leaks if async processor crashes between `INVOKED` and terminal state | `BattleStateTable` row has 10-minute TTL; the orchestrator's "all rows terminal" check treats a TTL'd missing row as `FAILED`. Worst case: round 2 fires for the surviving bot only, ~10 minutes after the original prompt |

## Validation

The E2E suite (`tests/e2e/battle.spec.ts`) covers the full `/battle` round-trip: two distinct sender ARNs on round 1, two round-2 placeholders, `NO_REBUTTAL` opt-out with no orphan placeholder, the not-enabled hint, and the premium-only reply. Its behavioral cases run against a battle-enabled deploy.

## References

- `backend/lambda/src/channel-flow-processor.ts` - hosts the `/battle` branch
- `backend/lambda/src/lib/async-processor-core.ts` - accepts the `battleContext` payload
- `backend/lib/stacks/battle-stack.ts` - provisions the alt-bot slot pool + battle state/config tables
- `frontend/src/utils/messageParser.ts` - strips the battle marker and exposes round info
- `docs/guides/admin/GUIDE-AB-TESTING-AND-BATTLES.md` - deployer/operator guide
