# End-to-end coverage matrix

Do not edit by hand. Generated from the `**Coverage:**` line of every document under
`docs/specs/` and the spec files under `tests/e2e/`. Regenerate with:

```
cd backend && npm run gen-coverage-matrix
```

`e2e-coverage-matrix.test.ts` fails the build when this file stops matching, when a document
carries no coverage declaration, or when a declaration names a spec file that does not exist.

**What a "covered" row means, exactly:** a named e2e spec file exists. It does not mean the
test is a good one, and it does not mean the test RAN - much of the suite is gated on
provisioned credentials and skips silently without them. Read this as the floor.

## Summary

| | |
|---|---|
| Spec documents | 49 |
| ...naming at least one e2e spec | 39 |
| ...declaring none, with a reason | 10 |
| Documents claiming live behaviour (Implemented / Partial) | 39 |
| ...of those, with no e2e spec | 0 |
| e2e spec files | 46 |
| e2e tests declared | 165 |

## Specifications

| Specification | Status | e2e coverage | Tests |
|---|---|---|---|
| [DESIGN-ASSISTANT: Meetings assistant](../specs/applications/DESIGN-ASSISTANT-MEETINGS.md) | Draft / planning - the design is not finalized… | none - a draft design; nothing is built, so there is no deployed behaviour to drive. | - |
| [SPEC-ASSISTANT: Meetings assistant](../specs/applications/SPEC-ASSISTANT-MEETINGS.md) | Draft / planning - the design is not finalized… | none - a draft design; nothing is built, so there is no deployed behaviour to drive. | - |
| [Demo Company Spec: Stratum Technologies](../specs/applications/SPEC-DEMO-COMPANY.md) | Implemented (the demo dataset and seed script s… | `e2e/classification-context.spec.ts`<br>`e2e/welcome.spec.ts` | 11 |
| [DESIGN: Battle Mode (`/battle`) - Technical Design](../specs/capabilities/DESIGN-BATTLE.md) | Implemented. Gated by the profile's `battleElig… | `e2e/battle.spec.ts` | 18 |
| [DESIGN: Experiments and Battle - Objective, Briefing, Lifecycle…](../specs/capabilities/DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md) | Implemented. The §4.3 drill-down's real-data re… | `e2e/experiments.spec.ts`<br>`e2e/battle.spec.ts` | 31 |
| [DESIGN: Multi-Agent Orchestration](../specs/capabilities/DESIGN-MULTI-AGENT-ORCHESTRATION.md) | Design (alignment doc). This proposes a recomme… | none - an alignment document proposing a structure; no code implements it yet. | - |
| [DESIGN: Multi-Assistant Turn Engine](../specs/capabilities/DESIGN-MULTI-ASSISTANT-TURN-ENGINE.md) | Draft (design-target). | none - a design target for generalizing `/battle`; the engine it describes is not built. The bat… | - |
| [SPEC: Battle Mode (`/battle`) - Product Specification](../specs/capabilities/SPEC-BATTLE.md) | Implemented. Gated by the profile's `battleElig… | `e2e/battle.spec.ts` | 18 |
| [SPEC: Drift Detection (Drift Convergence)](../specs/capabilities/SPEC-DRIFT-CONVERGENCE.md) | Partial. | `e2e/drift-detection.spec.ts` | 9 |
| [The AgentEchelon Interaction Layer - platform composition model](../specs/interaction/SPEC-INTERACTION-LAYER.md) | Design overview. | none - a design overview that owns no behaviour of its own; each pillar spec it maps declares it… | - |
| [Assistant Configuration - what the assistant *is*, per experien…](../specs/interaction/assistant-config/SPEC-ASSISTANT-CONFIG.md) | Implemented. The per-classification config seam… | `e2e/profile-config.spec.ts`<br>`e2e/admin-profiles.spec.ts` | 2 |
| [SPEC: Bilingual conversations (reply-language, pivot, dual deli…](../specs/interaction/assistant-config/SPEC-BILINGUAL-CONVERSATIONS.md) | Partial (reply-language ships; the inference pi… | `e2e/bilingual-conversations.spec.ts` | 1 |
| [SPEC: Capability profiles and deployment-defined classifications](../specs/interaction/assistant-config/SPEC-CAPABILITY-PROFILES.md) | Implemented. Classifications and assistant prof… | `e2e/classification-context.spec.ts`<br>`e2e/profile-config.spec.ts`<br>`e2e/agent-intents.spec.ts` | 21 |
| [SPEC: Configurable assistants - three per-assistant config axes…](../specs/interaction/assistant-config/SPEC-CONFIGURABLE-ASSISTANTS.md) | Implemented | `e2e/profile-config.spec.ts` | 1 |
| [SPEC: Configurable intent pack (per-deployment intent taxonomy)](../specs/interaction/assistant-config/SPEC-CONFIGURABLE-INTENT-PACK.md) | Implemented (the taxonomy mechanism; the domain… | `e2e/agent-intents.spec.ts` | 12 |
| [SPEC: Context-aware model routing (RoutingContext + provider ad…](../specs/interaction/assistant-config/SPEC-CONTEXT-AWARE-MODEL-ROUTING.md) | Partial, and gated off - the routing feature sh… | `e2e/agent-intents.spec.ts` | 12 |
| [SPEC: Per-profile ownership (`AgentEchelonClassification-*`)](../specs/interaction/assistant-config/SPEC-PER-PROFILE-OWNERSHIP.md) | Implemented. | `e2e/profile-ownership.spec.ts`<br>`e2e/profile-config.spec.ts`<br>`e2e/profile-config.spec.ts` | 4 |
| [SPEC: Portable, versioned assistant profiles](../specs/interaction/assistant-config/SPEC-PORTABLE-PROFILES.md) | Implemented and deployed. The versioning lifecy… | `e2e/admin-profiles.spec.ts`<br>`e2e/profile-config.spec.ts`<br>`e2e/portable-profile-gates.spec.ts`<br>`e2e/portable-profile-lifecycle.spec.ts` | 10 |
| [SPEC: User profile store and once-per-user onboarding](../specs/interaction/assistant-config/SPEC-USER-PROFILE-AND-ONBOARDING.md) | Partial (the store, the swap seam and the once-… | `e2e/onboarding-intake.spec.ts` | 2 |
| [SPEC: Welcome flow and assistant context](../specs/interaction/assistant-config/SPEC-WELCOME-AND-CONTEXT.md) | Partial (the welcome wiring ships; later contex… | `e2e/welcome.spec.ts`<br>`e2e/context-sources.spec.ts` | 6 |
| [Access & Controls Auditing - an append-only record of who could…](../specs/interaction/auditing/SPEC-ACCESS-AND-CONTROLS-AUDITING.md) | Implemented (audit capture and the membership-h… | `e2e/access-auditing.spec.ts` | 2 |
| [SPEC: Connectors - integrate with the business's systems, don't…](../specs/interaction/connectors/SPEC-CONNECTORS.md) | Design (the schema seam ships; the runtime path… | none - the schema seam ships but the runtime path is not built, so there is no connector call to… | - |
| [Conversation Configuration - a conversation is a configurable e…](../specs/interaction/conversation-config/SPEC-CONVERSATION-TYPES.md) | Partial (the `classification` type seam and the… | `e2e/classification-context.spec.ts` | 8 |
| [Cross-Channel Task Continuity](../specs/interaction/conversation/CROSS-CHANNEL-TASKS.md) | Implemented. | `e2e/cross-channel-tasks.spec.ts` | 1 |
| [SPEC: Context sources and stores, and what restricts each one](../specs/interaction/conversation/SPEC-CONTEXT-SOURCES-AND-STORES.md) | Partial. Every path below marked "as built" is… | `e2e/classification-context.spec.ts` | 8 |
| [SPEC: Conversation Archive and Member Removal (moderator)](../specs/interaction/conversation/SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md) | Implemented. | `e2e/archive-membership.spec.ts` | 2 |
| [SPEC: Compact message metadata - a coded codebook + out-of-band…](../specs/interaction/conversation/SPEC-MESSAGE-METADATA-CODEBOOK.md) | Partial (out-of-band lookup and the cap-sheddin… | `e2e/agent-intents.spec.ts` | 12 |
| [SPEC: Conversation ↔ transport notification bridge (email now;…](../specs/interaction/conversation/SPEC-NOTIFICATION-BRIDGE.md) | Implemented (outbound email hand-off); inbound… | `e2e/notification-bridge.spec.ts` | 1 |
| [SPEC: Task state transitions](../specs/interaction/conversation/SPEC-TASK-STATE-TRANSITIONS.md) | Implemented. | `e2e/task-state-machine.spec.ts` | 1 |
| [DESIGN: Admin-Action IAM Enforcement](../specs/interaction/identity-access/admin/DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md) | Built, on by default (opt-out with `-c adminIam… | `e2e/admin-attachments.spec.ts`<br>`e2e/credential-exchange.spec.ts` | 4 |
| [DESIGN: Admin Agent and Admin Notification Channel](../specs/interaction/identity-access/admin/DESIGN-ADMIN-AGENT-NOTIFICATIONS.md) | Design (not yet built). This design supersedes… | none - a design that supersedes an earlier attempt; the admin agent it describes is not built. | - |
| [SPEC: Admin Identity](../specs/interaction/identity-access/admin/SPEC-ADMIN-IDENTITY.md) | Implemented (with a small set of tracked gaps,… | `e2e/credential-exchange.spec.ts`<br>`e2e/admin-attachments.spec.ts`<br>`e2e/signin.spec.ts` | 12 |
| [Access control by example: blocked interactions, the policy tha…](../specs/interaction/identity-access/core/ACCESS-CONTROL-BY-EXAMPLE.md) | Implemented (reference: worked examples of the… | `e2e/classification-context.spec.ts`<br>`e2e/credential-exchange.spec.ts` | 11 |
| [Identity & Access Model](../specs/interaction/identity-access/core/IDENTITY-AND-ACCESS-MODEL.md) | Implemented (reference: the live identity and a… | `e2e/credential-exchange.spec.ts`<br>`e2e/signin.spec.ts`<br>`e2e/classification-context.spec.ts` | 19 |
| [SPEC: Add a user to a conversation (eligible-member invite and…](../specs/interaction/identity-access/core/SPEC-ADD-USER-ESCALATION.md) | DESIGN (not yet built). | none - design only; the escalation path is not built. | - |
| [Conversation Security, Membership, and Information Isolation](../specs/interaction/identity-access/core/SPEC-CONVERSATION-SECURITY.md) | Implemented (Layers 1-6 are live; Layer 7 mixed… | `e2e/classification-context.spec.ts`<br>`e2e/mentions.spec.ts`<br>`e2e/credential-exchange.spec.ts` | 16 |
| [Identity & Access - anyone participates at the right capability…](../specs/interaction/identity-access/core/SPEC-CREDENTIAL-EXCHANGE.md) | Implemented. | `e2e/credential-exchange.spec.ts` | 3 |
| [Federated Participants - bring external people in, safely, from…](../specs/interaction/identity-access/core/SPEC-FEDERATED-PARTICIPANTS.md) | Design (a wired, opt-in seam; not the shipped e… | none - a wired but opt-in seam, not the shipped experience; no deployment enables it. | - |
| [SPEC - Content Moderation Model (surfaces)](../specs/interaction/identity-access/core/SPEC-MODERATION.md) | Partial (the built content-moderation surfaces… | `e2e/moderation.spec.ts` | 3 |
| [DESIGN: Admin Console](../specs/interface/admin/DESIGN-ADMIN-CONSOLE.md) | Partial (8 sections built; Aurora-only quality… | `e2e/admin-dashboard.spec.ts`<br>`e2e/admin-dashboard-render.spec.ts`<br>`e2e/admin-flow.spec.ts`<br>`e2e/admin-nav.spec.ts` | 21 |
| [DESIGN: Separate Admin App](../specs/interface/admin/DESIGN-SEPARATE-ADMIN-APP.md) | Partial (frontend workspace split and CORS/env… | `e2e/admin-nav.spec.ts`<br>`e2e/admin-dashboard.spec.ts` | 16 |
| [SPEC: Admin console effectiveness, the intent-anchored drill](../specs/interface/admin/SPEC-ADMIN-CONSOLE-EFFECTIVENESS.md) | Implemented. The Effectiveness section is one i… | `e2e/admin-dashboard.spec.ts`<br>`e2e/admin-dashboard-render.spec.ts`<br>`e2e/admin-nav.spec.ts`<br>`e2e/agent-intents.spec.ts` | 29 |
| [SPEC: Admin Console](../specs/interface/admin/SPEC-ADMIN-CONSOLE.md) | Partial (8 sections built; Aurora-only quality… | `e2e/admin-dashboard.spec.ts`<br>`e2e/admin-dashboard-render.spec.ts`<br>`e2e/admin-flow.spec.ts`<br>`e2e/admin-nav.spec.ts`<br>`e2e/admin-attachments.spec.ts` | 22 |
| [DESIGN: Chat Application](../specs/interface/chat/DESIGN-CHAT-APP.md) | Implemented | `e2e/signin.spec.ts`<br>`e2e/signup.spec.ts`<br>`e2e/agent-intents.spec.ts`<br>`e2e/mentions.spec.ts` | 30 |
| [SPEC: Chat Application](../specs/interface/chat/SPEC-CHAT-APP.md) | Implemented | `e2e/signin.spec.ts`<br>`e2e/signup.spec.ts`<br>`e2e/agent-intents.spec.ts`<br>`e2e/mentions.spec.ts`<br>`e2e/welcome.spec.ts` | 33 |
| [SPEC: Abuse Controls (rate limiting, spend budgets, request ded…](../specs/ops/SPEC-ABUSE-CONTROLS.md) | Implemented, with two of the five controls opt-… | `e2e/abuse-controls.spec.ts` | 2 |
| [SPEC: Optional Aurora PostgreSQL + VPC Deployment Mode](../specs/ops/SPEC-AURORA-VPC-MODE.md) | Implemented (opt-in deployment mode). | `e2e/latency.spec.ts`<br>`e2e/admin-dashboard.spec.ts` | 15 |
| [SPEC: Cost Sleep Mode (auto-sleep / wake)](../specs/ops/SPEC-COST-SLEEP-MODE.md) | Implemented (Aurora-mode, opt-in `-c sleepMode=… | `e2e/cost-sleep-mode.spec.ts` | 1 |
| [SPEC: Per-Page Frontend Observability](../specs/ops/SPEC-FRONTEND-OBSERVABILITY.md) | Proposed | none - proposed; no telemetry is emitted yet. | - |

## e2e specs no document claims

Not a failure: a spec file may prove a journey (sign-in, navigation) that no single
specification owns. It is listed so the reverse gap - a test nobody knows is load-bearing -
is as visible as the forward one.

- `e2e/context-source-alarm.spec.ts` (3 tests)
- `e2e/deployed-build.spec.ts` (1 test)
- `e2e/dispatch-routing.spec.ts` (1 test)
- `e2e/experiment-results-trust.spec.ts` (1 test)
- `e2e/feedback.spec.ts` (1 test)
- `e2e/fulfillment-retry.spec.ts` (2 tests)
- `e2e/open-work-items.spec.ts` (1 test)
- `e2e/place-item-flow.spec.ts` (3 tests)
- `e2e/platform-knowledge.spec.ts` (1 test)
- `e2e/report-flow-branches.spec.ts` (3 tests)
- `e2e/speaker-attribution.spec.ts` (2 tests)
- `e2e/task-answer.spec.ts` (2 tests)
- `e2e/task-resolution.spec.ts` (2 tests)
- `e2e/tasks.spec.ts` (4 tests)
