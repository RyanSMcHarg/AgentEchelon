# SPEC: Federated Participants

**Status:** Design, built (an external issuer declared in the trusted-issuer registry is served by the one exchange, and the host's backend opens its conversation through the membership function); enabled only where a deployment declares a host's issuer and its `contextClassification`; unit-proven (`a-host-pool-person-takes-the-ordinary-exchange`, `the-edge-admits-a-token-only-where-its-person-is-served`), unproven on a deployment: no e2e spec drives it, and the second-issuer half of `deny-test-bearer-pin.mjs` needs a federated user the dev deployment does not declare (its first half held on dev on 2026-11-05, SPEC-CONVERSATION-SECURITY §4e); the per-connector group map is **NOT BUILT**

**Coverage:** none in the e2e suite; a deployment reaches it only by declaring a host's issuer. The live bearer-pin probe for a host pool is `backend/scripts/deny-test-bearer-pin.mjs`.

**Related:** [SPEC-CREDENTIAL-EXCHANGE.md](./SPEC-CREDENTIAL-EXCHANGE.md) - the credential substrate this is an additive path on. [SPEC-CONVERSATION-TYPES.md](../conversation/SPEC-CONVERSATION-TYPES.md) - Connectors, where a connector resolves the external person. [SPEC-CONVERSATION-SECURITY.md](./SPEC-CONVERSATION-SECURITY.md) - the layered access model this operates inside. [IDENTITY-PROVIDER-GUIDE.md](../../../guides/user/IDENTITY-PROVIDER-GUIDE.md) - wiring a second identity provider. [SPEC-INTERACTION-LAYER.md](../SPEC-INTERACTION-LAYER.md) - the interaction-layer set this belongs to.

**Site section:** Interaction layer, governance.

---

## Overview

**An external person joins a conversation as themselves, authenticated against their own identity provider, without ever getting an account here.** The valuable experiences connect a customer to a person inside the business - a routed support agent, an on-call engineer, a dispatched technician - and that person authenticates against the *business's* identity provider. Bringing them in must not mean migrating them in, and must not mean a shared guest login that makes every action unattributable.

**This is the credential exchange's own path, not a second substrate.** The same bearer pin, the same vend, the same session tags, and the same handlers: the external person's issuer is one more entry in the issuer registry ([SPEC-CREDENTIAL-EXCHANGE.md](./SPEC-CREDENTIAL-EXCHANGE.md) §4b), and what differs follows from that issuer's declaration, never from which file ran. Because access is enforced by IAM before a request runs, admitting an external person is a credential decision rather than a trust-the-client decision. One path serves every issuer: the one exchange (`POST /exchange-credentials`, `backend/lambda/src/credential-exchange.ts`), and one membership function a host's backend invokes to open a context conversation and add or remove a person (`membershipHandler` in `backend/lambda/src/conversation-management.ts`). The issuer is declared in the trusted-issuer registry, `issuers` in `deploy.config.json`, validated at synth by `backend/lib/config/issuers.ts`.

**The external person is one AppInstanceUser, like everyone else.** The exchange mints an opaque id once for the pair (registry issuer id, declared subject) and records it in the `Identities` index, so a second login from the same identity provider resolves to the same AppInstanceUser rather than creating a new one, and the same subject value under another issuer maps to a different person. The id carries no meaning: what makes the person external is their issuer's row, not a prefix. The external person can act only as themselves, because the bearer pin names their AppInstanceUser. The exchange mints the opaque id through the one minter and records it in `Identities` under `<registry id>|<declared subject>` (`backend/lambda/src/lib/person-identity.ts`); the token's `iss` is matched exactly to its registry entry, and a token from an issuer the registry does not declare resolves to nobody.

**What a credential reaches is the issuer's declaration and the person's memberships.** The person signs in through the ordinary exchange, which vends the classification their issuer's clearance source names, on that classification's role, bearer-pinned to their AppInstanceUser. A request may name one conversation to narrow the credential to it, with the same anchored, wildcard-free value any person's vend accepts, and naming a conversation is not admission to it. A first sign-in writes the person's `Identities` row, so a host's add finds them. Membership is the second layer: an external person who names somebody else's conversation gets a credential Amazon Chime SDK then refuses.

**An external person is an ordinary identity, and admission to a host's conversation is a backend act.** The conversation is opened by the host's backend, which invokes the membership function behind IAM with the context, its private grounding and the person, so a person never names a context to enter one. An entry's optional `contextClassification` names the classification those conversations are created at: synth holds it to one of that issuer's own classifications, conversational, with one value across the registry, and declaring it is what stands up the membership function (`backend/lib/config/issuers.ts`). A person from that issuer is served every person route, like any signed-in person, and what limits them is how their issuer is declared, their classification and their memberships. `backend/test/lib/a-host-pool-person-takes-the-ordinary-exchange.test.ts` holds the exchange half, and `backend/test/lib/the-edge-admits-a-token-only-where-its-person-is-served.test.ts` the gateway half.

**An external person is held by the classification axis like anyone else.** They are vended on the role of the classification their issuer's source names, and that role's channel grant is conditioned on the conversation's classification tag, so they reach a conversation only where their classification grants it and their membership admits them.

## Business Problem

A customer, partner or external specialist often needs to join one conversation without holding an account in this deployment, and should enter at their own capability rather than through a shared guest login or by being migrated in. The alternatives a business is left with are all bad in a different way: provisioning an account for every outside person makes the directory a liability and off-boarding a project; a shared guest identity removes attribution exactly where it matters most; and building cross-provider federation means owning token verification, identity derivation and a credential boundary that has to hold against the least trusted caller in the system. What a business actually wants is to route its own staff into customer conversations using the SSO it already runs, and have that person appear as themselves with scoped, audited access like any member.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here. Four of them meet this seam. The external person themselves is not a persona in that document, and what they need is set out under the end user's journey because they experience the conversation the same way.

### Admin / operator

**How this relates to them:** they answer for who can reach a conversation, and an external participant is the hardest case to answer for - a person with no account here, in a conversation that belongs to someone else. What makes it answerable is that the credential is pinned to the person's classification and expires, and that admission happened in the backend rather than by the person choosing to join.

| What they need | Requirement |
|---|---|
| An external person who reaches only what their classification and memberships allow | FR5, FR13 |
| Admission as a backend act they can review, never self-service | FR8, FR9 |
| No standing access: a short credential and a membership that can be removed | FR12 |
| An external session that can act only as itself, with the action attributable | FR4, FR7 |

### Platform developer

**How this relates to them:** they wire the second identity provider and own the gap between the boundary this document describes and the one the deployed path applies. The honest version of that gap is the most useful thing this document holds for them.

| What they need | Requirement |
|---|---|
| One registry entry per issuer, with nothing extra provisioned when none is declared | FR1 |
| Token verification at the gateway against the host's own pool, not trust in a connector | FR2 |
| An external person who is one AppInstanceUser like anyone else, never colliding with a native one | FR3, FR16 |
| The channel flow associated before any external member exists, so no first message bypasses it | FR10 |
| An accurate account of which boundary the deployed path applies, against the one this document describes | FR13, FR14 |

### Manager

**How this relates to them:** they monitor the interactions between their team and their customers, and this is the seam that puts their own staff into those conversations. Their concern is that it works with the SSO their business already runs and that a person's arrival does not become a data-handling question.

| What they need | Requirement |
|---|---|
| Their own staff routed in through their existing SSO, with no user migration | FR2 |
| A staff member's access ending when the case does | FR12 |
| Private grounding about a customer never readable by the conversation's members | FR11 |

### End user

**How this relates to them:** the customer is the reason this exists. They reach a real person inside the same experience, with the context already there, without leaving it. Nothing about the mechanism should be visible to them.

| What they need | Requirement |
|---|---|
| A real person in the conversation rather than a referral out of band | FR9 |
| Full context carried, so they do not repeat themselves | FR11 |
| An external participant who cannot moderate, rename or manage membership in their conversation | FR6 |

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable.

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | An external issuer is one entry in the trusted-issuer registry (`issuers` in `deploy.config.json`); an entry that declares `contextClassification` is what stands up the host membership function, and no route or handler of its own exists for any issuer | Enabler | Yes | `an-issuer-declares-its-reach` (unit, behavior), `a-feature-has-one-path` (unit, source text) |
| FR2 | An external person authenticates against their own identity provider, and their token is validated at the gateway against that pool rather than trusted from a connector or a request body | Table stakes | Yes | none |
| FR3 | The external person's AppInstanceUser has an opaque id minted once by the exchange for (registry issuer id, declared subject) and recorded in the `Identities` index, so a foreign subject never collides with a native one and a later login resolves to the same AppInstanceUser | Table stakes | Yes - an opaque UUID v7 minted once per (registry id, declared subject) and recorded in `Identities` (`backend/lambda/src/lib/person-identity.ts`) | `person-identity` (unit, behavior), `a-person-is-keyed-by-their-issuer` (unit, behavior) |
| FR4 | The AppInstanceUser id is both the messaging identity and the value the bearer-pin session tag carries, so an external session can act only as itself | Table stakes | Yes | `the-bearer-pin-is-the-person-tag` (unit, source text), `a-host-pool-person-takes-the-ordinary-exchange` (unit, behavior) |
| FR5 | A first sign-in through the ordinary exchange registers the person, so the host can add someone who is not in any conversation yet; a request may name one conversation to narrow the credential, and that value cannot widen the policy resource it is interpolated into | Table stakes | Yes | `a-host-pool-person-takes-the-ordinary-exchange` (unit, behavior) for the registration; `credential-exchange` (unit, behavior) for the literal channel check |
| FR6 | A person a host adds is a member and never a moderator, so they never moderate, manage membership or moderators, or delete a conversation | Table stakes | Yes | `a-host-adds-a-person-to-its-context-conversation` (unit, behavior) |
| FR7 | Both session tags are asserted on every vend, and the classification role's trust policy requires the classification tag, so a session asserting nothing is refused outright | Table stakes | Yes | `a-host-pool-person-takes-the-ordinary-exchange` (unit, behavior), `credential-exchange` (unit, behavior) |
| FR8 | Naming a conversation is not admission to it: membership is a separate act, and Amazon Chime SDK refuses a non-member regardless of what the credential names | Table stakes | Yes | `a-host-adds-a-person-to-its-context-conversation` (unit, behavior) for the admission half |
| FR9 | Admission is a backend act, never self-service: the host opens the context conversation and adds and removes a person through its own membership function, invoked directly behind IAM under its own scoped role, so naming a context is never admission to it | Differentiator | Yes | `a-host-adds-a-person-to-its-context-conversation` (unit, behavior) |
| FR10 | The channel flow is associated before any member is added, so an external member's first message cannot bypass it, including on a retried add that finds a conversation whose first create stopped before the flow was attached: the add reads the channel's flow and attaches it when missing before it adds a member, and adds nobody when it cannot (`addContextMember`) | Enabler | Yes | `a-host-adds-a-person-to-its-context-conversation` (unit, behavior, a retried add after a partial first create) |
| FR11 | The host's private grounding about the external person and the conversation never reaches member-readable channel metadata; it is written to a server-only store. On an add, a grounding or routing field the host omits (`userName`, `userLanguage`, `participantProfile`, `domainContext`, `otherContexts`, `segment`) is left as the conversation has it, and a host clears one by sending it as `null` | Differentiator | Yes | `a-host-adds-a-person-to-its-context-conversation` (unit, behavior) |
| FR12 | Access is not standing: the credential is short-lived, and removing the membership ends the external person's reach | Table stakes | Partly - the vend is one hour and the host's remove (`op: 'remove'`) is wired; nothing closes a case out on its own, so the removal is an act someone performs | none |
| FR13 | An external person is held by the classification axis like anyone else: they are vended on their classification's role, whose channel grant is conditioned on the conversation's classification tag | Table stakes | Yes | `a-host-pool-person-takes-the-ordinary-exchange` (unit, behavior) |
| FR14 | An external person's reach is derived from their issuer's declared clearance source (a claim-to-classification mapping, a fixed classification set, or their groups at that issuer translated into AgentEchelon groups) and the classifications that source may grant; a claim value the mapping does not declare, and a provider group the entry does not translate, reach nothing, and an issuer entry that declares no source is refused at synth. A connector or an identity provider can only ever grant less | Differentiator | Partly - the registry and the exchange derive reach from the declared source, within the issuer's classifications (`holderTokenOf`, `backend/lib/config/issuers.ts`), for a Cognito pool issuer, and an OIDC issuer's tokens reach the exchange through the edge authorizer, which verifies them against the entry | `a-person-is-keyed-by-their-issuer` (unit, behavior), `an-issuer-declares-its-reach` (unit, behavior), `the-edge-refuses-a-token-it-cannot-prove` (unit, behavior); live: `backend/scripts/deny-test-issuer-mapping.mjs`, held on dev on 2026-11-05 (`node scripts/run-deny-tests.mjs issuer-mapping` from `backend/`) |
| FR15 | Where the platform's own surface cannot sit in front of the external person, a connector relays their messages and bears the conversation itself, with the person holding no credentials and appearing as attribution metadata | Optional - attach instead | No | none |
| FR16 | One path per feature for every issuer: the exchange and the membership function serve an external person through the same code as anyone else, and no per-issuer copy of a handler exists. An external person's records, clearance, contact address and display name are read through the same `Directory` and `ClearanceSource` seams, keyed by AppInstanceUser, so nothing skips or special-cases them | Table stakes | Yes - one exchange and one membership function serve every issuer. The readers do not skip an external person: the membership audit asks `Directory.clearanceOf` by person and records a membership it cannot establish a clearance for as unaudited (`backend/lambda/src/membership-audit.ts`), and delivery email resolves every member through `Directory.contactFor` (`backend/lambda/src/lib/channel-notify.ts`) | `a-feature-has-one-path` (unit, source text), `membership-audit` (unit, behavior), `lib/channel-notify` (unit, behavior) |

**Reading the "Validated by" column.** Backend unit tests live in `backend/test/`, with the shared-library ones under `backend/test/lib/`; end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../../reference/e2e-coverage-matrix.md); the admin console's Vitest suite lives under `frontend/packages/admin/src/`. The status in brackets is what the test does, which matters more than that it is green:

