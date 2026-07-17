# SPEC: Conversation Archive and Member Removal (moderator)

**Status:** Implemented. Archive mechanism per [ADR-017](../../design/decisions/017-conversation-archive-mechanism.md) - Option 1 (mark archived + read-only via an immutable tag), composed with the conversation-type 90-day Amazon Chime SDK expiration TTL. This spec details the behavior and the identity/credential model.
**Scope:** Give a conversation's moderator two capabilities the platform currently lacks: (1) **archive** a conversation (mark it archived + read-only; it leaves members' active list and Amazon Chime SDK hard-expires it on the type TTL, while the Aurora/Athena archive persists for administrators), and (2) **remove a specific member** (never the primary assistant). Both are gated on Amazon Chime SDK `ChannelModerator` status; the channel creator is a moderator of their own channel.

## Why

Users that create conversations will need to be able to manage their list of conversations. This will allow them to focus on the conversations that are most relevant to them. `frontend/src/providers/ConversationProvider.chime.tsx` has a `deleteConversation` that only filters the item out of in-memory state and makes no Amazon Chime SDK/API call, so it reappears on reload. There is no leave, no archive, and no member-removal path available to a non-admin moderator. This spec adds those, consistent with the platform's identity model.

Design anchors (verified against the code):
- **Admins keep the archive for free.** A Amazon Chime SDK `AppInstanceAdmin` reads any channel without membership (see `docs/specs/identity-access/SPEC-ADMIN-IDENTITY.md`, "Two credential planes"), and the analytics archive (Kinesis -> Aurora/S3, `analytics-aurora/kinesis-archival.ts:365`) persists regardless of membership. So "archive" is purely the removal of the members' access; the channel and its data live on. Nothing new is needed to preserve the admin copy.
- **The creator is a moderator.** The primary create handler `create-conversation/index.js:373-375` runs `CreateChannelModerator` with the human's ARN (`ChannelModeratorArn: userArn`); the drift path (`lib/channel-creation.ts:98-100`) and the federated path (`federated-create-conversation.ts:221`) do the same. Moderator status is read live via `ListChannelModerators` (`chimeService.listModerators` `chimeService.ts:612`, `ChannelMembersPanel.tsx:58`), never from metadata (Tenet 6 - read each source of truth live).
- **The assistant is structural.** The per-tier assistant is an `app_instance_bot` (`.../bot/...` ARN) that is the channel's creator-bearer and a member. It must never be removable - a conversation without its assistant is broken.

## The capability reality (why this needs a backend path)

