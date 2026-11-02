# SPEC: Compact message metadata - a coded codebook + out-of-band lookup

**Status:** Partial. The `safeMetadataString` cap-shedding backstop, the out-of-band analytics record (Technique B) and the content declaration (Technique C) are in the tree; the coded-state codebook (Technique A) is specified here and has no implementation.

**Coverage:** `tests/e2e/agent-intents.spec.ts`

**Verified by:** `backend/test/lib/safe-metadata-string.test.ts` (Technique B, the budget guard), `backend/test/lib/a-direct-answer-names-what-it-answered.test.ts` (Technique C, the content declaration), `backend/test/lib/an-assistant-is-assigned-one-classification.test.ts` (the `agentType` / `classification` split - that the assistant's classification is the one ASSIGNED to the assistant, never inferred from the request or the sender ARN, and that either direction of disagreement with the channel is a boundary crossing).

**Related:** [MESSAGE-DELIVERY-GUIDE.md](../../guides/developer/MESSAGE-DELIVERY-GUIDE.md) - the transport caps this works within. [SPEC-AURORA-VPC-MODE.md](../foundations/SPEC-AURORA-VPC-MODE.md) - FR15, the requirement that a turn's out-of-band record is merged over the inline metadata at archival. [SPEC-CONFIGURABLE-INTENT-PACK.md](../interaction/assistants/SPEC-CONFIGURABLE-INTENT-PACK.md) - the per-deployment intent taxonomy that is already an append-ordered domain.

**Site section:** Communication layer.

---

**This document is a reference codebook and encoding contract rather than a spec of a feature, so it carries no requirements table.** The requirement that a turn's out-of-band analytics record is merged over the size-capped inline metadata at archival is FR15 of [SPEC-AURORA-VPC-MODE](../foundations/SPEC-AURORA-VPC-MODE.md); the transport caps it works within are owned by [MESSAGE-DELIVERY-GUIDE](../../guides/developer/MESSAGE-DELIVERY-GUIDE.md); the admin surface that reads the per-step telemetry is owned by [SPEC-ADMIN-CONSOLE-EFFECTIVENESS](../interface/SPEC-ADMIN-CONSOLE-EFFECTIVENESS.md). What lives here is the encoding: which fields are coded against a versioned codebook, which move out of band, which travel in content because they have no other carrier, and what each consumer must do when it cannot resolve one.

## Overview

**One size-capped field feeds two consumers, and which of them a cap failure costs depends on the mode.** Amazon Chime SDK Messaging caps a message's `Metadata` at 1024 *encoded* characters (`encodeURIComponent(s).length`). The frontend reads model, intent, feedback and the experiment join keys off each message from that field, and the archival pipeline reads the same field off the Kinesis record. In the default mode there is no separate analytics emission on the messaging path, so an overflow costs both consumers whatever `safeMetadataString` has to shed, keys in `METADATA_SHED_ORDER` first and the whole blob only as a last resort. In Aurora mode the full record is written out of band (Technique B) and archival merges it over the inline field, so an overflow costs the frontend the shed keys and the analytics nothing.

**The three carriers are chosen by consumer and by exposure, not by convenience.** Fields the frontend renders synchronously stay inline, coded where their domain is bounded. Heavy analytics-only fields leave the wire entirely and are keyed by the message id both sides already hold. Facts a turn declares about itself travel in metadata where the emitter has a metadata field and in content where it does not, because one delivery path answers from a handler return that carries no metadata at all.

**Coding is for bounded state and nothing else.** A field drawn from a finite, known set becomes a small integer index into an ordered codebook; a field with open values - a UUID, a token count, a content hash, an S3 key - stays literal. The inefficiency this removes is real and one-directional: `"assignmentMode":"probabilistic"` spends 31 encoded characters to express one of three states, and `"bedrockModel":"anthropic.claude-3-5-sonnet-20241022-v2:0"` spends roughly 60 to name one catalog entry.

**Degradation is honest at every step, which is the part that makes an encoding safe to depend on.** An unknown code decodes to `unknown` and keeps the raw code; an unresolved codebook version falls back to reading whatever literals are present; an irreducible blob sheds low-priority keys and drops only as a last resort, with a warning. A consumer never guesses a value it could not resolve.

## The problem, measured

The fields are encoded JSON, so every quote, brace and long string id costs. Measured against the live `buildAnalyticsMetadata` output (`backend/lambda/src/lib/analytics-metadata.ts`):

- A normal turn with no experiment sits comfortably under 1024.
- A premium experiment turn plus the config-identity fingerprint reaches 1022 of 1024, at the cliff.
- The same turn plus an active task reaches 1195, over the cap, so `safeMetadataString` sheds keys in `METADATA_SHED_ORDER` until it fits, and drops the blob only if shedding cannot get it under.
- Add an attachment reference and it reaches roughly 1647.

CJK text makes this far worse: a Chinese character encodes to nine characters, so the effective budget for Chinese text is roughly 110 characters (see [MESSAGE-DELIVERY-GUIDE](../../guides/developer/MESSAGE-DELIVERY-GUIDE.md)).

These figures are a point-in-time measurement of `buildAnalyticsMetadata`, not a standing budget. **Re-measure before adding any inline field.** The premium experiment case sits at 1022 of 1024, so one more literal field of any size pushes it over and shedding begins. "There is room for one more small field" is not true here.

## Design principles

- **Code the bounded, keep the unbounded literal.** A field whose values come from a finite, known set is expressed as an integer code; a field with open values is not.
- **One codebook, versioned, shared.** The emitter and every consumer resolve codes against the same codebook, stamped with a version, so a consumer detects and rejects a mismatch instead of mis-decoding.
- **Split by consumer, not by convenience.** Fields the frontend must read synchronously stay inline; analytics-only fields that only the archival pipeline consumes move out of band, keyed by the message id that already exists on both sides.
- **Honest degradation, never silent corruption.** An unknown code decodes to `unknown`; a missing or mismatched codebook falls back to the literal form; an irreducibly large blob drops as a last resort, with a warning.
- **Deployment-extensible.** Platform enums are fixed; domain enums - intents, models, task types - derive from the deployment's own configuration, so a fork with different intents or models gets a correct codebook without writing one.
- **No identity or relation state is trusted from metadata.** Who sent a message is its Amazon Chime SDK sender ARN, never a metadata field.

## Identity and relation state

Metadata is written by whoever sends the message, so on a person's message it is whatever that person chose to send, and channel Metadata is writable by members. Neither is a place to learn who someone is, how two conversations relate, or what a meeting is doing.

- **Identity.** A message's author is its sender ARN, which the Amazon Chime SDK sets and no sender can forge. A field that names a person names their AppInstanceUser ARN, rides only on a message the platform writes, and is a display or delivery hint (for example `targetedSender`, which keys the client's sticky mention), never authority. No field carries an identity provider's subject or issuer, an email address or a phone number. A directive on a person's message reaches only what that person could already reach: the notification bridge ignores the explicit targets on a person-sent message (`backend/lambda/src/lib/channel-notify.ts:286-292`).
- **Relations.** A link between two conversations is a resource tag on a channel naming the other channel ([METADATA-AND-TAGS](../../guides/developer/METADATA-AND-TAGS.md), section 3), never a metadata field.
- **Meeting state.** Which meeting is active on a conversation is the server-side channel-context record keyed by the channel ARN, never a metadata field a member could rewrite.

