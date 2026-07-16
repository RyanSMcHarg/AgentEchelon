# AgentEchelon Roadmap

**Status:** Pre-launch. The core platform is built and functional - intent-based routing, A/B testing, resilience, the admin dashboard, and Aurora mode are all in place. The remaining work is launch validation.

---

## Current State

`AgentEchelon` is an enterprise-shaped conversational AI platform built on Amazon Chime SDK Messaging and Amazon Bedrock, MIT licensed. Core flows are end-to-end implemented:

- Cognito auth with self-signup, email verification, admin approval, automatic token refresh
- Platform stacks: ChimeMessaging, CognitoAuth, S3Storage, Foundations, Experiments, the per-tier `AgentEchelonTier-{Basic,Standard,Premium}` stacks, Notifications, IAMPolicies, ChannelFlow, Frontend, and Analytics - plus the opt-in Battle stack and, in Aurora mode, AnalyticsAurora
- Per-tier async-processors (Basic/Standard/Premium) with tier-gated model access, each running the self-hosted Converse tool loop
- Intent-based model routing with tier-safe resolution and configurable fallback chains
- Bedrock resilience: retry with exponential backoff, model fallback, circuit breaker for quota protection
- A/B testing framework: DynamoDB-backed experiments, deterministic variant assignment, admin UI
- Async processor core with placeholder + async update pattern
- Intent classification with Bedrock Haiku and fast-path keyword matching
- Delivery option routing (DIRECT, PLACEHOLDER_UPDATE, TASK_MULTI_STEP)
- DynamoDB task state machines for multi-turn workflows
- S3 file attachments with presigned URLs
- Real-time chat UI with conversation sidebar and pulsing task indicators
- Admin dashboard (6 sections grouping the base + Aurora-only views, including Experiments for A/B testing)
- Kinesis → Firehose → S3 → Athena analytics pipeline (default Athena mode)
- SES email sharing for conversations
- ~55 Playwright E2E tests across 8 spec files (signup, signin, agent intents, admin dashboard, `/battle`, mentions, credential exchange, drift detection)
- **Self-hosted Converse tool loop as the live fulfillment path** - the shared router (Lex FallbackIntent) classifies intent, enforces `min(userTier, channelTier)`, and dispatches to the per-tier async-processor, which runs a `Converse` `toolConfig` loop calling the tier-scoped `load_company_context` retrieval under its own S3 IAM.
- **Channel Flow Processor** for `@all` broadcast routing and `@assistant` mention interception in multi-user channels
- **Bedrock Guardrails** attached to all agents (PII filters, prompt-injection detection, metadata-marker scrubbing) + an image-output guardrail construct for `/battle` generation-out
- **Optional Aurora PostgreSQL + VPC mode** (`analyticsMode=aurora` CDK context flag) - opt-in deployment adds pgvector + RDS Proxy + IAM auth + 4 advanced admin dashboard tabs; remaining work is the ≥7-day soak on a real deploy

---

## P0 - Launch Readiness (Blocks Public Release)

### Must-Fix Before GitHub Public Release

**Effort:** In-flight feature + launch validation | **Risk:** Low (most items are deploy validation; one new code feature)

