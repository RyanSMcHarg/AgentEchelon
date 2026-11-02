# SPEC: Conversation Security, Membership and Information Isolation

**Status:** Partial (Layers 1-6 ship; Layer 7 mixed-trust visibility is partial; caller resolution (§4e) and the audience rule's declared grants and outward guard are NOT BUILT).

**Coverage:** `tests/e2e/classification-context.spec.ts`, `tests/e2e/mentions.spec.ts`, `tests/e2e/credential-exchange.spec.ts`, `tests/e2e/identity-classification.spec.ts`, `tests/e2e/an-assistant-boundary-refuses-cloudwatch.spec.ts`

**Verified by:** `backend/test/cdk-synth.test.ts` asserts the SYNTHESIZED IAM policy, so a widened boundary fails the build. Layer 1 (describe 'Layer 1 - per-tier fail-closed channel-tag allow'): each classification's channel actions are ALLOWed only on `aws:ResourceTag/classification` in its declared `grants` set, with no unconditioned `SendChannelMessage` reaching channel resources (untagged/higher-tier channels match no Allow and are implicitly denied), and each assistant's channel grant is its own classification alone. Layer 4 / §7 (describe 'Layer 4 / §7 - IAM resource boundaries (deny-by-absence...)'): each classification's S3 `context/` read is confined to its declared `grants` set and reaches nothing outside it; the handler role holds only `dynamodb:GetItem` and `dynamodb:UpdateItem` on the channel-context store (case 'assistant role holds only GetItem + UpdateItem on the channel-context store'), which is referenced by no Cognito/Identity-Pool role; and `bedrock:ApplyGuardrail` is scoped to in-stack provisioned guardrails, never `*`. §4d (case 'every exchange role trusts sts:TagSession only for its OWN role, with sub asserted'): every exchange role's TRUST policy carries exactly one `sts:TagSession` statement, conditioned on `StringLike aws:RequestTag/person` and on `StringEquals aws:RequestTag/classification` equal to that role's own classification, asserted per role from the registry, with the guest/federated role and the admin-plane role carrying their own literal roles. `backend/test/an-exchange-role-cannot-be-assumed-un-pinned.test.ts` asserts the other half of the same trust document: `sts:AssumeRole` carries those conditions too, the `sts:TagSession` statement repeats them exactly, and no statement permits an `sts:` action unconditioned.

**Related:** [SPEC-CREDENTIAL-EXCHANGE.md](./SPEC-CREDENTIAL-EXCHANGE.md) (the vend that pins every principal) · [IDENTITY-AND-ACCESS-MODEL.md](./IDENTITY-AND-ACCESS-MODEL.md) (the reference model) · [ACCESS-CONTROL-BY-EXAMPLE.md](./ACCESS-CONTROL-BY-EXAMPLE.md) (the worked denials) · [SPEC-FEDERATED-PARTICIPANTS.md](./SPEC-FEDERATED-PARTICIPANTS.md) (external humans) · [ADR-017](../../../design/decisions/017-conversation-archive-mechanism.md) · [ADR-028](../../../design/decisions/028-vector-store-classification-boundary.md) · [ADR-042](../../../design/decisions/042-an-assistant-acts-in-exactly-one-classification.md) · [ADR-046](../../../design/decisions/046-classifications-are-a-set-not-a-ladder.md)

**Site section:** Interaction layer, governance.

---

## Overview

Seven numbered defense layers (Layer 1 through Layer 6, with Layer 4b, retrieval scoping, beside Layer 4) isolate classifications within the app, and Layer 7 governs mixed-trust visibility when an external guest shares a channel with internal members. Together they address context leakage in conversations whose members hold different clearances, conversation types, membership enforcement and drift detection.

**`classification` is the only closed axis IAM evaluates, and everything below is a consequence of keeping it closed.** A channel, a document and an assistant each carry exactly one classification; what a principal may reach is that classification's declared `grants` set, which every classification states and none inherits. The axis is a set rather than a ladder (ADR-046), so `grantsFor` is the only reach question and "what sits below this" is not a question the platform asks. The familiar triangular pattern in the tables below is what the shipped sample's prefix-shaped grant sets look like, not a property of the design, and many deployments should not nest them: the shipped outside classification `customer` grants only itself, so a person cleared for every member classification does not reach it (`validateProfilesConfig` refuses a member classification that grants it).

**Identity is bearer-pinned, so an actor can only ever act as itself.** Amazon Chime SDK does not bind `x-amz-chime-bearer` to the caller; AWS documents the opposite, that the bearer resource in the IAM policy is what decides which identity a credential may act as. So the bearer resource is the whole of the impersonation control, and it is pinned rather than wildcarded: a person's classification role names `.../user/${aws:PrincipalTag/person}`, and an assistant's acting role names `.../bot/${aws:PrincipalTag/bot}`, the bot its per-turn session was minted for (`assistantActingRole`, `agent-classification-common.ts`).

**A permissions boundary acts as a limit, and a narrowed grant is what delegation means.** Each classification publishes one boundary managed policy on its assistant acting role, written as an allow-list of the services a turn uses (`BoundaryTheServicesATurnUses`), with S3 allowed only on the unclassified key families a turn uses and the `context/` and `platform-knowledge/` prefixes the classification grants (`BoundaryObjectsATurnUses`, `BoundaryListingItsOwnPrefixes`), so another classification's prefix is outside it without being named, plus Denies: no IAM edit, no role chaining or session tagging and no bot tagging (`AnAssistantNeverEditsIdentityOrChains`), no channel or bot outside the classification, and no telemetry read unless the session's assistant role is an observability role (`assistantActingRole`, `agent-classification-common.ts`). Raising it is a deploy. Capabilities are delegated by narrowing a vended, recorded grant rather than by rewriting a policy; each assistant is narrowed below its classification and role by session policies chosen from its approved definition (`grantEdgesFor`, `assistantGrantCatalog`).

**Every sensitive operation carries at least two enforcement layers, so one missed check is not a breach.** A basic user cannot reach a premium model even through a direct API call: the channel tag gate refuses the send, the assistant's own role reaches only its classification's models and context prefixes, and the retrieval path is bounded by a database privilege as well as by a query filter. Where only one layer exists, this document says so rather than implying a second.

**Isolation is provable by deny-test rather than by code review, and that is the strongest evidence in this repository.** Three live deny-tests run against a deployed stack and let IAM decide: `deny-test-credential-exchange.mjs` proves the bearer pin and the channel tag gate on a real channel, `deny-test-session-classification.mjs` proves every classification role refuses a mismatched or absent classification assertion, and `deny-test-tag-key-case.mjs` settles whether a principal-versus-resource condition matches across the two tag casings. `verifyClassificationBoundary` does the same job inside Aurora, including a defeat test issued with the classification filter deleted and one issued with no role assumed at all. A synth test on top of those asserts the policy that was generated, so a widened boundary fails the build before anything is deployed.

## Business Problem

A business running one assistant platform across clearance levels needs a provable guarantee that content of a classification never leaks into a conversation a person not cleared for it can read. When a premium and a basic user share a room, the assistant can write financials, board minutes or competitive intelligence into a channel the basic user reads, and context isolation controls what the assistant reads rather than what it writes. The alternative is to accept that a general chatbot cannot promise this, or to build and prove a multi-layer isolation model and the harness that demonstrates it. What the business needs is not a claim but an account of which primitive stops each leak and a test that fails when one of them stops stopping it.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here. This is a cross-cutting foundation rather than a surface, so most personas meet it as a constraint on something else they were doing; two own it.

### Platform developer

**How this relates to them:** they answer for whether the isolation guarantee holds, so they are the audience for the layer model itself, for which primitive decides each row, and for the deny-tests that are the evidence. They are also the only audience that reads the gaps as work rather than as caveats.

| What they need | Requirement |
|---|---|
| A channel-level boundary enforced by IAM before any application code runs | FR2 |
| Proof that an assistant cannot act outside its own classification | FR3 |
| Proof that no principal can act as another identity | FR4, FR5 |
| An account of where only one layer exists, stated rather than implied | FR16, FR19, FR20 |
| A boundary that fails the build when it is widened | FR2, FR3, FR9 |

### Admin / operator

**How this relates to them:** they run the deployment, so their question is whether a boundary is currently in force, what fires when admission goes wrong, and what they have to switch on for a finding to become an action.

| What they need | Requirement |
|---|---|
| An uncleared membership surfaced whether it came from the app, a script or compromised credentials | FR12 |
| A switch between reporting a leak and revoking it | FR12 |
| An archived conversation that is read-only by IAM rather than by application logic | FR13 |
| An absent classification tag that fails closed and says so, rather than defaulting | FR1 |
| A guardrail catalog they can make stricter without a code change | FR11 |

### End user

**How this relates to them:** they never see any of it, which is the point. They are the subject of the guarantee rather than a user of it, and the one place it becomes visible to them is a refusal.

| What they need | Requirement |
|---|---|
| A conversation whose content stays inside the clearance it was held at | FR2, FR9, FR10 |
| An honest refusal rather than a fabricated answer when the room cannot reach the material | FR21 |
| A clear error at invite time rather than a silent add that later fails | FR7 |
| Another member's injected control marker that cannot spoof their client | FR15 |

### AI developer

**How this relates to them:** they build the assistants that run inside these layers, so the boundary decides what an assistant can be given and what a profile may select.

| What they need | Requirement |
|---|---|
| An assistant whose context reach is generated from its classification rather than hand-written | FR9 |
| Retrieval bounded by a privilege, not only by a filter a call site has to remember | FR10 |
| A guardrail selected per profile from a catalog, with the grant scoped to what it selected | FR11 |
| Private host grounding that reaches the assistant without reaching the room | FR14 |

### Manager

**How this relates to them:** they answer for a use case running in front of external people, so the mixed-trust case is theirs: an internal back-channel beside an external guest in one room.

| What they need | Requirement |
|---|---|
| An external guest who sees only what is meant for them | FR16, FR19 |
| An honest statement of what the visibility gate does and does not guarantee | FR16, FR17 |
| Observation of a live conversation without influencing it | FR18 |

**Also bounded by this document, and not personas in `PERSONAS.md`:** the **assistant**, a system actor whose classification is assigned to it rather than chosen by it (FR3), and **Legal** and **HR**, whose purpose-scoped reads run on the admin plane described in [SPEC-CREDENTIAL-EXCHANGE](./SPEC-CREDENTIAL-EXCHANGE.md) rather than through any layer here.

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable.

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | Every channel, assistant identity and person identity carries one `classification` tag. A channel's and an assistant's are written in the create call rather than by a following `TagResource`; a person's is a best-effort `TagResource` after the identity exists, re-applied on every credential vend. A reader that cannot find a tag resolves to `undefined`, logs a `[SecurityEvent]`, and the caller refuses; there is no floor (ADR-046) | Table stakes | Yes | `an-assistant-is-assigned-one-classification` (unit, source text), `identity-classification` (e2e, behavior) |
| FR2 | Layer 1: channel actions are granted only where the channel's `classification` is in the principal's declared grant set, as a fail-closed Allow on the global `aws:ResourceTag/classification`, so an untagged or out-of-set channel matches no Allow and is implicitly denied | Table stakes | Yes | **deny-test, the strongest evidence here:** `backend/scripts/deny-test-credential-exchange.mjs` proves the gate live on a real channel; `cdk-synth` Layer 1 (unit, synthesized policy), `classification-context` (e2e, behavior) |
| FR3 | An assistant acts in exactly one classification: its channel grant is its own classification alone rather than its grant set, so an assistant placed on a channel of any other classification is denied every channel action there (ADR-042) | Differentiator | Yes | **deny-test:** `assistant-classification-boundary` (e2e, live deny); `an-assistant-acts-in-exactly-one-classification` (unit, behavior), `cdk-synth` Layer 1 (unit, synthesized policy) |
| FR4 | A person can only act as themselves: their classification role's bearer resource is `.../user/${aws:PrincipalTag/person}`, never a wildcard. The classification roles condition `sts:AssumeRole` itself, and repeat the same condition on `sts:TagSession`, so an un-tagged assumption is refused rather than yielding a credential that can bear nothing. The assistant acting role takes the same shape, with the vend as its only trusted principal | Table stakes | Yes | **deny-test:** `backend/scripts/deny-test-credential-exchange.mjs` proves the same send allowed bearing the caller's own ARN and denied bearing another person's; `credential-exchange` (e2e, behavior) |
| FR5 | An assistant can only bear its own bot identity | Differentiator | Partly - every turn the async processor runs acts on a session of the classification's acting role, minted by the vend from the router's routing record and pinned to one bot by `.../bot/${aws:PrincipalTag/bot}`; a refused session fails the turn and there is no fallback identity. The router speaks on vended speak sessions too, and the channel flow speaks as nobody: it names its notices to the router and records a turn it could not start as turn state. Their own roles stay wider: the flow's role reads (`ListChannelMemberships`, `ListChannelModerators`, `GetChannelMessage`, `ListTagsForResource`) on `${appInstanceArn}/*` with no condition, and the router's role keeps a classification-conditioned read `/bot/*` bearer, an unconditioned `chime:SearchChannels` on `/bot/*` and `/user/*`, and, with drift on, channel creation bearing the service admin and membership changes on a channel of its own classification bearing that admin. Services that put a line in a conversation outside a user turn (proactive briefing, federated join notice, share-conversation, Battle Mode notices, the typed-conversation notice, the archive notice) name a notice to the router, which says it, and hold no vend invoke and no send bearing a bot; the conversation split's link is posted by the processor in the turn's answer; arrival triage speaks on vended speak sessions, and the battle orchestrator speaks as nobody: the router posts a duel's round placeholders and marker clears and says its closing lines; the roles that create conversations bear the service admin and hold no `/bot/*` bearer for creation or a membership change (a deployment with no service admin refuses creation), while sharing, which adds a member bearing the conversation's assistant, keeps a classification-conditioned `/bot/*` bearer for that membership change (`ShareAddsMember`, `notification-stack.ts`) | `an-assistant-acts-through-one-tagged-role` (unit, synthesized policy), `a-turn-acts-as-the-assistant-it-was-routed-to` (unit, behavior), `a-turn-runs-on-the-assistant-not-the-processor` (unit, behavior), `cdk-synth` 'assistant/handler roles bear BOTS only' (unit, synthesized policy), `assistant-classification-boundary` and `only-the-vend-mints-an-assistant-session` (e2e, deployed IAM), `no-platform-role-speaks-as-an-assistant` (e2e, deployed IAM) |
| FR6 | Every credential vend asserts `person` and `classification` as session tags, and each role's trust policy refuses to tag a session whose `classification` differs from that role's own classification | Differentiator | Partly - the trust-policy half is built; no permissions policy compares a principal tag with a resource tag (FR20) | **deny-test:** `backend/scripts/deny-test-session-classification.mjs` reads the condition off the deployed roles and proves a matching, a mismatched and an absent assertion; `cdk-synth` §4d case (unit, synthesized policy), `every credential vend asserts both identity and classification` (unit, source text) |
| FR7 | Layer 2: every path that adds a human resolves the channel's immutable tag first and refuses a shortfall with `403 TIER_FORBIDDEN`, and the set of adding paths is frozen so a new one fails the build until it is registered with the reason it cannot reuse the shared helper | Table stakes | Yes | `single-entry-point` (unit, source text) |
| FR8 | Layer 3: a person's clearance is resolved from their Cognito groups rather than a stored attribute, and a combination the deployment has not declared resolves to no token and is refused a credential with a logged security event rather than being defaulted to the floor | Table stakes | Yes | `auth` (unit, behavior), `credential-exchange` `resolveRoleKey` (unit, behavior) |
| FR9 | Layer 4: an assistant's `context/` read is confined to the prefixes its classification grants, generated from the same resolver the channel gate uses, and reaches nothing outside them | Table stakes | Yes | `cdk-synth` Layer 4 / §7 (unit, synthesized policy), `cdk-synth` 'gives the assistant the SAME reach for channels and for context prefixes' (unit, synthesized policy), `classification-context` (e2e, behavior) |
| FR10 | Layer 4b: retrieval is bounded by a database role per classification with row-level security over both vector tables, with the SQL classification filter kept as depth, fail-closed for untagged rows and refusing to run on an empty scope | Differentiator | Yes | **deny-test:** `verifyClassificationBoundary` (data-plane op, live, seven of seven including a defeat test with the filter deleted and one with no role assumed); `classification-boundary` (unit, behavior), `document-ingestion-classification` (unit, behavior) |
| FR11 | Layer 5: a Bedrock guardrail runs on every assistant turn on input and on output, selected per profile from a provisioned catalog, with `bedrock:ApplyGuardrail` scoped to in-stack provisioned guardrails rather than `*` | Table stakes | Yes | `cdk-synth` Layer 4 / §7 (unit, synthesized policy), `guardrail-mask-parity` (unit, source text) |
| FR12 | Layer 6: a dedicated membership-audit consumer is always deployed and flags cross-classification membership in both directions - a human whose clearance does not reach the channel and an assistant whose classification is not the channel's - from the membership event, a scheduled sweep and an on-downgrade re-evaluation | Differentiator | Partly - report-only by default; auto-revoke is a runtime toggle (`config/enforce` in the audit table, switched from the admin console's Security tab), and `-c membershipAuditEnforce=true` sets only its default | `membership-audit` (unit, behavior), `access-auditing` (e2e, behavior), `a-sweep-that-cannot-finish-says-so` (unit, behavior) |
| FR13 | An archived conversation is read-only for every chat-plane identity by an IAM Deny conditioned on the `archived` tag, which overrides the tag-gated Allow, with the admin-plane bearer deliberately exempt so it can post the archive notice | Table stakes | Yes | `handler-send-grant-carries-archive-deny` (unit, synthesized policy), `conversation-archive-wiring` (unit, behavior) |
| FR14 | A conversation's private host grounding lives in a server-only store that no member, Cognito or Identity-Pool principal is granted any access to; the router and handler roles hold `dynamodb:GetItem` and `dynamodb:UpdateItem` on it and nothing else | Differentiator | Yes | `cdk-synth` Layer 4 / §7 (unit, synthesized policy) |
| FR15 | An injected control marker is stripped on display, stripped on every non-UI backend read, and is never the trigger for a side-effect action; the guardrail's own mask token is removed where the mask is applied | Differentiator | Yes | `message-markers` (unit, behavior), `guardrail-mask-tokens` (unit, behavior), `guardrail-mask-parity` (unit, source text) |
| FR16 | Layer 7: in a channel mixing an external guest with internal members, every message is either targeted (internal-only) or broadcast (guest-visible) and the guest is broadcast-only | Table stakes | Partly - the targeted-messaging mechanism exists and the assistant is the gate; the decision between targeted and broadcast is a policy the assistant applies rather than a control that refuses a wrong broadcast; a one-conversation guest is bounded by scope and membership rather than by a classification tag, see [SPEC-FEDERATED-PARTICIPANTS](./SPEC-FEDERATED-PARTICIPANTS.md) FR13 and FR14 | none |
| FR17 | The platform does not offer to package the conversation itself as a downloadable file, because an assistant reads channel history with its own bearer and applies no per-message visibility filter | Enabler | Yes | none - the boundary is the absence of the surface; what would make the capability offerable is a re-read with the requestor's bearer, which is not performed |
| FR18 | A HIDDEN member reads and observes in real time without a send capability and without appearing in the membership list, enforced by Amazon Chime SDK rather than by application code | Enabler | Yes | none |
| FR19 | A guest reaches exactly one conversation | Table stakes | Partly - bounded by the vend requiring a `channelArn` and by Amazon Chime SDK membership, not by the classification tag, which is a known asymmetry rather than a settled design | `a-guest-reaches-one-conversation` (unit, source text) |
| FR20 | A permissions policy compares the caller's asserted `classification` principal tag with the resource's `classification` tag, so a service or a resource policy can read the caller's class without knowing which role they hold | Enabler | No | none - the key-case question it depends on is settled live by `backend/scripts/deny-test-tag-key-case.mjs` |
| FR21 | Tier drift reads as an honest refusal naming neither the material nor the classification that holds it, rather than a fabricated answer | Table stakes | Partly - the hard block is the Layer 4 denial (FR9); the refusal wording is profile instruction text, so it shapes the answer rather than enforcing anything | none |
| FR22 | The caller is resolved once per request, to an AppInstanceUser ARN: at the edge authorizer for a token-authorized route, through the `Identities` index `(issuer, subject) -> AppInstanceUser ARN`, and from the vended session's role session name for an IAM-authorized route. No handler reads a provider claim to learn who the caller is (§4e) | Table stakes | Partial - the edge authorizer (`backend/lambda/src/edge-authorizer.ts`) resolves a token's (registry issuer, declared subject) through `Identities`, and every handler asks `callerPersonId` (`backend/lambda/src/lib/auth.ts`), which reads the edge authorizer's context or a console session from its name; not verified on a deployment | `a-person-is-their-app-instance-user.test.ts` (unit, source scan), `lib/auth.test.ts` (unit) |
| FR23 | A human is one AppInstanceUser whichever issuer signed them in, with an opaque id the credential exchange creates once; an issuer's subject is only a way to obtain a session as it. The admin-plane AppInstanceUser is the one second principal a human holds, created by the exchange and tagged with its owner (§4e) | Table stakes | Partial, **NOT VERIFIED** on a deployment - both credential exchanges mint the person through `mintOrResolvePerson` (`backend/lambda/src/lib/person-identity.ts`), a UUID v7 id recorded in `Identities` and keyed by the issuer's registry id and the subject; the admin-plane id is `${personId}-admin`, tagged `owner` by the admin credential exchange (`ensureAdminIdentity` in `backend/lambda/src/admin-credential-exchange.ts`) | `backend/test/lib/person-identity.test.ts`, `backend/test/credential-exchange.test.ts`, `backend/test/only-the-exchange-writes-identities.test.ts` |
| FR24 | A conversation's audience is fixed at creation by its classification and type, and no automatic path (notice, recap, summary, retrieval, task hint) writes content from inside that audience into a conversation whose audience is wider. Context moves outward only when a person posts it (§3, the audience rule) | Table stakes | Partly - a reply or recap whose audience is wider than a targeted message's target is given no targeted message (`backend/lambda/src/lib/async-processor-core.ts`), and the event creator posts nothing into the conversation it concerns. **NOT BUILT:** the parent link is Metadata rather than a tag, and no classification declares a read-only grant (§3) | `a-private-brief-never-reaches-a-public-reply` (unit, behavior), `a-typed-conversation-posts-nothing-into-the-concerned-room` (unit, behavior) |
| FR25 | Context moves inward only through a declared grant: an inside classification's principals reach an outside classification's conversations because the inside classification's `grants` declare it (ADR-046), at the action level the grant names, and the grant is deny-tested in both directions | Table stakes | No - no classification grant is declared read-only at the action level, and no deny-test covers either direction of an inside-outside pair | none |

