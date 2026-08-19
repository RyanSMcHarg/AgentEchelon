---
title: "ADR-022: Message identity is established at the channel flow, not at Lex"
status: Accepted 2026-08-05
date: 2026-08-05
related:
  - "../../specs/ops/SPEC-ABUSE-CONTROLS.md"
  - "../../guides/developer/MESSAGE-FLOW.md"
  - "../../guides/user/TROUBLESHOOTING.md"
  - "./023-battle-round-coordination.md"
  - "./025-who-posts-the-placeholder.md"
  - "../../../backend/lambda/src/channel-flow-processor.ts"
  - "../../../backend/lambda/src/battle-orchestrator.ts"
  - "../../../backend/lambda/src/lib/async-processor-core.ts"
  - "../../../backend/lambda/src/lib/correlation.ts"
  - "../../../backend/lambda/src/lib/placeholder-target.ts"
implemented_by:
  - "`turnCorrelationId` + `correlationMarkerOf` (lib/correlation.ts), used by router-agent-handler"
  - "`mentionCorrelationId` (lib/correlation.ts), used on a flow entry that declares the inbound id"
  - "`claimPlaceholderMapping` / `readPlaceholderMapping` (lib/abuse-controls.ts)"
  - "`resolvePlaceholderTarget` (lib/placeholder-target.ts), the claimed-owner-wins resolution"
  - "channel-flow-processor records the mapping and denies a duplicate placeholder"
amended: |
  2026-08-13, section 4. The identifier rule is stated once for every entry rather than per path, and
  the three battle paths are recorded as NOT satisfying it: their ids embed a timestamp and a random
  suffix, so the flow's duplicate-placeholder guard cannot collapse them and the battle-state claims
  carry that job alone. Also records that `previousBucket` has no production call site, so the
  bucket-straddle case this ADR describes as covered is not. Nothing built by the amendment; it names
  the gap between the rule and the code so a reader stops inferring the rule holds everywhere.
  The current-state description of who posts, when, and under which identifier is MESSAGE-FLOW 5.1.
verified_by:
  - "test/lib/turn-correlation.test.ts - derivation is stable across a retry, distinct between turns"
  - "tests/e2e/fulfillment-retry.spec.ts - against a deployment: a duplicate fulfillment of a real
     in-flight turn adds no second message; a byte-identical retry replays the same correlation marker;
     a different transcript in the same window still answers (negative control)"
supersedes: SPEC-ABUSE-CONTROLS "Request deduplication (P0)", whose stated premise does not hold at runtime
superseded_in_part_by: ADR-025 (who posts the placeholder on a bypass) - section 2
---

<!-- A dedup that lives in a process is not one; see "The control, applied at the flow's own entry". -->

# ADR-022: Message identity is established at the channel flow, not at Lex

## Status

Accepted. Raised by a turn on the normal path that produced no reply: two async processor invocations
served one user message, and the losing one spent 22 seconds searching for a placeholder that was
never its own.

## Context

Two separate designs in this codebase need to answer the question *"which message is this?"*:

- **Request dedup** (SPEC-ABUSE-CONTROLS): Amazon Chime SDK and Lex deliver at least once, so one user
  message can be fulfilled more than once. Collapsing those fulfillments requires a key that is the
  same for both.
- **Placeholder correlation**: the async processor runs after the router has returned, and must find
  the placeholder message it is meant to update in place.

Both answer that question at a layer that cannot see the message.

**Lex request attributes do not carry a message id.** Measured live across every classification, the
attributes present at fulfillment are exactly `CHIME.channel.arn`, `CHIME.sender.arn` and
`x-amz-lex:channels:platform` (`WelcomeIntent` omits the sender). `CHIME.message.id` is not among them.
`resolveOriginatingMessageId` in `live-drift-flow.ts` exists because of this: it reads the id back from
the channel by content match, precisely because it cannot arrive through Lex.

That falsifies the premise the dedup design rests on. SPEC-ABUSE-CONTROLS states the router derives the
correlation id "from the inbound Amazon Chime SDK message id, which the fulfillment event already
carries". The code implements that statement faithfully. Because the attribute is absent, every
fulfillment mints a fresh UUID, so two fulfillments of one message never share a key and the claim
never collapses anything on the normal path.