1. **`/battle` multi-assistant feature** - Adversarial reply mode where two A/B-experiment variants respond to the same prompt in parallel + round-2 rebuttals. Spans single-turn → `TASK_*` report/document battles → image battles (vision-in + generation-out), plus a three-axis scorecard (time / cost / human pick-the-winner) and per-step latency/model/cost telemetry visible to admins and users. Authoritative scope: `docs/specs/experiments-battle/SPEC-BATTLE.md`. Generation-out is a net-new model + image-guardrail modality. Open-source posture: ship a basic default image-output guardrail; production moderation is the deployer's documented responsibility, not an internal AppSec gate.
2. **Drift convergence - hardened design (path C)** - cosine-similarity drift detection (no string matching), live-suggestion + new-channel flow, cross-user + multi-member privacy scoping, by-reference telemetry. Full design in `docs/specs/analytics-eval/SPEC-DRIFT-CONVERGENCE.md`. Remaining: eval-suite soak (target ≥95% TPR / ≤5% FPR), Aurora-mode validation on a clean deploy.
3. **Clean CDK deploy to a fresh AWS account** - Identify and remove any hardcoded account IDs, paths, or prior-deployment artifacts. Validate end-to-end deploy in under 30 minutes.
4. **All Playwright E2E tests passing against fresh deploy** - the existing suite plus the `/battle` E2E (`tests/e2e/battle.spec.ts`). Make any pre-existing dependence on previously created users or channels self-contained.
5. **Evaluation runner backend wiring** - The Lambda is scheduled and the prompt is defined, but the integration to the Athena query path and dashboard data surfacing needs completion.
6. **Admin dashboard backend integration** - Wire each tab to its data source. The battle-fields-in-Experiments-tab work is part of item 1.
7. **README consumption examples** - Copy-paste CDK snippets, `.env` template, system prompt customization guide, `/battle` setup walkthrough.
8. **CONTRIBUTING.md review** - Issue/PR templates, code style, test requirements.
9. **Security review** - IAM least-privilege per stack, no secrets in CDK context, CORS configuration, API Gateway throttling, `systemPromptAddendum` sanitization (per SPEC-BATTLE.md).
10. **Cost estimate** - Document expected monthly cost for a fresh deploy (Athena mode baseline). Battle adds up to 4× the per-invocation cost for simple turns, **more for `TASK_*` (multi-step chains × 2 bots) and image generation-out (per-image pricing)**; document the premium-tier gate plus the per-battle cost guard as the cost-control mechanisms. The user-facing scorecard surfaces est. cost per variant from `MODEL_RATE_TABLE`.

### Should-Fix (Strengthens Launch)

**Effort:** S (1 week)

1. **Screenshots and GIFs** of the widget and admin dashboard in the README
2. **Quick Start script** - One command to deploy, create a test user, and open the widget
3. **Demo video** - 2-3 minutes showing signup → conversation → admin dashboard
4. **GitHub Actions CI** - E2E tests on PR, CDK synth validation on push
5. **Published to AWS Community Builder blog** or similar for initial visibility

### Done When

A new user can clone the repo, follow the README, deploy to a fresh AWS account in under 30 minutes, and have a working conversational AI system with admin dashboard.

---

## P1 - First Post-Launch Iterations

### 1. Stabilization and Bug Fixes

**Effort:** Ongoing

Respond to GitHub issues from early adopters. Fix deployment edge cases, document environment-specific gotchas, improve error messages.

A latent shape has been hardened: WebSocket handlers that only checked content markers on `CREATE_CHANNEL_MESSAGE` events could miss the same markers when they arrived via `UPDATE_CHANNEL_MESSAGE` (e.g. an async-processor placeholder update). All four AE-relevant markers (NAVIGATE_CHANNEL, Lex JSON unwrap, ACTIVE_TASK, FEEDBACK) route through a single `parseMessagePayload` invoked on both CREATE and UPDATE; the navigation-action handler is wired into both `handleMessageCreate` and `handleMessageUpdate`. Architectural invariant captured in `MessagingProvider.tsx`: marker extraction lives only inside the shared parser, so any new marker is automatically safe.

### 2. Documentation Deepening

**Effort:** S (3-5 days) - narrower than originally scoped because the architecture deep-dive landed pre-launch

**Shipped:** `docs/overview/ARCHITECTURE.md` (harness pattern, delivery options, intent classification end-to-end), `docs/guides/user/TROUBLESHOOTING.md` (symptom→diagnosis→fix runbook), `docs/guides/admin/AURORA-MODE-GUIDE.md`, `docs/guides/user/IDENTITY-PROVIDER-GUIDE.md` all exist.

**Outstanding:**
- Tutorial: "Adding a new tool to the agent" (Action Group walkthrough)
- Tutorial: "Customizing the tier model" (adding a new tier or remapping intents)
- Tutorial: "Replacing the default system prompts"
- FAQ - common deploy/auth/Bedrock-model-access stumbles, distilled from the TROUBLESHOOTING runbook plus early-adopter issues

### 3. `/battle` generation-out: resilient image-model source

**Effort:** M | **Risk:** Medium (provider/model availability churn)

**Motivation:** the two locked-decision image models, `amazon.titan-image-generator-v2:0` and `amazon.nova-canvas-v1:0`, are now **LEGACY-locked** on Bedrock - AWS blocks them for accounts that haven't used them in 30 days, and there is **no self-serve access-grant** (it is a deprecation, not an access gate). On the test account *no* ACTIVE pure text-to-image generator exists (only Stability *editing* ops: upscale/inpaint/outpaint/bg-remove). The gen-out feature is code-complete and model-agnostic (registry-driven) but currently has no live model to point at there.

