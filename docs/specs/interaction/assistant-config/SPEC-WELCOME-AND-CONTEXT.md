# SPEC: Welcome flow and assistant context

**Status:** Partial (the welcome wiring ships; later context phases are design).

**Coverage:** `tests/e2e/welcome.spec.ts` asserts the deployed welcome path per classification (the orientation parameter is in the handler env, resolves, parses with the shipped parser, and IAM allows the role to read it), that the welcome delivered on the Amazon Chime SDK websocket is byte-for-byte what this deployment's own SSM config composes to, and that a run of consecutive new conversations never drops one, separating "never delivered" from "delivered and not rendered". `tests/e2e/context-sources.spec.ts` covers the wider context assembly.

**Verified by:** `backend/test/lib/welcome-orientation.test.ts` (parser tolerance, the generic fallback copy, the name-less lead-in, the trigger/topic short-circuits, and the oriented rendering), `backend/test/lib/first-turn-greeting.test.ts` (the by-name greeting on the first real turn, which is where personalization moved to).

**Problem and who it's for:** When a user opens a new conversation, a silent channel or a generic "Hello, I'm your AI assistant" is a poor first impression, and a conversation that makes the user repeat themselves is worse - a business wants a warm, context-aware first turn (the user greeted by name, with relevant context and example prompts) without wiring its own welcome-and-context-injection machinery. This is for the end user and the platform developer wiring the welcome path; the alternative is hand-building where context lives and when it is injected for every surface, or settling for a stock generic greeting. It defines where context lives, where it is read (WelcomeIntent vs fallback turns vs the async processor), how history threads, and one composition function every welcome surface uses.

**Site section:** Interaction layer, Assistant Configuration pillar (definition + per-assistant context/welcome config; the welcome-flow and context-injection mechanism is core-platform runtime).

> Pairs with the WelcomeIntent wiring and the bot-as-channel-member model. Adapts a reference pattern (cited inline) for AgentEchelon's self-hosted Converse tool-loop assistants.

## Why this exists

When a user opens a new conversation, the assistant should *always* greet them with at least the context the system already has (their name), plus anything specific about why this conversation exists (a topic the user typed at create time, a drift-redirect prompt, an explicit trigger from a sibling flow). Silent channels are a launch bug - and a no-context greeting (`"Hello! I'm your AI assistant"`) is barely better.

Reference Use Cases
* A user creates a conversation with a title and a tier, and has a profile. The assistant uses that information to open with a personalized, contextual greeting - including a few example prompts appropriate for the tier - that helps the user get started.
* A conversation created from drift in a previous conversation carries that context forward when the assistant is added, so the user does not repeat themselves and the conversation continues smoothly.

This spec defines:

1. **Where context lives** - who knows the user's name, where the topic is stored, how a drift-redirect carries its trigger across.
2. **Where context is read** - at WelcomeIntent fulfillment vs. on FallbackIntent turns vs. inside the per-tier async-processor.
3. **How conversation history is threaded** - what gets stored, where, for how many turns, and how the next turn sees it.
4. **What the welcome should say** - required vs. optional pieces, and a single composition function used by every welcome surface.

## Reference pattern

The shape of this spec mirrors a reference implementation's `{role}-agent-handler.ts` + `lib/{role}-context.ts` separation. The critical observations from that pattern, in order of how much weight they should carry in AgentEchelon:

