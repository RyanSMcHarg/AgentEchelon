# ADR-016: Compact message-metadata encoding (coded states + out-of-band analytics)

> **Status:** Accepted, partially implemented (governs `docs/specs/interaction/conversation/SPEC-MESSAGE-METADATA-CODEBOOK.md`). Phase 0 (graceful-shedding backstop + budget guard) and **Phase 1 (Technique B - out-of-band analytics keyed by message id)** are shipped; Technique A (coded state values) is designed, not yet built.

## Context

An operator running AE depends on its analytics and A/B experiment results being complete and trustworthy - and the cruelest failure is losing exactly the *richest* turns (an experiment turn carrying an active task and an attachment) while the dashboard shows no gap. Keeping that measurement whole, so an admin can trust what the console tells them, is the user problem here. The pressure comes from a hard limit: Amazon Chime SDK caps a message's `Metadata` at 1024 **encoded** characters, and that one field is the single source of truth for two independent consumers - the frontend (reads model/intent/feedback + the experiment join keys off each message) and the Aurora archival pipeline (`backend/lambda/src/analytics-aurora/kinesis-archival.ts` reads the same `Metadata` off the Kinesis record). There is no separate analytics emission (verified: no `PutRecord`/Firehose in `async-processor-core.ts`).

So when a heavy turn overflows the cap, `safeMetadataString` drops the whole blob and BOTH consumers silently lose everything - analytics and the experiment thumbs-join included. Measured: a premium experiment turn + config identity sits at 1022/1024; add an active task → 1195 (dropped); add an attachment → ~1647. The inefficiency is storing long human-readable strings for values drawn from small, known sets (`assignmentMode`, `intent`, `bedrockModel`, `deliveryOption`, …).

## Decision

Adopt two complementary techniques, governed by an append-only codebook contract:

1. **Code the bounded state fields.** Any field whose domain is a finite, known set is emitted as an integer index into a versioned **codebook**; only genuinely open values (UUIDs, token counts, hashes, ARNs, S3 keys) stay literal.
2. **Move heavy analytics out of band, keyed by the existing `MessageId`.** The bulky analytics-only fields (tokens, latencies, config-identity fingerprint, intent confidence, free-form fallback message, **and per-step telemetry `steps[]`**) have exactly one consumer (archival) and leave the messaging metadata entirely; archival joins them by the message id that already exists on both sides. No new id is minted. The no-cap store is also what makes `steps[]` persistable at all - one record per Converse iteration of the self-hosted tool loop, which never fit the 1024 Amazon Chime SDK Metadata budget (the original "steps[] is a Phase-2 concern" deferral).

Contract rules:

- **`cbv` (codebook version) is mandatory** and stamped on every coded message.
- **Domains are append-only.** Codes are positions; new values append, removed values are tombstoned. Reordering is forbidden (it silently remaps historical data) and guarded by a test.
- **One distribution source.** The codebook is generated at deploy from the fixed platform enums + the deployment's `IntentPack` + model catalog, and published once as a CDK output / SSM parameter (the intent-pack contract pattern). Both build artifacts resolve `cbv` against that single source, and trust only the deploy-bundled codebook - never one delivered alongside a message.
- **Honest degradation.** Unknown code → `unknown` (raw code retained); unresolved `cbv` → literal fallback; irreducible blob → drop as a last resort, with a warning.

## Consequences

- **The join and analytics stop silently disappearing on heavy turns.** Moving analytics out of band makes it independent of the messaging cap; coding the inline remainder gives wide headroom (a worst-case turn drops from ~1195 to ~911 encoded, the common case to ~579).
- **Less on the client wire (a security improvement).** Config-identity hashes, token counts, and latencies stop being delivered to every channel member; only fields the frontend renders stay inline. The out-of-band store inherits analytics IAM (admin-only).
- **Deployment-extensible.** Forks supply their own domains (their intents, models, assistant states) and get a correct codebook for free; the recipe is published in the spec for OSS replication.
- **Migration cost.** A `cbv`/codebook must ship to both builds and a dual-write window is needed for the join keys; staged in the spec (Phase 0 backstop → Phase 1 out-of-band → Phase 2 coded → Phase 3 guide correction).

## Alternatives considered

1. **Drop-the-whole-blob (status quo).** Rejected - silently loses analytics + the join exactly when the turn is richest; the bug this ADR exists to fix.
2. **Graceful field-shedding only** (the shipped Phase-0 backstop, kept). A good safety net, but it still *loses* the shed fields for archival; insufficient as the end state because the data is merely prioritized, not preserved.
3. **One id → fetch everything by lookup.** Rejected for the frontend path - delivery/display fields (`responseGroup`/`part`/`continuation`/targeting) must arrive synchronously with the message; an async fetch race would break multi-part rendering, and it adds a round-trip per bot message. Out-of-band lookup is right only for the analytics-only tail (Technique B).
4. **Compress the JSON (gzip/base64) in Metadata.** Rejected - base64 re-inflates under `encodeURIComponent`, defeating the purpose, and it makes the field opaque to the archival parser.

## Related

- `docs/specs/interaction/conversation/SPEC-MESSAGE-METADATA-CODEBOOK.md` - the full design + OSS replication recipe.
- `docs/guides/developer/MESSAGE-DELIVERY-GUIDE.md` - the encoded caps this works within.
- `docs/specs/interaction/assistant-config/SPEC-CONFIGURABLE-INTENT-PACK.md` - the per-deployment intent domain (the intent codebook) + the SSM contract pattern reused for codebook distribution.
- `backend/lambda/src/lib/async-processor-core.ts` - `safeMetadataString`, the cap constants, the emission point.
- `backend/lambda/src/analytics-aurora/kinesis-archival.ts` - the second consumer reading the same metadata today.