A platform notice names its email recipients by AppInstanceUser ARN (`notifyTargets: [{ person }]`, built by `notifyDirective` in `backend/lambda/src/lib/notify-directive.ts` and parsed by `parseNotifyDirective` in `backend/lambda/src/lib/channel-notify.ts`). **NOT BUILT:** a conversation's parent is carried in channel Metadata as `parentChannelArn` (`backend/lambda/src/lib/channel-creation.ts`).

## Technique A - code the bounded state fields

Each metadata field whose domain is a known set is replaced by a small integer index into that set. The codebook is the ordered list of possible values per field; the code is the position.

### What is codeable, and its source of truth

| Field | Domain source | Fixed or per-deployment |
|---|---|---|
| `role` | `user` / `assistant` | fixed |
| `agentType` (the assistant that answered) | the deployment's assistant NAMES (`concierge` / `analyst` / `advisor` out of the box) - the `/assistant/{name}` segment, read from the serving Lambda's `PROFILE_NAME`. Never self-determined, never derived from the request | **per-deployment** (an open set: assistants are added and renamed) |
| `classification` (the conversation the turn ran in) | the deployment's classification values (`basic` / `standard` / `premium` out of the box) - a **different subject and a different value set**, see the section below | fixed (extend with your classifications) |
| `assignmentMode` | `AssignmentMode` in `analytics-metadata.ts` (`deterministic` / `probabilistic` / `battle`) | fixed |
| `variantId` | `control` / `treatment` | fixed |
| `deliveryOption` | the `DeliveryOption` enum in `delivery-options.ts` (`DIRECT` / `PLACEHOLDER_UPDATE` / `TASK_UPDATE_IN_PLACE` / `TASK_MULTI_STEP` / `REFUSED`) | fixed |
| `intent` | the deployment's `IntentPack` (`lib/intent-pack.ts`) | **per-deployment** |
| `bedrockModel` | the model catalog (`getModelCatalog`, `backend/lib/config/model-strategy.ts`) | **per-deployment** (region and account catalog) |
| `activeTask.type` | the task taxonomy (intent-derived) | **per-deployment** |
| `activeTask.status` | the task lifecycle (`in_progress` / `completed` / ...) | fixed |
| `taskState` | the declared-graph machine state after this turn (distinct from `activeTask.status`) | **per-deployment** (the machine graph is pack-configurable) |
| `taskTransition` | the edge this turn applied, `{from,to}` (absent when nothing advanced) | literal or out-of-band |
| `fallbackReason` | the **known** reason set in `bedrock-resilience.ts` (`throttled` / `quota_exceeded` / `model_unavailable` / `model_error` / `access_denied` / `validation_error` / `server_error`) plus an `other` code | semi-open, see below |
| `respPhase` | the `ResponsePhase` vocabulary in `analytics-metadata.ts` - seven values: `placeholder` / `interim` / `progress` / `final` / `cancelled` / `error` / `notice`. Never shed: `METADATA_SHED_ORDER` omits it because it decides whether a turn closes at all | fixed |
| `trigger` | the `InteractionKind` set (`lib/interaction-kinds.ts`: `user` / `rebuttal` / `handover` / `repair` / `recovery` / `join_recap` / `welcome` / `event_step` / `task_step` / `name_room` - what KIND of interaction the turn is, declared by its dispatcher). `orchestrator` is a legacy value that is mapped on read and never emitted | fixed |
| `turnKind` | what a message is when it is NOT an answer: `notice` or `battle-notice` (a line the router says as an assistant, `lib/assistant-notice.ts`), and the content-declared kinds `reading` / `drift` / `welcome` / `notification` / `join_recap` / `receipt` / `queue_ack` / `event_step` / `task_step` (`TURN_KINDS`, `lib/turn-declaration.ts`). An ordinary answer declares none | fixed |
| `wasFallback`, `continuation`, `guardrailBlocked` | booleans | already minimal (`0`/`1`) |

