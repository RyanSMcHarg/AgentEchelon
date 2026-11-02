# The AgentEchelon Interaction Layer - platform composition model

**Status:** Design overview.

**Audience:** anyone deciding *whether* AgentEchelon fits their use case and gives them the right level of security, plus contributors who need to see how the interaction layer and the security model are built before starting a new use case or editing an existing one. Deployers who want *how do I add or edit one* want the guides in §7; this document is the model behind them.

**Coverage:** none - a design overview that owns no behavior of its own; each pillar spec it maps declares its own coverage.

**Related:** [SPEC-CREDENTIAL-EXCHANGE.md](./governance/SPEC-CREDENTIAL-EXCHANGE.md), [SPEC-ASSISTANT-CONFIG.md](./assistants/SPEC-ASSISTANT-CONFIG.md), [SPEC-CONVERSATION-TYPES.md](./conversation/SPEC-CONVERSATION-TYPES.md), [SPEC-CONNECTORS.md](../communication/SPEC-CONNECTORS.md), [SPEC-ACCESS-AND-CONTROLS-AUDITING.md](./governance/SPEC-ACCESS-AND-CONTROLS-AUDITING.md) - the five pillar specs, each of which owns its own requirements. [SPEC-CONVERSATION-SECURITY.md](./governance/SPEC-CONVERSATION-SECURITY.md) - the security layers. [ARCHITECTURE.md](../../overview/ARCHITECTURE.md) - how the shipped system works end to end.

**Site section:** Interaction layer.

---

**This document is an overview of how the platform composes rather than a spec of a feature, so it carries no requirements table.** Every requirement, its priority and its delivery status live in the five pillar specs listed in §5, and the security layers live in [SPEC-CONVERSATION-SECURITY](./governance/SPEC-CONVERSATION-SECURITY.md). What lives here is the composition model: which pillar owns which decision, which pillar is the composition root, and which invariants have to stay true as the catalog of experiences grows.

AgentEchelon today serves internal-collaboration use cases where one or more people interact with an assistant. Users and assistants are restricted to the data and models their specific role or use case requires, managed through an interaction layer that sits between the surfaces people use (chat and outbound email today, with voice and more as they come online) and the backend, controlling access at multiple levels. Because AgentEchelon is built on AWS services at its core, it enforces this with AWS primitives: a defense-in-depth approach that blocks restricted features in real time through both application code and infrastructure, and produces an automated audit trail of access and control changes. Five pillars accomplish this:

- **Identity and Access** - [SPEC-CREDENTIAL-EXCHANGE.md](./governance/SPEC-CREDENTIAL-EXCHANGE.md), with [SPEC-FEDERATED-PARTICIPANTS.md](./governance/SPEC-FEDERATED-PARTICIPANTS.md) and [IDENTITY-PROVIDER-GUIDE.md](../../guides/user/IDENTITY-PROVIDER-GUIDE.md)
- **Assistant Configuration** - [SPEC-ASSISTANT-CONFIG.md](./assistants/SPEC-ASSISTANT-CONFIG.md)
- **Conversation Configuration** - [SPEC-CONVERSATION-TYPES.md](./conversation/SPEC-CONVERSATION-TYPES.md)
- **Connectors** - [SPEC-CONNECTORS.md](../communication/SPEC-CONNECTORS.md), with the Connectors section of [SPEC-CONVERSATION-TYPES.md](./conversation/SPEC-CONVERSATION-TYPES.md) and `backend/lib/config/connectors.ts`
- **Auditing** - [SPEC-ACCESS-AND-CONTROLS-AUDITING.md](./governance/SPEC-ACCESS-AND-CONTROLS-AUDITING.md)

Also relevant: [MESSAGE-FLOW.md](../../guides/developer/MESSAGE-FLOW.md) (how a turn travels the layers - channel flow, Amazon Lex, `@all`, fulfillment, async processor - and where each control acts), [ARCHITECTURE.md](../../overview/ARCHITECTURE.md) (how the shipped system works end to end), and [SPEC-CONVERSATION-SECURITY.md](./governance/SPEC-CONVERSATION-SECURITY.md) (the security layers).

---

## 1. Why an interaction layer rather than a chat tool

Most agentic products are **one assistant, one channel, one user**. That is enough for a personal copilot or for a proof of concept, and not enough for an enterprise that needs a centralized platform to enable AI capabilities across internal and external touchpoints. Such a business manages not only the relationship between a customer and a single business unit, but often one or more customers across several business units. In a complex purchase, a customer moves between sales, a scheduled service visit and a support case, while the internal employees they interact with and the AI assistants managed by different internal organizations sit *inside* tools those people already use every day. Partners and other parties enter the same workflows, and not only in the enterprise. Companies need to manage the interactions and the touchpoints together, and adoption is better when no party is asked to abandon the tools and processes they already have.

