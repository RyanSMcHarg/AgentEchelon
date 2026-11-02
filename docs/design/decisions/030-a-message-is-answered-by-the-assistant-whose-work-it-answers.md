---
title: "ADR-030: A message is answered by the assistant whose work it answers"
status: Accepted 2026-08-14 (maintainer). Built and deployed; the handover half is not exercised live.
date: 2026-08-14
related:
  - "../../guides/developer/MESSAGE-FLOW.md"
  - "../../specs/interaction/quality/DESIGN-BATTLE.md"
  - "./023-battle-round-coordination.md"
  - "./024-task-ownership.md"
  - "./025-who-posts-the-placeholder.md"
  - "./029-clarification-is-public-and-answers-get-their-own-placeholder.md"
  - "./031-a-step-says-what-it-needs.md"
  - "../../../backend/lambda/src/router-agent-handler.ts"
  - "../../../backend/lambda/src/lib/resumed-chain-delivery.ts"
  - "../../../backend/lambda/src/lib/async-processor-core.ts"
tracking: |
  Replaces targeting as a routing input. The channel flow's `Target`-based battle continuation is
  measurably dead (the flow callback carries no `Target`) and is superseded rather than repaired.
  The handover is a Lambda invoke because ADR-023 measured that a bot-authored message never reaches
  another bot's Lex. B-proxy is NOT the route it moves onto: assistant-to-assistant traffic rides the
  Kinesis stream with post-processing delivering or dispatching, which is a consumer that can see a
  bot-authored message because it reads the stream rather than waiting on Lex.
---

# ADR-030: A message is answered by the assistant whose work it answers

## Status

**Accepted (maintainer, 2026-08-14). Built and deployed to the dev deployment.**

Verification is uneven and is stated per part rather than as a single claim:

| Part | State |
|---|---|
| The normalized delivery pair | Built. `Verified by:` `test/lib/resumed-chain-delivery.test.ts`; the live half is B-E7's receipt-stays-private assertion |
| A duel side resumes on the path a duel takes | Built. `Verified by:` `test/lib/handover-follows-the-task.test.ts`; live verification is B-E7's positive control |
| The handover | Built. `Verified by:` `test/lib/handover-follows-the-task.test.ts`. **No live exercise exists**: it needs two assistants where the one addressed does not own the chain, which no e2e sets up |

## Problem and who it's for

Someone is asked a question by an assistant and answers it, and nothing happens.

They are in a conversation with more than one assistant, or they are running a duel where two of them are working at once. One stops and asks them something. They answer, in the conversation, the way anyone would. What follows depends on details they have no reason to know about: whether they happened to address their reply to a particular assistant, and which assistant that was.

Answer without addressing anyone, and whichever assistant is configured to respond treats it as its own, absorbing it into work it was not about. The assistant that actually asked stays blocked. Address the wrong one and the same thing happens. Address the right one and the answer comes back in a message only they can see, so a duel meant to be compared is not comparable, and everyone else in the room sees a conversation that stopped mid-sentence.

None of these look like failures. A reply arrives. A turn is answered. The workflow simply never moves, and the person is left re-reading what they typed.

## Decision

**Routing follows the TASK, never the target.**

Targeting is a DELIVERY concern that the client already settles when the message is sent. It says who can see a message. It does not say what the message is about, and it was never able to: what a message is about is answerable from the work itself, because a chain records the assistant whose work it is.

Three parts follow from that.

### 1. Untargeted and mis-targeted are the same case

The assistant that RECEIVES a message is not necessarily the one whose work it answers. So the turn resolves the chain, reads its `assistantId`, and if that is not itself, hands the turn to the assistant it names. It does not answer work it does not own, and it does not drop the message.

When the person holds more than one chain, the receiving assistant's own wins. Not because targeting decides routing, but because a person mid-conversation with an assistant about work of its own is answering THAT, and the reading that makes their message answer someone else's question is the wrong one. Two duel sides waiting on the same person is exactly this case.

### 2. One normalized delivery pattern

A resumed chain always produces the same two messages: the ANSWER untargeted, and a RECEIPT targeted at the person who spoke.

This cannot ride Amazon Chime SDK's inheritance, which is why it is a decision and not a default. A Lex reply inherits the INBOUND message's targeting, so left alone the pair inverts with how the person happened to send:

| The person's message | What inheritance produces | Why it is wrong |
|---|---|---|
| Targeted at the assistant | A private placeholder | The answer is buried where only its sender can read it |
| Untargeted | A public placeholder | The receipt is broadcast, so the channel gets the answer AND a note saying the answer is elsewhere |

