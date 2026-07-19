# Conversation Security, Membership, and Information Isolation

**Status:** Implemented (Layers 1-6 are live; Layer 7 mixed-trust visibility is partial)

**Model:** Six defense layers (Layer 1 through Layer 6) isolate tiers within the app; Layer 7 governs mixed-trust visibility when an external guest shares a channel with internal members.
**Addresses:** Context leakage in mixed-tier conversations, conversation types, membership enforcement, drift detection
**References:** [Creating read-only chat channels for announcements with Amazon Chime SDK messaging](https://aws.amazon.com/blogs/business-productivity/creating-read-only-chat-channels-for-announcements-with-amazon-chime-sdk-messaging/) (McHarg, 2021)

---

## 1. The Problem

When a Premium user and a Basic user are in the same conversation, the Premium agent can surface financial data, board minutes, or competitive intelligence into a channel the Basic user can read. Context isolation (S3 prefix-based IAM) controls what the agent can **read** - but not what it **writes** into the channel.

The solution requires **six defense layers**, any one of which should prevent the leak independently.

## 2. Defense-in-Depth Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Channel Tags (IAM Condition Keys)                  │
│ Channels tagged with classification at creation.            │
│ IAM policies use tag conditions to block operations on      │
│ channels above the user's tier.                             │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: Channel Metadata (Application-Level)               │
│ classification field in Amazon Chime SDK channel metadata.             │
│ All Lambda handlers read metadata before membership ops.    │
├─────────────────────────────────────────────────────────────┤
│ Layer 3: User Tier (Cognito Groups)                         │
│ Tier is a Cognito group, not a stored user tag.             │
│ Lambdas resolve tier via AdminListGroupsForUser.            │
├─────────────────────────────────────────────────────────────┤
│ Layer 4: Agent IAM (S3 Prefix Scoping)                      │
│ Each tier's assistant has S3 access scoped to its tier's    │
│ prefix. It literally cannot read higher-tier context.       │
├─────────────────────────────────────────────────────────────┤
│ Layer 5: Bedrock Guardrails (Content Filtering)             │
│ Tier-specific guardrail policies block topic categories     │
│ that exceed the conversation's classification.              │
├─────────────────────────────────────────────────────────────┤
│ Layer 6: Kinesis Stream Audit (Async Enforcement)           │
│ Archival Lambda monitors membership events. Flags or        │
│ reverts violations that bypass Layers 1-5.                  │
└─────────────────────────────────────────────────────────────┘
```

## 3. Conversation Types and Classification

### Types

| Type | Classification | Members | Agent | Use Case |
|------|---------------|---------|-------|----------|
| **Private** | Creator's tier | 1 user + 1 agent | Creator's tier agent | Default. Private AI assistance. |
| **Team** | Set at creation | Multiple users + 1 agent | Classification tier agent | Collaboration at a specific tier level. |
| **Open** | `basic` | Any user + basic agent | Basic agent | Broad collaboration. Public context only. |

### Creation Rules

- Classification is set at creation time and **cannot be changed**
- Classification is enforced by **channel tags** (IAM layer) AND **channel metadata** (application layer)
- A user cannot create a conversation above their own tier
- A Premium user who wants to include Basic users creates an Open conversation

### Multi-user response gating

In a multi-user conversation the assistant responds only when it is addressed: `@assistant`
or `@all` is required for the bot to reply. `backend/lambda/src/channel-flow-processor.ts`
enforces this mention-required behavior. `create-conversation/index.js` associates the channel
flow to every new channel; existing channels are backfilled by
`backend/scripts/backfill-channel-flow.mjs`.

## 4. Layer 1: Channel Tags (IAM Condition Keys)

Amazon Chime SDK channels support resource tags. Tags are set at creation and can be used in IAM policy conditions to block actions on tagged resources.

### Tag Schema

When creating a channel:

```bash
aws chime create-channel \
  --app-instance-arn "$APP_INSTANCE_ARN" \
  --name "Q3 Planning" \
  --privacy "PRIVATE" \
  --mode "RESTRICTED" \
  --tags Key="classification",Value="premium" Key="conversationType",Value="team" \
  --chime-bearer "$BOT_ARN"
```

### IAM Policy Conditions: fail-closed ALLOW

> **Two properties of this enforcement design - see
> `agent-tier-common.tierChannelScopedAllow`:**
>
> 1. **Condition key is the GLOBAL `aws:ResourceTag/classification`, NOT
>    `chime:ResourceTag`.** Amazon Chime exposes **no service-specific condition
>    keys**, so `chime:ResourceTag/...` never exists in the request context and any
>    condition on it silently no-ops (a basic member could still send into a premium
>    channel). The global `aws:ResourceTag` IS populated for the tag-aware channel
>    actions.
> 2. **Channel-message actions authorize against TWO resources** - the **channel**
>    AND the caller's **bearer identity** (`.../user/<id>` or `.../bot/<id>`). The
>    `classification` tag only exists on the channel, so the boundary is the
>    *channel-resource* grant; the *bearer-resource* grant must be unconditioned
>    (Amazon Chime SDK restricts the bearer to the caller's own identity, so it widens nothing).

We use **ALLOW**, not Deny, because **allow fails CLOSED**: a tier identity is
granted the channel action ONLY when the channel's `classification` ∈ {its tier
and below}; an **untagged** or higher-tier channel matches no grant → implicit
deny. (A deny-on-higher fails OPEN on untagged/legacy channels - a real hole.)

```jsonc
// Per-tier role — TWO statements per the resource split:
// (1) channel resource, tag-gated  → the boundary
{ "Effect": "Allow",
  "Action": ["chime:SendChannelMessage","chime:ListChannelMessages","chime:GetChannelMessage",
             "chime:UpdateChannelMessage","chime:RedactChannelMessage","chime:DescribeChannel",
             "chime:UpdateChannel","chime:DeleteChannel","chime:UpdateChannelReadMarker",
             "chime:ListChannelMemberships"],
  "Resource": "arn:aws:chime:...:app-instance/<id>/channel/*",
  "Condition": { "StringEquals": { "aws:ResourceTag/classification": ["basic"] } } },   // standard→["basic","standard"], premium→all
// (2) bearer identity resource, UNCONDITIONED (no channel access; Amazon Chime SDK pins bearer to self)
{ "Effect": "Allow",
  "Action": [ /* same actions */ ],
  "Resource": ["arn:aws:chime:...:app-instance/<id>/user/*",
               "arn:aws:chime:...:app-instance/<id>/bot/*"] }
```

**Per-tier classification sets (allow):**

| Identity | Channel `classification` it may act on |
|----------|----------------------------------------|
| Basic (user role + assistant) | `{basic}` |
| Standard | `{basic, standard}` |
| Premium | `{basic, standard, premium}` |
| Admin (user role) | any (unconditioned - administration spans tiers) |

Per-member membership actions (`CreateChannelMembership` / `DeleteChannelMembership`
/ `DescribeChannelMembership`) authorize against the **AppInstanceUser** resource
(no `classification` tag), so they CANNOT be tag-gated and are granted unconditioned
 - they are governed by Amazon Chime SDK's moderator model + the **app-layer membership
admission gate** (below) + the **Layer 6 Kinesis audit**.

**Why this is powerful:** enforced by **IAM itself**, before any application logic.
A basic user's credentials physically cannot `SendChannelMessage` / `ListChannelMessages`
on a premium- or untagged channel - `AccessDeniedException`. The resulting access (deny matrix):
basic→basic SENT, basic(member)→premium DENIED,
basic(member)→untagged DENIED, premium→premium SENT.

Channels are tagged at creation (`create-conversation`, `lib/channel-creation`,
`proactive-briefing`); pre-existing channels are backfilled by
`scripts/backfill-channel-classification-tags.mjs` (fail-closed needs every channel
tagged).

### CDK Implementation

The boundary is defined once in `agent-tier-common.tierChannelScopedAllow(tier,
appInstanceArn, actions?)` and attached to the **credential-exchange rung roles**
(`grantPinnedExchangePermissions` in `cognito-auth-stack.ts`, bearer-pinned to the
caller's own `.../user/${aws:PrincipalTag/sub}`) and the **per-tier assistant roles**
(`*-tier-stack.ts`). It is not on the per-tier Cognito Identity-Pool user roles:
those are intentionally empty (`makeTierRole`), because the frontend reaches Amazon Chime SDK
only through the exchange (there is no Identity-Pool Amazon Chime SDK fallback). See
`docs/specs/identity-access/IDENTITY-AND-ACCESS-MODEL.md` §8 (row 2). `tierChannelScopedAllow` is the sole enforced boundary; the former
inert `iam-policies-stack.ts` per-tier managed policies have been removed.

## 4a. Access Matrix (actions × roles × conversation classification)

The authoritative at-a-glance. **Conversation classification** = the immutable
`classification` tag (= the conversation's tier; Private inherits the creator's
tier, Team is set at creation, Open = `basic`). Levels: **RW** = read + write,
**RO** = read-only, ** - ** = denied (`AccessDeniedException` at the IAM layer).

### Channel access by role × channel classification

| Principal (assumed role) | `basic` chan | `standard` chan | `premium` chan | untagged chan |
|---|:--:|:--:|:--:|:--:|
| **Basic** user | RW | - | - | - |
| **Standard** user | RW | RW | - | - |
| **Premium** user | RW | RW | RW | - |
| **Admin** user | RW | RW | RW | RW¹ |
| Basic assistant (processor) | RW | - | - | - |
| Standard assistant | RW | RW | - | - |
| Premium assistant | RW | RW | RW | - |
| HIDDEN observer / admin-console² | RO | RO | RO | RO |

¹ Admins are unconditioned (administration spans tiers), so they also reach untagged
channels - the only role that does. ² **Read-only** is Amazon Chime SDK-enforced for `HIDDEN`
members (spec §10) and for the app-instance-admin administration surface (archive-backed
viewing); they observe without a send capability.

### Per-action breakdown (what "RW" decomposes into, and how each is gated)

| Action | Authorized against | Tier-gated? | Class |
|---|---|:--:|---|
| `SendChannelMessage` | channel **+** bearer | channel: **yes** | write |
| `ListChannelMessages`, `GetChannelMessage` | channel **+** bearer | yes | read |
| `UpdateChannelMessage`, `RedactChannelMessage` | channel **+** bearer | yes | write (own/mod) |
| `DescribeChannel`, `ListChannelMemberships` | channel **+** bearer | yes | read |
| `UpdateChannel`, `DeleteChannel` | channel **+** bearer | yes | write (moderator) |
| `CreateChannelMembership`, `DeleteChannelMembership`, `DescribeChannelMembership` | **bearer/user** only | **no** (unconditioned) | gov. by app-layer admission gate + Amazon Chime SDK moderator model + Layer 6 audit |
| `CreateChannel` | n/a (no channel yet) | no | tier-gated at app-layer (`create-conversation` 403s over-tier) |
| `Connect`, `GetMessagingSessionEndpoint`, `ListChannels`, `ListChannelMembershipsForAppInstanceUser` | app / user | no | session-level, no channel exposure |

## 4b. Membership admission control (error on over-tier invite)

A user must be **refused at invite time** if their tier is below the conversation's
classification - *not* silently added and then locked out by Layer 1. Two gates:

- **Synchronous (app layer) - the user-facing error.** Every path that adds a
  *human* validates `memberTier ≥ channelClassification` and refuses:
  - `share-conversation/index.js` (the invite-by-email path): reads the recipient's
    authoritative Cognito-group tier, compares to the channel's immutable `classification` tag, and on
    a shortfall returns **403 `TIER_FORBIDDEN`** - *"This user cannot be added to
    this conversation; their access level does not meet the conversation's tier."*
  - `create-conversation` adds only the creator (already tier-authorized - over-tier
    creation 403s); `add-agent` / `channel-battle` add only the tier-matched
    assistant. So no app path adds an under-tier human.
- **Asynchronous (Layer 6 Kinesis audit) - the backstop for direct-SDK adds.** A
  membership created out-of-band (direct Amazon Chime SDK API by a moderator, a script, or
  compromised creds) bypasses the app gate. The Kinesis stream carries every
  `CREATE_CHANNEL_MEMBERSHIP` / `UPDATE_CHANNEL_MEMBERSHIP` event; the audit Lambda
  re-checks **(a) tier** (member's Cognito-group tier ≥ channel `classification`) and
  **(b) conversation-type correctness** (e.g. on an Open/announcement channel a
  non-tier member must be `HIDDEN`, not `DEFAULT`) and on a violation **auto-revokes**
  (`DeleteChannelMembership`) + alerts. See §9. Even before revocation, Layer 1 makes
  the wrongly-added member **inert** (no send/read on a higher-tier channel), so the
  audit closes the *visibility* gap, not a write-leak.

## 4c. Archived conversations (read-only via the `archived` tag)

Archiving a conversation makes it **read-only for everyone by IAM**, using the same tag-gated
mechanism as Layer 1 - the AWS-documented read-only-channel pattern (the blog referenced above,
Approach 2). On archive, the backend sets an immutable `archived` tag on the channel, and a **Deny**
on `chime:SendChannelMessage` + `chime:UpdateChannelMessage` conditioned on
`aws:ResourceTag/archived == "true"` is layered onto both the per-tier assistant send grant and the
user exchange creds (`agent-tier-common.archivedChannelReadOnlyDeny`). A Deny overrides the tag-gated
ALLOW, so once the tag is set neither a member nor the assistant can send or edit - the channel is
read-only by IAM, not by application logic. The app-instance-admin (admin-plane) bearer is
deliberately un-tag-gated and stays exempt, so it can post the "archived by ..." system message.
Membership is retained (members keep read-only access); the channel hard-expires on the
conversation-type TTL (90 days after last activity). Full design: [ADR-017](../../design/decisions/017-conversation-archive-mechanism.md)
and [SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP](../conversation-messaging/SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md).

## 5. Layer 2: Channel Metadata (Application-Level)

Channel metadata stores `classification` and `conversationType` as a JSON string. All Lambda handlers read this before membership operations.

### Metadata Schema

```json
{
  "classification": "premium",
  "conversationType": "private",
  "createdBy": "arn:...user/user-sub",
  "modelId": "anthropic.claude-opus-4-20250514"
}
```

### Enforcement in Lambda Handlers

Every function that modifies membership resolves the conversation's classification first. The authoritative source is the immutable `classification` tag (Layer 1); the metadata mirror below is the application-level view. The rank comparison is illustrative:

```typescript
// Ranks are resolved through the ProfileRegistry (backend/lib/config/profiles.ts),
// not a hardcoded map; the shipped default is basic:1, standard:2, premium:3.
const rankOf = (c: string) => profiles.rank(c);

async function validateMembership(channelArn: string, memberTier: string): Promise<void> {
  const channel = await messagingClient.send(
    new DescribeChannelCommand({ ChannelArn: channelArn, ChimeBearer: botArn })
  );
  const metadata = JSON.parse(channel.Channel?.Metadata || '{}');
  const classification = metadata.classification || 'basic';

  if (rankOf(memberTier) < rankOf(classification)) {
    throw new Error(
      `Membership denied: conversation requires ${classification} (user has ${memberTier})`
    );
  }
}
```

Applied in:
- `manage-conversation.ts` → `addMember()`
- `share-conversation/index.js` → before `CreateChannelMembership`
- `create-conversation/index.js` → validates creator's tier >= requested classification
- `router-agent-handler.ts` → resolves the served classification from the channel's immutable `classification` tag (never the mutable `modelTier` metadata) before routing

## 6. Layer 3: User Tier from Cognito Groups

A user's tier is their **Cognito group** membership, not a stored Amazon Chime SDK
AppInstanceUser tag. The groups `basic`, `standard`, `premium`, and `admins` are
defined in `cognito-auth-stack.ts`. `custom:tier` is mirrored into the matching
group by `post-confirmation.js` (at sign-up) and `user-management.ts` (on an admin
change); existing users are backfilled by `backend/scripts/backfill-tier-groups.mjs`.

### The group is the authoritative tier signal

The router, share, and create-conversation Lambdas call `AdminListGroupsForUser`
and use the **group**, not the `custom:tier` attribute, as the authoritative tier
signal. Deriving tier from group membership keeps a single source of truth that a
stray attribute edit cannot silently desync. This substitutes for the original
AppInstanceUser-metadata design; see `docs/specs/identity-access/IDENTITY-AND-ACCESS-MODEL.md` §8 (row 3).

### Channel classification caps the tier

`router-agent-handler.ts` picks `min(userTier, channelTier)`. A premium user in a
basic channel is downgraded to basic. A basic user who lands in a premium channel is
silently downgraded and logged as a security event. The channel's classification
always caps the tier the assistant runs at, so a higher-tier user cannot pull
higher-tier context into a lower-tier conversation.

## 7. Layer 4: Agent IAM (S3 Prefix Scoping)

Each tier's assistant role has S3 access scoped to its tier's prefix. The assistant literally cannot read higher-tier context files.

The live enforcement is `ContextS3Read` on each profile stack's processor role (the shared `assistant-async-processor.ts`, deployed once per profile stack), with the allowed prefixes generated from config (`classificationsAllowedFor`, which delegates to `ProfileRegistry.scopeAtOrBelow`). It scopes `s3:GetObject` and `s3:ListBucket` to that tier's prefixes: basic reads `context/basic/*`; standard reads `context/basic/*` and `context/standard/*`; premium reads all of `context/*`. Premium knowledge-base context is denied to basic and standard by the absence of the prefix grant, not by an explicit Deny. The per-tier policies below illustrate the shape.

### Per-Tier S3 Policies

```typescript
// Illustrative shape; the live policies are in assistant-profile-stack.ts,
// with prefixes generated from ProfileRegistry.scopeAtOrBelow (not hand-written per tier).

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

Updated to read from S3 using the conversation's classification:

```typescript
// Determine S3 prefix from channel classification
const channel = await describeChannel(channelArn);
const classification = JSON.parse(channel.Metadata || '{}').classification || 'basic';

// Read context files from the classification's S3 prefix
// IAM will block if agent's tier < classification (defense in depth)
const contextFiles = await listS3Objects(`context/${classification}/`);
```

## 8. Layer 5: Bedrock Guardrails (Tier-Specific)

A guardrail is in place on the assistants. Rather than one guardrail for all tiers, the model is per-tier guardrails that deny topic categories above the tier's classification. The per-tier topic-denial policy below is the tuning surface: each tier denies the categories above its classification.

### Guardrail Policies

| Tier | Denied Topics |
|------|--------------|
| Basic | Financial data, employee directory, roadmap details, customer accounts, competitive intel, board matters |
| Standard | Financial data, customer contract terms, board matters, competitive win rates |
| Premium | (no additional denials - full access) |

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

The membership audit is a dedicated consumer, `backend/lambda/src/membership-audit.ts`,
wired by `lib/constructs/membership-audit.ts` into both analytics stacks behind
`-c enableMembershipAudit`. It filters `CREATE_CHANNEL_MEMBERSHIP` and
`UPDATE_CHANNEL_MEMBERSHIP`, resolves the member's tier via `AdminListGroupsForUser`,
and on an over-tier member logs a `[MembershipAudit][SecurityEvent]`, alerts the admin
conversation (in-app message plus email through the notification bridge,
`lib/channel-notify.fanOutChannelNotification`), and auto-revokes the membership
(`DeleteChannelMembership`, admin bearer) when `-c membershipAuditEnforce=true`. It is
report-only by default. It skips bots, the admin service user, and federated (`fed_`)
members. Even in report-only mode, Layer 1 keeps a wrongly-added member inert, so this
consumer closes the residual visibility gap rather than a write leak.

### Monitored Events

| Event | What to check | Action on violation |
|-------|--------------|---------------------|
| `CREATE_CHANNEL_MEMBERSHIP` | Member tier >= channel classification | Auto-revoke membership + alert admin |
| `UPDATE_CHANNEL_MEMBERSHIP` | Member tier still valid after change | Auto-revoke if tier dropped below classification |
| `UPDATE_CHANNEL` | Classification tag/metadata unchanged | Revert metadata to original classification + alert admin |
| `CREATE_CHANNEL_MESSAGE` | Sender tier >= channel classification | Flag message for review (cannot delete - already persisted) |
| `CREATE_CHANNEL` | Creator tier >= requested classification | Flag channel for review |

### Membership Audit

```typescript
// In kinesis-archival.ts — add to the membership sync section
async function auditMembershipEvent(record: MessageRecord): Promise<void> {
  const { event_type, channel_arn, target_arn } = record;

  if (event_type === 'CREATE_CHANNEL_MEMBERSHIP' || event_type === 'UPDATE_CHANNEL_MEMBERSHIP') {
    const classification = await getChannelClassification(channel_arn);
    const memberTier = await getUserTier(target_arn);

    if (profiles.rank(memberTier) < profiles.rank(classification)) {
      console.error('SECURITY: Tier violation in membership event', {
        event_type, channel_arn, target_arn, memberTier, classification,
      });

      // Auto-revoke: remove the member immediately
      await messagingClient.send(new DeleteChannelMembershipCommand({
        ChannelArn: channel_arn,
        MemberArn: target_arn,
        ChimeBearer: botArn,
      }));

      // Alert: send to admin notification channel
      await sendAdminAlert(
        `Membership violation auto-reverted: ${memberTier} user removed ` +
        `from ${classification} conversation (${event_type})`
      );

      // Persist: record the violation in the audit table
      await recordSecurityEvent({
        type: 'membership_violation',
        channelArn: channel_arn,
        memberArn: target_arn,
        memberTier,
        classification,
        action: 'auto_revoked',
        timestamp: new Date().toISOString(),
      });
    }
  }
}
```

### Metadata Tampering Audit

```typescript
async function auditChannelUpdate(record: MessageRecord): Promise<void> {
  if (record.event_type !== 'UPDATE_CHANNEL') return;

  const currentMeta = record.metadata;
  const channelArn = record.channel_arn;

  // Get the original classification from channel tags (immutable at IAM level)
  const channelTags = await getChannelTags(channelArn);
  const tagClassification = channelTags?.classification;
  const metaClassification = currentMeta?.classification;

  // Detect metadata tampering: someone changed classification in metadata
  // but tags are the source of truth
  if (tagClassification && metaClassification && tagClassification !== metaClassification) {
    console.error('SECURITY: Classification metadata tampered', {
      channelArn,
      tagClassification,
      metaClassification,
    });

    // Revert metadata to match tags
    await messagingClient.send(new UpdateChannelCommand({
      ChannelArn: channelArn,
      Metadata: JSON.stringify({
        ...currentMeta,
        classification: tagClassification,
      }),
      ChimeBearer: botArn,
    }));

    await sendAdminAlert(
      `Classification tampering reverted on ${channelArn}: ` +
      `metadata said ${metaClassification}, tag says ${tagClassification}`
    );
  }
}
```

### Why This Matters

The Kinesis audit catches violations regardless of how they were introduced:
- **Backend system adds wrong member:** Reverted within seconds
- **Direct API call bypasses application:** IAM (Layer 1) blocks most cases, but if credentials are over-provisioned, Kinesis catches it
- **Metadata tampering:** Channel tags are the source of truth; metadata is reverted to match
- **Message sent by wrong tier:** Cannot be unsent (already persisted), but flagged for admin review
- **Infrastructure change breaks IAM:** Kinesis audit operates independently of IAM policies

## 9a. Layer 7: Mixed-trust visibility (external guests)

The first six layers isolate *tiers* of internal users. Layer 7 governs a different
shape: an **external guest** (a federated or routed human) sharing one channel with
**internal** members, for example AWS Support dialed into an incident triage room or a
routed support agent on a customer case. The guest must see only what is meant for
them, never the internal back-channel. This is the layer that applies when an
external-guest use case runs: a routed support agent, AWS Support, or a customer
alongside internal responders.

**The visibility model:**
- The external guest is admitted at a **capped classification** (`min(idpGroupCeiling, channel)`, `docs/design/SPEC-FEDERATED-PARTICIPANTS.md`) **and** scoped to that one channel (membership pin) - Layers 1/2/6 as today.
- **On top of that, a per-message visibility gate:** every message is either **targeted** (internal-only) or **broadcast** (guest-visible); the external guest is **broadcast-only**. Internal context (including `fetchContext`/dashboard data, D9) stays targeted.
- The assistant is the gate (it chooses targeted vs broadcast based on content sensitivity), riding **Amazon Chime SDK targeted messaging** (`Target=[…]`) - the *mechanism exists today*; the missing piece is the **policy + discipline**: a single wrong broadcast leaks internal context to the external party.

**Why a distinct layer:** the existing layers gate *which channels* a principal can touch and at *what tier* - they do **not** gate *within a channel* between a broadcast and a targeted message when trust levels are mixed. This is the new gate. The federated-guest admission model is in `docs/design/SPEC-FEDERATED-PARTICIPANTS.md`.

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

Bot is the only DEFAULT member (moderator). All users are HIDDEN members. Bot sends announcements; users read but cannot respond. Tag the channel with `readonly=true` and use IAM conditions to further restrict `ListChannelMemberships` and `DescribeChannel` on readonly-tagged channels.

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

**4. Cross-Tier Read-Only Access (opt-in policy)**

A Basic user cannot be a DEFAULT member of a Premium conversation (Layers 1-2 enforce this). But an admin could explicitly add them as HIDDEN for read-only observation of non-sensitive higher-tier conversations. This is an **opt-in policy decision**:
- Kinesis audit (Layer 6) logs HIDDEN cross-tier memberships separately
- Admin must explicitly approve
- HIDDEN member cannot send (Amazon Chime SDK enforces) - no write-side risk
- Read-side risk remains - use only for non-sensitive conversations

### Extended IAM Restrictions

Beyond Amazon Chime SDK's built-in HIDDEN enforcement, IAM policies can further restrict what users can do on tagged channels:

```json
{
  "Effect": "Deny",
  "Action": ["chime:ListChannelMemberships", "chime:DescribeChannel"],
  "Resource": "*",
  "Condition": {
    "StringEquals": { "chime:ResourceTag/readonly": "true" }
  }
}
```

This prevents HIDDEN members from discovering who else is in the channel - they can only read messages. **Amazon Chime SDK-enforced at the API level.**

## 11. Drift Detection

### Three Drift Types

| Detection | Trigger | Action | Layer |
|-----------|---------|--------|-------|
| **Topic drift** (existing) | Conversation moves away from stated purpose | Suggest new conversation | Application |
| **Tier drift** | User asks for info above classification | Agent can't access it (Layer 4 IAM blocks S3). Graceful refusal (Layer 5 instructions). | IAM + Agent |
| **Intent drift** | User requests action their tier doesn't support | Agent has no Action Group for it. Returns "not available at this tier." | Agent |

### Tier Drift - Multi-Layer Response

```
Premium user in Standard conversation: "What's our burn rate?"

Layer 4 (IAM):     Standard agent tries s3://context/premium/financial-data.json → AccessDenied
Layer 5 (Agent):   Agent instructions say "inform user, suggest Private conversation"
Layer 5 (Guard):   Standard guardrail denies "financial data" topic
Result:            "Financial metrics aren't available in this conversation.
                    Create a Private conversation for full access."
```

Three layers independently prevent the leak. Any one is sufficient.

## 11a. Control-Marker Injection Defense

The assistant embeds machine-readable control markers in a message's Content so clients can render UI deterministically: HTML-comment markers like `<!--ACTIVE_TASK:...-->`, `<!--battle:...-->`, `<!--battlestats:...-->`, `<!--suggestions:...-->`, `<!--corr:...-->`, and the inline `NAVIGATE_CHANNEL:<arn>|<label>` redirect. These markers drive real UI (a channel redirect, a battle scorecard, suggestion cards) and, for some deployments, assistant-triggered actions.

**Threat.** A message is user-authored text. A bad actor can type a control marker into their own message to try to spoof UI for other members (a fake scorecard, a redirect to a channel they choose) or to trigger an action the marker represents.

**Defense (three independent strips plus an output-only action rule):**

| Where | Mechanism | Effect on an injected marker |
|-------|-----------|------------------------------|
| Display (every client) | `frontend/src/utils/messageParser.ts` parses and strips known markers before render | Never shown as UI to another member |
| Backend reads | `lambda/src/lib/message-markers.ts` strips ALL `<!--...-->` comments on every non-UI read (analytics, the LLM relevance judge, the admin conversation browser) | Never scored, never leaked into a prompt or an admin view |
| Action path | Side-effect actions are keyed off assistant/model OUTPUT, not raw user input | A marker in a user message is never the trigger for an action |
| Input filter | The tier Bedrock guardrail runs the `PROMPT_ATTACK` filter on user input (`async-processor-core.ts`) | Prompt-injection attempts are filtered before the model sees them |

`message-markers.ts` is the single backend source of truth and deliberately strips the entire `<!--...-->` comment class rather than an allowlist, so a new marker (or an injected unknown one) is covered without a code change. Because the assistant never emits HTML comments as genuine content, stripping the whole class is safe.

**Why it holds.** An injected marker is stripped on display (no spoofed UI), stripped on every backend read (no leak, no mis-scored analytics), and is not on the action path (no triggered side effect). The defense does not depend on detecting "bad" markers; it strips the whole class everywhere the text is consumed.

## 12. Impact on Existing Architecture

| Component | Change |
|-----------|--------|
| `create-conversation/index.js` | Set `classification` in metadata AND channel tag |
| `manage-conversation.ts` | Read metadata, validate tier before `CreateChannelMembership` |
| `share-conversation/index.js` | Read metadata, validate recipient tier |
| `agent-tier-common.ts` / `*-tier-stack.ts` / `cognito-auth-stack.ts` | The enforced tag-gate is `tierChannelScopedAllow` (fail-closed **Allow** on the global `aws:ResourceTag/classification`) attached to the exchange rung roles + per-profile assistant roles. |
| `cognito-auth-stack.ts` | Define per-tier Cognito groups; mirror `custom:tier` into the matching group at post-confirmation |
| `assistant-profile-stack.ts` | Per-profile processor IAM roles with S3 prefix scoping (prefixes generated from config). Per-profile guardrails. |
| `channel-flow-processor.ts` | Enforce mention-required responses in multi-user conversations (@assistant / @all) |
| `kinesis-archival.ts` | Add membership audit on `CREATE_CHANNEL_MEMBERSHIP` events |
| Frontend `NewConversationModal` | Classification picker |
| Frontend `ShareConversationModal` | Filter recipient list by tier. Show classification badge. |
| Frontend conversation list | Show classification badge per conversation |

## 13. What This Does NOT Solve

- **Copy/paste:** A Premium user can always copy output from a Private conversation and paste it elsewhere. Information control is not DRM.
- **Admin dashboard:** Shows all conversations regardless of tier. By design - admins need visibility for evaluation.
- **Retroactive reclassification:** Classification cannot be changed. Create a new conversation instead.
- **Side channels:** A user could relay information verbally or via external tools. Organizational policy, not system enforcement.
