# SPEC: Welcome flow and assistant context

**Status:** Partial (the welcome wiring ships; later context phases are design)

> Pairs with the WelcomeIntent wiring and the bot-as-channel-member model.
> Adapts a reference pattern (cited inline) for AgentEchelon's self-hosted
> Converse tool-loop assistants.

## Why this exists

When a user opens a new conversation, the assistant should *always*
greet them with at least the context the system already has (their
name), plus anything specific about why this conversation exists
(a topic the user typed at create time, a drift-redirect prompt, an
explicit trigger from a sibling flow). Silent channels are a launch
bug - and a no-context greeting (`"Hello! I'm your AI assistant"`) is
barely better.

Reference Use Cases
* When a new conversation is created in AgentEchelon, the user creates a conversation with a title, a tier, and the user has a profile. The assistant should use this information to provide a personalized contextual greeting to the user to help them get started such as a few example prompts the user can provide for the given tier. 
* When a new conversation is created in AgentEchelon due to drift in a pervious conversation, when the assistant is added they should carry the context from the previous conversation to avoid having the user repeat themselves and allow the conversation to carry on smoothly

This spec defines:

1. **Where context lives** - who knows the user's name, where the topic
   is stored, how a drift-redirect carries its trigger across.
2. **Where context is read** - at WelcomeIntent fulfillment vs. on
   FallbackIntent turns vs. inside the per-tier async-processor.
3. **How conversation history is threaded** - what gets stored, where,
   for how many turns, and how the next turn sees it.
4. **What the welcome should say** - required vs. optional pieces,
   and a single composition function used by every welcome surface.

## Reference pattern

The shape of this spec mirrors a reference implementation's
`{role}-agent-handler.ts` + `lib/{role}-context.ts` separation. The
critical observations from that pattern, in order of how much weight
they should carry in AgentEchelon:

| Pattern                                                                                                                                                                                                                  | Where it's used there                                                                              | Why it matters for AgentEchelon                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Two-tier context model** - a fast static-shaped path (`handleDirectResponse` / `getXxxWelcomeMessage`) for greetings, and a full Bedrock path (`handlePlaceholderUpdate` + `buildXxxSystemPrompt`) for everything else | Sibling reference, agent-handler entry                                                             | The welcome path should be **instant, predictable, no Bedrock call**. Bedrock is reserved for turns that actually need reasoning.                                                                                                                                |
| **`DescribeAppInstanceUser` (Amazon Chime SDK) → user's `Name`**                                                                                                                                                                | `getUserName(senderArn)` helper                                                                    | The frontend sets the user's display name on the AppInstanceUser at first sign-in; the router reads it back when the Lex event carries `CHIME.sender.arn`. No Cognito hop required (AE uses Cognito `AdminGetUser`; equivalent path, slightly more permissions). |
| **`conversationHistory` in `event.sessionState.sessionAttributes`** - JSON-serialised, capped at the last 10 - 20 turns                                                                                                    | `extractConversationHistory(event)` / `updateConversationHistory(event, userMessage, botResponse)` | Lex carries it for free; no DynamoDB hit per turn. The next FallbackIntent turn reads it and the system prompt knows "this is message #N".                                                                                                                       |
| **`isFirstMessage = conversationLength === 0` as a top-level signal**                                                                                                                                                    | Threaded into `buildXxxSystemPrompt`                                                               | The full-context system prompt should branch on it - first-message gets a brevity-first instruction; later turns get a "this is message #N" anchor.                                                                                                              |
| **Role / persona-specific welcome variants**                                                                                                                                                                             | `getGuestWelcomeMessage` / `getAuthWelcomeMessage` / `getAdminWelcomeMessage`                      | AgentEchelon has tiers (basic/standard/premium). The welcome text can flex by tier; the *shape* (userName + triggerContext + topic + generic copy) stays the same.                                                                                               |
| **Profile context layered on welcome** - when a user has a profile record (DynamoDB), the welcome references it ("you're a recruiter from Acme; pick up where we left off")                                              | `getPersonalizedWelcome`                                                                           | AgentEchelon does not have profile records; the welcome composer takes an optional profile arg and ignores it when unset.                                                                                                                                        |
| **Static text, no Bedrock call on the welcome path**                                                                                                                                                                     | Same in every sibling agent                                                                        | Two reasons: latency (welcome lands instantly), and predictability (no model-output variance in the highest-visibility surface).                                                                                                                                 |

