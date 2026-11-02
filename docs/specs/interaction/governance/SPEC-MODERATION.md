# SPEC: Moderation

**Status:** Partial (the built content-moderation surfaces plus the can-work design; assistant-neutral).

**Coverage:** `tests/e2e/moderation.spec.ts` - drives real redacts against the deployed exchange and Amazon Chime SDK, asserting three distinct refusals: a moderation capability on the chat plane (400), the admin plane for a non-admin (403), and an admin credential scoped to one conversation acting on another (AccessDeniedException). The third is paired with a positive control - the same credential redacting successfully in the conversation it WAS scoped to - so the refusal is evidence of scoping rather than of a broken request.

**Related:** [SPEC-ADMIN-IDENTITY.md](./SPEC-ADMIN-IDENTITY.md) - the identity distinction this document's content surfaces act under. [SPEC-CONVERSATION-SECURITY.md](./SPEC-CONVERSATION-SECURITY.md) - Layer 5 (content safety) and Layer 6 (the stream audit) as layers of the access model.

**Site section:** Interaction layer, governance.

---

## Overview

**Content moderation is not one place in this platform, it is five, and each one holds a different identity with different powers.** A message can be inspected before it is delivered, filtered at the moment a model reads or writes it, reacted to after delivery, acted on out of band by an operator, and refused in the composer before it is sent at all. Naming them separately is the point of this document, because the question "what can block here" has a different answer at each surface and conflating them produces a design that assumes a power no surface has.

**The set is deliberately open.** Another stream consumer, a richer client-side gate or a per-classification policy hook fits in by lifecycle point and identity without disturbing the others. Surfaces are therefore named rather than numbered, so adding one does not renumber the rest.

**Content moderation is a separate axis from the identity distinction, and this document owns only the first.** The identity question - a channel-scoped Amazon Chime SDK `ChannelModerator` who may `redact` within one conversation, against a cross-conversation `AppInstanceAdmin` who may `delete` anywhere - belongs to [SPEC-ADMIN-IDENTITY.md](./SPEC-ADMIN-IDENTITY.md). Moderation is channel-scoped; administration is cross-conversation. The admin console appears below because it is where an operator acts on content, not because it is content moderation.

**What contains an operator's moderation credential is the channel scope on it, not a channel role.** Established by a failing end-to-end run rather than by reading: an `AppInstanceAdmin` can redact without holding the `ChannelModerator` role. So the boundary that holds is the session policy pinning the credential to one conversation, short-lived and recorded, and that is the property the e2e spec asserts with a paired positive control.

## Business Problem

A team that has to keep conversation content safe needs to know where in a message's lifecycle it can block, observe or remove content, and which identity is allowed to do each. Because moderation happens at several distinct surfaces, conflating them - channel flow against inference guardrail against stream tap against admin action - leads to wrong assumptions about what can block, observe or delete, and those assumptions fail in the permissive direction where nobody files a bug. The alternative on the market is stitching a moderation pipeline together across the message path and its permissions, and then securing each identity that touches it. What a deployment needs instead is the map: the surfaces, the identity at each, and the one authority that can remove content for good.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here. Five of them meet moderation, and they meet it at different surfaces: two act on content, one extends the model, one tunes what an assistant is held to, and one is refused in the composer before any of it applies.

### Admin / operator

**How this relates to them:** they are the only persona that reaches every conversation and the only one that can remove a message for good, so both the strongest power in this document and the tightest containment on it are theirs. They read from the archive rather than from live conversations, and every action they take vends its own credential.

| What they need | Requirement |
|---|---|
| Review conversation content across every conversation without holding membership in any of them | FR8 |
| Redact a message, and delete one where redaction is not enough | FR9 |
| A credential that cannot reach a conversation it was not opened for | FR10 |
| A moderated message that reads as moderated, with the actor named | FR12 |

### Manager

**How this relates to them:** they monitor a use case and hold the moderation-level capability for their own scope, so they redact and they do not delete. The surface they use is the same console the operator uses, narrowed where the request is served.

