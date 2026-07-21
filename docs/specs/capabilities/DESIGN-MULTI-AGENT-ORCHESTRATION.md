# DESIGN: Multi-Agent Orchestration

**Status:** Design (alignment doc). This proposes a recommended structure and a set of explicit decisions to confirm. It is not a finalized build; every "Recommendation" below is a starting position pending sign-off, not a committed design.

**Layer:** Core platform (capability - a platform feature under `capabilities/`, not an interaction pillar). Applications consume it; they do not reimplement it.

**Plane:** core. Sub-agents act on the assistant plane (borrowed alt-slot bots), never the admin plane.

**Mechanism vs configuration.** This doc owns the fan-out MECHANISM as a platform capability: spawning ephemeral sub-agents, borrowing alt-slot acting identities, the lifecycle and bounds, and the Strands orchestration layer. The fan-out CONFIGURATION - whether a given assistant delegates at all, over what dimension it fans out (for example per-attendee), its sub-agent bounds, and the per-sub-agent briefing template - is ASSISTANT CONFIGURATION and lives in pillar 2 (`interaction/assistant-config/`; the per-assistant config seam is in `templates/DESIGN-ASSISTANT-TEMPLATE.md`). This is the same split the platform draws elsewhere: for battle, the fan-out-to-two mechanism is platform (`capabilities/SPEC-BATTLE.md`) while the variant an experiment arms is config; for the Converse loop, the runtime is platform while the tools an assistant exposes are config.

**Product spec:** none yet. The first consumer (a meetings assistant) gets its own application-level SPEC that depends on this primitive.

**Summary:** Give one assistant the ability to spin up N short-lived sub-agents, each with its own task and its own channel-acting identity drawn from the existing bounded alt-slot bot pool, coordinated by an orchestrator that runs on top of today's single-assistant Converse loop. Recommended integration point: the AWS Strands Agents SDK as an orchestration layer, not a replacement runtime.

## Motivating example