**Scope:**
- Survey + adopt a currently-ACTIVE Bedrock text-to-image model. Evaluate **Stability** (`stability.sd3-5-large-v1:0` / `stability.stable-image-core-v1:1` / `stable-image-ultra` - confirm they expose true *text→image* generation, distinct from the editing suite, and the request/response schema, since it differs from the Titan/Nova `TEXT_IMAGE` body the current shaper assumes). Add a Stability shaper/parser to `image-gen-models.ts` alongside the existing one (the registry already abstracts per-model defs).
- Make the registry **provider-pluggable** and lifecycle-aware: prefer ACTIVE models, surface a clear deployer error when a configured model is LEGACY/locked (instead of a runtime `ResourceNotFoundException`), and let the admin editor list only currently-invokable models.
- Optional fallback: an **external image generator** (deployer-supplied HTTP endpoint / API key) the gen-out path can call when no Bedrock image model is enabled, returning the image into the same S3 + `<!--battleimage-->` pipeline. Strictly opt-in, deployer-owned (keys, cost, content policy) - consistent with the OSS no-central-operator posture.
- Keep the honest-empty contract throughout (no model / blocked / failed ⇒ honest text, never a fabricated image).

---

## P2 - Advanced Features

### 1. Optional Aurora PostgreSQL + VPC Analytics Mode - CODE-COMPLETE, AWAITING SOAK

**Spec:** [SPEC-AURORA-VPC-MODE.md](docs/specs/analytics-eval/SPEC-AURORA-VPC-MODE.md)
**Status:** Code-complete and CDK-wired. Opt-in via `--context analyticsMode=aurora`. Default remains Athena mode.

**What ships in v0.2.0:**
- AnalyticsStackAurora CDK construct: VPC (2 AZ), Aurora Serverless v2 with RDS Proxy + IAM auth, VPC endpoints for Kinesis / S3 / Secrets / Bedrock
- 9 schema migrations under `analytics-aurora/schema/`: initial tables, pgvector extension, materialized views, A/B experiments, summary embeddings (1024-dim HNSW), drift-events hardened (by-reference), conversation-creation-tasks (drift suggestion durability), document embeddings, drift-reasoning decision
- Lambdas: `db-client` (IAM auth + pooling), `schema-init` (CFN custom resource), `kinesis-archival` (exchange pairing), `drift-detection` (cosine-NN), `cross-conversation-context`, `analytics-query` (7 endpoints), `summary-updater` (scheduled), `embedding-writer`, `abandonment-detector` (scheduled), `evaluation-runner` (daily)
- Admin dashboard: 4 Aurora-only tabs (Flows, Flagged, Ground Truth, Conversations drift sub-view)
- `enableLiveDrift` cross-stack feature flag wired into the router-agent-handler
- Per-stage EMF metrics + UUIDv7 correlation IDs on every drift evaluation
- 110-case shared eval-suite fixture (50 positive + 50 negative + 10 prompt-injection)
- Aurora-mode user guide (`docs/guides/admin/AURORA-MODE-GUIDE.md`)

**Remaining for launch sign-off:**
- E2E test pass against a real Aurora deployment
- ≥7-day soak with stable EMF + eval-suite ≥95% TPR on two consecutive nights (per `docs/specs/analytics-eval/SPEC-DRIFT-CONVERGENCE.md` §Validation)

**Cost impact when enabled:** ~$75/month baseline increase (Aurora 0.5 ACU × 2 AZ + RDS Proxy + 3 interface VPC endpoints). Athena mode stays the default for cost-sensitive deployments.

### 2. Channel Flows Pre/Post-Processing Framework

**Effort:** M (2-3 weeks) | **Risk:** Medium (new runtime hook)

**State:** the Channel Flow runtime + processor exist today (`backend/lambda/src/channel-flow-processor.ts`, `AgentEchelonChannelFlow` stack). It handles `@all` broadcast routing, `@assistant` mention interception, and message filtering. What's NOT yet generalized is the **pluggable handler API** - consumers can't drop in their own ordered pre/post-handlers (PII redaction, content moderation, multi-channel egress) without modifying the processor itself.