- **behavior** - executes the code path and asserts on the result.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong value.
- **none** - no test exists.

**Why the credential guards are unit tests rather than end to end.** This path needs a second issuer in the registry and is absent from most deployments, so an end-to-end spec would self-skip, and a skipped test is not coverage. The guards call the exchange with a host pool's token and assert the role and tags it assumes; the live deny-tests (`backend/scripts/deny-test-bearer-pin.mjs`, `backend/scripts/deny-test-issuer-mapping.mjs`) run where a deployment declares the fixture issuer.

**Acceptance criteria.** With no external issuer declared, a token from any pool but the deployment's own resolves to nobody. With a host pool declared with an ordinary clearance source, a token from it is vended the classification that source names, on that classification's role, and a first sign-in registers the person. A vended credential asserts both session tags. An external person admitted to one conversation cannot reach another even with a valid credential naming it, because membership refuses them. A host's private grounding is absent from channel metadata and present in the server-only store.

**SETTLED:** reach comes from the issuer's configuration (FR14). Each registry entry declares a clearance source and the classifications it may grant, and the exchange asks the profile registry (`tokenForHeldClassifications`) for the declared classification that stands for what remains within the issuer's classifications. An issuer that wants one role for every external person declares a fixed set.

**SETTLED:** an unmapped group reaches nothing, never a lowest clearance, and nothing narrows by comparing classifications in an order: under [ADR-046](../../../design/decisions/046-classifications-are-a-set-not-a-ladder.md) a classification is a declared set of grants with no rank, and an undeclared set reaches nothing rather than falling back to a floor. FR14 asks the profile registry, which is the one place that interprets a classification value.