AgentEchelon's target is a **single interaction layer**: a configurable surface where internal people and external customers meet, across chat, voice, video and email, served by the right assistant, gated by the right access, and **wired into the systems the business already uses** rather than replacing them. The same platform expresses a one-to-one tiered chat, a routed support case, a masked service call, a sales engagement and an alert-triggered incident-triage room by **configuration** rather than by new code.

**Built on AWS, enforced by IAM.** AgentEchelon is composed of AWS-native services: Amazon Chime SDK Messaging for the conversation substrate, Cognito and STS for identity, S3 and Amazon Bedrock for context and inference. The decisive consequence is that **access is enforced by IAM and resource policies, secured through infrastructure rather than only through application code.** Who can act on which conversation, as which identity, at which classification, reaching which external system: every user, every conversation and every assistant is an AWS resource, so each of those is an IAM or resource-policy decision evaluated *before* a request is processed. That is why the platform can open up to a wide range of use cases - guests, federated externals, routed agents, multi-tenant connectors - without each new experience becoming a new attack surface: a misrouted request or an application bug cannot exceed what the assumed role and the channel's policy already permit. The richness of §3's experiences rides on the rigor of §4's two enforcement layers, both of which are AWS-native primitives.

## 2. Who benefits

Personas are defined in [PERSONAS.md](../../overview/PERSONAS.md) and are not redefined here. This model serves them at three different distances from the platform:

- **The end user, inside or outside the business,** gets one place for every interaction with the business - sales, a scheduled technician, a support case - with consistent quality and carried context regardless of which team or assistant they reach, and one surface for internal and external agentic workflows with an assistant that helps them in the moment of a customer conversation.
- **The admin / operator and the manager** get one deployment to run and one scope to monitor, with membership and access changes recorded rather than reconstructed.
- **The AI developer and the platform developer** get a composition model where a new experience is configuration against named pillars rather than a new code path, and where the access decision is not theirs to re-implement per surface.
- **The deploying business** integrates instead of migrating: its existing identity provider, its routing (Salesforce Omnichannel, ServiceNow and the like) and its systems of record stay authoritative, and AgentEchelon becomes the interaction layer on top, deployable to its own AWS account, MIT-licensed, with no per-user license fee.

## 3. Experiences enabled

Each is one conversation *type* composed from the pillars:

- **Engagement** - a single assigned internal user, resolved from the business's directory, owns an ongoing, context-rich relationship with a customer.
- **Support** - a customer enters via an embedded widget or a phone number; the assistant triages, then the business's router brings in a human agent **for the duration of the case**, working from the existing case in the business's case or ticketing system.
- **Service** - schedule or reschedule, then talk to the technician across chat, voice and SMS with **masked numbers**, every channel's history attached to the one conversation, so the same context carries forward into any later support case.
- **Internal IT** - an employee gets help in context, and a ticket is created and routed to IT in the existing service desk.
- **Incident triage** - an alert spins up a room, dials in the on-call engineer, shows live operational data, and escalates to the IT team or the vendor's support, all from one orchestrated conversation.

The status of each is in §8, and each conversation type's own requirements are in [SPEC-CONVERSATION-TYPES](./conversation/SPEC-CONVERSATION-TYPES.md).

## 4. The composition model: the conversation type is the root

The pillars are not peers. **The conversation type is the composition root** - it composes Identity and Access, Assistant Configuration, and Connectors - and the conversation (the Amazon Chime SDK channel) is the runtime hub everything attaches to. The fifth pillar, Auditing, is cross-cutting: it records access and membership changes across all of them, so it sits beside this model rather than inside it.

```
                Conversation Configuration  (the policy bundle = composition root)
                          │
   classification ───────────────────────► Identity & Access        WHO may act, at what capability
   (the only closed axis IAM evaluates)      • person  → SSO → credential exchange → bearer-pinned role scoped to its declared grants
                          │                  • external → connector resolves → admitted at the classification the connector declares
                          │                  • assistant → its own assigned-classification identity
   defaultAgents ────────────────────────► Assistant Configuration  WHICH assistant + how it behaves
                          │                  (model / prompt / tools / guardrail)
   connectors[] ─────────────────────────► Connectors               WHICH external systems + how
                          │                  (resolve people · sync records · fetch data · provide transports)
   commsChannels · participants ·
   capabilities · offboardMode ──────────► the conversation-level policy ([C] below)
```