**Scope:**
- Extract the existing processor logic behind a `ChannelFlowHandler` interface (`{ name; run(context): Promise<HandlerResult> }`)
- Ordered registry consumers extend at deploy time via CDK context or a config file
- Pre-handlers run before the Bedrock Agent invocation; post-handlers run on the response before the broadcast
- Maintain the existing `@all` / `@assistant` / filtering behaviors as built-in handlers in the default registry
- Tests proving order, short-circuit (a handler can drop the message), and error isolation (one handler's failure doesn't poison the chain)

This is the foundation for any future deterministic content-filter, deny-list, or multi-channel-egress extension.

### 3. Cross-Channel Task Continuity

**Effort:** M (2 weeks) | **Risk:** Low

Today's `task-tracking.ts` keys active tasks by channel. Adding a user-identity-keyed discovery path lets a user start a multi-step workflow (booking, document drafting, troubleshooting) in one channel and continue it in another - the agent finds all active tasks for the caller across channels they're members of and injects them into the system prompt regardless of where the message arrives.

Depends on: existing task tracking (shipped).

### 4. Bedrock Knowledge Bases for RAG

**Effort:** M (1-2 weeks) | **Risk:** Low

Optional integration with Bedrock Knowledge Bases for semantic retrieval. Shrinks system prompts by moving static context into OpenSearch Serverless with per-tier isolation. Particularly valuable for consumers who ship long system prompts or frequently updated content. ADRs already exist in `docs/design/decisions/` (`001-kb-backing-aurora-vs-oss.md`, `003-kb-scoping-per-channel-vs-global.md`, `007-kb-permission-metadata-filters.md`, `008-embedding-cost-and-ttl-policy.md`); no code yet.

### 5. Re-home the proactive briefing onto a per-tier assistant

**Effort:** S (2-3 days) | **Risk:** Low

The proactive-briefing workflow points at the **basic-tier**
assistant (`/agent-echelon/tier/basic/bot-arn`) - every scheduled briefing
conversation is created and answered by the basic assistant regardless of the
recipient's tier. That is correct for separation (no shared cross-tier
identity) but flattens the tier experience. Re-home it so the briefing picks
the assistant matching each recipient's enforced tier (premium recipients get
the premium assistant + premium models/context), tagging the created channel
`classification=<tier>` like every other conversation. Depends on: per-tier
separation (shipped) + Layer 1 channel tagging (shipped).

### 6. Conversation Types + Connectors + Federated Participants (Enterprise Interaction Layer)

**Effort:** L - XL (multi-phase) | **Risk:** Medium | **Status:** Step 1 (Credential Exchange) is the shipped foundation; the remaining build steps (connectors, comms, federated participants) are designed and staged.

The generalization that turns AE from a tiered chat tool into a configurable interaction layer for
support / sales / service / incident-triage use cases that connect internal staff to external customers
through existing business systems - **integrating with** the customer's IdP, routing, and systems of
record rather than migrating into AE. Use-case-led; concepts harvested from (not converged to) the
pre-convergence design specs. Canonical design across four specs:
- `docs/specs/conversation-messaging/SPEC-CONVERSATION-TYPES.md` - conversation type = a composable policy bundle (classification +
  drift + agents + commsChannels + participants + connectors); the type *carries* the IAM classification,
  never adds one. **Forward-compat contract** so growth never breaks deployed channels.
- `docs/design/SPEC-FEDERATED-PARTICIPANTS.md` - full-stack handling (IdP → creds → AppInstanceUser → messaging)
  for externally-resolved humans; prefer embedding the AE experience, connector-proxy as fallback.
- `docs/specs/identity-access/SPEC-CREDENTIAL-EXCHANGE.md` - **Step one / foundation** (below).

**Step one - Credential Exchange Service (the shipped foundation).** Following
IDENTITY-PROVIDER-GUIDE Approach 2, a backend exchange vends STS creds with a `sub` session tag so
`tierChannelScopedAllow` pins the ChimeBearer to the caller's own AppInstanceUser. The exchange is the
sole source of Chime credentials - there is no Identity-Pool fallback - so a caller can only act as its
own AppInstanceUser (no bearer impersonation, no create/moderator over-grant); the same pinning covers the
assistant-bearer (`/bot/*`) and the full-lifecycle delete path. This is also the federation credential
substrate - one piece of work. Build sequence + dependency
chain in SPEC-CONVERSATION-TYPES §7: **exchange → federated participants → `resolveParticipant` → routed
Support/Service/Triage**; the system-of-record connector (Jira `syncRecord`) + the conversation-type seams
don't touch human identity and can run alongside. Connectors are **broad per-vendor** (Salesforce /
ServiceNow / Jira / AWS Support / Twilio / PagerDuty) with capabilities `resolveParticipant` / `syncRecord`
/ `fetchContext` / `provideComms` / `ingest`, riding a normalized `PlatformEvent` taxonomy + per-tenant
credential isolation.