**OPEN:** what ends an external person's access when a case closes (FR12). The host's remove exists and nothing calls it on a schedule or on a conversation reaching a terminal state.

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| Migrating an external person into this deployment's identity provider | The whole point is integrating rather than migrating (tenet P5). An account per outside person makes the directory a liability and off-boarding a project | [SPEC-CREDENTIAL-EXCHANGE.md](./SPEC-CREDENTIAL-EXCHANGE.md) - the full lifecycle for people who *are* users here |
| A shared guest login | It removes attribution exactly where it matters most, and one compromised credential reaches every conversation it was ever used in | FR3 and FR4 - an AppInstanceUser of their own and a bearer pin on it |
| Adding an eligible, already-registered colleague | A different gate entirely: a registered person has an authoritative clearance to read, where an external person has a foreign token to verify | [SPEC-ADD-USER-ESCALATION.md](./SPEC-ADD-USER-ESCALATION.md) - the eligibility gate for registered people |
| Voice, SMS and meeting access for the external person | Comms are a connector concern, resolved per use case, and they do not change the identity or the classifications | [SPEC-CONVERSATION-TYPES.md](../conversation/SPEC-CONVERSATION-TYPES.md) - Connectors, and what a connector provides |
| Deciding who may be pulled in | The conversation type's participants policy and a connector's participant resolution answer that; this document answers what happens to the identity once resolved | [SPEC-CONVERSATION-TYPES.md](../conversation/SPEC-CONVERSATION-TYPES.md) - The model, and Connectors |
| Reclassifying a conversation so an external person can be admitted | The classification is set once at creation and is immutable. The classification is not negotiable by the thing it bounds | [SPEC-CONVERSATION-SECURITY.md](./SPEC-CONVERSATION-SECURITY.md) - the immutable tag and the layers built on it |
| Giving an external person moderation or membership authority in the conversation they joined | A host adds them as a member, and Amazon Chime SDK refuses a member moderation | FR6, and [SPEC-MODERATION.md](./SPEC-MODERATION.md) for who does moderate |
| Building a connector framework | Commodity integration work with a per-business shape, and the resolution seam is what this depends on rather than what it provides | [SPEC-CONVERSATION-TYPES.md](../conversation/SPEC-CONVERSATION-TYPES.md) - Connectors |

