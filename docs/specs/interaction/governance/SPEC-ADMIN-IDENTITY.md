# SPEC: Admin Identity

**Status:** Implemented (with a small set of tracked gaps, named in the Delivered column of the requirements table)

**Coverage:** `tests/e2e/credential-exchange.spec.ts`, `tests/e2e/admin-attachments.spec.ts`, `tests/e2e/signin.spec.ts`

**Related:** [DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md](./DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md) - how a capability becomes IAM-enforceable. [DESIGN-ADMIN-AGENT-NOTIFICATIONS.md](./DESIGN-ADMIN-AGENT-NOTIFICATIONS.md) - how admin-facing alerts are delivered inside the admin trust boundary.

**Site section:** Interaction layer, governance.

---

## Overview

**An operator acts as their own short-lived, audited `${personId}-admin` identity rather than as a standing bearer.** Every human operator holds two identities: an ordinary chat identity that is membership-gated exactly like any user's, and a separate admin identity that carries privileged authority. Elevation is a property of the identity, not of a credential a chat session could carry, so there is no server-side bearer swap and no path by which a chat credential acquires cross-classification reach. This is the Identity and Access pillar of the interaction layer, on the admin plane.

**The admin identity derives from the person, not from the identity provider.** `<personId>` is the operator's AppInstanceUser id ([IDENTITY-AND-ACCESS-MODEL.md](./IDENTITY-AND-ACCESS-MODEL.md) §1a). The `${personId}-admin` AppInstanceUser is the one second principal a human holds: the admin credential exchange creates it, never anything else, and tags it with its owner's AppInstanceUser ARN, so analytics, audit and erasure attribute an admin-plane action to its owner through that tag rather than by parsing the suffix, and offboarding the owner removes it too. The admin exchange accepts an operator from any declared issuer, for example a staff pool that IAM Identity Center signs into over SAML. **PARTIAL** (FR11): the exchange creates the twin from the minted person id and tags it `owner` (`ensureAdminIdentity` in `backend/lambda/src/admin-credential-exchange.ts`), and a console session name carries any person id (`consoleSessionOf` in `backend/lambda/src/lib/auth.ts`); archival attributes an admin-plane turn to its owner by the twin's id rather than by the tag, because it cannot reach the Amazon Chime SDK. The admin exchange's console route admits, at `AdminApi`'s edge authorizer, only a token whose issuer declares `admin: true`, and the handler vends a console session only to such an issuer (`backend/lib/stacks/admin-api-stack.ts`, `consoleRoleFor` in `consoleSession`, `backend/lambda/src/admin-credential-exchange.ts`).

**`classification` is the only closed axis IAM evaluates.** A conversation and a user each carry a classification, and that axis - and only that axis - caps what an ordinary chat identity may read. Admin authority is separate and additive rather than a higher role on the same ladder: a person is typically `premium` plus a membership of an admin group. Nothing else about a person, a team or an assistant is an ordering IAM can compare, which is why a scoped operator is served by narrowing the grant on that axis instead of by inventing a second one.

**Capabilities are delegated by narrowing a vended, recorded grant rather than by rewriting a policy.** Authority is a set of named capabilities, not one flag. To act, an operator makes a request naming the capabilities and the scope; the exchange vends a session policy that is the intersection of that request with the identity's own boundary, short-lived and recorded. Denying a role one action is one statement omitted from its policy, so `redact` can be held while `delete` is refused, without touching admin status as a whole.

**Every sensitive operation carries at least two enforcement layers, and isolation is proven by deny-test rather than by review** (tenet P4). The gateway evaluates an IAM policy before a handler runs, the handler applies the classification-scope filter, and the session policy pins the resource the credential may touch - the one channel on the messaging plane, and the messages resource on the archive plane, because IAM cannot condition an `execute-api` call on a query parameter. One missed check is therefore not a breach, and the layer that fails does so closed: a principal that cannot be resolved to a definite authority resolves to no scope and sees nothing, never full access (`scopeForRequest`, `caller-scope.ts`, returns `undefined`, and `classificationAllowed` refuses every item for it).

### Two credential planes

Privileged reads reach content through two planes, controlled separately, because they carry different risk.

