# AgentEchelon Tenets

The non-negotiables. Every architectural decision in the project traces back to one of these, and where two designs competed, the tenet broke the tie.

They align with the platform **invariants** in `docs/specs/conversation-messaging/SPEC-INTERACTION-LAYER.md` §6.

---

1. **Humans and assistants share one control plane** - People from any surface (chat, email, voice, and more) and configurable assistants with their agents are managed in the same conversations through the same access model utilizing repeatable configuration. 

2. **Context compounds, is shared, but bounded** -  A conversation is the unit of context: it builds across every turn and, per user, across their conversations, so no participant starts from zero. Everyone in it: the external user, the internal member who joins, and the assistant works from the same live picture, and that is the efficiency. Users never repeats themselves, whoever steps in is already caught up, and the assistant answers with full awareness. 

3. **The harness outlives the model** - Build the infrastructure once and treat the reasoning model as a replaceable function call, pulled in per step and per experience as the builder needs. The hard parts - context, access, action, observation, delivery - are model-agnostic, and forward-compatibility is by contract (a conversation snapshots its policy, behavior keys are open registries, schema evolves additively), so the catalog of experiences grows without breaking a deployed conversation.

4. **Governance is infrastructure - secure, layered, delegable** Access is enforced by AWS IAM and resource policies before a request runs, identity is bearer-pinned so an actor can only act as itself, `classification` is the only closed ordered axis IAM evaluates, and isolation is provable with a deny-test rather than a code review. Every sensitive operation carries at least two enforcement layers so a basic user cannot reach a premium model even through a direct API call, and one missed check is not a breach. Capabilities are scoped and delegated by narrowing a vended, recorded grant rather than by rewriting the policy.

5. **Fine-grained control at every step: cost, performance, quality, and policy** The builder controls each leg of the interaction: which model runs where (cost and performance), quality measured at every step, and adherence to the business's own policies and needs. The experience is exactly what they intend rather than whatever a model defaults to. When a dependency fails, the assistant degrades to a helpful response instead of failing silently or leaking an error, and best-effort side paths never block a reply.

6. **One central, reusable platform: integrate, don't migrate** Customizable to any use case, it is the single place AI integrates with humans in the loop. A deployed, wired platform (routing, resilience, A/B experiments, evaluation, and an admin console together), not a library to assemble or a new silo per team. Assistants are themselves reusable building blocks, each configured once through the platform's standard assistant onboarding and plugged into the same monitoring and control. It integrates with the business's existing identity provider, routing, and systems of record through per-tenant-isolated connectors, reading each source of truth live rather than rebuilding or duplicating it.
