---
title: "ADR-038: A turn answers the message that was there when it started"
status: >-
  Accepted 2026-09-16. Evaluates two directions for making a turn's target exact when the turn queue is on, bypassing Amazon Lex on a locked conversation, and reducing duplicate claims on a content match. Both are rejected in the form proposed. What is accepted is smaller and is BUILT and deployed to dev (2026-10-27, NOT VERIFIED there); option F bounds the processor's late content match by the turn's own start instant, taken from the router's entry mark, through an optional `notAfter` on the shared matcher. Verified by `backend/test/lib/a-turn-answers-the-message-that-was-there-when-it-started.test.ts`. The unconditional form of the bypass is ADR-036 option B, which ADR-036 and ADR-041 record as Accepted and the code runs; every assistant carries `StandardMessages: NONE`, and `flowOwnsTheTurn` claims every untargeted 1:1 turn.
date: 2026-09-16
amended: 2026-09-16
related:
  - "./022-message-identity-is-established-at-the-channel-flow.md"
  - "./025-who-posts-the-placeholder.md"
  - "./029-clarification-is-public-and-answers-get-their-own-placeholder.md"
  - "./033-a-conversation-answers-one-turn-at-a-time.md"
  - "./034-addressing-a-message-is-not-making-it-private.md"
  - "./036-why-turns-enter-through-amazon-lex.md"
  - "./037-a-turn-declares-what-it-answers-on-the-message-it-is-already-posting.md"
  - "../../overview/TENETS.md"
  - "../../guides/developer/LATENCY-TARGETS.md"
  - "../../guides/developer/MESSAGE-FLOW.md"
  - "../../../backend/lambda/src/lib/flow-bypass.ts"
  - "../../../backend/lambda/src/lib/inbound-message.ts"
  - "../../../backend/lambda/src/lib/live-drift-flow.ts"
  - "../../../backend/lambda/src/lib/private-command.ts"
  - "../../../backend/lambda/src/lib/turn-lock.ts"
  - "../../../backend/lambda/src/router-agent-handler.ts"
  - "../../../backend/lambda/src/assistant-async-processor.ts"
  - "../../../backend/lambda/src/channel-flow-processor.ts"
  - "../../../backend/lambda/src/analytics-aurora/kinesis-archival.ts"
  - "../../../backend/lambda/src/analytics-aurora/schema/043-the-metric-is-named-for-what-it-measures.sql"
  - "../../../backend/lambda/src/analytics-aurora/schema/052-a-queued-message-that-was-answered-is-a-response.sql"
  - "../../../backend/lambda/src/lib/assistant-provisioner.ts"
  - "../../../backend/lib/stacks/agent-classification-common.ts"
  - "../../../backend/test/lib/a-turn-answers-the-message-that-was-there-when-it-started.test.ts"
tracking: |
  Accepted. Every description of the built system in this record is read from the tree at the date
  above. The one change the decision endorses, option F, is written and unit-covered:
  `findInboundMessage` takes an optional `notAfter`, and `recordWhatThisTurnIsAnswering` passes the
  router's `entry` step instant with the processor's own entry as the fallback. It is deployed to dev
  (2026-10-27) and NOT VERIFIED there, so no figure in this record is a post-fix measurement, and no option here has been measured against
  another on a deployment. The wrong bind option F removes is still reasoned rather than observed on
  a deployment, and the rejections of options A through E and G are unchanged.
---

# ADR-038: A turn answers the message that was there when it started

> **Amended 2026-10-23.** `create-bot` and `create-lex-bot`, the deploy-time provisioners this record cites, are removed: no stack owns an assistant identity, and every identity and Amazon Lex bot is built by the provisioner (`backend/lambda/src/lib/assistant-provisioner.ts`, [ADR-048](./048-an-assistant-is-not-a-classification.md), amended 2026-10-23). The line numbers cited for them are of the removed files. The behavior cited is unchanged: every identity is built with `StandardMessages: NONE` and `TargetedMessages: ALL`.

## Status

**Accepted (2026-09-16), option F built the same day.** This record evaluates two directions the owner named for making a turn's target exact under the turn queue, states what each costs in the code as it stands, and rejects both in the form proposed. It accepts one small change, which is now written and unit-covered, and it leaves the larger question where ADR-036 already left it.

