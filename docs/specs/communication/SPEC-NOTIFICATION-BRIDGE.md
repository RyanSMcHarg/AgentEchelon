# SPEC: Conversation ↔ transport notification bridge (email now; SMS + voice/PSTN next)

**Status:** Implemented (outbound email hand-off); inbound reply loop Planned.

**Problem and who it's for:** An assistant often needs to reach someone who is off the app - handing off a task to an assignee, say - on whatever channel actually reaches them (email, SMS, voice), and have their reply land back in the same conversation. This is for the end user reached on their preferred channel and the platform developer who would otherwise stitch and maintain a separate integration per transport, or bolt on a notifications product that lives in its own silo. It treats the conversation channel as the hub: a channel message fans out to members over the right transport (email today; SMS, voice/PSTN next), and - once the inbound loop lands - an HMAC-signed reply token routes their reply back into the same channel, so the on-channel assistant handles it transport-agnostically.

**Site section:** Communication layer.

> A **platform capability**: a notification is a MESSAGE in a conversation channel; the bridge delivers it to members over the right transport (email today; SMS, voice/PSTN, push next) and - once the inbound loop lands - routes their **reply back into the same channel**, so the on-channel assistant handles it with no per-transport code. First consumer: a task hand-off - the assistant posts the assignment as a channel message; the bridge reaches an offline assignee by email (and, when inbound ships, loops their reply back to the assistant).

## The pattern

The **conversation channel is the hub**; each transport is bridged to it, both directions, so the assistant is transport-agnostic.

- **Outbound** - a channel message carrying `metadata.notify = { email?, sms? }` triggers a fan-out: list the channel's members, resolve each member's contact (email/phone) from the identity provider (`AdminGetUser`), and send over the requested transport. `NotifyOptions { email, sms, … }` is the channel selector, so adding a transport later is the same fan-out.
- **Reply-token** - each outbound email carries an **HMAC-signed token** in its `Message-ID` (and a body footer): `mtg-{channelId}.usr-{subPrefix}.ts-{ts}.tok-{sig}@{domain}`, plus a DynamoDB **thread row** mapping the token → `{ channelArn, userSub, taskId? }`. This is what lets a reply find its way home.
- **Inbound** - SES inbound receipt → S3 → an email-processor Lambda: verify SES verdicts, parse the MIME, **HMAC-verify the token** (from `In-Reply-To` / `References` / body), look up the thread row to recover the `channelArn`, then **post the reply into that channel** (as the user via STS AssumeRole on a verified token, else as the bot "on behalf of"). It then flows through the channel like any message, so the assistant responds; the response is emailed back with a fresh token. Quoted/HTML cruft is stripped so only the new content lands in the channel.

## Transport reach: one conversation hub, many transports

Email is **one instance of a general convergence pattern** - the conversation channel is the hub, and *every* transport bridges onto it in both directions. The components below are what this work builds (and later extends); the assistant, channel flow, router, and task system stay unchanged per transport.

| Transport | Outbound (→ participant) | Inbound (→ channel, assistant responds) |
|---|---|---|
| **In-app chat** | bot posts a channel message | user types in the channel |
| **Email** (this spec) | `notify`-metadata fan-out → SES, with a reply-token | reply → SES receipt → email-processor → post into channel |
| **SMS** (next) | same fan-out, `NotifyOptions.sms` | inbound SMS webhook → post into channel |
| **Voice / PSTN** (next) | **outbound call**: dial out → a **meeting bound to the channel** | **inbound call**: match the caller to a channel + join a meeting; **voicemail** → transcription → summary posted into the channel |

Invariants that keep it extensible:
- **A meeting/call is bound to a channel** - a phone call is just another way to enter a conversation.
- **Speech becomes channel messages** (transcription → channel post), so the assistant reasons over voice exactly as it does over chat/email.
- **Adding a transport = an outbound sender + an inbound→channel adapter**; nothing assistant-specific changes. This spec builds the **email** adapter. So the seams must be transport-generic - `fanOutNotifications(channelArn, content, subject, NotifyOptions)`, a transport-agnostic reply→channel resolver, and member-contact lookup by transport - or the next transport can't reuse them.