**Two enforcement layers tie it together**, the two columns of the capability model:

- **[I] Identity and IAM** - *can these credentials act at all, and on which classification of channel.* The single shared axis is the channel's `classification` tag, **stamped at creation from the classification the conversation was requested at**; the conversation type is stamped beside it as a separate fact, because a type key is never a classification value (§8). Identity, through the credential exchange, enforces it, and the bearer is pinned to the caller's own identity.
- **[C] Conversation-level policy** - *does this conversation type permit the action, for this role.* Comms channels, participant rules, drift, offboard behavior: application-level, driven by the type's configuration.

A participant's effective capability in any conversation is **their classification ([I]) and the conversation type's policy ([C]), both of which must permit the action**. Every actor - a person, a federated external, the assistant, a connector - is *placed* by Identity and *bounded* by the conversation type.

**A classification is a declared set of grants, not a ladder** ([ADR-046](../../design/decisions/046-classifications-are-a-set-not-a-ladder.md)). It reaches exactly what its `grants` declare, and a classification that declares none reaches nothing rather than falling back to a floor. A conversation type carries a classification and never invents one, so adding a type adds no classification.

The assistant is the one actor that lives in **two** pillars at once: it is an **identity**, its own classification-gated role bearing an assistant identity and never a user, *and* an **assistant configuration** - its model, prompt, tools and guardrail.

## 5. The five pillars, in one line each

