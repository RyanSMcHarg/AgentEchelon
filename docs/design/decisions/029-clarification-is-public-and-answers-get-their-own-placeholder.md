---
title: "ADR-029: A duel's clarifying question is public, and the answer gets its own placeholder"
status: Accepted 2026-08-13 (owner). Not built.
date: 2026-08-13
related:
  - "../../specs/capabilities/SPEC-BATTLE.md"
  - "../../specs/capabilities/DESIGN-BATTLE.md"
  - "../../guides/developer/MESSAGE-FLOW.md"
  - "./022-message-identity-is-established-at-the-channel-flow.md"
  - "./025-who-posts-the-placeholder.md"
  - "./026-task-shaped-battle-rounds.md"
  - "../../../backend/lambda/src/channel-flow-processor.ts"
  - "../../../backend/lambda/src/router-agent-handler.ts"
  - "../../../backend/lambda/src/lib/async-processor-core.ts"
  - "../../../backend/lambda/src/lib/battle-state.ts"
tracking: |
  DECIDED, NOT BUILT. Reverses the clarification privacy rule in SPEC-BATTLE and removes the last
  caller that hands a placeholder id to the processor, which is what closes the open item in ADR-022
  section 4 ("one field names two different things"). The e2e assertion that a clarifying question is
  NOT broadcast inverts with this decision and must be rewritten rather than deleted.
---

# ADR-029: A duel's clarifying question is public, and the answer gets its own placeholder

## Status

**Accepted (owner, 2026-08-13). Not built.**

## Problem and who it's for

A person running a duel asks an ambiguous question. One side needs to check what they meant before it
can answer. Today that produces a conversation the person cannot follow: the side's bubble turns into
`"Assistant is waiting for your response."`, the actual question arrives as a separate message only
they can see, their reply vanishes from the transcript entirely, and the finished answer appears an
hour later in the bubble from before they were asked anything, above everything sent since.

The person cannot reconstruct what was asked, what they said, or why the answer looks the way it does.
Neither can anyone reviewing the duel afterwards, because the reply was never written down.

## Context

The privacy machinery exists for a measurement reason: a side that did not think to ask a clarifying
question should not benefit from its rival's. That is a real property, and the cost of protecting it
this way is four separate mechanisms:

- the clarifying question is sent as a second, `Target`-ed message rather than shown in the duel;
- the placeholder is overwritten with neutral copy so the rival learns nothing from it;
- the user's reply is **denied** at the channel flow, so it is never delivered, never persisted, and
  never reaches the event archive;
- the resumed answer reuses the waiting message, which requires the only surviving caller that hands
  `placeholderMessageId` to the processor, and a durable pointer on the battle row whose TTL has to
  track the one hour user-wait deadline.

**The measurement property survives a much smaller mechanism.** The rival seeing the QUESTION learns
what the asker found ambiguous. It does not learn the ANSWER, which is where the information the user
supplied actually lives, and which stays `Target`-ed to the asking assistant. The leak that mattered is
closed by keeping the reply targeted; everything else was protecting the question, which is worth less
than what the concealment costs.

**And the question has positive value in round 2.** A rebuttal that can see its rival asked a good
clarifying question, or a needless one, can say so. That is a legitimate dimension of the comparison
and it is invisible today.

## Decision

**A duel side asking the user something is an ordinary turn asking the user something. Every rule below
follows from that; none of them is a battle rule.**

The owner's framing, 2026-08-13: *"Depending on the intent, like report_generation or data_extraction,
asking clarifying questions is part of the task flow. This aligns with keeping `/battle` as close to the
normal message flow as possible. Battle is just a more interactive way to participate in the
experiment."*

That settles a question this ADR originally answered the wrong way round. It asked how a duel's
clarification should behave; the answer is that it should not behave in any particular way, because a
duel does not own the behaviour. What follows is the ordinary path, written down for the one place that
had drifted from it.

**The clarifying question is an ordinary, public part of the duel. The answer to it gets its own
placeholder, like every other turn.**

1. **The question replaces the placeholder, permanently.** The side's round-1 placeholder is updated to
   the text of the question and stays that way. It is broadcast, like every other duel message. The
   separate `Target`-ed question message is removed.
2. **The battle state is unchanged.** That side stays `WAITING_FOR_USER`, which is non-terminal and
   suppresses the round-2 orchestrator exactly as it does now (ADR-026), and the user-wait clock still
   applies.
