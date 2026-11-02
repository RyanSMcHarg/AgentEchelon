---
title: "ADR-044: The channel flow routes optimistically from a stored bit and a token"
status: >-
  Declined 2026-10-11 (owner). Proposed 2026-09-17, with its enforcing layer MEASURED. The channel flow reads a paginated channel roster on every message so that four routing questions can be answered from it. Only two need anything about the conversation, and neither needs a name or a count: is this larger than a one-to-one, and which assistants are here. A person mention resolves to nothing that changes routing, verified in code. A private prefix cannot be verified by the flow at all, because Amazon Chime SDK does not deliver `Target` to a channel flow. And the flow does not have to be RIGHT about membership, because most channel operations require it: an assistant that is not a member is refused by the service, so the flow's knowledge is an optimization and the platform is the enforcing layer, measured 2026-09-17 for the bot principal in both channel modes with positive controls. The record recommends a stored routing context, written from membership events already on the stream, read per message, with a live read when it is missing. The owner shelved that read on 2026-09-17 (decision 2): the store saves about 32 ms at p50 against the live roster read and is the wrong trade, because the read already sits after release and a stored bit adds a silent failure branch. The owner declined the record on 2026-10-11 on the same reasoning, so the flow keeps reading the live roster on every message. The unused store and its writer are removed. Revisit if a conversation past the 50-member page boundary becomes ordinary, or if the read moves back in front of the person.
date: 2026-09-17
related:
  - "./034-addressing-a-message-is-not-making-it-private.md"
  - "./040-an-identity-rides-beside-a-persons-words-not-inside-them.md"
  - "./041-simplifying-how-a-message-reaches-an-assistant.md"
  - "../../overview/TENETS.md"
  - "../../guides/developer/MESSAGE-FLOW.md"
  - "../../../backend/lambda/src/lib/flow-bypass.ts"
  - "../../../backend/lambda/src/lib/channel-size.ts"
  - "../../../backend/lambda/src/lib/private-prefix.ts"
  - "../../../backend/lambda/src/lib/abuse-controls.ts"
  - "../../../backend/lambda/src/channel-flow-processor.ts"
  - "../../../backend/lambda/src/membership-audit.ts"
tracking: |
  Declined 2026-10-11. Everything described as as-built is READ FROM THE TREE at the date above with a file and
  line. The claims that carry the record are each cited rather than asserted: that a person mention has
  no routing effect, that the flow is not given a `Target`, that the roster read paginates, that the
  flow already reads DynamoDB on this path, and that a non-member send is refused by the service. The
  unused store and its writer are removed. The prerequisite it names - the post-delivery
  handling of a real private token with no `Target` - is BUILT (ADR-034).
---

# ADR-044: The channel flow routes optimistically from a stored bit and a token

## Status

**Declined (owner, 2026-10-11).** Proposed 2026-09-17. The owner shelved decision 2 on 2026-09-17, after the measurement below and not before it: the store is the only read that buys anything, about 32 ms at p50 against the live roster read, and it is still the wrong trade (the reasons are under decision 2). The record is declined on that reasoning. The flow keeps reading the live roster on every message, and routing behavior is unchanged. The unused store and its writer are removed, because nothing reads them.

**Revisit when** a conversation past the 50-member page boundary becomes ordinary (the paging cost the measurement could not reach), or when the roster read moves back in front of the person seeing their own message. Not for the 32 ms as it stands.

The prerequisite this record names, routing a real private token that arrives with no `Target` to the assistant it addresses, is built (`enforcePrivateAddressTarget` in `lib/private-command.ts`; `backend/test/lib/a-private-address-without-a-target-is-routed.test.ts`).

**The recommendation, declined: the flow reads a stored routing context, not a roster, and routes optimistically because it is not the layer that enforces membership.** The reasoning below is kept because it is what a revisit starts from.

## Read this first

The flow runs on every message in the deployment, synchronously, with Amazon Chime SDK waiting on it. What it spends before it knows whether it has anything to do is paid by every conversation, including rooms with no assistant in them where people are talking to each other.

