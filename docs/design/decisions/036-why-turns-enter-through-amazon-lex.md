---
title: "ADR-036: Why an assistant turn enters through Amazon Lex, and when it does not"
status: >-
  Accepted 2026-09-17 - option B, narrow Amazon Lex to targeted messages. Every assistant is created with `StandardMessages: NONE` and `TargetedMessages: ALL` (`assistantBotConfiguration` in `backend/lambda/src/lib/assistant-identity.ts`, called by the provisioner for every identity, with no per-profile switch), and the channel flow dispatches every untargeted turn, every 1:1 included (`flowOwnsTheTurn`, `lib/flow-bypass.ts`). Amazon Lex carries a targeted message and the welcome. Bypassing Lex on every turn (option C) is REFUTED: Amazon Chime SDK refuses an `InvokedBy` with both members set to `NONE`, measured across eight combinations, so at least one axis stays live and no configuration reaches Lex by the welcome alone. The entry comparison is TAKEN: flow-dispatched time to first feedback beats Lex-entered by 334 ms once message length is held fixed (95% CI -8 to 676) and by 896 ms uncontrolled, which against a one second target is material and is not decisive on its own. The code provisions `NONE`/`ALL`, and the deployed `InvokedBy` is verified 2026-10-11: all eight assistants on the default instance read `NONE`/`ALL` (Recorded evidence). `WelcomeIntent` firing under `StandardMessages: NONE` is verified 2026-10-11: 422 welcomes handled by assistants configured `NONE`/`ALL` between 2026-10-07 and 2026-10-11 (Recorded evidence). Two follow-ups are **OPEN**, and neither is a precondition of the decision: monitoring for a channel flow that is the only entry for standard messages, and the Lex leg isolated from the handler, which no analytics query returns. ADR-041 carries both measurements and records the same decision. The reasoning is kept because it is why the entry existed.
date: 2026-09-15
related:
  - "./011-agent-routing-mechanism.md"
  - "./022-message-identity-is-established-at-the-channel-flow.md"
  - "./029-clarification-is-public-and-answers-get-their-own-placeholder.md"
  - "./032-where-a-rule-runs.md"
  - "./033-a-conversation-answers-one-turn-at-a-time.md"
  - "./034-addressing-a-message-is-not-making-it-private.md"
  - "./035-a-reply-names-the-work-it-answers.md"
  - "./037-a-turn-declares-what-it-answers-on-the-message-it-is-already-posting.md"
  - "./038-a-turn-answers-the-message-that-was-there-when-it-started.md"
  - "./039-a-routing-decision-is-made-from-the-message.md"
  - "./041-simplifying-how-a-message-reaches-an-assistant.md"
  - "../../guides/developer/MESSAGE-FLOW.md"
  - "../../guides/developer/LATENCY-TARGETS.md"
  - "../../specs/interaction/governance/DESIGN-ADMIN-AGENT-NOTIFICATIONS.md"
  - "../../../backend/lambda/src/router-agent-handler.ts"
  - "../../../backend/lambda/src/channel-flow-processor.ts"
  - "../../../backend/lambda/src/lib/flow-bypass.ts"
  - "../../../backend/lambda/src/lib/router-arn.ts"
  - "../../../backend/lambda/src/admin-agent-lex-handler.ts"
  - "../../../backend/lambda/src/lib/assistant-provisioner.ts"
  - "../../../backend/lambda/src/lib/assistant-lex-bot.ts"
  - "../../../backend/lib/stacks/admin-services-stack.ts"
---

# ADR-036: Why an assistant turn enters through Amazon Lex, and when it does not

> **Amended 2026-10-23.** `create-bot` and `create-lex-bot`, the deploy-time provisioners this record cites, are removed: no stack owns an assistant identity, and every identity and Amazon Lex bot is built by the provisioner (`backend/lambda/src/lib/assistant-provisioner.ts`, [ADR-048](./048-an-assistant-is-not-a-classification.md), amended 2026-10-23). The line numbers cited for them are of the removed files. The behavior cited is unchanged: every identity is built with `StandardMessages: NONE` and `TargetedMessages: ALL`.