**What is built is option F and nothing else.** `findInboundMessage` takes an optional `notAfter` and skips any candidate created after it, or whose creation instant Amazon Chime SDK did not report (`backend/lambda/src/lib/inbound-message.ts`, the `notAfter` parameter and the guard inside the match loop). `recordWhatThisTurnIsAnswering` passes the router's `entry` step instant, falling back to the processor's own entry instant when a dispatch carries no router log (`backend/lambda/src/assistant-async-processor.ts`). Verified by `backend/test/lib/a-turn-answers-the-message-that-was-there-when-it-started.test.ts`. It is deployed to dev on 2026-10-27 and **NOT VERIFIED** on a deployment, so nothing here is a post-fix measurement.

**Every other caller of the matcher is untouched, deliberately.** The router's queued-branch lookup and the drift flow both read at arrival, where nothing later exists yet and newest-first is already exact, so neither passes a bound and neither changes behavior.

The queued-row comparison at the end is a read of migrations 039, 040, 043 and 052 against the owner's stated definition, and it finds the built shape already matches.

## Problem, and who has it

An operator wants the latency numbers on the Latency tab to cover the turns the platform actually ran, and to be right about which message each turn answered.

ADR-037 establishes that an ordinary Amazon Lex turn, one that neither opens a task nor queues and is not answered from the handler, declares nothing on either of its message events, so its pairing is minted by inference and labeled `in_batch` or `swept`. The reason is that Amazon Chime SDK sends an Amazon Lex fulfillment exactly three request attributes and the message id is not among them, measured across fourteen days of conversation logs on all three classifications and recorded at `backend/lambda/src/router-agent-handler.ts:3504-3519`. That residual is about a turn that never learns the id at all; this record is about a turn that learns it and learns the wrong one, which is the worse half because it produces a number rather than an absence.

Under the turn queue the same gap produces that second failure, and this record is about it. ADR-037's option G defers the sweep so a turn's confidence label stops depending on when a reader looks; this record's option F makes sure the id that turn declares is the right one. Neither substitutes for the other: a deferral that waits for a wrong declaration still records a wrong pairing, with more confidence than before.

It is for the developer extending the queue path, and for the operator who will read the queued-wait figures once anything surfaces them.

## What is true today

**The turn queue is off by default and everything below is conditional on it.** `turnQueueWiring` writes `TURN_QUEUE_ENABLED: '0'` unless `-c turnQueue=true` (`backend/lib/stacks/agent-classification-common.ts:400-405`), and `claimTurn` returns `{ claimed: true }` without reading anything when the flag is off (`backend/lambda/src/lib/turn-lock.ts:165`). So on a default deployment no message is ever queued, `v_queue_acknowledgement` is empty, and the defect described here cannot occur.

**The queued branch already resolves the message id, correctly, and pays for it.** When the claim is refused the router resolves the queued message's own id before it returns: `declaredMessageId || (await inboundMessage()).messageId || correlationId` (`backend/lambda/src/router-agent-handler.ts:4202-4206`), then enqueues under it (`:4209`) and opens the drain task against it (`:4255-4261`). The lookup is `findInboundMessage`, a `ListChannelMessages` matched on exact stored content (`backend/lambda/src/lib/inbound-message.ts:59`). At that instant the message being handled is the newest message from that sender, because it has just arrived, so the newest-first rule is exact here. Content matching on the queued side is already the mechanism and it already works, which is why option F leaves this caller alone: it passes no `notAfter` and gets the unbounded rule unchanged.

**The answering turn resolves its id LATER, and that is where the newest-first rule stops being exact on its own.** `recordWhatThisTurnIsAnswering` runs in the processor, not the router, because the router's copy sat in front of the first frame (`backend/lambda/src/assistant-async-processor.ts:619-626`). It runs after the acknowledgment exists, with a deliberately wider window (`maxResults: 50`, `backend/lambda/src/assistant-async-processor.ts:648-655`), and the matcher it calls takes the newest exact content match from that sender (`backend/lambda/src/lib/inbound-message.ts:95-116`). It is gated on `event.rememberHolder` (`backend/lambda/src/assistant-async-processor.ts:852`), which the router sets only under `owesHolderRecord`, which requires `turnQueueEnabled()` (`backend/lambda/src/router-agent-handler.ts:4141-4150`).

### The defect option F closes, stated as it was found

**Under a queue the two rules point in opposite directions on repeated text.** A person sends "ok", a turn starts on it, the person sends "ok" again while it runs, and the second one queues. An unbounded late lookup finds two exact matches and takes the newest, which is the queued one. The running turn then records that it is answering a message it is not answering, the queued message is claimed by the turn that is not going to fold it, and the message that actually started the turn is claimed by nobody.

