---
title: "ADR-045: A refusal from the classification boundary ends the turn"
status: Accepted 2026-09-17. A code review of the 355-commit delta, run at the owner's direction against one question (does every assistant act only in conversations of its own classification), confirmed twelve defects with two shapes behind them. IAM already enforces the boundary at the first channel read of every turn, exactly-own, provably; the router treats that denial as a transient failure and completes the turn anyway. Decisions 1, 2, 3, 4 and 7 are BUILT and cited by name in the code; 5 and 6 are **NOT BUILT**. The router fix closed the found defects; the rest is the same principle applied to every component that currently degrades past a refusal, plus what a deployment has to understand about defining classifications, a decision that the duel's alt bots become classification-bearing assistants (the first step of several assistants per conversation), and a design item for per-classification channel flows.
date: 2026-09-17
related:
  - "./042-an-assistant-acts-in-exactly-one-classification.md"
  - "./041-simplifying-how-a-message-reaches-an-assistant.md"
  - "./044-the-flow-routes-optimistically-from-a-stored-bit-and-a-token.md"
  - "../../specs/interaction/governance/ACCESS-CONTROL-BY-EXAMPLE.md"
  - "../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md"
  - "../../overview/TENETS.md"
  - "../../../backend/lambda/src/router-agent-handler.ts"
  - "../../../backend/lambda/src/lib/channel-size.ts"
  - "../../../backend/lambda/src/lib/channel-classification.ts"
  - "../../../backend/lambda/src/task-service.ts"
  - "../../../backend/lambda/src/membership-audit.ts"
  - "../../../backend/lib/classification-admission.ts"
  - "../../../backend/lib/config/profiles.ts"
  - "../../../backend/lib/stacks/assistant-profile-stack.ts"
  - "../../../backend/lib/stacks/channel-flow-stack.ts"
tracking: |
  The owner's standing observation, stated again on 2026-09-17: "Assistants are assigned to a classification and that classification matches the conversations they are a part of. I consistently discover new ways this is broken." This record is the consolidated answer to why, and what closes it. It amends ADR-042 in two places and leaves the rest standing: ADR-042 decision 5 (the handler reads the tag and refuses a mismatch) is replaced by honoring the IAM denial, and ADR-042 decision 3a (an unreadable tag does not refuse) is reversed for the callers named in decision 2 here, with the cost to the fire-and-forget task status writes that 3a protected stated under Consequences.
---

# ADR-045: A refusal from the classification boundary ends the turn

> **Amended 2026-10-23.** `create-bot` and `create-lex-bot`, the deploy-time provisioners this record cites, are removed: no stack owns an assistant identity, and every identity and Amazon Lex bot is built by the provisioner (`backend/lambda/src/lib/assistant-provisioner.ts`, [ADR-048](./048-an-assistant-is-not-a-classification.md), amended 2026-10-23). The line numbers cited for them are of the removed files. The behavior cited is unchanged: every identity is built with `StandardMessages: NONE` and `TargetedMessages: ALL`.

## Status

**Accepted (2026-09-17). Decisions 1, 2, 3, 4 and 7 are built; 5 and 6 are not.** The finding is verified against the tree, line by line, and the twelve confirmed defects are listed with their evidence in the review record this grew from. The root of it is also measured live against the deployment; see "The measured before-state" below.

| Decision | State |
|---|---|
| 1. The router honors the denial at its first read | **Built.** `lib/channel-size.ts` refuses rather than degrading, and `a-refused-membership-read-is-not-an-unreadable-one.test.ts` pins the difference between a refusal and an unreadable roster. |
| 2. The shared tag resolver stops lying, and its callers stop degrading | **Built.** `readChannelClassificationTag` returns `undefined` on a failed read and the callers refuse on it, each citing this decision at the call site (`channel-flow-processor.ts`, `lib/channel-classification.ts`, `lib/caller-scope.ts`, `channel-battle.ts`). A reply targeted at a duel's alt reaches its classification's router on the alt's own Amazon Lex bot, so it passes the router's refusal like any turn. |
| 3. Rank comparisons leave the assistant-plane components | **Built**, and completed by [ADR-046](./046-classifications-are-a-set-not-a-ladder.md), which removed the ordering those comparisons read. |
| 4. Admin surfaces read the tag to admit, and treat unknown as unknown | **Built** (`lib/caller-scope.ts`). |
| 5. The archival detector gets an independent operand | **Not built**, and the record already says nothing more is buildable without a schema change. |
| 6. A defaulted clearance is recorded as defaulted | **Not built.** |
| 7. Alt bots become classification-bearing assistants, in the role `alt` | **Built** (`channel-battle.ts`); the runtime-provisioning half is [ADR-048](./048-an-assistant-is-not-a-classification.md). |

## The measured before-state

Measured against the dev deployment on 2026-09-17, before any of this record is built, so that the fix has a number to move and a code-read finding does not get built against. Every measurement below carries a positive control in the same run, because a harness that measures a refusal must be unable to produce one from its own failure.