## Status

**Accepted (2026-09-17): option B, narrow Amazon Lex to targeted messages.** Every assistant identity is built by the provisioner (`backend/lambda/src/lib/assistant-provisioner.ts`) with `InvokedBy: { StandardMessages: 'NONE', TargetedMessages: 'ALL' }` (`assistantBotConfiguration` in `backend/lambda/src/lib/assistant-identity.ts`, whose default is `NONE`), and no per-profile setting exists. The channel flow claims every untargeted 1:1 turn unconditionally and never a targeted one (`flowOwnsTheTurn` in `lib/flow-bypass.ts`). Amazon Lex carries a targeted message and the welcome; the channel flow starts every other turn. Verified by `backend/test/lib/a-flow-entry-profile-owns-its-one-to-one-turn.test.ts` and `backend/test/a-targeted-turn-is-separable-from-a-standard-one.test.ts`. ADR-041 records the same decision with its full measurements. The code provisions `NONE`/`ALL`, and the deployed `InvokedBy` is verified 2026-10-11 on the default instance (see "Recorded evidence").

**What settles it.** Option C is refuted by measurement, so option B is the narrowest configuration that exists. The entry comparison is taken and favors the flow by a few hundred milliseconds, which supports the direction and does not carry it alone. What carries it is the countable simplification ADR-041 records: the double-decided routing cells go from eleven to five, and every untargeted turn declares its inbound message id. The entry is separable in the analytics read path through `turn_entry` (migration 054).

**Follow-ups, not preconditions of the decision:**

- **The deployed `InvokedBy`. Verified 2026-10-11 (Recorded evidence).** `DescribeAppInstanceBot` on each of the eight assistants on the default instance reads `StandardMessages: NONE` and `TargetedMessages: ALL`.
- **`WelcomeIntent` under `StandardMessages: NONE`. Verified 2026-10-11 (Recorded evidence).** The router logged 422 handled welcomes across the three classifications between 2026-10-07 and 2026-10-11, after every assistant's `InvokedBy` was last set to `NONE`/`ALL`.
- **Monitoring for a channel flow that is the only entry: built, not yet deployed.** The processor is associated with `FallbackAction: CONTINUE`, so a flow failure delivers the person's words and starts no turn, with no Amazon Lex entry behind it. `channel-flow-stack.ts` alarms on the processor's errors, its throttles, and its occupancy at 80% of the reserved concurrency (Verified by: `cdk-synth.test.ts`, "the channel-flow processor has error, throttle and occupancy alarms on itself").
- **OPEN: the Lex leg isolated from the handler** (criterion 1b). The read path exists: `latency_exchanges` returns `router_ms`, `ttff_ms` and `turn_entry` on one row. The measurement is `tests/e2e/the-lex-leg-is-measured-per-turn.spec.ts` (`LEX_LEG_E2E=1`), and it has not been run.

**The reasoning below is kept**, because why the Lex entry existed, and which of the inherited reasons hold for AgentEchelon, is what this record is for. Where a section below describes `StandardMessages: AUTO` invoking an assistant, it describes option A, the hybrid this record does not take.

**Two measurements, both 2026-09-16, both reported in full by ADR-041 and cited rather than retaken here.** An eight-combination probe of `CreateAppInstanceBot` establishes that `InvokedBy` cannot have both members set to `NONE`, which refutes option C. A thirty-day read of the deployed signed analytics path establishes the entry latency difference, which satisfies half of decision criterion 1.

## Recorded evidence

Read-only readings taken 2026-10-11 on the default instance, `agent-echelon`, in us-east-1. They settle the deployed `InvokedBy` and `WelcomeIntent` under `StandardMessages: NONE`.

**E1. The deployed `InvokedBy`.** Listed the instance's assistants, then described each one:

```
aws chime-sdk-identity list-app-instance-bots --app-instance-arn <the instance's app instance ARN>
aws chime-sdk-identity describe-app-instance-bot --app-instance-bot-arn <each AppInstanceBot ARN>
```

