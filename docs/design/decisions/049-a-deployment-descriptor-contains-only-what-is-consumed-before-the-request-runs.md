---
title: "ADR-049: A deployment descriptor contains only what is consumed before the request runs"
status: >-
  Accepted 2026-09-21, and PARTLY built. The two deletions are done and tested (`taskSupport` removed; `battleEligible` split into the classification's `battleCapable` plus a runtime setting). NOT built: `classifierMode` and `maxTokens` moving onto the versioned definition, `rateLimitPerHour` moving to the abuse-controls plane, and the descriptor guard test. Depends on ADR-048 for the three-layer split.
date: 2026-09-21
related:
  - "./048-an-assistant-is-not-a-classification.md"
  - "./046-classifications-are-a-set-not-a-ladder.md"
  - "../../specs/interaction/assistants/SPEC-PORTABLE-PROFILES.md"
  - "../../specs/interaction/assistants/SPEC-PER-PROFILE-OWNERSHIP.md"
  - "./050-the-alt-is-an-assistant-and-a-conversation-is-enrolled-once.md"
  - "../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md"
  - "../../../backend/lib/config/profiles.ts"
  - "../../../backend/lib/stacks/assistant-profile-stack.ts"
  - "../../../backend/lambda/src/lib/active-profile.ts"
  - "../../../backend/test/versioned-profile-omits-deploy-time-fields.test.ts"
tracking: |
  The owner, 2026-09-21: "Why are infrastructure parameters in a profile" and "Profile registry needs to be updatable in runtime." This record answers the first and bounds the second. ADR-048 splits classification, assistant and profile into three layers; this one says what the deployment descriptor for those layers may hold, so that "runtime-updatable" becomes a question about a small remainder rather than about the whole registry.
---

# ADR-049: A deployment descriptor contains only what is consumed before the request runs

## Status

**Accepted (2026-09-21), and partly built.** The verdicts below are read from the current tree and cited.

**Built and tested:**

- `taskSupport` is deleted from `AssistantProfile`, its seeds, and the docs that described it. The legacy-stripping coverage is kept so a version stored before the deletion still normalizes away (`versioned-profile-omits-deploy-time-fields.test.ts`).
- `battleEligible` is deleted from `AssistantProfile` and split: capability is `DeploymentClassification.battleCapable`, read by the stack that wires the plumbing AND by the runtime that refuses without it; policy is a per-classification SSM setting, off by default, written from the Experiments surface. *Verified by:* `test/lib/battle-enablement.test.ts` (capability first, fail-closed, both halves required) and `test/channel-battle.test.ts` (basic refused; a capable classification refused while turned off).

**Not built:** `classifierMode` and `maxTokens` moving onto the versioned definition, `rateLimitPerHour` moving to the abuse-controls control table, and the descriptor guard test described under "What proves it". Nothing below should be read as done because the two deletions are.

## The problem, in one example

An assistant is costing too much, and an operator wants to lower its hourly limit from 100 requests to 40.

That is a deploy. `rateLimitPerHour` is a field on a compiled constant, so changing what an assistant costs means shipping code, waiting for CloudFormation, and taking the deployment's release path to alter a number that no CloudFormation resource and no IAM policy ever reads.

The same is true of turning `/battle` off for one assistant. Nothing about either is infrastructure. They live in the deployment descriptor because that is where the assistant was first described, not because anything there consumes them.

## What is actually in there

There are two descriptors, not one, and they overlap.

`AssistantProfile` (`lib/config/profiles.ts:84`) is the registry entry: `name`, `displayName`, `modelKey`, `classifierMode`, `timeoutSeconds`, `taskSupport`, `contextScope`, `rateLimitPerHour`, `battleEligible`, `attachmentsReadable`.

`AssistantTopology` (a classification's `topology` in `lib/config/profiles.ts`) is the stack descriptor: `name`, `timeoutSeconds`, `memorySize`, `reservedConcurrency`, `maxTokens`, `streaming`, `contextRouting`, `systemPromptParam`, `intentPackParam`, `richProcessor`, `battleCapable`, `handlerExperimentsIndex`, `componentTag`.

`timeoutSeconds` is in both. So is `name`, whose comment in the topology is the ADR-048 collapse written as an equation: "Profile name = classification value = SSM segment".

The versioned definition already excludes six of these fields (`active-profile.ts:634`), guarded by `versioned-profile-omits-deploy-time-fields.test.ts`. The stated reason is not that they are infrastructure. It is that "no reader took them from a version, so two versions differing only in one of them got two configIds for the same behavior." That is an argument about a hash, and it has been standing in for a rule about ownership.

## The decision

**A deployment descriptor may contain only what is consumed before the request runs.**

CloudFormation synth and IAM policy evaluation both happen before a request. Anything consumed there has to be in a descriptor, because a deploy is the only thing that can change it, and IAM enforcing a grant ahead of the request is the property tenet P4 exists to keep.

Anything a Lambda reads DURING a request is by definition runtime-resolvable. Its presence in a compiled constant is not a design choice, it is the reason changing it needs a deploy.

The test is the consumer, not the intuition. "This feels like configuration" is how `rateLimitPerHour` and `timeoutSeconds` ended up in the same object despite one being a number in an env var and the other being a Lambda property.

**A field may have both kinds of consumer, and then the descriptor loses.** `battleEligible` is read during a request in three places and is also baked into a `BATTLE_ELIGIBLE` env at synth. A field like this is not a descriptor field that happens to be read; it is a runtime field that a deploy is caching. The deploy-time consumer is the one that moves, because the runtime read is the one that cannot be satisfied any other way.

**A field with no consumer at all is neither.** It does not belong in a descriptor, and moving it to the versioned definition only relocates the dead weight. It is deleted, or it is given the reader its presence implies.

**A field that leaves has two possible destinations, and the difference matters.**

Behavior, which is what the assistant does, goes on the versioned definition and is hashed into `configId`, because an analyst slicing results by configuration should see two different configurations when the behavior differs.

Policy, which is what an operator throttles or permits, goes somewhere runtime-mutable that is NOT hashed. Re-keying every turn's attribution because a cost limit moved would make the limit unadjustable in practice: the price of a cheap operational change would be a discontinuity in the measurements.

## Applying the rule

**Stays in a descriptor**, because CloudFormation or IAM consumes it: `name` (SSM segment, stack ids, the analytics dimension), `timeoutSeconds` (a Lambda property), `contextScope` (an IAM grant; ADR-048 settles it), `attachmentsReadable` (an `s3:GetObject` grant), and the topology's `memorySize`, `reservedConcurrency`, `streaming`, `contextRouting`, `richProcessor`, `battleCapable`, `handlerExperimentsIndex`, `componentTag`, `systemPromptParam` and `intentPackParam`, each of which creates a resource or widens a grant.

**Stays as a seed default, which it already is**: `displayName` and `modelKey`. A version overrides both, so the descriptor value is what a newly provisioned assistant carries before anyone edits it. No change.

**Moves to the versioned definition**, because it is behavior read during a request: `classifierMode` (which classifier runs, read by `router-agent-handler.ts`) and `maxTokens` (the response limit, currently a `MAX_TOKENS` env baked at synth). These are hashed, and re-admitting them re-keys `configId` once for any profile that sets them. That is the same one-time re-key `copy` and `displayName` already took, for the same reason: the hash is meant to identify what the assistant does, and it did not.

**Moves to runtime policy, unhashed**: `rateLimitPerHour`. It is read during a request (`channel-flow-processor.ts:2054`) and does not describe behavior an analyst should see as a different configuration. **Its home is the control table SPEC-ABUSE-CONTROLS already runs** (owner, 2026-09-21), which it already reaches as `rateLimit` on `evaluateAbuseGate`. That plane is runtime-writable and is where the other cost and abuse limits live, so the limit moves to the store that already enforces limits rather than to a new one.

**Is deleted**: `taskSupport`. It has no consumer of either kind, and it was doing harm.

Nothing read it: every reference outside its declaration and the test fixtures was a comment. Every conversational profile set `'full'`, and the only `'lightweight'` was the admin assistant, which has no conversational runtime and so no task loop to make shallow. It is also at the wrong layer, because task management belongs to the classification (ADR-048).

**What makes this more than tidying** is that the name was generating false documentation. `docs-drift-guard.test.ts` carries four separate banned phrasings of one claim, that the basic profile has reduced task tracking, because readers saw a two-valued depth field and drew the obvious conclusion. It is not true: `assistant-profile-stack.ts:342-344` gives a non-rich profile the same DynamoDB task grants, and `richProcessor` gates generated-doc output rather than task tracking. A field with no consumer whose name misleads readers into writing claims that CI then has to catch is worse than an absent one.

That guard is also why this paragraph does not quote the four phrasings. It scans every shipped document, including this one, and it caught this ADR when the phrases were reproduced verbatim to explain them. The phrases stay banned rather than being exempted here, because a guard with a carve-out for documents that discuss it would stop catching the documents most likely to repeat the claim.

The guard's own rule says the same thing without meaning to. It pairs each banned field with "the reader that owns it instead" and states that "a name with no live reader named here is a name nobody can justify keeping out", and `taskSupport` was the one entry whose owner read "nothing at runtime".

**Leaves the descriptor and splits in two**: `battleEligible` (owner, 2026-09-21). "Battle eligible is a single classification level config. When in experiments offer the ability to turn battles on. This would typically only be used for internal users."

**It was asking two questions with one field, and the two answers already disagreed.** `battleEligible` is `true` for all three conversational profiles, including basic. `battleCapable` on the topology is `false` for basic, and `assistant-profile-stack.ts:195` gates every battle resource on it, so basic's processor has no battle-state grant and no orchestrator invoke. Meanwhile `channel-battle.ts:413` gates the ENABLE on `battleEligible`, so Battle Mode can be turned on for a basic channel and then cannot run. Its own comment records the belief that made this invisible: "with every classification now battle-eligible there is no safe value to stand in for one."

That is the failure `attachmentsReadable` already documents from 2026-09-12, where the composer offered a control the IAM role could not back, and the field's note draws the lesson: "the grant is what actually enforces this, so a surface that disagrees lets somebody upload a file into a turn that cannot open it." Same disagreement, a second field, and no guard caught it.

So the two questions separate:

- **CAN this classification run a duel** is `battleCapable`, a deploy-time fact about whether the plumbing and the grants exist. It stays in the topology descriptor, where this ADR's rule puts it, because CloudFormation and IAM consume it.
- **IS battle turned on for this classification** is operator policy, classification-level rather than per assistant, runtime-settable, and **defaults off**. It is offered in the Experiments tab, which is where an operator already arms the experiment a duel runs on.

Every reader asks both, and the order matters: a classification that is not capable is never offered the toggle, so an operator cannot turn on something that has no grant behind it. `channel-battle.ts:413`, `channel-flow-processor.ts:2281` and `experiment-manager.ts:852` then refuse alike, which also settles the drift where the first two refused and the third logged "battleEligible is now a hint" and proceeded.

**Default off is a behavior change, deliberately.** All three conversational classifications are eligible today; after this none is until an operator turns it on, which matches what the setting is for.

## What this costs, stated once

**The existing guard narrows and its reason changes.** `versioned-profile-omits-deploy-time-fields.test.ts` currently holds all six fields off the versioned body. `classifierMode` and `maxTokens` are re-admitted and `taskSupport` is deleted, so the test keeps `contextScope`, `rateLimitPerHour` and `battleEligible` out and states the rule as the reason rather than the absence of a reader.

**A one-time re-key** of `configId` for any profile that sets `classifierMode` or `maxTokens`. Attribution before and after does not join for those profiles.

**A runtime home is needed for two fields, and one may already exist.** SPEC-ABUSE-CONTROLS runs a shared control table for cost and abuse limits, which is the obvious candidate for a rate limit and should be checked before a store is invented. `battleEligible` has no equally obvious home.

**One descriptor has to win `timeoutSeconds`.** Holding it in two places is a drift hazard that nothing currently detects.

**`maxTokens` is a deploy-time env today**, so moving it is a read-path change in the processor and not only a schema edit.

## What proves it

Nothing yet.

What would, and it is mechanically checkable: a test asserting that no field OF `AssistantProfile` read by a Lambda during a request is sourced from the compiled descriptor. That inverts the existing guard, which asserts what the versioned body may not hold, into one that asserts what the descriptor may not hold, and consumers are greppable.

**Scoped to `AssistantProfile`, deliberately.** A guard phrased as "nothing reads the compiled registry during a request" would be wrong and would fail on the cases that must stay: `grantsFor`, `reaches` and `classificationFor` are classification data, read at runtime from the compiled registry by the access decisions in `credential-exchange.ts`, `user-clearance.ts` and `membership-audit.ts`, and ADR-048 keeps them there. The rule is about the assistant descriptor, not about the registry as a whole.

The two fields that move to the versioned definition also need what their exclusion was justified by and never had: a reader that takes them from a version.

## What this does not decide

**The console surfaces.** `GET /admin/profiles` renders the assistant roster, and it moves when the roster stops being the compiled classification set. What it should show instead is not decided here.

**Which store holds the battle-on setting.** It is classification-level, runtime-written by the Experiments surface and read on the turn path, which points at a narrow parameter per classification written by the experiments handler, the shape its `alt` assignment write already uses. Naming the store is left to the implementation rather than guessed at here.

**What the basic-classification enable does for existing channels.** Battle cannot have run there, since the grants were never present, but a channel config row may already say it is on. Whether those rows are cleared or simply stop resolving is an implementation question.

**Whether the two descriptors merge.** They overlap and one of them encodes the ADR-048 collapse, but merging them is a consequence of that ADR landing, not of this rule.

**The alt profile.** It depends on this and on ADR-048: ADR-050.
