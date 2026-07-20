# AgentEchelon, AI Assistant Guide (vendor-neutral)

> **This is the vendor-neutral guide for any AI coding assistant** (OpenAI Codex, Gemini CLI,
> Claude Code, or others) working in this repository. It is a convenience layer, not a
> requirement: the authoritative, assistant-neutral documentation is `README.md`,
> `docs/overview/ARCHITECTURE.md`, and `docs/guides/user/TROUBLESHOOTING.md`. Start there regardless of which
> assistant (if any) you use.
>
> Tool-specific wrapper files defer to THIS file: `CLAUDE.md` (auto-loaded by Claude Code) and
> `GEMINI.md` (Gemini CLI) are thin pointers here plus any notes unique to that tool. Codex reads
> `AGENTS.md` natively. Keep the guidance in one place (this file) so the tool wrappers do not
> drift.

## Project Overview

Enterprise conversational AI interface built on React 19 and AWS CDK. Users chat with AI agents
(Claude Opus/Sonnet/Haiku, Amazon Nova) over Amazon Chime SDK real-time messaging. Three user
tiers (Basic/Standard/Premium) control model access via Cognito and IAM policies. An optional
Aurora PostgreSQL mode enables advanced evaluation, drift detection, and cross-conversation
context.

## Build and Run Commands

```bash
# Frontend
cd frontend && npm ci && npm run dev           # Dev server at localhost:5173 (npm ci = exact, lockfile-pinned install)
cd frontend && npm run build                    # Production build (Vite to frontend/dist)
cd frontend && npm run lint                     # ESLint

# Frontend, production hosting (DEFAULT path: CloudFront + S3)
# The AgentEchelonFrontend stack (deployed by `cdk deploy --all`) provisions an empty
# bucket + CloudFront distribution. The build is synced out-of-band because the
# Vite bundle bakes in CDK outputs (see docs/guides/user/FRONTEND-DEPLOY.md):
cd backend && npm run deploy-frontend          # build frontend + sync to S3 + invalidate CDN
cd backend && npm run deploy-frontend -- --no-build   # publish an existing frontend/dist

# Backend, Athena mode (default, ~14 stacks; 13 with -c enableBattle=false)
cd backend && npm ci
cd backend && npx cdk deploy --all              # Deploy all stacks
cd backend && npx cdk diff                      # Preview changes
cd backend && npm test                          # Jest tests (the gate)
cd backend && npm run build                      # tsc, deployable build typecheck (test/ excluded)
cd backend && npm run typecheck                  # tsc -p tsconfig.test.json, typecheck the test tree (Bundler res.)

# Backend, Aurora mode (same stack count; swaps Analytics to AnalyticsAurora, adds VPC + Aurora; RDS Proxy is opt-in via -c enableRdsProxy=true)
cd backend && npx cdk deploy --all --context analyticsMode=aurora

# E2E Tests (requires frontend running + deployed backend)
# One-time per deploy: create the tier test users + write the test-credentials
# secret the suite reads (idempotent; re-run after every redeploy):
cd backend && npm run provision-test-users
cd tests && npm ci && npx playwright install chromium
cd tests && npm test                            # All tests
cd tests && npm run test:signup                 # Signup suite only
cd tests && npm run test:signin                 # Signin suite only
cd tests && npm run test:agents                 # Agent interaction suite
cd tests && npm run test:headed                 # Headed mode (visible browser)
cd tests && npm run test:report                 # View HTML report
```

## Session Setup

Before making changes, verify:
1. AWS credentials configured (`aws sts get-caller-identity`)
2. Bedrock model access enabled (Opus, Sonnet, Haiku, Amazon Nova in us-east-1)
3. `frontend/.env` populated with CDK stack outputs (use `.env.example` as template)
4. If Aurora mode: schema migrations have run (and, only if `-c enableRdsProxy=true`, RDS Proxy is healthy; the default path is direct writer-endpoint IAM auth)

## Architecture

For the full end-to-end treatment, read `docs/overview/ARCHITECTURE.md`. This section is the map.

### Frontend Provider Hierarchy (order matters)
```
AuthProvider -> AwsClientProvider -> MessagingProvider -> ConversationProvider
```
Each provider depends on the one above it being initialized. AuthProvider handles Cognito
tokens, AwsClientProvider creates SDK clients with Identity Pool credentials, MessagingProvider
manages the Amazon Chime SDK WebSocket session, ConversationProvider handles conversation/message
state.

### Backend CDK Stacks