All eight `AppInstanceBot`s read `Configuration.Lex.InvokedBy = {"StandardMessages":"NONE","TargetedMessages":"ALL"}`: Concierge, Analyst and Advisor (the three classification primaries), Alt-basic-primary, Alt-standard-primary and Alt-premium-primary (the battle alts), AdminAgent (the admin assistant) and Assistant-probe (the probe classification). The last configuration update is 2026-10-07 for seven of them and 2026-10-11 for Analyst. On 2026-10-12 Assistant-probe, which no stack defines and which holds no channel membership, is deleted together with its Lex bot (`aws chime-sdk-identity delete-app-instance-bot`, `aws lexv2-models delete-bot`); the seven that remain are the ones the app deploys.

**E2. `WelcomeIntent` under `StandardMessages: NONE`.** CloudWatch Logs Insights over every `/aws/lambda/AgentEchelonClassification-*-AgentHandler*` log group (retention: never expire), window 2026-10-07T23:00Z, after the assistants' `InvokedBy` was last set, to 2026-10-11:

```
filter @message like "[Router][WelcomeIntent] participants" | parse @log /AgentEchelonClassification-(?<cls>[A-Za-z]+)-AgentHandler/ | stats count() as welcomes, min(@timestamp) as first, max(@timestamp) as last by cls
```

Result: 422 handled welcomes, premium 307, basic 76 and standard 39, the first at 2026-10-07 23:14Z and the last at 2026-10-11 13:34Z. The router's `WelcomeIntent` branch (`router-agent-handler.ts`, the `lexIntentName === 'WelcomeIntent'` branch) logs `[Router][WelcomeIntent] participants` on every welcome it handles, so each counted line is a welcome Amazon Lex delivered to an assistant configured `NONE`/`ALL`.

**Still OPEN.** E3, monitoring for the channel flow: on 2026-10-11 `aws cloudwatch describe-alarms` lists 14 alarms in the account and none on the channel-flow processor. The three processor alarms are built in `channel-flow-stack.ts` and reach the account with the ChannelFlow stack's next deploy. E4, the Lex leg isolated from the handler (criterion 1b): the per-turn read returns both spans on one row, and the measurement spec has not been run.

## Problem, and who has it

A deployer running AgentEchelon wants an assistant that acknowledges a person quickly and answers every message exactly once, whatever the conversation shape. Every assistant turn has to start somewhere. Today it starts at one of two kinds of entry: Amazon Chime SDK invokes the assistant's Amazon Lex bot, which fulfills into the agent handler, or AgentEchelon's own code (the channel flow, post-processing, or another Lambda) invokes the agent handler directly. The two kinds differ in what they know about the message, and so in how much work the handler does before the first frame appears.

Several turn shapes already skip Lex, so "what is Lex still for" is a live design question. A developer extending the message path, or an operator reading a latency figure, needs the answer written down rather than inferred from the code.

## What is true today

**Every assistant identity has a Lex bot behind it, whether or not a turn ever uses it.** `CreateAppInstanceBot` takes a `Configuration.Lex` block and has no form without one. The admin assistant shows the consequence: it has no conversational role, yet `admin-services-stack.ts` builds a Lex bot for it, and `admin-agent-lex-handler.ts` exists only to be that bot's fulfillment hook and closes silently. So removing Lex from the turn path does not remove a Lex resource per assistant; it changes only whether turns route through it.

**The Lex bot is built by the deployment, not by hand.** `create-lex-bot` creates the bot, its `WelcomeIntent` and `FallbackIntent` with fulfillment code hooks, and the alias, with conversation logs when a log group is configured, and `create-bot` creates the `AppInstanceBot` against it with `InvokedBy: { StandardMessages: 'NONE', TargetedMessages: 'ALL' }` and, for a default assistant, a `WelcomeIntent` in its Lex configuration, all under `cdk deploy`. ADR-011 made pure-IaC deployment a constraint.

**Lex is a passthrough.** `WelcomeIntent` fires when the assistant is added to a channel; `FallbackIntent` carries every real user turn. AgentEchelon classifies the request itself and does not use Lex's intent recognition to route (MESSAGE-FLOW §5.5).

