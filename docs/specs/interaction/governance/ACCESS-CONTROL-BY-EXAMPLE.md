# Access control by example: blocked interactions, the policy that blocks them, and the experience

**Status:** Implemented (reference: worked examples of the live IAM enforcement).

**Coverage:** `tests/e2e/classification-context.spec.ts`, `tests/e2e/credential-exchange.spec.ts`

**Related:** [IDENTITY-AND-ACCESS-MODEL.md](./IDENTITY-AND-ACCESS-MODEL.md) (the model these examples enforce) · [SPEC-CONVERSATION-SECURITY.md](./SPEC-CONVERSATION-SECURITY.md) (the layered boundary) · [SPEC-CREDENTIAL-EXCHANGE.md](./SPEC-CREDENTIAL-EXCHANGE.md) (the vend) · [SPEC-ADMIN-IDENTITY.md](./SPEC-ADMIN-IDENTITY.md) (the two-identity admin model) · [SPEC-MODERATION.md](./SPEC-MODERATION.md) (the client-side own-identity path for redact and delete)

**Site section:** Interaction layer, governance.

---

**This is a worked-example explainer, not a spec.** It carries no functional-requirements table, because its job is to show a boundary deciding rather than to state what the platform must do. [IDENTITY-AND-ACCESS-MODEL.md](./IDENTITY-AND-ACCESS-MODEL.md) describes the model; [SPEC-CONVERSATION-SECURITY.md](./SPEC-CONVERSATION-SECURITY.md) and [SPEC-CREDENTIAL-EXCHANGE.md](./SPEC-CREDENTIAL-EXCHANGE.md) carry the requirements and the evidence.

**Who it is for, and the problem it solves.** A team choosing or building on an AI platform needs to see - not just be told - that a blocked interaction is actually blocked by the infrastructure, and to know the one knob that changes each boundary. The alternative is to trust a product's isolation claim without proof, or to build both the enforcement and the harness that proves it. The audience is the platform developer and the admin / operator reasoning about or customizing enforcement.

**What each example gives the reader.** The attempted interaction, the **role** that acts, the **specific IAM statement** that decides it, what the **user** and the **assistant** experience, and the **knob** a deployer changes to customize it. Together they show how the platform uses native AWS features for defense in depth: a deployer codes the behavior they want, and the IAM layer proactively blocks undesirable actions even where the application makes a mistake, with reactive audit available on top.

The synthesized statements shown are what CDK emits from the constructs cited; verify against a deployed stack with `aws iam get-role-policy`.

---

## Identities and resources: how the identity provider, Amazon Chime SDK identities, ARNs, and IAM relate

One relationship underlies every example here:

- **The identity provider** (Cognito by default, or a federated SAML or OIDC provider) authenticates a person, who is one Amazon Chime SDK **AppInstanceUser** whichever issuer signed them in ([IDENTITY-AND-ACCESS-MODEL.md](./IDENTITY-AND-ACCESS-MODEL.md) §1a). The id is opaque, a UUID v7 the credential exchange mints once per (issuer, subject) (`mintOrResolvePerson`, `backend/lambda/src/lib/person-identity.ts`), and the admin twin is `${personId}-admin`, tagged `owner` by the admin credential exchange (`ensureAdminIdentity` in `backend/lambda/src/admin-credential-exchange.ts`). Assistants are **AppInstanceBots**; administration runs as AppInstanceAdmin identities of two kinds - a per-human `${personId}-admin` identity for each admin operator, plus a service identity for backend administration (see Category 4 and [SPEC-ADMIN-IDENTITY.md](./SPEC-ADMIN-IDENTITY.md)).
- **Users, assistants, and channels are all AWS resources with ARNs** (`<appInstance>/user/<id>`, `<appInstance>/bot/<id>`, `<appInstance>/channel/<id>`). Because they are ARN-able resources, "who may act on what" is an **IAM and resource-policy decision**, not application logic.
- **IAM policies** over those ARNs, plus the channel's immutable `classification` tag, allow or deny each action. On top of IAM, the Amazon Chime SDK enforces its own membership and bearer rules (the next section).

Two kinds of denial recur:

- **Conditional denial (tag-gated):** the action is granted, but only on channels whose `classification` is in the set the acting role names. A premium channel denies a basic user by the tag condition. This is the classification boundary.
- **Absolute denial:** an action a role simply never holds, denied unconditionally regardless of any tag. A guest (`restricted` role) is never granted `CreateChannel`, `CreateChannelMembership`, or `ListChannels`; no browser role is ever granted `RedactChannelMessage` or `DeleteChannelMessage`. There is no tag that would allow these; the permission is absent.

For the full model, the three meanings of "admin", and code-grounded file references, see [IDENTITY-AND-ACCESS-MODEL.md](./IDENTITY-AND-ACCESS-MODEL.md).

---

## Two authorization layers: IAM, and the Amazon Chime SDK identities

The policies below never act alone. Every Amazon Chime SDK messaging call carries an `x-amz-chime-bearer` header naming the identity it runs as: an **AppInstanceUser** (a person) or an **AppInstanceBot** (an assistant). Two independent gates apply to every call.

**IAM (the AWS layer)** decides whether the caller's credentials may name that bearer and act on that resource. A channel-message action authorizes against two resources at once, the **bearer** (`<appInstance>/user/<id>` or `<appInstance>/bot/<id>`) and the **channel** (`<appInstance>/channel/*`). That is why every grant in this document is two statements: one for the channel (tag-gated, the classification boundary) and one for the bearer (identity-pinned).

**Amazon Chime SDK (the app-instance layer)** enforces its own implicit rules regardless of what IAM allows: it gates on the caller's **role** (AppInstanceAdmin, ChannelModerator, member, non-member) and on **channel membership**, so a non-member cannot read or send even where a policy shape would permit it.

