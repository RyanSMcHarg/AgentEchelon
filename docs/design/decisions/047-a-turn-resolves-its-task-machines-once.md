---
title: "ADR-047: A turn resolves its task machines once, and carries them"
status: Accepted 2026-09-20 and built. Decision 3 changed while building it - the selection gates OPENING rather than narrowing the runtime set, because narrowing what runs strands a task already in flight. The record carries the correction rather than the draft. It follows two code reviews of the global-workflows change (commit `f8026cb`), which between them found eight wiring defects of one shape; this record is the shape, not the eight.
date: 2026-09-20
related:
  - "./033-a-conversation-answers-one-turn-at-a-time.md"
  - "./042-an-assistant-acts-in-exactly-one-classification.md"
  - "../../specs/interaction/assistants/DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md"
  - "../../specs/interaction/conversation/SPEC-TASK-STATE-TRANSITIONS.md"
  - "../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md"
  - "../../../backend/lambda/src/lib/task-state-machines.ts"
  - "../../../backend/lambda/src/lib/intent-pack.ts"
  - "../../../backend/lambda/src/lib/async-processor-core.ts"
  - "../../../backend/lambda/src/router-agent-handler.ts"
tracking: |
  The owner, 2026-09-20: workflows and the intents that open them belong to the platform, a classification may add its own, and an assistant may be configured to use them or not. The ownership half of that is sound. The SELECTION half was built against a resolution model that cannot express it, and this record is why that is a property of the model rather than of the four patches that failed to fix it.
---

# ADR-047: A turn resolves its task machines once, and carries them

## Status

**Accepted and built (2026-09-20).**

The change it examines (`f8026cb`) was partly inert and partly half-wired; this record decided what replaced it, and decision 3 changed during the build for a reason the build surfaced. The measurements below are from the tree at that commit plus the corrections attempted on top of it.

## The problem, in one example

An assistant is configured to offer one workflow: `guided_troubleshooting`. A `report_generation` task is open in its conversation.

The assistant is offered the `advance_task_state` tool for that task, advances it into a state that declares `delivers`, and produces the report. The delivery gate then looks for the machine, does not find it, and attaches nothing. The report reaches the person as unattached chat text, and the task advances anyway.

Nothing failed. No error is logged. The only symptom is a document that should have arrived as a file arriving as a wall of chat, which is the exact outcome the delivery gate exists to prevent, and which its own comment says it prevents.

That is one defect. Two review passes found eight, and every one of them is a variation of it: one component narrowed, another did not, and the disagreement is silent.

## What the code believes about task machines

Three things, none of them written down together, and the third is the one that matters.

**There is a resolved set per deployment.** `taskStateMachines(pack)` merges the classification intent pack's `machines` over `DEFAULT_TASK_STATE_MACHINES`. That is the correct model and it is not the problem.

**Every consumer resolves it for itself.** Twenty call sites call `taskStateMachines()` with no argument, each one asking the question again: the router at seven places, the processor at four, the core loop at three, the queue drain, the task service client, the user-tasks API. There is no single place where a turn's machines are decided.

**A consumer that forgets to ask gets a different answer, silently.** Thirteen function signatures in `task-state-machines.ts`, `task-tools.ts` and `task-tracking.ts` declare `machines: Record<string, TaskStateMachine> = DEFAULT_TASK_STATE_MACHINES`. A caller that omits the argument does not get an error and does not get the deployment's machines. It gets the platform defaults, which is a real answer to a different question, and on a deployment whose classification pack adds or overrides a machine it is the wrong one.

That default has already caused this once and the tree records it. `user-tasks-api.ts:50`: "`needsOf` read `taskStateMachines()` in a function that hydrates no intent pack". The fix at the time was to pass the pack at that call site. The signature that permitted the mistake was left as it was.

## Why the selection could not be bolted on

An assistant selecting which workflows it offers is a NARROWING. The resolution model is built on MERGING.

`buildTaskLoopContext` is the clearest case: `const machines = args.machines ? { ...base, ...args.machines } : base`, where `base` is the full resolved set. Those semantics come from the per-assistant override the design just removed, where a profile supplied a subset and inherited the rest. Under override semantics the merge is right. Under selection semantics it is not merely wrong, it is a no-op that looks like the fix: passing a narrowed set spreads it over the full set and yields the full set back. The corrected call site reads exactly like a working one.

