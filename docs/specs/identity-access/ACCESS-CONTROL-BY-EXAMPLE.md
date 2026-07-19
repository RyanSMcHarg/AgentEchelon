# Access control by example: blocked interactions, the policy that blocks them, and the experience

**Status:** Implemented (reference: worked examples of the live IAM enforcement)


**Purpose.** [`IDENTITY-AND-ACCESS-MODEL.md`](IDENTITY-AND-ACCESS-MODEL.md) describes the model; this doc adds clarity through examples of how IAM decisions over tagged resources, not application code, do the enforcing. Each example describes an attempted interaction, the **role** that acts, the **specific IAM statement** that decides it, what the **user** and the **assistant** experience, and the **knob** you change to customize it. Together they show how the platform uses native AWS features for defense in depth: you can code the behavior you want, but the IAM layer proactively blocks undesirable actions even if the application makes a mistake, and reactive audit is available on top.

The synthesized statements shown are what CDK emits from the constructs cited; verify against a deployed stack with `aws iam get-role-policy`.

---

## Identities and resources: how your IdP, Amazon Chime SDK identities, ARNs, and IAM relate

One relationship underlies every example here:

- **Your identity provider** (Cognito by default, or a federated SAML/OIDC IdP) authenticates a person. That identity maps 1:1 to a **Amazon Chime SDK AppInstanceUser** of the same id (the Cognito `sub`). Assistants are **AppInstanceBots**; moderation runs as a single **AppInstanceAdmin** service identity (see Category 4).
- **Users, assistants, and channels are all AWS resources with ARNs** (`<appInstance>/user/<id>`, `<appInstance>/bot/<id>`, `<appInstance>/channel/<id>`). Because they are ARN-able resources, "who may act on what" is an **IAM and resource-policy decision**, not application logic.
- **IAM policies** over those ARNs, plus the channel's immutable `classification` tag, allow or deny each action. On top of IAM, the Amazon Chime SDK enforces its own membership and bearer rules (the next section).

Two kinds of denial recur:

- **Conditional denial (tag-gated):** the action is granted, but only on channels whose `classification` is at or below the caller's tier. A premium channel denies a basic user by the tag condition. This is the tier boundary.
- **Absolute denial:** an action a role simply never holds, denied unconditionally regardless of any tag. A guest (`restricted` rung) is never granted `CreateChannel`, `CreateChannelMembership`, or `ListChannels`; no browser rung is ever granted `RedactChannelMessage` or `DeleteChannelMessage`. There is no tag that would allow these; the permission is absent.

For the full model, the three meanings of "admin", and code-grounded file references, see [`IDENTITY-AND-ACCESS-MODEL.md`](IDENTITY-AND-ACCESS-MODEL.md).

---

## Two authorization layers: IAM, and the Amazon Chime SDK identities

The policies below never act alone. Every Amazon Chime SDK messaging call carries an `x-amz-chime-bearer` header naming the identity it runs as: an **AppInstanceUser** (a person) or an **AppInstanceBot** (an assistant). Two independent gates apply to every call.

**IAM (the AWS layer)** decides whether your credentials may name that bearer and act on that resource. A channel-message action authorizes against two resources at once, the **bearer** (`<appInstance>/user/<id>` or `<appInstance>/bot/<id>`) and the **channel** (`<appInstance>/channel/*`). That is why every grant in this doc is two statements: one for the channel (tag-gated, the tier boundary) and one for the bearer (identity-pinned).

