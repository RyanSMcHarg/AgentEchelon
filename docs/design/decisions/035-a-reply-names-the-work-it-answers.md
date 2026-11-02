---
title: "ADR-035: A reply names the work it answers"
status: Accepted 2026-09-15. Phases 1 to 5 are built and verified live by tests/e2e/task-reference.spec.ts. Where the build departs from the proposal, the section says so under "As built".
date: 2026-09-15
related:
  - "./024-task-ownership.md"
  - "./033-a-conversation-answers-one-turn-at-a-time.md"
  - "./034-addressing-a-message-is-not-making-it-private.md"
  - "../../specs/interaction/conversation/DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING.md"
  - "../../specs/communication/SPEC-NOTIFICATION-BRIDGE.md"
  - "../../specs/interaction/conversation/SPEC-TASK-STATE-TRANSITIONS.md"
  - "../../../backend/lambda/src/lib/task-referent.ts"
  - "../../../backend/lambda/src/router-agent-handler.ts"
  - "../../../backend/lambda/src/channel-flow-processor.ts"
  - "../../../frontend/packages/chat/src/components/OpenWorkItems.tsx"
  - "../../../frontend/packages/chat/src/components/MessageInput.tsx"
tracking: |
  Accepted and built through phase 5. Every item gets a short reference, shown and typed as text,
  resolved by the router before ranking, routed by the channel flow in groups, and inserted by the
  web client's Answer action. Verified live by tests/e2e/task-reference.spec.ts.
---

# ADR-035: A reply names the work it answers

## Status

**Accepted (2026-09-15).** Phases 1 to 5 are built: `lib/task-reference.ts`, `allocateTaskRef` and `findAnswerableTaskByRef` in `lib/task-tracking.ts`, the `answerableTaskByRef` task-service op, the reference block in `router-agent-handler.ts`, `resolveReferenceTarget` in `channel-flow-processor.ts`, and the web Answer action, composer chip and message label. Unit coverage is `test/lib/a-reply-names-its-item.test.ts`, `OpenWorkItems.test.tsx`, `MessageInput.task-answer.test.tsx` and `utils/taskReference.test.ts`; verified live by `tests/e2e/task-reference.spec.ts` (4 of 4 on the deployment, 2026-09-15).

This record replaces a draft spec that was reviewed from product, principal engineering, developer, UX, application security and QA perspectives; every finding the review marked critical or important is applied below.

## Problem, and who has it

A person working with an assistant often has more than one thing open at once: a report the assistant is gathering requirements for, a clarifying question about an unclear request, an offer to split a subject into its own conversation. When the assistant asks something and the person replies "EMEA only", the platform decides which item that answers. Today it guesses. The router ranks the person's open items and the model picks one, or asks "which did you mean?" when it cannot tell (ADR-024 D7). That works most of the time and fails silently the rest: the answer attaches to the wrong work, and nothing tells the person where it went.

This is for anyone with several items open with an assistant, on whatever channel they are using. The web app is one of them. SMS, voice and email are others, and there is nothing to click on those and no hidden field to carry an id. DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING already sets the bar: every action has to be possible with text alone, and a client may make it more precise but never grant something the text path lacks.

## What is true today

| Piece | Today |
|---|---|
| Deciding which item a reply answers | The router ranks the sender's open items (this assistant's own first, work in flight before a parked question, then recency) and gives the model up to five as a closed set. The model names one through `advance_task_state`, or asks which was meant (`lib/task-referent.ts`) |
| Web: choosing an item | An item in another conversation has a Finish action that opens that conversation. An item in the current conversation has no action, and `OpenWorkItems.test.tsx` requires that. In a conversation with more than two members the composer picks the oldest open item on its own and shows an "Answering" chip the person can only dismiss (`MessageInput.tsx`) |
| Web: what a reply carries | `Metadata.task.id`. Lex never sees message metadata and the router does not read it; only the stream-side task-answer repair does |
| What the sent message shows | Nothing about which item it answered |
| A reference a person could type | None. Task ids are UUIDs, shown only to the model |
| Routing a group message | Since ADR-034 the channel flow resolves every `@` token from message text and dispatches the turn itself, so a group conversation is routed from content the flow provably receives |

