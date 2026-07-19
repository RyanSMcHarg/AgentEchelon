# Architecture Guide

This document explains how AgentEchelon works end-to-end. It covers every major flow, how the CDK stacks connect, and where to look when extending or debugging the system.

For deployment instructions, see [README.md](../../README.md). For Aurora-specific architecture, see [SPEC-AURORA-VPC-MODE.md](../specs/analytics-eval/SPEC-AURORA-VPC-MODE.md).

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
                    │  Cognito          ││  │ API  ││  │ API  ││
                    │  User Pool +      ││  │ GW 1 ││  │ GW 2 ││
                    │  Identity Pool    ││  │      ││  │      ││
                    └───────┬───────────┘│  └──┬───┘│  └──┬───┘│
                            │            │     │    │     │    │
        ┌───────────────────┘            │     │    │     │    │
        │ IAM credentials               │     │    │     │    │
        ▼                                │     │    │     │    │
 ┌──────────────┐                        │     │    │     │    │
 │  Amazon Chime SDK   │◄───────────────────────┘     │    │     │    │
 │  Messaging   │                              │    │     │    │
 │  AppInstance  │                              │    │     │    │
 └──────┬───────┘                              │    │     │    │
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
 │  V2 Bot      │    │ add-agent                    │     │    │
 │  (entry      │    │ share-conversation           │     │    │
 │  trigger)    │    └──────────────────────────────┘     │    │
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

**Reading the flow:** the **Channel Flow Processor** runs first on every message (mention rules, filtering, marker stripping); `@all` bypasses Lex and invokes the async processor directly. **Amazon Lex is only the entry trigger** - an Amazon Chime SDK-to-Lambda passthrough via its Dialog Code Hook - not a classifier or router. Each tier's Lex bot fulfils into that tier's **own handler Lambda**: all run the shared `router-agent-handler.ts` code but are deployed one per tier (per-tier ownership, ADR-011), not a single shared router. The models shown per tier are **defaults**; model selection is configurable per tier and per intent via `model-strategy` (Anthropic Claude, Amazon Nova, OpenAI GPT-OSS), so the platform is model-agnostic, not Anthropic-only.

---

## CDK Stack Dependency Graph

Stacks must be deployed in dependency order. `cdk deploy --all` handles this automatically.

```
ChimeMessaging                    (foundation — no dependencies)
     │
     ├──► CognitoAuth             (references AppInstance ARN)
     │
     ├──► S3Storage               (attachments bucket)
     │
     ├──► Analytics               (Athena mode: Kinesis stream)
     │    OR AnalyticsAurora      (Aurora mode: VPC + Aurora + Kinesis; RDS Proxy opt-in)
     │
     ├──► Foundations             (task tables + abuse-controls table [rate limit / spend budget / dedup] +
     │                             conversation-actions audit table; create-conversation/add-agent +
     │                             conversation-management [archive/remove-member/leave] APIs; depends on Analytics + CognitoAuth)
     │
     ├──► Experiments             (A/B experiments table + admin-experiments API; depends on CognitoAuth)
     │
     ├──► Notifications           (references User Pool for email)
     │
     ├──► Battle                  (default-on; /battle tables + orchestrator; depends on Experiments)
     │
     ├──► Tier-{Basic,Standard,Premium}   (the shared async processor + Lex bot + AppInstanceBot, one instance per profile;
     │                                     depend on Foundations + Experiments; Standard/Premium also on Battle)
     │
     ├──► ChannelFlow             (@all routing + message filtering; depends on Foundations + the tier stacks)
     │
     └──► Frontend                (CloudFront + private S3 origin for the SPA)
```

Eleven stacks deploy in both modes (ChimeMessaging, CognitoAuth, S3Storage, Foundations, Experiments, the three `Tier-*` stacks, Notifications, ChannelFlow, Frontend). `Battle` is default-on (opt out with `-c enableBattle=false`), and one analytics stack is added - `Analytics` in Athena mode or `AnalyticsAurora` in Aurora mode.

**Stack outputs flow:** Each stack exports values (ARNs, URLs) as CloudFormation outputs; the per-tier stacks instead publish their processor/bot ARNs to SSM. The frontend `.env` file is populated from these outputs. See `.env.example` for the mapping.

