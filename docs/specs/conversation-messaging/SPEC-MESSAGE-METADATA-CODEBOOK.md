# SPEC: Compact message metadata - a coded codebook + out-of-band lookup

**Status:** Partial (out-of-band lookup and the cap-shedding backstop ship; the coded-state codebook is design)


The `safeMetadataString` cap-shedding backstop and Technique B (out-of-band analytics) are in place; Technique A (coded states) is the codebook-encoding design. The append-only + `cbv` + out-of-band contract governs the encoding. Companion to `docs/guides/developer/MESSAGE-DELIVERY-GUIDE.md` (the size limits this solves); the per-variant experiment thumbs join rides this metadata.

## Summary

Amazon Chime SDK Messaging caps a message's `Metadata` at 1024 **encoded** characters (`encodeURIComponent(s).length`), and that single field is the source of truth for two independent consumers: the frontend (which reads model/intent/feedback and the experiment join keys off each message) and the Aurora archival pipeline (`kinesis-archival.ts`, which reads the same `Metadata` off the Kinesis record to write analytics rows). There is no separate analytics emission. So when a heavy turn overflows the cap, `safeMetadataString` drops the whole blob and BOTH consumers silently lose everything - analytics and the experiment join included.

This spec defines a durable, deployment-extensible encoding that keeps the metadata far under the cap by replacing bounded "state" values with small integer **codes** resolved against a versioned **codebook**, and moving the heavy analytics-only payload **out of band**, looked up by the message's existing id. It is written so an AgentEchelon OSS deployer can replicate the pattern for their own intents, assistant states, and integrations.

## The problem, measured

The fields are encoded JSON, so every quote, brace, and long string id costs. Measured against the live `buildAnalyticsMetadata` output (`backend/lambda/src/lib/analytics-metadata.ts`):

- A normal turn (no experiment) sits comfortably under 1024.
- A premium experiment turn + config-identity fingerprint = 1022 / 1024 - at the cliff.
- The same turn + an active task = 1195 / 1024 - over; the whole blob is dropped.
- Add an attachment reference and it reaches ~1647 / 1024.

CJK makes this far worse: a Chinese character encodes to nine characters, so the effective Metadata budget for Chinese text is ~110 characters (see `docs/guides/developer/MESSAGE-DELIVERY-GUIDE.md`).

The root inefficiency: the blob stores long human-readable strings for values that are drawn from small, known sets. `"assignmentMode":"probabilistic"` is 31 encoded characters to express one of three states; `"bedrockModel":"anthropic.claude-3-5-sonnet-20241022-v2:0"` is ~60 to name one catalog entry; `"intent":"report_generation"` is ~28 to name one of a dozen pack intents.

## Design principles

- **Code the bounded, keep the unbounded literal.** A field whose values come from a finite, known set (a "state") is expressed as an integer code; a field with open values (a UUID, a token count, a content hash, an S3 key) is not.
- **One codebook, versioned, shared.** The emitter and every consumer resolve codes against the same codebook, stamped with a version so a consumer can detect and reject a mismatch instead of mis-decoding.
- **Split by consumer, not by convenience.** Fields the frontend must read synchronously stay inline; analytics-only fields that only the archival pipeline consumes move out of band, keyed by the message id that already exists on both sides.
- **Honest degradation, never silent corruption.** An unknown code decodes to `unknown` (not a crash, not a wrong value); a missing or mismatched codebook falls back to the literal form; an irreducibly large blob still drops as a last resort, with a warning.
- **Deployment-extensible.** Platform enums are fixed; domain enums (intents, models, task types) are derived from the deployment's own configuration, so a fork with different intents or models gets a correct codebook for free.

## Technique A - code the bounded state fields

Each metadata field whose domain is a known set is replaced by a small integer index into that set. The codebook is the ordered list of possible values per field; the code is the position.

### What is codeable (and its source of truth)