Both were observed on the deployment. So the code reads which of the two the placeholder already is and posts the other. Exactly one is ever posted: the pair is two messages, never one and never three.

### 3. A mis-targeted message has its own copy

The receiving assistant gives a targeted receipt naming where the work went, and the owning assistant's turn then owes the answer and nothing else. Without that, one message earns two receipts, the second contradicting the first about who is acting.

## An `@mention` with no task reference is a SUPPORTED path, not a gap

It looks like one, and it is worth stating so it is not re-raised. A person answers a waiting step by `@`-mentioning an assistant and attaches nothing - no chip, no task reference. The assistant still understands what they are answering:

```
@Assistant-premium  audience is engineering leadership
  -> Amazon Chime SDK routes it to that bot's Lex
  -> the turn resolves the chain the person HOLDS in this channel
  -> the response is applied and the step is grounded, including what it still needs (ADR-031)
```

Nothing is parsed out of the message and nothing is carried on it. That is the decision working, not a fallback: routing follows the TASK, so a client hint is never the mechanism.

**It could not be the mechanism here in any case.** Lex fulfillment never receives message `Metadata` - the request attributes are exactly `CHIME.channel.arn`, `CHIME.sender.arn` and `x-amz-lex:channels:platform` - so a task reference on the message is invisible to the turn it would be informing. A client hint is readable only by the channel flow and by the message stream, which is why its one job is detecting a message that triggered NOTHING (ADR-032), never routing one that did.

**Addressing the WRONG assistant is the mis-targeted case above**, and is handed over with a receipt.

**One ambiguity is left deliberately unresolved.** If someone mentions assistant A while A ALSO holds a chain with them, A answers its own rather than handing over - the mention is taken as the disambiguator, because they named A. It only misfires when they address A, mean to answer B, and A has work with them too. Resolving it would mean reading the message back with `GetChannelMessage` on every turn to settle a case that needs two coincidences, which is the trade ADR-032 tenet 5 says not to make. The recovery is that B's chain stays visibly waiting on them rather than being silently lost.

## What this rejects

**Carrying the target to the server.** Two candidates were weighed and both are discarded by the decision above rather than by their costs: putting the `Target` in message `Metadata`, and reading it back with `GetChannelMessage` from the channel flow. Both answer "who was this addressed to", which is not the question. The `Target`-based continuation in the channel flow is superseded by this ADR, not repaired.

**A handover sent as a message THROUGH LEX.** [ADR-023](./023-battle-round-coordination.md) measured that Amazon Chime SDK does not deliver a bot-authored message to another bot's Lex: bot to bot produced zero handler invocations against a control of one. A handover routed that way would reach nobody at all. It is therefore a Lambda invoke over the existing handler bypass, the same seam the round-2 dispatch runs on.

**That rejection is about the ROUTE, not about messages**, and the distinction matters now that assistant-to-assistant traffic has a decided shape. Bot-to-bot messages ride the Kinesis stream, and POST-PROCESSING delivers them or dispatches on them per use case - a consumer that sees a bot-authored message perfectly well, because it is reading the stream rather than waiting for Lex to route. So a hand-over MAY be expressed as a message on that path; what it may not be is a message expected to arrive by the Lex route this ADR measured as dead.

An earlier version of this note said the handover could move onto ADR-023's B-proxy identities once they landed. That is superseded: B-proxy was not the shape chosen, and the stream plus post-processing is.

## How the hop is bounded

Not by a counter. ADR-023's `aecoord` hop cap is self-declared by each side, measured on the deployment: that this does not bound an exchange at all. Here, only a turn that did NOT arrive by handover may create one, so the chain is bounded at one hop structurally.

Two further guards, because each closes a failure that would otherwise be invisible:

- **Identity is validated, never assumed.** The owning bot's ARN is reconstructed from the chain's `assistantId` and checked with `isSanctionedBattleBot`, the same gate that stops a caller-supplied identity becoming an impersonation seam. This is the path that reaches it from STORED DATA rather than from a caller, so a task carrying a junk or foreign `assistantId` cannot make a handler run a turn as an arbitrary bot.
- **A handover is claimed per inbound message.** Delivery is at-least-once, and this runs ahead of the turn's own correlation claim, which is minted per fulfillment and so does not cover a redelivery. Unclaimed, a duplicate gives the person two receipts and the owning assistant two turns.

**What the one-hop bound means once a primary can delegate.** A primary that hands a turn to another assistant SPENDS the single hop: the receiving turn arrived by handover, so it may not hand on again. That is the intended reading rather than a limitation to design around - a chain of assistants each passing a question along is indistinguishable, from where the person sits, from nobody answering it. An assistant that cannot do the work and cannot pass it on says so, in the room, which is an outcome somebody can act on.