| Plane | What it reaches | How it is controlled |
|---|---|---|
| Live conversations | An active conversation's messages, membership and moderation | The operator's own admin identity, with a credential scoped to a single conversation, short-lived and recorded per vend. Amazon Chime SDK Messaging enforces the authority; de-provisioning the operator's admin identity revokes it |
| The archive | The durable copy of every conversation, spanning all classifications and persisting after content is redacted or deleted live | Separate short-lived credentials scoped to the archive, over storage encrypted with a customer-managed key. Holding admin authority over live conversations does not by itself grant archive access |

Controlling the archive separately is deliberate: it is the system of record, and where a single over-broad credential would do the most damage, so it is scoped, recorded, time-boxed and revocable on its own.

### Moderator and admin are different levels

Two levels of conversation authority exist and they are not the same thing. **Moderator** authority is channel-scoped: it belongs to whoever moderates a specific conversation, its creator or a member promoted to moderator, and reaches only the channels they actually moderate. **Admin** authority is cross-channel and classification-transcendent: an admin acts on any conversation regardless of classification, as themselves, and is the only level that can delete a message or act on a conversation it does not moderate.

| Action | Moderator (channels they moderate) | Admin (any channel) |
|---|---|---|
| Change conversation configuration (title, non-security metadata) | Yes | Yes |
| Reclassify a conversation | No (immutable) | No (immutable) |
| Add or remove members, promote a moderator | Yes | Yes |
| Join as a non-visible observer | No | Yes |
| Redact a message | Permitted by Amazon Chime SDK for a channel moderator, but no chat-plane credential this platform vends carries `RedactChannelMessage`, so a moderator cannot reach it from the chat app | Yes |
| Delete a message | No | Yes |

Creating a conversation is neither a moderator nor an admin action: it is a base user capability, and moderator status is a consequence of creating the channel rather than a permission that authorizes it. A moderator of a channel cannot exist before the channel does. Deleting a conversation is an admin action only: the `delete-conversation` capability vends `manage-channel` for one literally named conversation, with a stated reason, under the operator's `${personId}-admin` identity, and the console offers it on the Conversations tab. Archiving is the moderator's end-of-life path.

### Calibration

The capability set is modeled on an enterprise context where conversation messages are operational records rather than personal user data, so operators archive, read across conversations and delete as operators, subject to a recorded proof of need. This is a least-privilege starting point, not a fixed policy. Deployments serving other use cases - customer engagement, personal data, stricter data-protection regimes - do their own evaluation and extend the model; none of this is legal advice.

## Business Problem

A business running assistants for users at different clearance levels has to let specific people do privileged things: read any conversation across those levels, moderate a message, delete a message, change who is a member, configure models and routing, read the durable archive. Someone has to be able to do all of that, and the blunt way to allow it is one "admin" flag that unlocks everything - which cannot express "this person may moderate but may not read the archive", makes a stolen session catastrophic, and cannot be narrowed for a role that should see less. A credential that is always live and always able to read everything is also a standing target whose blast radius is the whole platform for as long as it lives, and a privileged action that is not attributable to a named human leaves nobody accountable for it. The alternative to a product's single bolted-on switch is to build the admin identity plane yourself - least-privilege capability model, per-action denial, just-in-time credentials, end-to-end audit - and secure it yourself.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here. The admin / operator persona is the full-access `admins` role; the other operator personas are narrower roles a deployer composes from the same capability set. One narrower role ships, `team-members`, scoped to the assistants a team owns (`ADMIN_ROLES` in `admin-capabilities.ts`); a deployment composes any other from the same keys.

### Admin / operator

**How this relates to them:** this is the break-glass role for a deployment and the only persona whose reach is the whole platform. Everything they do crosses a classification boundary they are not a member of, so the identity model is what makes their work possible and what makes it accountable.

| What they need | Requirement |
|---|---|
| Read, moderate, delete and manage membership across every classification, always as themselves | FR1, FR8 |
| Hold no standing power between actions, so a stolen session expires rather than persisting | FR5 |
| Have every action they take attributed to them by name | FR6 |
| Lose that authority in one step when they leave the admin group | FR5 |
| Archive access controlled separately from live administration | FR9 |

### Platform developer

**How this relates to them:** they debug the platform itself, so they need the raw event structure and per-turn telemetry, and they should not hold customer message bodies to get it.