3. **The user's reply keeps being denied, for now, and that is the part of this decision that is NOT
   settled.** See "The reply, and why it is still denied" below.
4. *(withdrawn - see below)*
5. **The resumed side posts a NEW placeholder** and updates it with the answer, through the handler
   entry like every other bypass (ADR-025). It carries a fresh correlation id and resolves through the
   `corr#` mapping. Nothing is handed a `placeholderMessageId`.
6. **The `<!--battlewaiting-->` marker is cleared from the question message when the side resumes**, so
   the frontend's waiting affordance ends. The question TEXT stays; only the marker goes.
7. **Round 2 is unchanged.** Fresh placeholders per side, each updated in place.

## What this means for `NEED_CLARIFICATION`

The sentinel is the last battle-only way to do something the ordinary path already does, and it is
therefore slated to retire rather than to be repaired.

**It is currently unreachable.** The round-1 prompt is `buildBattleAwareness` alone, which never
mentions the sentinel, so no model has a reason to emit it. Commit `29adb2d` removed the constant that
did, along with the length and deliverable clauses, and that removal was correct: those were duel-only
copies of intent-pack `verbosity` / `maxTokens` and `isDocumentRequest`. DESIGN-BATTLE described all of
them as current for three weeks afterwards.

**The state layer is already unified.** [ADR-026](./026-task-shaped-battle-rounds.md) made
`WAITING_FOR_USER` mean "blocked on a person" whether that is a clarifying question or the next leg of a
task machine, with `reason: 'clarification' | 'task-step'`. So a duel side that asks a question through
its intent's task flow already suspends round 2 correctly, with no sentinel involved.

**What retiring it takes**, recorded so the next reader does not have to re-derive it: the composer's
waiting affordance keys off the `<!--battlewaiting-->` marker, so a task-flow question needs to carry
the same signal or the frontend needs a different one; and `clarificationCount` has to be derived from
the `WAITING_FOR_USER` transitions rather than from the sentinel, so the measured dimension survives.
Neither is hard. Both are out of scope here, and the rules above hold either way, because they describe
the ordinary path that a task-flow question already takes.

## Forward-looking: "waiting on you" is not a battle concept

Recorded because it decides the SHAPE of the retirement above, and getting that shape wrong is cheap
now and expensive later.

A user will hold open items from several assistants and several workflows at once: a duel side that
asked something, a `report_generation` chain waiting on scope, a `data_extraction` step waiting on a
column mapping, potentially across different conversations. Each is the same thing from the person's
point of view - *something is blocked on me, and I need to close it out* - and they need to see which
one they are answering and work through them.

Two representations of that already exist and they do not know about each other:

- **`assigneeUserSub` on a task** ([ADR-024](./024-task-ownership.md)), the durable "this human owns
  this work item" field;
- **`WAITING_FOR_USER` on a battle row**, plus the `<!--battlewaiting-->` marker the composer reads,
  which is the same statement scoped to a duel and expressed in the channel rather than in task state.

The composer's affordance is the right UX primitive already - FIFO so the oldest question is answered
first, a chip per waiter, a picker when there is more than one, and now the recipient's name in the
input placeholder. What is wrong is only its SOURCE: it derives from a battle-specific marker, so an
ordinary task chain waiting on the same person is invisible to it.

**The mechanism is task assignment, and it already exists** (owner, 2026-08-13). A side that needs
something from a person opens a task assigned to them - `assigneeUserSub`, the field ADR-024 already
defines - and the composer renders the queue of tasks assigned to the current user. There is no new
signal to design, and specifically no `<!--taskwaiting-->` to invent beside `<!--battlewaiting-->`:

- **The question is a task, not a sentinel.** An intent's task machine already asks the user things and
  already tracks whether the answer arrived. `NEED_CLARIFICATION` is a second way to do that, reachable
  only from a prompt clause that no longer exists.
- **The channel marker stops being the source of truth.** `<!--battlewaiting-->` and the composer's
  `battleWaitingBots` derivation are a channel-side projection of state that belongs in the task store,
  which is why an ordinary chain waiting on the same person renders nothing today.
