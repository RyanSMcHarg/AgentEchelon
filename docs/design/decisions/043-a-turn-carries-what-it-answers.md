---
title: "ADR-043: A turn carries what it answers"
status: >-
  Accepted 2026-10-12, and built (owner, 2026-10-11, "those decisions all need to be built and tested"). The carried path skips every reconstruction, every flow dispatch is required to carry the id, a person is keyed by `person_id` on messages and exchanges (migrations 074 and 079), and a turn's classification is resolved from the answering assistant for a role's assistant as well as a primary. The end-to-end check of the two populations is written and not yet run. Proposed 2026-09-17. A turn that the channel flow DISPATCHES already carries the inbound message id end to end, as `userMessageId` into the request attribute `AE.message.id` and out again as `answersMessageId`. A turn that Amazon Chime SDK invokes Amazon Lex for NATIVELY cannot: the service sends Lex three request attributes and the message id is not among them. So the pairing apparatus (declare-on-placeholder, the cross-batch sweep, the deferral bound, `paired_by`, `anchor_source`, `turn_id_source`, and the split between measured and reconstructed time-to-first-feedback) serves exactly one population, the natively invoked one, and the analytics model treats that population's limits as though they were every turn's. The recommendation is that the model be stated as two paths rather than one, that ADR-036 option B be understood as moving turns onto the carried path rather than as building one, that classification be derived from the responding assistant rather than from a stamped field, and that a person be keyed by their user id rather than by a display name or an ARN. **Option B was taken on 2026-09-17** (ADR-041): `StandardMessages: NONE` is now the project default on every assistant and `turnEntry` is deleted rather than kept as a per-profile variant, so the population this record describes as reconstructing has already moved onto the carried path. The analytics recommendations below are built: the per-turn drill returns `paired_by` beside `turn_entry`, and a person is keyed by `person_id`.
date: 2026-09-17
related:
  - "./036-why-turns-enter-through-amazon-lex.md"
  - "./037-a-turn-declares-what-it-answers-on-the-message-it-is-already-posting.md"
  - "./038-a-turn-answers-the-message-that-was-there-when-it-started.md"
  - "./040-an-identity-rides-beside-a-persons-words-not-inside-them.md"
  - "./041-simplifying-how-a-message-reaches-an-assistant.md"
  - "./042-an-assistant-acts-in-exactly-one-classification.md"
  - "../../overview/TENETS.md"
  - "../../guides/developer/LATENCY-TARGETS.md"
  - "../../guides/developer/MESSAGE-FLOW.md"
  - "../../specs/communication/SPEC-MESSAGE-METADATA-CODEBOOK.md"
  - "../../../backend/lambda/src/channel-flow-processor.ts"
  - "../../../backend/lambda/src/router-agent-handler.ts"
  - "../../../backend/lambda/src/lib/flow-bypass.ts"
  - "../../../backend/lambda/src/lib/async-processor-core.ts"
  - "../../../backend/lambda/src/analytics-aurora/kinesis-archival.ts"
  - "../../../backend/lambda/src/analytics-aurora/analytics-query.ts"
  - "../../../backend/lib/config/profiles.ts"
tracking: |
  Proposed. Everything described as as-built is READ FROM THE TREE at the date above, with a file and
  line for each claim. No option is measured against another, no code or test accompanies this record,
  and the migrations and guards named under "What this owes" do NOT exist. The one measurement quoted
  is the archival outage window of 2026-09-16, which is recorded because it is the evidence that the
  reconstruction path is load-bearing rather than incidental.
---

# ADR-043: A turn carries what it answers

## Status

**Accepted (2026-10-12), and built.** Proposed 2026-09-17.