**Placeholder correlation has the same shape.** The placeholder is created by Amazon Chime SDK from the
Lex response, so its `MessageId` does not exist when the router invokes the processor. The processor's
only handle is the `<!--corr:{uuid}-->` marker, found by scanning a bounded window of recent messages
over roughly twenty seconds. That is a best-effort search, and it loses.

**The paths that work are the ones anchored at the flow.** `/battle` derives
`deriveBattleId(channelArn, userMessageId)` and claims it durably in the battle state table, and the
flow posts each placeholder itself so it can hand `placeholderMessageId` to the processor directly.
`@all` derives `mention-<messageId>`. Both work because the channel flow gave them a real message id.
The normal path is the one with no durable claim and no handed id, and it carries the most traffic.

**Why this went unexamined the longest.** The exotic paths were built with explicit attention to
at-least-once delivery, so each got a durable claim. The normal path inherited its protection from a
specification sentence rather than from a runtime check, and a specification that says a control is
always on reads the same whether or not the value feeding it arrives. The most travelled path was the
least verified because it was assumed settled.

### What the Amazon Chime SDK actually guarantees here

Two constraints come from the configured flow (`channel-flow-stack.ts`), and they bound what any
flow-side control can promise:

- **`InvocationType: 'ASYNC'`.** The processor is invoked asynchronously, so AWS Lambda's asynchronous
  retry behaviour applies: a function error replays the identical event, with the same `MessageId` and
  the same `CallbackId`. Any claim taken before the work completes would block the retry that is meant
  to recover the failure.
- **`FallbackAction: 'CONTINUE'`.** If the processor fails or times out, the message is delivered
  **unprocessed** rather than dropped. The failure path routes around the flow entirely, so no
  flow-side control can be a hard guarantee.

Two further points of accuracy about the API surface:

- **Amazon Chime SDK documents no idempotency guidance for channel flows.** The concept page, the
  processor setup page, and the `ChannelFlowCallback` reference say nothing about at-least-once
  delivery, duplicate invocations, or retries. The at-least-once behaviour this ADR responds to is
  measured on this deployment, not quoted from AWS.
- **There is no per-message idempotency token.** The invocation event carries `EventType`, `CallbackId`
  and `ChannelMessage`. `CallbackId` is documented as the identifier used to call the service back, not
  as an idempotency token. The one documented idempotency token in this API surface,
  `ClientRequestToken`, belongs to `CreateChannelFlow` and makes creation of the flow **resource**
  idempotent. It has no bearing on message processing.

`MessageId` is therefore the only stable per-message identity the service offers a processor. Keying on
it is not a preference among options; it is the only one available.

Three options were considered:

1. **Plumb the message id into Lex request attributes** by having the flow set it on `callbackAllow`.
   This assumes Amazon Chime SDK forwards a flow-set attribute into Lex request attributes, which is not
   established and needs its own live probe.
2. **Derive a key by hashing message content** (channel, sender, transcript). Needs no extra call, but a
   user who legitimately sends the same short text twice inside the dedup window is silently dropped.
   In a drift confirm or decline flow that text is `yes`.
3. **Dispatch the normal path from the flow**, as `@all` already does. The flow would post the
   placeholder itself and learn its `MessageId` from the `SendChannelMessage` response, removing the
   correlation marker, the lookup, and this whole class of problem. It is the cheapest option on paper
   and measures well. It is **bounded by a platform constraint**: a channel flow cannot reliably
   prevent Lex from being invoked on a message it releases. The only dependable suppression is
   `callbackDeny`, which drops the user's message from the channel entirely. That is correct for a
   `/battle` continuation, where hiding the user's reply is the intent, and wrong for an ordinary turn,
   where the message must remain in the conversation. This is why the flow-dispatch paths in this
   codebase are `@all` and `/battle` and not the normal path.
4. **Anchor both designs where the stable id already exists.**

## Decision

**Stable message identity is established at the channel flow. Idempotency and placeholder correlation
both anchor there, and neither depends on a value passing through Lex.**

The channel flow is the only component that sees a stable Amazon Chime SDK `MessageId` for every message, and it
sees it twice over: once on the inbound user message, and again on the bot placeholder, which re-enters
the flow like any other message.

