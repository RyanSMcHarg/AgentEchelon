# ADR-017: Conversation archive mechanism (mark vs. delete vs. de-member)

> **Status:** Accepted - **Option 1 (mark archived + read-only via tag)**, composed with the conversation type's Chime expiration TTL. Governs `docs/specs/conversation-messaging/SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md`. Records the choice of how a moderator "archives" a conversation so members lose the ability to write and the conversation leaves their active list, while the durable archive persists and the channel eventually hard-expires.

## Context

Users cannot currently remove a conversation (`ConversationProvider.chime.tsx` `deleteConversation` is in-memory only; it reappears on reload). We want a moderator (the creator is a `ChannelModerator` of their own channel) to **archive** a conversation: members permanently lose access, an archived copy persists for administrators.

**The archive is the Aurora/Athena data plane, not Chime.** This is the key fact that frames every option:
- The Kinesis archival pipeline (`analytics-aurora/kinesis-archival.ts`) writes each message's **content** (`:365-373,474`) plus analytics into the Aurora `messages` / `exchanges` tables (and, in Athena mode, S3). This is independent of Chime's own channel storage.
- The **admin dashboard reads conversations from Aurora**, not live Chime (`admin-conversations-aurora.ts` `FROM messages`).
- Therefore **every option below preserves the admin archive losslessly.** Deleting or emptying the Chime channel does not touch the Aurora/Athena record. The decision is purely about the *live Chime channel* lifecycle, user experience, control, and reversibility - not about whether the archive survives.