**IAM refuses, exactly-own, and that is now read from AWS rather than from the template.** `iam simulate-principal-policy` against the deployed premium `AgentHandler` role returns `implicitDeny` on `chime:ListChannelMemberships`, `chime:DescribeChannel`, `chime:ListChannelMessages` and `chime:SendChannelMessage` for a channel tagged `basic` and for one tagged `standard`, and `allowed` for `premium`. The three processor roles give the same answer for their own classifications, and deny on an untagged channel. This is the first run of that deny-test against an account: ADR-042 read, on 2026-09-16, a grant that also reached the `basic` and `standard` channels, and the exactly-own grant this record depends on is the one now deployed.

**The router does not honor it.** The app-instance administrator, the residual this record names, created a channel tagged `classification=basic` and added the premium bot to it out of band. Invoking the premium router as Lex fulfillment does returned `One moment...` carrying a correlation marker, with no refusal, on all three entry shapes: a turn carrying `@`, a turn carrying `.`, and a `WelcomeIntent`. The premium async processor then ran for each of those three turns, confirmed by that turn's own correlation marker appearing in the processor's log group. The positive control, the same bot in a `premium` room, behaves identically, so the turns are completing rather than the path being broken.

**Lex-returned text is materialized without passing the bot's IAM, and this is the half that reaches a person.** A message whose sender ARN is the premium bot lands in the basic-tagged room on membership alone, while that same principal is `implicitDeny` on `chime:SendChannelMessage` for that channel. The control is the basic bot added to a basic room, which produces the same greeting: the mechanism works for both, so what is being measured is the boundary and not an outage. This confirms the correction the review made to the first draft of this record. A greeting is text a person reads, in a room of a classification its author may not act in.

**Not yet measured:** whether `detectDrift` writes `channel_classification=premium` for the basic channel, and whether an archival row is written at `premium`. Both are asserted from the code path and remain to be read through the signed analytics API. The decision does not rest on them; it rests on the turn completing, which is measured three ways above.

The probes are kept outside the repository. Each deletes the rooms it creates, and exits `INVALID RUN` rather than reporting an access decision when any step of its own setup fails.

## Read this first

The classification boundary is **enforced by IAM, exactly-own, on every channel-scoped action the router takes**: the grant carries `aws:ResourceTag/classification` equal to the router's own classification (`backend/lib/stacks/assistant-profile-stack.ts:994`, `actor: 'assistant'`, ADR-042). That grant is in the tree and not yet deny-tested; ADR-042 read, from the deployment on 2026-09-16, a grant that also reached the channels of every classification the router's grant set holds, so "enforced" here means "as the tree deploys", and test 1 below is what earns "provably".

**Which read comes first depends on how the turn entered**, and the first draft of this record got that wrong by generalizing one branch. On a Lex turn carrying an `@` or a bypass token it is `ListChannelMemberships` through `channel-size.ts` (`backend/lambda/src/router-agent-handler.ts:1675-1693`); on a WelcomeIntent it is `DescribeChannel` at `:1943` and then `ListChannelMemberships` at `:2013`; on a `.`-addressed turn it is `channel-size.ts` again at `:2277`; and on a flow-entry turn there may be **no channel-scoped read at all** before the model runs. A premium router entered from a basic-tagged room receives `AccessDeniedException` at whichever of those fires, and on the flow path may receive none.

**Wherever the denial fires, the router treats it as a throttle and finishes the turn.** `backend/lambda/src/lib/channel-size.ts:173-176` catches every error identically and returns "treat the channel as a group"; `resolveChannelMetadata` (`router-agent-handler.ts:304-308`) returns `{}`; `getMemberArns` (`:338-341`) returns `[]`; `inboundWasTargeted` (`backend/lambda/src/lib/private-command.ts:177-180`) treats the message as public. The model runs. Grounding runs at the assistant's scope. Drift and archival rows are written at the assistant's classification. The processor's final `SendChannelMessage` (`assistant-profile-stack.ts:235`, exactly-own) stops the *answer*, after the work is done and with no refusal recorded. **The router's own Lex-returned text is not stopped at all**: a greeting or a placeholder returned from the fulfillment is materialized by Amazon Chime SDK, not sent by the router's IAM (`assistant-profile-stack.ts:962-964`), so it is posted in the wrong room.

So the fix is not a new check. **It is honoring the one that already fired.** A refusal from the boundary is not a degraded condition. It ends the turn.

Everything else in this record is that sentence applied to each component that currently degrades past a refusal, and what a deployment must understand about classifications for the sentence to stay true.

## The finding

A review of the 355-commit delta and the uncommitted tree, read against one question, produced 45 candidates; 20 went to a verifier each; 12 were confirmed, 2 plausible, 6 refuted. Two shapes account for nearly all of the confirmed ones.

### Shape A: a component asserts its own classification instead of reading the room's

`backend/lambda/src/router-agent-handler.ts:264-268`, comment collapsed to one line:

```ts
async function resolveChannelClassification(channelArn: string, botArn: string): Promise<string> {
  // Per-classification deployment: the handler IS the classification - no discovery needed.
  if (STATIC_CLASSIFICATION) return STATIC_CLASSIFICATION;
```