- **`WAITING_FOR_USER` stays, narrowed to what it is for.** It suppresses the round-2 orchestrator,
  which is a battle concern and stays a battle concern. What it stops carrying is the user-facing "you
  owe an answer", which the assigned task carries instead. ADR-026 already treats a clarification and a
  task leg as the same state, so this is the last step of that unification rather than a new idea.
- **`clearWaitingMarkerMessageId` becomes unnecessary.** Closing the task is what ends the affordance;
  no message needs un-marking, so the field, the marker and `clearBattleWaitingMarker` all retire
  together. They are transitional, and shipped that way deliberately: the marker is what the composer
  reads TODAY, so the queue keeps working until the task-assignment source replaces it.

That is the destination. This ADR does not build it; it records that the battle case is one instance of
work assigned to a person, so the next change reaches for `assigneeUserSub` rather than for a third
representation.

## The reply, and why it is still denied

The first draft of this decision said the reply would be released and the Lex entry would stand down,
"the same complement rule `@all` already uses". **That is not implementable as written, and the reason
is worth recording because it will be proposed again.**

The `@all` complement works because the token is in the message TEXT: `flowBypassToken` reads the
transcript, and Lex delivers the transcript, so both sides can independently reach the same verdict. A
clarifying reply carries no token. It is an ordinary message whose only distinguishing features are its
`Target` and the battle state of the addressed bot - and **Lex fulfillment receives neither**. The
request attributes are exactly `CHIME.channel.arn`, `CHIME.sender.arn` and
`x-amz-lex:channels:platform` ([ADR-022](./022-message-identity-is-established-at-the-channel-flow.md),
measured). The flow cannot stamp anything the Lex entry can read: `Metadata` does not reach Lex either,
and rewriting the user's own `Content` to carry a marker is exactly what `stripMessageMarkers` exists to
defend against.

So there are two real options, and this ADR does not choose between them:

- **A. Keep the deny.** Costs the archive record of the exchange, which is what the end-of-battle
  summary wants. This is what ships today and what the build under this decision keeps.
- **B. Let the ordinary Lex turn BE the resume.** Do not deny; the targeted reply invokes that bot's
  Lex as normal, and the handler notices it owns a `WAITING_FOR_USER` row for this channel's active
  battle and resumes from there. One entry, message persisted, and the flow's continuation path
  disappears entirely rather than being duplicated. It costs a battle-state read on the Lex path, gated
  behind the `ChannelBattleConfig` the handler already caches, and it makes the resume depend on state
  rather than on routing.

B is the better shape and is a larger change than this decision needs. Deciding it is deferred, and
until it is decided the deny stands - with the cost recorded here rather than discovered again.

## Consequences

- **The transcript reads in order.** Question, then the answer at the bottom, where a user who waited
  an hour is looking. Today the answer lands in the bubble from before the question was asked.
- **The archive holds the QUESTION.** Half of what SPEC-BATTLE's open question about the verbatim
  clarifying Q&A needs. The reply half waits on option B above.
- **The last handed placeholder id disappears.** `placeholderMessageId` stops meaning two things, and
  ADR-022 section 4's open item closes. `resolvePlaceholderTarget`'s handed-id branch and the
  `BYPASS_PLACEHOLDER_ATTR` silence branch in the handler both lose their only caller.
- **`waitingMessageId` narrows to one job:** naming the message whose marker is cleared on resume. It
  is no longer the answer target, so the durable-pointer-versus-TTL reasoning stops being load-bearing.
- **A stated privacy rule is reversed, deliberately.** SPEC-BATTLE says the clarification stays private
  until the end-of-battle summary. That now applies to the user's ANSWER only. This must be edited in
  the spec rather than left to be discovered.
- **One e2e assertion inverts.** `tests/e2e/battle.spec.ts` asserts that an ambiguous `/battle` produces
  the neutral private waiting state instead of broadcasting the question. Under this decision
  broadcasting the question is the correct behaviour, so the test is rewritten to assert the question
  text appears in the duel and the REPLY does not. Deleting it would remove the only coverage of the
  routing rule that still holds.
- **A rival can read the question in round 2**, which is intended, and which makes "did this side ask a
  useful clarifying question" a thing a rebuttal can address.
- **Releasing the reply adds a stand-down branch.** It is the same shape as the `@all` size branch and
  carries the same risk: if the flow and the handler ever disagree about whether a message is a
  continuation, the turn is answered twice or not at all. Both sides read one shared predicate.
