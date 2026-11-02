# Architecture Guide

This document explains how AgentEchelon works end-to-end. It covers every major flow, how the CDK stacks connect, and where to look when extending or debugging the system.

For deployment instructions, see [README.md](../../README.md). For Aurora-specific architecture, see [SPEC-AURORA-VPC-MODE.md](../specs/foundations/SPEC-AURORA-VPC-MODE.md).

---

## System Overview

```
                                 ┌──────────────────────────────────────┐
                                 │          React Frontend              │
                                 │  AuthProvider → AwsClientProvider    │
                                 │  → MessagingProvider                 │
                                 │  → ConversationProvider              │
                                 └──────┬──────────┬──────────┬────────┘
                                        │          │          │
                            WebSocket   │   REST   │   REST   │
                                        │          │          │
                    ┌───────────────────┐│  ┌──────┐│  ┌──────┐│
                    │  Issuer token     ││  │ API  ││  │ API  ││
                    │  (registry) +     ││  │ GW 1 ││  │ GW 2 ││
                    │  Cred. Exchange   ││  │      ││  │      ││
                    └───────┬───────────┘│  └──┬───┘│  └──┬───┘│
                            │            │     │    │     │    │
        ┌───────────────────┘            │     │    │     │    │
        │ vended credentials            │     │    │     │    │
        ▼                                │     │    │     │    │
 ┌──────────────────┐                    │     │    │     │    │
 │ Amazon Chime SDK │◄───────────────────┘     │    │     │    │
 │ Messaging        │                          │    │     │    │
 │ AppInstance      │                          │    │     │    │
 └──────┬───────────┘                          │    │     │    │
        │ Channel message event                │    │     │    │
        ▼                                      │    │     │    │
 ┌──────────────┐                              │    │     │    │
 │ Channel Flow │                              │    │     │    │
 │  Processor   │                              │    │     │    │
 └──────┬───────┘                              │    │     │    │
        │ runs FIRST: @assistant/@human/@all   │    │     │    │
        │  mention rules + filtering (@all     │    │     │    │
        │  bypasses Lex, invoking the async    │    │     │    │
        │  processor directly)                 │    │     │    │
        ▼                                      │    │     │    │
 ┌──────────────┐    ┌─────────────────────────┘    │     │    │
 │  Amazon Lex  │    │ create-conversation          │     │    │
 │  V2 Bot      │    │ share-conversation           │     │    │
 │  (entry      │    └──────────────────────────────┘     │    │
 │  trigger)    │                                         │    │
 └──────┬───────┘                                         │    │
        │ Lex fulfillment (Dialog Code Hook)              │    │
        ▼                                                 │    │
 ┌──────────────────────────────────────────────┐         │    │
 │  Lambda Handlers (tier-selected)             │         │    │
 │  ┌──────────┐ ┌───────────┐ ┌─────────────┐ │         │    │
 │  │  Basic   │ │  Standard │ │   Premium   │ │         │    │
 │  │  (Haiku) │ │  (Sonnet  │ │   (Opus +   │ │         │    │
 │  │          │ │  + Haiku) │ │   all)      │ │         │    │
 │  └────┬─────┘ └─────┬─────┘ └──────┬──────┘ │         │    │
 │       │              │              │        │         │    │
 │       ▼              ▼              ▼        │         │    │
 │  ┌──────────┐ ┌───────────┐ ┌─────────────┐ │         │    │
 │  │  Async   │ │   Async   │ │    Async    │ │         │    │
 │  │Processor │ │ Processor │ │  Processor  │ │         │    │
 │  └────┬─────┘ └─────┬─────┘ └──────┬──────┘ │         │    │
 └───────┼──────────────┼──────────────┼────────┘         │    │
         │              │              │                   │    │
         └──────────────┼──────────────┘                   │    │
                        ▼                                  │    │
              ┌───────────────────┐                        │    │
              │  Amazon Bedrock   │                        │    │
              │  (model inference)│                        │    │
              └───────────────────┘                        │    │
                                                           │    │
                        ┌──────────────────────────────────┘    │
                        │ presigned-url                         │
                        ▼                                       │
              ┌───────────────────┐                             │
              │    Amazon S3      │                             │
              │  (attachments)    │                             │
              └───────────────────┘                             │
                                                                │
                        ┌───────────────────────────────────────┘
                        │ analytics queries
                        ▼
              ┌───────────────────┐
              │  Analytics        │
              │  (Athena or       │
              │   Aurora mode)    │
              └───────────────────┘
```

**Reading the flow:** the **Channel Flow Processor** runs first on every message (mention rules, filtering, marker stripping) and decides WHO responds; `@all` and `/battle` bypass Lex, which is the only way they differ from an ordinary turn (MESSAGE-FLOW §6.1). **Amazon Lex is only the entry trigger** - an Amazon Chime SDK-to-Lambda passthrough via its Dialog Code Hook - not a classifier or router. Each assistant has its own Lex bot, built at runtime by the provisioner in `Messaging` (no stack owns one), and it fulfills into its classification's **own handler Lambda**: all run the shared `router-agent-handler.ts` code but are deployed one per tier (per-tier ownership, ADR-011), not a single shared router. The models shown per tier are **defaults**; model selection is configurable per tier and per intent via `model-strategy` (Anthropic Claude, Amazon Nova, OpenAI GPT-OSS), so the platform is model-agnostic, not Anthropic-only.

