# Site map: product surfaces to the specs behind them

Every surface a participant actually touches, mapped to the spec that defines it and the platform layer underneath. The layer tree it mirrors is in [`../DOCUMENTATION.md`](../DOCUMENTATION.md); the composition model is [`../specs/interaction/SPEC-INTERACTION-LAYER.md`](../specs/interaction/SPEC-INTERACTION-LAYER.md). Personas are defined once in [`PERSONAS.md`](PERSONAS.md).

## How to read this

The **interface** is thin. A client renders, holds a bearer-pinned identity, and *calls* the substrate; it does not run messaging. So a chat surface below names the **layer that backs it**, not work the client does. Two facts drive the whole map:

- **Messaging goes straight to Amazon Chime SDK Messaging, not through the client.** The chat client sends with `SendChannelMessage` and receives over a WebSocket (the communication-layer transport) directly against Amazon Chime SDK Messaging - the conversation substrate the interaction-layer engine composes over - on bearer-pinned STS creds. A message is then *processed* server-side (channel-flow hook, then the assistant pipeline). The client never brokers, stores, or fans out messages.
- **Everything else is a REST call to an interaction-layer action.** Create / share / archive a conversation, add an assistant, moderate, read analytics: each is a Lambda behind API Gateway, gated in IAM per actor. The client only invokes them.

## Interface layer - the two thin clients

### Chat interface - end-user SPA - `interface/chat`  [core plane]

The client itself: [`interface/chat/SPEC-CHAT-APP`](../specs/interface/chat/SPEC-CHAT-APP.md) (product) + `DESIGN-CHAT-APP` (technical). It has **no admin powers**: it cannot moderate or read others' conversations.

| Surface the user meets | What the user does | Backed by (layer · spec) |
|---|---|---|
| Sign in / register / reset password | authenticate; recover access | interface · `SPEC-CHAT-APP`; identity via Cognito (`IDENTITY-PROVIDER-GUIDE`) |
| Conversation list | see, open, create, share, archive, leave a conversation | interaction · `conversation-config/SPEC-CONVERSATION-TYPES`; durability in communication · `SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP` |
| Chat view (read / send) | read the thread, send a message, see live replies | communication · direct to Amazon Chime SDK Messaging (the substrate, not the client); rendered by `SPEC-CHAT-APP` |
| Compose / edit own message | write a turn; edit or delete one's *own* message | interface · `SPEC-CHAT-APP` (redaction of *others'* messages is admin, below) |
| Welcome & once-per-user onboarding | first-run greeting, greet-by-name, optional intake | interaction · `assistant-config/SPEC-WELCOME-AND-CONTEXT` + `SPEC-USER-PROFILE-AND-ONBOARDING` |
| Model selection | pick a model within the classification cap | interaction · `assistant-config/SPEC-ASSISTANT-CONFIG` |
| Mentions & multi-participant | @-mention assistants / people in a shared room | interaction · `SPEC-INTERACTION-LAYER` |
| Attachments | upload / view files | interface · `SPEC-CHAT-APP`; metadata in communication · `SPEC-MESSAGE-METADATA-CODEBOOK` |
| Battle / A-B (in-chat) | compare two models or personas on one prompt | capability · `capabilities/SPEC-BATTLE` (+ `DESIGN-BATTLE`) |
| Bilingual replies | reply-language, inference pivot, dual delivery | interaction · `assistant-config/SPEC-BILINGUAL-CONVERSATIONS` |

### Admin interface - operator SPA, 7 sections - `interface/admin`  [admin plane]

The client itself: [`interface/admin/SPEC-ADMIN-CONSOLE`](../specs/interface/admin/SPEC-ADMIN-CONSOLE.md) (product) + `DESIGN-ADMIN-CONSOLE` (per-section technical) + `DESIGN-SEPARATE-ADMIN-APP` (the standalone-app split). It reaches the substrate with **short-lived, IAM-gated admin credentials** (SigV4 / credential exchange); each privileged action is an enforceable capability, not just group membership (`identity-access/admin/DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT`).

| Section | What the operator does | Backed by (spec) |
|---|---|---|
| Overview | at-a-glance health, volumes, latency | `SPEC-ADMIN-CONSOLE` + `interaction/auditing/*`, `ops/SPEC-FRONTEND-OBSERVABILITY` |
| Conversations | read any conversation; moderate (redact) or administer (delete) | `SPEC-ADMIN-CONSOLE`, `identity-access/core/SPEC-MODERATION` |
| Effectiveness | relevance / flow evaluations, intents | `interface/admin/SPEC-ADMIN-CONSOLE` |
| Models | attribution, cost, latency, effectiveness by model | `interface/admin/SPEC-ADMIN-CONSOLE`, `assistant-config/SPEC-ASSISTANT-CONFIG`, `ops/SPEC-FRONTEND-OBSERVABILITY` |
| Experiments | A-B results, battle outcomes | `capabilities/SPEC-BATTLE`, `interface/admin/SPEC-ADMIN-CONSOLE` |
| Users | user management, provisioning, escalation | `identity-access/core/SPEC-ADD-USER-ESCALATION` |
| Security | membership audit, access audit, who-could-act | `identity-access/core/SPEC-CONVERSATION-SECURITY`, `interaction/auditing/SPEC-ACCESS-AND-CONTROLS-AUDITING` |

## Communication layer - the connectivity that wires each client to the engine - `communication`