### 1. The correlation id is derived, so one dispatch claim covers every path

The router derives the correlation id from the turn itself (channel, sender, transcript, and a short
time bucket) rather than minting a random one, so a retried fulfillment of the same turn produces the
SAME id.

**Every input is one a retry provably replays**, which is the property the control rests on. The Lex
`sessionId` is deliberately excluded: it separates nothing that channel and sender do not already
separate, and it would make the control depend on Amazon Chime SDK replaying the same session on a
retry, which is undocumented and was never measured. An input that discriminates nothing and can only
fail is a liability - if it varied, every id would differ and this control would silently do nothing.
The transcript half is confirmed: a live duplicate shows two fulfillments 2.6 seconds apart carrying a
byte-identical transcript.

That is what makes deduplication work, and it requires no new control. The async processor already
claims `dedup#<correlationId>` before any model call. The claim was inert on the normal path only
because the key changed on every fulfillment; with a derived key it collapses the duplicate, exactly as
it already does for `@all` (`mention-<messageId>`) and `/battle` (`deriveBattleId`).

**No claim is taken on the inbound message at the flow.** An earlier form of this decision put a lease
there. It is both unnecessary and unsafe. Unnecessary because the duplicate on the normal path is a
retried Lex FULFILLMENT, which happens downstream of the flow after the message is released, where a
flow-side claim cannot see it. Unsafe because the only way a flow can stop a message reaching Lex is
`callbackDeny`, which removes the user's own message from the conversation.

**The window is a deliberate trade.** Two byte-identical messages from the same sender in the same Lex
session, inside the window, resolve to one turn and receive one answer. The window is sized for a retry
(90 seconds), not for a conversation, so a deliberate repeat later is unaffected. `previousBucket` is
the affordance for a retry that straddles a bucket boundary, and no production call site passes it
(section 4), so that case derives a different id today.

### 2. An id is handed over only where it already exists

> **Superseded in part by [ADR-025](025-who-posts-the-placeholder.md).** On a bypass the assistant
> posts its own acknowledgment, and the handler does not pass `placeholderMessageId` on because it
> dispatches the worker before the message exists. Those paths resolve through the `corr#` mapping
> recorded at section 2b instead. The principle below - identity comes from the flow - is unchanged;
> only who performs the send differs.

Exactly one entry hands `placeholderMessageId` to the processor: the battle continuation, which answers
onto the side's existing "waiting" message and so never polls. It holds that id because the message was
created on an earlier turn, not by this dispatch.

Every other entry dispatches BEFORE its placeholder exists, so there is nothing to hand over. On a
bypass the assistant posts its own acknowledgment after the dispatch (ADR-025); on the Lex path Amazon
Chime SDK materialises it from the fulfillment return. Both resolve through the `corr#` mapping
recorded at section 2b, in a point read taken at finalize, after the model call.

That ordering is a decision and not an accident. Posting first would let the sender hold the id, and it
was priced: reordering every return path in the handler to save one `GetItem`, on paths where
resolution is not failing. Declined (ADR-025, option 1).

**A duplicate on the Lex path is stopped in the handler instead**, by REPLAYING THE SAME PLACEHOLDER -
the identical `<!--corr:{id}-->` marker, with no work done - so the two attempts are interchangeable.

**Silence is not available here, and the constraint is the reason.** Amazon Chime SDK materialises one
message per turn from the LAST fulfillment response, so a response that returns nothing suppresses the
only message that reaches the channel - which may be the attempt that did the work. Measured live: two
fulfillments 3.5 seconds apart, where the second returned an empty envelope and that envelope became
the channel's only bot message. Replaying the placeholder makes the two attempts interchangeable, so
whichever materialises carries the marker the dispatched processor is looking for.

**One decided exception: a duplicate of a GATE-BLOCKED fulfillment stays silent.** The dispatch claim
runs before the abuse gate (so a duplicate cannot double-meter the user), which means a winner can take
the claim and then be refused: it dispatched nothing and returned the block notice, not a placeholder.
Replaying the placeholder there would post a waiting bubble no worker will ever update, and the
last-response-wins materialisation would discard the notice the person should see. So the router marks
the block beside the fulfillment claim (`fulfil-blocked-<correlationId>`), and a duplicate that finds
that marker returns the empty envelope so the winner's notice stands. A gate block is fast and never
hits the retry timeout, so the notice did materialise; the marker write is best-effort, and an
unwritten marker degrades to the ordinary replay.