What the sibling pattern is **NOT** good for (and AgentEchelon should
NOT copy): a long handler-Lambda system prompt baked into TypeScript
strings. AgentEchelon's tier-scoped `context/{tier}/*.json` S3 docs
(the tool-loop retrieval) already provide a cleaner separation
between code and content. The system-prompt construction in AE should
stay deferred to the per-tier async-processor; only the *welcome* path
runs in the router.

## AgentEchelon state

| Slot                             | Behaviour                                                                                                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WelcomeIntent fulfillment        | `create-lex-bot.ts` sets `fulfillmentCodeHook: { enabled: true }`, `router-agent-handler.ts` detects `intentName === 'WelcomeIntent'` and runs the welcome composer.                                                                                                                |
| User name                        | Pulled from Cognito `AdminGetUser` via `resolveUserName(userSub)` in `router-agent-handler.ts`. Custom attribute `name` → `given_name` → email-local-part → `'there'`. Cached for the Lambda's warm life.                                                                           |
| Channel topic                    | Written to `Channel.Metadata.topic` when `create-conversation` is called with a `topic` body field; the router reads it. The frontend modal does not surface a topic input today. The topic is not frozen at creation: channel metadata is updatable at any time via Amazon Chime SDK `UpdateChannel`, so the topic can be refreshed as the conversation evolves (for example derived from the running conversation summary, or rewritten on a drift-redirect). That refresh path is supported by the primitive but not yet wired. |
| Drift / creation trigger context | `Channel.Metadata.triggerContext` (string, ≤240 chars). Set by callers that create a channel as a redirect from another flow (drift-confirm, cross-channel handoff). The router reads it; the drift-confirm flow is its producer.                                                   |
| Conversation history             | The async-processor reads recent channel messages from Amazon Chime SDK when it needs them; history is not held in Lex `sessionAttributes`. WelcomeIntent's reply is persisted (the bot's first message lands in the channel), so the next turn's processor sees it via `ListChannelMessages`. |
| Welcome composition              | `composeWelcome({ userName, triggerContext, topic })` in `router-agent-handler.ts`. Single function, three optional inputs, generic fallback when none are set.                                                                                                                     |
| Tier-flavoured welcome           | A single welcome shape across basic/standard/premium; the composer flexes by tier when a deployment wants it.                                                                                                                                                                       |

## Architecture: where context is gathered

```
User types something → Amazon Chime SDK AUTO routes to Lex (multi-user requires
                       CHIME.mentions attribute carrying the bot ARN;
                       1:1 routes regardless)
                                  │
                                  ▼
                    ┌───────────────────────────────────┐
                    │  Lex bot: TRANSPORT + SESSION only. │
                    │  Amazon Chime SDK routes to Lex, Lex invokes   │
                    │  the router as its fulfillment hook.│
                    │  Lex NLU is bypassed on real turns; │
                    │  the router classifies (Haiku).     │
                    └─────────────┬─────────────────────┘
                                  │
              ┌───────────────────┴───────────────────┐
              ▼                                       ▼
       WelcomeIntent                           FallbackIntent
   (Amazon Chime SDK SYSTEM event, fired         (the catch-all carrying EVERY
    when the assistant is ADDED        real user turn; Lex runs no
    to the channel; the ONLY           NLU on it)
    meaningful Lex intent)                      │
              │                                 │
              ▼                                 ▼
        ┌──────────────────────────────────────────────┐
        │   router-agent-handler (one fulfillment)     │
        │                                              │
        │   • resolveUserName(userSub)                 │
        │   • resolveChannelMetadata(channelArn)       │
        │       → { modelTier, topic, triggerContext } │
        │   • resolveUserTier(userSub)                 │
        │   • tier = min(userTier, channelTier)        │
        └────────────────────┬─────────────────────────┘
                             │
       ┌─────────────────────┴────────────────────┐
       ▼                                          ▼
   WelcomeIntent path                       FallbackIntent path
       │                                          │
       ▼                                          ▼
   composeWelcome({ userName,             classifyIntent → tier processor
     triggerContext, topic })             (async; placeholder + update;
                                          targetedSender metadata stamp)
       │                                          │
       ▼                                          ▼
   Static-shaped reply                     Bedrock Converse tool loop:
   via Lex.                                  • system prompt with tier
                                               base + isFirstMessage hint
                                             • load_company_context tool
                                               for tier-scoped S3 docs
                                             • out-of-band guardrail
                                               on output
```