**No turn state lives in the Lex session.** The handler echoes the session attributes it receives and never writes one (`formatLexResponse` in `router-agent-handler.ts`). Conversation history is re-read from Amazon Chime SDK each turn and application state lives in DynamoDB (ADR-011, Appendix E). The bot's idle session timeout is 300 seconds (`create-lex-bot`), so nothing durable could live there anyway.

### The turns that enter through Lex

| Turn shape | Why Lex carries it | MESSAGE-FLOW |
|---|---|---|
| A private message to an assistant (`.<assistant>`, a private work-item reply, a battle clarification) | `TargetedMessages: ALL` invokes the bot named in `Target` | §5.2 |
| The assistant being added to a channel | `WelcomeIntent` | §2.2, §6.5 |

An ordinary message in a 1:1, and `@all` or `@<assistant>` in a 1:1, are not in this table. Under `StandardMessages: NONE` Amazon Chime SDK invokes no assistant for an untargeted message at any conversation size, so the channel flow starts both (next table). Under option A, `StandardMessages: AUTO` invoked the Lex entry for every message in a conversation with one other member, which is what put them here.

### The turns that do not

| Turn shape | Who invokes the agent handler | MESSAGE-FLOW |
|---|---|---|
| An ordinary message in a conversation with one assistant | the channel flow, synchronously | §4.9 |
| `@<assistant>` or `@all`, at every conversation size | the channel flow, synchronously | §4.9 |
| `/battle`, each side of round 1 | the channel flow | §4.8 |
| A group message starting with a task reference | the channel flow, after the task service confirms the reference | §4.9, ADR-035 |
| A handover to the assistant that owns the work | the first assistant's handler | §6.10a, ADR-030 |
| A work-item reply that reached no assistant | post-processing (task-answer repair) | §10.2 |
| A reading of queued messages | post-processing | §10.3, ADR-033 |
| Battle round 2 | `battle-orchestrator.ts`, straight to the async processor | §6.1, ADR-023 |

Every entry in the second table except battle round 2 reaches the same agent handler the Lex entry fulfills into. The channel flow, task-answer repair and the reading choose that handler by the conversation's classification from one routing table (`routerArnForClassification` in `router-arn.ts`); a handover invokes the handler of the assistant that owns the work.

## What the Lex entry does and does not carry

Measured and recorded in earlier decisions, and the reason the two kinds of entry are not interchangeable:

- **Three request attributes and nothing else.** Lex fulfillment receives `CHIME.channel.arn`, `CHIME.sender.arn` and `x-amz-lex:channels:platform`, and `WelcomeIntent` omits the sender. There is no message id (ADR-022, measured across every classification).
- **No `Metadata` and no `Target`.** A clarifying reply in a duel cannot be told apart from an ordinary message at the Lex entry, and the flow has no way to stamp something the Lex entry can read (ADR-029). A task id in a message's metadata is not visible to the Lex entry (ADR-035).
- **What that costs on each Lex turn.** The turn derives its correlation id from channel, sender, transcript and a 90-second bucket instead of declaring the inbound message id (ADR-022); a turn that needs the inbound message id reads it back from the channel by content match (ADR-034); an attachment is recovered from the channel rather than handed over (MESSAGE-FLOW §6.2).
- **The flow cannot keep Lex from being invoked on a message it releases.** Its only dependable suppression is `callbackDeny`, which removes the person's message from the conversation (ADR-022, option 3). This is why option A required the flow to stand aside in a 1:1: when both entries run on one message, their correlation ids cannot be compared, and a live deployment showed two acknowledgments 558 ms apart with one never answered (ADR-034, measured 2026-08-12).
- **The flow cannot see `Target`.** The callback event does not carry it and cannot set it (MESSAGE-FLOW, Appendix B). The Kinesis stream does carry it, after delivery. So in flight, the only component that routes a private message to an assistant is Amazon Chime SDK's own invocation of that assistant's Lex bot.

## The earlier decision this starts from

The communication-hub project, which shares this platform's Amazon Chime SDK and Lex shape, compared Lex as the channel-flow processor's intermediary against a Lambda-only processor. It decided on 2025-11-10 to keep Lex with periodic review, and a January 2026 review kept that decision. Its reasons, and whether each holds for AgentEchelon:

