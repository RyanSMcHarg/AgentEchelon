---
title: "ADR-030: A message is answered by the assistant whose work it answers"
status: Accepted 2026-08-14 (owner). Built and deployed; the handover half is not exercised live.
date: 2026-08-14
related:
  - "../../guides/developer/MESSAGE-FLOW.md"
  - "../../specs/capabilities/DESIGN-BATTLE.md"
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
  another bot's Lex; when ADR-023's B-proxy identities land, the handover can move onto them.
---

# ADR-030: A message is answered by the assistant whose work it answers

## Status

**Accepted (owner, 2026-08-14). Built and deployed to mcharg-dev.**

Verification is uneven and is stated per part rather than as a single claim:

| Part | State |
|---|---|
| The normalized delivery pair | Built. `Verified by:` `test/lib/resumed-chain-delivery.test.ts`; the live half is B-E7's receipt-stays-private assertion |
| A duel side resumes on the path a duel takes | Built. `Verified by:` `test/lib/handover-follows-the-task.test.ts`; live verification is B-E7's positive control |
| The handover | Built. `Verified by:` `test/lib/handover-follows-the-task.test.ts`. **No live exercise exists**: it needs two assistants where the one addressed does not own the chain, which no e2e sets up |

## Problem and who it's for

Someone is asked a question by an assistant and answers it, and nothing happens.

They are in a conversation with more than one assistant, or they are running a duel where two of them
are working at once. One stops and asks them something. They answer, in the conversation, the way
anyone would. What follows depends on details they have no reason to know about: whether they happened
to address their reply to a particular assistant, and which assistant that was.

Answer without addressing anyone, and whichever assistant is configured to respond treats it as its
own, absorbing it into work it was not about. The assistant that actually asked stays blocked. Address
the wrong one and the same thing happens. Address the right one and the answer comes back in a message
only they can see, so a duel meant to be compared is not comparable, and everyone else in the room sees
a conversation that stopped mid-sentence.

None of these look like failures. A reply arrives. A turn is answered. The workflow simply never moves,
and the person is left re-reading what they typed.

## Decision

**Routing follows the TASK, never the target.**

Targeting is a DELIVERY concern that the client already settles when the message is sent. It says who
can see a message. It does not say what the message is about, and it was never able to: what a message
is about is answerable from the work itself, because a chain records the assistant whose work it is.

Three parts follow from that.

### 1. Untargeted and mis-targeted are the same case

The assistant that RECEIVES a message is not necessarily the one whose work it answers. So the turn
resolves the chain, reads its `assistantId`, and if that is not itself, hands the turn to the assistant
it names. It does not answer work it does not own, and it does not drop the message.

When the person holds more than one chain, the receiving assistant's own wins. Not because targeting
decides routing, but because a person mid-conversation with an assistant about work of its own is
answering THAT, and the reading that makes their message answer someone else's question is the wrong
one. Two duel sides waiting on the same person is exactly this case.

### 2. One normalized delivery pattern

A resumed chain always produces the same two messages: the ANSWER untargeted, and a RECEIPT targeted at
the person who spoke.

This cannot ride Amazon Chime SDK's inheritance, which is why it is a decision and not a default. A Lex
reply inherits the INBOUND message's targeting, so left alone the pair inverts with how the person
happened to send:

| The person's message | What inheritance produces | Why it is wrong |
|---|---|---|
| Targeted at the assistant | A private placeholder | The answer is buried where only its sender can read it |
| Untargeted | A public placeholder | The receipt is broadcast, so the channel gets the answer AND a note saying the answer is elsewhere |

Both were observed on the deployment. So the code reads which of the two the placeholder already is and
posts the other. Exactly one is ever posted: the pair is two messages, never one and never three.

### 3. A mis-targeted message has its own copy

The receiving assistant gives a targeted receipt naming where the work went, and the owning assistant's
turn then owes the answer and nothing else. Without that, one message earns two receipts, the second
contradicting the first about who is acting.

## An `@mention` with no task reference is a SUPPORTED path, not a gap

It looks like one, and it is worth stating so it is not re-raised. A person answers a waiting step by
`@`-mentioning an assistant and attaches nothing - no chip, no task reference. The assistant still
understands what they are answering:

```
@Assistant-premium  audience is engineering leadership
  -> Amazon Chime SDK routes it to that bot's Lex
  -> the turn resolves the chain the person HOLDS in this channel
  -> the response is applied and the step is grounded, including what it still needs (ADR-031)
```