| What they need | Requirement |
|---|---|
| Technical telemetry and the raw event structure without message content by default | FR2, FR3 |
| A scoped, opt-in, audited content read when a specific investigation needs one | FR5 |
| A role whose omitted capabilities are refused at the gateway rather than hidden in a client | FR3 |

### AI developer

**How this relates to them:** they answer for how an assistant is built, so they need quality signals and prompt-and-reply pairs for the assistants they own, and no moderation, delete or platform-configuration authority at all.

| What they need | Requirement |
|---|---|
| Quality and analytics reads scoped to the classifications they reach | FR2, FR8 |
| Denial of the capabilities their role omits, enforced rather than merely not offered | FR3 |
| A role that cannot be widened by a component they do not control | FR4, FR7 |

### Manager

**How this relates to them:** they monitor a use case rather than build it, so they need conversation content and the moderation-level capability for their own scope, and nothing beyond it.

| What they need | Requirement |
|---|---|
| Conversation content and `redact` for their scope, without `delete` or platform configuration | FR2, FR3 |
| An authority that stops at their scope rather than the whole surface | FR8 |

### End user

**How this relates to them:** they hold no admin identity at all, and that is the point. Moderating the conversations they create is a consequence of creating them, not a granted admin power, and nothing an operator holds can act as them.

| What they need | Requirement |
|---|---|
| To create conversations and moderate the ones they own, with no admin identity | FR1 |
| An assurance that no operator credential can ever speak as them | FR7 |
| A record of who could reach their conversation, and when | FR6 |

**Also served, and not personas in `PERSONAS.md`:** the **deployer**, who composes roles from the capability set and off-boards an operator in one step (FR2, FR5), and the **security and compliance function**, whose question is answered by the vend record rather than by any console view (FR6).