"No discovery needed" is true only if membership is perfectly enforced. It is enforced further than the first draft of this record allowed: Amazon Chime SDK's RESTRICTED channel mode lets only a channel moderator or the app-instance administrator add a member (ADR-042, decision 3 and its measurement). The residual is real and bounded: the app-instance administrator's own credential, a compromised moderator bearer, and the two in-band roles whose membership statements carry no tag condition (`backend/lib/stacks/agent-classification-common.ts:725-740`, `backend/lib/stacks/battle-stack.ts:366-372`), with the membership audit report-only by default behind them. So every downstream consumer that trusts the router's value inherits the assistant's classification rather than the room's: the processor payload, the live-drift projection (`channel_classification` upserted from the router, last write wins), the archival boundary detector (which then compares two copies of the same value), and the cross-conversation task hints.

### Shape B: a gate fails open, or compares by rank, where the only correct failure is refusal

- `backend/lambda/src/lib/channel-size.ts:173-176`: any error, including `AccessDeniedException`, becomes `unknown: true` and the turn proceeds.
- `backend/lambda/src/lib/channel-classification.ts:20-55`: the shared tag resolver substitutes the floor (`profiles.failClosedValue`, `'basic'`) for an unreadable tag. Two callers guard on `!classification` for a value the resolver cannot return, so the guards are dead code (`backend/lambda/src/lib/triage-on-arrival.ts:183-185`, `backend/lambda/src/lib/turn-handover.ts:482-484`): arrival triage dispatches a premium queue to the basic router. Task-answer repair has no such guard; it resolves the floor to the basic router (`backend/lambda/src/lib/task-answer-repair.ts:292-293`), re-drives a premium transcript through it, and has already taken its durable claim at `:239`, before either the size check at `:285` or the tag read.
- `backend/lambda/src/task-service.ts:250`: an unreadable tag ADMITS on the cross-conversation paths where this per-row check is the only gate. `:268`: `theirs > mine` admits any conversation at or below the service's own classification, a person-ladder rule left on an assistant component after ADR-042 moved assistants to exactly-own.
- `backend/lambda/src/membership-audit.ts:161` and `:484`: the detective control compares ranks while every preventive control decides by set predicate, so the two layers disagree about the same pairing. `backend/lib/classification-admission.ts` states the rule the audit breaks: "no consumer may compare ranks... every consumer bug being fixed here was a rank comparison."
- Admin surfaces (`admin-conversations.ts`, `caller-scope.ts`) resolve a conversation's classification from the archive projection rather than the tag, and treat NULL or `''` as the floor rather than as unknown.

## The principle

Tenet D3 asks for two enforcement layers on every sensitive operation, and names IAM as the one that is provable. The boundary has that layer, and RESTRICTED-mode membership is a second one on who can put an assistant in a room at all. What this record adds is not a third check. It is **making the first layer decisive**: a rule about what a component does when IAM says no, because a denial that is caught and degraded around enforces nothing.

1. **A denial is never a degradation.** `AccessDeniedException` and `ForbiddenException` on a channel action are the boundary speaking. The component stops, records a SecurityEvent naming the assistant and the channel, counts it, and does no further work on that turn. It does not fall back to a floor, to "group", to a cached value, or to a sibling classification's router.
2. **Unreadable is not a value.** A tag that cannot be read yields an honest "unknown" that callers refuse on. It is never substituted with the floor, because on an assistant-plane component the floor is a wrong classification, not a safe one.
3. **Sets, never ranks.** An assistant acts in exactly its own classification (`ProfileRegistry.channelsActableBy`, ADR-042). A person reaches the set their classification `grants`. No component compares two ranks to decide admission. The registry already says this; the audit and the task service predate it.
4. **Read the room from the room.** A conversation's classification is its immutable tag, read from Amazon Chime SDK (tenet D7). A projection of it (the drift table, the archive) may be reported, never used to admit.

The trade this makes is stated once so it is not rediscovered as a bug: **an unreadable tag now means an unanswered turn, not a floor-classified one.** A throttle makes an assistant briefly silent instead of briefly wrong. That is the correct direction, and it is the same silence that has no monitoring answer yet.

## The decision

### 1. The router honors the denial at its first read

`channel-size.ts` distinguishes a refusal from every other failure and says so in its result:

```ts
} catch (err) {
  if (isAccessDenied(err)) {   // AccessDeniedException | ForbiddenException
    return { memberCount: 0, members: [], isOneToOne: false, unknown: true, refused: true };
  }
  console.warn('[channel-size] ListChannelMemberships failed; treating the channel as a group', err);
  return { memberCount: 0, members: [], isOneToOne: false, unknown: true, refused: false };
}
```

The refusal is checked at **every** catch that today swallows a denial: `channel-size.ts:173-176` (used at `:1690` and `:2277`), `resolveChannelMetadata` (`router-agent-handler.ts:304-308`), `getMemberArns` (`:338-341`) and `inboundWasTargeted` (`lib/private-command.ts:177-180`). Each distinguishes `AccessDeniedException` and `ForbiddenException` from every other failure and reports `refused`; a throttle keeps today's degradation.