### 2b. The flow still claims the correlation, as a duplicate guard

When a bot message carrying `<!--corr:{id}-->` passes through, the flow claims `corr#<id>` against that
`MessageId` with a 300 second TTL. A DIFFERENT message holding the same correlation is a second
placeholder for a turn already in flight, and is denied.

**This sees EVERY bot message, including ones Amazon Chime SDK materialises from a Lex return.**
Measured live: a Lex fulfillment returned `{"Messages":[]}`, Amazon Chime SDK created a message from it, and the
flow was invoked for exactly that MessageId. So no placeholder is out of the flow's reach - it sees
each one, holds a stable MessageId for it, and can deny it.

What the guard catches: a cross-container redelivery of an `@all`, which posts its placeholder before
any durable claim is taken, and a second placeholder carrying a correlation already claimed. `/battle`
is already claimed upstream (`tryClaimRound1Fanout`, `resumeBotFromWaiting`) and cannot reach it twice.
It is no longer how any placeholder is FOUND.

**The limit is the KEY, not the reach.** The guard matches on the correlation marker, so it collapses
two placeholders only when they carry the SAME id. Two entries that derive the id by different rules
produce two keys, and both placeholders survive. Closing that requires one identity both entries can
compute - see the revisit condition under Consequences.

**The mapping is write-once, and only from a platform bot.** The correlation id is parsed out of message
*content*, and this codebase already treats control markers as attacker-supplied: `stripMessageMarkers`
exists precisely because a user can type one. Two constraints keep that from becoming an abuse
primitive. The write is conditional on `attribute_not_exists`, so an existing claim can never be
overwritten, and the marker is honoured only when the sender ARN is one of the deployment's own bots.
Without both, a user who induced an assistant to echo a `<!--corr:...-->` string could claim a
correlation before its real placeholder arrived, and the guard would then deny that placeholder - the
turn would lose the message it was going to answer in. The risk is denial rather than redirection now
that no path resolves a placeholder through this key.

The write-once rule is also required for ordinary operation, not only against abuse: updated persistent
messages re-invoke channel flows, so when the processor updates the placeholder with the real answer
that update re-enters the flow carrying the same marker. The flow will legitimately see the same
correlation id more than once, and must not treat the second sighting as a new mapping.

Ordering favours this. Amazon Chime SDK creates the message, the flow intercepts it, the flow takes the claim, and
only then is the message released and visible to `ListChannelMessages` - so a duplicate is denied
before it can ever be seen.

**Only the normal path still searches.** The flow-dispatched paths resolve by the mapping the flow
recorded, in a point read. The normal path's placeholder is created by Amazon Chime SDK after the
router returns, so the processor has no id at dispatch time and falls back to scanning for the marker.

That placeholder passes through the flow, so a `corr#` mapping is recorded for it too. The scan
persists because of ORDERING, not reach: the processor may look before the flow has recorded the
mapping. Its bounded search remains the one place a placeholder can be missed while present.

**When no placeholder resolves.** Two cases, and they need different endings. If this invocation lost
a duplicate dispatch, another invocation owns the placeholder and is answering; the loser returns
without posting, because posting would produce a second answer rather than a repaired one. If no
invocation resolves, the user is left with a placeholder that never settles, which is the original
symptom and must not be left silent: the turn is reported as failed in place, so the user sees a turn
that did not complete rather than one still in progress, and any task the turn opened is closed as
failed rather than left pending. A processor that gives up emits the log line named in
TROUBLESHOOTING §19 so the condition is alarmable, since the failure is rare and load-sensitive and
will not surface in a normal test run.

The distinction is decidable: the losing invocation is the one that resolved no placeholder *and* whose
dispatch claim was already held by another invocation.

### 3. One derived id serves both jobs

The correlation id both keys deduplication and labels the placeholder so the processor can recognise
it. A single derived id serves both, and `CHIME.message.id` could serve neither. It cannot key dedup,
because it never arrives. It could not label the placeholder either: the placeholder is a *different*
message from the one the user sent, created later, so identifying it requires a label carried in the
placeholder itself. Embedding the label in content is the established pattern for that reason, not a
workaround.