| What they need | Requirement |
|---|---|
| Content and `redact` for their scope, with `delete` refused rather than merely hidden | FR9, FR11 |
| To see that a message was already moderated rather than acting on it twice | FR12 |

### Platform developer

**How this relates to them:** they extend moderation, so what they need from this document is the inventory of insertion points and the honest state of each - which hook is invoked on every message today, which stream already has a consumer to copy, and what a new surface has to bring with it.

| What they need | Requirement |
|---|---|
| A synchronous pre-delivery hook that already runs on every message | FR1 |
| An asynchronous consumer pattern on the delivered-message stream, with a working example to model | FR7 |
| Confidence that a shared privileged identity is not the bearer for ordinary conversation work | FR14 |

### AI developer

**How this relates to them:** the inference-layer policy is attached per assistant, so what an assistant is held to is part of how that assistant is built. They select a policy rather than authoring filter code.

| What they need | Requirement |
|---|---|
| A content-safety policy that runs on both the prompt and the completion of every assistant turn | FR2 |
| More than one policy available as data, selectable per assistant | FR6 |
| Internal control markers never surfacing to a person, even when a model echoes one back | FR5 |
| Ordinary work content - a colleague's name, address or phone number - not rewritten under them | FR3 |

### End user

**How this relates to them:** the only moderation surface they meet is the composer, and it exists to stop a send that cannot be addressed rather than to judge what they wrote. It is advisory, and this document says so where it would otherwise be read as a boundary.