- **Identity and Access** - anyone (the deployment's SSO users, connector-resolved externals, guests) participates at exactly the capability they should, and **only as themselves**, bearer-pinned. One backend credential exchange vends credentials scoped to the caller's declared grants, for any identity provider. See [SPEC-CREDENTIAL-EXCHANGE.md](./governance/SPEC-CREDENTIAL-EXCHANGE.md), which also states honestly where the assistant half of the pin is narrower than the person half.
- **Assistant Configuration** - *what the assistant is* (model, system prompt, tools, guardrail) is configuration a conversation type selects, so different experiences get different assistants without new code. See [SPEC-ASSISTANT-CONFIG.md](./assistants/SPEC-ASSISTANT-CONFIG.md).
- **Conversation Configuration** - a conversation is a **configurable experience** rather than a fixed chat: a composable bundle of classification, agents, comms, participants, connectors and capabilities that *carries* a classification, with a forward-compatibility contract so the catalog grows without breaking deployed conversations. See [SPEC-CONVERSATION-TYPES.md](./conversation/SPEC-CONVERSATION-TYPES.md).
- **Connectors** - the platform **plugs into the business's existing systems** (Salesforce, ServiceNow, Jira, AWS Support, PagerDuty) instead of replacing them: resolve people, sync records, fetch data, provide transports, per vendor and per tenant credential-isolated. See [SPEC-CONNECTORS.md](../communication/SPEC-CONNECTORS.md), summarized in the Connectors section of [SPEC-CONVERSATION-TYPES.md](./conversation/SPEC-CONVERSATION-TYPES.md).
- **Auditing** - access and membership changes (`CREATE` and `DELETE_CHANNEL_MEMBERSHIP` plus moderator grants) stream through Kinesis to an append-only archive: the system of record for *who could act in a conversation, and when*. Amazon Chime SDK exposes no membership-history API, so this archive fills the gap and backs the admin console's audit views. See [SPEC-ACCESS-AND-CONTROLS-AUDITING.md](./governance/SPEC-ACCESS-AND-CONTROLS-AUDITING.md) for the retention, query and access contract.

## 6. The invariants (what must stay true as it grows)

- **Security is identity-provider-agnostic and lives at two layers** - the `AppInstanceUser` and membership, plus the assumed role - and never on a Cognito-specific signal (see [SPEC-CONVERSATION-SECURITY.md](./governance/SPEC-CONVERSATION-SECURITY.md)).
- **`classification` is the only closed axis** IAM evaluates. Conversation types proliferate freely and **carry** a classification; adding a type never adds a classification, which is a separate, deny-tested change.
- **A classification is a declared set of grants, not a ladder** ([ADR-046](../../design/decisions/046-classifications-are-a-set-not-a-ladder.md)). There is no rank to compare, and an undeclared grant set reaches nothing.
- **Every user, assistant and conversation is an AWS resource with an ARN.** A human is one `AppInstanceUser`, an assistant one `AppInstanceBot`, and a conversation one Amazon Chime SDK channel, and every record is keyed by one of them. An identity provider's issuer and subject are only a way to get a session as an `AppInstanceUser`, recorded in an index only the credential exchange writes; the `AppInstanceUser` id is opaque and minted once, never a provider's subject. One human never holds two `AppInstanceUser`s as the same person: a second provider adds a row to the index, and the admin-plane `AppInstanceUser` is the one second principal a person holds, tagged with its owner. A relation between conversations is a resource tag on a channel, never member-writable Metadata. Both credential exchanges mint the id through one minter, `mintOrResolvePerson` (`backend/lambda/src/lib/person-identity.ts`), and record it in the `Identities` table. [IDENTITY-AND-ACCESS-MODEL.md](./governance/IDENTITY-AND-ACCESS-MODEL.md) owns the model.
- **Every signal resolves to an `AppInstanceUser` first.** A message, a meeting attendee, a transcript segment, a call leg, an invitation, an inbound reply and an outbound recipient each reach a person through their `AppInstanceUser` ARN, and reach the identity provider only from that ARN. An email address or a phone number is a delivery route, never an identity: it never binds, merges or creates one.
- **Identity is bearer-pinned** - an actor can only ever act *as itself*, and the server resolves the caller once per request, never from a provider claim inside a handler. The edge authorizer resolves the caller through `Identities` (`backend/lambda/src/edge-authorizer.ts`), and handlers read it from the authorizer's context through `callerPersonId` (`backend/lambda/src/lib/auth.ts`), **NOT VERIFIED** on a deployment.
- **Forward-compatible by contract** - conversations snapshot their resolved policy at creation, resolution is lenient, behavior keys are open registries, and schema evolves additively. Growth never breaks a deployed conversation.
- **Integrate, don't migrate** - external systems stay authoritative, and connectors are per vendor and per tenant credential-isolated.

These elaborate tenets P4, P3 and P5 in [TENETS.md](../../overview/TENETS.md); the remaining tenets are design commitments these invariants sit beneath rather than restate.

## 7. Two documentation tiers

- **Design specs** - this document plus the five pillar specs: *why it is architected this way*, for contributors and evaluators.
- **Deployer guides** - *how do I add or edit one*: task-oriented, portable, and gated on shipped capability, because a how-to implies the feature works. [IDENTITY-PROVIDER-GUIDE.md](../../guides/user/IDENTITY-PROVIDER-GUIDE.md) covers the access model and [HOW-TO-ADD-OR-MANAGE-A-PROFILE.md](../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md) the assistant. No conversation-type guide and no connector guide exists, for the reason the gating states: those pillars are wired but dormant (§8), and a how-to for them would imply a capability a deployer does not yet have.

## 8. Current state: live, wired, and design-only

The wiring and the seams are in place with no one-way doors, while what is exposed to users is the set of internal use cases the application has focused on to date. Capabilities fall into three buckets, where the boundary is *capability available to users* rather than *code present*. Each pillar spec's requirements table is the authoritative statement for its own rows; this section is the map.

**Live and user-facing: the internal use cases built to date.** Tiered private chat (`basic`, `standard`, `premium`) on the self-hosted Converse agent loop with per-classification model, guardrail and context-S3 isolation; `@assistant`, `@human` and `@all` mention routing; conversation sharing and email invite; proactive briefings; `/battle` on the battle-capable classifications (`standard` and `premium` in the shipped set, and off until an operator turns it on); drift detection, conversation-level and on for the `general` and `ops-team` conversation types; the admin console; analytics with Athena as the default and Aurora opt-in, plus client-events telemetry. On the security side, the credential exchange's person half is complete and bearer-pinned and the Layer-1 classification gate is in force; the assistant half is pinned per assistant with a documented fallback, stated as such in [SPEC-CREDENTIAL-EXCHANGE](./governance/SPEC-CREDENTIAL-EXCHANGE.md).

**Wired but dormant: the "no one-way doors" seams.** The conversation-type registry (five shipped types, none named after a classification); the connector runtime (the `Connectors` stack with PagerDuty and Salesforce adapters), enabled only where a deployment declares a connector; the federated-participant substrate; the comms-transport hooks; and the conversation-as-hub plumbing. Present and additive, and largely unconsumed by the internal use cases, so a new use case is configuration plus activation rather than a migration.

**Design-only: the door is open and not wired.** The external use cases of §3 - support, service, incident triage, engagement - a consumer of connector events, and federated externals. Explicitly the destination rather than an available capability.

The experiences in §3 are the destination; the per-pillar specs and their migration sections are the path.