**Identity.** A human is one Amazon Chime SDK AppInstanceUser, an assistant is one AppInstanceBot, and a conversation is one channel; every record is keyed by one of them. An identity provider holds email, name and credentials, and its record maps to the AppInstanceUser through the `Identities` index, `(issuer, subject) -> AppInstanceUser ARN`, which only the credential exchange writes. Every signal - a message, a meeting attendee, an invitation, an inbound reply - resolves to an AppInstanceUser ARN first and reaches the identity provider only from it. Email and phone are delivery routes, never identity. See [Authentication Flow](#authentication-flow) for what is built.

---

## Layers and Capabilities

The platform has four layers - **Interface** (the clients), **Communication** (the APIs, their authorizers, the messaging WebSocket, meeting media, email), **Interaction** (the engine: the conversation substrate, identity and the credential exchange, conversations, meetings, assistants, connectors, the archive) and **Foundations** (the CDK app, tags, deploy scripts, operations). A service is not a layer: the Amazon Chime SDK and Cognito each span three, so stacks are cut by capability. In the design every stack is one capability labeled with its layer, the four deployable components stand up in order (the core, then the chat interface and the admin backend on it, then the admin interface on the admin backend), and a deployment declares its capabilities in one `capabilities` list; the minimal deployment is an anonymous visitor in the widget talking to one assistant, with no accounts. Person-facing routes sit on one HTTP API, `PersonApi`, behind one edge authorizer, and admin routes on one IAM-authorized HTTP API, `AdminApi`. The core is `Messaging`, `Identity`, `Conversations` and `Archive`, then the channel flow, the assistant stacks, post-processing and `PersonApi`; `AdminApi` is part of the `admin` capability. Each stack declares its routes beside its handlers (`RouteSpec` in `backend/lib/constructs/http-api.ts`), and the API stack serves the routes of the stacks it is built on. The capability list is read (`backend/lib/config/capabilities.ts`): `chat`, `admin`, `notifications`, `experiments`, `battle`, `operations`, `connectors` and `widget` are built, and `meetings` is **NOT BUILT** and refused at synth. No vendor calls an HTTP API: a connector that subscribes to vendor events receives them through the vendor's Amazon EventBridge partner event source, on a rule pinned to that source ([SPEC-CONNECTORS.md](../specs/communication/SPEC-CONNECTORS.md)). `IngressApi`, for a vendor with no EventBridge integration, is **NOT BUILT**. The target stacks, the component rule and the capability list are in [STACKS.md](STACKS.md#layers-and-capabilities); the decisions are [ADR-055](../design/decisions/055-stacks-are-capabilities-in-layers.md) and [ADR-056](../design/decisions/056-two-http-apis-and-no-aws-waf.md), both Accepted.

---

## CDK Stack Dependency Graph

This is the graph `bin/backend.ts` deploys with every built capability declared; a capability that is not declared leaves its stacks out. Stacks deploy in dependency order, which `npm run deploy` follows.

```
Messaging                         (the app instance, its service admin and retention, the message stream
     │                             and the app instance's streaming configuration; no dependencies)
     │
     ├──► Identity                (user pool when the issuer registry declares one, credential exchange and its
     │                             roles, Identities, offboarding, the platform trail; references the AppInstance ARN)
     │
     ├──► Conversations           (task tables + abuse-controls table [rate limit / spend budget / dedup] +
     │                             conversation-actions audit table + feedback table + attachments bucket;
     │                             create-conversation, conversation-management [archive/remove-member/leave],
     │                             presigned-URL and feedback handlers; depends on Identity)
     │
     ├──► Archive                 (Athena mode: the stream through Firehose into S3 and Athena
     │                             OR Aurora mode: VPC + Aurora; RDS Proxy opt-in; reads the stream;
     │                             depends on Identity and Conversations)
     │
     ├──► Assistants-<classification>   (router + the shared async processor + the seed that asks Messaging's provisioner
     │                                    for its declared assistants, one stack per classification the deployment
     │                                    declares (`profiles`); no stack owns an assistant's Lex bot or AppInstanceBot;
     │                                    depend on Messaging and Conversations, and on Archive in Aurora mode)
     │
     ├──► ChannelFlow             (@all + /battle routing + message filtering; depends on the Assistants-* stacks;
     │                             resolves the per-classification processors from the SSM contract at deploy)
     │
     ├──► Experiments             (`experiments`: the A/B experiments table and its SSM contract, and the channel flow's
     │                             grant on it; each classification's stack grants its own roles; no routes; depends on
     │                             ChannelFlow)
     │
     ├──► Battle                  (`battle`, which requires `experiments`: /battle tables + orchestrator and the channel
     │                             flow's grant on them; each battle-capable classification's stack builds its own alt
     │                             and grants; depends on Experiments and ChannelFlow)
     │
     ├──► PostProcessing          (post-delivery consumer on the message stream; depends on Messaging's stream,
     │                             Conversations and the classification stacks' SSM contracts)
     │
     ├──► ImageGuardrail-{region} (conditional: one per region hosting an active image model outside the deploy region;
     │                             the regional content guardrail the classification stacks reference cross-region)
     │
     ├──► AdminServices           (`admin`: every admin handler - the admin credential exchange and its roles,
     │                             user management, admin conversations and tasks, the feedback summary,
     │                             assistant administration and analytics (two nested stacks), and the admin
     │                             alert channel fed by `ae.alert` events; depends on the core, the Assistants-*
     │                             stacks, and Experiments and Battle when declared)
     │
     ├──► AdminApi                (`admin`: one HTTP API serving every admin route, IAM-authorized, the console
     │                             session behind the admin-plane edge authorizer; the console roles' grants;
     │                             depends on AdminServices and Identity)
     │
     ├──► Notifications           (`notifications`: share, briefing, the email bridge on the message stream, the
     │                             archival alarm; the only SES send grant)
     │
     ├──► Operations              (`operations`: the deployment-wide dashboard; no alarm of its own)
     │
     ├──► Connectors              (`connectors`: the vendor event rules and receiver, the per-person grants and their
     │                             revoker; depends on Messaging and Identity)
     │
     ├──► Widget                  (`widget`: CloudFront + private S3 origin for the embeddable widget, with
     │                             frame-ancestors from the declared hosts; depends on nothing in the core)
     │
     ├──► ChatApp                 (`chat`: CloudFront + private S3 origin for the chat SPA)
     │
     ├──► AdminApp                (`admin`: separate CloudFront + S3 origin for the admin console SPA; after AdminServices
     │                             and AdminApi)
     │
     └──► PersonApi               (one HTTP API serving every person route, behind the edge authorizer; built last,
                                   on every stack whose person routes it serves)
```

The required core deploys in both modes: Messaging, Identity, Conversations, Archive (Athena or Aurora under one name), one `Assistants-*` stack per declared classification (three by default), ChannelFlow, PostProcessing and PersonApi. Conditional `ImageGuardrail-{region}` stacks are added, one per region that hosts an active image model outside the deploy region. Everything else is a declared capability in `capabilities`: `chat` (`ChatApp`), `admin` (`AdminServices`, `AdminApi` and `AdminApp`), `notifications` (`Notifications`), `experiments` (`Experiments`), `battle` (`Battle`, requiring `experiments`), `connectors` (`Connectors`), `widget` (`Widget`) and `operations` (`Operations`). `meetings` is **NOT BUILT** and refused at synth.

**Stack outputs flow:** Each stack exports values (ARNs, URLs) as CloudFormation outputs; the per-classification stacks instead publish their processor/bot ARNs to SSM. The frontend `.env` file is populated from these outputs. See `.env.example` for the mapping.

| Stack                                   | Key Outputs                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Messaging                               | `AppInstanceArnOutput`, `KinesisStreamArn`, `KinesisStreamName`                                                                    |
| Identity                                | `UserPoolId`, `UserPoolClientId` (when the registry declares this deployment's own pool), `AdminUserPoolClientId` (with `admin`) |
| AdminServices                           | `AdminNotificationChannelArn`, `AdminAgentBotArn` |
| AdminApi                                | `AdminApiUrl`, `AdminApiCapabilities` (with `admin`) |
| Conversations                           | `AttachmentsBucketName`, `AgentTasksTableName`, `UserTasksTableName`, `ChannelContextTableName`, `UserProfileTableName` |
| Experiments                             | `ExperimentsTableName`                                                                                                       |
| Notifications                           | `SenderEmailIdentityArn`, `ReplyDomainMx` (with `replyDomain`) |
| Assistants-<classification>             | SSM: `/agent-echelon/assistant/{classification}/{processor-arn,bot-arn}`                                                     |
| ChannelFlow                             | `ChannelFlowArn`, `ProcessorFunctionArn`                                                                                     |
| Archive                                 | `AnalyticsMode`, `ArchiveBucketName`, `SleepModeEnabled` (Aurora mode) |
| Operations                              | `OperationsDashboardName`                                                                                                    |
| PersonApi                               | `PersonApiUrl`, `PersonApiCapabilities` |
| Widget                                  | `WidgetDistributionUrl`, `WidgetDistributionId`, `WidgetDistributionBucketName`, `WidgetHosts` |

---

## Authentication Flow

```
 ┌────────┐     ┌───────────────┐     ┌──────────────────┐
 │  User  │────►│ Registration  │────►│ Cognito User Pool│
 │        │     │ Screen        │     │ (email + password)│
 └────────┘     └───────────────┘     └────────┬─────────┘
                                               │
                                    ┌──────────▼──────────┐
                                    │ Email Verification   │
                                    │ (Cognito sends code) │
                                    └──────────┬──────────┘
                                               │
                                    ┌──────────▼──────────┐
                                    │ Post-Confirmation    │
                                    │ Lambda Trigger       │
                                    │ (approval pending,   │
                                    │  tier -> its group)  │
                                    └──────────┬──────────┘
                                               │
                                    ┌──────────▼──────────┐
                                    │ Login Screen         │
                                    │ (USER_PASSWORD_AUTH) │
                                    └──────────┬──────────┘
                                               │
                              ┌────────────────▼────────────────┐
                              │ AuthProvider receives:           │
                              │  - IdToken (1 hour)             │
                              │  - AccessToken (1 hour)         │
                              │  - RefreshToken (30 days)       │
                              └────────────────┬────────────────┘
                                               │
                              ┌────────────────▼────────────────┐
                              │ AwsClientProvider:              │
                              │  IdToken → Credential Exchange  │
                              │  (mints the AppInstanceUser at  │
                              │   the first exchange)           │
                              │  → bearer-pinned credentials    │
                              │    + the caller's userArn       │
                              │  → Amazon Chime SDK client initialized │
                              └────────────────┬────────────────┘
                                               │
                              ┌────────────────▼────────────────┐
                              │ Token Refresh (automatic):      │
                              │  - Every 50 minutes (interval)  │
                              │  - On stale reconnect (>5 min)  │
                              │  - Uses REFRESH_TOKEN_AUTH flow  │
                              │  - Failure → redirect to login  │
                              └─────────────────────────────────┘
```

The diagram is the deployment pool's password flow. The sign-in screen lists every issuer the registry declares with a redirect sign-in (`VITE_ISSUERS`), and those sign in with the authorization code flow and PKCE (`frontend/packages/shared/src/services/redirectSignIn.ts`); the widget's anonymous visitor holds a guest token from the guest issuer instead ([GUEST-ISSUER](../guides/admin/GUEST-ISSUER.md)). Each token reaches the same credential exchange.

**Auth failure states:**

| Failure | What happens |
|---------|-------------|
| Wrong password | `AuthProvider` catches `NotAuthorizedException` → error shown on LoginScreen |
| Unverified email | Cognito returns `UserNotConfirmedException` → redirects to verification screen |
| Token expired mid-session | 50-minute refresh interval fires `REFRESH_TOKEN_AUTH` → if refresh fails, user is redirected to login |
| Network error during login | Catch-all error → "Unable to sign in" message on LoginScreen |
| Refresh token expired (30 days) | `REFRESH_TOKEN_AUTH` returns `NotAuthorizedException` → user must re-login |

**Who the caller is.** The credential exchange is the only minter of AppInstanceUsers: it creates an opaque id once per `(issuer, subject)` and records it in the `Identities` index, and it returns the caller's `userArn`, which is the client's identity. On the server the caller is resolved once per request, at the edge authorizer or from the vended session's role session name, and handlers never read `claims.sub`, `cognito:username` or `claims.email`. Built, and **NOT VERIFIED** on a deployment:
- the minter and the `Identities` index (`backend/lambda/src/lib/person-identity.ts`), keyed by the issuer's registry id and the subject that entry declares;
- the edge authorizer (`backend/lambda/src/edge-authorizer.ts`), on both HTTP APIs, which verifies the token against the trusted-issuer registry, resolves its subject through `Identities` and hands the handler its context; `callerPersonId` (`backend/lambda/src/lib/auth.ts`) reads that context or the IAM console session, so no handler looks a caller up in `Identities` itself;
- the client keeps the `userArn` the exchange returns (`frontend/packages/shared/src/services/credentialExchange.ts`) and refuses to start the Amazon Chime SDK without `VITE_PERSON_API_URL` (`frontend/packages/chat/src/services/chimeService.ts`).

**Key files:**
- `frontend/packages/shared/src/providers/AuthProvider.tsx` - sign-in (the pool's password flow, and code plus PKCE for a redirect issuer), token management, refresh logic
- `frontend/packages/chat/src/providers/AwsClientProvider.tsx` - SDK clients over the exchange's vended credentials
- `backend/lambda/src/credential-exchange.ts` - the credential exchange
- `backend/lib/stacks/identity-stack.ts` - the user pool when the registry declares one, the credential exchange and its roles, `Identities`, Lambda triggers
- `backend/lambda/cognito-triggers/post-confirmation.js` - marks a confirmed signup unapproved and mirrors `custom:tier` into its group; it creates no AppInstanceUser

---

## Message Flow

This is the core flow: user sends a message and receives an AI response.

> **Full walkthrough:** [`../guides/developer/MESSAGE-FLOW.md`](../guides/developer/MESSAGE-FLOW.md) traces every hop (channel flow, Lex, `@assistant`/`@all` routing, fulfillment, async processor), says *why* each exists, and maps where each enforcement layer acts.

```
 User types message
        │
        ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ Frontend                                                             │
 │                                                                      │
 │  MessageInput.tsx                                                    │
 │       │                                                              │
 │       ▼                                                              │
 │  ConversationProvider.sendMessage()                                  │
 │       │                                                              │
 │       ▼                                                              │
 │  Amazon Chime SDK: SendChannelMessage (REST via IAM credentials)            │
 │       │                                                              │
 │       └─── optimistic update: message appears in UI immediately      │
 └───────┼──────────────────────────────────────────────────────────────┘
         │
         ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ Backend                                                              │
 │                                                                      │
 │  Amazon Chime SDK receives message in channel                               │
 │       │                                                              │
 │       ▼                                                              │
 │  Channel Flow Processor runs first (@all / /battle bypass Lex and    │
 │  hand off to the same handler; otherwise pass to Lex)                │
 │       │                                                              │
 │       ▼                                                              │
 │  The assistant's own Lex V2 Bot: RecognizeText                       │
 │       │                                                              │
 │       ├── FallbackIntent fulfillment → shared router                 │
 │       │                                                              │
 │       ▼                                                              │
 │  router-agent-handler.ts (shared router / Lex fulfillment)          │
 │       │                                                              │
 │       ├── 1. Resolve tier: the channel classification                │
 │       │                                                              │
 │       ├── 2. Classify intent (LLM classifier by default)            │
 │       │      └── Returns: delivery option + model route              │
 │       │                                                              │
 │       ├── 3. Select delivery option:                                 │
 │       │      ├── DIRECT: respond inline (simple Q&A)                 │
 │       │      ├── PLACEHOLDER_UPDATE: send "thinking..." placeholder, │
 │       │      │   invoke async processor, update placeholder later    │
 │       │      └── TASK_MULTI_STEP: create task in DynamoDB,           │
 │       │          invoke async processor, stream updates              │
 │       │                                                              │
 │       └── 4. Dispatch to the tier's Async Processor (for non-DIRECT) │
 │                    │  (ARN resolved from SSM per tier)               │
 │                    ▼                                                  │
 │              Per-tier Async Processor Lambda                          │
 │                    │                                                  │
 │                    ├── Runs the self-hosted Converse tool loop        │
 │                    │   (`async-processor-core.ts` `invokeBedrock`):   │
 │                    │   Bedrock Converse + tier-scoped context tool,   │
 │                    │   out-of-band guardrail on output - no Agent     │
 │                    ├── Parses response markers (task status, etc.)    │
 │                    ├── Updates placeholder via UpdateChannelMessage   │
 │                    │   OR sends new message via SendChannelMessage    │
 │                    └── Updates DynamoDB task state (if multi-step)    │
 └────────────────────┼─────────────────────────────────────────────────┘
                      │
                      ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ Frontend receives response                                           │
 │                                                                      │
 │  MessagingProvider: WebSocket callback fires                         │
 │       │                                                              │
 │       ├── MESSAGE_UPDATE: placeholder replaced with final response   │
 │       ├── CREATE_CHANNEL_MESSAGE: new bot message received           │
 │       │                                                              │
 │       ▼                                                              │
 │  messageParser.ts: strip metadata markers                            │
 │       │  (removes <!--ACTIVE_TASK:-->, <!--corr:-->, etc.)           │
 │       │                                                              │
 │       ▼                                                              │
 │  ConversationInterface.tsx: renders message                          │
 │  TaskStatusIndicator.tsx: shows pulsing dot if task in progress      │
 └──────────────────────────────────────────────────────────────────────┘
```

**What the user sees at each step:**

| Step | User-visible behavior |
|------|----------------------|
| User sends message | Message appears immediately (optimistic update); input is disabled while sending |
| DIRECT response | Bot reply appears within seconds, no loading indicator |
| PLACEHOLDER_UPDATE | "One moment..." placeholder appears as a bot message; replaced in-place when real response arrives |
| TASK_MULTI_STEP | `isBotTyping` indicator shows a pulsing dot; status updates stream into the channel; task completes when done |
| WebSocket disconnect | `ConnectionStatus` component shows reconnecting state; Amazon Chime SDK auto-reconnects |
| Async processor fails | Placeholder message stays as-is (user sees "One moment..." indefinitely - no automatic error recovery) |

**Key files:**
- `frontend/packages/chat/src/components/MessageInput.tsx` - User input, file attachment, send button
- `frontend/packages/chat/src/providers/ConversationProvider.chime.tsx` - `sendMessage()`, message state
- `frontend/packages/chat/src/providers/MessagingProvider.tsx` - WebSocket session, message callbacks
- `frontend/packages/shared/src/utils/messageParser.ts` - Strip metadata markers before display
- `backend/lambda/src/router-agent-handler.ts` - Shared Lex fulfillment: tier resolution (the channel's classification; a caller-clearance mismatch logs a SecurityEvent), intent classification, delivery selection, dispatch to the per-tier processor (ARN from SSM)
- `backend/lambda/src/channel-flow-processor.ts` - Runs first on every message; decides who responds. `@all` and `/battle` bypass Lex and otherwise follow the ordinary turn path
- `backend/lambda/src/assistant-async-processor.ts` - The single config-driven assistant processor (one instance deployed per profile; self-gates its capabilities on the profile env)
- `backend/lambda/src/lib/intent-classifier.ts` - Greeting/acknowledgment fast-path + a configurable LLM classifier (`CLASSIFIER_MODEL_ID`, default Haiku) used for every tier by default; a keyword-only classifier is opt-in per profile (`classifierMode: 'keyword'`)
- `backend/lambda/src/lib/delivery-options.ts` - Intent → delivery option mapping
- `backend/lambda/src/lib/model-resolver.ts` + `backend/lib/config/model-strategy.ts` - Intent → model routing (`INTENT_ROUTE_STRATEGY`: primary + fallback per intent, limited to the classification's allowed models)
- `backend/lambda/src/lib/async-processor-core.ts` - the self-hosted Converse tool loop (terminal Bedrock call `invokeBedrock`), marker parsing, response delivery

---

## Intent Classification & Model Routing

> **Terminology.** "Intent" here means the platform's own *request classification*: the category the classifier assigns to an incoming message (a code question, a report request, a greeting). It is not the same thing as an Amazon Lex *intent* (Lex's own NLU unit). The router uses Lex only as the entry trigger and classifies the request itself downstream, so "intent" below always means this classified request category. (Whether to rename this concept to avoid the collision with Lex's term is an open follow-up.)

A message is classified once, and that single classification drives **two independent decisions**: how the reply is **delivered** (next), and which **model** answers it (Model routing, below).

**The default is the LLM classifier, for every profile.** Each profile carries a `classifierMode` (`'llm' | 'keyword'`). The shipped member profiles set `'llm'` - basic included, which is a deliberate choice rather than an omission - and the shipped `ops-premium` role sets `'keyword'` (`backend/lib/config/profiles.ts`). The keyword classifier is an **opt-in alternative** a profile selects where classification cost matters more than accuracy. It is not a stage every message passes through, and the two modes are alternatives rather than a chain.

```
  User message arrives at agent handler
          │
          ▼
     profile.classifierMode
          │
          ├───────────────── 'keyword' (OPT-IN; shipped only on ops-premium) ────────┐
          │                                                                          │
          ▼ 'llm'  (the default, every shipped member profile)                       ▼
  ┌─────────────────────────────────────────┐              ┌──────────────────────────────────┐
  │ Exact-match short-circuit               │              │ classifyIntentByKeyword          │
  │ (fastPathIntent)                        │              │                                  │
  │                                         │              │ "error" / "fix" → GUIDED_TROUBLE │
  │ empty or under 3 chars → GREETING       │              │ "extract" / "pull" → DATA_EXTRACT│
  │ EXACT "hi" / "hello"   → GREETING       │              │ "report" / "summary" → REPORT_GEN│
  │ EXACT "thanks" / "ok"  → ACKNOWLEDGMENT │              │ substring match, no model call   │
  │                                         │              └────────────┬─────────────────────┘
  │ Anything else falls through. This is an │                           │
  │ EXACT-token check, not the keyword      │                           │
  │ table on the right.                     │                           │
  └────────────┬────────────────────────────┘                           │
               │ no exact match (the common case)                       │
               ▼                                                        │
  ┌─────────────────────────────────────────┐                           │
  │ LLM classifier - THE DEFAULT PATH       │                           │
  │ (model set by CLASSIFIER_MODEL_ID;      │                           │
  │  default Haiku). Categories from the    │                           │
  │  active intent pack, so a deployment's  │                           │
  │  domain intents are classifiable.       │                           │
  └────────────┬────────────────────────────┘                           │
               │                                                        │
               ├────────────────────────────────────────────────────────┘
               ▼
  ┌─────────────────────────────────────────┐
  │ Delivery option lookup                  │
  │                                         │
  │ Intent Type          → Delivery Option  │
  │ ─────────────────────────────────────── │
  │ GREETING             → DIRECT           │
  │ ACKNOWLEDGMENT       → DIRECT           │
  │ GENERAL              → PLACEHOLDER_UPD  │
  │ DATA_EXTRACTION      → TASK_MULTI_STEP  │
  │ REPORT_GENERATION    → TASK_MULTI_STEP  │
  │ GUIDED_TROUBLESHOOT  → TASK_MULTI_STEP  │
  └─────────────────────────────────────────┘
```

**Delivery options explained:**

| Option | Behavior | Use Case |
|--------|----------|----------|
| `DIRECT` | Return response inline in Lex fulfillment | Quick replies (<5s) |
| `PLACEHOLDER_UPDATE` | Send "One moment..." placeholder, invoke async processor, update the placeholder with the real response | Medium queries (5-30s) |
| `TASK_MULTI_STEP` | Create a DynamoDB task, invoke async processor, stream status updates to the channel, complete the task | Long-running workflows (30s-5min) |

### Model routing

The same classified intent also selects the model, through two layers:

- **Classification default model.** Each classification declares the models it selects and a default (`models` on its entry; the shipped defaults are Haiku, Sonnet and Opus). The default answers any request not pinned to a specific intent.
- **Per-intent routing.** `INTENT_ROUTE_STRATEGY` (`backend/lib/config/model-strategy.ts`) gives each intent a primary and a fallback model. A route is keyed by the intent it serves ([ADR-064](../design/decisions/064-a-turn-takes-its-model-from-the-intent-and-the-step-it-runs.md)), so the classified intent finds its own route. An intent with no route of its own answers through the `general` route when it is one of the platform intents that do (`ANSWERS_THROUGH_GENERAL`), else on the classification's default model. If the chosen model is not allowed for the user's tier, resolution falls back to the tier default, so per-intent routing never grants more access than the tier already has (`resolveModelForIntent` in `backend/lambda/src/lib/model-resolver.ts`).

| Route (intent) | Primary model | Fallback model |
|--------------|---------------|----------------|
| `general` | haiku | sonnet |
| `code_generation` | sonnet | gpt_oss_20b |
| `code_review` | gpt_oss_20b | sonnet |
| `data_extraction` | haiku | sonnet |
| `report_generation` | titan | sonnet |
| `strategic_analysis` | opus | sonnet |
| `guided_troubleshooting` | sonnet | haiku |

Each route is the intent of the same name; `greeting`, `acknowledgment` and the other platform intents in `ANSWERS_THROUGH_GENERAL` answer through `general` unless the version routes them. An intent routed to an image model in `models.byIntent` (`image_generation` as shipped) generates an image with that route's primary and fallback instead of resolving a text model; image routes never reach the text strategy. A deployment that ships its own intent pack (`ASSISTANT_INTENT_PACK`) supplies its own categories; see [SPEC-CONFIGURABLE-INTENT-PACK.md](../specs/interaction/assistants/SPEC-CONFIGURABLE-INTENT-PACK.md). The resolved model then runs through the Bedrock resilience layer (retry, model fallback, circuit breaker) inside the async processor.

### A/B experiments over the routing

Any of the three model-selection points can be A/B tested. An experiment swaps a model for a share of traffic, with sticky per-conversation assignment (a deterministic hash of the channel and the experiment id), and per-variant results in the admin console.

| Experiment type | What it swaps |
|-----------------|---------------|
| Intent | the model for one specific intent |
| Base Model | the tier default model (any intent on the tier) |
| Classification | the classifier model itself |

A classification experiment cannot run alongside an intent or base-model experiment on the same tier, because changing the classifier shifts routing for every intent and would confound the other test. Full guide: [GUIDE-AB-TESTING-AND-BATTLES.md](../guides/admin/GUIDE-AB-TESTING-AND-BATTLES.md).

### One turn at a time, and what happens to the rest

The flow above is one message being answered. People do not wait for that: they send a second, then a correction to the first, while the assistant is still working.

**A conversation answers one turn at a time** (ADR-033). Anything arriving while a turn is running is held rather than starting a second turn, and the person is told so - one notice, updated in place, not one per message. What is held is then read **as a group**, because three messages that are really one request are only recognisable together, and each becomes a durable task before any of it is executed.

| | |
|---|---|
| Where the state lives | One DynamoDB row per (conversation, assistant). Every handoff is a conditional write on a field of it - there is no `busy` flag and no second store |
| When the queue is read | On message ARRIVAL, dispatched from the message stream, running BESIDE the turn it waits behind - which is what makes an amendment possible, since work can only be changed while it is still running |
| What comes out | A task per message: `queued_request` for work the reading understood, `queued_clarification` for a message it could not make out, `work_still_wanted` when it cannot tell whether the running work is still wanted |
| Who waits | Never the queue. The drain asks and clears; each task it opens is owned by the person who can answer it |

Two consequences are worth knowing at this level. The queue is the only place the platform deliberately makes somebody wait, so it is measured as its own thing - the acknowledgement sets time to first feedback, and the work that comes out of it is measured as task resolution, with human think time kept out of the assistant's latency. And an assistant that could not understand a message says so, rather than proposing work it invented: a guess becomes an item the person has to notice and correct.

Detail: [SPEC-TURN-QUEUE](../specs/interaction/conversation/SPEC-TURN-QUEUE.md) for the behavior, [DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING](../specs/interaction/conversation/DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING.md) for the mechanism.

---

## File Attachment Flow

```
  User drags file onto MessageInput
          │
          ▼
  FileUploadPreview.tsx
  (validates: ≤10MB, allowed MIME types)
          │
          ▼
  attachmentService.ts: requestPresignedUrl()
          │
          ▼
  API Gateway → presigned-url Lambda
  (creates an S3 presigned POST: a policy whose content-length-range
  is a true 1..10MiB cap, with type/encryption/metadata pinned as
  policy conditions; 1-hour default expiry)
          │
          ▼
  attachmentService.ts: uploadToS3()
  (POST the signed policy fields + file to S3 as multipart form data)
          │
          ▼
  Message sent with attachment in Amazon Chime SDK message metadata:
  {
    "attachment": {
      "fileKey": "attachments/<conversationId>/<personId>/<timestamp>-<filename>",
      "name": "report.pdf",
      "type": "application/pdf",
      "size": 245000
    }
  }
          │
          ▼
  Recipient's AttachmentDisplay.tsx:
  (requests download presigned URL, renders preview or download link)
```

`<personId>` is the uploader's AppInstanceUser id, the same id the message's sender ARN carries. The presigned-url Lambda composes the key server-side from `callerPersonId` (`backend/lambda/presigned-url/index.js`), never from the request body.

**Key files:**
- `frontend/packages/chat/src/services/attachmentService.ts` - Upload/download via presigned URLs
- `frontend/packages/chat/src/components/FileUploadPreview.tsx` - Drag-and-drop preview
- `frontend/packages/chat/src/components/AttachmentDisplay.tsx` - Renders attachment in message
- `backend/lambda/presigned-url/index.js` - Generates S3 presigned URLs
- `backend/lib/stacks/conversations-stack.ts` - S3 bucket + CORS + presigned URL API

---

## Conversation Sharing Flow

```
  User clicks "Share" on a conversation
          │
          ▼
  ShareConversationModal.tsx
  (enter recipient email address)
          │
          ▼
  POST /share-conversation
  {
    conversationArn: "...",
    conversationTitle: "Q3 Planning",
    recipientEmail: "user@example.com",
    senderName: "Alice"
  }
          │
          ▼
  share-conversation Lambda:
  1. Resolve the recipient by address (Directory.findByAddress)
  2. Resolve channel classification from the immutable `classification` tag
     (ListTagsForResource, refusing a missing or unknown tag - never
     DescribeChannel metadata, which a member could tamper)
  3. Resolve recipient clearance (Directory.groupsFor → held classifications)
  4. Reject with 403 TIER_FORBIDDEN if the recipient's clearance does not
     include the channel's classification
  5. CreateChannelMembership (bot bearer)
  6. Bot posts public announcement: "X joined." In newly multi-user channels,
     append a mention-required reminder.
  7. Asks the classification's router for a recap turn: the room's primary
     catches the new member up in its own model, voice and language, TARGETED
     at just that member (only they see it; lib/join-recap.ts)
  8. Asks the router for the welcome, targeted at the new member, carrying a
     notify directive naming them (memberWelcome, a conversation-shared
     notice). The email bridge in Notifications reads it off the message
     stream and emails it with a deep link ?conversation=<id>; this function
     sends no email and holds no SES grant
          │
          ▼
  Response: { success, recipientName, isNowMultiUser }
          │
          ▼
  Recipient opens ?conversation=<id> link → App.tsx reads the query param,
  calls selectConversation() once conversations load, strips the param.
```

**Recipient identity.** The share resolves its recipient through the `Directory` seam: the address finds one subject in the deployment's primary issuer's directory, resolved to a person through `Identities` (`Directory.findByAddress`), and the recipient's clearance groups are read by AppInstanceUser (`Directory.groupsFor`) (`backend/lambda/share-conversation/index.js`). An address never binds or creates an identity: no such subject, more than one, or a subject who has never signed in is refused. A person whose only issuer is another registry issuer is not found by address.

**Why this matters:** the email is the welcome message itself, sent by the one bridge every conversation notice goes through, so it carries the same consent, unsubscribe and reply handling as any other notice and the recipient can mute it as a `conversation-shared` notice. The mention hint + targeted summary land in multi-user channels so a dropped-in user (a) sees that the dynamic changed and (b) has context to jump in.

**Tier enforcement (defense in depth):** Channel metadata alone is not a security boundary - it's self-asserted by whoever created the channel. The authoritative signals are the channel's `classification` tag and the person's clearance, read through the `ClearanceSource` seam (Cognito groups are the bundled source). The share Lambda, `create-conversation`, and `router-agent-handler` all independently check it. See `docs/specs/interaction/governance/SPEC-CONVERSATION-SECURITY.md`.

**Key files:**
- `frontend/packages/chat/src/components/ShareConversationModal.tsx` - Share UI
- `frontend/packages/chat/src/App.tsx` - `?conversation=X` deep-link handler
- `backend/lambda/share-conversation/index.js` - tier gate + announce + recap request + the welcome that carries the email
- `backend/lambda/src/lib/join-recap.ts` - the recap turn the share asks of the router
- `backend/lib/stacks/notification-stack.ts` - SES identity + IAM + the share route (served by `PersonApi`)
- `backend/lambda/src/router-agent-handler.ts` - effective classification = the channel's classification (IAM already refused a caller without clearance for it)
- `backend/lambda/src/channel-flow-processor.ts` - multi-member mention routing
- `backend/lambda/cognito-triggers/post-confirmation.js` - `custom:tier` → group sync

---

## Analytics Data Flow

> Both the Athena and Aurora analytics pipelines are wired into the admin console. The base console includes model effectiveness, user feedback, and live conversation operations; Aurora adds the deeper evaluation, drift, and task-analysis views when that stack is deployed.

### Why two data sources (raw archive + curated views)

Every Amazon Chime SDK event lands on one Kinesis stream, and from there it fans out to two sinks that do different jobs. This split is deliberate, not redundancy:

1. **Raw archive (S3): the absolute system of record.** An append-only copy of every event exactly as Amazon Chime SDK Messaging emitted it (channel create/update/delete, membership, message create/update/redact/delete). It is never rewritten. Its jobs are durability, replay and backfill, and debugging: it is the one place that stays true when a derived view is wrong. When a curated view has a bug (drops, mis-parses, or curates away an event), the raw archive is what you read to see what actually happened and to rebuild the view from.

2. **Curated query store (Glue/Athena or Aurora): fast, sometimes mutable views.** A derived store shaped for querying, not for durability. It groups messages into conversations and exchanges, folds placeholder-then-final edits onto one row, derives conversation state (live / archived / deleted), applies redaction-aware reads, and (in Aurora) serves sub-second dashboards, evaluation scoring, drift, and pgvector context. Because the raw archive holds the truth, this layer is free to curate, re-derive, and be rebuilt.

The two roles cannot collapse into one store: an immutable raw log cannot serve sub-second mutable dashboards, and a curated store that rewrites or drops rows cannot be the system of record. The raw S3 archive is the constant across both modes; the analytics mode selects only the curated engine (Glue/Athena by default, Aurora when richer real-time analysis is needed).

### Athena Mode (Default)

Athena mode is the lower-cost way to run the platform. Testing is focused primarily on Aurora mode, so Athena mode gets less end-to-end coverage (see [Testing focus](../guides/admin/AURORA-MODE-GUIDE.md#testing-focus)).

```
  Amazon Chime SDK message events
          │
          ▼
  Kinesis Data Stream (2 shards)
          │
          ▼
  Kinesis Firehose
          │
          ▼
  S3 (partitioned by date)
          │
          ▼
  Glue Data Catalog (schema)
          │
          ▼
  Athena (SQL queries)
          │
          ▼
  Analytics Query Lambda → API Gateway → Admin Dashboard
```

### Aurora Mode (Optional)

```
  Amazon Chime SDK message events
          │
          ▼
  Kinesis Data Stream
          │
          ├──────────────────────────────────────────────┐
          ▼                                              ▼
  Kinesis Firehose → S3                    Archival Lambda (VPC)
  (raw absolute archive,                          │
   system of record)                              │
                                                   ▼
                              writer endpoint (IAM auth); RDS Proxy when enabled
                                                   │
                                                   ▼
                                           Aurora Serverless v2
                                                   │
                                    ┌──────────────┼──────────────┐
                                    ▼              ▼              ▼
                              messages       exchanges     conversations
                              table          table         summaries
                                    │              │              │
                                    ▼              ▼              ▼
                              Drift          Evaluation    Cross-conversation
                              Detection      Scoring       Context (pgvector)
                                    │              │              │
                                    └──────────────┼──────────────┘
                                                   ▼
                                    Analytics Query Lambda (VPC)
                                                   │
                                                   ▼
                                           API Gateway
                                                   │
                                                   ▼
                                           Admin Dashboard
                                    (intent-anchored Effectiveness drill
                                       + supporting views, Aurora mode)
```

The diagram above is the **archival/analytics** path (asynchronous, off the request path). The **live request path** reaches Aurora separately: the non-VPC agent handler invokes a VPC-attached **retrieval data-plane Lambda** that runs RAG retrieval and drift detection (embed + pgvector) and returns results. The handler stays out of the VPC so it can still reach SSM, Cognito, and Lambda-invoke; the data-plane Lambda reuses the existing Bedrock and Secrets endpoints, adding no new VPC endpoints (ADR-013). See [RAG.md](../guides/developer/RAG.md) and, for per-piece costs, [INFRASTRUCTURE-COST.md](../guides/admin/INFRASTRUCTURE-COST.md).

**Key files:**
- `backend/lib/stacks/archive-stack.ts` - Athena mode (Kinesis → Firehose → S3 → Glue → Athena)
- `backend/lib/stacks/archive-stack-aurora.ts` - Aurora mode (VPC + Aurora; RDS Proxy opt-in via `enableRdsProxy`, default off)
- `backend/lambda/src/analytics-aurora/kinesis-archival.ts` - Kinesis → Aurora consumer
- `backend/lambda/src/analytics-aurora/analytics-query.ts` - Dashboard query API
- `backend/lambda/src/analytics-aurora/drift-detection.ts` - Topic drift detection
- `backend/lambda/src/analytics-aurora/cross-conversation-context.ts` - pgvector search
- `frontend/packages/admin/src/components/admin/AdminDashboard.tsx` - Dashboard shell (tab routing)
- `frontend/packages/admin/src/services/analyticsService.ts` - Analytics API client

**Aurora-mode add-ons (opt-in, same stack):**
- **Out-of-band message analytics (A/B + metadata-cap decoupling).** Heavy per-message analytics - per-step execution telemetry and the full analytics blob - are written to a `MessageAnalytics` DynamoDB table keyed by message id (keeping the Amazon Chime SDK `Metadata` under its ~1 KB cap), and the archival Lambda merges them back on ingest; the analytics query reads them back per message (`analytics-query.ts`). Per-variant experiment results also fold in **real human signals** - thumbs (from the feedback table) and `/battle` wins (from the BattleOutcome table) - via read-time scans over the VPC DynamoDB gateway endpoint. See `docs/specs/communication/SPEC-MESSAGE-METADATA-CODEBOOK.md`.
- **Cost sleep mode (`-c sleepMode=true`).** The same stack conditionally adds a `deployment-state` table, an EventBridge idle checker, the public `GET /deployment/state` on `PersonApi`, the admin `POST /query/deployment/sleep` and `POST /query/deployment/wake` on `AdminApi`, and an SNS topic. The checker pauses Aurora Serverless v2 (`ModifyDBCluster` → MinCapacity 0) after `sleepAfterIdle` of inactivity; an admin wake restores it, and users see a paused-state banner meanwhile. See `docs/specs/foundations/SPEC-COST-SLEEP-MODE.md`.

**Cost attribution (tagging).** Every stack self-tags at the app root via `applyStandardTags` (`backend/lib/tagging.ts`): `Project` is **derived from the deployment identity** (`STACK_PREFIX`), never hardcoded, so several instances in one AWS account bill apart in Cost Explorer. See `docs/guides/admin/TAGGING.md`.

---

## Frontend Provider Hierarchy

Providers must be initialized in order. Each depends on the one above it.

```
  <AuthProvider>                    ← Cognito tokens (IdToken, AccessToken, RefreshToken)
    │
    └─ <AwsClientProvider>          ← vended credentials from the credential exchange; creates Amazon Chime SDK client
         │
         └─ <MessagingProvider>     ← WebSocket session; channel message callbacks
              │
              └─ <ConversationProvider>  ← Conversation list, active conversation, message state
                   │
                   └─ <App />       ← UI components can use all 4 contexts
```

**Why this order matters:**
- `AwsClientProvider` needs the IdToken from `AuthProvider` to call the credential exchange
- `MessagingProvider` needs the Amazon Chime SDK client from `AwsClientProvider` to open a WebSocket
- `ConversationProvider` needs the WebSocket from `MessagingProvider` to receive messages

If a provider fails to initialize, everything below it is unavailable. The `ConnectionStatus` component shows the current state.

---

## Where to Look

| "I want to..." | Start here |
|-----------------|-----------|
| Change the AI system prompt | The admin Profiles tab / `manage-profiles` - edit the active version's persona, no deploy (fallbacks: the per-deployment SSM persona param, then the `defaultPersona` the serving profile declares in `backend/lib/config/profiles.ts`) |
| Add a new intent | `backend/lambda/src/lib/intent-classifier.ts` → `delivery-options.ts`; for its model route, `backend/lib/config/model-strategy.ts` (`INTENT_ROUTE_STRATEGY`) |
| Add a new user tier | [How to add or manage a profile](../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md) |
| Change the auth flow | `frontend/packages/shared/src/providers/AuthProvider.tsx` + `backend/lib/stacks/identity-stack.ts` |
| Add an admin dashboard tab | `frontend/packages/admin/src/components/admin/` + `AdminDashboard.tsx` |
| Modify the analytics pipeline | `backend/lib/stacks/archive-stack.ts` (Athena) or `archive-stack-aurora.ts` (Aurora) |
| Change file upload limits | `backend/lambda/presigned-url/index.js` (the enforced size cap + MIME allow-list) and `frontend/packages/chat/src/services/attachmentService.ts` (the matching client-side check) |
| Debug message delivery | `backend/lambda/src/lib/async-processor-core.ts` → CloudWatch Logs |
| Debug auth token issues | `frontend/packages/shared/src/providers/AuthProvider.tsx` → browser console |
| Understand the database schema | `backend/lambda/src/analytics-aurora/schema/001-initial.sql` |
| Run E2E tests | `tests/e2e/` → `npm test` (requires deployed backend) |
| Run backend unit tests | `backend/test/` → `npm test` |
| Review security posture | Security Model section below + `docs/guides/developer/SECURITY-NPM-SUPPLY-CHAIN.md` |
| Apply design tokens | `frontend/packages/shared/src/styles/design-tokens.css` → [DESIGN-SYSTEM.md](../guides/developer/DESIGN-SYSTEM.md) |

---

## User Tiers & Access Control

Access to AI models is enforced at the IAM level. Deployments can choose Anthropic, Amazon, or OpenAI-on-Bedrock options per tier, but a Basic user still cannot invoke premium-only models directly.

| Tier | Models Available | Handler Timeout | Task Tracking | File Access |
|------|-----------------|----------------|---------------|-------------|
| Basic | Configurable basic model (default: Claude Haiku) | 30s | DynamoDB tasks | `context/basic/*` prefix |
| Standard | Configurable standard model plus standard-safe fallbacks (default: Sonnet) | 60s | DynamoDB tasks | `context/standard/*` prefix |
| Premium | Configurable premium model with full catalog access (default: Opus) | 90s | DynamoDB tasks | `context/premium/*` prefix |

Which models a classification uses is its own selection (`models` on its entry in `profiles`), granted by its own stack; no context key overrides it ([MODEL_STRATEGY](../guides/developer/MODEL_STRATEGY.md#three-layers)).

**How tier is determined:** the person's clearance is the authoritative signal, read via `resolveUserClearance` (`backend/lambda/src/lib/user-clearance.ts`) through `Directory.clearanceOf`, which asks each of the person's issuers for its declared clearance source (`backend/lambda/src/lib/clearance-source.ts`) and bounds it by that issuer's classifications; for this deployment's own pool the source is its Cognito groups (`basic`/`standard`/`premium`). The membership audit and the group reconcile read clearance the same way; the share reads the recipient's groups through `Directory`, and the console's user management writes the pool's groups and reads them through the pool's adapter. The `custom:tier` attribute is only the approval-time input, synced into the groups. The fulfillment handler (`router-agent-handler.ts`) takes the channel's classification as the effective tier (IAM has already refused a sender without clearance for that channel, and a clearance mismatch logs a SecurityEvent), then dispatches to that profile's async processor (the shared `assistant-async-processor.ts`, deployed once per profile). Lex is only the entry trigger; it performs no routing or tier logic.

**How tier is enforced:** Each profile's processor Lambda has its own IAM role with Bedrock `InvokeModel` permissions scoped to that profile's model ARNs (`modelArnsForClassification`). The credential exchange vends frontend SDK clients a session pinned to the caller's AppInstanceUser and scoped to their clearance; there is no Identity Pool, so the exchange is the only source of a person's AWS credentials and its URL is required.

---

## Admin Dashboard

The admin console groups its views into **7 sections** (section rail + sub-tabs, the `SECTIONS` array in `frontend/packages/admin/src/components/admin/AdminDashboard.tsx`): Operations (Overview, Alerts, Client), Performance (the Effectiveness overview with its Effectiveness and Latency drills, Answer types, Queue, the basic Evaluations view in Athena mode, and the Flagged and Ground Truth action tabs), Oversight (Conversations, Membership Audit, Access log), Models (Models + Model Strategy), Assistants (Profiles), Experiments (Experiments + the classifier gate), and Users (Users + Manage Users). Flows, Tasks, and Steps are not standalone tabs: their detail lives inside the Effectiveness drill, and Latency is a drill rather than a tab. Views unavailable in the active analytics mode are hidden - Aurora-only views in Athena mode, and the Athena-only Evaluations view in Aurora mode (there the drill is the evaluation surface). (Usage: [ADMIN-GUIDE.md](../guides/admin/ADMIN-GUIDE.md); design: [SPEC-ADMIN-CONSOLE.md](../specs/interface/SPEC-ADMIN-CONSOLE.md).) The individual views:

| Tab | Mode | Data Source | Shows |
|-----|------|------------|-------|
| Overview | Both | `conversation_volumes`, `intent_distribution` | Daily message/conversation counts, intent type breakdown |
| Alerts | Aurora | Effectiveness, model-effectiveness, and latency data | Consolidated alertable conditions: literal errors, latency SLA breaches, and eval-quality breaches |
| Latency (drill from the Performance overview) | Both | `latency_metrics` | Avg/P95 total, Bedrock inference, and polling time |
| Conversations | Both | `/admin/conversations`, `/admin/conversations/{channelId}/messages`, `/admin/conversations/membership-history`; vended sessions from `/exchange-credentials/admin/{view-live-members,manage-membership,redact,delete}`; `drift_events` | **Archive-backed** conversation browser (the archive reader: Athena over the `conversations` Glue table, or Aurora in Aurora mode - not live Amazon Chime SDK), messages with per-message inspect (stored fields + metadata + raw; the sender's id always, the sender's name only under the identity grant `USER_IDENTITY_VIEW_GROUP_NAMES` and `identity not shown` in its place otherwise), and membership-history timeline. The member list, add/remove, redact (moderation) and delete (administration) run client-side against the Amazon Chime SDK as the admin's own `${personId}-admin` identity, on a session the admin exchange vends per action (`backend/lambda/src/admin-conversations.ts`). Optional drift view in Aurora mode. |
| Effectiveness | Aurora | `intent_effectiveness`, `intent_exchanges`, `task_timeline` | Intent-anchored worst-first dashboard (classification/execution/latency/cost/tool-error per intent), drilling intent -> exchanges/tasks -> per-task turn timeline -> steps (the detail that the retired Evaluations/Flows/Tasks/Steps tabs carried) |
| Evaluations | Athena | `evaluation_scores` | Scores by date, agent type, intent - color-coded by quality (the basic evaluation view; in Aurora mode the Effectiveness drill supersedes it) |
| Flagged | Aurora | `flagged_responses` | Response review queue: approve/reject with notes |
| Ground Truth | Aurora | `ground_truth` | Human scores vs automated scores, calibration metrics |
| Models | Both | `model_usage`, `model_effectiveness`, `/feedback` | Per-model usage, intent-by-model effectiveness, latency, compliance, and user feedback summaries. Each average is taken over the exchanges that carry the value and returns its own count (`scored_count` for quality, `timed_count` for latency): an unjudged exchange is not a zero, and an unmeasured turn is not an instant one |
| Model Strategy | Both | Static frontend config mirrored from backend strategy metadata | Provider posture, deploy-time model choices, intent routing, fallback model guidance, tier availability |
| Profiles | Both | `/admin/profiles` | Versioned, portable assistant profiles: edit persona/model/tool configuration, activate, rollback, import/export - no redeploy |
| Experiments | Both | `experiment_results`, DynamoDB `ExperimentsTable` | A/B test management: create/pause/complete experiments, side-by-side variant comparison (score, latency, tokens, compliance, fallback rate) |
| Users | Both | `active_users_daily`, `messages_per_user`, `signup`/`signin_funnel_conversion` (client-events); `user_activity` legacy fallback | Session DAU vs messaging DAU + tier breakdown, sign-up/sign-in conversion funnels, top-50 sender leaderboard |
| Manage Users | Both | Cognito admin actions | Approve, reject, tier, and enable users from the console |
| Membership Audit | Both | Layer 6 membership-audit findings | Uncleared membership flags for review, with the report-only vs auto-revoke runtime toggle |

---

## Error States & Edge Cases

| Scenario | Behavior |
|----------|----------|
| **Bedrock unavailable** | Async processor catches `ServiceException` → logs error; placeholder message stays as "One moment..." with no automatic recovery |
| **WebSocket disconnect** | Amazon Chime SDK `MessagingSession` auto-reconnects with exponential backoff; `ConnectionStatus` component shows state |
| **Token expires mid-conversation** | 50-minute refresh interval prevents this in most cases; if refresh fails, user is redirected to login; in-flight messages may be lost |
| **S3 upload fails** | `attachmentService.ts` catches error → `FileUploadPreview` shows error state; user can retry |
| **Presigned URL expires before upload** | URL defaults to 1-hour expiry; if expired, `attachmentService` returns error and user must re-attach |
| **Email fails (sharing)** | The share function sends no email: the `Notifications` email bridge sends the welcome's notice, so a failed send is the bridge's and does not fail the share |
| **Lex returns `FallbackIntent`** | The fulfillment handler classifies the request itself and applies its default routing (Lex is only the trigger) |
| **Concurrent messages in same channel** | Amazon Chime SDK handles ordering; each message gets a unique `MessageId`; no deduplication - duplicate sends produce duplicate messages |
| **Aurora connection failure** | `db-client.ts` pool reconnects on auth errors; other errors thrown to caller |
| **Lambda timeout (30-90s by tier)** | Async processor is killed; placeholder message stays; no automatic cleanup of DynamoDB task state |

---

## Security Model

This section summarizes security controls.

**Authentication:**
- Every token is verified at the edge authorizer against the trusted-issuer registry; a token from an undeclared issuer reaches nothing
- The deployment's own Cognito pool, when declared, with email verification and configurable admin approval
- Tokens stored in browser memory (React state) - not localStorage, not cookies
- 50-minute refresh interval, plus a credential refresh before the WebSocket re-opens on a stale reconnect (page hidden >5 min or no messages >5 min)
- The credential exchange maps an authenticated person to temporary IAM credentials pinned to their AppInstanceUser; it is the only source of a person's AWS credentials (there is no Identity Pool)

**Authorization:**
- Tier-based IAM policies scope Bedrock model access per user role
- Each Lambda handler has its own IAM role with least-privilege permissions
- Lambda invoke permissions scoped to each handler's own async processor (no cross-tier invocation)
- S3 file access scoped by tier prefix (`context/basic/*`, `context/standard/*`, `context/premium/*`)

**Input handling:**
- React escapes all rendered content (no `dangerouslySetInnerHTML`)
- Message metadata markers (`<!--ACTIVE_TASK:-->`) stripped by `messageParser.ts` before display
- File uploads enforced server-side by the presigned-url Lambda (`backend/lambda/presigned-url/index.js`): MIME allow-list, filename sanitizing (path separators / control characters / traversal segments rejected), identity-bound keys (the caller's AppInstanceUser id from `callerPersonId`, never a body-supplied userId), and a POST-policy `content-length-range` of 1 byte to 10 MiB; the client mirrors the same limit and type checks. No server-side malware scanning
- SQL queries in Aurora mode use parameterized queries; table/column names validated against identifier regex

**CORS:**
- CORS is configured on each HTTP API: `PersonApi` allows `appUrl`, `adminAppUrl` and every origin an issuer declares in `allowedOrigins`; `AdminApi` allows `adminAppUrl`
- S3 attachment bucket CORS is pinned to the configured `appUrl` origin (`conversations-stack.ts`)

**Data in transit:**
- All AWS SDK calls use HTTPS
- Aurora connections use SSL with certificate validation (`rejectUnauthorized: true`)
- The default Aurora connection is direct to the writer endpoint with IAM authentication tokens; the optional RDS Proxy (opt-in) uses the same IAM auth

---

## Data Processing & Retention

**Where user data flows:**

| Data | Storage | Retention | Contains PII? |
|------|---------|-----------|---------------|
| Messages | Amazon Chime SDK AppInstance | Controlled by Amazon Chime SDK (not configurable in this project) | Yes - message content, sender ARN |
| File attachments | S3 bucket | 90 days (lifecycle rule) | Possible - depends on uploaded files |
| Analytics (Athena) | Kinesis → Firehose → S3 | 90 days (S3 lifecycle) | Yes - sender ARN, message content |
| Analytics (Aurora) | Aurora PostgreSQL | 90 days for evaluation_results (`expires_at`); messages table has no auto-expiry | Yes - `sender_name`, `sender_arn`, and the person key (`person_id`) |
| Task tracking | DynamoDB | TTL-based expiry (set per task) | Yes - the person key (`personId`) |
| Cross-conversation context | Aurora PostgreSQL | No auto-expiry | Yes - the person key (`person_id`), conversation summaries |

**Third-party data processing:**
- **Amazon Bedrock:** User messages are sent to Bedrock for model inference. Bedrock runs within your AWS account and region. Per [AWS documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html), Bedrock does not use customer inputs to train models and does not share data with model providers (Anthropic, Amazon). Data stays within your AWS account boundary.
- **Amazon Chime SDK:** Messages are stored in the Amazon Chime SDK AppInstance within your AWS account. Amazon Chime SDK is an AWS-managed service subject to the [AWS Data Processing Addendum](https://d1.awsstatic.com/legal/aws-dpa/aws-dpa.pdf).
- **Amazon SES:** Recipient email addresses are sent to SES for conversation sharing. SES is subject to the AWS DPA.
- **Image models hosted outside AWS:** where a classification selects one (`models.selected`), a workflow's image step sends its recorded brief to that provider ([ADR-064](../design/decisions/064-a-turn-takes-its-model-from-the-intent-and-the-step-it-runs.md) security posture). The brief may carry a requirement drawn from the classification's corpus. The platform does not block it; it records each such call on the turn's archive record (`imageEgress`: the provider, the model, and whether the brief carried a context-sourced requirement). Whether a classification may use an external image model is the admin's choice.

**PII in analytics:** The analytics pipeline stores user identifiers in queryable tables. Admin users can query conversation history, evaluation scores, and cross-conversation context by the person key, the AppInstanceUser id (`person_id` in Aurora, `personId` in DynamoDB). Deleting a person erases their records by AppInstanceUser over every store and keeps their battle votes and feedback, still carrying that id (`backend/lambda/src/lib/offboarding.ts`, **NOT VERIFIED** on a deployment). Organizations with GDPR/CCPA requirements should implement data subject access/deletion procedures against these tables.

---

## Testing

| Test type | Location | What it covers | Gaps |
|-----------|----------|---------------|------|
| **E2E (Playwright)** | `tests/e2e/` | Signup, signin, agent intents (per tier), admin dashboard | Disabled in CI; requires deployed AWS environment |
| **Backend unit (Jest)** | `backend/test/` | CDK synth validation, Aurora modules (db-client, drift-detection, cross-conversation-context) | Tests mock all external dependencies; no integration tests against real databases |
| **Frontend unit (Vitest)** | `frontend/packages/*/src/**/*.test.{ts,tsx}` | Components, providers, services, and utils (about 220 test files across chat, admin, shared and widget; run with `cd frontend && npm test`) | Coverage is targeted at behavior-heavy modules, not exhaustive |

```bash
# Run E2E tests (requires deployed backend + running frontend)
cd tests && npm test

# Run backend unit tests
cd backend && npm test
```

**Known testing gaps:**
- E2E tests are disabled in CI (`.github/workflows/ci.yml`) because they require a deployed AWS environment
- Backend unit tests mock everything - no integration tests verify actual database queries, Bedrock calls, or Amazon Chime SDK interactions
- No load/performance testing
- Error paths and edge cases are largely untested

This is a significant gap for production use.

---

## Frontend Styling

All UI components use CSS custom properties (design tokens) defined in `frontend/packages/shared/src/styles/design-tokens.css`. Component-specific styles live in co-located `.css` files (e.g., `MessageInput.css` next to `MessageInput.tsx`).

Status colors in admin dashboard tabs use `var(--status-good)`, `var(--status-warn)`, `var(--status-bad)`, `var(--status-info)`, and `var(--status-neutral)` tokens rather than hardcoded hex values.

For the full design system (color palette, typography, component patterns, dark mode), see [DESIGN-SYSTEM.md](../guides/developer/DESIGN-SYSTEM.md).

---

## Licensing

AgentEchelon is released under the **MIT License**. Key dependency licenses:

| Dependency | License |
|-----------|---------|
| React | MIT |
| AWS CDK | Apache 2.0 |
| AWS SDK for JavaScript v3 | Apache 2.0 |
| Amazon Chime SDK for JS | Apache 2.0 |
| Playwright (dev) | Apache 2.0 |
| Vite (dev) | MIT |

All dependencies are permissive (MIT or Apache 2.0). No GPL-licensed dependencies are included. AWS services (Bedrock, Cognito, Amazon Chime SDK, S3) are used at runtime but not bundled.

---

## Related Documentation

| Document | What it covers |
|----------|---------------|
| [README.md](../../README.md) | Setup, configuration, cost estimates, customization guide |
| [CLAUDE.md](../../CLAUDE.md) | Quick reference for development sessions |
| [SPEC-AURORA-VPC-MODE.md](../specs/foundations/SPEC-AURORA-VPC-MODE.md) | Full Aurora mode spec (VPC, RDS Proxy, schema, costs, risks) |
| [CHIME_SDK_INTEGRATION.md](../guides/developer/CHIME_SDK_INTEGRATION.md) | Amazon Chime SDK integration details and Lex event format |
| [SECURITY-NPM-SUPPLY-CHAIN.md](../guides/developer/SECURITY-NPM-SUPPLY-CHAIN.md) | npm supply-chain hardening (install-script blocking, lockfile pinning, audit practices) |
| [DESIGN-SYSTEM.md](../guides/developer/DESIGN-SYSTEM.md) | CSS design tokens, component patterns, typography |
| [IDENTITY-PROVIDER-GUIDE.md](../guides/user/IDENTITY-PROVIDER-GUIDE.md) | How to integrate Auth0, Okta, Azure AD, LDAP, or any IdP |