**Reading the "Validated by" column.** A **deny-test** is the strongest evidence in this repository and is called out where one exists: it runs against a deployed stack and lets IAM or Postgres decide, rather than asserting what the code intends. Live deny-tests are `backend/scripts/deny-test-*.mjs` plus the `verifyClassificationBoundary` data-plane op and the `assistant-classification-boundary` e2e phase. Unit tests live in `backend/test/` (the analytics ones under `backend/test/analytics-aurora/`); end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../../reference/e2e-coverage-matrix.md). The status in brackets is what the test does, which matters more than that it is green:

- **behavior** - executes the code path and asserts on the result.
- **synthesized policy** - asserts the IAM document CDK emits, so a widened boundary fails the build before a deploy.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong number.
- **none** - no test exists.

**Known limits on the delivered rows.** FR5 fails closed: a turn the vend refuses does not act, and the processor's own role holds no Amazon Bedrock or data grant to act with (`assistant-profile-stack.ts`, `adoptTurnIdentity` in `assistant-async-processor.ts`). It holds no Amazon Chime SDK grant for alerts: it raises an admin alert as an `ae.alert` event, through `events:PutEvents` on the default bus conditioned on that source (`errAlert.grant(processorRole)`, `alertEmitterWiring`), and the `AdminServices` stack posts it into the admin notification channel as the admin assistant. What remains wider than one bot is the out-of-turn producers listed in FR5, the flow's reads, which run on its own role across the whole app instance with no condition, and the router's own-role grants listed in FR5. FR12 is report-only by default, so a finding is a guarantee that somebody is told rather than a guarantee that a wrongly-added member is gone. FR16's gap is policy and discipline rather than mechanism, and FR17 does not close it: declining to write transcript files is not a guarantee that a model cannot be induced to repeat targeted content in an ordinary reply.

FR20 depends on nothing else and is not blocked: the casing question that made it doubtful is settled, and what is missing is the policy itself.

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| Copy and paste, and relaying content verbally or through an external tool | Information control is not DRM. A person who may read something can always move it, and a control that claimed otherwise would be the most misleading line in this document | Organizational policy. Nothing here enforces it, and nothing here implies it does |
| Retroactive reclassification of a conversation | A channel's classification is fixed at creation and `UpdateChannel` cannot change a tag, which is what makes every reader able to trust it without a version check | Create a new conversation. [SPEC-CONVERSATION-TYPES](../conversation/SPEC-CONVERSATION-TYPES.md) sets the classification at creation |
| A per-person cap that serves a lower assistant into a higher room | It made "a downgraded answer" a real operating mode, let two members of one conversation be answered at different classifications, and decided nothing Layer 1 had not already decided - while adding a failure mode where a throttled clearance lookup silently routed a premium turn to the basic assistant | FR2. One conversation, one classification, and IAM decides it |
| Evaluation or a quality score as an isolation signal | A percentage from a sample read after the fact could never be the guarantee, and reporting one risks reading as though the matter were handled | [SPEC-EVALUATION](../quality/SPEC-EVALUATION.md), which puts leak detection out of its own scope for the same reason |
| Denied-topics filtering by default | The provisioned guardrail policy is content safety, PII and word filtering. A denied-topics policy is a deployment's own judgment about its own subject matter, and shipping a default one would imply a coverage nobody authored | FR11. A deployer adds a guardrail carrying a denied-topics policy to the catalog and selects it on a profile |
| Hiding conversations from the admin console | Administration spans classifications by design, because an operator who cannot read a conversation cannot review it | [SPEC-ADMIN-IDENTITY](./SPEC-ADMIN-IDENTITY.md) bounds the authority instead: separate identity, one channel, short-lived, audited |
| A multi-valued classification assertion on one principal | A principal carries one short enum token and config expands it where the policy is generated; a delimited list on the identity would be unreadable and impossible to extend without rewriting every principal | FR8 refuses an undeclared combination loudly. Closing it means declaring the combination or changing the identity assertion |
| Tag-gating WHO a membership change adds or removes | `CreateChannelMembership` and `DeleteChannelMembership` are authorized against the channel and the bearer, which are conditioned for every service that changes membership bearing an assistant (`membershipAsAssistantStatements`); the member is `MemberArn`, a request parameter IAM never evaluates (measured by `backend/scripts/deny-test-assistant-membership.mjs`), so no condition can name it | FR7 for the write-time gate, FR12 for the backstop, and Amazon Chime SDK's own moderator model underneath both |
| Cost-allocation tags as an access signal | `Project` / `Codebase` / `Instance` / `Environment` / `ManagedBy` are applied at the app root for attribution. They share the tagging mechanism and nothing else | [TAGGING.md](../../../guides/admin/TAGGING.md). No IAM condition in this document reads them |

## User Experience Description and Mocks

This document has no user-facing surface of its own. What an operator and a developer actually do with it is four things, and each is a command or a read rather than a screen.

**An operator confirms a boundary is in force rather than trusting that it is.** Reading a classification tag back off a deployed resource is one call, and the `identity-classification` e2e phase makes the same check against the deployment. Running a deny-test is how the answer stops being a reading of policy and becomes IAM's own: `deny-test-credential-exchange.mjs` provisions a real channel and shows the same send allowed bearing the caller's own identity and refused bearing another's, and `deny-test-session-classification.mjs` reads the trust condition off the deployed roles before testing it.

**An operator responds to a membership finding.** The finding arrives as an in-app message in the admin conversation plus an email, names the member and the channel, and is listed in the console's membership audit. In the default configuration the operator revokes it; flipping the enforce toggle in the console's Security tab (the `config/enforce` item in the audit table, read at runtime with no redeploy) makes the consumer revoke instead, at the cost that a false positive removes a legitimate member. `-c membershipAuditEnforce=true` sets only the default the toggle starts from. Both readings of that trade-off are defensible, which is why it is a switch rather than a default.

