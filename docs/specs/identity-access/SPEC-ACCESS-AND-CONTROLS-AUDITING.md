# Access & Controls Auditing - an append-only record of who could act, and what changed

**Status:** Implemented (audit capture and the membership-history view; forward extensions noted inline)


The **Auditing** pillar of the interaction layer (`docs/specs/conversation-messaging/SPEC-INTERACTION-LAYER.md` is the map). The conversation event stream is the audit source: the capture path (Amazon Chime SDK channel events → Kinesis → archive) feeds the admin-console membership-history view, and the retention, query, and access contract over that archive governs how that record is kept and read. Control-plane access changes are part of the same audit model.

**Related:** `docs/specs/conversation-messaging/SPEC-INTERACTION-LAYER.md` (the model) · `docs/specs/identity-access/SPEC-MODERATION.md` (the three surfaces, incl. the near-real-time Kinesis tap) · `docs/specs/identity-access/SPEC-CREDENTIAL-EXCHANGE.md` (the identities and bearer-pinned roles being audited) · `docs/guides/admin/ADMIN-GUIDE.md` (the membership-history view) · `backend/lambda/src/admin-conversations.ts` (`membershipHistory`) · `backend/lambda/src/analytics-aurora/kinesis-archival.ts` · `backend/lambda/src/client-events.ts` · `backend/lib/stacks/analytics-stack.ts`.

---

## 1. Why

Defense in depth needs a third leg. IAM blocks disallowed actions in real time (infrastructure) and the app enforces conversation-level policy (code), but neither answers the question an auditor actually asks: *what happened, who could act, and when did that change?* For a business to trust the platform with sensitive or regulated conversations, every access and membership change must leave a durable, append-only record that outlives the change itself - a member who left, a tier that was downgraded, a moderator who was granted. Because AgentEchelon is built on AWS, those events already flow (the Amazon Chime SDK channel stream lands on Kinesis); auditing turns that stream into a system of record rather than a transient feed.

## 2. Who benefits

- **Security & compliance** get an after-the-fact trail for incident review, access certification, and regulatory requests - without trusting that the live system was configured correctly at the time.
- **Operators & admins** get a concrete answer to "who joined, left, or was promoted in this conversation, when, and who invited them" - surfaced in the admin console's membership-history view.
- **The business** can show that access to sensitive conversations is *recorded and reviewable*, not merely enforced, which is often the difference between "can we use this" and "no."

## 3. Experiences enabled

- **Membership history per conversation** - who joined / left / was granted or revoked moderator, with timestamps and the inviter (shipped in the admin console).
- **Access review** - reconstruct who could act in a given conversation at a point in time.
- **Duration answers** - because joins/leaves and message create/redact events are all captured, the archive answers *how long* a user had access and *how long* a piece of content was visible, not just point-in-time facts.
- **Passive-access review** - read APIs are logged per user by default, so the audit covers who *viewed* a conversation, not only who posted; a member who lurked without sending is still on the record (attributable through the bearer-pin `sub`).
- **Incident forensics** - trace a specific action or membership change back through the append-only archive.
- **Access-anomaly feed** - a new **Audit** section in the admin console (alongside the existing six) shows when a user is in a conversation their tier no longer permits, or attempted an action they shouldn't, with optional automatic remediation when the proactive-action toggle is on (§4b). This Audit section is the home for the membership history, the violations feed, and the retention/legal-hold controls.
- **Control-plane audit** - tier changes, approvals, and user deletions are captured in CloudTrail, CloudWatch, and the client-events pipeline (§4a).

## 4. The model - capture, store, query

The conversation is the hub, and its event stream is the audit source. Three stages, all AWS-native:

- **Capture (mode-agnostic, shipped):** the Amazon Chime SDK AppInstance streaming configuration emits channel events - messages plus `CREATE_CHANNEL_MEMBERSHIP` / `DELETE_CHANNEL_MEMBERSHIP` / `CREATE_CHANNEL_MODERATOR` / `DELETE_CHANNEL_MODERATOR` - onto a Kinesis data stream that consumers tap in **near-real-time**: the archival writer and the moderation tap process each event within seconds of it landing (Kinesis's retention window is just how long a record stays re-readable for replay, not a delay before it's processed). The membership and moderator events are the access record; the messages are the content record.
- **Store (append-only):** Athena mode fans the stream through Firehose to S3 (the `conversations` dataset, queryable via Glue/Athena), on a RETAINed bucket with a configurable lifecycle. Aurora mode archives via `kinesis-archival.ts` into Postgres. Either way the store is *written, never mutated* - the audit property is that history accumulates and is not edited in place.
- **Query:** the admin console reads membership history straight from the archive. Amazon Chime SDK exposes **no** membership-history API, so the archive is the **system of record** for "who could act, and when" - not a convenience copy. Auditing queries the **Athena archive (the default mode)** and needs no SQL/vector features, so **Aurora is not required for auditing** - Aurora archives the same events, but adds nothing the audit queries need.

