# Data inventory: where user input lands, how long it stays, and who can reach it

**Audience:** anyone deploying AgentEchelon who answers for the data it holds: a security or privacy reviewer, a data protection officer, an operator handling an access or erasure request, and an engineer adding a store.

**Verified:** 2026-11-15, against the code on the `meetings` branch. Every row cites the file that creates or reads the store, and line numbers are given where they are stable. The AWS compliance and Region sections cite AWS pages read on the same date.

**Related:** tenets [D7](TENETS.md) (the three stores), [D13](TENETS.md) (state is keyed by conversation or principal), [D15](TENETS.md) (an artifact's key names its owner) and [P4](TENETS.md); [SPEC-CONTEXT-SOURCES-AND-STORES.md](../specs/interaction/assistants/SPEC-CONTEXT-SOURCES-AND-STORES.md) for the guard on each path that reaches a model; [STACKS.md](STACKS.md) for which stack owns each resource.

---

## What this covers

**User input** is anything a person types, uploads, says or is: messages and their edits, targeted messages, attachments, meeting audio, transcripts and captions, meeting recordings, task answers, intake answers, profile fields, feedback, invitations, guest sessions, connector grants, and the records derived from all of these (analytics, archive facts, the Aurora projection and its embeddings, logs, generated pages, email replies, the person export, and what is sent to a model provider).

Each table below answers six questions for one store family:

- **Where:** the service, resource and key layout, and the file that creates it.
- **Used by:** the component that reads it and why.
- **Retention:** the TTL attribute, lifecycle rule, channel setting or log retention the code sets, or **none set**.
- **Access:** the principals that read or write it, the IAM condition that bounds them, and the handler check behind that.
- **Export:** whether the person export (`POST /users/export`) carries it.
- **Erasure:** what offboarding (`POST /users/delete`, `backend/lambda/src/lib/offboarding.ts`) does to it.

A person is their AppInstanceUser, and every person-keyed store uses its bare id (`personId`) or full ARN. The export and the erasure walk one inventory of stores (`OFFBOARDED_STORES` and `OFFBOARDING_KEPT`, `backend/lambda/src/lib/offboarding.ts:128-150`), and the export's readers are typed by that list (`EXPORT_READERS`, `backend/lambda/src/lib/person-export.ts:125`), so a store erasure gains without an export reader fails the build. Both routes are admin capabilities (`delete-users` and `export-users`, `backend/lib/config/admin-capabilities.ts:680-696`); there is no self-service route a person calls for their own export or deletion.

Removal policy, where a table says nothing else: RETAIN in production and DESTROY otherwise (`backend/lib/config/environment.ts:40-42`).

---

## 1. Amazon Chime SDK Messaging: the live conversation

The authority for current conversation state (D7): content, membership, name and the channel's `classification` tag.

| Data | Where | Used by | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| Messages, edits, redactions, deletions | Amazon Chime SDK channel in the app instance (`backend/lib/stacks/messaging-stack.ts`); the client sends with `SendChannelMessage` | Chat clients over WebSocket; the processor loads recent history for each model turn (`backend/lambda/src/lib/async-processor-core.ts`) | App-instance `ChannelRetentionSettings.RetentionDays` = 90 (`MESSAGE_RETENTION_DAYS`, `backend/lib/config/conversation-types.ts:121`; applied in `backend/lambda/src/set-app-instance-retention.ts:100`). The channel itself expires after its last message by conversation type: `general`, `ops-team`, `customer-engagement` and `meeting` 270 days, `ops` 30 days, `guest-visitor` 1 day (`backend/lib/config/conversation-types.ts:136, 548-735`), applied at create (`backend/lambda/src/lib/channel-creation.ts:1581-1603`) | Person session: bearer pinned to `${appInstanceArn}/user/${aws:PrincipalTag/person}` (`backend/lib/constructs/exchange-role.ts:104`), channel actions only where `aws:ResourceTag/classification` is one the role's classification allows (`backend/lib/stacks/agent-classification-common.ts:290-301`), writes denied on `archived=true` (`:1309-1318`). A person holds no edit, redact or message-delete grant (`exchange-role.ts:85-95`); moderation is the admin plane's (`backend/lambda/src/lib/vend.ts:56-78`). The service enforces membership | Membership list only; message content is **not in the export** except a visitor's messages carried into an upgraded conversation (`person-export.ts:131-157`) | Memberships removed (`offboarding.ts:426-451`). Messages the person sent stay in each conversation until the retention or expiry above: **not erasable per person** except in an upgraded-from visitor conversation (`offboarding.ts:396-424`) |
| Targeted messages (`Target`) and mentions | Same channel; `Target` set by the chat client (`frontend/packages/chat/src/services/chimeService.ts`) and by assistants (`backend/lambda/src/router-agent-handler.ts`) | Delivery to the named member only | As messages | As messages; the service delivers a targeted message only to its target | As messages | As messages |
| Channel Metadata | Channel `Metadata` written at create (`channel-creation.ts:1623-1643`): model id, name and tier plus routing extras | Routing hints | Life of the channel | Member-readable and member-writable by design, so it carries routing bits only and never private grounding or trusted state | Not exported | Not touched |
| Person's AppInstanceUser (name) | App instance user, minted only by the credential exchange | Display name, the identity every store keys on | Life of the person | The person may describe and update their own user (`exchange-role.ts:160-164`) | Yes (`person-export.ts:272-276`) | Deleted (`offboarding.ts`, step 6) |
| Message stream | Kinesis `chime-messaging-<prefix>`, 2 shards, AWS-managed encryption (`messaging-stack.ts:178-193`); streams `Channel` and `ChannelMessage` | Firehose archive, Aurora archival, membership audit, post-processing, email bridge | 24 hours (`messaging-stack.ts:181`) | Consumers' roles | n/a | Expires in 24 hours |

**Conversation archive and deletion.** Archiving a conversation tags it `archived=true`, removes its moderators and writes an audit row; it deletes no message (`backend/lambda/src/conversation-management.ts:232-317`). `DeleteChannel` is called by the admin console's delete conversation, by the retirement of a visitor conversation after an upgrade (`channel-creation.ts:845-856`) and for the admin notification channel. A deleted channel's history remains in the archive (section 2).

---

## 2. The conversation archive: S3, Amazon Data Firehose and Amazon Athena

The system of record (D7): append-only, survives channel deletion, and keeps what a message said before it was edited or redacted.

| Data | Where | Used by | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| Every `Channel` and `ChannelMessage` event, raw, including edits, redactions and `Target` | `<prefix>-conversation-archive-<account>-<region>`, key `conversations/user_type=<classification>/year=/month=/day=/`, gzip, SSE-KMS with a rotating customer key (`backend/lib/constructs/conversation-archive.ts:53-111`; Athena mode `backend/lib/stacks/archive-stack.ts:116-203`). Glue table `conversations`, one `line` column | Admin analytics and conversation review (Athena mode), the evaluation runner, the meeting figures | **No expiration on `conversations/`**: moves to Infrequent Access at 30 days and stays (`conversation-archive.ts:59-73`). `errors/` 90 days, `athena-results/` 7 days. No versioning, no Object Lock | Firehose role writes. Admin readers get `s3:GetObject` and `ListBucket` on the whole bucket and `PutObject` on `athena-results/*` only (`backend/lib/stacks/admin-services-stack.ts:1093-1143`); the admin backend gates queries on the caller's classifications. No classification condition on the bucket itself | **Not in the export** (`notBuilt`, `person-export.ts:293-295`) | **Kept** (`OFFBOARDING_KEPT`). **Not erasable**: no code deletes from it, and the key layout has no person segment, so a person's events cannot be found without scanning |
| Platform facts (`AE_TASK_SETTLED`, `AE_RUN_ENDED`) | Put on the message stream, archived with it (`backend/lambda/src/lib/archive-facts.ts`) | Task and workflow analytics | As above | As above | No | Kept; they carry a `personId` |
| Offboarding and export records | `appendServerEvent` (`backend/lambda/src/lib/event-archive.ts`) | Audit of who exported or deleted whom; counts per store, never content | As above | As above | No | Kept |
| Client events (Athena mode) | `client_events/event_type=<t>/y/m/d/` from a second Firehose (`archive-stack.ts:518-551`); columns include `person_id`, `session_id`, `properties` | Frontend observability | 90 days; `event_type=unknown` 7 days (`archive-stack.ts:139-153`) | Archive readers | No | Kept until expiry |
| Delivered documents | `delivered-documents/<classification>/<conversationId>/<sha256>` (`backend/lambda/src/lib/delivered-document.ts`); in Aurora mode a separate `<prefix>-aurora-archive-...` bucket (`backend/lib/stacks/archive-stack-aurora.ts:546-566`) | Record of what an assistant delivered | 90 days (`archive-stack.ts:142`; `archive-stack-aurora.ts:566`) | Evaluation runner and archival roles | No | Kept until expiry |
| Meeting events | `meeting_events/year=/month=/day=/` from a Firehose fed by EventBridge and `POST /meetings/events` (`backend/lib/stacks/meetings-stack.ts:292-321`); columns include `person_key`, `attendee_id` (`backend/lambda/src/lib/meeting-event-shape.ts`) | Meeting figures | **No expiration** in the archive bucket | Archive readers | No | Kept in S3; the Aurora copy is erased (section 3) |

---

## 3. The Aurora projection (Aurora mode)

A fast, lossy, rebuildable query surface (D7), projected from the message stream by `backend/lambda/src/analytics-aurora/kinesis-archival.ts`. The cluster is Aurora PostgreSQL Serverless v2, encrypted with a customer-managed key, backup retention 7 days, deletion protection in production (`archive-stack-aurora.ts:420-453`). Schema files are under `backend/lambda/src/analytics-aurora/schema/`.

| Data | Table | Used by | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| Message text, every edited version, sender, target, tool-call arguments and results in `metadata` | `messages` (`001-initial.sql`, `070-every-version-of-a-message.sql`); redactions and deletions are separate `-RED` and `-DEL` rows applied at read, so the original text stays | Admin analytics, summaries (`backend/lambda/src/analytics-aurora/summary-updater.ts`), evaluation, tool judging | **None set**; the turn audit table's own comment states that messages, exchanges and client events have no retention (`019-turn-audit.sql`) | Lambdas connect with IAM authentication; `rds-db:connect` covers every database user on the cluster (`archive-stack-aurora.ts:745`). **No row-level security** on this table (`backend/lambda/src/analytics-aurora/classification-boundary-sql.ts:90-100`) | **Not in the export** (`person-export.ts:212-215`) | **Kept**, with `person_id` (`backend/lambda/src/analytics-aurora/person-erasure.ts:41`) |
| Exchanges (request and reply pairing) | `exchanges` | Turn analytics | None set | As above | No | Kept |
| Conversation summaries | `conversation_summaries` (summary, topics, key points) | Summary injection, drift anchor | None set | Caller-scoped; no classification column (SPEC-CONTEXT-SOURCES-AND-STORES FR19) | No | Kept |
| Cross-conversation context | `cross_conversation_context` (`person_id`, summary, topic) | Briefing a person on their other conversations | None set | Forced row-level security, writes only as the writer role | No | **Erased** (`person-erasure.ts:32`) |
| Channel membership projection | `channel_membership` | Admin analytics; never a live decision | None set | As `messages` | No | **Erased** |
| Pending conversation offers | `conversation_creation_tasks` | Offer flow | `expires_at` 30 minutes (`007-conversation-creation-tasks.sql`), **not enforced by a purge** | As `messages` | No | **Erased** |
| Meeting events | `meeting_events` (`person_key`, `attendee_id`, `detail`) | Meeting figures | `expires_at` 270 days (`105-a-meetings-events-expire-with-its-conversation.sql`), purged in batches on each ingest (`backend/lambda/src/analytics-aurora/meeting-events-ingest.ts:69`) | Forced row-level security | No | **Erased** by `person_key` |
| Client events | `client_events` (`person_id`, `event_data`) from `backend/lambda/src/analytics-aurora/client-events-ingest.ts`; client-supplied `properties` are stored as sent (`backend/lambda/src/client-events.ts:214-227`) | Frontend observability | **None set** | As `messages` | No | **Kept** (it holds the offboarding and export records) |
| Turn audit, evaluation results, classifier replay labels | `turn_events`, `evaluation_results`, `classifier_replay_labels` | Quality and evaluation | `expires_at` 90 days, **not enforced**: no code deletes on it (`019-turn-audit.sql`) | As `messages` | No | Kept |
| Moderation, review flags, golden set, cleaned rows | `moderation_actions`, `flagged_review`, `human_flag`, `golden_set_entries`, `clean_conversation_rows` (actor ids, notes, request and reference text) | Admin review and evaluation | None set | As `messages`; golden tables have forced row-level security | No | Kept |
| Drift decisions | `drift_events` (`person_id`, originating message id; no message body) | Drift review | None set | As `messages` | No | Kept |
| Document chunks and vectors | `embeddings` (`002-pgvector.sql`), written by `backend/lambda/src/analytics-aurora/document-ingestion.ts` from the company bucket's `rag/` | Retrieval (section 5.1 of SPEC-CONTEXT-SOURCES-AND-STORES) | **None set**, by decision ([ADR-008](../design/decisions/008-embedding-cost-and-ttl-policy.md)) | Per-classification reader roles under forced row-level security (ADR-028) | n/a (company content, not a person's) | n/a |
| Summary and topic vectors | `summary_embeddings` (`005-summary-embeddings.sql`), `conversation_topic_embeddings` | Drift and related-conversation lookup | **None set** | Reader roles under forced row-level security | No | Kept |