The credential-exchange model draws a hard line between the **chat plane** (the user's own `${sub}` identity, least-privilege) and the **admin plane** (`${sub}-admin`, moderation caps, per-channel and audited). See `docs/specs/identity-access/SPEC-ADMIN-IDENTITY.md` and `SPEC-CREDENTIAL-EXCHANGE.md`.

- **Self-leave is almost reachable but not vendable.** The chat-plane IAM ceiling already permits `chime:DeleteChannelMembership` pinned to the caller's own ARN (`cognito-auth-stack.ts:472`, `grantPinnedExchangePermissions`). But no `CAPABILITY_ACTIONS` entry vends it: the only capability containing `DeleteChannelMembership` is `manage-membership`, which is a `MODERATION_CAP` (admin-plane only, `credential-exchange.ts:79,93`). So a chat user cannot currently request a "leave" cred.
- **Removing another member is not reachable on the chat plane at all.** The chat-plane grant pins the membership resource to `${sub}` (`PINNED_USER_ARN`), so a chat cred can only ever delete the caller's own membership, never another member's. Removing someone else, or archiving-for-all, is fundamentally an admin-plane / app-instance-admin action.

This means a moderator who is not in the `admins` group has **no existing credential** that can remove another member or archive a shared conversation. The feature therefore needs a small, deliberate addition rather than just UI wiring.

## Credential mechanism (decided)

**Decided: a single backend membership Lambda (Cognito-JWT authenticated) handles ALL membership mutations - archive, remove-member, and self-leave.** The caller's token supplies their `sub`; the Lambda authorizes per operation and acts as the app-instance-admin bearer to perform the Amazon Chime SDK mutation. This keeps user creds least-privilege, puts authority server-side where it is checkable, gives one uniform audit path, and mirrors the existing server-side pattern (`federated-remove-member.ts`, `membership-audit.ts`, `user-management.ts` all mutate memberships as the admin bearer).

Authorization per operation:
- **Archive** and **remove-member**: the Lambda verifies the caller is a live `ChannelModerator` of the target channel (`ListChannelModerators`).
- **Self-leave**: no moderator check - the Lambda only allows the caller to remove **their own** membership (target `sub` must equal the token `sub`).

Rejected: expanding the chat-plane exchange caps to let a moderator name other members. That would require un-pinning the membership resource from `${sub}` in the chat-plane IAM, weakening the bearer-pin invariant the credential-exchange model rests on. Keeping mutations server-side avoids it.

**Host stack.** The Lambda is provisioned in the shared `AgentEchelonFoundations` stack - it already hosts the create-conversation / add-agent APIs and hosts no bot - and sits behind the same Cognito authorizer as the other authenticated management routes. Routes: `POST /conversations/archive`, `POST /conversations/remove-member`, `POST /conversations/leave`.

## Behavior

### Archive a conversation (moderator) - Option 1 per ADR-017
- **Whole-conversation, all members.** Archive is not a per-user hide - a moderator archives the conversation for everyone. Every member's active list loses it; the thread becomes read-only for all.
- UI action lives in the conversation header actions row (`ConversationInterface.tsx:335`, beside Share / Members), shown only when the current user is a moderator (same `listModerators` check the members panel uses).
- Labeled **"Archive"**, not "Delete". Opens an in-app confirmation modal (`ArchiveConversationModal`) that states plainly: archiving makes the conversation **read-only for everyone** and moves it out of the active list (still reachable read-only via the "Show archived" toggle); members keep read-only access until the conversation is **permanently deleted 90 days after its last activity**, and administrators retain an archived copy in the analytics store. Requires an explicit confirm (not a one-click).
- On confirm, the backend archive Lambda (acting as the app-instance-admin bearer, after verifying the caller is a live `ChannelModerator`) performs, in order:
  1. **Post a system message** to the channel - "Conversation archived by `<user>` on `<date>`" - as the admin bearer (not yet blocked). This flows through Kinesis -> Aurora and so appears in the conversation history in the admin console (the console reads Aurora, `admin-conversations-aurora.ts`). See "Audit" below.
  2. **Set an immutable `archived` tag** on the channel (tag-authoritative, like `classification`, so the state cannot be spoofed via mutable metadata).
  3. **Remove all moderators** (`DeleteChannelModerator` for every ChannelModerator). Members are NOT removed - they keep read access for the grace window; but with no moderator left, no one on the user side can un-archive, rename, or re-open it. The assistant bot is unaffected (it is a member/creator-bearer, never a ChannelModerator - `create-conversation/index.js:373-375` makes only the human a moderator).
- **Read-only enforcement is IAM, on the `archived` tag** - the same mechanism AWS documents for read-only Amazon Chime SDK channels (["Creating read-only chat channels for announcements"](https://aws.amazon.com/blogs/business-productivity/creating-read-only-chat-channels-for-announcements-with-amazon-chime-sdk-messaging/), Approach 2: tag the channel and deny send/update via `StringNotLike aws:ResourceTag/readonly`). We use the same pattern with the `archived` tag. The `SendChannelMessage` allow is tag-gated today (`tierChannelScopedAllow`, `StringEquals aws:ResourceTag/classification`, `agent-tier-common.ts:153`); archive adds a condition (`StringNotEquals`/`Null` on `aws:ResourceTag/archived`) that the tag is NOT set to `true`, applied to **both** `chime:SendChannelMessage` **and** `chime:UpdateChannelMessage` (block editing existing messages too, per the blog), on BOTH the per-tier assistant grant and the user exchange `SendChannelMessage`/`UpdateChannelMessage` cred (`cognito-auth-stack.ts` `EXCHANGE_MSG_ACTIONS`). So once the tag is set, neither a member nor the assistant can physically send or edit - the channel is read-only by IAM, not by application logic. The admin plane is deliberately un-tag-gated (`cognito-auth-stack.ts:~437`), so the backend/admin bearer remains exempt (which is why step 1's system message is posted before the tag matters and by the exempt bearer). **Blast-radius note:** an IAM Deny is evaluated globally for a principal, so the archived Deny is added ONLY to the user-exchange and per-tier assistant principals - never to the app-instance-admin/bearer role - or it would block step 1 and every admin action. A synth assertion (Phase 5) pins this. **Leave still works:** the Deny targets `chime:SendChannelMessage`/`chime:UpdateChannelMessage` only, not `chime:DeleteChannelMembership`, so a member can still **leave** an archived channel.
- **Active-list filtering:** the client filters `archived`-tagged channels out of the active conversation list; they remain enumerable so a "read-only Archived view" (roadmap) can show them during the grace window.
- **Eventual hard delete:** the conversation type's Amazon Chime SDK `ExpirationSettings` (`LAST_MESSAGE_TIMESTAMP`, 90 days), applied at channel creation across all three paths, hard-deletes the now-inactive channel after the retention window. The Aurora/Athena archive persists past expiry.
- **Grace period (the reason for Option 1, ADR-017):** because the channel survives read-only until its TTL elapses, members can still *read* the thread for the retention window before Amazon Chime SDK deletes it.

### Remove a member (moderator)
- The members panel already has a moderator-only remove affordance (`ChannelMembersPanel.tsx:172`) that today calls `chimeService.removeMember` (a chat-plane call that would be denied for removing others, per the capability reality above). Rewire it to the Option-A backend path.
- **Never the assistant:** the backend refuses any target whose ARN is an `app_instance_bot` (`.../bot/...`), and the UI hides the remove control for the assistant row. Two layers, so a crafted request still fails server-side.
- Confirmation before removal (a member losing access is not silently reversible).

### Leave a conversation (member)
- Any member may leave a conversation they are in - "Leave" is available to non-moderators, not just moderators. It removes only the caller's own membership; other members and the conversation are unaffected (this is NOT archive).
- Routed through the same backend membership Lambda (self-leave authorization: target `sub` == token `sub`), so it is audited on the same path. A member cannot leave-remove anyone else (the backend rejects a target other than self).
- The assistant is never a leave target (it is not the caller). UI action lives on the conversation (e.g. the header overflow or members panel), with a brief confirm.

### Audit (both)
`DELETE_CHANNEL_MEMBERSHIP` is currently **not** audited (`membership-audit.ts:59`, `AUDITED_EVENT_TYPES` covers only CREATE/UPDATE). Archive/removal is recorded **two ways**:
1. **In the conversation history** - the archive flow posts a system message ("Conversation archived by `<user>` on `<date>`") as the admin bearer, which flows Kinesis -> Aurora and shows in the admin console conversation timeline (`admin-conversations-aurora.ts`).
2. **In the admin audit trail** - the backend Lambda writes a durable row (actor, operation, target(s), channel, timestamp) so there is a queryable "who archived / removed / left" record independent of the conversation.

Both apply to archive. Remove-member and self-leave write the audit-trail row (2); a system message (1) for those is optional (proportional - a member leaving need not clutter the thread).

## Naming
UI: **"Archive"** for the conversation-level action and **"Remove"** for a single member. Backend/logs call it what it is (membership removal) for precision. Never the word "delete" in the user-facing archive flow, since the data is not deleted - access is.

## Out of scope / non-goals
- Channel deletion (`chime:DeleteChannel`) - never, it would destroy the admin archive too.
- Un-archive / restore for the user - archive is defined as permanent loss of the user's access; only an admin re-add could restore membership, which is an admin action, not part of this feature.
- Message-level deletion/redaction - separate (moderation) concern.

## Resolved decisions
1. **Archive scope:** whole-conversation - all members, read-only for everyone (not a per-user hide).
2. **Credential mechanism:** a single backend membership Lambda handles archive, remove-member, and self-leave (no chat-plane cap expansion).
3. **Self-leave:** in scope - any member may leave their own membership, via the backend Lambda.
4. **Read-only enforcement:** IAM condition on the `archived` tag (denies `SendChannelMessage` + `UpdateChannelMessage`), the AWS-documented read-only pattern; plus removal of all moderators to lock it.
5. **Audit:** both - a system message in the conversation history AND an admin-audit-trail row (archive); an audit-trail row for remove-member/self-leave.

## Acceptance criteria (definition of done)
Backend / IAM (unit + CDK synth):
- A non-moderator calling archive or remove-member is rejected (403); only a live `ChannelModerator` succeeds.
- Remove-member with a bot (`.../bot/...`) target is refused server-side, independent of the UI hide.
- Archive executes in order: system message posted -> `archived` tag set -> all moderators removed -> audit row written.
- Remove-member is idempotent (a `NotFoundException`/`ConflictException` from Amazon Chime SDK is swallowed, as in `federated-remove-member.ts`).
- Synth assertions: the `archived`-tag Deny is present on BOTH the user-exchange `SendChannelMessage`/`UpdateChannelMessage` and the per-tier assistant send grant; the Deny is ABSENT from the admin/bearer principal; the three routes sit behind the Cognito authorizer; API Gateway returns CORS headers on 4xx/5xx (gateway responses).

Behavior (live e2e, real data - not skipped):
- A moderator archives a conversation: it leaves the active list, a subsequent send is denied by IAM, and the "Conversation archived by ..." system message appears in the admin console timeline.
- A member can still **leave** an archived channel (Deny does not cover `DeleteChannelMembership`).
- A member self-leaves a live conversation: it leaves only their list; other members are unaffected; an audit row is written.
- A moderator removes a member (not the assistant); attempting to remove the assistant fails.

Retention: channels are created with a 90-day `LAST_MESSAGE_TIMESTAMP` `ExpirationSettings` (verify via `DescribeChannel`).

## Remaining (implementation-time) detail
- **Confirmation copy:** the permanent-loss / read-only warning lives in `conversation.archiveConfirm` (`frontend/src/locales/en.json`).
- **Audit sink:** reuse the membership-audit findings store vs. a small dedicated `conversation-actions` table (pick the lighter durable option).