**Amazon Chime SDK (the app-instance layer)** enforces its own implicit rules regardless of what IAM allows. It binds `x-amz-chime-bearer` to the caller's authenticated identity, so you can only ever act as yourself, and it gates message access on **channel membership**, so a non-member cannot read or send even where a policy shape would permit it. This is the Amazon Chime SDK's documented model: every messaging call requires the `x-amz-chime-bearer` header naming the `AppInstanceUser` or `AppInstanceBot` making it ([making SDK calls from a back-end service](https://docs.aws.amazon.com/chime-sdk/latest/dg/call-from-backend.html), [using the messaging SDK](https://docs.aws.amazon.com/chime-sdk/latest/dg/using-the-messaging-sdk.html)), and "an `AppInstanceUser` can only send a message or list a channel membership in channels to which the user belongs" ([authorization by role](https://docs.aws.amazon.com/chime-sdk/latest/dg/auth-by-role.html), with [example IAM roles](https://docs.aws.amazon.com/chime-sdk/latest/dg/iam-roles.html)).

So three boundaries do three different jobs: the IAM **tag condition** is the tier boundary, Amazon Chime SDK **membership** is the admission boundary, and the **bearer binding** is the impersonation boundary. Some rungs (the guest rung) carry no IAM tag condition at all and are scoped entirely by Amazon Chime SDK membership. In each example, watch which of the three is doing the work.

---

# Category 1. Channel access: who may act on a channel at all

## A Basic user tries to post in a Premium channel

**Attempt.** A `basic` user (or a bug on their behalf) calls `chime:SendChannelMessage` on a channel tagged `classification=premium`.

**Acting role.** The user's `basic` credential-exchange rung role, bearer-pinned to their own AppInstanceUser (`grantPinnedExchangePermissions`, `cognito-auth-stack.ts:403`). The SPA reaches Amazon Chime SDK only through this exchange; the Cognito Identity-Pool tier roles are empty (`makeTierRole`, `cognito-auth-stack.ts:342`).

**Deciding policy** (`tierChannelScopedAllow('basic', …)`, `agent-tier-common.ts:115`):

```json
{
  "Sid": "AllowOwnAndLowerTierChannelActions",
  "Effect": "Allow",
  "Action": ["chime:SendChannelMessage", "chime:GetChannelMessage",
             "chime:ListChannelMessages", "chime:DescribeChannel",
             "chime:ListChannelMemberships", "chime:UpdateChannelReadMarker"],
  "Resource": "<appInstance>/channel/*",
  "Condition": { "StringEquals": { "aws:ResourceTag/classification": ["basic"] } }
}
```

**Result: denied (conditional).** The channel's tag is `premium`, not in `["basic"]`, so the condition is false, no Allow matches, and the action is implicitly denied. This is fail-closed: an untagged or unknown-tag channel also fails to match, so a tagging gap denies rather than leaks. The tag condition is IAM, evaluated before any application code runs, so even a routing bug cannot make a basic identity act on a premium channel. Two boundaries at the Amazon Chime SDK layer back it up: the call must name the user's own AppInstanceUser as `x-amz-chime-bearer` (the second statement in the grant authorizes exactly that bearer), and Amazon Chime SDK requires channel membership, so a non-member is refused regardless of tier.

**User experience.** The user is never vended credentials that can act on the premium channel; the console does not list channels above their tier, and a direct API attempt returns `AccessDenied`.

**Assistant experience.** The premium assistant never receives the message, so no turn is generated. Nothing to filter after the fact, because the message never enters the channel.

**To customize.** The allowed set is `classificationsAllowedFor(tier)` (`agent-tier-common.ts`), which delegates to `ProfileRegistry.scopeAtOrBelow` over the classification ladder declared in `backend/lib/config/profiles.ts`. Add or reorder classifications by editing `classifications` + `groupClearance` in `profiles.ts` (that single edit also drives the Cognito group and the exchange rung). The tag itself is stamped immutably at channel creation by `create-conversation`.

## A guest tries to read a channel they were not invited to

**Attempt.** A guest on the `restricted` rung tries to read or send in a channel other than the one they were admitted to.

**Acting role.** The `restricted` (guest) exchange rung, bearer-pinned to the guest's own AppInstanceUser. This rung's channel grant carries **no** `classification` tag condition (`cognito-auth-stack.ts:416-423`).

**Deciding policy.** IAM grants `EXCHANGE_MSG_ACTIONS` on `<appInstance>/channel/*` with no tag condition, and the guest rung deliberately omits channel discovery (no `ListChannels`) and self-membership management (the higher-rung block at `cognito-auth-stack.ts:438-461` that the restricted rung skips).

**Result: denied by Amazon Chime SDK, not by IAM.** This is the clearest case of the two layers dividing the work. IAM would permit the action shape on any channel, but the guest is not a member of the other channel, and Amazon Chime SDK gates message access on membership, so the read or send is refused at the app-instance layer. The guest is scoped by **admission** (which channels they are a member of), enforced by Amazon Chime SDK, not by a classification tag.

**User experience.** A guest sees only the channel they were invited into and cannot discover or reach others. This is the mechanism the external and federated-participant use cases build on.

**Assistant experience.** Unchanged; the assistant answers within the channel the guest was admitted to.

**In AgentEchelon.** The guest (`restricted`) rung and its bearer-pinned, admission-scoped policy exist here as a seam, but the end-to-end guest flow (guest-credential vending, admission, and a guest surface) is **not enabled in this project**. The same pattern, a namespace-disjoint `guest_<...>` AppInstanceUser pinned by a `sub` session tag and admitted to a single channel, is implemented, security-hardened (including an IDOR-class fix so a supplied id can never name another user's identity), and **running in production on [mcharg.site](https://mcharg.site)** (a guest-reachable chat widget, no sign-in required), a separate deployment built on this reference. The design is proven in the field; it simply does not ship in AgentEchelon.

**To customize.** For guests the control is **admission**: who is added as a channel member (create-conversation and the invite path), plus keeping discovery and self-membership off the restricted rung. The classification tag gate is intentionally absent here because membership, not tier, is the guest boundary. See `SPEC-CREDENTIAL-EXCHANGE.md` §5a (the restriction spectrum) and Layer 7 in `SPEC-CONVERSATION-SECURITY.md`.

## Someone tries to add a lower-tier member to a higher-tier channel

**Attempt.** A `basic` user is added as a member of a `premium` channel, either by invite or by a direct Amazon Chime SDK API call.

**Why IAM tags cannot fully prevent this.** `CreateChannelMembership` and `DeleteChannelMembership` authorize against the **bearer/user** resource (`<appInstance>/user/<id>`), which carries no `classification` tag. A tag condition on them would fail closed and break legitimate membership, so they are granted unconditioned (see the tag-gated-actions section and `agent-tier-common.ts:38-41`). Membership is therefore governed by three other mechanisms, not by the tag gate. This is the honest edge: the tier boundary on *messages* is provable IAM, but the boundary on *membership* is not, so it is defended in depth.

**Gate 1, synchronous app-layer admission (live).** Every path that adds a human validates `memberTier ≥ channelClassification` and refuses. The invite-by-email path (`share-conversation/index.js`) reads the recipient's authoritative Cognito-group tier, compares it to the channel's `modelTier`, and returns **403 `TIER_FORBIDDEN`** on a shortfall. `create-conversation` adds only the creator (over-tier creation already 403s), and the assistant-add paths add only the tier-matched bot, so no in-app path adds an under-tier human. This is application code, so it is defense in depth, not the provable IAM boundary.

**Gate 2, IAM containment (live).** A membership added out of band (a direct Amazon Chime SDK API call by a moderator, a script, or compromised creds) bypasses Gate 1. But the tier tag gate (the first example above) still denies that member's `SendChannelMessage`, `GetChannelMessage`, and `ListChannelMessages` on the higher-tier channel, because their credentials are classification-capped. A wrongly-added member is therefore **inert**: present, but unable to read or send. The residual exposure is at most the visibility of the channel's existence and membership, never a message leak.

**Gate 3, near-real-time Kinesis audit (implemented, opt-in).** Every `CREATE_CHANNEL_MEMBERSHIP` and `UPDATE_CHANNEL_MEMBERSHIP` event streams to Kinesis. The membership-audit consumer (`backend/lambda/src/membership-audit.ts`, wired into both analytics stacks, enabled with `-c enableMembershipAudit`) re-checks the member's tier against the channel classification and, on a violation, logs a `[MembershipAudit][SecurityEvent]`, alerts the admin conversation (an in-app message plus an email through the notification bridge), and, when `-c membershipAuditEnforce=true`, auto-revokes the membership (`DeleteChannelMembership` as the admin bearer). It is **report-only by default**, so a false positive alerts rather than removing a legitimate member. It audits humans and assistants alike (below), and skips the admin service user and federated members. With Gate 2, a wrongly-added member is both inert and then surfaced or revoked.

**User experience.** An in-app invite to an over-tier user returns a clear error stating their access level does not meet the conversation's tier, rather than a silent add that later fails. A member added out of band cannot see or send messages regardless.

**Assistant experience (assistants are audited too, not exempt).** Assistants are channel members like anyone else: they are added and removed through the same membership APIs, so an out-of-band membership change here is a real risk, not a non-event. A higher-tier assistant placed on a lower-tier channel would answer there with its own tier's model and context, exposing capability and data to users below that clearance. The audit therefore holds bots to the same rule as humans: a channel must carry only its tier-matched assistant, so a mismatched bot is flagged (and, when enforcing, revoked), allowing the legitimately-added `/battle` alt-slot bots. This closes the reverse of the human case: a human below the channel's tier is the leak; an assistant above it is.

**To customize.** The synchronous gate is the `memberTier ≥ channelClassification` check in `share-conversation` and `create-conversation`; the containment is the tier tag gate; the audit backstop is the membership-audit consumer, enabled with `-c enableMembershipAudit` and switched from report-only to auto-revoke with `-c membershipAuditEnforce=true` (`SPEC-CONVERSATION-SECURITY.md` §4b, Layer 6). This is the clearest case of control failing closed while the audit catches what the write-time gate cannot.

---

# Category 2. Channel actions: IAM prevention and the implicit Amazon Chime SDK roles

Category 1 was about *being on* a channel. This category is about *what actions* are allowed once you are, and how absolute denials differ from the conditional (tag-gated) ones.

## The complete set of tag-gated actions (conditional denials)

The `aws:ResourceTag/classification` condition applies to **channel-resource** actions only. The helper `tierChannelScopedAllow` (`agent-tier-common.ts:115`) can gate any of the ten actions in `TIER_GATED_CHANNEL_ACTIONS` (`agent-tier-common.ts:43`). This is the complete set of actions denied on a channel whose classification is above the caller's tier:

```
chime:SendChannelMessage
chime:UpdateChannelMessage
chime:RedactChannelMessage
chime:GetChannelMessage
chime:ListChannelMessages
chime:DescribeChannel
chime:UpdateChannel
chime:DeleteChannel
chime:UpdateChannelReadMarker
chime:ListChannelMemberships
```

That list is the helper's full capability. Each principal is granted only the subset it needs, and the tag condition applies to exactly the subset granted:

| Principal | Tag-gated actions actually granted | Source |
| --- | --- | --- |
| **Browser user** (exchange rung: `basic` / `standard` / `premium`) | `SendChannelMessage`, `GetChannelMessage`, `ListChannelMessages`, `DescribeChannel`, `ListChannelMemberships`, `UpdateChannelReadMarker`. No `Update`, `Redact`, or `Delete`. | `EXCHANGE_MSG_ACTIONS`, `cognito-auth-stack.ts:390` |
| **Per-profile assistant** (processor role) | `SendChannelMessage`, `ListChannelMessages`, `GetChannelMessage`, `UpdateChannelMessage`, `DescribeChannel`, `UpdateChannel`. No `Redact` or `Delete`. | `assistant-profile-stack.ts` (`ProcessorRole` `ChimePolicy`) |
| **Admin / guest rungs** | none tag-gated (the admin and `restricted` rungs are deliberately not tag-conditioned; see Category 4 and the guest example) | `cognito-auth-stack.ts:416-428` |

**Deliberately not tag-gated, and why.** Actions that authorize against the **bearer** resource (`<appInstance>/user/<id>` or `<appInstance>/bot/<id>`) carry no classification tag, so adding a tag condition to them would fail closed and break them. These are membership management (`CreateChannelMembership`, `DeleteChannelMembership`), `DescribeChannelMembership`, and the profile and discovery actions. They are governed instead by Amazon Chime SDK's membership and moderator model plus the app-layer share and create gates. `ListChannelMemberships` is the exception that stays tag-gated because it is channel-scoped, not bearer-scoped (`agent-tier-common.ts:38-41`).

## Absolute denials: actions a rung simply never holds

The tag gate above is a *conditional* denial. Some denials are *absolute*: the action is never granted to the rung, so no tag or membership could ever allow it. There is nothing to misconfigure, because the capability was never there.

- **Guests cannot create channels, add members, or list channels.** The `restricted` rung grants only the minimal messaging set on channels it is admitted to; it deliberately omits `CreateChannel`, `CreateChannelMembership`, and `ListChannels` (the higher-rung block at `cognito-auth-stack.ts:438-461` that the restricted rung skips). A guest therefore cannot discover channels or pull others in, by absence of the permission, not by a condition.
- **No browser rung can redact or delete a message** (the next example).

## Any user's browser tries to delete or redact a message

**Attempt.** A user, including an admin, calls `chime:RedactChannelMessage` or `DeleteChannelMessage` from the SPA using their ordinary (chat) credential.

**Acting role.** Any credential-exchange CHAT rung role (`basic` / `standard` / `premium`, or an admin's chat identity on the `admin` rung).

**Deciding policy.** The rung action set, `EXCHANGE_MSG_ACTIONS` (`cognito-auth-stack.ts`), contains send, get, list, describe, and read-marker actions, and deliberately **no** `Update`, `Redact`, or `Delete` message actions:

```json
{ "Action": ["chime:SendChannelMessage", "chime:GetChannelMessage",
             "chime:ListChannelMessages", "chime:DescribeChannel",
             "chime:ListChannelMemberships", "chime:UpdateChannelReadMarker"] }
```

**Result: denied on the chat rung, including an admin's chat identity.** No chat credential can redact or delete another user's message, because the action is not on the chat rungs and the chat identity `${sub}` is not an app-instance-admin. This holds even for an admin: their *chat* credential is powerless to moderate.

**User experience.** Moderation is a deliberate, separate step. The admin console requests an `identity:'admin'` credential (a distinct rung, `ExchangeRoleAdminPlane`) scoped to one channel, short-lived and audited, and calls Amazon Chime SDK redact/delete client-side as the admin's own `${sub}-admin` bearer (the next example). No server-side component wields the bearer.

**Assistant experience.** Unaffected; assistants do not delete or redact.

**To customize.** Keep destructive message actions off the CHAT rungs. Moderation lives on the separate admin-plane role, vended only on an `identity:'admin'` request (`SPEC-ADMIN-IDENTITY.md`); do not add delete or redact to `EXCHANGE_MSG_ACTIONS`.

## A prompt injection tries to make the assistant act as a user

**Attempt.** A crafted message tries to get the premium assistant to act as a user, or as another user's identity (a confused-deputy or impersonation attempt). In AWS the generic way to become another identity is `sts:AssumeRole`, so the real question is not only "can the credentials name another bearer" but "can this actor obtain different credentials at all."

**Acting role.** The premium `ProcessorRole`. Its channel grant pins the bearer to a **bot** resource, never a user (`bearerResources: ['<appInstance>/bot/*']`, `premium-tier-stack.ts:129`); user rungs pin the other way, to `<appInstance>/user/${aws:PrincipalTag/sub}` (`cognito-auth-stack.ts:387`). At the Amazon Chime SDK layer, Amazon Chime SDK binds `x-amz-chime-bearer` to the caller's authenticated identity, so an AppInstanceBot and an AppInstanceUser are distinct principals that cannot be swapped.

**Deciding policy.** Two things have to hold, and both do:
- **The bearer is pinned.** With the credentials it holds, the assistant can bear only its own bot identity, and a user can bear only their own `sub`. Neither names the other, and Amazon Chime SDK enforces the same binding.
- **The escalation path is closed.** `sts:AssumeRole` is a real impersonation vector, so it is blocked three ways. The vended rung credentials carry **no** `sts:AssumeRole` permission, so the assistant (or a user) cannot assume a different role to get different credentials. The rung roles' **trust policy names only the credential-exchange Lambda** (`assumedBy: ArnPrincipal(credentialExchangeRole)`, `cognito-auth-stack.ts:484`), so nothing else may assume them. And the exchange may assume a rung role **only with the `sub` session tag** (`sts:TagSession` plus a required `aws:RequestTag/sub`, `cognito-auth-stack.ts:488-493`), which it sets from the caller's verified token, so a rung role is never assumed un-pinned.

**Result: blocked, and the boundary is explicit.** A prompt cannot make the assistant borrow another identity, because the assistant's credentials can neither name another bearer nor assume another role. The one component that can mint credentials pinned to a given `sub` is the credential-exchange Lambda, and it pins to the caller's own verified `sub`, so it cannot mint someone else's identity either. The trust boundary is therefore the exchange Lambda's role and code, not the assistant and not the prompt: impersonation would require compromising that role, not talking a model into it.

**User experience.** A user cannot make the assistant act on their behalf beyond what the assistant is already scoped to; the assistant answers as the assistant.

**Assistant experience.** The assistant always acts as its own bot identity; nothing it is told changes whose credentials it holds or lets it acquire different ones.

**To customize.** Bearer pinning is set via the `bearerResources` option (`agent-tier-common.ts:128`); keep user rungs pinned to `sub` and assistant roles pinned to a bot. Do **not** grant `sts:AssumeRole` to the rung roles, and do **not** widen a rung role's trust policy beyond the exchange Lambda. The required `sub` tag on assumption is what keeps every minted session pinned.

---

# Category 3. Assistant access to users and context

Beyond channels, an assistant is bounded in *which model* it may invoke and *what context* it may read.

## A Basic-tier assistant tries to use a Premium-only model

**Attempt.** The basic tier's async processor tries to call `bedrock:InvokeModel` on a higher-tier model (for example an Opus-class model reserved for premium).

**Acting role.** The basic profile's `ProcessorRole` (`assistant-profile-stack.ts`, driven by the basic `ProfileTopology`).

**Deciding policy** (`BedrockPolicy` in `assistant-profile-stack.ts`; basic omits the streaming action because its topology sets `streaming: false`, while premium adds `InvokeModelWithResponseStream`):

```json
{
  "Effect": "Allow",
  "Action": ["bedrock:InvokeModel"],
  "Resource": "<modelArnsForTier('basic')>"
}
```

**Result: denied.** `modelArnsForTier('basic')` (`agent-tier-common.ts`, called from `assistant-profile-stack.ts`) resolves only the basic profile's model ARNs. A premium model ARN is not in the list, so `InvokeModel` on it is denied.

**User experience.** A basic user only ever receives answers from the basic model; the model selector in the console is scoped to their tier, so a higher model is not even offered.

**Assistant experience.** The basic processor cannot call the premium model even if code or configuration asked it to; the call returns `AccessDenied` at Bedrock.

**To customize.** Change which models a tier may invoke in `modelArnsForTier` and the model catalog (`getModelCatalog`, `model-strategy.ts`), plus `tierModelSelection`. This is the single place tier-to-model access is granted.

## A Basic-tier assistant tries to read Premium knowledge-base context

**Attempt.** The basic processor tries `s3:GetObject` on `context/premium/...` to enrich an answer.

**Acting role.** The basic tier's `ProcessorRole`.

**Deciding policy** (`ContextS3Read` in `assistant-profile-stack.ts`; the prefixes come from `classificationsAllowedFor`, so the basic profile grants only the `context/basic/*` prefix):

```json
{
  "Effect": "Allow",
  "Action": "s3:GetObject",
  "Resource": "<attachmentsBucket>/context/basic/*"
}
```

**Result: denied.** The basic role holds a grant for `context/basic/*` only. Premium (and standard) prefixes are absent, so reads against them are denied. Premium adds `context/standard/*` and `context/premium/*` to its own role, which is why premium can read everything below it and basic cannot read up.

**User experience.** A basic user's assistant cannot surface premium knowledge into the conversation, so higher-tier material never appears in a lower-tier room.

**Assistant experience.** The context-retrieval tool returns nothing for premium documents; the model answers without that material rather than leaking it.

**To customize.** Edit the `s3:prefix` list in each tier stack's `ContextS3Read`. Adding a prefix widens what that tier's assistant can read; removing one narrows it. Context is laid out under `context/{tier}/` in the attachments bucket.

---

# Category 4. Human admin and the admin service user

"Admin" is more than one thing. The full three meanings are in [`IDENTITY-AND-ACCESS-MODEL.md`](IDENTITY-AND-ACCESS-MODEL.md); the two that act are the **human admin** (a claim, acting as themselves) and the **admin service user** (a machine identity for moderation).

## An admin reads channels across every tier (admin is not a tier)

**Attempt.** A user in the `admins` group reads and participates in channels of any classification.

**Acting role.** The `admin` exchange rung, bearer-pinned to the admin's own AppInstanceUser. A person gets this rung because they hold the `admins` claim, not because of where they sit in the tier ladder. Admin is orthogonal to classification: it is not a tier above `premium`, it is a separate claim. So "which tier is the admin in" is the wrong question, and "can an admin read above their tier" has no meaning, because an admin has no tier ceiling.

**Deciding policy** (the `rung === 'admin'` branch, `cognito-auth-stack.ts:416-428`): the channel grant is `EXCHANGE_MSG_ACTIONS` on `<appInstance>/channel/*` with **no** `classification` tag condition. The tag gate from Category 1 simply does not appear on this rung.

**Result: allowed across every tier, as themselves.** Because the admin rung is not tag-gated, an admin reads and participates in any tier's channel. The Amazon Chime SDK layer still applies: the admin acts as their own AppInstanceUser (their `sub` on every action for the audit trail), and Amazon Chime SDK's membership rules still govern message read and send at the app-instance layer. Because the `admin` (chat) rung uses `EXCHANGE_MSG_ACTIONS`, the admin still cannot redact or delete with their CHAT credential (Category 2); moderation uses the separate `${sub}-admin` identity (next section).

**User experience.** An admin gets cross-tier oversight as themselves, not through a shared or elevated account, so every action is attributable. Moderation runs client-side as the admin's own `${sub}-admin` identity (next section).

**To customize.** Membership in the admin group is the switch; the group name is `admins` by default and overridable via `ADMIN_GROUP_NAMES` for host-app or federated admins (`auth.ts` `ADMIN_GROUPS`, `ADMIN-INTEGRATION-GUIDE.md`). The `rung === 'admin'` branch is where cross-tier reach is defined.

## The admin identity: client-side moderation (redact and delete)

The human admin above participates through the `admin` (chat) rung as their chat identity `${sub}`, which cannot moderate. Destructive moderation, redacting and deleting others' messages, runs as a SEPARATE per-human identity: the admin's own `${sub}-admin` `AppInstanceUser`, registered as an `AppInstanceAdmin`, which holds cross-channel redact and delete.

The admin console requests this identity's credential from the Credential-Exchange on an `identity:'admin'` request (the `ExchangeRoleAdminPlane` role): scoped to one channel, short-lived, and recorded (`admin_scoped_credential_vend`). The SPA then calls Amazon Chime SDK redact/delete directly with the `${sub}-admin` bearer, so the action is the human acting as themselves, not a server-side bearer swap. This is why the CHAT rungs, admin included, never hold redact or delete (the absolute denial in Category 2): those capabilities live only on the separate `${sub}-admin` identity, vended per request. A dedicated SERVICE `app-instance-admin` (created by `create-app-instance-admin.ts`, ARN in SSM) still exists but only for no-human automation; see `SPEC-ADMIN-IDENTITY.md` for the two-identity model and `SPEC-MODERATION.md` for the moderation surfaces.

---

## How this maps to customization, in one place

| You want to change | Edit | Effect |
|---|---|---|
| Tiers and their ordering | `classifications` + `groupClearance` in `backend/lib/config/profiles.ts` (interpreted by `ProfileRegistry`; `classificationsAllowedFor` delegates to `scopeAtOrBelow`) | Defines the classification ladder the channel gate evaluates |
| Which models a tier may invoke | `modelArnsForTier` + model catalog (`model-strategy.ts`), `tierModelSelection` | The per-tier `bedrock:InvokeModel` resource list |
| What context a tier's assistant may read | `ContextS3Read` `s3:prefix` list in each tier stack | The per-tier S3 read scope |
| What the browser may do | `EXCHANGE_MSG_ACTIONS` (`cognito-auth-stack.ts`) | The action set on every user rung; keep destructive actions off it |
| Who is an admin | `admins` group, `ADMIN_GROUP_NAMES` | Unlocks the cross-tier admin rung and the admin API |
| Identity pinning | `bearerResources` (`agent-tier-common.ts`) | Which identity a role may bear; keep pinned |
| Who can join a channel (guest admission) | channel membership via create-conversation / invite path | The Amazon Chime SDK-membership boundary for guests and shared channels |
| Cross-tier membership control | `share-conversation` / `create-conversation` tier check, plus the Layer 6 Kinesis audit consumer | App gate refuses over-tier invites; the tag gate makes any out-of-band add inert; the audit revokes |
| Preventing role escalation | rung-role trust policy + no `sts:AssumeRole` on rungs (`cognito-auth-stack.ts`) | Only the exchange Lambda may assume rung roles, always `sub`-pinned |

## Related

- [`IDENTITY-AND-ACCESS-MODEL.md`](IDENTITY-AND-ACCESS-MODEL.md): the model these examples enforce, and the three meanings of "admin".
- [`SPEC-CONVERSATION-SECURITY.md`](SPEC-CONVERSATION-SECURITY.md): the defense-in-depth layers, the Access Matrix (§4a), and membership admission (§4b).
- [`SPEC-CREDENTIAL-EXCHANGE.md`](SPEC-CREDENTIAL-EXCHANGE.md): the exchange that vends the bearer-pinned, classification-capped credentials.
- [`SPEC-MODERATION.md`](SPEC-MODERATION.md): the client-side own-identity path for redact and delete.
- [`SPEC-ADMIN-IDENTITY.md`](SPEC-ADMIN-IDENTITY.md): the two-identity admin model (chat `${sub}` vs `${sub}-admin`).
