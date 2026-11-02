# Site map: product surfaces to the specs behind them

Every surface a participant actually touches, mapped to the spec that defines it and the platform layer underneath. The layer tree it mirrors is in [`../DOCUMENTATION.md`](../DOCUMENTATION.md); the composition model is [`../specs/interaction/SPEC-INTERACTION-LAYER.md`](../specs/interaction/SPEC-INTERACTION-LAYER.md). Personas are defined once in [`PERSONAS.md`](PERSONAS.md).

## How to read this

The **interface** is thin. A client renders, holds a bearer-pinned identity, and *calls* the substrate; it does not run messaging. So a chat surface below names the **layer that backs it**, not work the client does. Two facts drive the whole map:

- **Messaging goes straight to Amazon Chime SDK Messaging, not through the client.** The chat client sends with `SendChannelMessage` and receives over a WebSocket (the communication-layer transport) directly against Amazon Chime SDK Messaging - the conversation substrate the interaction-layer engine composes over - on bearer-pinned STS creds. A message is then *processed* server-side (channel-flow hook, then the assistant pipeline). The client never brokers, stores, or fans out messages.
- **Everything else is a REST call to an interaction-layer action.** Create / share / archive a conversation, add an assistant, moderate, read analytics: each is a Lambda behind API Gateway, gated in IAM per actor. The client only invokes them.

## Interface layer - the thin clients

### Chat interface - end-user SPA - `interface/chat`  [core plane]

The client itself: [`interface/SPEC-CHAT-APP`](../specs/interface/SPEC-CHAT-APP.md) (product) + `interface/DESIGN-CHAT-APP` (technical). It has **no admin powers**: it cannot moderate or read others' conversations.

| Surface the user meets | What the user does | Backed by (layer · spec) |
|---|---|---|
| Sign in / register / reset password | authenticate; recover access | interface · `interface/SPEC-CHAT-APP`; identity via Cognito (`IDENTITY-PROVIDER-GUIDE`) |
| Conversation list | see, open, create, share, archive, leave a conversation | interaction · `interaction/conversation/SPEC-CONVERSATION-TYPES`; durability in communication · `interaction/conversation/SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP` |
| Chat view (read / send) | read the thread, send a message, see live replies | communication · direct to Amazon Chime SDK Messaging (the substrate, not the client); rendered by `interface/SPEC-CHAT-APP` |
| Compose / edit own message | write a turn; edit or delete one's *own* message | interface · `interface/SPEC-CHAT-APP` (redaction of *others'* messages is admin, below) |
| Welcome & once-per-user onboarding | first-run greeting, greet-by-name, optional intake | interaction · `interaction/assistants/SPEC-WELCOME-AND-CONTEXT` + `interaction/conversation/SPEC-USER-PROFILE-AND-ONBOARDING` |
| Model selection | pick a model within the classification cap | interaction · `interaction/assistants/SPEC-ASSISTANT-CONFIG` |
| Mentions & multi-participant | @-mention assistants / people in a shared room | interaction · `interaction/SPEC-INTERACTION-LAYER` |
| Attachments | upload / view files | interface · `interface/SPEC-CHAT-APP`; metadata in communication · `communication/SPEC-MESSAGE-METADATA-CODEBOOK` |
| Battle / A-B (in-chat) | compare two models or personas on one prompt | capability · `interaction/quality/SPEC-BATTLE` (+ `interaction/quality/DESIGN-BATTLE`) |
| Bilingual replies | reply-language, inference pivot, dual delivery | interaction · `interaction/assistants/SPEC-BILINGUAL-CONVERSATIONS` |

### Admin interface - operator SPA, 7 sections - `interface/admin`  [admin plane]

The client itself: [`interface/SPEC-ADMIN-CONSOLE`](../specs/interface/SPEC-ADMIN-CONSOLE.md) (product) + `interface/DESIGN-ADMIN-CONSOLE` (per-section technical) + `interface/DESIGN-SEPARATE-ADMIN-APP` (the standalone-app split). It reaches the substrate with **short-lived, IAM-gated admin credentials** (SigV4 / credential exchange); each privileged action is an enforceable capability, not just group membership (`interaction/governance/DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT`).