## Why it's a platform capability (not an app feature)

Every assistant lives on a channel. The bridge means any of them reaches offline participants and receives their replies **without transport-specific code** - task hand-offs, proactive briefings, share notifications all become "post a message with `notify`." So it belongs in **platform core/infra**, not in a host app. (Host-specific bits - who to notify, the copy - stay data/persona.)

## What exists vs. needs

- **Exists (SES primitive):** `lib/notification.ts` `sendEmailNotifications` (the SES send primitive, used by proactive-briefing/archival-alarm as direct sends) + `NotificationStack` (SES sender identity).
- **Exists (outbound bridge - shipped):** the outbound fan-out is implemented in `lib/channel-notify.ts` (`parseNotifyDirective` reads `metadata.notify` on a channel message, `fanOutChannelNotification` lists the channel's members, resolves each member's contact via the IDP, and sends over SES) and is invoked from `channel-flow-processor.ts`. A channel message carrying `metadata.notify` reaches offline members by email.
- **Needs (the inbound half - Planned):**
 1. **Reply-token** scheme - an HMAC secret (Secrets Manager) + an email-sender path that stamps the
     token (Message-ID + footer) and writes the thread row.
 2. **Inbound** - an **EmailStack**: SES inbound receiving (verified domain, receipt rule set, S3
     bucket), an email-processor Lambda (parse → verify token → recover channel → post → invoke the tier
     processor → reply), the **threads** + **events** DynamoDB tables, and **STS AssumeRole** to post as
     the user. This inbound path is not built yet.

## Ops prerequisites (cannot be done from code alone - needs the operator)

Inbound email is gated on real AWS/DNS ops:
1. **A receiving domain verified in SES** with **MX records** pointing to SES inbound (`inbound-smtp.us-east-1.amazonaws.com`). `noreply@example.com` won't receive; pick e.g. `assistant@example.com` and add MX.
2. **SES production access** (out of sandbox) to email arbitrary recipients.
3. **Manual activation of the SES receipt rule set** (only one active per region; the stack creates but cannot activate it).
4. SPF/DKIM/DMARC on the domain (deliverability + the processor checks verdicts).

## Phasing

1. **Outbound notify (shipped).** The fan-out (`parseNotifyDirective` + `fanOutChannelNotification`) + IDP contact lookup runs in the channel-flow processor on `metadata.notify`, reusing `sendEmailNotifications`. A task hand-off: post the assignment as a channel message with `notify:{email:true}` targeted at the assignee → they get the email. **One-way** (no reply routing yet) - already delivers the hand-off.
2. **Reply-token + thread store.** Add the HMAC token (email-sender path) + the threads table so outbound emails are reply-addressable. Tokens are stamped even before the inbound consumer exists.
3. **Inbound bridge (gated on the ops prereqs).** The EmailStack: SES inbound → email-processor → verify token → post into channel → tier processor → reply. The heavy half; do it once domain/MX/production access are in place.
4. **More transports (same seams, no assistant changes).** SMS (via a 10DLC provider) + in-app/push as additional `NotifyOptions` channels; **voice/PSTN** - outbound calls (dial out → meeting on the channel) and inbound calls + voicemail (transcription → summary → channel). Same convergence pattern (see "Transport reach"), which is exactly why Phases 1 - 3 must keep the seams transport-generic.

## A task hand-off on top of this

Once Phase 1 (outbound) lands, the assignment notification is trivial and assistant-agnostic: on a shared task, when the assignee is set, the assistant posts a short channel message `"<assignee>, you're set to complete <X> by <dueBy>"` with `metadata.notify:{email:true}`; the bridge emails the assignee (resolved from the IDP). With Phase 3 (inbound) they reply by email and the assistant walks them through it on the channel. No SES code in the host app.

