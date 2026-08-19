---
title: "ADR-025: Who posts the placeholder"
status: Accepted 2026-08-10 (option 1; built and deployed the same day)
date: 2026-08-10
related:
  - "../../guides/developer/MESSAGE-FLOW.md"
  - "./022-message-identity-is-established-at-the-channel-flow.md"
  - "./023-battle-round-coordination.md"
  - "../../../backend/lambda/src/router-agent-handler.ts"
  - "../../../backend/lambda/src/channel-flow-processor.ts"
  - "../../../backend/lib/stacks/assistant-profile-stack.ts"
tracking: |
  ACCEPTED AND BUILT (option 1); see Status. The question it settles: the handler already composes the
  placeholder TEXT but could not send, so the ACT was performed by Amazon Chime SDK Messaging on the
  Lex path and by the channel flow on a bypass, and one profile setting reached the channel by two
  routes. The acknowledgment is the assistant's own, so the assistant speaks it, and an assistant's
  author controls it. This reopens a question previously closed on the IAM constraint alone: the
  read-only handler role is a real cost, but it is a cost to be priced rather than a reason not to ask.
---

# ADR-025: Who posts the placeholder

## Status

**Accepted: option 1.** Built and deployed 2026-08-10.

The turn posts its own acknowledgment on a flow entry and returns an empty `messages` array; the
caller's contract is unchanged, so the channel flow's posting became its FALLBACK for when a turn
hands the message back. Implemented as a wrapper at the handler's entry rather than by editing every
return path, which also means the dispatch is NOT reordered and no `placeholderMessageId` is handed
over on the `@all` and `/battle` paths - priced at one skipped GetItem and declined (see the
accounting under option 1).

Verified by `assistant-posts-its-own-acknowledgment.test.ts` and
`handler-send-grant-carries-archive-deny.test.ts`, mutation-proven three ways (removing the flow-entry
gate fails the Lex-path test; trusting a caller-supplied bot identity fails the sanction test; a raw
send grant outside the shared helper fails the source scan), and exercised live: `mentions.spec.ts`
4/4 against the deployment, including "a 1:1 `@all` is answered exactly once, by one entry".

## Context

A `PLACEHOLDER_UPDATE` turn shows the user an acknowledgment ("One moment...") that the async processor
later overwrites with the answer. **The handler already decides what that acknowledgment says**:
`getQuickResponse` and `getTaskPlaceholder` live in `lib/delivery-options.ts` and are resolved in
`router-agent-handler.ts`, from the profile version the handler loaded.

**Sending is not the handler's job by default, and that is the constraint this decision confronts.**
`AgentHandlerRole` is scoped to reads of channel state, and `chime:SendChannelMessage` belongs to
`ProcessorRole` (`assistant-profile-stack.ts:224-232`), the component that writes the answer. Giving
the handler any send is a real widening of a role kept deliberately read-only, so it is the cost an
answer has to justify rather than a detail. Whichever way it is resolved, the words are authored in one
component and performed by another.

**The routing this decision is called on to fix**, one profile-resolved behaviour reaching the channel
by four routes:

| Entry | Who performs the send |
|---|---|
| ordinary Lex turn | Amazon Chime SDK, materialising the fulfillment return |
| `@all`, `/battle` round 1 | the channel flow, via `sendBotMessage` |
| battle continuation | the channel flow (or it reuses the waiting message) |
| round 2 | the battle orchestrator |

Under the accepted option the middle two rows become the assistant itself; the Lex path and round 2 are
unchanged. See **Decision** below.

**Why this is worth an ADR rather than a cleanup.** Nothing is broken today. The problem is that one
profile-resolved behaviour reaches the channel by four routes, which is the divergence class the
`@all` and round-1 handoffs exist to remove: a difference that cannot error, only drift. It is also
the last product-shaped thing the channel flow does on a turn path, against the rule that the flow
decides who responds and nothing else (MESSAGE-FLOW 3.1).

**The question was closed early once.** The prior framing was that the handler cannot write to a
channel, therefore posting stays where it is, therefore the `corr#` mapping and its marker-scan
fallback are unavoidable. The premise is true and the conclusion does not follow: the grant is a
deployment decision rather than a platform limit, and the handler is not the only alternative to the
flow.

### What must be true of any answer

- **The acknowledgment is the assistant's behaviour.** Whether to acknowledge, in what words, and
  whether a long task announces itself differently, are properties of the profile version, so an
  assistant's author controls them by editing a profile rather than by editing a Lambda.
- **One authored behaviour, one route to the channel**, or an explicitly stated reason for more.
- **TTFF does not regress.** It is measured as placeholder timestamp minus user message timestamp and
  is already around 4.5s against a 1s target, so anything added to the handler's synchronous path is
  paid on every turn.
- **Archived channels stay read-only.** Any new send grant must carry the existing Deny.
- **A duplicate turn still produces one placeholder.** ADR-022's guarantee is not weakened.