**What it does NOT do is bind the bearer to the caller.** There is no independent check that the IAM principal making the call "is" the identity named in `x-amz-chime-bearer`. AWS is explicit that this is IAM's job: "The IAM permissions for Amazon Chime SDK messaging APIs require an `app-instance-user-arn` that matches the `chime-bearer` parameter", and a back-end service is given the ability to act as anybody by widening that resource to `.../user/*` ([making SDK calls from a back-end service](https://docs.aws.amazon.com/chime-sdk/latest/dg/call-from-backend.html)). The role table's "you can only use your ARN" restrictions apply to the `AppInstanceUserArn` **parameter** on a few `...ForAppInstanceUser` calls, not to the bearer header ([authorization by role](https://docs.aws.amazon.com/chime-sdk/latest/dg/auth-by-role.html)).

So **the impersonation boundary is the bearer resource in the IAM policy, and nothing behind it.** Where this platform pins that resource, the boundary holds and is deny-tested: a person's exchange role names `.../user/${aws:PrincipalTag/person}`, and `backend/scripts/deny-test-credential-exchange.mjs` proves live that the same send is allowed bearing the caller's own ARN and `AccessDenied` bearing another user's. Where the resource is a wildcard, what narrows it is the condition on it, and where there is neither there is no second layer underneath. This is the Amazon Chime SDK's documented model: every messaging call requires the `x-amz-chime-bearer` header naming the `AppInstanceUser` or `AppInstanceBot` making it ([making SDK calls from a back-end service](https://docs.aws.amazon.com/chime-sdk/latest/dg/call-from-backend.html), [using the messaging SDK](https://docs.aws.amazon.com/chime-sdk/latest/dg/using-the-messaging-sdk.html)), and "an `AppInstanceUser` can only send a message or list a channel membership in channels to which the user belongs" ([authorization by role](https://docs.aws.amazon.com/chime-sdk/latest/dg/auth-by-role.html), with [example IAM roles](https://docs.aws.amazon.com/chime-sdk/latest/dg/iam-roles.html)).

So three boundaries do three different jobs: the IAM **tag condition** is the classification boundary, Amazon Chime SDK **membership** is the admission boundary, and the IAM **bearer resource** is the impersonation boundary. All three are IAM or Amazon Chime SDK doing exactly one job each, and only the middle one is enforced by the service itself. Some roles (the guest role) carry no IAM tag condition at all and are scoped entirely by Amazon Chime SDK membership. In each example, watch which of the three is doing the work.

---

# Category 1. Channel access: who may act on a channel at all

## A Basic user tries to post in a Premium channel

**Attempt.** A `basic` user (or a bug on their behalf) calls `chime:SendChannelMessage` on a channel tagged `classification=premium`.

**Acting role.** The user's `basic` credential-exchange classification role, bearer-pinned to their own AppInstanceUser (`exchangeVendStatements` in the `ExchangeRole` construct, `backend/lib/constructs/exchange-role.ts`, built by the classification's own `Assistants-<classification>` stack). The SPA reaches Amazon Chime SDK only through this exchange; the deployment creates no Identity Pool (`identity-stack.ts`).

**Deciding policy** (`classificationChannelScopedAllow('basic', …, { actor: 'person' })`, `agent-classification-common.ts`):

```json
{
  "Sid": "AllowGrantedClassificationChannelActions",
  "Effect": "Allow",
  "Action": ["chime:SendChannelMessage", "chime:GetChannelMessage",
             "chime:ListChannelMessages", "chime:DescribeChannel",
             "chime:ListChannelMemberships", "chime:ListChannelModerators",
             "chime:UpdateChannel", "chime:UpdateChannelReadMarker"],
  "Resource": "<appInstance>/channel/*",
  "Condition": { "StringEquals": { "aws:ResourceTag/classification": ["basic"] } }
}
```

The permitted list is `ProfileRegistry.grantsFor('basic')`, the grant set that classification **declares**. Every classification must declare one and there is no fallback to a rank order: an absent set means an unknown classification, and the answer to what an unknown classification reaches is nothing. That is why the statement is named for the grant rather than for a rank relationship ([ADR-046](../../../design/decisions/046-classifications-are-a-set-not-a-ladder.md)).

**Result: denied (conditional).** The channel's tag is `premium`, not in `["basic"]`, so the condition is false, no Allow matches, and the action is implicitly denied. This is fail-closed: an untagged or unknown-tag channel also fails to match, so a tagging gap denies rather than leaks. The tag condition is IAM, evaluated before any application code runs, so even a routing bug cannot make a basic identity act on a premium channel. Two boundaries at the Amazon Chime SDK layer back it up: the call must name the user's own AppInstanceUser as `x-amz-chime-bearer` (the second statement in the grant authorizes exactly that bearer), and Amazon Chime SDK requires channel membership, so a non-member is refused regardless of classification.

**User experience.** The user is never vended credentials that can act on the premium channel; the console does not list channels their classification does not grant, and a direct API attempt returns `AccessDenied`.

**Assistant experience.** The premium assistant never receives the message, so no turn is generated. Nothing to filter after the fact, because the message never enters the channel.

**To customize.** The allowed set is `classificationsAllowedFor(classification)` (`agent-classification-common.ts`), which delegates to `ProfileRegistry.grantsFor` over the classifications declared in `backend/lib/config/profiles.ts`. Each one states the set it grants; there is no ordering to edit. Add or change classifications by editing `classifications` + `groupClearance` in `profiles.ts` (that single edit also drives the Cognito group and the exchange role). The tag itself is stamped immutably at channel creation by `create-conversation`.

## A guest tries to read a channel they were not invited to

**Attempt.** A guest on the `restricted` role tries to read or send in a channel other than the one they were admitted to.

**Acting role.** The `restricted` (guest) exchange role, bearer-pinned to the guest's own AppInstanceUser. This role's channel grant carries **no** `classification` tag condition (`exchangeVendStatements`, `backend/lib/constructs/exchange-role.ts`; the role is `ExchangeRoleRestricted` in `identity-stack.ts`).

**Deciding policy.** IAM grants `EXCHANGE_MSG_ACTIONS` on `<appInstance>/channel/*` with no tag condition, and the guest role deliberately omits channel discovery (no `ListChannels`) and self-membership management (the higher-role block that the restricted role skips).

**Result: denied by Amazon Chime SDK, not by IAM.** This is the clearest case of the two layers dividing the work. IAM would permit the action shape on any channel, but the guest is not a member of the other channel, and Amazon Chime SDK gates message access on membership, so the read or send is refused at the app-instance layer. The guest is scoped by **admission** (which channels they are a member of), enforced by Amazon Chime SDK, not by a classification tag. The vend also requires a `channelArn` and narrows the session to that one conversation, so scope and membership bound the guest together.

**User experience.** A guest sees only the channel they were invited into and cannot discover or reach others. This is the mechanism the external and federated-participant use cases build on.

**Assistant experience.** Unchanged; the assistant answers within the channel the guest was admitted to.

**In AgentEchelon.** The guest (`restricted`) role and its bearer-pinned, admission-scoped policy exist here as a seam, and the end-to-end guest flow - guest-credential vending, admission, and a guest surface - is **not enabled in this project**.

**To customize.** For guests the control is **admission**: who is added as a channel member (create-conversation and the invite path), plus keeping discovery and self-membership off the restricted role. The classification tag gate is intentionally absent here because membership, not classification, is the guest boundary - a known asymmetry rather than a settled design, and the one place a reader cannot answer "what may they reach" from the tag alone. See [SPEC-CREDENTIAL-EXCHANGE.md](./SPEC-CREDENTIAL-EXCHANGE.md), the restriction spectrum, and [SPEC-CONVERSATION-SECURITY.md](./SPEC-CONVERSATION-SECURITY.md), Layer 7.

## Someone tries to add a member whose clearance does not reach the channel

**Attempt.** A `basic` user is added as a member of a `premium` channel, either by invite or by a direct Amazon Chime SDK API call.

**Why IAM tags cannot fully prevent this.** `CreateChannelMembership` and `DeleteChannelMembership` are authorized against the **channel** (`<appInstance>/channel/<id>`, which carries the immutable `classification` tag) and the **bearer** (`<appInstance>/user/<id>` or `<appInstance>/bot/<id>`). The member being added or removed, `MemberArn`, is a request parameter, not a resource, so IAM never sees it: no policy can say who may be added. That was measured live by `backend/scripts/deny-test-assistant-membership.mjs`, which found a `Deny` on the member's ARN never consulted and the authorization on the channel. So the tag gate can condition WHERE a membership change happens and AS WHOM, and it does for every service that changes membership bearing an assistant - share, Battle Mode and federated sharing hold the change only on a channel and a bot carrying a declared classification (`membershipAsAssistantStatements`, `agent-classification-common.ts`; deny-tested by `tests/e2e/no-platform-role-speaks-as-an-assistant.spec.ts`), and so does the group-membership reconcile, bearing its own classification's assistant. The conversation creators bear the service admin instead, and each creates only its own classification (a person's conversation through that classification's own creator): the router's drift split, the conversation split, the typed-conversation creator and the per-classification conversation creators hold the change, and the moderator changes beside it, only on a channel of their own classification and bearing the admin by its exact ARN (`membershipAsServiceAdminStatements`). The proactive briefing and federated add-member create the same way. The admin-plane roles (user deletion, archive and removal, the membership audit, the admin conversation sync and the admin notification provisioner) act across classifications, and hold their membership changes on a channel carrying a declared classification, or the named admin conversations, bearing the admin by its exact ARN and never any person (`adminPlaneMembershipStatements`). `backend/test/only-declared-speakers-can-speak.test.ts` refuses any membership grant in a synthesized template that names a resource without a classification condition, outside a person's own vended session, whose bearer is pinned to the caller. It cannot condition WHO is added. Membership is therefore governed by three further mechanisms beyond the tag gate. This is the honest edge: the classification boundary on *messages* is provable IAM, and the boundary on *who is a member* is not, so it is defended in depth.

**Gate 1, synchronous app-layer admission.** Every path that adds a human checks `profiles.reaches(memberClearance, channelClassification)` and refuses. The invite-by-email path (`share-conversation/index.js`) reads the recipient's authoritative Cognito-group classification, compares it to the channel's immutable `classification` tag (never the mutable `metadata.modelTier`; a missing or invalid tag resolves to a value that reaches nothing, so the add is refused with no floor), and returns **403 `TIER_FORBIDDEN`** on a shortfall. `create-conversation` adds only the creator (creation at a classification the caller is not cleared for already 403s), and the assistant-add paths add only the classification-matched bot, so no in-app path adds an uncleared human. This is application code, so it is defense in depth rather than the provable IAM boundary. The set of adding paths is frozen by `backend/test/single-entry-point.test.ts`, so a new one fails CI until it is registered with the reason it cannot reuse the shared helper.

**Gate 2, IAM containment, and it runs in both directions.** A membership added out of band - a direct Amazon Chime SDK API call by a moderator, a script, or compromised credentials - bypasses Gate 1. The classification tag gate (the first example above) still denies the wrongly-added principal every channel action:

- **A wrongly-added HUMAN is inert.** Their credentials are classification-bound, so `SendChannelMessage`, `GetChannelMessage` and `ListChannelMessages` on a channel of a classification they are not cleared for are denied. The residual exposure is at most the visibility of the channel's existence and membership, never a message leak.
- **An ASSISTANT of another classification is also inert.** Its channel grant is `channelsAnAssistantMayActIn` - its own classification alone - so the tag condition denies a premium assistant every channel action on a `basic` channel, and denies a basic assistant every action on a premium one ([ADR-042](../../../design/decisions/042-an-assistant-acts-in-exactly-one-classification.md); deny-tested live at `tests/e2e/assistant-classification-boundary.spec.ts`). An assistant grant that reached its whole grant set would run the opposite direction from a person's: a person whose clearance does not reach the channel is held outside it, while an assistant whose classification grants more than the channel would be admitted to it, so the gate would allow exactly the case it is written to contain.

**Gate 3, near-real-time Kinesis audit, always deployed.** Every `CREATE_CHANNEL_MEMBERSHIP` and `UPDATE_CHANNEL_MEMBERSHIP` event streams to Kinesis. The membership-audit consumer (`backend/lambda/src/membership-audit.ts`, wired into both analytics stacks and always deployed) re-checks the member's classification against the channel classification and, on a violation, logs a `[MembershipAudit][SecurityEvent]`, alerts the admin conversation (an in-app message plus an email through the notification bridge), and, when its enforce toggle is on, auto-revokes the membership (`DeleteChannelMembership` as the admin bearer). The toggle is runtime state, the `config/enforce` item in the audit table that the admin console's Security tab flips with no redeploy; `-c membershipAuditEnforce=true` sets only its default. It is **report-only by default**, so a false positive alerts rather than removing a legitimate member. It audits humans and assistants alike, a person from any declared issuer through `Directory.clearanceOf`, and skips only the admin service user; a person whose clearance cannot be established is recorded as an unaudited membership. What no gate can condition is WHO becomes a member, because the member is a request parameter IAM never evaluates (`MemberArn`; measured by `backend/scripts/deny-test-assistant-membership.mjs`) - so Gate 2 makes the wrongly-added principal unable to act, and Gate 3 is what tells somebody it is there.

**User experience.** An in-app invite to a user not cleared for the conversation's classification returns a clear error stating that their access does not include the tier the conversation requires, rather than a silent add that later fails. A member added out of band cannot see or send messages regardless.

**Assistant experience (assistants are audited too, not exempt).** Assistants are channel members like anyone else: they are added and removed through the same membership APIs, so an out-of-band membership change here is a real risk rather than a non-event. An assistant placed on a channel of another classification is denied every channel action there, so it holds a membership it cannot act on, and the audit reports it. The rule the audit holds bots to is the same one IAM now enforces: a channel must carry only its classification-matched assistant, so a mismatched bot is flagged (and, when enforcing, revoked), and a `/battle` alt, tagged with its classification at creation, passes because it is that classification's assistant.

**To customize.** The synchronous gate is the `profiles.reaches(memberClearance, channelClassification)` check in `share-conversation` and `create-conversation`; the containment is the classification tag gate, with `actor: 'assistant'` selecting the narrower assistant form; the audit backstop is the always-deployed membership-audit consumer, switched from report-only to auto-revoke by the runtime enforce toggle in the console's Security tab, whose default `-c membershipAuditEnforce=true` sets ([SPEC-CONVERSATION-SECURITY.md](./SPEC-CONVERSATION-SECURITY.md), membership admission control and Layer 6). This is the clearest case of control failing closed while the audit catches what the write-time gate cannot.

---

# Category 2. Channel actions: IAM prevention and the implicit Amazon Chime SDK roles

Category 1 was about *being on* a channel. This category is about *what actions* are allowed once a principal is, and how absolute denials differ from the conditional (tag-gated) ones.

## The complete set of tag-gated actions (conditional denials)

The `aws:ResourceTag/classification` condition applies to **channel-resource** actions only. The helper `classificationChannelScopedAllow` (`agent-classification-common.ts`) can gate any of the ten actions in `CLASSIFICATION_GATED_CHANNEL_ACTIONS`. This is the complete set of actions that can be denied on a channel whose classification the caller's role does not name:

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
| **Browser user** (exchange role: `basic` / `standard` / `premium`) | `SendChannelMessage`, `GetChannelMessage`, `ListChannelMessages`, `DescribeChannel`, `ListChannelMemberships`, `ListChannelModerators`, `UpdateChannelReadMarker`, `UpdateChannel`. No `UpdateChannelMessage`, `RedactChannelMessage` or `DeleteChannelMessage`. | `EXCHANGE_MSG_ACTIONS`, `backend/lib/constructs/exchange-role.ts` |
| **Per-classification assistant** (acting role, the session every turn acts on) | `SendChannelMessage`, `ListChannelMessages`, `GetChannelMessage`, `UpdateChannelMessage`, `DescribeChannel`, `ListChannelMemberships`, plus `UpdateChannel` for the first-turn title. No `Redact` or `Delete`. | `ASSISTANT_TURN_CHANNEL_ACTIONS` (`backend/lambda/src/lib/assistant-acting-policy.ts`), `assistant-profile-stack.ts` (`sessionChannelActions`) |
| **Admin / guest roles** | the `admin` chat role is tag-gated to admin-plane channels; the `restricted` role is deliberately not tag-conditioned (see Category 4 and the guest example) | `exchange-role.ts` |

**`UpdateChannel` on a browser role is the owner rename, and it is not administration.** It is in `EXCHANGE_MSG_ACTIONS`, so a classification role holds it tag-gated, and Amazon Chime SDK additionally requires the caller to be a channel moderator - so a member who does not moderate the channel is refused by the service even where IAM allows. `DeleteChannel` is not on any browser role. See the per-action table in [SPEC-CONVERSATION-SECURITY.md](./SPEC-CONVERSATION-SECURITY.md), the access matrix, which maps `UpdateChannel` to the `rename` capability on the chat plane and to `manage-channel` on the admin plane.

**Not on a browser role's tag-gated set, and why.** A browser role holds no membership change on anyone but the caller: `CreateChannelMembership` is an admin-plane moderation action (`MODERATION_ACTIONS` on `ExchangeRoleAdminPlane`, `admin-services-stack.ts`), the one `DeleteChannelMembership` a browser role holds bears the caller's own AppInstanceUser, which is leaving (`exchangeVendStatements`), and the profile and discovery actions act on the person's own `AppInstanceUser`, which carries no classification tag. Membership changes are authorized against the channel and the bearer, both of which IAM can condition, and never against the member being added: `MemberArn` is a request parameter, measured by `backend/scripts/deny-test-assistant-membership.mjs`. So the services that change membership bearing an assistant hold it only on a channel and a bot carrying a declared classification, one statement conditioning each resource's `classification` tag (`membershipAsAssistantStatements`, `agent-classification-common.ts`), and the conversation creators, which bear the service admin, hold it only on a channel of their own classification and the admin's exact ARN (`membershipAsServiceAdminStatements`). For a role serving several classifications IAM does not pair the two legs, so pairing the bot with the channel's own classification is the handler's. Who is added is governed by Amazon Chime SDK's membership and moderator model plus the app-layer share and create gates, and the membership audit detects the rest.

## Absolute denials: actions a role simply never holds

The tag gate above is a *conditional* denial. Some denials are *absolute*: the action is never granted to the role, so no tag or membership could ever allow it. There is nothing to misconfigure, because the capability was never there.

- **Guests cannot create channels, add members, or list channels.** The `restricted` role grants only the minimal messaging set on channels it is admitted to; it deliberately omits `CreateChannel`, `CreateChannelMembership`, and `ListChannels` (the higher-role block that the restricted role skips). A guest therefore cannot discover channels or pull others in, by absence of the permission, not by a condition.
- **No browser role can redact or delete a message** (the next example).

## Any user's browser tries to delete or redact a message

**Attempt.** A user, including an admin, calls `chime:RedactChannelMessage` or `DeleteChannelMessage` from the SPA using their ordinary (chat) credential.

**Acting role.** Any credential-exchange CHAT classification role (`basic` / `standard` / `premium`, or an admin's chat identity on the `admin` role).

**Deciding policy.** The role action set, `EXCHANGE_MSG_ACTIONS` (`backend/lib/constructs/exchange-role.ts`), contains send, get, list, describe, moderator-list, read-marker and channel-rename actions, and deliberately **no** message `Update`, `Redact` or `Delete`:

```json
{ "Action": ["chime:SendChannelMessage", "chime:GetChannelMessage",
             "chime:ListChannelMessages", "chime:DescribeChannel",
             "chime:ListChannelMemberships", "chime:ListChannelModerators",
             "chime:UpdateChannelReadMarker", "chime:UpdateChannel"] }
```

**Result: denied on the chat role, including an admin's chat identity.** No chat credential can redact or delete another user's message, because the action is not on the chat roles and the chat identity `${personId}` is not an app-instance-admin. This holds even for an admin: their *chat* credential is powerless to act as an admin.

**User experience.** This is a deliberate, separate **admin** step. The admin console requests an admin credential from the admin credential exchange (`POST /exchange-credentials/admin/redact` or `/delete`, on a distinct role, `ExchangeRoleAdminPlane`) scoped to one channel, short-lived and audited, and calls Amazon Chime SDK redact or delete client-side as the admin's own `${personId}-admin` bearer (the next example). No server-side component wields the bearer.

**Assistant experience.** Redact is held only by the operator's `${personId}-admin` identity; a human channel moderator and an assistant hold no IAM grant for it. No assistant role carries `RedactChannelMessage` (`ASSISTANT_TURN_CHANNEL_ACTIONS` and the processor `ChimePolicy` omit it), whatever Amazon Chime SDK's moderator model would permit a channel-creating AppInstanceBot, and an assistant never holds `DeleteChannelMessage`, because delete is AppInstanceAdmin-only and assistants are not admins.

**To customize.** Keep destructive message actions off the CHAT roles. Administration lives on the separate admin-plane role, vended only by the admin credential exchange on a per-capability route, `POST /exchange-credentials/admin/<capability>` ([SPEC-ADMIN-IDENTITY.md](./SPEC-ADMIN-IDENTITY.md)); do not add delete or redact to `EXCHANGE_MSG_ACTIONS`.

## A prompt injection tries to make the assistant act as a user

**Attempt.** A crafted message tries to get the premium assistant to act as a user, or as another user's identity (a confused-deputy or impersonation attempt). In AWS the generic way to become another identity is `sts:AssumeRole`, so the real question is not only "can the credentials name another bearer" but "can this actor obtain different credentials at all."

**Acting role.** The premium classification's assistant acting role, assumed for the turn by the vend and tagged with the assistant, its assistant role and its bot (`assistantActingRole` in `agent-classification-common.ts`, `assistant-vend.ts`). The processor's own `ProcessorRole` holds its bootstrap and its own records only: it writes logs, invokes the vend, raises the admin error alert, and writes the processor's records about a turn (abuse counters and the cost circuit, turn state, the message-analytics row, the triage dispatch), which the acting role does not hold; a call the turn makes as the assistant without a session is refused rather than made as a wider identity (`assistant-profile-stack.ts`). The alert grant is `events:PutEvents` on the default bus for the `ae.alert` source only (`errAlert.grant(processorRole)`, `alertEmitterWiring` in `agent-classification-common.ts`), so the processor holds no Amazon Chime SDK send at all; the `AdminServices` stack posts the alert as the admin assistant. The acting role's bearer is a **bot** resource, never a user: `<appInstance>/bot/${aws:PrincipalTag/bot}`, conditioned on the bot's own `classification` tag; user roles pin the other way, to `<appInstance>/user/${aws:PrincipalTag/person}` (`exchangeVendStatements`, `backend/lib/constructs/exchange-role.ts`). At the Amazon Chime SDK layer, an AppInstanceBot and an AppInstanceUser are distinct principals that cannot be swapped.

**Deciding policy.** Three things have to hold, and they hold to different degrees:

- **The bearer is pinned, for a person.** A user can bear only their own AppInstanceUser, by the ARN pattern in the grant (the `person` session tag carries it). A user's grant and an assistant's grant never name each other's kind of resource, so neither can bear the other's kind of identity.
- **The bearer is pinned, for an assistant, by the same construction.** The acting role's bearer statement is `<appInstance>/bot/${aws:PrincipalTag/bot}` with `aws:ResourceTag/classification` equal to the role's own classification, so a session acts as exactly the bot it was minted for, and the boundary separately denies acting as any bot not tagged with this classification (`assistantActingRole`). Which bot a session carries is decided by the routing record the router writes for the turn (`lib/turn-routing.ts`); the vend reads it, resolves the assistant and its assistant role from the assignment records rather than from the caller, and refuses when either is missing, expired or for another classification (`assistant-vend.ts`). There is no fallback identity: a turn the vend refuses does not act (`adoptTurnIdentity` in `assistant-async-processor.ts`). What IAM cannot check is whether the router chose the right assistant within the classification; that decision is code. Some out-of-turn producers still post as a bot on their own roles with a classification-conditioned `/bot/*` bearer (**NOT BUILT** for them: see [SPEC-CREDENTIAL-EXCHANGE.md](./SPEC-CREDENTIAL-EXCHANGE.md), the assistant pin).
- **The escalation path is closed.** `sts:AssumeRole` is a real impersonation vector, so it is blocked several ways. The vended role credentials carry **no** `sts:AssumeRole`, so a user cannot assume a different role to get different credentials. The classification roles' **trust policy names only the credential-exchange Lambda** (`assumedBy: PrincipalWithConditions(ArnPrincipal(exchangeRoleArn), …)`, the `ExchangeRole` construct, `backend/lib/constructs/exchange-role.ts`), so nothing else may assume them. The one exception is the guest (`restricted`) role: where email replies are enabled, its trust policy also names the email reply poster, under the same `person` and `classification` conditions, so a verified reply is posted as the person (`EmailReplyPosterRole`, `identity-stack.ts`). The vend roles condition `person` and `classification` on `sts:AssumeRole` itself and repeat them on `sts:TagSession` (`vendTagPin`, `exchange-role.ts`), with the values the exchange sets from the caller's verified token, so an un-tagged assumption is refused outright. On the assistant side the acting role's trust policy names only the classification's vend, and requires `classification` equal to its own value, `role` among the assistant roles the deployment declares for the classification (`deployedRoles` in `assistant-profile-stack.ts`), and `assistant` and `bot` present, with the conditions on the assume itself as well as on the tag call (`PrincipalWithConditions`, `assistantActingRole`); the processor, the router and the flow cannot assume it at all. The classification's permissions boundary **denies `iam:*`, `sts:AssumeRole`, `sts:TagSession` and bot tagging** outright, so a session is a leaf that can neither chain into another role nor rewrite its own policy or identity tags.

**The ordering is part of the enforcement, not an implementation detail.** The assistant identity is fixed by the routing record before the turn is dispatched, and the processor adopts the vended session **before the model loop starts**, so at the moment it is fixed there is no model output to influence it. Fixing the assistant from anything the model emitted, or adopting the session later in the turn, would lose the property while still passing every check above. What the session does NOT bound is a tool the model selects that invokes another Lambda, which runs on its own role and its own bearer.

**Result: blocked, and the boundary is explicit.** A prompt cannot make the assistant borrow a person's identity, because the assistant's credentials can neither name a user bearer nor assume another role. The one component that can mint credentials pinned to a given `sub` is the credential-exchange Lambda, and it pins to the caller's own verified `sub`, so it cannot mint someone else's identity either. The trust boundary is therefore the exchange Lambda's role and code, not the assistant and not the prompt: impersonation would require compromising that role, not talking a model into it.

**User experience.** A user cannot make the assistant act on their behalf beyond what the assistant is already scoped to; the assistant answers as the assistant.

**Assistant experience.** The assistant acts as a bot identity and never as a person's, and nothing it is told changes whose credentials it holds or lets it acquire different ones. Which bot it acts as is bounded to its own classification by IAM and to one identity by the `bot` tag on its session, and the value that selects the bot is the routing record the router wrote, which only the router and arrival triage can write, and arrival triage only for its own posts.

**To customize.** Bearer pinning is set via the `bearerResources` option for platform roles and by `assistantActingRole` for assistants (`agent-classification-common.ts`); keep user roles pinned to the caller's own AppInstanceUser (the `person` session tag) and assistant sessions pinned to their own bot rather than resting on the classification condition alone. Do **not** grant `sts:AssumeRole` to the classification roles or to a vended session of either kind, do **not** relax the boundary's Deny on `iam:*` and `sts:AssumeRole`, and do **not** widen a trust policy beyond the principal meant to assume it - the exchange Lambda for a classification role, the classification's vend for the acting role. The session tags (`person` and `classification` for a person; `assistant`, `classification`, `role` and `bot` for an assistant, each required on the assume itself as well as on the tag call) are what keep every minted session pinned. A change to where the assistant session is adopted must keep it ahead of the model loop: that ordering, not the policy, is what makes a prompt unable to change whose identity the turn holds.

---

# Category 3. Assistant access to users and context

Beyond channels, an assistant is bounded in *which model* it may invoke and *what context* it may read.

## A Basic-classification assistant tries to use a Premium-only model

**Attempt.** The basic classification's async processor tries to call `bedrock:InvokeModel` on a model its classification does not declare, for example an Opus-class model reserved for premium.

**Acting role.** The basic classification's assistant acting role, the session every turn acts on (`assistant-profile-stack.ts`, driven by the basic classification's `topology` in `lib/config/profiles.ts`).

**Deciding policy** (`BedrockPolicy`, a managed policy on the acting role in `assistant-profile-stack.ts`; basic omits the streaming action because its topology sets `streaming: false`, while premium adds `InvokeModelWithResponseStream`):

```json
{
  "Effect": "Allow",
  "Action": ["bedrock:InvokeModel"],
  "Resource": "<modelArnsForClassification('basic')>"
}
```

**Result: denied.** `modelArnsForClassification('basic')` (`agent-classification-common.ts`, called from `assistant-profile-stack.ts`) resolves only the basic profile's model ARNs. A premium model ARN is not in the list, so `InvokeModel` on it is denied.

**User experience.** A basic user only ever receives answers from the basic model; the model selector in the console is scoped to their classification, so a higher model is not even offered.

**Assistant experience.** The basic processor cannot call the premium model even if code or configuration asked it to; the call returns `AccessDenied` at Bedrock.

**To customize.** Change which models a classification may invoke in its own `models` selection (on its entry in `profiles`) and deploy its stack; `modelArnsForClassification` builds the grant from that selection and the instance's catalog (`getModelCatalog`, `model-strategy.ts`). This is the single place classification-to-model access is granted.

## A Basic-classification assistant tries to read Premium knowledge-base context

**Attempt.** A basic turn tries `s3:GetObject` on `context/premium/...` to enrich an answer.

**Acting role.** The basic classification's assistant acting role.

**Deciding policy** (`roleContextStatements` in `agent-classification-common.ts`, on the acting role, each prefix conditioned on the session's `role` tag; the prefixes are capped by `contextPrefixesAllowedFor`, so the basic classification grants only the `context/basic/*` prefix):

```json
{
  "Effect": "Allow",
  "Action": "s3:GetObject",
  "Resource": "<attachmentsBucket>/context/basic/*"
}
```

**Result: denied.** The basic role holds a grant for `context/basic/*` only. Premium and standard prefixes are absent, so reads against them are denied. Premium adds `context/standard/*` and `context/premium/*` to its own role, which is why premium can read everything its grant set names and basic cannot read outside its own.

**Note the asymmetry with the channel boundary, because it is deliberate.** ADR-042 narrowed an assistant's CHANNEL reach to its own classification alone; its CONTEXT reach is still the set its classification grants. So a premium assistant reads three context prefixes and answers only in premium channels. The two are generated from one resolver, and `backend/test/cdk-synth.test.ts` (case 'gives the assistant the SAME reach for channels and for context prefixes') is what keeps them from drifting apart independently.

**User experience.** A basic user's assistant cannot surface premium knowledge into the conversation, so material of a classification the room is not cleared for never appears in it.

**Assistant experience.** The context-retrieval tool returns nothing for premium documents; the model answers without that material rather than leaking it.

**To customize.** Edit the prefix list each classification stack's `roleContextStatements` are capped by, which is the classification's `grants` in `profiles.ts` rather than a hand-written list. Adding a grant widens what that classification's assistant can read; removing one narrows it. Context is laid out under `context/{classification}/` in the attachments bucket.

## A channel member tries to read the conversation's private host grounding

**Attempt.** A browser user (or a bug on their behalf) tries to read the conversation's private host grounding - the participant profile, domain context, extra context blobs, and resolved display name a host stamped on the channel.

**Where it lives.** Not in the Amazon Chime SDK channel Metadata (any member reads that via `DescribeChannel`), but in a dedicated DynamoDB table, `ChannelContextTable` (`conversations-stack.ts`), keyed by `channelArn`. Metadata keeps only what a member may both see and rewrite without consequence: the display model fields, the drift pointers and a sanitized topic label. The reply language, the segment and the participant roster are in the server-side store with the grounding, because each decides something (`channel-context-client.ts`).

**Acting role.** No browser role, Cognito, guest, or Identity-Pool principal holds any grant on the table. The conversation-create Lambdas write it (`channelContextTable.grantWriteData`, `conversations-stack.ts`); the router and handler roles hold `dynamodb:GetItem` and `dynamodb:UpdateItem` on it and nothing else (`assistant-profile-stack.ts`): the read is per-turn grounding, and the update is the pre-creation participant write on the drift-confirm and split paths, which create conversations from inside the handler.

**Deciding policy** (the handler's grant on the store):

```json
{
  "Effect": "Allow",
  "Action": ["dynamodb:GetItem", "dynamodb:UpdateItem"],
  "Resource": "<channelContextTable ARN>"
}
```

**Result: absolute denial for every member principal.** The store is reachable only by server-side Lambda roles: the create Lambdas write it, and the handler reads one item at a time and patches owned fields on a row it is creating, with no `PutItem` (which would replace another conversation's whole item), `DeleteItem`, `Query` or `Scan`. Because no user role references the table at all, a member cannot read the private grounding by any path, and it never enters the member-readable channel Metadata. This boundary is asserted in `backend/test/cdk-synth.test.ts` (case 'assistant role holds only GetItem + UpdateItem on the channel-context store', which also refuses `PutItem`, `DeleteItem`, `Scan`, `Query` and `BatchWriteItem`; and the Cognito auth stack references it from no role).

**User experience.** A member sees the conversation and its messages, never the host grounding that shapes how the assistant is briefed; that grounding informs the assistant without being exposed to the people in the room.

**Assistant experience.** The router reads the grounding server-side and forwards it to the worker as context for the turn; the assistant is grounded without any member being able to read the same record.

**To customize.** Keep the full write on the conversation-create Lambdas and the handler's grant at `GetItem` plus `UpdateItem`; do not grant any browser or Identity-Pool role access to `ChannelContextTable`. Put only member-safe fields in channel Metadata.

---

# Category 4. Human admin and the admin service user

"Admin" is more than one thing. The full three meanings are in [IDENTITY-AND-ACCESS-MODEL.md](./IDENTITY-AND-ACCESS-MODEL.md); the two that act are the **human admin** (a claim, acting as themselves) and the **admin service user** (a machine identity for administration).

## An admin's chat identity is membership-gated like any user's

**Attempt.** A user in the `admins` group reads and participates, with their chat credential, in channels of a classification they are not cleared for.

**Acting role.** The credential exchange vends the chat identity on the role the person's classifications name, bearer-pinned to their own AppInstanceUser. The `admins` group clears for the `admin` classification, which grants itself alone: it is the classification of admin conversations (the admin notification channel), and it reaches no member conversation. A person holding `admins` alone is vended the `admin` vend role; a person holding `admins` beside `premium` is vended the `premium` vend role with the `adminPlane` session tag. Admin access (reading any conversation, the archive, every admin capability) is a separate identity, never this credential ([SPEC-ADMIN-IDENTITY.md](./SPEC-ADMIN-IDENTITY.md) FR1).

**Deciding policy** (`exchangeVendStatements`, `backend/lib/constructs/exchange-role.ts`): every vend role's channel grant is tag-gated to the set its classification grants, the `admin` role's included (admin-plane channels only). A member vend role carries one more statement, `AllowAdminPlaneChannelActionsWhenHeld`, allowing channels tagged with the admin plane's classification only when `aws:PrincipalTag/adminPlane` is `true`, which the exchange asserts only for a person holding the admin plane.

**Result: denied outside what the person holds.** An `admins`-only chat credential reaches admin conversations and nothing else; a `premium` + `admins` chat credential reaches `basic`, `standard`, `premium` and admin conversations. Neither reaches an untagged channel. The chat role uses `EXCHANGE_MSG_ACTIONS`, so the admin cannot redact or delete with it either (Category 2).

**User experience.** An admin chats as themselves in the conversations their classifications reach, the admin conversation included. Oversight across every conversation runs in the admin console, as the admin's own `${personId}-admin` identity (next section), so every privileged read is a separate, attributable vend.

**To customize.** The `admins` group (`groupClearance` in `backend/lib/config/profiles.ts`) is the clearance for admin conversations. Admin access is an issuer declaring `admin: true` plus its admin groups (`adminGroups`, default `admins`) in the trusted-issuer registry; the two are independent.

## The admin identity: client-side administration (redact and delete)

The human admin above participates through their chat role as their chat identity `${personId}`, which holds no admin authority. Destructive administration, redacting and deleting others' messages, runs as a SEPARATE per-human identity: the admin's own `${personId}-admin` `AppInstanceUser`, registered as an `AppInstanceAdmin`, which holds cross-channel redact and delete.

The admin console requests this identity's credential from the admin credential exchange on the capability's own route, `POST /exchange-credentials/admin/<capability>` (the `ExchangeRoleAdminPlane` role): scoped to one channel, short-lived, and recorded (`admin_scoped_credential_vend`). The SPA then calls Amazon Chime SDK redact or delete directly with the `${personId}-admin` bearer, so the action is the human acting as themselves rather than a server-side bearer swap. This is why the CHAT roles, admin included, never hold redact or delete (the absolute denial in Category 2): those capabilities live only on the separate `${personId}-admin` identity, vended per request. A dedicated SERVICE `app-instance-admin` (created by `create-app-instance-admin.ts`, ARN in SSM) exists only for no-human automation; see [SPEC-ADMIN-IDENTITY.md](./SPEC-ADMIN-IDENTITY.md) for the two-identity model and [SPEC-MODERATION.md](./SPEC-MODERATION.md) for the content-moderation surfaces.

---

## How this maps to customization, in one place

| You want to change | Edit | Effect |
|---|---|---|
| Classifications and what each grants | `classifications` + `groupClearance` in `backend/lib/config/profiles.ts` (interpreted by `ProfileRegistry`; `classificationsAllowedFor` delegates to `grantsFor`) | Defines the grant set the channel gate evaluates for a person; an assistant reaches its own classification alone regardless |
| Which models a classification may invoke | The classification's `models` selection, through `modelArnsForClassification` and the model catalog (`model-strategy.ts`) | The per-classification `bedrock:InvokeModel` resource list |
| What context a classification's assistant may read | that classification's `grants` in `profiles.ts`, which caps the `roleContextStatements` prefix list | The per-classification S3 read scope |
| What the browser may do | `EXCHANGE_MSG_ACTIONS` (`backend/lib/constructs/exchange-role.ts`) | The action set on every user role; keep destructive message actions off it |
| Who is an admin | `admins` group, `ADMIN_GROUP_NAMES` | Unlocks the admin console session, the per-request `${personId}-admin` admin-plane vend and the admin API; its chat role reaches admin conversations only |
| Identity pinning | `bearerResources` and `assistantActingRole` (`agent-classification-common.ts`), the vend (`assistant-vend.ts`) and the routing record (`lib/turn-routing.ts`) | Which identity a role may bear; keep pinned, and keep the vend the only principal the acting role trusts |
| Who can join a channel (guest admission) | channel membership via create-conversation / invite path | The Amazon Chime SDK-membership boundary for guests and shared channels |
| Cross-classification membership control | `share-conversation` / `create-conversation` classification check, plus the Layer 6 Kinesis audit consumer | App gate refuses an invite the clearance does not reach; the tag gate makes an out-of-band add inert for a human and for an assistant alike; the audit reports, and revokes only when the runtime enforce toggle is on |
| Preventing role escalation | role-role trust policy + no `sts:AssumeRole` on roles (`ExchangeRole`, `backend/lib/constructs/exchange-role.ts`), plus the assistant boundary's Deny on `iam:*`, `sts:AssumeRole` and `sts:TagSession` | Only the exchange Lambda may assume classification roles (the guest role also trusts the email reply poster where email replies are on), and only a `person`-tagged session resolves a bearer; only the vend may assume the acting role, and a session is a leaf |

## Related

- [IDENTITY-AND-ACCESS-MODEL.md](./IDENTITY-AND-ACCESS-MODEL.md): the model these examples enforce, and the three meanings of "admin".
- [SPEC-CONVERSATION-SECURITY.md](./SPEC-CONVERSATION-SECURITY.md): the defense-in-depth layers, the access matrix, and membership admission control.
- [SPEC-CREDENTIAL-EXCHANGE.md](./SPEC-CREDENTIAL-EXCHANGE.md): the exchange that vends the bearer-pinned, classification-bound credentials.
- [SPEC-MODERATION.md](./SPEC-MODERATION.md): the client-side own-identity path for redact and delete.
- [SPEC-ADMIN-IDENTITY.md](./SPEC-ADMIN-IDENTITY.md): the two-identity admin model (chat `${personId}` against `${personId}-admin`).
- [ADR-042](../../../design/decisions/042-an-assistant-acts-in-exactly-one-classification.md): why an assistant's channel reach is its own classification alone.
- [ADR-046](../../../design/decisions/046-classifications-are-a-set-not-a-ladder.md): why a grant set is declared rather than derived from a rank.