| Pattern                                                                                                                                                                                                                  | Where it's used there                                                                              | Why it matters for AgentEchelon                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Two-tier context model** - a fast static-shaped path (`handleDirectResponse` / `getXxxWelcomeMessage`) for greetings, and a full Bedrock path (`handlePlaceholderUpdate` + `buildXxxSystemPrompt`) for everything else | Sibling reference, agent-handler entry                                                             | The welcome path should be **instant, predictable, no Bedrock call**. Bedrock is reserved for turns that actually need reasoning.                                                                                                                                |
| **`DescribeAppInstanceUser` (Amazon Chime SDK) → user's `Name`**                                                                                                                                                                | `getUserName(senderArn)` helper                                                                    | The frontend sets the user's display name on the AppInstanceUser at first sign-in; the router reads it back when the Lex event carries `CHIME.sender.arn`. No Cognito hop required (AE uses Cognito `AdminGetUser`; equivalent path, slightly more permissions). |
| **`conversationHistory` in `event.sessionState.sessionAttributes`** - JSON-serialized, capped at the last 10 - 20 turns                                                                                                    | `extractConversationHistory(event)` / `updateConversationHistory(event, userMessage, botResponse)` | Lex carries it for free; no DynamoDB hit per turn. The next FallbackIntent turn reads it and the system prompt knows "this is message #N".                                                                                                                       |
| **`isFirstMessage = conversationLength === 0` as a top-level signal**                                                                                                                                                    | Threaded into `buildXxxSystemPrompt`                                                               | The full-context system prompt should branch on it - first-message gets a brevity-first instruction; later turns get a "this is message #N" anchor.                                                                                                              |
| **Role / persona-specific welcome variants**                                                                                                                                                                             | `getGuestWelcomeMessage` / `getAuthWelcomeMessage` / `getAdminWelcomeMessage`                      | AgentEchelon has tiers (basic/standard/premium). The welcome text can flex by tier; the *shape* (userName + triggerContext + topic + generic copy) stays the same.                                                                                               |
| **Profile context layered on welcome** - when a user has a profile record (DynamoDB), the welcome references it ("you're a recruiter from Stratum Technologies; pick up where we left off")                                              | `getPersonalizedWelcome`                                                                           | AgentEchelon has a per-user profile record (`UserProfileTable`, a reference stand-in an implementer can swap for their own store; see [`SPEC-USER-PROFILE-AND-ONBOARDING.md`](SPEC-USER-PROFILE-AND-ONBOARDING.md)). Today the welcome uses it to gate onboarding **once per user** rather than to layer copy; the composer's personalization arg stays optional. The persisted facts are available for richer personalization later.                                                                                                                                        |
| **Static text, no Bedrock call on the welcome path**                                                                                                                                                                     | Same in every sibling agent                                                                        | Two reasons: latency (welcome lands instantly), and predictability (no model-output variance in the highest-visibility surface).                                                                                                                                 |

What the sibling pattern is **NOT** good for (and AgentEchelon should NOT copy): a long handler-Lambda system prompt baked into TypeScript strings. AgentEchelon's tier-scoped `context/{classification}/*.json` S3 docs (the tool-loop retrieval) already provide a cleaner separation between code and content. The system-prompt construction in AE should stay deferred to the per-tier async-processor; only the *welcome* path runs in the router.

## AgentEchelon state

| Slot                             | Behavior                                                                                                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WelcomeIntent fulfillment        | `create-lex-bot.ts` sets `fulfillmentCodeHook: { enabled: true }`, `router-agent-handler.ts` detects `intentName === 'WelcomeIntent'` and runs the welcome composer. When an onboarding intake schema is configured for the classification, this path first consults the user profile: an already-onboarded creator gets the normal welcome, a new user gets the intake (see the onboarding row below).                                                                                                                |
| User name                        | Pulled from Cognito `AdminGetUser` via `resolveUserName(userSub)` in `router-agent-handler.ts`. Custom attribute `name` → `given_name` → email-local-part → `'there'`. Cached for the Lambda's warm life. Read on the FIRST real turn (the async processor's first-turn greeting) and by the onboarding intake, NOT on the welcome path: the WelcomeIntent fires on the assistant's own channel membership, before the creator's membership and the channel Metadata are reliably readable, so a name resolved there races and is routinely wrong or missing. |
| Channel topic                    | Written to `Channel.Metadata.topic` when `create-conversation` is called with a `topic` body field; the router reads it. The frontend modal does not surface a topic input today. The topic is not frozen at creation: channel metadata is updatable at any time via Amazon Chime SDK `UpdateChannel`, so the topic can be refreshed as the conversation evolves (for example derived from the running conversation summary, or rewritten on a drift-redirect). That refresh path is supported by the primitive but not yet wired. |
| Drift / creation trigger context | `Channel.Metadata.triggerContext` (string, ≤240 chars): the TOPIC label for a conversation that continues from another. The router reads it on WelcomeIntent and merges it into the assembled orientation as `priorSubject`. Written by the drift-confirm flow (derived from the triggering message, preamble removed) and accepted as a `create-conversation` body field. Paired with `priorMessage`, the user's own words quoted back - the topic says what this is about, the quote says what they typed. |
| Conversation history             | The async-processor reads recent channel messages from Amazon Chime SDK when it needs them; history is not held in Lex `sessionAttributes`. WelcomeIntent's reply is persisted (the bot's first message lands in the channel), so the next turn's processor sees it via `ListChannelMessages`. |
| Welcome composition              | `composeWelcomeMessage(orientation)` in `backend/lambda/src/lib/welcome-orientation.ts`. One assembled orientation, composed additively over whatever is present; the generic copy is what an empty assembly renders.                                                                 |
| Deployment welcome orientation   | Optional per-classification SSM parameter (`ASSISTANT_WELCOME_PARAM`, wired by `assistant-profile-stack.ts` to `${SSM_ROOT}/assistant/{classification}/welcome-orientation`) holding orientation JSON: company name and blurb, the access level this classification grants, example prompts, and a platform note. The router loads and parses it once per warm container and passes it to the composer. Absent, unreadable, or unparseable config falls back to the generic welcome. See "Welcome orientation config" below. |
| Tier-flavoured welcome           | A single welcome shape across basic/standard/premium, flexed per classification by that classification's own orientation parameter rather than by code.                                                                                                                             |
| Once-per-user onboarding         | Opt-in. When an intake schema is configured, the router onboards each user ONCE: on WelcomeIntent it reads the conversation's participant shape from the server-only channel-context store, which the creating path writes BEFORE `CreateChannel`, and skips the intake if that user's profile is already onboarded; on intake completion it records `onboardedAt` plus the collected facts in the profile. Live channel membership is read only for a channel with no recorded participant row, whose welcome has already fired and which is therefore not racing. Per-conversation intake state still rides in `sessionAttributes`; the durable flag lives in the user profile store. See [`SPEC-USER-PROFILE-AND-ONBOARDING.md`](SPEC-USER-PROFILE-AND-ONBOARDING.md). |

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
   composeWelcome(orientation)            classifyIntent → tier processor
     assembled from: deployment           (async; placeholder + update;
     config + topic + priorSubject         targetedSender metadata stamp)
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

