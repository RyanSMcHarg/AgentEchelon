# Metadata and Tags: What Goes Where

This guide is the rule for storing data on Amazon Chime SDK channels and users, and for using
resource tags. It exists because the wrong choice leaks information to other users or
silently weakens the tier boundary. Read it before you add a field to a channel, a user,
or a tag.

The one-line version:

> **Tags gate access. Channel metadata is public to members. User metadata does not exist.
> Sensitive per-channel data lives in Aurora, read server-side only.**

Related: [SPEC-CONVERSATION-SECURITY](../../specs/identity-access/SPEC-CONVERSATION-SECURITY.md),
[TAGGING (cost tags)](../admin/TAGGING.md),
[SPEC-MESSAGE-METADATA-CODEBOOK](../../specs/conversation-messaging/SPEC-MESSAGE-METADATA-CODEBOOK.md).
The channel-metadata relocation design (`SPEC-CHANNEL-METADATA-MINIMIZATION`) is tracked internally until it ships.

---

## 1. Channel metadata is readable by every member

Amazon Chime SDK channel `Metadata` is a single JSON blob returned by `DescribeChannel`, and
`DescribeChannel` is part of the default `view` capability every channel member holds.
**Anything you write into channel metadata is disclosed to every member of that channel** -
including members added later by a share, and federated guests. In a 1:1 channel that is
fine; in any shared, team, or federated channel it is a cross-member disclosure.

### Do put in channel metadata
Non-sensitive, display-level data that is appropriate for **every** member to see:
- `topic` (the conversation's display title)
- `triggerContext` (a short greeting-shaping hint with no identity in it)
- `contextType` (`private` / `guest` / `briefing`; also a tag)
- `createdVia` (`user` / `drift` / `proactive` / `federated`)
- `modelTier` (a tier name, not a person; the non-authoritative Layer 2 mirror of the tag)

### Never put in channel metadata
- **Any identity**: a user's `sub`, a federated `iss` (home-IdP issuer), email, or ARN.
  The creator is available natively as `Channel.CreatedBy`; members are available natively
  as `ListChannelMemberships`. Do not copy them into metadata.
- **Anything about another user**: names, roles, profiles, language, geo, presence.
- **Host-app domain payload**: work items, plans, assignees, `participantProfile`,
  `domainContext`, `otherContexts`, `contextId`. This is another user's business data.
- **Secrets or credentials** of any kind.

If you need per-channel context that is not safe for every member to read, it goes in
Aurora (section 4), not in metadata.

### Do not trust channel metadata for a security decision
Metadata is mutable by any channel moderator (the owner `rename` capability is
`chime:UpdateChannel`, which can rewrite the metadata blob). Never read a field from
channel metadata and use it to authorize, gate a tier, or select a model tier. The
authoritative signal is the `classification` tag (section 3). `modelTier` may exist in
metadata as a convenience mirror, but the router resolves the served tier from the tag
(`resolveChannelTier` -> `ListTagsForResource`), never from metadata.

## 2. User metadata: there is none

AppInstanceUser `Metadata` is **always empty**. The credential-exchange service creates and
refreshes every AppInstanceUser with `Metadata: ''` on purpose. Do not start storing user
attributes there:
- It has no access-control benefit and adds a surface to tamper.
- The authoritative user tier is the **Cognito group**, resolved via
  `AdminListGroupsForUser`. Nothing else is trusted for tier.
- User attribute changes (tier, approval) go through the admin-gated `user-management`
  handler (behind `callerIsAdmin`), never through a self-service path, and the group -
  not any attribute - is what authorization reads.

If you think you need to store something on a user, you almost certainly want either a
Cognito group (for authority) or an Aurora row keyed by the user sub (for data).

## 3. Tags gate access; keep them immutable and non-secret

Two tag families exist, for two different jobs.

### The `classification` security tag
- Set **once, at channel creation**, to the channel's tier, and **never changed**.
  `chime:UpdateChannel` cannot modify tags, which is exactly why the tier boundary keys on
  the tag and not on metadata.
- IAM enforces it: `tierChannelScopedAllow` grants channel actions only where
  `aws:ResourceTag/classification` is the caller's tier or below, fail-closed on an
  untagged or higher-tier channel (`lib/stacks/agent-classification-common.ts`).
- Every channel-creation path must apply it (native, drift, federated, briefing). A channel
  created without it is inert to tier-capped callers by design; that is a bug in the
  creation path, not a safe default to rely on.
- Reading the tag at runtime uses `chime:ListTagsForResource`. A tag **read** cannot be
  tier-gated (it is how the tier is learned), so grant it as an ungated channel read.

### Cost-attribution tags
`Project`, `Codebase`, `Instance`, `Environment`, `ManagedBy` are applied once at the app
root and are covered by [TAGGING](../admin/TAGGING.md). Do not set `Project` per stack.

### Tag rules
- Tags are for **access control and cost attribution**, not for storing data.
- Never put a secret, a mutable value, or per-user data in a tag. Tags are readable through
  the AWS API and are capped in size and count.
- If a value needs to change over the channel's life, it does not belong in a tag.

## 4. Sensitive per-channel data lives in Aurora, read server-side

Per-channel host and participant context (`domainContext`, `otherContexts`,
`participantProfile`, the `{sub, iss, role}` roster, `userLanguage`, `segment`,
`contextId`) is stored in the Aurora `channel_context` table, keyed by `channel_arn`. It is
never member-readable.

Non-VPC Lambdas (the router, notification bridge) must not connect to Aurora directly
(ADR-018). They call the data-plane Lambda through `lib/data-plane-client.ts`:
- `putChannelContext(channelArn, context, roster)` to write (federated create / add-member).
- `getChannelContext(channelArn)` to read (router grounding, notification roster).

This keeps the host payload out of every member's reach while the assistant still gets full
grounding server-side.

## 5. Quick decision table

| You want to store... | Put it in... |
|----------------------|--------------|
| The channel's tier (for access control) | `classification` **tag**, set once at creation |
| The channel's display title / greeting hint | channel **metadata** (`topic`, `triggerContext`) |
| Who created the channel | nowhere - read `Channel.CreatedBy` |
| Who the members are | nowhere - read `ListChannelMemberships` |
| A member's issuer, role, profile, language, geo | Aurora `channel_context` (server-only) |
| Host-app work items / plans / assignees | Aurora `channel_context` (server-only) |
| A user's tier / authority | Cognito **group** (admin-managed) |
| Any attribute on an AppInstanceUser | nowhere - user metadata stays empty |
| Cost-attribution identity | app-root **tags** (see TAGGING) |
| A secret | Secrets Manager - never a tag or metadata |
