# The AgentEchelon Interaction Layer - platform composition model

**Audience:** anyone deciding *whether* AgentEchelon fits their use case and gives them the right level of security, plus contributors who need to see how the interaction layer and security model is built before diving into a new use case or editing an existing use case. (Deployers who want *how do I add or edit one* want the **guides** in §7; this doc is the model behind them.)

**Status:** Design overview.

AgentEchelon today serves internal-collaboration use cases where one or more people interact with an assistant. Users and assistants are restricted to the data and models their specific role or use case requires, managed through an interaction layer that sits between the frontend surfaces (web, voice, and SMS) and the backend to control access at multiple levels. Because AgentEchelon is built on AWS services at its core, it enforces this with AWS primitives: a defense-in-depth approach that blocks restricted features in real time through both application code and infrastructure, and produces an automated audit trail of access and control changes. Five pillars accomplish this:

- **Message flow (how a turn travels the layers)** - `docs/guides/developer/MESSAGE-FLOW.md` (channel flow / Lex / `@all` / fulfillment / async processor, and where each control acts)
- **Identity & Access** - `docs/specs/identity-access/SPEC-CREDENTIAL-EXCHANGE.md` (+ `docs/design/SPEC-FEDERATED-PARTICIPANTS.md`, `docs/guides/user/IDENTITY-PROVIDER-GUIDE.md`)
- **Assistant Configuration** - `docs/specs/assistant-context/SPEC-ASSISTANT-CONFIG.md`
- **Conversation Configuration** - `docs/specs/conversation-messaging/SPEC-CONVERSATION-TYPES.md`
- **Connectors** - `docs/specs/conversation-messaging/SPEC-CONVERSATION-TYPES.md` §6 (+ `backend/lib/config/connectors.ts`)
- **Auditing** - `docs/specs/identity-access/SPEC-ACCESS-AND-CONTROLS-AUDITING.md`

Also: `docs/overview/ARCHITECTURE.md` (how the shipped system works end-to-end today) and `docs/specs/identity-access/SPEC-CONVERSATION-SECURITY.md` (the security layers).

---

## 1. Why? From a tiered chat tool to an interaction layer enabling multiple use cases

Most agentic products are **one assistant, one channel, one user**. That's enough for a personal copilot or for proofs of concept. It is not enough to meet strict requirements from enterprise businesses that require a centralized platform to enable AI capabilities across internal and external touchpoints. As more companies look to realize the full potential of AI systems, they need a system that lets them manage not only the relationship between a customer and a single business unit, but oftentimes one or more customers across multiple business units. Think about the purchase of enterprise infrastructure. As a **customer** moves between sales, a scheduled service visit, and a support case; the **internal employees** they interact with and the AI assistants managed by different internal organizations exist *inside* existing tools and services that are already part of their daily workflows. In many cases - not just in the enterprise (think home sales, where independent agents are involved) - partners and other parties enter these complex workflows. Companies need to manage the interactions and the different touchpoints, and importantly, will see better adoption if they don't try to force different parties to wholesale abandon existing tools and processes.

AgentEchelon's target is a **single interaction layer**: a configurable surface where internal people and external customers meet, across chat, voice, video, and email, served by the right assistant, gated by the right access, and **wired into the systems the business already uses** rather than replacing them. The same platform expresses a 1:1 tiered chat, a routed support case, a masked service call, a sales engagement, and an alert-triggered incident-triage room by **configuration**, not new code.

**Built on AWS, enforced by IAM.** AgentEchelon is composed of AWS-native services (Amazon Chime SDK Messaging for the conversation substrate, Cognito + STS for identity, S3/Bedrock for context and inference). The decisive consequence is that **access is enforced by IAM and resource policies, secured through infrastructure, not just application code.** Who can act on which conversation, as which identity, at which classification, reaching which external system: every user, every conversation, and every assistant is an AWS resource, so each of these is an IAM/resource-policy decision evaluated *before* a request is processed. That is why the platform can safely open up to a wide range of use cases (guests, federated externals, routed agents, multi-tenant connectors) without each new experience becoming a new attack surface: a misrouted request or an application bug cannot exceed what the assumed role and the channel's policy already permit. The richness of §3's experiences rides on the rigor of §4's two enforcement layers, both of which are AWS-native primitives.

