# Metadata and Tags: What Goes Where

This guide is the rule for storing data on Amazon Chime SDK channels and users, and for using resource tags. The wrong choice leaks information to other members or weakens the classification boundary. Read it before you add a field to a channel, a user, or a tag.

The one-line version:

> **Tags gate access and record relations. Channel metadata is readable by every member and writable by members, so it never holds an identity or a relation. User metadata is not written. The private per-channel host grounding lives in a server-only store (`ChannelContextTable`), read server-side only.**

Related: [SPEC-CONVERSATION-SECURITY](../../specs/interaction/governance/SPEC-CONVERSATION-SECURITY.md), [TAGGING (cost tags)](../admin/TAGGING.md), [SPEC-MESSAGE-METADATA-CODEBOOK](../../specs/communication/SPEC-MESSAGE-METADATA-CODEBOOK.md). The rule is minimization: a field goes in member-readable channel metadata only if every member may see it and rewriting it changes no decision.

---

## 1. Channel Metadata

Amazon Chime SDK channel `Metadata` is a single JSON blob (capped at about 1 KB) returned by `DescribeChannel`, and `DescribeChannel` is part of the default `view` capability every channel member holds. **Anything written into channel metadata is disclosed to every member of that channel** - including members added later by a share, and federated guests.

### Fields as built
Display-level data only. The create paths write these through `createConversationCore` in `backend/lambda/src/lib/channel-creation.ts` (person, drift, typed, a host's context create and add, the proactive briefing); a host's add (`membershipHandler` in `conversation-management.ts`) also refreshes them on an existing conversation:
- `modelId`, `modelName` (display labels; nothing decides from them)
- `modelTier` (the classification name; the non-authoritative mirror of the tag)
- `membershipSource` (a display hint so the client can show Share disabled; the share Lambda refuses from the copy in the context store)
- `topic` (the conversation's subject, typed by the person who opened it; also written to the context store)
- `createdVia: 'person'` and `createdBy` (person create path; see the exception below)
- `createdViaDrift`, `parentChannelArn`, `originatingMessageId`, `triggerContext` (drift create path; `triggerContext` is a sanitized topic label)
- `contextType`, `contextId` (federated paths: the host's context type and its plan anchor id, both bounded; `contextType` is also a tag)

**NOT BUILT:** two of these break the rule below. `createdBy` is an identity (`createConversationForPerson` in `backend/lambda/src/lib/channel-creation.ts`), and `parentChannelArn` is a relation between conversations (`createConversationFromDrift` and `createConversationFromEvent` in the same file), which the router reads back as the welcome's fallback `parentRef` link when the context store holds none (`router-agent-handler.ts`). Under the rule, the relation is a channel link tag (section 3) and the creator is read from the moderator list, which is where every authorizing reader already looks.

### Never put in channel metadata
- **Any identity**: a user's `sub`, a federated `iss` (home-IdP issuer), email, or ARN. Members are available natively as `ListChannelMemberships` and moderators as `ListChannelModerators`. The one exception is below.
- **Any relation**: another channel's ARN, a parent or child link, or meeting state. A relation between conversations is a resource tag on a channel naming the other channel (section 3), which no member can rewrite.
- **Anything about another user**: names, roles, profiles, language, geo, presence.
- **Host-app domain payload**: work items, plans, assignees, `participantProfile`, `domainContext`, `otherContexts`. This is another user's business data.
- **Secrets or credentials** of any kind.

**Exception: `createdBy`, to be removed.** The person create path writes `createdBy: input.userArn`, the creator's AppInstanceUser ARN, set server-side from the validated JWT claim. It is written for attribution only (an operator reading `DescribeChannel`). It is member-writable, so nothing authorizes on it: ownership and moderator checks read `ListChannelModerators` (for example `callerIsModerator` in `channel-battle.ts`). The federated and drift paths do not write it.

If you need per-channel context that is not safe for every member to read, it goes in the server-only Channel Context store (section 4), not in metadata.

### Never trusted
Metadata is writable by any channel moderator, and every conversation's creator is one (`chime:UpdateChannel` rewrites Name and Metadata in one call), so treat it as member-writable. Never read a field from channel metadata and use it to authorize, gate a classification, or select a model. The authoritative signal is the `classification` tag (section 3). The router resolves the served classification from the tag (`resolveChannelClassificationTag` -> `ListTagsForResource`), never from `modelTier`.

## 2. User Metadata

The credential-exchange service creates every AppInstanceUser with no `Metadata`, and its display-name refresh (`refreshDisplayName` in `backend/lambda/src/lib/vend.ts`) carries the existing value across unchanged. Do not start storing user attributes there:
- It has no access-control benefit and adds a surface to tamper.
- A person's clearance comes from the clearance source their issuer declares (`backend/lambda/src/lib/clearance-source.ts`), read by AppInstanceUser through `Directory.clearanceOf`, whichever issuer signed them in; for a Cognito pool's own groups the shipped `ClearanceSource` adapter reads them with `AdminListGroupsForUser`. Never from a tag or channel Metadata.
- Clearance changes go through the admin-gated `user-management` handler (behind `callerIsAdmin`), never a self-service path.

If you think you need to store something on a user, you almost certainly want either a group (for authority) or a row keyed by the person's AppInstanceUser id (for data). The one thing a user resource carries about another resource is a relation tag (section 3).

## 3. Tags

Tags are for access control, labels, relations between resources and cost attribution. The families:

### The `classification` security tag
- Set **once, in the channel's create call**, to the channel's classification, and **never changed**. `chime:UpdateChannel` cannot modify tags, which is why the classification boundary keys on the tag and not on metadata.
- IAM enforces it: `classificationChannelScopedAllow` (`backend/lib/stacks/agent-classification-common.ts`) grants channel actions only where `aws:ResourceTag/classification` is in the caller's set. A person reaches the classifications `classificationsAllowedFor` returns (its declared grant set, [ADR-046](../../design/decisions/046-classifications-are-a-set-not-a-ladder.md)); an assistant reaches only its own classification (`channelsAnAssistantMayActIn`, [ADR-042](../../design/decisions/042-an-assistant-acts-in-exactly-one-classification.md)). An untagged channel matches no Allow (fail-closed).
- Every channel-creation path applies it (person, drift, federated, briefing). A channel created without it is unreachable by every classification-scoped caller; that is a bug in the creation path, not a safe default to rely on. Every creator creates only its own classification: its `chime:CreateChannel` requires the `classification` tag in the request and requires it to be the role's own (`createOwnClassificationOnly`), and its tag-on-create grant (`tagOnCreateStatements`) stamps only that value and only where the channel carries no `classification` yet or already carries the same one, so no grant can reclassify an existing conversation. A conversation opened from another one (a drift split, a typed or ops conversation an event opened) carries the origin's classification: the creator reads the origin's tag and refuses a mismatch (`OriginClassificationMismatchError`). Archiving writes the `archived` key and no other.
- Reading the tag at runtime uses `chime:ListTagsForResource`. A tag **read** cannot be classification-gated (it is how the classification is learned), so it is granted as an ungated channel read.

### Channel label tags
Written in the same create call, read by nothing that decides access:
- `primaryAssistant` (`PRIMARY_TAG` in `conversation-primary.ts`): the room's primary assistant by handle, resolved before the room exists.
- `conversationType` (`CONVERSATION_TYPE_TAG` in `channel-creation.ts`): the room's type key, as a label an operator filters on. The type that decides policy is the context store's `conversationType`, which no member can write.
- `contextType` (federated paths): the host's context type.

### AppInstanceUser tag
The credential exchange tags each person's AppInstanceUser with `classification` set to their resolved clearance (`credential-exchange.ts`), as a separate best-effort call after create. It makes the clearance readable on the identity; it is not what enforces it, and an unresolved clearance leaves the identity untagged rather than guessed.

### Relation tags
A relation between two resources is a tag on one of them whose value is the other's ARN. A tag is written by the creator, cannot be changed by `chime:UpdateChannel`, and is readable to IAM and to any reader with `chime:ListTagsForResource`, so it is the one place a relation can be both trusted and audited. A channel ARN fits a tag value, which allows up to 256 characters and the `:` and `/` an ARN uses. There is no person-level link or alias table: one human is one AppInstanceUser, so the only relations a resource carries are these two tags. The server-only channel-context row may also carry a `parentRef` for the router's grounding; it is read server-side only and is never the record of the link.
- **The channel link tag.** A conversation opened from another one (a drift split, a conversation an event opened, a meeting conversation scheduled from its parent, a customer conversation seeded from a guest conversation) carries a tag naming the source channel's ARN, written in the create call. It is a link, never a grant: membership of one conversation reaches nothing in the other, and erasing a person follows the tag to the source conversation.
- **The owner tag on the admin twin.** The admin-plane AppInstanceUser, the one second principal a human holds ([SPEC-ADMIN-IDENTITY](../../specs/interaction/governance/SPEC-ADMIN-IDENTITY.md)), is created by the admin credential exchange and tagged with its owner's AppInstanceUser ARN. Analytics, audit and erasure attribute an admin-plane action to its owner through this tag, never by parsing the twin's id.

The admin credential exchange writes the owner tag (`ensureAdminIdentity` in `backend/lambda/src/admin-credential-exchange.ts`, through `tagIdentity` in `backend/lambda/src/lib/vend.ts`, key `ADMIN_TWIN_OWNER_TAG` in `backend/lambda/src/lib/person-arn.ts`), and offboarding finds the twin by it (`backend/lambda/src/lib/offboarding.ts`). The channel link tag is written on a customer conversation a path B claim opens and on the conversation a path A bind continues the visit in: `upgradedFrom` names the visitor's conversation and `upgradedFromPerson` the visitor's AppInstanceUser (`UPGRADE_SOURCE_TAG` and `UPGRADE_SOURCE_PERSON_TAG` in `backend/lambda/src/lib/upgrade.ts`, written by `createConversationForUpgrade` in `backend/lambda/src/lib/channel-creation.ts`), and offboarding follows both (`backend/lambda/src/lib/offboarding.ts`). **NOT BUILT:** the link tag on every other relation; a drift split's or an event conversation's source channel is recorded as `parentChannelArn` in channel metadata (`backend/lambda/src/lib/channel-creation.ts`).

### Cost-attribution tags
`Project`, `Codebase`, `Instance`, `Environment`, `ManagedBy` are applied once at the app root and are covered by [TAGGING](../admin/TAGGING.md). Do not set `Project` per stack.

### Tag rules
- Never put a secret, a mutable value, or per-user data in a tag. Tags are readable through the AWS API and are capped in size and count. A relation tag holds another resource's ARN, which is a reference rather than per-user data.
- If a value needs to change over the channel's life, it does not belong in a tag.

## 4. Channel Context Store

The sensitive host grounding a conversation carries - `participantProfile`, `domainContext`, `otherContexts`, and the resolved `userName` - is stored in a **server-only DynamoDB table** (`ChannelContextTable` in `conversations-stack.ts`, keyed by `channelArn`). The same table holds the member roster (`participants`, `memberIdentities`), `onboardingIntake`, `conversationType`, `membershipSource`, and the drift carry-over (`priorSubject`, `priorMessage`, `parentRef`). The owned fields are listed in `OWNED_FIELDS` in `channel-context-client.ts`; a field absent from that list is discarded on write.

No member principal is granted access. Writers are the conversation-create Lambdas (person and context create, a host's add, the proactive briefing) and the assistant Lambdas (router handler, async processor, conversation split, event creation), each with `UpdateItem` (plus `GetItem` on the assistant side) and no `PutItem`, `DeleteItem` or `Scan`. Readers are the assistant Lambdas, the membership reconcile (a keys-only `Query` on the `ByConversationType` index), and the share-conversation Lambda in `notification-stack.ts` (`GetItem`, for `membershipSource`). Grants are in `conversations-stack.ts`, `assistant-profile-stack.ts` and `notification-stack.ts`.

**OPEN:** nothing deletes a row, so a conversation's `onboardingIntake`, `memberIdentities` and `domainContext` outlive the channel's expiration (see the comment on the table in `conversations-stack.ts`).

Read and written through `backend/lambda/src/lib/channel-context-client.ts`:
- `putChannelContext(channelArn, { participantProfile, domainContext, otherContexts, userName, userLanguage, segment })` to write (a host's context create and add).
- `getChannelContext(channelArn)` to read (router grounding).

**Routing signals.** `userLanguage` and `segment` decide which model answers the turn (`segment.country === 'CN'` routes to the Chinese model) and which language it replies in. Channel metadata is member-writable, so sourcing them from it would let a member choose the model serving their own conversation. They are written server-side and read only from the store. `host-grounding.ts` reads them from the store alone, and a value found in metadata is ignored and reported.

**Roster.** The member roster is not in metadata. Who is in the conversation is read from live channel membership. The stored `memberIdentities` is an **issuer hint** only: it supplies the home-IdP `iss` needed to resolve a federated member's contact details, and only for ids that are already members. The notification fan-out resolves who to notify from live membership, never from a stored list (`channel-notify.ts`). Nothing in metadata is trusted as grounding or as a routing decision.

**Grounding held only in metadata.** A channel whose grounding fields exist only in its metadata (written before the store held them) gets none from the store. Nothing errors: the assistant answers ungrounded, and because `userLanguage` and `segment` choose the model, a conversation routed to another language or region falls back to the deployment default. `host-grounding.ts` detects and logs each such turn rather than reading metadata, naming the channel and which keys are present (never their values).

The recovery is `backend/scripts/backfill-channel-context.ts`, run once from `backend/`, where `ts-node` is installed (the repository root has no `package.json`):

```bash
cd backend
AWS_PROFILE=<your-profile> npx ts-node scripts/backfill-channel-context.ts --dry-run
AWS_PROFILE=<your-profile> npx ts-node scripts/backfill-channel-context.ts
```

It is an operator action rather than a read-time fallback because metadata is member-writable: promoting it is a judgement about one deployment at one moment, not a standing trust relationship. The promoted values are re-bounded and marker-stripped on the way in, the store is never overwritten, and the run reports what it recovered and what it left alone. A channel whose metadata has since been rewritten without those fields recovers from nowhere; the host must re-send its grounding through the create path. Full rules in `backend/lambda/src/lib/legacy-channel-context.ts`.

## 5. Quick decision table

| You want to store... | Put it in... |
|----------------------|--------------|
| The channel's classification (for access control) | `classification` **tag**, set once at creation |
| The channel's display title / greeting hint | channel **metadata** (`topic`, `triggerContext`) |
| Who created the channel | read `ListChannelModerators` for authority; `createdBy` in metadata is attribution only |
| Who the members are | nowhere - read `ListChannelMemberships` |
| That this conversation was opened from another one | a channel link **tag** naming the source channel's ARN, set at creation (section 3); never metadata |
| Whose admin-plane identity an admin twin is | an owner **tag** on the twin naming the owner's AppInstanceUser ARN (section 3) |
| A member's profile / the conversation's domain grounding | `ChannelContextTable` DynamoDB (server-only, `channel-context-client.ts`) |
| Host-app work items / plans / other-context blobs | `ChannelContextTable` DynamoDB (server-only) |
| The member roster and federated issuers | `ChannelContextTable` (`participants`, `memberIdentities`); live membership decides who is in the conversation (section 4) |
| A member's language, geo | `ChannelContextTable` DynamoDB (server-only) - they select the reply language and the model, so they are never sourced from member-writable metadata (section 1, `host-grounding.ts`) |
| The conversation type that decides policy | `ChannelContextTable` (`conversationType`); the `conversationType` tag is a label |
| A person's clearance / authority | identity-provider **group** (admin-managed), read through `clearance-source.ts` |
| Any attribute on an AppInstanceUser | nowhere - user metadata stays empty |
| Cost-attribution identity | app-root **tags** (see TAGGING) |
| A secret | Secrets Manager - never a tag or metadata |
| What a message is (an answer, a notice, a duel side) and which assistant said it, for analytics | the **message** `Metadata` and its out-of-band record, never channel metadata ([SPEC-MESSAGE-METADATA-CODEBOOK](../../specs/communication/SPEC-MESSAGE-METADATA-CODEBOOK.md), "Turn shapes in analytics") |