It currently reads the whole roster. `resolveChannelSize` (`lib/channel-size.ts:134-140`) pages `ListChannelMemberships` at fifty per page up to a page limit, and returns `{ memberCount, members, isOneToOne }`, which is handed to `flowOwnsTheTurn` so it can answer four questions at once.

**Two of the four need nothing from the roster at all, and the other two do not need it to be correct.**

## The four questions

| Question | What answers it | What it needs |
|---|---|---|
| Is this larger than a one-to-one? | `isOneToOne` | **One bit.** Not a count |
| Which assistants are here? | roster scan | **The assistant ARNs.** Bounded by the number of assistants, not by the room |
| Which assistant was named? | `resolveMentionedAssistant` | Match against the **deployment's bots**, then confirm that one is here |
| Is this privately addressed? | `resolvePrivateTarget` | The text alone. It is a proxy, not a check |

### Assistant resolution does not need the roster, and does not follow from the classification

> **THE REASON TO DO THIS IS CORRECTNESS, NOT LATENCY (2026-09-17).** The measurement below removes the speed argument: resolving an assistant without the roster does not make the read cheaper, because the read costs what an Amazon Chime SDK call costs. What it removes is an AMBIGUITY. `resolvePrivateTarget` and the mention resolver both match a display name against the channel roster and take the FIRST hit (`private-prefix.ts:143`, `members.find`), so a person sharing a display name with an assistant is resolved by roster order - and the flow then reports a private-address mismatch for a message whose client was right. Matching an assistant against the deployment's bots is a deterministic answer to "is this an assistant" that no roster ordering can change.

**The deployment's bots are a cached, deployment-scoped list.** `ListAppInstanceBots` changes when a profile is added, which is to say on deploy, so it memoizes per container and costs nothing after the first message. Matching `@Atlas` against it needs no channel read.

**But being a bot is not being a bot HERE**, and the classification does not settle it. A conversation does not necessarily hold the one assistant its classification implies: a duel runs two, the live assistant and its role's alt. So "which assistants are in this channel" is a genuinely per-channel fact.

**Confirming one bot is a point lookup, not a scan.** `DescribeChannelMembership` takes a channel and a member and is already used on the battle paths (`battle-outcome-api.ts:113`, `channel-battle.ts:717`).

> **MEASURED 2026-09-17, AND THE POINT LOOKUP IS NOT CHEAPER.** It was assumed here that paging a roster to find one name was the expensive shape and that a point lookup would avoid it. Timed warm against the dev deployment, interleaved, 25 runs after 5 discarded warm-ups, on a two-member channel:
>
> | Read | p50 | p90 | min |
> |---|---|---|---|
> | `ListChannelMemberships` (today) | 110.7 ms | 118.5 ms | 93.6 ms |
> | `DescribeChannelMembership` (the point lookup) | 112.4 ms | 118.8 ms | 94.1 ms |
> | DynamoDB `GetItem` (the stored context) | 78.7 ms | 85.8 ms | 76.3 ms |
>
> **The point lookup saves nothing** - it is 1.7 ms SLOWER at p50, inside the noise. On a room that fits one page the cost is the API round trip, not the payload, and both are one Amazon Chime SDK call. The scan-versus-lookup distinction only begins to pay past the 50-member page boundary, and no such conversation exists on the deployment to measure.
>
> **Caveats, so these are not read as more than they are.** Taken from a workstation rather than from a Lambda in-region, so every number carries the same internet round trip and the absolute figures are inflated; the ordering and the rough gap reflect service-side latency and should survive, but that has not been confirmed in-region. One channel, two members.

So the expensive shape is not the paging. It is the Amazon Chime SDK call itself, which is why the alternative below is about what the flow must KNOW rather than about how it reads it.

### A person mention has no routing effect

`channel-flow-processor.ts:1324` is the entire consequence of an `@` that resolves to a person:

```ts
if (mightMention && !mentioned && !mentionsAll && !invokesBattle && size && !size.isOneToOne) {
  console.warn('[ChannelFlow] an @ token named nobody in this conversation; no turn starts', ...)
}
```