**Transport versus classification.** Every real user turn still transits the Lex
bot: Amazon Chime SDK routes the message to Lex, and Lex invokes the router as its
fulfillment code hook (`Chime` to `Lex` to router). What the router does NOT do is
trust Lex's NLU. Lex matches at most two intents (`WelcomeIntent`,
`FallbackIntent`), and only `WelcomeIntent` carries meaning, and only in its
Amazon Chime SDK-triggered form: a SYSTEM event fired when the assistant is added to a
channel, which the router detects by the absence of an `inputTranscript`. Every
other turn arrives as `FallbackIntent`, whose label the router ignores entirely;
it classifies the request category itself with a separate Haiku classifier
(`classifyIntent` for standard and premium, a keyword-only `classifyIntentBasic`
for basic with no model call). So a message reaching Lex is transport, not
classification: Lex is the managed Amazon Chime SDK-to-Lambda bridge and per-turn session,
and the router is the brain. This is consistent with
[`MESSAGE-FLOW.md`](../../guides/developer/MESSAGE-FLOW.md) §4 ("why Lex isn't the brain"), which is the
fuller treatment of the same hop.

## Welcome composition contract

`composeWelcome` is the single source of welcome copy. Every surface
that wants to greet the user - WelcomeIntent fulfillment, a
drift-redirect channel creation, an "X joined the conversation" recap
- should call it.

```ts
composeWelcome({
  userName: string,           // required; 'there' if unknown
  triggerContext?: string,    // optional; drift-redirect prompt
                              // or other creation-trigger text
  topic?: string,             // optional; topic set on Channel.Metadata
});
```

Priority order:

1. `triggerContext` set → "continuing from your earlier message: '…'"
2. `topic` set → "I can help with `<topic>`. Where would you like to start?"
3. neither → generic "I can answer questions, draft documents, …"

`userName` always appears as a `Hi <Name>` lead-in when known.
Otherwise the lead is `Hi`. Per the sibling pattern, when the user's
display name resolves to the sentinel `'there'`, drop the
interpolation entirely.

## Channel metadata schema (welcome-relevant fields)

The router reads these from `Channel.Metadata`. `create-conversation`
writes them.

| Key | Type | Set by | Read by |
|---|---|---|---|
| `modelTier` | `'basic' \| 'standard' \| 'premium'` | create-conversation | router (tier resolution); admin tools |
| `createdBy` | string (user ARN) | create-conversation | share-conversation, admin views |
| `topic` | string (≤500 chars) | create-conversation when `topic` in body | router (WelcomeIntent + future system-prompt grounding) |
| `triggerContext` | string (≤240 chars) | drift-confirm flow / redirect callers | router (WelcomeIntent grounding) |

`topic` and `triggerContext` are intentionally separate slots: a topic
is *what the user is here for* (durable across the conversation); a
trigger context is *what brought them to this specific channel right
now* (one-shot, references the drift-causing message). The welcome
flows them in different copy.

## Invariants

These invariants govern the **default static welcome**. The onboarding welcome pattern (a separate, opt-in
intake flow described under "The two-tier welcome" below) intentionally relaxes "instant" and "shaped" for
assistants that must gather structured inputs before they can help.

- **Welcome always lands.** Even when `userName`, `topic`, and
  `triggerContext` are all unknown, `composeWelcome` returns the
  generic copy. The bot never opens a channel with silence.
- **Welcome is instant.** No Bedrock call on the welcome path. Cognito
  lookups are cached for the Lambda's warm life. Channel metadata is
  cached per-channel.
- **Welcome is consistent.** `composeWelcome` is the single source of
  copy - `create-conversation`, the router, and any redirect
  caller all funnel through it.
- **Welcome is shaped, not free-form.** Static copy with interpolation
  slots, not a Bedrock-generated turn. Predictable for tests, no
  model variance, no guardrail surprises.

## The complete assistant-context model

Welcome is one entry in a larger set of context sources assembled per turn. This section inventories all of
them so a reader building an assistant sees the whole picture (the how-to is
[`GUIDE-ASSISTANT-CONTEXT.md`](../../guides/developer/GUIDE-ASSISTANT-CONTEXT.md); the message path is
[`MESSAGE-FLOW.md`](../../guides/developer/MESSAGE-FLOW.md)).

**Active per turn (assembled today):**