**The consequence is a number, not a gap, and it is wrong in the flattering direction.** The exchange's `user_message_at` becomes the later send, so the reported latency is short by the interval between the two sends. Migration 040's header records the same class of error from the other end, found because `triaged_ms` came back smaller than `ack_ms` on live rows; the note there applies unchanged, which is that an impossible or flattering number is worse than a missing one because nothing about it looks wrong.

**The drain's own description degrades with it.** The holder record exists so a reading can say what the work in flight IS rather than "the work already in progress", which is the defect `backend/lambda/src/router-agent-handler.ts:4110-4116` records: with a bare description, corrections were classified as new work and the amendment became a second item answered after the thing it was meant to change. A holder record naming the wrong message does not degrade to that; it describes the wrong work confidently.

**The instants that settle it are already in hand on both sides.** Amazon Chime SDK reports each candidate's `CreatedTimestamp` on the listing the matcher already walks, the drift flow already compares a resolved `createdAt` against another instant to order two facts (`backend/lambda/src/lib/live-drift-flow.ts:462-463`), and the processor already receives the router's step log on its own event. So bounding the match needs no new call, no new store and no new event, which is what makes option F the cheap form rather than merely the small one.

**What is built reads the bound from the router's entry mark, and the matcher applies it inside the walk.** The `createdAt` the lookup RETURNS is still unread by the processor; what option F uses is each candidate's creation instant, compared against `notAfter` before the match is taken. Those are two different fields and only the second one decides anything.

## Option 1: when the queue is on and the conversation is locked, the channel flow takes the turn

The owner's words: bypass Amazon Lex by default to capture the message id and skip the Amazon Lex placeholder even in a 1:1.

### What the shape would be

Not a change to `InvokedBy`. That is a property of the `AppInstanceBot` resource, written once per assistant at create and re-applied on update (`create-bot` and `:117`), so it is deployment-wide for that assistant across every conversation and cannot express "this conversation, right now". The flow's only per-message power over Amazon Lex is denial, which deletes the person's message (ADR-022 option 3), and that is not available for anything somebody said to the room.

The shape that is available is the one already built. `flowOwnsTheTurn` is asked by the flow to decide whether to act and by the router to decide whether to stand down, so the two are complements by construction (`backend/lambda/src/lib/flow-bypass.ts:386-417`). Its 1:1 branch is a single line, `if (isOneToOne) return false;` (`backend/lambda/src/lib/flow-bypass.ts:400`). Flipping that for the population in question makes the flow dispatch the turn with `userMessageId` in hand (`backend/lambda/src/channel-flow-processor.ts:1385-1397`) and makes the router return silence on the Amazon Lex entry (`backend/lambda/src/router-agent-handler.ts:1750-1769`), and the assistant speaks its own acknowledgment (ADR-025, `backend/lambda/src/router-agent-handler.ts:1427-1460`).

That is ADR-036's option B achieved in AgentEchelon's own code rather than by reconfiguring Amazon Chime SDK, and it keeps two things option B puts at risk: `WelcomeIntent` still fires on channel-add, and `TargetedMessages: ALL` still routes a private message, so neither needs the probe ADR-036 names as a precondition.

### Why the conditional part does not work

**"When the conversation is locked" cannot be an input to `flowOwnsTheTurn`.** That function is pure over the message text, the roster and the channel size, and the whole property it exists for is that two components compute the same answer independently (`backend/lambda/src/lib/flow-bypass.ts:1-39`). Lock state is mutable and the two components read it at different instants: the flow reads it in the callback, the router reads it on the Amazon Lex invoke that follows. Between the two the holder can release. The flow reads locked and claims, the router reads unlocked and answers, and the turn is answered twice under two correlation ids that cannot be compared, which is the 2026-08-12 failure exactly: two acknowledgments 558 ms apart with one stranded permanently (ADR-034, and `backend/lambda/src/lib/flow-bypass.ts:368-377`). The opposite ordering answers it zero times.

There is no cheap repair. A shared decision would mean the flow writing its verdict somewhere the router reads, per message, on the critical path, which is the conditional write at the flow that ADR-022's decision declined as both unnecessary and unsafe.

**Gating on the queue FEATURE instead is safe and is still wrong.** `turnQueueEnabled()` is an environment variable that does not change within a turn, so both sides would agree. But the channel flow does not receive it today: `turnQueueWiring` is applied in `assistant-profile-stack.ts`, `conversations-stack.ts` and `post-processing-stack.ts`, and not in `channel-flow-stack.ts`. More importantly it would make a deployment's message topology change shape when a feature flag flips. ADR-037 already lists "the pairing quality of a deployment depends on the turn queue" as a relationship no reader would expect; making the ENTRY depend on it is the larger version of the same surprise, and tenet D9 asks that two features of the same kind be built the same way rather than one of them forking on a flag.