## Options

### 1. The handler posts on the bypass paths (leaning)

The handler posts its own placeholder for `@all`, `/battle` and any future bypass, and returns to its
caller the fact that it has done so rather than the text to post. The Lex path is unchanged: Chime
keeps materialising that placeholder from the fulfillment return.

- **It matches what is actually happening.** The assistant acknowledges the request it received, then
  hands off to the processor for the full response. The component that decided what the turn IS is the
  component that speaks.
- **The channel flow stops writing user-visible messages on a turn path entirely**, leaving it with
  release, drop, and hand the turn over. Its remaining sends are its own rejection notices, which are
  the flow speaking for itself rather than for an assistant. **It does NOT leave the flow uninvolved
  in the turn**: the flow still claims the `corr#` mapping on every placeholder it observes, which the
  Lex path depends on. The claim is not a product behaviour, so it is consistent with the rule; but
  "the flow is out of the placeholder business" would be false and is not what this option delivers.
- **The handler holds the `MessageId`**, from `SendChannelMessage`'s own response; no lookup is
  involved, and `sendBotMessage` (`channel-flow-processor.ts`) already returns it for exactly this
  reason. It can therefore hand `placeholderMessageId` to the processor at dispatch - but see the
  accounting below before treating that as a benefit, because resolution is not currently a problem
  on either path.
- **It requires REORDERING the handler, and that is the part an implementer would otherwise discover.**
  Today the handler dispatches the processor and THEN returns the placeholder text
  (`router-agent-handler.ts`, the `invokeAsyncProcessor` call precedes the `formatLexResponse`
  return), which is why it currently cannot hand over an id: at dispatch time the placeholder does not
  exist. Holding the id means the sequence becomes **compose, send, take the id from the response,
  dispatch with it, return**. Three consequences follow, and the third is an improvement rather than a
  cost:
  - **TTFF improves slightly.** The placeholder is posted before the handler returns rather than after
    its caller receives the return, which removes one hop from the first visible feedback on a bypass.
  - **The processor dispatch is delayed by one Chime round trip.** The answer lands that much later.
    Small, and paid only on bypass turns.
  - **A failed send stops being silent.** Today the dispatch has already gone when the caller's send
    fails, so the processor produces an answer with no placeholder to update and falls back to a scan.
    Posting first lets the handler decline to dispatch and say so, which is the honest failure.
- **One property to verify rather than assume: a handler-posted placeholder is created `PENDING`.**
  Every message crosses the channel flow, so `SendChannelMessage` returns the id immediately while the
  message is still pending release. The processor could in principle be handed an id it cannot yet
  update. This is not new and there is shipped evidence it holds: the battle continuation's fallback
  path already posts a placeholder, takes the returned id and dispatches with it immediately
  (`waitingMsgId` in `channel-flow-processor.ts`). The evidence is that path working, not an argument
  from timing, and a test should pin it.
- **Cost: two resolution paths again.** The Lex path still resolves by lookup, because Chime
  materialises that placeholder and no AE component ever sees its id. The `@all` handoff deliberately
  collapsed to one path; this re-splits it. The split is at least principled - whoever can know the id
  passes it - but it is a real reversal and must be recorded as one rather than discovered later.
- **IT BUYS ESSENTIALLY NOTHING FOR PLACEHOLDER RESOLUTION, and that must not be claimed for it.**
  The tempting argument is that holding the id removes the `corr#` mapping and the marker/poll
  fallback. It does not, because **resolution already works on both paths today**:
  - The id IS known, and known in time. The channel flow learns it the moment the Lex-materialised
    placeholder crosses it, and `claimPlaceholderMapping` writes `corr# -> MessageId` there. Nothing
    is missing; what is true is only that no component holds the id at DISPATCH time.
  - The processor does not need it at dispatch. It resolves at FINALIZE, after the model call, by a
    single mapping read. The mapping lands in about a second and the model call takes seconds, so the
    read succeeds.
  - `pollForPlaceholderMessage` is the THIRD fallback, after the mapping read and an explicitly handed
    id, on both the success and error paths. On an ordinary turn it does not run.

  So the honest accounting is: this option lets the bypass paths skip **one GetItem**. The mapping, the
  fallback and the flow's claim all stay, and they stay under option 2 as well for as long as any path
  is Lex-materialised. **Option 1 is an ownership change, not a simplification, and the case for it
  has to rest on ownership alone.**
- **Cost: one IAM grant**,
  `classificationChannelScopedAllow(classification, appInstanceArn, ['chime:SendChannelMessage'])` -
  the same helper `ProcessorRole` uses, which layers the archived-channel read-only Deny automatically
  because `SendChannelMessage` is in `ARCHIVE_DENIED_ACTIONS`. It is an existing grant shape applied to
  a second role, not a new privilege shape.
- **TTFF: neutral.** The send happens on the bypass either way; it moves from the flow's process into
  the handler's, saving one return trip.

