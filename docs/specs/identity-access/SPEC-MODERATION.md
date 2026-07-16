# SPEC - Moderation Model (surfaces)

**Status:** Partial (the built moderation surfaces plus the can-work design; assistant-neutral)


> **Scope.** How content moderation works (and *can* work) in AgentEchelon, and
> how the admin console operates. Assistant-neutral; OSS deployers can read this
> regardless of tooling.

AgentEchelon moderates content at **several distinct surfaces** - each at a different point in the message lifecycle, with a different identity and different powers. The principal surfaces are below. **This is not a closed set of exactly N**: surfaces can be added (another stream consumer, a richer client-side gate, a per-tier policy hook) without disturbing the others. Keep them distinct - do not conflate the bot / inference / stream layers with the admin layer.

| Surface | When | Identity | Powers | Status |
|---------|------|----------|--------|--------|
| **Real-time** (channel flow) | synchronous, *before* delivery | the channel-flow processor / default assistant | inspect, block, rewrite a message in-flight | hook exists, minimal use today |
| **Inference-layer** (Bedrock Guardrails) | at model invocation, on prompt **and** completion | the per-tier agent's attached Guardrail | anonymize / block PII, prompt-injection, and metadata markers in model input + output | active on every agent turn |
| **Near-real-time** (Kinesis tap) | async, just after delivery | a dedicated stream consumer | observe + react (flag, notify, auto-act) without blocking delivery | **possible, not wired today** |
| **Admin console** | out-of-band, any time | the operator's own **`${sub}-admin`** identity (client-side) | review the archive + take manual/automated action across conversations (redact, **delete**) | active surface for operators |
| **Client-side pre-send** (lightweight) | before send, in the composer | the user's own session | validate/block malformed sends (e.g. multi-target `@mention`) before they reach Chime | active, advisory |

The five above are today's surfaces; the model is deliberately open. New moderation foci slot in by lifecycle point + identity without renumbering the others - which is why this spec names surfaces rather than relying on a fixed ordinal.

## Real-time moderation - channel flow
Every channel has the Channel Flow Processor (`backend/lambda/src/channel-flow-processor.ts`) associated at creation. Chime invokes it **synchronously on every message before delivery**, so it can `ChannelFlowCallback` ALLOW / DENY / modify content. Today it handles `@all` routing and `/battle`; it is the natural place to add synchronous content filtering (profanity, PII, prompt-injection) that must block a message from ever being delivered.

## Inference-layer moderation - Bedrock Guardrails
Each per-tier agent has a **Bedrock Guardrail** (`backend/lib/constructs/bedrock-guardrails.ts`) attached. It runs at **model-invocation time**, filtering both the prompt going in and the completion coming back: it anonymizes/blocks PII, blocks prompt-injection patterns, and strips the metadata markers (`<!--ACTIVE_TASK:-->`, `<!--corr:-->`) the system uses internally. This is a **separate surface** from the channel flow: it acts at the inference boundary (not the Chime delivery boundary), it acts only on assistant turns (not human-to-human messages), and its identity is the guardrail policy bound to the agent - independent of who sent the message. Per the OSS posture the default guardrail is intentionally permissive on technical/architecture content; tuning it for production is the deployer's job.

## Near-real-time moderation - Kinesis tap (extension point)
Chime messages already stream to **Kinesis** (the archival pipeline: Chime → Kinesis → Firehose → S3 → Athena; Aurora in Aurora mode). A moderation consumer can subscribe to the **same Kinesis stream** to react to messages asynchronously - flagging, alerting, or invoking the admin service user to act - **without** adding latency to delivery (unlike the channel-flow surface). This is **not wired today**, but the stream is the integration point; document it so it isn't reinvented. (AE's stream is currently archival-only; a richer real-time stream processor is the natural extension here.)

## Admin console: archive read + client-side moderation
The admin console (admin dashboard **Conversations** tab, backed by `backend/lambda/src/admin-conversations.ts` for reads) is how an operator checks operational health, sees how assistants are performing, and takes manual action across conversations.

**Viewing reads the ARCHIVE, not live Chime.** Conversations and messages come from the analytics archive - Athena over the `conversations` Glue table (`conversations/user_type={tier}/year=/month=/day=/` on S3) in Athena mode, or the Postgres `messages`/`exchanges` tables in Aurora mode. Rebuilding the list by enumerating live Chime channels is wrong: with per-tier ownership no single bot sees every channel, and the archive is the system of record for history anyway.

**Action runs client-side, as the operator's own admin identity.** Moderation is NOT server-side. The admin console requests an `identity:'admin'` credential from the Credential-Exchange (scoped to the target channel, short-lived, audited) and calls Chime directly with the operator's own `${sub}-admin` bearer (`chimeService.ts`; see `SPEC-ADMIN-IDENTITY.md`):
- **Redact:** blanks a message's content. A channel **moderator** (who must also be a member) can redact; so can the operator's `${sub}-admin` identity, membership-free.
- **Delete:** removes the message. **Requires an app-instance-admin**, so a moderator or per-tier bot CANNOT delete; the operator's `${sub}-admin` identity holds that authority.

Each admin has a separate `${sub}-admin` `AppInstanceUser`, registered as an `AppInstanceAdmin` at the exchange on first use. The dedicated SERVICE `app-instance-admin` (custom resource `CreateAppInstanceAdminResource` in `AgentEchelonChimeMessaging`, SSM `/agent-echelon/app-instance-admin-arn`) is used only for no-human automation (e.g. membership-audit auto-revoke).

## Client-side pre-send validation (lightweight)
`frontend/src/utils/mentionParser.ts` (`parseMentions`) validates the composer's outgoing message before it reaches Chime - e.g. it rejects multi-target mentions (`Target` is fixed at 1 by the AWS API) and `@all` mixed with explicit mentions, surfacing the error in the composer and blocking the send. This is advisory, not a security boundary (a determined client can bypass it), but it is a real moderation focus at the earliest point in the lifecycle. Authoritative enforcement lives server-side (channel flow, Guardrails, tier IAM).

### Why the admin ARN is narrowly scoped
A common pattern is to use an app-instance-admin ARN **broadly** as the bearer for elevated operations (adding members, meetings, attachments, channel creation). **AE deliberately does NOT.** Per per-tier ownership (`docs/specs/assistant-context/SPEC-PER-TIER-OWNERSHIP.md`, tenet "the bot operates as itself"), conversation creation, membership, and sends run as the **per-tier bot** that owns the channel - never a shared admin. AE scopes the app-instance-admin to **admin-console moderation only** (redact/delete + archive viewing). This keeps tenant isolation intact while still giving operators a real moderation lever.

## Authority quick-reference
| Action | Per-tier bot (channel moderator) | App-instance-admin |
|--------|----------------------------------|--------------------|
| Send / add member to *its* channel | ✅ | ✅ |
| Redact a message | ✅ (its channels) | ✅ (any) |
| **Delete** a message | ❌ | ✅ |
| Read history across all conversations | ❌ (only its own) | via the **archive** (no per-channel membership needed) |
