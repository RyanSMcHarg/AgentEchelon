# AgentEchelon, AI Assistant Guide (vendor-neutral)

> **This is the vendor-neutral guide for any AI coding assistant** (OpenAI Codex, Gemini CLI, Claude Code, or others) working in this repository. It is a convenience layer, not a requirement: the authoritative, assistant-neutral documentation is `README.md`, `docs/overview/ARCHITECTURE.md`, and `docs/guides/user/TROUBLESHOOTING.md`. Start there regardless of which assistant (if any) you use.
>
> Tool-specific wrapper files defer to THIS file: `CLAUDE.md` (auto-loaded by Claude Code) is a thin pointer here plus the notes unique to that tool. Codex reads `AGENTS.md` natively. Keep the guidance in one place (this file) so the tool wrappers do not drift.

## Project Overview

Enterprise conversational AI interface built on React 19 and AWS CDK. Users chat with AI assistants (Anthropic Claude, Amazon Nova, OpenAI GPT-OSS, DeepSeek V3.2 on Bedrock) over Amazon Chime SDK real-time messaging. Classifications control model access through IAM: the shipped catalog's `basic`/`standard`/`premium` (surfaced to users as tiers) deploy when a deployment declares none, and `guest` and `customer` deploy only where declared. A person signs in through any identity provider the trusted-issuer registry declares (`backend/lib/config/issuers.ts`), and each issuer declares where its people's clearance comes from. An optional Aurora PostgreSQL mode enables advanced evaluation, drift detection, and cross-conversation context.

## Build and Run Commands

```bash
# Frontend (npm-workspaces monorepo: @ae/chat, @ae/admin, @ae/widget, @ae/shared)
cd frontend && npm ci && npm run dev:chat      # Chat dev server at localhost:5173 (npm ci = exact, lockfile-pinned install)
cd frontend && npm run dev:admin                # Admin console dev server
cd frontend && npm run build                    # Production build (Vite to packages/{chat,admin,widget}/dist)
cd frontend && npm run lint                     # ESLint

# Frontend, production hosting (DEFAULT path: CloudFront + S3)
# The AgentEchelonChatApp stack (deployed by `npm run deploy` when `chat` is declared) provisions
# an empty bucket + CloudFront distribution. The build is synced out-of-band because the
# Vite bundle bakes in CDK outputs (see docs/guides/user/FRONTEND-DEPLOY.md):
cd backend && npm run deploy-frontend          # build frontend + sync to S3 + invalidate CDN
cd backend && npm run deploy-frontend -- --no-build   # publish an existing packages/chat/dist

# Backend, Athena mode (default: the required core - seven stacks plus one Assistants-<classification>
# per declared classification - plus each capability declared in deploy.config.json `capabilities`,
# plus conditional ImageGuardrail-{region} stacks for image models pinned outside the deploy region)
cd backend && npm ci
cd backend && npm run deploy                    # Deploy all stacks (the supported path: builds first,
                                                # runs the stack-prefix safety gate, forwards the
                                                # persisted context from deploy.config.json)
cd backend && npm run deploy:stack -- <Stack>   # One stack, with the same config, build and rollback
                                                # checks (--diff-only to look first). Never a raw
                                                # `cdk deploy`: it forwards no persisted context
cd backend && npx cdk diff                      # Preview changes
cd backend && npm run assistant -- validate <profile>  # Profile CLI: draft | validate | activate | rollback,
                                                # SigV4-signed against AdminApi (needs `admin`)
cd backend && npm run test:shards               # Jest tests (the gate). Shards, ONE AT A TIME.
                                                # Longer than one tool call: run a shard at a time
                                                # (--shards=8 --only=N) and resume with --from=N.
                                                # Reports persist in backend/test-results/.
cd backend && npm run test:report               # What the last run proved. Takes no lock.
cd backend && npm run test:slice -- <pattern>   # One area, fast
cd backend && npm test                          # Whole suite in one run: CI only. It exceeds the
                                                # 10-min limit an interactive tool call gets and is
                                                # killed mid-run, which reports as "Jest worker
                                                # encountered N child process exceptions" - a dying
                                                # pool that reads exactly like a regression.
cd backend && npm run build                      # tsc, deployable build typecheck (test/ excluded)
cd backend && npm run typecheck                  # tsc -p tsconfig.test.json, typecheck the test tree (Bundler res.)

# Backend, Aurora mode (same stack count; the Archive stack runs Aurora instead of Athena, adds VPC + Aurora; RDS Proxy is opt-in via -c enableRdsProxy=true)
cd backend && npm run deploy -- --context analyticsMode=aurora

# E2E Tests (requires frontend running + deployed backend)
# One-time per deploy: create the tier test users + write the test-credentials
# secret the suite reads (idempotent; re-run after every redeploy):
cd backend && npm run provision-test-users
# Email delivery tests read a TEST INBOX (an SES receipt rule into S3) and skip, saying why, without one.
# Declare an existing one in deploy.config.json (testInboxDomain + testInboxBucket + testInboxPrefix; no stack is
# created), name one for a single run, or deploy the opt-in TestInbox stack first (README "Test inbox"):
#   TEST_EMAIL_DOMAIN=<domain> TEST_INBOX_BUCKET=<bucket> TEST_INBOX_PREFIX=<prefix> npm run provision-test-users
#   npm run deploy:stack -- <Prefix>TestInbox --context testInboxDomain=<a domain used only for tests>
# The test users' addresses are on TEST_EMAIL_DOMAIN (default: the inbox's domain). Re-provisioning with a
# new domain moves the existing users in place; it does not create a second set.
cd tests && npm ci && npx playwright install chromium
cd tests && npm test                            # All tests
cd tests && npm run test:signup                 # Signup suite only
cd tests && npm run test:signin                 # Signin suite only
cd tests && npm run test:agents                 # Agent interaction suite
cd tests && npm run test:headed                 # Headed mode (visible browser)
cd tests && npm run test:report                 # View HTML report
```