| Reason given there | Holds for AgentEchelon? | Why |
|---|---|---|
| Session attributes hold conversation state without another table | **No** | AgentEchelon writes no session attributes; history comes from Amazon Chime SDK and state from DynamoDB (see "What is true today"). That project's own routing decision records that AgentEchelon's use of Lex is lighter than its own on exactly this point |
| Intent routing: a welcome on join, a form-flow intent, a fallback for everything else | **Half** | `WelcomeIntent` is used for the same purpose. There is no form-flow intent, and `FallbackIntent` only triggers AgentEchelon's own classifier |
| Mention and multi-bot routing are native to the bot and Lex pairing | **Only for private messages** | Public `@` routing is done by the channel flow for every token (ADR-034). `Target` routing, which is how a private message reaches an assistant, is still native and still Lex |
| The bot, Lex, handler chain is an IAM isolation boundary | **Partly** | Each classification's bot still fulfills into its own classification's handler. On the bypass entries, the same isolation comes from the flow choosing the handler by the conversation's classification tag, which is AgentEchelon code |
| Accepted cost: an estimated 100 to 200 ms per message, judged imperceptible | **Not established** | The figure was an estimate there, not a measurement, and AgentEchelon has not isolated the Lex leg (see below) |
| Accepted cost: manual Lex configuration and drift | **No** | AgentEchelon builds Lex under `cdk deploy` (see "What is true today") |
| Accepted cost: debugging across two systems | **Yes** | Both entries exist, and a turn's path depends on its shape |

Its revisit triggers were: AWS deprecating the `AppInstanceBot` and Lex integration, Amazon Chime SDK offering another routing mechanism, and total response time becoming a user-visible problem. For AgentEchelon, the third is already tracked as time-to-first-frame (TTFF) against a published target (LATENCY-TARGETS).

**So the inherited reasoning does not settle the question for AgentEchelon.** The reason that carried most weight there, session state, does not apply here. What does apply is narrower: a private message reaches an assistant through Lex, and a welcome on join arrives as a Lex intent.

## What AgentEchelon has measured

**TTFF and what the handler costs inside it.** Premium turns on a deployment, 2026-08-21, over 1,484 agent-handler invocations: TTFF averaged 2,653 ms (p95 4,000 ms). Agent-handler compute averaged 1,035 ms, of which the intent classifier averaged 444 ms. Each of those three is a measurement over its own population.

**The time spent outside the handler is NOT MEASURED, and is not the difference between those two averages.** Subtracting the handler-compute average from the TTFF average looks like it yields the span across Amazon Chime SDK, the channel flow, Lex, the handler's invocation on the way in and the acknowledgment's creation on the way out. It does not: the two averages are over different populations on different clocks (`avg_router_ms` over `router_measured_count`, `avg_ttff_ms` over `ttff_measured_count`), so their difference describes no turn on the system. LATENCY-TARGETS, "Same population" in "Reducing TTFF", states this and names what does produce the figure: read `router_ms` against `ttff_ms` PER ROW, on the turns that stamped both, and decompose the in-handler part with `v_router_steps`. Until that per-row read is taken there is no number here, and the Lex hop inside the unmeasured span is separated by nothing.

**What the regression measured since points at, and how firmly.** On 2026-09-05, warm TTFF on premium was about 3.4 s and agent-handler compute had risen to about 1,900 ms. Both figures moved on the same populations they were defined on, and the handler-compute rise is of the same order as the TTFF rise, which points inside the handler rather than in front of it. The increase is attributed by timing and mechanism, not by instrumentation, to DynamoDB round trips the turn queue added before the acknowledgment (ADR-033), and nothing in the Lex configuration changed between the two dates. That is an attribution, not a measurement: it rules the Lex leg out only as far as an unchanged component and a matching movement elsewhere can, and the per-row read above is what would settle it.