### 2. The handler posts on every path, and returns an empty envelope to Lex

As option 1, plus the Lex path: the handler posts the placeholder itself and returns `messages: []`.

- **One resolution path everywhere, reached from the other side.** Not "everyone looks it up" but
  "nobody needs to": every placeholder has a known id at dispatch, so the `corr#` mapping and its
  fallback could retire. **Weigh this modestly.** Resolution is not failing today - the mapping is
  written by the flow the instant the placeholder appears and is read once, at finalize, long after it
  has landed. This removes a working mechanism rather than a broken one.
- **Blocker: Chime materialises a message even from an empty `messages` array.** Verified live and
  recorded at the flow's duplicate-placeholder guard. So every ordinary turn would leave a stray empty
  envelope beside the real placeholder. Removing it means the channel flow inspecting and dropping
  Lex envelopes, which is more flow behaviour rather than less and contradicts the rule this ADR is
  trying to serve.
- **Cost: TTFF on every ordinary turn.** A synchronous `SendChannelMessage` enters the handler's
  critical path on the one path that does not currently pay for it. Against a 1s target already
  missed by 3.5s, that is the expensive kind of elegant.

### 3. The processor posts

The handler dispatches; the processor posts the placeholder as its first act, then updates it.

- **Attraction:** no IAM change at all - the processor already sends - and the poster and the updater
  become the same component, so no id ever has to be handed anywhere.
- **Against it: the acknowledgment stops being the handler's.** The processor would be performing a
  behaviour resolved from a profile it did not load, which is the same authored-here-performed-there
  split this ADR exists to close, moved one component along.
- **Against it: TTFF.** First visible feedback would wait on an async invoke and a possible cold
  start, where today it is posted the moment the handler returns. This is the worst option for the
  metric that matters most.

### 4. Status quo

The flow keeps posting on bypasses, Chime keeps materialising on the Lex path.

- **Nothing breaks, and that is the point.** It costs nothing today and leaves one profile-resolved
  behaviour with four routes to the channel, none of them written down as a decision.
- Worth keeping on the list because the alternatives all buy consistency with either latency or a
  second resolution path, and "not yet" is a legitimate answer to a defect that has not bitten.

## Decision direction (owner, 2026-08-10): option 1

Rationale in the owner's terms: it is truer to what is happening - the assistant acknowledges a
received request, then passes off to the processor for the full response - and it gives an assistant's
author control over how their assistant responds, because the acknowledgment becomes profile
behaviour end to end rather than something the platform performs on the assistant's behalf.

Option 2 is the more complete version of the same idea and is rejected on cost: it buys a single
resolution path with a stray envelope on every ordinary turn and a synchronous send on the one path
whose latency is already the problem.

## Consequences

- `AgentHandlerRole` carries a classification-scoped `chime:SendChannelMessage`
  (`assistant-profile-stack.ts:856`). The archived-channel Deny comes with it through the shared
  helper, and `handler-send-grant-carries-archive-deny.test.ts` pins that the grant only ever goes
  through that helper, because a Deny arriving by side effect is exactly the kind of protection that
  disappears quietly if the helper is bypassed.
- **The handler's dispatch and return are reordered** (send, then dispatch with the id, then return).
  That ordering IS the feature - it is what lets the id be handed over at all - so it needs a test
  that fails if the dispatch moves back in front of the send, not merely one that checks the id
  arrives.
- `channel-flow-processor.ts` loses `sendBotMessage` from both turn paths. It keeps it for its own
  rejection notices, which is the only remaining reason the flow sends anything.
- **The bypass paths do NOT hand `placeholderMessageId` to the processor.** An earlier draft of this
  bullet said they would, on the reasoning that a component which posts the message holds its id. It
  does hold it, and passing it on would require posting BEFORE the dispatch, which means reordering
  every return path in the handler to buy one skipped `GetItem`. Priced and declined (see option 1):
  this decision is justified on OWNERSHIP, not on shortening a resolution path.
  So `@all` and `/battle` round 1 resolve through the `corr# -> MessageId` mapping exactly as the Lex
  path does. **That mapping and the marker scan are therefore load-bearing on every path and must not
  be deleted** - the claim in `channel-flow-processor.ts` is what round 1 depends on, not a redundant
  duplicate guard. The one exception is the battle CONTINUATION, which answers onto a message that
  already exists and so is given its id (`TurnRequest.placeholderMessageId`).
- The flow's duplicate-placeholder guard keeps its job unchanged: it claims on the marker in a bot
  message's content, and a handler-posted placeholder still carries one.
- The battle continuation dispatches through the handler entry
  (`channel-flow-processor.ts:942`) and so inherits this decision rather than needing its own, except
  that it answers onto the side's existing waiting message instead of posting a new one. Round 2 still
  has its placeholder posted by the orchestrator and is unaffected until it moves to the entry
  ([ADR-023](./023-battle-round-coordination.md) A-prime), at which point it inherits this decision too.