### 4a. Two audit planes

- **Data plane.** Conversation content plus membership and moderator changes, via the Amazon Chime SDK archive above. This plane backs the admin console.
- **Control plane.** Access-control changes that happen *outside* a channel (approve, change-tier, delete-user, role changes in `user-management.ts`) are written to CloudWatch logs by the handlers and captured at the API level by **AWS CloudTrail** (every such call is an IAM-authenticated AWS API call). Sign-in, sign-up, and session access events flow through the **client-events** pipeline (`client-events.ts` → Firehose). These control-plane changes are auditable across CloudWatch, CloudTrail, and client-events.

### 4b. Detection and proactive action (observe by default, act on opt-in)

Auditing is not only passive recording. The same event stream plus the classification/tier model let the platform **detect access that shouldn't be happening** and decide whether to act on it. Two signal families:

- **Wrong conversation** - a member whose tier no longer satisfies the channel's `classification` (downgraded after joining, or admitted at a mismatched tier). IAM already fail-closes their *sends* - they cannot message a higher-classification channel - but the *membership* anomaly persists silently until something detects it. At message time this mismatch is detected and logged: `router-agent-handler.ts` downgrades the request to `min(userTier, channelTier)` and emits a `SecurityEvent` (a CloudWatch warning), while IAM fail-closes the send regardless.
- **Disallowed actions** - attempts IAM denies (surfaced as `AccessDenied` in CloudTrail) or actions the conversation-level policy forbids for that role. Read APIs (`ListChannelMessages`, `GetChannelMessage`) are logged per user **by default**, extending detection to **passive access** - a member who *reads* a conversation they shouldn't, not only one who posts. The bearer pin makes those reads attributable: every call carries the caller's own `sub`, so a read log entry names the user. (Mechanism to confirm: this assumes Amazon Chime SDK Messaging read APIs emit **CloudTrail data events** - reads are *not* in the channel event stream. If they prove not loggable that way, the fallback is routing reads through a logged backend read-proxy, which trades off today's direct-to-Amazon Chime SDK read path.) The only reason to scope it down is **cost** - read logging rides CloudTrail data events, whose volume tracks read traffic - so a deployer may sample, scope it to higher classifications, or disable it, accepting reduced passive-access visibility in exchange.

**Detection runs on three triggers, so a silent member can't hide:** (1) the membership and send events as they stream; (2) a **semi-regular sweep** of every conversation's memberships against the current channel `classification` and each member's tier - the catch-all for members no live event would surface; and (3) **immediately on a role change or account-level access change** - a downgrade, suspension, or deletion re-evaluates that user's memberships at once and (toggle-on) remediates the ones they no longer qualify for. This is the control-plane → data-plane link: changing a user's tier in `user-management.ts` doesn't just affect future vends, it can sweep their existing memberships.

Each detection is **logged as a first-class anomaly event** and **surfaced in the admin dashboard** as a violations feed (who, which conversation, which signal, when) beside the membership history - so an operator sees access drift without grepping logs.

**Proactive action is a toggle, default OFF.** *Off:* observe, log, and surface only; a human reviews and acts from the dashboard. *On* (per deployment / conversation type, mirroring the drift live-suggestion flag): the platform takes the appropriate remediation automatically - remove the mismatched membership, downgrade, or alert - and **every automatic action is itself an audited event**, so even the auto-remediation is on the record. The toggle never weakens enforcement: IAM still fail-closes regardless of its setting; it only decides whether the *residual* anomaly (e.g., stale membership IAM can't retract on its own) is cleaned up automatically or by a human.

**Worked examples** (signal → how it's detected → action when the toggle is on):

- **Downgraded member** - a user moved premium → basic who is still a member of a premium-classified channel. Detected by a membership-vs-`classification` sweep (and at their next send, where IAM already fail-closes the message). Action: remove the membership + alert.
- **Mis-share above tier** - a basic user added to a standard channel by a faulty share. Detected at the `CREATE_CHANNEL_MEMBERSHIP` event (member tier < channel classification). Action: revoke the membership before any exchange happens.
- **Identity-spoof attempt** - an actor calling with a `ChimeBearer` that isn't its own. The bearer pin already denies it in IAM; auditing records the attempt as a high-severity event (no auto-action needed - it never succeeded).
- **Probing / repeated denials** - one principal accumulating `AccessDenied` across channels it isn't in. Detected from the CloudTrail `AccessDenied` signal. Action: alert, and rate-limit or disable on repeat.

Off the toggle, each of these is logged and surfaced for a human; on, the listed action runs automatically and is itself audited.

### 4c. Retention and legal hold - the toggles

Retention is set across two domains - live conversations and the archive - with more-specific policies overriding more-general ones.

**Live conversations (messages in the Amazon Chime SDK channels):**

1. **Global message retention** - Amazon Chime SDK `AppInstanceRetentionSettings`, app-instance-wide: trims messages older than the window while the channels persist. The one app-instance-level *message*-retention control.
2. **Per conversation type (default expiration)** - Amazon Chime SDK's per-channel TTL, `ExpirationSettings` (`ExpirationCriterion` = `CREATED_TIMESTAMP` or `LAST_MESSAGE_TIMESTAMP`, plus `ExpirationDays`), set from the conversation type's default (a new field on the conversation-type config, so it composes with that pillar). This is **native and per-channel** - set at channel creation, no app-enforced job. Note the semantics: it is **channel deletion** - how long the conversation itself remains stored in the SDK - which expires the **whole conversation** at the TTL, distinct from the message-only trim in (1).
3. **Per specific conversation (override)** - set or override `ExpirationSettings` on a single channel (at creation, or later via `PutChannelExpirationSettings`).

**Athena archive (the audit/analytics copy):**

4. **Global archive default** - an S3 lifecycle across the whole archive.
5. **Per message or per user - legal hold** - a separate, longer-lived policy on specific messages or a specific user. Placing it **copies any existing records within the policy period into the hold store** and **routes all new matching records there**, so held material lives outside the normal archive lifecycle (and on an Object-Lock store, cannot be rewritten or prematurely deleted).

**The per-user hold scope is broad by design.** A per-user hold covers **every conversation the user is or has been a member of within the retention period, plus all events related to those conversations** - not just the user's own messages. Holding a person preserves the full context they had access to, which is what an investigation or legal request actually needs (and what makes "how long did they have access, and to what" answerable after the fact).

**Precedence:** on the live side, a per-conversation policy (3) overrides the conversation-type default (2), which overrides global (1); on the archive side, a legal hold (5) always wins over the archive default (4).

**Implementation note (channel fields).** A review of the Amazon Chime SDK `CreateChannel` parameters confirms `ExpirationSettings` is the one field worth surfacing at creation for retention. `create-conversation` (`backend/lambda/create-conversation/index.js`) now **accepts it as a request parameter** - `expirationDays` (1 - 5475) + `expirationCriterion` (`CREATED_TIMESTAMP` | `LAST_MESSAGE_TIMESTAMP`), validated, both required together, omitted when absent (never-expires). That is **toggle 3 at the request level**; **toggle 2**, the conversation-type `expiration` default that fills it in automatically, composes with the conversation-type pillar. The other unused `CreateChannel` fields are intentionally omitted: `ClientRequestToken` (the deterministic `ChannelId` already gives idempotency), `MemberArns` / `ModeratorArns` (members and moderators are added in ordered post-create steps so the bot joins first and `WelcomeIntent` fires), and `ElasticChannelConfiguration` (AgentEchelon channels are small RESTRICTED / PRIVATE conversations, not elastic).

## 5. How it composes with the other pillars

- **← Identity & Access:** the identities and bearer-pinned roles the credential exchange vends are exactly what auditing records acting and joining. Because every actor is an AWS resource and every action an IAM-authenticated call, **AWS CloudTrail is the infrastructure-level complement** to the app-level archive - the deployer gets a second, independent audit substrate for free.
- **← Conversation Configuration:** the conversation (channel) is the audit unit; its `classification` tags the sensitivity of the records it produces, which drives how the audit store must be protected (§6).
- **← Connectors:** an externally-resolved participant admitted via a connector is audited like any other member - admission is backend, so the membership event is captured the same way.
- **↔ Moderation (`SPEC-MODERATION.md`):** auditing and moderation share this capture. Moderation's near-real-time Kinesis tap and the admin console's after-the-fact membership view are two reads of the same stream; this spec owns the *retention and integrity* of the record, moderation owns *acting on* it.

## 6. Security & integrity (what must stay true)

- **Append-only, not end-user-writable.** The archive is written only by the pipeline. No end-user or assistant role has write access to it; the credential-exchange rungs grant nothing on the audit store. The audit cannot be edited to hide a change.
- **Reading the audit is itself a gated capability.** Membership history is an admin-console surface behind the admin role, not an end-user one - the record of who could act is at least as sensitive as the conversation.
- **The audit inherits the highest classification it records.** The archive holds conversation content and member identities, so it must be protected at the top classification of any conversation it captures; its S3/IAM boundary is the deployment's, and query access is admin-gated so the audit never becomes an exfiltration path.
- **Retention, integrity & legal hold.** The retention toggles (live-conversation and archive, global through per-message) are defined in §4c. The integrity requirement here: the archive is append-only, and for regulated deployments the archive - the legal-hold store especially - sits on S3 Object Lock / WORM so even an admin cannot rewrite or prematurely delete history.
- **PII & redaction.** Because the store carries message content, redaction and retention policy live here; a redaction in the live conversation should have a defined effect on the archived record.
- **Detection observes; it never silently weakens enforcement.** IAM fail-closes disallowed actions whether or not proactive action is on (§4b). The toggle only governs *automatic remediation of residual anomalies*, and every automatic action is itself audited - there is no un-recorded enforcement, and turning the toggle off never opens a hole (it only shifts remediation to a human).