**The entry comparison, taken 2026-09-16.** Thirty days of development traffic, 990 responses carrying a placeholder instant, read through the deployed signed analytics path with `conversation_summaries` and `turn_latency_audit` rather than by invoking a Lambda. Flow-dispatched time to first feedback beats Lex-entered by 896 ms uncontrolled (2374 ms over n=792 against 1478 ms over n=33, 95% CI 671 to 1119). Holding message length fixed removes roughly two thirds of that: on later messages under 80 characters the difference is 334 ms, 95% CI -8 to 676, which crosses zero. On byte-identical prompt text three of four pairs favor the flow and one reverses. The full table and its confounds are ADR-041, Appendix G.

**What it settles and what it does not.** The direction is consistent and the mechanism is the expected one: a flow dispatch removes one service hop and hands the router an exact message id instead of a content match. The magnitude is a few hundred milliseconds at the median with a real possibility of being near zero once the prompt is held fixed. **Against the one second time-to-first-feedback target that is material and it is not decisive**, so it does not by itself carry a change of entry and it does not leave option A standing on latency alone either. The earlier project's 100 to 200 ms is an estimate there and is not used here.

**The population is the broad one, deliberately.** `turn_latency_audit` applies no `paired_by` filter, so unlike the console headline these rows include reconstructed pairings. That is the right read here, because the exclusion is not neutral by entry: a flow-dispatched turn always declares its inbound message id and pairs `declared`, while an ordinary Lex turn on a queue-off deployment declares nothing and is swept whenever first feedback exceeds the batching window. The console's headline therefore drops slow Lex turns and almost no flow turns.

**What is still not measured** is the Lex leg itself, separated from the handler. See the per-row read above, and criterion 1b.

## Options

**A. Keep the hybrid.** NOT TAKEN. Lex carries the 1:1, private and welcome turns; the flow and direct invokes carry the rest. No new routing. The two entries keep deriving turn identity differently, and every guard that must treat them alike has to be written twice (ADR-022, ADR-034).

**B. Narrow Lex to targeted messages. TAKEN**, on every assistant and with no per-profile switch. `StandardMessages: NONE` and `TargetedMessages: ALL`. The flow dispatches every untargeted turn, including a 1:1, with the inbound message id declared. The 1:1 duplicate cannot arise, because no untargeted message invokes Lex, so the member-count branch has nothing left to prevent. Private messages still enter through Lex. `NONE`/`ALL` is measured ACCEPTED by `CreateAppInstanceBot`, with `WelcomeIntent` present and absent alike (2026-09-16). That `WelcomeIntent` fires under it when the assistant is added to a channel is verified 2026-10-11 (criterion 3, Recorded evidence).

**C. Bypass Lex on every turn. REFUTED BY MEASUREMENT (2026-09-16): this configuration does not exist.** `InvokedBy` with `StandardMessages: NONE` and `TargetedMessages: NONE` is refused by `CreateAppInstanceBot` with `BadRequestException: Either RespondsTo or InvokedBy must be set`, with `WelcomeIntent` present and absent alike, measured across eight combinations on a development deployment (ADR-041, Appendix A). `InvokedBy` was populated on both refused attempts, so the service reads an all-`NONE` `InvokedBy` as absent and falls back to requiring the deprecated `RespondsTo`, whose one legal value means the bot responds to all standard messages. Nothing expresses this constraint: the SDK's `LexConfiguration` marks both fields optional and constrains neither by the other, the botocore service model carries no exclusivity trait, and the public API reference is silent. It exists only in service validation, which is why reading the model established nothing and one write established it.

**So at least one axis stays live, and the choice is which rather than whether.** There is no configuration in which Amazon Lex is reached only by `WelcomeIntent`. Option B is the whole of what is reachable in the direction this record was pointing.

**What C would have needed, kept because it is why stopping at B is tolerable.** Every turn would be dispatched by AgentEchelon code with the message id in hand. Private messages would have no in-flight route, because the flow cannot see `Target`, so they would have to be dispatched from the stream by post-processing, adding stream delivery and detection time to every private turn (the same consequence MESSAGE-FLOW §12.2 records for task-answer repair). The welcome would have moved to a membership event on the stream. ADR-041 designs a second route for that population, from an addressee carried in `Metadata`, and records it refuted along with C rather than as an alternative to it. The Lex bot and its fulfillment hook would have remained either way, as the admin assistant's do, because `CreateAppInstanceBot` requires them, and the refusal makes that requirement stricter than this record stated: the block must also declare a live trigger.