A user asks their assistant to "set up the Thursday design review with Priya, Marco, and Dana." The assistant needs to, per attendee: look the person up, invite or add them to a channel, greet them, and walk them through why they were added. That is one orchestrator (the user's assistant) fanning out one ephemeral task sub-agent per attendee. Each sub-agent runs a short invite -> join -> greet -> onboard sequence, reports back, and is gone. The orchestrator collates the results into a single reply to the user.

This is the shape of "an assistant that coordinates other assistants." It recurs beyond meetings: bulk onboarding, multi-party support triage, any fan-out-then-collate task. This doc specifies the reusable platform primitive; the meetings assistant is its first application (see "How applications build on it").

## The gap

What AgentEchelon has today:

- **One assistant per classification.** `basic`, `standard`, and `premium` each own a single default `AppInstanceBot`. The channel's immutable `classification` tag selects which one responds (`channel-flow-processor.ts` -> `getChannelClassification` -> `resolveBotArn`).
- **A single self-hosted Converse loop.** `async-processor-core.ts` `invokeBedrock` runs one hand-rolled Bedrock Converse tool loop (reason -> tool_use -> observe -> answer, bounded by `MAX_TOOL_ITERATIONS`). It is one assistant answering one turn.
- **A bounded alt-slot bot pool used only by `/battle`.** `battle-stack.ts` pre-provisions a fixed pool of persona-less `AppInstanceBot`s (default 2, `altBotSlotCount` CDK context; `ALT_BOT_SLOT_COUNT = 2` baseline in `SPEC-BATTLE.md`). Each slot has no static persona; the model and prompt it serves are resolved at runtime. Today the only thing that fans out to them is `/battle`, and only two at a time, head to head.

What the platform does not have: **an assistant that orchestrates N ephemeral sub-agents**, each acting under its own identity, to complete independent sub-tasks and report back. The fan-out machinery exists (`channel-flow-processor.ts` already invokes the async processor per bot member via `Promise.all` + async Lambda invoke), the acting identities exist (the alt-slot pool), and the single-agent runtime exists (`async-processor-core.ts`). No component composes them into orchestrator-plus-workers.

## Recommended structure

**Orchestrator agent + ephemeral task sub-agents.**

- The **orchestrator** is the user's existing assistant (the per-classification default bot, running the `async-processor-core.ts` loop). One new tool is added to its loop: a "delegate" tool that takes a list of sub-tasks and fans them out. The orchestrator stays the single voice the user talks to.
- Each **sub-agent** is an ephemeral worker: a scoped system prompt plus a small task (invite this attendee, greet this attendee). It runs, acts in the channel under a borrowed identity, returns a structured result, and is discarded. It holds no durable state of its own; the orchestrator owns the collation.

**How Strands expresses it.** The AWS Strands Agents SDK is open-source, model-driven, code-first, and model-agnostic over Bedrock, which matches AE's self-hosted-loop posture. Its multi-agent primitives map cleanly:

- **agents-as-tools** - the orchestrator exposes each sub-agent as a callable tool. This is the closest fit to today's Converse tool loop: the delegate step is just another tool the orchestrator model can call, and the sub-agent runs to completion inside that call. Recommended for the meetings case (one sub-agent per attendee, independent, collated by the parent).
- **swarm** - collaborative agents that share context and hand off among themselves. Useful when sub-agents must coordinate with each other rather than only report up. Heavier than the meetings case needs.
- **graph / workflow** - deterministic, declared-edge orchestration. The right tool when the sub-task sequence is fixed and ordering matters (invite must precede greet). AE already has a deterministic-graph idiom in `task-state-machines.ts`; a Strands workflow is the multi-agent analog.

The meetings case is an orchestrator plus a set of independent per-attendee task sub-agents, so **agents-as-tools (with an optional per-attendee workflow inside each sub-agent for invite -> join -> greet -> onboard ordering)** is the recommended starting shape.

**How a sub-agent gets an identity to act in a channel.** A sub-agent that posts, invites, or greets must act as an Amazon Chime SDK principal. The recommendation is to **reuse the bounded alt-slot bot pool** rather than mint an Amazon Chime SDK bot per attendee. A sub-agent is assigned a free slot from the roster (`INSTANCE_SSM.altBotSlotsRoster`, resolved via the `ALT_BOT_SLOTS_ROSTER_PARAM` env the channel flow already reads), acts with `ChimeBearer: <slotArn>`, and releases the slot on completion. The pool is persona-less by design, which is exactly what an ephemeral sub-agent needs: the persona and task are supplied per invocation, not baked into the principal. The pool size is the concurrency bound (see Decision 5).

**Message and turn flow (meetings example).**

1. User turn arrives at the orchestrator (default bot) through the normal `router` -> `async-processor-core.ts` path.
2. The orchestrator's Converse loop calls the delegate tool with a per-attendee sub-task list.
3. The delegate step claims one alt-slot per attendee from the roster (up to the pool bound; excess attendees queue), then invokes a sub-agent runtime per claimed slot (async Lambda invoke, the same `Promise.all` + `InvocationType.Event` fan-out `channel-flow-processor.ts` uses for `/battle`).
4. Each sub-agent runs its short invite -> join -> greet -> onboard sequence as its slot bot, then writes a structured result (per-attendee status) to a coordination store.
5. The orchestrator collects the results (poll or callback), releases the slots, and produces one consolidated reply to the user.

## Decisions to confirm

Each decision is presented with a recommendation, the reasoning, and the tradeoff. None is committed; this section is the point of the doc.

### 1. Strands scope: orchestration layer vs full runtime

- **Recommendation:** adopt Strands as an **orchestration layer on top of** the existing `async-processor-core.ts` Converse loop. The orchestrator uses Strands to plan and fan out; each leaf sub-agent can still run the hand-rolled loop (or a thin Strands agent that wraps the same Converse call).
- **Rationale:** incremental. The single-assistant loop is load-bearing and carries a lot of hard-won behavior (prompt caching, guardrail in/out, work-item proposals, task tools, battle mode, metadata shedding). Wrapping it preserves all of that and limits the new surface to coordination.
- **Tradeoff:** two runtime idioms coexist for a while (Strands orchestration, hand-rolled leaf). The alternative, Strands as the **full agent runtime** replacing the hand-rolled loop, is cleaner long-term but is a large rewrite that re-validates every existing behavior, and is not justified by the meetings use case alone.

### 2. Sub-agent identity: reuse the alt-slot pool vs dynamic provisioning

- **Recommendation:** **reuse the bounded alt-slot bot pool.** Assign a free slot per sub-agent, act as that slot, release on completion.
- **Rationale:** the pool already exists, is persona-less, is bounded, and `SPEC-BATTLE.md` already rejected per-invocation `AppInstanceBot` creation on IAM-policy and unbounded-growth grounds. The same reasoning applies here, so the platform keeps one bounded-pool story instead of two identity models.
- **Tradeoff:** pool size caps concurrent sub-agents (a 5-attendee meeting with a 2-slot pool runs in waves). Dynamic per-attendee bot provisioning removes that cap but reintroduces the unbounded-growth and IAM-surface problems the battle work deliberately avoided, plus provisioning latency on the critical path. If large fan-outs become common, the answer is raising `altBotSlotCount`, not per-attendee bots.

### 3. Runtime: Lambda vs a longer-running host

- **Recommendation:** run sub-agents on **Lambda** for v1 (the same async-processor Lambda substrate). The invite/greet/onboard tasks are short; the 15-minute cap is comfortable.
- **Rationale:** zero new infrastructure, reuses the existing async fan-out, inherits the existing IAM and observability.
- **Tradeoff:** the 15-minute cap rules out a sub-agent that **sits in a live meeting** for an hour. That is a different workload (a long-running host: Fargate, ECS, or Bedrock AgentCore-style runtime) and is explicitly out of scope for v1. If a durable in-meeting presence is wanted later, it is a separate runtime decision, not a reason to reject Lambda for the short-task fan-out that the meetings-setup case actually needs.

### 4. Capability inheritance: sub-agents cannot exceed the parent

- **Recommendation:** a sub-agent **inherits the parent assistant's classification cap and capability scope, and can never exceed it.** A `premium` orchestrator can spawn `premium`-or-lower sub-agents; a sub-agent cannot read company context, tools, or models the parent could not.
- **Rationale:** classification is the platform's authorization axis. If a sub-agent could escalate, delegation would become a privilege-escalation path around the immutable `classification` tag. Inheritance keeps the existing model intact: the sub-agent's effective capability is `min(parent, requested)`.
- **Tradeoff:** a sub-agent cannot be given a narrowly higher capability for one step even when that would be convenient. That is the correct default; a genuine cross-classification need is a separate, explicitly-authorized flow, not an implicit consequence of spawning.

### 5. Lifecycle and bounds

- **Max concurrency:** bounded by the alt-slot pool size (`altBotSlotCount`, default 2). The orchestrator claims up to that many slots and queues the rest into waves.
- **Slot claim/release:** a sub-agent claims a slot atomically (conditional write on a slot-lease record keyed by slot ARN, mirroring the battle-state conditional-write idiom), and releases on completion. A crashed sub-agent's lease ages out on a TTL, so a lost slot self-heals (same pattern as the 10-minute battle-state TTL).
- **Failure/timeout:** one sub-agent failing does not fail the batch. The orchestrator collates partial results ("invited Priya and Marco; could not reach Dana - retry?"), the same fail-soft posture `/battle` uses when a bot's row never reaches terminal.
- **Cleanup:** slots are released and any transient coordination rows TTL out. No durable per-sub-agent state persists past the turn.
- **Recommendation:** ship the bounded, TTL-reaped, fail-soft lifecycle above; do not add a durable sub-agent registry in v1.

## How applications build on it

The platform primitive is: *an orchestrator, a delegate tool, a bounded pool of borrowable acting identities, and a fan-out-then-collate lifecycle.* Keep the boundary crisp.

- **Platform (this doc):** the delegate tool, slot leasing over the alt-slot pool, the sub-agent runtime, capability inheritance, and the lifecycle/bounds. Domain-agnostic.
- **Configuration (pillar 2, assistant-config):** whether an assistant delegates, the fan-out dimension (per-attendee here), the sub-agent bounds, and the briefing template are declared as assistant configuration, not baked into the mechanism. An assistant declares its delegation config in `templates/DESIGN-ASSISTANT-TEMPLATE.md` (the "primitives this assistant uses" seam) and consumes this capability.
- **Application (for example, the meetings assistant):** the per-attendee task definition (invite -> join -> greet -> onboard), the attendee-resolution logic, the onboarding script, and the consolidated user-facing reply. The meetings assistant DESIGN consumes this primitive; it does not own the orchestration mechanics.

A second application (bulk onboarding, support triage) reuses the same primitive with a different per-sub-agent task, no platform change.

## Testing strategy

- **Unit:** the delegate tool's fan-out planning (task list -> slot claims -> waves), slot-lease claim/release with the conditional-write and TTL, capability-inheritance clamping (`min(parent, requested)`), and result collation including partial failure. These are pure-logic seams testable without AWS, mirroring the existing `backend/test/lib/*-battle.test.ts` style.
- **Integration:** orchestrator -> N sub-agents against a stubbed Amazon Chime SDK/Bedrock, asserting each sub-agent acts as its leased slot bearer and releases the slot, and that a crashed sub-agent's lease reaps.
- **End-to-end:** a meetings-setup flow driving invite -> greet for 2-3 attendees on a battle-enabled-style deploy (pool present), asserting the consolidated reply. Expect this to start as a `fixme` scaffold until a pool-provisioned deploy exists, consistent with the battle e2e posture.
- **Deferred / gaps:** live-meeting (long-running-host) sub-agents; fan-outs wider than the pool under real concurrency; cross-classification delegation.

## Security and IAM

- **Bearer pinning.** A sub-agent acts strictly as its leased slot's `ChimeBearer`. It never borrows the orchestrator's default-bot bearer and never acts as a human. This is the same bearer-pinning discipline the channel flow already enforces (each `/battle` bot posts as its own ARN).
- **Capability scoping.** Sub-agent effective capability is clamped to the parent's classification (Decision 4). Company-context, tool availability, and model choice are all bounded by the parent's classification-scoped IAM, so a sub-agent cannot read a higher-classification bucket or call a model the parent could not.
- **Identity boundary.** Sub-agents act on the assistant plane (borrowed alt-slot bots), never the admin plane. Nothing here touches the `${sub}-admin` administration identity or credential-exchange `plane:'admin'`; delegation is an assistant-runtime concern, not an administrative one.
- **Injection defense.** The existing input/output guardrail (`applyInputGuardrail` / `applyOutputGuardrail`) and control-marker stripping apply to each sub-agent turn exactly as they do to a normal turn, so a malicious attendee name or onboarding string cannot break out of a sub-agent prompt any more than it can today.
- **Bounded blast radius.** Pool-size concurrency (Decision 5) caps how many principals a single user turn can put in motion, which is also the cost bound.

## Open technical questions

- **Slot leasing under contention:** if `/battle` and a delegation both want alt-slots at once, who wins, and does delegation need its own pool separate from the battle pool? A shared pool is simpler but couples two features' concurrency.
- **Orchestrator wait model:** does the orchestrator poll a coordination store for sub-agent results, or do sub-agents call back and wake it? Polling is simplest on Lambda; callback avoids a spin but needs a resume path.
- **Where the delegate tool lives:** a new tool in `invokeBedrock`'s tool config (uniform with company-context/task tools) versus a distinct orchestration entry point that wraps the loop.
- **Strands packaging on Lambda:** SDK size, cold-start cost, and whether the leaf sub-agent adopts a thin Strands agent or keeps the hand-rolled Converse call.
- **Sub-agent visibility in the channel:** does each attendee see the sub-agent's greeting as a distinct named member, or does the orchestrator relay? This is partly a product choice for the consuming application, but it constrains how slots are named and surfaced.
- **Result schema:** the structured per-sub-task result contract the orchestrator collates (status, artifacts, error) needs a stable shape so multiple applications can reuse it.