So the narrowing has to be applied at every site independently, and every site that is missed fails silently, because a task machine is consulted for authorization in one place, for delivery in another, for the prompt hint in a third, and for the task type in a fourth. Each pair that disagrees is a distinct defect with its own symptom.

The evidence that this is not a matter of care: four separate corrections were applied across two review rounds, each one addressing the sites the previous round named, and each round found more. The remaining ones at the time of writing are the merge above, `taskHasMachine`/`legalTransitionsFrom` reading the compiled defaults rather than the turn's set, the import path discarding graphs where the edit path explains the refusal, and the router narrowing with the classification's active version while the processor narrows with the experiment variant's.

## Decision

**1. A turn resolves its task machines ONCE, where it resolves the assistant, and carries them.**

The resolved set becomes part of the turn's resolved context, alongside the persona, the model and the tool allowlist. It is computed where those are, from the same version, and passed to every consumer in that process. Each of the two Lambdas resolves it once for its own turn: the router beside the intent pack it is classifying against, the processor beside the assistant it resolved.

NOT PASSED ACROSS THE LAMBDA BOUNDARY, and that is a deliberate limit rather than an omission. The obvious reading of "resolved once" is that the router sends the set on the event, and the resolved machines are a large object that would then ride every asynchronous invoke for no gain: both sides resolve from the same two inputs, the classification's pack and the serving version, so a second resolution on the same inputs is the same answer. What the decision removes is a consumer resolving INDEPENDENTLY inside a process, which is where every measured defect came from.

The experiment case is correct because the processor resolves beside the profile it is actually serving, variant included, rather than inheriting a set resolved from a different version.

**2. The `machines` parameter defaults are removed.**

Twelve signatures take a required argument, plus the two context types that carry the set (`TaskLoopContext` and the `buildTaskLoopContext` argument).

NOT YET `advanceTaskStateTo` AND `applyUserResponseToTask`, which are the authorization path and keep the optional-with-default shape; `queue-drain-task.ts` and `task-service.ts` call them without one. So "it does not compile" is true of the read and prompt paths and is not yet true of the advance path, which is the one that matters most. That is remaining work, not a decision to exempt them. A caller that does not have a turn's machines to pass cannot silently get the platform defaults; it does not compile. This is the enforcement half, and it is the reason to prefer it to a convention: the failure it prevents is invisible at runtime, so the compiler is the only reader that will reliably notice.

Where a caller genuinely operates outside a turn, it passes `DEFAULT_TASK_STATE_MACHINES` explicitly and says why at the call site. An explicit platform-only set is a decision; a defaulted one is an accident that reads identically.

**3. The selection gates what may be OPENED. It never narrows what runs.**

This is a correction to the shape the record was drafted with, and building it is what produced the correction. The draft said the selection narrows the resolved set once, at the single resolution. That is coherent and it strands work: a task opened while a workflow was offered keeps running long after the selection changes, and narrowing the runtime set removes the graph from under it. The advance tool stops being offered for that task, the delivery gate stops recognising it, and the person waiting on the work has no way to finish it and no error to explain why.

So the selection is applied at the ONE place a task type is chosen - the router, at the moment it decides to open one. Everything downstream runs the task it was handed against the full resolved set. Gating the opening cannot strand anything, because nothing is in flight yet, and it is the decision an operator means when they say an assistant should not offer a workflow.

That also removes the failure this record opens with rather than merely fixing it: there is no longer a narrowed set and a full set that can disagree, because at runtime there is only one.

The PLATFORM machines (`queue_drain`, `queued_request`, `queued_clarification`, `queued_combination`, `work_still_wanted`) are exempt even from the open gate, because the queue opens them directly and they are how the turn queue works rather than workflows anyone opted into (SPEC-TASK-STATE-TRANSITIONS, "Two kinds of shipped machine").

**4. Definitions stay where they are: the platform set, and a classification's pack.**

A profile version does not define a task graph. That half of the original change is sound, is the ownership the owner asked for, and is not revisited here. It covers task machines only: an event workflow (ADR-061) is declared on a version, by ADR-061 decision 1 as built, because it is the assistant's own greeting and follow-up rather than a shared lifecycle.

## Gaps this record named, and what has since closed