**D. Narrow the other axis.** The same measurement establishes that `ALL`/`NONE` and `MENTIONS`/`NONE` are both accepted, so turning the targeted entry off, or reducing the standard entry to mentions only, are configurations that exist and that this record did not enumerate. Neither is proposed. `TargetedMessages: NONE` would strand the private address, the private work-item answer and the battle clarification with no in-flight route, and it buys nothing toward assistant-to-assistant messaging, because a message authored by an `AppInstanceBot` invokes no other `AppInstanceBot` before `InvokedBy` is consulted at all (ADR-023, measured with a control). They are named so the option space is the measured one rather than the assumed one.

## What decides this

1a. **TTFF split by entry. TAKEN 2026-09-16**, and reported above. It came in second rather than first, which is why the two halves are numbered apart. The difference is a few hundred milliseconds at the median once the prompt is held fixed, with an interval that crosses zero on the tightest control. Read against this criterion as written: not small enough for option A to rest on latency, and not large enough for option B to be justified by measurement alone. The criterion is satisfied and it does not decide the record.
1b. **The Lex leg isolated from the handler. OPEN: takeable, not yet taken.** `router_ms` against `ttff_ms` PER ROW on the turns that stamped both is what produces the time a turn spends outside the handler at all; a difference of group averages does not, and no figure in this record is derived that way. The per-turn latency drill (`latency_exchanges`, `getLatencyExchanges` in `analytics-query.ts`) returns `router_ms`, `ttff_ms` and `turn_entry` on one row. `tests/e2e/the-lex-leg-is-measured-per-turn.spec.ts` reads it as testAdmin through the signed path, groups `ttff_ms - router_ms` by entry and logs the medians; the difference between the `lex` and `flow` medians is the Lex leg. The run's result is recorded here when it is taken.
2. **~~A route for private messages without Lex, if C is pursued.~~ Withdrawn 2026-09-16.** C is refused by the service rather than blocked on a design, so nothing waits on this. The targeted entry stays live under every reachable option and a private message keeps the in-flight route it has today.
3. **The welcome's trigger under `StandardMessages: NONE`. Verified 2026-10-11, a follow-up rather than a precondition.** ADR-043 reports on 2026-09-16 that `WelcomeIntent` fires under it. The recorded reading on the default instance confirms it: 422 welcomes handled by assistants configured `NONE`/`ALL` between 2026-10-07 and 2026-10-11 (Recorded evidence, E2).

## Revisit when

- Amazon Chime SDK delivers `Target` to a channel flow, or forwards a flow-set attribute into Lex request attributes (ADR-022 already names the second).
- `CreateAppInstanceBot` accepts a configuration without Lex, accepts an `InvokedBy` with both members set to `NONE`, or AWS changes the `AppInstanceBot` and Lex integration. The second is checked by attempting it, not by reading the SDK types or the service model, neither of which expresses today's refusal.
- ~~The Lex-entry and flow-entry TTFF comparison above exists.~~ **Fired 2026-09-16.** It moved the question without closing it.
- The analytics read path returns `router_ms` and `ttff_ms` on one row (`latency_exchanges` does), so criterion 1b is takeable; the measurement run is recorded under Recorded evidence when taken.
- A turn shape is added that the Lex entry cannot identify from its three request attributes, which would be the next case for the flow to route.

## Consequences

- MESSAGE-FLOW §1 and §5 cite this record for why the Lex entry exists; §4.5 ("Who answers") is the account of which turns the flow answers, and Appendix C ("Why `StandardMessages` is `NONE`") of why a 1:1 has no Lex entry.
- The as-built entry is option B: `StandardMessages: NONE` with `TargetedMessages: ALL` on every assistant, and the channel flow as the only entry for untargeted messages. ADR-041 records the same decision. Monitoring for the channel flow is built (the processor's error, throttle and occupancy alarms) and not yet deployed. The Lex leg isolated from the handler (criterion 1b) stays **OPEN** until the measurement spec is run.