| Section | What the operator does | Backed by (spec) |
|---|---|---|
| Operations | at-a-glance health now: overview, alerts, browser-side client measurement | `interface/SPEC-ADMIN-CONSOLE`, `interaction/governance/SPEC-ACCESS-AND-CONTROLS-AUDITING`, `interface/SPEC-FRONTEND-OBSERVABILITY` |
| Performance | how fast and how good over a range: effectiveness and latency drills, answer types, queue, evaluations, flagged, ground truth | `interface/SPEC-ADMIN-CONSOLE`, `interface/SPEC-ADMIN-CONSOLE-EFFECTIVENESS`; the scores come from `interaction/quality/SPEC-EVALUATION` (+ `interaction/quality/DESIGN-EVALUATION`) |
| Oversight | read any conversation and moderate (redact) or administer (delete); membership audit; access log | `interface/SPEC-ADMIN-CONSOLE`, `interaction/governance/SPEC-MODERATION`, `interaction/governance/SPEC-CONVERSATION-SECURITY`, `interaction/governance/SPEC-ACCESS-AND-CONTROLS-AUDITING` |
| Models | attribution, cost, latency, effectiveness by model; model strategy | `interface/SPEC-ADMIN-CONSOLE`, `interaction/assistants/SPEC-ASSISTANT-CONFIG`, `interface/SPEC-FRONTEND-OBSERVABILITY` |
| Assistants | versioned, portable assistant profiles | `interaction/assistants/SPEC-PORTABLE-PROFILES`, `interface/SPEC-ADMIN-CONSOLE` |
| Experiments | A-B results, battle outcomes, the classifier gate | `interaction/quality/SPEC-BATTLE`, `interface/SPEC-ADMIN-CONSOLE` |
| Users | user management, provisioning, escalation | `interaction/governance/SPEC-ADD-USER-ESCALATION` |

### Embeddable widget - `interface/widget`

| Surface the user meets | What the user does | Backed by (layer · spec) |
|---|---|---|
| Assistant on a host page | talk to one assistant as a guest or with the host's sign-in | interface · `interface/SPEC-EMBEDDABLE-WIDGET` (built; deployed when the `widget` capability is declared) |

## Communication layer - the connectivity that wires each client to the engine - `communication`

Transport, not messaging logic: how each client reaches the engine. A client holds a bearer-pinned identity and connects over one of these; adding a channel never changes the engine. Its specs are in `communication/`: connectors, the notification bridge, the message metadata codebook and telephony.

| Channel | Status | How it reaches the engine |
|---|---|---|
| WebSocket + REST (messaging) | Built | The chat client receives over a WebSocket directly against Amazon Chime SDK Messaging and sends with `SendChannelMessage`; every other action is a REST call to an interaction-layer Lambda, gated in IAM per actor. |
| WebRTC (real-time audio/video) | Roadmap | Seamed; the connectivity pattern is proven on the predecessor site's communication widget. |
| Email (outbound) | Partial | Outbound hand-off built; inbound next. |
| Voice / phone (PSTN) and SMS | Design | Draft design (**NOT BUILT**). A call or a text is part of a conversation through a telephony connector (Twilio first), with no Amazon Chime SDK in the path, and a phone number is never an identity, worked through a delivery; see `communication/SPEC-TELEPHONY` and `communication/DESIGN-TELEPHONY`. Joining an Amazon Chime SDK WebRTC meeting by phone is a separate draft. |

## Interaction layer - who may act, as whom, at what capability - `interaction` (5 pillars)

Composition root: `interaction/conversation/SPEC-CONVERSATION-TYPES`. Cross-pillar overview: `interaction/SPEC-INTERACTION-LAYER`.