The backend is composed of independently-deployable feature stacks rather than one monolith:
`/battle` is `AgentEchelonBattle`; each assistant tier is its own `AgentEchelonClassification-*` stack
(owning its async processor, Lex bot, and AppInstanceBot); experiments are
`AgentEchelonExperiments`; shared task tables plus create-conversation/add-agent are
`AgentEchelonFoundations`. Each tier's code is independently owned. See
`docs/specs/assistant-context/SPEC-PER-PROFILE-OWNERSHIP.md`.

**Always deployed (both modes):**
1. `AgentEchelonChimeMessaging`, Amazon Chime SDK AppInstance (foundation)
2. `AgentEchelonCognitoAuth`, User Pool, Identity Pool, Cognito triggers, per-classification Identity-Pool roles (generated from config)
3. `AgentEchelonS3Storage`, file attachment bucket with presigned URLs
4. `AgentEchelonFoundations`, shared task-tracking tables (`agent-tasks` + `user-tasks`) + the abuse-controls table (rate limit / spend budget / request dedup) + the conversation-actions audit table + create-conversation/add-agent + conversation-management (archive / remove-member / leave) APIs + their SSM contract (hosts no bot)
5. `AgentEchelonExperiments`, A/B experiments table + admin-experiments API (`/admin/experiments`); publishes the experiments SSM contract
6. `AgentEchelonClassification-{Basic,Standard,Premium}`, per-profile assistant stacks: each is a thin subclass of the shared `AssistantProfileStack` supplying a `ProfileTopology`; the one shared `assistant-async-processor.ts` (self-hosted Converse tool loop, no Bedrock Agent) serves every profile, with per-profile context IAM + content guardrail + Lex bot + AppInstanceBot
7. `AgentEchelonNotifications`, SES email identity + conversation sharing + proactive-briefing EventBridge workflow (`lambda/src/proactive-briefing.ts`; recipients/schedule via `briefingRecipients`/`briefingScheduleRate` context)
8. `AgentEchelonChannelFlow`, Channel Flow Processor for @all + /battle routing + message filtering
9. `AgentEchelonFrontend`, the default production frontend hosting: private S3 origin + CloudFront (OAC, SPA error mapping, security response headers, managed-rules WAF on by default). Provisions an EMPTY bucket + distribution; the Vite build is synced out-of-band by `npm run deploy-frontend` (it bakes in CDK outputs, so a BucketDeployment cannot run inside the stack). After first deploy, set `--context appUrl=https://<DistributionUrl>` and redeploy so backend CORS allows the app origin. See `docs/guides/user/FRONTEND-DEPLOY.md`.

**Opt-in:**
- `AgentEchelonBattle` (default-on; `-c enableBattle=false` to omit), /battle alt-bot slot pool + battle-owned Lex + orchestrator + battle tables + channel-battle/outcome APIs; battle eligibility is the per-profile `battleEligible` field in `profiles.ts` (premium by default)

**Athena mode (default):**
- `AgentEchelonAnalytics`, Kinesis to Firehose to S3 to Glue to Athena pipeline + client-events `/events` API

**Aurora mode (opt-in via `--context analyticsMode=aurora`):**
- `AgentEchelonAnalyticsAurora`, VPC (created by default, or import an existing one with `-c analyticsVpcId=`), Aurora Serverless v2, optional RDS Proxy (opt-in via `enableRdsProxy`; default is direct writer-endpoint IAM auth), Kinesis archival, evaluation runner, analytics API. Live drift detection is opt-in (`-c enableLiveDrift=true`, default off, Aurora-mode only); it runs conversation-level in the per-tier message path.

### Key Directories

