# Agent Echelon

**Agent Echelon is a self-hosted agent control plane: a governed, multi-party agentic AI platform that runs entirely in your own AWS account and serves your internal and customer-facing use cases from one place.** It is the governed layer between your agents and everything they touch (the harness around your models), deciding who may act, which model answers, where the context lives, and what gets recorded. It does not bolt a new policy engine and a separate agent-identity service onto your stack: it enforces with the cloud's own primitives. Every user, assistant, and conversation is an AWS resource with an ARN; every actor holds a bearer-pinned identity, never a shared backend credential; access is an IAM decision keyed on an immutable classification tag: fail-closed, evaluated before any request runs, and provable with a deny test rather than a code review. Classifications are your labels (`internal`, `confidential`, `restricted`, whatever your data taxonomy already says), and each is served by a capability profile that fixes which model answers, at what depth, with what reach. Self-hosted, model-agnostic, MIT-licensed.

The point is centralization. Instead of standing up a separate tool for each use case (a support assistant here, an internal assistant there, each with its own login, data store, bill, and security review), you run one governed platform that serves them all - and a new experience is configuration over the same substrate rather than a new system.

> **Status: reference implementation.** Agent Echelon is a starter application that demonstrates a governed agent architecture on AWS. It is a foundation to build on, not a turnkey production system. Every deployment should evaluate the features against its own security, privacy, and compliance needs and modify the project to meet them. Nothing here is legal advice.

> **Not affiliated with AWS.** Agent Echelon is an independent, personal open-source project by Ryan McHarg. It is **not affiliated with, endorsed by, sponsored by, or an official product of** Amazon Web Services, Inc. or Amazon.com, Inc., and the author does not speak for or represent AWS. "AWS", "Amazon Chime SDK", "Amazon Bedrock", "Amazon Cognito", and related names are trademarks of Amazon.com, Inc. or its affiliates; they are used here only to identify the AWS services this project runs on. Any linked AWS blog posts (including ones the author wrote) are cited for attribution and technical reference only and do not imply any current or past affiliation or endorsement.

## Why Agent Echelon

Most agentic systems are a model, tools, memory, and an orchestration loop. Agent Echelon ships each of those and lets you customize or swap them, then wraps them in the enterprise layers - governed multi-party conversation, omnichannel surfaces, and access enforced in the cloud's own IAM. It is organized as four layers, each running on the one below:

- **Interface layer.** The surfaces a participant meets: a web console for users and an admin console today; an embedded widget, phone/voice (PSTN), SMS, and integration into existing third-party tools are designed and seamed.
- **Communication layer.** The connectivity that moves messages and keeps context: a durable conversation that *is* the memory, a server-side hook on every message, and event capture with per-message metadata - each transport on a provider you choose.
- **Interaction layer.** The engine: Agent Echelon's own code composed over the AWS services it uses, expressing who may act, as whom, at what capability, with which assistant, reaching which systems. That code writes the policy; AWS IAM enforces it. Its composition root is the *conversation type*; five pillars (identity and access, assistant configuration, conversation configuration, connectors, auditing) compose every experience.
- **Foundations layer.** How the platform is deployed and operated: the AWS CloudFormation stacks (CDK) that provision every resource, resource tagging for cost allocation, and the monitoring that keeps it running. The tags that attribute cost are the same ones the interaction layer's IAM decisions read, so cost and governance ride one mechanism.

The engine composes AWS managed primitives (Amazon Chime SDK Messaging, Bedrock, S3, Cognito/STS, IAM, Kinesis), so inference, moderation, message delivery, and retention are AWS's to operate, not yours to build. The platform integrates your identity provider (Cognito by default, or your SSO/SAML/OIDC) rather than replacing it. Real workflows span sales, a scheduled service visit, and a support case - across business units, internal employees, and outside partners - so the same platform expresses a 1:1 tiered chat, a routed support case, a masked service call, or an alert-triggered incident-triage room by **configuration, not new code**. (Pluggable connectors to external systems of record are a designed, opt-in seam, not yet a shipped runtime path.)

**Security** - Every conversation runs inside your AWS account on infrastructure you own. Cognito handles authentication with corporate IdP support. Bedrock Guardrails filter PII, prompt injection, and sensitive content. IAM - keyed on each channel's immutable `classification` tag and bearer-pinned to each user's *own* identity - enforces not just which models a tier may use but which conversations a user (or an assistant) can read or send in: fail-closed, evaluated before any request is processed, and provable with a deny-test rather than a code review. Admins can browse, moderate, redact, or delete any message.

**Cost control** - Three user tiers (Basic, Standard, Premium) gate access to progressively more capable (and expensive) models. Intent-based routing automatically selects the cheapest model that fits the task - Haiku for Q&A, Sonnet for code, Opus only when deep reasoning is needed. A/B experiments let you prove whether a cheaper model performs just as well before switching. Circuit breakers and fallback chains protect against runaway quota spend.