Depends on: per-tier separation (shipped) + Layer 1 channel tagging (shipped) + the conversation-type +
connector schema seams (shipped, non-breaking, in `backend/lib/config/`).

### 7. Internal vs. external guardrail posture (constrained intents/workflows)

**Effort:** M | **Risk:** Medium | **Depends on:** Conversation Types (§6), moderation

Today's routing is intentionally **open**: the intent classifier + `INTENT_ROUTE_STRATEGY` let a user
ask anything and the assistant does its best. That flexibility fits **internal** use cases, where trusted
staff benefit from an open-ended assistant. **External-facing** deployments need the opposite posture:
constrain users to a set of **approved use-cases / intents / workflows**, reject or safe-fallback anything
outside them, and apply stricter guardrails - the conversation is a bounded workflow, not an open chat.
This item adds a per-conversation-type "intent allow-list + out-of-scope handling" policy (a natural home
is the `SPEC-CONVERSATION-TYPES.md` policy bundle) so a deployer chooses open (internal) vs. constrained
(external) per conversation type, rather than one global stance. The principle - *open internal, strict
external* - should eventually be codified in `docs/overview/TENETS.md`. Cross-links: `docs/specs/conversation-messaging/SPEC-CONVERSATION-TYPES.md`,
`docs/specs/identity-access/SPEC-MODERATION.md`.

---

## P3 - Future Exploration

### 1. Advanced Evaluation Module

**Effort:** L (3-4 weeks) | **Depends on:** Aurora mode

Two-pass Haiku/Sonnet evaluation, error pre-detection, adversarial-aware classification, intent flow evaluation, ground-truth calibration. Ships as an optional evaluator module that replaces the basic evaluation runner with the advanced patterns when Aurora mode is enabled. (Drift detection already uses cosine + the 110-case eval-suite fixture; this would extend evaluation rigor to the broader response-quality dimension.)

### 2. Multi-Party Privacy / Membership Intersection (broadened)

**Effort:** M (1-2 weeks)

Drift detection already enforces a multi-member intersection scope (see `lib/scoped-channels.ts`). This item generalizes the same filter to cross-conversation context retrieval and any future RAG path so users never see notes from conversations they're not in. The pattern exists; this is extending it.

### 3. Voice Integration (PSTN + WebRTC) - reference-guide track

**Effort:** XL (6+ weeks) | **Risk:** High

A reference guide for voice integration using Chime Voice Connector and SMA Lambdas. Calls would land in the same Chime channel as chat with transcriptions posted as persistent messages. Deployment specifics (SIP trunking provider, phone-number provisioning) are too site-specific to ship as a drop-in module - likely a "how to wire this yourself" guide rather than code.

### 4. Meeting Integration - reference-guide track

**Effort:** XL (4+ weeks) | **Risk:** Medium

Same posture as voice: a reference guide for linking Chime SDK Meetings video/audio calls to chat conversations, with meeting transcripts and summaries posting back to the parent channel. Site-specific details need generalization that's easier delivered as docs than code.

### 5. Multi-Region / Multi-Tenant Aurora

**Effort:** XL (4-6 weeks) | **Depends on:** Aurora mode

Multi-region Aurora global database and tenant isolation via PostgreSQL row-level security or schema-per-tenant. For consumers running AgentEchelon as a SaaS product where a single deployment serves many tenants.

### 6. Emerging-intent observability (report common + poorly-performing questions)

**Effort:** M | **Depends on:** analytics/evaluation data (Aurora mode)

A **reporting/observability** surface - not an auto-reactive intent engine - that highlights the questions
users ask that are both **high-frequency** and **low-quality** (long TTFF, low eval score, guardrail hits,
thumbs-down, or "the assistant couldn't answer"), so a team can see where the assistant is underperforming
at scale and decide how to improve it: refine `INTENT_ROUTE_STRATEGY` / the intent pack, adjust the tier
floor, add context, or add a dedicated tool. It surfaces *what to investigate*; humans still decide the
change. The signals already exist (per-message analytics, the evaluation runner, drift, feedback) - this is
a rollup/dashboard over them, ranked by frequency × poor-performance. Motivating example: the tier-floor
routing fix (premium general questions were silently answered by Haiku) is exactly the kind of systemic
under-performance such a report would have flagged early. Ties into the P3 Advanced Evaluation Module.