A warning. `@Alice` where Alice is a real member, and `@Zzz` where nobody is, produce the identical outcome: no dispatch, no turn, no message.

**Why it ever mattered.** `mentionsAMember` makes `flowOwnsTheTurn` return true, and owning the turn meant **the Amazon Lex entry stood down**. That was load-bearing while `StandardMessages: AUTO` invoked Amazon Lex for a one-to-one. With that configuration removed (ADR-041), nothing is invoked for an untargeted message at any size, so there is nothing to stand down.

**Mentions exist to route to an assistant. That is the whole of their routing job.**

**The warning is not collateral and must survive.** It is the only signal that somebody typed a name and got silence, which is the shape tenet D11 exists for. It is gated on `mightMention && !mentioned`, both of which survive, so it costs no roster.

### The private prefix is a proxy, not a check

**The flow is not given a `Target`.** Amazon Chime SDK delivering one to a channel flow is listed in ADR-041 as a condition to revisit when it becomes true, which is to say it is not true now. The flow cannot verify privacy.

What `resolvePrivateTarget` decides is narrower: **"this probably carries a `Target`, so Amazon Lex will answer it and the flow must not claim it too."** Preventing a double answer, not protecting a secret.

**A proxy does not need to resolve who.** `mightAddressPrivately` (`lib/private-prefix.ts:148`) answers it from the text alone, and a `.word` matching the shape but naming nobody is a typo. Not answering a typo is correct.

**The case that matters is the opposite one** - a real token naming a real member, arriving with no `Target` - and it is settled after delivery by routing to the assistant the address names (ADR-034). That handling is BUILT, and it is the prerequisite here.

## The decision

### 1. The flow is not the layer that enforces membership

**Most channel operations require membership, so the service refuses a sender that is not a member.** That would make the flow's knowledge an optimization rather than an enforcement, and it is why the flow may be wrong about it. Tenet D3 asks for two layers; this names which one holds.

> **MEASURED FOR THE BOT PRINCIPAL, 2026-09-17, AND IT HOLDS IN BOTH CHANNEL MODES.**
>
> | Channel mode | Bot a member | Outcome |
> |---|---|---|
> | `RESTRICTED` | no | **Refused**, `ForbiddenException` |
> | `RESTRICTED` | yes | Sent (positive control) |
> | `UNRESTRICTED` | no | **Refused**, `ForbiddenException` |
> | `UNRESTRICTED` | yes | Sent (positive control) |
>
> Both controls passed, so the refusal is the membership and not something else. And **the guarantee does not depend on the channel mode**: a deployment that later creates `UNRESTRICTED` channels does not silently lose the backstop. The probe distinguished a credential failure from a refusal as a distinct loud outcome, because an earlier probe in this repository reported a finding from an expired token by reading any error as a refusal.
>
> This was taken because the claim had been an extrapolation. What was on record was a refusal for the SERVICE APP-INSTANCE-ADMIN (`admin-notification-channel-provision.ts:14`), a different principal kind, and this platform has been surprised by a per-role difference here before: that same administrator READS a channel without membership. ADR-041 rule 10 - established by attempting it, not by reading the model.

Being wrong therefore produces a refusal, never a wrong answer:

| The flow is wrong because | What happens |
|---|---|
| An assistant joined after the message was sent | The original assistant answers. **This is the better outcome**: the message was sent into a one-to-one and expected an answer, and a perfectly fresh read would have stood down and answered nobody |
| An assistant left after the message was sent | The post is **refused by Amazon Chime SDK**. Caught, not silent |
| The stored bit says group and the room is now one-to-one | **Nothing happens, and nothing objects.** The only branch that produces no exception, and therefore the only one that needs a counter |

### 2. A stored routing context, written from the events already on the stream - SHELVED 2026-09-17, DECLINED 2026-10-11