| Stack                         | Key Outputs                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChimeMessaging                | `AppInstanceArn`                                                                                                                                        |
| CognitoAuth                   | `UserPoolId`, `UserPoolClientId`, `IdentityPoolId`, `CredentialExchangeApiUrl`, `UserManagementApiUrl`, `AdminConversationApiUrl`, `UserFeedbackApiUrl` |
| S3Storage                     | `PresignedUrlApiUrl`, `AttachmentBucketArn`                                                                                                             |
| Foundations                   | `CreateConversationApiUrl`, `AddAgentApiUrl`                                                                                                            |
| Experiments                   | `ExperimentsApiUrl`                                                                                                                                     |
| Notifications                 | `ShareApiUrl`                                                                                                                                           |
| Battle                        | `BattleOutcomeApiUrl`                                                                                                                                   |
| Tier-{Basic,Standard,Premium} | SSM: `/agent-echelon/assistant/{tier}/{processor-arn,bot-arn}`                                                                                               |
| ChannelFlow                   | `ChannelFlowArn`, `ProcessorFunctionArn`                                                                                                                |
| Analytics / AnalyticsAurora   | `AnalyticsApiUrl`, `ClientEventsApiUrl` (Athena)                                                                                                        |

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
                                    │ (creates Amazon Chime SDK       │
                                    │  AppInstanceUser)    │
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
                              │  IdToken → Cognito Identity Pool│
                              │  → Temporary IAM credentials    │
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

**Auth failure states:**

| Failure | What happens |
|---------|-------------|
| Wrong password | `AuthProvider` catches `NotAuthorizedException` → error shown on LoginScreen |
| Unverified email | Cognito returns `UserNotConfirmedException` → redirects to verification screen |
| Token expired mid-session | 50-minute refresh interval fires `REFRESH_TOKEN_AUTH` → if refresh fails, user is redirected to login |
| Network error during login | Catch-all error → "Unable to sign in" message on LoginScreen |
| Refresh token expired (30 days) | `REFRESH_TOKEN_AUTH` returns `NotAuthorizedException` → user must re-login |

**Key files:**
- `frontend/src/providers/AuthProvider.tsx` - Cognito auth, token management, refresh logic
- `frontend/src/providers/AwsClientProvider.tsx` - Identity Pool → IAM credentials → SDK clients
- `backend/lib/stacks/cognito-auth-stack.ts` - User Pool, Identity Pool, Lambda triggers
- `backend/lambda/cognito-triggers/post-confirmation.js` - Creates Amazon Chime SDK AppInstanceUser on signup

---

## Message Flow

This is the core flow: user sends a message and receives an AI response.