**And because a flow-entry turn can reach the model with no channel read at all, one is made.** `resolveChannelClassification` (`router-agent-handler.ts:1915-1919`, the `channel_resolved` step) stops returning `STATIC_CLASSIFICATION` on faith and makes one exactly-own read, `DescribeChannel`, already granted at `:1007`, memoized per channel per container because the tag is immutable. That gives every entry shape a decisive first read before intent classification (`:2420`), processor resolution (`:2231`), drift (`:3678`) or dispatch (`:5033`).

On a refusal the router logs `[SecurityEvent] assistant refused by the channel classification boundary`, emits one count with the assistant's classification as a dimension, **alarms on that count** (a count nobody watches is a log line; nothing watches the flow-failure silence today), and returns a silent close: **no Lex-returned content**, because Amazon Chime SDK would materialize it ungated, and no further work.

**Cost: one `DescribeChannel` per channel per warm container on the flow path**, where today there is none, and zero on every other path, where a channel read already happens first. The tag is not read for enforcement; the refusal path may read it through the unconditioned `ListTagsForResource` grant to name the room's classification in the SecurityEvent, and that read may fail without changing the outcome.

### 2. The shared tag resolver stops lying, and its callers stop degrading

`backend/lambda/src/lib/channel-classification.ts:63-82` already exposes `readChannelClassificationTag`, which returns `undefined` for an unreadable tag; the working tree moved conversation-split to it, and the channel flow reads through it but still substitutes the floor (see "What channel flows need to do"). The remaining callers of the substituting resolver (`channel-battle.ts:161`, `backend/lambda/src/membership-audit.ts:288`, `router-agent-handler.ts:286`, `task-answer-repair.ts:292`, `turn-handover.ts:483`, `triage-on-arrival.ts:183`) move too, and each refuses on `undefined`. The task service is **not** among them: it already reports unreadable honestly (`task-service.ts:195-212`, `{ unreadable: true }`) and only what it does with that answer changes. The three that matter most:

- **Arrival triage** (`backend/lambda/src/lib/triage-on-arrival.ts`): a queue whose channel tag cannot be read is not dispatched to anyone, and the triage claim is released so the next attempt can try. The unit test that mocks the resolver returning `''` is rewritten to mock the value the resolver actually returns.
- **Task-answer repair** (`backend/lambda/src/lib/task-answer-repair.ts`): an unreadable tag refuses the repair the same way an unreadable room size already does at `:285-290`. The durable `repair-<messageId>` claim moves from `:239` to after both checks, so a refused repair leaves no claim and a later delivery can succeed; `task-answer-repair.test.ts:321` pins the claim being taken first and is rewritten with the reason.
- **Task service, cross-conversation paths** (`task-service.ts:250`): unreadable refuses. The comment "PROCEEDING, because IAM has already authorised this call" is true only for the HERE leg, where the caller's own channel action was authorized; on the cross-conversation legs IAM never evaluated those channels, and this row check is the only gate.

### 3. Rank comparisons leave the assistant-plane components that still make them

- `task-service.ts:267`: `theirs > mine` becomes `!profiles.channelsActableBy(SERVICE_CLASSIFICATION).includes(tag)`. A premium task service refuses a basic conversation's rows exactly as its router's IAM refuses the basic channel. The test pinning the permissive behavior is rewritten with the reason.
- `backend/lambda/src/membership-audit.ts:161` and `:484`: a person is in place when the channel's classification is in `grantsFor(theirClassification)`; an assistant is in place when it equals `channelsActableBy` (which is exactly one value). Both directions are findings. `clearanceForGroups` (`:279`), the highest-single-group resolver, is replaced by the same `resolveHolderToken` the credential exchange uses, so the audit and the exchange resolve a person to the same token.

  **This is an enforcement migration, not a code change alone.** `resolveHolderToken` resolves to NO token for any group combination the deployment has not named (`backend/lib/profile-registry.ts`), so after this change every person holding an unnamed combination becomes a finding in every room, and with `MEMBERSHIP_AUDIT_ENFORCE=true` (`backend/lambda/src/membership-audit.ts:123`) they are revoked. A deployment enables enforcement only after a report-only pass has reconciled its group combinations against the declared tokens.

No admission site is exempt as **person-plane**: a person's reach is a declared set on the person plane too ([ADR-046](./046-classifications-are-a-set-not-a-ladder.md)). The administrator's scope in `backend/lambda/src/lib/caller-scope.ts` asks `grantsFor` through `classificationAllowed`, and no federated identity helper narrows a person's reach. The tie-break in `profile-registry.ts` picks between two declared tokens with equal `grants` and is not an admission.

### 4. Admin surfaces read the tag to admit, and treat unknown as unknown

`channelClassificationAllowed` in `admin-conversations.ts` resolves the conversation's classification from Amazon Chime SDK's tag for the admission decision, not from `metadata.modelTier`. Where the tag cannot be read, or the archive has no value, the answer is "unknown" and unknown is refused, never ranked as the floor. `scopeAnalyticsRows` in `caller-scope.ts` treats a row whose classification fields are present but NULL as unclassifiable and excludes it for a scope-limited caller; the `GET /evaluation/exchanges` routes call it. The tests pinning `''` and `'not-a-classification'` as allowed are rewritten.

### 5. The archival detector gets an independent operand

