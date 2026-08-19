---
title: "ADR-026: A task-shaped duel finishes its work with the user before the next round"
status: Accepted 2026-08-10 (both decisions built and deployed)
date: 2026-08-10
related:
  - "./023-battle-round-coordination.md"
  - "./024-task-ownership.md"
  - "./025-who-posts-the-placeholder.md"
  - "../../specs/capabilities/DESIGN-BATTLE.md"
  - "../../specs/capabilities/SPEC-BATTLE.md"
  - "../../../backend/lambda/src/lib/battle-state.ts"
  - "../../../backend/lambda/src/lib/task-tracking.ts"
  - "../../../backend/lambda/src/router-agent-handler.ts"
  - "../../../backend/lambda/src/battle-orchestrator.ts"
amends: |
  Amends DESIGN-BATTLE 2a and ADR-023's consequences. Both stated that removing
  the task gate let a rebuttal answer a side whose chain was still running; that
  is reversed. Their CORE separation is kept intact and is what makes the
  reversal cheap: battle completion is still never defined by task terminality,
  because WAITING_FOR_USER was already non-terminal.
---

# ADR-026: A task-shaped duel finishes its work with the user before the next round

## Status

Accepted 2026-08-10 (owner). Both decisions below are settled and built; not yet exercised against a
deployment.

**Verified by:** `backend/test/lib/battle-two-clocks.test.ts` (the clock split, the row outliving its own
wait, the bound being configuration, waited time banked, and a task leg not inflating
`clarificationCount`), `backend/test/task-shaped-battle-parity.test.ts` (the payload having one
definition, the wait preceding the round-1 terminal transition, no battle-specific completion predicate,
and the round-2 opt-out staying terminal), `backend/test/lib/battle-state.test.ts` (the pointer holding
past ten minutes and ageing out on the duel bound), and `backend/test/lib/battle-round1-complete.test.ts`
(still green, which is the evidence the ADR-024 separation was not reversed to get here).

Each was confirmed to FAIL on the unfixed code before being kept: reverting the waiting transition to the
machine clock reddens two clock tests, and disabling the wait branch reddens two parity tests.

## Problem and who it's for

A user runs `/battle write a report on Q2 churn` and expects two comparable reports to argue over. What
a report actually needs first is requirements: the `report_generation` machine opens at
`collecting_requirements` for exactly that reason. So a task-shaped duel is not one question and two
answers; it is two pieces of collaborative work that each need the user, and only then something to
compare.

Today that produces a duel that cannot finish. It is not a rough edge, it is four separate failures
stacked on the same turn, and the user sees a broken feature rather than a slow one.

## What is actually broken today

Established by reading the code, not inferred:

1. **A task-shaped side never reports round-1 completion at all.** The `TASK_MULTI_STEP` branch's worker
   dispatch (`router-agent-handler.ts`) omits `battleContext` entirely, so the worker never enters its
   battle path: it does not call `markBotCompleted`, does not capture `round1Reply`, and the placeholder
   it returns carries no `<!--battle:-->` marker, so the frontend does not render the turn as a duel
   side. The orchestrator then reports "didn't finish in time" for BOTH sides and closes the duel.
2. **The same dispatch drops the profile variant.** It omits `variantProfile`, so a `profileRef` variant
   silently serves the profile's active version on any task-shaped duel. This is the same class of
   defect as the second profile resolution in the worker, in a second place.
3. **`WAITING_FOR_USER` is on a machine clock.** `markBotWaitingForUser` stamps `enteredStateAt = now`,
   and `rowDeadlineMs` falls back to `enteredStateAt + ROUND1_DEADLINE_MS` (180s). A user who takes more
   than three minutes to answer a clarifying question is reported as an assistant that stalled. The row
   TTL is `STATE_TTL_SECONDS` (600s) from the same instant, so past ten minutes the state is gone
   outright.
4. **A greeting or acknowledgment inside a duel bypasses the whole mechanism.** The `DIRECT`
   short-circuit returns a canned string before any dispatch and has no battle guard, so `/battle hello`
   (the command is stripped before classification, so the classifier sees `hello`) and a continuation
   answered with "thanks" both leave the side at `INVOKED` with no worker ever run.

Point 1 is why the feature looks broken; point 3 is why the obvious fix does not work on its own.

## Decision 1: each side completes its own chain, then the next round fires

**A side's round is not over until it has finished the work it took on, including every exchange with
the user that work needs.** Round 2 fires when both sides have finished, not when both have spoken once.

**Each side runs its OWN chain, with its own requirements.** Side A may ask what period to cover while
side B asks which metric defines churn, and each builds to the answer it got. The user answers both.

**The comparability cost is accepted, explicitly, and is not a defect to be filed later.** Two reports
built to two different briefs are not the same deliverable, so a task-shaped duel measures something
narrower than a single-turn duel does: it compares how each assistant elicits requirements and what it
produces from them, not two renderings of one brief. It also asks the user to answer two sets of
questions. Both were weighed against clarifying once before the fan-out (one brief, one set of
questions, strictly comparable) and against broadcasting one side's answer to both. The owner chose
per-side chains on the grounds that how an assistant elicits requirements is part of what is being
compared. Anything reading a task-shaped duel's result must not describe it as a like-for-like
comparison of one deliverable.

### Why this does NOT reintroduce the coupling ADR-024 removed