> **SHELVED (owner, 2026-09-17), AFTER THE MEASUREMENT ABOVE AND NOT BEFORE IT.** The store is the only one of the three reads that buys anything: 32 ms at p50 against the live roster read. That is a real saving and it is still the wrong trade, for three reasons taken together.
>
> - **It lands in the wrong place.** ADR-041 rule 4 already moved this read AFTER `callbackAllow`, so the person has seen their own words before it runs. The 32 ms delays the placeholder, on a turn measured in seconds.
> - **It buys that with a correctness surface.** A stored bit saying group when the room is one-to-one produces no exception at all - this record names it as the one branch nothing else surfaces - and it trades "read current state from the service" for a projection with a TTL, a writer, a reconciliation story and a refusal classifier.
> - **The thing it was meant to enable turned out not to need it.** The point lookup was the reason a stored assistant list looked necessary, and it is not cheaper.
>
> **The store and its writer are removed (2026-10-11).** The store module and the post-processing rule that writes it are not consulted by anything, so they are deleted with the decline. The writer decision is recorded below, so whoever revisits this starts from the measurement rather than from the assumption it replaced.
>
> **Revisit it if** a conversation past the page boundary becomes ordinary (the paging cost this measurement could not reach), or if the read moves back in front of the person. Not for the 32 ms as it stands.

The design below is the one settled before the shelving, recorded for a revisit. None of it is built.

Per channel: the larger-than-one-to-one bit and the assistant ARNs, written from the membership events already on the message stream and read by the flow per message.

**The event is the TRIGGER; the live roster is the SOURCE.** The entry is not built by applying the event's delta to the previous entry. On a membership event the writer re-reads that channel's roster and stores what it read. An incremental apply would compound a single missed or out-of-order event into an entry that is wrong from then on, and nothing would ever correct it; a re-read is self-healing, and membership events are rare enough that the read costs nothing anyone is waiting on. It also keeps tenet D7 intact - the stored value is a copy of something Amazon Chime SDK was asked for, never a tally this component maintains.

**This is the form ADR-041 Appendix K already committed to conditionally:** "a bit, written from the live roster, invalidated by the membership event, with the silent direction of the crossing counted." Each clause earns its place.

- **Written from the event, not by the writers.** Appendix K refused a write-through row because `chime:CreateChannelMembership` is held by seven Lambdas and vended to administrators, who would never update it. A row written from the event observes every writer regardless of who made the change.
- **Read, not memoized per container.** A per-container memo cannot be invalidated by a stream event, because the flow is a `ChannelFlowCallback` and not a stream consumer. A shared store is what makes event invalidation reach it.
- **The read is already precedented on this path.** The flow calls `claimCorrelation` per message against a generic `pk`+`ttl` DynamoDB table (`lib/abuse-controls.ts`), so this is an existing seam rather than new infrastructure (tenet D8).

**A missing entry reads live.** A new channel, or one the projection never saw. That keeps the store off the correctness path and matches the direction `channel-size.ts` already fails in.

**And the entry carries a TTL, which is the reconciliation half rather than a cache detail.** Events get dropped and consumers fail; tenet D6 says a low-frequency sweep behind an event path is correct design precisely because of that, and an expiring entry is the cheapest form of it. Expiry falls back to the live read, so a missed membership event costs one stale window bounded by the TTL rather than until the channel changes again. The existing `pk`+`ttl` table (`lib/abuse-controls.ts`) already has the shape.

**SETTLED 2026-09-17: the post-processing rules write it** (`lambda/src/message-post-processing.ts`), as a rule of their own.

**The audit path was disqualified on a fact this record had wrong.** It said `membership-audit.ts` "already sees `CREATE_CHANNEL_MEMBERSHIP` and `DELETE_CHANNEL_MEMBERSHIP`". It does not. `AUDITED_EVENT_TYPES` is `CREATE` and **`UPDATE`** (`lambda/src/membership-audit.ts:127`), and `lambda/src/membership-audit.ts:678` drops every other event type before any work. So the auditor never observes an assistant LEAVING - which is precisely the transition the routing context exists to notice, and the one row in the table above that produces a refusal rather than a wrong answer. Building the writer there would have required widening an audit path's event set for a routing reason, on top of the objection already recorded: an audit path and a routing path are two unrelated reasons for one Lambda to fail.