| Pillar | Plane | Specs |
|---|---|---|
| Identity & Access | core | `interaction/governance/IDENTITY-AND-ACCESS-MODEL`, `interaction/governance/ACCESS-CONTROL-BY-EXAMPLE`, `interaction/governance/SPEC-CREDENTIAL-EXCHANGE`, `interaction/governance/SPEC-CONVERSATION-SECURITY`, `interaction/governance/SPEC-MODERATION`, `interaction/governance/SPEC-ADD-USER-ESCALATION`, `interaction/governance/SPEC-FEDERATED-PARTICIPANTS` |
| Identity & Access | admin | `interaction/governance/SPEC-ADMIN-IDENTITY`, `interaction/governance/DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT`, `interaction/governance/DESIGN-ADMIN-AGENT-NOTIFICATIONS` |
| Assistant Configuration | core | `interaction/assistants/SPEC-ASSISTANT-CONFIG`, `interaction/assistants/SPEC-WELCOME-AND-CONTEXT`, `interaction/conversation/SPEC-USER-PROFILE-AND-ONBOARDING`, `interaction/assistants/SPEC-CONTEXT-AWARE-MODEL-ROUTING`, `interaction/assistants/SPEC-CONFIGURABLE-INTENT-PACK`, `interaction/assistants/SPEC-BILINGUAL-CONVERSATIONS`, `interaction/assistants/SPEC-PER-PROFILE-OWNERSHIP`, `interaction/assistants/SPEC-PORTABLE-PROFILES` (assistants as portable, versioned artifacts); the delegation/fan-out CONFIG seam (mechanism is `interaction/assistants/DESIGN-MULTI-AGENT-ORCHESTRATION`) |
| Conversation Configuration | core | `interaction/conversation/SPEC-CONVERSATION-TYPES` (the composition root) |
| Connectors | core | `communication/SPEC-CONNECTORS` (the connector contract - integrate, don't migrate; governed MCP seam), declared per experience in `interaction/conversation/SPEC-CONVERSATION-TYPES`, under "The experiences the model is built for" |
| Auditing (the access record) | core + admin | `interaction/governance/SPEC-ACCESS-AND-CONTROLS-AUDITING` |

**Conversation substrate** (`interaction/conversation/`) - the Amazon Chime SDK Messaging fabric the engine composes over, distinct from the five config pillars: durable conversation & membership - the memory is the channel (`interaction/conversation/SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP`), the per-message metadata pipeline (`communication/SPEC-MESSAGE-METADATA-CODEBOOK`), the notification bridge for email / SMS / voice out (`communication/SPEC-NOTIFICATION-BRIDGE`), and cross-channel task carry (`interaction/conversation/CROSS-CHANNEL-TASKS`).

## Core platform - ops (cross-cutting; not a pillar) - `ops`

Infrastructure, control, and telemetry that cut across the layers.

| Concern | Spec |
|---|---|
| Per-page performance / usage telemetry (both apps) | `interface/SPEC-FRONTEND-OBSERVABILITY` |
| Aurora + VPC analytics engine (opt-in) | `foundations/SPEC-AURORA-VPC-MODE` |
| Idle auto-pause of the data plane | `foundations/SPEC-COST-SLEEP-MODE` |
| Spend budgets, rate limits, dedup, length caps | `interaction/governance/SPEC-ABUSE-CONTROLS` |

## Core platform - capabilities (platform features; not a pillar) - `capabilities`

Features a conversation or assistant invokes. The MECHANISM lives here; the CONFIG that drives it is pillar 2 (assistant-config) or pillar 3 (conversation-config).

| Capability | Spec | Mechanism vs config |
|---|---|---|
| Battle / A-B | `interaction/quality/SPEC-BATTLE`, `interaction/quality/DESIGN-BATTLE` | fan-out-to-two mechanism here; the variant an experiment arms is assistant-config |
| Multi-agent orchestration | `interaction/assistants/DESIGN-MULTI-AGENT-ORCHESTRATION` | orchestrator + sub-agent fan-out mechanism here; the delegation config is assistant-config |
| Topic-drift detection | `interaction/assistants/SPEC-DRIFT-CONVERGENCE` | embedding-based drift signal here; thresholds / live-drift enablement are conversation-config |
| Evaluation | `interaction/quality/SPEC-EVALUATION`, `interaction/quality/DESIGN-EVALUATION` | the passes, rubrics and coverage accounting here; the rule set and rubric they judge against are config. Hosted by `foundations/SPEC-AURORA-VPC-MODE` |

## Applications - built on the platform - `applications`

What a deployer writes on top of the machinery above.

| Application | Spec |
|---|---|
| Meetings assistant | `interaction/assistants/SPEC-ASSISTANT-MEETINGS`, `interaction/assistants/DESIGN-ASSISTANT-MEETINGS` |
| Demo company (sample deployment) | `demos/SPEC-DEMO-COMPANY` |
| Further use cases (support, incident-triage, internal-IT) | `applications/*` (as added) |