| What they need | Requirement |
|---|---|
| A send that cannot be addressed refused in the composer, with the reason, rather than delivered wrongly | FR13 |
| An assistant reply that never shows them platform control markers | FR5 |

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable.

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | A synchronous pre-delivery inspection point exists on every conversation: the channel flow is associated before any membership is added, and Amazon Chime SDK invokes it on every message before delivery, so it can allow, deny or rewrite content in flight | Enabler | Partly - the hook is associated and invoked on every message, and what it carries today is addressing rather than any content filter | `channel-creation` (unit, behavior), `a-context-conversation-opens-through-the-one-create` (unit, behavior), `channel-flow-callback-idempotence` (unit, behavior) |
| FR2 | Every assistant turn passes a content-safety policy at model invocation, on the prompt going in and the completion coming back | Table stakes | Yes | `guardrail-catalog` (unit, behavior) |
| FR3 | Payment-card and social-security numbers block rather than mask, and the contact details colleagues legitimately exchange are not rewritten | Table stakes | Yes | `guardrail-catalog` (unit, behavior) - asserts both halves, including that every remaining entity is a block so nothing silently rewrites a person's words |
| FR4 | Prompt-injection filtering runs on model input | Table stakes | Partly - the `PROMPT_ATTACK` filter runs at `HIGH` on input and is set to `NONE` on output, so a completion is not screened for it. `HIGH` blocks medium-confidence scores as well as high ones, and that is what holds a measured exfiltration attempt; it also refuses some ordinary business text scored at medium confidence. **Measured 2026-10-28** with ApplyGuardrail on the deployed guardrail and a temporary `LOW` one: at `LOW` a requirements answer passes and so does the exfiltration attempt, while five other injections score high confidence and are blocked at every strength. **OPEN:** a second signal that separates the two at medium confidence | `guardrail-catalog` (unit, behavior) for the provisioned filter set |
| FR5 | Internal control markers never reach a person: the policy masks a marker a model echoes back, and the runtime removes the mask token at the guardrail boundary, under one shared declaration so the provisioned filter and the stripper cannot drift apart | Differentiator | Yes | `guardrail-mask-tokens` (unit, behavior), `message-markers` (unit, behavior), `guardrail-mask-parity` (unit, source text) |
| FR6 | A deployment defines more than one content policy as data, and an assistant profile selects among them rather than editing filter code | Differentiator | Yes | `guardrail-catalog` (unit, behavior) - asserts a stricter alternate that is observably different from the default |
| FR7 | An asynchronous consumer reacts to delivered messages - flag, alert, act - without adding latency to delivery | Enabler | Partly - the stream and the consumer pattern are built and one consumer already flags, alerts and revokes on it; no content-moderation consumer is wired | `membership-audit` (unit, behavior) for the consumer pattern; none for a content-moderation consumer |
| FR8 | An operator reviews conversation content from the archive rather than by enumerating live conversations, because no single assistant sees every conversation and the archive is the system of record for history | Table stakes | Yes | `admin-conversations-aurora` (unit, behavior) for the Aurora-mode read; none for the Athena-mode read |
| FR9 | Redact blanks a message's content, and the only principal holding an IAM grant for it is the operator's own `${personId}-admin` identity: a human channel moderator's chat role and every assistant role carry no `RedactChannelMessage`, whatever Amazon Chime SDK's moderator model would permit; delete removes the message and is available only to the cross-conversation admin identity | Table stakes | Yes | `moderation` (e2e, behavior) |
| FR10 | A moderation credential is pinned to the one conversation it was vended for | Differentiator | Yes | `moderation` (e2e, behavior) - **deny-test:** a credential scoped to conversation A cannot redact in conversation B, paired with a positive control redacting in A so the refusal is evidence of scoping rather than of a broken request |
| FR11 | A moderation capability is refused on the chat plane whoever asks, and the admin plane is refused to a non-admin | Table stakes | Yes | `moderation` (e2e, behavior, negative case): two distinct refusals by the exchange itself (400 and 403, application code rather than IAM), each asserted to carry no credentials in the response body |
| FR12 | A moderated message reads as moderated: a redacted message and a deleted one carry distinct tombstones, the actor is named where the action was audited, and an action already taken is not offered again | Table stakes | Yes | `ConversationsTab.redaction` (admin Vitest, behavior) |
| FR13 | The composer refuses a send it cannot address - more than one distinct human, more than one distinct assistant, `@all` combined with an explicit mention, a private prefix combined with a mention - before it reaches Amazon Chime SDK, and says why | Above bar - optional | Yes | `mentionParser` (chat Vitest, behavior) |
| FR14 | The shared service admin identity is not a general-purpose elevated bearer: membership and sends on the turn path run as the assistant that owns the conversation, and conversation creation, the one bounded exception (Appendix B), holds no standing membership afterwards | Differentiator | Partly - the turn path runs as the per-classification assistant, and the channel flow's role carries no `chime:DeleteChannelMessage` at all, so the withdrawn delete cannot be reinstated without re-granting it; the conversation-management handler still bears the service admin for the user-initiated archive, remove-member and leave operations, each gated on the caller's own channel-moderator status before the bearer acts | none - `handler-send-grant-carries-archive-deny` proves that the handler's send grant carries the archived-channel Deny, not which bearer the turn path holds; nothing asserts the absence of the flow's delete grant, and nothing covers the conversation-management bearer |

**Reading the "Validated by" column.** Each entry is one specific test, named by its filename without its extension. Backend unit tests live in `backend/test/`, with the shared-library ones under `backend/test/lib/` and the Aurora analytics ones under `backend/test/analytics-aurora/`; end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../../reference/e2e-coverage-matrix.md); the admin console's Vitest suite lives under `frontend/packages/admin/src/`, and the chat client's under `frontend/packages/chat/src/`. The status in brackets is what the test does, which matters more than that it is green:

- **behavior** - executes the code path and asserts on the result.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong value.
- **none** - no test exists.

**A row marked deny-test carries the strongest evidence this document has.** Tenet P4 asks for isolation proven by deny-test rather than by code review, and FR10 is the row that meets it: a live run against the deployed stack in which IAM refuses. FR11's refusals are also live, and are the exchange's own application-code answers rather than an IAM decision, which is why that row is labeled a negative case rather than a deny-test. FR10's positive control is not decoration: without it a denial could be a bad ARN, an expired session or a missing capability, and the test would report containment where there is only a broken request.

**Acceptance criteria.** A chat identity is refused a moderation capability. A non-admin is refused the admin plane. A credential vended for one conversation cannot act on another, and can act on the one it names. Redaction is granted only to an operator's admin identity; deletion is available only to the cross-conversation admin identity. A redacted message and a deleted message are visibly different, and neither offers the action that already ran. A control marker never renders to a person, whether the model emitted it or the guardrail masked it.