**A developer changes a boundary by editing config, not policy.** Classifications and what each grants live in one place, and the channel gate, the Cognito groups, the exchange roles, the context prefixes and the Aurora reader scope are all generated from it, so a boundary cannot be widened in one of those five and left narrow in the others. The synth test asserts the generated document, so the edit either produces the boundary the developer meant or fails the build.

**A person meets the boundary once, as a refusal.** An invite of a person not cleared for the classification returns a clear error naming the recipient's access and the tier the conversation requires, rather than a silent add. A request the room cannot reach is answered by saying the information is not available at this conversation's access level and suggesting a private conversation, without naming what would hold it. That wording is instruction text on top of the Layer 4 denial, so it shapes the refusal rather than being the control (FR21).

**OPEN:** whether the guest asymmetry in FR19 is closed by declaring `guest` as a classification that grants only itself, which would make the guest row answerable from the tag like every other row, or left as an admission-scoped exception with the reasoning stated. The requirement records the asymmetry; it does not decide it.

## Related Documents

- [SPEC-CREDENTIAL-EXCHANGE.md](./SPEC-CREDENTIAL-EXCHANGE.md) - the vend that pins every principal and carries the session tags FR6 depends on
- [IDENTITY-AND-ACCESS-MODEL.md](./IDENTITY-AND-ACCESS-MODEL.md) - the reference account of who can do what and which primitive enforces it
- [ACCESS-CONTROL-BY-EXAMPLE.md](./ACCESS-CONTROL-BY-EXAMPLE.md) - the same boundaries walked as concrete blocked interactions
- [PERSONAS.md](../../../overview/PERSONAS.md) - the canonical definitions of the personas above
- [SPEC-FEDERATED-PARTICIPANTS.md](./SPEC-FEDERATED-PARTICIPANTS.md) - the federated-guest admission model Layer 7 builds on
- [SPEC-ACCESS-AND-CONTROLS-AUDITING.md](./SPEC-ACCESS-AND-CONTROLS-AUDITING.md) - the three detection triggers behind FR12
- [SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md](../conversation/SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md) - the archive mechanism behind FR13
- [ADR-017](../../../design/decisions/017-conversation-archive-mechanism.md) - archive as mark-plus-read-only via tag
- [ADR-028](../../../design/decisions/028-vector-store-classification-boundary.md) - the retrieval privilege behind FR10
- [ADR-042](../../../design/decisions/042-an-assistant-acts-in-exactly-one-classification.md) - the assistant boundary behind FR3
- [ADR-046](../../../design/decisions/046-classifications-are-a-set-not-a-ladder.md) - why the axis is a declared set rather than a ladder
- [TENETS.md](../../../overview/TENETS.md) - tenet P4, which this document is the implementation of
- [Creating read-only chat channels for announcements with Amazon Chime SDK messaging](https://aws.amazon.com/blogs/business-productivity/creating-read-only-chat-channels-for-announcements-with-amazon-chime-sdk-messaging/) (McHarg, 2021) - the read-only-channel pattern behind FR13 and FR18

---

The rest of this document is the mechanism: the layers, the tag schema, the access matrices and the policy shapes the requirements above are satisfied by. Section numbers are retained because other documents cite them.

## 1. The Problem

When a Premium user and a Basic user are in the same conversation, the Premium agent can surface financial data, board minutes, or competitive intelligence into a channel the Basic user can read. Context isolation (S3 prefix-based IAM) controls what the agent can **read** - but not what it **writes** into the channel.

The solution requires **seven defense layers** (Layers 1 through 6, with Layer 4b beside Layer 4, plus Layer 7 for mixed trust), any one of which should prevent the leak independently.

## 2. Defense-in-Depth Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Channel Tags (IAM Condition Keys)                  │
│ Channels tagged with classification at creation.            │
│ IAM policies use tag conditions to block operations on      │
│ channels outside the principal's grant set.                 │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: Channel Metadata (Application-Level)               │
│ classification field in Amazon Chime SDK channel metadata.  │
│ All Lambda handlers read metadata before membership ops.    │
├─────────────────────────────────────────────────────────────┤
│ Layer 3: User Tier (Cognito Groups)                         │
│ Tier is a Cognito group, not a stored user tag.             │
│ Lambdas resolve tier via AdminListGroupsForUser.            │
├─────────────────────────────────────────────────────────────┤
│ Layer 4: Agent IAM (S3 Prefix Scoping)                      │
│ Each assistant's S3 access is scoped to the prefixes its    │
│ classification grants. It cannot read outside that set.     │
├─────────────────────────────────────────────────────────────┤
│ Layer 4b: Retrieval scoping (vector store)                  │
│ Embedded content reaches the model without passing through  │
│ Layer 4 at all. A per-classification database role + RLS,   │
│ plus the SQL filter as depth (ADR-028). See §7a.            │
├─────────────────────────────────────────────────────────────┤
│ Layer 5: Bedrock Guardrails (Content Safety)                │
│ Content, PII, and prompt-injection filtering on every turn, │
│ selectable per profile. Isolation itself is Layers 1+4.     │
├─────────────────────────────────────────────────────────────┤
│ Layer 6: Kinesis Stream Audit (Async Enforcement)           │
│ A dedicated consumer (membership-audit.ts, NOT the archival │
│ Lambda) reads membership events. Flags; revokes only when   │
│ enforce is on. See §9.                                      │
└─────────────────────────────────────────────────────────────┘
```

## 3. Conversation Types and Classification

### Types

| Type | Classification | Members | Agent | Use Case |
|------|---------------|---------|-------|----------|
| **Private** | Creator's tier | 1 user + 1 agent | Creator's tier agent | Default. Private AI assistance. |
| **Team** | Set at creation | Multiple users + 1 agent | Classification tier agent | Collaboration at a specific tier level. |
| **Open** | `basic` | Any user + basic agent | Basic agent | Broad collaboration. Public context only. |

### The classification invariant

Everything below is a consequence of one rule, stated here because it is the design and not an implementation detail:

> **An exchange happens between parties that all hold the channel's single classification.**

Three parts, each exactly one value:

1. **A channel has exactly one classification.** Set at creation, immutable, carried on the channel TAG. A channel with no classification tag is not "unclassified" - it is a fault: a reader that cannot find it resolves to `undefined`, logs a `[SecurityEvent]`, and the caller refuses; there is no floor (ADR-046).
2. **An assistant is ASSIGNED exactly one classification.** It does not classify itself and has no say in it: the deployment assigns it, the stack stamps it on the serving Lambda, and the assistant carries it. An assistant answers at its assigned classification or it does not answer.
3. **A person holds one or more classifications** (their Cognito-group clearance). This is an INDEPENDENT axis - a person may hold several - and its only relation to the other two is the constraint below.

**The axis is a SET, and it is not ordered at all (ADR-046).** A channel, a document and an assistant each carry exactly one classification, and what a PRINCIPAL may reach is `grantsFor`: that classification's declared `grants`, which every classification states and none inherits. There is no order to the axis: a deployment may declare `legal` and `finance`, where neither is above the other, so `grantsFor` is the only reach question. The shipped sample declares prefix-shaped sets, which is why the familiar triangular pattern appears.

> **The model above is ahead of the identity assertion, and the gap is stated rather than smoothed over.** A principal carries ONE short enum token - its classification `value` - and config expands that token into the grant set where the policy is generated. `ProfileRegistry.clearanceForGroups` therefore resolves a person's Cognito groups to a **single** token: the declared classification whose own `grants` ARE the union of what they hold. For any combination a deployment has named, that is exact. It is NOT general: a person holding a combination the deployment has not declared resolves to NO token and is refused a credential with a logged security event. That is loud rather than silent, but it is still single-valued. Closing it means either a multi-valued identity assertion or declaring the combination.

**A participant who does not reach the channel's classification does not belong in the exchange.** Not "is served a downgraded answer", not "is capped at what they may see" - does not belong. Layer 1 making a wrongly-added participant inert is a **backstop for an admission that already went wrong** (for a person; see Layer 6 for the assistant case). Its firing is the signal, never the resolution. A control that never fires is still the control that catches the day admission fails, so it stays; treating it as the normal operating mode is the error.

**There is no per-person min-cap, and its absence is part of that same principle.** Such a cap serves a lower assistant into a higher room, which makes "downgraded answer" a real operating mode and lets two members of one conversation be answered at different classifications - not a property a conversation can coherently have, and nothing in the room would explain it. It also decides nothing Layer 1 has not already decided: the channel-scoped allow is applied to the Cognito user roles as well as the assistant roles and is fail-closed, so a message reaching the router is proof that IAM permitted this person to act on this channel. What it does add is a failure mode - a clearance lookup that answered a default classification for any Cognito fault would let a throttle during a turn in a premium conversation quietly route it to the basic assistant: a worse model and a narrower context, in a room IAM was willing to serve at premium, with nothing said to anybody. An unresolvable clearance is `undefined` rather than any classification, so "we could not establish who this is" and "they hold the least-privileged classification" are distinct answers and the caller refuses on the first. One conversation, one classification, and IAM decides it.

It follows that any disagreement between the assistant that answered and the channel it answered in is a defect in **either** direction, and is reported as one.

**`admin` is a classification, and its conversational runtime is not deployed.** It has a clearance group (`admins`), an authenticated role, a profile (`admin-agent`) and a `grants` set naming itself alone: holding it clears a chat identity for admin conversations and for no member conversation ([SPEC-ADMIN-IDENTITY](SPEC-ADMIN-IDENTITY.md) FR1, the two-identity split). Reach across every conversation is admin access, through the console and the `${personId}-admin` identity, never a classification, so `widestReachingValue` excludes the admin plane. It is NOT where unclassifiable content is stamped: `failClosedContentValue` excludes the admin plane precisely so such content stays readable in ordinary conversations, and it is the conversational classification the fewest holders reach. What it does not yet have is a router, a processor or a task service: the SSM tree publishes `/assistant/admin-agent/bot-arn` and none of the `router-arn` / `processor-arn` / `task-service-arn` keys the other classifications carry. An `admin`-classified channel therefore has an assistant that can hold it and own it, and cannot yet answer in it.

### The audience rule

**A conversation has one audience, fixed at creation by its classification and its type.** Two conversations about the same subject, one internal and one with a customer, are two audiences, and nothing moves between them except by one of two routes:

- **Inward, through a declared grant.** An inside classification reaches an outside one only because the inside classification's `grants` declare it (ADR-046), recorded in that classification's definition. A grant states its action level: a classification that may read an outside conversation without posting into it holds the read actions on that classification's channels and no `SendChannelMessage`. Every such grant is deny-tested in both directions (tenet D12): nothing at the outside classification reaches the inside one, and the inside session holds no action on outside channels that its grant does not name.
- **Outward, only when a person posts it.** No automatic path - a notice, a join recap, a summary, a retrieval, a task hint, or an assistant's own reply - writes content from inside an audience into a conversation whose audience is wider. An assistant's history in such a conversation excludes the targeted messages it can read, because what the model is not given it cannot repeat. A link between two conversations is a resource tag on one channel naming the other, written by the creator, never member-writable Metadata, and membership of one grants nothing in the other.

**NOT BUILT:**
- The event creator refuses a concerned conversation at another classification (`backend/lambda/src/typed-conversation-from-event.ts`, "refusing rather than linking across a classification boundary") rather than linking under a declared rule.
- A parent link is written to channel Metadata (`parentChannelArn` in `metadataExtras`, `backend/lambda/src/lib/channel-creation.ts`) and read back as a fallback (`channelMeta.parentChannelArn`, `backend/lambda/src/router-agent-handler.ts`), not as a channel tag.
- No classification declares a read-only grant, because every exchange role holds one channel action list (`EXCHANGE_MSG_ACTIONS`, `backend/lib/constructs/exchange-role.ts`), and no deny-test covers an inside-outside pair in either direction.

### Creation Rules

- Classification is set at creation time and **cannot be changed**
- Classification is enforced by **channel tags** (IAM layer) AND **channel metadata** (application layer)
- A user cannot create a conversation at a classification their clearance does not reach
- A Premium user who wants to include Basic users creates an Open conversation

### Multi-user response gating

In a multi-user conversation the assistant responds only when it is addressed: `@assistant` or `@all` is required for the bot to reply. `backend/lambda/src/channel-flow-processor.ts` enforces this mention-required behavior. `lib/channel-creation.ts`, through which every creator creates, associates the channel flow to every new channel.

## 4. Layer 1: Channel Tags (IAM Condition Keys)

Amazon Chime SDK channels support resource tags. Tags are set at creation and can be used in IAM policy conditions to block actions on tagged resources.

### Tag Schema

**One key, `classification`, on every resource the boundary judges.** The value is always a classification this deployment declares in `backend/lib/config/profiles.ts` (`basic` / `standard` / `premium` out of the box) - never a tier name, never a sentinel, never a label invented at the call site. Same key and same vocabulary on a channel and on an identity, so `aws:ResourceTag/classification` means the same thing on both ends of an exchange.

| Resource | Value | Written by | When |
|---|---|---|---|
| **Channel** | the conversation's classification | `lib/channel-creation.ts`, `create-conversation` (typed and context requests, through `create-conversation-at-classification`), a host's add (`membershipHandler` in `conversation-management`), `proactive-briefing`, `admin-notification-channel-provision` | at `CreateChannel`, in the create call |
| **AppInstanceBot** (assistant) | the classification the assistant is **assigned** | `lambda/src/lib/assistant-provisioner.ts` (`provisionerTags`) | at `CreateAppInstanceBot`, in the create request; every assistant identity is built there |
| **AppInstanceUser** (person) | the person's clearance token | `credential-exchange.ts` (from `clearanceForGroups`), `user-management.ts` | a best-effort `TagResource` after the identity exists, re-applied on every credential exchange, and on every clearance change |

Three rules govern it:

1. **On a channel and on a bot, set it in the create call, never by a following `TagResource`.** A provision that dies between the two leaves a resource that is permanently unclassified. `TagResource` is for REPAIR of resources that already exist - bots and channels are RETAINed and never recreated - not for initial classification. A person's identity is the opposite case: `CreateAppInstanceUser` with `Tags` requires `chime:TagResource` as well, so coupling the tag to the create turned a missing permission into a total authentication outage (`credential-exchange.ts`); the tag is therefore a separate best-effort call, and because it runs on every vend a failure heals on the next one. That tag is readable by an auditor and is not an IAM input (see §4d).
2. **Absent is unclassified, and is never defaulted.** A reader that cannot find the tag must treat the resource as unclassified and fail closed - `readChannelClassificationTag` (`lib/channel-classification.ts`) resolves to `undefined`, logs a `[SecurityEvent]`, and the caller refuses; there is no floor (ADR-046). It must NOT infer one: an inferred classification reads as authority the resource does not carry.
3. **Immutable in practice.** A channel's classification is fixed at creation and `UpdateChannel` cannot change a tag. An assistant's is fixed by its deployment. Only a person's moves, and only on a clearance change, which re-stamps it.

A tag is an **input to enforcement, not the enforcement itself.** What gates a request is the classification-bound role the credential exchange vends plus the IAM conditions below. The tag is what makes the same fact readable on the resource, so an auditor compares two values of one kind rather than deriving one of them per check.

**Key case: `classification` lowercase on channels, assistants and people.** A separate **`Classification`** (capital) is applied by CDK to every resource in a classification stack, which is how the per-classification Lambda roles carry theirs. The two are different keys written by different mechanisms, and the difference matters the moment a policy compares a principal tag to a resource tag - see the section on sessions and principal tags below.  When creating a channel or an identity, write the lowercase key.

**Not to be confused with the archive's columns.** `messages.assistant`, `messages.conversation_classification` and `messages.user_clearance` record what a *turn* ran under, at the instant it ran. They are historical facts stamped by the producer, not reads of these tags - a person's clearance moves, so the tag answers what they hold now and the column answers what they held then.

When creating a channel:

```bash
aws chime-sdk-messaging create-channel \
  --app-instance-arn "$APP_INSTANCE_ARN" \
  --name "Q3 Planning" \
  --privacy "PRIVATE" \
  --mode "RESTRICTED" \
  --tags Key="classification",Value="premium" Key="conversationType",Value="team" \
  --chime-bearer "$BOT_ARN"
```

When creating an assistant:

```bash
aws chime-sdk-identity create-app-instance-bot \
  --app-instance-arn "$APP_INSTANCE_ARN" \
  --name "Assistant-premium" \
  --tags Key="classification",Value="premium" \
  --configuration '{"Lex":{...}}'
```

Reading it back - the check the `identity-classification` e2e phase makes against the deployment:

```bash
aws chime-sdk-identity list-tags-for-resource --resource-arn "$BOT_ARN"
```

**These tags are NOT the cost-allocation tags.** `Project` / `Codebase` / `Instance` / `Environment` / `ManagedBy` are applied once at the app root for cost attribution and are documented in [TAGGING.md](../../../guides/admin/TAGGING.md). They share the mechanism and nothing else: no IAM condition in this document reads them, and nothing here is a cost signal.

### IAM Policy Conditions: fail-closed ALLOW

> **Two properties of this enforcement design - see `agent-classification-common.classificationChannelScopedAllow`:** 1. **Condition key is the GLOBAL `aws:ResourceTag/classification`, NOT `chime:ResourceTag`.** Amazon Chime SDK exposes **no service-specific condition keys**, so `chime:ResourceTag/...` never exists in the request context and any condition on it silently no-ops (a basic member could still send into a premium channel). The global `aws:ResourceTag` IS populated for the tag-aware channel actions. 2. **Channel-message actions authorize against TWO resources** - the **channel** AND the caller's **bearer identity** (`.../user/<id>` or `.../bot/<id>`). The classification boundary on the CHANNEL resource is the reach boundary; the bearer-resource grant is the impersonation boundary and is narrowed by identity. For a person it is narrowed to the one identity the session may act as, by the resource pattern `.../user/${aws:PrincipalTag/person}` (SPEC-CREDENTIAL-EXCHANGE, the model). For an assistant it is narrowed the same way: the acting role's bearer is `.../bot/${aws:PrincipalTag/bot}`, the bot the vend minted the turn's session for, **conditioned on `aws:ResourceTag/classification` equal to that role's own classification** (`assistantActingRole`, SPEC-CREDENTIAL-EXCHANGE, the assistant pin). The router's role, and the roles that still post as an assistant out of turn, hold `/bot/*` under the same classification condition, so they reach that classification's bots and no other classification's, including the untagged bots earlier deployments created and replaced before the provisioner deleted what it created (`create-bot`, delete branch). The older reading, that the bearer grant may be left on `/user/*` and `/bot/*` because "Amazon Chime SDK restricts the bearer to the caller's own identity", holds for a federated person whose credentials ARE an identity, and does not hold for a Lambda execution role, which has none: the bearer it passes is checked only against the resource pattern and the conditions on it. So an unconditioned wildcard bearer on a role is a real widening wherever more than one identity matches it, and the channel flow's role still holds one for reads: `ListChannelMemberships`, `ListChannelModerators`, `GetChannelMessage` and `ListTagsForResource` on `${appInstanceArn}/*` with no condition (`channel-flow-stack.ts`), so it can read bearing any bot or user of any classification (**NOT BUILT**: narrowing it).

The enforcement uses **ALLOW**, not Deny, because **allow fails CLOSED**: a classification's identity is granted the channel action ONLY when the channel's `classification` ∈ its declared `grants` set; an **untagged** channel, or one carrying a classification outside that set, matches no grant → implicit deny. (A deny-on-what-is-outside fails OPEN on untagged and legacy channels - a real hole.)

```jsonc
// A person's classification role - TWO statements per the resource split:
// (1) channel resource, tag-gated  → the boundary. These eight are EXCHANGE_MSG_ACTIONS
//     (lib/constructs/exchange-role.ts), what a role receives; the helper's maximum is the ten in
//     CLASSIFICATION_GATED_CHANNEL_ACTIONS, which adds RedactChannelMessage and DeleteChannel and
//     which no principal is granted in full.
{ "Effect": "Allow",
  "Action": ["chime:SendChannelMessage","chime:GetChannelMessage","chime:ListChannelMessages",
             "chime:DescribeChannel","chime:ListChannelMemberships","chime:ListChannelModerators",
             "chime:UpdateChannelReadMarker","chime:UpdateChannel"],
  "Resource": "arn:aws:chime:...:app-instance/<id>/channel/*",
  "Condition": { "StringEquals": { "aws:ResourceTag/classification": ["basic"] } } },
  // a PERSON's role: the classification's declared grant set (in the shipped sample,
  // standard→["basic","standard"]). An ASSISTANT's role: its own classification alone (ADR-042),
  // whatever its classification grants, and with the narrower turn action set.
// (2) bearer identity resource: the IMPERSONATION boundary, narrowed to the identities this
//     session may act as. A person pins by ARN pattern (the user ARN ends in the caller's own
//     sub). An assistant's acting role names the one bot its per-turn session was minted
//     for, by the same ARN-variable construction. The router's role reaches `/bot/*` of
//     its own classification by a tag condition; the channel flow's role still reads on
//     `${appInstanceArn}/*` unconditioned (NOT BUILT: narrowing it).
{ "Effect": "Allow",                                    // a person's classification role
  "Action": [ /* same actions */ ],
  "Resource": "arn:aws:chime:...:app-instance/<id>/user/${aws:PrincipalTag/person}" }
{ "Effect": "Allow",                                    // an assistant's acting role
  "Action": [ /* the turn action set */ ],
  "Resource": "arn:aws:chime:...:app-instance/<id>/bot/${aws:PrincipalTag/bot}",
  "Condition": { "StringEquals": { "aws:ResourceTag/classification": "premium" } } }