DESIGN-BATTLE 2a deleted `isBattleRound1Complete`, which asked "has this side's TASK reached a terminal
state" to answer "is this side's ROUND done". A guard test now asserts that function can never return.
**That separation stands, and this decision does not touch it.** The predicate for "this side produced
its response" remains a battle fact.

What changes is which STATE a task-shaped side occupies between exchanges. `BattleBotStatus` already has
four values and `allBotsTerminal` already counts only `COMPLETED` and `FAILED`, so **`WAITING_FOR_USER`
already suppresses round 2** - that is precisely how a clarifying question works today. A side mid-chain
is therefore BUSY, not incomplete, and the existing state machine already expresses it.

So the mechanism is: a task-shaped side that has more work to do with the user enters
`WAITING_FOR_USER` rather than `COMPLETED`, and reaches `COMPLETED` when its task reaches a terminal
state. No new predicate, no battle question answered from task state, and the guard test stays valid.
Being able to keep that test is evidence the separation was the right cut.

## Decision 2: two clocks, because a human is not a stalled Lambda

**A machine deadline and a human wait are different measurements and get different bounds.**

- **The machine deadline** (`ROUND1_DEADLINE_MS`, 180s) keeps its job: a side that is GENERATING and
  goes quiet has stalled, and "didn't finish in time" is the honest report.
- **The human wait is suspended time.** While a side is `WAITING_FOR_USER` the machine deadline does not
  run, and the row TTL is extended on every exchange so a conversation cannot age out mid-answer. The
  bound on a human wait is its own, and it is generous by comparison.

The distinction the current model cannot express is exactly the one that matters: *the assistant
stalled* versus *the user is still typing*. Both look identical to a single deadline stamped at state
entry, and the current code resolves that ambiguity the wrong way on every clarification.

**A wait is still bounded.** Suspended is not infinite: a duel abandoned by its user is closed
explicitly rather than reported as an assistant failure, and the wait bound is configuration rather
than a constant, for the same reason `X` was rejected as a bare constant in ADR-023 (the arithmetic is
per-profile).

**Measurement obligation.** `computeActiveResponseMs` already exists to bank waited time out of a
side's active response, and `activeResponseMs` is the field a duel's timing should be read from. Any
latency figure attributed to a task-shaped duel must use it, or a slow human is recorded as a slow
assistant.

## Consequences

- **DESIGN-BATTLE 2a's stated consequence is reversed** and its core separation is kept. That section and
  section 5 stated OPPOSITE rules as current fact: 2a said a rebuttal could answer a side still working,
  while section 5 described the pre-separation intent-keyed completion table that ADR-024 had already
  removed. ADR-023's consequences carried the same claim as 2a. All three are reconciled here.
- **`createBattleTask` collapses into `createTask`.** ADR-024 made "the owner may be an assistant" a
  first-class concept, which leaves `battleId` as the only genuinely battle-specific field the separate
  function still carries. Keeping a second creation door is also what forced the battle branch to be
  tested BEFORE the ordinary active-task branch, which is why a resumed side restarts its chain from
  state 0 instead of continuing it. One door, and the ordinary owner lookup
  (`getActiveTaskForOwner`) applies to a duelling assistant exactly as it does to a person.
- **The task-shaped dispatch reaches parity with the placeholder dispatch.** `battleContext`,
  `variantProfile`, `placeholderMessageId` and the attachment all ride it, and the placeholder carries
  the battle marker with the side's resolved display name. The two branches diverging silently is the
  divergence class the round-1 handoff exists to remove; a second copy of a dispatch is where it hides.
- **A duel never uses `DIRECT`.** A greeting or acknowledgment inside a duel resolves to
  `PLACEHOLDER_UPDATE` so the side still runs a turn and still reports its state. The fan-out used to
  enforce this itself and the handoff dropped it.
- **Round 2's archived classification matches round 1's.** Round 1 archives the effective classification
  (the lesser of channel and sender clearance); round 2 must archive the same value rather than the
  channel's, or one duel is split across two `user_type` values in per-classification analytics.
- **A duel now spans human-paced time**, so anything assuming a duel is short gets re-examined: the
  single-active-battle claim, the `resolveActiveBattleId` age-out, and any dashboard that treats an open
  duel as an in-flight request.

## Alternatives rejected

- **Clarify once before the fan-out.** One brief, one set of questions, strictly comparable, and it
  keeps a duel short. Rejected by the owner because how an assistant elicits requirements is part of
  what a duel should compare, and moving clarification ahead of the fan-out removes it from the
  comparison entirely.
- **Broadcast one side's clarification answer to both.** Preserves comparability and asks the user once,
  but the side that did not ask receives requirements it did not earn, and the deliberate per-bot routing
  in `planBattleContinuation` exists so a side that failed to ask never benefits from its rival's
  question.
- **Raise `STATE_TTL_SECONDS` to cover a human wait.** One constant, no new concept, but it delays
  reporting a genuinely stalled side by the same amount and holds every row far longer. It resolves the
  ambiguity by discarding the distinction rather than modelling it.
- **Let round 2 fire mid-chain and tell the rebuttal about it in the prompt.** What DESIGN-BATTLE 2a
  proposed. Rejected: a rebuttal of a half-written report is not a rebuttal, and the prompt cannot
  recover information the other side has not produced yet.
