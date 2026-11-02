/**
 * REUSE RATHER THAN BUILD NEW - a ratchet on the operations that keep getting reimplemented.
 *
 * "Create a conversation channel" is implemented six times and "add a member" ten times. Each copy
 * re-derives the same sequence, so every fix has to be applied N times and a missed copy looks fixed
 * from the outside. That is not hypothetical: commit `39208b5` ("associate the channel flow before any
 * membership") changed the person-facing create path only - then `lambda/create-conversation/index.js`,
 * since retired - while `lib/channel-creation.ts` had the identical defect, was never touched, and
 * drift-spawned channels kept the bug for a week while it read as done.
 *
 * THAT PARTICULAR SPLIT IS NOW CLOSED. The person-facing path is `lambda/src/create-conversation.ts` and
 * it calls the canonical creator rather than carrying its own copy (ADR-053). The guard stays because the
 * other copies remain, and because the next new call site is the one nobody will notice.
 * What it does is stop the bleeding: the count can go DOWN without ceremony and can never go UP by
 * accident. A seventh creation path fails CI with a message naming the helper to use instead.
 *
 * THE RATCHET IS TWO-WAY ON PURPOSE. An unlisted call site fails (proliferation). A listed call site
 * that no longer makes the call ALSO fails (allowlist rot), which forces the list down as consolidation
 * lands and stops it decaying into a stale inventory nobody trusts - the exact failure mode of the
 * point-in-time audit this repo already retired.
 *
 * Adding an entry is allowed. Adding one WITHOUT a reason is not: the reason is the whole control,
 * because it is what makes "I need another one" a decision someone wrote down rather than a default.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOTS = ['backend/lambda'];

interface Controlled {
  /** The shared implementation a new caller should reuse. */
  canonical: string;
  /** Why this operation is controlled - what breaks when it is reimplemented. */
  why: string;
  /** Sanctioned call sites: repo-relative path -> the reason THIS copy exists. */
  sites: Record<string, string>;
  /** Where to look, when it is wider than SCAN_ROOTS. */
  scanRoots?: string[];
  /**
   * The shape a copy takes, when it is not `new <key>(`. Each one has a fixture, checked below, that
   * proves it matches the copy it exists to catch.
   */
  pattern?: RegExp;
  /** A line the pattern must match: a copy as it was written before it was consolidated. */
  fixture?: string;
}

/**
 * The operations that must not grow new implementations. Keyed by the SDK command as it appears in
 * source (`new <key>(`), which is the form a new copy actually takes, or by a name with a `pattern`.
 */