**Quality of output** - Every response is tracked with model, latency, token count, intent classification, and optional human evaluation scores. The admin dashboard shows model effectiveness by intent, flagged response review queues, [drift detection](#drift-detection-aurora-only), and side-by-side A/B experiment results. You measure what you ship.

## Overview

Built with React 19 and AWS CDK, Agent Echelon combines real-time messaging, durable conversation history, fine-grained access control, file attachments, multi-step task workflows, and a comprehensive admin console. It is a **custom architecture built on AWS primitives** (Amazon Chime SDK, Amazon Bedrock, Cognito, STS, S3, DynamoDB) - not a managed offering - and it deploys **entirely to your own AWS account**.

### Key Features

**Model routing and resilience:**
- **Multiple Bedrock Model Families** - Anthropic Claude, Amazon Nova, and OpenAI GPT-OSS selectable per tier at deploy time (the provider layer also supports external HTTP APIs, proven by the image-generation path)
- **Intent-Based Model Routing** - Automatic model selection per intent (e.g., Haiku for Q&A, Sonnet for code, Opus for analysis) with configurable fallback chains
- **Bedrock Resilience** - Exponential backoff retry on throttling, automatic model fallback on quota exhaustion, and circuit breaker to protect against cascading failures
- **A/B Model Testing** - DynamoDB-backed experiment framework for comparing models per intent with deterministic conversation-level variant assignment and side-by-side analytics
- **Cost and Abuse Controls** - Per-user and global hourly Bedrock spend budgets, per-tier request rate limiting, request dedup, an inbound length cap, and a global circuit trip - distinct from the model-fallback resilience above (see [SPEC-ABUSE-CONTROLS](docs/specs/ops/SPEC-ABUSE-CONTROLS.md))

**Collaboration and access control:**
- **AWS-Native Persistent Messaging** - Real-time WebSocket delivery with durable conversation history using AWS-managed messaging infrastructure
- **Role-Based Access** - Control model access by user tier (Basic, Standard, Premium) via Cognito + IAM policies
- **Corporate Identity** - SAML/OIDC integration via Amazon Cognito (see [Identity Provider Guide](docs/guides/user/IDENTITY-PROVIDER-GUIDE.md))
- **File Attachments** - S3-based secure upload/download with presigned URLs, drag-and-drop support
- **Multi-Step Task Workflows** - Guided troubleshooting, data extraction, and report generation with state tracking across conversation turns
- **Conversation Archive, Leave & Remove** - A moderator can archive a conversation (read-only + hidden from the active list; membership retained, so members keep read-only access until the 90-day expiry) or remove a member; any member can leave (see [SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP](docs/specs/communication/SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md))

**Admin operations and analytics:**
- **Admin Analytics Console** - Conversation volumes, model usage, model-by-intent effectiveness, evaluation scores, user activity, and user feedback summaries
- **Conversation Operations** - Browse conversations from the analytics archive, per-message inspect (all fields + metadata), member add/remove, membership-history timeline, and redact / delete - acting as the service app-instance-admin
- **Model Strategy Console** - Intent-to-model routing visibility with provider posture, fallback pairings, cost/latency classes
- **Experiments Console** - Create, pause, and complete A/B model experiments with side-by-side variant results (score, latency, tokens, compliance, fallback rate)
- **User Management** - Approve, reject, change tier, and enable/disable users from the admin dashboard
- **Evaluation Suite** (Aurora mode) - Multi-turn flow evaluation, flagged response review, ground truth human scoring, task completion tracking
- **Live Drift Detection** (Aurora mode only, see [section below](#drift-detection-aurora-only)) - Cosine-similarity drift detection over Titan v2 embeddings, with a live user-facing suggestion to split or switch the conversation when topics shift

**Infrastructure:**
- **Per-tier assistant stacks** - Each tier runs a self-hosted Bedrock Converse tool loop with its own model, content guardrail, in-Lambda tools, and channel-flow routing (no managed Bedrock Agent)
- **Centralized Model Strategy** - Model IDs, IAM allowlists, and routing config derive from a single shared config
- **Optional Aurora Mode** - Aurora PostgreSQL + VPC for advanced analytics (deploy with `--context analyticsMode=aurora`)

### Athena vs Aurora Mode

Agent Echelon deploys in **Athena mode** by default (lower cost, simpler). Aurora mode adds advanced capabilities at the cost of a VPC + Aurora Serverless v2 cluster.

| Feature | Athena (default) | Aurora |
|---------|:---:|:---:|
| Message archiving (Kinesis -> S3) | Yes | Yes |
| Admin dashboard: Overview, Models, Conversations, Users, Latency | Yes | Yes |
| Admin dashboard: Evaluations (basic scores) | Yes | Yes |
| User management (approve/reject/tier) | Yes | Yes |
| **Multi-turn flow evaluation** | -- | Yes |
| **Flagged response review queue** | -- | Yes |
| **Ground truth human calibration** | -- | Yes |
| **Task completion tracking** | -- | Yes |
| **Conversation summaries** | -- | Yes |
| **Drift detection** | -- | Yes |
| **Cross-conversation context search** | -- | Yes |
| **pgvector semantic embeddings** | -- | Yes |

**Athena mode limitations:**
- No real-time per-message analytics - data is available after Firehose buffering (5 min)
- No cross-conversation context (each conversation is isolated)
- **No drift detection.** Drift requires Aurora's pgvector cosine similarity and the summary-updater Lambda; neither exists in Athena mode. Deploying with `enableLiveDrift=true` in Athena mode is a misconfiguration - the feature silently skips every turn.
- Admin dashboard shows only aggregate metrics from S3/Athena, not per-exchange detail
- Aurora-only tabs (Flows, Flagged, Ground Truth, Tasks) are hidden

**Graceful degradation:** The app is designed to run fully in Athena mode without errors. Aurora-only admin tabs are hidden (not shown as broken). Task tracking in async processors silently skips DynamoDB writes when `TASKS_TABLE` is not configured - the bot still generates responses, just without multi-turn state. The premium tier's S3 knowledge base context is optional - if `CONTEXT_BUCKET` is empty, responses are generated without enrichment. The admin dashboard shows an informational banner when no analytics data has been archived yet, explaining the pipeline delay and suggesting Aurora mode for advanced features. Cross-conversation context and drift detection are never referenced in Athena mode.

## Documentation

The full documentation lives under [`docs/`](docs/DOCUMENTATION.md), organized by what you are doing: **deploy it** (user guides), **operate it** (admin guides), **extend it** (the [Developer Guide](docs/guides/developer/DEVELOPER-GUIDE.md)), and **understand it** (specs by domain plus the decision records). Start at the map: **[docs/DOCUMENTATION.md](docs/DOCUMENTATION.md)**.

## Architecture

> **Full architecture guide:** [docs/overview/ARCHITECTURE.md](docs/overview/ARCHITECTURE.md) covers all flows end-to-end: authentication, message routing, intent classification, file attachments, conversation sharing, analytics pipelines, and CDK stack dependencies.

```
┌─────────────────────────────────────────────────────────────────┐
│                        React Frontend                           │
│                   (Vite + TypeScript + React 19)                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Amazon Cognito                              │
│              (User Pool + Identity Pool)                        │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌──────────────────┐ ┌───────────────┐ ┌─────────────┐
│  Amazon Chime SDK       │ │  API Gateway  │ │  Amazon S3  │
│  Messaging       │ │               │ │             │
│  (WebSocket)     │ │               │ │             │
└────────┬─────────┘ └───────────────┘ └─────────────┘
         │
         ├── Channel Flow Processor (@all routing, filtering)
         │
         ▼
┌──────────────────┐
│  Amazon Lex V2   │
│  (per-tier bot)  │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│  Per-tier async processors (3 tiers)             │
│  ┌──────────┐ ┌───────────┐ ┌──────────────┐    │
│  │  Basic   │ │  Standard │ │   Premium    │    │
│  │ (Haiku)  │ │  (Sonnet) │ │   (Opus)     │    │
│  └────┬─────┘ └─────┬─────┘ └──────┬───────┘    │
│       └──────────────┼──────────────┘            │
│                      ▼                           │
│   Self-hosted Converse tool loop                 │
│   (in-Lambda tools) + content guardrail          │
└──────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Amazon Bedrock                             │
│         (Claude Opus, Sonnet, Haiku, Amazon Nova)               │
└─────────────────────────────────────────────────────────────────┘
```

### Provider Hierarchy

```
AuthProvider → AwsClientProvider → MessagingProvider → ConversationProvider
```

- **AuthProvider**: Cognito authentication with automatic token refresh
- **AwsClientProvider**: Amazon Chime SDK client initialization with Cognito Identity Pool credentials
- **MessagingProvider**: WebSocket session management with channel-specific callbacks
- **ConversationProvider**: Conversation CRUD, message state, optimistic updates

## Project Structure

```
agentechelon/
├── frontend/                 # React application
│   ├── src/
│   │   ├── components/       # UI components
│   │   │   ├── admin/        # Admin analytics dashboard
│   │   │   ├── AttachmentDisplay.tsx
│   │   │   ├── ConnectionStatus.tsx
│   │   │   ├── ConversationInterface.tsx
│   │   │   ├── ConversationList.tsx
│   │   │   ├── ErrorBoundary.tsx
│   │   │   ├── FileUploadPreview.tsx
│   │   │   ├── Header.tsx
│   │   │   ├── MessageInput.tsx
│   │   │   ├── TaskStatusIndicator.tsx
│   │   │   └── ...auth screens
│   │   ├── providers/        # React context providers
│   │   │   ├── AuthProvider.tsx
│   │   │   ├── AwsClientProvider.tsx
│   │   │   ├── MessagingProvider.tsx
│   │   │   └── ConversationProvider.chime.tsx
│   │   ├── services/         # Backend integration
│   │   │   ├── chimeService.ts
│   │   │   ├── attachmentService.ts
│   │   │   └── analyticsService.ts
│   │   ├── types/            # TypeScript definitions
│   │   └── utils/            # Message parsing utilities
│   └── package.json
│
├── backend/                  # AWS CDK infrastructure
│   ├── lib/stacks/           # Modular CDK stacks
│   │   ├── chime-messaging-stack.ts
│   │   ├── foundations-stack.ts
│   │   ├── {basic,standard,premium}-classification-stack.ts
│   │   ├── experiments-stack.ts
│   │   ├── battle-stack.ts
│   │   ├── cognito-auth-stack.ts
│   │   ├── s3-storage-stack.ts
│   │   ├── analytics-stack.ts
│   │   └── iam-policies-stack.ts
│   ├── lambda/               # Lambda functions
│   │   ├── create-conversation/
│   │   ├── add-agent-to-conversation/
│   │   ├── presigned-url/
│   │   └── src/
│   │       ├── router-agent-handler.ts         # Lex fulfillment: classify + dispatch
│   │       ├── assistant-async-processor.ts    # shared Converse loop (one instance per profile)
│   │       ├── analytics-aurora/     # Aurora mode (optional)
│   │       │   ├── db-client.ts      # pg client + IAM auth + pooling
│   │       │   ├── kinesis-archival.ts  # Kinesis → Aurora consumer
│   │       │   ├── analytics-query.ts   # Dashboard query API
│   │       │   ├── drift-detection.ts   # Topic drift detection
│   │       │   ├── cross-conversation-context.ts
│   │       │   ├── schema-init.ts       # Migration runner
│   │       │   ├── iam-auth-setup.ts
│   │       │   └── schema/
│   │       │       ├── 001-initial.sql
│   │       │       ├── 002-pgvector.sql
│   │       │       └── 003-materialized-views.sql
│   │       ├── channel-flow-processor.ts   # @all routing, message filtering
│   │       ├── evaluation/           # Evaluation runner
│   │       └── lib/                  # Shared agent libraries
│   ├── lib/constructs/               # Reusable CDK constructs
│   │   └── bedrock-guardrails.ts     # Content filtering + PII + prompt injection
│   └── cdk.json
│
└── tests/                    # Playwright E2E tests
```

## Quick Start

### Prerequisites

- Node.js 18+
- AWS CLI configured with appropriate credentials
- AWS CDK CLI (`npm install -g aws-cdk`)
- Access to Amazon Bedrock models in your AWS account

> **Dependency security.** Install with `npm ci` (exact, lockfile-pinned), not `npm install`. Every install root ships a committed `.npmrc` with `ignore-scripts=true`, which blocks dependency lifecycle scripts - the primary execution vector for npm supply-chain attacks. See [docs/guides/developer/SECURITY-NPM-SUPPLY-CHAIN.md](docs/guides/developer/SECURITY-NPM-SUPPLY-CHAIN.md) for the full rationale, the audit/cooldown/credential practices, and how to check a checkout against the 2026 axios and Red Hat "Miasma" compromises.

### Deploy Backend

```bash
cd backend
npm ci   # exact, lockfile-pinned install (not `npm install`); .npmrc blocks install scripts

# Bootstrap CDK (first time only)
cdk bootstrap aws://ACCOUNT-ID/REGION

# Run deployment doctor checks before deploying
npm run doctor

# Deploy all stacks (set your sender email for notifications)
# Optional model selection:
#   cdk deploy --all --context standardModelKey=gpt_oss_20b --context premiumModelKey=gpt_oss_120b
SES_SENDER_EMAIL=you@example.com cdk deploy --all
```

### Email & the SES Sandbox (read this - it affects whether email works)

Two features send outbound email, both through the same SES path:

- **Conversation sharing** - when a user shares a conversation, the recipient gets an invite.
- **Proactive briefing** - the scheduled, no-user-in-the-loop workflow emails every configured member (see [Proactive Briefing](#proactive-briefing) below).

How it behaves, in order of likelihood for a fresh deploy:

1. **`SES_SENDER_EMAIL` unset** → it defaults to the placeholder `noreply@example.com`. The code **does not silently fail**: it skips the send and returns a visible reason (the share UI shows a warning; the proactive Lambda logs and reports `emailSkipped`). Redeploy with a real address to enable email at all.
2. **Sender not yet verified** → after the first deploy, SES sends a verification email to `SES_SENDER_EMAIL`. **Click the link.** Until the sender identity is verified, every `SendEmail` call fails.
3. **SES sandbox (the default for every new AWS account)** → sandbox imposes three limits you *will* hit:
   - **Every recipient must also be a verified identity** - not just the sender. A share to an unverified address, or a proactive briefing whose `briefingRecipients` include unverified addresses, will fail for those recipients (the workflow is resilient - verified recipients still receive, failures are reported per-recipient, the run does not abort).
   - **~200 emails / 24h and 1 message / second.**
   - To send to arbitrary recipients and lift the quota, [request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) in the SES console (typically approved within a day).

For a demo on a sandbox account: verify the sender **and** each demo recipient address in the SES console first, or email simply won't be delivered even though the rest of the workflow (conversation created, briefing page generated) succeeds.

### Proactive Briefing

A scheduled, fully proactive workflow (no user request): an **EventBridge** rule fires the `ProactiveBriefingFunction`, which creates a conversation, renders a briefing **page on the fly to S3** (served via a 7-day presigned link), seeds the conversation with that link, and emails every member via the notification workflow above.

Configure it at deploy time via CDK context (it safely no-ops with no recipients):

```bash
SES_SENDER_EMAIL=you@example.com cdk deploy --all \
  --context briefingRecipients='[{"userArn":"<appInstanceArn>/user/<sub>","email":"member@example.com","name":"Member Name"}]' \
  --context briefingScheduleRate='rate(1 day)'   # default: rate(1 day); any EventBridge schedule expression
```

EventBridge can't be triggered from a browser, so to see it immediately (or for the Part 1 demo) invoke it once manually:

```bash
aws lambda invoke --function-name <ProactiveBriefingFunctionName CDK output> /dev/stdout
```

Sandbox caveat: `briefingRecipients` emails must be SES-verified in sandbox mode (see above). Briefing pages live in a dedicated private S3 bucket with a 30-day lifecycle (`BriefingsBucketName` CDK output).

### Deployment Doctor

The backend includes a lightweight deployment validation command:

```bash
cd backend
npm run doctor
```

It checks for:

- AWS credentials and region presence
- frontend `.env` availability and missing keys
- local callback URL alignment with the `5173` dev server
- SES sender configuration
- the selected analytics mode

Use this before `cdk deploy` to catch common local configuration issues early.

### Configure Bedrock Access

Request model access in AWS Console:

1. Navigate to **Bedrock > Model access > Manage model access**
2. Enable the following models:
   - `anthropic.claude-opus-4-6-v1` (Premium tier)
   - `anthropic.claude-sonnet-4-6` (Standard tier)
   - `anthropic.claude-3-haiku-20240307-v1:0` (Basic tier + intent classification)
   - `amazon.nova-pro-v1:0` (Amazon Nova Pro - the `titan` catalog key)

### Run Frontend (local development)

```bash
cd frontend
npm ci   # exact, lockfile-pinned install (not `npm install`)

# Copy environment template and update with CDK outputs
cp .env.example .env

# Start development server
npm run dev
```

### Deploy Frontend (production - CloudFront + S3)

For a real, shareable deployment the SPA is hosted on **CloudFront + private S3
by default**. The `AgentEchelonFrontend` stack (already created by `cdk deploy --all`)
provisions the hosting; a build-and-publish step uploads the app:

```bash
cd backend
npm run deploy-frontend     # builds frontend, syncs frontend/dist to S3, invalidates the CDN
```

The build bakes in CDK outputs, so populate `frontend/.env` from the stack
outputs first, then - because the public URL is only known after the first
deploy - set `--context appUrl=https://<DistributionUrl>` and redeploy so the
backend CORS allowlist includes the app origin (a custom domain avoids this
round-trip). An optional `wafAllowedIps` context locks the distribution to known
IPs. Full guide, including teardown and the security headers applied:
**[`docs/guides/user/FRONTEND-DEPLOY.md`](docs/guides/user/FRONTEND-DEPLOY.md)**.

### Create First Admin User

> **Embedding AgentEchelon behind your own app's auth?** This step (and AE's
> built-in admin console) is the **standalone default**, not a requirement. If
> your product already has users and operators, you can point AE's user plane at
> your IdP ([docs/guides/user/IDENTITY-PROVIDER-GUIDE.md](docs/guides/user/IDENTITY-PROVIDER-GUIDE.md))
> and its admin plane at your own admin console + auth
> ([docs/guides/admin/ADMIN-INTEGRATION-GUIDE.md](docs/guides/admin/ADMIN-INTEGRATION-GUIDE.md)) - in which
> case you can skip creating an AE-Cognito admin entirely.
>
> | Plane | Standalone default | Host-owned option |
> |-------|--------------------|-------------------|
> | **User** (who can chat, at which tier) | AE Cognito user pool | Your IdP - [IDENTITY-PROVIDER-GUIDE](docs/guides/user/IDENTITY-PROVIDER-GUIDE.md) |
> | **Admin** (who sees analytics / moderates) | AE `admins` group + AE dashboard | Your console - [ADMIN-INTEGRATION-GUIDE](docs/guides/admin/ADMIN-INTEGRATION-GUIDE.md) |
>
> **"Admin" means three distinct things** in this system (a Cognito *group*, an
> empty IAM *role*, and an Amazon Chime SDK *service* principal), and the tier boundary lives
> on the credential exchange rather than the Identity-Pool roles. The full,
> code-grounded account - with a capability matrix and a spec-drift table - is
> **[docs/specs/interaction/identity-access/core/IDENTITY-AND-ACCESS-MODEL.md](docs/specs/interaction/identity-access/core/IDENTITY-AND-ACCESS-MODEL.md)**.
> Read it before reasoning about who can do what.

New deployments have no users. Run the setup script to create the first admin:

```bash
# Usage: ./scripts/create-admin-user.sh <email> [temporary-password]
# Omit the password to auto-generate one; it's printed at the end.
AWS_PROFILE=your-profile ./scripts/create-admin-user.sh admin@example.com
```

This creates a premium-tier user, adds it to the `premium` + `admins` Cognito groups (the authoritative tier/admin signal), and creates the Amazon Chime SDK AppInstance User required for messaging. The account uses a **temporary password** - on first sign-in the app prompts you to set a permanent one (`NEW_PASSWORD_REQUIRED`). Sign in at http://localhost:5173.

**Password requirements:** 8+ characters, uppercase, lowercase, digit, symbol.

Additional users can sign up through the registration form. New signups require admin approval before they can sign in - approve users in the AWS Console or CLI:

```bash
aws cognito-idp admin-update-user-attributes \
  --user-pool-id YOUR_POOL_ID \
  --username user@example.com \
  --user-attributes Name=custom:approved,Value=true Name=custom:tier,Value=basic
```

## Configuration

Create a `.env` file in the frontend directory:

```env
# AWS Configuration
VITE_AWS_REGION=us-east-1

# Cognito Configuration
VITE_USER_POOL_ID=your-user-pool-id
VITE_CLIENT_ID=your-client-id
VITE_IDENTITY_POOL_ID=your-identity-pool-id

# Amazon Chime SDK Configuration
# No bot ARN is needed - channels enroll the per-tier assistant server-side.
VITE_APP_INSTANCE_ARN=your-app-instance-arn

# API Endpoints
# REQUIRED - the credential exchange is the sole source of Amazon Chime SDK credentials
# (bearer-pinned, classification-capped). Unset means the frontend cannot reach Amazon Chime SDK.
VITE_CREDENTIAL_EXCHANGE_API_URL=your-credential-exchange-api-url
VITE_CREATE_CONVERSATION_API_URL=your-create-conversation-api-url
VITE_PRESIGNED_URL_API_URL=your-presigned-url-api-url
VITE_ANALYTICS_API_URL=your-analytics-api-url
# Optional - client-events ingestion endpoint. If unset, frontend
# event tracking (signup/signin/session funnels, DAU, web vitals,
# error rate) silently no-ops. Source: CDK output
# AgentEchelonAnalytics.ClientEventsApiUrl.
VITE_CLIENT_EVENTS_API_URL=your-client-events-api-url
```

### Backend deploy-time configuration (CDK context)

Backend config is set at deploy time via CDK context (`-c key=value` on `cdk deploy`). Defaults are shown; deeper detail for the admin-identity, membership-audit, and abuse-control keys lives in the linked docs.

| Context key | Default | What it does |
|---|---|---|
| `analyticsMode` | `athena` | `athena` (serverless, cheap) or `aurora` (VPC + Aurora + pgvector; adds evaluation, drift, RAG). |
| `enableRdsProxy` | `false` | Aurora-only, opt-in RDS Proxy connection pooling (~$86/mo floor). Default is direct writer-endpoint IAM auth. |
| `enableLiveDrift` | `false` | Aurora-only, opt-in live drift suggestions in the message path. |
| `enableBattle` | `true` | `/battle` alt-bot slot pool + orchestrator; `-c enableBattle=false` omits the Battle stack. Battle eligibility is the per-profile `battleEligible` field in `profiles.ts` (premium by default). |
| `analyticsVpcId` / `createVpcEndpoints` | create / `true` | Aurora-only: import an existing VPC instead of creating one; skip interface/gateway endpoints when the imported VPC already egresses. |
| `sleepMode` | `false` | Aurora-only auto-pause to 0 ACU when idle (`sleepAfterIdle` default `2h`, `sleepCheckRate` default `rate(15 minutes)`). |
| `enableMembershipAudit` | `false` | Layer-6 over-tier membership audit. `membershipAuditEnforce` (default `false`) = report-only vs auto-revoke; `membershipAuditAlertChannelArn` routes findings. See [ADMIN-GUIDE](docs/guides/admin/ADMIN-GUIDE.md). |
| `adminAuthMode` | `ae-cognito` | Which IdP authenticates admins: `ae-cognito` / `federated` (`hostAdminPoolId`, `adminGroupNames`) / `service`. See [SPEC-ADMIN-IDENTITY](docs/specs/interaction/identity-access/admin/SPEC-ADMIN-IDENTITY.md). |
| `bedrockUserHourlyBudget` / `bedrockGlobalHourlyBudget` | (unset) | Per-user / global hourly spend ceilings (abuse controls). See [SPEC-ABUSE-CONTROLS](docs/specs/ops/SPEC-ABUSE-CONTROLS.md). |
| `basicModelKey` / `standardModelKey` / `premiumModelKey` | (tier default) | Override the default model per tier (any key in the model catalog). |
| `assistantIntentPack` | (default pack) | The request-classification taxonomy (per deployment). |
| `senderEmail` | (required for email) | SES sender for notifications / conversation sharing. |
| `appUrl` | `http://localhost:5173` | Frontend origin for the backend CORS allowlist; set to the CloudFront URL after the first deploy. |
| `frontendWaf` | `true` | Managed-rules WAF on the CloudFront distribution (`wafRateLimit`, `wafAllowedIps` tune it). |
| `environment` | `dev` | `prod` sets `RETAIN` removal policies + deletion protection on stateful resources. |

## Model Strategy

Model routing is capability-first rather than tier-first. The canonical backend strategy lives in:

- `backend/lib/config/model-strategy.ts`

That file defines:

- the current Bedrock model catalog
- tier availability for each model
- the IAM allowlist inputs
- intent-level preferred and fallback routing

At runtime, the **model resolver** (`backend/lambda/src/lib/model-resolver.ts`) uses this strategy to select the optimal model per intent while enforcing tier-based access control. If a model fails, the **resilience layer** (`backend/lambda/src/lib/bedrock-resilience.ts`) retries with exponential backoff then falls back to the strategy's fallback model. A **circuit breaker** prevents hammering a consistently failing model.

The admin console exposes:

- **Model Strategy** tab - read-only view of provider posture, intent routing, fallback pairings, cost/latency classes
- **Experiments** tab - create A/B tests comparing models per intent, with deterministic conversation-level variant assignment and side-by-side results

This keeps routing behavior in one shared config rather than hardcoded across stacks, so supporting additional providers or models is a config change, not a rewrite.

Implementation details for the shared routing metadata live in [docs/guides/developer/MODEL_STRATEGY.md](docs/guides/developer/MODEL_STRATEGY.md).

## User Tiers

Access to AI models is controlled by user tier:

| Tier | Models | Agent Handler |
|------|--------|---------------|
| Basic | Configurable basic model (default: Claude Haiku) | Single response, 30s timeout |
| Standard | Configurable standard model plus standard-safe fallbacks | Task tracking + DynamoDB, 60s timeout |
| Premium | Configurable premium model with full catalog access | Full capabilities + analytics, 90s timeout |

## Aurora Mode Deployment (Optional)

Aurora mode adds RAG, live drift detection, cross-conversation context, and the full evaluation suite, backed by a VPC + Aurora Serverless v2 cluster with pgvector. Deploy it with `--context analyticsMode=aurora`. Full operator guide: [docs/guides/admin/AURORA-MODE-GUIDE.md](docs/guides/admin/AURORA-MODE-GUIDE.md); design and reference (VPC, endpoints, teardown, cost): [docs/specs/ops/SPEC-AURORA-VPC-MODE.md](docs/specs/ops/SPEC-AURORA-VPC-MODE.md).

## Drift Detection (Aurora-only)

When a message diverges from a conversation's running topic, the assistant offers to split or switch the conversation (Aurora mode; live path behind `--context enableLiveDrift=true`). Design and operation: [docs/specs/capabilities/SPEC-DRIFT-CONVERGENCE.md](docs/specs/capabilities/SPEC-DRIFT-CONVERGENCE.md).

## Cost Sleep Mode (Aurora-only)

Sleep mode auto-pauses the Aurora data plane after a configurable idle period and exposes an admin wake/sleep API, so an idle instance stops paying for the cluster. Design: [docs/specs/ops/SPEC-COST-SLEEP-MODE.md](docs/specs/ops/SPEC-COST-SLEEP-MODE.md).

## Admin Dashboard

The admin console groups analytics, conversation moderation (redact/delete), model strategy, A/B experiments, evaluation, and user management into a sectioned dashboard (Aurora-only tabs are hidden in Athena mode). Using it: [docs/guides/admin/ADMIN-GUIDE.md](docs/guides/admin/ADMIN-GUIDE.md). Design: [docs/specs/interface/admin/SPEC-ADMIN-CONSOLE.md](docs/specs/interface/admin/SPEC-ADMIN-CONSOLE.md). Running it behind your own admin console/auth: [docs/guides/admin/ADMIN-INTEGRATION-GUIDE.md](docs/guides/admin/ADMIN-INTEGRATION-GUIDE.md).

## API Endpoints

### Core Endpoints (Both Modes)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/create-conversation` | POST | Create new conversation with AI agent |
| `/add-agent` | POST | Add AI agent to existing conversation |
| `/conversations/archive` | POST | Archive a conversation (moderator): read-only + hidden from the active list; membership retained, so members keep read-only access until the 90-day expiry |
| `/conversations/remove-member` | POST | Remove a member from a conversation (moderator; never the assistant) |
| `/conversations/leave` | POST | Leave a conversation (any member; self only) |
| `/presigned-url` | POST | Generate S3 presigned URL for file upload/download |
| `/share-conversation` | POST | Share conversation via SES email |
| `/admin/conversations` | GET | Browse conversations from the analytics archive (system of record) |
| `/admin/conversations/messages` | GET | Load a conversation's messages from the archive (incl. full raw payload for inspect) |
| `/admin/conversations/members` | GET | Load current conversation members |
| `/admin/conversations/membership-history` | GET | Join / leave / moderator-grant timeline, reconstructed from the archive (audit trail) |
| `/admin/conversations/add-self` | POST | Add the current admin to a conversation (as the app-instance-admin) |
| `/admin/conversations/add-member` | POST | Add a member by ARN (validated to this app instance), as the app-instance-admin |
| `/admin/conversations/remove-member` | POST | Remove a member, as the app-instance-admin |
| `/admin/conversations/redact-message` | POST | Redact a message (moderator or admin) |
| `/admin/conversations/delete-message` | POST | Delete a message (**requires the app-instance-admin**) |
| `/feedback` | POST | Submit per-message user feedback (`helpful` / `needs work`) |
| `/events` | POST | Cognito-authed batch ingestion for frontend events (signup/signin/session funnels, message lifecycle, web-vitals). Lands in S3 `client_events/` via Firehose; backs the Overview/Users/Latency client-events dashboards. |
| `/feedback` | GET | Admin summary of user feedback by model and intent |

### Analytics Endpoints (Aurora Mode)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/analytics/evaluation` | GET | Daily evaluation metrics (materialized view) |
| `/analytics/evaluation/exchanges` | GET | Detailed exchange list with multi-dimensional scores |
| `/analytics/evaluation/flows` | GET | Multi-turn flow summaries with composite scores |
| `/analytics/conversations` | GET | Conversation list with auto-generated summaries |
| `/analytics/drift` | GET | Drift detection events (original topic vs current) |
| `/analytics/context?userSub=X` | GET | Cross-conversation context for a user (related prior conversations) |
| `/analytics/latency?days=N` | GET | Response latency breakdown: avg/P95 total, Bedrock, polling by agent type and delivery option |
| `/analytics/model-effectiveness` | GET | Compare model effectiveness by intent: score, latency, and compliance rate |

## Cost Estimate

> **⚠️ Estimates only.** The figures here are rough estimates for orientation, not budgeting. AWS pricing changes and your actual cost depends on region, traffic, and configuration. **Validate your own costs** against the [AWS Pricing Calculator](https://calculator.aws) and your bills before committing to spend.

A low-volume Athena-mode deployment runs roughly **$30-50/month** (dominated by the always-on Kinesis stream and Bedrock inference); Aurora mode adds roughly **~$50-95/month**. The full per-component cost model, both deployment modes, both VPC configs, and the Bedrock inference drivers live in the single source of truth: **[docs/guides/admin/INFRASTRUCTURE-COST.md](docs/guides/admin/INFRASTRUCTURE-COST.md)**.

## Customization Guide

Extending AgentEchelon, adding or changing a tier, adding a tool or intent, configuring image-generation providers, and replacing prompts, is covered in the **[Developer Guide](docs/guides/developer/DEVELOPER-GUIDE.md)** and the docs it links (for example [docs/guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md](docs/guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md) and [docs/guides/admin/IMAGE-GEN-PROVIDERS.md](docs/guides/admin/IMAGE-GEN-PROVIDERS.md)).

## Troubleshooting

Symptom-to-fix runbook (deploy, connection, Amazon Chime SDK, Bedrock, Aurora): **[docs/guides/user/TROUBLESHOOTING.md](docs/guides/user/TROUBLESHOOTING.md)**.

## End-to-End Tests

The project includes Playwright E2E tests with video recording covering sign up, sign in, and agent intent interactions across all user tiers.

> **Post-deploy validation (start here).** After deploying, the fastest way to prove a fresh
> deployment end-to-end is the demo seed + one-command validation: it seeds three tier users and
> the tiered demo context, then exercises every tier flow with real (measured, recorded)
> conversations and verifies the admin dashboard against that real data - nothing faked.
> ```bash
> cd backend
> AWS_PROFILE=<your-profile> npx ts-node scripts/seed-demo.ts   # users + tier context + identity check
> AWS_PROFILE=<your-profile> npm run validate                   # tier flows -> battle -> admin dashboard
> ```
> Full runbook (prerequisites, per-tier scenarios, RAG ingestion, how to adapt it to your own
> use case): **[docs/guides/user/DEMO-AND-VALIDATION.md](docs/guides/user/DEMO-AND-VALIDATION.md)**. The sections below
> document the raw Playwright suite the validator drives.

### Test Structure

```
tests/
├── playwright.config.ts              # Playwright config (Chromium, video + trace on)
├── e2e/
│   ├── signup.spec.ts                # Registration flow tests
│   ├── signin.spec.ts                # Authentication flow tests
│   ├── agent-intents.spec.ts         # Agent interaction tests (Basic/Standard/Premium)
│   └── helpers/
│       ├── agent-helpers.ts          # Navigation, messaging, and validation utilities
│       └── test-credentials.ts       # Credential loading (Secrets Manager or env vars)
└── test-results/                     # Video recordings and trace files
```

### Running Tests

```bash
cd tests
npm ci   # exact, lockfile-pinned install (not `npm install`)
npx playwright install chromium

# Run all tests (requires frontend running on localhost:5173)
npm test

# Run specific suites
npm run test:signup
npm run test:signin
npm run test:agents

# Run headed (visible browser)
npm run test:headed

# View HTML report
npm run test:report
```

### Gated live-data suites

A few suites drive the live deployment and produce real data, so they stay OFF by default and turn on
with a gate flag: `EXPERIMENTS_E2E=1` (A/B experiments), `BATTLE_E2E=1` (`/battle` duels),
`ONBOARDING_E2E=1` (standard-tier intake), `TASKS_E2E=1` (task lifecycle). Point them at a deployed
origin with `E2E_BASE_URL` (chat) and `E2E_ADMIN_BASE_URL` (admin console).

The analytics read plane is IAM-enforced (`adminIamEnforcement`), so the experiments and tasks suites
SigV4-sign their analytics calls instead of sending a Bearer JWT (see
`tests/e2e/helpers/signed-analytics.ts`). That signing exchanges the admin id token for Identity Pool
credentials, so both of these must be set to the deployed pool ids:

| Var | Purpose | Source |
|-----|---------|--------|
| `VITE_USER_POOL_ID` | Cognito User Pool that mints the id token | `AgentEchelonCognitoAuth` output `UserPoolId` |
| `VITE_IDENTITY_POOL_ID` | Identity Pool the id token is exchanged at for signing credentials | `AgentEchelonCognitoAuth` output `IdentityPoolId` |
| `VITE_ANALYTICS_API_URL` | Signed analytics endpoint | analytics stack output `AnalyticsApiUrl` |
| `VITE_EXPERIMENTS_API_URL` | Admin experiments API (arming/listing) | experiments stack output |

`backend/scripts/gen-frontend-env.mjs` writes all of these into the per-package `.env` files from the
live CloudFormation outputs, so the simplest setup is to run it and export the same values for the suite.

### Test Credentials

The Playwright suite signs in as four tier users (basic / standard / premium /
admin) read from an AWS Secrets Manager secret (`agent-interface/test-credentials`).
After deploying a fresh stack, create those users and write the secret with the
one-shot provisioning script:

```bash
cd backend
AWS_PROFILE=<your-profile> npm run provision-test-users
```

This reads the live `AgentEchelonCognitoAuth` outputs (User Pool + client IDs),
creates each user with a permanent password, adds it to the matching Cognito
group (the authoritative tier signal), and writes/updates the secret the tests
read. It is **idempotent** - re-run it after every redeploy. Overridable via env:

| Var | Default | Purpose |
|-----|---------|---------|
| `TEST_USER_PASSWORD` | `AgentEchelonE2E!2026` | Permanent password for all four users |
| `TEST_EMAIL_DOMAIN` | `agentechelon.test` | Email host for the tier users |
| `ADMIN_EMAIL` | `testuser-admin@<domain>` | Admin user's email |
| `TEST_SECRET_NAME` | `agent-interface/test-credentials` | Secrets Manager secret id |

Tests skip automatically (rather than failing) when the secret is absent, so the
suite degrades gracefully on a stack that hasn't been provisioned.

### Test Coverage

The suite is ~55 tests across 8 spec files:

| Suite | Tests | Description |
|-------|-------|-------------|
| signup.spec.ts | 5 | Form display, validation errors, successful registration, duplicate rejection |
| signin.spec.ts | 8 | Form display, invalid credentials, tier-specific sign in (basic/standard/premium), WebSocket connection, sign out |
| agent-intents.spec.ts | 12 | Conversation creation, greeting message, factual Q&A, context retention, concise responses, analysis requests, task tracking, code generation, metadata stripping |
| admin-dashboard.spec.ts | 14 | Admin console navigation, analytics tabs, date range switching, and back navigation |
| battle.spec.ts | 6 | `/battle` multi-assistant arming, parallel replies, and scorecard |
| mentions.spec.ts | 2 | Mention routing (`@assistant` / `@all`) in multi-user channels |
| credential-exchange.spec.ts | 3 | Bearer-pinned Amazon Chime SDK credential vending from the exchange |
| drift-detection.spec.ts | 5 | Topic-drift detection + suggestion flow (Aurora mode) |

All tests include video recordings and trace files in `tests/test-results/` for debugging.

### Testing Built-In Intents

The agent ships with 6 built-in intents. Use this script to test each one against a running deployment:

```bash
#!/bin/bash
# test-intents.sh - Test all built-in intents against a deployed AgentEchelon
#
# Prerequisites:
# - Frontend running at http://localhost:5173
# - Backend deployed with a premium user created and approved
# - Test credentials set via env vars or Secrets Manager
#
# Usage: ./test-intents.sh

set -e

echo "=== AgentEchelon Intent Test Suite ==="
echo ""

# Run specific intent tests via Playwright
cd tests
npm ci --silent
npx playwright install chromium --with-deps 2>/dev/null

echo "1. GREETING - Testing greeting responses..."
npx playwright test agent-intents.spec.ts -g "greeting" --reporter=list 2>&1 | tail -3

echo "2. ACKNOWLEDGMENT - Testing acknowledgment handling..."
npx playwright test agent-intents.spec.ts -g "context" --reporter=list 2>&1 | tail -3

echo "3. GUIDED_TROUBLESHOOTING - Testing analysis/troubleshooting..."
npx playwright test agent-intents.spec.ts -g "analysis" --reporter=list 2>&1 | tail -3

echo "4. DATA_EXTRACTION - Testing data extraction..."
npx playwright test agent-intents.spec.ts -g "code generation" --reporter=list 2>&1 | tail -3

echo "5. REPORT_GENERATION - Testing task tracking (multi-step)..."
npx playwright test agent-intents.spec.ts -g "task" --reporter=list 2>&1 | tail -3

echo "6. GENERAL - Testing general Q&A..."
npx playwright test agent-intents.spec.ts -g "question" --reporter=list 2>&1 | tail -3

echo ""
echo "=== Full Suite ==="
npx playwright test agent-intents.spec.ts --reporter=list

echo ""
echo "Results: tests/test-results/"
echo "Report:  npx playwright show-report"
```

**Intent taxonomy reference** (defined in `backend/lambda/src/lib/intent-classifier.ts`):

| Intent | Trigger | Delivery Option | Example |
|--------|---------|----------------|---------|
| `GREETING` | "Hello", "Hi", "Hey" | DIRECT | Fast path - no Bedrock call needed |
| `ACKNOWLEDGMENT` | "Thanks", "OK", "Got it", "Bye" | DIRECT | Fast path - no Bedrock call needed |
| `GUIDED_TROUBLESHOOTING` | Troubleshooting or debugging requests | TASK_MULTI_STEP | Multi-turn state machine with step tracking |
| `DATA_EXTRACTION` | Extract data, parse, analyze a document | PLACEHOLDER_UPDATE | Async processor with "Thinking..." placeholder |
| `REPORT_GENERATION` | Generate a report or summary | TASK_MULTI_STEP | Multi-turn state machine |
| `GENERAL` | Anything else | PLACEHOLDER_UPDATE | Default classification for open-domain questions |

**Fast-path optimization:** Greetings and acknowledgments are classified via exact string matching (no Bedrock call). All other intents go through a Bedrock Haiku classification call before routing.

## Technology Stack

- **Frontend**: React 19, Vite, TypeScript
- **Backend**: AWS CDK (TypeScript), Lambda (Node.js 20)
- **AI**: Provider-open, not Bedrock-locked - model-agnostic and configurable per tier and per intent. The assistant runs on Bedrock model families (Anthropic Claude, Amazon Nova, OpenAI GPT-OSS); the provider layer also supports **external HTTP APIs**, proven today by the image-generation path (Stability on Bedrock plus external providers), so adding a non-AWS model provider is an architecture the platform already demonstrates
- **Messaging**: Amazon Chime SDK Messaging (WebSocket)
- **Auth**: Amazon Cognito (SAML/OIDC) with automatic token refresh
- **Storage**: Amazon S3 (presigned URLs)
- **Analytics**: Kinesis Data Firehose, S3, Athena
- **Message trigger**: Amazon Lex V2 - an Amazon Chime SDK-to-Lambda passthrough that invokes the fulfillment handler; request classification and model routing are done in `router-agent-handler.ts`, not by Lex

## Contributing

Contributions are welcome! Please read our [Contributing Guidelines](CONTRIBUTING.md) before submitting pull requests.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

Built with [Amazon Chime SDK](https://aws.amazon.com/chime/chime-sdk/) and [Amazon Bedrock](https://aws.amazon.com/bedrock/).