## User Experience Description and Mocks

Two modes exist and the choice is per use case, biased toward the first.

### Mode A - direct, and preferred

Where the platform's own surface can sit in front of the external person, they act inside it.

1. **The customer asks for a person**, or a routing decision brings one in. Nothing about the mechanism is visible to them.
2. **The external person authenticates with their own SSO.** Their own identity provider, their own credentials, no account here.
3. **They land in the conversation.** Their membership is what actually admits them. A credential naming a different conversation gets them nothing.
4. **They participate as themselves.** Read, send, mark read. Redact, delete, add a member: none of these are available to a member, and they are refused rather than hidden.
5. **They arrive briefed.** The host's private grounding about the customer and the case reaches the assistant through the server-only store, not through anything a member of the conversation can read.
6. **They leave when the case does.** The credential expires on its own; the membership is removed.

### Mode B - connector-proxy, fallback only

Where the platform's surface cannot be put in front of the person, a connector relays their messages and bears the conversation itself. The external person holds no credentials on this path and appears as attribution metadata. The guard is then on the connector's own bounded identity rather than on theirs, which is strictly weaker, which is why the bias is to Mode A.

### The customer's view, in both modes

A real person is in the conversation, already caught up, inside the same experience they were already in. Tenet P2 is what makes that possible: the conversation is the unit of context, so whoever steps in works from the same live picture and the customer never repeats themselves.

