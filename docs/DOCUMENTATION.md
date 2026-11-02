# AgentEchelon Documentation

The map of everything under `docs/`. For what AgentEchelon is and why, start at the root [`README.md`](../README.md) and [`overview/PLATFORM-OVERVIEW.md`](overview/PLATFORM-OVERVIEW.md) - this page does not repeat the overview, it points you to the right document for a task.

## Start here, by what you are doing

- **Evaluate / deploy it** -> [`overview/PLATFORM-OVERVIEW.md`](overview/PLATFORM-OVERVIEW.md), [`overview/ARCHITECTURE.md`](overview/ARCHITECTURE.md), then `guides/user/` (deploy, identity provider, demo-and-validation, troubleshooting).
- **Operate a deployment** -> `guides/admin/` (admin guide, integration, the guest issuer, Aurora mode, A/B and battles, image-gen, cost).
- **Extend it / build assistants** -> `guides/developer/` (developer guide, add-or-manage a profile, model strategy, message flow, assistant context, RAG) and the assistant templates.
- **Understand a decision** -> `design/decisions/` (the ADRs) and the specs below.
- **Follow a message, or check where a number came from** -> [`reference/message-path-and-analytics-map.md`](reference/message-path-and-analytics-map.md), which indexes both paths end to end. The two documents it opens with, [`guides/developer/MESSAGE-FLOW.md`](guides/developer/MESSAGE-FLOW.md) and [`guides/developer/LATENCY-TARGETS.md`](guides/developer/LATENCY-TARGETS.md), were reachable from nowhere on this page until it existed.

## The specs, by platform layer

The spec tree mirrors the platform's layers (see [`./specs/interaction/SPEC-INTERACTION-LAYER.md`](./specs/interaction/SPEC-INTERACTION-LAYER.md), the composition model). Each spec declares its `Layer` / `Pillar` / `Plane` and a `Status`. Personas are defined once in [`overview/PERSONAS.md`](overview/PERSONAS.md); the surface-to-spec index is [`overview/SITE-MAP.md`](overview/SITE-MAP.md).

- **`specs/interface/`** - the surfaces a participant meets: the chat app (end-user client), the admin console (operator client; admin plane), and the embeddable widget ([`SPEC-EMBEDDABLE-WIDGET.md`](specs/interface/SPEC-EMBEDDABLE-WIDGET.md), design).
- **Communication layer** - the connectivity that wires each client to the engine (WebSocket + REST live; WebRTC, voice/PSTN, and email seamed). This is transport, described in [`overview/ARCHITECTURE.md`](overview/ARCHITECTURE.md) and [`overview/PLATFORM-OVERVIEW.md`](overview/PLATFORM-OVERVIEW.md). `specs/communication/` holds the connectors, the notification bridge, the message metadata codebook and telephony ([`SPEC-TELEPHONY.md`](specs/communication/SPEC-TELEPHONY.md), design).
- **`specs/interaction/`** - the engine: who may act, as whom, at what capability (enforced in IAM). The five config pillars: `identity-access/` (`core/` and `admin/`), `assistant-config/`, `conversation-config/`, `connectors/`, `auditing/`; plus `conversation/`, the Amazon Chime SDK conversation substrate the engine composes over (durable conversation and membership, message metadata, the notification bridge, cross-channel tasks).
- **`specs/foundations/`** - core-platform operations and foundations (Aurora mode, cost-sleep). Cross-cutting, not a pillar.
- **`specs/capabilities/`** - core-platform features a conversation or assistant invokes (battle, drift, multi-agent orchestration). A capability's mechanism lives here; the config that drives it is assistant-config (pillar 2) or conversation-config (pillar 3).
- **`specs/applications/`** - built on the platform: specific assistants and use cases (the meetings assistant, the demo company). This is what a deployer writes; the platform specs are the machinery.

## Conventions

- **Product `SPEC-*` vs technical `DESIGN-*`.** Flagship features split into a product spec (problem, personas, use cases, requirements) and a technical design (architecture, data, APIs, tests). Most specs are a single file with a short "Problem and who it's for" header.
- **Status** on every spec: Implemented / Partial / Design.
- **Layer / Pillar / Plane** on every spec, tying it back to the composition model.
- Terminology: the customer-facing chat interface uses **tier**; platform, admin, and internal docs use **classification** for the same capability level.