- **A carried turn reconstructs nothing.** `resolveOriginatingMessage` (`lib/live-drift-flow.ts`), which the router's lookup and live drift both use, answers from the declared `AE.message.id` and `AE.turn.targeted` and never searches the channel for a flow-dispatched turn; only a turn Amazon Lex invoked natively calls `findInboundMessage`. Before this, a flow-dispatched turn that opened a task still paid a `ListChannelMessages` whose text match could not succeed, because the flow strips its address token before dispatch.
- **Every dispatch carries the id.** `RouterTurnParams.messageId` is required, and every `handOffTurnToRouter` call and each duel side names it.
- **A person is keyed by their id.** `messages.person_id` and `exchanges.person_id` (migration 074, named by 079), the bare id `drift_events` already stores, backfilled in bounded batches; null on an assistant's message, whose sender is `agent_type`. The view is not replaced.
- **Classification is the answering assistant's.** `classificationOfAssistant` (`profile-registry.ts`) resolves a role's assistant as well as a primary, through the one naming rule the stack provisions assistants by (`roleAssistantName`). The archival boundary check reads it; before this it read `classificationFor`, which answers only for a primary, so every message from `ops-premium` was reported as an undeclared identity.
- **The two paths are stated.** The per-turn drill returns `paired_by` beside `turn_entry`, and LATENCY-TARGETS states which figures are carried and which are reconstructed.

Verified by: `a-dispatched-turn-carries-what-it-answers.test.ts`, `analytics-aurora/a-person-is-keyed-by-their-id.test.ts`, `lib/an-assistant-is-assigned-one-classification.test.ts`. **OPEN:** the deployed check of item 4 below (`the-lex-leg-is-measured-per-turn.spec.ts`, `LEX_LEG_E2E=1`) is written and has not been run.

**The recommendation: a turn carries the id of the message it answers, and everything downstream reads that rather than re-deriving it.** Three further consequences follow from the same principle and are recorded here because they are the same mistake in different places: classification is derived from the responding assistant rather than stamped onto a message, a person is keyed by their user id rather than a display name, and the latency model becomes two paths instead of one path with a quality flag.

## Read this first

A turn has to know which message it is answering. Everything in the latency model, and most of the analytics model, is a consequence of how that question is answered.

Amazon Lex cannot answer it. The Lex entry receives the transcribed text of a message, not the message, so it never learns the `MessageId`. [ADR-037](./037-a-turn-declares-what-it-answers-on-the-message-it-is-already-posting.md) is the record of what that costs and what was built to recover from it.

**The channel flow can answer it, and already does, end to end.** A `ChannelFlowCallback` carries the whole `ChannelMessage`, `MessageId` included (`channel-flow-processor.ts:312`), and a turn the flow DISPATCHES carries it the whole way:

| Step | Where | As |
|---|---|---|
| The flow sets it on the dispatch | `channel-flow-processor.ts:977`, `:1608`, `:2288` | `userMessageId` |
| The router forwards it as a request attribute | `router-agent-handler.ts:1091` | `AE.message.id` |
| The router reads it back out | `router-agent-handler.ts:3397` | `userMessageId` |
| The processor stamps what the turn answers | `async-processor-core.ts:763`, `:4611` | `answersMessageId` |

**The boundary is not flow against Lex. It is dispatched against natively invoked.** `router-agent-handler.ts:3393` states it exactly:

> WHEN A BYPASS CALLER DECLARED IT. The Lex path cannot: Amazon Chime SDK sends Lex three request attributes and the message id is not among them, and resolving it here would put a channel read on the one path whose whole promise is immediacy.

So when the flow calls `callbackAllow` and Amazon Chime SDK then invokes Amazon Lex itself, nothing can carry the id, and the turn must reconstruct it: `findInboundMessage` in `lib/inbound-message.ts`, whose header says "WHICH MESSAGE A TURN IS ANSWERING, when nothing told the turn", one `ListChannelMessages`, an exact content match, bounded by ADR-038's `notAfter`.

**That is the whole of the problem, and it is a population problem rather than a plumbing one.** The carried path exists, is built, and works. The reconstruction apparatus serves the turns that cannot use it, which is now exactly the targeted ones: `TargetedMessages: ALL` keeps Amazon Lex as the entry for a message carrying a `Target`, and the service does not permit an `InvokedBy` whose members are both `NONE`. Before option B it also included every ordinary untargeted one-to-one turn, which is the population that moved.

### A correction, recorded rather than quietly fixed

An earlier draft of this record claimed the flow "holds the `MessageId` and discards it", on the evidence that grepping `channel-flow-processor.ts` for `answersMessageId`, `inboundMessageId` and `originalMessageId` returned nothing. The field is called `userMessageId`. A name-exact search is not an existence check, which is a mistake this project has recorded before, and the conclusion drawn from it was wrong. The thesis survives in a narrower and better form: nothing needs building to carry the id, and what ADR-036 option B changes is which turns get to use what is already there.