| Field | Domain source | Fixed or per-deployment |
|---|---|---|
| `role` | `user` / `assistant` | fixed |
| `userType` / `agentType` (tier) | `basic` / `standard` / `premium` | fixed (extend if you add tiers) |
| `assignmentMode` | `analytics-metadata.ts` `AssignmentMode` (`deterministic` / `probabilistic` / `battle`) | fixed |
| `variantId` | `control` / `treatment` | fixed |
| `deliveryOption` | `delivery-options.ts` `DeliveryOption` enum | fixed |
| `intent` | the deployment's `IntentPack` (`lib/intent-pack.ts`) | **per-deployment** |
| `bedrockModel` | the model catalog (`getModelCatalog`) | **per-deployment** (region/account catalog) |
| `activeTask.type` | the task taxonomy (intent-derived) | **per-deployment** |
| `activeTask.status` | the task lifecycle (`in_progress` / `completed` / …) | fixed |
| `taskState` | the declared-graph machine state after this turn (distinct from `activeTask.status`) | **per-deployment** (the machine graph is pack-configurable) |
| `taskTransition` | the edge this turn applied, `{from,to}` (absent when nothing advanced) | literal / out-of-band |
| `fallbackReason` | the **known** reason set in `bedrock-resilience.ts` (`throttled` / `quota_exceeded` / `model_unavailable` / `model_error` / `access_denied` / `validation_error` / `server_error`) **plus an `other` code** | semi-open - see below |
| `wasFallback`, `continuation` | booleans | already minimal (`0`/`1`) |

`fallbackReason` is **not** strictly bounded: `bedrock-resilience.ts:102` falls through to `message || 'unknown_error'`, a free-form error string. Code the seven known reasons and reserve a final `other` code; the free-form message itself is heavy and analytics-only, so it goes **out of band** (Technique B), never inline. This keeps the inline field one character while preserving the full reason for archival. The same rule applies to any future field that is "mostly enum with an open fallthrough": code the known cases, reserve `other`, push the open tail out of band.

The two biggest wins are `bedrockModel` (a ~45 - 60 char id becomes one or two characters) and `intent` (a ~20 - 28 char key becomes one), because both are drawn from the deployment's own finite config.

### What stays literal

Open-valued fields are not coded: `inputTokens` / `outputTokens` / `latencyMs` / `totalMs` / `pollMs` (unbounded numbers), `configId` / `personaVersion` / `intentPackVersion` / `systemPromptHash` (content-addressed), `targetedSender` (an ARN), `attachment.fileKey` (an S3 key). Most of these are analytics-only and are handled by Technique B.

`experimentId` is a borderline case. It is technically codeable - experiments are a finite, per-deployment domain (rows in the experiments table), so it could be an append-ordered codebook field exactly like `intent`. This spec keeps it **literal inline** anyway: it is the join key the frontend reads synchronously, it is only present on the small fraction of turns served by an experiment, and a UUID is ~38 encoded characters - cheap enough that coding it trades real cross-version stability (a stable UUID survives any `cbv` change) for a marginal byte saving. A deployment running many concurrent experiments on CJK-heavy traffic could revisit and code it; the codebook mechanism already supports it.

### Wire shape

The coded metadata carries a codebook version and the codes. **Value-coding (replacing a string value with an integer) and key-shortening (renaming `assignmentMode` → `mode`) are two independent levers** - value-coding is the normative win this spec requires; key-shortening is an optional extra. The example below keeps semantic key names so the contract stays readable; only the version field is mandatory:

```jsonc
{
  "cbv": 3,             // codebook version — MANDATORY; consumers reject/fallback on mismatch
  "intent": 4,          // index into codebook.intent
  "assignmentMode": 1,  // index into codebook.assignmentMode (1 = battle)
  "variantId": 0,       // index into codebook.variant (0 = control)
  "bedrockModel": 7,    // index into codebook.model
  "deliveryOption": 2,
  "activeTask": { "type": 4, "status": 1 },
  "experimentId": "3f9a2b7c-…"  // literal (small; the inline join key)
}
```

The out-of-band analytics record (Technique B) is **not** referenced by a new field - it is keyed by the message's existing `MessageId`, which both the frontend and the Kinesis record already carry, so no pointer is added to the metadata. Decoding is a table lookup: `codebook.intent[meta.intent]`; an out-of-range index decodes to `unknown` (and the raw code is retained for forensic backfill).

