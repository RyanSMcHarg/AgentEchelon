# Identity & Access Model

**Status:** Implemented (reference: the live identity and access model).

**Problem and who it's for:** A business that runs assistants for users at different clearance levels needs to trust - and be able to verify - exactly who can do what and which primitive enforces each boundary, so it can reason about isolation and map its own operators in. The alternative is to trust a product's access claims without an authoritative account, or to design, document, and secure your own identity-and-IAM model. This is for the platform developer and admin/operator who need that authoritative account of who can do what and which primitive (Cognito / IAM / Amazon Chime SDK) enforces it. It documents the one user pool, the four additive groups, the three distinct "admins," and the bearer-pinned, classification-capped exchange. (Current state: authority lives on group membership and the credential exchange, not a separate admin pool or the Identity-Pool roles - a design worth understanding before reasoning about the model.)

**Site section:** Interaction layer, Identity & Access pillar (core plane).


**Why this doc exists.** "Admin" means three different things in this codebase, and two of them are easy to conflate. AgentEchelon runs on **one** Cognito user pool (not a separate admin pool), and the tier boundary is enforced at the credential exchange, not the Identity-Pool roles. This document is the account of *who* can do *what*, and *which primitive* (Cognito / IAM / Amazon Chime SDK) enforces it, so you can reason about the security model without reverse-engineering five stacks.

---

## 1. TL;DR