**The duel door is gated. CLOSED.** As first written this record said: *"A task opens in two places in the router: the ordinary intent path, and the battle side. The gate is on the first. Gating the second makes the task id conditional for the whole battle chain below it, which is a change to the `/battle` hot path rather than to the selection."* That reasoning held only for gating it **at the creation site**, which is where it was being attempted. The gate belongs one level up, in `resolveBattleSide`, where the delivery option and the task type are produced by one function: a side that may not open the type plans a `PLACEHOLDER_UPDATE` and carries no task type, so the creation branch is never reached and nothing below it becomes conditional. The obstacle was an artifact of where the gate was being placed, not a property of `/battle`.

This is the same lesson as the decision above, one level out: gate what is OPENED, at the point the decision is made, rather than what is RUN. Verified by `battle-turn.test.ts` ("will not open a workflow the serving version deselected, and plans a REPLY instead"), with the companion assertion that an allowed type still opens, so a gate stuck closed cannot pass.

**The gate reads the serving variant. CLOSED.** As first written this record said the gate was fixed where the intent pack is resolved, so an experiment's variant profile settled later in the same handler and its `workflows` was never read: a variant that changed the selection did not change what its arm could open, and both sides of a duel were gated identically however the variants were configured.

The gate is now built inside `resolveBattleSide`, after the variants resolve, from the serving variant's own `workflows` with the classification's selection as the inherited default when a variant sets none. `resolveBattleSide` takes that selection rather than a ready-made predicate, which is what lets it wait for the variant. Per side, so an experiment that varies `workflows` is testable. Verified by `battle-turn.test.ts` ("gates on the SERVING VARIANT's selection, not the classification's").

The change is in the working tree and not committed, so a clean checkout still carries the classification-level gate.

## What this record does NOT decide

**Whether a pack that drops the work-management intent is refused or repaired.** The original change imported a route key (since retired by ADR-064) into every pack and the key was wrong, so the guarantee was dead code; corrected to `guided_troubleshooting`, it works and injects that intent's troubleshooting-flavored description into every deployment's classifier prompt, including deployments with nothing to troubleshoot. The three candidates are to keep injecting, to add a domain-neutral work intent to the default pack and inject that, or to refuse at the write path a pack that leaves an assistant unable to open work at all. That is a separate decision about authored taxonomies and is deliberately not bundled here.

## Alternatives considered

**Patch the remaining sites.** This is the third round of it. The first two each fixed what the previous review named and each left a silent disagreement behind, because the number of sites is twenty and the failure is invisible. The argument against is not that patching is hard, it is that nothing in the code prevents the twenty-first.

**Keep the defaults and audit by test.** A test can assert that a given consumer passes the turn's machines; it cannot assert that every future consumer will. The default is the thing that makes forgetting silent, and it costs nothing to remove.

**Resolve lazily behind a single accessor with request-scoped state.** One resolution point, without threading a parameter. Rejected because the Lambda container is reused across turns and across assistants: request-scoped mutable state is how one turn's configuration reaches the next one's, and the profile cache already makes that failure mode familiar. An argument that is passed cannot leak across turns.

**Drop the selection and ship only the ownership change.** This is the honest fallback and it remains available. It is not preferred because the selection is a requirement the owner stated, and because the resolution consolidation is worth doing on its own merits: the twenty independent resolutions and the thirteen silent defaults are a defect surface whether or not anything narrows.

## Consequences

**The blast radius is the parameter, not the logic.** Thirteen signatures lose a default and roughly twenty call sites gain an argument they already have in scope. No machine changes, no state changes, no stored data changes.

**Some call sites will turn out to have no turn context.** Those are the interesting ones, and each is a question worth answering rather than defaulting past: the queue drain, the task service, the user-tasks API. Where the answer is genuinely the platform set, it says so.

**`f8026cb` must not be left as the tip.** It contains a dead import and a selection that narrows the delivery gate without narrowing the tool that advances into it. Either this record is built on top of it, or the selection half is reverted first. Leaving it is the one option that is worse than both.

**The e2e coverage the change removed has to come back.** `CUSTOM_MACHINES` in `profile-config.spec.ts` was the only end-to-end exercise of the deprecated `awaitsUser` wait form. It is unreferenced now, and the compatibility promise in SPEC-TASK-STATE-TRANSITIONS 12.6 is exercised nowhere against a deployment. It moves to the classification pack, which is where a deployment's own machine now lives.