## What is true today

Read from the tree on 2026-09-17.

### The Lex entry pays to recover the id

`router-agent-handler.ts:1832` and `async-processor-core.ts:956` and `:1083` all call `ListChannelMessages` to find the message a turn is answering. The file's own comment at `async-processor-core.ts:942` records the cost: it "is a billed API call, so this runs only when the mapping never appeared".

### What was built because the id was missing

All of this is in service of one absent fact:

| Mechanism | Where | What it is for |
|---|---|---|
| Declare-on-placeholder | `async-processor-core.ts` | The turn states what it answers on the placeholder it is already posting |
| `paired_by` (`declared` / `in_batch` / `swept`) | `kinesis-archival.ts` | Records how confidently a pairing was established |
| The cross-batch sweep | `kinesis-archival.ts`, step 5 | Pairs a bot message whose answer arrived in a later batch |
| The deferral bound | `UPDATE_DEFER_SECONDS`, migration 053 | Stops the sweep minting a pairing before the evidence lands |
| `anchor_source` (`ledger` / `exchange`) | `v_turn_latency` | Which source supplied the turn's start instant |
| `turn_id_source` | `turn_events`, `v_turn_latency` | Whether the turn id was declared or derived |
| Measured against reconstructed time-to-first-feedback | `ttff_measured_count`, `ttff_reconstructed_count` | Separates timing that was observed from timing that was inferred |

### The flow entry is every profile

`assistant-profile-stack.ts:1701` sets `INVOKED_BY_STANDARD_MESSAGES: 'NONE'` unconditionally, for every assistant. `flow-bypass.ts:443` is where the flow decides an untargeted turn:

```ts
if (isOneToOne) return true;
```

The branch is unconditional because there is no longer a per-profile entry to vary: `turnEntry` was deleted with `probe` on 2026-09-17, on the grounds that a variant kept is a variant that has to be tested and that the proliferation of such flags hides bugs. So a one-to-one turn is claimed by the flow, always. A group turn is claimed by the flow when it carries `@all`, a command, or a mention, and is claimed by nobody when it carries none of those, which is the intended behavior: an assistant does not answer a group message nobody addressed.

**"Normal untargeted turns" therefore means one-to-one turns**, which were the ones the Amazon Lex entry used to be invoked for automatically. The flow owning them is [ADR-036](./036-why-turns-enter-through-amazon-lex.md) option B, narrowing Amazon Lex to targeted messages.

### ADR-036's conditions on option B

ADR-036 names three conditions on option B: the `WelcomeIntent` probe, a monitoring answer for a channel flow that is the only entry for standard messages, and the Lex leg isolated from the handler. ADR-036 records option B as Accepted, with all three as **OPEN** follow-ups rather than preconditions.

One is reported, and one is answered in part:

- **`WelcomeIntent` fires under `StandardMessages: NONE`, verified 2026-10-11.** This record reported it on 2026-09-16 as measured on the `probe` classification, which is what that classification existed to measure. The recorded reading of 2026-10-11 on the default instance confirms it: every assistant reads `NONE`/`ALL`, and the router handled 422 welcomes between 2026-10-07 and 2026-10-11 ([ADR-036, Recorded evidence](./036-why-turns-enter-through-amazon-lex.md#recorded-evidence)). The concern is that narrowing standard messages takes the onboarding intake with it; the recorded welcomes show that the welcome, where the intake starts, still reaches the handler.
- **The entry is separable.** `turn_entry` on `messages` (migration 054) lets an analytics query split a figure by how the turn entered. Isolating the Lex leg from the handler also needs `router_ms` and `ttff_ms` on one row, which no query returns, so ADR-036 keeps that half **OPEN**.

**The monitoring answer was NOT given, and the flip was taken with it open.** Under option B a channel-flow failure means the person's words are delivered and no turn starts, so an outage presents as a slow assistant rather than a broken one. There is no longer an automatic Amazon Lex invocation behind it for a one-to-one turn. `DENY` is not the alternative, because it would drop the person's words. **No monitoring answer exists yet**, and nothing in this record supplies one; it is tracked separately and is the live risk this configuration carries.

This record is therefore not the record that flipped the entry, which is ADR-041. It is a record about what a turn knows once the flow owns it, which is now true for every profile.

### Classification is stamped, and the stamp is unreliable

`kinesis-archival.ts:821` sets `agent_type` from `analytics.agentType`, which is message metadata. The conversation's classification is read the same way. Both share a failure mode with a partition key that reads the same metadata: **a message AE did not author carries no metadata at all**, so the value is absent for every person's message and for every membership, moderator and channel event that Amazon Chime SDK generates itself.

`v_turn_latency` also carries `responder`, and that one comes from `turn_events.actor` on the `placeholder_posted` event. It is written by the turn, from the ledger, and cannot be absent for a turn that posted a placeholder.

[ADR-042](./042-an-assistant-acts-in-exactly-one-classification.md) establishes that an assistant acts in exactly one classification, enforced by an IAM condition on the conversation's `classification` tag. **That makes assistant to classification a total function**, and it makes the assistant a sounder source for the classification of a turn than any stamped field.

### The responder has two representations, and the reliable one is not used where it matters

The codebase already reasons this way. `analytics-aurora/analytics-query.ts:3613` states the principle outright: attribution goes "via `agent_type` (the responder's identity), NOT `conversation_classification` (the room's)", and `:541` and `:3823` scope the effectiveness surfaces by `agent_type` as "one assistant".

But there are two columns holding that identity, from sources of very different quality:

| | Source | Can it be absent |
|---|---|---|
| `agent_type` | `analytics.agentType` in message metadata (`kinesis-archival.ts:821`) | Yes, on every record AE did not author |
| `responder` | `turn_events.actor` on `placeholder_posted` (`v_turn_latency`) | No, for any turn that posted a placeholder |

`getLatencyMetrics` uses the lossy one, and says so in its own SQL (`analytics-aurora/analytics-query.ts:2753`, matched by the `GROUP BY` at `:3321`):

```sql
COALESCE(e.agent_type, c.agent_type, m.agent_type, 'unknown') AS agent_type
```

A three-source coalesce chain ending in `'unknown'` is what reading a stamped field looks like when the stamp is unreliable. `responder` is surfaced only by `getTurnLatencyAudit` (`:2122`, `:2146`).

**So the sound source already exists and is already computed.** Keying attribution and classification off the responder is a change of which column is read, not new derivation.

### A person is keyed by name and by ARN, inconsistently

`person_id` is the person key across `client_events`, `cross_conversation_context`, `channel_membership`, `drift_events` and `conversation_creation_tasks` (migration 079), and `conversations` carries no person column.

The two core turn tables do not follow it. `messages` identifies a person by `sender_arn` and `sender_name` and holds no user id; `exchanges` holds no user identity at all beyond `user_role`. `analytics-aurora/analytics-query.ts:1302` returns `m.sender_name AS sender`, so a display name is the identity in an analytics result.

The cost of mixing shapes is already recorded in this codebase. The comment at `kinesis-archival.ts` on `drift_events.person_id` states that the column once held a full ARN on one path and a bare sub on the other, so "any join to a user, and the `idx_drift_events_person` index, silently split in two". The archival code derives the bare id with `personIdFromArn(sender_arn)`, which means **the id is already available at archival time and simply is not stored on the turn tables**.

### The reconstruction path is load-bearing, and that is measurable

On 2026-09-16 the archival Lambda failed on every invocation for 21 hours (a PostgreSQL 42703 on a column that does not exist). Because pairing happens in that Lambda, no exchange was created for the whole window, and every latency surface over that window is empty. That is the correct behavior for a projection whose producer is down, and it is also the evidence that the pairing work is not incidental: it is the only thing that makes a turn's timing knowable.

A turn that carried its own correlation would still need the projection to be queryable, but it would not need the projection to be *correct about what answers what*.

## The decision

### 1. Nothing is built to carry the id. The population moves onto what exists

`AsyncProcessorEvent.userMessageId` (`async-processor-core.ts:763`) is the carrying field and it is already populated on every dispatched turn. There is no transport change to make.

What changed the population is the entry configuration: under `StandardMessages: NONE`, an ordinary untargeted one-to-one turn is dispatched by the flow rather than invoked natively, and therefore carries its id. **That is ADR-036 option B, and this record's contribution is to say what option B buys beyond latency**: it moved the largest reconstructing population onto the carried path.

**Absence stays meaningful and must keep being handled.** `userMessageId` is optional because the natively invoked path genuinely cannot supply it, and targeted messages reach Amazon Lex under every reachable configuration, so that path never empties. A turn reading absence as "reconstruct" is correct; one reading it as an error breaks the remaining path; one treating it as a pairing failure would under-report exactly the population ADR-037 exists about.

### 1a. What that removes, and what it does not

[ADR-038](./038-a-turn-answers-the-message-that-was-there-when-it-started.md) is Accepted and built: the processor bounds a late CONTENT MATCH by the turn's own start instant, through an optional `notAfter` on the shared matcher. That bound exists because the turn is searching for the message it answers by its text.

**A carried id removes the search, not just the bound.** There is nothing to match and nothing to bound: the turn was handed the id. ADR-038's bound stays exactly as built for reconstructed turns, where the search is still the only option.

This is the shape of the whole record. Nothing built for the reconstructed path is removed. It stops running on the path that never needed it.

### 2. The latency model is two paths, not one path with a flag

`turn_entry` is currently shaped as a reporting facet, something to filter a chart by. That is the wrong shape. It is a statement about **how the turn's correlation was obtained**, and the two answers have different guarantees:

| | Carried (flow entry) | Reconstructed (Amazon Lex entry) |
|---|---|---|
| What the turn answers | Known at dispatch | Declared on the placeholder, confirmed later, swept if not |
| Turn start instant | The inbound message's own timestamp | An anchor, per `anchor_source` |
| Time-to-first-feedback | Measured by construction | Measured or reconstructed |
| The sweep and the deferral bound | Do not apply | Apply |
| `paired_by` | `declared`, always | `declared`, `in_batch` or `swept` |

**No new `paired_by` value.** An earlier draft proposed a fourth value, `carried`, to distinguish being told from asserting. It is not needed and should not be added: `turn_entry` already records how the turn entered, so the pair (`turn_entry`, `paired_by`) answers the question, and a third column encoding what two existing ones already determine is the duplicated-source mistake tenet D7 names. `LATENCY-TARGETS.md:386` already states the consequence: "A flow-dispatched turn always declares the message it answers, so it pairs `declared` whatever its latency."

That sentence is also the reason the current headline cannot compare entries: the exclusion is not neutral by entry. `turn_entry` is what makes the split queryable instead of invisible, and no surface reads it yet.

Reporting should say which guarantee a number carries, rather than pooling both and labeling the pool. **The admin console is where that lands**: the latency surfaces read `turn_entry` today as a grouping, and the two-path split is what turns that grouping from a facet into a statement about whether a figure was observed or inferred.

### 3. Classification is derived from the responding assistant

Per ADR-042 an assistant acts in exactly one classification, and which conversations it may join follows from that. So the classification of a turn is a function of its responder, and the classification of a conversation is a function of the assistant that is a member of it.

Analytics should derive it that way rather than read a stamped field. The stamped field is absent on exactly the records AE did not author, and the assistant is present on every record it did.

### 4. A person is keyed by their user id

The user id, the bare sub, is the analytics key. Not a display name, and not an ARN.

A display name is resolved late and only for a caller permitted to see it. An ARN is a location, it embeds the id, and storing it where the id belongs is what split the drift index in two.

For an assistant message the same column holds the assistant's id, which by point 3 is what classification is a function of. One column answers both questions.

## What this does not change

- **It does not remove the reconstruction path.** A targeted message reaches Amazon Lex under every reachable entry configuration ([ADR-041](./041-simplifying-how-a-message-reaches-an-assistant.md)), so reconstructed turns continue to exist and their machinery stays.
- **It does not change who answers.** `flowOwnsTheTurn` and the Lex entry ask the same question so their answers are complements; this record changes what a claimed turn KNOWS, not which side claims it.
- **It does not make a group message answerable that is not answerable today.** A plain untargeted group message is still nobody's turn.
- **It does not delete `sender_name`.** The name stays on `messages` for the archive and the admin conversation view, which is already admin-gated. It stops being an identity.

## Consequences and risks

- **The two entries must not disagree about one message.** This used to be a rule that both callers pass the same `turnEntry`, which was a rule precisely because the entry could be read two ways: provisioned onto the bot at deploy time, and re-derived per message at runtime from the same config. Those two could disagree, giving two responders or none, and nothing downstream could catch either. `flow-bypass.ts:430-443` now records that as the reason the option went rather than merely being unused. One invariant asserted in one place cannot disagree with itself, and carrying an id is what makes the disagreement consequential: the two sides would differ on what the turn answers, not only on who answers.
- **A migration adds columns to the two largest tables.** `messages` and `exchanges` are the highest-volume tables in the projection, and migration 054 is the precedent for adding to `messages` without replacing the view, which is what avoids the outage class that a `CREATE OR REPLACE VIEW` reintroduced once.
- **Mixed-shape identity during the transition.** Rows written before the migration have no user id. Any read that keys on the id has to state what it does with rows that predate it, rather than silently under-report, which is the defect [ADR-037](./037-a-turn-declares-what-it-answers-on-the-message-it-is-already-posting.md) exists about.
- **Deriving classification from the responder is only as good as ADR-042's enforcement.** If an assistant could act in more than one classification the derivation is wrong. That is precisely what the ADR-042 deny-test asserts, so the derivation depends on that test continuing to pass rather than on a comment.

## What this owes

Each item, with where it stands:

1. **A test that the flow's dispatch still carries `userMessageId`**, failing if any dispatch site stops setting it. Built: the type requires it and `a-dispatched-turn-carries-what-it-answers.test.ts` pins every call site.
2. **A test that a carried turn reconstructs nothing**, asserting `findInboundMessage` is not called and the sweep does not run for it. This is the non-vacuity guard for the whole record: the id being carried is worth nothing if the apparatus runs anyway. Built, and it found the apparatus running: the shared resolver now answers from the declaration (Status above).
3. **A migration** adding the user id to `messages` and `exchanges`, following migration 054 in not replacing `v_turn_latency`. Built: migration 074.
4. **An end-to-end check that the two paths are actually distinguishable on a deployment.** A unit test proves the branch; only this proves the deployment produces both populations. **OPEN:** written as a signed read of the per-turn drill that asserts every flow-entry turn pairs `declared` and logs both populations (`the-lex-leg-is-measured-per-turn.spec.ts`), and not yet run.
5. **A statement, in `LATENCY-TARGETS.md`, of which figures are carried and which are reconstructed.** Built: "Carried and reconstructed figures".
6. **A doc review.** Done for `MESSAGE-FLOW.md` (the resolver answers a carried turn from its declaration) and `LATENCY-TARGETS.md` (item 5).

## Rollback

Each part reverses independently, which is why they are numbered rather than bundled.

- **The entry configuration** reverses by restoring `StandardMessages: AUTO` in `assistant-profile-stack.ts`. Turns return to being invoked natively and to reconstructing, because absence of `userMessageId` already means "reconstruct". No data is invalidated: rows already written keep their `turn_entry`, which stays a true statement about how those turns entered. Reversing it per profile rather than for the deployment would mean restoring `turnEntry`, which was deliberately deleted; the hybrid described in MESSAGE-FLOW Appendix C is the record of what that costs.
- **The classification derivation** is a change of which column a query reads. Reverting reads the stamped field again.
- **The user id** is additive. The column is written alongside the existing `sender_arn` and `sender_name`, never instead of them, so a revert stops writing it and no read that predates it changes.

What does NOT reverse cleanly is a `CREATE OR REPLACE VIEW` over `v_turn_latency`, which is why point 3 follows migration 054 in not touching the view.

## What a person sees

Nothing. No behavior a person experiences changes: the same assistant answers the same messages at the same speed.

What changes is what an operator can say about that speed. Today a latency figure pools turns whose timing was observed with turns whose timing was inferred, and reports the pool. After this it can state which it is, per turn, and attribute it to an assistant from a source that cannot be missing.