Legal and HR act through the admin / operator surface under the accountability calibration above, and their purpose-scoped reads are specified in [SPEC-ADMIN-CONSOLE.md](../../interface/SPEC-ADMIN-CONSOLE.md).

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable.

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | Each operator holds an ordinary chat identity that is never elevated and a separate admin identity that carries privileged authority, and cross-identity authority cannot attach to a chat credential | Differentiator | Yes | `credential-exchange` (unit, behavior, negative case): an admin on the chat plane pins `${personId}` and never `${personId}-admin`, and an `identity:admin` request from a non-admin is refused; `credential-exchange` (e2e, behavior) |
| FR2 | Authority is a set of capabilities rather than one flag: a full-access admin holds all of them, narrower roles hold defined subsets, and a dedicated service identity exists only for no-human automation | Differentiator | Partly - the capability set and the service identity ship, and the narrower role is `team-members`, scoped to the assistants its team owns (`ADMIN_ROLES` in `admin-capabilities.ts`); the four example persona roles are **NOT BUILT** | `admin-capability-map` (unit, behavior), `caller-scope` (unit, behavior) |
| FR3 | Each privileged action is a capability a role can be denied independently, enforced where the request is served rather than in the client | Differentiator | Yes - every route in the admin capability catalog is `AWS_IAM` in every deployment (an `AdminApi` route is IAM unless it declares otherwise, `authOf` in `http-api.ts`) with no flag that returns it to the admin-group gate, and each capability owns its own resource, including a sub-path per capability under `POST /query` on `AdminApi` | `deny-test-admin-capabilities` (deployed API, behavior, negative case): a `team-members` session is refused by the gateway on every catalog route it does not hold; `admin-iam-enforcement-wiring` (unit, behavior), `admin-capability-map` (unit, behavior), `credential-exchange` (unit, behavior, negative case): an archive capability is refused on the chat plane, and refused outright to a non-admin |
| FR4 | A principal that cannot be resolved to a definite authority is treated as the least privilege: an unrecognized role resolves to no scope and sees nothing, a missing admin registration refuses the action, and provisioning that cannot establish the level issues no credentials | Table stakes | Yes | `caller-scope` (unit, behavior, negative case): an unresolvable role ARN and a role absent from the scope map both get no scope rather than full access, and an untagged item is refused rather than read as any classification; `auth-admin-mode` (unit, behavior, negative case): `ADMIN_IAM_ENFORCEMENT` without an IAM identity, and an IAM identity without `ADMIN_IAM_ENFORCEMENT`, are both untrusted |
| FR5 | Elevated access is not standing: an operator states a rationale, access is vended short-lived and scoped against that stated purpose, the rationale is stored with the vend, and the grant is left to expire | Gap - prioritize | Yes - every per-conversation vend is scoped to one conversation, lasts 30 minutes by default and is refused without a stated reason (`REASON_REQUIRED`); the reason is written to the Access Log beside what was reached before the credential is returned, and the console asks for it (`ReasonDialog`). The calibration of what the reason accepts is open ([SPEC-ADMIN-CONSOLE.md](../../interface/SPEC-ADMIN-CONSOLE.md) FR29) | `admin-credential-exchange` (unit, behavior), `an-access-is-recorded-before-it-is-granted` (unit, behavior), `credential-exchange` (e2e, behavior), `admin-attachments` (e2e, behavior) |
| FR6 | Every privileged action is attributed to the human who performed it, at the enforcement layer and in an audit event, even when execution runs through the shared service identity | Table stakes | Yes | `credential-exchange` (unit, behavior), `an-iam-caller-is-still-a-caller` (unit, behavior, negative case): a body-supplied caller cannot attribute a write to someone else |
| FR7 | An operator only ever acts as themselves: no credential is minted or wielded as another user or another admin, and a compromised backend component holds no operator authority | Table stakes | Yes | `credential-exchange` (unit, behavior, negative case): the identity and classification are derived from validated claims and a body-supplied `sub` or classification is ignored, and the client is never handed the rename action |
| FR8 | Acting across classifications belongs to the admin identity rather than to any chat credential, and always leaves an attributable record | Differentiator | Yes | `caller-scope` (unit, behavior), `credential-exchange` (unit, behavior) for the vend record |
| FR9 | The archive plane is controlled separately from live administration: scoped, recorded, time-boxed and revocable on its own | Differentiator | Partly - the archive read is vended separately and short-lived, over storage encrypted with a customer-managed key; the per-request proof-of-need decrypt gate that key exists to support is not built | `credential-exchange` (unit, behavior, negative case): the exchange refuses to mix archive and Amazon Chime SDK Messaging capabilities in one credential |
| FR10 | Removing a person from the admin group, disabling or deleting them ends their authority: no new admin credential is vended, the standing admin identity is de-provisioned, and any in-flight credential expires on its short lifetime | Table stakes | Partly: the group check refuses the next vend and an in-flight credential expires. De-provisioning the standing admin identity runs when the admin group changes or a user is deleted, disabled or re-enabled: the Cognito call reaches EventBridge through the platform trail and invokes the sync, typically within seconds (CloudTrail delivery to EventBridge is best-effort), with a daily backstop. The sync counts only enabled members of the admin group, so a disabled admin who stays in the group is de-provisioned | `auth-admin-mode` (unit, behavior) for the group gate; `an-admin-is-a-moderator-of-an-admin-conversation` (unit, behavior) for the admin-conversation moderator memberships and the disabled-user filter; `the-admin-conversation-sync-can-do-what-its-reconcile-asks` (unit, synthesized template) for the event rule and the sync role's moderator grants; none for removing the standing `${personId}-admin` identity, none for event delivery |
| FR11 | The admin identity is `${personId}-admin`, derived from the operator's AppInstanceUser for every issuer, created only by the exchange and tagged with its owner's AppInstanceUser ARN; the console session name carries the person id; analytics, audit and erasure attribute the admin identity to its owner through the tag | Table stakes | **PARTIAL** - created by the exchange from the minted person id and tagged `owner` (`ensureAdminIdentity` in `backend/lambda/src/admin-credential-exchange.ts`); the console session name carries any person id (`consoleSessionOf` in `backend/lambda/src/lib/auth.ts`); archival attributes by id, not by the tag; not verified on a deployment | `credential-exchange.test.ts`, `lib/auth.test.ts` (unit) |

**Reading the "Validated by" column.** Each entry is one specific test, named by its filename without its extension. Backend unit tests live in `backend/test/`, with the shared-library ones under `backend/test/lib/` and the analytics ones under `backend/test/analytics-aurora/`; end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../../reference/e2e-coverage-matrix.md). The status in brackets is what the test does, which matters more than that it is green:

- **behavior** - executes the code path and asserts on the result; **negative case** marks a unit refusal, where the test asserts that the code path refuses.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong number.
- **none** - no test exists.