## Technique B - out-of-band heavy analytics, keyed by message id

The bulky analytics-only fields (token counts, latencies, the config-identity fingerprint, intent confidence, fallback detail) are read by exactly one consumer: the archival pipeline. They do not need to ride the messaging metadata at all.

Move them to a dedicated emission keyed by the message's own id (no new id is minted - `MessageId` already exists on the Amazon Chime SDK message and on the Kinesis record). Two viable stores:

- **Direct analytics emission (recommended).** At send time the async processor writes the full analytics record to the analytics pipeline directly (a `PutRecord` to the analytics Kinesis/Firehose, or a `message-analytics` DynamoDB row keyed by `messageId` + `channelArn`). Archival joins by `messageId` instead of parsing the size-capped Amazon Chime SDK `Metadata`. This makes analytics robust against the messaging cap entirely, which the current design is not.
- **Side table looked up on demand.** A DynamoDB `message-analytics` table keyed by `messageId`; archival (and any admin drill-down) reads it by id. Heavier read path; only justified if a consumer needs random access by id.

The frontend never fetches the out-of-band record: everything it renders (model, intent, the experiment join keys, multi-part grouping, targeting, attachment, task status) stays inline via Technique A. No extra round-trip is added to the chat path.

**Security note (a quiet win).** Carried on the Amazon Chime SDK `Metadata`, the heavy analytics fields would be delivered to every channel member - `systemPromptHash`, `configId`, `personaVersion`, token counts, and latencies on the wire to clients that have no use for them (the frontend ignores them, but they would be exposed). Out of band, that minor information exposure is removed: only data the frontend actually renders stays on the message wire. The out-of-band store is **admin-scoped analytics data** and MUST inherit the analytics pipeline's access controls (admin-only read), exactly like the Aurora analytics tables; it is never exposed on a member-readable path. Keying it by `MessageId` is not a capability - the key grants nothing, the record carries no message content, and access is gated by the analytics IAM, not by knowledge of the id.

### The resulting split

| Category | Where it lives | Why |
|---|---|---|
| Delivery/display (`responseGroup`, `continuation`, `part`, `totalParts`, `targetedSender`, `attachment` ref, `activeTask`, battle markers) | inline, coded where bounded | must arrive synchronously with the message |
| Experiment join (`experimentId`, `variantId`, `assignmentMode`) | inline (coded where bounded) | the frontend thumbs vote attributes per-variant live |
| Heavy analytics (tokens, latencies, config fingerprint, confidence, fallback detail) | out of band, keyed by `messageId` | only the archival pipeline reads it; no cap should constrain it |

### Worked example - the heavy turn, before and after

The premium experiment turn that overflows (experiment + config identity + active task + attachment), measured as encoded JSON:

| Variant | Encoded chars | Result |
|---|---|---|
| **Before** (all literal, inline) | ~1195 - 1647 | over 1024 → whole blob dropped, join + analytics lost |
| **After** (analytics out of band; bounded values coded) - with attachment | 911 | fits, join preserved |
| **After** - common case (no attachment) | 579 | fits, comfortable headroom |

The dominant remaining inline costs are the genuinely open values that must stay (the `targetedSender` ARN and the `attachment.fileKey`); the bounded state fields collapse to single digits and the heavy analytics leaves the wire entirely.

## Codebook contract, versioning, and honesty