---

## Priority Summary

### Shipped in v0.2.0 (not on the post-launch roadmap because they're done)
- **Self-hosted Converse tool loop** - tier-scoped `load_company_context` retrieval as the live fulfillment path
- **Per-tier ownership** - independently-deployable `AgentEchelonTier-*` stacks, SSM-only contract, deployed + validated end-to-end (`docs/specs/assistant-context/SPEC-PER-TIER-OWNERSHIP.md`)
- **One class per tier** - `BasicTierStack` / `StandardTierStack` / `PremiumTierStack` in three files; shared SSM contract centralised in `agent-tier-common.ts`. Practical guide: `docs/guides/developer/HOW-TO-ADD-OR-MANAGE-A-TIER.md`
- `@all` mention routing via Channel Flow Processor (routed to the tier processors)
- Bedrock Guardrails per tier (text; out-of-band `ApplyGuardrail` on the tool-loop output) + an image-output guardrail for `/battle` generation-out. Default guardrail scoped to harmful-content/PII only - no over-broad topic-DENY (OSS + seeded-context posture)
- Aurora PostgreSQL + VPC mode - code-complete, opt-in, awaiting soak (see P2 §1)

### Post-launch backlog

| Priority | Item | Effort | Risk | Notes |
|----------|------|--------|------|-------|
| P0 | **`/battle` multi-assistant feature** | **Core validated; remaining S - M** | **Med (image gen-out modality)** | **Core single-turn duel validated end-to-end on the deployed stack. Remaining: round-2/`TASK_*` soak, and image gen-out (blocked on an active Bedrock image model - see P1 §3). `docs/specs/experiments-battle/SPEC-BATTLE.md`** |
| P0 | Launch readiness (must-fix, other items) | M | Low | Blocks public release |
| P0 | Launch readiness (should-fix) | S (1w) | None | Strengthens launch |
| P1 | Stabilization and bug fixes | Ongoing | - | Post-launch support |
| P1 | Documentation deepening (tutorials + FAQ) | S (3-5d) | None | Architecture deep-dive already shipped; remaining is tutorials |
| P1 | **`/battle` generation-out resilient image-model source** | M | Medium | Titan/Nova LEGACY-locked; need active model + provider-pluggable shaper |
| P2 | **Aurora PostgreSQL + VPC mode - soak** | S (~7-10 days) | Low | Code-complete; gate is the multi-day soak per `docs/specs/analytics-eval/SPEC-DRIFT-CONVERGENCE.md` §Validation |
| P2 | Channel Flows pluggable-handler API | M (2-3w) | Medium | Runtime already exists; this generalizes it for deployer extension |
| P2 | Cross-channel task continuity | M (2w) | Low | User-identity-keyed task discovery |
| P2 | Bedrock Knowledge Bases for RAG | M (1-2w) | Low | ADRs decided, no code |
| P2 | Internal vs. external guardrail posture (constrained intents/workflows) | M | Medium | Open internal, strict external; per-conversation-type intent allow-list |
| P3 | Advanced evaluation module | L (3-4w) | Low | Depends on Aurora mode |
| P3 | Emerging-intent observability (common + poorly-performing questions) | M | Low | Rollup over analytics/eval to prioritize intent/routing improvements |
| P3 | Multi-party privacy generalization (beyond drift) | M (1-2w) | Low | Pattern shipped in drift; this extends it |
| P3 | Voice integration (PSTN + WebRTC) - reference guide | XL (6+w) | High | Most likely docs, not code |
| P3 | Meeting integration - reference guide | XL (4+w) | Medium | Most likely docs, not code |
| P3 | Multi-region / multi-tenant Aurora | XL (4-6w) | Medium | SaaS deployment pattern |

---

## Versioning Strategy

- **0.1.x** - Pre-launch development (current)
- **0.2.0** - First public release (P0 complete)
- **0.3.0** - First post-launch iteration (P1 items land)
- **0.4.0** - Aurora mode and Channel Flows framework (P2 items land)
- **1.0.0** - Advanced patterns extracted and stable; API considered stable for production consumers

Pre-1.0 releases may have breaking changes between minor versions. Post-1.0 follows semver.