| Path | Contents |
|------|----------|
| `frontend/packages/chat/src/components/` | React UI components |
| `frontend/packages/admin/src/components/admin/` | Admin dashboard sections including Overview, Conversations, Quality, Models, Experiments, Users, and Membership Audit (Layer 6 review plus the report-only vs auto-revoke toggle). See `docs/guides/admin/ADMIN-GUIDE.md`, `docs/specs/admin-console/SPEC-ADMIN-CONSOLE.md`, `docs/specs/identity-access/SPEC-ADMIN-IDENTITY.md`, `docs/specs/identity-access/SPEC-MODERATION.md`. |
| `frontend/packages/{chat,shared}/src/providers/` | Context providers (auth, messaging, conversations) |
| `frontend/packages/{admin,chat,shared}/src/services/` | Backend integration (Amazon Chime SDK, S3, analytics) |
| `frontend/packages/shared/src/types/` | TypeScript types (including full Aurora analytics types) |
| `frontend/packages/{chat,shared}/src/utils/` | Message parsing utilities |
| `backend/lib/stacks/` | CDK stack definitions |
| `backend/lib/interfaces/` | Shared interfaces (IAnalyticsStackOutputs) |
| `backend/lambda/` | Lambda handlers (3-tier agents, Cognito triggers, presigned URL) |
| `backend/lambda/src/analytics-aurora/` | Aurora-mode Lambdas (archival, analytics, drift detection, context search) |
| `backend/lambda/src/analytics-aurora/schema/` | SQL migration files (001-initial, 002-pgvector, 003-views, 004-experiments) |
| `backend/lambda/src/channel-flow-processor.ts` | Channel Flow Processor for @all routing and message filtering |
| `backend/lambda/src/lib/` | Shared Lambda libraries (intent classifier, intent pack, delivery options, task tracking, async-processor-core, model-resolver, resolve-model-plan, bedrock-resilience, experiment-manager) |
| `backend/lib/constructs/` | Reusable CDK constructs (bedrock-guardrails) |
| `backend/test/` | Jest unit tests (CDK synth, Aurora modules) |
| `tests/e2e/` | Playwright E2E tests (auth, agents, admin dashboard) |
| `docs/` | Specs and reference docs (see `docs/README.md` for the index) |

### Message Flow

**Message path:**
1. User sends a message via Amazon Chime SDK `SendChannelMessage`
2. The Channel Flow Processor runs first (enforces mention rules for `@assistant`/`@human`/`@all`, filters messages)
3. When the bot should respond, the message routes to the per-tier Lex bot; its fulfillment Lambda (`router-agent-handler.ts`) classifies intent, resolves the tier's async processor, and invokes it. (`@all` bypasses Lex: the Channel Flow Processor invokes the async processor directly and broadcasts.)
4. The async processor runs a self-hosted Converse tool loop (`lambda/src/lib/async-processor-core.ts` `generateResponse`): it calls Bedrock's Converse API, optionally invokes tools, and applies the content guardrail out-of-band. There is no Bedrock Agent.
5. The reply is written back by updating the placeholder message (long replies split into linked continuation messages)
6. The frontend receives the response over the Amazon Chime SDK WebSocket

See `docs/overview/ARCHITECTURE.md` for mention routing, the share flow, model resolution and resilience,
and the Aurora archival path in full.

### Important Patterns (must-know; deep detail in the docs)

- Channels are RESTRICTED + PRIVATE; bot creates channel, user is added as moderator.
- **Tier authorization**: Cognito groups (`basic`/`standard`/`premium`/`admins`) are the authoritative signal for what a user can do. `router-agent-handler.ts` picks `min(userTier, channelTier)`.
- **Message delivery and size (read before producing or extending any channel message)**: Amazon Chime SDK caps are on the encoded length (`encodeURIComponent`): `Content` 4096, `Metadata` 1024, and CJK encodes ~9x per char. Long replies MUST go through `handleLongResponse`/`splitIntoChunks`. Full guide: `docs/guides/developer/MESSAGE-DELIVERY-GUIDE.md`. Canonical code: `backend/lambda/src/lib/async-processor-core.ts`.
- Bedrock Guardrails filter PII, prompt injection, and metadata markers on all agents.
- **Model routing**: `model-resolver.ts` maps a classified request to a model from a configurable strategy, enforcing tier-based access control. Defaults are per-deployment configurable and specific request categories can use different models. See `docs/overview/ARCHITECTURE.md` and `docs/guides/developer/MODEL_STRATEGY.md`.
- **Configurable classification taxonomy (per deployment)**: `lib/intent-pack.ts` loads the taxonomy from the `ASSISTANT_INTENT_PACK` env var (CDK context `assistantIntentPack`). Full design: `docs/specs/assistant-context/SPEC-CONFIGURABLE-INTENT-PACK.md`.
- Bedrock resilience: `bedrock-resilience.ts` provides retry (exponential backoff), model fallback, and a circuit breaker (5 failures / 60s window).
- A/B experiments: `experiment-manager.ts` uses a deterministic MD5 hash of `channelArn + experimentId` for sticky conversation-level variant assignment.
- **Cross-channel task continuity**: tasks are tracked in `AgentTasksTable` (keyed by `taskId, channelArn`) and `UserTasksTable` (keyed by `userSub`). Resume is channel-scoped; cross-channel awareness is prompt-only (a brief hint, never an auto-resume, never a channel ARN leak).
- **Building or changing assistant context / RAG?** Read `docs/guides/developer/GUIDE-ASSISTANT-CONTEXT.md`, `docs/specs/conversation-messaging/SPEC-WELCOME-AND-CONTEXT.md`, and `docs/guides/developer/RAG.md` first. The context model (tier-scoped company context, pgvector RAG, conversation history + summary, welcome/personalization, participant/domain context) spans several docs and is easy to miss and reinvent.