**OPEN:** whether the channel flow should carry synchronous content filtering at all, or whether a delivered-message consumer is the right home for everything except what must never be delivered. The flow blocks, which nothing else in this document can, and it pays for that with latency on every message.

**OPEN:** what a content-moderation consumer on the delivered-message stream is allowed to do once it flags something. Flag and alert need no new authority; auto-redacting needs a bearer, and the only identity that holds one across conversations is the service admin, which FR14 exists to keep narrow.

**SETTLED (owner, 2026-09-29): the conversation-management handler keeps the service admin bearer** for the user-initiated archive, remove-member and leave operations. It is inside FR14's boundary, not an exception to it.

The distinction FR14 draws is about whose AUTHORITY an operation runs on, not about which ARN appears in the API call. Here the caller's own Amazon Chime SDK channel-moderator status is checked first and a 403 is returned when it is absent, so a caller who may not archive cannot archive, whatever the bearer. The bearer is the mechanism that executes a decision the caller was already entitled to make. What FR14 narrows is the opposite case - a shared elevated identity standing in for an authority nobody checked - and the turn path is where that mattered, which is why membership and sends on it run as the assistant that owns the conversation.

Moving these to the caller's own `${personId}-admin` vend was considered and declined: it would put a second mechanism behind the same already-gated decision, and the `${personId}-admin` identity exists for the admin plane, where an operator acts across conversations they are not a member of. These operations are the opposite - a member acting on their own conversation.

**OPEN:** the guardrail's `PROMPT_ATTACK` filter is input-only. Whether a completion should be screened for injection artifacts is undecided, and the cost of screening output is a second evaluation on every turn.

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| The identity distinction between a channel moderator and a cross-conversation admin | It is an authority model rather than a content control, and it governs far more than moderation: archive access, membership, configuration | [SPEC-ADMIN-IDENTITY.md](./SPEC-ADMIN-IDENTITY.md) - the two-identity split, the capability set, and the levels table |
| Topic denial per classification | The policy is content safety plus PII plus a word list. No denied-topics policy ships, and cross-classification context isolation is enforced before a request runs rather than by asking a model to decline | [SPEC-CONVERSATION-SECURITY.md](./SPEC-CONVERSATION-SECURITY.md) - Layer 1 channel-tag IAM and Layer 4 archive-prefix scoping |
| The client-side composer check as a security boundary | A determined client bypasses it. It is a usability control at the earliest point in the lifecycle, and calling it more than that would put an unenforced line on the diagram | FR13 states it as advisory; authoritative enforcement is the channel flow, the inference policy and the per-classification IAM grants |
| Deleting a conversation | Not an available action at either authority level. Archiving, which marks a conversation read-only through an immutable tag, is the supported end-of-life path | [SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md](../conversation/SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md) - the archive path and the moderator gate on it |
| Removing content from the archive when it is redacted or deleted live | The archive is the system of record and holds what a message said before it was moderated, which is what makes an audit possible | [SPEC-ACCESS-AND-CONTROLS-AUDITING.md](./SPEC-ACCESS-AND-CONTROLS-AUDITING.md) - retention and what an erasure request reaches |
| Human review queues, escalation workflow and reviewer scoring | Commodity trust-and-safety tooling with nobody here to maintain it, and the stream is the integration point for a vendor that has it | FR7 names the consumer seam; the delivered-message stream is the attachment point |
| Tuning the shipped content policy for a public-facing deployment | The default is calibrated for colleagues inside an organization. A deployment serving the public revisits the PII position as a recorded decision rather than as a configuration flag somebody sets differently by accident | FR6 - a deployment declares its own policy in the catalog and points a profile at it |

## User Experience Description and Mocks

Moderation is met at three surfaces by three different people, and only one of them looks like moderation.

### The end user, in the composer