## Extending this to a room with more than one assistant

**Status: partly built.** Roles exist per classification (a classification has roles such as `(premium, primary)` and `(premium, ops)`), a room can hold several assistants of one classification, an addressed assistant answers directly, and the primary delegates (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION Phase 4). A room records its primary (the `primaryAssistant` tag) and every path that speaks for it resolves through one resolver; that is built and not yet deployed ([DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION](../../specs/interaction/assistants/DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md) §3.8). **NOT BUILT:** changing a room's primary, and the notice that a room gained a second assistant. This section is the plan for the case the rule was always written for. It lives here rather than in an ADR of its own because it is not a new decision - it is this ADR's rule ("a message is answered by the assistant whose work it answers") applied to a room where the question finally has more than one possible answer. The fan-out MECHANISM for one assistant spinning up ephemeral sub-agents is a different thing and is owned by [DESIGN-MULTI-AGENT-ORCHESTRATION](../../specs/interaction/assistants/DESIGN-MULTI-AGENT-ORCHESTRATION.md): that doc is about workers the user never addresses, this section is about assistants the user can.

### What blocks it, precisely

The responder is resolved from the room's CLASSIFICATION, never from its membership or roles. The lookup was called `resolveBotArn` and has been renamed `resolvePrimaryBotArn`, because the old name claimed to answer "which assistant acts for this room" while it actually answered "which bot does this classification have". Those are the same answer only while a room has one assistant, and the name is what hid the assumption from every call site.

The rename is behavior-neutral and is done. What it unblocks is giving a conversation assistant ROLES and resolving the primary from them. Classification keeps deciding what an assistant may DO - it is the access boundary and stays tag-authoritative - and stops deciding who acts, which was only ever a coincidence of there being one of them.

### `@all` reaches the primary, which decides

Not fanned out to every assistant, and not refused. Fanning out produces N answers to one question, which is the doubling the turn design exists to prevent; refusing pushes routing onto the person on every turn, including the many where they neither know nor care which assistant should take it, and asking the room rather than a directory is the reason a shared room exists.

Room size changes the mechanics beneath the rule, not the rule. In a **1:1** the Lex path is also routing the message, because AUTO routes everything when there is one other member, so both entries see the turn and the router stands down for `@all` so exactly one answers. In a **group** AUTO routes nothing unaddressed, so the flow is the only entry and the primary is reached alone.

### The primary delegates two ways, for two different things

| Mechanism | When | Why |
|---|---|---|
| **Direct invoke** | the primary needs an answer to finish its own turn | It is a call, and the person is waiting on ONE reply - the primary's. Nothing new appears in the conversation because nothing new happened in it. This is the same hop this ADR already bounds. |
| **Assistant-to-assistant message** | the work belongs to the other assistant from here on | It is a hand-over, not a question. The receiving assistant answers the room itself, holds its own turn lock, and owns the resulting work item. It rides the Kinesis stream with post-processing dispatching on it - the decided shape for bot-to-bot traffic - and NOT the Lex route this ADR measured as dead. |

**A hand-over is announced in the room, naming the assistant it went to.** An answer from an assistant nobody addressed, to a question asked of the room, is a surprise even when it is the right answer.

### A person may still address one assistant directly, and privately

A mention routes to that assistant and bypasses the primary entirely - somebody who knows who they want does not go through a receptionist. Targeting an assistant privately gets a private answer back from THAT assistant, and neither the primary nor any other assistant in the room learns what was asked.

That second path is why this cannot be built as "everything flows through the primary". A primary that saw every message would see the private ones, and a private request to one assistant would become readable by another.

### Two constraints that are easy to miss

**Gaining a second assistant silently changes how the room answers.** Chime AUTO counts other non-hidden members and BOTS COUNT, so adding any second bot flips a 1:1 from routing every message to routing only mentions. The room stops answering unaddressed messages, and nothing about it looks different to the person in it. The room is told, at the moment it gains its second assistant. This is the cheapest item in the plan and the one most likely to be skipped, because the change is invisible to whoever builds it and obvious only to whoever is using it.

**Every assistant in a room shares the room's classification.** A room holding assistants of two classifications has two answers to "what may be read here", and the only safe resolution drops everything to the lowest, which is what nobody wants and nobody would predict. Crossing that boundary is what a hand-off to another conversation is for.

### What is already right and is not rebuilt