> **Full walkthrough:** [`docs/guides/developer/MESSAGE-FLOW.md`](../guides/developer/MESSAGE-FLOW.md) traces every hop
> (channel flow, Lex, `@assistant`/`@all` routing, fulfillment, async processor),
> says *why* each exists, and maps where each enforcement layer acts.

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
 │  Channel Flow Processor runs first (@all/@everyone → invoke the      │
 │  async processor DIRECTLY, bypassing Lex; otherwise pass to Lex)     │
 │       │                                                              │
 │       ▼                                                              │
 │  Per-tier Lex V2 Bot: RecognizeText                                 │
 │       │                                                              │
 │       ├── FallbackIntent fulfillment → shared router                 │
 │       │                                                              │
 │       ▼                                                              │
 │  router-agent-handler.ts (shared router / Lex fulfillment)          │
 │       │                                                              │
 │       ├── 1. Resolve tier: min(userTier, channelTier)                │
 │       │                                                              │
 │       ├── 2. Classify intent (keywords, else the LLM classifier)     │
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
 │                    │   out-of-band guardrail on output — no Agent     │
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
- `frontend/src/components/MessageInput.tsx` - User input, file attachment, send button
- `frontend/src/providers/ConversationProvider.chime.tsx` - `sendMessage()`, message state
- `frontend/src/providers/MessagingProvider.tsx` - WebSocket session, message callbacks
- `frontend/src/utils/messageParser.ts` - Strip metadata markers before display
- `backend/lambda/src/router-agent-handler.ts` - Shared Lex fulfillment: tier resolution (`min(userTier, channelTier)`), intent classification, delivery selection, dispatch to the per-tier processor (ARN from SSM)
- `backend/lambda/src/channel-flow-processor.ts` - Runs first on every message; `@all`/`@everyone` invokes the async processor directly (bypassing Lex)
- `backend/lambda/src/assistant-async-processor.ts` - The single config-driven assistant processor (one instance deployed per profile; self-gates its capabilities on the profile env)
- `backend/lambda/src/lib/intent-classifier.ts` - Fast-path keywords + a configurable LLM classifier (`CLASSIFIER_MODEL_ID`, default Haiku); Basic tier is keyword-only
- `backend/lambda/src/lib/delivery-options.ts` - Intent → delivery option mapping
- `backend/lambda/src/lib/model-resolver.ts` + `backend/lib/config/model-strategy.ts` - Intent → model routing (`INTENT_ROUTE_STRATEGY`: primary + fallback per intent, capped to the tier's allowed models)
- `backend/lambda/src/lib/async-processor-core.ts` - the self-hosted Converse tool loop (terminal Bedrock call `invokeBedrock`), marker parsing, response delivery

---

## Intent Classification & Model Routing

> **Terminology.** "Intent" here means the platform's own *request classification*: the category the classifier assigns to an incoming message (a code question, a report request, a greeting). It is not the same thing as an Amazon Lex *intent* (Lex's own NLU unit). The router uses Lex only as the entry trigger and classifies the request itself downstream, so "intent" below always means this classified request category. (Whether to rename this concept to avoid the collision with Lex's term is an open follow-up.)

A message is classified once, and that single classification drives **two independent decisions**: how the reply is **delivered** (next), and which **model** answers it (Model routing, below).

```
  User message arrives at agent handler
          │
          ▼
  ┌─────────────────────────────────────────┐
  │ Fast-path keyword matching              │
  │                                         │
  │ "hello" / "hi" → GREETING              │
  │ "thanks" / "ok" → ACKNOWLEDGMENT       │
  │ "error" / "fix" → GUIDED_TROUBLESHOOTING│
  │ "extract" / "pull" → DATA_EXTRACTION   │
  │ "report" / "summary" → REPORT_GENERATION│
  └────────────┬────────────────────────────┘
               │
               │ no keyword match?
               ▼
  ┌─────────────────────────────────────────┐
  │ LLM classifier for unmatched messages   │
  │ (model set by CLASSIFIER_MODEL_ID;      │
  │  default Haiku). Basic tier is keyword- │
  │  only. Categories from the intent pack. │
  └────────────┬────────────────────────────┘
               │
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

- **Tier default model.** Each tier has a configurable default (`basicModelKey` / `standardModelKey` / `premiumModelKey`; defaults Haiku, Sonnet, Opus). It answers any request not pinned to a specific intent.
- **Per-intent routing.** `INTENT_ROUTE_STRATEGY` (`backend/lib/config/model-strategy.ts`) gives each intent a primary and a fallback model. The classifier's category is mapped to a strategy key (`INTENT_TYPE_TO_KEY`; anything unmapped goes to `general_qa`), then the strategy is applied. If the chosen model is not allowed for the user's tier, resolution falls back to the tier default, so per-intent routing never grants more access than the tier already has (`resolveModelForIntent` in `backend/lambda/src/lib/model-resolver.ts`).

| Strategy key | Primary model | Fallback model |
|--------------|---------------|----------------|
| `general_qa` | haiku | sonnet |
| `code_generation` | sonnet | gpt_oss_20b |
| `code_review` | gpt_oss_20b | sonnet |
| `document_extraction` | haiku | sonnet |
| `report_generation` | titan | sonnet |
| `strategic_analysis` | opus | sonnet |
| `workflow_actions` | sonnet | haiku |

How the default intent pack maps onto those keys: `general` / `greeting` / `acknowledgment` to `general_qa`, `data_extraction` to `document_extraction`, `report_generation` to `report_generation`, `guided_troubleshooting` to `workflow_actions`. A deployment that ships its own intent pack (`ASSISTANT_INTENT_PACK`) supplies its own categories; see [SPEC-CONFIGURABLE-INTENT-PACK.md](../specs/assistant-context/SPEC-CONFIGURABLE-INTENT-PACK.md). The resolved model then runs through the Bedrock resilience layer (retry, model fallback, circuit breaker) inside the async processor.

### A/B experiments over the routing

Any of the three model-selection points can be A/B tested. An experiment swaps a model for a share of traffic, with sticky per-conversation assignment (a deterministic hash of the channel and the experiment id), and per-variant results in the admin console.

| Experiment type | What it swaps |
|-----------------|---------------|
| Intent | the model for one specific intent |
| Base Model | the tier default model (any intent on the tier) |
| Classification | the classifier model itself |

A classification experiment cannot run alongside an intent or base-model experiment on the same tier, because changing the classifier shifts routing for every intent and would confound the other test. Full guide: [GUIDE-AB-TESTING-AND-BATTLES.md](../guides/admin/GUIDE-AB-TESTING-AND-BATTLES.md).

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
  (generates S3 PutObject presigned URL, 1-hour default expiry)
          │
          ▼
  attachmentService.ts: uploadToS3()
  (PUT file to S3 via presigned URL)
          │
          ▼
  Message sent with attachment in Amazon Chime SDK message metadata:
  {
    "attachment": {
      "fileKey": "attachments/<conversationId>/<userId>/<timestamp>-<filename>",
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

**Key files:**
- `frontend/src/services/attachmentService.ts` - Upload/download via presigned URLs
- `frontend/src/components/FileUploadPreview.tsx` - Drag-and-drop preview
- `frontend/src/components/AttachmentDisplay.tsx` - Renders attachment in message
- `backend/lambda/presigned-url/index.js` - Generates S3 presigned URLs
- `backend/lib/stacks/s3-storage-stack.ts` - S3 bucket + CORS + presigned URL API

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
  1. Look up recipient in Cognito (by email)
  2. Resolve channel tier (DescribeChannel metadata)
  3. Resolve recipient tier (AdminListGroupsForUser → basic/standard/premium)
  4. Reject with 403 TIER_FORBIDDEN if recipient tier < channel tier
  5. CreateChannelMembership (bot bearer)
  6. Bot posts public announcement: "X joined." In newly multi-user channels,
     append a mention-required reminder.
  7. Bot generates a history recap via Bedrock Haiku and sends it TARGETED to
     just the new member (only that user sees the catch-up summary)
  8. SES SendEmail with a deep link ?conversation=<id> back to the channel
          │
          ▼
  Response: { success, recipientName, isNowMultiUser, emailSent, emailError? }
          │
          ▼
  Frontend surfaces emailSent=false as a yellow warning in the share modal
  (the user is still added to the channel — only the email delivery failed)
          │
          ▼
  Recipient opens ?conversation=<id> link → App.tsx reads the query param,
  calls selectConversation() once conversations load, strips the param.
```

**Why this matters:** the share flow returns an explicit `emailSent` flag
rather than reporting success when SES rejects the sender email, so the
frontend warns the user instead of silently swallowing the failure. The mention
hint + targeted summary land in multi-user channels so a dropped-in user
(a) sees that the dynamic changed and (b) has context to jump in.

**Tier enforcement (defense in depth):** Channel metadata alone is not a
security boundary - it's self-asserted by whoever created the channel. The
authoritative signal is the user's Cognito group membership. The share
Lambda, `create-conversation`, and `router-agent-handler` all independently
check it. See `docs/specs/identity-access/SPEC-CONVERSATION-SECURITY.md`.

**Key files:**
- `frontend/src/components/ShareConversationModal.tsx` - Share UI + emailSent warning
- `frontend/src/App.tsx` - `?conversation=X` deep-link handler
- `backend/lambda/share-conversation/index.js` - tier gate + announce + summary + SES
- `backend/lib/stacks/notification-stack.ts` - SES identity + IAM + API Gateway
- `backend/lambda/src/router-agent-handler.ts` - `min(userTier, channelTier)` enforcement
- `backend/lambda/src/channel-flow-processor.ts` - multi-member mention routing
- `backend/lambda/cognito-triggers/post-confirmation.js` - `custom:tier` → group sync
- `backend/scripts/backfill-tier-groups.mjs` - one-shot migration for existing users
- `backend/scripts/backfill-channel-flow.mjs` - one-shot migration for existing channels

---

## Analytics Data Flow

> Both the Athena and Aurora analytics pipelines are wired into the admin console. The base console includes model effectiveness, user feedback, and live conversation operations; Aurora adds the deeper evaluation, drift, and task-analysis views when that stack is deployed.

### Why two data sources (raw archive + curated views)

Every Amazon Chime SDK event lands on one Kinesis stream, and from there it fans out to two
sinks that do different jobs. This split is deliberate, not redundancy:

1. **Raw archive (S3): the absolute system of record.** An append-only copy of every event
   exactly as Chime emitted it (channel create/update/delete, membership, message
   create/update/redact/delete). It is never rewritten. Its jobs are durability, replay and
   backfill, and debugging: it is the one place that stays true when a derived view is wrong.
   When a curated view has a bug (drops, mis-parses, or curates away an event), the raw archive
   is what you read to see what actually happened and to rebuild the view from.

2. **Curated query store (Glue/Athena or Aurora): fast, sometimes mutable views.** A derived
   store shaped for querying, not for durability. It groups messages into conversations and
   exchanges, folds placeholder-then-final edits onto one row, derives conversation state
   (live / archived / deleted), applies redaction-aware reads, and (in Aurora) serves
   sub-second dashboards, evaluation scoring, drift, and pgvector context. Because the raw
   archive holds the truth, this layer is free to curate, re-derive, and be rebuilt.

The two roles cannot collapse into one store: an immutable raw log cannot serve sub-second
mutable dashboards, and a curated store that rewrites or drops rows cannot be the system of
record. The raw S3 archive is the constant across both modes; the analytics mode selects only
the curated engine (Glue/Athena by default, Aurora when richer real-time analysis is needed).

### Athena Mode (Default)

```
  Amazon Chime SDK message events
          │
          ▼
  Kinesis Data Stream (1 shard)
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
                                           RDS Proxy (IAM auth)
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

The diagram above is the **archival/analytics** path (asynchronous, off the request path). The **live
request path** reaches Aurora separately: the non-VPC agent handler invokes a VPC-attached **retrieval
data-plane Lambda** that runs RAG retrieval and drift detection (embed + pgvector) and returns results. The
handler stays out of the VPC so it can still reach SSM, Cognito, and Lambda-invoke; the data-plane Lambda
reuses the existing Bedrock and Secrets endpoints, adding no new VPC endpoints (project decision 018). See
[RAG.md](../guides/developer/RAG.md) and, for per-piece costs, [INFRASTRUCTURE-COST.md](../guides/admin/INFRASTRUCTURE-COST.md).

**Key files:**
- `backend/lib/stacks/analytics-stack.ts` - Athena mode (Kinesis → Firehose → S3 → Glue → Athena)
- `backend/lib/stacks/analytics-stack-aurora.ts` - Aurora mode (VPC + Aurora; RDS Proxy opt-in via `enableRdsProxy`, default off)
- `backend/lambda/src/analytics-aurora/kinesis-archival.ts` - Kinesis → Aurora consumer
- `backend/lambda/src/analytics-aurora/analytics-query.ts` - Dashboard query API
- `backend/lambda/src/analytics-aurora/drift-detection.ts` - Topic drift detection
- `backend/lambda/src/analytics-aurora/cross-conversation-context.ts` - pgvector search
- `frontend/src/components/admin/AdminDashboard.tsx` - Dashboard shell (tab routing)
- `frontend/src/services/analyticsService.ts` - Analytics API client

**Aurora-mode add-ons (opt-in, same stack):**
- **Out-of-band message analytics (A/B + metadata-cap decoupling).** Heavy per-message analytics - per-step execution telemetry and the full analytics blob - are written to a `MessageAnalytics` DynamoDB table keyed by message id (keeping the Amazon Chime SDK `Metadata` under its ~1 KB cap), and the archival Lambda merges them back on ingest; surfaced via `/analytics/execution-steps` (admin **Steps** tab). Per-variant experiment results also fold in **real human signals** - thumbs (from the feedback table) and `/battle` wins (from the BattleOutcome table) - via read-time scans over the VPC DynamoDB gateway endpoint. See `docs/specs/conversation-messaging/SPEC-MESSAGE-METADATA-CODEBOOK.md`.
- **Cost sleep mode (`-c sleepMode=true`).** The same stack conditionally adds a `deployment-state` table, an EventBridge idle checker, an admin sleep/wake API (`/deployment/{state,sleep,wake}`), and an SNS topic. The checker pauses Aurora Serverless v2 (`ModifyDBCluster` → MinCapacity 0) after `sleepAfterIdle` of inactivity; an admin wake restores it, and users see a paused-state banner meanwhile. See `docs/specs/analytics-eval/SPEC-COST-SLEEP-MODE.md`.

**Cost attribution (tagging).** Every stack self-tags at the app root via `applyStandardTags` (`backend/lib/tagging.ts`): `Project` is **derived from the deployment identity** (`STACK_PREFIX`), never hardcoded, so several instances in one AWS account bill apart in Cost Explorer. See `docs/guides/admin/TAGGING.md`.

---

## Frontend Provider Hierarchy

Providers must be initialized in order. Each depends on the one above it.

```
  <AuthProvider>                    ← Cognito tokens (IdToken, AccessToken, RefreshToken)
    │
    └─ <AwsClientProvider>          ← IAM credentials from Identity Pool; creates Amazon Chime SDK client
         │
         └─ <MessagingProvider>     ← WebSocket session; channel message callbacks
              │
              └─ <ConversationProvider>  ← Conversation list, active conversation, message state
                   │
                   └─ <App />       ← UI components can use all 4 contexts
```

**Why this order matters:**
- `AwsClientProvider` needs the IdToken from `AuthProvider` to call Cognito Identity Pool
- `MessagingProvider` needs the Amazon Chime SDK client from `AwsClientProvider` to open a WebSocket
- `ConversationProvider` needs the WebSocket from `MessagingProvider` to receive messages

If a provider fails to initialize, everything below it is unavailable. The `ConnectionStatus` component shows the current state.

---

## Where to Look

| "I want to..." | Start here |
|-----------------|-----------|
| Change the AI system prompt | `backend/lambda/src/assistant-async-processor.ts` (the profile's `DEFAULT_PROMPTS` entry, or the SSM persona param) |
| Add a new intent | `backend/lambda/src/lib/intent-classifier.ts` → `delivery-options.ts`; for its model route, `backend/lib/config/model-strategy.ts` (`INTENT_ROUTE_STRATEGY`) |
| Add a new user tier | [Customization Guide in README](../../README.md#adding-a-new-user-tier) |
| Change the auth flow | `frontend/src/providers/AuthProvider.tsx` + `backend/lib/stacks/cognito-auth-stack.ts` |
| Add an admin dashboard tab | `frontend/src/components/admin/` + `AdminDashboard.tsx` |
| Modify the analytics pipeline | `backend/lib/stacks/analytics-stack.ts` (Athena) or `analytics-stack-aurora.ts` (Aurora) |
| Change file upload limits | `frontend/src/services/attachmentService.ts` |
| Debug message delivery | `backend/lambda/src/lib/async-processor-core.ts` → CloudWatch Logs |
| Debug auth token issues | `frontend/src/providers/AuthProvider.tsx` → browser console |
| Understand the database schema | `backend/lambda/src/analytics-aurora/schema/001-initial.sql` |
| Run E2E tests | `tests/e2e/` → `npm test` (requires deployed backend) |
| Run backend unit tests | `backend/test/` → `npm test` |
| Review security posture | Security Model section below + `docs/guides/developer/SECURITY-NPM-SUPPLY-CHAIN.md` |
| Apply design tokens | `frontend/src/styles/design-tokens.css` → [DESIGN-SYSTEM.md](../guides/developer/DESIGN-SYSTEM.md) |

---

## User Tiers & Access Control

Access to AI models is enforced at the IAM level. Deployments can choose Anthropic, Amazon, or OpenAI-on-Bedrock options per tier, but a Basic user still cannot invoke premium-only models directly.

| Tier | Models Available | Handler Timeout | Task Tracking | File Access |
|------|-----------------|----------------|---------------|-------------|
| Basic | Configurable basic model (default: Claude Haiku) | 30s | DynamoDB tasks | `context/basic/*` prefix |
| Standard | Configurable standard model plus standard-safe fallbacks (default: Sonnet) | 60s | DynamoDB tasks | `context/standard/*` prefix |
| Premium | Configurable premium model with full catalog access (default: Opus) | 90s | DynamoDB tasks | `context/premium/*` prefix |

Deployment model overrides are selected in CDK with `basicModelKey`, `standardModelKey`, and `premiumModelKey`.

**How tier is determined:** User tier is stored as a Cognito custom attribute (`custom:tier`), set during admin approval. The fulfillment handler (`router-agent-handler.ts`) reads the tier and resolves the effective tier as `min(userTier, channelTier)`, then dispatches to that profile's async processor (the shared `assistant-async-processor.ts`, deployed once per profile). Lex is only the entry trigger; it performs no routing or tier logic.

**How tier is enforced:** Each profile's processor Lambda has its own IAM role with Bedrock `InvokeModel` permissions scoped to that profile's model ARNs (`modelArnsForTier`). The Cognito Identity Pool authenticated roles (one per classification, generated from config in `cognito-auth-stack.ts`) give frontend SDK clients their classification-appropriate permissions; the former standalone IAMPolicies stack has been removed.

---

## Admin Dashboard

The admin console groups its views into **7 sections** (section rail + sub-tabs):
Overview (Overview + Latency), Conversations, Effectiveness (the intent-anchored
Dashboard drill - the consolidation target that Evaluations/Flows/Tasks/Steps fold into -
plus those detail sub-tabs and the Flagged and Ground Truth action tabs), Models (Models +
Model Strategy), Experiments,
Users (Users + Manage Users), and Security (Membership Audit). Aurora-only views
are hidden in Athena mode. (Usage: [ADMIN-GUIDE.md](../guides/admin/ADMIN-GUIDE.md); design:
[SPEC-ADMIN-CONSOLE.md](../specs/admin-console/SPEC-ADMIN-CONSOLE.md).) The individual views:

| Tab | Mode | Data Source | Shows |
|-----|------|------------|-------|
| Overview | Both | `conversation_volumes`, `intent_distribution` | Daily message/conversation counts, intent type breakdown |
| Models | Both | `model_usage`, `model_effectiveness`, `/feedback` | Per-model usage, intent-by-model effectiveness, latency, compliance, and user feedback summaries |
| Model Strategy | Both | Static frontend config mirrored from backend strategy metadata | Provider posture, deploy-time model choices, intent routing, fallback model guidance, tier availability |
| Experiments | Both | `experiment_results`, DynamoDB `ExperimentsTable` | A/B test management: create/pause/complete experiments, side-by-side variant comparison (score, latency, tokens, compliance, fallback rate) |
| Conversations | Both | `/admin/conversations{,/messages,/members,/membership-history,/add-member,/remove-member,/redact-message,/delete-message}`, `drift_events` | **Archive-backed** conversation browser (Athena over the `conversations` Glue table - not live Amazon Chime SDK), messages with per-message inspect (all fields + metadata + raw), member list + add/remove, membership-history timeline, and redact/delete moderation - acting as the **app-instance-admin** (delete is admin-only). Optional drift view in Aurora mode. |
| Evaluations | Both | `evaluation_scores` | Scores by date, agent type, intent - color-coded by quality |
| Latency | Both | `latency_metrics` | Avg/P95 total, Bedrock inference, and polling time |
| Users | Both | `active_users_daily`, `messages_per_user`, `signup`/`signin_funnel_conversion` (client-events); `user_activity` legacy fallback | Session DAU vs messaging DAU + tier breakdown, sign-up/sign-in conversion funnels, top-50 sender leaderboard |
| Manage Users | Both | Cognito admin actions | Approve, reject, tier, and enable users from the console |
| Flows | Aurora | `evaluation_flows` | Multi-turn evaluation: 5 weighted dimensions, drill into flow detail |
| Flagged | Aurora | `flagged_responses` | Response review queue: approve/reject with notes |
| Ground Truth | Aurora | `ground_truth` | Human scores vs automated scores, calibration metrics |
| Tasks | Aurora | `task_metrics`, `task_details` | Completion rate, duration, per-type breakdown; `task_details` also carries each task's current `task_state` (declared-graph machine state) + `transition_count` |
| Effectiveness | Aurora | `intent_effectiveness`, `intent_exchanges`, `task_timeline` | Intent-anchored worst-first dashboard (classification/execution/latency/cost/tool-error per intent), drilling intent -> exchanges/tasks -> per-task turn timeline -> steps |

---

## Error States & Edge Cases

| Scenario | Behavior |
|----------|----------|
| **Bedrock unavailable** | Async processor catches `ServiceException` → logs error; placeholder message stays as "One moment..." with no automatic recovery |
| **WebSocket disconnect** | Amazon Chime SDK `MessagingSession` auto-reconnects with exponential backoff; `ConnectionStatus` component shows state |
| **Token expires mid-conversation** | 50-minute refresh interval prevents this in most cases; if refresh fails, user is redirected to login; in-flight messages may be lost |
| **S3 upload fails** | `attachmentService.ts` catches error → `FileUploadPreview` shows error state; user can retry |
| **Presigned URL expires before upload** | URL defaults to 1-hour expiry; if expired, `attachmentService` returns error and user must re-attach |
| **SES email fails (sharing)** | Lambda catches error → returns 500; `ShareConversationModal` shows error message |
| **Lex returns `FallbackIntent`** | The fulfillment handler classifies the request itself and applies its default routing (Lex is only the trigger) |
| **Concurrent messages in same channel** | Amazon Chime SDK handles ordering; each message gets a unique `MessageId`; no deduplication - duplicate sends produce duplicate messages |
| **Aurora connection failure** | `db-client.ts` pool reconnects on auth errors; other errors thrown to caller |
| **Lambda timeout (30-90s by tier)** | Async processor is killed; placeholder message stays; no automatic cleanup of DynamoDB task state |

---

## Security Model

This section summarizes security controls.

**Authentication:**
- Cognito User Pool with email verification and configurable admin approval
- Tokens stored in browser memory (React state) - not localStorage, not cookies
- 50-minute refresh interval, plus a credential refresh before the WebSocket re-opens on a stale reconnect (page hidden >5 min or no messages >5 min)
- Identity Pool maps authenticated users to temporary IAM credentials

**Authorization:**
- Tier-based IAM policies scope Bedrock model access per user role
- Each Lambda handler has its own IAM role with least-privilege permissions
- Lambda invoke permissions scoped to each handler's own async processor (no cross-tier invocation)
- S3 file access scoped by tier prefix (`context/basic/*`, `context/standard/*`, `context/premium/*`)

**Input handling:**
- React escapes all rendered content (no `dangerouslySetInnerHTML`)
- Message metadata markers (`<!--ACTIVE_TASK:-->`) stripped by `messageParser.ts` before display
- File uploads validated client-side (10MB limit, MIME type whitelist) - no server-side malware scanning
- SQL queries in Aurora mode use parameterized queries; table/column names validated against identifier regex

**CORS:**
- API Gateway REST APIs use the `appUrl` CDK context variable for allowed origins
- Aurora analytics API uses the same `appUrl` context variable
- S3 attachment bucket CORS still uses wildcard origins

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
| Analytics (Aurora) | Aurora PostgreSQL | 90 days for evaluation_results (`expires_at`); messages table has no auto-expiry | Yes - `sender_name`, `sender_arn`, `user_sub` |
| Task tracking | DynamoDB | TTL-based expiry (set per task) | Yes - `userSub` |
| Cross-conversation context | Aurora PostgreSQL | No auto-expiry | Yes - `user_sub`, conversation summaries |

**Third-party data processing:**
- **Amazon Bedrock:** User messages are sent to Bedrock for model inference. Bedrock runs within your AWS account and region. Per [AWS documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html), Bedrock does not use customer inputs to train models and does not share data with model providers (Anthropic, Amazon). Data stays within your AWS account boundary.
- **Amazon Chime SDK:** Messages are stored in the Amazon Chime SDK AppInstance within your AWS account. Amazon Chime SDK is an AWS-managed service subject to the [AWS Data Processing Addendum](https://d1.awsstatic.com/legal/aws-dpa/aws-dpa.pdf).
- **Amazon SES:** Recipient email addresses are sent to SES for conversation sharing. SES is subject to the AWS DPA.

**PII in analytics:**
The analytics pipeline stores user identifiers in queryable tables. Admin users can query conversation history, evaluation scores, and cross-conversation context by `user_sub`. Organizations with GDPR/CCPA requirements should implement data subject access/deletion procedures against these tables.

---

## Testing

| Test type | Location | What it covers | Gaps |
|-----------|----------|---------------|------|
| **E2E (Playwright)** | `tests/e2e/` | Signup, signin, agent intents (per tier), admin dashboard | Disabled in CI; requires deployed AWS environment |
| **Backend unit (Jest)** | `backend/test/` | CDK synth validation, Aurora modules (db-client, drift-detection, cross-conversation-context) | Tests mock all external dependencies; no integration tests against real databases |
| **Frontend unit** | (none) | Nothing | No component, hook, or provider unit tests exist. All frontend coverage comes from E2E only. |

```bash
# Run E2E tests (requires deployed backend + running frontend)
cd tests && npm test

# Run backend unit tests
cd backend && npm test
```

**Known testing gaps:**
- E2E tests are disabled in CI (`.github/workflows/ci.yml`) because they require a deployed AWS environment
- No frontend unit tests (React component tests, provider tests, service tests)
- Backend unit tests mock everything - no integration tests verify actual database queries, Bedrock calls, or Amazon Chime SDK interactions
- No load/performance testing
- Error paths and edge cases are largely untested

This is a significant gap for production use.

---

## Frontend Styling

All UI components use CSS custom properties (design tokens) defined in `frontend/src/styles/design-tokens.css`. Component-specific styles live in co-located `.css` files (e.g., `MessageInput.css` next to `MessageInput.tsx`).

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
| [SPEC-AURORA-VPC-MODE.md](../specs/analytics-eval/SPEC-AURORA-VPC-MODE.md) | Full Aurora mode spec (VPC, RDS Proxy, schema, costs, risks) |
| [CHIME_SDK_INTEGRATION.md](../guides/developer/CHIME_SDK_INTEGRATION.md) | Amazon Chime SDK integration details and Lex event format |
| [SECURITY-NPM-SUPPLY-CHAIN.md](../guides/developer/SECURITY-NPM-SUPPLY-CHAIN.md) | npm supply-chain hardening (install-script blocking, lockfile pinning, audit practices) |
| [DESIGN-SYSTEM.md](../guides/developer/DESIGN-SYSTEM.md) | CSS design tokens, component patterns, typography |
| [IDENTITY-PROVIDER-GUIDE.md](../guides/user/IDENTITY-PROVIDER-GUIDE.md) | How to integrate Auth0, Okta, Azure AD, LDAP, or any IdP |
