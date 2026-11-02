# Agent Echelon

**Agent Echelon is a self-hosted agent control plane: a governed, multi-party agentic AI platform that runs entirely in your own AWS account and serves your internal and customer-facing use cases from one place.** It is the governed layer between your agents and everything they touch (the harness around your models), deciding who may act, which model answers, where the context lives, and what gets recorded. It does not bolt a new policy engine and a separate agent-identity service onto your stack: it enforces with the cloud's own primitives. Every user, assistant, and conversation is an AWS resource with an ARN; every actor holds a bearer-pinned identity, never a shared backend credential; access is an IAM decision keyed on an immutable classification tag: fail-closed, evaluated before any request runs, and provable with a deny test rather than a code review. Classifications are your labels (`internal`, `confidential`, `restricted`, whatever your data taxonomy already says), and each is served by a capability profile that fixes which model answers, at what depth, with what reach. Self-hosted, model-agnostic, MIT-licensed.

The point is centralization. Instead of standing up a separate tool for each use case (a support assistant here, an internal assistant there, each with its own login, data store, bill, and security review), you run one governed platform that serves them all - and a new experience is configuration over the same substrate rather than a new system.

> **Status: reference implementation.** Agent Echelon is a starter application that demonstrates a governed agent architecture on AWS. It is a foundation to build on, not a turnkey production system. Every deployment should evaluate the features against its own security, privacy, and compliance needs and modify the project to meet them. Nothing here is legal advice.

> **Not affiliated with AWS.** Agent Echelon is an independent, personal open-source project by Ryan McHarg. It is **not affiliated with, endorsed by, sponsored by, or an official product of** Amazon Web Services, Inc. or Amazon.com, Inc., and the author does not speak for or represent AWS. "AWS", "Amazon Chime SDK", "Amazon Bedrock", "Amazon Cognito", and related names are trademarks of Amazon.com, Inc. or its affiliates; they are used here only to identify the AWS services this project runs on. Any linked AWS blog posts (including ones the author wrote) are cited for attribution and technical reference only and do not imply any current or past affiliation or endorsement.