With decision 1 in place the router's classification is only ever recorded on admitted turns, so the drift projection is correct by construction on live turns and the detector's two operands become genuinely independent. **Nothing more is buildable here without a schema change**: `channel_classification` is one row per channel and a `router` write overwrites both `classification` and `source` (`backend/lambda/src/analytics-aurora/channel-classification.ts:82-88`), so there is no tag-sourced backfill left to prefer once a live turn has landed. This record does not add a column; historical rows written before decision 1 are out of scope and are named as such. The two comments claiming the projection is "written from the router's read of the immutable tag" (`kinesis-archival.ts:897-898`, `backend/lambda/src/analytics-aurora/data-plane-handler.ts:144-146`) are corrected: it is written from the router's own classification, which decision 1 makes equivalent on admitted turns.

### 6. A defaulted clearance is recorded as defaulted

`resolveUserClearance` returns a source alongside the value (`held` or `defaulted`). The router forwards both; archival writes `user_clearance` only for `held`, and the false SecurityEvent at `router-agent-handler.ts:2223-2231` fires only when a held clearance does not reach the room. Schema note: `messages.user_clearance` NULL continues to mean "none declared"; a defaulted value is not written. The deleted `minRank(channelClassification, userClearance)` cap is a separate, small item and is not decided here.

### 7. Alt bots become classification-bearing assistants, in the role `alt`

The second side of a duel is an assistant of the room's classification holding the role `alt`, an alternate primary, with everything that entails: a bot identity tagged at creation (`BOT_CLASSIFICATION` set, as every other assistant's is at `assistant-profile-stack.ts:1688`), a role whose channel grant is exactly-own rather than conditioned on every classification, and no exemption in the membership audit. The orchestrator draws a duel's second side from the room's own classification.

**THERE IS NO POOL (owner, 2026-09-17).** An earlier draft of this decision kept the pool and stamped it per classification, at a cost of pool size times classification count. The owner rejected the pool itself: a classification has **one alt primary assistant**, reused for duels and for experiments alike, rather than a numbered set of anonymous bots. `AltSlot0` and `AltSlot1` stop being identities in their own right and become what they always were underneath, an alternate of the classification's primary.

Two consequences are recorded rather than discovered later. **Concurrency is now per classification**: an experiment binds its classification's alt for the experiment's life (`admin-experiments.ts`, which names the challenger by assistant id and releases it on delete), so one battle-enabled experiment runs per classification at a time. The shared pool of two allowed two at once across all classifications, so this is more capacity for `standard` and `basic` and less for `premium`, which is the only `battleEligible` classification in the default configuration. The count is therefore a configuration value rather than a literal `1`, so raising it is a config change and not a redesign. And **the existing two bots are tagged in place rather than replaced** (`TagResource` on update): they are RETAINed, so they survive the stack change regardless, and keeping their ARNs keeps the SSM roster and any duel in flight at deploy time valid.

**Roles beyond `primary` and `alt` are out of scope here.** Naming a further role, such as a meeting assistant, is the runtime-creation work in item 5 of the Direction below; this decision does not invent a role vocabulary ahead of it.

This is the smallest change that makes the rule above true of every assistant in the tree. It is also the first step of a larger design, which this record names and does not decide.

## Direction: multiple assistants per conversation

Decision 7 is where the platform stops treating a second assistant as a special case, and the owner's direction is that it is the first of several. Four things follow, each its own record, listed so they are found by design rather than as breakage:

1. **The classification stops pointing at exactly one profile.** A profile is one assistant, and always was: profiles are keyed by name (`backend/lib/profile-registry.ts:270`, `profileByName`) and the SSM layout is `/assistant/<name>/...`. The collapse is on the classification side: each classification entry carries a single `profile` pointer, and `profileFor(classification)` (`:259-263`) returns that one. That is not the design; it is the implementation of the design at N=1, and it is what made "the classification's assistant" a phrase that could be said at all. A meeting assistant and an ops assistant at `premium` are two profiles of one classification, so the classification holds a set of profiles with roles (item 5), and the stacks are stamped per assistant rather than per classification.
2. **The router runs as the assistant it was handed.** ADR-034 already records the gap: `handOffTurnToRouter` invokes the classification's router and "that router resolves its own bot", so `@Ops` in a premium room is answered by whichever bot the premium router serves. With several assistants per classification that is the central routing question. The bot ARN the flow already passes has to be the identity the turn runs as, and `isSanctionedBattleBot` (which today replaces an unrecognized bot with the router's own) becomes "is this an assistant of my classification that is a member here".
3. **An unaddressed message in a room with several assistants goes to the room's primary.** Today a one-to-one goes to its one assistant and a group's `@all` goes to the primary, where "primary" means the classification's single bot (`resolvePrimaryBotArn`, read from the classification's `bot-arn` parameter). With several assistants the primary is a ROLE one of them holds (item 5), and the plain message goes to whichever holds it. This interacts with the flow's "which assistants are here" read of the live roster (ADR-044, declined, keeps it live) and with the flow's route-to-the-addressed-assistant, both of which assume the addressed assistant is unique by name.
4. **`@all` changes meaning.** From "the room's assistant" to either "every assistant here" or "the primary", and those are different behaviors with different costs.
5. **Assistants are created and managed at runtime, per classification, each with a role** (owner, 2026-09-17). Today the set of assistants is fixed at deploy: `CreateAppInstanceBot` runs only inside stack custom resources, `manage-profiles.ts` versions the definition of a known profile and cannot add or remove one, and the profile set is `DEFAULT_PROFILES_CONFIG`. The direction is an administrative path that creates an assistant within a classification, tags its identity with that classification at creation (decision 7's requirement, and what makes the boundary checkable per identity), and assigns it a **role within the classification**: `primary`, the assistant an unaddressed message reaches; `alt`, an alternate primary, which is what a duel's second side is; and further roles as they are named (a meeting assistant, an ops assistant). Two consequences worth stating now. The role is what answers item 3, so the rule for a plain message is "the primary", and a room may hold exactly one primary. And every place that memoizes the deployment's assistants for a container's life becomes wrong the moment this ships: ADR-044's "changes only on deploy" holds of the deployment's bot list only while assistants are fixed at deploy, and stops holding here, which is why that record asks for a bounded TTL rather than a permanent memo.

None of these is decided here. What this record decides is the precondition for all of them: every assistant carries its classification, so a room with several of them is still a room where the boundary can be checked per identity.

## How classifications are defined and deployed, for a deployment that is not this one

This section exists because the owner asked for it, and because the defects above are what a new deployment would inherit by following the shipped shape without knowing which parts are load-bearing.

### What a classification is

A **classification** is the one closed axis IAM evaluates (tenet P4). It is declared in `backend/lib/config/profiles.ts` as an entry in `DEFAULT_PROFILES_CONFIG.classifications` with a `value` and a `grants` set. **A profile is one assistant**, keyed by its own name; today each classification entry points at exactly one profile, which is the N=1 implementation of a design that always intended several (see "Direction", item 1). Three things carry it at runtime:

| Carrier | Where | How it changes |
|---|---|---|
| A conversation | the immutable `classification` tag on the channel, set at creation | never; a channel is one classification for its life |
| An assistant | the `CLASSIFICATION` environment of its router and processor, the tag condition on its IAM, and the `classification` tag on its bot identity (`BOT_CLASSIFICATION`, `assistant-profile-stack.ts:1688` into `create-bot`), which the audit reads first (`backend/lambda/src/membership-audit.ts:327-331`) | at deploy; the identity tag is set at bot creation and backfilled by `TagResource` on update, so a bot created before the tag existed is untagged until then |
| A person | the Cognito group they hold, resolved through `groupClearance` to a classification, whose `grants` set is what their credentials reach | when an administrator moves them |

This decision still had a **rank**, which ordered the classifications so `grants` could be left unstated for the common case, and it named six runtime sites that compared ranks: `task-service.ts`, two in `membership-audit.ts`, `caller-scope.ts`, `kinesis-archival.ts`, the federated identity helper, and the tie-break in `profile-registry.ts`. [ADR-046](./046-classifications-are-a-set-not-a-ladder.md) removes rank from the schema, so `grants` is required and stated, and none of those comparisons survives: five ask set membership, the federated pair is deleted, and the tie-break resolves to declaration order. The rule this paragraph set is the one that held: **no consumer of the admission payload may compare ranks** (`backend/lib/classification-admission.ts`), because a consumer holding two ranks can express exactly the admission this model replaced. No rank travels in that payload, and there is none to travel.

### The two predicates, and who each is for

- **`grantsFor(classification)`**, a set, is for **people**. A person cleared at `standard` reaches `['basic', 'standard']` because the shipped config DECLARES that set (`backend/lib/config/profiles.ts`). Every classification declares its `grants` and the validator refuses one that does not (ADR-046), so a deployment declaring a non-prefix set (a `finance` classification granting `['finance']` alone) is an ordinary configuration rather than an exception to a default.
- **`channelsActableBy(classification)`**, a set of one, is for **assistants**. An assistant acts in exactly its own classification (ADR-042). It does not inherit what a person reaches, because an assistant reading another classification's conversation is a cross-classification context leak in the direction that matters.

A new deployment that adds a classification adds it to the registry, adds a profile beside it, and stamps its stack. `HOW-TO-ADD-OR-MANAGE-A-PROFILE.md` walks the steps. What that guide does not yet say, and this record asks it to, is **which consumers derive from the registry and which were spelled out by hand**, because a hand-spelled list is where a new classification silently fails: the read-boundary SQL in `classification-boundary.test.ts` is deliberately literal so that adding a classification forces a human to re-read which rows each reader can see, and that is a feature only if the guide says so.

### Overlap: what happens when a person holds more than one group

A person can hold several Cognito groups. The registry handles the union, not the code that reads it:

- `clearanceGroups` names the groups that are **exclusive** of each other, so a writer that sets one removes the rest.
- A combination the deployment has named gets its **declared token**; `resolveHolderToken` (`credential-exchange.ts`, `user-management.ts`) resolves the person to it.
- A combination the deployment has **not** named resolves to no token at all, and the caller refuses (`backend/lib/profile-registry.ts`). It does not resolve to the widest single group: it resolves to the declared token whose `grants` equal the union of what the held groups clear for, and when two tokens declare the same set, declaration order picks between them.

The maintenance rule for a deployment is therefore: **every group combination a person can actually hold has a declared token, or it is understood that those people are refused a credential and cannot enter any conversation, including the ones their individual groups clear for.** That lockout is the symptom a deployer sees first, and it is not an error anywhere. The membership audit resolves a person the same way (decision 3): through each issuer's clearance source to the holder token the credential exchange vends. One more thing the rule must cover: `failClosedContentValue` is what untagged content is stamped as, so a new conversational classification that fewer holders reach than the current one silently changes it (guide 5, around line 595).

### Several assistants in one conversation, all of its classification

**A conversation has one classification and holds one or more assistants, every one of them exactly that classification** (owner, 2026-09-17). A duel is the first instance of the shape: two named assistants of the room's classification. A meeting assistant joining a conversation, or an ops assistant sitting in an ops conversation beside the room's primary, are the next. Overlap between classifications in one room is never permitted; several assistants of the same classification is the design.

**The pooled alt bots are the one place the tree contradicts that, and decision 7 below removes the contradiction.** Today a duel's second side is an anonymous `AltSlot-N` identity from a single shared pool: created once in the battle stack rather than per classification (`backend/lib/stacks/battle-stack.ts:308-346`), carrying **no classification tag** (`create-bot`, which declared the pooled bots not classification assistants), acting under `ChannelBattleRole`, whose channel grant is conditioned on **every** declared classification (`battle-stack.ts:309-336`), and exempted by the membership audit (`backend/lambda/src/membership-audit.ts:465-469`). Nothing in the stack records a constraint that forced the pool to be shared; the nearest comment says battle replies come from "the channel-flow to the premium async-processor", which reads as a leftover from when duels ran at one classification. It is a cross-classification principal, the exact shape ADR-042 says cannot exist, justified by the same argument this record rejects for the router: that the identity does not matter because a layer behind it is scoped.

### Removing a classification

Deleting a classification from the registry deletes its stack's definition, not its stack. `AgentEchelonClassification-Probe` survived its own removal on 2026-09-17 and its cross-region imports broke the next deploy. A removal is a code change and an account change, and the account half has no test. The guide should say: after removing a classification, confirm no `AgentEchelonAssistants-<classification>` stack remains before deploying; delete the classification's comment block, its `Classification` union member and any literal cast that named it (guide 5.2 and 5.7). `backend/lib/config/profiles.ts:143-170` still carries the rationale for a `probe` entry that no longer exists, which is what skipping that step looks like.

## What channel flows need to do

Today there is one shared channel flow serving every classification. Two consequences follow, and they pull in opposite directions.

**It must not be classification-scoped, so it is unscoped.** Its role holds `resources: [${appInstanceArn}/*]` with no tag condition (`backend/lib/stacks/channel-flow-stack.ts`, `ChimePolicy`), because it acts in every classification's channels. It is the last channel-acting principal in the platform that is not exactly-own, and that is a fact about its shape rather than a choice anybody made.

**It picks the router by reading the tag**, per message (cached per channel per container, since the tag is immutable). That read is a routing decision rather than an enforcement: a wrong pick fails closed one link later, because the picked router's own first read is exactly-own.

Whatever the flow's shape, these hold:

1. **A denied channel read ends the flow's work on that message.** The flow releases the message (it must; a held message is delivered unprocessed on timeout) and dispatches nothing.
2. **The flow routes only to an assistant that is in the room.** The flow's post-delivery route for a private address resolves the assistant against the live roster, so this holds. ADR-044, which proposed answering from a stored routing context instead, is declined, and any future store would have to hold it too.
3. **The flow must not degrade an unreadable classification to the floor. CLOSED by decision 2.** The flow reads through `readChannelClassificationTag` and returns `undefined` when the tag cannot be read (`backend/lambda/src/channel-flow-processor.ts`, which cites this decision at the line), so a throttled tag read now releases the message and dispatches nothing rather than sending the floor's router into a room of another classification. `profiles.failClosedValue`, the value it used to substitute, no longer exists: [ADR-046](./046-classifications-are-a-set-not-a-ladder.md) removed it and `profile-registry.ts` records that nothing replaces it.

### Design item: per-classification channel flows

Stamping the flow per classification, from one shared body, the way the routers and processors already are, would make the flow exactly-own like every other channel-acting principal and would replace its per-message tag read with `STATIC_CLASSIFICATION`. Each link of the chain then has an IAM statement behind it:

| Link | Enforced by | Depends on |
|---|---|---|
| channel, tagged X, is associated with flow X | `chime:AssociateChannelFlow` conditioned on `aws:ResourceTag/classification = X` on the associating principal | the condition being honored for that action, which is **not yet measured**. One such statement already ships: `DriftConfigureOwnClassificationChannel` (`agent-classification-common.ts:813-819`) conditions this exact action on every Aurora-mode drift channel create, so the probe can start from CloudTrail for that action rather than from nothing |
| flow X invokes only router X | flow X's role: `lambda:InvokeFunction` on router X alone; router X's resource policy: allow flow X's role alone | nothing new; principal-to-resource IAM |
| router X acts only in channels tagged X | already exactly-own (ADR-042) | decision 1, so the denial is honored |

Two honest limits. The flow ARN in `AssociateChannelFlow` is a request parameter, not the resource, so IAM cannot pin "only flow X" by tag alone; the association stays code-chosen and a wrong one fails closed at the next link. And this does not address the twelve findings: their failing path is Lex invoking an out-of-place bot's own router, which never touches the flow-to-router link. It closes a different gap, the flow's unconditioned access, and it is recorded here as a design item rather than a decision because the first row of the table is an assumption about the service until a deny-probe establishes it. This platform has been surprised by per-action IAM behavior before, and the project's rule is that a boundary claim is established by attempting it.

## Consequences and risks

- **Silence replaces wrongness.** An assistant refused by the boundary says nothing in the room. That is correct and it is indistinguishable, to a person, from the flow-failure silence. The SecurityEvent and the count are what distinguish them to an operator; a person-facing signal is a separate question, not this record's.
- **Throttles now cost turns, and on the task service they cost status writes.** A throttled `ListChannelMemberships` is not a denial and keeps today's degradation; a throttled `ListTagsForResource` on the paths in decision 2 now refuses where it used to substitute. ADR-042 decision 3a chose fail-open on the task service specifically so that fire-and-forget task status writes would not be lost to a tag-read throttle (`task-service.test.ts:102-129` pins it). Reversing it means a throttled write on a cross-conversation path is dropped and counted rather than admitted. Rare, visible, and the alternative was a premium task hint in a basic prompt.
- **Tests that pin fail-open behavior turn red**: `task-service.test.ts:102-129`, `:149-156`, `:565-571`; `membership-audit.test.ts:195-202`; `caller-scope.test.ts:36-38`, `:162-166`; `triage-on-arrival.test.ts:183-190`, and its mock factory at `:42-43`, which must export `readChannelClassificationTag` or the import change fails as a TypeError rather than as the intended assertion; `task-answer-repair.test.ts:321`, which pins the claim being taken before the checks; `admin-conversations-aurora.test.ts:79`. Each is rewritten with the reason rather than deleted, and each rewrite is a place the old behavior was believed correct. `channel-size.ts` has no test today, and decision 1 gives it one.

## What proves it

Tenet P4 says isolation is provable with a deny-test rather than a code review. This record was produced by a code review, and it owes the tests:

1. **The router deny-test, in three entry shapes.** A premium bot made a member of a basic-tagged room, then: a Lex turn carrying `@`, a Lex turn carrying `.assistant`, and a bot-added WelcomeIntent. For each, assert no processor invoke, no `detectDrift` call, no archival row at `premium`, **no Lex-returned content**, exactly one SecurityEvent, and one count. Run live through the deployed path, with a positive control (the same bot in a premium room answers), so an authentication failure cannot read as a refusal.
1a. **The channel-size test**, which does not exist today: `AccessDeniedException` and `ForbiddenException` yield `refused: true`; a throttle yields `refused: false, unknown: true`.
2. **The resolver honesty test.** `readChannelClassificationTag` returns `undefined` on a thrown read, and every caller in decision 2 refuses on it. The triage test's mock returns what the resolver returns.
3. **The rank-free test.** Over a registry fixture whose `grants` is not a rank prefix, every assistant-plane admission site (the task service, the membership audit) agrees with `channelsActableBy` and `grantsFor`. A lexical guard on `rankOf(`, `profiles.rank(` and `classificationRank(` in those files backs it; a guard on `rankOf` alone would pass today, because that name exists only in `task-service.ts`.
4. **The audit-agrees-with-the-exchange test.** For every declared classification and every group combination the fixtures name, `membership-audit` and `credential-exchange` resolve a person to the same token.
5. **The admin-unknown test.** A conversation with no archived classification and an unreadable tag is refused to every scope-limited admin, and `GET /evaluation/exchanges` applies the same scope as the POST.
6. **The `AssociateChannelFlow` probe**, before the design item is designed: does the tag condition deny an association to a channel of another classification? A live `validate.mjs` phase through the deployed path, positive control included, not a Jest test.
7. **The flow refuses on `undefined`** (false today, `channel-flow-processor.ts:172`), and **a WelcomeIntent does not greet on a denial**.

## What this owes

- A recorded follow-up for each decision, and one for the design item, so none of it lives only here.
- `HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`: the derived-versus-literal consumer list, the group-combination maintenance rule, and the removal checklist.
- `ACCESS-CONTROL-BY-EXAMPLE.md`: the sentence that IAM enforces at the first read and the router honors it, replacing any text that implies the tag read is the enforcement.
- ADR-042's status: a note that its exactly-own IAM was enforcing all along and that this record is the runtime half.
- Records for the five multi-assistant items under "Direction", starting with runtime creation and roles (item 5), since it is what makes the other four concrete: a one-to-many registry with nothing that can add to it is a schema, not a capability.
- An alarm on the refusal count, or the count is a log line.
- The security review that gates the push inherits this record as its opening finding.