**Transport versus classification.** Every real user turn still transits the Lex bot: Amazon Chime SDK routes the message to Lex, and Lex invokes the router as its fulfillment code hook (`Chime` to `Lex` to router). What the router does NOT do is trust Lex's NLU. Lex matches at most two intents (`WelcomeIntent`, `FallbackIntent`), and only `WelcomeIntent` carries meaning, and only in its Amazon Chime SDK-triggered form: a SYSTEM event fired when the assistant is added to a channel, which the router detects by the absence of an `inputTranscript`. Every other turn arrives as `FallbackIntent`, whose label the router ignores entirely; it classifies the request category itself with a separate Haiku classifier (`classifyIntent`), used for every classification by default (basic included). A profile can opt into a keyword-only classifier (`classifyIntentByKeyword`, no model call) by setting `classifierMode: 'keyword'`, but no default classification does. So a message reaching Lex is transport, not classification: Lex is the managed Amazon Chime SDK-to-Lambda bridge and per-turn session, and the router is the brain. This is consistent with [`MESSAGE-FLOW.md`](../../../guides/developer/MESSAGE-FLOW.md) §4 ("why Lex isn't the brain"), which is the fuller treatment of the same hop.

## Welcome composition contract

`composeWelcomeMessage` is the single source of welcome copy. Every surface that wants to greet the user - WelcomeIntent fulfillment, a drift-redirect channel creation, an "X joined the conversation" recap - should call it.

### Orientation is the whole welcome context

**Orientation** means everything that orients a person in this conversation: who they are, where they are, what access they have, **why this conversation exists**, and what they can do next. It is not the name of one input. The deployment's SSM parameter is one *source* of orientation; a topic supplied at creation is another; a carry-over from a previous conversation is another; incident state will be another.

Orientation fields fall into two groups, distinguished by who controls them and therefore how far they are trusted:

| Group | Fields | Source | Trust |
|---|---|---|---|
| Deployment | `companyName`, `companyBlurb`, `accessBlurb`, `examples`, `platformNote` | `ASSISTANT_WELCOME_PARAM` (SSM) | operator |
| Per-conversation | `topic`, `priorSubject`, `parentRef` | `Channel.Metadata` | **member** |

```ts
composeWelcomeMessage(orientation?: WelcomeOrientation | null);
```

**Composition is additive across sources.** Every present field renders its own clause; every absent field omits only its own clause. There is no branch at which one present value discards another, and the generic welcome is what an *empty* assembly renders rather than a branch anything falls back into. Clause order:

1. The lead: "I'm your assistant at `<companyName>`, `<companyBlurb>`". Without a company name the "at `<company>`" clause is dropped and the neutral lead is used; a `companyBlurb` with no `companyName` keeps its own line. **Dropped entirely on a spawned conversation** (see "The drift-created conversation" below), which opens on its continuity rather than on an introduction.
2. Why this conversation exists: `priorSubject` renders "This conversation continues from `<subject>`", with `parentRef` as a link back. `topic` renders "I can help with `<topic>`". Only one of these renders that sentence, `priorSubject` first, since two reason-for-existing sentences would be redundant. This is precedence *within* one group; it never suppresses another group.
3. The access line.
4. The example prompts, as bullets.
5. The platform note.

An earlier implementation short-circuited on `triggerContext` and then on `topic`, returning immediately. A conversation that knew why it existed therefore forgot which company it was in: a present value discarded every other present value, which is the same defect as the all-or-nothing field gate one level up. Both are gone.

**Per-conversation fields are member-controlled and sanitised.** Amazon Chime SDK channel `Metadata` is member-WRITABLE, so `topic`, `priorSubject` and `parentRef` are attacker-controlled text. They are marker-stripped (the same injection defence the context-source runtime applies) and length-capped before they can reach the copy, so one participant cannot crowd the rest of the welcome out. The deployment parameter cannot set them at all: a parameter naming `topic` is ignored and reported, because a deployment-wide value would apply one conversation's reason-for-existing to every conversation.

`priorSubject` is a **label, never a user's message body**: the drift design's by-reference principle forbids copying a user's text into a new conversation, so the subject travels in `priorSubject` and the way back travels in `parentRef`.

The lead-in is always the bare `Hi`. The welcome carries no user name by design: the WelcomeIntent fires on the assistant's channel membership at creation, ahead of the creator's membership and the channel Metadata, so a name resolved on this path races and is routinely wrong or missing. The assistant greets the user by name on their first real turn instead, where the sender is known. `welcome-orientation.test.ts` locks the name-less lead-in in both the generic and oriented forms.

### Welcome orientation config

The platform ships a generic, classification-neutral welcome. A deployment supplies company-specific orientation as JSON in the classification's `ASSISTANT_WELCOME_PARAM` parameter, with no code change, which is itself a worked customization example:

| Field | Type | Renders as |
|---|---|---|
| `companyName` | string | "I'm your assistant at `<companyName>`" |
| `companyBlurb` | string | a trailing clause on the same sentence |
| `accessBlurb` | string | one line stating what this classification's access covers |
| `examples` | string[] | "A few things you can try:" plus one bullet each, capped at 4 |
| `platformNote` | string | a closing line, typically pointing at the platform itself |

`backend/scripts/seed-demo.ts` writes one orientation per classification for the demo deployment.

#### One missing field omits one piece of copy

Every field is optional and each is composed independently. A field that is absent, blank, or the wrong type omits **only its own piece of copy**; the fields that are present are still rendered. There is no threshold at which a partial orientation reverts to the generic greeting, and no placeholder is invented for a missing one:

- No `companyName` drops the "at `<company>`" clause and uses the neutral lead sentence, rather than naming an organization the configuration did not name. A `companyBlurb` with no `companyName` keeps its own line.
- An orientation carrying only an `accessBlurb`, or only `examples`, or only a `platformNote` renders that field. An earlier implementation gated the whole oriented welcome on `companyName || companyBlurb || examples`, so an access-line-only orientation fell all the way back to the generic greeting and discarded what the deployment had configured.
- The generic welcome is served in exactly one case: no orientation field is usable at all.

#### A degraded welcome is recorded as an error

This path cannot fail loudly on its own. The welcome still lands, so a missing field, an unparseable value, or a revoked `ssm:GetParameter` grant produces no exception, no retry, and no user complaint, only worse copy. Silence here is therefore indistinguishable from health, so the router records it instead:

| Condition | Recorded as |
|---|---|
| The parameter is declared and read cleanly, but a field was blank, wrong-typed, or truncated | `welcome_orientation_incomplete` |
| The oriented welcome rendered with one or more fields absent | `welcome_orientation_incomplete`, naming the omitted fields |
| The parameter is declared but does not exist, cannot be read, or yields no usable orientation | `welcome_orientation_unusable` |
| No parameter is declared for the classification | nothing; the generic welcome is the documented platform default, not a defect |