Access-model facts (from `SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md`): a moderator who is not an `admins`-group member has no chat-plane credential that can remove another member or the channel (chat-plane `DeleteChannelMembership` is pinned to the caller's own ARN; `DeleteChannel` and multi-member removal are admin-plane only). So whichever option is chosen, the mutation runs through a backend path that acts as the app-instance-admin bearer after verifying the caller's live `ChannelModerator` status. The assistant (`app_instance_bot`) is never removed.

## Options

### Option 1 - Mark archived (state flag on the live channel)
Tag the channel `archived` (an immutable classification-style **tag**, not mutable metadata, so the state is authoritative), hide archived channels from the user's list, and make them read-only: the send path refuses new messages and inbound messages to an archived channel are rejected/tagged archived.

- **Pros:** reversible (un-archive is a tag flip); full control; could surface an "Archived" section to users; nothing is destroyed.
- **Cons:** most moving parts - read-only enforcement needs a real gate (channel-flow deny or a router refusal), the flag must be tag-authoritative (mutable metadata would be spoofable; live tier decisions read the immutable classification tag, not metadata, for the same reason), and `ListChannelMembershipsForAppInstanceUser` still returns archived channels, so the client must filter them and **pagination gets harder as archived channels accumulate** (the user's noted downside). Chime channels persist indefinitely.

### Option 2 - Chime DeleteChannel (delete the live channel; keep the Aurora/Athena archive)
The backend deletes the Chime channel; the Aurora/Athena archive (with full content) remains and is what admins already read.

- **Pros:** cleanest end state - no list clutter, no pagination problem, no read-only enforcement to build; truly permanent, matching "forever lose all access, never editable again"; the admin view is unaffected (it reads Aurora).
- **Cons:** irreversible - the conversation can never be re-opened, continued, or restored for anyone; the live Chime message history is gone (the Aurora copy remains for admin review but is not a resumable conversation). Channel teardown must clean up any associated channel-flow / streaming bindings (cf. the 2026-07-13 teardown gotcha where flow/streaming custom resources blocked deletion). "Least control," as noted.

### Option 3 - Remove all memberships (empty the live channel)
The backend removes every human membership (never the assistant bot). The channel persists in Chime but is memberless, so it drops off every user's `ListChannelMembershipsForAppInstanceUser`.

- **Pros:** simple (one `DeleteChannelMembership` per member, the same primitive the backend already uses in `federated-remove-member` / `user-management`); the conversation disappears from everyone's list immediately; the archive is untouched; an admin can still find it via `ListChannels` and could restore access by re-adding a member if ever needed (a middle ground between 1 and 2).
- **Cons:** not truly deleted - memberless "orphan" channels accumulate in Chime and remain visible to an `AppInstanceAdmin` `ListChannels` sweep (clutter, though no per-idle-channel cost); "archived" is implicit (absence of members) rather than an explicit state, so there is no user-facing "archived" view and no clean re-surfacing story beyond an admin re-add.

## Composition with Chime channel expiration (scaffolding only today - must be wired)

Archive is not the only lifecycle lever. A conversation **type carries a retention TTL** that maps to Chime's native `ExpirationSettings`: `conversation-types.ts` defines a per-type `expiration` field (`ChannelExpiration = { days, criterion }`). **Status check (2026-07-16): the default is not applied at creation today.** The primary create handler (`create-conversation/index.js:217-246,325`) *can* set `ExpirationSettings`, but only from a **per-request override** (`expirationDays`/`expirationCriterion` in the request body); it never consults the conversation-type `expiration` default, and the frontend's `createConversation` sends no override. The drift path (`lib/channel-creation.ts`) and federated path (`federated-create-conversation.ts`) set no expiration at all. Net effect: channels are created with **no expiration** (never expire), and no type set an `expiration` value until this ADR. Wiring the type default into all three paths is a prerequisite of this ADR (see Decision - 90 days). Once wired, Chime **hard-deletes the channel automatically** once it passes the TTL - `CREATED_TIMESTAMP` = a fixed lifetime from creation, `LAST_MESSAGE_TIMESTAMP` = expire after N days of inactivity.

This composes cleanly with archive and changes the calculus:
- Archive is the **immediate** effect (gone from lists / access removed / read-only). Expiration is the **eventual** hard cleanup of the Chime channel. The Aurora/Athena archive is untouched by either - it persists past expiration.
- With `LAST_MESSAGE_TIMESTAMP`, archiving a conversation read-only (or de-membering it, so no new messages arrive) **freezes the last-message clock at archive time**, so the Chime channel auto-expires N days after its final real message. Archived conversations purge themselves from Chime on the type's retention schedule.
- This **dissolves Option 3's orphan-channel con**: memberless "orphan" channels are not permanent litter - they expire on the type TTL. It also gives Option 1 a natural grace-then-delete story (readable during the window, gone after) without a bespoke sweep.
- It reframes Option 2 as the "delete NOW, skip the grace window" choice rather than the only path to a clean end state.

## Decision

**Accepted: Option 1 - mark archived + read-only via tag, composed with the conversation type's Chime expiration TTL.**

On archive, the backend sets an immutable `archived` tag on the channel (tag-authoritative, like `classification`, so the state cannot be spoofed via mutable metadata), the channel drops out of the user's active list, and the conversation becomes read-only: new messages into an archived channel are refused. The Aurora/Athena archive is untouched. The channel then hard-expires on the conversation type's TTL (`LAST_MESSAGE_TIMESTAMP` freezes the clock at the last real message, so an archived, now-inactive conversation auto-deletes N days later).

**Why Option 1 over 2 and 3:** it preserves a **grace period**. Because the archived conversation still exists (read-only) until its expiration TTL elapses, a user who archives can still *read* that conversation for the retention window before Chime hard-deletes it - unlike Option 2 (deleted immediately) or Option 3 (dropped from the list with no straightforward user-facing read path). This matters where a user archives to declutter but may still want to reference the thread for a while. Expiration then provides the eventual hard cleanup, so archived channels do not accumulate forever - the read-only tag and the type TTL together give "hidden and frozen now, gone later" without a bespoke purge job.

The tradeoff accepted: Option 1 carries the most machinery (a read-only enforcement gate + tag-authoritative state + filtering archived channels out of the active list). That cost is justified by the grace-period behavior above.

Prerequisite (now specified): set `expiration` = `{ days: 90, criterion: LAST_MESSAGE_TIMESTAMP }` on **all** conversation types - a platform-wide 90-day retention after last activity (user directive 2026-07-16, going forward; no backfill of existing channels) - AND apply that type default as `ExpirationSettings` in all three creation paths (primary `create-conversation/index.js`, drift `lib/channel-creation.ts`, federated `federated-create-conversation.ts`), since today none apply the type default (see "Composition" above). Without this, archived channels linger read-only forever.

**Read-only is a documented AWS pattern, not novel.** The IAM-tag enforcement is exactly AWS's own recommendation for read-only Chime channels ([Creating read-only chat channels for announcements with Amazon Chime SDK messaging](https://aws.amazon.com/blogs/business-productivity/creating-read-only-chat-channels-for-announcements-with-amazon-chime-sdk-messaging/), Approach 2): tag the channel and add an IAM condition that denies `SendChannelMessage`/`UpdateChannelMessage` on tagged channels (`StringNotLike aws:ResourceTag/readonly`). We apply the identical mechanism with the `archived` tag, reusing the existing tag-gated send grant (`tierChannelScopedAllow`) so archive is an incremental condition on a proven pattern rather than new machinery. This de-risks the "most machinery" tradeoff noted above - the enforcement primitive is AWS-documented and already in use for the tier boundary.

**Locking, not just hiding:** on archive the backend also removes all `ChannelModerator`s (only the human is a moderator - `create-conversation/index.js:373-375` on the primary path, `lib/channel-creation.ts:98-100` on drift, `federated-create-conversation.ts:221` on federation; the assistant bot is never one), so no user-side actor can un-archive, rename, or re-open. Read-only (IAM tag) + no moderators (no management authority) makes archive one-way from the user side; only an admin (admin plane) could reverse it.

### Roadmap (follow-up, not part of the initial archive build)
Surface the **retention/expiration setting to the user for their current conversation** - so a user can see how long an (archived or active) conversation will be kept before Chime deletes it, and understands the grace window they have after archiving. The setting already exists per conversation (`ExpirationSettings`); this is a read-only disclosure in the UI, tracked as a roadmap item.

## Consequences

- A backend moderator-membership Lambda (per the spec) is required regardless of option - it verifies moderator status and acts as the admin bearer. Option 3 uses only `DeleteChannelMembership`; Option 2 adds `DeleteChannel` + flow/streaming teardown; Option 1 adds tag writes + a read-only gate.
- `DELETE_CHANNEL_MEMBERSHIP` is not currently audited (`membership-audit.ts:59`); a moderator archive/removal should be logged by the Lambda irrespective of option.
- The admin dashboard needs no change - it already reads Aurora.
- **Related (separate, not gated by this ADR): conversation list ordering.** Chime supplies `LastMessageTimestamp` on each `ChannelSummary` (already captured as `lastMessageAt`, `chimeService.ts:311`) but `ListChannelMembershipsForAppInstanceUser` does **not** return the list pre-sorted - the client must sort. The list should order by `lastMessageAt` (last activity) then `createdAt`, both descending. This is a small frontend sort in `listConversations` / the provider, orthogonal to the archive choice.
