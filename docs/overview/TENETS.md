# AgentEchelon Tenets

The non-negotiables. Every architectural decision in the project traces back to one of these, and where two designs competed, the tenet broke the tie.

The platform **invariants** in `docs/specs/interaction/SPEC-INTERACTION-LAYER.md` §6 elaborate the governance, forward-compatibility, and integration tenets (4, 3, and 6); the remaining tenets (shared control plane, context, fine-grained control) are design commitments these invariants sit beneath rather than restate.

---

1. **Humans and assistants share one control plane** - People from any surface (chat and outbound email today, with voice and more as they come online) and configurable assistants with their agents are managed in the same conversations through the same access model utilizing repeatable configuration.

2. **Context compounds, is shared, but bounded** - A conversation is the unit of context: it builds across every turn and, per user, across their conversations, so no participant starts from zero. Everyone in it: the external user, the internal member who joins, and the assistant works from the same live picture, and that is the efficiency. Users never repeats themselves, whoever steps in is already caught up, and the assistant answers with full awareness.

3. **The harness outlives the model** - Build the infrastructure once and treat the reasoning model as a replaceable function call, pulled in per step and per experience as the builder needs. The hard parts - context, access, action, observation, delivery - are model-agnostic, and forward-compatibility is by contract (a conversation snapshots its policy, behavior keys are open registries, schema evolves additively), so the catalog of experiences grows without breaking a deployed conversation.

4. **Governance is infrastructure - secure, layered, delegable** Access is enforced by AWS IAM and resource policies before a request runs, identity is bearer-pinned so an actor can only act as itself, `classification` is the only closed ordered axis IAM evaluates, and isolation is provable with a deny-test rather than a code review. Every sensitive operation carries at least two enforcement layers so a basic user cannot reach a premium model even through a direct API call, and one missed check is not a breach. Capabilities are scoped and delegated by narrowing a vended, recorded grant rather than by rewriting the policy.

5. **Fine-grained control at every step: cost, performance, quality, and policy** The builder controls each leg of the interaction: which model runs where (cost and performance), quality measured at every step, and adherence to the business's own policies and needs. The experience is exactly what they intend rather than whatever a model defaults to. When a dependency fails, the assistant degrades to a helpful response instead of failing silently or leaking an error, and best-effort side paths never block a reply.

6. **One central, reusable platform: integrate, don't migrate** Customizable to any use case, it is the single place AI integrates with humans in the loop. A deployed, wired platform (routing, resilience, A/B experiments, evaluation, and an admin console together), not a library to assemble or a new silo per team. Assistants are themselves reusable building blocks, each configured once through the platform's standard assistant onboarding and plugged into the same monitoring and control. It integrates with the business's existing identity provider and routing today, with per-tenant-isolated connectors to systems of record - reading each source of truth live rather than rebuilding or duplicating it - designed and seamed.

## Implementation tenets

Tenets 1-6 are the commitments a design is judged against. These four are the mechanics that follow
from them and settle day-to-day implementation choices - which source to read, whether to add
infrastructure, whether a schedule is warranted. They are listed separately because they are applied
at a different altitude, not because they are lesser, and because each has been violated in practice
with the violation shipping green.

7. **Event-driven, not polling** - If a system already emits an event for a state change, subscribe to
it rather than re-deriving that state on a timer. A schedule that recomputes what an event stream
already delivers is duplicated logic with added latency and a second way to be wrong. Two
qualifications keep this honest. First, **you cannot event-source the absence of an event**: detecting
that nothing happened (abandonment, idle-sleep) is inherently time-based, and so is anything genuinely
periodic (a daily briefing, batch evaluation deliberately batched for cost). Second, events get
dropped and handlers fail, so a **low-frequency reconciliation sweep behind an event path is correct
design** - the sweep is a correctness backstop, never the primary mechanism.

8. **Know which of the three stores answers your question, and use one source per question** - There
are three, with different jobs, and treating any of them as a cache of another produces numbers that
disagree:

   - **Amazon Chime SDK Messaging** - authoritative for *current* conversation state: content,
     membership, name. It streams both as events. It is NOT durable beyond the channel's life and
     holds none of the platform's own telemetry.
   - **The S3 / Athena conversation archive** - the system of record. Append-only, survives channel
     deletion, holds the full event sequence (including what a message said before it was edited or
     redacted) *and* everything the Amazon Chime SDK never knew: model used, tokens, latency,
     guardrail decisions, evaluation scores, experiment attribution.
   - **The Aurora projection** - a fast, lossy, rebuildable query surface for similarity search and
     analytical joins.

   Read current conversation state from the Amazon Chime SDK rather than a copy: a projection inherits
   its pipeline's lag, and at read time that is indistinguishable from the conversation having been
   quiet. Read history, telemetry, and anything that must outlive the channel from the archive - "go
   to the source, not the copy" is about current state, and must not talk anyone out of using the
   archive for what only the archive has. And when the caller already holds the data in memory,
   consult neither.

   **One source per question, per mode.** Within a deployment, every caller asking the same question
   must read the same place: in Aurora mode that is consistently Aurora, in Athena mode consistently
   Athena. Two surfaces answering "how many messages" from different stores will disagree, and the
   operator has no way to tell which is right. If a number is shown in more than one place, it comes
   from one query.

   **Say what a number counts.** Operators reconcile these figures against an AWS bill and against
   each other, so a count must state its own semantics. "Messages" that counts message-created events
   includes messages later deleted or redacted - correct for "how much did we process and pay for",
   wrong for "how many are in this conversation now". Both are legitimate questions; a figure that
   does not say which one it answers will be read as whichever the reader had in mind.

9. **Reuse before building** - Prefer an existing seam, construct, or native service feature over new
infrastructure. Before adding a resource, check whether the platform already solved this: the
non-VPC-handler to data-plane-Lambda seam takes a new `op` rather than a new VPC endpoint; the Amazon
Chime SDK supplies channel flows, moderation, membership events, and streaming config rather than
app-level reimplementations of them; the migration runner applies a new SQL file with no manual step.
New infrastructure carries a standing cost and a standing failure mode, so it should be the conclusion
of an argument, not the opening move.

10. **Consistent designs for similar functionality** - Two features of the same kind should be built
the same way. When a second instance of a pattern diverges, both become harder to reason about and a
fix to one silently leaves the other broken. If a new case genuinely does not fit the established
pattern, change the pattern or record why it does not apply - do not quietly fork it. This applies to
where a resource lives (a stack owns a capability, not a technology), to how a surface authorizes, and
to how a value is stored: a versioned row may hold provenance, never current state.