> **Costs money to deploy and run.** Agent Echelon runs entirely in *your* AWS account, so you pay for the AWS resources it provisions and for every model invocation it makes. Deploying it, running the demo/validation suite (which drives real, billed conversations - see [End-to-End Tests](#end-to-end-tests)), and serving real traffic all incur real charges - Amazon Bedrock inference, the always-on infrastructure baseline, and any paid external providers (e.g. OpenAI/FAL image generation) you configure. **Every cost figure in this documentation is a rough estimate for orientation only** - your actual cost depends on region, traffic, retention, and configuration, and AWS pricing changes. Validate against the [AWS Pricing Calculator](https://calculator.aws) and your own bills before committing to any spend. A built-in, opt-in "sleep mode" (`-c sleepMode=true`, Aurora mode only) can auto-pause the Aurora cluster to 0 ACU after a configurable idle period (with a manual admin wake), shedding the dominant idle cost when nobody is using the deployment (see [SPEC-COST-SLEEP-MODE](./docs/specs/foundations/SPEC-COST-SLEEP-MODE.md)). Even so, this is a full multi-service governed platform on real infrastructure, so expect it to cost more to run than a typical single-purpose demo.

## Why Agent Echelon

Most agentic systems are a model, tools, memory, and an orchestration loop. Agent Echelon ships each of those and lets you customize or swap them, then wraps them in the enterprise layers - governed multi-party conversation and access enforced in the cloud's own IAM (with an omnichannel edge designed and seamed, below). It is organized as four layers, each running on the one below:

- **Interface layer.** The client surfaces people use: a web chat client for users and the operator admin app today, with mobile, phone (PSTN), email, and integration into existing third-party tools designed and seamed. A client renders, holds a bearer-pinned identity, and reaches the engine through the connectivity layer below.
- **Communication layer.** The connectivity that wires each client to the engine: WebSocket and REST for messaging today, with WebRTC for real-time next, and email handing off outbound already. Each transport runs on a provider you choose rather than one the platform hard-codes, and adding connectivity never changes the engine.
- **Interaction layer.** The engine: Agent Echelon's own code composed over the AWS services it uses, expressing who may act, as whom, at what capability, with which assistant, reaching which systems. That code writes the policy; AWS IAM enforces it. Its composition root is the *conversation type*; five pillars (identity and access, assistant configuration, conversation configuration, connectors, auditing) compose every experience.
- **Foundations layer.** How the platform is deployed and operated: the AWS CloudFormation stacks (CDK) that provision every resource, resource tagging for cost allocation, and the monitoring that keeps it running. The tags that attribute cost are the same ones the interaction layer's IAM decisions read, so cost and governance ride one mechanism.

The engine composes AWS managed primitives (Amazon Chime SDK Messaging, Bedrock, S3, Cognito/STS, IAM, Kinesis), so inference, moderation, message delivery, and retention are AWS's to operate, not yours to build. The platform integrates your identity provider rather than replacing it: every provider a deployment accepts is an entry in its trusted-issuer registry (its own Amazon Cognito pool, an OIDC provider or a Microsoft Entra tenant verified directly with no pool at all, a SAML or OIDC provider federated into the pool, a host application's signed assertion, or the platform's own guest issuer for an anonymous visitor), and each entry declares what its people may reach, translating the provider's own groups into the deployment's. Real workflows span sales, a scheduled service visit, and a support case - across business units, internal employees, and outside partners - so the same platform expresses a 1:1 tiered chat, a routed support case, a masked service call, or an alert-triggered incident-triage room by **configuration, not new code**. (Connectors to external systems of record are opt-in, declared with the `connectors` capability: vendor events arrive through Amazon EventBridge and per-person grants are held; acting on a vendor event is **NOT BUILT**.)

**Security** - Every conversation runs inside your AWS account on infrastructure you own, and enforcement is the cloud's own, not a bolted-on policy engine. IAM - keyed on each channel's immutable `classification` tag and bearer-pinned to each user's *own* identity - decides not just which models a classification may use but which conversations a user (or an assistant) can read or send in: fail-closed, evaluated before any request is processed, and provable with a deny-test rather than a code review. This does not hinge on the identity provider: authentication plugs into yours through the trusted-issuer registry, a person is their Amazon Chime SDK AppInstanceUser whichever issuer signed them in, and the frontend obtains Amazon Chime SDK credentials *only* through the bearer-pinned, classification-bound credential exchange, never a shared backend credential. Bedrock Guardrails filter PII, prompt injection, and sensitive content on every model turn. Admins can browse, moderate, redact, or delete any message.

**Cost control** - Each classification is served by a capability profile that fixes which model answers, so which models a conversation may use is governed per classification (the sample deployment ships `basic`/`standard`/`premium`, a tiered-chat example whose grant sets nest only because the sample is configured that way - rename them, or declare sets that do not nest, for your own taxonomy; the shipped outside `customer` classification is reached by no member classification). Intent-based routing sends each request to the model you assign it, so the default keeps cost down by using the cheapest model that fits (Haiku for Q&A, Sonnet for code, Opus only when deep reasoning is needed) - and you can change any of it. A/B experiments let you prove whether a cheaper model performs just as well before switching. Circuit breakers and fallback chains protect against runaway quota spend.

**Quality of output** - Every response is tracked with model, latency, token count, intent classification, and optional human evaluation scores. The admin dashboard shows model effectiveness by intent, flagged response review queues, [drift detection](#drift-detection-aurora-only), and side-by-side A/B experiment results. You measure what you ship.

## Overview

Built with React 19 and AWS CDK, Agent Echelon combines real-time messaging, durable conversation history, fine-grained access control, file attachments, multi-step task workflows, and a comprehensive admin console. It is a **custom architecture built on AWS primitives** (Amazon Chime SDK, Amazon Bedrock, Cognito, STS, S3, DynamoDB) - not a managed offering - and it deploys **entirely to your own AWS account**.

### Key Features

**Model routing and resilience:**
- **Multiple Bedrock Model Families** - Anthropic Claude, Amazon Nova, OpenAI GPT-OSS, and DeepSeek V3.2 selectable per classification at deploy time (the provider layer also supports external HTTP APIs, proven by the image-generation path)
- **Intent-Based Model Routing** - You control which model handles each intent (e.g., Haiku for Q&A, Sonnet for code, Opus for analysis) via a configurable per-classification routing strategy, with configurable fallback chains. 
- **Bedrock Resilience** - Exponential backoff retry on throttling, automatic model fallback on quota exhaustion, and circuit breaker to protect against cascading failures
- **A/B Model Testing** - Experiment framework for comparing models per intent with deterministic conversation-level variant assignment and side-by-side analytics
- **Cost and Abuse Controls** - Per-user and global hourly Bedrock spend budgets, per-classification request rate limiting, request dedup, an inbound length cap, and a global circuit trip - distinct from the model-fallback resilience above (see [SPEC-ABUSE-CONTROLS](./docs/specs/interaction/governance/SPEC-ABUSE-CONTROLS.md))

**Collaboration and access control:**
- **AWS-Native Persistent Messaging** - Real-time WebSocket delivery with durable conversation history using AWS-managed messaging infrastructure
- **Role-Based Access** - Control model access by classification (the shipped `basic`/`standard`/`premium`, or a set the deployment declares in `profiles`) through IAM policies on each conversation's `classification` tag
- **Any Identity Provider** - Each provider is one entry in the trusted-issuer registry (`issuers` in `deploy.config.json`), declaring its clearance source and the classifications it may grant; adding a provider of a built kind changes no code (see [Identity Provider Guide](docs/guides/user/IDENTITY-PROVIDER-GUIDE.md))
- **File Attachments** - S3-based secure upload/download with presigned URLs, drag-and-drop support
- **Multi-Step Task Workflows** - Guided troubleshooting, data extraction, and report generation with state tracking across conversation turns
- **Conversation Archive, Leave & Remove** - A moderator can archive a conversation (read-only + hidden from the active list; membership retained, so members keep read-only access until the 90-day expiry) or remove a member; any member can leave (see [SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP](./docs/specs/interaction/conversation/SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md))

- **One Turn at a Time** - A conversation answers one turn at a time. Messages arriving while an assistant is working are held and acknowledged visibly, read as a GROUP rather than one at a time, and turned into durable work items before any of it runs - so a burst of three related messages is answered as one request instead of three overlapping replies. A message the assistant cannot make sense of becomes a question it asks, not work it invented (see [SPEC-TURN-QUEUE](./docs/specs/interaction/conversation/SPEC-TURN-QUEUE.md)).

**Admin operations and analytics:**
- **IAM-Enforced Admin Actions** - Every privileged admin action (view-all-events, moderation, redact / delete, archive and attachment reads) gates on an IAM-enforceable capability, not `admins`-group membership alone. For each operation the console obtains a short-lived, bearer-pinned, action-scoped credential from the credential exchange, so a role can be denied a specific action, the vend is auditable, and isolation is provable with a deny-test (see [SPEC-ADMIN-IDENTITY](./docs/specs/interaction/governance/SPEC-ADMIN-IDENTITY.md))
- **Admin Analytics Console** - Conversation volumes, model usage, model-by-intent effectiveness, evaluation scores, user activity, and user feedback summaries
- **Conversation Operations** - Browse conversations from the analytics archive, per-message inspect (all fields + metadata), member add/remove, membership-history timeline, and redact / delete - each live action runs in the browser as the admin's own `<person>-admin` identity, vended per conversation by the credential exchange
- **Model Strategy Console** - Intent-to-model routing visibility with provider posture, fallback pairings, cost/latency classes
- **Experiments Console** - Create, pause, and complete A/B model experiments with side-by-side variant results (score, latency, tokens, compliance, fallback rate)
- **User Management** - Approve, reject, change classification, and enable/disable users from the admin dashboard
- **Evaluation Suite** (Aurora mode) - Multi-turn flow evaluation, flagged response review, ground truth human scoring, task completion tracking
- **Live Drift Detection** (Aurora mode only, see [section below](#drift-detection-aurora-only)) - Cosine-similarity drift detection over Titan v2 embeddings, with a live user-facing suggestion to split or switch the conversation when topics shift

**Infrastructure:**
- **Per-classification assistant stacks** - Each classification's profile runs a self-hosted Bedrock Converse tool loop with its own model, content guardrail, in-Lambda tools, and channel-flow routing (no managed Bedrock Agent)
- **Centralized Model Strategy** - Model IDs, IAM allowlists, and routing config derive from a single shared config
- **Optional Aurora Mode** - Aurora PostgreSQL + VPC for advanced analytics (set `"analyticsMode": "aurora"` in `backend/deploy.config.json` before the first deploy)

### Athena vs Aurora Mode

Agent Echelon deploys in **Athena mode** by default (lower cost, simpler). Aurora mode adds advanced capabilities at the cost of a VPC + Aurora Serverless v2 cluster.

**Chosen at first deploy.** Pick the mode before the first deploy. Switching an existing deployment between Athena and Aurora is not supported: both archive modes create the same fixed-name resources, so `npm run deploy` refuses a deploy that would switch. Changing modes means tearing the deployment down and deploying fresh, which starts it empty (see [Switching modes](docs/guides/admin/AURORA-MODE-GUIDE.md#switching-modes)).

**Testing focus.** Athena mode is provided as a lower-cost way to run the platform. Testing is focused primarily on Aurora mode: the end-to-end suite and `validate` are run against an Aurora-mode deployment, so Athena mode gets less end-to-end coverage. Exercise it in your own environment before relying on it (see [Testing focus](docs/guides/admin/AURORA-MODE-GUIDE.md#testing-focus)).

| Feature | Athena (default) | Aurora |
|---------|:---:|:---:|
| Message archiving (Kinesis -> S3) | Yes | Yes |
| Admin dashboard: Overview, Models, Conversations, Users, Latency | Yes | Yes |
| Admin dashboard: Evaluations (basic scores) | Yes | Yes |
| User management (approve/reject/classification) | Yes | Yes |
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
- No drift detection. Drift requires Aurora's pgvector cosine similarity and the summary-updater Lambda; neither exists in Athena mode. Deploying with `enableLiveDrift=true` in Athena mode is a misconfiguration - the feature silently skips every turn.
- Admin dashboard shows only aggregate metrics from S3/Athena, not per-exchange detail
- Aurora-only views (the Effectiveness drill, Alerts, Flagged, Ground Truth) are hidden. Flows and Tasks are not standalone tabs; their detail lives inside the Effectiveness drill

**Graceful degradation:** The app is designed to run fully in Athena mode without errors. Aurora-only admin tabs are hidden (not shown as broken). Task tracking in async processors silently skips DynamoDB writes when `TASKS_TABLE` is not configured - the bot still generates responses, just without multi-turn state. The premium classification's S3 knowledge base context is optional - if `CONTEXT_BUCKET` is empty, responses are generated without enrichment. The admin dashboard shows an informational banner when no analytics data has been archived yet, explaining the pipeline delay and suggesting Aurora mode for advanced features. Cross-conversation context and drift detection are never referenced in Athena mode.

## Documentation

The full documentation lives under [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md), organized by what you are doing: **deploy it** (user guides), **operate it** (admin guides), **extend it** (the [Developer Guide](docs/guides/developer/DEVELOPER-GUIDE.md)), and **understand it** (specs by domain plus the decision records). Start at the map: **[docs/DOCUMENTATION.md](docs/DOCUMENTATION.md)**.

## Architecture

> **Full architecture guide:** [docs/overview/ARCHITECTURE.md](docs/overview/ARCHITECTURE.md) covers all flows end-to-end: authentication, message routing, intent classification, file attachments, conversation sharing, analytics pipelines, and CDK stack dependencies.

```
┌──────────────────────────────────────────────────────────────────┐
│                         React Frontend                           │
│   AuthProvider -> AwsClientProvider -> MessagingProvider ->       │
│   ConversationProvider          (Vite + TypeScript + React 19)    │
└───────────────┬───────────────────────────────┬──────────────────┘
        WebSocket│                           REST │
                 ▼                                ▼
┌───────────────────────────┐   ┌───────────────────────────────────┐
│  Identity provider: any   │   │   PersonApi (one HTTP API,        │
│  issuer the registry      │   │   edge authorizer) . credential-  │
│  declares (pool, SAML,    │   │  exchange (the SOLE source of     │
│  OIDC, Entra, guest)      │   │  Amazon Chime SDK creds) .        │
└────────────┬──────────────┘   │  create-conversation . share .    │
             │ token, then the  │  presigned-url . events           │
             ▼ vended creds     └───────────────────────────────────┘
┌───────────────────────────┐
│    Amazon Chime SDK        │
│    Messaging (WebSocket +  │
│    durable message store)  │
└────────────┬──────────────┘
             │ channel message event
             ▼
┌───────────────────────────┐   runs FIRST on every message: mention
│   Channel Flow Processor   │   rules + filtering. @all (and /battle)
└────────────┬──────────────┘   bypass Lex and invoke the async
             │ (otherwise)       processor directly.
             ▼
┌───────────────────────────┐   entry trigger only (Dialog Code
│    Amazon Lex V2 Bot       │   Hook): not a classifier or router.
│    (one per assistant)     │
└────────────┬──────────────┘
             │ Lex fulfillment -> shared router-agent-handler.ts
             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Per-classification handler + async processor (one per profile)   │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐   sample models shown -   │
│  │  basic  │  │ standard │  │ premium  │   configurable per        │
│  │ (Haiku) │  │ (Sonnet) │  │  (Opus)  │   classification + intent │
│  └────┬────┘  └────┬─────┘  └────┬─────┘                          │
│       └────────────┼─────────────┘                                │
│                    ▼                                               │
│   Self-hosted Bedrock Converse tool loop (in-Lambda tools) +      │
│   content guardrail; intent -> model routing with fallback        │
└──────────────────────────┬───────────────────────────────────────┘
             ┌─────────────┼──────────────┐
             ▼             ▼               ▼
   ┌──────────────────┐ ┌─────────┐ ┌────────────────────┐
   │  Amazon Bedrock  │ │  Amazon │ │     Analytics      │
   │ (Claude . Nova . │ │   S3    │ │  (Athena or Aurora │
   │   GPT-OSS)       │ │ (files) │ │   mode)            │
   └──────────────────┘ └─────────┘ └────────────────────┘
```

**Reading the flow:** the **Channel Flow Processor** runs first on every message (mention rules, filtering, marker stripping); `@all` bypasses Lex and invokes the async processor directly. **Amazon Lex is only the entry trigger** (an Amazon Chime SDK-to-Lambda passthrough via its Dialog Code Hook), not a classifier or router. Each assistant has its own Lex bot, built at runtime by the provisioner in `Messaging` (no stack owns one), and it fulfills into its classification's own handler Lambda: all run the shared `router-agent-handler.ts` code but are deployed one per classification (per-classification ownership, ADR-011). The models shown are the sample **defaults**; model selection is configurable per classification and per intent via `model-strategy` (Anthropic Claude, Amazon Nova, OpenAI GPT-OSS), so the platform is model-agnostic. The token a person signs in with is verified at `PersonApi`'s edge authorizer against the trusted-issuer registry, and the credential exchange vends the only AWS credentials a client holds, bearer-pinned to the person's own AppInstanceUser; there is no Identity Pool. The full diagram, with the REST lanes and every enforcement point, is in [docs/overview/ARCHITECTURE.md](docs/overview/ARCHITECTURE.md).

### Provider Hierarchy

```
AuthProvider → AwsClientProvider → MessagingProvider → ConversationProvider
```

- **AuthProvider**: sign-in through any issuer the trusted-issuer registry declares (the pool's password flow, or code plus PKCE for a redirect issuer), with automatic token refresh
- **AwsClientProvider**: Amazon Chime SDK client initialization with bearer-pinned credentials from the credential exchange
- **MessagingProvider**: WebSocket session management with channel-specific callbacks
- **ConversationProvider**: Conversation CRUD, message state, optimistic updates

## Project Structure

```
agentechelon/
├── frontend/                 # npm-workspaces monorepo (Vite + TypeScript + React 19)
│   ├── package.json          # workspace root (scripts: dev:chat / dev:admin / build:*)
│   ├── tsconfig.base.json
│   └── packages/
│       ├── shared/           # @ae/shared - code both apps import
│       │   └── src/          # providers (AuthProvider: Cognito auth + token refresh),
│       │                     #   components, services, api, config, i18n, types, utils
│       ├── chat/             # @ae/chat - the end-user chat app
│       │   ├── .env.example
│       │   └── src/
│       │       ├── components/   # conversation UI, attachments, auth screens
│       │       ├── providers/    # AwsClientProvider, MessagingProvider,
│       │       │                 #   ConversationProvider.chime
│       │       └── services/     # chime / attachment / analytics clients
│       ├── admin/            # @ae/admin - the standalone admin console
│       │   ├── .env.example
│       │   └── src/
│       │       ├── components/admin/   # analytics dashboard tabs
│       │       ├── config/
│       │       └── services/
│       └── widget/           # @ae/widget - the embeddable widget: the framed document and embed.js
│           ├── .env.example
│           └── src/
│               ├── components/   # launcher, panel, transcript, refusal states
│               ├── session/      # guest start, the refresh leader, the host assertion
│               └── embed/        # the host-page loader
│
├── backend/                  # AWS CDK infrastructure
│   ├── lib/stacks/           # Modular CDK stacks
│   │   ├── messaging-stack.ts       # Messaging: the app instance and the message stream
│   │   ├── identity-stack.ts        # Identity: the pool when declared, the credential exchange, Identities, the trail
│   │   ├── conversations-stack.ts   # Conversations: shared tables, attachments, feedback
│   │   ├── archive-stack.ts         # Archive, Athena mode
│   │   ├── archive-stack-aurora.ts  # Archive, Aurora mode
│   │   ├── assistant-profile-stack.ts   # AssistantsStack: one Assistants-<classification> per registry classification
│   │   ├── experiments-stack.ts     # Experiments: the experiments table and its SSM contract
│   │   ├── battle-stack.ts
│   │   ├── notification-stack.ts    # Notifications: email, and the only SES send grant
│   │   ├── admin-services-stack.ts  # AdminServices: every admin handler, the admin exchange, the alert channel
│   │   ├── admin-api-stack.ts       # AdminApi: one HTTP API, every admin route, behind IAM
│   │   ├── person-api-stack.ts      # PersonApi: one HTTP API, every person route, behind the edge authorizer
│   │   └── operations-stack.ts      # Operations: the deployment-wide dashboard
│   ├── lambda/               # Lambda functions
│   │   ├── cognito-triggers/
│   │   ├── presigned-url/
│   │   ├── share-conversation/
│   │   └── src/
│   │       ├── create-conversation.ts          # create-conversation handler
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
│   │       │   └── schema/           # NNN-*.sql migrations (applied at runtime)
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

- Node.js 20+ (matches the Lambda runtime)
- AWS CLI configured with appropriate credentials
- AWS CDK CLI (`npm install -g aws-cdk`)
- Access to Amazon Bedrock models in your AWS account

> **Dependency security.** Install with `npm ci`, not `npm install`: it installs the exact tree in the committed lockfile, which is what bounds the `^` ranges in the manifests. Every install root ships a committed `.npmrc` with `ignore-scripts=true`, which blocks dependency lifecycle scripts - the primary execution vector for npm supply-chain attacks. See [docs/guides/developer/SECURITY-NPM-SUPPLY-CHAIN.md](docs/guides/developer/SECURITY-NPM-SUPPLY-CHAIN.md) for the rationale, the audit, release-delay and credential practices, and how to scan the manifests and lockfiles for a package or version an advisory names.

### Deploy Backend

```bash
cd backend
npm ci   # exact, lockfile-pinned install (not `npm install`); .npmrc blocks install scripts

# Bootstrap CDK (first time only)
cdk bootstrap aws://ACCOUNT-ID/REGION

# Create this instance's deploy context from the example (gitignored), then edit it:
# at minimum set senderEmail, and analyticsMode ("athena" or "aurora") before the first deploy
cp deploy.config.example.json deploy.config.json

# Run deployment doctor checks before deploying
npm run doctor

# Deploy all stacks. Which models each classification uses is its own `models` in `profiles`;
# no context key picks a model (docs/guides/developer/MODEL_STRATEGY.md).
npm run deploy
```

`npm run deploy` refuses to run without `backend/deploy.config.json`, and refuses a config that omits any key whose absence removes something already deployed: `appUrl`, `adminAppUrl`, `capabilities`, `issuers`, `connectors`, `enableLiveDrift`, `analyticsMode` and `imageGenKeysSecretArn` (`DESTRUCTIVE_IF_ABSENT` in `backend/lib/config/deploy-context.ts`). A key present with an empty value (`""`) takes its default, so a copy of the example passes as it stands. `--allow-partial-config` skips the check. The sender address is the `senderEmail` key; the `SES_SENDER_EMAIL` environment variable is read only when the context carries no `senderEmail`, and the example carries one, so set the key.

### The minimal deployment

The smallest deployment is an anonymous visitor talking to one assistant in the embeddable widget, with no accounts and no user pool: the required core, the guest issuer and the `widget` capability. Its `backend/deploy.config.json` declares:

```json
{
  "capabilities": ["widget"],
  "profiles": ["guest", "customer"],
  "issuers": [{
    "id": "guest",
    "kind": "guest",
    "clearance": { "fixed": ["guest"], "classifications": ["guest"] },
    "allowedOrigins": ["https://www.example.com"]
  }],
  "appUrl": "",
  "adminAppUrl": "",
  "connectors": [],
  "enableLiveDrift": false,
  "analyticsMode": "athena",
  "imageGenKeysSecretArn": ""
}
```

- The last six keys carry their defaults and are there because `npm run deploy` refuses a config that omits them (`DESTRUCTIVE_IF_ABSENT`, above).
- `allowedOrigins` names the host pages that embed the widget; the `Widget` stack's `frame-ancestors` is generated from it.
- A guest issuer needs both outside classifications declared, `guest` and `customer`, and synth refuses it otherwise ([GUEST-ISSUER](docs/guides/admin/GUEST-ISSUER.md#declaring-it)).
- Outside production, a guest issuer that names no captcha uses Cloudflare Turnstile's always-pass test keys; production refuses them.
- The stacks are `Messaging`, `Identity` (the guest issuer and the platform trail, no user pool), `Conversations`, `Archive`, `ChannelFlow`, `Assistants-guest`, `Assistants-customer`, `PostProcessing`, `PersonApi` and `Widget`, plus one `ImageGuardrail-<region>` per region hosting an active image model outside the deploy region.

`npm run deploy` publishes the widget build to the `Widget` distribution, and resolves `widgetUrl` from that distribution's `WidgetDistributionUrl` output the way it resolves `appUrl`, so `PersonApi` admits the frame's calls in CORS: up front when the distribution exists, and on its first deploy in one extra backend pass of the same run. A host page then includes `<widget origin>/embed.js` and calls `AEWidget.mount({ mode: 'guest' })` ([SPEC-EMBEDDABLE-WIDGET](docs/specs/interface/SPEC-EMBEDDABLE-WIDGET.md)).

**Verified by:** `backend/test/deploy-matrix/c0-anonymous-widget.test.ts`, which synthesizes `["widget"]` with the guest issuer as the only registry entry and `["guest", "customer"]` as the profiles, in both analytics modes, and checks its exact stack set (C0 in `backend/test/deploy-matrix/configurations.ts`).

Accounts, the chat app and the admin console are added by declaring them: an issuer for the deployment's own pool (or a provider federated into it) in `issuers`, and `chat` and `admin` in `capabilities`. The shipped `backend/deploy.config.example.json` declares that larger set.

`npm run deploy` is the supported path: it builds first (the Lambda bundler ships compiled `.js`, so a stale build deploys silently otherwise), refuses an `--all` deploy if any stack falls outside the instance prefix (the safety gate for shared accounts), and forwards the persisted per-instance context from `backend/deploy.config.json`. A raw `cdk deploy` skips all of this: it forwards none of the persisted context, so every context-gated flag reverts to its default, and it runs neither the build nor the analytics-mode and rollback checks. Deploy one stack with `npm run deploy:stack -- <Stack>` (`--diff-only` to look first) instead.

**What deploys is what `capabilities` declares.** `backend/deploy.config.json` lists the capabilities a deployment stands up beyond the required core (`widget`, `chat`, `admin`, `notifications`, `experiments`, `battle`, `connectors`, `operations`; see `capabilities` under Configuration), and synth refuses an unknown name, a capability that is **NOT BUILT**, and one missing a capability it requires. The core always deploys, with one `…Assistants-<classification>` stack per classification the deployment declares in `profiles` (`basic`, `standard` and `premium` when it declares none; `guest` and `customer` only where declared).

**Deploying one stack at a time follows the dependency order `npm run deploy` uses.** A stack that resolves another stack's parameter at deploy deploys after it: the battle stack before the battle-capable `…Assistants-*` stacks, which read its tables, and the `…Assistants-*` stacks before the channel flow, post-processing and `…AdminServices`, which read their routers and task services. Deploying out of order fails with `Unable to fetch parameters [...] from parameter store`, which reads as a missing account permission and is really a missing parameter. Use `npm run deploy:stack -- <Stack>`, which forwards the full context.

### Email & the SES Sandbox (read this - it affects whether email works)

Two features send outbound email, both through the same SES path:

- **Conversation sharing** - when a user shares a conversation, the recipient gets an invite.
- **Proactive briefing** - the scheduled, no-user-in-the-loop workflow emails every configured member (see [Proactive Briefing](#proactive-briefing) below).

How it behaves, in order of likelihood for a fresh deploy:

1. **No sender set** (no `senderEmail` key and no `SES_SENDER_EMAIL` environment variable) → it defaults to the placeholder `noreply@example.com`. The code **does not silently fail**: it skips the send and returns a visible reason (the share UI shows a warning; the proactive Lambda logs and reports `emailSkipped`). Redeploy with a real address to enable email at all.
2. **Sender not yet verified** → after the first deploy, SES sends a verification email to the sender address. **Click the link.** Until the sender identity is verified, every `SendEmail` call fails.
3. **SES sandbox (the default for every new AWS account)** → sandbox imposes three limits you *will* hit:
   - **Every recipient must also be a verified identity** - not just the sender. A share to an unverified address, or a proactive briefing whose recipients (`briefingRecipientArns`) have unverified addresses, will fail for those recipients (the workflow is resilient - verified recipients still receive, failures are reported per-recipient, the run does not abort).
   - **~200 emails / 24h and 1 message / second.**
   - To send to arbitrary recipients and lift the quota, [request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) in the SES console (typically approved within a day).

For a demo on a sandbox account: verify the sender **and** each demo recipient address in the SES console first, or email simply won't be delivered even though the rest of the workflow (conversation created and seeded) succeeds.

Every email a person can stop (a conversation notice, a share, a briefing, an alarm) carries one-click unsubscribe (`List-Unsubscribe` and `List-Unsubscribe-Post`, RFC 8058) and a link to a preference page, both keyed to the person's AppInstanceUser rather than their address. Invitations and other mail a person must act on are always sent. Replies by email are opt-in: set `replyDomain` (a subdomain used only for replies) and `replyRuleSet` (your account's active SES receipt rule set), point the subdomain's MX record at SES, and a reply to a conversation notice is posted into that conversation as the person who sent it, only when its reply token, DMARC and From address all check out (`docs/specs/communication/SPEC-NOTIFICATION-BRIDGE.md`).

### Proactive Briefing

A scheduled, fully proactive workflow (no user request): an **EventBridge** rule fires the `ProactiveBriefingFunction`, which creates a conversation, seeds it with the briefing, and emails every member a link into that conversation via the notification workflow above. The link opens only for a member who signs in.

Configure it at deploy time with two keys in `backend/deploy.config.json`, then run `npm run deploy` (it safely no-ops with no recipients; the `notifications` capability deploys it):

```json
"briefingRecipientArns": "<appInstanceArn>/user/<personId>,<appInstanceArn>/user/<personId>",
"briefingScheduleRate": "rate(1 day)"
```

`briefingScheduleRate` defaults to `rate(1 day)` and takes any EventBridge schedule expression. `ADMIN_EMAIL=<address> npm run provision-admin -- --print-arn` prints a pool user's AppInstanceUser ARN once they have signed in.

EventBridge can't be triggered from a browser, so to see it immediately (or for the Part 1 demo) invoke it once manually:

```bash
aws lambda invoke --function-name <ProactiveBriefingFunctionName CDK output> /dev/stdout
```

Recipients are people, by AppInstanceUser ARN; each address is read from the person's identity provider when the briefing is sent. Sandbox caveat: those addresses must be SES-verified in sandbox mode (see above).

### Deployment Doctor

The backend includes a lightweight deployment validation command:

```bash
cd backend
npm run doctor
```

It checks for (`backend/scripts/deployment-doctor.mjs`):

- AWS credentials and region in the environment (`AWS_PROFILE`, `AWS_ACCESS_KEY_ID` or `CDK_DEFAULT_ACCOUNT`; `CDK_DEFAULT_REGION` or `AWS_REGION`)
- `frontend/packages/chat/.env` exists and fills every key in its `.env.example` (on a fresh clone this warns until the first deploy writes it)
- the `APP_URL` environment variable, when set, points at the `5173` dev server
- `SES_SENDER_EMAIL` set in the environment (it does not read `senderEmail` from `deploy.config.json`)
- the analytics mode, read from `CDK_CONTEXT_ANALYTICS_MODE` and always reported as a pass (it does not read `analyticsMode` from `deploy.config.json`)
- each entry of `issuers` in `deploy.config.json`: a named Cognito pool exists, an OIDC discovery URL answers with the declared issuer, a host-assertion issuer pins a public key

Each check prints `[ok]` or `[warn]`, and the command exits 0 either way. Run it before `npm run deploy` to catch common local configuration issues early.

### Configure Bedrock Access

Request model access in AWS Console:

1. Navigate to **Bedrock > Model access > Manage model access**
2. Enable the following models:
   - `anthropic.claude-opus-4-6-v1` (premium classification)
   - `anthropic.claude-sonnet-4-6` (standard classification)
   - `anthropic.claude-haiku-4-5-20251001-v1:0` (Claude Haiku 4.5: basic, guest and customer classifications, the intent classifier and utility calls; invoked through the `us.` cross-region inference profile, `backend/lib/config/model-strategy.ts`)
   - `amazon.nova-pro-v1:0` (Amazon Nova Pro - the `titan` catalog key)

### Run Frontend (local development)

```bash
cd frontend
npm ci   # exact, lockfile-pinned install (not `npm install`)

# Copy the per-package env template and update with CDK outputs
# (frontend is a workspaces monorepo - each app has its own .env)
cp packages/chat/.env.example packages/chat/.env     # chat app
cp packages/admin/.env.example packages/admin/.env   # admin console (optional)
# ...or generate both from stack outputs: node ../backend/scripts/gen-frontend-env.mjs

# Start a development server (per app)
npm run dev:chat     # end-user chat app
npm run dev:admin    # admin console
```

`npm run deploy` already writes both `.env` files. The backend allows one chat origin, the `appUrl` context, and with `chat` declared `npm run deploy` sets it to the chat app's CloudFront origin, so a dev server on `http://localhost:5173` fails CORS against that deployment. Point the backend at the dev server first with `cd backend && npm run deploy -- --context appUrl=http://localhost:5173`, which takes the CloudFront origin out until the next plain `npm run deploy` ([Local development](docs/guides/user/FRONTEND-DEPLOY.md#local-development-vite-dev-server)). Allowing both origins at once is **NOT BUILT**.

### Deploy Frontend (production - CloudFront + S3)

For a real, shareable deployment the SPA is hosted on **CloudFront + private S3 by default**. The `<prefix>ChatApp` stack (`AgentEchelonChatApp` for the default instance name, created by `npm run deploy` when `chat` is a declared capability) provisions the chat hosting, and `npm run deploy` also builds and publishes the app. To publish a frontend change alone:

```bash
cd backend
npm run deploy-frontend            # chat app: builds packages/chat/dist, syncs to S3, invalidates the CDN
npm run deploy-frontend -- --admin # admin console (opt-in; see the admin-console note below)
```

The build bakes in CDK outputs, so each app's `.env` (`frontend/packages/{chat,admin}/.env`) must hold the stack outputs first; `npm run deploy` writes them, and `backend/scripts/gen-frontend-env.mjs` rewrites them. `npm run deploy` also resolves `appUrl` from the live chat distribution, in one extra backend pass on that distribution's first deploy, so the backend CORS allowlist includes the app origin; for a custom domain, pass `--context appUrl=https://<your domain>`. An optional `wafAllowedIps` context locks the distribution to known IPs. Full guide, including teardown and the security headers applied: **[`docs/guides/user/FRONTEND-DEPLOY.md`](docs/guides/user/FRONTEND-DEPLOY.md)**.

**Deploying the admin console.** The standalone admin console is a separate hosting stack that the backend creates when `admin` is a declared capability - a deployment can run headless or embed the console in its own app. To host it, add `"admin"` to `capabilities` in `deploy.config.json` and run `npm run deploy`. That one command:

1. Deploys the backend, which creates the `<prefix>AdminApp` origin (its own CloudFront + S3).
2. Publishes the admin build to it (`npm run deploy-frontend -- --admin`).
3. Resolves `adminAppUrl` from the admin distribution the same way it resolves `appUrl`, so the admin/analytics APIs' CORS allowlist trusts it (on the first deploy of that distribution, in one extra backend pass).

Deploy a single stack with `npm run deploy:stack -- <Stack>`, which applies `deploy.config.json` and refuses a missing `appUrl` (or `adminAppUrl` with the admin console declared); a raw `cdk deploy` without that context reverts every context-gated flag to its default ([`docs/overview/STACKS.md#deploy`](docs/overview/STACKS.md#deploy)). Running the admin plane behind your own console/auth instead: **[docs/guides/admin/ADMIN-INTEGRATION-GUIDE.md](docs/guides/admin/ADMIN-INTEGRATION-GUIDE.md)**.

### Create First Admin User

> **Embedding AgentEchelon behind your own app's auth?** This step (and AE's built-in admin console) is the **standalone default**, not a requirement. If your product already has users and operators, you can point AE's user plane at your IdP ([docs/guides/user/IDENTITY-PROVIDER-GUIDE.md](docs/guides/user/IDENTITY-PROVIDER-GUIDE.md)) and its admin plane at your own admin console + auth ([docs/guides/admin/ADMIN-INTEGRATION-GUIDE.md](docs/guides/admin/ADMIN-INTEGRATION-GUIDE.md)) - in which case you can skip creating an AE-Cognito admin entirely.
>
> | Plane | Standalone default | Host-owned option |
> |-------|--------------------|-------------------|
> | **User** (who can chat, at which classification) | The deployment's own Cognito pool (the `deployment` issuer, `pool: "self"`) | Your IdP, as an entry in the trusted-issuer registry - [IDENTITY-PROVIDER-GUIDE](docs/guides/user/IDENTITY-PROVIDER-GUIDE.md) |
> | **Admin** (who sees analytics / moderates) | AE `admins` group + AE dashboard | Your console - [ADMIN-INTEGRATION-GUIDE](docs/guides/admin/ADMIN-INTEGRATION-GUIDE.md) |
>
> **"Admin" means three distinct things** in this system (a Cognito *group*, the console IAM *role* the credential exchange vends, and an Amazon Chime SDK *service* principal), and the classification boundary lives on the credential exchange, the only source of a person's AWS credentials (there is no Identity Pool). The full, code-grounded account - with a capability matrix and a spec-drift table - is **[./docs/specs/interaction/governance/IDENTITY-AND-ACCESS-MODEL.md](./docs/specs/interaction/governance/IDENTITY-AND-ACCESS-MODEL.md)**. Read it before reasoning about who can do what.

New deployments have no users. Provision the first admin (from `backend/`):

```bash
# Default: Cognito emails a one-time temporary password; the app forces a permanent-
# password reset on first sign-in (NEW_PASSWORD_REQUIRED). To skip email (e.g. a local
# bootstrap), set ADMIN_TEMP_PASSWORD to a temporary password of your choice - the
# forced reset on first sign-in still applies. No permanent password is ever set here.
cd backend
AWS_PROFILE=your-profile ADMIN_EMAIL=admin@example.com ADMIN_TIER=premium npm run provision-admin
```

This creates a user in the classification `ADMIN_TIER` names (required, with no default) and adds it to that classification's group and the `admins` Cognito group (the deployment pool's clearance source). It creates no AppInstanceUser: the credential exchange mints the admin's AppInstanceUser at their first sign-in, and `--print-arn` prints it afterwards (`backend/scripts/provision-admin.mjs`). It resolves the user pool from the `<prefix>Identity` stack's outputs, and is idempotent (re-running updates the user and re-sends the invite). Then sign in at your deployed frontend URL - the `AgentEchelonChatApp` CloudFront distribution from the stack outputs (or http://localhost:5173 if you are running the app locally).

**Password requirements:** 8+ characters, uppercase, lowercase, digit, symbol.

Additional users can sign up through the registration form. New signups require admin approval before they can sign in: the pre-authentication trigger refuses a sign-in until `custom:approved` is `true`. Approve users in the admin console's Users tab, which sets the approval, places the user in exactly one clearance group and enables them. A person's clearance is their Cognito clearance group, not the `custom:tier` attribute. Sign-up places a new user in the group for the classification they requested, so approving by CLI means checking that group as well as setting the flag:

```bash
# The clearance the user requested at sign-up
aws cognito-idp admin-list-groups-for-user --user-pool-id YOUR_POOL_ID --username user@example.com

# To grant a different clearance: remove the requested group, add the one you grant
aws cognito-idp admin-remove-user-from-group --user-pool-id YOUR_POOL_ID --username user@example.com --group-name premium
aws cognito-idp admin-add-user-to-group --user-pool-id YOUR_POOL_ID --username user@example.com --group-name basic

# Approve
aws cognito-idp admin-update-user-attributes --user-pool-id YOUR_POOL_ID --username user@example.com \
  --user-attributes Name=custom:approved,Value=true
```

## Configuration

Create a `.env` file in each frontend package (`frontend/packages/chat/.env`, and `frontend/packages/admin/.env` for the admin console) - or generate them from the stack outputs with `backend/scripts/gen-frontend-env.mjs`:

```env
# AWS Configuration
VITE_AWS_REGION=us-east-1

# The deployment's own pool, when the trusted-issuer registry declares one (pool: "self")
VITE_USER_POOL_ID=your-user-pool-id
VITE_CLIENT_ID=your-client-id
# The app client a provider federated into the pool signs in through (UserPoolFederatedClientId); only when one is
VITE_FEDERATED_CLIENT_ID=
# The sign-in screen's issuers, projected from the registry by gen-frontend-env.mjs
VITE_ISSUERS='[...]'

# Amazon Chime SDK Configuration
# No bot ARN is needed - channels enroll the per-classification assistant server-side.
VITE_APP_INSTANCE_ARN=your-app-instance-arn

# API Endpoints
# REQUIRED, both packages - the person API (CDK output AgentEchelonPersonApi.PersonApiUrl). Its
# credential exchange is the sole source of Amazon Chime SDK credentials (bearer-pinned,
# classification-bound); unset means the frontend cannot reach Amazon Chime SDK.
VITE_PERSON_API_URL=your-person-api-url
# The capabilities whose person routes it serves (AgentEchelonPersonApi.PersonApiCapabilities),
# so a client offers a feature only where its route exists.
VITE_PERSON_API_CAPABILITIES=core
# Chat package only: the declared classifications for the registration screen, before sign-in, written by
# gen-frontend-env.mjs from the runtime registry rows, URI-encoded behind uri:. Signed in, both apps read the
# set from GET /classifications on the person API.
VITE_CLASSIFICATIONS=uri:...
# Admin console only (frontend/packages/admin/.env), from the AgentEchelonAdminApi outputs.
VITE_ADMIN_API_URL=your-admin-api-url
VITE_ADMIN_API_CAPABILITIES=admin
```

### Backend deploy-time configuration (CDK context)

Backend config is set at deploy time via CDK context: a key in `backend/deploy.config.json`, which `npm run deploy` and `npm run deploy:stack` forward, or `--context key=value` after `npm run deploy --`, which wins for that run. Defaults are shown; deeper detail for the admin-identity, membership-audit, and abuse-control keys lives in the linked docs.

| Context key | Default | What it does |
|---|---|---|
| `analyticsMode` | `athena` | `athena` (serverless, cheap) or `aurora` (VPC + Aurora + pgvector; adds evaluation, drift, RAG). Chosen at first deploy; switching an existing deployment is not supported (see [Switching modes](docs/guides/admin/AURORA-MODE-GUIDE.md#switching-modes)). |
| `enableRdsProxy` | `false` | Aurora-only, opt-in RDS Proxy connection pooling (~$88/mo floor). Default is direct writer-endpoint IAM auth. |
| `enableLiveDrift` | `false` | Aurora-only, opt-in live drift suggestions in the message path. |
| `capabilities` | (none: the core alone) | The capabilities this deployment stands up beyond the required core, as a list: `chat` (the chat app hosting), `admin` (`AdminServices`, every admin handler and the admin notification channel; `AdminApi`, every admin route; and the admin console hosting), `notifications` (email), `experiments` (the A/B experiments table; its administration handlers are in `AdminServices` and its routes on `AdminApi`), `battle` (battles; requires `experiments`; whether a classification can run one is its `battleCapable` field in `profiles.ts`), `operations` (the deployment-wide dashboard), `connectors` (the vendors the `connectors` key declares, each one that subscribes to vendor events receiving them through the vendor's Amazon EventBridge partner event source) and `widget` (the embeddable widget hosting, framed only by the hosts the issuers declare in `allowedOrigins`). `meetings` is **NOT BUILT** and refused at synth. `npm run deploy` refuses a `deploy.config.json` without the key, because an absent list removes every stack outside the core. |
| `profiles` | (none: the shipped catalog minus `guest` and `customer`) | The classifications and assistant profiles this deployment runs (`resolveDeploymentProfiles`, `backend/lib/config/profiles.ts`), one `Assistants-<classification>` stack each. A list selects from the shipped catalog (`["basic", "standard", "premium", "guest", "customer"]`), and a role is declared by naming its assistant beside its classification: `["basic", "standard", "premium", "ops-premium"]` deploys the premium ops assistant, and a declared role is deployed (`npm run add-assistant-role` adds the name and deploys `Assistants-premium`). An object (`classifications`, `profiles`, `groupClearance`) is a fully custom set that replaces it. The admin plane (`admin`, its `admin-agent` assistant and the `admins` group) is in every set. Synth refuses a set `validateProfilesConfig` refuses, and an issuer, link classifications or served conversation type naming a classification the set does not declare: a guest issuer needs `guest` and `customer`. See [HOW-TO-ADD-OR-MANAGE-A-PROFILE](./docs/guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md) section 1.5. |
| `connectors` | (none) | The connector registry, beside the `connectors` capability (`backend/lib/config/connectors.ts`): each external vendor (`pagerduty`, `salesforce`), the vendor events it receives and the Amazon EventBridge partner event source they arrive through (`eventSource`), the classification those events concern, and whether it takes per-person grants. A person a vendor names is resolved only through `Identities`, never by email. Synth refuses either one declared without the other. |
| `analyticsVpcId` / `createVpcEndpoints` | create / `true` | Aurora-only: import an existing VPC instead of creating one; skip interface/gateway endpoints when the imported VPC already egresses. With `createVpcEndpoints=false`, `npm run deploy` and `npm run deploy:stack` first check that the VPC's own endpoints route everything the in-VPC handlers call, and refuse a gap (`npm run check:vpc` runs the check alone; [SPEC-AURORA-VPC-MODE, Appendix G](docs/specs/foundations/SPEC-AURORA-VPC-MODE.md#appendix-g---imported-vpc)). |
| `sleepMode` | `false` | Aurora-only auto-pause to 0 ACU when idle (`sleepAfterIdle` default `2h`, `sleepCheckRate` default `rate(15 minutes)`). |
| `membershipAuditEnforce` | `false` | The Layer-6 uncleared membership audit is ALWAYS deployed (it flags uncleared members for review - a standing security guarantee). This sets enforcement mode: `false` = report-only (flag for review), `true` = auto-revoke the uncleared membership. Findings are `ae.alert` events, which `AdminServices` posts into the admin notification channel when `admin` is declared. `membershipAuditAlertChannelArn` is retired and synth refuses it. See [ADMIN-GUIDE](docs/guides/admin/ADMIN-GUIDE.md). |
| `adminAuthMode` | `ae-cognito` | Selects no authorizer: every admin route, `GET /feedback` included, is `AWS_IAM` in every deployment. Sets `ADMIN_AUTH_MODE` on the admin handlers; `ae-cognito` is the default, `federated` is retired and refused at synth, and `service` trusts any IAM-signed caller as admin (a trusted backend principal). `adminGroups` on the `deployment` entry of `issuers` (the trusted-issuer registry) names the admin group when it is not `admins`. See [SPEC-ADMIN-IDENTITY](./docs/specs/interaction/governance/SPEC-ADMIN-IDENTITY.md). |
| `issuers` | (the deployment's own pool alone) | The trusted-issuer registry (`backend/lib/config/issuers.ts`): every identity provider a person may sign in through, one entry each, with its kind, its clearance source, the classifications that source may grant and, for an issuer whose people may hold an admin session, `admin: true`. A token from an issuer it does not declare reaches nothing. See [IDENTITY-PROVIDER-GUIDE](docs/guides/user/IDENTITY-PROVIDER-GUIDE.md). |
| `widgetUrl` | (derived) | The widget frame's own origin (the `Widget` stack's `WidgetDistributionUrl` output), admitted by `PersonApi` CORS when `widget` is in `capabilities`. `npm run deploy` derives it from the live distribution, in one extra backend pass on that distribution's first deploy; set it only to override. |
| `adminAppUrl` | (unset) | The deployed admin-console origin, added to the admin/analytics APIs' CORS allowlist (the admin-plane analog of `appUrl`). With `admin` in `capabilities`, `npm run deploy` resolves it from the admin console's CloudFront distribution (`AgentEchelonAdminApp`); set it yourself for a custom domain. |
| `userProfileService` | (unset: the built-in user-profile table) | The ARN of a Lambda function that serves the per-person profile in place of the built-in table, declared beside `issuers`. Synth refuses a value that is not a Lambda function ARN; declared, it sets `USER_PROFILE_SERVICE_ARN` on each classification's router and grants it the invoke. See [SPEC-USER-PROFILE-AND-ONBOARDING](./docs/specs/interaction/conversation/SPEC-USER-PROFILE-AND-ONBOARDING.md). |
| `bedrockUserHourlyBudget` / `bedrockGlobalHourlyBudget` | (unset) | Per-user / global hourly spend limits (abuse controls). See [SPEC-ABUSE-CONTROLS](./docs/specs/interaction/governance/SPEC-ABUSE-CONTROLS.md). |
| `additionalRoles` | retired | Refused at synth. A role the deployment declares is deployed: name its assistant in `profiles` (`ops-premium`), or run `npm run add-assistant-role`. |
| `basicModelKey` / `standardModelKey` / `premiumModelKey` / `guestModelKey` / `customerModelKey` | retired | Refused at synth. A classification's models are its own selection, `models: { selected, default }` on its entry in `profiles` ([MODEL_STRATEGY](docs/guides/developer/MODEL_STRATEGY.md#three-layers)). |
| `assistantIntentPack` | (default pack) | The request-classification taxonomy (per deployment). |
| `senderEmail` | (required for email) | SES sender for notifications / conversation sharing. |
| `appUrl` | `http://localhost:5173` | Frontend origin for the backend CORS allowlist. With `chat` in `capabilities`, `npm run deploy` resolves it from the chat app's CloudFront distribution; set it yourself for a custom domain, or to `http://localhost:5173` for the Vite dev server (one chat origin at a time). |
| `frontendWaf` | `true` | Managed-rules WAF on the CloudFront distribution (`wafRateLimit`, `wafAllowedIps` tune it). |
| `environment` | `dev` | `dev` or `production`, and nothing else (`backend/lib/config/environment.ts`): `production` sets `RETAIN` removal policies + deletion protection on stateful resources. |

## Model Strategy

Model routing is capability-first rather than classification-first. The canonical backend strategy lives in:

- `backend/lib/config/model-strategy.ts`

That file defines:

- the current Bedrock model catalog
- classification availability for each model
- the IAM allowlist inputs
- intent-level preferred and fallback routing

At runtime, the **model resolver** (`backend/lambda/src/lib/model-resolver.ts`) uses this strategy to select the optimal model per intent while enforcing classification-based access control. If a model fails, the **resilience layer** (`backend/lambda/src/lib/bedrock-resilience.ts`) retries with exponential backoff then falls back to the strategy's fallback model. A **circuit breaker** prevents hammering a consistently failing model.

The admin console exposes:

- **Model Strategy** tab - read-only view of provider posture, intent routing, fallback pairings, cost/latency classes
- **Experiments** tab - create A/B tests comparing models per intent, with deterministic conversation-level variant assignment and side-by-side results

This keeps routing behavior in one shared config rather than hardcoded across stacks, so supporting additional providers or models is a config change, not a rewrite.

Implementation details for the shared routing metadata live in [docs/guides/developer/MODEL_STRATEGY.md](docs/guides/developer/MODEL_STRATEGY.md).

## User Tiers

The sample deployment is a **tiered chat**: three example classifications (`basic`/`standard`/`premium`) surfaced to users as tiers, each gating access to progressively more capable models. This is one example taxonomy, not the platform's model - rename or replace the classifications for your own data taxonomy (see [PLATFORM-OVERVIEW](docs/overview/PLATFORM-OVERVIEW.md)). In this sample:

| Tier | Models | Agent Handler |
|------|--------|---------------|
| Basic | Configurable basic model (default: Claude Haiku) | Task tracking + DynamoDB, 30s timeout |
| Standard | Configurable standard model plus standard-safe fallbacks | Task tracking + DynamoDB, 60s timeout |
| Premium | Configurable premium model with full catalog access | Full capabilities + analytics, 90s timeout |

## Aurora Mode Deployment (Optional)

Aurora mode adds RAG, live drift detection, cross-conversation context, and the full evaluation suite, backed by a VPC + Aurora Serverless v2 cluster with pgvector. Deploy it with `"analyticsMode": "aurora"` in `backend/deploy.config.json`, set before the first deploy. Full operator guide: [docs/guides/admin/AURORA-MODE-GUIDE.md](docs/guides/admin/AURORA-MODE-GUIDE.md); design and reference (VPC, endpoints, teardown, cost): [./docs/specs/foundations/SPEC-AURORA-VPC-MODE.md](./docs/specs/foundations/SPEC-AURORA-VPC-MODE.md).

## Drift Detection (Aurora-only)

When a message diverges from a conversation's running topic, the assistant offers to split or switch the conversation (Aurora mode; live path behind `--context enableLiveDrift=true`). Design and operation: [./docs/specs/interaction/assistants/SPEC-DRIFT-CONVERGENCE.md](./docs/specs/interaction/assistants/SPEC-DRIFT-CONVERGENCE.md).

## Cost Sleep Mode (Aurora-only)

Sleep mode auto-pauses the Aurora data plane after a configurable idle period and exposes an admin wake/sleep API, so an idle instance stops paying for the cluster. Design: [./docs/specs/foundations/SPEC-COST-SLEEP-MODE.md](./docs/specs/foundations/SPEC-COST-SLEEP-MODE.md).

## Admin Dashboard

The admin console groups analytics, conversation moderation (redact/delete), model strategy, A/B experiments, evaluation, and user management into a sectioned dashboard (Aurora-only tabs are hidden in Athena mode). Using it: [docs/guides/admin/ADMIN-GUIDE.md](docs/guides/admin/ADMIN-GUIDE.md). Design: [./docs/specs/interface/SPEC-ADMIN-CONSOLE.md](./docs/specs/interface/SPEC-ADMIN-CONSOLE.md). Running it behind your own admin console/auth: [docs/guides/admin/ADMIN-INTEGRATION-GUIDE.md](docs/guides/admin/ADMIN-INTEGRATION-GUIDE.md).

## API Endpoints

### Core Endpoints (Both Modes)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/create-conversation` | POST | Create new conversation with AI agent |
| `/conversations/archive` | POST | Archive a conversation (moderator): read-only + hidden from the active list; membership retained, so members keep read-only access until the 90-day expiry |
| `/conversations/remove-member` | POST | Remove a member from a conversation (moderator; never the assistant) |
| `/conversations/leave` | POST | Leave a conversation (any member; self only) |
| `/presigned-url` | POST | Generate S3 presigned URL for file upload/download |
| `/share-conversation` | POST | Share a conversation with a person by address; the welcome it asks for carries the email, sent by the `Notifications` email bridge |
| `/admin/conversations` | GET | Browse conversations from the analytics archive (system of record) |
| `/admin/conversations/{channelId}/messages` | GET | Load a conversation's messages from the archive (incl. full raw payload for inspect) |
| `/admin/conversations/membership-history` | GET | Join / leave / moderator-grant timeline, reconstructed from the archive (audit trail) |
| `/exchange-credentials/admin/view-live-members` | POST | Vend a session that lists a conversation's current members |
| `/exchange-credentials/admin/manage-membership` | POST | Vend a session that adds or removes a member; the console then calls the Amazon Chime SDK itself, as the admin's own identity |
| `/exchange-credentials/admin/redact` | POST | Vend a session that redacts a message (moderation) |
| `/exchange-credentials/admin/delete` | POST | Vend a session that deletes a message (administration) |
| `/feedback` | POST | Submit per-message user feedback (`helpful` / `needs work`) |
| `/events` | POST | Batch ingestion for frontend events behind the edge authorizer (signup/signin/session funnels, message lifecycle, web-vitals). Lands in S3 `client_events/` via Firehose; backs the client-events dashboards. |
| `/feedback` | GET | Admin summary of user feedback by model and intent (`AWS_IAM`, `view-analytics`; SigV4-signed with a console session) |

The `/admin/*`, `/exchange-credentials/admin/*` and `GET /feedback` routes are on `AdminApi`; the others are on `PersonApi`. Every route, with its authorizer and throttle, is in the generated [API contract](docs/reference/api-contract.md).

### Analytics Endpoints (Aurora Mode)

These are on `AdminApi`, `AWS_IAM`-authorized (SigV4), under the `/query` mount.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/query/analytics/evaluation` | GET | Daily evaluation metrics, a live query over `exchanges` and `evaluation_results` |
| `/query/analytics/evaluation/exchanges` | GET | Detailed exchange list with multi-dimensional scores |
| `/query/analytics/evaluation/flows` | GET | Multi-turn flow summaries with composite scores |
| `/query/analytics/conversations` | GET | Conversation list with auto-generated summaries |
| `/query/analytics/drift` | GET | Drift detection events (original topic vs current) |
| `/query/analytics/context?personId=X` | GET | Cross-conversation context for a user (related prior conversations) |
| `/query/analytics/model-effectiveness` | GET | Compare model effectiveness by intent: score, latency, and compliance rate |

Latency and experiment results have no dedicated GET resource. They are served from `POST /query`, which takes a `queryType` in the body:

| Request | Description |
|---------|-------------|
| `POST /query` `{"queryType":"latency_metrics"}` | Response latency breakdown: avg/P95 total, Bedrock, polling by agent type and delivery option |
| `POST /query` `{"queryType":"experiment_results"}` | Per-variant experiment rollup (the Experiments tab) |

`POST /query` is the general contract for every query type; the GET resources above are the subset that also has its own path.

## Cost Estimate

> **⚠️ Estimates only.** The figures here are rough estimates for orientation, not budgeting. AWS pricing changes and your actual cost depends on region, traffic, and configuration. **Validate your own costs** against the [AWS Pricing Calculator](https://calculator.aws) and your bills before committing to spend.

A low-volume Athena-mode deployment runs roughly **$30-50/month** (dominated by the always-on Kinesis stream and Bedrock inference); Aurora mode adds roughly **~$50-95/month**. The full per-component cost model, both deployment modes, both VPC configs, and the Bedrock inference drivers live in the single source of truth: **[docs/guides/admin/INFRASTRUCTURE-COST.md](docs/guides/admin/INFRASTRUCTURE-COST.md)**.

## Customization Guide

Extending AgentEchelon, adding or changing a classification (and its profile), adding a tool or intent, configuring image-generation providers, and replacing prompts, is covered in the **[Developer Guide](docs/guides/developer/DEVELOPER-GUIDE.md)** and the docs it links (for example [docs/guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md](docs/guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md) and [docs/guides/admin/IMAGE-GEN-PROVIDERS.md](docs/guides/admin/IMAGE-GEN-PROVIDERS.md)).

## Troubleshooting

Symptom-to-fix runbook (deploy, connection, Amazon Chime SDK, Bedrock, Aurora): **[docs/guides/user/TROUBLESHOOTING.md](docs/guides/user/TROUBLESHOOTING.md)**.

## End-to-End Tests

The project includes Playwright E2E tests with video recording covering sign up, sign in, and agent intent interactions across all user tiers.

> **Post-deploy validation (start here).** After deploying, the fastest way to prove a fresh deployment end-to-end is the demo seed + one-command validation: it seeds three tier users and the tiered demo context, then exercises every tier flow with real (measured, recorded) conversations and verifies the admin dashboard against that real data - nothing faked.
>
> **⚠️ Running this costs money.** Because the conversations are real, every tier flow and the battle is a billed **Amazon Bedrock** model invocation (priced per token), and the battle image-generation test calls a **paid external image-gen provider** (OpenAI / FAL) when configured. A full run is on the order of a few dollars of inference, not free - run it to validate a fresh deployment, but do not leave it looping. (It also seeds the demo users/context, so it doubles as "populate the deployment with realistic data.")
> ```bash
> cd backend
> AWS_PROFILE=<your-profile> npx ts-node scripts/seed-demo.ts   # users + tier context + identity check
> AWS_PROFILE=<your-profile> npm run validate                   # ALL phases: tier flows + tasks/experiments/feedback + battle -> admin
> ```
> Run the FULL `npm run validate`, not the Playwright suite directly: the data-producing phases (tasks, experiments, feedback, welcome) are what drive DOMAIN intents and multi-step tasks across every tier, so the admin console shows real breadth instead of an all-`general` bar. The validator prints a **DATA READINESS** preflight and a **PHASE SUMMARY** so a sparse dashboard is visible, not silent (a phase self-skips when its deployed dependency is absent). Full runbook (prerequisites, the data-readiness gating, per-tier scenarios, RAG ingestion, adapting it to your own use case): **[docs/guides/user/DEMO-AND-VALIDATION.md](docs/guides/user/DEMO-AND-VALIDATION.md)**. The sections below document the raw Playwright suite the validator drives.

### Test Structure

```
tests/
├── playwright.config.ts              # Playwright config (Chromium, video on, trace kept for a failure)
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

A few suites drive the live deployment and produce real data, so they stay OFF by default and turn on with a gate flag: `EXPERIMENTS_E2E=1` (A/B experiments), `BATTLE_E2E=1` (`/battle` battles), `ONBOARDING_E2E=1` (standard-tier intake), `TASKS_E2E=1` (task lifecycle). Point them at a deployed origin with `E2E_BASE_URL` (chat) and `E2E_ADMIN_BASE_URL` (admin console).

Every admin route, `GET /feedback` and the analytics read plane included, is `AWS_IAM`-authorized, so the experiments and tasks suites SigV4-sign their admin calls instead of sending a Bearer JWT (see `tests/e2e/helpers/signed-analytics.ts`). That signing takes the admin id token from the signed-in page's `localStorage` and trades it for a console session at the admin credential exchange, so it needs `AWS_REGION` outside `us-east-1`, alongside these deployed values:

| Var | Purpose | Source |
|-----|---------|--------|
| `VITE_PERSON_API_URL` | The person API, whose credential exchange is where the signed-in user becomes a person first | `AgentEchelonPersonApi` output `PersonApiUrl` |
| `VITE_ADMIN_API_URL` | The admin API: the admin credential exchange that vends the console session the calls are signed with, analytics (at `/query`) and experiment administration | `AgentEchelonAdminApi` output `AdminApiUrl` |

`backend/scripts/gen-frontend-env.mjs` writes all of these into the per-package `.env` files from the live CloudFormation outputs, so the simplest setup is to run it and export the same values for the suite.

### Test Credentials

The Playwright suite signs in as four tier users (basic / standard / premium / admin) read from an AWS Secrets Manager secret (`agent-interface/test-credentials`). After deploying a fresh stack, create those users and write the secret with the one-shot provisioning script:

```bash
cd backend
AWS_PROFILE=<your-profile> npm run provision-test-users
```

This reads the live `AgentEchelonIdentity` outputs (User Pool + client IDs), creates each user with a permanent password, adds it to the matching Cognito group (the authoritative tier signal), and writes/updates the secret the tests read. It is **idempotent** - re-run it after every redeploy. Overridable via env:

| Var | Default | Purpose |
|-----|---------|---------|
| `TEST_USER_PASSWORD` | random per run | Permanent password for all four users. Generated fresh each run and written to the credentials secret below, so no default credential ships in this repo. Set it only if you want stable logins across re-provisions. |
| `TEST_EMAIL_DOMAIN` | the test inbox's domain, else `agentechelon.test` | Email host for the tier users |
| `TEST_INBOX_BUCKET` | `testInboxBucket` in `deploy.config.json` | An existing S3 bucket an SES receipt rule writes `TEST_EMAIL_DOMAIN`'s mail into (see Test inbox) |
| `TEST_INBOX_PREFIX` | `testInboxPrefix` in `deploy.config.json` | The key prefix that rule writes under |
| `ADMIN_EMAIL` | `testuser-admin@<domain>` | Admin user's email |
| `TEST_SECRET_NAME` | `agent-interface/test-credentials` | Secrets Manager secret id |

Tests skip automatically (rather than failing) when the secret is absent, so the suite degrades gracefully on a stack that hasn't been provisioned.

### Test inbox

The notification tests read the email a test user actually received: who got it, what it says and where its link goes. That needs a domain whose mail SES receives into S3. Without one those tests skip and say why, and `validate` lists the inbox as missing.

Use a domain or subdomain that exists only for tests, such as `inbox.example.com`. Every message to any address on it is stored. If the domain is a verified SES identity, SES can send to it even while the account is in the SES sandbox.

**Use an existing inbox.** If an SES receipt rule you do not manage here already writes a domain's mail to a bucket, declare it in `backend/deploy.config.json`, so every deploy and every re-provisioning after a rebuild uses it:

```json
"testInboxDomain": "inbox.example.com",
"testInboxBucket": "my-mail-bucket",
"testInboxPrefix": "incoming/"
```

With `testInboxBucket` set no `TestInbox` stack is created, because the domain's receipt rule belongs to whoever runs it. Provisioning reads the three keys. To name an inbox for one run instead, set the matching variables, which win over the config:

```bash
TEST_EMAIL_DOMAIN=inbox.example.com TEST_INBOX_BUCKET=my-mail-bucket TEST_INBOX_PREFIX=incoming/ \
  AWS_PROFILE=<your-profile> npm run provision-test-users
```

**Set up a new inbox.** Deploy the opt-in `TestInbox` stack, then provision. Provisioning finds the stack's inbox in SSM.

```bash
npm run deploy:stack -- AgentEchelonTestInbox --context testInboxDomain=inbox.example.com
AWS_PROFILE=<your-profile> npm run provision-test-users
```

| Context | Purpose |
|---------|---------|
| `testInboxDomain` | The domain to receive. Required; the stack exists only when it is set and `testInboxBucket` is not. |
| `testInboxBucket`, `testInboxPrefix` | An existing inbox's bucket and key prefix (above). Set, no stack is created; synth refuses a bucket without a domain and a prefix without a bucket. |
| `testInboxRuleSet` | The name of the region's **active** SES receipt rule set. SES allows one active set per region, so an account that already receives mail must name its set and the rule is added to it. Without it the stack creates a set and leaves it inactive; the `ActivateRuleSet` output prints the command, and activating it replaces any other active set in the region. |
| `testInboxDomainVerified` | `true` when the domain is already a verified SES identity. SES receives only for a verified domain; without this the stack creates the identity. |
| `testInboxHostedZoneId`, `testInboxHostedZoneName` | A Route 53 public hosted zone for the domain. The stack then writes the DKIM records that verify it and the MX record that routes its mail to SES. Without them, add the records yourself; the `MxRecord` output shows the MX value. |

The stack's bucket expires mail after three days, and its policy admits writes from its own receipt rule only.

Either way, provisioning writes the inbox into the test secret as `testInbox` and gives the test users addresses on its domain. The environment wins over `deploy.config.json`, and the config over the stack's inbox in SSM. Users the secret already records under another address are moved to the new one in place, so they keep their identity, conversations and history.

The demo cast (`npm run provision-test-users -- --cast ops-demo`, secret `agent-interface/demo-credentials`) reads the same inbox: each person's address is `demo-<who>@<inbox domain>` (`demo-oncall`, `demo-priya`, `demo-marcus`, `demo-dana`, `demo-admin`, `demo-basic`, `demo-sales`), unless that person's `DEMO_*_EMAIL` variable names another, and the secret records `testInbox` too. `tests/e2e/demo-cast-mail.spec.ts` (`validate --only=demo-cast-mail`) then reads what the cast received. With no inbox the cast keeps plus-addresses on the presenter's mailbox, `presenterMailbox` in `deploy.config.json` (`presenter@example.com` when unset), and that spec skips saying why.

### Test Coverage

**385 e2e tests across 124 spec files**, mapped to the specifications they cover.

The authoritative, per-spec breakdown is **[docs/reference/e2e-coverage-matrix.md](docs/reference/e2e-coverage-matrix.md)**, which is GENERATED from the specs and the spec files - it reports which documents claim live behavior and which e2e covers each. Read it there rather than here.

Regenerate it with the command at the top of that file. All runs include video recordings and trace files in `tests/test-results/` for debugging.

### Testing Built-In Intents

The default intent pack defines 11 domain intents plus the 7 universal intents every pack has (`greeting`, `acknowledgment`, `general`, `conversation_summary`, `set_preference`, `show_preferences`, `off_topic`; `UNIVERSAL_INTENT_KEYS` in `backend/lambda/src/lib/intent-pack.ts`). Use this script to exercise the agent interaction suite against a running deployment; each step runs the tests whose titles match its `-g` pattern:

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

echo "1. Greeting on a new conversation..."
npx playwright test agent-intents.spec.ts -g "greeting" --reporter=list 2>&1 | tail -3

echo "2. Follow-up keeps conversation context..."
npx playwright test agent-intents.spec.ts -g "context" --reporter=list 2>&1 | tail -3

echo "3. STRATEGIC_ANALYSIS (refused where not offered, answered at premium)..."
npx playwright test agent-intents.spec.ts -g "strategic analysis" --reporter=list 2>&1 | tail -3

echo "4. CODE_GENERATION..."
npx playwright test agent-intents.spec.ts -g "code generation" --reporter=list 2>&1 | tail -3

echo "5. Task tracking (multi-step)..."
npx playwright test agent-intents.spec.ts -g "task" --reporter=list 2>&1 | tail -3

echo "6. GENERAL Q&A..."
npx playwright test agent-intents.spec.ts -g "question" --reporter=list 2>&1 | tail -3

echo "7. DATA_EXTRACTION reaches the archive as its intent..."
npx playwright test agent-intents.spec.ts -g "data_extraction" --reporter=list 2>&1 | tail -3

echo ""
echo "=== Full Suite ==="
npx playwright test agent-intents.spec.ts --reporter=list

echo ""
echo "Results: tests/test-results/"
echo "Report:  npx playwright show-report"
```

**Intent taxonomy reference** (the default pack in `backend/lambda/src/lib/intent-pack.ts`; a deployment supplies its own via `ASSISTANT_INTENT_PACK`):

| Intent | Trigger | Delivery Option | Example |
|--------|---------|----------------|---------|
| `GREETING` | "Hello", "Hi", "Hey" | DIRECT | Fast path - no Bedrock call needed |
| `ACKNOWLEDGMENT` | "Thanks", "OK", "Got it", "Bye" | DIRECT | Fast path - no Bedrock call needed |
| `PLATFORM_QUESTION` | Questions about the AgentEchelon platform itself | PLACEHOLDER_UPDATE | Answered from platform information |
| `GUIDED_TROUBLESHOOTING` | Troubleshooting or debugging requests | TASK_MULTI_STEP | Multi-turn state machine with step tracking |
| `DATA_EXTRACTION` | Extract or export structured/bulk data (a table, list, or dataset) | TASK_MULTI_STEP | Multi-turn state machine; a single-fact question is `GENERAL` |
| `IMAGE_GENERATION` | "Generate an image of ...", "draw ..." | TASK_MULTI_STEP | The image route's model generates the image, which the platform delivers |
| `CODE_GENERATION` | A short piece of code: one function, class or query | PLACEHOLDER_UPDATE | Async processor with "Thinking..." placeholder |
| `CODE_REVIEW` | "Review this code", critique of supplied code | PLACEHOLDER_UPDATE | Async processor with "Thinking..." placeholder |
| `STRATEGIC_ANALYSIS` | Business case, competitive or market assessment | PLACEHOLDER_UPDATE | Async processor with "Thinking..." placeholder |
| `CODE_DELIVERY` | A complete program, module or multi-part code deliverable | TASK_MULTI_STEP | Requirements agreed before the code is written |
| `TECHNICAL_DESIGN` | A technical, system or solution design | TASK_MULTI_STEP | Goal, constraints and outline agreed before writing |
| `DESIGN_REVIEW` | Review of an existing design, architecture or proposal | PLACEHOLDER_UPDATE | Findings ranked by impact |
| `REPORT_GENERATION` | Generate a report or summary | TASK_MULTI_STEP | Multi-turn state machine |
| `GENERAL` | Anything else | PLACEHOLDER_UPDATE | Default classification for open-domain questions |

**Fast-path optimization:** Greetings and acknowledgments are classified via exact string matching (no Bedrock call). All other intents go through a Bedrock Haiku classification call before routing.

## Technology Stack

- **Frontend**: React 19, Vite, TypeScript
- **Backend**: AWS CDK (TypeScript), Lambda (Node.js 20)
- **AI**: Provider-open, not Bedrock-locked - model-agnostic and configurable per classification and per intent. The assistant runs on Bedrock model families (Anthropic Claude, Amazon Nova, OpenAI GPT-OSS, DeepSeek V3.2); the provider layer also supports **external HTTP APIs**, proven today by the image-generation path (Stability on Bedrock plus external providers), so adding a non-AWS model provider is an architecture the platform already demonstrates
- **Messaging**: Amazon Chime SDK Messaging (WebSocket)
- **Auth**: any issuer the trusted-issuer registry declares (the deployment's own Amazon Cognito pool, a SAML or OIDC provider federated into it, OIDC or Microsoft Entra verified directly, a host application's signed assertion, the guest issuer), with automatic token refresh
- **Storage**: Amazon S3 (presigned URLs)
- **Analytics**: Kinesis Data Firehose, S3, Athena
- **Message trigger**: Amazon Lex V2 - an Amazon Chime SDK-to-Lambda passthrough that invokes the fulfillment handler; request classification and model routing are done in `router-agent-handler.ts`, not by Lex

## Contributing

Contributions are welcome! Please read our [Contributing Guidelines](CONTRIBUTING.md) before submitting pull requests.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

Built with [Amazon Chime SDK](https://aws.amazon.com/chime/chime-sdk/) and [Amazon Bedrock](https://aws.amazon.com/bedrock/).