The derivation `CHIME.message.id || randomUUID()` is therefore replaced by `turnCorrelationId`, and the
misleading attribute read is removed rather than left to imply a capability that does not exist.

Retries are unaffected either way: an asynchronous Lambda retry replays an identical event, so it
carries the same correlation id and the processor's existing claim collapses it. That case has always
worked, and it is not what this ADR changes.

### 4. One identifier rule across every entry

Six entries reach the same processor, and each was given its own minting rule as it was built. The rule
is one rule: **a turn's correlation id is derived from evidence a redelivery provably replays**, and it
is minted by the first component that holds that evidence. There is one id per RESPONDING ASSISTANT per
turn, so a two-sided duel has two, and it carries every job in section 3 at once.

| Entry | Derivation | Minted by | Satisfies the rule |
|---|---|---|---|
| ordinary Lex turn | `turnCorrelationId(channel, sender, transcript, 90s bucket)` | the handler | yes |
| drift-spawned welcome | the same derivation, over the SPAWNING message | the handler | yes |
| `@all` | `mention-<inbound MessageId>` | the handler, from the id the flow declares | yes |
| `/battle` round 1 | `battle-r1-<bot>-<timestamp>-<random>` | the channel flow | **no** |
| battle continuation | `battle-r1c-<bot>-<timestamp>-<random>` | the channel flow | **no** |
| round 2 | `battle-r2-<bot>-<timestamp>-<random>` | the orchestrator | **no** |

**What the three exceptions cost, stated rather than implied.** Section 2b's guard matches on the id,
so two deliveries of a battle side produce two keys and both placeholders survive it. What actually
keeps a duel idempotent is a different set of claims, keyed on the deterministic
`deriveBattleId(channelArn, userMessageId)`: `tryClaimRound1Fanout`, `resumeBotFromWaiting` and
`tryClaimOrchestratorFire`. That is a working control, and it is not the one this ADR describes. A
reader who takes "the flow denies a duplicate placeholder" as universal will build on a guarantee that
holds on three entries out of six.

**Closing it is a derivation change, not a mechanism.** Each battle id has replay-stable evidence
available at its minting site: `battleId` plus the side for round 1 and round 2, and `battleId` plus
the side plus the inbound `MessageId` for a continuation, which the flow holds even though it denies
that message. The cost is that the correlation id is also the battle state row key, so the change
touches those writers. The benefit is that one guard then covers every entry and the battle claims
become defense in depth rather than the only control.

**The affordance for a bucket-straddling retry is not wired.** `turnCorrelationId` accepts
`previousBucket` and no production call site passes it; only `test/lib/turn-correlation.test.ts` does.
A retried fulfillment that lands the other side of a 90 second boundary therefore derives a different
id and is not collapsed. The window trade described above is real, but the boundary case it names as
handled is handled only in the unit test.

**One field names two different things.** `placeholderMessageId` means "a message this dispatch
created" in the general case and "a message that already existed, which this turn writes onto" for the
battle continuation, which is the only caller that sets it. The second is not a placeholder for this
turn at all: it carries an EARLIER turn's marker, so it can never be resolved by this turn's id and has
to be handed over. Naming them apart is what keeps rule 3 in MESSAGE-FLOW 5.1 (nothing hands over an id
it obtained by posting) true without an unexplained exception.

## The control, applied at the flow's own entry (2026-08-14)

The flow's own duplicate gate was the last place still outside this ADR, and it looked like it was
inside. It was a module-scope `Set`, declared under a comment naming it the idempotency gate for the
at-least-once delivery of Amazon Chime SDK channel flows, capped at 200 entries and evicting by
insertion order.

**A dedup that lives in a process is a same-container optimisation wearing the label of a control.** A
redelivery is a separate invocation, usually on a separate container, so both attempts read an empty
set and both believed they were the first. Measured: two invocations 139ms apart, different Lambda
request ids, carrying one `MessageId` and one `CallbackId`.

It now claims `flow-<MessageId>` through `claimCorrelation`, the same conditional write the processor
and the round-1 fan-out use. `MessageId` needs no derivation: Amazon Chime SDK replays it verbatim, so
it is already a key a redelivery provably replays.