**Post-processing already receives both events.** Its Kinesis event source declares no filter (`lib/stacks/post-processing-stack.ts`), so every channel event on the stream reaches it, and `parseStreamRecord` reads the envelope (`EventType` + `Payload`) rather than assuming a message shape. Its stated contract is a list of rules that each decide for themselves whether they apply and that never throw, which is exactly the shape of a best-effort projection whose absence is a live read.

**It is a THIRD shape for that component, and it is named rather than folded into the other two.** Post-processing today holds rules that act on a message delivery did not route, and out-of-band side effects of one that it did. This is neither: it acts on a MEMBERSHIP event and writes state another component reads. That file's header records that its second shape "was added rather than stretched onto the first"; this is the same move, for the same reason (tenet D9). What stays out is unchanged: archival, measurement and analysis have their own consumer.

**No new infrastructure, and the permissions already exist.** The entry is a `pk`+`ttl` item on the table `claimCorrelation` already uses; post-processing already holds `dynamodb:PutItem` on it for its action claim and `chime:ListChannelMemberships` for the re-read, and the flow already holds a write on the same table. The flow gains one `dynamodb:GetItem` (tenet D8).

### 3. Tenet D7 is satisfied because the store is not a second answer

Tenet D7 says to read current conversation state from Amazon Chime SDK rather than a copy, because a projection inherits its pipeline's lag. That objection is aimed at a copy standing in as the AUTHORITY. Here the authority is the service, which refuses a non-member; the store only decides how the flow spends its time before asking. Tenet D6 is the one being applied: membership changes emit events, and re-reading the roster on every message to notice a rare change is the polling shape it names.

## What this does not change

- **Who answers.** Every routing outcome is the one the flow produces today.
- **The `@` prefilter.** It still gates the more expensive work, and now gates strictly more of it.
- **Privacy enforcement.** Never the flow's. Amazon Chime SDK routes from `Target`.
- **The mention warning.** It survives on the prefilter.

## Consequences and risks

- **A refusal must be classified, or this trades latency for alert noise.** An optimistic route that loses a race and an assistant that was never a member arrive as the same `ForbiddenException`. The precedent is on record: the duel rename at `async-processor-core.ts:3434` was forbidden **by design on every battle turn**, and because the log carried `Exception` the end-to-end guard reported a failed turn. Three in one duel. The expected refusal has to degrade visibly and be counted; the misconfiguration has to stay loud.
- **The silent branch needs a counter.** A stored bit saying group when the room is one-to-one produces no exception at all. It is the only outcome nothing else surfaces.
- **Pagination leaves the common path.** Both facts come from one `GetItem`; a live fallback pages only when the store has no entry.
- **A handed-over routing context becomes trivially bounded** (ADR-041 Appendix N): a bit and a short list of assistant ARNs, bounded by a constant rather than by the size of the room.

## What a revisit would owe

The record is declined, so nothing below is owed. Item 1 is built for ADR-034's own reasons.

1. **The post-delivery route for a real private token with no `Target`**, built before the flow stops resolving names. BUILT (`backend/test/lib/a-private-address-without-a-target-is-routed.test.ts`).
2. **A test that a person mention changes no routing outcome.**
2a. **A test that the writer re-reads rather than applying a delta**, so a dropped event cannot corrupt the entry permanently.
2b. **A test that a membership event for one channel writes only that channel's entry.**
3. **A test that the stored context is keyed per CHANNEL**, so one conversation cannot be routed from another's entry. `the-flow-pays-for-what-it-uses.test.ts` already carries this case for the classification memo ("does not answer one conversation from another conversations memo"); a routing context keyed wrongly is the same defect with a worse blast radius, because it would name the wrong assistants.
4. **A test that a missing entry falls back to the live read** rather than to a guess.
5. **A test that the mention warning still fires** without a roster read.
6. **A classifier for the expected refusal**, with a test that an optimistic miss does not surface as a backend error - the duel-rename shape, caught this time.
7. **A counter for the silent branch**, and a measurement of the stored read against the roster read taken the way ADR-041 Appendix O takes its numbers.