`fallbackReason` is **not** strictly bounded: the classifier in `bedrock-resilience.ts` falls through to the raw error message, or `unknown_error`, for anything it does not recognize. Code the seven known reasons and reserve a final `other` code; the free-form message is heavy and analytics-only, so it goes out of band (Technique B) and never inline. That keeps the inline field one character while preserving the full reason for archival. The same rule applies to any field that is mostly enum with an open fallthrough: code the known cases, reserve `other`, push the open tail out of band.

The two biggest wins are `bedrockModel`, where a 45 to 60 character id becomes one or two characters, and `intent`, where a 20 to 28 character key becomes one, because both are drawn from the deployment's own finite configuration.

### `agentType` and `classification` answer different questions, and share no value set

Neither may be decoded with the other's codebook. `agentType` names the ASSISTANT; `classification` names the room.

- **`agentType` is the assistant that answered, by NAME.** It carries the `/assistant/{name}` segment - the same identifier the profile store, the assignment record and the version history are keyed by. The stack stamps it on the serving Lambda as `PROFILE_NAME` and the processor carries it, so there is no runtime resolution and no path by which an assistant reports anything other than what it was given. The set is **open**, because a deployment adds and renames assistants, which is why it is per-deployment above and must not be coded against a fixed domain.

  **An assistant is ASSIGNED exactly one classification.** It never classifies itself and has no say in it. That classification is configuration, resolved from the name (`profileRegistry.classificationFor`), and it is not carried on the message: one fact, one place (tenet D7).

  **A consumer comparing this field to a classification must resolve it first.** A direct string comparison reports a boundary crossing on every assistant turn, and a control that fires always is a silent one.

- **`classification` is the conversation's classification.** The router reads it from the channel's immutable `classification` tag and the turn carries it. It is the one classification the turn runs at. There is no per-person value to prefer over it: a person's credential cannot reach a channel whose classification their grants do not include, so a person in the room always reaches the room's classification.

- **`userClearance` is what the caller was cleared for** when the turn ran. A person may hold several classifications, and that set need not nest, so what they hold is named by a single token whose `grants` expand to the set. A person whose grants include more than the room's classification holds more than the room is classified at, so this value and `classification` legitimately differ.

The only relation between the assistant's classification and the others is a constraint - a person must never reach an assistant whose classification they do not reach - and that is an access rule IAM enforces before the turn runs, not an identity any field may borrow from another.

**An exchange is between parties that match.** An assistant has one classification, a channel has one, and a participant who does not reach the channel's classification should never have been admitted to it. The two agreeing is the normal case and the only correct one: a disagreement in **either** direction is an admission failure rather than a downgrade working as intended. The comparison runs on the assistant's classification **resolved from its name**, never on the name itself.

**There is no per-person cap on the serving classification.** One conversation is served at one classification and IAM decides it: the channel-scoped allow is applied to the Cognito user roles as well as the assistant roles and is fail-closed, so a message arriving at the router is itself proof that IAM permitted this person to act on this channel. The router takes the channel's classification directly. A cap in application code decides nothing IAM has not already decided, and on a transient Cognito fault it can answer with a fail-closed refusal that reads as policy - routing a premium room's turn to the basic assistant and presenting an outage as a decision.

**Emit `agentType` from the assistant, never from the request.** The value that looks usable is the turn's `classification`, which is a fact about the room rather than about the assistant, and writing it here files it as the assistant's identity.

**`userClearance` and the sender's role are different axes, and only one of them can be declared late.** A caller's clearance **moves**: a clearance change rewrites their groups and re-stamps the `classification` tag on their identity, so it can only be recorded by a producer that was present when the turn ran, which is what `user_clearance` is for. What **kind** of principal sent the turn does not move - a person, an administrator acting on the admin plane, a federated sender, an assistant - and that is legible in the sender ARN itself, so archival resolves it when it writes the row.

That difference matters because **a person's message carries no metadata at all.** The platform attaches metadata to messages it writes; a message a person sends arrives from Amazon Chime SDK with none. So every producer-declared field on that row is absent, and a classification for the sender cannot be recovered from it. The role can: it is recorded as `user_role` (`user`, `admin`, `federated`, `bot`, or `unknown` for an ARN the shared definition cannot place) from one shared definition the membership audit uses for the same question.

**Do not repair a missing `userClearance` from the room.** Falling back to the conversation or to the answering assistant makes it a copy of `classification` or `agentType`: the field then states what the room was, stops describing the sender, and reads as fully populated while answering nothing. An absent value that admits it is worth more than a present one that misleads.