Transport, not messaging logic: how each client reaches the engine. A client holds a bearer-pinned identity and connects over one of these; adding a channel never changes the engine. This layer is transport and has no dedicated spec directory; the conversation *substrate* it was once conflated with now lives in the interaction layer, below.

| Channel | Status | How it reaches the engine |
|---|---|---|
| WebSocket + REST (messaging) | Built | The chat client receives over a WebSocket directly against Amazon Chime SDK Messaging and sends with `SendChannelMessage`; every other action is a REST call to an interaction-layer Lambda, gated in IAM per actor. |
| WebRTC (real-time audio/video) | Roadmap | Seamed; the connectivity pattern is proven on the predecessor site's communication widget. |
| Email (outbound) | Partial | Outbound hand-off built; inbound next. |
| Voice / phone (PSTN) | Roadmap | Pluggable SIP trunk (the deployer's provider); see `applications/DESIGN-ASSISTANT-MEETINGS` (Voice). |

## Interaction layer - who may act, as whom, at what capability - `interaction` (5 pillars)

Composition root: `interaction/conversation-config/SPEC-CONVERSATION-TYPES`. Cross-pillar overview: `interaction/SPEC-INTERACTION-LAYER`.

| Pillar | Plane | Specs |
|---|---|---|
| Identity & Access | core | `identity-access/core/`: `IDENTITY-AND-ACCESS-MODEL`, `ACCESS-CONTROL-BY-EXAMPLE`, `SPEC-CREDENTIAL-EXCHANGE`, `SPEC-CONVERSATION-SECURITY`, `SPEC-MODERATION`, `SPEC-ADD-USER-ESCALATION`, `SPEC-FEDERATED-PARTICIPANTS` |
| Identity & Access | admin | `identity-access/admin/`: `SPEC-ADMIN-IDENTITY`, `DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT`, `DESIGN-ADMIN-AGENT-NOTIFICATIONS` |
| Assistant Configuration | core | `assistant-config/`: `SPEC-ASSISTANT-CONFIG`, `SPEC-WELCOME-AND-CONTEXT`, `SPEC-USER-PROFILE-AND-ONBOARDING`, `SPEC-CONTEXT-AWARE-MODEL-ROUTING`, `SPEC-CONFIGURABLE-INTENT-PACK`, `SPEC-BILINGUAL-CONVERSATIONS`, `SPEC-PER-PROFILE-OWNERSHIP`, `SPEC-PORTABLE-PROFILES` (assistants as portable, versioned artifacts); the delegation/fan-out CONFIG seam (mechanism is `capabilities/DESIGN-MULTI-AGENT-ORCHESTRATION`) |
| Conversation Configuration | core | `conversation-config/SPEC-CONVERSATION-TYPES` (the composition root) |
| Connectors | core | `connectors/SPEC-CONNECTORS` (the connector contract - integrate, don't migrate; governed MCP seam), declared per experience in `SPEC-CONVERSATION-TYPES` section 6 |
| Auditing (the access record) | core + admin | `auditing/`: `SPEC-ACCESS-AND-CONTROLS-AUDITING` |

**Conversation substrate** (`interaction/conversation/`) - the Amazon Chime SDK Messaging fabric the engine composes over, distinct from the five config pillars: durable conversation & membership - the memory is the channel (`SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP`), the per-message metadata pipeline (`SPEC-MESSAGE-METADATA-CODEBOOK`), the notification bridge for email / SMS / voice out (`SPEC-NOTIFICATION-BRIDGE`), and cross-channel task carry (`CROSS-CHANNEL-TASKS`).

## Core platform - ops (cross-cutting; not a pillar) - `ops`

Infrastructure, control, and telemetry that cut across the layers.

| Concern | Spec |
|---|---|
| Per-page performance / usage telemetry (both apps) | `ops/SPEC-FRONTEND-OBSERVABILITY` |
| Aurora + VPC analytics engine (opt-in) | `ops/SPEC-AURORA-VPC-MODE` |
| Idle auto-pause of the data plane | `ops/SPEC-COST-SLEEP-MODE` |
| Spend budgets, rate limits, dedup, length caps | `ops/SPEC-ABUSE-CONTROLS` |

## Core platform - capabilities (platform features; not a pillar) - `capabilities`

Features a conversation or assistant invokes. The MECHANISM lives here; the CONFIG that drives it is pillar 2 (assistant-config) or pillar 3 (conversation-config).

| Capability | Spec | Mechanism vs config |
|---|---|---|
| Battle / A-B | `capabilities/SPEC-BATTLE`, `DESIGN-BATTLE` | fan-out-to-two mechanism here; the variant an experiment arms is assistant-config |
| Multi-agent orchestration | `capabilities/DESIGN-MULTI-AGENT-ORCHESTRATION` | orchestrator + sub-agent fan-out mechanism here; the delegation config is assistant-config |
| Topic-drift detection | `capabilities/SPEC-DRIFT-CONVERGENCE` | embedding-based drift signal here; thresholds / live-drift enablement are conversation-config |

## Applications - built on the platform - `applications`

What a deployer writes on top of the machinery above.

| Application | Spec |
|---|---|
| Meetings assistant | `applications/SPEC-ASSISTANT-MEETINGS`, `DESIGN-ASSISTANT-MEETINGS` |
| Demo company (sample deployment) | `applications/SPEC-DEMO-COMPANY` |
| Further use cases (support, incident-triage, internal-IT) | `applications/*` (as added) |
