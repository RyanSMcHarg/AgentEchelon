---
title: "ADR-039: A routing decision is made from the message, and the automatic invocation is a property of the assistant"
status: >-
  Accepted 2026-09-17. Two directions: (A) a per-channel routing context the channel flow reads on every message, and (B) turning `StandardMessages: AUTO` off. (A) is DECLINED, and the flow reads no per-channel routing record. (B) is decided as (B1), `StandardMessages: NONE` with `TargetedMessages: ALL` on each assistant's `Configuration.Lex`, which is ADR-036 option B and what the code runs: the provisioner builds every assistant identity with `StandardMessages: NONE` (`assistantBotConfiguration`, `lib/assistant-identity.ts`), and `flowOwnsTheTurn` (`lib/flow-bypass.ts`) claims every untargeted 1:1 turn. (B) as first phrased, at the app instance (B3), is not expressible, because `InvokedBy` exists only on the `AppInstanceBot`. The amendment reverses the original record's central objection to (B): a private message keeps its in-flight route through the targeted entry, so the disclosure the original record named does not arise. ADR-044, which revisited (A) as a stored routing bit, is Declined (2026-10-11). `WelcomeIntent` firing under `StandardMessages: NONE` and the deployed `InvokedBy` (`NONE`/`ALL` on every assistant) are both verified 2026-10-11 on the default instance (ADR-036, Recorded evidence). A monitoring answer for the channel flow as the single entry for untargeted messages is **OPEN**, and is not a precondition of the decision.
date: 2026-09-16
amended: 2026-09-16
related:
  - "./011-agent-routing-mechanism.md"
  - "./022-message-identity-is-established-at-the-channel-flow.md"
  - "./029-clarification-is-public-and-answers-get-their-own-placeholder.md"
  - "./030-a-message-is-answered-by-the-assistant-whose-work-it-answers.md"
  - "./032-where-a-rule-runs.md"
  - "./033-a-conversation-answers-one-turn-at-a-time.md"
  - "./034-addressing-a-message-is-not-making-it-private.md"
  - "./036-why-turns-enter-through-amazon-lex.md"
  - "./037-a-turn-declares-what-it-answers-on-the-message-it-is-already-posting.md"
  - "./038-a-turn-answers-the-message-that-was-there-when-it-started.md"
  - "./041-simplifying-how-a-message-reaches-an-assistant.md"
  - "../../overview/TENETS.md"
  - "../../guides/developer/LATENCY-TARGETS.md"
  - "../../guides/developer/MESSAGE-FLOW.md"
  - "../../../backend/lambda/src/channel-flow-processor.ts"
  - "../../../backend/lambda/src/lib/channel-size.ts"
  - "../../../backend/lambda/src/lib/channel-context-client.ts"
  - "../../../backend/lambda/src/lib/channel-classification.ts"
  - "../../../backend/lambda/src/lib/flow-bypass.ts"
  - "../../../backend/lambda/src/lib/private-command.ts"
  - "../../../backend/lambda/src/lib/private-prefix.ts"
  - "../../../backend/lambda/src/lib/lex-envelope.ts"
  - "../../../backend/lambda/src/router-agent-handler.ts"
  - "../../../backend/lambda/src/lib/assistant-provisioner.ts"
  - "../../../backend/lib/stacks/channel-flow-stack.ts"
  - "../../../backend/lib/stacks/conversations-stack.ts"
tracking: |
  Accepted. Every description of the deployed system here is read from the tree at the date above, and
  the configuration levels are read from the Amazon Chime SDK client models in the same tree. The entry
  measurement is ADR-036's and ADR-041's, and this record does not take it or stand in for it.
---

# ADR-039: A routing decision is made from the message, and the automatic invocation is a property of the assistant

> **Amended 2026-10-23.** `create-bot` and `create-lex-bot`, the deploy-time provisioners this record cites, are removed: no stack owns an assistant identity, and every identity and Amazon Lex bot is built by the provisioner (`backend/lambda/src/lib/assistant-provisioner.ts`, [ADR-048](./048-an-assistant-is-not-a-classification.md), amended 2026-10-23). The line numbers cited for them are of the removed files. The behavior cited is unchanged: every identity is built with `StandardMessages: NONE` and `TargetedMessages: ALL`.

## Status

**Accepted (2026-09-17). (A) is declined; (B) is decided as B1, and the code runs it.** The provisioner (`backend/lambda/src/lib/assistant-provisioner.ts`) builds every assistant identity with `InvokedBy: { StandardMessages: NONE, TargetedMessages: 'ALL' }` (`assistantBotConfiguration` in `backend/lambda/src/lib/assistant-identity.ts`, whose default is `NONE`), and `flowOwnsTheTurn` (`lib/flow-bypass.ts`) claims every untargeted 1:1 turn, so the channel flow starts every untargeted turn at every conversation size. Verified by `backend/test/lib/a-flow-entry-profile-owns-its-one-to-one-turn.test.ts`. The flow reads no per-channel routing record: ADR-044, which revisited (A) as a stored routing bit, is Declined (2026-10-11), and its unused store and writer are removed. The private 1:1 targeting concern this record left open does not arise, because `TargetedMessages: ALL` is untouched and a targeted message still reaches Amazon Lex. ADR-036 and ADR-041 record the same decision for the entry.

**OPEN, and follow-ups to the decision rather than preconditions of it:**

- **A monitoring answer for the channel flow as the single entry for untargeted messages**, the third item the amendment names.