| Source | Where it comes from | How it reaches the model |
|---|---|---|
| Conversation history | Recent channel messages, read fresh each turn | The model input (recent window) |
| Company context | Tier documents under `context/{tier}/` | Retrieved and folded into the prompt (see target below) |
| Project RAG | pgvector over the reference corpus (`rag/`) | Top-K relevant chunks in a retrieved-context section |
| Participant / domain context | Channel metadata | Prompt sections, present only when the channel carries them |
| Persona and standing policy | Assistant config (persona) | The stable prompt prefix |
| Welcome / personalization | Channel metadata (name, topic, trigger) | The welcome reply (see contract above) |

**Also available:**

- **Cross-conversation context.** Related-conversation retrieval exists as a capability but is not wired
  into the per-turn prompt.

### Company context as digest plus retrieval (built)

Company context loads through two tier-scoped paths. The company-context tool and the always-present per-tier
**digest** (`context/{tier}/_digest.json`, document titles and one-line descriptions) are scoped by the
physical **IAM** prefix boundary (a lower tier's role cannot read a higher tier's prefix). Company documents
are ALSO embedded into the pgvector store (same path as project RAG, under `rag/company/{tier}/`) and retrieved
by relevance per turn, scoped by the fail-closed **SQL** tier filter. The digest tells the assistant what
company context exists; retrieval and the tool supply the detail; the whole-corpus re-read and the size cap are
gone. With company RAG active, a document's tier is enforced by both IAM (tool + digest) and the SQL filter
(retrieval). This spec documents a reference implementation: a production deployment keeps genuinely sensitive
records (financials, PII, regulated data) in their **source of truth** and reads them live through a connector,
rather than embedding a copy (the demo embeds *fictional* financials for illustration). See [`RAG.md`](../../guides/developer/RAG.md)
and [`GUIDE-ASSISTANT-CONTEXT.md`](../../guides/developer/GUIDE-ASSISTANT-CONTEXT.md).

### Conversation summary as consumable context (built)

The summary that already exists for drift is also assistant context, consumed conditionally: the router fetches
it from the data-plane Lambda and folds it into the prompt (`## EARLIER IN THIS CONVERSATION`) when the
conversation has grown beyond the recent-history window (a summary row exists), and omits it on short
conversations. The fetch runs in parallel with retrieval, so it adds no wall-clock. It is no longer a
drift-only artifact.

### The two-tier welcome (static and onboarding)

The welcome is a passthrough that can be as light as an instant greeting or as rich as a context-gathering
intake. The **static greeting** below is the default: instant, no model call, personalized from channel
metadata. An assistant that must collect structured inputs before it can help uses the **onboarding welcome
pattern** (a short, multi-step intake that gathers the minimum required inputs, confirms them, and hands off
to the working assistant with that context in place). The onboarding pattern is a separate, **opt-in flow
(built)**; the invariants above govern the default static greeting.

The onboarding intake is deterministic: like the static welcome it makes no Bedrock call on any intake turn,
so it stays instant and predictable. Progress rides in Lex `sessionAttributes` across turns (`AE_ONBOARDING`),
so there is no per-turn store; because the questions and answers are ordinary channel messages, the working
assistant sees the collected inputs in its recent-history window once intake confirms, with nothing extra to
thread. It is enabled per deployment by supplying an intake schema (`ONBOARDING_INTAKE` env or
`ONBOARDING_INTAKE_PARAM` SSM); absent a schema it is inert and the router behaves exactly as the static path.
The engine is `backend/lambda/src/lib/onboarding-intake.ts` (a pure FSM), wired into the router welcome and
first-turn paths. The schema shape and field semantics are documented in
[`GUIDE-ASSISTANT-CONTEXT.md`](../../guides/developer/GUIDE-ASSISTANT-CONTEXT.md) ("Welcome patterns").

One limitation of the opt-in flow: intake progress lives in the Lex session, so if the session expires
mid-intake the flow restarts from the first field. The intake is short (a few fields) and the session TTL far
exceeds it, so this is a non-issue in practice; the collected inputs also remain in channel history
regardless.

## Related docs

- `docs/guides/developer/GUIDE-ASSISTANT-CONTEXT.md` - the developer/admin how-to for building and operating assistant context.
- `docs/specs/assistant-context/SPEC-PER-PROFILE-OWNERSHIP.md` - the per-tier ownership model that hosts
  the tier-specific async-processors the FallbackIntent path
  dispatches to.
- `docs/specs/analytics-eval/SPEC-DRIFT-CONVERGENCE.md` - the drift feature whose confirm
  flow is the `triggerContext` producer.
- `docs/guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md` - the practical guide a
  tier-team uses; per-tier welcome copy files fit here.
