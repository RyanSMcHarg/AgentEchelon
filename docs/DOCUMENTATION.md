# AgentEchelon Documentation

The map of everything under `docs/`. For what AgentEchelon is and why, start at the root [`README.md`](../README.md) and [`overview/PLATFORM-OVERVIEW.md`](overview/PLATFORM-OVERVIEW.md) - this page does not repeat the overview, it points you to the right document for a task.

## Start here, by what you are doing

- **Evaluate / deploy it** -> [`overview/PLATFORM-OVERVIEW.md`](overview/PLATFORM-OVERVIEW.md), [`overview/ARCHITECTURE.md`](overview/ARCHITECTURE.md), [`overview/STACKS.md`](overview/STACKS.md), then `guides/user/` (frontend deploy, identity provider, demo-and-validation, troubleshooting).
- **Answer for the data a deployment holds** -> [`overview/DATA-INVENTORY.md`](overview/DATA-INVENTORY.md): where user input lands, its retention, access, export and erasure, and the AWS compliance scope and Regions of each service.
- **Operate a deployment** -> `guides/admin/` (admin guide, integration, the guest issuer, Aurora mode, A/B and battles, image-gen, cost, tagging).
- **Extend it / build assistants** -> `guides/developer/` (developer guide, add-or-manage a profile, model strategy, message flow, assistant context, RAG).
- **Understand a decision** -> `design/decisions/` (the ADRs), the [tenets](overview/TENETS.md), and the specs below.
- **Follow a message, or check where a number came from** -> [`reference/message-path-and-analytics-map.md`](reference/message-path-and-analytics-map.md), which indexes both paths end to end, starting from [`guides/developer/MESSAGE-FLOW.md`](guides/developer/MESSAGE-FLOW.md) and [`guides/developer/LATENCY-TARGETS.md`](guides/developer/LATENCY-TARGETS.md).
- **Look up a route, a context key or a spec's e2e coverage** -> `reference/`: [`api-contract.md`](reference/api-contract.md), [`context-catalog-reference.md`](reference/context-catalog-reference.md) and [`e2e-coverage-matrix.md`](reference/e2e-coverage-matrix.md), each generated from the code or the specs.

## The specs, by platform layer

The spec tree mirrors the platform's layers (see [`./specs/interaction/SPEC-INTERACTION-LAYER.md`](./specs/interaction/SPEC-INTERACTION-LAYER.md), the composition model). Each spec's header declares its `Status`, its e2e `Coverage` and its `Site section`. Personas are defined once in [`overview/PERSONAS.md`](overview/PERSONAS.md); the surface-to-spec index is [`overview/SITE-MAP.md`](overview/SITE-MAP.md).

- **`specs/interface/`** - the surfaces a participant meets: the chat app (end-user client), the admin console (operator client; admin plane), frontend observability, and the embeddable widget ([`SPEC-EMBEDDABLE-WIDGET.md`](specs/interface/SPEC-EMBEDDABLE-WIDGET.md)).
- **`specs/communication/`** - the connectivity that wires each client and system to the engine: connectors, the notification bridge, the message metadata codebook, and telephony ([`SPEC-TELEPHONY.md`](specs/communication/SPEC-TELEPHONY.md), **NOT BUILT**). The WebSocket and REST transports are described in [`overview/ARCHITECTURE.md`](overview/ARCHITECTURE.md).
- **`specs/interaction/`** - the engine: who may act, as whom, at what capability (enforced in IAM).
  - `assistants/` - assistant configuration, capability profiles, intent packs, model routing, context sources, drift, multi-agent orchestration, meetings.
  - `conversation/` - the Amazon Chime SDK conversation substrate the engine composes over: conversation types, archive and membership, the turn queue, workflows and tasks (SPEC-WORKFLOWS-AND-TASKS, the one place their status is recorded) and their state transitions, processes that link workflows across teams and classifications (SPEC-PROCESSES), document templates, user profile and onboarding.
  - `governance/` - identity and access, the credential exchange, admin identity, moderation, abuse controls, conversation security, access auditing.
  - `quality/` - evaluation, A/B experiments and battles.
- **`specs/foundations/`** - deployment and operations: Aurora mode, cost-sleep, release evidence. Cross-cutting, not a pillar.
- **`specs/demos/`** - a use case built on the platform (the demo company): what a deployer writes; the platform specs are the machinery.

## Conventions

- **Product `SPEC-*` vs technical `DESIGN-*`.** Flagship features split into a product spec (problem, personas, use cases, requirements) and a technical design (architecture, data, APIs, tests). Most specs are a single file with a short "Problem and who it's for" header.
- **Status** on every spec. `Implemented` cites the code and names the test that verifies it (`backend/test/docs-drift-guard.test.ts` checks this); a requirement that is not built carries a single **NOT BUILT** marker where it lives.
- **Coverage** on every spec leads with the e2e spec file that exercises it, or `none - <reason>`, and feeds the generated coverage matrix.
- Terminology: the customer-facing chat interface uses **tier**; platform, admin, and internal docs use **classification** for the same capability level.