**OPEN:** this document carries no mocks, and the candidate depends on Mode A having a host-embedded surface to draw, which no deployment enables today.

## Related Documents

- [SPEC-CREDENTIAL-EXCHANGE.md](./SPEC-CREDENTIAL-EXCHANGE.md) - the bearer-pinned vend and the restriction spectrum this path adds a role to
- [SPEC-CONVERSATION-TYPES.md](../conversation/SPEC-CONVERSATION-TYPES.md) - the conversation type whose classification is the cap, its participants policy, and the connector that resolves an external person
- [SPEC-CONVERSATION-SECURITY.md](./SPEC-CONVERSATION-SECURITY.md) - the layered access model, including the mixed-trust visibility layer for external guests
- [SPEC-ADD-USER-ESCALATION.md](./SPEC-ADD-USER-ESCALATION.md) - the other way a person joins a conversation, for people who hold an account here
- [SPEC-MODERATION.md](./SPEC-MODERATION.md) - the authority an external person does not hold
- [SPEC-INTERACTION-LAYER.md](../SPEC-INTERACTION-LAYER.md) - the interaction-layer set this belongs to
- [IDENTITY-PROVIDER-GUIDE.md](../../../guides/user/IDENTITY-PROVIDER-GUIDE.md) - wiring a second identity provider
- [ADR-046](../../../design/decisions/046-classifications-are-a-set-not-a-ladder.md) - why the helper's fixed ordering and floor fallback are an open question rather than a design
- [PERSONAS.md](../../../overview/PERSONAS.md) - the canonical definitions of the personas above
- [TENETS.md](../../../overview/TENETS.md) - tenet D1 for the bearer pin and the layered gate, tenet P5 for integrating rather than migrating
- AWS blog, *Integrate your Identity Provider with Amazon Chime SDK Messaging* (June 2021)

## Appendix A - The four layers an external person crosses

Each layer is handled so a gap in any one cannot escalate.