**Traces and passwords.** Every test records a video; a Playwright trace (`trace.zip` under `tests/test-results/`) is kept only for a failing test (`trace: 'retain-on-failure'`). A trace records the value of every `fill`, every input's value in its DOM snapshots, and every request body, so a password typed with `fill` lands in it three times. Type a password with `fillSecret` (`tests/e2e/helpers/unrecorded-secret.ts`): the page receives a random stand-in, and a context route swaps the real value into the request on its way to Amazon Cognito. `tests/e2e/trace-holds-no-password.spec.ts` produces a trace locally and fails if the password is in it, and fails if a spec types a password field any other way.

### One test run at a time

Heavy test runs on a development machine are serial, and this is enforced rather than advised.

The backend suite is split into Jest shards because one run exceeds the 10-minute limit an interactive tool call gets. But shards started CONCURRENTLY hard-lock the machine: each Jest process runs 4 workers holding a full TypeScript program (see the comments in `backend/jest.config.js`), so four shards is 16 compiling workers, enough to lose uncommitted work. Running the Jest shards alongside a Playwright e2e run starves it the same way.

`npm run test:shards` runs them one after another from a single supervising process, which holds an exclusive lock (`backend/scripts/lib/test-run-lock.cjs`, the file `ae-test-run.lock` in the repository's shared `.git` directory) for its whole lifetime. Every checkout on the machine, git worktrees included, contends for that one file, because a lock per checkout let two worktrees run at once and exhaust memory. A second runner refuses to start rather than queueing - a queued run is indistinguishable from a hung one when you come back to read the output. A lock left behind by a crash is reclaimed automatically, so a crash never needs manual cleanup: the lock records the holder's pid with the process identity behind it (its executable name and the time the operating system started it), and a pid that is free, or that the operating system has handed to another process, does not hold it.

### A run that is killed still has to be worth something

A full pass outlives a tool call, so it gets moved to the background, and a backgrounded run on a development machine is killed often enough to plan for. The runner therefore treats being killed as normal rather than exceptional:

- **Results are durable and incremental.** Each shard's report lands in `backend/test-results/` the moment it finishes and nothing is deleted, so a run killed at minute 40 still names which shards passed and which tests failed.
- **Runs resume.** `--from=N` and `--only=N` continue where a kill left off, which is what makes a long suite runnable in an environment that grants ten minutes at a time. `--shards=8` makes each piece small enough to finish inside one.
- **Progress is readable while a run is in flight.** `npm run test:report` prints what is known so far and takes no lock.
- **An incomplete run is not a pass.** Shards with no report exit non-zero and say the suite is NOT proven, so a run that lost shards never ends on a green line.

The transform cache is on and pinned to `backend/node_modules/.cache`, which roughly halves the wall clock (measured on this repo). `AE_JEST_NO_CACHE=1` restores the uncached behavior if the partial-import flake that once justified disabling it ever returns.

While iterating, run a targeted slice rather than the suite: `npm run test:slice -- test/lib/stop`.

For Claude Code there is a second, earlier layer: `.claude/hooks/serial-test-runs.js` refuses the command shapes before they spawn - a hand-written `--shard`, two test runs chained in one command, the whole suite in a single call, or anything at all while the lock is held. The hook cannot see a run started from a terminal, and the lock cannot see a command before it spawns, so both exist. Neither is a substitute for the other.

## Session Setup

Before making changes, verify:
1. AWS credentials configured (`aws sts get-caller-identity`)
2. Bedrock model access enabled (Opus, Sonnet, Haiku, Amazon Nova in us-east-1)
3. `frontend/packages/{chat,admin}/.env` populated with CDK stack outputs (generated by `backend/scripts/gen-frontend-env.mjs`, which `npm run deploy` runs; there is no root `frontend/.env`)
4. If Aurora mode: schema migrations have run (and, only if `-c enableRdsProxy=true`, RDS Proxy is healthy; the default path is direct writer-endpoint IAM auth)

## Architecture

For the full end-to-end treatment, read `docs/overview/ARCHITECTURE.md`. This section is the map.

### Frontend Provider Hierarchy (order matters)
```
AuthProvider -> AwsClientProvider -> MessagingProvider -> ConversationProvider
```
Each provider depends on the one above it being initialized. AuthProvider holds the person's token from the issuer they signed in through, AwsClientProvider creates SDK clients with the credentials the credential exchange vends (the only source of a person's AWS credentials, bearer-pinned to the person's own AppInstanceUser), MessagingProvider manages the Amazon Chime SDK WebSocket session, ConversationProvider handles conversation/message state.

### Backend CDK Stacks

The backend is composed of independently-deployable feature stacks rather than one monolith: `/battle` is `AgentEchelonBattle`; each classification's assistants are its own `AgentEchelonAssistants-<classification>` stack (owning its async processor, router and the seed that asks the provisioner for its declared assistants; no stack owns an assistant identity, ADR-048), one per classification the profile registry declares; experiments are `AgentEchelonExperiments`; shared conversation state plus create-conversation are `AgentEchelonConversations`. Each classification's code is independently owned. See `docs/specs/interaction/assistants/SPEC-PER-PROFILE-OWNERSHIP.md`.

A deployment is the required core plus the capabilities `backend/deploy.config.json` declares in `capabilities` (`backend/lib/config/capabilities.ts`). A capability that is not declared leaves no stack behind, and synth refuses an unknown name, a capability that is **NOT BUILT** (`meetings`), and one missing a capability it requires. `connectors` is declared together with its connector registry (`connectors`, `backend/lib/config/connectors.ts`), and synth refuses either without the other. Stack placement, the component rule and the deploy order are in `docs/overview/STACKS.md`. Every change keeps to its layer and to the deploy rules in `CONTRIBUTING.md` ("The four layers", "Deploy only what you declare"): the core depends on nothing optional, a capability reaches the core only through an attach point declared in `capabilities.ts`, absent means off, and the deploy matrix (`backend/test/deploy-matrix/`) passes.

**Required core (both modes):** seven stacks plus one `AgentEchelonAssistants-<classification>` per declared classification, and one `AgentEchelonImageGuardrail-<region>` per region hosting an active image model outside the deploy region. Stack names come from `backend/lib/config/stack-names.json`.
1. `AgentEchelonMessaging`, the Amazon Chime SDK AppInstance, its service admin and retention, and the message stream with the app instance's streaming configuration
2. `AgentEchelonIdentity`, the user pool, with the admin plane's group and the membership groups, when the trusted-issuer registry declares one (`pool: 'self'`), with the admin console's app client (`AdminWebClient`) on it when `admin` is declared, Cognito triggers, the person credential exchange (the only minter of AppInstanceUsers and the only source of a person's AWS credentials) and the one-conversation and admin plane vend roles (each conversational classification's vend role and clearance groups are its `Assistants-<classification>` stack's), the `Identities` index, the access log, offboarding (`OffboardingFunction`) and the platform CloudTrail trail, and the guest issuer when the registry declares one (its KMS signing key, kill switch and guest-session role, and guest start and guest refresh on the exchange; `docs/guides/admin/GUEST-ISSUER.md`)
3. `AgentEchelonConversations`, shared task-tracking tables (`agent-tasks` + `user-tasks`) + the per-user profile table + the channel-context table + the abuse-controls table (rate limit / spend budget / request dedup) + the token store (`Tokens`, keyed `<kind>#<sha256>`) + the conversation-actions audit table + the user-feedback table + the attachments bucket + create-conversation + conversation-management (archive / remove-member / leave) + presigned-URL + user-feedback handlers, whose routes `AgentEchelonPersonApi` serves, + their SSM contract (hosts no bot)
4. `AgentEchelonArchive`, the conversation archive in the deployment's `analyticsMode` (below), under one name in either mode, with an `AnalyticsMode` output
5. `AgentEchelonAssistants-<classification>`, one per classification the deployment declares (`profiles` in `deploy.config.json`, `resolveDeploymentProfiles` in `lib/config/profiles.ts`) with a `topology`, the shipped catalog minus `guest` and `customer` when it declares none: each is the shared `AssistantsStack` reading that classification's topology; the one shared `assistant-async-processor.ts` (self-hosted Converse tool loop, no Bedrock Agent) serves every profile, with per-classification context IAM + content guardrail and the seed that asks the provisioner (in `AgentEchelonMessaging`) for its declared assistants, each its own Lex bot and AppInstanceBot; no stack owns an assistant identity
6. `AgentEchelonChannelFlow`, Channel Flow Processor for @all + /battle routing + message filtering
7. `AgentEchelonPostProcessing`, the post-delivery consumer on the message stream: acts on messages delivery did not route; resolves the tasks table + classification router ARNs from SSM at deploy
8. `AgentEchelonPersonApi`, one HTTP API (API Gateway v2) serving every person route the core and the declared capabilities declare, behind the edge authorizer (`backend/lib/constructs/edge-authorizer.ts`: the token verified against the trusted-issuer registry and resolved through `Identities`, cached 300 s, the credential exchange uncached); `GET /deployment/state` has no authorizer; outputs `PersonApiUrl` and `PersonApiCapabilities`

**Declared capabilities (`capabilities` in `deploy.config.json`):**
- `chat`: `AgentEchelonChatApp`, the default production frontend hosting: private S3 origin + CloudFront (OAC, SPA error mapping, security response headers, managed-rules WAF on by default). Provisions an EMPTY bucket + distribution; the Vite build is synced out-of-band by `npm run deploy-frontend` (it bakes in CDK outputs, so a BucketDeployment cannot run inside the stack). `npm run deploy` resolves `appUrl` from the distribution so backend CORS allows the app origin. See `docs/guides/user/FRONTEND-DEPLOY.md`.
- `admin`: `AgentEchelonAdminServices` (every admin handler, all SigV4: the admin credential exchange and its roles, user management, admin conversations and tasks, the feedback summary, assistant administration and analytics as two nested stacks, and the admin notification channel with the one rule that posts `ae.alert` events into it), `AgentEchelonAdminApi` (one HTTP API serving every admin route behind IAM, the console session behind its own edge authorizer that admits only an issuer declaring `admin: true`, and the console roles' `execute-api:Invoke` grants from the capability catalog; outputs `AdminApiUrl` and `AdminApiCapabilities`) and `AgentEchelonAdminApp` (the admin console hosting).
- `notifications`: `AgentEchelonNotifications`, the deployment's only SES send grant: SES email identity + conversation sharing + the email bridge (a second consumer on the message stream that sends delivery email) + the archival alarm + proactive-briefing EventBridge workflow (`lambda/src/proactive-briefing.ts`; recipients (AppInstanceUser ARNs) and schedule via `briefingRecipientArns`/`briefingScheduleRate` context). It runs the briefing as the standard classification's assistant.
- `experiments`: `AgentEchelonExperiments`, the A/B experiments table and the channel flow's grant on it; each classification's stack grants its own roles on it by its fixed name, which the functions are told in their environment when it is declared. It has no routes: experiment administration (`/admin/experiments`) is handled in `AgentEchelonAdminServices` and served on `AgentEchelonAdminApi` when `admin` is declared too.
- `battle` (requires `experiments`): `AgentEchelonBattle`, the orchestrator + battle tables + the channel flow's grant on them + the channel-battle/outcome handlers (each battle-capable classification's alt and its grants are built by its own `Assistants-<classification>` stack, `classification-capabilities.ts`), whose routes `AgentEchelonPersonApi` serves; whether a classification can run a duel is its `battleCapable` field in `profiles.ts`
- `widget`: `AgentEchelonWidget`, the embeddable widget hosting (`backend/lib/stacks/widget-stack.ts`): private S3 origin + CloudFront, with `frame-ancestors` generated from every issuer's `allowedOrigins`; `AgentEchelonPersonApi` admits the frame's own origin (`widgetUrl`) in CORS.
- `connectors`: `AgentEchelonConnectors`, the runtime for the connectors declared in `connectors` (`backend/lib/config/connectors.ts`): one EventBridge rule per subscribing connector on its vendor's partner event bus, and the per-person grants and their revoker.
- `operations`: `AgentEchelonOperations`, the deployment-wide CloudWatch dashboard; every stack keeps its own alarms either way
- **NOT BUILT:** `meetings`, which synth refuses with the reason.

**Athena mode (default):**
- `AgentEchelonArchive` as the Athena archive: the message stream to Firehose to S3 to Glue to Athena pipeline + the client-events handler (`POST /events`, on `AgentEchelonPersonApi`)
- The lower-cost run mode. Testing focuses primarily on Aurora mode (the e2e suite and `validate` run against an Aurora deployment), so a change that touches Athena-only code paths is less covered; see [Testing focus](docs/guides/admin/AURORA-MODE-GUIDE.md#testing-focus).

**Aurora mode (opt-in via `--context analyticsMode=aurora`):**
- `AgentEchelonArchive` as the Aurora archive: VPC (created by default, or import an existing one with `-c analyticsVpcId=`), Aurora Serverless v2, optional RDS Proxy (opt-in via `enableRdsProxy`; default is direct writer-endpoint IAM auth), Kinesis archival, evaluation runner, the client-events `/events` API (the admin analytics query is in `AgentEchelonAdminServices`, as a VPC function in this VPC). Live drift detection is opt-in (`-c enableLiveDrift=true`, default off, Aurora-mode only); it runs conversation-level in the per-tier message path.

**The mode is chosen at first deploy.** Switching an existing deployment between Athena and Aurora is not supported (both archive modes create the same fixed-name resources), and `npm run deploy` refuses a deploy whose `analyticsMode` differs from the deployed `Archive` stack's `AnalyticsMode` output (`backend/scripts/lib/deploy-guards.cjs`). Changing modes is a teardown and a fresh deploy; see [Switching modes](docs/guides/admin/AURORA-MODE-GUIDE.md#switching-modes).

### Key Directories

| Path | Contents |
|------|----------|
| `frontend/packages/chat/src/components/` | React UI components |
| `frontend/packages/admin/src/components/admin/` | Admin dashboard sections (the `SECTIONS` array in `AdminDashboard.tsx`): Operations, Performance, Oversight (Conversations, Security with the Membership Audit: Layer 6 review plus the report-only vs auto-revoke toggle, and the access log), Models, Assistants (Profiles), Experiments and Users. See `docs/guides/admin/ADMIN-GUIDE.md`, `docs/specs/interface/SPEC-ADMIN-CONSOLE.md`, `docs/specs/interaction/governance/SPEC-ADMIN-IDENTITY.md`, `docs/specs/interaction/governance/SPEC-MODERATION.md`. |
| `frontend/packages/{chat,shared}/src/providers/` | Context providers (auth, messaging, conversations) |
| `frontend/packages/{admin,chat,shared}/src/services/` | Backend integration (Amazon Chime SDK, S3, analytics) |
| `frontend/packages/shared/src/types/` | TypeScript types (including full Aurora analytics types) |
| `frontend/packages/{chat,shared}/src/utils/` | Message parsing utilities |
| `backend/lib/stacks/` | CDK stack definitions |
| `backend/lib/interfaces/` | Shared interfaces (IArchiveStackOutputs) |
| `backend/lambda/` | Lambda handlers (3-tier agents, Cognito triggers, presigned URL) |
| `backend/lambda/src/analytics-aurora/` | Aurora-mode Lambdas (archival, analytics, drift detection, context search) |
| `backend/lambda/src/analytics-aurora/schema/` | SQL migrations (`NNN-*.sql`, applied at runtime by the migration runner) |
| `backend/lambda/src/channel-flow-processor.ts` | Channel Flow Processor for @all routing and message filtering |
| `backend/lambda/src/lib/` | Shared Lambda libraries (intent classifier, intent pack, delivery options, task tracking, async-processor-core, model-resolver, resolve-model-plan, bedrock-resilience, experiment-manager) |
| `backend/lib/constructs/` | Reusable CDK constructs (bedrock-guardrails) |
| `backend/test/` | Jest unit tests (CDK synth, Aurora modules) |
| `tests/e2e/` | Playwright E2E tests (auth, agents, admin dashboard) |
| `docs/` | Specs and reference docs (see `docs/DOCUMENTATION.md` for the index) |

### Message Flow

**Message path:**
1. User sends a message via Amazon Chime SDK `SendChannelMessage`
2. The Channel Flow Processor runs first (enforces mention rules for `@assistant`/`@human`/`@all`, filters messages)
3. When an assistant should respond, the message routes to that assistant's own Lex bot; its fulfillment Lambda, the classification's router (`router-agent-handler.ts`) classifies intent, resolves the tier's async processor, and invokes it. (`@all` bypasses Lex: the Channel Flow Processor invokes the async processor directly and broadcasts.)
4. The async processor runs a self-hosted Converse tool loop (`lambda/src/lib/async-processor-core.ts` `generateResponse`): it calls Bedrock's Converse API, optionally invokes tools, and applies the content guardrail out-of-band. There is no Bedrock Agent.
5. The reply is written back by updating the placeholder message (long replies split into linked continuation messages)
6. The frontend receives the response over the Amazon Chime SDK WebSocket

See `docs/overview/ARCHITECTURE.md` for mention routing, the share flow, model resolution and resilience, and the Aurora archival path in full.

### Important Patterns (must-know; deep detail in the docs)

- Channels are RESTRICTED + PRIVATE; bot creates channel, user is added as moderator.
- **Tier authorization**: each issuer in the trusted-issuer registry declares a clearance source and the classifications it may grant (`backend/lib/config/issuers.ts`); for the deployment's own pool the source is its Cognito groups (`basic`/`standard`/`premium`/`admins`), and a token from an undeclared issuer reaches nothing. A person can send only into a channel whose classification their clearance grants (IAM, fail-closed; classifications are declared grant sets, not a ladder), so `router-agent-handler.ts` answers at the channel's classification and logs a `SecurityEvent` on a clearance mismatch.
- **Message delivery and size (read before producing or extending any channel message)**: Amazon Chime SDK caps are on the encoded length (`encodeURIComponent`): `Content` 4096, `Metadata` 1024, and CJK encodes ~9x per char. Long replies MUST go through `handleLongResponse`/`splitIntoChunks`. Full guide: `docs/guides/developer/MESSAGE-DELIVERY-GUIDE.md`. Canonical code: `backend/lambda/src/lib/async-processor-core.ts`.
- Bedrock Guardrails filter PII, prompt injection, and metadata markers on all agents.
- **Model routing**: `model-resolver.ts` maps a classified request to a model from a configurable strategy, enforcing tier-based access control. Defaults are per-deployment configurable and specific request categories can use different models. See `docs/overview/ARCHITECTURE.md` and `docs/guides/developer/MODEL_STRATEGY.md`.
- **Configurable classification taxonomy (per deployment)**: `lib/intent-pack.ts` loads the taxonomy from the `ASSISTANT_INTENT_PACK` env var (CDK context `assistantIntentPack`). Full design: `docs/specs/interaction/assistants/SPEC-CONFIGURABLE-INTENT-PACK.md`.
- Bedrock resilience: `bedrock-resilience.ts` provides retry (exponential backoff), model fallback, and a circuit breaker (5 failures / 60s window).
- A/B experiments: `experiment-manager.ts` uses a deterministic MD5 hash of `channelArn + experimentId` for sticky conversation-level variant assignment.
- **Cross-channel task continuity**: tasks are tracked in `AgentTasksTable` (keyed by `taskId, channelArn`) and `UserTasksTable` (keyed by `personId`). Resume is channel-scoped; cross-channel awareness is prompt-only (a brief hint, never an auto-resume, never a channel ARN leak).
- **Building or changing assistant context / RAG?** Read `docs/guides/developer/GUIDE-ASSISTANT-CONTEXT.md`, `docs/specs/interaction/assistants/SPEC-WELCOME-AND-CONTEXT.md`, and `docs/guides/developer/RAG.md` first. The context model (tier-scoped company context, pgvector RAG, conversation history + summary, welcome/personalization, participant/domain context) spans several docs and is easy to miss and reinvent.

## Configuration

Frontend environment variables live per package in `frontend/packages/{chat,admin}/.env` (generated from live stack outputs by `backend/scripts/gen-frontend-env.mjs`; see each package's `.env.example`). Backend deploy-time config is via CDK context. The full, current tables (every variable, its CDK context key, default, and notes) live in `README.md` under "Configuration". Treat the README as authoritative for config; this file points there rather than duplicating it.

Typical deploy:
```bash
cd backend && AWS_PROFILE=<your-profile> npm run deploy -- \
  --context senderEmail=you@example.com
```

On a deployment that carried conversations from before the host grounding moved out of channel metadata, also run the grounding recovery once. Dry-run first; it reports what it would recover and what it leaves alone:
```bash
AWS_PROFILE=<your-profile> npx ts-node backend/scripts/backfill-channel-context.ts --dry-run
AWS_PROFILE=<your-profile> npx ts-node backend/scripts/backfill-channel-context.ts
```
Without it those conversations answer ungrounded and on the deployment's default model and language (the router logs each such turn). A fresh deployment has nothing to recover and the run reports zero.

### Admin identity and membership enforcement (deploy-time choices)

Two admin-facing choices, both defaulting to the safe option. Full model in `docs/specs/interaction/governance/SPEC-ADMIN-IDENTITY.md`; operating guidance in `docs/guides/admin/ADMIN-GUIDE.md`.

**1. How admin handlers treat a signed caller** (`-c adminAuthMode`, default `ae-cognito`). Every admin route, `GET /feedback` included, is in the admin capability catalog and is `AWS_IAM` in every deployment (an `AgentEchelonAdminApi` route is IAM unless it declares otherwise, `authOf` in `backend/lib/constructs/http-api.ts`; the grants are `grantAdminRolesOnApi` in `backend/lib/constructs/admin-role-grants.ts`) with no switch: the console signs with a session the credential exchange vends on the role the person's group names (`admins` or `team-members` in AE's own Cognito pool). Create an admin by adding a user to the `admins` group in that pool. `adminAuthMode` selects no authorizer; it only sets `ADMIN_AUTH_MODE` on the admin handlers:
- `ae-cognito` (default): handlers admit an admin console session.
- `federated` is retired and refused at synth.
- `service`: a handler trusts any IAM-signed caller as admin (`isServiceAdminCall` in `backend/lambda/src/lib/auth.ts`), for a trusted backend principal you grant `execute-api:Invoke`.

`adminGroups` on the `deployment` entry of the trusted-issuer registry (`issuers` in `deploy.config.json`) names the admin group when it is not `admins`.
```bash
# admin APIs called by your own backend principal
npm run deploy -- --context adminAuthMode=service
```

**2. How uncleared memberships are handled** (`-c membershipAuditEnforce`). The near-real-time membership audit (`docs/specs/interaction/governance/SPEC-CONVERSATION-SECURITY.md` Layer 6) watches Amazon Chime SDK membership changes and flags a violation in whichever direction is a leak for that kind of member, which is opposite for the two. A PERSON is flagged when the channel is ABOVE their clearance, because they would see content they are not cleared for. An ASSISTANT is flagged when its own classification is ABOVE the channel's, because it would answer with a higher classification's model and context to lower-cleared members. An assistant BELOW the channel is not flagged, because its own credentials do not reach the channel and Layer 1 denies it.
- **Always deployed** - flagging uncleared members for review is a standing security guarantee, not opt-in.
- **Report-only (default) vs auto-revoke of member access:** `-c membershipAuditEnforce=false` (default) flags and alerts only; `=true` auto-removes the offending membership. This is the ONLY knob, and it is ALSO a runtime toggle in the admin dashboard's Membership Audit tab (report-only vs auto-revoke), which overrides the deploy default, so operators switch between manual removal and auto-revocation without redeploying.
- Findings are `ae.alert` events on the default EventBridge bus. With `admin` declared, `AgentEchelonAdminServices` posts them into the admin notification channel; without it, findings are log-only. `membershipAuditAlertChannelArn` is retired and synth refuses it.
```bash
# audit runs by default in report-only; flip to auto-revoke in the dashboard (or at deploy) when confident
npm run deploy -- --context membershipAuditEnforce=false
```

## Deployment Verification

After deploying, verify:
```bash
# Check stacks deployed
aws cloudformation list-stacks --query 'StackSummaries[?starts_with(StackName, `AgentEchelon`) && StackStatus==`CREATE_COMPLETE`].StackName' --output table

# Check Bedrock model access
aws bedrock list-foundation-models --query 'modelSummaries[?starts_with(modelId, `anthropic`)].modelId' --output table

# Profile registry convergence: one row per deployed classification plus the admin plane's, and both
# registry alarms (RegistryItemDropped, RegistryReadFailed) in OK once every stack has deployed
aws ssm get-parameters-by-path --path /agent-echelon/registry/classification --query 'Parameters[].Name' --output table
aws cloudwatch describe-alarms --alarm-name-prefix AgentEchelonIdentity-profile-registry --query 'MetricAlarms[].{Name:AlarmName,State:StateValue}' --output table

# Archive partition backfill: the conversations table holds a partition for each user_type/year/month/day prefix
# already in the archive bucket, and the registrar's dead-letter alarm is OK
aws glue get-partitions --database-name agent_echelon_analytics --table-name conversations --query 'length(Partitions)'
aws cloudwatch describe-alarms --alarm-name-prefix AgentEchelonArchive-archive-partition-unregistered --query 'MetricAlarms[].StateValue'

# Aurora mode with -c enableRdsProxy=true only: verify RDS Proxy health (default deploy has no proxy)
aws rds describe-db-proxies --query 'DBProxies[?starts_with(DBProxyName, `agent-echelon`)].{Name:DBProxyName,Status:Status,Endpoint:Endpoint}'
```

## Documentation

`README.md` is the comprehensive entry point; `docs/DOCUMENTATION.md` is the index of specs and guides. Start with `README.md`, `docs/overview/ARCHITECTURE.md`, and `docs/guides/user/TROUBLESHOOTING.md`, then follow the index into the relevant deep-dive. `docs/overview/TENETS.md` holds the canonical project tenets that every architectural decision traces back to.