So if this is done at all it is done unconditionally, for every 1:1, and it is then ADR-036's option B and inherits ADR-036's entry measurement, taken 2026-09-16 (ADR-036, ADR-041).

### What the unconditional form costs

**Amended 2026-09-17: the unconditional form is taken in code, by configuration rather than in this record.** The code provisions every assistant with `StandardMessages: NONE` and `TargetedMessages: ALL`, so on a deployment carrying it the channel flow starts every untargeted turn at every conversation size (ADR-041, and ADR-036 option B). The deployed `InvokedBy` is verified 2026-10-11: every assistant on the default instance reads `NONE`/`ALL` ([ADR-036, Recorded evidence](./036-why-turns-enter-through-amazon-lex.md#recorded-evidence)). The costs below are live wherever that configuration is. Two are answered by the configuration: a private message still reaches Amazon Lex through `TargetedMessages: ALL`, so it keeps its visibility, and the stand-aside roster read on an entry about to do nothing is gone with the entry. One is not: the channel flow BECOMES the single point of failure for every ordinary turn, and a flow failure then delivers the person's words and starts no turn. Nothing monitors that failure yet.

**A private message in a 1:1 loses the visibility Amazon Chime SDK carries for free.** The channel-flow callback carries no `Target`, measured 2026-08-14 (`backend/lambda/src/lib/private-command.ts:4-5`), and the stored message cannot be read while the flow is still holding it, measured 2026-09-15 for a targeted and an untargeted message alike (`backend/lambda/src/lib/private-command.ts:146-149`). In a room the Amazon Lex entry can infer targeting from the fact that it was invoked at all for an unaddressed command, which is what `lexEntryAnswersCommand` is (`backend/lambda/src/lib/private-command.ts:52-55`). In a 1:1 that inference is unavailable, because `StandardMessages: AUTO` invokes the entry for every message regardless. So neither entry can tell a private 1:1 message from a public one in flight. Today it does not matter, because the Amazon Lex entry answers either way and the reply inherits the `Target`. Under this option the flow answers, so the platform has to re-derive the visibility itself, and the only instrument is `inboundWasTargeted`: a post-release `GetChannelMessage` with a bounded read-after-write of up to two reads and a 250 ms pause (`backend/lambda/src/lib/private-command.ts:102-121`), which fails toward public (`:113-116`). That puts a channel read plus a deliberate sleep in front of the first frame on every 1:1 turn, and gives the check a failure direction that is a disclosure rather than a delay. ADR-037 option E was rejected for buying determinism with the quantity the metric measures; this is the same trade with a worse failure mode.

**The channel flow becomes a single point of failure for every ordinary turn.** The router's own stand-down comment states the exposure: it trusts that the flow ran, and if the flow is not associated to the channel the turn is silenced and nothing answers it (`backend/lambda/src/router-agent-handler.ts:1620-1623`). That is acceptable today because it costs only `@all` and `/battle`. Extended to every 1:1 message it means a flow that is absent, erroring or throttled takes the whole conversation silent, where today a 1:1 survives it intact.

**Every 1:1 message pays a roster read on the entry that is about to do nothing.** The router's stand-down guard is gated on a prefilter today (`backend/lambda/src/router-agent-handler.ts:1671`), so a message with no `@` in it reads nothing. Widening it to every 1:1 message means `resolveChannelSize`, and up to two calls when the first is unreadable (`:1686-1697`), on an entry whose only remaining job is to return silence.

**The latency is unmeasured in both directions, which is ADR-036's whole open question.** The option removes the Amazon Chime SDK to Amazon Lex to Lambda leg and adds the flow's synchronous invoke of the router plus the assistant's own `SendChannelMessage`. MESSAGE-FLOW records that the flow is synchronous with Amazon Chime SDK waiting on it, so every rule added there is paid for by every conversation ("Why these jobs live in the flow, and nothing else does"), and that the flow's 35 second timeout exceeds the handler's 30 second one by design (§4.9). No figure compares the two entries on one deployment and one classification, and ADR-036 says so under "What is not measured". This record adds no such figure either.

### What it buys

Every ordinary 1:1 turn declares its target on its own acknowledgment, deterministically, which is ADR-037's named exit and would make its inference paths dead code on that population rather than a documented fallback. The acknowledgment also becomes a message the turn posts and therefore holds the id of, so it gains a `Metadata` field the Amazon Lex-materialized placeholder does not have, which reopens ADR-037's option C on that path. That second gain is small, because ADR-037 option A already covers the same fact in content at no extra call.

## Option 2: match on content, with duplicates reduced so one message is claimed by one row

### What "duplicates reduced" would have to mean, and which part already exists

Three readings, and they are not the same change.

**Uniqueness on the analytics claim: mostly built, and not the remedy.** `exchanges_user_agent_message_uniq` makes the pair unique (`backend/lambda/src/analytics-aurora/schema/017-exchanges-one-per-agent-reply.sql:16`), deliberately on the pair rather than on the user message so a duel can record both sides. The sweep additionally anti-joins per responder identity, so one user message cannot be claimed twice by the same assistant (`backend/lambda/src/analytics-aurora/kinesis-archival.ts:1506-1511`), and every insert is `ON CONFLICT DO NOTHING` (`backend/lambda/src/analytics-aurora/kinesis-archival.ts:1620`). What is not prevented is the same user message carrying both an ordinary exchange and a queued one, which is why migration 052 labels the queued population and `v_turn_latency` anchors away from it (`backend/lambda/src/analytics-aurora/schema/052-a-queued-message-that-was-answered-is-a-response.sql:207-218`).

Adding a stricter constraint would prevent double counting and would not touch the defect. A wrong bind writes one row, not two. Tightening uniqueness makes a wrong number self-consistent, which is the direction migration 040 already warns about.

**A claim table: new infrastructure for a fact the platform already records.** Knowing which identical message is already spoken for is state, and a Lambda doing a content match holds none. But the turn-state record already holds both halves: the queue holds the ids of the messages waiting (`backend/lambda/src/router-agent-handler.ts:4207`), and `rememberHolderMessage` holds the id the running turn claimed (`backend/lambda/src/lib/turn-lock.ts:2245`). Tenet D8 says new infrastructure should be the conclusion of an argument, and here the argument does not reach one: a claim table would re-record what `TURN_STATE_TABLE` already has.

**Oldest-unclaimed-first: the right instinct, and the wrong key.** "Unclaimed" needs a read of the queue state at match time, so it turns a pure content match into a stateful one and adds a `GetItem` to the branch. And it is over-general. The thing that makes the newest-first rule wrong is not that the newer message is claimed; it is that the newer message did not exist when the turn started.

### The cheap correct form, and what it looks like built

**Bound the candidate set by time instead.** A message created after this turn began is, by construction, not the message this turn is answering. Taking the newest exact match at or before that instant costs no extra call, no extra store and no extra event.

**The bound is an optional parameter on the shared matcher, not a second matcher.** `findInboundMessage` takes `notAfter` and, when it is set, skips a candidate whose creation instant is later than the bound or that Amazon Chime SDK reported no instant for at all. Absent, the newest-first rule is exactly what it was, which is what keeps the router's queued-branch lookup and the drift flow unchanged: both read at arrival, where nothing later exists yet. One set of rules about which message counts, which is why `inbound-message.ts` is its own module in the first place.

**The instant is the ROUTER's entry mark, and which instant it is carries the whole behavior.** `recordWhatThisTurnIsAnswering` reads the `entry` step off `event.routerSteps` and falls back to the processor's own entry instant when a dispatch carries no router log. Everything else the event offers is later: the claim, the dispatch, this handler's entry. Earliest is the tightest bound that is still safely after the message being answered, because that message had to exist for the channel flow and Amazon Lex to invoke the router at all. So the true message always passes and the copies queued behind the turn do not.

**The two clocks differ and the inbound leg absorbs it.** A candidate's creation instant is Amazon Chime SDK's clock and the router's entry mark is a Lambda's, so the comparison is cross-clock in the same way `exchanges.inbound_ms` already is. What separates them is the inbound leg, which is hundreds of milliseconds, orders above any plausible skew between two NTP-disciplined AWS clocks. A skew large enough to matter costs a declaration, never a wrong one.

It does not make the match exact, because two identical messages sent inside one turn's start window are still ambiguous. It removes the ambiguity that the queue creates, which is the population the owner asked about, and it removes it in the direction where the cost of being wrong is a missing anchor rather than a flattering number, which is the direction `findInboundMessage` already chooses when nothing matches. The two reasons for finding nothing stay distinguishable in the log: a message outside the window is a window too narrow, and text that exists only after the turn began is the person repeating themselves while the assistant works.

It also satisfies tenet D11 on the same terms the existing match does: it compares the platform's own stored content and an instant the platform recorded, and judges no phrase.

## Do the two options compose or compete

**At the layer they act on, they compose.** Option 1 is an entry change and narrows the population that has to recover the id at all; option 2 is a recovery rule for every entry that still does not hold it. Nothing in either forecloses the other, and the tree already runs both shapes side by side: a bypass entry declares `AE.message.id` and a task-shaped Amazon Lex turn resolves it by content match, and both fold to one column (`backend/lambda/src/analytics-aurora/kinesis-archival.ts:715-720`).

**As the owner framed them they compete, and the conditional is why.** "Bypass for the locked case, content matching otherwise" makes the SAME turn shape take different entries at different instants. The entry decision would then be a function of mutable state read twice, which is the property `backend/lambda/src/lib/flow-bypass.ts` exists to prevent and the failure it was written after. Two alternatives that compose when each is unconditional stop composing the moment one of them is conditioned on something the other cannot see at the same instant.

So the composition worth having is: the entry rule stays a pure function of the message and the room, and the recovery rule gets narrower. That is not a choice between the two options; it is one of each, taken at the layer it belongs to.

## The queued-row definition, against what is built

The owner: each queued message still has its own row, each starts at the point their message was sent and ends when the queue is cleared.

**The built shape already matches, and the column is `drained_ms`.** `v_queue_acknowledgement` produces one row per queued message, keyed on the message the deferral notice acknowledged, with `sent_at` from that message's own `user_message` ledger row and `drained_ms` as the span from the send to the queue's settle (`backend/lambda/src/analytics-aurora/schema/043-the-metric-is-named-for-what-it-measures.sql:51-106`). Per message at the start, shared at the end, exactly as described.

**One precision worth keeping.** The settle instant is the `queue_status = 'settled'` notice update, and migration 043's header records that this update is written after the reading, the proposal, task creation, the private follow-ups, the queue clear and a `readTurnState` round trip. So the column ends slightly after the clear rather than at it, and it is named for the end of the drain for that reason. The difference is one round trip and the name already says which one it is.

**`v_queued_exchange.waited_ms` is a different question and must not be read as this one.** It is the exchange's `response_latency_ms`, the span from the queued send to the ANSWER that folded the message in (`backend/lambda/src/analytics-aurora/schema/052-a-queued-message-that-was-answered-is-a-response.sql:261-294`), with `answered_together` saying how many messages that one reply addressed (`:287`). That is the end of the person's wait, not the end of the queue's.

**Both reconcile with ADR-033, by different arguments, and it matters which.** ADR-033 line 389 refuses a per-queued-message mapping onto an answer because the mapping does not exist. The owner's definition needs no such mapping: the end is a batch event shared by every message in the episode, and a row that says "you sent at T and the queue finished draining at S" claims nothing about which reply addressed you. `drained_ms` is therefore consistent with ADR-033 without needing its exception. `v_queued_exchange` does name an answer, and it is justified separately and correctly: the mapping is declared by the reading and the fold rather than inferred, which migration 052's header sets out at `:18-28`. ADR-033's refusal was of an inferred mapping and stands.

**So: matches, on the definition as stated.** What is missing is not a measurement but a reader. Nothing outside the schema reads `v_queued_exchange` at all, and `v_queue_acknowledgement` has exactly one reader, `queueAcknowledgementSample` (`backend/lambda/src/analytics-aurora/turn-events-backfill.ts:257`). Neither figure reaches the admin console. And `drained_ms` carries a documented bias: when a notice update is refused and a fresh notice is posted, the settle lands on a notice id no acknowledgment named, so the FIRST and longest-waiting message of that episode reports NULL forever, which biases any distribution built on it short (`backend/lambda/src/analytics-aurora/schema/043-the-metric-is-named-for-what-it-measures.sql:22-37`).

## Options considered and rejected

**A. Bypass Amazon Lex when the queue is on and the conversation is locked.** Rejected. The conditional cannot be evaluated identically by the two components that must agree, and disagreeing produces either two answers or none. There is no repair short of a per-message write at the flow that ADR-022 already declined.

**B. Bypass Amazon Lex for every 1:1 when the queue feature is on.** Rejected as a flag-shaped fork of the entry topology (tenet D9), and because the flow does not receive the flag today.

**C. Bypass Amazon Lex for every 1:1, unconditionally.** TAKEN as ADR-036 option B (see "What the unconditional form costs"). As judged in this record: not rejected, and not recommended here. It is ADR-036's option B and it is the only change that makes the ordinary turn's target exact rather than merely better. As first judged here it was blocked on two things. ADR-036's entry measurement is taken 2026-09-16 (ADR-036, ADR-041). The second blocker, which ADR-036 did not name, is that a private 1:1 message would lose the visibility Amazon Chime SDK carries for it, with a post-release read that fails toward disclosure as the only instrument to recover it; `TargetedMessages: ALL` resolves it, because a private message keeps its in-flight route through Amazon Lex.

**D. Reduce duplicates by tightening uniqueness on the analytics claim.** Rejected. A wrong bind writes one row, so uniqueness cannot see it, and the effect of tightening is to make a flattering number consistent.

**E. Reduce duplicates with a claim table or an oldest-unclaimed-first rule.** Rejected. Both re-record state `TURN_STATE_TABLE` already holds, and both key on the wrong property: the problem is that the newer message did not exist yet, not that it is spoken for.

**F. Bound the processor's late content match by the turn's own start instant.** Endorsed, and BUILT. ADR-037 also has an option F and it is a different change, removing the Amazon Lex entry from the turns that do not need it; that record refers to this one as "ADR-038 option F" for the same reason this one names its own record when it points back. It removes the queue-induced ambiguity with no new call, no new store and no new event, using instants both sides already hold. Built as an optional `notAfter` on the shared matcher so the two callers that read at arrival keep the newest-first rule unchanged.

**G. Pay the channel read in the router so the answering turn holds the id before it posts.** Rejected, again. ADR-037 option E and the router's own comments already settled it, most recently at `backend/lambda/src/router-agent-handler.ts:4118-4129`.

## Decision

**Neither option in the form proposed. Option F, and the entry question stays with ADR-036.**

1. **The entry rule stays a pure function of the message and the room.** `flowOwnsTheTurn` takes text, roster and size and nothing that can change between two readers. A conditional entry is not a smaller version of a bypass; it is a different mechanism with the failure mode the bypass seam was built to remove.

2. **The recovery rule gets narrower, not stateful.** The processor's late match takes the newest exact match at or before the turn's own start, and that start is the router's `entry` mark with the processor's own entry as the fallback. Nothing else about `findInboundMessage` changes, and the router's queued-branch lookup is already exact and is left alone. Where every copy of the text postdates the start, the turn declares nothing, which is the same direction the matcher already takes when it resolves nothing at all.

3. **Uniqueness stays where it is.** The pair constraint and the sweep's per-responder anti-join are correct for what they guard. Nothing is added to make a wrong bind consistent.

4. **The queued row is `drained_ms` and it already exists.** One row per queued message, its own send, the drain's end. No new view and no new column. What it needs is a reader and an honest note about its short bias, and both of those are work rather than design.

5. **`v_queued_exchange` stays a separate question and keeps its label.** It answers when the person was answered, and averaging it beside a one-to-one turn's time to first feedback is the misreading migration 052 exists to prevent.

6. **The exit is unchanged.** The ordinary turn's target becomes exact when the channel flow dispatches it, and not before. ADR-036's entry measurement for that change is taken 2026-09-16 (ADR-036, ADR-041), and the second precondition this record named is resolved by `TargetedMessages: ALL` (see "What the unconditional form costs").

### Why this is the honest answer and not the cautious one

The queue-induced wrong bind is real, it is recorded here with the mechanism, and it deserves a fix. What it does not deserve is the fix that was proposed for it, because both proposals are larger than the defect and both fail in ways the tree has already been bitten by once. The bypass reintroduces a measured duplicate through a new door; the uniqueness constraint quiets a symptom the defect does not produce.

Option F is small enough to look like a decline to act, and it is not. It closes the whole population the queue creates, which is every repeated message during a burst, and it is the only candidate that does not spend the person's first frame or the one-responder invariant to do it.

## What proves it

- **Existing, and what this decision leans on:** `backend/test/lib/flow-bypass.test.ts` pins that the flow and the router decide from one definition, including the 1:1 branch this record declines to condition. `backend/test/flow-does-not-run-the-turn.test.ts` and `backend/test/lib/a-private-command-is-answered-by-the-lex-entry.test.ts` pin the two halves of the private-command split that option C would have to replace in a 1:1. `backend/test/channel-flow-outlasts-router.test.ts` pins the timeout ordering any flow-dispatched turn depends on.
- **Existing, on the analytics side:** `backend/test/analytics-aurora/an-exchange-is-declared-not-inferred.test.ts` pins that both pairers obey a declaration and infer only in its absence. `backend/test/analytics-aurora/ttff-counts-only-measured-pairings.test.ts` pins the headline's partition on `paired_by`. `backend/test/analytics-aurora/a-queued-message-that-was-answered-is-a-response.test.ts` pins the queued pass. `backend/test/lib/a-placeholder-names-what-it-answers.test.ts` pins ADR-037's declaration on the acknowledgment.
- **Option F, and it is the named verifying test for this record's one decision:** `backend/test/lib/a-turn-answers-the-message-that-was-there-when-it-started.test.ts` drives `recordWhatThisTurnIsAnswering` over a listing holding two identical messages either side of the turn's start instant. It asserts that the copy sent while the turn ran is refused, that the ORIGINAL is declared when both copies are in the window and that the id declared is the older one rather than merely non-empty, that the bound is the ROUTER's entry mark (a message that queued before this handler woke is still refused) and that the processor's own entry is the fallback when a dispatch carries no router log, that a bounded caller declines a candidate whose instant Amazon Chime SDK did not report, and that an unbounded caller still takes the newest match, which is the router's queued branch.
- **Its non-vacuity was established by running it against three implementations,** not asserted: the bound removed, the bound taken from the processor's entry instead of the router's, and the fix as written. A bound that rejected every candidate would pass the first assertion and would be a switch-off of this whole record, so the same listing is asserted both ways.
- **Not proven by any of these:** that the wrong bind described above has occurred on a deployment. It is read from the code paths and their instants, not from a row.

## What is not yet true

- **The wrong bind is reasoned, not observed.** No query in this repository counts how often a running turn's late lookup lands on a message created after its own start. The mechanism is exact and the incidence is unknown, and those are different claims. Option F closes the population without anyone having counted it, which is the honest description of what shipped: the fix is free, so it did not have to wait for the count, and the count is still owed.
- **Option F is deployed to dev (2026-10-27) and NOT VERIFIED there,** so its effect on a live deployment is unmeasured in both directions. Nothing reports how often the bound refuses a candidate, which is the same figure the bullet above asks for and would answer it from the other side: the warning the matcher logs when every copy of the text postdates the turn's start is the cheapest instrument for it and nothing aggregates that log.
- **The ambiguity inside one turn's start window stays.** Two identical messages sent before the turn began are still indistinguishable to a content match, and option F makes no claim about them. What it removes is the population the queue creates.
- **The entry comparison is ADR-036's and ADR-041's, taken 2026-09-16.** Flow-dispatched time to first feedback beats Amazon Lex-entered by a few hundred milliseconds once the prompt is held fixed, which is consistent in direction and not decisive in size. This record does not take it.
- **The private-1:1 route without Amazon Lex is not designed, and the taken form does not need one.** Under `TargetedMessages: ALL` a private message still enters through Amazon Lex. A bypass that also took targeted messages from Amazon Lex would need a route that does not fail toward disclosure, and none exists.
- **Neither queued figure reaches an operator.** `v_queued_exchange` has no reader outside the schema and `v_queue_acknowledgement` has one, which is a backfill sampler. A definition that matches and that nobody can read is not yet a measurement anyone has.
- **`drained_ms` is a floor, not the wait.** The episode-losing case in migration 043's header drops the longest-waiting message of each affected episode, so any distribution built on it is biased short, and nothing currently reports how often that happens.
- **The queue is off by default,** so every claim in this record about queued behavior describes a deployment run with `-c turnQueue=true` and describes nothing at all about a default one.

## Consequences

- **ADR-036's measurement is taken 2026-09-16, and the second precondition this record named is resolved.** Narrowing the Amazon Lex entry is the change that makes the pairing question disappear, and a 1:1 private message keeps its visibility because `TargetedMessages: ALL` still carries it through Amazon Lex.
- **ADR-037's residual is unchanged on the default path** and is narrowed on the queued path by option F, because the population that declares a WRONG id shrinks to the ambiguity inside one turn's start window. ADR-037 names the exposure as its resolved-by-search provenance and says that a declaration minted from a search is not the turn's own knowledge; option F bounds the search and does not change what the label says about it, so both halves of that finding stand.
- **ADR-037's sweep deferral makes this record's fix load-bearing rather than optional.** That deferral waits until a turn's declaration is readable and then trusts it, so a wrong declaration is no longer a wrong label that a reader could at least see was reconstructed; it is a `declared` pairing carrying a flattering latency. The two changes landed the same day and they have to travel together: the scheduling fix on the reader's side, the bound on the writer's.
- **ADR-033's refusal of an inferred queued mapping stands and is not weakened by the owner's row definition,** because that definition's end instant is a batch event and claims no mapping.
- **`backend/lambda/src/lib/flow-bypass.ts` gains a recorded reason for a change it must not take.** The 1:1 branch has now been proposed for conditioning twice, and the reason it stays unconditional is written here rather than only in the module header.
- **Revisit when** a private message's visibility can be determined by the channel flow without a post-release read, or when a deployment reports how often the late match lands on a message created after the turn began.
