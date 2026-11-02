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
| Spec documents | 64 |
| ...naming at least one e2e spec | 52 |
| ...declaring none, with a reason | 12 |
| Documents claiming live behavior (Implemented / Partial) | 49 |
| ...of those, with no e2e spec | 0 |
| e2e spec files | 124 |
| e2e tests declared | 385 |

## Specifications

| Specification | Status | e2e coverage | Tests |
|---|---|---|---|
| [DESIGN: Telephony and SMS over Twilio, with no Amazon Chime SDK](../specs/communication/DESIGN-TELEPHONY.md) | Draft design ( | none - nothing in this document is built. | - |
| [SPEC: Connectors - integrate with the business's systems, don't…](../specs/communication/SPEC-CONNECTORS.md) | Design, with the runtime built and enabled only… | none - no end-to-end spec drives a vendor delivery; the deployed refusals are the deny-tests `ba… | - |
| [SPEC: Compact message metadata - a coded codebook + out-of-band…](../specs/communication/SPEC-MESSAGE-METADATA-CODEBOOK.md) | Partial. The `safeMetadataString` cap-shedding… | `e2e/agent-intents.spec.ts` | 13 |
| [SPEC: Conversation ↔ transport notification bridge (email now;…](../specs/communication/SPEC-NOTIFICATION-BRIDGE.md) | Partial (outbound email, email preferences with… | `e2e/preferences.spec.ts`<br>`e2e/notification-bridge.spec.ts`<br>`e2e/demo-cast-mail.spec.ts` | 6 |
| [SPEC: Telephony and SMS - a call or a text is part of a convers…](../specs/communication/SPEC-TELEPHONY.md) | Draft design ( | none - nothing in this document is built, so there is no call or message to drive. | - |
| [Demo Company Spec: Stratum Technologies](../specs/demos/SPEC-DEMO-COMPANY.md) | Implemented (the demo dataset and seed script s… | `e2e/classification-context.spec.ts`<br>`e2e/welcome.spec.ts` | 11 |
| [SPEC: Optional Aurora PostgreSQL + VPC Deployment Mode](../specs/foundations/SPEC-AURORA-VPC-MODE.md) | Implemented (opt-in deployment mode). | `e2e/latency.spec.ts`<br>`e2e/admin-dashboard.spec.ts`<br>`e2e/the-lex-leg-is-measured-per-turn.spec.ts` | 20 |
| [SPEC: Cost Sleep Mode (auto-sleep / wake)](../specs/foundations/SPEC-COST-SLEEP-MODE.md) | Partial. The opt-in mode, the idle checker, the… | `e2e/cost-sleep-mode.spec.ts`<br>`e2e/cost-sleep-failure-alert.spec.ts` | 2 |
| [The AgentEchelon Interaction Layer - platform composition model](../specs/interaction/SPEC-INTERACTION-LAYER.md) | Design overview. | none - a design overview that owns no behavior of its own; each pillar spec it maps declares its… | - |
| [DESIGN: Adding an assistant role, from onboarding a context to…](../specs/interaction/assistants/DESIGN-ADDING-AN-ASSISTANT-ROLE.md) | Partially implemented, and the worked case answ… | `e2e/an-assistant-boundary-refuses-cloudwatch.spec.ts`<br>`e2e/an-ops-role-reaches-only-its-own-classification.spec.ts`<br>`e2e/battle.spec.ts` | 29 |
| [DESIGN-ASSISTANT: Meetings assistant](../specs/interaction/assistants/DESIGN-ASSISTANT-MEETINGS.md) | NOT BUILT, under consideration. Draft / plannin… | none - a draft design; nothing meeting-specific is built, and the invitation chase (FR32) is ver… | - |
| [DESIGN: Refusing what a classification cannot produce](../specs/interaction/assistants/DESIGN-CAPABILITY-REFUSAL.md) | Partial - sections 1, 3 to 6, 8 and 9 are built… | `e2e/capability-refusal.spec.ts` | 3 |
| [DESIGN: Meeting sub-agents for onboarding and live incident work](../specs/interaction/assistants/DESIGN-MEETING-ONBOARDING-AND-INCIDENT-SUBAGENTS.md) | Partial. Two parts are built (ADR-061 slice 3e)… | `e2e/an-alarm-a-room-watches-starts-its-workflow.spec.ts` | 3 |
| [DESIGN: Multi-Agent Orchestration](../specs/interaction/assistants/DESIGN-MULTI-AGENT-ORCHESTRATION.md) | Design (alignment doc), not scheduled - the bac… | none - an alignment document proposing a structure; no code implements it yet. | - |
| [DESIGN: Multi-agent fan-out on Strands, the runtime](../specs/interaction/assistants/DESIGN-MULTI-AGENT-STRANDS-RUNTIME.md) | NOT BUILT, under consideration. Draft design fo… | none - a draft design; nothing is built, so there is no deployed behavior to drive. | - |
| [DESIGN: Multi-Assistant Turn Engine](../specs/interaction/assistants/DESIGN-MULTI-ASSISTANT-TURN-ENGINE.md) | NOT BUILT, under consideration. A design target… | none - a design target for generalizing `/battle`; the engine it describes is not built. The bat… | - |
| [DESIGN: Separate assistants, separately owned, and how work rea…](../specs/interaction/assistants/DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md) | Partially implemented. Phases 2 and 4 are built… | `e2e/portable-profile-gates.spec.ts`<br>`e2e/assistant-classification-boundary.spec.ts`<br>`e2e/an-ops-role-reaches-only-its-own-classification.spec.ts` | 12 |
| [SPEC: Assistant configuration - what the assistant is, per expe…](../specs/interaction/assistants/SPEC-ASSISTANT-CONFIG.md) | Implemented. The per-classification config seam… | `e2e/profile-config.spec.ts`<br>`e2e/admin-profiles.spec.ts` | 5 |
| [SPEC-ASSISTANT: Meetings assistant](../specs/interaction/assistants/SPEC-ASSISTANT-MEETINGS.md) | NOT BUILT, under consideration. Draft / plannin… | none - a draft design; nothing meeting-specific is built, and the invitation chase (FR32) is ver… | - |
| [SPEC: Bilingual conversations (reply-language, pivot, dual deli…](../specs/interaction/assistants/SPEC-BILINGUAL-CONVERSATIONS.md) | Partial (reply-language ships; the deployment's… | `e2e/bilingual-conversations.spec.ts`<br>`e2e/a-person-who-joins-is-welcomed-once-in-their-language.spec.ts`<br>`e2e/a-welcome-is-said-in-the-assistants-voice.spec.ts` | 6 |
| [SPEC: Capability profiles and deployment-defined classifications](../specs/interaction/assistants/SPEC-CAPABILITY-PROFILES.md) | Implemented. Classifications and assistant prof… | `e2e/classification-context.spec.ts`<br>`e2e/profile-config.spec.ts`<br>`e2e/agent-intents.spec.ts` | 23 |
| [SPEC: Refusing what a classification cannot produce](../specs/interaction/assistants/SPEC-CAPABILITY-REFUSAL.md) | Partial - the refusal itself (FR1-FR6, FR8, FR9… | `e2e/capability-refusal.spec.ts`<br>`e2e/subjects-and-intents.spec.ts` | 6 |
| [SPEC: Configurable assistants - three per-assistant config axes…](../specs/interaction/assistants/SPEC-CONFIGURABLE-ASSISTANTS.md) | Implemented | `e2e/profile-config.spec.ts` | 2 |
| [SPEC: Configurable intent pack (per-deployment intent taxonomy)](../specs/interaction/assistants/SPEC-CONFIGURABLE-INTENT-PACK.md) | Implemented (the taxonomy mechanism; the domain… | `e2e/agent-intents.spec.ts` | 13 |
| [SPEC: Context-aware model routing (RoutingContext + provider ad…](../specs/interaction/assistants/SPEC-CONTEXT-AWARE-MODEL-ROUTING.md) | Partial, and gated off - the routing feature sh… | `e2e/agent-intents.spec.ts`<br>`e2e/a-route-is-keyed-by-its-intent.spec.ts`<br>`e2e/a-step-picks-the-model-where-it-overrides-or-delivers.spec.ts` | 16 |
| [SPEC: Context sources and stores, and what restricts each one](../specs/interaction/assistants/SPEC-CONTEXT-SOURCES-AND-STORES.md) | Partial. Every path below marked "as built" is… | `e2e/classification-context.spec.ts`<br>`e2e/a-turn-role-is-refused-another-classifications-context-source.spec.ts` | 9 |
| [SPEC: Drift Detection (Drift Convergence)](../specs/interaction/assistants/SPEC-DRIFT-CONVERGENCE.md) | Partial. The embedding-based signal, the confir… | `e2e/drift-detection.spec.ts`<br>`e2e/turn-state-without-lex.spec.ts`<br>`e2e/drift-scope-heavy-member.spec.ts`<br>`e2e/subjects-and-intents.spec.ts` | 16 |
| [SPEC: Per-profile ownership (`AgentEchelonAssistants-*`)](../specs/interaction/assistants/SPEC-PER-PROFILE-OWNERSHIP.md) | Implemented. | `e2e/profile-ownership.spec.ts`<br>`e2e/profile-config.spec.ts`<br>`e2e/profile-config.spec.ts` | 6 |
| [SPEC: Portable, versioned assistant profiles](../specs/interaction/assistants/SPEC-PORTABLE-PROFILES.md) | Implemented and deployed. The versioning lifecy… | `e2e/admin-profiles.spec.ts`<br>`e2e/profile-config.spec.ts`<br>`e2e/portable-profile-gates.spec.ts`<br>`e2e/portable-profile-lifecycle.spec.ts` | 13 |
| [SPEC: Welcome flow and assistant context](../specs/interaction/assistants/SPEC-WELCOME-AND-CONTEXT.md) | Partial (the welcome wiring ships; the welcome… | `e2e/welcome.spec.ts`<br>`e2e/context-sources.spec.ts`<br>`e2e/a-version-variable-fills-a-welcome-and-a-template.spec.ts`<br>`e2e/a-person-who-joins-is-welcomed-once-in-their-language.spec.ts`<br>`e2e/an-opened-room-welcomes-its-lead-once-by-role.spec.ts`<br>`e2e/a-welcome-workflow-offers-the-intake-as-a-step.spec.ts` | 15 |
| [Cross-Channel Task Continuity](../specs/interaction/conversation/CROSS-CHANNEL-TASKS.md) | Implemented. | `e2e/cross-channel-tasks.spec.ts` | 1 |
| [DESIGN: Conversation Types](../specs/interaction/conversation/DESIGN-CONVERSATION-TYPES.md) | Section 2 is built on one creation path. Sectio… | `e2e/a-typed-conversation-creator-creates-at-one-classification.spec.ts`<br>`e2e/a-person-opened-conversation-goes-through-the-canonical-creator.spec.ts`<br>`e2e/an-opened-room-welcomes-its-lead-once-by-role.spec.ts` | 9 |
| [DESIGN: Task access, and where the queue's work happens](../specs/interaction/conversation/DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING.md) | Built, and each row cites what it claims. The a… | `e2e/task-state-machine.spec.ts`<br>`e2e/task-answer.spec.ts`<br>`e2e/task-resolution.spec.ts`<br>`e2e/concurrent-tasks.spec.ts` | 7 |
| [SPEC: Conversation Archive and Member Removal (moderator)](../specs/interaction/conversation/SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md) | Partial (archive and remove-member ship with th… | `e2e/archive-membership.spec.ts` | 3 |
| [SPEC: Conversation Types](../specs/interaction/conversation/SPEC-CONVERSATION-TYPES.md) | Partial. A conversation is a type rather than o… | `e2e/a-typed-conversation-creator-creates-at-one-classification.spec.ts`<br>`e2e/a-person-opened-conversation-goes-through-the-canonical-creator.spec.ts`<br>`e2e/a-conversation-is-named-and-assembled.spec.ts` | 8 |
| [SPEC: Document templates](../specs/interaction/conversation/SPEC-DOCUMENT-TEMPLATES.md) | Partial (the template format, storage behind an… | `e2e/document-templates.spec.ts`<br>`e2e/tasks.spec.ts`<br>`e2e/report-flow-branches.spec.ts` | 9 |
| [SPEC: Task state transitions](../specs/interaction/conversation/SPEC-TASK-STATE-TRANSITIONS.md) | Partial (the machine, the tools, the delivery c… | `e2e/a-step-requires-its-lookup-before-the-task-moves-on.spec.ts`<br>`e2e/an-image-is-asked-for-confirmed-drawn-and-revised.spec.ts`<br>`e2e/a-step-picks-the-model-where-it-overrides-or-delivers.spec.ts`<br>`e2e/task-state-machine.spec.ts`<br>`e2e/tasks.spec.ts`<br>`e2e/report-flow-branches.spec.ts`<br>`e2e/place-item-flow.spec.ts`<br>`e2e/an-invitation-runs-its-workflow-until-it-is-revoked.spec.ts`<br>`e2e/a-proposal-is-applied-once-by-its-addressee.spec.ts`<br>`e2e/a-workflow-step-opens-a-task-for-a-person.spec.ts`<br>`e2e/a-task-deadline-ends-the-task-and-continues-the-run.spec.ts`<br>`e2e/an-idle-assistant-takes-up-its-own-work.spec.ts` | 26 |
| [SPEC: The Turn Queue - managing multiple requests to a single a…](../specs/interaction/conversation/SPEC-TURN-QUEUE.md) | Partial. The conversation-level claim, the defe… | `e2e/turn-queue.spec.ts`<br>`e2e/private-stop.spec.ts`<br>`e2e/group-split-offer.spec.ts`<br>`e2e/an-idle-assistant-takes-up-its-own-work.spec.ts` | 16 |
| [SPEC: User profile store and once-per-user onboarding](../specs/interaction/conversation/SPEC-USER-PROFILE-AND-ONBOARDING.md) | Partial (the store, the swap seam, the once-per… | `e2e/onboarding-intake.spec.ts`<br>`e2e/reply-preferences.spec.ts` | 4 |
| [Access control by example: blocked interactions, the policy tha…](../specs/interaction/governance/ACCESS-CONTROL-BY-EXAMPLE.md) | Implemented (reference: worked examples of the… | `e2e/classification-context.spec.ts`<br>`e2e/credential-exchange.spec.ts` | 11 |
| [DESIGN: Admin-Action IAM Enforcement](../specs/interaction/governance/DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md) | Built, deployed and validated. Every route in t… | `e2e/admin-attachments.spec.ts`<br>`e2e/credential-exchange.spec.ts` | 4 |
| [DESIGN: Admin Assistant and Admin Notification Channel](../specs/interaction/governance/DESIGN-ADMIN-AGENT-NOTIFICATIONS.md) | Not built end-to-end. The code is complete and… | `e2e/notification-bridge.spec.ts`<br>`e2e/an-operator-notice-is-worded-by-the-admin-agent.spec.ts` | 4 |
| [Identity and Access Model](../specs/interaction/governance/IDENTITY-AND-ACCESS-MODEL.md) | Partial (the groups, the three admins, the bear… | `e2e/credential-exchange.spec.ts`<br>`e2e/signin.spec.ts`<br>`e2e/classification-context.spec.ts` | 19 |
| [SPEC: Abuse Controls (rate limiting, spend budgets, request ded…](../specs/interaction/governance/SPEC-ABUSE-CONTROLS.md) | Partial. The five controls and the shared table… | `e2e/abuse-controls.spec.ts` | 2 |
| [SPEC: Access and Controls Auditing](../specs/interaction/governance/SPEC-ACCESS-AND-CONTROLS-AUDITING.md) | Implemented (audit capture and the membership-h… | `e2e/access-auditing.spec.ts` | 2 |
| [SPEC: Add a user to a conversation (eligible-member invite and…](../specs/interaction/governance/SPEC-ADD-USER-ESCALATION.md) | DESIGN (not yet built). | none - design only; the escalation path is not built. | - |
| [SPEC: Admin Identity](../specs/interaction/governance/SPEC-ADMIN-IDENTITY.md) | Implemented (with a small set of tracked gaps,… | `e2e/credential-exchange.spec.ts`<br>`e2e/admin-attachments.spec.ts`<br>`e2e/signin.spec.ts` | 12 |
| [SPEC: Conversation Security, Membership and Information Isolati…](../specs/interaction/governance/SPEC-CONVERSATION-SECURITY.md) | Partial (Layers 1-6 ship; Layer 7 mixed-trust v… | `e2e/classification-context.spec.ts`<br>`e2e/mentions.spec.ts`<br>`e2e/credential-exchange.spec.ts`<br>`e2e/identity-classification.spec.ts`<br>`e2e/an-assistant-boundary-refuses-cloudwatch.spec.ts` | 31 |
| [SPEC: Credential Exchange](../specs/interaction/governance/SPEC-CREDENTIAL-EXCHANGE.md) | Partial (the person half is bearer-pinned; the… | `e2e/credential-exchange.spec.ts`<br>`e2e/a-providers-groups-give-the-access-the-guide-describes.spec.ts` | 7 |
| [SPEC: Federated Participants](../specs/interaction/governance/SPEC-FEDERATED-PARTICIPANTS.md) | Design, built (an external issuer declared in t… | none - in the e2e suite; a deployment reaches it only by declaring a one-conversation issuer. Th… | - |
| [SPEC: Moderation](../specs/interaction/governance/SPEC-MODERATION.md) | Partial (the built content-moderation surfaces… | `e2e/moderation.spec.ts` | 3 |
| [DESIGN: Battle Mode (`/battle`) - Technical Design](../specs/interaction/quality/DESIGN-BATTLE.md) | Partial. The two-version battle (section 1a), t… | `e2e/battle.spec.ts` | 21 |
| [DESIGN: Evaluation](../specs/interaction/quality/DESIGN-EVALUATION.md) | Partial. This document describes the design for… | `e2e/evaluation-verdicts.spec.ts` | 3 |
| [DESIGN: Experiments and Battle - Objective, Briefing, Lifecycle…](../specs/interaction/quality/DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md) | Partial. §1 to §4 are implemented. The §4.3 dri… | `e2e/an-image-experiment-attributes-every-step-to-its-arm.spec.ts`<br>`e2e/experiments.spec.ts`<br>`e2e/experiment-results-trust.spec.ts`<br>`e2e/battle.spec.ts` | 36 |
| [SPEC: Battle Mode (`/battle`) - Product Specification](../specs/interaction/quality/SPEC-BATTLE.md) | Partial. The battle path ships. Three rows are… | `e2e/an-image-duel-runs-both-chains-to-an-image.battle.spec.ts`<br>`e2e/battle.spec.ts`<br>`e2e/a-tested-treatment-is-promoted-into-the-live-assistant.spec.ts`<br>`e2e/experiments.spec.ts`<br>`e2e/experiment-results-trust.spec.ts` | 38 |
| [SPEC: Evaluation](../specs/interaction/quality/SPEC-EVALUATION.md) | Partial. This document describes the design for… | `e2e/evaluation-verdicts.spec.ts` | 3 |
| [DESIGN: Admin Console](../specs/interface/DESIGN-ADMIN-CONSOLE.md) | Partial (7 sections built; Aurora-only quality… | `e2e/admin-dashboard.spec.ts`<br>`e2e/admin-dashboard-render.spec.ts`<br>`e2e/admin-flow.spec.ts`<br>`e2e/admin-nav.spec.ts`<br>`e2e/admin-console-reflects-role.spec.ts` | 30 |
| [DESIGN: Chat Application](../specs/interface/DESIGN-CHAT-APP.md) | Implemented | `e2e/signin.spec.ts`<br>`e2e/signup.spec.ts`<br>`e2e/agent-intents.spec.ts`<br>`e2e/mentions.spec.ts` | 39 |
| [DESIGN: Separate Admin App](../specs/interface/DESIGN-SEPARATE-ADMIN-APP.md) | Partial (frontend workspace split and CORS/env… | `e2e/admin-nav.spec.ts`<br>`e2e/admin-dashboard.spec.ts` | 18 |
| [SPEC: Admin console effectiveness, the intent-anchored drill](../specs/interface/SPEC-ADMIN-CONSOLE-EFFECTIVENESS.md) | The intent spine is implemented. The Effectiven… | `e2e/admin-dashboard.spec.ts`<br>`e2e/admin-dashboard-render.spec.ts`<br>`e2e/admin-nav.spec.ts`<br>`e2e/agent-intents.spec.ts`<br>`e2e/a-console-edits-an-intents-image-and-step-models.spec.ts` | 34 |
| [SPEC: Admin Console](../specs/interface/SPEC-ADMIN-CONSOLE.md) | Partial. This document describes the design for… | `e2e/admin-dashboard.spec.ts`<br>`e2e/admin-dashboard-render.spec.ts`<br>`e2e/admin-flow.spec.ts`<br>`e2e/admin-nav.spec.ts`<br>`e2e/admin-attachments.spec.ts`<br>`e2e/admin-console-reflects-role.spec.ts`<br>`e2e/admin-workflow-builder.spec.ts`<br>`e2e/archive-membership.spec.ts`<br>`e2e/a-conversation-is-read-without-who-said-it.spec.ts`<br>`e2e/an-ops-role-reaches-only-its-own-classification.spec.ts`<br>`e2e/experiment-battles.spec.ts` | 42 |
| [SPEC: Chat Application](../specs/interface/SPEC-CHAT-APP.md) | Implemented | `e2e/signin.spec.ts`<br>`e2e/signup.spec.ts`<br>`e2e/agent-intents.spec.ts`<br>`e2e/mentions.spec.ts`<br>`e2e/welcome.spec.ts`<br>`e2e/turn-state-without-lex.spec.ts` | 45 |
| [SPEC: Embeddable widget - an assistant on someone else's page,…](../specs/interface/SPEC-EMBEDDABLE-WIDGET.md) | Built, not deployed. The widget is `frontend/pa… | `e2e/guest-widget.spec.ts`<br>`e2e/invitations.spec.ts` | 4 |
| [SPEC: Per-Page Frontend Observability](../specs/interface/SPEC-FRONTEND-OBSERVABILITY.md) | Proposed, under consideration. The per-page att… | none - proposed; the per-page attribution this document adds is not emitted. The seam it extends… | - |

## e2e specs no document claims

Not a failure: a spec file may prove a journey (sign-in, navigation) that no single
specification owns. It is listed so the reverse gap - a test nobody knows is load-bearing -
is as visible as the forward one.

- `e2e/a-classification-is-denied-a-model-it-does-not-declare.spec.ts` (2 tests)
- `e2e/a-declared-assistant-is-the-registrys-own-name.spec.ts` (2 tests)
- `e2e/a-deployment-brings-its-own-golden-entries.spec.ts` (4 tests)
- `e2e/a-draft-answers-the-golden-set-before-it-is-activated.spec.ts` (5 tests)
- `e2e/a-non-member-cannot-open-work-in-a-conversation.spec.ts` (1 test)
- `e2e/a-replayed-turn-claims-once.spec.ts` (2 tests)
- `e2e/a-room-an-event-opens-is-named-from-its-context.spec.ts` (2 tests)
- `e2e/a-runtime-assistant-answers-as-itself.spec.ts` (4 tests)
- `e2e/a-team-creates-opens-and-moves-its-own-assistant.spec.ts` (4 tests)
- `e2e/a-vended-session-cannot-write-processor-records.spec.ts` (1 test)
- `e2e/admin-task-routes.spec.ts` (4 tests)
- `e2e/an-agent-step-addressed-to-a-role-reaches-only-its-holders.spec.ts` (2 tests)
- `e2e/an-assistant-passes-a-question-to-its-ops-roommate.spec.ts` (3 tests)
- `e2e/an-assistant-session-is-narrowed-to-its-definition.spec.ts` (1 test)
- `e2e/an-assistants-infrastructure-links-name-live-resources.spec.ts` (1 test)
- `e2e/an-assistants-page-shows-its-templates-intents-and-workflows.spec.ts` (1 test)
- `e2e/an-import-cannot-carry-a-model-the-target-classification-lacks.spec.ts` (2 tests)
- `e2e/analytics-accuracy.spec.ts` (9 tests)
- `e2e/context-source-alarm.spec.ts` (3 tests)
- `e2e/deployed-build.spec.ts` (2 tests)
- `e2e/dispatch-routing.spec.ts` (1 test)
- `e2e/export.spec.ts` (2 tests)
- `e2e/feedback.spec.ts` (1 test)
- `e2e/flag-a-response.spec.ts` (1 test)
- `e2e/funnel.spec.ts` (2 tests)
- `e2e/h1-offboard.spec.ts` (1 test)
- `e2e/h1-person.spec.ts` (2 tests)
- `e2e/identical-private-messages.spec.ts` (1 test)
- `e2e/no-platform-role-speaks-as-an-assistant.spec.ts` (3 tests)
- `e2e/only-the-vend-mints-an-assistant-session.spec.ts` (3 tests)
- `e2e/open-work-items.spec.ts` (1 test)
- `e2e/platform-knowledge.spec.ts` (2 tests)
- `e2e/speaker-attribution.spec.ts` (2 tests)
- `e2e/task-reference.spec.ts` (4 tests)
- `e2e/trace-holds-no-password.spec.ts` (3 tests)
- `e2e/ttff-decomposition.spec.ts` (6 tests)

## Deny-tests

Every live refusal the platform claims, and the file that proves it. Rendered from
`backend/lib/docs/deny-test-inventory.ts`. A row is present when every file it names exists and
holds the check; that is not a record that it ran. Each run against a deployed instance is
recorded, dated, in the document that makes the claim. The configurations are the deploy
matrix's (`backend/test/deploy-matrix/configurations.ts`): C0 is the anonymous widget alone, and
each later configuration adds capabilities to the one before. A file marked (unit) proves the
refusal's logic without a deployment; it never makes a row present.

28 of 28 present.

| Deny-test | Refuses | Files | Configurations | State |
|---|---|---|---|---|
| `bearer-pin` | A session vended for one person cannot act as another person: the `person` session tag pins the bearer. | `backend/scripts/deny-test-bearer-pin.mjs` | C1 and later | present |
| `credential-exchange` | An exchange credential sending as another person is refused on a real channel its caller belongs to. | `backend/scripts/deny-test-credential-exchange.mjs` | C1 and later | present |
| `session-classification` | A session asserting one classification cannot be minted on the role carrying another classification's grants. | `backend/scripts/deny-test-session-classification.mjs` | C1 and later | present |
| `tag-key-case` | A principal-versus-resource tag condition matches the key casing the stacks write, so it enforces rather than never matching. | `backend/scripts/deny-test-tag-key-case.mjs` | C1 and later | present |
| `offboarded-sign-in` | An offboarded person is refused at their next sign-in, and nothing is minted for them. | `backend/scripts/deny-test-offboarded-sign-in.mjs` | C1 and later | present |
| `assistant-membership` | A membership credential is authorized on the channel, not on the member it names, so the membership audit is the enforcement on that axis. | `backend/scripts/deny-test-assistant-membership.mjs` | C1 and later | present |
| `admin-capabilities` | Every admin capability is refused, by IAM at the gateway, to a role that does not hold it. | `backend/scripts/deny-test-admin-capabilities.mjs` | C2 and later | present |
| `owner-team-tag` | Only the ownership function can write the `owner-team` tag. | `backend/scripts/deny-test-owner-team-tag.mjs` | C2 and later | present |
| `provisioner-claims` | No principal can ask the assistant provisioner in another's name: each classification's claim path is writable by its own seed alone and the console's by `manage-assistants` alone, and a request whose claim was never written is refused. | `backend/scripts/deny-test-provisioner-claims.mjs`<br>`backend/test/the-provisioner-builds-and-retires-every-assistant.test.ts` (unit)<br>`backend/test/one-principal-builds-every-assistant.test.ts` (unit) | C1 and later | present |
| `identities-writers` | Only the credential exchange and offboarding write the `Identities` table, and, with a `provisioned-only` issuer, the subject provisioners, which write `pending` rows alone. | `backend/scripts/deny-test-credential-exchange.mjs` | C1 and later | present |
| `issuer-mapping` | A person from a foreign issuer cannot read or post in a channel their mapped classifications do not reach, and a claim value outside the mapping reaches nothing. | `backend/scripts/deny-test-issuer-mapping.mjs` | C5 and later | present |
| `edge-authorizer` | A token from an undeclared issuer, with a forged signature, for another audience, of the undeclared token type, signed with an undeclared algorithm (none and HS256 included) or outside its validity gets 401 on every person-facing route; a first-time token is refused everywhere but the exchange; a one-conversation issuer is refused everywhere but its own routes. | `backend/scripts/deny-test-edge-authorizer.mjs`<br>`backend/test/lib/the-edge-refuses-a-token-it-cannot-prove.test.ts` (unit)<br>`backend/test/lib/the-edge-admits-a-token-only-where-its-person-is-served.test.ts` (unit) | C1 and C5 | present |
| `admin-exchange` | The admin credential exchange refuses a guest token and a host assertion. | `backend/scripts/deny-test-admin-exchange.mjs` | C5 and later | present |
| `guest` | A guest cannot reach another guest's channel or any route but the exchange; a refresh replay revokes its family, the latest credential included; two tabs refreshing at once both keep the session; a burst from one address is refused; guest start refuses with its reason code when a control cannot answer; the guest-session role with no session policy is refused CreateChannel, CreateChannelMembership and every other channel. | `backend/scripts/deny-test-guest.mjs`<br>`backend/test/the-guest-session-fails-closed.test.ts` (unit)<br>`backend/test/lib/the-edge-verifies-a-guest-token.test.ts` (unit)<br>`backend/test/the-guest-session-reaches-one-conversation.test.ts` (unit)<br>`backend/test/the-guest-issuer-is-declared-with-its-controls.test.ts` (unit) | C0 and later | present |
| `guest-widget` | An anonymous visitor in the widget gets an answer from the seeded assistant, and the widget shows each refusal's reason. | `tests/e2e/guest-widget.spec.ts` | C0 and later | present |
| `tokens` | A single-use token is refused on a second redemption, after it expires and on the wrong channel, and each kind writes only its own records. | `backend/scripts/deny-test-tokens.mjs`<br>`backend/test/the-token-store-redeems-a-token-once.test.ts` (unit) | C0 and later | present |
| `host-assertion` | A host assertion is refused on replay, on a wrong audience, a long expiry, an unpinned key or no `jti`, on any route but the exchange (without spending its `jti`), with an unmapped permission set, and for a subject nobody provisioned (nothing is created); a pending subject reaches the exchange alone. The undeclared-origin and parent-frame refusals are made by the widget frame itself, in the browser, so no live script can make them: they are proven by the component tests of the widget (`frontend/packages/widget/src/session/hostAssertion.test.ts`, `frontend/packages/widget/src/embed/embed.test.ts`). | `backend/scripts/deny-test-host-assertion.mjs`<br>`backend/test/lib/the-edge-verifies-a-host-assertion.test.ts` (unit)<br>`backend/test/a-host-assertion-is-spent-before-the-exchange-vends.test.ts` (unit)<br>`backend/test/a-host-assertion-issuer-pins-its-keys.test.ts` (unit) | C5 and later | present |
| `pending-identities` | No role but the two subject provisioners writes a `pending` `Identities` row, and each only under the keys of its own issuers; a pending row of one issuer is not accepted from another; a provisioned subject is bound once, to one person, under concurrency too, and carries no expiration. | `backend/scripts/deny-test-pending-identities.mjs`<br>`backend/test/a-provisioned-subject-is-pending-until-its-first-sign-in.test.ts` (unit)<br>`backend/test/the-host-assertion-boundary.test.ts` (unit) | C5 and later | present |
| `upgrade` | A guest is bound to an account only by the rules of the bind, which removes its expiration and revokes the guest's refresh family; the bind takes the widget's single-use hand-off (a nonce, and the secret only the tab the widget opened receives), so a forwarded sign-in link binds nothing; an existing account cannot bind a visitor; a claim is never matched by email and redeems once; erasure follows the source-channel tag; a second issuer is linked only by a pinned session. | `backend/scripts/deny-test-upgrade.mjs`<br>`backend/test/lib/binding-a-guest-ends-the-guest-credential.test.ts` (unit)<br>`backend/test/a-claim-opens-a-tagged-customer-conversation.test.ts` (unit)<br>`backend/test/lib/a-second-issuer-is-linked-only-by-a-pinned-session.test.ts` (unit)<br>`backend/test/the-upgrade-paths-are-granted-narrowly.test.ts` (unit)<br>`backend/test/user-management-delete.test.ts` (unit) | C0 and later (path B and the link need a customers' pool) | present |
| `invitations` | An invitation is redeemed once, in its declared mode only; a GET of its link leaves the token unspent; a sign-in redemption never binds an account that already exists; a forwarded link admits one session, pinned to one conversation; revocation removes the membership; offboarding the inviter makes a pending invitation unredeemable. | `backend/scripts/deny-test-invitations.mjs`<br>`tests/e2e/invitations.spec.ts`<br>`backend/test/lib/an-invitation-names-its-invitee-by-person.test.ts` (unit)<br>`backend/test/lib/an-invitation-is-redeemed-once-in-its-mode.test.ts` (unit)<br>`backend/test/invitations-are-granted-narrowly.test.ts` (unit)<br>`backend/test/an-invitation-link-issuer-is-declared-with-its-controls.test.ts` (unit)<br>`backend/test/user-management-delete.test.ts` (unit) | C3 and later | present |
| `reply-token` | Email is sent only with consent and the unsubscribe headers; inbound mail without a valid reply token, or failing DMARC, posts nothing. | `backend/scripts/deny-test-reply-token.mjs`<br>`tests/e2e/preferences.spec.ts` | C3 and later | present |
| `funnel-export` | Each funnel stage is recorded once, and an export covers every store that names a person. | `tests/e2e/funnel.spec.ts`<br>`tests/e2e/export.spec.ts`<br>`backend/test/lib/the-funnel-records-each-stage-once-per-journey.test.ts` (unit)<br>`backend/test/an-export-covers-every-store-erasure-names.test.ts` (unit) | C2 and later | present |
| `claims-erased` | The contact copy kept for a person from a claims-only issuer is erased when the person is offboarded. | `tests/e2e/h1-offboard.spec.ts` | C5 and later | present |
| `non-pool-person` | A person from a second pool and from a foreign OIDC issuer is an opaque AppInstanceUser that is not the token's subject, and every person-facing feature works for them. | `tests/e2e/h1-person.spec.ts` | C5 and C7 | present |
| `connector-events` | A vendor event reaches the receiver only through its connector's rule, pinned to the declared partner event source and subscribed events; the receiver may be invoked by those rules alone; and no route serves a vendor. A replay is dropped, and a person is named only through `Identities`, never by email (unit; live with a real vendor delivery). | `backend/scripts/deny-test-connector-events.mjs`<br>`backend/test/lib/a-vendor-event-is-received-only-from-its-source.test.ts` (unit)<br>`backend/test/lib/a-connector-names-a-person-only-through-identities.test.ts` (unit) | C6 and later | present |
| `connector-boundary` | The connector runtime holds no Amazon Chime SDK channel action, reads only its own connectors' secrets, decrypts grants only under their encryption context, and never writes `Identities`. | `backend/scripts/deny-test-connector-boundary.mjs`<br>`backend/test/connectors-hold-only-their-own-reach.test.ts` (unit) | C6 and later | present |
| `permission-boundaries` | Each role a session is vended on or an assistant acts through (every assistant acting role, the guest and link session roles, each person vend role a host assertion is also vended on, the admin exchange's roles), the edge authorizer and the connector runtime carry a permissions boundary that caps them, whatever their identity or session policy grants. | `backend/scripts/deny-test-permission-boundaries.mjs`<br>`backend/test/every-role-a-credential-is-minted-on-carries-a-boundary.test.ts` (unit) | C7 | present |
| `context-source-per-classification` | A classification's acting role, with the tags a real session carries, is refused another classification's context-source catalog and every source that catalog publishes and its own does not, so a `ctx:` variable reads only what its classification publishes (ADR-060). | `tests/e2e/a-turn-role-is-refused-another-classifications-context-source.spec.ts`<br>`backend/test/a-turn-role-is-refused-another-classifications-context-source.test.ts` (unit) | C1 and later | present |