Both are `Count` metrics in the `AgentEchelon/Welcome` namespace, dimensioned on `Classification`, alongside a `[Router][WelcomeIntent][ConfigDefect]` error log carrying the specific reasons. The router reads the parameter through a variant of its SSM helper that preserves the failure reason, because the ordinary helper collapses "absent", "malformed" and "access denied" into a single `undefined`, and the difference between those is the difference between a legitimate un-configured deployment and a silent misconfiguration.

`tests/e2e/welcome.spec.ts` asserts the deployed wiring directly (parameter name in the handler env, parameter resolving, the shipped parser accepting it, and IAM allowing the role to read it) for the same reason.

### The drift-created conversation uses the same welcome

A conversation created by confirming a drift suggestion runs the welcome flow above, unchanged. It is worth stating explicitly because it did not always, and because the mechanism is easy to get wrong in a way that looks fine.

**`WelcomeIntent` fires on the assistant's AUTOMATIC channel membership.** The bot acquires that membership by being the `CreateChannel` bearer, so it happens on every creation path with no explicit call. Verified against a live Amazon Chime SDK deployment: a channel created by a bot bearer with **no** `CreateChannelMembership` call at all receives the composed welcome within seconds. An earlier comment in `create-conversation` claimed the opposite - that only an explicit membership add fires it - and that claim was wrong. The explicit add there is still made, for a different reason: it guarantees `ListChannelMemberships` returns the bot, which `@mention` routing needs.

The consequence for this document's ordering rule (§2 of [`SPEC-USER-PROFILE-AND-ONBOARDING.md`](SPEC-USER-PROFILE-AND-ONBOARDING.md)) is direct: because the welcome fires on creation, it can arrive before the creator's own membership settles. That is why per-conversation participant context is written ahead of `CreateChannel` rather than read back afterwards.