```

**Per-tier classification sets (allow):**

| Identity | Channel `classification` it may act on |
|----------|----------------------------------------|
| Basic person (user role) | `{basic}` |
| Standard person | `{basic, standard}` |
| Premium person | `{basic, standard, premium}` |
| Any assistant | its own classification alone (ADR-042) |
| Admin chat identity (`admin` vend role) | the admin plane's own classification alone; a person holding `admins` beside a member classification adds admin-plane channels through the `adminPlane` session tag (`exchangeVendStatements`) |
| Admin-plane identity (`${personId}-admin`, `ExchangeRoleAdminPlane`) | any channel, unconditioned - administration spans classifications; every vend is narrowed to one channel by its session policy |

Per-member membership changes (`CreateChannelMembership` / `DeleteChannelMembership`, and the moderator changes `CreateChannelModerator` / `DeleteChannelModerator`) are authorized against the **channel** and the **bearer**, never against the member: `MemberArn` is a request parameter IAM does not evaluate (measured by `backend/scripts/deny-test-assistant-membership.mjs`, which found a Deny on the member's ARN never consulted). Every membership grant a platform service holds is conditioned on the conversation's classification:

| Bearer | Roles | Channel leg | Bearer leg | Helper |
|---|---|---|---|---|
| An assistant | Share, Battle Mode, a host's remove (`membershipHandler`, the leave alone), the group-membership reconcile | `${appInstanceArn}/channel/*` with `aws:ResourceTag/classification` in the role's classifications | `${appInstanceArn}/bot/*` with the same condition | `membershipAsAssistantStatements` |
| The service admin, on the admin plane | User deletion, archive and removal, the membership audit and its admin API, the admin notification provisioner (any declared classification, the admin plane's included); the admin conversation sync (the channels `adminConversationArns` names, exactly) | `${appInstanceArn}/channel/*` with `aws:ResourceTag/classification` in every declared classification, or the named channels | The service admin's exact ARN | `adminPlaneMembershipStatements` |
| The service admin | The router's drift split, the conversation split, the typed-conversation creator, each classification's conversation creator (a host's context conversation included), the proactive briefing, a host's add (`membershipHandler`) | `${appInstanceArn}/channel/*` with `aws:ResourceTag/classification` in the role's classifications | The service admin's exact ARN, with no tag condition (the admin carries `classification=admin`, which matches no creator's classification) | `membershipAsServiceAdminStatements` |

Both helpers are in `agent-classification-common.ts`, and every creator tags the channel in `CreateChannel` itself, so the channel is classified before any member is added. Every creator creates only a conversation of its own classification: its `chime:CreateChannel` requires `aws:RequestTag/classification` present and equal to its own, its tag-on-create stamps only that value and only on a channel carrying no `classification` or the same one, and a conversation opened from another one is refused unless the origin's tag matches (`OriginClassificationMismatchError`). A person's conversation is created by that classification's own creator (`create-conversation-at-classification.ts`, one function and role per conversational classification in `conversations-stack.ts`), which the person-facing API invokes after its reach gate and which refuses a request for another classification; the API itself holds no Amazon Chime SDK grant. The `CreateChannel` and tag conditions are covered by the step 39 lines of `backend/scripts/deny-test-assistant-membership.mjs`, not yet run against a deployment. Every creator bears the service admin and holds no create, tag or membership change bearing an assistant (`driftChannelCreateStatements` refuses a role with no named admin at synth): a deployment with no service admin refuses creation rather than creating as an assistant (`NoServiceAdminError`, `channel-creation.ts`), and `only-declared-speakers-can-speak.test.ts` refuses a `CreateChannel` grant reaching a bot in any template, the admin notification channel's provisioner apart. `backend/test/only-declared-speakers-can-speak.test.ts` refuses any membership grant in a synthesized template that names a resource outside these two legs, except a person's own vended session (the browser roles and the admin identity's `manage-membership` session), whose bearer is pinned to the caller by a policy variable; it checks that each admin-plane role bears only the service admin on a classified channel. The share, Battle Mode, add-agent and federated sharing roles are deny-tested in `tests/e2e/no-platform-role-speaks-as-an-assistant.spec.ts`; the service-admin shape has its live check in `backend/scripts/deny-test-assistant-membership.mjs` (allowed on its own classification's channel, refused on another classification's and on an untagged channel), not yet run against a deployment. WHO is added is governed by Amazon Chime SDK's moderator model + the **app-layer membership admission gate** (below) + the **Layer 6 Kinesis audit**. This is the one statement of that fact; the sections below refer back to it rather than restating it.

**Why this is powerful:** enforced by **IAM itself**, before any application logic. A basic user's credentials physically cannot `SendChannelMessage` / `ListChannelMessages` on a premium- or untagged channel - `AccessDeniedException`. The resulting access (deny matrix): basic→basic SENT, basic(member)→premium DENIED, basic(member)→untagged DENIED, premium→premium SENT.

Channels are tagged at creation (`lib/channel-creation`, through which every creator creates); pre-existing channels are backfilled by `scripts/backfill-channel-classification-tags.mjs` (fail-closed needs every channel tagged).

### CDK Implementation

The boundary is defined once in `classificationChannelScopedAllow(classification, appInstanceArn, actions?, opts)` (`backend/lib/stacks/agent-classification-common.ts`) and attached to the **credential-exchange classification roles** (`exchangeVendStatements` in the `ExchangeRole` construct, `backend/lib/constructs/exchange-role.ts`, built by each classification's own `Assistants-<classification>` stack and, for the admin plane, by `identity-stack.ts`, bearer-pinned to the caller's own `.../user/${aws:PrincipalTag/person}`) and the **per-classification assistant roles** (`assistant-profile-stack.ts`). The `actor` option selects which boundary is built and is **required**, deliberately: `'person'` resolves to the classification's declared `grants`, and `'assistant'` resolves to `channelsAnAssistantMayActIn` - its own classification alone. A default would be wrong in one direction or the other, so the question is answered at compile time and a new call site cannot be added without answering it. There is no other role a person's credential is on: the deployment creates no Identity Pool, so the frontend reaches Amazon Chime SDK only through the exchange. See [IDENTITY-AND-ACCESS-MODEL.md](./IDENTITY-AND-ACCESS-MODEL.md), Related docs. `classificationChannelScopedAllow` is the sole enforced channel boundary.

## 4d. Sessions, principal tags, and what the identity tag does at evaluation time

**What is in force, and what is not.** "Where classification enters an evaluation" and "How a session is granted" describe the boundary in code. Of "Adding classification as a principal tag", the trust-policy half is in force and the permissions half is not. In force: every credential vend passes both a `person` and a `classification` session tag at `sts:AssumeRole` (`credential-exchange.ts` on the chat vend, `admin-credential-exchange.ts` on the admin-plane vends), and every exchange role's trust policy carries that same pair of conditions on `sts:AssumeRole` itself and repeats them on `sts:TagSession`, with `classification` equal to that role's own classification or `admin` on the admin-plane role (`vendTagPin` in the `ExchangeRole` construct, `backend/lib/constructs/exchange-role.ts`, and `ExchangeRoleAdminPlane` in `admin-services-stack.ts`, both built with `PrincipalWithConditions`). On the assistant side, every resource in a classification stack carries `classification=<value>` from `cdk.Tags.of(this).add('classification', classification)` (`assistant-profile-stack.ts`), and the acting role's trust policy requires `classification` equal to its own value, `role` among the assistant roles the deployment declares (`deployedRoles`), and `assistant` and `bot` present (`assistantActingRole`). Not in force: no permissions policy compares a principal's `classification` tag with a resource tag; the acting role reads its session's `role` tag (per-role context and telemetry) and `bot` tag (the bearer), and compares the resource's `classification` tag with literal values.

**One key, `classification`, everywhere.** Stack resources, sessions, channels and identities all carry `classification`, and every condition reads that key; `backend/test/only-declared-speakers-can-speak.test.ts` refuses a synthesized template with a `Classification` tag or a condition on one, so a cost report sees one key and no condition depends on how IAM folds case. IAM matches a principal tag key case-insensitively (measured): `backend/scripts/deny-test-tag-key-case.mjs` settles it with IAM deciding: a scratch role tagged `Classification=basic` whose only statement allows `ssm:GetParameter` where `aws:ResourceTag/classification` equals `${aws:PrincipalTag/classification}` reads a parameter tagged `classification=basic` and is refused one tagged `classification=premium`, and a same-case control behaves identically. So a principal-vs-resource condition across the two casings enforces rather than silently never matching. The script's third case measures the resource side (`aws:ResourceTag/Classification` against a lowercase tag); **OPEN:** its result is not yet recorded here.

The `classification` tag exists on three resource kinds (see the Tag Schema above). This section states exactly how a session is granted and which of those tags IAM reads when a request is evaluated, because the two are easy to conflate and the difference decides what the tag can be relied on for.

### Where classification enters an evaluation

Two operands, and **neither of them is a tag on the caller's AppInstanceUser**:

| Operand | Comes from | Condition key |
|---|---|---|
| What the caller may reach | the **role** they hold, written at deploy with its classification baked in | the role's own policy (an explicit list of allowed tag values) |
| What the resource is | the channel's **immutable tag**, set at creation | `aws:ResourceTag/classification` |

`classificationChannelScopedAllow` writes the first as a `StringEquals` list: the declared grant set for a person, and the single own classification for an assistant. So the evaluation is *role constant vs. resource tag*.

A tag on an **AppInstanceUser is a resource tag**. It produces `aws:ResourceTag/classification` for actions taken **on that user resource**, not `aws:PrincipalTag` for actions taken **by** them. Tagging an identity therefore does not, by itself, put the identity's classification into any decision about a channel. What it does is make the fact readable to the membership auditor, the archive, and any operator asking what an identity is - which is a real job, and a different one.

### How a session is granted

1. The caller presents an ID token to the credential exchange. Identity comes from the verified token, never the request body, and is the AppInstanceUser that token's issuer and subject resolve to (§4e). Today the token is a Cognito ID token and the identity is its `sub` claim.
2. The exchange resolves the caller's clearance from their groups (`clearanceForGroups`) and selects the matching classification role.
3. It calls `sts:AssumeRole` on that role with two session tags. **`person`** (the caller's AppInstanceUser id) is what the role's policy uses to pin the bearer to `.../user/${aws:PrincipalTag/person}`, so a caller can only ever act as themselves. **`classification`** carries the access class the exchange computed, and the role's trust policy refuses to tag a session whose `classification` differs from the role's own classification (see "Adding classification as a principal tag" below).
4. A requested capability narrows the vend further through an inline session policy, intersected with the role's boundary.

The classification is carried by **which role was assumed**. It is a deploy-time constant, not an assertion the caller makes, which is why it cannot be forged by a client.

### Adding classification as a principal tag

Two mechanisms make the caller's classification available as a principal tag, one per principal kind:

- **Assistants - already tagged.** The classification stack tags every resource it creates with `classification=<value>`. A per-turn assistant session additionally carries `assistant`, `classification`, `role` and `bot` as session tags, which the acting role's trust policy requires and its permissions read (`role` and `bot`). What is missing is any permissions condition that reads the principal's `classification` against a resource.
- **People - tagged on the identity and on the session.** The credential exchange stamps the caller's clearance onto their `AppInstanceUser` as a `classification` tag, and `backfill-identity-classifications.mjs` covers identities created before that tag existed. That identity tag is readable by an auditor but is **not** an IAM input, because it is on the Amazon Chime SDK resource rather than on the STS session. The IAM input is the `classification` session tag the exchange passes beside `sub` at `sts:AssumeRole` (`credential-exchange.ts`), and the exchange roles' trust policies require it to equal the role's own classification (`vendTagPin`, `backend/lib/constructs/exchange-role.ts`). `deny-test-session-classification.mjs` is the live deny test for that trust condition: it reads the condition off the deployed roles, then assumes a scratch role carrying the identical condition with a matching, a mismatched and an absent assertion.

What is in force is the **trust-policy half**: a session asserting a classification other than its role's cannot be minted. What is not is the **permissions half** shown next: no policy compares `${aws:PrincipalTag/classification}` with a channel's `aws:ResourceTag/classification`. Such a policy would require the caller's asserted classification to match the resource:

```json
{
  "Condition": {
    "StringEquals": {
      "aws:ResourceTag/classification": "${aws:PrincipalTag/classification}"
    }
  }
}
```

The trust policy that refuses a mismatched assertion is in force. On each exchange role, the `sts:TagSession` statement carries this condition, with the role's own value (`admin` on the admin-plane role):

```json
{
  "Condition": {
    "StringLike": { "aws:RequestTag/person": "*" },
    "StringEquals": { "aws:RequestTag/classification": "premium" }
  }
}
```

### What this adds, and what it cannot do

The trust-policy half adds two things: a tagged session (and every exchange vend is tagged, because `person` is required) **cannot be minted without a classification assertion**, and the assertion **must agree with the role** that carries it, so a mis-vended role and a mismatched assertion cannot combine. The permissions half would add a third: other services and resource policies could read the caller's classification without knowing which role they hold.

**It does not replace the role.** IAM condition operators compare strings; they do not compare ranks, and a session tag holds one value rather than a set. `${aws:PrincipalTag/classification}` equals a resource tag or it does not, so neither an ordered ladder nor a grant set can be expressed this way. The set stays where it is: an explicit list of permitted tag values on a per-classification role, written at deploy from `profiles.ts`. The principal tag is an **equality cross-check layered over** that, not a replacement for it.

**And the set is a GRANT, with nothing behind it.** A principal's reach is `ProfileRegistry.grantsFor`, which returns a classification's declared `grants`. Every classification declares one and there is no fallback, because a default would re-impose a ladder on deployments that never asked for one: an absent set means an unknown classification, and the honest answer to what an unknown classification reaches is nothing. A type like `admin` may grant `['basic', 'premium', 'admin']` - a set no rank comparison can describe - because a real taxonomy is rarely a single ladder. The principal still carries **one short enum token** (its classification `value`); the set lives in config and is expanded where the policy is generated, because a tag is one bounded Key->Value and a delimited list on the identity would be unreadable and impossible to extend without rewriting every principal.

This costs the resource side nothing: a conversation, a document and an assistant each still carry exactly one classification, and that axis stays closed. It is not ordered, so `grantsFor` is the only reach question - a holder's reach and "what sits below this" are not the same question once a type can grant a non-contiguous set.

**What the classification assertion is actually for, given that.** It does not decide reach; the role does. It binds the session to the role it was vended on: a session asserting `basic` cannot be minted on the role that carries premium's grant set. That catches a mis-vend, which is the one failure the role alone cannot catch, because the role's own policy is correct in that scenario and simply handed to the wrong caller. The exchange asserts the access class `resolveRoleKey` returns and reads the role ARN for that class from the SSM key the role's stack publishes it under (`exchangeRoleArnKey`, `backend/lib/constructs/exchange-role.ts`; `resolveExchangeRoleArn`, `backend/lambda/src/lib/exchange-role-arn.ts`), and the trust condition makes AWS refuse any vend where the role reached is not the role for the asserted class, such as a wrong or swapped published ARN. This check lives on the trust policy, so a mismatch fails at `sts:AssumeRole` with an explicit error rather than minting a session whose every later call is denied.

**Order of deployment matters, and getting it wrong is an outage.** A role condition that requires a session tag denies every vend on that role for any exchange code that does not pass the tag, which is total loss of Amazon Chime SDK credentials for every caller: the same shape as the tag-on-create coupling recorded in `credential-exchange.ts`. So the exchange passes the tag on every vend path before a condition requires it, and the same rule applies to any future permissions condition that reads `${aws:PrincipalTag/classification}`.

**What is not in force, stated precisely.**

- **A principal-vs-resource tag condition.** No permissions policy on an exchange role or an assistant role compares `aws:PrincipalTag/classification` (or `Classification`) with `aws:ResourceTag/classification`. Reach on a channel is decided only by the role's explicit list of allowed resource-tag values (`classificationChannelScopedAllow`).

So the summary: the role decides the reach set, the resource tag decides the target, and the session's `classification` assertion is required by the role's trust policy to agree with the role carrying it. No policy yet reads the assertion against the resource.

## 4e. Who the caller is

The bearer pin in §4d is only as good as the value it pins to, so the identity behind it is stated here as invariants.

**Identity invariants.**
- **A human is one AppInstanceUser, an assistant one AppInstanceBot, a conversation one channel**, and every record a person makes or owns is keyed by the AppInstanceUser id.
- **The id is opaque.** The credential exchange creates it once, the first time an issuer's subject signs in, and it is never a provider's subject claim or a value derived from one. No other path creates an AppInstanceUser.
- **An issuer is only a way in.** The `Identities` index maps `(issuer, subject) -> AppInstanceUser ARN`, and only the exchange maps a subject to a person; the subject provisioners pre-assign a `provisioned-only` issuer's subject as a `pending` row, which only the exchange binds. One human signed in through two issuers has two rows pointing at one AppInstanceUser, never two AppInstanceUsers and never an alias table. A row whose AppInstanceUser is gone resolves to nothing.
- **The admin-plane AppInstanceUser is the one second principal a human holds** ([SPEC-ADMIN-IDENTITY](./SPEC-ADMIN-IDENTITY.md)). The exchange creates it and tags it with its owner's AppInstanceUser ARN, and analytics, audit and erasure attribute it through that tag, never by parsing its id.
- **An email address or a phone number is a delivery route, never identity.** It may find a record inside one issuer's directory; it never binds, merges or creates an AppInstanceUser.
- **The client's identity is the `userArn` the exchange returns.** It never decodes the ID token to build an ARN.

**One resolver on the server.** Each request is resolved once, to an AppInstanceUser ARN:
- A token-authorized route is resolved by the edge authorizer, which verifies the token against the declared issuers, looks up `(issuer, subject)` in `Identities` and passes the ARN in the request context. An unknown issuer is refused.
- An IAM-authorized route is resolved from the vended session's role session name, after the exact-ARN check.
- Handlers read the resolved ARN and never `claims.sub`, `cognito:username` or `claims.email`. Groups, clearance, rosters, names and contact addresses resolve through `Directory`, keyed by AppInstanceUser, which asks each of the person's issuers through the adapter and clearance source the seam factory chose for it (`backend/lambda/src/lib/issuer-seams.ts`). The membership audit reads a member's clearance there (`Directory.clearanceOf`), whichever issuer signed them in: a member whose only issuer is no longer declared reaches nothing and is flagged.

Adding an issuer widens authentication only, never authorization: the vend still pins the bearer to the AppInstanceUser, and IAM still evaluates `classification` on every channel action, so a token from any issuer reaches exactly what its mapped classification set grants.

**As built.** The edge authorizer (`backend/lambda/src/edge-authorizer.ts`, attached to both HTTP APIs through `backend/lib/constructs/edge-authorizer.ts`) is **NOT VERIFIED** on a deployment. It passes the issuer id, the subject, the person id and ARN and the claims the registry reads in the request context, and admits a one-conversation person to `ONE_CHANNEL_ROUTES` alone, so such a person is refused at the gateway and again by the handler everywhere but the two routes that serve them. Every handler asks `callerPersonId` (`backend/lambda/src/lib/auth.ts`), which reads that context or a console session's person from its name.

**NOT BUILT:**
- Archival attributes an admin-plane turn to its owner by the twin's id (`adminTwinOwnerId`, `backend/lambda/src/lib/person-arn.ts`) rather than by its `owner` tag, because the archival path has no route to the Amazon Chime SDK.
- No deny-test that signs in through a second issuer has run against a deployment: `deny-test-bearer-pin.mjs` and `deny-test-issuer-mapping.mjs` are written and not yet run. The unit suites assert that each token-route handler acts as a resolved person id that is not the token's `sub`; no live test does.

## 4a. Access Matrix (actions × principals × conversation classification)

The authoritative at-a-glance. **Conversation classification** = the immutable `classification` tag (Private inherits the creator's classification, Team is set at creation, Open = `basic` in the shipped sample). **RW** = read + write, **RO** = read-only, **-** = denied (`AccessDeniedException` at the IAM layer, before the request runs).

Three things decide what a caller may do, and the tables below are only readable if they are kept apart:

1. **The classification role** the exchange vends carries the **grant set** - the classifications whose channels it may touch at all (`ProfileRegistry.grantsFor`). An assistant's role carries its own classification alone instead (ADR-042).
2. **The session policy** narrows that boundary to the capabilities asked for, and where a scope is given, to one channel. It can only ever narrow.
3. **Amazon Chime SDK's own model** refuses a non-member, and refuses a moderator action to a non-moderator, whatever IAM allowed.

**What does NOT decide these rows: the principal's own `classification` tag.** People and assistants carry one, and no IAM permissions condition and no runtime code reads it (see the section on sessions and principal tags). A row is decided by the set baked into the role, not by the tag on the caller. The session's `classification` assertion is checked, but only against the role carrying it - it binds a session to its role and does not widen or narrow any row here.

### Channel access by principal × channel classification

| Principal (assumed role) | `basic` | `standard` | `premium` | `admin` | untagged |
|---|:--:|:--:|:--:|:--:|:--:|
| **Guest / federated** (`restricted` role) | RW¹ | RW¹ | RW¹ | RW¹ | RW¹ |
| **Basic** user | RW | - | - | - | - |
| **Standard** user | RW | RW | - | - | - |
| **Premium** user | RW | RW | RW | - | - |
| **Admin** user - chat identity (`admins` alone) | - | - | - | RW | - |
| **Premium** user who also holds `admins` (chat identity)² | RW | RW | RW | RW | - |
| **Admin** user - admin-plane identity³ | RW+mod | RW+mod | RW+mod | RW+mod | RW+mod |
| Basic assistant (processor) | RW | - | - | - | - |
| Standard assistant | - | RW | - | - | - |
| Premium assistant | - | - | RW | - | - |
| Admin assistant (`AdminAgent`) | - | - | - | RW | - |
| HIDDEN observer⁴ | RO | RO | RO | RO | RO |

**The ordinary-user rows are triangular by CONFIGURATION, not by structure.** Each person row is that classification's declared `grants` set, and the shipped sample declares prefix-shaped sets, which is what a ladder looks like. Nothing defaults: a classification that declares no grants is refused at synth. A classification that declares `grants` explicitly may reach a set that is not a rank prefix - `premium: ['basic','premium']` is expressible and would put a `-` in the `standard` column. Read each person row as a set, never as "everything below me". **The assistant rows are diagonal by STRUCTURE** (ADR-042): an assistant reaches its own classification whatever that classification grants, so widening a grant set cannot widen an assistant row.

¹ **Not classification-gated, and this is the one row where the tag is not the boundary.** The `restricted` role carries no `aws:ResourceTag/classification` condition, so the boundary spans every classification. What bounds a guest is the other two mechanisms: the vend **requires a `channelArn`** and narrows the session to that single conversation with read+participate only, and Amazon Chime SDK refuses them on any channel they are not a member of. A guest therefore reaches exactly one conversation - but by scope and membership rather than by tag. **This is a known asymmetry, not a settled design**: making it tag-gated needs `guest` declared as a classification granting only itself, and the guest vend to narrow by tag as well as by channel. Until that is decided, the guest row is the one place a reader cannot answer "what may they reach" from the tag alone.

² A person holding the admin plane beside a member classification is vended the member classification's role with the `adminPlane` session tag, and that role's one admin-plane statement allows channels tagged with the admin plane's classification only when the tag is `true` (`exchangeVendStatements`, `backend/lib/constructs/exchange-role.ts`). The admin plane's own chat role is tag-gated to admin-plane channels like every other classification role, so no chat identity reaches an untagged channel; the guest row above is the one principal that does.

³ The **two-identity split** ([SPEC-ADMIN-IDENTITY](./SPEC-ADMIN-IDENTITY.md)). The chat identity (the person's AppInstanceUser) is an ordinary member subject to the archived-channel Deny. The admin-plane identity (that AppInstanceUser's admin twin, `${personId}-admin`, tagged with its owner, §4e) is a standing app-instance-admin that reads and moderates **without membership**, is exempt from the archived Deny, and is vended only short-lived, always scoped to one channel, and audited. A chatting admin never holds it: it is a separate vend, on a separate role, for a separate identity.

⁴ **Read-only is Amazon Chime SDK-enforced** for `HIDDEN` members (see HIDDEN Membership and Restricted Operations below) - they observe without a send capability. This is the service's model, not an IAM condition.

### Per-action breakdown (what "RW" decomposes into, and how each is gated)

A capability must be **requested** in the vend to appear in the session policy at all; the classification role is the boundary and the intersection is what the caller gets. Moderation capabilities are **admin-plane only** and always require a `channelArn`.

| Action | Capability | Authorized against | Classification-gated? | Plane |
|---|---|---|:--:|---|
| `GetChannelMessage`, `ListChannelMessages` | `view` | channel **+** bearer | yes | chat or admin |
| `DescribeChannel`, `ListChannelMemberships`, `ListChannelModerators` | `view` | channel **+** bearer | yes | chat or admin |
| `SendChannelMessage`, `UpdateChannelReadMarker` | `participate` | channel **+** bearer | yes | chat |
| `RedactChannelMessage` | `redact` | channel **+** bearer | yes | **admin only**, channel-scoped |
| `DeleteChannelMessage` | `delete` | channel **+** bearer | yes | **admin only**, channel-scoped |
| `CreateChannelMembership`, `DeleteChannelMembership`, `CreateChannelModerator` | `manage-membership` | channel **+** bearer | yes | **admin only**, channel-scoped |
| `UpdateChannel`, `DeleteChannel` | `manage-channel` | channel **+** bearer | yes | **admin only**, channel-scoped |
| `UpdateChannel` (owner rename only) | `rename` | channel **+** bearer | yes | chat; Amazon Chime SDK additionally requires moderator |
| `CreateChannel` | n/a (no channel yet) | n/a | no | app-layer: `create-conversation` 403s a request at a classification the caller is not cleared for |
| `Connect`, `GetMessagingSessionEndpoint`, `ListChannels`, `ListChannelMembershipsForAppInstanceUser` | session-level | app / user | no | no channel exposure |

**Two orthogonal resource tags gate writes independently of classification**, and both are deny-by-omission of an allow rather than explicit denies: `archived=true` makes a channel read-only for every chat-plane identity (ADR-017), and `aeChannelKind` gates kind-specific actions. A caller inside their classification can still be refused by either.

### What proves each row

Not a code review. `backend/scripts/deny-test-credential-exchange.mjs` proves the bearer pin and the classification gate on a real channel; `backend/scripts/deny-test-bearer-pin.mjs` proves a session vended for one AppInstanceUser is refused `chime:Connect`, `chime:SendChannelMessage` and `chime:ListChannelMessages` as another's bearer and as its own `-admin` twin, by `iam simulate-principal-policy` and live, for the deployment's pool and a host app's pool the trusted-issuer registry declares with the one-conversation session (written and not yet run against a deployment); `backend/scripts/deny-test-issuer-mapping.mjs` proves a foreign issuer's mapped value reaches only its classification and an unmapped value reaches nothing (written and not yet run against a deployment); `backend/scripts/deny-test-credential-exchange.mjs` also proves, by `iam simulate-principal-policy` over every role the deployment creates, that only the exchange and offboarding write `Identities`; `backend/scripts/deny-test-session-classification.mjs` proves every classification role requires the session's classification assertion and refuses a mismatched or absent one; `tests/e2e/assistant-classification-boundary.spec.ts` proves the assistant rows live; `verifyClassificationBoundary` (data-plane op) proves that each reader role in Aurora reaches exactly its grant set, including the non-vacuity check that a reader whose set includes a classification *can* see what a reader whose set excludes it cannot.

## 4b. Membership admission control (error on an invite the clearance does not reach)

A user must be **refused at invite time** if their clearance does not reach the conversation's classification - *not* silently added and then locked out by Layer 1. Two gates:

- **Synchronous (app layer) - the user-facing error.** Every path that adds a *human* checks `profiles.reaches(memberClearance, channelClassification)` and refuses:
 - `share-conversation/index.js` (the invite-by-email path): reads the recipient's authoritative Cognito-group clearance, compares it to the channel's immutable `classification` tag, and on a shortfall returns **403 `TIER_FORBIDDEN`** - *"This user cannot be added to this conversation. Their access ({recipient}) does not include the {tier} tier this conversation requires, so they need the {tier} tier granted before they can be added."* A missing or invalid tag resolves to a value that reaches nothing, so the add is refused (no floor).
 - `create-conversation` adds only the creator (already checked - creating at a classification the creator does not reach 403s); `channel-battle` adds only the classification-matched assistant. So no app path adds a human whose clearance does not reach the room.
- **Asynchronous (Layer 6 Kinesis audit) - the backstop for direct-SDK adds.** A membership created out-of-band bypasses the app gate. **Who can actually do that is narrow, and worth stating precisely rather than as "a moderator with the SDK":** there is no Identity Pool, so a person holds no credential the exchange did not vend, and the ordinary chat role the exchange vends carries no membership action. `CreateChannelMembership` reaches a caller only through an admin-role exchange vend, narrowed per request by a session policy and recorded - or through a backend Lambda role. So the realistic sources are a compromised Lambda credential, a mis-scoped admin vend, or the service admin identity; a channel moderator cannot do it with their own session. The Kinesis stream carries every `CREATE_CHANNEL_MEMBERSHIP` / `UPDATE_CHANNEL_MEMBERSHIP` event; the audit Lambda re-checks **(a) reach** (the member's Cognito-group clearance reaches the channel `classification`) and **(b) conversation-type correctness** (e.g. on an Open/announcement channel a member outside the classification must be `HIDDEN`, not `DEFAULT`) and on a violation alerts, **and auto-revokes (`DeleteChannelMembership`) only when the runtime enforce toggle is on**. It is **report-only by default**, so a false positive alerts rather than removing a legitimate member - see Layer 6. Do not read this layer as a guarantee that a wrongly-added member is gone; read it as a guarantee that somebody is told.

**Layer 1 makes a wrongly-added principal inert in BOTH directions, which is what ADR-042 decides.** For a **human** whose clearance does not reach the channel's classification, the tag condition denies every channel action, so the audit closes a residual *visibility* gap rather than a write leak. For an **assistant** of any other classification, the assistant's channel grant is its own classification alone (`channelsAnAssistantMayActIn`), so the tag condition denies it every channel action on that channel too - it cannot read or send there, and cannot answer. The audit still reports it, because no condition reaches the membership itself (the membership actions in §4). See [ADR-042](../../../design/decisions/042-an-assistant-acts-in-exactly-one-classification.md), deny-tested live by `tests/e2e/assistant-classification-boundary.spec.ts`.

## 4c. Archived conversations (read-only via the `archived` tag)

Archiving a conversation makes it **read-only for everyone by IAM**, using the same tag-gated mechanism as Layer 1 - the AWS-documented read-only-channel pattern (the blog in Related Documents, Approach 2). On archive, the backend sets an immutable `archived` tag on the channel, and a **Deny** on `chime:SendChannelMessage` + `chime:UpdateChannelMessage` conditioned on `aws:ResourceTag/archived == "true"` is layered onto both the per-tier assistant send grant and the user exchange creds (`agent-classification-common.archivedChannelReadOnlyDeny`). A Deny overrides the tag-gated ALLOW, so once the tag is set neither a member nor the assistant can send or edit - the channel is read-only by IAM, not by application logic. The app-instance-admin (admin-plane) bearer is deliberately un-tag-gated and stays exempt, so administration of an archived conversation still works. The "archived by ..." notice is posted by the conversation's assistant before the tag is set, because the Deny refuses it afterwards. Membership is retained (members keep read-only access); the channel hard-expires on the conversation-type TTL (90 days after last activity). Full design: [ADR-017](../../../design/decisions/017-conversation-archive-mechanism.md) and [SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP](../conversation/SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md).

## 5. Layer 2: Channel Metadata (Application-Level)

Channel Metadata is member-writable (a channel's moderators hold `chime:UpdateChannel`), so it carries display fields only and nothing decides anything from it. What decides is elsewhere: the room's classification, its primary assistant and its type label are channel TAGS, which members cannot change, and the conversation type that sets policy is in the server-side context store (`channel-context-client.ts`).

### What a room carries

```json
{
  "tags": { "classification": "premium", "primaryAssistant": "advisor", "conversationType": "general" },
  "metadata": { "modelId": "anthropic.claude-opus-4-20250514", "modelName": "Opus", "modelTier": "premium" }
}
```

`conversationType` on the tag is a label for operators and cost allocation, and equals the context store's type key; the context store is the authority.

### Enforcement in Lambda Handlers

Every function that modifies membership resolves the conversation's classification first. The authoritative source is the immutable `classification` tag (Layer 1); Metadata is never read for it. The reach test is illustrative:

```typescript
// Reach is resolved through the ProfileRegistry (backend/lib/config/profiles.ts), which reads each
// classification's declared `grants`. It is set membership rather than a comparison, because a
// deployment's classifications may be peers - `legal` beside `finance` - with no order between them.
// The classification comes from the immutable TAG, never from Metadata, which a moderator can rewrite.

async function validateMembership(channelArn: string, memberClearance: string): Promise<void> {
  const classification = await readChannelClassificationTag(messagingClient, channelArn, '[Share]');
  if (classification === undefined) {
    // Missing, invalid or unreadable: refuse. There is no floor to fall to (ADR-046).
    throw new Error('Membership denied: the conversation carries no readable classification');
  }

  if (!profiles.reaches(memberClearance, classification)) {
    throw new Error(
      `Membership denied: conversation requires ${classification} (user holds ${memberClearance})`
    );
  }
}
```

Applied in:
- `backend/lambda/share-conversation/index.js` → reads the immutable `classification` tag before `CreateChannelMembership` and refuses the add when the tag is missing or invalid (no floor)
- `backend/lambda/src/create-conversation.ts` → refuses a requested classification the creator's clearance does not reach
- `backend/lambda/src/conversation-management.ts` (`membershipHandler`) → a host's add is confined by construction: the channel is created at the context classification the registry's oneChannel issuers name (`CONTEXT_CLASSIFICATION`), an existing one is joined only at that classification, and membership never crosses it
- `backend/lambda/src/router-agent-handler.ts` → resolves the served classification from the channel's immutable `classification` tag (never the mutable `modelTier` metadata) before routing

The membership-adding paths are enumerated and frozen by `backend/test/single-entry-point.test.ts`: a new one fails CI until it is registered there with the reason it cannot reuse `backend/lambda/src/lib/channel-creation.ts`. That guard is what keeps this list from drifting out of date.

## 6. Layer 3: User Tier from Cognito Groups

A user's tier is their **Cognito group** membership, not a stored Amazon Chime SDK AppInstanceUser tag. The groups `basic`, `standard`, `premium`, and `admins` are defined in `identity-stack.ts`. `custom:tier` is mirrored into the matching group by `post-confirmation.js` (at sign-up) and `user-management.ts` (on an admin change).

### The group is the authoritative tier signal

The router, share, and create-conversation Lambdas call `AdminListGroupsForUser` and use the **group**, not the `custom:tier` attribute, as the authoritative tier signal. Deriving tier from group membership keeps a single source of truth that a stray attribute edit cannot silently desync. This substitutes for the original AppInstanceUser-metadata design; see [IDENTITY-AND-ACCESS-MODEL.md](./IDENTITY-AND-ACCESS-MODEL.md), Related docs.

### The channel's classification decides the answer

`router-agent-handler.ts` answers at the channel's classification. A premium user in a basic channel is answered at basic. A basic user cannot send into a premium channel at all, because IAM fail-closes the send; if a clearance lookup ever disagrees with the channel, the handler logs a security event. The channel's classification always decides which assistant answers, so a person whose clearance reaches more than the room cannot pull context from a classification the room's grants do not include into it, and every member of one conversation is answered at the same classification.

## 7. Layer 4: Agent IAM (S3 Prefix Scoping)

Each assistant role's S3 access is scoped to the `context/` prefixes its classification grants. The assistant cannot read a context file outside that set.

### Server-only Channel Context store (private host grounding)

A conversation's private host grounding - the participant profile, domain context, extra context blobs, and resolved display name - lives in a dedicated DynamoDB table (`ChannelContextTable`, `conversations-stack.ts`) keyed by `channelArn`, deliberately OUT of the member-readable Amazon Chime SDK channel Metadata (which any member reads via `DescribeChannel`). The conversation-create Lambdas write it, and the router and handler roles hold `dynamodb:GetItem` and `dynamodb:UpdateItem` on it and nothing else (`assistant-profile-stack.ts`): the read is per-turn grounding, and the update is the pre-creation participant write on the drift-confirm and split paths, which create conversations from inside the handler; no `PutItem`, `DeleteItem`, `Query` or `Scan`. No channel member, Cognito, or Identity-Pool principal holds any grant. Code: `channel-context-client.ts`. The participant roster (`memberIdentities`), the reply language, the segment and the conversation type are in this store too, because channel Metadata is member-writable and a member who could edit the roster could add an identity and have content sent out of band. Metadata keeps display labels and decides nothing; it never holds an identity or a relation. **NOT BUILT:** the person create path still writes the creator's ARN as `createdBy` and the drift and event paths write `parentChannelArn` there ([METADATA-AND-TAGS](../../../guides/developer/METADATA-AND-TAGS.md), section 1).

The enforcement is `roleContextStatements` (`agent-classification-common.ts`) on each classification's assistant acting role, the role every turn acts on: each `context/` prefix is granted to the assistant roles that read it, conditioned on the session's `role` tag, and capped by `contextPrefixesAllowedFor`, which delegates to `ProfileRegistry.contextPrefixesGranted` and so to the same grant set. It scopes `s3:GetObject` and `s3:ListBucket` to the prefixes the classification grants: in the shipped sample, basic reads `context/basic/*`; standard reads `context/basic/*` and `context/standard/*`; premium reads all of `context/*`. A prefix outside the grant set is denied by the absence of the grant, not by an explicit Deny. The per-classification policies below illustrate the shape.

**An assistant's CONTEXT reach and its CHANNEL reach are different questions.** ADR-042 narrowed the channel boundary to the assistant's own classification; it did not narrow the context read, which stays the classification's declared grant set. So a premium assistant reads `context/basic/*` and answers only in premium channels, and `backend/test/cdk-synth.test.ts` (case 'gives the assistant the SAME reach for channels and for context prefixes') is what keeps the two derived from one resolver rather than drifting apart.

### Per-classification S3 policies

```typescript
// Illustrative shape; the deployed statements are roleContextStatements on the acting role,
// conditioned on the session's role tag, with prefixes capped by
// ProfileRegistry.contextPrefixesGranted, which reads the
// grant set (grantsFor) rather than being hand-written per classification.

// Basic agent: can only read basic/ context
const basicS3Policy = new iam.PolicyStatement({
  actions: ['s3:GetObject'],
  resources: [`${contextBucketArn}/context/basic/*`],
});

// Standard agent: can read basic/ and standard/
const standardS3Policy = new iam.PolicyStatement({
  actions: ['s3:GetObject'],
  resources: [
    `${contextBucketArn}/context/basic/*`,
    `${contextBucketArn}/context/standard/*`,
  ],
});

// Premium agent: full access
const premiumS3Policy = new iam.PolicyStatement({
  actions: ['s3:GetObject'],
  resources: [`${contextBucketArn}/context/*`],
});
```

### load-context Action Group

Reads from S3 using the conversation's classification:

```typescript
// Determine the S3 prefix from the channel's immutable classification TAG, never from Metadata
const classification = await readChannelClassificationTag(messagingClient, channelArn, '[Context]');
if (classification === undefined) {
  // Missing, invalid or unreadable: refuse the read rather than guessing a prefix (ADR-046)
  return [];
}

// Read context files from the classification's S3 prefix
// IAM will block if the assistant's classification does not grant it (defense in depth)
const contextFiles = await listS3Objects(`context/${classification}/`);
```

## 7a. Layer 4b: Retrieval scoping (the vector store)

**The privilege is a database role per classification (ADR-028)**, with row-level security over both vector tables, and every reader and writer assuming a role for the statement. The `verifyClassificationBoundary` data-plane op runs seven checks against the cluster, including the defeat test issued with the classification filter deleted and the defeat test issued with no role assumed at all, and a live `retrieve` returns content in the same run, so the boundary is not passing by matching nothing. One implementation note that is load-bearing rather than incidental: the runtime connects as a dedicated non-owning database user, because the table owner is exempt from its own policies for reasons the catalog does not account for.

Layer 4 bounds what the assistant can **fetch from S3**. Retrieval reaches the model by a different route and never touches that boundary: the router pre-fetches semantically relevant chunks from Aurora pgvector before dispatch, and passes them in on the payload. So a document embedded into the vector store is grounding that Layer 4 does not gate.

Retrieval, drift and summaries run on a per-classification turn data plane (`TurnDataPlane-{classification}`). IAM limits which roles invoke each one, and each runs on its own role that reads only its classification's routing table (built, not yet deployed: [DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION](../assistants/DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md) Phase 1c). What it reads from the shared Aurora database is pinned to its classification by the function code, on one database login (**OPEN**).

What holds today:

- **Document retrieval** (`document-retrieval.ts`) appends `AND metadata->>'classification' = ANY($3)`, where the scope is `profiles.grantsFor(classification)` - the same grant set the reader role and the S3 context prefixes are generated from, so a non-contiguous grant set cannot make the filter and the privilege describe different boundaries. It is fail-closed for untagged rows, and it refuses to run with an empty scope rather than defaulting to one.
- **The classification of a chunk is asserted at ingest** by its S3 key (`rag/{sourceType}/{classification}/…`, `document-ingestion.ts`), stamped with the fail-closed content value (`failClosedContentValue`, the conversational classification the fewest holders reach) when absent. Fail-closed protects against omission; it does not protect against content written under the wrong classification.
- **Conversation summaries** (`summary_embeddings`) carry a classification column, and drift's two reads run as the channel's reader role. Membership scoping also applies: the live intersection of all human members' Amazon Chime SDK memberships (`scoped-channels.ts`, `SearchChannels … MEMBERS INCLUDES`, no archive fallback, empty scope ⇒ suggest nothing). The two bound different things and neither subsumes the other - membership bounds *the people*, classification bounds *the channel* - so both are applied. This closes the case where two premium-cleared people talking in a basic channel let drift point from that basic channel at a premium one.
  - The classification is resolved from the Amazon Chime SDK channel tag **outside** the VPC, because nothing that can reach Aurora can reach Amazon Chime SDK Messaging (`natGateways: 0`, and no Amazon Chime SDK endpoint), and lands in `channel_classification` as a projection - never an authority (ADR-012). A summary written for a channel that projection has never heard of is stamped with the fail-closed content value (`failClosedContentValue`), so the failure withholds rather than leaks.

**Why this is a named layer rather than a footnote to Layer 4.** Every other classification boundary in this document survives a wrongly written query, because the principal lacks the permission. Without a database privilege this one would not: one database identity (`db-client.ts` `DB_USER`) could read every row, and the only protection would be that the filter had been written correctly at every call site that would ever exist. A leak here looks like a normal answer.

ADR-028 places it in a database privilege - a role per classification, row-level security admitting only rows the role's classification grants, and every caller assuming a role for the statement - keeping the filters as defense in depth. Two properties of that design are worth stating here because getting either wrong reproduces the original hole while appearing to fix it: the policies are `FORCE`d (Postgres exempts a table's owner otherwise, and the data-plane connects as the owner), and they discriminate on `current_user` rather than on a policy role list (Postgres matches those by role membership, which `SET ROLE` requires the caller to hold).

## 8. Layer 5: Bedrock Guardrails (Content Safety)

A Bedrock guardrail is applied to every assistant turn, on input and on output (`applyInputGuardrail` / `applyOutputGuardrail` in `async-processor-core.ts`). The provisioned policy is content-safety, PII, and word filtering - not topic denial.

### Guardrail Policy (as provisioned)

`buildGuardrailPolicy` (`lib/constructs/bedrock-guardrails.ts`) provisions:

- **Content filters:** SEXUAL, VIOLENCE, HATE, INSULTS, MISCONDUCT, and PROMPT_ATTACK (the prompt-injection filter, run on input).
- **Sensitive information:** US Social Security numbers and payment-card numbers BLOCK; contact details (email, phone) are deliberately not masked, because colleagues exchange them as ordinary work content and a phone mask matched the digits of ordinary arithmetic; an internal-marker regex ANONYMIZEs `<!--ACTIVE_TASK|corr|turn:-->` so a control marker a model echoes back is masked.
- **Word policy:** a blocked-word list plus the managed PROFANITY list.

Guardrails are define-then-select ([SPEC-CONFIGURABLE-ASSISTANTS](../assistants/SPEC-CONFIGURABLE-ASSISTANTS.md), the guardrail catalog): a deployment provisions a catalog of guardrails and each assistant profile selects one by id (the default, or a stricter variant), with the IAM grant scoped per provisioned guardrail so a profile can never point at an arbitrary resource. That catalog is the tuning surface for stricter, industry-specific filtering: a deployer that needs topic denial adds a guardrail carrying a denied-topics policy to the catalog and selects it on the profiles that need it. No denied-topics policy is populated by default.

Cross-classification context isolation - the property that a reader must not see grounding from a classification the room's grants do not include - is enforced by Layers 1 (channel-tag IAM gate), 4 (S3 prefix scoping) and 4b (retrieval scoping) rather than by Layer 5. Layer 5 is content safety plus the drift agent instructions below. The three are not equally strong, and are not the same kind of control: Layers 1 and 4 are IAM, while 4b is a database privilege plus a query filter (ADR-028).

### Agent Instructions - Tier-Drift Handling

Added to each agent's instructions:

```
When you cannot find information that seems like it should exist,
it may be because the conversation's access level restricts what
you can retrieve. In this case:
- Do NOT guess or fabricate the information
- Inform the user: "This information isn't available at this
  conversation's access level"
- Suggest: "You can ask in a Private conversation for full access"
- Never reveal what tier would have the information
```

## 9. Layer 6: Kinesis Stream Audit (Async Enforcement)

The Kinesis archival Lambda already processes every Amazon Chime SDK event (`CREATE_CHANNEL_MEMBERSHIP`, `UPDATE_CHANNEL_MEMBERSHIP`, `DELETE_CHANNEL_MEMBERSHIP`, `CREATE_CHANNEL`, `UPDATE_CHANNEL`, `CREATE_CHANNEL_MESSAGE`, etc.). This is the **last line of defense** - it catches violations from any source, including backend systems, direct API calls, or compromised credentials that bypass Layers 1-5.

### The membership-audit consumer

The membership audit is a dedicated consumer, `backend/lambda/src/membership-audit.ts`, wired by `lib/constructs/membership-audit.ts` into the Archive stack in both modes, on the Messaging stack's stream, and always deployed (flagging a member whose clearance does not reach the channel is a standing guarantee, not opt-in; the only knob is whether it also revokes). It filters `CREATE_CHANNEL_MEMBERSHIP` and `UPDATE_CHANNEL_MEMBERSHIP`, resolves the member's clearance through `Directory.clearanceOf` (`memberClearanceOf`), which finds the person's subjects through `Identities` and asks each of their issuers' clearance sources, and on a member whose clearance does not reach the channel auto-revokes the membership (`DeleteChannelMembership`, admin bearer) when enforcement is on, logs a `[MembershipAudit][SecurityEvent]` with the outcome, and then alerts the admins with what actually happened (revoked, already gone, failed, or reported) through `postAdminNotice` (`lib/admin-notice.ts`): an `ae.alert` event on the default bus, which the `AdminServices` stack posts into the admin notification channel as the admin assistant, emailed to the admin roster by that channel's `notify` fan-out. Its role holds no message send at all: its alert grant is `alertEmitterWiring`, `events:PutEvents` for the `ae.alert` source only. Enforcement is a runtime toggle: the consumer reads the `config/enforce` item from the audit table (cached for thirty seconds), the admin console's Security tab flips it with no redeploy, and `-c membershipAuditEnforce=true` sets only the default the toggle falls back to. It is report-only by default.

**It audits assistants as well as people, in opposite directions.** A HUMAN member is a violation when their clearance does not reach the channel's classification - they would see content above their clearance. An ASSISTANT (`/bot/`) is a violation when its assigned classification is not the channel's - it does not belong in that room at all. The assistant's classification is read from the `classification` tag on its AppInstanceBot - the same signal the channel side is judged on, so the comparison is like for like - falling back to the published `/{root}/assistant/{classification}/bot-arn` parameters for an assistant provisioned before its deployment carried the tag. It is never inferred from the ARN. A `/battle` alt assistant is tagged with its classification at creation and is audited on the same rule. The admin service user is skipped, because it is the service moderator. Every other person is audited through `Directory.clearanceOf` whichever issuer signed them in (§4e): a member whose issuers are all removed from the registry reaches nothing and is flagged, and a member whose clearance cannot be established (an issuer that decides only from a token, an undeclared combination, a failed read) is recorded as an unaudited membership rather than revoked on a guess (`membership-audit.ts`).

**An invitee is audited by the invitation that names it.** An invitation mints its invitee's AppInstanceUser at invite time and adds it to the one conversation it is for, with no `Identities` row until a `sign-in` redemption binds one and none ever for a `link` redemption ([SPEC-CREDENTIAL-EXCHANGE](./SPEC-CREDENTIAL-EXCHANGE.md) §4c), so it resolves to no clearance. For a member who resolves to no clearance at all, and for no one else, the consumer reads the conversation's invitations through the token store's sparse index (`invitationAdmitsMember`, `membership-audit.ts`; its role holds `Query` on that index and nothing else in `Tokens`) and records no finding when a record of this conversation names the member, is not revoked, carries the conversation's classification, and is pending and unexpired or was redeemed by its link. The read is filtered to the member and paged to the end of the index. Because an invitation adds its invitee before it writes the record, and the index lags the record, a member no record names yet is read once more after a short settle (`INVITATION_SETTLE_MS`, three seconds by default) before anything is reported. A revoked or expired invitation, one naming somebody else or another classification, and an unreadable token store admit nobody, and the member is flagged as before.

**A finding is about the room as it is now.** A membership event describes the room when the event was written, so before any finding is reported the consumer reads whether the member is still in the conversation (`isStillMember`, `membership-audit.ts`: `ListChannelMemberships` as the service admin, visible and hidden members, under the listing grant the sweep already holds). A member who has already left, such as an invitee whose invitation was revoked seconds after it was made, is logged as a stale event and reported nowhere. A member still there is reported as before, including an invitee a revocation left behind, and a listing that cannot be read leaves the finding standing.

**Layer 1 keeps a wrongly-added principal inert in both directions, and the audit is what tells somebody.** For a human whose clearance does not reach the channel, the tag condition denies every channel action, so this consumer closes a residual visibility gap rather than a write leak. For an assistant of any other classification, the assistant's grant is its own classification alone (ADR-042), so the tag condition denies it every channel action there as well: it holds a membership it cannot act on. In report-only mode the consumer reports both; with enforcement on it revokes both. What no layer can gate is the membership itself (the membership actions in §4).

### Monitored Events

The consumer audits the two MEMBERSHIP events - the ones that can place a member on a channel their clearance does not reach (`AUDITED_EVENT_TYPES` in `membership-audit.ts`):

| Event | Check | Action on violation |
|-------|-------|---------------------|
| `CREATE_CHANNEL_MEMBERSHIP` | Member clearance reaches the channel classification | Alert admin; auto-revoke when enforce is on |
| `UPDATE_CHANNEL_MEMBERSHIP` | Member clearance still valid after the change | Alert admin; auto-revoke when enforce is on |

The same reach check also runs on two non-event triggers - a scheduled sweep of every channel's memberships and an on-downgrade re-evaluation of one user's memberships - so a member whose clearance stops reaching the channel AFTER joining (no membership event fires) is still caught. See [SPEC-ACCESS-AND-CONTROLS-AUDITING](./SPEC-ACCESS-AND-CONTROLS-AUDITING.md), the three detection triggers.

`UPDATE_CHANNEL`, `CREATE_CHANNEL`, and `CREATE_CHANNEL_MESSAGE` are NOT audited here: the classification decision keys on the IMMUTABLE `classification` tag (not mutable metadata), so metadata tampering is a no-op that needs no revert, and a message from a sender whose clearance does not reach the channel was already prevented by Layer 1 (the sender's tag-gated credentials cannot send on the channel).

### Why This Matters

The membership audit catches a MEMBERSHIP the member's clearance does not reach regardless of how it was introduced - a backend system, a direct API call, or over-provisioned credentials that bypass Layers 1-5 - and it operates independently of IAM:
- **Backend system or direct API adds a wrong member:** flagged (report-only) or auto-revoked (enforce), from the membership event, the scheduled sweep, or the on-downgrade re-eval.
- **A member's clearance stops reaching the channel after joining** (clearance changed): no membership event fires, but the sweep and the on-downgrade re-eval catch it.
- **Metadata tampering needs no audit:** the `classification` tag is the source of truth and cannot be changed by `UpdateChannel`, so a tampered `metadata.modelTier` is simply never read.
- **Message sent by a sender whose clearance does not reach the channel:** already prevented by Layer 1 (the sender's tag-gated credentials cannot send on the channel).

## 9a. Layer 7: Mixed-trust visibility (external guests)

The first six layers isolate *classifications* of internal users. Layer 7 governs a different shape: an **external guest** (a federated or routed human) sharing one channel with **internal** members, for example AWS Support dialed into an incident triage room or a routed support agent on a customer case. The guest must see only what is meant for them, never the internal back-channel. This is the layer that applies when an external-guest use case runs: a routed support agent, AWS Support, or a customer alongside internal responders.

**The visibility model:**
- The external guest is admitted on the `restricted` role **and** scoped to that one channel (the vend requires a `channelArn`; membership is the second bound) - Layers 1/2/6. An issuer declaring the one-conversation session is vended the one `restricted` role whatever its token says; an issuer declaring another clearance source has its reach derived from that source within its declared classifications (`holderTokenOf`, `backend/lib/config/issuers.ts`, read through `backend/lambda/src/lib/auth.ts`). [SPEC-FEDERATED-PARTICIPANTS](./SPEC-FEDERATED-PARTICIPANTS.md) FR14 owns what remains of that gap.
- **On top of that, a per-message visibility gate:** every message is either **targeted** (internal-only) or **broadcast** (guest-visible); the external guest is **broadcast-only**. Internal context (including `fetchContext` and dashboard data) stays targeted.
- The assistant is the gate (it chooses targeted vs broadcast based on content sensitivity), riding **Amazon Chime SDK targeted messaging** (`Target=[…]`). The *mechanism exists*; what the gate rests on is **policy and discipline**, because a single wrong broadcast leaks internal context to the external party and no control refuses it.

**Why a distinct layer:** the existing layers gate *which channels* a principal can touch and at *what classification* - they do **not** gate *within a channel* between a broadcast and a targeted message when trust levels are mixed. This is the gate that does. The federated-guest admission model is in [SPEC-FEDERATED-PARTICIPANTS](./SPEC-FEDERATED-PARTICIPANTS.md).

### Not offered: a file containing the conversation

The platform delivers **generated artifacts** as downloadable files - a report, an extraction, a summary the assistant wrote. It does **not** offer to package the conversation itself, and that is a deliberate boundary rather than a missing feature.

**Why.** An assistant reads channel history with its OWN bearer (`loadChannelHistory`, `ChimeBearer: botArn`) and applies no per-message visibility filter, so its working context includes **targeted** messages - including ones addressed to other members. A transcript composed from that context would carry content the person asking for it may not be entitled to see. No prompt instruction fixes this: by the time the request arrives, the model has already read the text, and asking it to leave something out is a request, not a control.

**What offering it would require.** The export would have to be assembled by the runtime, re-reading messages with the **requestor's** bearer, so the Amazon Chime SDK itself excludes what that person cannot see - targeted messages to others, and anything from before they joined. The same test would apply to any attachment the export references: a document they cannot open must not ride along inside one they can. That is a read the platform does not perform, so the capability is not offered.

**What this boundary does NOT claim.** It governs what the platform *offers to package*. It is not a guarantee that a model cannot be induced to repeat targeted content in an ordinary reply - that is the policy-and-discipline gap this layer names above, and declining to write files does not close it. Stating the boundary honestly is the point: a reader should not mistake "we do not offer transcript downloads" for "targeted content cannot reach the wrong person".

## 10. HIDDEN Membership and Restricted Operations

From the [read-only channels blog post](https://aws.amazon.com/blogs/business-productivity/creating-read-only-chat-channels-for-announcements-with-amazon-chime-sdk-messaging/) (McHarg, 2021), HIDDEN membership allows users to read channel messages without being visible to other members or being able to send. This is **enforced by the Amazon Chime SDK itself** - no application code needed.

### HIDDEN Member Capabilities

| Operation | DEFAULT member | HIDDEN member |
|-----------|:-:|:-:|
| `ListChannelMessages` (read) | Yes | Yes |
| `SendChannelMessage` (write) | Yes | **No** (Amazon Chime SDK enforces) |
| `UpdateChannelMessage` | Yes | **No** |
| Visible in `ListChannelMemberships` | Yes | **No** |
| Receives WebSocket events | Yes | Yes (real-time observation) |

### Use Cases

**1. Admin Observation (evaluation, compliance)**

Admins added as HIDDEN members see all messages in real-time for quality evaluation without being visible to users or influencing agent behavior. The agent behaves identically whether observed or not - critical for evaluation accuracy.

**2. Engagement / Customer Success**

A CSM observes how customers interact with the agent - what questions they ask, where they get stuck. If intervention is needed, the CSM can be promoted to DEFAULT membership to join visibly, or reach out via a separate channel.

**3. Announcements / Broadcast**

Bot is the only DEFAULT member (moderator). All users are HIDDEN members. Bot sends announcements; users read but cannot respond. A deployer may additionally tag the channel with `readonly=true` and add IAM conditions restricting `ListChannelMemberships` and `DescribeChannel` on readonly-tagged channels; no shipped policy reads a `readonly` tag (see Extended IAM Restrictions below).

```typescript
// Create announcement channel
const channel = await messagingClient.send(new CreateChannelCommand({
  AppInstanceArn: APP_INSTANCE_ARN,
  Name: 'Company Announcements',
  Mode: 'RESTRICTED',
  Privacy: 'PRIVATE',
  ChimeBearer: botArn,
  Tags: [
    { Key: 'classification', Value: 'basic' },
    { Key: 'readonly', Value: 'true' },
  ],
}));

// Add users as HIDDEN (read-only, invisible)
for (const userArn of allUserArns) {
  await messagingClient.send(new CreateChannelMembershipCommand({
    ChannelArn: channel.ChannelArn,
    MemberArn: userArn,
    Type: 'HIDDEN',
    ChimeBearer: botArn,
  }));
}
```

**4. Read-only access outside the grant set (opt-in policy)**

A Basic user cannot be a DEFAULT member of a Premium conversation (Layers 1-2 enforce this). But an admin could explicitly add them as HIDDEN for read-only observation of a non-sensitive conversation at a classification their clearance does not reach. This is an **opt-in policy decision**:
- Kinesis audit (Layer 6) logs such HIDDEN memberships separately
- Admin must explicitly approve
- HIDDEN member cannot send (Amazon Chime SDK enforces) - no write-side risk
- Read-side risk remains - use only for non-sensitive conversations

### Extended IAM Restrictions

Beyond Amazon Chime SDK's built-in HIDDEN enforcement, a deployer may add IAM policies that further restrict what users can do on tagged channels. The `readonly`-tag Deny below is a pattern a deployer may add, not a shipped statement: no stack reads a `readonly` tag.

```json
{
  "Effect": "Deny",
  "Action": ["chime:ListChannelMemberships", "chime:DescribeChannel"],
  "Resource": "*",
  "Condition": {
    "StringEquals": { "aws:ResourceTag/readonly": "true" }
  }
}
```

Added to a role, this would prevent HIDDEN members from discovering who else is in the channel - they could only read messages. The condition key is the global `aws:ResourceTag`, for the reason the Layer 1 section gives: Amazon Chime SDK exposes no service-specific condition keys, so a `chime:ResourceTag` form would silently no-op.

## 11. Drift Detection

### Three Drift Types

| Detection | Trigger | Action | Layer |
|-----------|---------|--------|-------|
| **Topic drift** | Conversation moves away from stated purpose | Suggest new conversation | Application |
| **Tier drift** | User asks for information held at a classification the room's grants do not include | Agent cannot access it (Layer 4 IAM blocks S3). Graceful refusal (Layer 5 instructions). | IAM + Agent |
| **Intent drift** | User requests an action their classification does not support | Agent has no Action Group for it. Returns "not available at this tier." | Agent |

### Tier Drift - Multi-Layer Response

```
Premium user in Standard conversation: "What's our burn rate?"

Layer 4 (IAM):     Standard agent tries s3://context/premium/financial-data.json → AccessDenied
Layer 5 (Agent):   Agent instructions say "inform user, suggest Private conversation"
Result:            "Financial metrics aren't available in this conversation.
                    Create a Private conversation for full access."
```

Layer 4 (IAM S3-prefix scope) is the hard block that prevents the leak - the standard agent's role cannot read the premium context prefix, so the data never reaches the model. The Layer 5 agent instruction shapes the graceful refusal on top of that denial; it is UX, not the control.

## 11a. Control-Marker Injection Defense

The assistant embeds machine-readable control markers in a message's Content so clients can render UI deterministically: HTML-comment markers like `<!--ACTIVE_TASK:...-->`, `<!--battle:...-->`, `<!--battlestats:...-->`, `<!--suggestions:...-->`, `<!--corr:...-->`, and the inline `NAVIGATE_CHANNEL:<arn>|<label>` redirect. These markers drive real UI (a channel redirect, a battle scorecard, suggestion cards) and, for some deployments, assistant-triggered actions.

**Threat.** A message is user-authored text. A bad actor can type a control marker into their own message to try to spoof UI for other members (a fake scorecard, a redirect to a channel they choose) or to trigger an action the marker represents.

**Defense (three independent strips plus an output-only action rule):**

| Where | Mechanism | Effect on an injected marker |
|-------|-----------|------------------------------|
| Display (every client) | `frontend/packages/shared/src/utils/messageParser.ts` parses and strips known markers before render | Never shown as UI to another member |
| Backend reads | `lambda/src/lib/message-markers.ts` strips ALL `<!--...-->` comments on every non-UI read (analytics, the LLM relevance judge, the admin conversation browser) | Never scored, never leaked into a prompt or an admin view |
| Action path | Side-effect actions are keyed off assistant/model OUTPUT, not raw user input | A marker in a user message is never the trigger for an action |
| Input filter | The tier Bedrock guardrail runs the `PROMPT_ATTACK` filter on user input (`async-processor-core.ts`) | Prompt-injection attempts are filtered before the model sees them |
| Guardrail mask | The guardrail's `MetadataMarkerFilter` masks a leaked marker, and `stripGuardrailMaskTokens` removes the token that mask leaves, at the guardrail boundary (`applyOutputGuardrail`) | A masked marker never reaches a reader as a visible token |

`message-markers.ts` is the single backend source of truth and deliberately strips the entire `<!--...-->` comment class rather than an allowlist, so a new marker (or an injected unknown one) is covered without a code change. Because the assistant never emits HTML comments as genuine content, stripping the whole class is safe.

**A mask is not a strip.** Amazon Bedrock Guardrails replaces an `ANONYMIZE` match with the literal `{FILTER_NAME}`, so the metadata-marker filter rewrites a leaked marker into a different visible string that `stripMessageMarkers` cannot match: the text it looks for is already gone. The filter name has ONE definition (`backend/lib/config/guardrail-masks.ts`), read both by the CDK construct that provisions the filter and by the stripper that removes its token, so renaming the filter cannot leave the stripper matching a name nothing produces. The token is removed where it is created, so no surface stores or renders one. The scope is every regex filter declared for an internal marker (`<!--ACTIVE_TASK|corr|turn:-->`) and deliberately excludes PII entity masks: were a deployment to add an EMAIL `ANONYMIZE` rule to its catalog, `{EMAIL}` would be that rule's intended output, and removing it would delete the evidence that a redaction happened. The shipped policy provisions no such mask; its PII entities BLOCK.

**Why it holds.** An injected marker is stripped on display (no spoofed UI), stripped on every backend read (no leak, no mis-scored analytics), and is not on the action path (no triggered side effect). The defense does not depend on detecting "bad" markers; it strips the whole class everywhere the text is consumed.