### How the non-web channels work, measured in this repository and in communication-hub

| Channel | Inbound reply | What it can carry | Reference implementation |
|---|---|---|---|
| **Email** | Built in communication-hub, designed here (SPEC-NOTIFICATION-BRIDGE). SES receipt, a signed token in `Message-ID` and a body footer, quoted text stripped, posted as the person through an assumed role when the token verifies | Plain text into the channel, plus the token's lookup row: conversation, person, and one `taskId` | The lookup row is keyed per conversation and person, so every new email overwrites its `taskId`. A token binds a reply to the conversation, not reliably to an item |
| **SMS** | Not built in either repository. communication-hub has a design for a keyword set (YES, CONFIRM, DECLINE, STOP) and "the most recently active conversation" when a person has several | Plain text only; a single business sender number, no per-conversation or per-item numbering | None |
| **Voice** | Built in communication-hub: inbound calls, fixed keypad menus, voicemail transcribed and posted by a bot | Transcribed speech and keypad digits | No notion of choosing an item |
| **Admin commands (communication-hub)** | `accept meeting <id>` accepts a full id or an 8-character prefix; with no id it acts on the single pending request or lists them when several are pending | Text | The closest existing precedent: a short typed reference, the single case implicit, and a list when ambiguous |

## Options

**A. Keep judging from the text, and ask when unsure (today).** Works on every channel and asks nothing of the person. A confident wrong pick is invisible, "which did you mean?" costs a round trip every time, and describing an item in words is exactly what a private item must not do in a room.

**B. The client attaches the task id.** Exact in the web app. Fails the text test: an SMS reply has nowhere to put an id, so the same words reach different decisions on different channels.

**C. A short reference per item, shown and typed on every channel.** Deterministic when present, visible on the sent message, and the same decision everywhere because it is text. One more thing to learn, so it must be offered only where it is needed.

**D. Reply-to threading.** Works in the web app and email. SMS and voice have none, and a quote points at a message, not at an item: one assistant message can ask about two.

**E. One open question at a time.** Works everywhere, but serializes a person's work, which contradicts the queue design (several items proposed at once, each directed on its own), and an unrelated message still has to be told apart from an answer.

**F. A sender number or address per item.** Does not scale, costs per number, and breaks the identity model where the conversation's own number identifies the conversation.