**What the drift path contributes** is channel `Metadata` and server-only context, not copy. `createConversationFromDrift` posts nothing into the new conversation; it stamps `triggerContext` (the topic), `parentChannelArn` and `originatingMessageId` on `Metadata`, writes `priorMessage` (the user's own words) to the server-only channel-context store, and the composer renders them.

**A spawned conversation gets a SHORTER welcome than a fresh one, deliberately.** The composer detects the spawn from its evidence (`priorSubject` or `priorMessage`, which only the drift creation path sets) and drops the parts that orient someone arriving cold:

| Section | Fresh conversation | Spawned (drift) conversation |
|---|---|---|
| Lead ("I'm your assistant at `<companyName>`") | rendered | **dropped** |
| Reason this conversation exists (`priorSubject` + link back) | when set | rendered |
| The user's quoted message (`priorMessage`) | when set | rendered |
| Access line, example prompts, platform note | rendered | **dropped** |

So a spawned conversation opens directly on `This conversation picks up <topic> ([the conversation it came from](...))`, then the quote, then the answer.

The reason is that none of the dropped copy is new information to this reader. They were already mid-conversation with this same assistant, were told who it is and what they can ask in the thread they came from, and arrived by accepting an offer to continue one thought. Repeating the introduction pushes the only line that matters, what this thread is for, below an introduction they have just read.

The drift path posts no first message of its own. An extra hardcoded message fills no gap - the welcome already arrives - and would open a drift conversation with **two** bot messages in nondeterministic order, one of them bypassing the composer entirely.

**On quoting.** The composer's `priorMessage` clause quotes the user's message back to them, which is a deliberate exception to the drift design's by-reference principle and is documented with its erasure consequence in [`SPEC-DRIFT-CONVERGENCE.md`](../../capabilities/SPEC-DRIFT-CONVERGENCE.md). The topic (`priorSubject`) and the quote (`priorMessage`) are separate fields because they answer different questions: what this conversation is about, and what the person actually typed.

## Channel metadata schema (welcome-relevant fields)

The router reads these from `Channel.Metadata`. `create-conversation` writes them.

| Key | Type | Set by | Read by |
|---|---|---|---|
| `modelTier` | `'basic' \| 'standard' \| 'premium'` | create-conversation | admin tools; create-conversation. NOT the router's classification authority - the router resolves the served classification from the immutable `classification` tag, deliberately NOT from `metadata.modelTier` (see `router-agent-handler.ts` "We deliberately do NOT trust `metadata.modelTier`"). |
| `createdBy` | string (user ARN, `…/user/<sub>`) | create-conversation (server-set from the JWT sub). The federated create path does not write it at all. | share-conversation, admin views. ATTRIBUTION ONLY, and deliberately not the router's onboarding gate: channel Metadata is member-WRITABLE, so this value can be rewritten by another member and must never key a per-user decision. The gate reads the server-only participant store instead. |
| `topic` | string (≤500 chars as written) | create-conversation when `topic` in body | router (WelcomeIntent + future system-prompt grounding). The welcome composer renders at most the first 200 characters. |
| `triggerContext` | string (≤240 chars) | the drift-confirm flow (topic derived from the triggering message); create-conversation when `triggerContext` in body | router (WelcomeIntent grounding, as `priorSubject`) |
| `priorMessage` | string (≤400 chars) | the drift-confirm flow (the triggering message, marker-stripped) | router (WelcomeIntent, quoted back under "You asked:") |
| `parentChannelArn`, `originatingMessageId` | string | the drift-confirm flow | router (the welcome's link back to the originating conversation) |

`topic` and `triggerContext` are intentionally separate slots: a topic is *what the user is here for* (durable across the conversation); a trigger context is *what brought them to this specific channel right now* (one-shot, referencing the drift-causing conversation by label). Both are orientation sources and both render, alongside the deployment's configured copy rather than instead of it; only the reason-for-existing *sentence* is taken by one of them, `triggerContext` first.

## Conversation context: lifecycle, writers, and the guarantee

**Status: the store is built; the GUARANTEE that a conversation has one is not.** This section states
what the guarantee must be, records which paths currently satisfy it, and names the two that do not.

### What this store is, and why the question matters

The server-only channel-context store (`ChannelContextTable`, keyed by `channelArn`) holds the
conversation's private grounding and routing signals: `participantProfile`, `domainContext`,
`otherContexts`, `userName`, `participants`, `memberIdentities`, `userLanguage`, `segment`, and
`memberCount` (a membership signal the archival path records; the `@all` size decision never reads it - see below).

It exists because Amazon Chime SDK channel `Metadata` is member-WRITABLE (`UpdateChannel`), so
anything a member could forge cannot ground an answer or choose a model. That makes this store the
only place several answers can legitimately come from - and therefore the only place their ABSENCE has
consequences.

**Absence is not neutral.** Each consumer degrades differently, and the degradations are not equally
visible:

| Consumer | Without context | How it looks |
|---|---|---|
| `host-grounding.ts` | no participant profile, no domain grounding, no `userName` | a generic, slightly worse answer. **Invisible.** |
| Model routing (`userLanguage`, `segment`) | falls back to the default model | wrong language or wrong model. Invisible to the operator. |
| Onboarding (`getParticipantContext`) | reads live membership instead | a race the recorded shape exists to avoid |

`memberCount` is written by the archival path as a cheap membership signal, but the `@all` responder
decision is NOT a consumer of it: channel size is always resolved live via `resolveChannelSize`
(`channel-size.ts`), which deliberately exposes no read accessor for the recorded count, so that
decision is unaffected by a missing or sparse row.

None of these throw. That is the whole problem: a conversation with no context is a conversation that
quietly answers slightly worse forever, and nothing reports it.

### The guarantee

**Every conversation that an assistant will answer in MUST have a context row before its first turn.**

Two properties follow, and both are load-bearing:

1. **Written BEFORE `CreateChannel` completes**, not after. The welcome fires on membership, so a row
   written afterwards races the first turn it is meant to ground.
2. **A row may be sparse, and sparse must be indistinguishable from absent to every consumer.** Fields
   are written by different paths at different times; a consumer that branches on the ROW rather than
   the FIELD would treat a row carrying only `memberCount` as "context exists". Every consumer today
   guards the field (`if (priv.domainContext)`, `ctx?.memberIdentities || []`,
   `parseParticipantContext(ctx?.participants)`), and that is a requirement, not a coincidence.

### Writers, and what each contributes

| Path | Writes | When |
|---|---|---|
| `lib/channel-creation.ts` | `participants`, carried `memberIdentities`, drift's `priorMessage` | before `CreateChannel` |
| `federated-create-conversation.ts` | `participants`, participant profile, domain context | at creation |
| `federated-add-member.ts` | `participants` (re-derived), `memberIdentities` | on member add |
| `kinesis-archival.ts` | `memberCount` | on every membership event |
| **`admin-notification-channel-provision.ts`** | **nothing** | **GAP** |
| **`proactive-briefing.ts`** | **nothing** | **GAP** |

### The gap, stated plainly

**Two channel-creating paths write no context at all.** A conversation created by the admin
notification provisioner or by proactive briefing has no participant shape, no grounding, and no
member count. The assistant still answers in them; it answers with less than it should, and nothing
surfaces that.

**This is a symptom of the root cause already on record: channel creation is implemented six times.**
There is no single place where "a conversation is created" happens, so there is no single place where
"and therefore it has context" can be guaranteed. Every new creation path re-decides the question, and
two of them decided it by omission. Consolidating creation is the actual fix; until then, this section
is the checklist a new path must satisfy.

### What a new creation path owes

1. Write the context row **before** `CreateChannel` returns.
2. Write `participants` at minimum - it is what onboarding reads to avoid re-interrogating a user.
3. Never write grounding into channel `Metadata` as a substitute. Metadata is member-writable.
4. If the conversation is machine-created and has no human participant shape, write the row anyway
   with what is known. A row asserting "no participants" is a positive statement; an absent row is a
   question nobody answers.

### Open, and deliberately not decided here

- **Whether a missing row should be repaired lazily** (first turn notices and backfills) or whether
  creation paths must simply be correct. Lazy repair hides the gap; strict creation surfaces it but
  leaves existing conversations unrepaired.
- **Whether `memberCount` should be conditional on the row existing.** Today it is not, so the
  archival path can CREATE a sparse row for a channel that never had context. That is safe only
  because every consumer is field-guarded; making it conditional would preserve the null/non-null
  distinction at the cost of never caching for pre-existing channels.
- **A detector.** Absence is invisible by construction, so the only way this stops recurring is a
  scheduled check for channels with assistant turns and no context row.

## Invariants

These invariants govern the **default static welcome**. The onboarding welcome pattern (a separate, opt-in intake flow described under "The two-tier welcome" below) intentionally relaxes "instant" and "shaped" for assistants that must gather structured inputs before they can help.

- **Welcome always lands.** Even when `orientation`, `topic`, and `triggerContext` are all unknown, `composeWelcomeMessage` returns the generic copy. The bot never opens a channel with silence.
- **Welcome is instant.** No Bedrock call on the welcome path. Cognito lookups are cached for the Lambda's warm life. Channel metadata is cached per-channel, and the orientation parameter is loaded once per warm container.
- **Welcome is consistent.** `composeWelcomeMessage` is the single source of copy for every surface that reaches the WelcomeIntent path, the drift-confirm path included: `createConversationFromDrift` posts nothing into the conversation it creates, it stamps channel `Metadata` and the composer renders it.
- **Welcome is shaped, not free-form.** Static copy with interpolation slots, not a Bedrock-generated turn. Predictable for tests, no model variance, no guardrail surprises.

## The complete assistant-context model

Welcome is one entry in a larger set of context sources assembled per turn. This section inventories all of them so a reader building an assistant sees the whole picture (the how-to is [`GUIDE-ASSISTANT-CONTEXT.md`](../../../guides/developer/GUIDE-ASSISTANT-CONTEXT.md); the message path is [`MESSAGE-FLOW.md`](../../../guides/developer/MESSAGE-FLOW.md)).

**Active per turn (assembled today):**

| Source | Where it comes from | How it reaches the model |
|---|---|---|
| Conversation history | Recent channel messages, read fresh each turn | The model input (recent window) |
| Company context | Tier documents under `context/{classification}/` | Retrieved and folded into the prompt (see target below) |
| Project RAG | pgvector over the reference corpus (`rag/`) | Top-K relevant chunks in a retrieved-context section |
| Participant / domain context | Channel metadata | Prompt sections, present only when the channel carries them |
| Persona and standing policy | Assistant config (persona) | The stable prompt prefix |
| Welcome / personalization | Channel metadata (name, topic, trigger) | The welcome reply (see contract above) |

**Also available:**

- **Cross-conversation context (per user).** Partly built - per-user facts carry across a user's conversations today; a running cross-conversation summary is roadmap. See the subsection below.

### Company context as digest plus retrieval (built)

Company context loads through two tier-scoped paths. The company-context tool and the always-present per-tier **digest** (`context/{classification}/_digest.json`, document titles and one-line descriptions) are scoped by the physical **IAM** prefix boundary (a lower tier's role cannot read a higher tier's prefix). Company documents are ALSO embedded into the pgvector store (same path as project RAG, under `rag/company/{tier}/`) and retrieved by relevance per turn, scoped by the fail-closed **SQL** tier filter. The digest tells the assistant what company context exists; retrieval and the tool supply the detail; the whole-corpus re-read and the size cap are gone. With company RAG active, a document's tier is enforced by both IAM (tool + digest) and the SQL filter (retrieval). This spec documents a reference implementation: a production deployment keeps genuinely sensitive records (financials, PII, regulated data) in their **source of truth** and reads them live through a connector, rather than embedding a copy (the demo embeds *fictional* financials for illustration). See [`RAG.md`](../../../guides/developer/RAG.md) and [`GUIDE-ASSISTANT-CONTEXT.md`](../../../guides/developer/GUIDE-ASSISTANT-CONTEXT.md).

### Conversation summary as consumable context (built)

The summary that already exists for drift is also assistant context, consumed conditionally: the router fetches it from the data-plane Lambda and folds it into the prompt (`## EARLIER IN THIS CONVERSATION`) when the conversation has grown beyond the recent-history window (a summary row exists), and omits it on short conversations. The fetch runs in parallel with retrieval, so it adds no wall-clock. It is no longer a drift-only artifact.

### Cross-conversation context, per user (partly built)

Context compounds within a conversation (the summary above) and, per user, across their conversations, so no participant starts from zero. Two parts of that carry today; one is roadmap:

- **Per-user facts carry across conversations (built).** A durable per-user record holds what the platform learned about a person (who they are, what they told it during onboarding, whether they have been onboarded), keyed by their identity, and every new conversation reads it - so a returning user is not re-onboarded and their company and role are already in hand. This is the pluggable user-profile store of [`SPEC-USER-PROFILE-AND-ONBOARDING.md`](SPEC-USER-PROFILE-AND-ONBOARDING.md); a deployment can point it at its own store by ARN.
- **A running cross-conversation summary is not yet wired into the per-turn prompt (roadmap).** The capability to find and summarize a user's related past conversations exists, but folding that running, cross-conversation picture into each turn - the "everyone works from the same live picture, across their conversations" tenet at full strength - is design, not built. Until it lands, cross-conversation carry is the per-user facts above plus whatever the user brings into the new conversation, not an automatic summary of every prior thread.

All of it stays **bounded by the same access model**: cross-conversation context is scoped to the requesting user's own conversations and classification, never a window into another participant's threads.

### The two-tier welcome (static and onboarding)

The welcome is a passthrough that can be as light as an instant greeting or as rich as a context-gathering intake. The **static greeting** below is the default: instant, no model call, personalized from channel metadata. An assistant that must collect structured inputs before it can help uses the **onboarding welcome pattern** (a short, multi-step intake that gathers the minimum required inputs, confirms them, and hands off to the working assistant with that context in place). The onboarding pattern is a separate, **opt-in flow (built)**; the invariants above govern the default static greeting.

The onboarding intake is deterministic: like the static welcome it makes no Bedrock call on any intake turn, so it stays instant and predictable. Progress rides in Lex `sessionAttributes` across turns (`AE_ONBOARDING`), so there is no per-turn store; because the questions and answers are ordinary channel messages, the working assistant sees the collected inputs in its recent-history window once intake confirms, with nothing extra to thread. It is enabled per deployment by supplying an intake schema (`ONBOARDING_INTAKE` env or `ONBOARDING_INTAKE_PARAM` SSM); absent a schema it is inert and the router behaves exactly as the static path. The engine is `backend/lambda/src/lib/onboarding-intake.ts` (a pure FSM), wired into the router welcome and first-turn paths. The schema shape and field semantics are documented in [`GUIDE-ASSISTANT-CONTEXT.md`](../../../guides/developer/GUIDE-ASSISTANT-CONTEXT.md) ("Welcome patterns").

One limitation of the opt-in flow: intake progress lives in the Lex session, so if the session expires mid-intake the flow restarts from the first field. The intake is short (a few fields) and the session TTL far exceeds it, so this is a non-issue in practice; the collected inputs also remain in channel history regardless.

## Related docs

- `docs/guides/developer/GUIDE-ASSISTANT-CONTEXT.md` - the developer/admin how-to for building and operating assistant context.
- `docs/specs/interaction/assistant-config/SPEC-PER-PROFILE-OWNERSHIP.md` - the per-tier ownership model that hosts the tier-specific async-processors the FallbackIntent path dispatches to.
- `docs/specs/capabilities/SPEC-DRIFT-CONVERGENCE.md` - the drift feature whose confirm flow is the `triggerContext` producer.
- `docs/guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md` - the practical guide a tier-team uses; per-tier welcome copy files fit here.