**Removal of the projection.** Because the archive is kept, a rebuild of the projection restores every kept row; the erased rows are the four listed in `PERSON_OWN` (`person-erasure.ts:29-34`).

---

## 4. The attachments bucket: uploads, generated output, dashboards, transcripts and recordings

One bucket created in `backend/lib/stacks/conversations-stack.ts:547-591`: SSE-S3, versioned, noncurrent versions expire after 30 days, RETAIN. Each key family has its own lifecycle rule (D15).

| Data | Key family | Used by | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| A member's uploads | `attachments/<conversationId>/<personId>/<ts>-<fileName>`, key built by the presigner (`backend/lambda/presigned-url/index.js:179`), 10 MiB cap | Chat clients, the processor (an attachment the sender owns, `backend/lambda/src/lib/attachment-bytes.ts:24-34`) | 90 days (`conversations-stack.ts:562`) | Presigner `PutObject` and `GetObject` on `attachments/*` (`conversations-stack.ts:657-671`), URLs valid 300 seconds; the person-segment rule (third segment equals the caller) and conversation membership are **handler checks** in `backend/lambda/presigned-url/index.js:238-265`, not an IAM condition. The classification acting role holds Get and Put on all of `attachments/*` (`agent-classification-common.ts:874-897`). An admin opens one conversation's uploads through an audited credential vend scoped to `attachments/<channelId>/*` (`backend/lambda/src/admin-credential-exchange.ts:152-160`) | Listed by key and size, not copied (`person-export.ts:231-250`) | **Erased**, every version (`offboarding.ts:650-683`) |
| Assistant deliverables | `generated-docs/<channelId>/...` | Download, archival copy | 90 days (`:563`) | Acting role Put; presigner Get; admin team `attachment-read` vend | No | **Not erased** (not the person's key family) |
| Generated images | `battle-images/` | Battle and image turns | 90 days (`:564`) | Acting role Put; presigner Get | No | Not erased |
| Dashboard pages built from a conversation | `dashboards/<classification>/<conversationId>/snapshot.json` and `page.html` (`backend/lambda/src/lib/dashboard-keys.ts:17-35`), written by the assistant's dashboard tool from telemetry (`backend/lambda/src/lib/dashboard-tool.ts`) | Members, through a signed CloudFront URL issued after a membership check, valid 300 seconds (`backend/lambda/src/dashboard-link.ts`; `backend/lib/constructs/dashboard-distribution.ts:28-104`) | 30 days, superseded versions 1 day (`:567`) | Only publisher roles write; members read their own classification's dashboards (`exchange-role.ts:156`) | No | Not erased |
| Meeting transcript segments | `transcripts/<classification>/<conversationId>/<meetingId>/segments/<startMs>-<personId>-<resultId>.json` (`backend/lambda/src/lib/meeting-transcript.ts:40-54`), posted by each speaker's own client and checked for attendee ownership (`backend/lambda/src/meeting-api.ts:922-959`) | Building the meeting transcript | 270 days when `meetings` is declared (`DeleteOldTranscripts`, `:576`); segments are not deleted after the transcript is written | Meeting API writes segments; run entry reads and lists `transcripts/*` (`meetings-stack.ts:141-151`) | **Not in the export** | **Not erased**, although the key carries the person id |
| Meeting transcript | `transcripts/<classification>/<conversationId>/<meetingId>.md`, with speaker names, written at meeting end only when the meeting was transcribed (`backend/lambda/src/lib/meeting-transcription.ts:320-332`) | Meeting summary turn, hosts, admins | 270 days | Presigner signs it for a host who is a member at the matching classification (`backend/lambda/presigned-url/index.js:271-283`); the acting role reads only its own classification's family (`backend/lib/stacks/assistant-profile-stack.ts:1127-1136`); admin reads `transcripts/*/*.md` with an access-log record (`admin-services-stack.ts:1187-1191`) | No | Not erased |
| Meeting recording | `recordings/<classification>/<conversationId>/<meetingId>/<partId>/capture/...` and `.../media/composited-video/<id>.mp4` (`backend/lambda/src/lib/meeting-recording.ts:14-15`), only when `meetingMediaRecording` is set (`meetings-stack.ts:160`) | Hosts | 270 days (`DeleteOldRecordings`, `:577`); capture chunks deleted once the recording is written (`backend/lambda/src/lib/meeting-media-capture.ts:258-275`) | Written by the Amazon Chime SDK media pipelines service principal, conditioned on `aws:SourceAccount` and `aws:SourceArn` (`backend/lib/constructs/meeting-recordings.ts:22-43`); presigner signs the composited video for a host | No | Not erased |
| Live captions | Not stored: the client keeps the newest three lines in memory (`frontend/packages/chat/src/services/meetingTranscription.ts`), and captions-only mode writes nothing (`meeting-api.ts:932-937`) | The meeting window | n/a | n/a | n/a | n/a |
| Meeting audio and video | Amazon Chime SDK Meetings media in the media Region (`MEDIA_REGION`, else the deploy Region, `meeting-api.ts:107`); transcription by Amazon Transcribe through `StartMeetingTranscription`, en-US (`meeting-transcript.ts:71-77`) | Live meeting | Not stored by the platform unless recorded (above) | Attendee join tokens | n/a | n/a |

---

## 5. Amazon DynamoDB: per-person and per-conversation state

| Data | Table and key | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|
| Profile, onboarding answers, preferences | `UserProfile`, PK `personId` (`conversations-stack.ts:296`; `backend/lambda/src/lib/user-profile-client.ts`). PITR on | **None set** on profile items | Router read and write (`assistant-profile-stack.ts:1632-1648`); the language preference route is attribute-limited and denied keys matching `*#*` (`conversations-stack.ts:1720-1741`). Replaceable by the implementer's own store through `USER_PROFILE_SERVICE_ARN` | Yes | **Erased** |
| Contact copies (email, name from a claims issuer) | `UserProfile`, key `<personId>#contact#<issuer>`, KMS-encrypted values (`backend/lambda/src/lib/claims-directory.ts:38-94`) | TTL `expiresAt`, 90 days (`CONTACT_COPY_TTL_DAYS`, `claims-directory.ts:35`) | Writers and readers bounded by `dynamodb:LeadingKeys` `*#contact#*` (`backend/lib/constructs/contact-copy.ts:37-77`) | Yes | **Erased** |
| Email preferences | `UserProfile`, key `<personId>#notices` (`backend/lambda/src/lib/notice-preferences.ts`) | None set | LeadingKeys `*#notices` (`backend/lib/constructs/directory-access.ts:197`) | Yes | **Erased** |
| Private conversation grounding: participant profile, member identity lookup `{sub, iss, role}`, onboarding intake answers, language, active and last meeting (hosts, attendee keys, removed people) | `ChannelContext`, PK `channelArn` (`conversations-stack.ts:328-335`; fields in `backend/lambda/src/lib/channel-context-client.ts:50-294`). PITR on | **None set**; the stack states that nothing deletes a row (`conversations-stack.ts:316-320`) | Named Lambdas with `GetItem` and `UpdateItem` only, no user principal (SPEC-CONTEXT-SOURCES-AND-STORES §3.1); offboarding's update is attribute-limited (`conversations-stack.ts:758-767`) | The person's identity entries and intake only | **Partly erased**: the person's `memberIdentities` entries and their intake (`offboarding.ts:566-611`). `userName`, `participantProfile` and meeting person ids **are not erased** |
| Task answers and cards | `AgentTasks`, PK `taskId` SK `channelArn`; form answers in `details` (`backend/lambda/src/task-service.ts:808`). PITR on | TTL `ttl`: 24 hours by default (`backend/lambda/src/lib/task-tracking.ts:763`), up to 45 days for workflow tasks (`task-service.ts:736-738`) | Task service role, no condition (`assistant-profile-stack.ts:2759-2771`) | Yes (filter on user, owner, assignee) | **Erased** |
| A person's task list | `UserTasks`, PK `principalId` SK `taskId`, GSI by owner | TTL copied from the task; a reassigned row can be written with **none set** (`task-tracking.ts:1533-1538`) | Task service role; read API | Yes | **Erased** |
| Thumbs feedback, reason, free-text note | `UserFeedback`, PK `feedbackId`, append-only (`backend/lambda/src/user-feedback.ts:131-150`). PITR on | **None set** | Feedback role `PutItem` only (`conversations-stack.ts:1640-1645`); admin analytics scans | **Not in the export** (`notBuilt`) | **Kept** (`feedback`), carrying the voter's id. **Not erasable** |
| Battle votes | `BattleOutcome`, PK `battleId`, `votes` keyed by person id (`backend/lambda/src/lib/battle-outcome.ts`). PITR on | **None set** | Battle outcome role | **Not in the export** | **Kept** (`battle_votes`). **Not erasable** |
| Battle round replies | `BattleState`, PK `battleId` SK assistant | TTL `ttl`: duel lifetime plus 300 seconds; sentinels 30 days (`backend/lambda/src/lib/battle-state.ts:126-144`) | Orchestrator and battle roles | No | Not touched; expires |
| Who enabled battle | `ChannelBattleConfig`, PK `channelArn`, `enabledBy` | None set | Offboarding update limited to `enabledBy` (`backend/lib/stacks/battle-stack.ts:161-171`) | Yes | Name removed |
| Invitations, reply and unsubscribe links, claims, registrations, guest sessions | `Tokens`, PK `<kind>#sha256(token)` (`backend/lambda/src/lib/tokens.ts`); invitations carry inviter and invitee names | TTL `reclaimAt` = expiry plus 7 days (`tokens.ts:84, 159`); reply 14 days, unsubscribe 60 days, registration 30 days, guest session 900 seconds, invitation by policy (`backend/lambda/src/invitations.ts:397`) | Per-kind grants bounded by LeadingKeys `<kind>#*` (`backend/lib/constructs/token-store.ts:62-73`) | Yes, without the hash | **Erased** for reply, unsubscribe, claim and invitation; guest, proposal and assertion items are not, and expire |
| Identity index (issuer and subject to person) | `Identities`, PK `<issuer>\|<subject>` (`backend/lib/stacks/identity-stack.ts:354`). RETAIN always, PITR on | **None set** | Credential exchange; provisioned issuers bounded by LeadingKeys | Yes | **Erased**, replaced by a `revoked` marker holding only a hash of the subject, which persists so the subject is refused |
| Access log (who opened what, with reason) | `AccessLog`, PK `day#<date>` (`identity-stack.ts:309`; `backend/lambda/src/lib/access-log.ts`). RETAIN always | TTL `expiresAt`, 400 days (`ACCESS_LOG_RETENTION_DAYS`, `access-log.ts:43`) | `PutItem` only for the writers; query by the access log reader | No | Kept until expiry |
| Conversation actions (archive, rename, moderation, with reason) | `ConversationActions`, PK `conversation-action#<channel>` (`conversations-stack.ts:1349`; `conversation-management.ts:110-119`) | **None set** | Conversation management role | No | Kept |
| Membership audit findings | `AuditTable` (`backend/lib/constructs/membership-audit.ts:84`) | **None set** | Audit function; admin read bounded by LeadingKeys | No | Kept |
| Turn analytics record (tokens, latency, tool calls, retrieved passages, reply preferences; no prompt or reply text) | `MessageAnalytics`, PK `messageId` (`archive-stack-aurora.ts:808`) | TTL `ttl`, 7 days (`backend/lambda/src/lib/message-analytics.ts:36`) | Processor put, archival read | No | Expires; merged into Aurora `messages` (kept) |
| Rate, budget and dedup counters | `AbuseControls`, PK `budget#user#<personId>#<hour>`, `ratelimit#<personId>#<hour>`, `guest-ip#<HMAC>` and others | TTL `ttl`, 300 seconds to 2 hours (`backend/lambda/src/lib/abuse-controls.ts`) | Processor and handler roles; guest-ip writer bounded by LeadingKeys | Budget rows | Budget rows erased; `ratelimit` rows expire |
| Turn lock and stop markers | `TurnState`, `stop#<channel>#<personId>#<responder>` | Stop markers TTL 300 seconds (`backend/lambda/src/lib/turn-lock.ts:112`); the lock and queue have **none set** | Processor and handler roles | Stop markers | Stop markers erased |
| Turn routing | `TurnRouting`, PK `correlationId`, no person field (`assistant-profile-stack.ts:445`) | TTL 7 days (`backend/lambda/src/lib/turn-routing.ts:30`) | Handler put, vend get | No | Expires |
| Connector grants (sealed vendor OAuth tokens) | `ConnectorGrants`, PK `personId` SK `connectorId`, customer-managed KMS key (`backend/lib/stacks/connectors-stack.ts:265-296`) | **None set** | Grant routes and the revoker; KMS use conditioned on ViaService and encryption context | **Not in the export**: never exported as a credential, and whether one is held is `notBuilt` | **Erased**: revoked at the vendor, then deleted (`backend/lambda/src/lib/connector-grants.ts:203-219`) |
| Connector event replay ids | `ConnectorReplay`, PK connector plus vendor event id | TTL 7 days (`backend/lambda/src/connector-ingest.ts:50`) | Receiver role | No | Not person-keyed; expires |

---

## 6. Identity, email and invitations

| Data | Where | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|
| Pool account: email, given and family name, custom `tier`, `approved`, `groups` | Amazon Cognito user pool, when the registry declares this deployment's pool (`identity-stack.ts:1026-1067`), RETAIN | Life of the account | Pool administration; the credential exchange asks the pool at every vend | Yes (`poolAccount`) | **Erased**: global sign-out then `AdminDeleteUser` (`offboarding.ts:693-711`) |
| Accounts at an external identity provider | The provider (Microsoft Entra, OIDC, SAML, a host application) | The provider's | The provider's | Only the issuer and subject the platform holds | The platform revokes its own index; the provider account is the provider's to delete |
| Inbound email replies (raw MIME) | `replies/` in the InboundReplies bucket, only when `replyDomain` is set (`backend/lib/stacks/notification-stack.ts:710-769`), written by this deployment's SES receipt rule | 1 day, and deleted after processing (`backend/lambda/src/email-reply.ts:165`) | Reply poster role Get and Delete on `replies/*` | No | Expires in a day |
| Outbound email | Amazon SES; the platform keeps no copy | n/a | Notification roles | n/a | n/a |

---

## 7. Logs and audit trails that may carry content

| Data | Where | Retention | Content risk | Erasure |
|---|---|---|---|---|
| Amazon Lex conversation text logs | Log group `AssistantLexConversationLogs` (`backend/lib/constructs/assistant-provisioner.ts:80-81`), text logging enabled per assistant (`backend/lambda/src/lib/assistant-lex-bot.ts:152-163`) | 14 days | The person's input text as Amazon Lex receives it | Expires; **not erasable per person** |
| Lambda function logs | One log group per function | **None set** for about 102 of 105 functions: only three set `logRetention` (one week, `archive-stack-aurora.ts:646, 721`; `admin-services-stack.ts:380`) and two Cognito triggers set one month (`identity-stack.ts:1119-1127`). These groups never expire | Handlers mostly log ids and flags rather than text (for example the router logs only whether a transcript exists). Content does reach logs in places: membership audit notices (`backend/lambda/src/membership-audit.ts:515`), golden-run model output up to 160 characters, and the full event in two Aurora setup functions | **Not erasable per person** |
| HTTP API access logs | `backend/lib/constructs/http-api.ts:154-175` | 1 month | Caller, method, IP, path, status; no request body | Expires |
| Firehose delivery errors | Log groups in `conversation-archive.ts:81`, `archive-stack.ts:169, 520`, `meetings-stack.ts:292` | 14 days | Delivery errors | Expires |
| Dead-letter queues | Archival, document ingestion, typed conversation events, connector events, meeting events (`archive-stack-aurora.ts:938, 1371`; `meetings-stack.ts:444`) | 14 days | The archival queue holds shard and sequence ranges, not payloads; the meeting events queue holds the original event | Expires |
| CloudTrail | `PlatformTrailBucket` (`identity-stack.ts:868-919`): management events, plus data events (Lambda invokes, DynamoDB item access, Kinesis records, S3 object access) unless `trailDataEvents=false` | `trailRetentionDays`, default 400 | Records keys and principals; DynamoDB and S3 data events can include key values such as person ids | Expires |
| Amazon Bedrock model invocation logging | **Not configured**: no `PutModelInvocationLoggingConfiguration` anywhere | n/a | Prompts are not logged by Bedrock for this deployment | n/a |

---

## 8. Model providers: what leaves the deployment's stores for inference

| Call | Content sent | Where it runs | Retention at the provider | Controls |
|---|---|---|---|---|
| Amazon Bedrock Converse, every assistant turn (`async-processor-core.ts`) | System prompt, grounding, and the conversation's recent messages loaded from Amazon Chime SDK | Bedrock in the deploy Region, or across the member Regions of a `us.` cross-Region inference profile for Haiku 4.5, Sonnet 4.6, Opus 4.6 and DeepSeek R1 (`backend/lib/config/model-strategy.ts:139, 155-173`) | Governed by Amazon Bedrock's data terms; the platform enables no invocation logging | Guardrails applied with `ApplyGuardrail` (`async-processor-core.ts`; `backend/lib/constructs/bedrock-guardrails.ts`) |
| Utility work: classification, titles, summaries, drift reasoning, evaluation judge, tool judging | Message text and summaries | Haiku 4.5 through the `us.` profile (`UTILITY_MODEL_ID`) | As above | As above |
| Embeddings | Document chunks and summaries | Titan Text Embeddings V2 in the deploy Region (`document-ingestion.ts:46-47`) | As above | Guardrails do not apply to embedding models |
| DeepSeek API, when a classification selects `deepseek_api` (`backend/lib/config/model-catalog.ts`) | The turn's prompt and history, over HTTPS to `api.deepseek.com` (`backend/lambda/src/lib/providers/external-llm.ts`) | **Outside AWS** | The provider's terms | Bedrock Guardrails do not apply on this path |
| Image generation: OpenAI `gpt-image` and FAL Flux, when their keys are configured; Stability models on Bedrock | The image prompt (`backend/lambda/src/lib/image-gen-models.ts`) | OpenAI and FAL **outside AWS**; Stability in us-west-2 regardless of the deploy Region | The provider's terms | Image guardrails in the model's Region (`backend/bin/backend.ts:517-548`) |

---

## 9. Summary of gaps

**Retention not set**

- **The conversation archive (`conversations/`) and the archived meeting events never expire.** This is deliberate (the system of record), and it is also why a person's archived messages cannot age out.
- **Aurora `messages`, `exchanges`, `conversation_summaries`, `client_events` and the vector tables have no retention.** `turn_events`, `evaluation_results`, `classifier_replay_labels` and `conversation_creation_tasks` carry an `expires_at` that nothing enforces.
- **`ChannelContext` has no TTL and nothing deletes a row**, so participant profiles, intake answers and meeting attendee lists outlive their conversation.
- **`UserFeedback`, `BattleOutcome`, `ConversationActions`, the membership audit, `ConnectorGrants`, `Identities` and the profile item of `UserProfile` have no TTL.**
- **About 102 Lambda log groups have no retention set** and never expire.

**Not in the person export**

- **Message content** (Amazon Chime SDK and the archive), **the Aurora projection**, **thumbs feedback**, **battle votes**, **meeting transcripts and recordings**, **whether a connector grant is held**, and the access log. The export says so per store (`notBuilt`) rather than reading as complete.
- **Attachments are listed, not copied.**
- **There is no self-service export or deletion route**; both are admin capabilities.

**Not erasable today**

- **What a person said**: their messages stay in each conversation until the channel's retention or expiry, in the archive indefinitely, and in Aurora `messages` (including every edited version and redacted text). Offboarding removes their identity, so their `person_id` no longer resolves to anybody, but the content remains.
- **Feedback and battle votes** are kept by design (`OFFBOARDING_KEPT`), carrying the voter's id.
- **Meeting transcript segments** carry the person's id in the key and are not erased; the transcript itself names speakers.
- **`ChannelContext` fields beyond the identity lookup and intake** (`userName`, `participantProfile`, meeting person ids).
- **Logs** (Lambda, Amazon Lex, CloudTrail) cannot be redacted per person; Lex and CloudTrail expire, most Lambda groups do not.
- **Content sent to a model provider outside AWS** is under that provider's terms.

---

## 10. AWS services the platform uses, and their compliance scope

**AWS's scope of a service does not make an AgentEchelon deployment compliant.** Under the shared responsibility model, AWS attests to the service; the deployment's own configuration, retention, access policies, data flows and operating controls are the deployer's to assess. Several choices above bear directly on that assessment: the archive never expires; the DeepSeek API, OpenAI and FAL are third parties outside AWS's scope; `us.` cross-Region inference profiles process prompts in Regions other than the deploy Region; connectors exchange data with the vendor a deployment declares; and an external identity provider holds its own copy of each person. A service AWS has not listed for a program may still be usable in a deployment that keeps regulated data out of it, which is the deployer's determination.

Sources, all read 2026-11-15: the [Services in Scope index](https://aws.amazon.com/compliance/services-in-scope/) and its program pages for [SOC](https://aws.amazon.com/compliance/services-in-scope/SOC/) (last updated 2026-08-11), [PCI](https://aws.amazon.com/compliance/services-in-scope/PCI/), [ISO and CSA STAR](https://aws.amazon.com/compliance/iso-certified/) (ISO/IEC 27001, 27017, 27018, 27701, 22301, 20000-1, 9001 and CSA STAR CCM v4.0; last updated 2026-09-01), [FedRAMP](https://aws.amazon.com/compliance/services-in-scope/FedRAMP/), [C5](https://aws.amazon.com/compliance/services-in-scope/C5/) (last updated 2026-01-13), [DoD CSP SRG](https://aws.amazon.com/compliance/services-in-scope/DoD/), and the [HIPAA Eligible Services Reference](https://aws.amazon.com/compliance/hipaa-eligible-services-reference/) (last updated 2026-10-15). Pages that showed no date are cited by the date read. "Listed" means the service appears with a check on that page; it says nothing about a specific feature or Region.

| Service | Used for | Turned on by | SOC | PCI DSS | ISO and CSA STAR | FedRAMP Moderate (US East/West) | HIPAA eligible | C5 |
|---|---|---|---|---|---|---|---|---|
| Amazon Chime SDK (Messaging, Identity, Meetings, Media Pipelines) | Conversations, identities, meetings, recording | Core; meetings by `meetings` | Listed | Listed | Listed | Listed | Listed | Listed |
| Amazon Lex V2 | Turn entry for every assistant | Core | Listed | Listed | Listed | Listed | Listed | Listed |
| Amazon Bedrock, including Guardrails | Inference, embeddings, guardrails | Core | Listed (excludes Bedrock Marketplace) | Listed (same) | Listed (same) | Listed | Listed | Listed (same) |
| Amazon Transcribe (through Amazon Chime SDK) | Meeting transcription | `meetings` | Listed | Listed | Listed | Listed | Listed | Listed |
| AWS Lambda | All handlers | Core | Listed | Listed | Listed | Listed | Listed | Listed |
| Amazon DynamoDB | Section 5 | Core | Listed | Listed | Listed | Listed | Listed | Listed |
| Amazon S3 | Sections 2 and 4 | Core | Listed | Listed | Listed | Listed | Listed | Listed |
| Amazon Kinesis Data Streams | Message stream | Core | Listed | Listed | Listed | Listed | Listed | Listed |
| Amazon Data Firehose | Archive delivery | Core | Listed | Listed | Listed | Listed | Listed (as Amazon Kinesis Data Firehose) | Listed |
| Amazon Athena and AWS Glue | Archive queries and catalog | Core | Listed | Listed | Listed | Listed | Listed | Listed |
| Amazon Aurora PostgreSQL (and RDS Proxy, opt-in) | Projection and vectors | Aurora mode | Listed as Amazon RDS; Aurora not named | Same | Same | Listed (Aurora PostgreSQL) | Listed (Amazon Aurora) | Same as SOC |
| Amazon API Gateway | Person and admin APIs | Core | Listed | Listed | Listed | Listed | Listed | Listed |
| AWS AppSync (Events) | Admin console live events | `admin` | Listed | Listed | Listed | **Not confirmed** (not on the page) | Listed | Listed |
| Amazon Cognito | Deployment's own pool, when declared | Registry | Listed | Listed | Listed | Listed | Listed | Listed |
| AWS IAM | Every boundary | Core | Listed | Listed | Listed | Listed | Not listed (IAM Identity Center only) | Listed |
| AWS STS | Credential exchange sessions | Core | **Not confirmed** (not named) | **Not confirmed** | **Not confirmed** | Listed with IAM | **Not confirmed** | **Not confirmed** |
| Amazon EventBridge | Events, connectors, meeting state | Core | Listed | Listed | Listed | Listed | Listed | Listed |
| Amazon EventBridge Scheduler | Workflow deadlines | Core | **Not confirmed** (not named) | **Not confirmed** | **Not confirmed** | **Not confirmed** | **Not confirmed** | **Not confirmed** |
| Amazon CloudWatch and CloudWatch Logs | Metrics, alarms, logs | Core | Listed | Listed | Listed | Listed | Listed | Listed |
| AWS CloudTrail | Platform trail | Core | Listed | Listed | Listed | Listed | Listed | Listed |
| Amazon SES | Notifications and reply receiving | `notifications` | Listed | Listed | Listed | Listed | Listed | Listed |
| Amazon SQS and Amazon SNS | Dead-letter queues, alarm topics | Core | Listed | Listed | Listed | Listed | Listed | Listed |
| AWS Systems Manager (Parameter Store) | Assistant definitions and catalogs | Core | Listed | Listed | Listed | Listed | Listed | Listed |
| AWS Secrets Manager | Provider API keys | Core | Listed | Listed | Listed | Listed | Listed | Listed |
| AWS KMS | Archive, Aurora, contact copies, grants, guest tokens | Core | Listed | Listed | Listed | Listed | Listed | Listed |
| Amazon VPC | Aurora data plane | Aurora mode | Listed | Listed | Listed | Listed | Listed | Listed |
| Amazon CloudFront and AWS WAF | Chat, admin and widget hosting; dashboard pages | `chat`, `admin`, `widget`, `dashboard-pages` | Listed (CloudFront excludes Embedded POPs) | Same | Same | Listed | Listed | Listed |
| AWS CloudFormation | Deployment | Core | Listed | Listed | Listed | Listed | Listed | Listed |
| Amazon Route 53 | Test inbox domain only | `testInboxDomain` | Listed | Listed | Listed | Listed | Listed | Listed |

All of these services are also listed on the DoD CSP SRG page; the impact level per service could not be read reliably from that page and is **not confirmed** here.

---

## 11. Supported Regions

A deployment is one AWS account and one Region (`backend/bin/backend.ts:159`, default `us-east-1`). The Region a service is offered in is AWS's list; the Region a deployment can use is the intersection across every service it deploys, plus where the model catalog sends inference.

| Service | Regions relevant to a deployment (as read 2026-11-15) | Source |
|---|---|---|
| Amazon Chime SDK Messaging | Control and data: **us-east-1 and eu-central-1 only**. Kinesis streaming and channel-flow Lambdas must be in the control Region | [Chime SDK Regions](https://docs.aws.amazon.com/chime-sdk/latest/dg/sdk-available-regions.html) |
| Amazon Chime SDK Meetings | Control: us-east-1, us-west-2, eu-central-1, eu-west-2, ca-central-1, ap-south-1, ap-northeast-1, ap-northeast-2, ap-southeast-1, ap-southeast-2 (and opt-in af-south-1, il-central-1, GovCloud). Media: those plus eu-west-1, eu-west-3, eu-north-1, eu-south-1, sa-east-1, us-east-2, us-west-1 | Same |
| Amazon Chime SDK media pipelines and transcription | Pipelines control in us-east-1, us-west-2, eu-central-1 and others; call analytics transcription in us-east-1, us-west-2, eu-central-1 | Same |
| Amazon Lex V2 | us-east-1, us-west-2, eu-central-1, eu-west-1, eu-west-2, ca-central-1, af-south-1, ap-northeast-1, ap-northeast-2, ap-southeast-1, ap-southeast-2, us-gov-west-1 | [Lex endpoints](https://docs.aws.amazon.com/general/latest/gr/lex.html) |
| Amazon Bedrock models in the shipped catalog | Haiku 4.5, Sonnet 4.6, Opus 4.6: geographic and global cross-Region inference only, in both us-east-1 and eu-central-1 (no in-Region). Nova Pro: in-Region us-east-1; eu-central-1 only cross-Region. gpt-oss-20b and 120b: in-Region in both. DeepSeek V3.2: in-Region us-east-1; not listed for eu-central-1. DeepSeek R1: `us` geographic in us-east-1; not listed for eu-central-1. Titan Text Embeddings V2: in-Region in both. Stability Image Core and Ultra: us-west-2 | [Bedrock Regional availability](https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html) |
| Amazon SES receiving | Includes us-east-1 and eu-central-1 | [SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html) |
| Amazon Cognito, Amazon Data Firehose, Amazon Athena, AWS Glue, Aurora PostgreSQL Serverless v2 | Include us-east-1 and eu-central-1 | [Cognito](https://docs.aws.amazon.com/general/latest/gr/cognito_identity.html), [Firehose](https://docs.aws.amazon.com/general/latest/gr/fh.html), [Athena](https://docs.aws.amazon.com/general/latest/gr/athena.html), [Glue](https://docs.aws.amazon.com/general/latest/gr/glue.html), [Aurora Serverless v2](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.Aurora_Fea_Regions_DB-eng.Feature.ServerlessV2.html) |
| Lambda, DynamoDB, S3, Kinesis Data Streams, API Gateway, EventBridge, CloudWatch, Systems Manager, Secrets Manager, KMS, SQS, SNS, CloudTrail | On AWS's list of core services included in every Region launch | [Regional services](https://aws.amazon.com/about-aws/global-infrastructure/regional-product-services/) |
| EventBridge Scheduler, AWS AppSync Events | **Not confirmed** from a page read for this document | |
| CloudFront and its WAF web ACL | Global; the web ACL is created in us-east-1 whatever the deploy Region (`backend/lib/constructs/frontend-distribution.ts:144`) | |

**Where a full deployment runs today.**

- **Amazon Chime SDK Messaging narrows every deployment to us-east-1 or eu-central-1.** It is core, so no capability widens this.
- **The shipped model catalog narrows it to us-east-1.** Haiku 4.5 (the utility model for classification, titles, summaries and evaluation), Sonnet 4.6, Opus 4.6 and DeepSeek R1 are invoked through `us.` inference profiles (`backend/lib/config/model-strategy.ts:139, 200-345`), which a deployment in eu-central-1 cannot call, and DeepSeek V3.2 and R1 are not offered there. An eu-central-1 deployment needs a catalog that names EU or in-Region model ids, which is a code change to `model-strategy.ts`.
- **Every optional capability is available in us-east-1**: meetings (control, media, pipelines and transcription), notifications with reply receiving, Aurora mode, and the frontends.
- **So a full deployment, core plus every capability, runs in us-east-1 today.**

**Data residency.**

- **Messages are stored in the Messaging data Region**, which is the deploy Region.
- **Inference through a `us.` profile is processed in us-east-1, us-east-2 or us-west-2**, chosen by Bedrock per request; the code grants all three (`US_CROSS_REGION_PROFILE_REGIONS`, `model-strategy.ts:155-159`). A global profile, which the catalog does not use, could route outside the US.
- **Stability image prompts go to us-west-2** from any deploy Region, and **DeepSeek API, OpenAI and FAL calls leave AWS**.
- **Meeting media is hosted in `MEDIA_REGION`**, or the deploy Region when it is unset (`meeting-api.ts:107`), and Amazon Chime SDK can place media in any media Region its control Region serves.