**Verified 2026-10-11 on the default instance ([ADR-036, Recorded evidence](./036-why-turns-enter-through-amazon-lex.md#recorded-evidence)):**

- **`WelcomeIntent` under `StandardMessages: NONE`.** ADR-043 reports on 2026-09-16 that it fires; the recorded reading counts 422 welcomes handled by assistants configured `NONE`/`ALL` between 2026-10-07 and 2026-10-11.
- **The deployed `InvokedBy`.** The code provisions `NONE`/`ALL`, and all eight deployed assistants read `NONE`/`ALL`.

**How to read the body.** This record answers two questions the owner asked about the future of channel routing and states what each would cost against the code. Its original text declined both in the form proposed; the amendment at the end re-judges (B) and is the operative reasoning for it. Where the text below says `create-bot` sets `AUTO`, describes the automatic invocation as live, or calls B1 "not recommended", it describes the `AUTO` configuration this decision replaces and the reasoning the amendment withdraws. The same holds wherever the original body or the amendment treats ADR-036's entry comparison as unmeasured (it is taken 2026-09-16), names the `WelcomeIntent` probe as a precondition (it is a follow-up, verified 2026-10-11), or names a private 1:1 route without Amazon Lex as a blocker (`TargetedMessages: ALL` removes the need for one); each such sentence carries an inline note. The declined direction (A) is revisited by ADR-044, which is also Declined (2026-10-11).

**THIS RECORD EVALUATED (B) AS THE WRONG PROPOSAL, AND THE AMENDMENT REVERSES ITS CENTRAL OBJECTION.** Everything below about (A) stands. Everything below about (B) is kept as written, as the history of an argument made against a proposal the owner did not make, and it is superseded by the amendment at the end of this record. Read the amendment before acting on any sentence in "(B) Turning the automatic invocation off".

## Problem, and who has it

A deployer wants an assistant that answers every message exactly once, quickly, and that never shows one person's private message to the room. A developer extending the message path wants to know where a routing decision may read from, and at which level each routing knob actually lives, rather than inferring it from four stacks and two AWS clients.

The two questions asked are:

**(A) A channel routing context.** A per-channel record the channel flow reads on every message to make its routing decisions.

**(B) Turning off `StandardMessages: AUTO` at the app instance rather than per configuration**, so that Amazon Chime SDK stops invoking assistants automatically and the channel flow becomes the router for everything.

They are asked together because they look complementary: if the flow routes everything, it needs to know more, and a per-channel record is where more would live. This record's central finding is that the complement does not hold, and the reason is specific rather than general.

## What is configurable, and at which level

The owner's phrasing distinguishes "app instance" from "configs". The four levels are real and they carry different things, so they are set out before either option is judged.

| Level | Resource | What it can carry | Can it express an invocation rule? |
|---|---|---|---|
| App instance | `AppInstance` | `Name` and `Metadata`, plus retention settings and streaming configurations set by their own API calls | **No.** The shape has no invocation, routing or bot field at all |
| App instance bot | `AppInstanceBot` | `Name`, `Metadata`, `Tags`, and `Configuration.Lex`, which holds `LexBotAliasArn`, `LocaleId`, `WelcomeIntent` and `InvokedBy` | **Yes, and this is the only level that can.** `InvokedBy` is `{ StandardMessages, TargetedMessages }` |
| Channel | `Channel` | `Name`, `Mode`, `Privacy`, `Metadata`, `ChannelFlowArn`, `ElasticChannelConfiguration`, `ExpirationSettings`, plus resource tags | **No.** A channel can name a flow; it cannot say which assistants Amazon Chime SDK invokes on it |
| Channel flow | the flow's own Lambda | whatever AgentEchelon writes into it | **No, except by denial.** The flow can allow or deny a message; it cannot change whether Amazon Chime SDK invokes a bot on a message it releases (ADR-022, option 3) |

Read from the Amazon Chime SDK client models in this tree on 2026-09-16, and confirmed against how the deployment writes them: `create-bot` sets `InvokedBy: { StandardMessages: 'AUTO', TargetedMessages: 'ALL' }` inside `Configuration.Lex` at create (`create-bot`) and re-applies exactly the same block on update (`create-bot`). The app-instance level is written once by `MessagingAppInstance` in `backend/lib/stacks/messaging-stack.ts:25` and carries no such field to write.

**So (B) as phrased is not available.** There is no app-instance-level place to turn `StandardMessages: AUTO` off. The setting exists only on each `AppInstanceBot`, which is what "configs" already means: `Configuration.Lex` is literally the configuration block, written per assistant by the deployment.

**What (B) reduces to** is changing that block on every assistant at once, which the deployment can already do because it writes the block from one place. That is a deployment-wide change per assistant, not a per-channel or per-moment one, which ADR-038 established when it declined to condition the entry (`create-bot`, and ADR-038 "What the shape would be"). The distinction the owner drew between the app instance and the configs is therefore not the distinction that matters here. The one that matters is that neither level can express "this conversation, right now", and no level below the bot can express it at all.

**Two things follow that are worth stating separately.** First, `TargetedMessages: ALL` is an independent field, so turning `StandardMessages` off does not turn targeted routing off; a private `.` address keeps reaching the assistant it names. Second, `WelcomeIntent` sits in the same `Configuration.Lex` block and is not `InvokedBy`, so what it does under `StandardMessages: NONE` is a separate question, established by probe rather than assumed. ADR-036 records it as a follow-up to the decision, **OPEN** (see Status).

## (A) The routing context

### What the flow decides today, and what each decision reads

Every decision the channel flow makes, with its source, read from `backend/lambda/src/channel-flow-processor.ts`.

| Decision | Source | When it is paid |
|---|---|---|
| Is this a bot's own message | `Sender.Arn` on the event | free, every message |
| Is this a bot-to-bot loop | `Sender.Arn`, `Target`, `Content`, all on the event (`:313`) | free, bot messages only |
| Is this an empty Amazon Lex envelope | `Content` on the event (`:358`) | free, bot messages only |
| Is this a duplicate placeholder | a conditional write on the abuse-controls table (`:457`) | bot messages carrying a correlation marker |
| Is this an edit rather than a send | `EventType` on the event (`:523`) | free, every message |
| Which classification is this conversation | `ListTagsForResource` on the channel (`:158`, `backend/lambda/src/lib/channel-classification.ts:71`) | **an Amazon Chime SDK call on every message** |
| Which assistant is primary here | SSM `GetParameter`, memoized per container per classification (`:186`) | free once warm |
| Who is in the room, and how many | `ListChannelMemberships`, paginated (`:627`, `backend/lambda/src/lib/channel-size.ts:101`) | only when the text carries `@`, `.` or a command |
| Does this message name a member, an assistant, or nobody | the roster above plus `Content` (`:637`) | with the roster read |
| Does a `.` prefix resolve to a member | the roster above plus `Content` (`:644`) | with the roster read |
| Does the flow own this turn | `flowOwnsTheTurn` over text, roster and size (`:662`) | pure, no read |
| Did a privately addressed message carry its `Target` | `GetChannelMessage`, up to twice with a 250 ms pause (`:704`, `backend/lambda/src/lib/private-command.ts:102`) | only on a resolved private address |
| Does a `#n` reference name an item this sender may answer | a `RequestResponse` invoke of the task service (`:768`, `:1282`) | only on a message starting with a reference |
| Is this delivery a duplicate | a conditional write on the abuse-controls table (`:778`) | only when a turn is dispatched |
| Which router runs the turn | `routerArnForClassification` over environment variables (`:1368`) | free |
| Which task service serves this classification | environment variables (`:1248`) | free |

### What a routing context would contain that is not already free

Working down that list, the answer is close to nothing, and each exclusion has its own reason.

**The per-message facts are on the event.** Content, message id, metadata, sender, event type and the attachment reference all arrive with the callback. A store cannot improve on a field that is already in hand, and tenet D7's closing clause says so directly: when the caller already holds the data in memory, consult neither.

**The roster and the member count cannot be cached, and that is a recorded decision rather than an opinion.** `backend/lambda/src/lib/channel-size.ts:106-124` rejects an event-written count on two independent grounds. It collapses assistants into the human roster, so a battle channel of three reports two and the flow stands aside for an `@all` that Amazon Chime SDK will not route either, which is the failure direction where nobody answers. And only one of the two callers that must agree on size can reach such a store at all, because the channel flow has no `CHANNEL_CONTEXT_TABLE` in its environment and no grant on that table (`backend/lib/stacks/channel-flow-stack.ts:327`). Two halves of a decision that must be exact complements would then compute it from different sources with different semantics, which is the precise failure that module exists to prevent. Tenet D7 is the general form of the same point: membership is current conversation state, the Amazon Chime SDK streams it, and a projection's lag at read time is indistinguishable from a quiet conversation.

**`Target` is the one fact the flow most needs and the one a per-channel record structurally cannot hold.** The callback does not carry it, measured 2026-08-14 (`backend/lambda/src/lib/private-command.ts:4-5`), and a message the flow is still holding cannot be read at all, measured 2026-09-15 for a targeted and an untargeted message alike (`backend/lambda/src/lib/private-command.ts:146-149`). `Target` is a property of one message, set by the sender at send time. A record about the conversation is the wrong shape for it, not merely an unpopulated one.

**The routing table and the task-service ARNs are already environment variables**, written at deploy. Moving them into a per-channel row would replace a free read with a paid one.

**The primary assistant is already SSM-backed and memoized per container** (`backend/lambda/src/channel-flow-processor.ts:188`), so after the first message on a warm container it costs nothing.

**Which leaves exactly one read that happens on every message: the classification tag.** It is an Amazon Chime SDK control-plane call on the path of every message, including messages the flow will release untouched, and it is the only candidate a routing context could plausibly displace.

### Why displacing that one read with a store is the wrong trade

**It would be additive, not substitutive.** The classification tag is the Layer-1 access boundary. Tenet P4 makes `classification` the only closed axis IAM evaluates, and the tag is chosen precisely because channel Metadata is member-writable while the tag is not (`backend/lambda/src/lib/channel-classification.ts:10-13`). A copy of it in a DynamoDB row would be a second source for the one fact the whole access model is keyed on, and the live decision would still have to read the tag or stop being tag-authoritative. So the store's read would be added to the tag read rather than instead of it.

**And the cheap substitution needs no store at all.** The tag is documented as immutable against `UpdateChannel`, and the flow already memoizes SSM parameters per container for exactly this reason. A per-container memo on the tag read would remove the same call for the same warm-container population, with no table, no grant, no environment variable and no second source. It is not free of judgment: the admin notification provisioner re-tags a channel's classification as a repair path (`backend/lambda/src/admin-notification-channel-provision.ts:238`), so a memo has a staleness window bounded by container lifetime on a security boundary. That is a decision worth taking on its own terms, with its own test, and it is not one to take as a side effect of a routing-context proposal.

### The honest per-message cost, priced where it actually lands

This is the part that decides (A), and it is sharper than "one more DynamoDB read".

**A read in the channel flow sits in front of the person's own message, not in front of the reply.** The flow is synchronous and Amazon Chime SDK waits on it. Every read the handler makes before `callbackAllow` delays the message appearing in the room for everybody, the sender included. In the code as it stands, the classification read (`:585`), the primary-assistant lookup (`:586`) and the conditional roster read (`:627`) all precede the release at `:791`. The private-address check is the one rule written the other way round, and it is written that way deliberately: it releases first and reads after (`backend/lambda/src/lib/private-command.ts:144-149`), because holding the message costs delivery.

**So a routing-context read is paid twice over against the metric this area has been fighting over.** Time to first feedback has a one second target (`docs/guides/developer/LATENCY-TARGETS.md`, "TTFF (`ttff_ms`)"), and the acknowledgment cannot start until the turn starts, which cannot happen until the flow releases. A read in front of release lengthens the person's wait to see their own words and then lengthens time to first feedback by the same amount.

**And it is paid on every message, including the ones the flow will stand aside on.** In a busy room the overwhelming majority of messages are people talking to each other: no `@`, no `.`, no command, no reference. Those messages reach none of the conditional branches today. A routing context read on every message would put a store read on the path of exactly the traffic the flow exists to leave alone.

**This is ADR-032, arriving at a new proposal.** That record's tenets are written for this shape: every rule added to the channel flow is paid for by every person in every conversation, including the ones the rule will never apply to, and the latency asymmetry is the whole argument. A routing context is not a rule, but it is paid the same way and it buys the same nothing on the turns that were already correct.

### As a cache, and what the staleness rule would have to be

Taking the proposal at its most favorable, a routing context is a cache rather than a source of truth. Tenet D7 then decides most of it before a staleness rule is written.

Membership, content and channel name are current conversation state that the Amazon Chime SDK holds and streams, so they are read from it rather than from a copy. The staleness rule for a cache of them cannot be written honestly, because at read time a stale projection and a quiet conversation look identical, and the routing decision has no way to tell the two apart in the direction that matters: a roster missing a member who just joined resolves their name to nobody, and the flow's own log says so while the person is ignored in front of the room (`backend/lambda/src/channel-flow-processor.ts:1094`).

Classification is not current conversation state, so tenet D7 does not forbid caching it. What decides that one is the paragraph above: the substitution that works costs no infrastructure, and the store version is additive on the boundary IAM evaluates.

**So there is no staleness rule to write, because there is nothing left that both wants caching and may be cached.**

### Is it a new store or a new operation on an existing one

Neither, as it turns out, and the question is worth answering because tenet D8 asks it first.

`ChannelContextTable` already exists, keyed by `channelArn` (`backend/lib/stacks/conversations-stack.ts:240-241`). It is written by the creation paths and by the assistant handler and read by the assistant handler (`backend/lambda/src/lib/channel-context-client.ts:165`, `:254`). So a routing context would be a grant and an environment variable rather than a table, which is the reuse tenet D8 asks for.

**That store has already refused this exact addition, in its own closing comment.** `backend/lambda/src/lib/channel-context-client.ts:334-346` records that no member count is stored on the item and that a writer for one does not belong there, giving the two `channel-size.ts` grounds. It also records that rows from an earlier deployment can still carry an inert `memberCount`, which is the fossil of this idea having been tried.

**And it is a server-only grounding store rather than a routing store**, which is the other reason to leave it alone. Its header states what it is for and why its contents must never be member-readable (`backend/lambda/src/lib/channel-context-client.ts:4-13`), and its `OWNED_FIELDS` list silently discards anything outside it (`:126-147`). Routing data has a different audience, a different write path and a different failure direction. Tenet D9 asks that two features of the same kind be built the same way; it does not ask that two features of different kinds share a row because the key matches.

**The one thing member-writable Metadata settles by itself**: a routing context cannot live in channel Metadata under any design, because every member holds `chime:UpdateChannel` on a channel they created and the service authorizes on channel-moderator status. That is why the model-routing signals `userLanguage` and `segment` were moved out of Metadata into `ChannelContext` in the first place (`backend/lambda/src/lib/channel-context-client.ts:44-52`). Trusted routing state in Metadata would let a member redirect their own conversation's routing.

### What (A) would legitimately be, and it is a different proposal

There is exactly one fact the flow needs that is per conversation, is not derivable from the message, is not a resource tag, is not in SSM, and is not current conversation state the Amazon Chime SDK owns.

**Which assistant holds the primary role in this conversation.** `resolvePrimaryBotArn` answers it from the classification and says plainly that this is correct only while a room holds one assistant per classification (`backend/lambda/src/channel-flow-processor.ts:168-198`). ADR-030 records the same gap, ADR-034 records it under what it does not settle, and the `@<member>` branch repeats it (`backend/lambda/src/channel-flow-processor.ts:1047-1052`). A room with two assistants of one classification has nowhere to say which is which.

That record would be a genuine routing context, it would be read on the gate the roster read already has rather than on every message, and it would be written once when the conversation is composed rather than maintained as a projection of something else. It is not what was asked about, and it should not be built as a side effect of a proposal aimed elsewhere. It is named here so the useful half of the idea is not lost with the half that is declined.

## (B) Turning the automatic invocation off

### What it reduces to, and what it does not

As established above, `StandardMessages: NONE` is a per-`AppInstanceBot` change applied to every assistant by one deployment. It is ADR-036's option B, and reaching the same outcome in AgentEchelon's own code by flipping the 1:1 branch in `flowOwnsTheTurn` (`backend/lambda/src/lib/flow-bypass.ts:400`) is ADR-038's option C. This record does not restate either; it adds what the two questions establish together.

### What breaks, item by item

**`WelcomeIntent`: not established, and it is a probe rather than a reasoning exercise.** It is a field of `Configuration.Lex` beside `InvokedBy` rather than a value of it, so it is not obviously governed by `StandardMessages`. As first written, ADR-036 named establishing its behavior under `StandardMessages: NONE` as a precondition for option B. (Resolved as to the decision: it is a follow-up rather than a precondition, reported 2026-09-16 in ADR-043 and verified 2026-10-11, see ADR-036, Recorded evidence.) Flipping the flow's 1:1 branch instead leaves `WelcomeIntent` untouched, which is ADR-038's reason for preferring that shape.

**Session attributes: nothing breaks, and this is a gap that has already closed.** The handler echoes what it receives and writes none. The one piece of state that used to ride the Amazon Lex session, an onboarding intake in progress, was moved into `ChannelContext` precisely because the session expired after five idle minutes and a pause mid-intake filed the next answer under the first question (`backend/lambda/src/lib/channel-context-client.ts:100-108`). So the reason the inherited decision in ADR-036 weighed most heavily does not apply here at all, and it applies even less than ADR-036 recorded, because the one counter-example has since moved.

**The intent pack: nothing breaks.** It is AgentEchelon's own classification taxonomy loaded from `ASSISTANT_INTENT_PACK`, not a set of Amazon Lex intents. Amazon Lex is a passthrough and `FallbackIntent` carries every real turn (ADR-036, "What is true today").

**`TargetedMessages: ALL`: nothing breaks, and this is the point people miss.** The two fields are independent, so a private `.` address in a room keeps reaching the assistant it names through the Amazon Lex entry.

**Private 1:1 targeting: this is what breaks, and it is the strongest argument against (B).** In a room the Amazon Lex entry infers that an unaddressed command was targeted from the fact that it was invoked at all, which is what `lexEntryAnswersCommand` is (`backend/lambda/src/lib/private-command.ts:52-55`). In a 1:1 that inference is unavailable, because `AUTO` invokes the entry for every message regardless. Today it costs nothing, because the Amazon Lex entry answers either way and the reply inherits the `Target`. Under (B) the flow answers, so the platform has to re-derive the visibility itself, and the only instrument is `inboundWasTargeted`: a post-release `GetChannelMessage`, up to two reads with a 250 ms pause, which fails toward public (`backend/lambda/src/lib/private-command.ts:102-121`). That puts a channel read plus a deliberate sleep in front of the first frame on every 1:1 turn and gives the check a failure direction that is a disclosure rather than a delay.

**The text-based private check does not rescue it, and the module says so itself.** `flowOwnsTheTurn` stands down for a resolved `.` prefix (`backend/lambda/src/lib/flow-bypass.ts:401-406`), and that check reads text. Its own comment states the limit: the web composer refuses the ambiguous combination, but the flow is not allowed to rely on one client. In a 1:1 the text check is unreachable today because the size branch returns first (`backend/lambda/src/lib/flow-bypass.ts:400`). Under (B) it becomes load-bearing in the one place it cannot be trusted, for a message whose `Target` was set by a client that did not write a dot.

**Anything keyed on the Amazon Lex entry.** Every guard that exists because two entries can see one message has to be re-read rather than deleted: the router's stand-down (`backend/lambda/src/router-agent-handler.ts:1750-1769`), the member-count branch, the `lexEntryAnswersCommand` and `inboundWasTargeted` complement pair, and the duplicate-placeholder claim that reconciles two incomparable correlation ids. Some of those become dead code and some become the only remaining rule, and which is which is not readable from the change itself.

**The channel flow becomes a single point of failure for every turn.** The router's own comment states the exposure: it trusts that the flow ran, and if the flow is not associated to the channel the turn is silenced and nothing answers it (`backend/lambda/src/router-agent-handler.ts:1620-1623`). That is tolerable while it costs `@all` and `/battle`. Extended to every conversation it means a flow that is absent, erroring or throttled takes every conversation silent, where today a 1:1 survives it intact.

**Every 1:1 message pays a roster read on an entry that is about to do nothing.** The router's stand-down is gated on a cheap prefilter today (`backend/lambda/src/router-agent-handler.ts:1671`), so a message with no `@` reads nothing. Widening it to every 1:1 message means `resolveChannelSize`, and up to two calls when the first is unreadable (`backend/lambda/src/router-agent-handler.ts:1689-1700`).

### What it buys, once the already-solved problems are excluded

**It does not buy the avoidance of stray placeholders, and this is worth saying plainly so the case rests on what it actually gains.** An empty Amazon Lex envelope is already dropped at the flow before it becomes a message, by `isEmptyLexEnvelope` plus `callbackDeny` (`backend/lambda/src/channel-flow-processor.ts:352-361`), and a carrying envelope is already unwrapped so what lands in the channel is the text a person would read (`:395`). The duplicate placeholder is already claimed against the correlation marker (`:457`). None of that is a reason for (B).

**It does not buy consolidating turn state off the Amazon Lex session**, because the one piece that lived there has already moved.

**It does not buy the 1:1 duplicate fix**, which is already the member-count branch and is already the root-cause fix for the measured incident.

**What is left is narrower and is real.**

1. **Every turn holds the inbound `MessageId` before it posts anything.** That is ADR-037's determinism property, and it is the exit ADR-037 and ADR-038 both name. It matters most where the current recovery is a search rather than a handover: `findInboundMessage` takes the newest exact content match and can therefore be wrong rather than merely weaker under a queue (ADR-037, "What is not yet true"; ADR-038, "What is true today"). ADR-038's option F narrows that population by bounding the match at the turn's start instant; (B) removes it, because there is nothing to search for.

2. **It is the only change that reaches that population at the carrier rather than at the reader.** ADR-037's amendment endorses deferring the sweep, which fixes the label a reader sees on every entry and every deployment at once and is much cheaper. It does not make the id exact, because a deferred mint still pairs from whatever the turn declared, and a turn that resolved its id by search declared a search result. So (B) and the deferral are not substitutes: one fixes when the reader asks, the other fixes what the turn knows.

3. **One entry instead of two, so a guard is written once.** Every item in the list above that breaks is also an item that stops having to exist in two complementary halves. That is a genuine simplification of the seam, and it is not a latency argument or a correctness argument; it is a maintenance one, and it should be counted as such rather than dressed as either of the others.

4. **The attachment is handed over rather than recovered.** The flow holds `Metadata` and the Amazon Lex entry never sees it, so an attachment is recovered from the channel today (MESSAGE-FLOW section 6.2). Small, and real.

5. **The acknowledgment gains a `Metadata` field.** ADR-038 already prices this as small, because ADR-037's option A carries the same fact in content at no extra call.

**What it does not buy, and cannot**: the `Target`. Neither entry can tell a private 1:1 message from a public one in flight, and (B) moves the answer from the entry that did not need to know to the one that does.

## Do (A) and (B) depend on each other

**(B) without (A) is not blocked by a missing store, and this is the finding that decouples them.** The two facts the flow would need under (B) are the message's `Target` and, in a room with two assistants of one classification, which of them is primary. The first cannot live in a per-channel record at all, because it is a property of one message set by its sender. The second is already needed today and is unrelated to (B). So the thing (B) most needs is precisely the thing (A) structurally cannot supply, and adding (A) would not move (B) one step closer to viable.

**(A) without (B) buys nothing**, because the flow's decisions are already made from the message, the immutable tag, a memoized parameter and a live roster, and the only per-message read a store could displace is the one it must not displace.

**(A) and (B) together is the same as (B) alone**, plus a read in front of every message.

The coherent combinations are therefore three, and the fourth is the one that was asked about.

| Combination | Coherent | Why |
|---|---|---|
| Neither, which is today | Yes | Every routing decision is made from the message, a tag, a memoized parameter, or a live read of current conversation state |
| (B) alone, unconditionally, after its preconditions | Yes | ADR-036 option B and ADR-038 option C. As first judged, blocked on a measurement and on a private 1:1 route that does not fail toward disclosure. Resolved: the measurement is taken 2026-09-16, `TargetedMessages: ALL` keeps the private route, and B1 is TAKEN |
| A per-conversation record of which assistant is primary, read on the gate the roster read already has | Yes | ADR-030's open gap. A different proposal from (A), named so it is not lost |
| (A) as a per-message read for routing data already free | No | Additive on the access boundary, paid in front of message delivery, on the traffic the flow exists to leave alone |
| (B) conditioned on anything mutable | No | Already rejected by ADR-038: the two components that must agree read mutable state at different instants |

## Options

**A1. Build the routing context as asked: a per-channel row the flow reads on every message.** Rejected. It displaces no read it may safely displace, it is paid in front of the person's own message rather than in front of the reply, and the one store it would reuse has already refused this addition in its own closing comment.

**A2. Memoize the classification tag read per container.** Not rejected, and not recommended here. It removes the same call for the same population with no store and no grant, and it is a change to a Layer-1 boundary with a staleness window bounded by container lifetime, which deserves its own decision and its own test rather than arriving as the residue of a declined proposal.

**A3. Record which assistant is primary in a conversation.** Not rejected, and out of scope. The one genuine routing fact that is per conversation and not derivable. It is ADR-030's gap and belongs to ADR-030's successor.

**B1. `StandardMessages: NONE` on every assistant.** TAKEN (see Status and the amendment). It is ADR-036 option B. As first judged here it was not recommended, on ADR-036's then-unmeasured entry comparison, its `WelcomeIntent` probe, and a second blocker from ADR-038. The amendment withdraws the blocker, the entry comparison is taken 2026-09-16, and the `WelcomeIntent` probe is a follow-up, reported in ADR-043 and verified 2026-10-11 (ADR-036, Recorded evidence).

**B2. The same outcome in AgentEchelon's code, by flipping the 1:1 branch in `flowOwnsTheTurn`.** Not rejected, and not recommended here. It leaves `WelcomeIntent` and `TargetedMessages: ALL` untouched, so it needs no probe, and it inherits the same private 1:1 disclosure and the same single point of failure. ADR-038 records it as option C.

**B3. `StandardMessages: NONE` at the app instance.** Rejected because it is not expressible. There is no app-instance-level invocation setting, and recording that is more useful than recording a preference about one.

**B4. Condition the entry on anything per conversation or per moment.** Rejected, and already rejected. ADR-038 established that a conditional entry is not a smaller version of a bypass but a different mechanism with the failure the bypass seam was built to remove.

## Decision

**(A) is declined. (B) is decided as B1 (see Status and the amendment). The points below are the record's reasoning; the amendment withdraws point 5.**

1. **A routing decision is made from the message, from the conversation's immutable tag, from a memoized deploy-time parameter, or from a live read of current conversation state.** Those four are the sources, and a per-channel record is not a fifth. Nothing in the flow's current decision set wants one.

2. **A read is not added in front of `callbackAllow` to save a read behind it.** The flow is synchronous and the release gates the person's own message, so a read there is charged to everyone including the traffic the flow leaves alone. This is ADR-032's latency asymmetry applied to data rather than to rules, and it is stated here because the next proposal of this shape will also be about data.

3. **The automatic invocation is a property of the assistant, and nothing below that level can express it.** `InvokedBy` lives on `AppInstanceBot.Configuration.Lex`. The app instance carries a name and metadata, a channel carries a flow ARN and tags, and a channel flow carries only the power to deny. A design that needs per-conversation or per-moment entry control needs AgentEchelon's own code, which is what `flowOwnsTheTurn` already is.

4. **The entry question stays with ADR-036, and this record adds no reason to skip its measurement.** What it adds is a reason to stop treating (A) as the thing that would unblock (B).

5. **The private 1:1 route is the blocker to design first, and it is not a store.** Until a private message's visibility can be determined by the flow without a post-release read that fails toward public, (B) trades a measured latency question for an unmeasured disclosure one.

6. **The useful half of (A) is named rather than discarded.** Which assistant is primary in a conversation is a real per-conversation routing fact with no home today, and it is ADR-030's to settle.

### Why this is the honest answer and not the cautious one

Both proposals have a real case. (A) is asked because the flow is the one component that sees everything, which is exactly the pull ADR-032 was written about, and it is right that the flow makes routing decisions and should make them well. (B) is asked because one entry is simpler than two and because the ordinary turn's target is genuinely inexact, which ADR-037 and ADR-038 both spend their length on.

What decides both is that the work has already been done nearby and the answers are on the record. The cached member count was tried and is a fossil in a live table. The conditional entry was proposed twice and declined twice. The sweep that races a fact was diagnosed as a carrier shortage and then correctly rediagnosed as a scheduling error, which is the nearer and cheaper half of what (B) would buy. Proposing either of these again without those findings would not be caution, it would be rediscovery.

The one thing this record adds that none of them had is the configuration table at the top. "App instance, not configs" reads as a real choice between two levels, and it is not one: there is only the one level, and knowing that changes what the question was.

## What proves it

- **Existing, and what this record leans on:** `backend/test/lib/flow-bypass.test.ts` pins that the flow and the router decide from one definition, including the 1:1 branch (B2) would flip. `backend/test/flow-does-not-run-the-turn.test.ts` pins the decisions that must not move into the flow, which is the ratchet the (A) proposal pushes against. `backend/test/lib/a-private-command-is-answered-by-the-lex-entry.test.ts` and `backend/test/lib/a-private-address-without-a-target-is-routed.test.ts` pin the two halves of the private-address split that (B) would have to replace in a 1:1. `backend/test/channel-flow-outlasts-router.test.ts` pins the timeout ordering any flow-dispatched turn depends on.
- **Not proven by any of these:** that a routing-context read would cost what this record says it costs. The ordering of the reads against `callbackAllow` is read from the code and is exact; the milliseconds are not measured and no figure is claimed. Also unproven: everything (B) would change, none of which has run anywhere.

## What is not yet true

- **The entry comparison is ADR-036's and ADR-041's, taken 2026-09-16.** Flow-dispatched time to first feedback beats Amazon Lex-entered by a few hundred milliseconds once the prompt is held fixed, which is consistent in direction and not decisive in size. This record does not take it.
- **The per-message cost of the classification read is not measured.** It is one Amazon Chime SDK control-plane call in front of `callbackAllow` on every message, which is established from the code. What it costs in milliseconds, and therefore what A2 would save, is not.
- **`WelcomeIntent` under `StandardMessages: NONE` is verified.** ADR-043 reports on 2026-09-16 that it fires, and the recorded reading of 2026-10-11 confirms it on the default instance: 422 welcomes handled by assistants configured `NONE`/`ALL` (ADR-036, Recorded evidence). It is a follow-up, not a precondition of the decision.
- **The private 1:1 route without the Amazon Lex entry is not designed, and B1 does not need one.** Under `TargetedMessages: ALL` a private message still enters through Amazon Lex, so the blocker this record named, as ADR-038 does, does not arise for the decision taken.
- **The primary-assistant record (A3) is not designed either.** It is named as the one legitimate routing context and nothing beyond that is settled: not where it is written, not who writes it, not what happens when it is absent on a conversation that predates it.
- **Whether a per-container memo on the classification tag is safe is not settled.** The tag is immutable against `UpdateChannel` and is re-written by the admin notification provisioner as a repair path, so the staleness window is bounded by container lifetime on a boundary IAM evaluates. That is a decision with a test, not a note in this record.
- **B1 is built (see Status); nothing else here is.** A2 and A3 are not built.

## Consequences

- **ADR-032's tenets gain a second kind of proposal they govern.** They were written about rules on the critical path; the argument transfers unchanged to data on the critical path, and this record is the worked example.
- **ADR-036's option B gains a configuration fact it did not state.** There is no app-instance-level `InvokedBy`, so "reconfiguring Amazon Chime SDK" means writing the same `Configuration.Lex` block on every assistant, which is what the deployment already does from one place.
- **ADR-038's second blocker is confirmed from the other direction.** This record reaches the private 1:1 disclosure by asking what a routing context could supply and finding that `Target` is the one thing it cannot.
- **ADR-037's exit is narrowed rather than widened.** (B) remains the change that makes the ordinary turn's target exact, and the sweep deferral remains the cheaper half that reaches every entry at once. They answer different halves, and this record says which.
- **`backend/lambda/src/lib/channel-size.ts` gains a recorded second refusal.** A cached routing fact for the flow has now been proposed twice and declined twice for the same two reasons, and the reason it stays a live read is written here as well as in the module header.
- **Revisit when** ADR-036's entry measurement exists, when a private message's visibility can be determined by the channel flow without a post-release read that fails toward public, when a conversation can hold two assistants of one classification and something has to say which is primary, or when the Amazon Chime SDK delivers `Target` to a channel flow or forwards a flow-set attribute into Amazon Lex request attributes.

---

## Amendment (owner, 2026-09-16): (B) was evaluated as the wrong proposal, and evaluated correctly it is not declined on the same ground

"I meant to turn each lex config to standard messages: none."

**The conclusion changes, and it is stated first because a record that quietly reverses itself is worse than one that says it evaluated the wrong thing.** The original (B) section names one blocker above the others: a private 1:1 message loses its visibility guarantee, because the channel flow carries no `Target` and re-deriving privacy means a post-release read that fails toward public. That objection does not survive the corrected proposal. Under `StandardMessages: NONE` with `TargetedMessages: ALL` kept, a private message still reaches the named assistant's Amazon Lex entry exactly as it does today, the flow never has to re-derive anything, and the inference the entry already makes about privacy gets stronger rather than weaker. What is left against (B) is real but smaller, is a duplicate-or-silence question rather than a disclosure one, and is bounded by a rule the tree already contains.

### The owner's reading of the two fields is correct

**`StandardMessages` and `TargetedMessages` are two independent required fields of one structure**, read from the Amazon Chime SDK identity client model in this tree on 2026-09-16 (`InvokedBy` in `@aws-sdk/client-chime-sdk-identity`, `models_0`). `StandardMessages` takes `ALL`, `AUTO`, `MENTIONS` or `NONE`; `TargetedMessages` takes `ALL` or `NONE`. Neither is defined in terms of the other, and the service documents them as separate triggers: `NONE` on the first means the bot processes no standard messages, and `ALL` on the second means the bot processes every targeted message sent to it and replies targeted back to the sender.

**Independent in the model, and read jointly by the service at exactly one corner (measured 2026-09-16, after this amendment was written).** Eight combinations attempted with `CreateAppInstanceBot`: `AUTO`/`ALL`, `NONE`/`ALL` with and without `WelcomeIntent`, `ALL`/`NONE`, `MENTIONS`/`NONE` and `MENTIONS`/`ALL` are all accepted; `NONE`/`NONE` is refused, with and without `WelcomeIntent`, with `BadRequestException: Either RespondsTo or InvokedBy must be set` and `InvokedBy` populated. The service reads an all-`NONE` `InvokedBy` as absent and falls back to requiring the deprecated `RespondsTo`. The full matrix is ADR-041, Appendix A.

**So the paragraph above holds for every pair this record relies on, including the `NONE`/`ALL` the corrected proposal asks for, and it does not hold at the all-`NONE` corner.** No option here proposes that corner, so nothing in this record's reasoning or conclusions moves. What it changes is the standing of the method: the constraint is expressed nowhere in the client model this paragraph reads, nowhere in the botocore service model, and nowhere in the public API reference. **A configuration is established by attempting it. Reading the model establishes what can be typed, not what the service accepts.**

**The deployment writes both in one literal, per assistant, from one place.** `create-bot` sets `InvokedBy: { StandardMessages: 'AUTO', TargetedMessages: 'ALL' }` inside `Configuration.Lex` at create (`create-bot`) and re-applies the identical block on update (`create-bot`). So the corrected proposal is one word changed in two lines, applied to every assistant by the next deployment, and it is exactly ADR-036 option B ("`StandardMessages: NONE` and `TargetedMessages: ALL`", ADR-036 "Options"). The original record already said `TargetedMessages` is independent ("Two things follow that are worth stating separately") and then argued the (B) section as though it were not.

**What stops invoking an assistant, precisely.** Amazon Chime SDK's per-bot routing is drawn in order in MESSAGE-FLOW §5.1 to §5.4, and `StandardMessages` governs two of those rules and not the third:

| Rule | Today | Under `StandardMessages: NONE` |
|---|---|---|
| A message authored by an `AppInstanceBot` (§5.1) | invokes nothing, whatever its `Target` | unchanged, and it is not an `InvokedBy` decision at all |
| The message's `Target` names this bot (§5.2) | `TargetedMessages: ALL` invokes its Amazon Lex entry | **unchanged**, because that field is not being changed |
| `CHIME.mentions` names this bot (§5.2a) | `AUTO` invokes it | stops invoking |
| Exactly one other non-hidden member (§5.3) | `AUTO` invokes it on every message | stops invoking |
| Anything else in a group (§5.4) | invokes nothing | unchanged |

**So the population that stops being auto-invoked is exactly two shapes**: a mention-carrying message in a room, and every message in a 1:1 that carries no `Target`. Nothing else moves.

### The central objection does not apply, and it inverts

**A private message in a 1:1 keeps its in-flight route.** `.Atlas what did we agree` sent with a `Target` is a targeted message, so §5.2 invokes the named assistant's entry and the reply inherits the inbound's targeting. The flow meanwhile stands down, because `flowOwnsTheTurn` returns false for a resolved private address before it reaches any dispatch rule (`backend/lambda/src/lib/flow-bypass.ts:401-406`), and in a 1:1 it returns false one line earlier anyway (`backend/lambda/src/lib/flow-bypass.ts:400`). No component has to re-derive `Target`, `inboundWasTargeted` is not reached on that path, and no read fails toward public.

**The message the flow would newly claim in a 1:1 carries no `Target`, so there is no visibility to lose.** AgentEchelon creates no hidden memberships anywhere in the tree, and `AUTO`'s own test is other non-hidden members (`backend/lambda/src/lib/channel-size.ts`, `ONE_TO_ONE_MEMBER_COUNT`), so a 1:1 here is the person and the assistant and nobody else. An untargeted inbound message is readable by both of them; an untargeted flow-dispatched reply is readable by both of them. The audience is identical, which is the reason the disclosure the original record describes cannot occur at that size. In a room, where the audience genuinely differs, nothing changes: the flow's behavior on a room message is untouched by this proposal.

**The inference the Amazon Lex entry makes about privacy gets stronger.** `lexEntryAnswersCommand` exists because in a room an unaddressed command reaching the entry can only have been targeted, and it carries `&& !isOneToOne` precisely because `AUTO` destroys that inference at the smaller size (`backend/lambda/src/lib/private-command.ts:52-55`, and the module header's part 1). Under `StandardMessages: NONE` the inference holds at every size: if the entry runs on an unaddressed command at all, the message was targeted. The size branch becomes removable rather than load-bearing, which is the opposite of what the original record predicted.

**What the flow genuinely cannot tell apart, stated plainly.** Its callback still carries no `Target` (measured 2026-08-14, `backend/lambda/src/lib/private-command.ts:4-5`), so in a 1:1 it cannot distinguish "targeted, the entry is answering it" from "untargeted, nobody is answering it". Claiming every 1:1 message would double-answer the targeted ones; claiming none would silence the untargeted ones. The failure is a duplicate or a silence, not a disclosure, and both are visible to the person rather than to somebody who should not have seen the message.

**And the rule that resolves it is already written.** `flowOwnsTheTurn` stands down for a resolved `.` address (`backend/lambda/src/lib/flow-bypass.ts:406`), which is unreachable in a 1:1 today only because the size branch returns first. The corrected proposal's 1:1 rule is therefore: claim the turn unless the text resolves a private address. Its two error directions are both already handled. A client that sets a `Target` without writing a dot produces a duplicate, which is the direction the tree already tolerates elsewhere for a command that must not go unanswered (`answeredWhenRosterUnreadable`, `backend/lambda/src/lib/flow-bypass.ts:101`). A client that writes a dot without setting a `Target` produces a silence, and that message is the one `enforcePrivateAddressTarget` already removes and reports to its sender (`backend/lambda/src/lib/private-command.ts:173`), so the person is told rather than ignored.

### What breaks, item by item

**The ordinary 1:1 message is what breaks, and nothing invokes it unless the flow is changed.** Today a person types "hello" in a 1:1 with no mention, §5.3 invokes the assistant's entry, and the router answers. Under the corrected proposal Amazon Chime SDK invokes nothing. The only component that sees the message is the channel flow, so the flow must claim it, which means flipping the 1:1 return in `flowOwnsTheTurn` (`backend/lambda/src/lib/flow-bypass.ts:400`) and reading the roster for a message that carries no `@`, no `.` and no command. That is ADR-038's option C, and it is the whole of the change on AgentEchelon's side.

**`@all` and `@<assistant>` in a 1:1 break the same way and are fixed by the same line.** They are listed separately in ADR-036's table because Amazon Lex carries them today only by way of `AUTO`; once the flow claims every untargeted 1:1 message they are claimed with it.

**A bare `/stop` in a 1:1 is the escape hatch and must be checked deliberately.** `/stop` declares `sizeBranched: true` (`backend/lambda/src/lib/flow-bypass.ts:113-118`), which means the flow stands aside at that size because the router is already the entry there. Under this proposal the router is not the entry there, so the size branch becomes the thing that silences the escape hatch. This is the same defect the registry's own header describes for a command nobody wired, arriving in a command that is wired.

**A bare `#<n>` reference in a 1:1 breaks on a stated premise that stops being true.** `resolveReferenceTarget` returns null for a 1:1 on the grounds that "a 1:1 already reaches its assistant" (`backend/lambda/src/channel-flow-processor.ts:1285-1291`, guard at `:1312`). Under the corrected proposal that premise is false unless the new 1:1 claim covers the reference too. It would, since a reference-only message is untargeted, but the guard's comment would then be wrong and the ordering of the two rules has to be settled rather than assumed.

**`WelcomeIntent` is still a probe, and this record does not resolve it.** (Resolved as to the decision: the probe is a follow-up rather than a precondition. ADR-043 reports on 2026-09-16 that the welcome fires under `StandardMessages: NONE`, and the recorded reading of 2026-10-11 confirms it, see ADR-036, Recorded evidence.) It sits in `Configuration.Lex` beside `InvokedBy` rather than inside it, and it fires on the assistant being added to a channel rather than on a message, so there is a reasonable expectation that a message trigger does not govern it. That is a reading and not a measurement, and ADR-036 as first written named the probe as a precondition for option B. The adjacent fact this tree does establish is narrower: the two are independently settable in the same block, because a bot created with `WELCOME_INTENT=''` omits `WelcomeIntent` while keeping `InvokedBy` unchanged (`create-bot`, `:85-86`). That establishes independence of authorship, not independence of behavior. If the welcome does stop firing, the onboarding intake that starts there stops with it (`backend/lambda/src/router-agent-handler.ts:1931` onward), which is a user-visible loss and not a latency question. The first-real-turn greeting is deliberately not on `WelcomeIntent` (`backend/lambda/src/router-agent-handler.ts:410`) and reaches the same handler from either entry, so it survives.

**The duplicate-fulfillment replay stays needed and its population shrinks.** It exists because Amazon Lex can fulfil one entry twice, and it replays the same placeholder rather than going silent (`backend/lambda/src/router-agent-handler.ts:611-618`). Under the corrected proposal Amazon Lex fulfillments happen only for targeted messages and the welcome, so the shape it guards becomes rarer without becoming impossible. It is not dead code.

**Everything keyed on two entries seeing one message has to be re-read rather than deleted**, and this part of the original record stands: the router's stand-down (`backend/lambda/src/router-agent-handler.ts:1671-1769`), the member-count branch, and the `lexEntryAnswersCommand` and `inboundWasTargeted` complement pair (`backend/lambda/src/lib/private-command.ts:52-55`, `:102-121`). What the amendment adds is which way each moves: the complement pair stays needed in a room and its 1:1 exemption becomes removable, and the member-count branch stops having a duplicate to prevent at the size it was written for.

### What it buys, net of what is already solved

**1. It reaches the residual determinism population, and the flow does hold the message id for it.** ADR-037 amendment 2 and ADR-038 narrow the gap to one population: an ordinary Amazon Lex turn, not answered `DIRECT` from the handler, that opens no task and does not queue. On a default deployment that turn is handed no id and declares nothing on either of its message events. The corrected proposal moves exactly that turn to the flow, and the flow holds the inbound `MessageId` from its callback and passes it: `userMessageId: MessageId` on the dispatch (`backend/lambda/src/channel-flow-processor.ts:857`) becomes the `AE.message.id` request attribute (`backend/lambda/src/router-agent-handler.ts:1091`), which `inboundMessageId` reads (`backend/lambda/src/router-agent-handler.ts:1208`) and which `placeholderContent` declares with no turn-queue gate (`backend/lambda/src/router-agent-handler.ts:3520`). So the answer is yes on both halves of the question, and it is the only change that reaches that population at the carrier rather than at the reader. This is unchanged from the original record and is restated because it is now the case's strongest leg rather than its consolation.

**2. It removes the empty Amazon Lex envelope and everything spent handling it, which the original record did not count.** A fulfillment that returns `messages: []` is still a message send: Amazon Chime SDK materializes one message per turn from the last fulfillment response, so an empty array becomes a channel message, the flow is invoked for it, `isEmptyLexEnvelope` recognizes it and `callbackDeny` stops it (`backend/lambda/src/lib/lex-envelope.ts:67`, `backend/lambda/src/channel-flow-processor.ts:386-394`, MESSAGE-FLOW Appendix A). That is a send, a Lambda invocation and a `ChannelFlowCallback` to produce something nobody sees. It happens only on the Amazon Lex entry: a flow-entered turn returns its silence to the flow as a Lambda return value and posts its own message directly (`backend/lambda/src/router-agent-handler.ts:1460`, `postAsAssistant`), so no envelope is materialized. Under `StandardMessages: NONE` the untargeted turns stop entering through Amazon Lex, so every envelope those turns would have produced stops existing. The flow is still invoked for the person's own message, exactly as it is today, so that invocation is not a saving and is not counted here.

**Where that cost actually lands, established rather than asserted.** It does not reach analytics: a message is mirrored to the stream once released (MESSAGE-FLOW §5, §9.1) and a denied message is never released, so nothing counts it and no figure is inflated. It does not reach any control this platform enforces: the per-user hourly limit and the budgets are metered by the router on a turn it is about to dispatch and by the flow only for the duel fan-out (`docs/specs/interaction/governance/SPEC-ABUSE-CONTROLS.md`, "Per-user hourly request limit"), and the envelope is authored by Amazon Chime SDK on the bot's behalf rather than by any AgentEchelon send, so no limit sees it. What it does cost is one channel-flow Lambda invocation and one `ChannelFlowCallback` per occurrence, on a function whose concurrency is sized for the request path (`backend/lib/stacks/channel-flow-stack.ts:303-308`). Whether the send itself counts against an Amazon Chime SDK quota or bill is not established from this tree and no figure is claimed for it.

**How often it happens, and why the recorded zero is not the whole answer.** MESSAGE-FLOW Appendix A measures 736 flow invocations over seven days with zero empty-envelope drops, and lists two producers: the Battle stack's alt handler (since deleted), and an Amazon Lex entry standing down for the flow. That list is incomplete against the code. Six further returns of `formatLexSilentResponse` are reachable on an Amazon Lex entry: the queue notice when the handler posted it itself (`backend/lambda/src/router-agent-handler.ts:4374`, `:4379`), a stop acknowledgment corrected in place (`:3440`), a completed handover (`:2830`), a reference that named nothing answerable (`:2783`), a duplicate of a gate-blocked fulfillment (`:4064`), and the roster-unreadable stand-down (`:1727`). The zero is consistent with all of them, because the queue is off by default (`-c turnQueue=true`, `backend/lib/stacks/agent-classification-common.ts:391`, `:405`) and the others are exception paths. **So this is a cost the current design pays once the turn queue is switched on, and in a 1:1 it is paid on every queued message**: the flow stands aside on the turn, the queued send's silent fulfillment still lands, and the flow still has to deny it. The corrected proposal removes it rather than relocating it, because the flow-entered turn has no envelope to produce in the first place. Appendix A's producer list is a doc gap and is worth correcting whatever is decided here.

**3. One entry instead of two for the untargeted population, so a guard is written once.** Unchanged from the original record, and it is a maintenance argument rather than a correctness or latency one.

**4. The attachment is handed over rather than recovered, and the acknowledgment gains a `Metadata` field.** Both small, both unchanged.

**5. A mention-carrying room message stops paying for an entry that immediately stands down.** Today `@Atlas draft this` in a room invokes the assistant's entry through §5.2a while the flow also dispatches it, and the router then reads the roster (`backend/lambda/src/router-agent-handler.ts:1689-1700`) purely to discover that the flow owns the turn and return silence (`:1766`). Under the corrected proposal that invocation, that roster read and that envelope all stop. This is a saving the original record did not name because it was arguing about the 1:1.

**What it still does not buy**: nothing in the "already solved" list moves. The stray placeholder is already dropped at the flow, the correlation claim already reconciles a duplicate, the Amazon Lex session already holds no turn state, and the 1:1 duplicate is already fixed at the root by the member-count branch.

### What it costs

**Priced against MESSAGE-FLOW §4.18 as it stands on 2026-09-16, while another agent is reducing that cost.** The floor stated there is one `ChannelFlowCallback`, one `chime:ListTagsForResource` and a container-cached SSM read for a person's message, with the roster read gated behind a prefilter so ordinary chatter pays none. Any figure below is against that version and will need re-reading against the reduced one.

**The roster read moves from a branch onto every person's message.** The flow cannot decide whether to claim a turn without knowing whether the conversation is a 1:1, and `isOneToOne` comes only from a live `chime:ListChannelMemberships`, up to ten pages (P7). A cached or event-written count is refused on two independent grounds recorded in the module itself (`backend/lambda/src/lib/channel-size.ts`, the `resolveChannelSize` header), and the original record's (A) section is the second refusal. So the prefilter gate at `backend/lambda/src/channel-flow-processor.ts:609-621` stops being a gate, and the floor for a person's message becomes one `ChannelFlowCallback`, one `ListTagsForResource`, one to ten `ListChannelMemberships` pages, and the cached SSM read. In a room where people are talking to each other, that read is paid on traffic the flow will still leave alone.

**Where it lands is a design choice this proposal opens, and the tree already has the pattern.** As the code stands, every read precedes the release at `backend/lambda/src/channel-flow-processor.ts:785`, so a roster read there would sit in front of the person seeing their own words. It does not have to: the private-address check releases first and reads after, deliberately, because holding the message costs delivery (`backend/lambda/src/lib/private-command.ts:141-149`). A 1:1 claim decided after release would put the roster read in front of the turn rather than in front of the message, which is where the Amazon Lex hop sits today. The original record's decision point 2, "a read is not added in front of `callbackAllow` to save a read behind it", is therefore not violated by the corrected proposal; it constrains where the read goes.

**Which makes the latency question the same one ADR-036 names.** (Resolved: ADR-036 and ADR-041 take it on 2026-09-16; flow-dispatched time to first feedback beats Amazon Lex-entered by a few hundred milliseconds once the prompt is held fixed.) After release, today's path is Amazon Chime SDK invoking Amazon Lex and Amazon Lex fulfilling into the handler; the proposed path is one `ListChannelMemberships` plus one `RequestResponse` Lambda invoke. Which is faster to first feedback is exactly ADR-036's comparison, plus one membership read. No figure is claimed in this amendment; ADR-041 Appendix G carries the measured one.

**Plus the per-dispatch costs the flow already pays on its other branches**: one conditional `PutItem` for the delivery claim (P12) and one `RequestResponse` invoke of the classification's router (P15 to P18), now on every 1:1 turn rather than on `@all`, `@<assistant>`, a room command and a reference.

**Against which the envelope saving above is a genuine offset rather than a rhetorical one**, and on a deployment with the turn queue on it is the larger of the two in a 1:1, because a queued message costs a send, a flow invocation and a deny today and costs none of the three under the proposal.

### The single point of failure, and `FallbackAction: CONTINUE` makes it worse rather than better

**Today a flow failure costs `@all`, `/battle`, a room mention and a reference, and a 1:1 survives it intact**, because Amazon Chime SDK invokes the assistant's entry whatever the flow does. The router's comment records the exposure from its own side: it trusts that the flow ran, and a channel with no flow associated silences the turn there and nothing answers it (`backend/lambda/src/router-agent-handler.ts:1620-1623`). Under the corrected proposal that sentence widens to every ordinary turn, because there is no second entry left to catch one.

**`FallbackAction: CONTINUE` is what makes the failure quiet.** A message the flow has not resolved when the 35 second deadline passes is delivered unprocessed (`backend/lib/stacks/channel-flow-stack.ts:303`, `:497`). Today that is the benign direction: the person's words reach the room, the mention rules are skipped, and in a 1:1 Amazon Lex still fires, so the turn still happens. Under the corrected proposal the same fallback delivers the person's message and starts no turn at all, so the person sees their own words land and then waits on an assistant that was never invoked. The failure presents as an assistant thinking, not as an outage. `DENY` is not the alternative: it would take the person's own words out of the conversation, which MESSAGE-FLOW §4.7 and the router's comment both refuse for anything a person said.

**So the honest statement is that the corrected proposal concentrates the whole turn path on one component whose failure mode is silence, and that the existing fallback converts an outage into a slow assistant.** That is a monitoring requirement, not a design blocker, and it is the thing to design before the entry is narrowed rather than after.

### The `.`-prefix options, against what is already built

The owner named two, in the same breath as the corrected proposal.

**"All dot prefixed messages also get a get channel message call to confirm target" is the check that shipped on 2026-09-15.** `enforcePrivateAddressTarget` releases the message once, reads it back as the assistant with one retry and a 250 ms pause, deletes an untargeted one using the app-instance admin as bearer, and tells the sender in the deployment's configured copy (`backend/lambda/src/lib/private-command.ts:141-222`, called at `backend/lambda/src/channel-flow-processor.ts:697`). It is gated on a `.` that resolved to a real member other than the sender, so ordinary traffic pays nothing. This option is therefore not a proposal; it is the as-built state, and the measured facts behind each part of it are recorded in the module: a held message cannot be read at all, the assistant's delete on a person's message is refused while the admin's succeeds, and a message correctly targeted at another person is unreadable to the assistant and to the admin alike.

**"Assumed targeted, and the handler can reject or respond properly privately after checking" is a different trade, and it is strictly narrower.** It moves the check from the flow to the entry that was invoked. The entry is invoked only when the message carried a `Target` naming that assistant, so it can only ever see the messages that are already correct. The disclosing direction, a dot-prefixed message with no `Target`, invokes no entry: in a room nothing is invoked because §5.4 applies, and under the corrected proposal nothing is invoked in a 1:1 either. A message addressed `.Alice` with no `Target` invokes nothing under any configuration, because no assistant is its target. So the handler cannot reject what it never receives, and the disclosure stands. The premise the option rests on, that a dot prefix may be assumed to carry a `Target`, is the one thing `private-command.ts` exists because it measured false.

**But one reading of it is useful, and it is the rule the corrected proposal needs.** If "assumed targeted" is taken as a statement about what the FLOW does rather than about what the handler does, it is precisely the 1:1 stand-down described above: the flow treats a resolved dot as targeted, stands aside, and lets the entry answer. That rule is already written at `backend/lambda/src/lib/flow-bypass.ts:401-406` and is unreachable in a 1:1 only because the size branch returns one line earlier. So the two clauses are not alternatives to each other and neither replaces the built check: one of them IS the built check, and the other is the flow-side rule that makes the corrected proposal safe at the size it changes.

**What neither option addresses, and it is unchanged.** A client may set a `Target` without writing a dot, and the service will deliver that message privately with no backend rule objecting (`backend/lambda/src/lib/private-prefix.ts:35-38`). Under the corrected proposal that message is the duplicate case in a 1:1: the entry answers it privately and the flow answers it publicly-to-a-room-of-two. The person sees two answers, both of which they were entitled to see. That is the residual, and it is worth stating as the price rather than leaving it implied.

### (C) Never queuing a targeted message

"We can also consider never queuing targeted messages."

**The narrow version of this is already built, and that is the finding to read first.** The turn lock is keyed on the conversation AND the resolved responder, never on the conversation alone: `backend/lambda/src/lib/turn-lock.ts:2` states it in its first line and `:9-15` gives the reason, and ADR-033 states it twice in its own terms ("the lock is keyed on the conversation AND the resolved responder, with one deliberate exception: `/battle`", and in its assertion table, "a message addressed to a DIFFERENT assistant is answered while the first is busy"). So a targeted message naming an assistant that is not the one holding the turn is answered immediately today, queue or no queue. The smaller proposal the coordinator named as possibly the correct one is not a proposal; it is the as-built state, and the reason it was built that way is the same one the owner is reaching for: busy is a property of a responder, not of a room.

**What is left of (C) is therefore one case: a targeted message addressed to the assistant that is holding the turn.** That is the only message the change would newly let run, and it is a genuine exception to ADR-033 rather than a refinement of it.

**The steelman, and where it holds.** A `Target` is what makes a message private (ADR-034, and `backend/lambda/src/lib/private-command.ts`), the recipient set is the sender plus the target, and a reply on the Amazon Lex path inherits the inbound's targeting (MESSAGE-FLOW §5.2). Verified in the tree rather than taken on trust: ADR-033 already applies exactly this reasoning three separate times, to the task a targeted request opens, to the queued affordance a client renders, and to the confirmation a stop posts. So the room genuinely sees neither half of a private exchange, and a private turn running beside a public one is invisible to every member who is not its sender.

**And where it does not hold, which is the common case.** ADR-033's opening defect is a person sending a second message before the first is answered, getting two turns, and being handed two answers that may contradict each other (`backend/lambda/src/lib/turn-lock.ts:4-7`). Privacy does not help there, because the sender is on both sides: they see the public turn they started and the private turn they started, and they are the person the invariant protects. The steelman holds only when the two messages come from DIFFERENT people, one public and one private, and the private half never doubles up on the same person's own work.

**So ADR-033's commitment is not "one visible answer at a time", and the ADR says so structurally.** Its lock is keyed on the responder and its stop marker is keyed on conversation, person and responder (`backend/lambda/src/lib/turn-lock.ts:1989-1999`, ADR-033 "The stop record is therefore keyed by conversation, person, AND responder"). A design whose commitment were visibility would key on the audience; this one keys on who is doing the work. The commitment is the assistant's own consistency: one turn's state at a time, for one responder, in one conversation. A parallel private turn for the same responder is a violation of the letter and of the spirit.

**What breaks mechanically, and it is not a list of edge cases.**

- **The state record cannot represent two turns.** There is exactly one lock row per conversation per responder, carrying one `holderAt` and one queue. A second, unlocked turn is not in it, so the busy signal, the queue depth and the client's turn state all describe one of the two and are silent about the other.
- **The queue notice has no placeholder to live in.** The first message to queue behind a running answer writes its notice into that answer's placeholder (`findHolderPlaceholder`, ADR-033 "The notice lives in the running answer's placeholder"). With two turns running there are two placeholders and one holder record, so the notice can land on the wrong one. ADR-033 already carves out the case where the running turn answers a private request and posts the notice as its own message; that carve-out was written for one turn, not two.
- **`/stop` is the least broken of them, and only by accident.** The marker is keyed by person and responder, and `selectStoppableTasks` picks work by requester and assistant (ADR-033's amendment on the same point), so one person's stop does not reach another's private work. What does break is the acknowledgment: a stop is confirmed to the room and names how many items were cancelled, and a count that silently excludes somebody else's private work is a count that means two different things depending on who reads it.
- **The takeover has nothing to take over.** A turn that holds no lock leaves no `holderAt` to go stale and no payload for `turn-lock-release-on-failure.ts` to release, so a private turn killed by the platform is recovered by nothing. Today every turn is covered because every turn claims.
- **Task visibility is the one thing that does not break**, because it is inherited from the request rather than from the turn (`backend/lambda/src/lib/task-visibility.ts`, and ADR-033 "a task inherits the visibility of the request that created it"). Two concurrent turns open two tasks with two visibilities, correctly, without either knowing about the other.

**Cost and abuse: the spend shape changes, and nothing bounds the new dimension.** Every control in `docs/specs/interaction/governance/SPEC-ABUSE-CONTROLS.md` is a VOLUME limit: a per-user hourly request count, a per-user hourly model-call budget, a global hourly budget, a dedup claim and an inbound length cap. None of them bounds simultaneity, and the spec contains no concurrency control at all. Today the queue is what bounds it: at most one turn in flight per responder plus `TURN_QUEUE_MAX` waiting, default 5 (`backend/lambda/src/lib/turn-lock.ts`, `QUEUE_MAX`). Under (C), ten targeted messages sent during one long turn start ten concurrent turns for one responder in one conversation. The hourly limit still refuses the eleventh-to-the-hour, so the spend is bounded over an hour and unbounded over a second, which is a different shape on processor concurrency and on Bedrock throughput. **So a targeted lane needs its own bound**, and the honest form of it is a concurrency cap per responder per conversation rather than a queue, because a lane whose whole point is not waiting cannot be bounded by making it wait.

**What it buys, measured honestly: nothing yet, on any deployment.** `TURN_QUEUE_ENABLED` defaults off and ADR-033 records it off in every environment (`backend/lib/stacks/agent-classification-common.ts:391`, `:405`). No targeted message has ever queued, so "how often does this happen" has the answer zero and no instrument would change that until the queue ships. The product improvement is real in principle, a person who addresses an assistant directly is not made to wait on somebody else's turn, and it is unmeasurable in practice until the thing it improves is switched on. That is an argument for deciding it after the queue is enabled, not before.

**The determinism interaction is small and runs the wrong way.** The coordinator's premise, that `userMessageId` reaches the processor only under the turn queue, is the misreading ADR-037's second amendment already corrected: the hand-off is gated on `AE.message.id` being declared by a bypass caller (`backend/lambda/src/router-agent-handler.ts:3382-3383`, `:3522`), not on the queue flag, and an ordinary Amazon Lex turn resolves its id by content match either way. What the queue does carry is ids: it holds message ids and never content (`backend/lambda/src/lib/turn-lock.ts`, "THE QUEUE HOLDS IDS, NEVER CONTENT", and ADR-033 "A drain carries the message's ID and never its text"). So a targeted message that queues has its id recorded by the drain, and one that never queues is answered by an ordinary Amazon Lex turn that declares nothing. **(C) therefore enlarges ADR-037's residual population slightly rather than shrinking it.** Small, real, and worth stating because (B)'s whole determinism case runs the other way.

**The conclusion on (C).** Rejected in the form proposed, because the only case it actually changes is the one ADR-033 settled for reasons privacy does not answer, and because it removes the bound on concurrency without proposing another. The narrower version is already built. If the case is revisited, the shape to evaluate is not "never queue a targeted message" but "allow N concurrent turns per responder per conversation, with the state record able to hold N", which is a change to the lock's cardinality rather than an exemption from it, and which would make the notice, the takeover and the stop confirmation correct by construction instead of by carve-out.

### How the three proposals depend on each other

| | Depends on | Stands alone |
|---|---|---|
| **(A)** a per-channel routing context | nothing | Yes, and it is declined. It supplies nothing (B) needs, because `Target` is a property of one message |
| **(B)** `StandardMessages: NONE` per configuration | a flow-side 1:1 rule, which is already written and one line out of reach | Yes. It needs neither (A) nor (C) |
| **(C)** never queuing a targeted message | nothing, and its narrow form is already built | Yes, and it is declined. It is entered from both entries, so it is indifferent to (B) |

**(B) and (C) compose in presentation rather than in mechanism.** Under (B) the targeted message is the only shape left on the Amazon Lex entry, so "targeted goes straight through, standard goes through the flow" reads as one clean split by addressing. That legibility is genuine and it is not an argument: the per-responder lock already gives the practical half of it, and the half (C) would add is the half ADR-033 refuses. The split (B) produces on its own is legible enough without it.

### The options, revised

**B1 is renamed and re-judged.** The original B1 read "`StandardMessages: NONE` on every assistant", which is the correct proposal, and then inherited the (B) section's reasoning about a disclosure that does not arise. Re-judged, it is **not rejected**, it no longer waits on the private 1:1 route, and it is TAKEN (see Status). The three things this amendment names:

1. **ADR-036's entry measurement.** Taken 2026-09-16 (ADR-036, ADR-041).
2. **The `WelcomeIntent` probe.** Reported 2026-09-16 in ADR-043 that it fires under `StandardMessages: NONE`, and verified 2026-10-11 on the default instance: 422 welcomes handled by assistants configured `NONE`/`ALL` (ADR-036, Recorded evidence). A follow-up to the decision, not a precondition of it.
3. **A monitoring answer for the silent-flow failure**, which is new in this amendment. **OPEN**, and a follow-up to the decision rather than a precondition of it.

**B2 is unchanged in shape and gains a reason to prefer it less.** Flipping the 1:1 branch in `flowOwnsTheTurn` reaches the same routing outcome in AgentEchelon's own code and needs no probe. What it does not reach is the empty envelope: Amazon Chime SDK still invokes the entry on every 1:1 message, so the entry still runs, still stands down, and still materializes an envelope for the flow to deny. B2 therefore buys the determinism property and the single entry while keeping the waste, and it doubles the invocations rather than halving them. B1 is the one that removes the send.

**B3 and B4 are unchanged.** There is still no app-instance-level `InvokedBy`, and a conditional entry is still a different mechanism rather than a smaller bypass.

**(A) is unchanged in every respect.** Nothing in the corrected proposal makes a per-channel routing context more useful, and the decoupling finding holds for the same reason: `Target` is a property of one message and a per-channel record cannot hold it. What does change is that the corrected proposal needs the roster on every message, which is the one read a store may not displace, so (A) and (B) remain independent and (A) remains declined.

### What this amendment does not change

The (A) analysis, the configuration-level table, decision points 1, 2, 3, 4 and 6, and every "What is not yet true" entry except the fifth. Decision point 5, "the private 1:1 route is the blocker to design first, and it is not a store", is **withdrawn**: under the corrected proposal the private 1:1 route is unchanged from today, and the blocker to design first is the flow's own failure mode.

### What is not yet true, added

- **Nothing here has been measured.** The envelope count is read from code paths and from Appendix A's seven-day window, which was taken with the turn queue off. How often a silent fulfillment occurs on a deployment with it on is not measured.
- **Whether the denied send counts against an Amazon Chime SDK quota or bill is not established.** What is established is that it reaches no analytics figure and no platform rate or budget limit.
- **The duplicate case is reasoned, not observed.** The deployment runs `StandardMessages: NONE`, verified 2026-10-11 (ADR-036, Recorded evidence), so the configuration the case depends on is live. The case itself has no recorded observation, and the frequency of a client setting a `Target` without a dot is unknown.
- **The flow's failure rate is not characterized.** The exposure widens under the corrected proposal, and there is no figure for how often the flow fails today.