1. **Write and send.** Nothing in the composer judges content. What it checks is whether the message can be addressed at all (FR13).
2. **Be told, not corrected.** A send naming two people, or `@all` beside an explicit mention, is refused in place with the reason, because `Target` carries one member and a silently dropped addressee is a message delivered to the wrong reader.
3. **Never see the plumbing.** An assistant reply arrives with every internal control marker gone, whether the assistant emitted one or the inference policy masked it (FR5).

### The operator, in the admin console

1. **Open the Conversations tab.** The list and the messages come from the archive, so a conversation shows up regardless of which assistant owns it and history survives the conversation (FR8).
2. **Read what was already moderated.** A redacted message and a deleted message carry distinct tombstones, and the actor is named where the action was audited (FR12).
3. **Act, one conversation at a time.** Redacting or deleting requests a credential scoped to that conversation, short-lived and recorded, and calls Amazon Chime SDK as the operator's own admin identity (FR9, FR10).
4. **Find the action gone once it has run.** Redact disappears once the message is redacted or deleted; delete disappears once it is deleted (FR12).

A manager follows the same path narrowed to their scope, and finds `delete` refused where the request is served rather than merely absent from the screen (FR11).

### The platform developer, extending the model

There is no surface here. A new moderation focus is chosen by lifecycle point and identity: the channel flow to block before delivery, the inference policy to filter what a model reads or writes, the delivered-message stream to react without latency, or the admin plane to act out of band. Appendix A is that map.

**OPEN:** this document carries no mocks. The candidate is the Conversations tab with both tombstones and the per-message actions visible, which the admin console renders today.

## Related Documents

- [SPEC-ADMIN-IDENTITY.md](./SPEC-ADMIN-IDENTITY.md) - the authority model: moderator against admin, the two credential planes, and the levels table
- [SPEC-CONVERSATION-SECURITY.md](./SPEC-CONVERSATION-SECURITY.md) - Layer 5 content safety, Layer 6 the stream audit, and the control-marker injection defense
- [SPEC-CREDENTIAL-EXCHANGE.md](./SPEC-CREDENTIAL-EXCHANGE.md) - the scoped, short-lived, recorded vend that pins a moderation credential to one conversation
- [SPEC-ADMIN-CONSOLE.md](../../interface/SPEC-ADMIN-CONSOLE.md) - the operator surface the admin actions run from
- [SPEC-PER-PROFILE-OWNERSHIP.md](../assistants/SPEC-PER-PROFILE-OWNERSHIP.md) - why conversation creation, membership and sends run as the assistant that owns the conversation
- [PERSONAS.md](../../../overview/PERSONAS.md) - the canonical definitions of the personas above
- [TENETS.md](../../../overview/TENETS.md) - tenet P4, which the deny-tested scoping follows from, and tenet D8, which is why the delivered-message stream is the extension point rather than a new one

## Appendix A - The surfaces

Each surface sits at a different point in the message lifecycle, holds a different identity and has different powers. The set is open: a new focus fits in by lifecycle point and identity without renumbering the others.

| Surface | When | Identity | Powers |
|---|---|---|---|
| **Real-time** (channel flow) | synchronous, before delivery | the channel-flow processor | inspect, block or rewrite a message in flight |
| **Inference-layer** (Amazon Bedrock Guardrails) | at model invocation, on prompt and completion | the policy attached to the assistant | block harmful categories, block payment and identity numbers, mask internal control markers |
| **Near-real-time** (delivered-message stream) | asynchronous, just after delivery | a dedicated stream consumer | observe and react - flag, notify, act - without blocking delivery |
| **Admin console** (administration) | out of band, any time | the operator's own `${personId}-admin` app-instance-admin identity, client-side | review the archive and act across conversations (redact, delete) |
| **Client-side pre-send** | before send, in the composer | the user's own session | refuse a send that cannot be addressed |

### Real-time - the channel flow

Every conversation has the channel flow processor (`backend/lambda/src/channel-flow-processor.ts`) associated before any member is added, so no message - including a welcome - can bypass it. Amazon Chime SDK invokes it synchronously on every message before delivery, so it can answer `ChannelFlowCallback` with allow, deny or modified content. What it decides today is who responds: it routes `@all` and `@<assistant>` in a group conversation and drives `/battle`. It does not run the turn, and a decision duplicated between it and the router diverges silently because the turn answers either way. It is the natural home for synchronous content filtering that must stop a message from ever being delivered, and the cost of putting filtering there is latency on every message.