| Layer | What happens | What bounds it |
|---|---|---|
| **L0 - identity provider** | The person authenticates with the business's own SSO | The token is verified at the edge authorizer against the issuer's registry entry. An issuer declaring a `fixed` set reads no claim for reach; one declaring a `mapping` reads the claim it names, within its declared classifications (FR14) |
| **L1 - credentials and boundary** | The exchange validates the token and assumes a bearer-pinned role, returning short-lived credentials | The assumed role is the vend role of the classification the issuer's source names, conditioned on the conversation's classification tag, and a request may narrow it to one conversation |
| **L2 - identity** | The person gets an `AppInstanceUser` with an opaque id, created by the exchange on first exchange (or assigned in advance by an invitation or a connector for a `provisioned-only` issuer) and recorded in the `Identities` index under their issuer, so a later login resolves to the same AppInstanceUser | The id carries no meaning and is never derived from the token, so it is disjoint from every other person by construction. Stored by id, not by personal data. Assignment in advance by a connector or an administrator is built (`provisionSubject`, a `pending` row the exchange binds once); **NOT BUILT:** assignment in advance by an invitation |
| **L3 - messaging** | A privileged backend path admits them to the routed conversation only; their own credentials then let them read and send there | Membership is the per-conversation scope and is never self-service. Removing the membership revokes the reach |

**What the boundary is, precisely.** The exchange assumes the vend role of the person's classification and asserts two session tags: the AppInstanceUser id the exchange minted, which pins the bearer, and the classification the role itself carries, which the role's trust policy requires by exact match - a session asserting nothing is refused. The role carries the messaging action set (`EXCHANGE_MSG_ACTIONS`, `backend/lib/constructs/exchange-role.ts`) on conversations tagged with a classification it grants, pinned to the bearer, plus the archived-conversation read-only Deny. Membership is the second mechanism behind it. A credential lasts one hour.

**One account of the boundary.** There is no group-to-clearance resolution with a floor, and no narrowing outside the exchange: reach is the issuer's declared clearance source within its declared classifications (FR14), the person's id comes from the one minter the one exchange calls, and no id is derived from the token.

## Appendix B - Implementation map

An external issuer is an entry in the trusted-issuer registry, `issuers` in `deploy.config.json`, and every concern below is served by the handler every other person uses.

| Concern | Where |
|---|---|
| Declare the issuer, its subject claim, its clearance source and the classifications it may grant | `backend/lib/config/issuers.ts`, read by the stacks through `backend/lib/constructs/trusted-issuers.ts` and by each function as `TRUSTED_ISSUERS` (`backend/lambda/src/lib/trusted-issuers.ts`) |
| Verify the host pool's token and vend a capped, bearer-pinned credential | `backend/lambda/src/credential-exchange.ts`, at `POST /exchange-credentials` on `PersonApi`, behind the edge authorizer, which admits every issuer the registry declares there |
| Mint or resolve the external person's id | `backend/lambda/src/lib/person-identity.ts` |
| Create a conversation for a host context | `membershipHandler` with `op: 'add'` in `backend/lambda/src/conversation-management.ts`, invoked by the host's backend, which creates it at the registry's `contextClassification` and at the deterministic id `contextChannelId` derives (`createConversationForContext`, `backend/lambda/src/lib/channel-creation.ts`), with the host's grounding |
| Admit an external member, remove one | `membershipHandler` in `backend/lambda/src/conversation-management.ts`, deployed as `ConversationMembershipFunction` (output `ConversationMembershipFunctionArn`) in `backend/lib/stacks/conversations-stack.ts` under its own scoped role, invoked by the host with `{ op: 'add' \| 'remove', contextType, contextId, iss, sub }` |
| The per-connector group map and connector-driven participant resolution | The connector pillar, not built here |

The identity and messaging calls use the current `chime-sdk-identity` and `chime-sdk-messaging` service namespaces, while the IAM action prefix remains `chime:`.

## Appendix C - How it composes

- **With the credential exchange:** federated participants are an additive path - verify an external token, apply the issuer's classifications - rather than a new substrate. Every invariant of the exchange holds unchanged, including the bearer pin.
- **With conversation configuration:** the conversation type's classification is the cap, and its participants policy together with a connector's participant resolution decide who may be pulled in and how.
- **With connectors:** participant resolution turns "bring in a support agent" into a concrete external identity to admit, and the comms seam carries voice, SMS or meeting access for that person where a use case needs it.
- **With moderation:** an external person holds none of it. Redaction is channel-scoped moderation and deletion is cross-conversation administration, and a member reaches neither.