## 2. Who benefits

- **Customers** get *one* place for every interaction with the business (sales, a scheduled technician, a support case) with consistent quality and carried context regardless of which team or assistant they reach.
- **Internal & business users** get one surface for internal *and* external agentic workflows, shared context, and an assistant that helps them **in the moment** of a customer conversation.
- **The business** integrates instead of migrating: its existing IdP (SSO), its routing (Salesforce Omnichannel, ServiceNow, …), and its systems of record stay authoritative; AgentEchelon becomes the interaction layer on top - deployable to its own AWS account, MIT-licensed, no per-seat lock-in.

## 3. Experiences enabled

Each is one conversation *type* composed from the pillars:

- **Engagement** - a single assigned internal user (resolved from the business's directory) owns an ongoing, context-rich relationship with a customer.
- **Support** - a customer enters via an embedded widget or a phone number; the assistant triages, then the business's router brings in a human agent **for the duration of the case**, working from the existing case in the business's case/ticketing system (ServiceNow, Zendesk, Salesforce Service Cloud).
- **Service** - schedule / reschedule, then talk to the technician across chat, voice, and SMS with **masked numbers**, every channel's history attached to the one conversation, so the same context carries forward into any later support case.
- **Internal IT** - an employee gets help in-context; a ticket is created and routed to IT in the existing service desk.
- **Incident triage** - an alert spins up a room, dials in the on-call engineer, shows live operational data, and escalates to the IT team or the vendor's support - all from one orchestrated conversation.

## 4. The composition model, the conversation type is the root 

The pillars are not peers. **The conversation type is the composition root** - it composes Identity & Access, Assistant Configuration, and Connectors - and the conversation (the Amazon Chime SDK channel) is the runtime hub everything attaches to. The fifth pillar, Auditing, is cross-cutting: it records access and membership changes across all of them, so it sits beside this model rather than inside it.

```
                Conversation Configuration  (the policy bundle = composition root)
                          │
   classification ───────────────────────► Identity & Access        WHO may act, at what capability
   (the one IAM-evaluated axis)              • person  → SSO → credential exchange → capped, bearer-pinned role
                          │                  • external → connector resolves → admitted at a capped classification
                          │                  • assistant → its own per-tier identity
   defaultAgents ────────────────────────► Assistant Configuration  WHICH assistant + how it behaves
                          │                  (model / prompt / tools / guardrail)
   connectors[] ─────────────────────────► Connectors               WHICH external systems + how
                          │                  (resolve people · sync records · fetch data · provide transports)
   commsChannels · participants ·
   capabilities · offboardMode ──────────► the conversation-level policy ([C] below)
```

**Two enforcement layers tie it together** (the two columns of the capability model):

- **[I] Identity / IAM** - *can these credentials act at all, and on which classification of channel.* The single shared axis is the channel's `classification` tag, **set from the conversation type** at creation. Identity (the credential exchange) enforces it; the bearer is pinned to the caller's own identity.
- **[C] Conversation-level policy** - *does this conversation type permit the action, for this role.* Comms channels, participant rules, drift, offboard behavior - app-level, driven by the type's config.

A participant's effective capability in any conversation = **their access rung ([I]) ∧ the conversation type's policy ([C])**. Every actor - a tiered human, a federated external, the assistant, a connector - is *placed* by Identity and *bounded* by the Conversation type.

The assistant is the one actor that lives in **two** pillars at once: it is an **identity** (its own classification-gated role, bearing an assistant identity, never a user) *and* an **assistant configuration** (its model, prompt, tools, guardrail).

## 5. The five pillars (target, in one line each)

- **Identity & Access** - *anyone* (your SSO users, connector-resolved externals, guests) participates at exactly the capability they should, and **only as themselves** (bearer-pinned). One backend credential exchange vends scoped, classification-capped credentials for any identity provider. → `SPEC-CREDENTIAL-EXCHANGE.md`.
- **Assistant Configuration** - *what the assistant is* (model, system prompt, tools, guardrail) is config a conversation type selects, so different experiences get different assistants without new code. The capabilities ship today (scattered across `model-strategy.ts` and the per-tier stacks); the spec gives them a home as a named bundle. → `SPEC-ASSISTANT-CONFIG.md`.
- **Conversation Configuration** - a conversation is a **configurable experience**, not a fixed chat: a composable bundle (classification + agents + comms + participants + connectors + capabilities) that *carries* a classification (it never invents one), with a forward-compat contract so the catalog grows without breaking deployed conversations. → `SPEC-CONVERSATION-TYPES.md`.
- **Connectors** - the platform **plugs into the business's existing systems** (Salesforce / ServiceNow / Jira / Twilio / AWS Support / PagerDuty …) instead of replacing them: resolve people, sync records, fetch data, provide transports - per-vendor, per-tenant-isolated. → `SPEC-CONVERSATION-TYPES.md` §6.
- **Auditing** - access and membership changes (`CREATE`/`DELETE_CHANNEL_MEMBERSHIP` + moderator grants) stream through Kinesis to an append-only archive: the system of record for *who could act in a conversation, and when*. Amazon Chime SDK exposes no membership-history API, so this archive fills the gap and backs the admin console's audit views. The capture ships today; the spec defines the retention, query, and access contract over it. → `SPEC-ACCESS-AND-CONTROLS-AUDITING.md`.

## 6. The invariants (what must stay true as it grows)

- **Security is IdP-agnostic and lives at two layers** (the AppInstanceUser/membership + the assumed role), never on a Cognito-specific signal (`SPEC-CONVERSATION-SECURITY.md`).
- **`classification` is the only closed, ordered axis** IAM evaluates. Conversation types proliferate freely and **carry** a classification; adding a type never adds a classification (that's a separate, deny-tested change).
- **Identity is bearer-pinned** - an actor can only ever act *as itself*.
- **Forward-compatible by contract** - conversations snapshot their resolved policy at creation; resolution is lenient; behavior keys are open registries; schema evolves additively. Growth never breaks a deployed conversation.
- **Integrate, don't migrate** - external systems stay authoritative; connectors are per-vendor and per-tenant credential-isolated.

## 7. Two doc tiers

- **Design specs** (this doc + the four pillar specs) - *why it's architected this way.* For contributors and evaluators.
- **Deployer guides** - *how do I add/edit one.* Task-oriented, portable, **gated on shipped capability** (a how-to implies the feature works). Extend `IDENTITY-PROVIDER-GUIDE.md` (access model) + `HOW-TO-ADD-OR-MANAGE-A-PROFILE.md` (assistant/tier); add a conversation-type guide and a connector guide as those pillars ship.

## 8. Current state: live, wired, and design-only

The system has all the wiring and seams in place with no one-way doors, while exposing to users only the internal use cases the app has focused on to date. Capabilities fall into three buckets, where the boundary is *capability available to users*, not *code present*:

- **① Live & user-facing today - the internal use cases built to date.** Tiered private chat (basic / standard / premium) on the self-hosted Converse agent loop with per-tier model + guardrail + context-S3 isolation; `@assistant` / `@human` / `@all` mention routing; conversation sharing + email invite; proactive briefings; `/battle` (premium-gated); drift detection (conversation-level, all-tier, on by default); the admin console; analytics (Athena default, Aurora opt-in) + client-events telemetry. **Security live today:** the credential-exchange bearer pin is live (end-user and assistant bearers both pinned; the legacy Identity-Pool over-grant is retired) and the Layer-1 classification gate.
- **② Wired but dormant today - the "no one-way doors" seams.** The conversation-type registry (defaults to the tier today), the connector schema, the federated-participant substrate, comms-transport hooks, and conversation-as-hub plumbing. Present, additive, unconsumed - so a new use case is config + activation, never a migration.
- **③ Design-only today - door open, not wired.** The external use cases of §3 (support / service / incident triage / engagement), live connector integrations, and federated externals. Explicitly the destination, not a shipped capability.

The experiences in §3 are the destination; the per-pillar specs + the migration sections are the path.