const CONTROLLED: Record<string, Controlled> = {
  CreateChannelCommand: {
    canonical: 'backend/lambda/src/lib/channel-creation.ts',
    why:
      'Creating a conversation channel carries invariants that are individually easy to miss and '
      + 'silent when missed: the immutable `classification` tag (the per-classification IAM roles are '
      + 'fail-closed and key on it), channel-flow association BEFORE any membership, the moderator, '
      + 'expiration, and the pre-create channel-context write. Almost none of these hold '
      + 'across all six copies.',
    sites: {
      'backend/lambda/src/lib/channel-creation.ts':
        'THE canonical creator: every conversation, the admin notification channel included '
        + '(`createAdminNotificationChannel`).',
    },
  },

  DeleteChannelCommand: {
    canonical: 'backend/lambda/src/lib/channel-creation.ts',
    why:
      'Deleting a conversation removes every message in it for every member, and erasure, export and the '
      + 'funnel each follow a deleted conversation by its ARN alone. `retireVisitorConversation` deletes a '
      + 'visitor\'s conversation only after its visit carried over, only one of the asking classification, and '
      + 'only as the service admin; a second copy would be a second set of those checks to keep in step.',
    sites: {
      'backend/lambda/src/lib/channel-creation.ts':
        'THE retirement of a visitor\'s conversation once its seed is written (`retireVisitorConversation`).',
      'backend/lambda/src/admin-notification-channel-provision.ts':
        'The admin notification channel\'s custom resource, deleting the channel it provisioned when its stack '
        + 'is torn down; the channel is the deployment\'s alert feed, not a conversation of any classification.',
    },
  },

  SendChannelMessageCommand: {
    canonical: 'backend/lambda/src/lib/chime/send.ts',
    why:
      'Every message the platform posts goes through `sendChannelMessage`: STANDARD and PERSISTENT unless '
      + 'the caller says otherwise, Metadata as one JSON string, the bearer the caller chose. Twenty-two '
      + 'hand-built requests each restated the defaults, so a change to what a platform message is had '
      + 'twenty-two places to land.',
    sites: {
      'backend/lambda/src/lib/chime/send.ts': 'THE message send.',
    },
  },

  'notify directive': {
    canonical: 'backend/lambda/src/lib/notify-directive.ts',
    why:
      'The Metadata keys that ask the bridge for an email (`notify`, `notifySubject`, `notifyTargets`, '
      + '`notifyConversationId`) are built by `notifyDirective`, the shape `parseNotifyDirective` reads. '
      + 'Five hand-written copies meant a key renamed in one was silently dropped by the bridge for the '
      + 'others, which is how an alarm once emailed under the generic subject.',
    pattern: /notify:\s*\{\s*email:\s*true\s*\}/,
    fixture: '      notify: { email: true },',
    sites: {
      'backend/lambda/src/lib/notify-directive.ts': 'THE directive builder.',
      'backend/lambda/src/lib/channel-notify.ts':
        'The directive PARSER, which normalizes what it read to the same shape; it builds no Metadata.',
    },
  },

  'conversation link': {
    canonical: 'backend/lambda/src/lib/notify-directive.ts',
    why:
      'A link into a conversation is `conversationDeepLink` (or `conversationRef` for a relative one), '
      + 'built from a channel id validated to the id alphabet and this deployment\'s own origin, so nothing '
      + 'a message says can point a reader anywhere else. Three copies each built the query by hand.',
    pattern: /`[^`\n]*\?conversation=\$\{/,
    fixture: 'const conversationLink = `${APP_URL}?conversation=${conversationId}`;',
    scanRoots: ['backend/lambda'],
    sites: {},
  },

  SendEmailCommand: {
    canonical: 'backend/lambda/src/lib/channel-notify.ts',
    why:
      'Every email goes through the one fan-out (`emailPeople`, or the bridge for a directive), which '
      + 'resolves each recipient by person at send time and never takes an address as an identity. The '
      + 'share invitation, the briefing and the archival alarm each sent directly, each with its own '
      + 'recipient source and its own sender check. The raw form is the same send: each mail carries its own '
      + 'reply address and unsubscribe headers (B9, M-8), which only the transport builds.',
    pattern: /new\s+Send(Raw)?EmailCommand\s*\(/,
    fixture: '      await sesClient.send(new SendEmailCommand({',
    sites: {
      'backend/lambda/src/lib/notification.ts': 'The SES transport the fan-out sends through.',
    },
  },

  'SES send grant': {
    canonical: 'backend/lib/constructs/directory-access.ts',
    why:
      'The one SES grant is `grantEmailFanOut`: the sender identity AND its parent domain, with the '
      + 'directory reads the fan-out resolves contacts through. A hand-written statement is how one path '
      + 'came to be scoped to the address while SES authorized against the domain.',
    pattern: /'ses:SendEmail'/,
    fixture: "              actions: ['ses:SendEmail'],",
    scanRoots: ['backend/lib'],
    sites: {
      'backend/lib/constructs/directory-access.ts': 'THE email fan-out grant.',
    },
  },

  CreateChannelMembershipCommand: {
    canonical: 'backend/lambda/src/lib/channel-creation.ts',
    why:
      'Adding a member is an ACCESS-CONTROL act: the classification boundary has to bind before the '
      + 'membership is written, and membership is the authority for who is in a conversation (never a '
      + 'stored roster copy). Ten independent copies means ten places that rule can be forgotten. The '
      + 'owner-stated direction is one typed entry point, shaped like conversation types.',
    sites: {
      'backend/lambda/src/lib/channel-creation.ts': 'THE canonical helper.',
      'backend/lambda/share-conversation/index.js':
        'User-initiated share. Enforces the classification from the immutable tag and fails closed - the '
        + 'reference behaviour the consolidated helper should keep.',
      'backend/lambda/src/lib/membership-reconcile.ts':
        'THE reconcile that keeps a conversation\'s humans equal to an allowed set (DESIGN-CONVERSATION-TYPES '
        + 'section 6), shared by the admin-conversation sync and the group-membership reconcile. The '
        + 'allowed set is admitted against the classification BEFORE it reaches here (lib/membership-source.ts), '
        + 'so the classification binds before the write; humans only, so assistants are never touched.',
      'backend/lambda/src/admin-notification-channel-provision.ts': 'Admin notification channel provisioning.',
      'backend/lambda/src/channel-battle.ts':
        'Adds the alt-slot bot for a duel. Bot membership, not human - a plausible carve-out when the '
        + 'human path consolidates.',
    },
  },

  CreateChannelModeratorCommand: {
    canonical: 'backend/lambda/src/lib/channel-creation.ts',
    why:
      'Moderator assignment decides who can archive, rename or re-open a conversation: the person who '
      + 'opened it and the room primary assistant, never an assistant as a removal target '
      + '(SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP FR11). Three copies is already three places to get it wrong.',
    sites: {
      'backend/lambda/src/lib/channel-creation.ts': 'THE canonical helper.',
      'backend/lambda/src/admin-notification-channel-provision.ts':
        'MAKES THE ADMIN ASSISTANT A MODERATOR of its own channel (the canonical helper does the same for a '
        + 'room\'s primary when the service admin created the room). The channel is the admin notification '
        + 'channel, admin-plane infrastructure and not a person\'s conversation: the admin assistant '
        + 'OWNS this channel by design (DESIGN-ADMIN-AGENT-NOTIFICATIONS) and is already its moderator '
        + 'whenever it created it. This call only reaches the case where it did NOT - a channel left by '
        + 'the previous version, created by the service app-instance-admin - and gives the agent the '
        + 'authority it would have had, so it can post the alerts and stamp the channel. It can never '
        + 'touch a user conversation: the only ARN it is given is the custom resource\'s own recorded '
        + 'channel.',
      'backend/lambda/src/lib/membership-reconcile.ts':
        'Called by the admin-conversation sync with moderators=all-allowed. Makes each current admin a MODERATOR of each admin conversation, not merely a member. The '
        + 'rule this registry exists to protect - moderator standing comes only from the sites listed '
        + 'here - holds: these are humans, and the assistant is excluded by the same `/user/` filter that '
        + 'guards the membership loop beside it. Without this the admin assistant bot is the only '
        + 'moderator an admin channel has, so the admins in it cannot rename, archive or redact '
        + 'inside their own channel. Moderation is channel-scoped (SPEC-MODERATION), so this grants '
        + 'nothing outside these configured channels and does NOT elevate a chat identity to '
        + 'cross-channel administration, which stays on the separate `${sub}-admin` plane. The '
        + 'matching DeleteChannelModerator in the same function is what bounds the grant: the sweep '
        + 'converges the moderator set on the admin set from whatever state it observes, so a demoted '
        + 'admin does not keep moderator authority in an admin channel however the record got there.',
    },
  },

  PutEventsCommand: {
    canonical: 'backend/lambda/src/lib/admin-notice.ts',
    why:
      'A platform alert is an `ae.alert` event on the default bus, carrying the instance that raised it, '
      + 'and the one rule that posts alerts into the admin channel (AdminServices) matches both. A second '
      + 'PutEvents copy raises an alert that rule may never match - another source, no instance - and an '
      + 'alert nobody receives reads exactly like nothing having gone wrong. Every caller uses '
      + '`postAdminNotice`.',
    sites: {
      'backend/lambda/src/lib/admin-notice.ts': 'THE alert raiser.',
      'backend/lambda/src/lib/connectors/events.ts':
        'NOT AN ALERT: the one publisher of received vendor events (`ae.connector`), a different source the alert '
        + 'rule never matches, granted `events:PutEvents` for that source alone. A connector raises an alert '
        + 'through `postAdminNotice` like everything else.',
    },
  },

  CreateAppInstanceUserCommand: {
    canonical: 'backend/lambda/src/lib/person-identity.ts',
    why:
      'Creating a person is minting their id. Only the credential exchange creates a person: the '
      + 'minter reserves an opaque UUID v7 id in the Identities table for the (issuer, subject) BEFORE the '
      + 'AppInstanceUser exists, so one human never holds two AppInstanceUsers and no id is derived from a '
      + 'Cognito sub or username. A trigger, an approval or a script that creates one keys it on something '
      + 'else, and that person then has two identities. A script signs the user in and calls the exchange '
      + '(scripts/lib/sign-in-exchange.cjs) instead.',
    scanRoots: ['backend/lambda', 'backend/scripts'],
    sites: {
      'backend/lambda/src/lib/person-identity.ts': 'THE minter. Every person, for every issuer.',
      'backend/lambda/src/create-app-instance-admin.ts':
        'The service app-instance-admin, created by a custom resource at deploy time. A service principal, '
        + 'not a person: it has no issuer and no subject.',
      'backend/lambda/src/lib/vend.ts':
        'The admin-plane twin `<personId>-admin` only, created by the admin credential exchange '
        + '(admin-credential-exchange.ts, ensureAdminIdentity) beside the person it belongs to (the one '
        + 'deliberate second principal a human holds). The person it derives from is minted by '
        + 'person-identity.ts through the person exchange, and the admin exchange reads it and mints nobody.',
    },
  },

  'HTTP response headers': {
    canonical: 'backend/lambda/src/lib/http-response.ts',
    why:
      'A handler answers through a `responder` that declares its route\'s CORS headers once: which origins '
      + 'are echoed (with `Vary: Origin`), the allowed headers and methods, and the `{ error, code? }` '
      + 'envelope. Twenty-two hand-built copies differed in which of those they sent, so a route\'s CORS '
      + 'behavior was whatever its copy happened to say. Pass the route\'s headers to `responder` instead, '
      + 'and parse an origin list with `originsFrom`.',
    pattern: /'Access-Control-Allow-(Origin|Headers|Methods)'|ALLOWED_ORIGINS?\b[^;\n]*\.split\(/,
    fixture: "const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:5173').split(',');",
    sites: {
      'backend/lambda/src/lib/http-response.ts': 'THE responder.',
    },
  },

  'channel Metadata parse': {
    canonical: 'backend/lambda/src/lib/chime/channel-meta.ts',
    why:
      'Channel Metadata is member-writable, so a parse decides nothing about identity, classification or '
      + 'membership. The copies disagreed on what unparseable text and a non-object meant, and on whether a '
      + 'merge that cannot be read or does not fit may still write. `parseChannelMetadata` and '
      + '`mergeChannelMetadata` say it once.',
    pattern: /JSON\.parse\([^)\n]*\b[Cc]hannel\??\.Metadata\b/,
    fixture: "const meta = JSON.parse(resp.Channel?.Metadata || '{}') as Record<string, unknown>;",
    sites: {},
  },

  ListTagsForResourceCommand: {
    canonical: 'backend/lambda/src/lib/channel-classification.ts',
    why:
      'A channel\'s tags (`classification`, `primaryAssistant`, the admin kind) are the authority access '
      + 'and routing decide on. `readChannelTags` is the one read, and each caller keeps its own decision '
      + 'about what an unreadable tag means. Nine inline reads each re-parsed the tag list.',
    sites: {
      'backend/lambda/src/lib/channel-classification.ts': 'THE channel tag reader.',
      'backend/lambda/src/assistant-ownership.ts':
        'An assistant bot\'s identity tags (`owner-team`), read back after a write through the Amazon Chime '
        + 'SDK identity client. A bot is not a channel.',
      'backend/lambda/src/lib/assistant-ownership.ts':
        'Each assistant bot\'s identity tags (`assistant`, `owner-team`), through the Amazon Chime SDK '
        + 'identity client. A bot is not a channel.',
      'backend/lambda/src/lib/offboarding.ts':
        'An admin-plane twin\'s `owner` tag, read before offboarding removes the twin, through the Amazon '
        + 'Chime SDK identity client. A twin is an AppInstanceUser, not a channel.',
    },
  },

  ListChannelMessagesCommand: {
    canonical: 'backend/lambda/src/lib/chime/history.ts',
    why:
      'Every history reader lists a conversation the same way: newest first, bounded, as one bearer. '
      + '`recentChannelMessages` is that listing and `decodeContent` the one decode. Four copies each '
      + 'built the request, and five files carried their own decoder.',
    sites: {
      'backend/lambda/src/lib/chime/history.ts': 'THE history listing.',
    },
  },

  'message content decoder': {
    canonical: 'backend/lambda/src/lib/chime/history.ts',
    why: 'Message content may be URL-encoded. `decodeContent` decodes it, and returns content that will not decode as sent.',
    pattern: /function\s+(tryDecode|safeDecode\w*)\s*\(/,
    fixture: 'function safeDecode(content: string): string {',
    sites: {},
  },

  ChimeSDKMessagingClient: {
    canonical: 'backend/lambda/src/lib/chime/clients.ts',
    why:
      'A function builds its own-role messaging client through `chimeMessagingClient`, and a client that '
      + 'acts as an assistant session through `sessionClient` (`lib/assistant-session.ts`). Which identity '
      + 'a client sends as is the bearer decision, and one factory per identity keeps it visible.',
    sites: {
      'backend/lambda/src/lib/chime/clients.ts': 'THE own-role factory.',
      'backend/lambda/src/lib/assistant-session.ts':
        'The client built on an assistant session\'s credentials (`messagingClientAsAssistant`).',
    },
  },

  ChimeSDKIdentityClient: {
    canonical: 'backend/lambda/src/lib/chime/clients.ts',
    why: 'An own-role identity client is built through `chimeIdentityClient`, for the same reason as messaging.',
    sites: {
      'backend/lambda/src/lib/chime/clients.ts': 'THE own-role factory.',
    },
  },

  'app-instance admin bearer read': {
    canonical: 'backend/lambda/src/lib/chime/clients.ts',
    why:
      'The app-instance admin bears cleanups and audits on channels the caller is not in. Five copies '
      + 'read its ARN and disagreed on whether a failed read is cached, retried or thrown. '
      + '`appInstanceAdminBearer` takes that choice as `onFailure`.',
    pattern: /GetParameterCommand\(\{\s*Name:\s*ADMIN_ARN_PARAM\b/,
    fixture: 'const r = await ssm.send(new GetParameterCommand({ Name: ADMIN_ARN_PARAM }));',
    sites: {},
  },

  'task table access': {
    canonical: 'backend/lambda/src/lib/task-tracking.ts',
    why:
      'The task tables are read and written in one module, behind the task service (the boundary that '
      + 'decides which classification may see a task) and the task store (the one import a turn uses). A '
      + 'second reader of the table names is a second access path that the service never sees.',
    pattern: /process\.env\.(USER_TASKS_TABLE|TASKS_TABLE)\b/,
    fixture: "const USER_TASKS_TABLE = process.env.USER_TASKS_TABLE || '';",
    sites: {
      'backend/lambda/src/lib/task-tracking.ts': 'THE task table implementation, internal to the service and the store.',
    },
  },

  'task table function import': {
    canonical: 'backend/lambda/src/lib/task-store.ts',
    why:
      'A turn reaches tasks through `task-store`, which asks the task service whenever the function is wired '
      + 'to one. Importing a table-touching function from `task-tracking` reads around the service. Pure '
      + 'helpers and types from `task-tracking` are not table access and are not matched.',
    pattern: new RegExp(
      "import\\s*\\{[^}]*?\\b(allocateTaskRef|createTask|getTask|getActiveTask|getActiveTaskForAssistant|"
      + 'getConversationTasksForAssistant|getTasksOwnedBy|reassignTaskOwner|getAssigneeChannelTasks|'
      + 'findAnswerableTaskById|findAnswerableTaskByRef|getActiveTasksForOwnerInChannel|getActiveTaskForOwner|'
      + 'getOpenTasksForConversation|getActiveTasksForUser|recordTaskDelivery|markTaskPrivate|updateTaskStatus|'
      + 'cancelActiveTasksInChannel|selectStoppableTasks|cancelStoppedTasks|cancelTasksForStop|pauseTask|resumeTask|'
      + 'reassignTask|markTaskReminded|scanActiveDueTasks|advanceTaskState|advanceTaskStateTo|applyUserResponseToTask|'
      + "recordNoTransitionTurn|startTask|completeTask|failTask)\\b[^}]*\\}\\s*from\\s*['\"][./]*(?:lib/)?task-tracking(?:\\.js)?['\"]",
    ),
    fixture: "import { getActiveTasksForUser, principalIdFromArn, type UserTask } from './lib/task-tracking.js';",
    sites: {
      'backend/lambda/src/task-service.ts': 'THE task service: the boundary itself, which runs the table functions.',
      'backend/lambda/src/assistant-async-processor.ts':
        'The processor\'s task READS (the row, the prompt context, the conversation and cross-conversation '
        + 'hints), on the read grant its role holds. Its task writes go through `task-store`.',
    },
  },

  'task service invoke': {
    canonical: 'backend/lambda/src/lib/task-service-op.ts',
    why:
      'A task service takes `{ op, input }` and answers with JSON. `invokeTaskServiceOp` is the one invoke, '
      + 'for the turn seam, the operator plane and the work-item route alike; each caller passes the client '
      + 'that acts as its own role. Four copies each parsed the answer and reported a FunctionError their own way.',
    pattern: /JSON\.stringify\(\{\s*op,\s*input\s*\}\)/,
    fixture: 'Payload: Buffer.from(JSON.stringify({ op, input })),',
    sites: {
      'backend/lambda/src/lib/task-service-op.ts': 'THE task service invoke.',
    },
  },

  'archive mode fork': {
    canonical: 'backend/lambda/src/lib/archive-reader.ts',
    why:
      'The archive is read from the Aurora projection through the data plane or from Athena, and both modes '
      + 'are supported. `archiveReader()` selects the mode once and returns one interface, so a handler holds '
      + 'auth and HTTP and never its own per-mode SQL and row mapping.',
    pattern: /^(?![ \t]*(\*|\/\/)).*\bhasDataPlane\(\)/m,
    fixture: '  if (hasDataPlane()) {',
    sites: {
      'backend/lambda/src/lib/archive-reader.ts': 'THE archive reader: the one place the mode is selected for a read.',
      'backend/lambda/src/lib/data-plane-client.ts': 'The definition of the switch.',
      'backend/lambda/src/lib/event-archive.ts': "The event WRITE path (Firehose in Athena mode, the data plane in Aurora mode) for client events and platform events, and offboarding's erasure of a person's own projection rows (Aurora mode only), not an archive read.",
    },
  },

  CognitoUserPoolsAuthorizer: {
    canonical: 'backend/lib/constructs/edge-authorizer.ts',
    why:
      'No route is authorized by a Cognito authorizer. Every person-facing route is behind the edge authorizer, '
      + 'which verifies a token from any issuer the registry declares; a Cognito authorizer trusts its pools '
      + 'alone, checks no audience, and would make that pool privileged again (L15).',
    sites: {},
    scanRoots: ['backend/lib', 'backend/bin'],
    pattern: /(new|extends)\s+(apigateway\.)?CognitoUserPoolsAuthorizer\b/,
    fixture: "const exchangeAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CredentialExchangeAuthorizer', {",
  },

  RestApi: {
    canonical: 'backend/lib/constructs/http-api.ts',
    why:
      'A deployment serves two HTTP APIs, `PersonApi` and `AdminApi` (D11), built from the route table each '
      + 'stack declares (`RouteSpec`); a vendor reaches neither, its events arriving through its EventBridge partner '
      + 'event source. A REST API of its own would be another surface with its own URL, CORS, authorizer and grants, '
      + 'which is the drift eleven of them had.',
    sites: {},
    scanRoots: ['backend/lib', 'backend/bin'],
    pattern: /new\s+(apigateway\.)?(RestApi|LambdaRestApi|SpecRestApi)\s*\(/,
    fixture: "const api = new apigateway.RestApi(this, 'AddBotApi', {",
  },

  HttpApi: {
    canonical: 'backend/lib/constructs/http-api.ts',
    why:
      'The HTTP APIs are built by `RouteTableApi`, which gives every route its authorizer from the route '
      + 'table, payload format 1.0, one invoke permission per function, the access log and the CORS. A second '
      + 'HTTP API built by hand would serve routes none of that applies to.',
    sites: {
      'backend/lib/constructs/http-api.ts': 'THE route-table API.',
    },
    scanRoots: ['backend/lib', 'backend/bin'],
    pattern: /new\s+(apigwv2\.)?HttpApi\s*\(/,
    fixture: "this.api = new apigwv2.HttpApi(this, 'Api', {",
  },

  HttpLambdaAuthorizer: {
    canonical: 'backend/lib/constructs/edge-authorizer.ts',
    why:
      'A person-facing route on an HTTP API is authorized by the edge authorizer, through `EdgeAuthorizer.authorizerFor`, '
      + 'which gives the credential exchange and every single-use route the uncached attachment. A second Lambda '
      + 'authorizer would be a second token check with its own idea of which issuers, audiences and algorithms count, '
      + 'and a hand-picked attachment can answer a single-use route from the cache.',
    sites: {
      'backend/lib/constructs/edge-authorizer.ts': 'THE edge authorizer: one function, its cached and uncached attachments.',
    },
    scanRoots: ['backend/lib', 'backend/bin'],
  },

  JwtVerifierCreate: {
    canonical: 'backend/lambda/src/lib/token-verification.ts',
    why:
      'A token is verified in one place, `verifyToken`, which adds what the library does not do: the algorithm pin '
      + '(none, HMAC and undeclared algorithms refused), the refusal of embedded keys, a required expiry, the OIDC '
      + 'token type, and the registry entry chosen twice. A verifier built anywhere else skips all of it.',
    sites: {
      'backend/lambda/src/lib/token-verification.ts': 'THE token check at the edge.',
    },
    pattern: /\b(Cognito|Alb)?JwtVerifier\.create\s*\(/,
    fixture: "const verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'id', clientId });",
  },

  StartQueryExecutionCommand: {
    canonical: 'backend/lambda/src/lib/archive-reader.ts',
    why: 'An Athena query over the archive goes through the archive reader, which also owns its Aurora twin.',
    sites: {
      'backend/lambda/src/lib/archive-reader.ts': 'THE archive reader\'s Athena adapter.',
      'backend/lambda/src/analytics-query.ts': 'The Athena-mode analytics handler, deployed only in that mode; its Aurora twin is a separate handler.',
      'backend/lambda/src/evaluation/evaluation-runner.ts': 'The offline evaluation runner over the Athena archive.',
    },
  },

  // ── ONE PRINCIPAL BUILDS AND RETIRES EVERY ASSISTANT (ADR-048, amended 2026-10-24) ─────────────────
  CreateAppInstanceBotCommand: {
    canonical: 'backend/lambda/src/lib/assistant-provisioner.ts',
    why:
      'An assistant\'s identity is built in one place, by the provisioner, on the session role that alone holds '
      + 'the grant: created with its `classification`, `assistant`, `role` and `provisioner = runtime` tags in the '
      + 'same call (an untagged create is refused), with a per-build idempotency token. A second builder is a second '
      + 'principal that can create an identity, which is what the provisioner exists to end.',
    sites: {
      'backend/lambda/src/lib/assistant-provisioner.ts': 'THE identity build, run by the provisioner function alone.',
    },
  },
  DeleteAppInstanceBotCommand: {
    canonical: 'backend/lambda/src/lib/assistant-provisioner.ts',
    why:
      'An identity is removed in one place, by the provisioner, which settles "already gone" (a deleted bot answers '
      + 'Describe with Forbidden) and stops before the Amazon Lex bot when the identity remains.',
    sites: {
      'backend/lambda/src/lib/assistant-provisioner.ts': 'THE identity removal, run by the provisioner function alone.',
    },
  },
  CreateBotCommand: {
    canonical: 'backend/lambda/src/lib/assistant-lex-bot.ts',
    why: 'Every assistant\'s Amazon Lex bot is built the same way, tagged at create, by the provisioner\'s build path.',
    sites: {
      'backend/lambda/src/lib/assistant-lex-bot.ts': 'THE Amazon Lex bot build, called from the provisioner\'s build path only.',
    },
  },
  'asking the provisioner': {
    canonical: 'backend/lambda/src/assistant-provisioner-function.ts',
    why:
      'The provisioner answers three direct invokes, and its callers are named in IAM (`one-principal-builds-every-'
      + 'assistant.test.ts`): the console\'s create and retire, and a deploy\'s seed. A new caller is a new way an '
      + 'assistant comes to exist or stops existing, and is a decision someone writes down here.',
    pattern: /PROVISIONER_FUNCTION_NAME/,
    fixture: "const PROVISIONER_FUNCTION_NAME = process.env.PROVISIONER_FUNCTION_NAME || '';",
    sites: {
      'backend/lambda/src/manage-assistants.ts': 'The console: `build` for a create, `remove` for a retire or an undone build.',
      'backend/lambda/src/seed-declared-assistants.ts': 'A deploy\'s seed: `seed-declared`, the thin CloudFormation adapter.',
    },
  },
};

function sourceFiles(roots: string[] = SCAN_ROOTS): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      // .d.ts are build artifacts and carry declarations, not call sites, and so is a .js beside its .ts.
      // .mjs and .cjs too: the operator scripts are written in them.
      else if (/\.(ts|js|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.d.ts')
        && !(e.name.endsWith('.js') && fs.existsSync(p.slice(0, -3) + '.ts'))) out.push(p);
    }
  };
  for (const r of roots) {
    const abs = path.join(ROOT, r);
    if (fs.existsSync(abs)) walk(abs);
  }
  return out;
}

function callSitesOf(command: string, files: string[]): string[] {
  const re = CONTROLLED[command]?.pattern ?? new RegExp(`new\\s+${command}\\s*\\(`);
  return files
    .filter((f) => re.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'))
    .sort();
}

describe('single entry point: reuse rather than build new', () => {
  const files = sourceFiles();

  for (const [command, spec] of Object.entries(CONTROLLED)) {
    describe(command, () => {
      const actual = callSitesOf(command, spec.scanRoots ? sourceFiles(spec.scanRoots) : files);
      const sanctioned = Object.keys(spec.sites).sort();

      it('has no UNSANCTIONED call site', () => {
        const added = actual.filter((f) => !spec.sites[f]);
        // Thrown rather than asserted so the failure carries the guidance. A bare `toEqual([])` diff
        // tells the next person WHAT tripped and not what to do about it, and "what to do about it"
        // is the entire point of this guard.
        if (added.length) {
          throw new Error(
            `\n\nNEW \`${command}\` call site(s):\n  ${added.join('\n  ')}\n\n`
            + `Reuse \`${spec.canonical}\` instead.\n\n${spec.why}\n\n`
            + 'If a new copy is genuinely required, add it to CONTROLLED in this file WITH the reason '
            + 'it cannot reuse the canonical helper. The reason is the control; an entry without one '
            + 'is how six copies happened.\n',
          );
        }
        expect(added).toEqual([]);
      });

      it('has no STALE allowlist entry (the ratchet only turns one way)', () => {
        const gone = sanctioned.filter((f) => !actual.includes(f));
        if (gone.length) {
          throw new Error(
            `\n\nThese are allowlisted but no longer call \`${command}\`:\n  ${gone.join('\n  ')}\n\n`
            + 'Consolidation landed - delete them from CONTROLLED so the count ratchets DOWN and the '
            + 'list keeps describing the code rather than its history.\n',
          );
        }
        expect(gone).toEqual([]);
      });
    });
  }

  it('is not vacuous - the scanner finds the call sites it claims to police', () => {
    // A regex that matched nothing would pass every assertion above while checking nothing at all.
    // These are lower bounds, not the live counts: asserting the exact number would make this test
    // fail on consolidation, which is the outcome it exists to encourage.
    expect(sourceFiles().length).toBeGreaterThan(50);
    expect(callSitesOf('CreateChannelCommand', files).length).toBeGreaterThanOrEqual(1);
    expect(callSitesOf('CreateChannelMembershipCommand', files).length).toBeGreaterThanOrEqual(2);
    expect(callSitesOf('CreateAppInstanceUserCommand', sourceFiles(CONTROLLED.CreateAppInstanceUserCommand.scanRoots)).length).toBeGreaterThanOrEqual(2);
    expect(sourceFiles(['backend/scripts']).length).toBeGreaterThan(10);
  });

  it('each pattern matches the copy it exists to catch', () => {
    for (const [name, spec] of Object.entries(CONTROLLED)) {
      if (!spec.pattern) continue;
      expect({ name, matched: spec.pattern.test(spec.fixture || '') }).toEqual({ name, matched: true });
    }
  });
});