## Identity resolution across multiple IDPs

A bare `sub` is ambiguous once members span more than one identity provider, so a notify **target** is `{ sub, iss? }` - the OIDC **issuer** is the discriminator. For a Cognito issuer the user pool id is embedded in it (`https://cognito-idp.<region>.amazonaws.com/<poolId>`), so `iss` alone yields the pool for the `AdminGetUser` lookup (`poolIdFromIssuer`) - no separately stored pool reference, and `iss` is a routing key, not identity content, so it doesn't break "never persist email/name".

- **Trusted-pool allow-list.** The processor resolves an issuer to its pool only if that pool is in `NOTIFY_ALLOWED_POOL_IDS` (∪ the primary `USER_POOL_ID`); IAM grants `AdminGetUser` on exactly that set. A crafted/unknown `iss` resolves to nothing and the recipient is skipped - IAM is the hard boundary, the allow-list is defense in depth.
- **No issuer ⇒ primary pool.** Single-IDP deployments omit `iss` and resolve against the one primary pool - identical to before. The host stamps per-member `iss` only when a roster actually spans IDPs.
- **Non-Cognito IDPs** (Google/Okta/raw OIDC) can't be queried via `AdminGetUser` (`poolIdFromIssuer` returns null) - those need an **account-level contact fallback** (a stored, user-controlled contact), the same fallback path as "IDP lookup not possible." Not built yet; tracked as follow-up.

### Resolving a task assignee (no `iss` on the task)

A task's `assigneeUserSub` is the assignee's **`fed_` Amazon Chime SDK/AppInstanceUser id** (the `user-tasks` partition key), produced by `deriveFederatedSub(iss, sub)` - a one-way hash, so the raw `(sub, iss)` can't be recovered from it. We deliberately do **not** copy `iss` onto the task (that would be a second, drift-prone IDP pointer). Instead, to email an assignee, the notifier **reverse-matches** the `fed_` id against the channel roster `[{sub, iss}]`: the member whose `deriveFederatedSub(iss, sub)` equals `assigneeUserSub` yields the resolvable `(sub, iss)` for `notifyTargets`. The roster (carrying `iss` per member) is the single IDP pointer; the task only names *who*, the roster says *how to reach them*. (The assignment hand-off implements this match; for single-IDP today the assignee resolves against the primary pool regardless.)

### Readiness state (single-IDP today)

`iss` must travel the same path `sub` does - resource ACL → host roster builder → AE roster stamp → task notify. Done AE-side: the roster stamp keeps `iss` (`federated-create-conversation.ts`), and the notify fan-out + welcome consumer resolve by `(iss, sub)`. Still single-IDP-assuming until a second IDP is added: the host resource ACL stores no `iss` attribute and its roster builder omits `iss` (both additive when needed - Cognito subs are UUIDs so no key migration, just an `iss` attribute + thread-through).

## Security / privacy

- **Reply auth:** HMAC-verify the token AND match the sender's email to the `userSub`'s IDP email; unknown sender + no valid token → reject (rate-limited). Tokens expire (e.g. 30d).
- **Post-as-user** via STS AssumeRole only on a verified token; else post as bot "on behalf of".
- **Authz boundary** stays the resource ACL - a member removed from the resource drops off the fan-out (membership derives from the ACL-reconciled channel + IDP).
- Untrusted inbound email is sanitized (strip quotes/HTML) before it enters the channel.

## Open questions

1. **Receiving address/domain** - confirm the domain to MX-point at SES.
2. **SES production access** - already granted for this account, or needs a request?
3. **Trigger point** - the `metadata.notify` fan-out hooks the channel-flow processor; confirm.
4. **Scope of v1** - Phase 1 (outbound email) only, or commit to the full inbound bridge once ops land?

## Related

- `lib/notification.ts` (SES primitive), `notification-stack.ts`, `channel-flow-processor.ts` (the fan-out trigger point), `IDENTITY-PROVIDER-GUIDE.md` (email-by-sub).