**`classification` rides the turn, and the archive records it as `conversation_classification`.** The `channel_classification` table also holds a channel's classification, but it is the isolation projection for retrieval - written by a live drift check or a backfill, so most channels have no row - and an access input, so an analytics value derived from message metadata never writes it. The archive's `user_type` column is deprecated and not written: on older exchange rows it mixes the conversation's classification, the sender's clearance and `unknown` with nothing to tell them apart. In Athena mode the S3 partition keeps the name `user_type` because it is the storage layout, and it is filled from `classification`.

**Absent is not `unknown`.** An out-of-range *code* decodes to `unknown`. An **absent key** means the producer declared nothing. Consumers keep those apart: one is a value that could not be read, the other is a message that never had one. Defaulting an absent key to a classification is the same guess this section removes.

**A notice names its assistant and says it is a notice.** Every line a service needs said (Battle Mode on or off, a join line, an archived conversation, a duel side that did not finish) is said by the router as the assistant it concerns, so it declares `agentType`, `assistantRole`, `classification` and `turnKind` (`notice`, or `battle-notice` for a duel's own lines). It declares no `profileVersion`, because no profile version produced it. Readers tell a notice from an answer by `turnKind`, never by an absent `agentType`: archival records it in `turn_kind`, no pairing path makes an exchange of it, and it carries no correlation marker, `total_ms` or `battleId`, so it is outside the assistant-turn population and is filed under no duel.

**A notice's variables are declared, typed and capped per kind** (`NOTICE_VARIABLES`, `NOTICE_VARS`, `checkNoticeVars` in `lib/notice-copy.ts` and `lib/assistant-notice.ts`), each as a binding in ADR-060's grammar (`value:<type>`, or the variable source it carries, such as `person:displayName`), and markers (`<!--...-->`) are stripped from every value. A person's display name in a notice the room reads (`memberJoined`, `conversationArchived`) is declared a mention and renders inert: no `@` handle, link or marker syntax, at most 64 characters. The types and their caps in characters are `text` 300, `longText` 2000, `arn` 400 (an Amazon Chime SDK ARN) and `id` 200 (`MESSAGE_VALUE_CAPS`, `lib/message-template.ts`). Text over its cap is shortened, because a shortened sentence still reads. An `arn` or `id` over its cap refuses the notice, because a shortened reference is a broken one; the refusal is logged with the kind, the variable name and the length, never the value. No notice takes a URL, so a service has no way to put a link of its choosing in an assistant's mouth.

### Turn shapes in analytics

| Shape | Declares | Archival records |
|---|---|---|
| An answer | `agentType`, `assistantRole`, `classification`, `profileVersion`, `profileConfigId`, `intent`, `bedrockModel` and the latency fields | one exchange per answered message |
| A notice | `agentType`, `assistantRole`, `classification`, `turnKind: notice` or `battle-notice` | the message, attributed; no exchange, no duel |
| A join recap (a person was added and the room's primary catches them up, privately) | an answer's fields plus `trigger: join_recap` | the turn and its compute, with `turn_kind = join_recap`, since it answers no message (`answersNoMessage`); no exchange, and no time to first feedback since nobody waited |
| A duel side | an answer's fields plus `experimentId`, `variantId` (`control` or `treatment`), `assignmentMode: battle`, `battleId`, `battleRound` | the side's exchange under its experiment, variant and duel; `profileVersion` is the side's pinned version |

A duel side's attribution comes from what it declares, never from which AppInstanceBot posted it: no reader keys on a sender ARN, so the alt's own AppInstanceBot and the retired battle-stack AppInstanceBots (`AltSlot*`) file under the same assistant and variant. No variant field rides a duel turn (a side serves its pinned version), and the scorecard's `A` and `B` columns are ordered by `variantId`, so a pick of `A` credits the control and `B` the treatment.

### What stays literal

Open-valued fields are not coded:

- `inputTokens`, `outputTokens`, `latencyMs`, `totalMs`, `pollMs`, `modelMs`, `toolMs`, `processorEntryMs`, `triggerAtMs` - unbounded numbers. The last four are the latency split, the server-clock processor-entry stamp for the end-to-end, model, tool and inbound metrics, and the cause instant `ack_ms` is taken from (see [LATENCY-TARGETS.md](../../guides/developer/LATENCY-TARGETS.md)). `modelMs`, `toolMs` and `processorEntryMs` never ride inline: they are written to the out-of-band record only.
- `imageCount` - an unbounded number: how many images a generation-out turn produced, the basis for per-image cost.
- `configId`, `personaVersion`, `intentPackVersion`, `systemPromptHash` - content-addressed.
- `profileName`, `profileConfigId`, `profileVersion` - portable-profile attribution, the exact assistant profile and version that served the turn. `profileName` names the DEFINITION that served; `agentType` names the ASSISTANT that answered. They are the same string on every ordinary turn and on both sides of a duel (each side serves a pinned version of its own assistant), and come apart on a cross-assistant `profileRef` experiment variant, which serves a version of another assistant's profile. That is the case worth being able to see, so neither substitutes for the other and the three attribution fields always describe one artifact.
- `targetedSender` - an ARN. `attachment.fileKey` - an S3 key.

Most of these are analytics-only and are handled by Technique B.

`experimentId` is a borderline case. It is technically codeable, since experiments are a finite per-deployment domain, so it could be an append-ordered codebook field exactly like `intent`. It stays **literal inline** anyway: it is the join key the frontend reads synchronously, it is present only on the small fraction of turns served by an experiment, and a UUID is roughly 38 encoded characters - cheap enough that coding it trades real cross-version stability (a stable UUID survives any `cbv` change) for a marginal saving. A deployment running many concurrent experiments on CJK-heavy traffic could revisit it; the codebook mechanism supports it.

### Wire shape

The coded metadata carries a codebook version and the codes. **Value-coding (replacing a string value with an integer) and key-shortening (renaming `assignmentMode` to `mode`) are two independent levers.** Value-coding is the normative win this document requires; key-shortening is an optional extra. The example keeps semantic key names so the contract stays readable; only the version field is mandatory:

```jsonc
{
  "cbv": 3,             // codebook version - MANDATORY; consumers reject/fallback on mismatch
  "intent": 4,          // index into codebook.intent
  "assignmentMode": 1,  // index into codebook.assignmentMode (1 = battle)
  "variantId": 0,       // index into codebook.variant (0 = control)
  "bedrockModel": 7,    // index into codebook.model
  "deliveryOption": 2,
  "activeTask": { "type": 4, "status": 1 },
  "experimentId": "3f9a2b7c-…"  // literal (small; the inline join key)
}
```

The out-of-band analytics record is **not** referenced by a new field. It is keyed by the message's existing `MessageId`, which both the frontend and the Kinesis record already carry, so no pointer is added to the metadata. Decoding is a table lookup, `codebook.intent[meta.intent]`, and an out-of-range index decodes to `unknown` with the raw code retained for forensic backfill.

## Technique B - out-of-band heavy analytics, keyed by message id

The bulky analytics-only fields - token counts, latencies, the config-identity fingerprint, intent confidence, fallback detail - are read by exactly one consumer: the archival pipeline. They do not need to ride the messaging metadata at all.

They move to a dedicated emission keyed by the message's own id. No new id is minted: `MessageId` already exists on the Amazon Chime SDK message and on the Kinesis record. The store is a side table: `MessageAnalyticsTable`, a DynamoDB table keyed by `messageId` with a seven-day TTL, written by the async processor before the message update and read by archival by id, which joins it over the size-capped `Metadata` rather than parsing the capped field alone. A direct emission into the analytics pipeline was the alternative, and the side table was chosen because archival is the one consumer and already runs per message, so a read by id at archival time costs one lookup and needs no second pipeline. The mechanics are under Cap-safety and back-compatibility below.

The frontend never fetches the out-of-band record: everything it renders - model, intent, the experiment join keys, multi-part grouping, targeting, attachment, task status - stays inline via Technique A, so no round-trip is added to the chat path.

**Security note.** Carried on the Amazon Chime SDK `Metadata`, the heavy analytics fields are delivered to every channel member: `systemPromptHash`, `configId`, `personaVersion`, token counts and latencies on the wire to clients that have no use for them. Out of band, that exposure is removed and only data the frontend renders stays on the message wire. The out-of-band store is **admin-scoped analytics data** and MUST inherit the analytics pipeline's access controls (admin-only read), exactly like the Aurora analytics tables; it is never exposed on a member-readable path. Keying it by `MessageId` is not a capability: the key grants nothing, the record carries no message content, and access is gated by the analytics IAM rather than by knowledge of the id.

## Technique C - the content declaration, for a turn that has no metadata at all

Both techniques above assume the emitter can write message `Metadata`. One delivery path cannot.

A `DIRECT` turn is answered from the fulfillment handler's Amazon Lex return, and Amazon Chime SDK materializes the channel message from that return. An Amazon Lex fulfillment response carries messages and session attributes; it carries no message metadata. So for that turn the cap is not the constraint, the absence of the field is: no coded blob and no out-of-band key can be attached to a message the emitter never sends.

The carrier of last resort is the message's own content. `lib/turn-declaration.ts` defines one marker for it, stripped from everything a human or a judge reads by the same rule that hides `<!--corr:-->`:

```
Hey, what can I help you with? <!--corr:{id}--><!--turn:answers={MessageId};delivery=DIRECT;phase=final;entry=lex-->
```

| Key | Domain | What it states |
|---|---|---|
| `answers` | an Amazon Chime SDK `MessageId` | the message this turn answers |
| `delivery` | the `DeliveryOption` set | the delivery this turn took |
| `kind` | `reading`, `drift`, `welcome`, `notification`, `join_recap`, `receipt`, `queue_ack`, `event_step`, `task_step`, or absent | what kind of turn this is; absent means an ordinary answer |
| `phase` | the `respPhase` vocabulary | the response phase this message is. `final` says the message is the whole answer |
| `entry` | `lex`, `flow` or `platform` | how this turn entered, which under `StandardMessages: NONE` is also whether the message was targeted. `platform` is a turn no message entered (a rebuttal, a welcome, an event step, a task taken up) |

**One marker with keys, not a marker per fact.** The five travel together and arrive from one decision. Separate markers would be separate patterns, separate strippers to keep in step, and a standing chance that a reader knows about four of them.

**The kind set is closed, and a kind absent from it is dropped by the parser.** A dropped kind falls into the answer bucket, which means "declared nothing" rather than "is an answer", and a console reads it as the latter. `reading` is queue work, which answers a burst rather than a message. `drift` is a suggestion about where the conversation is going: it responds to a message and deliberately does not do the work, so it names its target and stays out of the population that measures answers. `welcome` fires on the assistant's membership at channel creation, so it answers nothing and pairing it would report a reply time measured from nothing. `notification` is a message the platform sent that nobody asked for - a task assignment, a reminder - and it is listed here so the content carrier accepts the value the metadata carrier already declares. `join_recap` is the room's primary catching up a person who was just added, so it answers no message. `receipt` is a placeholder closed out as a pointer to where the answer went, and `queue_ack` a placeholder that became a queue notice; neither answers anything itself, and the message the answer moved to pairs through its own `answersMessageId`. `event_step` is an event workflow's `agent` step (ADR-061) and `task_step` an idle assistant taking up a task assigned to it (ADR-063); nobody's message started either, so both pair with nothing.

**`entry` is here because it had no carrier of last resort and `delivery` did.** The entry rides the analytics metadata, and on one path that metadata never exists: a `DIRECT` answer materialized from an Amazon Lex fulfillment carries no message metadata at all. On the slimmed Aurora path it survives, because the processor re-adds `entry` after `pickFrontendMetadata` runs, so the content carrier covers only the Lex return. It is knowable at the moment the declaration is written, so nothing has to be inferred to fill it.

**Scope, stated so this does not grow into a third general-purpose channel.** Technique C carries facts a downstream consumer needs in order to join or classify the turn, for a turn that cannot use metadata. Anything the frontend renders belongs inline (Technique A) and anything heavy belongs out of band (Technique B). Content is the most exposed of the three carriers: it is member-readable, it passes through a guardrail and a channel flow that may both rewrite it, and it is charged against the 4KB message limit rather than the 1024-character metadata cap.

**A content declaration is not trusted the way a metadata one is.** Metadata wins wherever both exist, for exactly that reason. Three properties keep a forged declaration inert:

- **Bounded and character-classed**, the same as `<!--corr:-->`, so no crafted marker smuggles a key. A value that cannot survive the reader's own pattern is dropped rather than truncated, because a truncated message id pairs the answer with nothing while looking exactly like a declaration that worked. The bound is also a storage fact: `messages.turn_entry` is narrower than a declarable value, and archival inserts inside a transaction, so a crafted over-long value would abort the whole batch.
- **Composed once, last.** `withTurnDeclaration` removes any declaration already present before appending its own, and a reader takes the last, so model-composed prose cannot bring one along. A leaked marker is masked at the guardrail boundary alongside the other internal markers.
- **Read from bot messages only.** A declaration is a statement a turn makes about its own answer. Read off a person's message it would let anyone who can type assert who answered what.

**The declared facts are folded once, at archival**, into `messages.answers_message_id`, `messages.turn_kind`, `messages.delivery_option` and `messages.turn_entry`, so no downstream reader parses content to learn them. Adding a marker to a class of message that did not carry one is a change to every reader of that contract: four readers - the model's history loader, the evaluation runner, the client's latency clock and the turn ledger - treated a `<!--corr:-->` marker alone as proof of a placeholder, and each now asks for the declared `phase` first.

### The resulting split

| Category | Where it lives | Why |
|---|---|---|
| Delivery and display (`responseGroup`, `continuation`, `part`, `totalParts`, `targetedSender`, `attachment` ref, `activeTask`, battle markers) | inline, coded where bounded | must arrive synchronously with the message |
| Experiment join (`experimentId`, `variantId`, `assignmentMode`) | inline, coded where bounded | the frontend attributes a thumbs vote per variant, live |
| Heavy analytics (tokens, latencies, config fingerprint, confidence, fallback detail) | out of band, keyed by `messageId` | only the archival pipeline reads it, and no cap should constrain it |
| What the turn declares about itself (`answers`, `delivery`, `kind`, `phase`, `entry`) | metadata where the emitter has it, content otherwise | a handler-answered turn has no metadata field to write, and the pairing must not fall back to adjacency |

### Worked example - the heavy turn, before and after

The premium experiment turn that overflows (experiment, config identity, active task, attachment), measured as encoded JSON:

| Variant | Encoded chars | Result |
|---|---|---|
| All literal, inline | roughly 1195 to 1647 | over 1024, so the whole blob drops and the join and analytics are lost |
| Analytics out of band and bounded values coded, with attachment | 911 | fits, join preserved |
| The same, common case with no attachment | 579 | fits, comfortable headroom |

The dominant remaining inline costs are the genuinely open values that must stay - the `targetedSender` ARN and the `attachment.fileKey` - while the bounded state fields collapse to single digits and the heavy analytics leaves the wire entirely.

## Codebook contract, versioning, and honesty

- **The codebook is generated, not hand-maintained.** It is assembled at deploy time from the fixed platform enums plus the deployment's `IntentPack` and model catalog.
- **One distribution source, both build artifacts.** The frontend (Vite) and the backend (CDK) are separate builds, so "shared codebook" has to be concrete rather than assumed. The generated codebook is published once at deploy as a CDK output or SSM parameter, the same contract pattern the per-deployment intent pack already uses (`${SSM_ROOT}/assistant/{classification}/assistant-intent-pack`, see [SPEC-CONFIGURABLE-INTENT-PACK](../interaction/assistants/SPEC-CONFIGURABLE-INTENT-PACK.md)). The backend emitter reads it at cold start; the frontend reads it from a CDK output baked into the Vite environment, the way it already consumes other stack outputs. Both sides resolve `cbv` against that single deploy-published codebook, never against one derived independently per build.
- **Trust only the deploy-bundled codebook.** A consumer decodes a message's `cbv` against the codebook it received at deploy, never one delivered alongside the message. A forged or tampered `Metadata` therefore cannot remap codes to attacker-chosen values; at worst an unknown `cbv` triggers the literal fallback.
- **`cbv` is mandatory.** Bump it whenever the ordered domain of any coded field changes. Adding an intent appends to the list and bumps `cbv`; existing entries are never reordered.
- **Append-only domains.** Codes are positions, so reordering silently remaps historical data. New values append; removed values keep their position, tombstoned, so archived rows still decode.
- **An unknown code decodes to `unknown`.** A consumer on an older codebook that sees a code past the end of its table decodes to `unknown` and records the raw code for forensic backfill, never a wrong value.
- **A missing or mismatched codebook falls back to literals.** If a consumer cannot resolve a codebook for a message's `cbv`, it reads any literal fields present. The emitter MAY dual-write literals during a migration window.

## Cap-safety and back-compatibility

- **Cap-shedding backstop.** `safeMetadataString` (`backend/lambda/src/lib/async-processor-core.ts`) degrades gracefully: over budget it sheds low-priority keys in `METADATA_SHED_ORDER` - secondary analytics first, then bulky display-only fields - while preserving the small join and core fields, instead of dropping the whole blob. A budget guard test asserts a maximal turn stays within 1024 with the join intact.
- **Out-of-band analytics.** The full analytics blob is persisted to a dedicated DynamoDB table (`MessageAnalyticsTable`, partition key `messageId`, TTL'd) and archival reads it by id, so analytics neither rides nor competes for the 1024 budget.
  - **The table lives in the Aurora stack rather than in Foundations.** Archival, in the Aurora stack, is the sole consumer, and the producers (the per-classification async processors) are created after the Aurora stack, so the table name and ARN pass to them by a direct prop (`MessageAnalyticsWiring`) with no SSM indirection or stack-ordering hack. Archival reads its own-stack table; each processor gets write-only access.
  - **Slimming is coupled to the store being available.** `async-processor-core` writes the full blob via `writeMessageAnalytics`, keyed by the id of the message the answer lands in - the placeholder on an ordinary turn, the new public message on a broadcast resume, the question message on a clarification - and *before* the Amazon Chime SDK update so the row is in place before the message reaches archival, and slims the `Metadata` via `pickFrontendMetadata` only when `MESSAGE_ANALYTICS_TABLE` is set, which is Aurora mode. In the default mode the table is absent, the write is a fail-open no-op, and the `Metadata` stays full - so Athena, whose `conversations` Glue table aggregates by partition and never parses these fields, is unaffected.
  - **Archival merges out-of-band over inline.** `kinesis-archival.transformToMessageRecord` reads the row by the raw `MessageId` for bot messages and merges it over the slim inline metadata: out-of-band wins, and a missing row falls back to inline, which still carries the frontend-kept fields. Both reads and writes fail open. The merged blob is stored in Aurora's `messages.metadata` JSONB, so anything in the out-of-band record lands in Aurora with no schema change and no cap.
  - **Per-step telemetry (`steps[]`).** The self-hosted tool loop can make several Converse calls in one turn. Each iteration is instrumented as a `ConverseStep` (`makeConverseStep`: a `stepLabel` of `generate` or `tool-propose:<name>` for the tool the model proposed, model, start and end, per-call tokens, `estCostUsd` honest-null, and `tools?: Array<{name, ok, errorClass, refusal?}>` - structured per-tool outcome, with `errorClass` drawn from a bounded vocabulary (`timeout` / `not_found` / `unauthorized` / `bad_input` / `error` / `workflow_refusal`, the last a move the task workflow refused by a declared rule, with the platform's refusal code in `refusal` and excluded from the tool-error rate) and never raw text, payloads or personal data, so per-tool success and failure is recorded rather than implied by a free-text label). The array is persisted **into the out-of-band record only** and never the slim inline `Metadata`: it would exceed the 1024 cap, and only archival and the admin console consume it. The standard classification's external model path synthesizes a single `generate` step for parity. The admin console surfaces it in the Effectiveness tab's turn-timeline drill, backed by `getExecutionSteps` (the `execution_steps` query type) reading `messages.metadata->'steps'`.
  - Tests: `pick-frontend-metadata.test.ts` (the slim allow-list contract: join keys survive, heavy fields including `steps` are dropped), `analytics-metadata.battle.test.ts` (`makeConverseStep` cost wiring), the `safe-metadata-string.test.ts` budget guard, and `EffectivenessTab.test.tsx` (the admin steps view: turn timeline, expand, per-step durations and honest-null cost).
- **Coded states.** `cbv` and coded fields; consumers decode via the codebook. During a rollout window the emitter dual-writes the literal forms for the join keys so a client on the old contract still works, then removes the literals once clients are on the codebook.

## Test gates

The encoding is unsafe without named, automated gates.

**Gates that exist, by file:**

- **Budget guard.** `backend/test/lib/safe-metadata-string.test.ts` asserts a maximal heavy turn stays within 1024 encoded characters with the experiment join and core analytics preserved, and that an irreducible blob still drops as a last resort. This is the standing guard against exceeding the cap.
- **Content declarations round-trip and cannot be forged.** `backend/test/lib/a-direct-answer-names-what-it-answered.test.ts` asserts that every declared fact survives the round trip, that a value the reader cannot parse is dropped rather than truncated, that a kind outside the closed set is refused, that a declaration arriving inside composed text is removed before a new one is appended, and that none of it is ever visible to a human.
- **A marked message is not assumed to be a placeholder.** The same file asserts that each reader of the correlation marker consults the declared `phase` first, so a handler-answered turn stays in the model's history, is scored by the evaluation runner, stops the client's clock, and closes its own response in the ledger.
- **The assistant's classification is assigned, not inferred.** `backend/test/lib/an-assistant-is-assigned-one-classification.test.ts`.
- **The slim allow-list contract.** `backend/test/lib/pick-frontend-metadata.test.ts`.

**Gates the coded encoding requires before it can be relied on:**

- **Append-only invariant.** A snapshot of each coded domain's ordered values per `cbv`, failing if an existing entry is reordered or removed without a `cbv` bump. Reordering silently remaps historical data, which is the one unrecoverable error.
- **Round-trip identity.** For every coded field, `decode(encode(v)) === v` across the full domain.
- **Honest degradation.** An out-of-range code decodes to `unknown` rather than throwing or returning a wrong value, and an unresolved `cbv` falls back to literal reads. Both asserted explicitly.
- **Budget regression on the coded shape**, so a future field addition that breaks the cap fails CI rather than silently dropping in production.

## OSS replication recipe

This pattern is the point of publishing it: a fork with different intents, models or assistant states reuses the mechanism and supplies its own domains.

1. **Enumerate your state fields.** Any per-message field with a finite value set is a codebook candidate: your intents, your model catalog, your task and assistant states, your routing modes.
2. **Make each domain an append-only ordered list.** Your `IntentPack` already is one, and its `key` order is your intent codebook. Your model catalog keys are another. Add your own for any custom assistant-integration states.
3. **Generate the codebook at deploy and bump `cbv` on any domain change.** Derive it from the same configuration the assistant runs on, so it cannot drift from what the emitter uses.
4. **Decode by table lookup in every consumer**, with `unknown` for out-of-range codes and a literal fallback for an unresolved `cbv`.
5. **Keep open values literal or out of band.** Ids, counts, hashes and free text never get codes; if they are heavy and single-consumer, move them out of band keyed by the message id.
6. **Check whether every one of your delivery paths can write metadata at all.** A path that answers from the handler return rather than through your own send has no metadata field, and no amount of budget work reaches it. Technique C is the answer for those, and its scope is deliberately narrow: the facts a downstream consumer needs in order to join or classify the turn, never anything a person reads.
7. **Re-budget for your locale.** For a non-Latin deployment, remember the roughly ninefold CJK encoding multiplier when sizing what remains inline.

## Non-goals

- It does not change `Content` handling: long replies go through `handleLongResponse` and attachments (see [MESSAGE-DELIVERY-GUIDE](../../guides/developer/MESSAGE-DELIVERY-GUIDE.md)).
- It does not introduce per-message client fetches on the chat path; the frontend reads only inline fields.
- It does not compress open values such as text, ids and hashes; those are addressed by moving them out of band, or by not carrying them at all.

## Related Documents

- [MESSAGE-DELIVERY-GUIDE.md](../../guides/developer/MESSAGE-DELIVERY-GUIDE.md) - the encoded caps and the helper layer this builds on
- [SPEC-AURORA-VPC-MODE.md](../foundations/SPEC-AURORA-VPC-MODE.md) - FR15, the requirement that the out-of-band record is merged over the inline metadata at archival, and the projection the merged blob lands in
- [SPEC-CONFIGURABLE-INTENT-PACK.md](../interaction/assistants/SPEC-CONFIGURABLE-INTENT-PACK.md) - the per-deployment intent taxonomy that is already an append-ordered domain, and the SSM contract pattern the codebook would follow
- [SPEC-ADMIN-CONSOLE-EFFECTIVENESS.md](../interface/SPEC-ADMIN-CONSOLE-EFFECTIVENESS.md) - the turn-timeline drill that reads the per-step telemetry
- [LATENCY-TARGETS.md](../../guides/developer/LATENCY-TARGETS.md) - what the latency split fields are measured against
- [TENETS.md](../../overview/TENETS.md) - tenet D7 for one fact in one place, and tenet D11 for why a bounded, platform-written marker is pattern work rather than a language judgment
- `backend/lambda/src/lib/analytics-metadata.ts` - `buildAnalyticsMetadata`, `pickFrontendMetadata`, and the vocabularies above
- `backend/lambda/src/lib/async-processor-core.ts` - `safeMetadataString`, `METADATA_SHED_ORDER`, and the emission point
- `backend/lambda/src/lib/turn-declaration.ts` - the content declaration, its closed sets and its reader
- `backend/lambda/src/analytics-aurora/kinesis-archival.ts` - the second consumer, which merges the out-of-band record over the inline metadata