Nothing is parsed out of the message and nothing is carried on it. That is the decision working, not a
fallback: routing follows the TASK, so a client hint is never the mechanism.

**It could not be the mechanism here in any case.** Lex fulfillment never receives message `Metadata` -
the request attributes are exactly `CHIME.channel.arn`, `CHIME.sender.arn` and
`x-amz-lex:channels:platform` - so a task reference on the message is invisible to the turn it would be
informing. A client hint is readable only by the channel flow and by the message stream, which is why
its one job is detecting a message that triggered NOTHING (ADR-032), never routing one that did.

**Addressing the WRONG assistant is the mis-targeted case above**, and is handed over with a receipt.

**One ambiguity is left deliberately unresolved.** If someone mentions assistant A while A ALSO holds a
chain with them, A answers its own rather than handing over - the mention is taken as the
disambiguator, because they named A. It only misfires when they address A, mean to answer B, and A has
work with them too. Resolving it would mean reading the message back with `GetChannelMessage` on every
turn to settle a case that needs two coincidences, which is the trade ADR-032 tenet 5 says not to make.
The recovery is that B's chain stays visibly waiting on them rather than being silently lost.

## What this rejects

**Carrying the target to the server.** Two candidates were weighed and both are discarded by the
decision above rather than by their costs: putting the `Target` in message `Metadata`, and reading it
back with `GetChannelMessage` from the channel flow. Both answer "who was this addressed to", which is
not the question. The `Target`-based continuation in the channel flow is superseded by this ADR, not
repaired.

**A handover sent as a message.** [ADR-023](./023-battle-round-coordination.md) measured that Amazon
Chime SDK does not deliver a bot-authored message to another bot's Lex: bot to bot produced zero
handler invocations against a control of one. A handover expressed as a message would reach nobody at
all. It is therefore a Lambda invoke over the existing handler bypass, the same seam the round-2
dispatch runs on. When ADR-023's B-proxy identities land it can move onto them.

## How the hop is bounded

Not by a counter. ADR-023's `aecoord` hop cap is self-declared by each side, and tracker row 66 records
that this does not bound an exchange at all. Here, only a turn that did NOT arrive by handover may
create one, so the chain is bounded at one hop structurally.

Two further guards, because each closes a failure that would otherwise be invisible:

- **Identity is validated, never assumed.** The owning bot's ARN is reconstructed from the chain's
  `assistantId` and checked with `isSanctionedBattleBot`, the same gate that stops a caller-supplied
  identity becoming an impersonation seam. This is the path that reaches it from STORED DATA rather
  than from a caller, so a task carrying a junk or foreign `assistantId` cannot make a handler run a
  turn as an arbitrary bot.
- **A handover is claimed per inbound message.** Delivery is at-least-once, and this runs ahead of the
  turn's own correlation claim, which is minted per fulfillment and so does not cover a redelivery.
  Unclaimed, a duplicate gives the person two receipts and the owning assistant two turns.

## Consequences

**A duel side is resumed by whichever path answers the chain.** Under
[ADR-024](./024-task-ownership.md) ownership follows the state a chain STARTS in, and every task-shaped
chain starts in one that awaits the person, so the person holds it from its first moment and the
person-owed lookup is the one that finds it. The duel resume had been written on the assistant's-own-
chain branch, which that made unreachable for duels. Measured on the deployment by B-E7's positive
control: the answer was accepted, the task advanced, both sides sat in `WAITING_FOR_USER`, and round 2
never fired. Resuming a side is a consequence of the chain being answered, not of which lookup found
it, so it is one function called from both paths.

**The owner rule needs no check on the person-owed path.** That lookup only ever returns a chain THIS
PERSON holds, so a member who did not start the duel finds nothing and advances nothing. The refusal is
structural rather than a comparison that could be got wrong.

**Broadcasting is scoped to a duel.** An ordinary task continuation in a 1:1 has no public to broadcast
to, and splitting it would add a receipt nobody needs to every such turn.

**The IAM grant is a policy of its own.** `grantInvoke` puts its statement on the role's default policy,
which the function depends on, so naming the function there closes a CloudFormation dependency cycle
and the template will not deploy. A separate policy resource carries no such dependency. The first
attempt used a name pattern built from the stack name instead, which deployed green and denied at
runtime, because CloudFormation truncates the stack name when the generated physical name would exceed
64 characters.

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