**A deny-test runs against a deployed stack and lets IAM decide, and only FR3 carries one.** Tenet P4 asks for isolation proven by deny-test rather than by code review, so a row whose evidence is a unit refusal, or only that the allowed path works, is weaker than it looks. `deny-test-admin-capabilities` (in `backend/scripts/`) calls every catalog route as a `team-members` session and requires the gateway to refuse each one it does not hold. Every new admin endpoint is added to the catalog it reads.

**Acceptance criteria.** A non-admin, and an authenticated non-admin, are denied on every admin route in each admin auth mode. A scoped role is denied a capability its persona does not hold, at the gateway and not only in the console. An admin cannot act as another admin's or a user's identity. Provisioning fails closed when the level cannot be established. Removing an operator from the admin group refuses their next vend. Every privileged content read and every moderation emits an attributable vend record.

**The rationale is a precondition of the vend.** A privileged action - deleting a message, changing membership, reading a conversation the operator is not a member of - is authorized only after the operator states why, and that rationale is stored with the vend. This is what makes the credential temporary in a sense that matters: the grant expires on its own, and the record of why it was asked for outlives it. The admin credential exchange refuses a per-conversation vend with no reason (`REASON_REQUIRED`) and writes the reason, the human, the admin identity, the scope, the capabilities and the lifetime to the Access Log before the credential is returned; a vend whose record cannot be written is refused. The console asks once per conversation for its reads and again for every change (`ReasonDialog`).

**OPEN, and narrower than it looks:** what the reason field accepts. A free-text box nobody reads is the failure mode the requirement exists to prevent, so the calibration - free text against a structured purpose, and whether sensitive scope additionally needs a second person - is held in [SPEC-ADMIN-CONSOLE.md](../../interface/SPEC-ADMIN-CONSOLE.md) FR29 beside the surface that asks the question.

**OPEN:** whether ownership of a channel or a use case is a scope axis of its own. Assistant ownership is recorded as the `owner-team` tag on each `AppInstanceBot`, and a team member's console session names only the assistants their team owns ([SPEC-ADMIN-CONSOLE.md](../../interface/SPEC-ADMIN-CONSOLE.md) FR47); no policy condition evaluates that tag, and the platform records no ownership of a channel or a use case, so a manager's scope by use case has no axis to narrow on.

**OPEN:** whether "who redacted or deleted, and when" is a capability of its own or rides on the moderation capability.

**OPEN:** whether, and how strictly, every cross-classification read - not only mutations and content vends - must be logged before the model is used where messages are personal data.

**No opt-out.** The admin-group gate is never the boundary on a catalog route: every one is `AWS_IAM` in every admin auth mode, and no context flag changes that. `adminAuthMode` selects no authorizer: `GET /feedback`, the feedback summary, is a catalog route (`view-analytics`) like every other. The mode only sets `ADMIN_AUTH_MODE` on the admin handlers, and only `service` changes them, trusting any IAM-signed caller as admin (`isServiceAdminCall`).

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| A full data-protection policy | The capability set is calibrated for an enterprise context where conversation messages are operational records. A deployment where they are personal data adds erasure propagation to the archive, read-access logging of sensitive reads, retention bounds and its own review | [SPEC-ACCESS-AND-CONTROLS-AUDITING.md](./SPEC-ACCESS-AND-CONTROLS-AUDITING.md) - the record, its retention toggles and what a per-read control would cost |
| Impersonation, or acting as a user | Deliberately impossible rather than missing: every action is attributable to the operator who took it, and impersonation breaks that by construction | FR7, and [SPEC-CREDENTIAL-EXCHANGE.md](./SPEC-CREDENTIAL-EXCHANGE.md) - the bearer pin that makes an actor able to act only as itself |
| Reclassifying a conversation | A conversation's classification is set once at creation and is immutable by design, because every live decision reads that tag. No role can change it | [SPEC-CONVERSATION-SECURITY.md](./SPEC-CONVERSATION-SECURITY.md) - the layered access model the tag drives |
| Legal hold and e-discovery | Sketched as future architecture, not built | [SPEC-ACCESS-AND-CONTROLS-AUDITING.md](./SPEC-ACCESS-AND-CONTROLS-AUDITING.md) - the legal-hold toggle and its per-user scope |
| Admin authority from an identity pool | Admin authority is a claim, additive to a user's classification, never a property of which pool or issuer holds the person. A deployment may keep administrators in a staff pool apart from a self sign-up customer pool, so a self-registered customer never sits beside them, and that pool is an issuer like any other, not an authority. A host application maps its own admin claim in | [IDENTITY-AND-ACCESS-MODEL.md](./IDENTITY-AND-ACCESS-MODEL.md) - a person as one AppInstanceUser, groups as authority, and the three identities called "admin" |
| Granting or revoking admin status from the admin console | Minting the authority the console runs under from inside the console is a privilege-escalation path | [SPEC-ADMIN-CONSOLE.md](../../interface/SPEC-ADMIN-CONSOLE.md) - what the console manages, and what it deliberately does not |