**A per-thread token (communication-hub's email model) is not an option on its own.** It identifies the conversation, and its one `taskId` is overwritten by the next message, so it is a transport detail that a reference rides inside rather than a way to name an item.

## Decision

**Option C for the deterministic path, option A kept as the fallback, and option B implemented as the web app's way of producing C.** One decision, reached from text. The client only saves typing.

### 1. The reference

- **Assigned when the item is created, atomically.** Triage creates several items at once (`createTasksFromProposal` writes them concurrently), so the number comes from an atomic counter: one row per conversation in the task service's table, incremented with a single conditional `UpdateItem ... ADD`, written through the task service seam like every other task write. **Never from channel metadata**, which conversation members can write.
- **Stored on the task as `taskRef`** and never reused while the conversation lives, so `#2` means the same item in yesterday's message and today's.
- **Scoped to the conversation,** so everyone in a room refers to an item the same way.
- **Rendered `#<n>`.** Short, typeable on a phone keypad, and not a Markdown heading without a following space.
- **A reference reveals only that an item exists.** Existence of private work is already visible to the room (owner decision, 2026-08-23), so a person counting `#1..#n` learns nothing the platform does not already show. What an item is stays private.

### 2. Who may answer an item

**The item's awaited party, and nobody else:** the person its current state awaits, which for a requirements step is the requester (ADR-024). A reference sent by anyone else is treated as naming no item of theirs. The reference narrows the set the router already checks; it never widens it. Like a client's task id, it is precision and not permission.

**As built:** the item's owner may also answer it by reference while the assistant holds the step, because the owner is who the assistant is working for and the router already reads their owned items as referent candidates (ADR-024 D8). The set is therefore the items whose step awaits the sender plus the items the sender owns with this assistant, and nothing else.

### 3. When it is shown

- **In any assistant message that asks the person something about an item,** when that person has more than one open item in the conversation. With one open item there is nothing to disambiguate and the reference is left out; a second item opening before the reply arrives simply falls back to today's path, which is not an error.
- **In a proposal, in place of the position number.** `buildProposalMessage` numbers items by position today (`1.`, `2.`); a position number beside a reference invites the wrong reply, so the list shows `#3 Q2 ARR report`, and any ordering is said in words.
- **In the web task list and on each item's status,** always.
- **Rendered by the platform, never written by the model.** Wherever the platform already composes an item label (the proposal list, the referent hint the model reads), the reference is part of the label; the model is told to use `#n` when it names an item. The wording around it is configured copy: `taskRefHint` for a one-time teaching line the first time a person has two items ("Reply starting with #2 to answer that one"), after which only the references appear.

**As built:** the `taskRefHint` line is added under every reply that leaves its item waiting on the person while they have more than one open item here, unless the reply already names the reference. A one-time line needs a per-person record of having been taught, and a line that is present exactly when a bare reply would be ambiguous is the simpler rule to keep true. The referent hint the model reads carries each candidate's reference and tells the model to name choices by it.

### 4. How a reply is resolved

In order; the first that applies decides:

1. **A reference at the start of the message,** after any leading mentions and private-address prefix are stripped (the router already strips both), written `#<n>` and optionally preceded by `re`. When it names an open item this sender may answer, the item is fixed: no ranking and no model choice. An item owned by another assistant goes through the existing handover.
2. **A task id in the message metadata,** checked the same way. The web app always sends the typed reference with it, so this only matters for a client that sends the id without the text.
3. **Neither:** today's ranked, judged path.

**A reference that resolves to nothing the sender may answer** (closed, another conversation's, someone else's, or out of range) is answered, not ignored. The reply is configured copy (`taskRefNotFound`, with `{ref}`), sent **only to the sender**, and lists only the open items that sender may answer, with their references. Another person's private item is never listed.

**A private item answered by a public message** is still answered, because the person chose to send it. The assistant replies to the sender privately and says their message was visible to the room. Text channels offer no private send inside a group (an SMS group thread cannot address one person, per DESIGN-TASK-ACCESS), so a person answering private work over such a channel is told so in the same way.

**As built:**

- **Where the reply goes follows the work (owner, 2026-09-15).** Shared work answered from a public message gets a public reply and nothing else. A private message gets a private reply. Private work's details go only in messages targeted at the person: from a public message the answer is posted to them privately, and the public placeholder says only that they were answered privately (`answeredPrivately`). If the private message cannot be posted, the turn fails with the ordinary failure line rather than answering in public. The rule lives in `planResumedChainDelivery` and applies to every turn on a private item, not only to replies by reference. A duel side answered privately still posts its answer to the room, because a duel is a comparison.
- **The not-found reply is sent only when the sender has at least one open item here** (`taskRefNotFound`, `taskRefNothingOpen` for the other case in configured copy). A sender with nothing open is answered as ordinary conversation, so a message such as "#1 priority is revenue" in a 1:1 is not refused.
- **Step 2, a task id in message metadata, is not read by the router.** The web client always sends the typed reference with it, so no shipped client depends on it.

### 5. Getting the message to the assistant

In a group conversation Amazon Chime SDK delivers only addressed messages to an assistant, so a bare `#2 EMEA only` reaches no assistant through delivery. The channel flow already routes `@` tokens from message text (ADR-034), and it routes a leading reference the same way: **only when the reference names an item the sender may answer**, checked through the task service before dispatch, and to the assistant that owns that item. Otherwise the flow does nothing and ordinary addressing applies. A member cannot start a model turn in a room just by typing `#` and a number, and every dispatched turn stays under the existing rate limits.

### 6. The web app

- An **Answer** action on every open item, including items in the current conversation, puts `#<n>` at the start of the composer and shows an "Answering #n: title" chip. For a private item it sends privately, as today, and shows the title only to the requester.
- The sent message shows **"Answering #n"** above its text, read from the typed reference and exposed as text for assistive technology (`Answering item 2: <title>` where the title may be shown).
- **The automatic oldest-item pick is removed.** Nothing is attached unless the person chose it or typed it.

**As built:** the Answer action puts `#<n>` at the start of the composer and the chip reads the reference from the text, so deleting the reference or dismissing the chip stops answering. An item elsewhere keeps its Finish action, which opens the conversation and inserts the reference there. An older item without a reference is answered only when the person chose it with Answer. A shared item's reply that carries a reference is sent with its task id and no mention: the channel flow routes the reference, and a mention on the same message invoked the assistant a second time, which queued the message behind its own answer (measured live). The stream-side task-answer repair stands down for a message that starts with a reference for the same reason. The sent message's label reads "Answering #n", with "Answering item n" for assistive technology; the title is not repeated on the message.

### 7. The other channels

- **SMS** carries the reference as typed text. Questions sent by SMS include the reference when more than one item is open, and the teaching line the first time.
- **Email** carries it the same way in the body. The reply token still identifies the conversation and person; it does not identify the item, and its `taskId` is not relied on for that.
- **Voice** resolution is specified when the voice transport is built here: a spoken form ("item two") and keypad entry are both candidates, and neither is decided by this record.

### 8. What is recorded

Each answering turn records how its item was resolved, on its analytics row next to the task id: `reference`, `client-id`, `ranked`, `asked`, or `corrected`, where `corrected` is a turn whose model re-targeted a different item than the previous turn or whose person said it was the wrong one. The baseline to capture before building is today's split between `ranked` and `asked`, and the rate of corrections. Success is fewer `asked` round trips and fewer corrections on conversations where references are shown, at every classification.

**As built:** the analytics row carries `taskResolution` with `reference` or `ranked`. `client-id`, `asked` and `corrected` are not yet recorded; each needs a signal the router does not have before the model runs.

## What proves it

- **Unit:** N concurrent task creations in one conversation receive N distinct references; references are never reused; the parse accepts `#2` and `re #2` at the start and after leading mentions, and nothing elsewhere; resolution order; a reference from someone who is not the awaited party resolves to nothing; the not-found reply lists only the sender's items.
- **E2E (new `tests/e2e/task-reference.spec.ts`):** two open items for one person in a group conversation; `#2 ...` with no mention reaches the owning assistant and moves item 2 only; the same words without a reference go down today's path; a second member's `#2` moves nothing and no reply they can see names the item; a closed item's reference draws the not-found reply; the web Answer action produces the same result as typing.
- **Transport-independent contract:** a text-only message with no metadata, arriving through the bypass, resolves exactly as the web send does. That is what makes SMS and email follow without platform work once their transports exist.
- **Existing test that changes:** `OpenWorkItems.test.tsx` requires no action on a current-conversation item, and is rewritten.

## Phasing

1. `taskRef` assignment and storage; references in the web task list and in proposals, replacing position numbers. No routing change.
2. Router resolution from a leading reference, the awaited-party rule, the not-found reply, private-item handling, and the resolution field on analytics.
3. Channel-flow routing of a leading reference in group conversations.
4. The teaching line and references in the assistant's questions when more than one item is open.
5. The web Answer action and the "Answering #n" label; the automatic pick removed.
6. SMS and email pick it up as those transports are built; voice is specified then.

Phases 1 to 5 are built. Phase 6 waits on the transports.

## Consequences

- **ADR-024 D7 gains a step ahead of ranking:** an explicit, checked reference fixes the item. Ranking and asking remain for every reply that carries none.
- **ADR-034's content-routed flow extends to a leading reference,** under the same rule that the flow routes only what it can check.
- **A proposal's items are named by reference, not by position.**
- **What stays open:** several references in one message ("#1 yes, #2 EMEA only") are answered for the first reference, and the rest asked about, until a later decision splits one message across items; whether to show references when only one item is open; and an item split into a new conversation keeps its reference in the old conversation's history while the new conversation assigns its own.