- **One Cognito user pool.** Not a separate admin pool. Authority comes from **group membership**, not from the pool you live in.
- **Four groups, additive:** `basic` / `standard` / `premium` / `admins`. A user can hold more than one; `admins` is meant to be held *in addition to* a tier (e.g. `premium` **+** `admins`). See [§4](#4-can-a-user-be-in-multiple-groups-yes-by-design).
- **"Admin" is three distinct things** ([§3](#3-the-three-admins)):
 1. the Cognito **`admins` group** (a claim) - gates the admin console/API and unlocks the cross-tier rung of the credential exchange;
 2. the **`AdminAuthenticatedRole`** IAM role - **empty and powerless**, kept only so the Identity Pool can resolve a principal;
 3. the Amazon Chime SDK **`app-instance-admin`** identities that hold cross-channel redact+delete: a dedicated **service** identity (not a human) for automated administration, plus each human admin's own **separate `${sub}-admin`** `AppInstanceUser` (their chat identity `${sub}` is never registered), whose scoped credential the admin wields client-side.
- **The frontend reaches Amazon Chime SDK *only* through the credential exchange** (bearer-pinned, classification-capped). The Identity-Pool tier roles grant **nothing** for Amazon Chime SDK - there is no Identity-Pool fallback.
- **Human admins administer CLIENT-SIDE as their own `${sub}-admin` identity.** The credential exchange vends a per-channel, short-lived, audited cred (`identity:'admin'`) pinned to `${sub}-admin`; the console calls Amazon Chime SDK redact/delete/membership directly, attributed to the human at the Amazon Chime SDK layer and in an audit event (`admin_scoped_credential_vend`). The chat identity `${sub}` is never elevated. The dedicated service identity handles automated, no-human paths.

---

## 2. The primitives and how they're wired

| Layer                   | Primitive                                               | What it establishes                                             | Where                                                                                                             |
| ----------------------- | ------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Identity**            | **One** Cognito User Pool                               | Who you are (authN); groups you hold                            | `cognito-auth-stack.ts` (UserPool + `basic`/`standard`/`premium`/`admins` groups)                                 |
| **Claim**               | `cognito:groups` in the JWT                             | The authoritative permission signal                             | `auth.ts` `parseGroups`/`extractClaims`/`TIER_ORDER`                                                              |
| **App-layer AuthZ**     | API Gateway Cognito authorizer + `auth.ts` guards       | Gate admin/tier APIs on the group claim                         | `requireAdmin`/`callerIsAdmin`/`requireGroup`                                                                     |
| **Data-plane creds**    | **Credential exchange** (STS rung roles, bearer-pinned) | The *only* way the SPA gets Amazon Chime SDK creds; caps by classification | `cognito-auth-stack.ts` `grantPinnedExchangePermissions`, `credential-exchange.ts`, `SPEC-CREDENTIAL-EXCHANGE.md` |
| **Identity-Pool roles** | `AuthenticatedRole` + per-tier roles                    | **Empty** - principal resolution only, no Amazon Chime SDK power           | `cognito-auth-stack.ts` `makeTierRole`                                                                            |
| **Administration identity** | Per-human `${sub}-admin` (client-side) + service `app-instance-admin` (automation) | Cross-channel redact **and** delete                             | `credential-exchange.ts`, `SPEC-ADMIN-IDENTITY.md`, `SPEC-MODERATION.md`                                          |
| **Channel boundary**    | IAM `aws:ResourceTag/classification` on channel actions | min(userTier, channelTier), fail-closed ALLOW                   | `agent-classification-common.tierChannelScopedAllow`                                                                        |

Two facts most readers get wrong, both verified in code:

1. **The per-tier Identity-Pool roles are empty.** `makeTierRole = (logicalId) => new iam.Role(this, logicalId, { assumedBy: authTrust })` - no inline or managed policies (`cognito-auth-stack.ts:342`). The comment above it is explicit: the roles "are KEPT (so the pool still resolves a principal … ) but are powerless for Amazon Chime SDK. The frontend reaches Amazon Chime SDK ONLY via the exchange." So `AdminAuthenticatedRole` being an "admin" role grants **zero** admin power.

2. **The classification boundary lives on the credential-exchange rung roles, not the Identity-Pool roles.** `grantPinnedExchangePermissions` applies `tierChannelScopedAllow(rung, …)` to the `basic`/`standard`/`premium` rungs (`cognito-auth-stack.ts:432`), each **bearer-pinned** to `…/user/${aws:PrincipalTag/sub}`. This is the same fail-closed tag-gate the specs describe, but attached to the exchange rung, not the Cognito user role.

---

## 3. The three "admins"

They share a word and nothing else. Keep them separate or the model won't make sense.

### 3.1 Cognito `admins` **group** - a claim
- **What it is:** membership in the `admins` Cognito group, surfaced as a value in the `cognito:groups` JWT claim.
- **What it unlocks:**
 - **The admin console + admin APIs.** `callerIsAdmin(event)` / `requireAdmin` check `parseGroups(claims['cognito:groups']).some(g => ADMIN_GROUPS.has(g))` (`auth.ts` → `callerIsAdmin`). Default admin group name is `admins`, overridable via `ADMIN_GROUP_NAMES` for host-app integrations (`auth.ts` → `ADMIN_GROUPS`, see `ADMIN-INTEGRATION-GUIDE.md`).
 - **The cross-tier rung of the credential exchange.** The `admin` rung gets **unconditioned** channel access (`cognito-auth-stack.ts:416-428`) - still bearer-pinned to the admin's own user. This is how a human admin can *read and participate in* channels across every tier **as themselves**.
- **What it does NOT grant:** message **delete/redact**. The chat action set (`EXCHANGE_MSG_ACTIONS`, `cognito-auth-stack.ts`) has no `Update/Redact/Delete`. Deleting/redacting others' messages requires the admin's separate `${sub}-admin` identity, vended per-channel by the exchange on an `identity:'admin'` request (§3.3), never the chat rung.
- **Who assigns it:** added to the group explicitly (not derived from `custom:tier`; the post-confirmation trigger only mirrors *tier* into its matching group). `admins` is additive - held **alongside** a tier.

### 3.2 `AdminAuthenticatedRole` - an **empty** IAM role
- **What it is:** the Identity-Pool role mapped to the `admins` group so the pool can resolve a principal and `cognito:preferred_role` flows (`cognito-auth-stack.ts:348,355`).
- **What it grants:** **nothing** for Amazon Chime SDK. Built by `makeTierRole` with no policies. Its existence is an artifact of the Identity-Pool role-mapping contract, **not** an authority. Do not reason about admin power from this role.

### 3.3 Amazon Chime SDK `app-instance-admin` - service AND per-human identities

See `SPEC-ADMIN-IDENTITY.md` for the full model. Two kinds of app-instance-admin exist:
- **The service app-instance-admin:** a single dedicated **service** `AppInstanceUser` (`AppInstanceUserId = agent-echelon-admin`), created and registered as an `AppInstanceAdmin` by the `create-app-instance-admin.ts` custom resource; ARN in SSM (`/agent-echelon/app-instance-admin-arn`). Not a human, not tied to any Cognito user. It is used for **automated, no-human** administration (for example membership-audit auto-revoke).
- **Per-human admin identities:** each human admin has a SEPARATE `${sub}-admin` `AppInstanceUser` registered as an `AppInstanceAdmin` (their chat identity `${sub}` is never registered). Human-initiated moderation runs **client-side** from the admin's own browser, using the `${sub}-admin` bearer, vended per-channel, short-lived, and audited by the Credential-Exchange (`identity:'admin'`; see `SPEC-ADMIN-IDENTITY.md`). It is attributed to the human at the Amazon Chime SDK layer and revoked per person.

**What either holds:** cross-channel **redact AND delete**, authority a channel moderator (redact-only) and the per-tier bots (moderators of their own channels only) do **not** have.

**The admin identity's cred is a browser credential; the service one is not.** The Credential-Exchange vends the `${sub}-admin` admin-plane cred to the admin's browser only on an `identity:'admin'` request: scoped to one channel, short-lived, and recorded as `admin_scoped_credential_vend`. The admin console then calls Amazon Chime SDK redact / delete / membership directly (`chimeService.ts`). The chat identity `${sub}` is never vended admin-plane creds. The service app-instance-admin is used only for no-human automation. Attribution is native at the Amazon Chime SDK layer (the human's own `${sub}-admin` ARN) **and** in the audit trail.

### 3.4 The Amazon Chime SDK implicit-role model (the layer beneath admin #3)

The three "admins" above are AgentEchelon's constructs. Underneath, Amazon Chime SDK Messaging enforces its **own** authorization model - the "implicit roles" - that operates *in addition to* IAM. Understanding it is what makes §3.3 precise, and it is why a **service** `app-instance-admin` is the right (and necessary) tool for cross-channel administration.

**Implicit roles are a second, independent gate.** Authority is a function of the caller's **role relative to the channel** (AppInstanceAdmin / ChannelModerator / Member / Non-member), enforced by the Amazon Chime SDK back end regardless of what IAM says. From the AWS authorization-by-role reference ([`chime-sdk/.../auth-by-role.html`](https://docs.aws.amazon.com/chime-sdk/latest/dg/auth-by-role.html)), the meaning of a **Denied** cell is explicit:

> **Denied** - *Even if the correct Action/Resource context is specified in the IAM Policy, it will still be blocked by the back end.*

So **IAM-allowed is necessary but not sufficient.** Two gates stack:

1. **IAM** decides which `x-amz-chime-bearer` ARN your credentials may name (the call is performed **as** that `AppInstanceUser`/`AppInstanceBot`). In AE the credential exchange **pins** the bearer to the caller's own `sub`, so you can only ever act as yourself.
2. **Amazon Chime SDK's implicit-role model** then decides what that bearer may do on the target channel - and can **deny even when IAM allows**.

| Implicit role | Scope | Can | Cannot (Amazon Chime SDK denies even if IAM allows) |
|---|---|---|---|
| **AppInstanceAdmin** | Every channel in the app instance; **no membership needed** to moderate | `ChannelModerator` actions on **all** channels; `RedactChannelMessage`; **`DeleteChannelMessage`**; manage members/moderators/bans | `SendChannelMessage` **without first joining** (must `CreateChannelMembership` for itself to send); edit *others'* messages (`UpdateChannelMessage` = own only) |
| **ChannelModerator** | Only channels it moderates | add/remove members & moderators, manage bans, **`RedactChannelMessage`**, list messages, `UpdateChannel`/`DeleteChannel` | **`DeleteChannelMessage` = Denied**; anything in channels it doesn't moderate |
| **Member - `DEFAULT`** | Only channels it belongs to | `SendChannelMessage`, read; redact/update **own** messages; add members **only in an `UNRESTRICTED` channel** | `DeleteChannelMessage`; moderator actions; add members in a `RESTRICTED` channel |
| **Member - `HIDDEN`** | Same, read-only | read/observe; **invisible** in `ListChannelMemberships` | **`SendChannelMessage`** (Amazon Chime SDK-enforced) |
| **Non-member** | - | only PUBLIC-channel describe/list | send/read/moderate on any channel unless it is also Admin/Moderator |

Two channel properties shape the Member rows: **`Mode`** (`RESTRICTED` → only moderators add/remove members; `UNRESTRICTED` → members can too) and **`Privacy`** (`PUBLIC` → non-members can describe/list; `PRIVATE` → invite-only, opaque to non-members). AE creates conversation channels `RESTRICTED`+`PRIVATE`.

**Redact vs delete - the exact semantics AE relies on:**
- `RedactChannelMessage` → **tombstone**: the message "exists in the back end, but the action returns null content, and the state shows as redacted" (`Redacted=true`). **Moderator or admin** can redact any message; a member can redact their **own**.
- `DeleteChannelMessage` → **removal**: "Deletes a channel message. **Only admins can perform this action.** … A background process deletes any revisions created by `UpdateChannelMessage`." **AppInstanceAdmin-only** - `ChannelModerator` and `Member` are both **Denied**.

**Why this forces the service-admin design.** AE's admin console reviews **every** conversation across all tiers. To act on an arbitrary channel it needs an identity that (a) can `DeleteChannelMessage` at all - which **only** an AppInstanceAdmin can - and (b) can redact/manage a channel **without first being added to it** (admins moderate membership-free; only *sending* would require a join). A per-tier bot is only a moderator of its **own** channels; a human admin promoted to per-channel moderator would still be **delete-incapable** and would have to be added to each channel first. The service `app-instance-admin` satisfies both for automated paths, and each human admin has a separate `${sub}-admin` identity registered as an `AppInstanceAdmin` so their own client-side administration satisfies both as themselves, each an auditable Amazon Chime SDK identity (§3.3). An `AppInstanceAdmin` is required for delete regardless of who acts.

---

## 4. Can a user be in multiple groups? Yes, by design

Groups are **additive**, and that is the intended model:

- **`admins` is meant to be held *with* a tier.** An operator is (typically) `premium` **+** `admins`: `premium` for what their *own* conversations can do, `admins` for the console. `TIER_ORDER` picks the **most-privileged** group for the tier signal (`admins` > `premium` > `standard` > `basic`, `auth.ts` → `TIER_ORDER`) and `isAdmin` is a *separate* any-match check (`auth.ts` → `isAdmin`) - so holding both is coherent: you get admin-console access **and** a concrete data-plane tier.
- **Conversation membership & assistant access are per-channel**, gated by `min(userTier, channelTier)` (`router-agent-handler.ts`) and the channel `classification` tag - independent of how many groups you hold. Being in `admins` does not silently upgrade the assistant in a `basic` channel.
- **Admin-only conversations** are ordinary channels whose membership happens to be all-admins; there is no separate "admin channel" primitive. (For the admin-conversation + email-notification pattern, see `ADMIN-GUIDE.md`.)

> ✅ **Multi-group parsing.** `parseGroups` (`auth.ts`) strips surrounding brackets and splits on whitespace **or** commas, so the three real claim shapes (a JSON array, `"admins,premium"`, and the bracketed multi-group form API Gateway emits, `"[admins premium]"`) all parse. A `premium`+`admins` user therefore passes `callerIsAdmin`. Pinned by a unit test, `backend/test/lib/auth.test.ts`.

---

## 5. Why not a separate admin pool / stricter admin↔user separation?

A common question is why AgentEchelon does not put admins on a fully separate Cognito pool with a stricter admin/user split. The shipped answer, and the reasoning:

- **One pool, group as authority.** Admin power is a *claim* (`admins` group) evaluated at the API layer, not a pool boundary. This keeps a single identity for a person who is both a user and an operator, and lets host-app integrations map their own admin role in via `ADMIN_GROUP_NAMES` / federation (`ADMIN-INTEGRATION-GUIDE.md`) without provisioning a second pool.
- **The strong separation is at the *identity plane*.** An admin's ordinary (chat) browser credential can never act as an admin: it is pinned to `${sub}`, which is **not** an app-instance-admin, and the exchange never vends it a delete/redact action. Admin authority lives on a SEPARATE `${sub}-admin` identity, and the exchange vends its cred only on an explicit `identity:'admin'` request: scoped to one channel, short-lived, and recorded (`admin_scoped_credential_vend`). So the blast radius of a stolen admin browser session is bounded to what the exchange vends per request, one channel at a time and each vend audited, and admin actions are attributed per human at the Amazon Chime SDK layer (the `${sub}-admin` ARN), not only in the app audit trail.

---

## 6. Capability matrix - actor × action × enforcing primitive

The at-a-glance the rest of the doc supports. **Enforced by** names the primitive that actually stops the action; "app API" = server-side handler behind an `auth.ts` guard.

| Action                                 |  Basic user   | Standard user | Premium user |         Admin (group)          | `app-instance-admin` (service) | Enforced by                                                                                         |
| -------------------------------------- | :-----------: | :-----------: | :----------: | :----------------------------: | :----------------------------: | --------------------------------------------------------------------------------------------------- |
| Sign in / hold identity                |       ✅       |       ✅       |      ✅       |               ✅                |              n/a               | Cognito (one pool)                                                                                  |
| Send/read in a `basic` channel         |       ✅       |       ✅       |      ✅       |               ✅                |               -                | Exchange rung, tag-gated `aws:ResourceTag/classification`                                           |
| Send/read in a `standard` channel      |       -       |       ✅       |      ✅       |               ✅                |               -                | Exchange rung                                                                                       |
| Send/read in a `premium` channel       |       -       |       -       |      ✅       |               ✅                |               -                | Exchange rung                                                                                       |
| Send/read in **any/untagged** channel  |       -       |       -       |      -       |      ✅ (cross-tier rung)       |               -                | `admin` exchange rung (unconditioned, still bearer-pinned)                                          |
| Act only as **your own** bearer        |       ✅       |       ✅       |      ✅       |               ✅                |              n/a               | `sub` session tag pins `…/user/${sub}`                                                              |
| Get an assistant reply                 | ≤ basic model |  ≤ standard   |  ≤ premium   |          per channel           |              n/a               | `min(userTier, channelTier)` in router                                                              |
| Open the **admin console / admin API** |       -       |       -       |      -       |               ✅                |              n/a               | `requireAdmin`/`callerIsAdmin` on the `admins` claim                                                |
| View archived conversations (any tier) |       -       |       -       |      -       |               ✅                |              n/a               | Admin API (archive-backed via Athena, read-only, no bearer)                                         |
| **Redact** another user's message      |       -       |       -       |      -       |        ✅ *client-side*         |      ✅ (automated paths)       | Exchange `identity:'admin'` vends a scoped, audited cred; admin's own `${sub}-admin` bearer         |
| **Delete** another user's message      |       -       |       -       |      -       |        ✅ *client-side*         |      ✅ (automated paths)       | Exchange `identity:'admin'` vends a scoped, audited cred; admin's own `${sub}-admin` bearer         |
| Add/remove **another** member          |       -       |       -       |      -       |        ✅ *client-side*         |     (moderator authority)      | Exchange `identity:'admin'` (manage-membership), scoped + audited; Amazon Chime SDK moderator model |
| Remove **own** membership (leave)      |       ✅       |       ✅       |      ✅       |               ✅                |              n/a               | Exchange rung (DeleteChannelMembership pinned to self)                                              |
| Hold **scoped admin** creds in browser |       -       |       -       |      -       | ✅ *(one channel, short-lived)* |              n/a               | Exchange vends only on `identity:'admin'`, per channel + audited                                    |

Reading the two admin columns together is the whole model: an **admin (group)** performs admin actions client-side as their own `${sub}-admin` identity, using a per-channel, short-lived, audited cred the exchange vends only on an `identity:'admin'` request; the service identity covers automated, no-human paths. The admin's *chat* credential never holds admin power.

---

## 6a. Full access matrix - assistants and context (data plane)

§6 covers the **channel** plane (who can act on a conversation). This section adds the **data plane** - which *context* each identity can read - and the **assistants**, which §6 only touched. Verified against code (tier stacks + processors); caveats are flagged in the notes below.

**How a user reads context depends on the use case.** In *this* deployment, users have no direct `s3:GetObject` on `context/*` (the Identity-Pool roles are empty; the exchange rungs grant only Amazon Chime SDK message actions), so a user's access to knowledge is mediated by (a) *which tier assistant* sits in their channel - `min(userTier, channelTier)` - and (b) *what that assistant is allowed to read*. So here, "what can a Basic user learn from the assistant" is answered by the **Basic assistant's row**, not the Basic user's.

> **This is not the only shape - it is one of several the substrate supports.** The `context/{tier}/` store is a **role-tiered knowledge source**, and the same prefix structure is meant to be pointed at whatever the deployment's knowledge *is*. In many use cases that source is content users **also** read directly, by the **same role**: a wiki, a docs site, or **published posts**. A sibling reference deployment wires exactly this - a context-sync function syncs published blog-post summaries into the same tiered prefixes (`…/blog-posts-public.json` for the public/guest role, `…/blog-posts.json` for the authenticated role, an admin variant for everything), so the **assistant** reads the posts from S3 while **users** read the very same posts through the app - each gated by role. There, context is a *shared, role-gated* store, not an assistant-only one. AgentEchelon-Public ships a **seeded placeholder** (`context/{tier}/*.json` sample company context) with that structure in place, ready to be pointed at a real published-content / wiki source. The invariant that holds across all shapes is the **role/tier gate** (`context/{tier}/`), not "who" reads it - assistant, user, or both, according to role.

### Table B - Assistant capabilities & context access

Per-tier assistant (the async-processor / handler role, acting as the tier's **bot** identity). ✅ = allowed · - = denied.

| Capability / resource | Basic asst | Standard asst | Premium asst | Enforced by |
|---|:--:|:--:|:--:|---|
| Send/read on channels **≤ its tier** (bot bearer, tag-gated) | basic | basic, standard | basic, standard, premium | `tierChannelScopedAllow` on the tier role (`agent-classification-common.ts:115`); bearer pinned to `/bot/*` |
| **Redact** messages in its own channels (moderator) | ✅ | ✅ | ✅ | Amazon Chime SDK moderator (bot is channel creator) + `RedactChannelMessage` in tier role |
| **Delete** a message | - | - | - | `DeleteChannelMessage` is AppInstanceAdmin-only; assistants are not admins |
| Create channel / add members / set moderator | ✅ | ✅ | ✅ | tier role grant on `appInstance/*` (`agent-classification-common.ts:395-401`) |
| Read `context/basic/*` | ✅ | ✅ | ✅ | `ContextS3Read` (`*-classification-stack.ts`) |
| Read `context/standard/*` | - | ✅ | ✅ | `ContextS3Read` prefix scoping |
| Read `context/premium/*` | - | - | ✅ | `ContextS3Read` prefix scoping |
| Read `attachments/*` - **the sender's own only** | - | ✅ | ✅ | IAM prefix grant **+** app-layer `senderOwnsAttachmentKey` (per-user object authz) |
| Write `generated-docs/*` (document mode) | - | ✅ | ✅ | tier role `s3:PutObject` |
| Read/write `battle-images/*` (`/battle` image gen) | - | - | ✅ | premium role only |
| KB retrieval - Aurora pgvector, **tier-filtered** | ✅¹ | ✅¹ | ✅¹ | SQL `metadata->>'tier' = ANY(tierScope)` (`document-retrieval.ts`); router builds `tierScope` |
| Embeddings (`amazon.titan-embed-text-v2`) | ✅ | ✅ | ✅ | `bedrock:InvokeModel` scoped to titan-embed (`agent-classification-common.ts:524`) |

**Users, by contrast (data plane), in this deployment:** **no** direct `context/*`, `attachments/*`, `generated-docs/*`, `battle-images/*`, or KB read; users see context only as prose the assistant writes back into the channel. **This is deployment-specific, not a law of the design** - see the shared-knowledge note above: a use case whose context is a wiki or published posts grants users direct, role-gated read of the same source. The service `app-instance-admin` also has **no** context/KB grant - it reviews history through the analytics **archive** (Athena/Aurora), a separate admin-only role, not the context store.

**Notes & verified caveats:**
- ¹ **KB retrieval is live only in Aurora analytics mode** (`ENABLE_LIVE_DRIFT`); in Athena mode no KB/drift path is wired. "On by default" means *when Aurora is deployed*.
- **KB tier filter.** Ingestion stamps `metadata.tier` via `deriveTier` (from the `rag/{type}/{tier}/` prefix; default `RAG_DEFAULT_TIER`, `premium` being the most-restrictive, fail-closed default), and retrieval filters on `metadata->>'tier' = ANY(tierScope)` with no `IS NULL` branch, so untagged chunks are not returned. Pinned by `test/lib/document-ingestion-tier.test.ts`. Aurora-mode only; the filter is tier-only (there is no finer-grained per-document `visibility` field).
- **The context prefix is chosen from the assistant's own tier, not the channel's classification.** Net access is correct because routing binds the tier-matched bot to the channel (processor-tier == channel-tier), and IAM is the real boundary.
- **Context-aware model routing and the configurable intent pack run on the standard tier only**; basic/premium use the tier-default model and the built-in intent pack. The A/B experiment override, per-tier default model, and the separate Haiku classifier **are** wired on all tiers.
- **Attachment reads are ownership-checked.** Both the standard processor and the premium `/battle` vision path verify the sender owns the referenced attachment `fileKey` (`senderOwnsAttachmentKey`) before reading from `attachments/*`, falling back to text-only on a cross-user reference, even though the IAM `s3:GetObject` grant spans `attachments/*`.

## 6b. Defense in depth - guardrails are one layer, not the boundary

A recurring mis-read is to treat Bedrock Guardrails as *the* enforcement. They are not - they protect the **assistant's** input and output. The conversation, and the data boundary, are defended by several independent layers, most of which run **whether or not an assistant is involved**. If any one layer fails, the others still hold.

| Layer | Protects | Runs on | Mechanism | Status |
|---|---|---|---|---|
| **IAM + `classification` tag** | Which conversations a principal may read/send in | **every** Amazon Chime SDK call | Fail-closed ALLOW on `aws:ResourceTag/classification`; provable with a deny-test | Built (§2) |
| **Credential exchange (bearer pin)** | Impersonation - a caller acts only as **itself** | every user Amazon Chime SDK session | STS `sub` session-tag pins the bearer to `…/user/${sub}` | Built (§2) |
| **Bedrock Guardrails** | **Assistant** turns: input (prompt-injection, content) + output (PII, content, markers) | assistant turns **only** | `ApplyGuardrail` `source:'INPUT'` before the call **and** `source:'OUTPUT'` after; fail-open | Built |
| **Channel flow** | Conversation-level message handling - **runs on every message, including human-to-human with no assistant** | every message in a channel (before Lex) | Amazon Chime SDK `CHANNEL_FLOW` processor; must `ChannelFlowCallback` to release, so it can hold/modify/deny any message | Built (mention/`@all` routing, battle orchestration, notify directives, idempotency; also the conversation-level interception point where content rules can run) |
| **Archival + proactive analysis** | Catching failures **after the fact** - tier mismatches, drift, security events | async, **all** Kinesis events | Archive of every channel event + drift detection + `[SecurityEvent]` logging over the archive | Built (Aurora mode); this layer detects and logs, it does not perform automated remediation (Layer-6 auto-revocation) |

Two things this makes explicit:
- **Guardrails only see assistant turns.** A human-to-human message in a shared channel is not guardrailed - but it *is* subject to the IAM/classification boundary, passes through the channel flow, and is archived for proactive analysis. So "no assistant involved" ≠ "no enforcement."
- **The provable boundary is IAM**, not the model layer. Guardrails and the channel flow are content/behavior defenses on top of the data boundary; the thing that *cannot* be bypassed by an application bug is the fail-closed IAM tag gate (§2), and the archival layer is the independent backstop that catches anything the inline layers miss.

## 7. End-to-end: an admin deletes an off-tier message

1. Operator signs in - one pool; JWT carries `cognito:groups = premium, admins`.
2. Frontend calls the credential exchange → gets **admin-rung** creds: bearer-pinned to the operator's own user, cross-tier channel *read*, **no** delete/redact. They can browse across tiers as themselves.
3. Operator opens the admin console and clicks "delete message." The SPA requests an `identity:'admin'` credential from the Credential-Exchange, scoped to that one channel.
4. The exchange verifies the `admins` claim (`auth.ts`), provisions/uses the operator's `${sub}-admin` identity, and vends a short-lived cred, recording `_auditEvent: 'admin_scoped_credential_vend'`. ✅
5. The SPA calls Amazon Chime SDK `DeleteChannelMessage` **directly, as the operator's own `${sub}-admin` ARN** (`chimeService.ts`). Only an `AppInstanceAdmin` can delete, and the `${sub}-admin` identity holds that authority.
6. Amazon Chime SDK attributes the action to the operator's own `${sub}-admin` ARN; the scoped vend is recorded in the audit trail with the operator's Cognito `sub`.

The operator's *chat* credential never held delete power (step 2): the authority lives on a separate `${sub}-admin` identity, vended one channel at a time, short-lived, and **audited on every vend**.

---

## 8. Related docs

- `SPEC-CREDENTIAL-EXCHANGE.md` - the bearer-pinned, classification-capped rung model; the *only* source of frontend Amazon Chime SDK creds.
- `SPEC-MODERATION.md` - the content-moderation surfaces; `SPEC-ADMIN-IDENTITY.md` - the `${sub}-admin`/service app-instance-admin identity (redact vs delete authority).
- `SPEC-CONVERSATION-SECURITY.md` - the seven-layer isolation model.
- `ADMIN-INTEGRATION-GUIDE.md` - the three admin-auth modes (`ae-cognito` / `service` / `federated`) and `ADMIN_GROUP_NAMES` for host-app admin identity.
- `ADMIN-GUIDE.md` - using the console, and the admin-conversation + email notification pattern.
- `IDENTITY-PROVIDER-GUIDE.md` - external IdP (OIDC/SAML) integration.
- `MESSAGE-FLOW.md` - the end-to-end message path (channel flow / Lex / `@all` / fulfillment / async processor) and where each enforcement layer in §6b acts.