### Inference-layer - Amazon Bedrock Guardrails

Each assistant has a policy attached (`backend/lib/constructs/bedrock-guardrails.ts`), evaluated at model-invocation time on the prompt going in and the completion coming back. This is a different surface from the channel flow in three ways: it acts at the inference boundary rather than the delivery boundary, it acts only on assistant turns rather than on human-to-human messages, and its identity is the policy bound to the assistant rather than whoever sent the message.

What the shipped default does:

- **Harmful-content filters** on sexual, violence, hate, insults and misconduct, plus `PROMPT_ATTACK` at `HIGH` on input and `NONE` on output.
- **Payment and identity numbers block rather than mask.** A social-security number and a payment-card number have no legitimate place in a message to an assistant and are the classic target of an exfiltration attempt, so a message carrying one is refused and the sender is told, rather than silently rewritten.
- **Contact details are not masked, and that is a position rather than a setting.** Colleagues exchange names, addresses and phone numbers because that is the ordinary content of work, and a masking filter also proved inaccurate in practice: the digits of ordinary arithmetic matched the phone detector, so asking the assistant to compute anything returned a masked answer.
- **Internal control markers are masked.** An `ANONYMIZE` regex filter covers `<!--ACTIVE_TASK:-->`, `<!--corr:-->` and `<!--turn:-->`, so a model that echoes a control marker back is caught. The filter's name is the mask Amazon Bedrock Guardrails substitutes, so it is a visible string the runtime has to remove, and it is read from one shared declaration (`backend/lib/config/guardrail-masks.ts`) that the stripper also reads - the provisioned filter and the removed token cannot drift apart.
- **A word list**, with a managed profanity list beside it.

The policy is data. `buildGuardrailPolicy` is exported so a deployment's catalog can start from the default and change it, a fully declared policy can be provisioned verbatim in its place, and the shipped catalog already carries a stricter alternate an assistant profile can point at.

### Near-real-time - the delivered-message stream

Messages already stream off Amazon Chime SDK Messaging into Kinesis and on through the archival pipeline to S3 and Athena, with Aurora as the additional projection in Aurora mode. A consumer subscribing to the same stream reacts after delivery without adding latency to it, which is the trade against the channel flow.

This pattern is not hypothetical here: the membership audit (`backend/lambda/src/membership-audit.ts`, Layer 6 of [SPEC-CONVERSATION-SECURITY](./SPEC-CONVERSATION-SECURITY.md)) is already a consumer on that stream, and it flags, alerts an operator and revokes a membership when enforcing. What is absent is a consumer whose subject is message *content*. The stream is the integration point, and a vendor's trust-and-safety pipeline attaches there rather than inside the turn.

### Admin console - archive read and admin actions

The admin console's Conversations tab is how an operator checks operational health and acts across conversations, backed by `backend/lambda/src/admin-conversations.ts`.

**Viewing reads the archive, not live conversations.** Conversations and messages come from Athena over the `conversations` Glue table on S3, where the `user_type` partition holds the conversation's classification, or from the Postgres `messages` and `exchanges` tables in Aurora mode. Rebuilding the list by enumerating live Amazon Chime SDK channels is wrong twice over: with per-profile ownership no single assistant sees every conversation, and the archive is the system of record for history regardless.

**Action runs client-side, as the operator's own admin identity.** These actions are not server-side. The console requests the capability's credential from the admin credential exchange (`POST /exchange-credentials/admin/<capability>`), scoped to the target conversation, short-lived and recorded, and calls Amazon Chime SDK directly with the operator's own `${personId}-admin` bearer (`frontend/packages/admin/src/services/adminChime.ts`).

- **Redact** blanks a message's content. Redact is held only by the operator's `${personId}-admin` identity, membership-free; a human channel moderator and an assistant hold no IAM grant for it (`EXCHANGE_MSG_ACTIONS` and every assistant action set omit `RedactChannelMessage`), whatever Amazon Chime SDK's moderator model would otherwise permit them.
- **Delete** removes the message and requires an app-instance-admin, so a channel moderator or a per-classification assistant cannot delete.