- **The codebook is generated, not hand-maintained.** It is assembled at deploy time from the fixed platform enums plus the deployment's `IntentPack` and model catalog.
- **One distribution source, both build artifacts.** The frontend (Vite) and backend (CDK) are separate builds, so "shared codebook" must be concrete, not assumed. The generated codebook is published once at deploy as a **CDK output / SSM parameter** - the same contract pattern the per-deployment intent pack already uses (`${SSM_ROOT}/.../assistant-intent-pack`, see `docs/specs/assistant-context/SPEC-CONFIGURABLE-INTENT-PACK.md`). The backend emitter reads it at cold start; the frontend reads it from a CDK output baked into the Vite env (the way it already consumes other stack outputs). Both sides resolve `cbv` against this single deploy-published codebook, never against one derived independently per build.
- **Trust only the deploy-bundled codebook.** A consumer decodes a message's `cbv` against the codebook it received at deploy, NEVER one delivered alongside the message. A forged or tampered `Metadata` therefore cannot remap codes to attacker-chosen values; at worst an unknown `cbv` triggers the literal fallback.
- **`cbv` is mandatory.** Bump it whenever the ordered domain of any coded field changes (adding an intent appends to the list and bumps `cbv`; never reorder existing entries - append only, so old codes keep their meaning).
- **Append-only domains.** Codes are positions; reordering would silently remap historical data. New values append; removed values keep their slot (tombstoned) so archived rows still decode.
- **Unknown code → `unknown`.** A consumer on an older codebook that sees a code past the end of its table decodes to `unknown` and records the raw code for forensic backfill, never a wrong value.
- **Missing/again-mismatched codebook → literal fallback.** If a consumer cannot resolve a codebook for a message's `cbv`, it falls back to reading any literal fields present (the emitter MAY dual-write literals during a migration window - see below).

## Cap-safety and back-compat

