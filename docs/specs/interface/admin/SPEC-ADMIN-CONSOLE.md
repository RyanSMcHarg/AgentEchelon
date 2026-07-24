# SPEC: Admin Console

**Status:** Partial (8 sections built; Aurora-only quality views and several operator affordances are opt-in or roadmap) **Layer:** Interface (admin interface - reference client) **Plane:** admin **Summary:** A single internal operator surface for reading conversations, moderating and administering them, managing assistant profiles, and watching platform health, assistant effectiveness, experiments, users, and security in one place. **Technical design:** [`DESIGN-ADMIN-CONSOLE.md`](DESIGN-ADMIN-CONSOLE.md) **Site section(s):** Admin Console (standalone operator app; see [`DESIGN-SEPARATE-ADMIN-APP.md`](DESIGN-SEPARATE-ADMIN-APP.md))

## 1. Business problem

An operator running an AgentEchelon instance flies blind. The record of what the platform did lives in several stores at once: an event archive of every conversation, an analytics projection for derived quality signals, a Cognito user pool, and a live messaging substrate. There is no single place to read a conversation end to end, moderate or administer it, see whether the assistants are actually answering well, compare models, run and read experiments, manage users, or confirm that classification isolation is holding. Answering any one of those questions means querying a store directly and reassembling the picture by hand. The alternative on the market is to stitch together general-purpose dashboards, log tools, and moderation scripts - none of which understands conversations, classifications, or an accountable privileged action - and keep them in sync as the platform evolves, or to fly blind.

That gap matters on four fronts. Trust and safety: without a way to read and moderate a specific conversation, an operator cannot respond to a bad answer, a leak, or a legal or workplace request. Evaluation: without effectiveness and experiment views, an AI developer cannot tell whether a model or profile change helped or hurt, so quality changes ship on intuition. Cost: without per-model usage, token spend, and cost-per-reply, spend is invisible until the bill arrives. Compliance: without a membership and moderator timeline and a cross-classification audit, an operator cannot establish who accessed a conversation and when, or prove that isolation is enforced.

The console exists to make the platform legible to the people who operate it, in one place, without direct store access, and with every privileged read and action carried out under an accountable identity.

## 2. Personas

See [`overview/PERSONAS.md`](../../../overview/PERSONAS.md) for the canonical definitions. The console serves the operator-facing personas; the end user is the subject of the data, not a user of the console. Legal and HR are compliance roles that act through the admin / operator surface.

| Persona | What they need from this feature |
|---|---|
| Admin / operator | Read, moderate, and administer any conversation across classifications; manage users; watch platform health; audit access and confirm classification isolation. |
| AI developer | Evaluate assistant quality by intent, triage flagged responses, calibrate the automated evaluator against human labels, and compare two models or profiles head to head with a ship recommendation. |
| Platform developer | Debug the runtime: trace a turn step by step (tool loop, tokens, cost, per-step latency), inspect the full raw stored payload, and watch error rate and reconnect spikes as early warnings. |
| Manager | Read outcomes for decisions: adoption and engagement trends, assistant effectiveness rankings, and experiment ship recommendations, without touching the underlying stores. |
| QA / test engineer | Validate assistant quality across scenarios before a release: read evaluations and per-intent scores (Effectiveness), triage flagged responses (Flagged), and calibrate against human labels (Ground Truth) as release-gating signals. |
| BI analyst | Read the analytics surfaces (Overview, Users, Models) and, more importantly, get queryable access and EXPORT of the underlying governed data to their own BI stack (QuickSight / Athena / the data-in-your-account model), rather than being limited to the curated dashboards. |
| Legal team member | Review a conversation's message history, redact or delete specific messages, and establish who accessed it and when for a legal matter. Acts through the admin / operator surface, subject to the accountability-logging calibration in the admin identity model. |
| HR | Review a specific user's conversations and confirm who had access and when for a workplace matter. Acts through the admin / operator surface, under the same calibration. |
| End user | Not a console user. Their trust and safety are why moderation, evaluation, and audit exist; their conversations are what the console reads. |

## 3. Use cases