| Already true | Why it matters here |
|---|---|
| the turn lock is keyed on (conversation, ASSISTANT) | busy is a property of the assistant, so two working at once is a supported state rather than a race to fix |
| a work item records the assistant it belongs to, fixed for life | routing a change request is a lookup, not a guess - which is this ADR's own rule |
| the queue's reading carries per-message targeting and per-subject ownership | a queue arriving while two assistants are busy is already separable by whose it is |

The one thing to verify rather than assume: the client unions the queues so a message waiting on the second assistant is styled as waiting. That is asserted today only in a unit test, because the deployment provisions two answering assistants only for a duel and a duel deliberately does not take the turn lock. Multi-assistant makes the path real and it needs an end-to-end assertion when it does.

### Sequence

1. **Rename the lookup to what it resolves.** Done, behavior-neutral, and it stops later work inheriting the assumption the old name hid.
2. **Give a conversation assistant roles, and resolve the primary from them.** Single-assistant rooms resolve exactly as they do now.
3. **Let a room hold several assistants of one classification.** Private targeting works from here, because it needs only addressing, which already exists.
4. **The mode-change notice.** Ships HERE, with the first room that can have two assistants, because the silent change lands when the second one joins whether or not anything has been delegated.
5. **Delegation: direct invoke, then hand-over with its announcement.** The announcement is not later polish - the first handed-over turn is the first turn a person can be surprised by.
6. **The end-to-end queue assertion**, once two assistants can genuinely both be busy.

## Consequences

**A duel side is resumed by whichever path answers the chain.** Under [ADR-024](./024-task-ownership.md) ownership follows the state a chain STARTS in, and every task-shaped chain starts in one that awaits the person, so the person holds it from its first moment and the person-owed lookup is the one that finds it. The duel resume had been written on the assistant's-own-chain branch, which that made unreachable for duels. Measured on the deployment by B-E7's positive control: the answer was accepted, the task advanced, both sides sat in `WAITING_FOR_USER`, and round 2 never fired. Resuming a side is a consequence of the chain being answered, not of which lookup found it, so it is one function called from both paths.

**A third resume site covers the TASKLESS wait.** A round-1 clarification asked before any chain exists parks the side in `WAITING_FOR_USER` with no task row - the wait lives on the battle row alone
- so neither chain-answering path above finds anything to resume. The handler therefore checks, when no task was found, whether the active duel has a side waiting in this channel, and resumes it. The owner rule is preserved (the duel answers to whoever started it, and an unrecorded initiator fails open rather than making the side unresumable), and the check runs BEFORE the generic task fallback so an unrelated open task cannot absorb the answer while the duel strands.

**The owner rule needs no check on the person-owed path.** That lookup only ever returns a chain THIS PERSON holds, so a member who did not start the duel finds nothing and advances nothing. The refusal is structural rather than a comparison that could be got wrong.

**Broadcasting is scoped to a duel.** An ordinary task continuation in a 1:1 has no public to broadcast to, and splitting it would add a receipt nobody needs to every such turn.

**The IAM grant is a policy of its own.** `grantInvoke` puts its statement on the role's default policy, which the function depends on, so naming the function there closes a CloudFormation dependency cycle and the template will not deploy. A separate policy resource carries no such dependency. The first attempt used a name pattern built from the stack name instead, which deployed green and denied at runtime, because CloudFormation truncates the stack name when the generated physical name would exceed 64 characters.

## How this gets proven

| Invariant | The test that can fail |
|---|---|
| A message answers the chain, not the addressee | A chain owned by another assistant; assert the turn invokes that assistant and does NOT apply the response itself |
| The receiving assistant does not go silent | An unsanctioned `assistantId`; assert no handover, no receipt, and that the person still gets an answer |
| A handover cannot impersonate | A chain naming a bot in no roster; assert `isSanctionedBattleBot` refuses and a security event is logged |
| The hop is bounded at one | A handed-over turn whose chain still names another assistant; assert it does not hand over again |
| One message, one handover | Replay the same inbound id; assert the second delivery hands nothing over AND does not answer instead |
| The answer is public, the receipt is private | Both placeholder shapes; assert exactly one message is posted, and which one |
| A receipt is never doubled | A handed-over turn; assert the worker is told the receipt is already given |
| An id is never shown to a person | An unresolvable variant; assert the copy contains no principal id |
| A duel side resumes on the person-owed path | Answer a chain the person holds; assert THIS side leaves `WAITING_FOR_USER` and the rival does not |
| An ordinary continuation is not broadcast | The same, with no active duel; assert no broadcast and no resume |
| The self-invoke grant names the function | Synth; assert the ARN, and that it is NOT on the role's default policy |