## User Experience Description and Mocks

**The identity plane has no surface of its own, and its correct appearance is an absence.** An operator signs in to the admin console, and what they experience is that the actions their role holds work and the ones it does not are refused. There is no elevation prompt, no session to keep alive and no credential to copy.

1. **Sign in once, as themselves.** Entry is gated on the console session's capability set, issued for the `admins` or `team-members` role the person's groups name, with an access-denied screen for a sign-in that holds none, and sign-in carries the multi-factor, forgot-password and force-change challenges the pool is configured with (FR1).
2. **Act, one credential at a time.** Opening a conversation, redacting a message, adding a member or opening an attachment each vends its own short-lived credential under the `${personId}-admin` identity, scoped to that one conversation or that one object key. A denial fails that action rather than the whole read, which is what makes a narrower role usable rather than merely safer (FR3, FR5).
3. **See only what the role reaches.** A scoped operator's lists come back already narrowed, because the narrowing happens where the request is served. A row that is absent is refused rather than filtered in the browser (FR8).
4. **Leave, and be finished.** Removal from the admin group refuses the next vend; nothing has to be revoked by hand (FR10).

The one operator-visible artifact of this model is the record it leaves, read as the membership history and the access-review views in [SPEC-ACCESS-AND-CONTROLS-AUDITING.md](./SPEC-ACCESS-AND-CONTROLS-AUDITING.md).

**OPEN:** this document carries no mocks, and whether the identity plane warrants one is unsettled. The candidate is the Access Log the console already shows ([SPEC-ADMIN-CONSOLE.md](../../interface/SPEC-ADMIN-CONSOLE.md) FR30), which records each credential vended and not what was done with it.

## Related Documents

- [DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md](./DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md) - the mechanics of FR3: the capability catalog, the per-resource authorizers, and the fail-closed scope resolver
- [DESIGN-ADMIN-AGENT-NOTIFICATIONS.md](./DESIGN-ADMIN-AGENT-NOTIFICATIONS.md) - the admin-plane delivery path for admin-facing alerts, and the trust boundary it stays inside
- [PERSONAS.md](../../../overview/PERSONAS.md) - the canonical definitions of the personas above
- [IDENTITY-AND-ACCESS-MODEL.md](./IDENTITY-AND-ACCESS-MODEL.md) - a person as one AppInstanceUser, groups as authority, and the three identities called "admin"
- [SPEC-CREDENTIAL-EXCHANGE.md](./SPEC-CREDENTIAL-EXCHANGE.md) - the bearer-pinned vend this model narrows
- [SPEC-ACCESS-AND-CONTROLS-AUDITING.md](./SPEC-ACCESS-AND-CONTROLS-AUDITING.md) - the append-only record of who could act, and what changed
- [SPEC-ADMIN-CONSOLE.md](../../interface/SPEC-ADMIN-CONSOLE.md) - the operator surface these identities act through
- [SPEC-MODERATION.md](./SPEC-MODERATION.md) - channel-scoped moderation, distinct from cross-channel administration
- [SPEC-CONVERSATION-SECURITY.md](./SPEC-CONVERSATION-SECURITY.md) - the layered access model this plane operates inside
- [ADMIN-INTEGRATION-GUIDE.md](../../../guides/admin/ADMIN-INTEGRATION-GUIDE.md) - the three admin auth modes
- [ADMIN-GUIDE.md](../../../guides/admin/ADMIN-GUIDE.md) - operating the console
- [TENETS.md](../../../overview/TENETS.md) - tenet P4, which the two-identity split and the deny-test discipline follow from