1. **Read a conversation** - As an admin / operator (or legal / HR), I open a conversation and read its full history, live members, membership timeline, and any message attachments, so that I can respond to a report or a compliance request.
2. **Moderate or administer content** - As an admin / operator, I redact or delete a specific message, or add or remove a member, so that I can act on a bad answer or a leak under an accountable identity.
3. **Watch platform health** - As an admin / operator, I read traffic volume, active users, error rate, latency SLOs, web vitals, and WebSocket stability at a glance, so that I can catch a regression early.
4. **Evaluate assistant quality** - As an AI developer, I read evaluation scores by agent and intent, analyze multi-turn flow quality, and triage flagged responses, so that I can find and fix weak spots.
5. **Calibrate the evaluator** - As an AI developer, I submit human ground-truth scores and read the evaluator's error and agreement, so that I can trust the automated scores.
6. **Compare models** - As an AI developer or manager, I run an A/B experiment or a `/battle` match-up and read head-to-head results with a ship recommendation, so that I can decide what to promote.
7. **Debug a turn** - As a platform developer, I trace a turn's tool loop step by step and inspect the full raw stored payload, so that I can root-cause a runtime problem.
8. **Manage users** - As an admin / operator, I approve, set classification, disable, re-enable, or delete users, so that access matches policy.
9. **Understand adoption** - As a manager, I read session and messaging DAU, funnels, and per-user leaderboards, so that I can judge engagement.
10. **Audit access and isolation** - As an admin / operator (or legal), I detect cross-classification membership leaks, revoke over-classification access, and establish who accessed a conversation and when, so that I can prove isolation and accountability.
11. **Manage assistant profiles** - As an admin / operator or AI developer, I read an assistant profile's resolved configuration, create a new version, edit its models and tools, validate it, activate or roll back a version, and export or import a profile, so that I can change assistant behavior as a versioned artifact without a redeploy.
12. **Watch what is wrong right now** - As an admin / operator, I open one consolidated Alerts view that lists every metric in `bad` or `warn` status (runtime errors, missed latency SLOs, and intent or model quality regressions), each linking to its drill, so that I do not have to hunt tab by tab.

## 4. Feature catalog

The complete expected operator feature surface, grouped by the 8 console sections plus Auth/session and System/settings. Each entry names what it is, why it matters to the operator, and its status. Features the console does not have are enumerated as first-class out-of-scope entries.

**Status legend:** **Built** = present and functional in the `frontend/packages/admin` tree. **Partial** = present but gated (Aurora-only, or a deploy flag) or with an unserved backing query. **Out of scope (boundary)** = deliberately excluded. **Out of scope (roadmap)** = not built, a plausible future addition.

### Overview

| Feature | Why it matters | Status |
|---|---|---|
| Traffic headline (messages, active conversations, active days, avg/day, volume sparkline) | Baseline sense of load | Built |
| Intent distribution | See the traffic split by intent | Built |
| Session and messaging DAU | Distinguish who signed in from who engaged | Built |
| Error-rate trailing band | Spot platform-health regressions | Built |
| Latency SLOs (avg total, avg Bedrock, avg polling, p95) | Track response-time targets | Built |
| Page web-vitals percentiles | Real-user front-end health | Built |
| WebSocket connection health (connects, disconnects, reconnects) | Reconnect spikes as an early warning | Built |
| Consolidated Alerts sub-tab (every metric in `bad` or `warn` status - runtime errors, latency SLA breaches, and intent/model quality breaches - assembled client-side, each row stating value vs target and linking to its drill) | See what is wrong right now in one place, not tab by tab | Partial (Aurora; leans on the Aurora-only effectiveness/model data, so hidden in Athena mode) |

### Conversations