Each operator has their own `${personId}-admin` `AppInstanceUser`, registered as an `AppInstanceAdmin` at the exchange on first use. The exchange tags the twin `owner` with its owner's AppInstanceUser ARN (`ensureAdminIdentity` in `backend/lambda/src/admin-credential-exchange.ts`, through `tagIdentity` in `backend/lambda/src/lib/vend.ts`).

### Client-side pre-send validation

`frontend/packages/chat/src/utils/mentionParser.ts` (`parseMentions`) checks the composer's outgoing message before it reaches Amazon Chime SDK. It refuses more than one distinct human mention and more than one distinct assistant mention, because `Target` is fixed at one member by the AWS API; it refuses `@all` combined with an explicit mention; and it refuses a private `.` prefix combined with a mention. Each refusal surfaces in the composer with its own message and blocks the send. Addressing and privacy are separate here: an `@<member>` mention sets no `Target` and leaves the message readable by the conversation, while the `.` prefix is the private form. This surface is advisory, not a security boundary - a determined client bypasses it - and authoritative enforcement lives in the channel flow, the inference policy and the per-classification IAM grants.

## Appendix B - Why the shared admin identity stays narrow

A common pattern is to use an app-instance-admin ARN broadly as the bearer for elevated operations: adding members, meetings, attachments, conversation creation. This platform keeps it narrow. Under per-profile ownership ([SPEC-PER-PROFILE-OWNERSHIP.md](../assistants/SPEC-PER-PROFILE-OWNERSHIP.md), and the tenet that an assistant operates as itself) membership changes and sends on the turn path run as the assistant that owns the conversation, never a shared admin.

**Conversation creation is the one bounded exception.** Amazon Chime SDK makes the `CreateChannel` bearer a member before a channel flow can be attached, so an assistant bearer's welcome bypasses the flow. The service admin therefore creates person-created, drift-split and event-opened conversations (`resolveServiceAdminBearer` in `service-admin-bearer.ts`, `createConversationCore` in `channel-creation.ts`): it creates the channel, adds the primary assistant as member and moderator, adds the people and the type's assistants as bearer while it moderates, then drops its moderator record and leaves in a `finally`, so a creation that fails partway still removes it. It holds no standing membership in any conversation it creates. Where the parameter is unset or unreadable, creation is refused (`NoServiceAdminError`); no conversation is created as an assistant. A host's context conversation (`createConversationForContext`) creates through the same creator, as the service admin.

Two consequences are worth stating because each was reached deliberately:

**The channel flow's role carries no `chime:DeleteChannelMessage`, and the absence is the enforcement.** A private address that arrives with no `Target` is not deleted: a delete never unsends anything, and destroying the sender's own words to work around their client's fault is the wrong remedy. Because the grant is absent as well as the behavior, reinstating a delete fails on permissions rather than quietly working. The flow reads the stored message back to see its `Target` and tells the sender what happened (`backend/lambda/src/lib/private-command.ts`).

**The service `app-instance-admin` remains the bearer for admin-plane and automation paths.** It is created as a custom resource in the Amazon Chime SDK messaging stack and published to SSM at `/agent-echelon/app-instance-admin-arn`. Its consumers are the membership audit and its admin API, admin conversation sync, user management, the admin notification path, and the conversation-management handler's archive, remove-member and leave operations. That last set is user-initiated rather than automation: the caller's own channel-moderator status is checked first and the bearer executes a decision the caller was entitled to make. That arrangement is settled and deliberate - see the note above FR14's table. Each of these roles holds its membership changes bearing the service admin by its exact ARN, never `user/*` (any person), and only on a channel that carries a declared classification, or, for the admin conversation sync, only on the channels `adminConversationArns` names (`adminPlaneMembershipStatements`, `agent-classification-common.ts`); the admin notification provisioner creates and stamps its channel bearing the admin assistant, reached through its admin-plane classification tag.