**The claim is bypass-only.** It is taken only when the message takes a flow-owned path (`@all`,
`/battle`, or a battle continuation); an ordinary message is released to Lex without one, because its
duplicate is a retried FULFILLMENT that only the handler's derived-id claim can see.

**Claim-before-dispatch is a decided trade, not an oversight.** A winner that dies between taking the
claim and dispatching makes the redelivery a no-op, and that turn is lost. The window is bounded on
both sides: the claim carries the dedup TTL (5 minutes, and Amazon Chime SDK redelivers within
seconds), and the window itself is a hard crash only - every dispatch path that can fail notifies the
sender instead of throwing through. Claiming after dispatch would reopen the double answer this claim
exists to prevent, which is the worse direction: a duplicate is visible and confusing, a rare lost turn
is retryable by the person.

**The loser still calls back.** The claim records that the MESSAGE was handled, not that its CALLBACK
was resolved, and a winner that died between the two would otherwise leave Amazon Chime SDK holding the message
until it times out. `FallbackAction: CONTINUE` then delivers it UNPROCESSED, past the mention rules and
marker stripping the flow exists to apply. Resolving a callback the winner already resolved is safe
because an already-decided callback is no longer treated as an error.

`Verified by:` `test/lib/flow-dedup-survives-a-cold-container.test.ts`, which loads the handler twice
so the two invocations genuinely do not share module scope. A single-instance test passes against the
`Set` and proves nothing, which is why this one exists in the shape it does.

## Consequences

- The normal path gains the durable, cross-container idempotency the exotic paths already have. One
  user message produces one assistant turn.
- SPEC-ABUSE-CONTROLS stops claiming request dedup is always on when it is inert on the normal path.
  The control plane logic was never wrong; the key feeding it was.
- Placeholder resolution becomes deterministic, so the replacement-placeholder compromise is not
  reachable and the one-message-updated-in-place pattern holds without exception.
- The flow takes one conditional write per BOT message, and none on the inbound message, which the
  Decision rules out as both unnecessary and unsafe. It is a point operation on a table the flow
  already reaches for rate limiting.
- A deployment without the shared table keeps today's behaviour. Dedup fails open, as it does now.
- Unit coverage that asserts the claim against a mocked table is not sufficient evidence that dedup
  works. It passes a key in directly, so it holds whether or not the derived key is stable, which is why
  it did not detect this. **Verification for this ADR is a test that delivers one message twice through
  the flow's own derivation and asserts exactly one assistant turn and one model call**, plus a test
  that the marker parser rejects an id it should not honour. `test/lib/turn-correlation.test.ts` covers
  the derivation properties: stable across a retry, distinct between turns and senders, separating again
  once the window passes, and short enough to ride in content. What unit coverage CANNOT establish is
  that a live retried fulfillment actually reuses the id, since that depends on Amazon Chime SDK
  replaying the same Lex `sessionId` and transcript. Confirming that against a deployment is required
  before this is described as verified.
- The control is best-effort by construction, so no downstream component may assume exactly-once. The
  processor keeps its own dispatch claim, and anything that would be harmful to run twice stays
  individually guarded.
- **Resolution is three deep and the claimed owner wins.** `resolvePlaceholderTarget` prefers the
  `corr#` owner over any handed id, then the handed id, then a single deferred marker scan run after
  the answer is ready. The preference order is not cosmetic: the flow's guard and the processor's
  dispatch claim pick their winners independently, and when they diverged the answer landed on a
  message the flow had already denied while the surviving placeholder never settled.
- **The identifier rule holds on three entries of six** (section 4). The battle derivations are open
  work, and until they change, the section 2b guard reaches every placeholder but collapses only the
  entries whose id a redelivery reproduces. Cite the battle-state claims for those paths, not the
  guard.
- **`previousBucket` is unused in production** (section 4), so the bucket-straddle case is covered by a
  unit test and nothing else. Either wire the adjacent-bucket check at the claim site or stop
  describing it as handled.
- **Revisit when** Amazon Chime SDK forwards flow-set attributes into Lex request attributes. If that
  is ever established by probe, option 1 becomes available and the router could identify its own
  message without help. It is not needed for this decision.