- **Cap-shedding backstop.** `safeMetadataString` degrades gracefully: when over budget it sheds low-priority keys (secondary analytics, then bulky/UX-only) while preserving the small join + core fields, instead of dropping the whole blob. A budget guard test (`backend/test/lib/safe-metadata-string.test.ts`) asserts a maximal turn stays within 1024 with the join intact.
- **Out-of-band analytics (Technique B).** The full analytics blob is persisted to a dedicated DynamoDB table (`MessageAnalyticsTable`, PK `messageId`, TTL'd) and archival reads it by id, so analytics no longer rides - or competes for - the 1024 budget.
   - **The table lives in the Aurora stack, not Foundations.** Archival (in the Aurora stack) is the sole consumer, and the producers (per-tier async processors) are created *after* the Aurora stack in `bin/backend.ts`, so the table name/arn pass to the tiers by a direct prop (`MessageAnalyticsWiring`) - no SSM indirection or stack-ordering hack needed. Archival reads its own-stack table (`grantReadData`); each tier processor gets write-only `PutItem`.
   - **Slimming is coupled to the store being available.** `async-processor-core` writes the full blob via `writeMessageAnalytics` (keyed by the placeholder message id, *before* the Amazon Chime SDK update so the row is in place before the message reaches archival) and slims the Metadata via `pickFrontendMetadata` ONLY when `MESSAGE_ANALYTICS_TABLE` is set (Aurora mode). In Athena mode the table is absent, the write is a fail-open no-op, and the Metadata stays full - so Athena, whose `conversations` Glue table aggregates by partition only and never parses these fields, is unaffected.
   - **Archival merges out-of-band over inline.** `kinesis-archival.transformToMessageRecord` reads the row by the raw Amazon Chime SDK `MessageId` for bot messages and merges it over the slim inline metadata (out-of-band wins; a missing row falls back to inline, which still carries the frontend-kept fields). Both reads/writes fail open. The merged blob is stored in Aurora's `messages.metadata` JSONB, so anything in the out-of-band record (including `steps[]`, below) lands in Aurora with no schema change and no cap.
   - **Per-step telemetry (`steps[]`) - tracking each step of the message path.** The self-hosted tool loop (`invokeBedrock`) can make several Converse calls in one turn (generate → tool-use → answer). Each iteration is instrumented as a `ConverseStep` (`makeConverseStep`: model, start/end, per-call tokens, `estCostUsd` honest-null, and `tools?: Array<{name, ok, errorClass}>` - structured per-tool outcome, `errorClass` from a bounded vocabulary (`timeout` / `not_found` / `unauthorized` / `bad_input` / `error`) and never raw text or payloads/PII, so per-tool success/failure is recorded rather than only implied by the free-text `stepLabel`) and the array is persisted **into the out-of-band record only** - never the slim inline Metadata (it would blow the 1024 cap, and only archival/admin consume it). The standard tier's external (Chinese) LLM path synthesizes a single `generate` step for parity. The no-cap store is what makes this per-step path tracking possible. **Surfaced in the admin console** via `StepsTab` (Models section, Aurora-only) backed by `getExecutionSteps` (`/analytics/execution-steps` + the `execution_steps` POST queryType) reading `messages.metadata->'steps'`.
   - Tests: `pick-frontend-metadata.test.ts` (the slim allow-list contract - join keys survive, heavy fields incl. `steps` dropped) + `analytics-metadata.battle.test.ts` (`makeConverseStep` cost wiring) + the `safe-metadata-string.test.ts` budget guard + `StepsTab.test.tsx` (the admin steps view: list → expand → per-step durations + honest-null cost).
- **Coded states (Technique A).** `cbv` and coded fields; consumers decode via the codebook. During a rollout window, the emitter dual-writes the literal forms for the join keys so a stale frontend still works, then removes the literals once clients are on the codebook.

## Test gates

The encoding ships with named, automated gates - it is unsafe without them:

- **Budget guard.** `backend/test/lib/safe-metadata-string.test.ts` asserts a maximal heavy turn stays within 1024 encoded with the experiment join + core analytics preserved, and that an irreducible blob still drops as a last resort. This is the standing "did we just blow the 1k limit?" guard.
- **Append-only invariant.** A test snapshots each coded domain's ordered values per `cbv` and fails if an existing entry is reordered or removed without a `cbv` bump (reordering silently remaps historical data - the one unrecoverable error).
- **Round-trip identity.** For every coded field, `decode(encode(v)) === v` across the full domain.
- **Honest-degradation.** An out-of-range code decodes to `unknown` (not a throw, not a wrong value); an unresolved `cbv` falls back to literal reads. Both asserted explicitly.
- **Budget regression.** The budget guard extends to the coded shape so a future field addition that breaks the cap fails CI rather than silently dropping in production.

## OSS replication recipe (your deployment, your states)

This pattern is the point of publishing it: a fork with different intents, models, or assistant states reuses the mechanism and supplies its own domains.

1. **Enumerate your state fields.** Any per-message field with a finite value set is a codebook candidate - your intents, your model catalog, your task/agent states, your routing modes.
2. **Make each domain an append-only ordered list.** Your `IntentPack` already is one (its `key` order is your intent codebook). Your model catalog keys are another. Add your own for any custom assistant-integration states.
3. **Generate the codebook at deploy and bump `cbv` on any domain change.** Derive it from the same config the assistant runs on, so it can never drift from what the emitter uses.
4. **Decode by table lookup in every consumer**, with `unknown` for out-of-range codes and a literal fallback for an unresolved `cbv`.
5. **Keep open values literal or out of band.** Ids, counts, hashes, free text never get codes; if they are heavy and single-consumer, move them out of band keyed by the message id.
6. **Re-budget for your locale.** If your deployment is non-Latin, remember the ~9x CJK encoding multiplier when sizing what remains inline.

## Non-goals

- This does not change `Content` handling - long replies still go through `handleLongResponse` / attachments (`docs/guides/developer/MESSAGE-DELIVERY-GUIDE.md`).
- It does not introduce per-message client fetches on the chat path; the frontend reads only inline fields.
- It does not compress open values (text/ids/hashes); those are addressed by Technique B (move out of band) or by not carrying them at all.

## Related

- `docs/guides/developer/MESSAGE-DELIVERY-GUIDE.md` - the encoded caps and the helper layer this builds on.
- `docs/specs/assistant-context/SPEC-CONFIGURABLE-INTENT-PACK.md` - the per-deployment intent taxonomy that is already an append-ordered domain (the intent codebook).
- `backend/lambda/src/lib/async-processor-core.ts` - `safeMetadataString`, the cap constants, and the emission point.
- `backend/lambda/src/analytics-aurora/kinesis-archival.ts` - the second consumer that reads the same metadata.