| Feature | Why it matters | Status |
|---|---|---|
| Conversation list across classifications | Pick any conversation to administer | Built |
| Read decoded message history (Lex envelope unwrapped) | Faithful read without raw Lex JSON | Built |
| Live members | Current membership before an action | Built |
| Membership and moderator timeline | Audit who joined, left, or held moderator, and when | Built |
| Inspect drawer (full raw stored payload) | Faithful per-message record for troubleshooting | Built |
| Attachment review from the Info drawer (open a message's attachment via short-lived, channel-scoped, audited S3 credentials; assistant deliverables under `attachment-read`, user uploads under `attachment-read-uploads`) | Review a deliverable or a user-uploaded file under an accountable identity | Built |
| Per-conversation drift events | Review topic drift | Partial (Aurora) |
| Administration actions (join, add / remove member, redact, delete) under `${sub}-admin` | Act on content and membership under an accountable identity | Built |
| Live conversation tail (real-time follow) | Watch an active conversation as it happens | Out of scope (roadmap) |

### Effectiveness

| Feature | Why it matters | Status |
|---|---|---|
| Intent-anchored dashboard (worst-first; classification, execution, latency, cost/reply, tool-error) | One ranked view of where quality is weakest | Partial (Aurora) |
| Drill L1-L4 (intent to exchange or task to turn timeline to tool-loop steps) | Trace a weak intent down to a single turn | Partial (Aurora) |
| Evaluations (avg relevance, per agent / intent; per-exchange detail) | Quality by agent and intent | Built (per-exchange Aurora-only) |
| Flows (multi-turn weighted dimensions) | Multi-turn task-flow quality | Partial (Aurora; empty until the flow pass runs) |
| Tasks (completion metrics, task list, per-task timeline) | Track multi-step task outcomes | Partial (Aurora) |
| Flagged triage (approve / reject with notes) | Triage low-quality or non-compliant responses | Partial (UI built; backing read not yet served) |
| Ground Truth (human score submission, MAE / agreement) | Calibrate the automated evaluator | Partial (UI built; backing read not yet served) |

### Models

| Feature | Why it matters | Status |
|---|---|---|
| Model usage (count, latency, tokens) | Volume, latency, and spend per model | Built |
| Model-by-intent effectiveness | Which model does best on which intent | Partial (Aurora) |
| User feedback (thumbs, approval rate) | Human signal per model and intent | Built |
| Model strategy and capability catalog (static) | Documented routing and model reference | Built |
| Execution steps (per-turn tool-loop debug) | Debug a turn's tool loop and per-step cost | Partial (Aurora) |

### Assistants

The assistant-profile management surface (profiles are versioned, portable artifacts; see [`SPEC-PORTABLE-PROFILES.md`](../../interaction/assistant-config/SPEC-PORTABLE-PROFILES.md)). Every mutation is gated server-side on the `manage-profiles` capability and audited.

| Feature | Why it matters | Status |
|---|---|---|
| Profile list with per-profile versions, active pointer, and draft state | See every assistant profile and its version history | Built |
| Resolved config-values view (models bundle, per-intent and classifier routing, tools, guardrail, timeouts, rate limit, battle eligibility) | Read exactly what an active profile does today | Built |
| Create version / edit draft / validate / activate / roll back | Change assistant behavior as a versioned artifact with no redeploy | Built |
| Export / import a profile (instance-agnostic manifest; model keys are catalog keys, never ARNs) | Move a profile across instances or regions | Built |
| Rich draft editors (models bundle and tool set) | Edit the model routing and tool surface in place | Built |
| Infrastructure deep links (AWS console links for the profile's models, guardrail, processor Lambda, logs, and IAM role, server-resolved) | Jump from a profile to its live AWS resources | Built |
| Jump to this assistant's Effectiveness (scoped to the profile's classification) | Cross-link a profile to its quality data | Built |

### Experiments

| Feature | Why it matters | Status |
|---|---|---|
| Experiment registry list | See configured experiments and `/battle` match-ups | Built |
| Create / pause / resume / complete (A/B and `/battle`) | Run experiments end to end | Built |
| Head-to-head per-variant results | Compare control vs treatment | Partial (Aurora) |
| Objective banner and LLM ship recommendation (descriptive, never reroutes) | Read progress and a promote/hold call | Partial (Aurora) |

### Users

| Feature | Why it matters | Status |
|---|---|---|
| Session and messaging DAU | Engagement and the bounced cohort | Built |
| Per-user leaderboard | Per-user message volume | Built |
| Sign-up and sign-in funnels | Acquisition and auth conversion | Built |
| Manage users (list, approve at a classification, reject, disable, re-enable, change classification, delete) | Keep access aligned with policy | Built |
| Bulk user operations | Approve or offboard many users at once | Out of scope (roadmap) |
| Act-as-user / impersonation | Reproduce a user's view for support | Out of scope (boundary) |

### Security

| Feature | Why it matters | Status |
|---|---|---|
| Membership-audit findings (member and assistant cross-classification leaks) | Detect over-classification access | Yes (always deployed; report-only or `-c membershipAuditEnforce=true` for auto-revoke) |
| Report-only vs auto-revoke toggle | Runtime enforcement switch, no redeploy | Yes (runtime toggle) |
| Per-finding revoke | Remove a flagged membership and close the finding | Yes |

### Auth / session

| Feature | Why it matters | Status |
|---|---|---|
| Admin sign-in (raw-SDK Cognito `LoginScreen variant="admin"`, no Amplify) | Authenticate to the standalone console | Built |
| Forgot-password flow | Self-serve password reset | Built |
| MFA challenge | Second factor at sign-in | Built |
| New-password (force-change) challenge | First-login password set | Built |
| Sign-out (leaving the console signs out) | End the admin session | Built |
| `admins`-group entry gate (`isAdmin`); non-admin sees access-denied | Only administrators reach the console | Built |
| No self-registration (admins are provisioned) | Admin accounts are not self-minted | Built (deliberate) |
| Fine-grained per-action RBAC, enforced | Deny a specific action (read but not delete) per role | Partial (built and IAM-enforceable per capability behind `adminIamEnforcement`, with four opt-in example persona roles behind `enableAdminPersonas`; default gate is the `admins` group, see A14 below and [`DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md`](../../interaction/identity-access/admin/DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md)) |
| Console audit log (who did what in the console) | Accountability for operator actions themselves | Out of scope (roadmap; actions emit telemetry events today, but there is no in-console log view) |

### System / settings

| Feature | Why it matters | Status |
|---|---|---|
| Shared date preset (7d / 30d / 90d) | Scope every analytics view to a window | Built |
| Analytics-mode detect and badge | Know which backend (Athena / Aurora) is live | Built |
| Mode-honesty banners (unsupported / no-data / API-down) | Never a silently empty or misleading table | Built |
| Metric-targets registry (good / warn / bad) | Show what good is on every measurement surface | Built |
| Help affordances (info tooltips, doc links) | In-context explanation | Built |
| Saved views / custom dashboards / custom date presets | Reuse a tailored slice | Out of scope (roadmap) |
| Analytics export / CSV download | Take data out for offline analysis | Out of scope (roadmap) |
| Scheduled or emailed reports | Push metrics without opening the console | Out of scope (roadmap) |
| Consolidated in-console Alerts view (a metric in `bad`/`warn` surfaced in one health view) | Read every breaching metric in one place, each linking to its drill | Built (Overview > Alerts, Aurora; see the Overview section) |
| External alerting / paging on a target breach (email, SNS, PagerDuty) | Be pushed a notification off-console when a metric crosses its target | Out of scope (roadmap; the console consolidates and links, it does not page) |
| In-console assistant-profile editing | Version, edit, activate, roll back, import, and export assistant profiles in place | Built (Assistants section) |
| In-console classification-definition editing | Edit classification definitions in place (user classification *assignment* is Built under Users) | Out of scope (roadmap) |
| Data-retention configuration UI | Set archive or projection retention from the console | Out of scope (roadmap) |
| Multi-org / multi-tenant management | Administer several instances or tenants from one console | Out of scope (boundary; one console administers one instance) |

The saved-views / custom-dashboards, analytics export / CSV download, and scheduled / emailed reports rows above are BI-analyst-motivated (see the BI analyst persona): the analyst's primary path is AWS-native (QuickSight / Athena on the governed archive, the data-in-your-account model), so these console-side conveniences are roadmap, not the mechanism by which the analyst gets data out.

**Acceptance criteria:** An operator can, from one app, (a) open any conversation and read it, redact or delete a message, and see who joined or left and when; (b) read platform health, latency SLOs, and error rate over a chosen window; (c) in Aurora mode, rank intents by quality and drill to a single turn's tool loop; (d) create and read an experiment with a ship recommendation; (e) approve a pending user at a classification and later delete them; (f) see and revoke a cross-classification membership leak; (g) sign in with MFA and be denied entry when not in the `admins` group. Athena mode serves every non-Aurora view and honestly labels the rest. Every privileged read and action is attributable to an identity and audited.

## 5. Non-goals

- **Not a chat client.** The console reads and administers conversations; it does not send assistant or user messages.
- **Not channel-level moderation config.** The console performs cross-conversation administration as an app-instance administrator; promoting a channel creator or member to moderate a single channel is a separate concern (see [`SPEC-MODERATION.md`](../../interaction/identity-access/core/SPEC-MODERATION.md)).
- **Not external paging.** The console consolidates breaching metrics into an in-console Alerts view and links each to its drill; pushing an off-console notification (email, SNS, paging) on a target breach is a later, separate concern.
- **Not traffic control.** Experiment ship recommendations are descriptive only; the console never reroutes live traffic.
- **Not admin-role management.** This surface manages the classification groups for users and versions assistant profiles; it does not grant or revoke admin status, and it does not provision the per-human administration identity.
- **Not impersonation or multi-tenant.** The console never acts as a user, and one console administers one instance.
- **Not a second data store.** The console reads existing stores (archive, analytics projection, Cognito, live messaging) and introduces no new system of record.

## 6. Open product questions

- **Fine-grained action authority (A14).** Per-capability IAM enforcement is built and opt-in behind `adminIamEnforcement`, with four example persona roles behind `enableAdminPersonas`; the default gate is still the `admins` group. Whether per-capability enforcement should become the default, and which persona roles a deployment maps to which capability sets, is open. (See [`DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md`](../../interaction/identity-access/admin/DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md).)
- **Compliance read calibration.** Legal and workplace conversation reads are high-sensitivity; the accountability-logging calibration for those reads (what is logged, retained, and surfaced to the subject) is a per-deployment policy decision defined with the admin identity model.
- **Console self-audit.** Admin actions emit telemetry events, but there is no in-console log of operator actions; whether the console should surface its own audit trail (and to whom) is open.
- **Consolidation cadence.** The Effectiveness dashboard is the consolidation target for Evaluations, Flows, Tasks, and Steps; the order and pace of folding each standalone sub-view into the drill without losing information is an ongoing call.
- **Athena parity expectations.** Several quality views are Aurora-only; whether any warrants an approximate Athena rendering versus staying honestly gated is open.

## Related

- [`DESIGN-ADMIN-CONSOLE.md`](DESIGN-ADMIN-CONSOLE.md) - how the console is built (architecture, data sources, APIs, flows, security, testing).
- [`DESIGN-SEPARATE-ADMIN-APP.md`](DESIGN-SEPARATE-ADMIN-APP.md) - the standalone admin app split (workspace packages, invariant, CORS, deploy).
- [`SPEC-ADMIN-IDENTITY.md`](../../interaction/identity-access/admin/SPEC-ADMIN-IDENTITY.md) - who an admin is and how administration authority is vended and audited.
- [`SPEC-MODERATION.md`](../../interaction/identity-access/core/SPEC-MODERATION.md) - channel-level moderation, distinct from cross-channel administration.
- [`SPEC-CONVERSATION-SECURITY.md`](../../interaction/identity-access/core/SPEC-CONVERSATION-SECURITY.md) - the layered access model; the Security section is Layer 6.
- [`SPEC-ACCESS-AND-CONTROLS-AUDITING.md`](../../interaction/auditing/SPEC-ACCESS-AND-CONTROLS-AUDITING.md) - the analytics data sources and audit events.
- [`ADMIN-GUIDE.md`](../../../guides/admin/ADMIN-GUIDE.md) - operator-facing usage.