## Configuration

Frontend environment variables live in `frontend/.env` (see `frontend/.env.example`). Backend
deploy-time config is via CDK context. The full, current tables (every variable, its CDK
context key, default, and notes) live in `README.md` under "Configuration". Treat the README as
authoritative for config; this file points there rather than duplicating it.

Typical deploy:
```bash
cd backend && AWS_PROFILE=<your-profile> npx cdk deploy --all \
  --context senderEmail=you@example.com \
  --context appUrl=https://your-frontend-url
```

After deploying, run these once to backfill the group + channel-flow state:
```bash
AWS_PROFILE=<your-profile> USER_POOL_ID=<pool-id> \
  node backend/scripts/backfill-tier-groups.mjs

AWS_PROFILE=<your-profile> node backend/scripts/backfill-channel-flow.mjs
```

### Admin identity and membership enforcement (deploy-time choices)

Two admin-facing choices, both defaulting to the safe option. Full model in
`docs/specs/identity-access/SPEC-ADMIN-IDENTITY.md`; operating guidance in `docs/guides/admin/ADMIN-GUIDE.md`.

**1. Which IdP authenticates admins** (`-c adminAuthMode`, default `ae-cognito`). This is a
separate decision from the user IdP: the user population can widen (federation, guests) while
admins stay in one IdP.
- `ae-cognito` (default): admins are the `admins` group in AE's own Cognito pool. Create an admin
  by adding a user to the `admins` group in that pool; nothing else to configure.
- `federated`: admins come from the host's own admin pool. Set `-c hostAdminPoolId=<pool-id>`, plus
  `-c adminGroupNames=<claim>` if the admin group claim is not named `admins`. Admin sign-in is a
  separate entry point against that pool.
- `service`: no interactive admin IdP; a trusted backend principal calls the admin API with IAM (SigV4).
```bash
# host-owned admin identity
npx cdk deploy --all -c adminAuthMode=federated -c hostAdminPoolId=us-east-1_XXXX -c adminGroupNames=admins
```

**2. How over-tier memberships are handled** (`-c enableMembershipAudit`, `-c membershipAuditEnforce`).
The near-real-time membership audit (`docs/specs/identity-access/SPEC-CONVERSATION-SECURITY.md` Layer 6) watches Amazon Chime SDK
membership changes and flags any member or assistant placed on a channel above their tier.
- Off by default. Enable with `-c enableMembershipAudit=true`.
- **Report-only (default) vs auto-revoke of member access:** `-c membershipAuditEnforce=false` (default)
  flags and alerts only; `=true` auto-removes the offending membership. This is ALSO a runtime toggle in
  the admin dashboard's Membership Audit tab (report-only vs auto-revoke), which overrides the deploy
  default, so operators switch between manual removal and auto-revocation without redeploying.
- Optional `-c membershipAuditAlertChannelArn=<arn>` routes findings to an admin conversation (in-app plus
  email via the notification bridge); without it, findings are log-only.
```bash
# audit on, start in report-only (recommended), then flip to auto-revoke in the dashboard when confident
npx cdk deploy --all -c enableMembershipAudit=true -c membershipAuditEnforce=false
```

## Deployment Verification

After deploying, verify:
```bash
# Check stacks deployed
aws cloudformation list-stacks --query 'StackSummaries[?starts_with(StackName, `AgentEchelon`) && StackStatus==`CREATE_COMPLETE`].StackName' --output table

# Check Bedrock model access
aws bedrock list-foundation-models --query 'modelSummaries[?starts_with(modelId, `anthropic`)].modelId' --output table

# Aurora mode with -c enableRdsProxy=true only: verify RDS Proxy health (default deploy has no proxy)
aws rds describe-db-proxies --query 'DBProxies[?starts_with(DBProxyName, `agent-echelon`)].{Name:DBProxyName,Status:Status,Endpoint:Endpoint}'
```

## Documentation

`README.md` is the comprehensive entry point; `docs/README.md` is the index of specs and guides.
Start with `README.md`, `docs/overview/ARCHITECTURE.md`, and `docs/guides/user/TROUBLESHOOTING.md`, then follow the
index into the relevant deep-dive. `docs/overview/TENETS.md` holds the canonical project tenets that
every architectural decision traces back to.
