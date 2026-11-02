import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { sharedOrigins, adminOrigin, invitationLandingFor } from '../config/app-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { contactCopiesDeclared, grantContactCopyWrite } from '../constructs/contact-copy';
import { Construct } from 'constructs';
import { defaultProfileRegistry as profiles } from '../profile-registry';
import { dataRemovalPolicy as dataRemovalPolicyOf } from '../config/environment';
import {
  SSM_ROOT, SHARED_SSM, CHANNEL_FLOW_ARN_SSM_KEY, INSTANCE_SSM, turnQueueWiring,
  driftChannelCreateStatements, classificationChannelScopedAllow, speakAsAssistantStatements, speakAsAssistantEnv, roomPrimaryReadStatements,
  RES_PREFIX, sayThroughRouterWiring, membershipAsAssistantStatements, conversationalClassifications,
  adminPlaneMembershipStatements, ownInstanceFunctions, STACK_PREFIX, CAPABILITY_RESOURCES, INSTANCE_NAME, membershipAsServiceAdminStatements,
  modelArnsForClassification,
  EVERY_CLASSIFICATION, neverAnOutsideConversation, memberRoutersByNameStatements, routerByNameEnvironment,
  ownInstanceMemberConversationFunctions,
} from './agent-classification-common';
import { getModelCatalog, type Classification } from '../config/model-strategy';
import { guestSettingsOf } from '../config/issuers';
import { bindTargetCreatorsOnly, conversationCreatorInvoke, memberCreatorsOnly, CONVERSATION_CREATOR_PARAM_ROOT } from '../constructs/conversation-creator';
import { APPROVAL_QUEUE_ATTRIBUTE, REGISTRATIONS_AWAITING_APPROVAL } from '../../lambda/src/lib/upgrade';
import { grantIssuerRegistry, issuersOf } from '../constructs/trusted-issuers';
import { grantServerEventAppend } from '../constructs/server-event-writer';
import { grantAccountStateRead, grantDirectoryRead } from '../constructs/directory-access';
import type { RouteSource, RouteSpec, RouteThrottle } from '../constructs/http-api';
import { grantTokenKinds } from '../constructs/token-store';
import { claimTargetOf, GUEST_VISITOR_TYPE, upgradePathsOf } from '../config/conversation-types';
import { INVITATIONS_BY_CHANNEL, INVITATION_CHANNEL_ATTRIBUTE } from '../../lambda/src/lib/invitations';
import { CLASSIFICATION_PACK_PREFIX } from '../../lambda/src/lib/profile-bodies';

/** The conversation routes' throttle, which their one REST API carried as a whole. */
const CONVERSATION_THROTTLE: RouteThrottle = { rate: 50, burst: 100 };

export interface ConversationsStackProps extends cdk.StackProps {
  appInstanceArn: string;
  /** This deployment's own pool, or `''` when the registry declares none (L15). */
  selfPoolId: string;
  /**
   * The role offboarding runs on (Identity). Granted here, with the tables and the bucket, exactly what
   * erasing one person needs on each: their profile row, their task partition, their stop records and
   * budget rows, and their uploads.
   */
  offboardingRoleArn?: string;
  /**
   * The credential exchange's role (Identity), granted here with the resources, by reference: when an issuer
   * declares the `claims` directory, the write of its contact copies and the encrypt on their key (C5); when
   * the registry declares a guest issuer, its token kinds in `Tokens` (`guest-refresh#`, `guest-family#`), its
   * address rows in the abuse-controls table (`guest-ip#`), and the invoke of the guest classification's creator.
   */
  credentialExchangeRoleArn?: string;
  /**
   * The credential exchange's function (Identity): the invitations function asks it to mint each invitee,
   * the one minter of an AppInstanceUser (M-10). Absent, no invitation is issued.
   */
  credentialExchangeFunctionArn?: string;
  /** The classifications the `invitation-link` issuer declares (Identity), when the registry declares one. */
  invitationLinkReach?: string[];
  /**
   * Whether `notifications` is declared: the invitation and guest-upgrade functions are told the `TransactionalMail`
   * function's fixed name, which sends their emails. Absent, they send none, and each answers with its unsent path.
   */
  transactionalMail?: boolean;
}

/**
 * The membership adds conversation management is denied on an outside conversation and on one with no audience
 * (`neverAnOutsideConversation`). It removes, leaves and archives in every conversation, and adds in none.
 */
export const CONVERSATION_MANAGEMENT_ADDS = [
  'chime:CreateChannelMembership',
  'chime:BatchCreateChannelMembership',
  'chime:CreateChannelModerator',
] as const;

/**
 * CONVERSATIONS (`<prefix>Conversations`): the shared state a conversation is made of, and the handlers
 * that create and change it.
 *
 * The task tables, the user profile, the channel context, turn state, abuse controls, the feedback
 * (thumbs) table and the attachments bucket; and the create-conversation, membership, task, turn-state,
 * attachment and feedback routes. It publishes the shared SSM contract its tables are read through. It
 * hosts no assistant: those live in the per-classification `Assistants-*` stacks, duels in `Battle` and
 * experiments in `Experiments`.
 */
export class ConversationsStack extends cdk.Stack implements RouteSource {
  /** The conversation, task, turn-state, attachment and feedback routes, on `PersonApi`. */
  public readonly routes: RouteSpec[] = [];
  /** The archive, removal and leave handler; the admin console's archive route reaches it too. */
  public readonly conversationManagementFunction: lambda.IFunction;
  /** The attachments bucket: user uploads, assistant deliverables, and profile bodies under `profiles/*`. */
  public readonly attachmentsBucket: s3.Bucket;
  public readonly presignedUrlFunction: lambda.Function;
  /**
   * UserFeedback (thumbs) table. Exposed so the Aurora archive can read it for the per-variant thumbs
   * join; the Archive stack deploys after this one, so it is a construct reference.
   */
  public readonly feedbackTable: dynamodb.Table;
  /** `Tokens` (A8): the edge authorizer (PersonApi) records a host assertion's `jti` here, by reference. */
  public readonly tokensTable: dynamodb.Table;
  /** The invitations function (M-10): the admin backend invokes it to list and revoke a conversation's invitations. */
  public readonly invitationsFunction?: lambda.IFunction;
  /** Path B's function, when a guest issuer and a claim target are declared: the console's approvals reach it. */
  public readonly guestUpgradeFunction?: lambda.IFunction;

  constructor(scope: Construct, id: string, props: ConversationsStackProps) {
    super(scope, id, props);

    // Per-classification company-context S3 scoping + per-classification model selection live in the
    // AgentEchelonAssistants-* stacks alongside the processors (ADR-011).

    // Every classification owns its own Lex + AppInstanceBot + router (AgentEchelonAssistants-*),
    // a classification's alt is its own assistant with its own Lex bot, and experiments live in
    // AgentEchelonExperiments — so there is no shared Lex/AppInstanceBot/router here.

    // ============================================================
    // DynamoDB Tables for Task Tracking
    // ============================================================

    const dataRemovalPolicy = dataRemovalPolicyOf(this);

    const agentTasksTable = new dynamodb.Table(this, 'AgentTasksTable', {
      partitionKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'channelArn', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: dataRemovalPolicy,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    // Work-item tasks: per-context (plan) lookup for cascade-cancel + (later) the per-plan digest.
    // SPARSE — only work-item tasks carry `contextId`, so enterprise tasks aren't indexed. Cross-user
    // by design (a co-participant's task must cancel when the owner drops the item), which a user-tasks
    // index can't do; the plan's tasks all share `contextId`.
    agentTasksTable.addGlobalSecondaryIndex({
      indexName: 'contextId-index',
      partitionKey: { name: 'contextId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // "What work is open in THIS conversation", whoever owns it (ADR-024 D4). Visibility is scoped by
    // conversation membership rather than by ownership, and that question had no index at all: the
    // table's channelArn is a SORT key, so it cannot be queried on its own, and the two owner-keyed
    // reads can only narrow one actor's tasks to a channel. Not sparse - every task has a channel.
    //
    // Sorted by `updatedAt` rather than by `status`: recency answers "what is open here" in one query
    // and orders the result, where a status sort key needs one query per active status and still does
    // not order them. A judgement, not a measurement; revisit if the filtered read proves wasteful.
    agentTasksTable.addGlobalSecondaryIndex({
      indexName: 'channelArn-updatedAt-index',
      partitionKey: { name: 'channelArn', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // THE KEY SAYS WHAT IT HOLDS: the principal the work is with, a person's AppInstanceUser id or an
    // assistant's AppInstanceBot id while an assistant holds the work.
    const userTasksTable = new dynamodb.Table(this, 'UserTasksTable', {
      partitionKey: { name: 'principalId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: dataRemovalPolicy,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    // WHOSE WORK IS OPEN IN THIS CONVERSATION (ADR-024 D8).
    //
    // The table is partitioned by ASSIGNEE, which answers "what do I owe" as a partition read and is
    // worth keeping (D2). It cannot answer "the work in this conversation": while an assistant is
    // working, the row sits in the assistant's partition, so the person it belongs to is not the key.
    //
    // The narrowing to one person is NOT this index. It is applied by the task service, behind the
    // IAM boundary that decides who may run the read at all, against an owner the caller carries from
    // the message sender rather than one it composes. The index makes the question askable; the
    // service decides who may ask it and about whom (tenet D3, two layers).
    // ── UPGRADING AN EXISTING DEPLOYMENT ADDS THESE INDEXES ONE AT A TIME ─────────────────────────
    //
    // A FRESH deployment is unaffected: CreateTable accepts every index at once, so a first install of
    // this repo works as written. The limit is on UPDATES to a table that already exists -
    // "Cannot perform more than one GSI creation or deletion in a single update" - which is what an
    // upgrade from a release before ADR-024 D8 performs.
    //
    // SO IT IS A FLAG, NOT A SOURCE EDIT (code review, 2026-09-09). This used to instruct the operator
    // to comment an index out, deploy, put it back and deploy again - which means the committed tree
    // cannot be deployed to an existing environment as written, and an OSS deployer's first upgrade
    // requires editing a stack file they did not write. Both indexes are still added by default,
    // because that is correct for the fresh install this repo's own instructions describe; an upgrade
    // passes the wave instead:
    //
    //   npm run deploy -- --context taskIndexWave=1     # ownerPersonId-index only
    //   npm run deploy                                  # both; the second is added on this pass
    //
    // Attempting both at once against an existing table fails the update and rolls it back; that
    // failure is loud and the rollback is clean, so it costs a deploy rather than a repair.
    //
    // NOTHING BREAKS IN BETWEEN. Both reads that use these indexes catch their own failure and return
    // an empty list, so a turn taken while an index is still building degrades to the behavior that
    // existed before it: the runtime's assumption stands and no candidate list is offered.
    //
    // Anything other than `1` reads as "all of them", including an absent value and a typo: the
    // default has to be the whole shape, or a mistyped flag would silently ship a table missing an
    // index and the reads that need it would degrade to empty for the life of the deployment.
    const taskIndexWave = String(this.node.tryGetContext('taskIndexWave') ?? '').trim();
    const deferSecondTaskIndex = taskIndexWave === '1';
    if (deferSecondTaskIndex) {
      console.log(
        '[Conversations] taskIndexWave=1: adding ownerPersonId-index only. '
        + 'Deploy again WITHOUT the flag to add channelArn-assistantId-index.',
      );
    }

    // WHAT ONE PERSON OWNS, ACROSS CONVERSATIONS (ADR-024 D8).
    //
    // The partition answers what a principal is ASSIGNED, which is what they owe next. It cannot
    // answer what they OWN: while an assistant is working, the row sits in the assistant partition
    // and the person it belongs to is only an attribute. Those are different questions, and an
    // operator asks both.
    //
    // SPARSE by construction: only rows written since D8 carry an owner, and older ones age out on
    // the task TTL rather than being backfilled.
    userTasksTable.addGlobalSecondaryIndex({
      indexName: 'ownerPersonId-index',
      partitionKey: { name: 'ownerPersonId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
    });

    // HELD BACK ONLY ON WAVE 1. See the note above: one GSI per UpdateTable on a table that exists.
    if (!deferSecondTaskIndex) {
      userTasksTable.addGlobalSecondaryIndex({
        indexName: 'channelArn-assistantId-index',
        partitionKey: { name: 'channelArn', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'assistantId', type: dynamodb.AttributeType.STRING },
      });
    }

    userTasksTable.addGlobalSecondaryIndex({
      indexName: 'principalId-taskType-index',
      partitionKey: { name: 'principalId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'taskType', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Per-user profile: the durable per-END-USER record (onboarded flag + collected onboarding facts
    // like company/role). One item per person id (their AppInstanceUser id). No TTL — this is durable user memory, not transient
    // state (contrast AbuseControlsTable, which self-expires). This built-in table is a REFERENCE
    // STAND-IN: an implementer can point the router at their own profile store via
    // USER_PROFILE_SERVICE_ARN and this table goes unused. See SPEC-USER-PROFILE-AND-ONBOARDING.md.
    //
    // THE CONTACT COPIES of a `claims`-directory issuer (C5) live here too, as their own items keyed
    // `<personId>#contact#<issuerId>`, and are the only items that carry `expiresAt`: 90 days after the
    // sign-in that wrote them. The TTL and the key exist only when the registry declares such an issuer.
    const contactCopies = contactCopiesDeclared(this);
    const userProfileTable = new dynamodb.Table(this, 'UserProfileTable', {
      partitionKey: { name: 'personId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      ...(contactCopies ? { timeToLiveAttribute: 'expiresAt' } : {}),
      removalPolicy: dataRemovalPolicy,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    // Channel Context store (channel-context-client.ts). The SERVER-ONLY grounding a conversation
    // carries — participant profile, domain context, extra context blobs, resolved display name —
    // keyed by channelArn. These must NOT sit in Amazon Chime SDK channel Metadata, which any member
    // can read via DescribeChannel; only the conversation-create Lambdas write here and only the
    // assistant handler reads. Durable (no TTL), PITR on, like UserProfileTable.
    //
    // THE ROUTING SIGNALS MOVED HERE AND THIS COMMENT USED TO DENY IT. It read that "the member-readable
    // routing bits (topic, language, segment, contextId) ... deliberately stay in channel Metadata".
    // `userLanguage` and `segment` are owned by this store because they decide WHICH MODEL answers a
    // turn, and Metadata is member-writable; `topic` is owned here too, because its only reader runs at
    // `WelcomeIntent` when Metadata is not yet reliably readable. The participant ROSTER does stay in
    // Chime, where `ListChannelMemberships` is the authority - what lives here is the `{sub, iss, role}`
    // LOOKUP, which Metadata may never hold because identity is on `METADATA-AND-TAGS.md`'s never list.
    //
    // DURABLE MEANS FOREVER, AND THAT IS A KNOWN DEFECT rather than the end state. Nothing deletes a
    // row and archive does not touch one, so a conversation's `onboardingIntake`, `memberIdentities` and
    // `domainContext` outlive the channel's own expiration. `DESIGN-CONVERSATION-TYPES.md` section 4.4
    // carries the disposition this needs; it is NOT BUILT.
    //
    // ONE OTHER KIND OF ITEM LIVES HERE: an alarm's watch record, keyed `watch#alarm#<alarm name>`, naming the
    // conversation that watches the alarm (ADR-061, the incident watch). The canonical creator writes it beside the
    // room's row, and the router reads it by key; it carries no `conversationType`, so the type index never lists it.
    const channelContextTable = new dynamodb.Table(this, 'ChannelContextTable', {
      partitionKey: { name: 'channelArn', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: dataRemovalPolicy,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });
    // EVERY CONVERSATION OF ONE TYPE, for the group-membership reconcile (DESIGN-CONVERSATION-TYPES §6).
    // Sparse - only rows a creator stamped with a type are indexed - and KEYS_ONLY, so the index holds
    // channel ARNs and nothing private.
    channelContextTable.addGlobalSecondaryIndex({
      indexName: 'ByConversationType',
      partitionKey: { name: 'conversationType', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    // Abuse-controls control plane (docs/specs/analytics-eval/SPEC-ABUSE-CONTROLS.md). One
    // generic pk+ttl table backs request dedup (`dedup#<corr>`), spend budgets
    // (`budget#user#…`, `budget#global#…`), and later rate limits. Every entry is short-lived
    // (minutes to two hours) and self-expires via DynamoDB TTL, so the table never accumulates.
    const abuseControlsTable = new dynamodb.Table(this, 'AbuseControlsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: dataRemovalPolicy,
    });

    // ── THE TOKEN STORE (A8) ──────────────────────────────────────────────────────────────────────
    //
    // Every single-use or bounded token the platform issues or remembers, in one table: `pk` is
    // `<kind>#<sha256(token)>` (`lambda/src/lib/tokens.ts`), so the kind leads every key and each writer's
    // grant carries `dynamodb:LeadingKeys` limited to its own kinds (`grantTokenKinds`). Redemption is a
    // conditional update on `consumedAt` and `expiresAt`; TTL (`reclaimAt`, `expiresAt` plus 7 days)
    // only reclaims space. A token is found by its hash, and nothing else is a way in to it. ONE SPARSE
    // INDEX lists a conversation's invitations (`invitationChannel`, carried by invitation records alone) for
    // the inviter, a moderator and the console; it holds no token, only the record's own fields.
    const tokensTable = new dynamodb.Table(this, 'TokensTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'reclaimAt',
      removalPolicy: dataRemovalPolicy,
    });
    tokensTable.addGlobalSecondaryIndex({
      indexName: INVITATIONS_BY_CHANNEL,
      partitionKey: { name: INVITATION_CHANNEL_ATTRIBUTE, type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // THE REGISTRATIONS WAITING FOR AN OPERATOR, only where the guest issuer declares approval `admin`: a
    // sparse index on the attribute a registration carries while it waits, and loses when it is approved.
    const guestForTokens = issuersOf(this).guest();
    const registrationApproval = guestForTokens ? guestSettingsOf(guestForTokens).registrationApproval : 'none';
    if (registrationApproval === 'admin') {
      tokensTable.addGlobalSecondaryIndex({
        indexName: REGISTRATIONS_AWAITING_APPROVAL,
        partitionKey: { name: APPROVAL_QUEUE_ATTRIBUTE, type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
    }

    // Which turn is answering a conversation, and what is waiting behind it (ADR-033).
    //
    // ITS OWN TABLE, AND NOT THE ABUSE-CONTROLS ONE, though that is also a generic pk+ttl store and
    // reusing it would have needed no new IAM. The two have OPPOSITE failure policies, and mixing
    // them is a hazard rather than an untidiness: the global spend budget FAILS SAFE, so an error
    // reading it becomes "over budget" and blocks the turn, deliberately, so a control-table outage
    // can never become unbounded spend. A turn lock takes a write on every turn - far more traffic
    // than the controls it would sit beside - so throttling caused by queue traffic would start
    // tripping that spend limit and stop the deployment answering anyone. A convenience for people
    // who send twice must not be able to take down answering.
    //
    // Same shape otherwise: one `pk`, a TTL attribute that only the stop marker sets (the lock is
    // released by a recorded fact, never by a clock - see lib/turn-lock.ts), and on-demand billing
    // because the load follows conversation traffic rather than a provisioned guess.
    //
    // NO POINT-IN-TIME RECOVERY, and that is a decision rather than an omission - every task and
    // profile table above carries it. Nothing here is worth restoring. A lost lock row reads as "not
    // busy", which is the fail-open answer this module takes on every other failure, so losing the
    // table degrades to today's behavior rather than to a wrong one. A lost queue row loses at most
    // `TURN_QUEUE_MAX` message IDS, whose content still lives in the channel and can be triaged again
    // by the next turn. Restoring either to a point in time would be restoring a claim about which
    // turn was running minutes ago, which is worse than having none: it would name a holder that
    // finished, and the takeover path would have to undo it.
    const turnStateTable = new dynamodb.Table(this, 'TurnStateTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // THE LOCK AND ITS QUEUE NEVER EXPIRE, deliberately (maintainer, 2026-08-28): they carry no `ttl`. A
      // drain holds that record across the time a person takes to answer a question the assistant asked,
      // so an expiry would delete a queue somebody was told was waiting. A conversation whose holder is
      // gone is recovered by the next message, which checks the state and takes the lock: an event
      // somebody caused, seen by code that is running. The table has no stream; that takeover is counted
      // as `LockTakeover` (StrandedLockAlarm below).
      //
      // THE STOP MARKER DOES EXPIRE (`stop#<channel>#<personId>#<responder>`, which names a person): it
      // can change only a turn that was running when it was written, so it sets `ttl` to the longest a
      // turn can run (`STOP_MARKER_TTL_SECONDS`, lib/turn-lock.ts) and the table reclaims it.
      timeToLiveAttribute: 'ttl',
      removalPolicy: dataRemovalPolicy,
    });

    // ── THE OTHER HALF OF "A TURN THAT NEVER CAME BACK" (ADR-033) ─────────────────────────────
    //
    // The StrandedLockAlarm below COUNTS a lock taken over from a stale holder: by then the
    // conversation has gone unanswered until a later message arrived, and the metric exists to say
    // that should not have happened. A turn releases its lock in a `finally`, which covers every
    // ending its own code reaches; the platform killing the invocation is the one it cannot, and
    // Lambda reports exactly that to an onFailure destination, carrying the payload that started
    // the invocation - the channel, the bot and the correlation, which is the whole lock. That
    // destination is per classification (`TurnRecoveryOnFailure` in assistant-profile-stack.ts).
    //
    // THE SHARED TurnLockReleaseOnFailure FUNCTION USED TO BE DECLARED HERE, AND IS GONE.
    //
    // Nothing read it. Retrying a died turn moved to a per-classification copy
    // (`TurnRecoveryOnFailure` in the profile stack) whose invoke grant names its own processor, so
    // the boundary is denied at IAM rather than refused in code - and the shared one was left behind
    // with its ARN still published to SSM. Every deployment carried a Lambda nobody invoked plus an
    // SSM parameter every dependent stack resolved and waited on.
    //
    // `lambda/src/turn-lock-release-on-failure.ts` stays: it is the handler the per-classification
    // copy runs.


    // NOT an error alarm. It fires when the design's central claim has FAILED - a conversation was
    // held by something that died. Left without an action deliberately, matching the repair-rate
    // alarm: an alarm that exists and is visible is the floor, and wiring it to a destination is the
    // deployer's choice.
    //
    // IT WATCHES THE TAKEOVER NOW, not an expiry. The record no longer expires (maintainer, 2026-08-28),
    // because an expiry on a record that holds a queue and an unanswered question deletes work
    // somebody was told was waiting. The same failure is now observed by the next arriving message,
    // which takes a lock whose holder is past any possible turn - sooner, and by code that is running.
    new cloudwatch.Alarm(this, 'StrandedLockAlarm', {
      // PREFIXED LIKE EVERY OTHER ALARM HERE. Alarm names are account-and-region unique, and this
      // was the one literal in the repo: a second instance in the same account silently took
      // ownership of the first's alarm, and tearing down either deleted it for both. The instance
      // that owns an alarm has to be readable from its name.
      alarmName: `${this.stackName}-stranded-locks`,
      alarmDescription:
        'A conversation lock was taken over because its holder was past any possible turn (ADR-033). '
        + 'The design claims a lock is released by a recorded fact - a turn finishing, or the platform '
        + 'reporting the invocation running it died. A non-zero count means neither happened and '
        + 'something died holding a conversation, which the next message had to recover. Check the '
        + 'router log for the conversation and the correlation that held it.',
      metric: new cloudwatch.Metric({
        namespace: 'AgentEchelon/TurnQueue',
        metricName: 'LockTakeover',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      // MISSING IS NOT BREACHING. The healthy state emits nothing at all, so treating absent data as a
      // breach would leave this alarming forever on a deployment where the design is working.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // The /battle DynamoDB tables live in AgentEchelonBattle; the experiments table +
    // admin-experiments API live in AgentEchelonExperiments (experiments-stack.ts).

    // The Battle Orchestrator and the battle tables (SPEC-BATTLE.md) live in the
    // opt-in AgentEchelonBattle stack (battle-stack.ts). Each alt is its classification's own
    // assistant on its own Lex bot, so this stack needs no shared Lex/router.

    // ============================================================
    // Shared SSM contract for the per-classification stacks (SPEC-PER-PROFILE-OWNERSHIP.md).
    // AgentEchelonAssistants-{standard,premium} resolve these at DEPLOY time via
    // valueForStringParameter (an SSM dynamic ref, NOT Fn::importValue), so a
    // classification deploys decoupled from this stack while still pointing at the shared
    // TASK tables. The experiments SSM keys are published by AgentEchelonExperiments
    // and the /battle SSM keys by the opt-in AgentEchelonBattle stack.
    // ============================================================
    const sharedParams: Array<[string, string, string]> = [
      ['SharedAgentTasksArnParam', SHARED_SSM.agentTasksArn, agentTasksTable.tableArn],
      ['SharedAgentTasksNameParam', SHARED_SSM.agentTasksName, agentTasksTable.tableName],
      ['SharedUserTasksArnParam', SHARED_SSM.userTasksArn, userTasksTable.tableArn],
      ['SharedUserTasksNameParam', SHARED_SSM.userTasksName, userTasksTable.tableName],
      ['SharedUserProfileArnParam', SHARED_SSM.userProfileArn, userProfileTable.tableArn],
      ['SharedUserProfileNameParam', SHARED_SSM.userProfileName, userProfileTable.tableName],
      ['SharedChannelContextArnParam', SHARED_SSM.channelContextArn, channelContextTable.tableArn],
      ['SharedChannelContextNameParam', SHARED_SSM.channelContextName, channelContextTable.tableName],
      ['SharedTurnStateArnParam', SHARED_SSM.turnStateArn, turnStateTable.tableArn],
      ['SharedTurnStateNameParam', SHARED_SSM.turnStateName, turnStateTable.tableName],
      ['SharedAbuseControlsArnParam', SHARED_SSM.abuseControlsArn, abuseControlsTable.tableArn],
      ['SharedAbuseControlsNameParam', SHARED_SSM.abuseControlsName, abuseControlsTable.tableName],
      ['SharedTokensArnParam', SHARED_SSM.tokensArn, tokensTable.tableArn],
      ['SharedTokensNameParam', SHARED_SSM.tokensName, tokensTable.tableName],
      // NOTE: the cognito pool id is published by the Identity stack (not here) to
      // avoid a deploy-order cycle with the router-export removal — see
      // identity-stack.ts.
    ];
    for (const [paramId, parameterName, stringValue] of sharedParams) {
      new ssm.StringParameter(this, paramId, { parameterName, stringValue });
    }

    // THE CONTACT COPIES' KEY (C5): the user-profile table's customer managed key for the claims a
    // `claims`-directory issuer's people signed in with. Only the exchange encrypts and only the
    // directory's contact lookup decrypts (lib/constructs/contact-copy.ts).
    // One import of the exchange's role, shared by every grant this stack places on it.
    let importedExchange: iam.IRole | undefined;
    const exchangeRole = (arn: string) => (importedExchange ??= iam.Role.fromRoleArn(this, 'ImportedCredentialExchangeRole', arn, { mutable: true }));
    if (contactCopies) {
      const contactKey = new kms.Key(this, 'ContactCopyKey', {
        description: 'Encrypts the contact claims kept for issuers with no directory of their own',
        enableKeyRotation: true,
        removalPolicy: dataRemovalPolicy,
      });
      new ssm.StringParameter(this, 'SharedContactCopyKeyArnParam', { parameterName: SHARED_SSM.contactCopyKeyArn, stringValue: contactKey.keyArn });
      if (props.credentialExchangeRoleArn) {
        grantContactCopyWrite(exchangeRole(props.credentialExchangeRoleArn), userProfileTable.tableArn, contactKey.keyArn);
      }
    }

    // ============================================================
    // The attachments bucket and the presigned-URL API
    // ============================================================

    this.attachmentsBucket = new s3.Bucket(this, 'AttachmentsBucket', {
      // Bucket name auto-generated by CDK to avoid conflicts
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true, // deny non-TLS access (aws:SecureTransport)
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Keep bucket on stack deletion
      autoDeleteObjects: false, // Don't auto-delete objects
      lifecycleRules: [
        {
          id: 'DeleteOldVersions',
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
        {
          id: 'DeleteOldAttachments',
          expiration: cdk.Duration.days(90), // Keep attachments for 90 days
        },
        // A golden-set upload's entries, before they are de-identified, are handed over here and removed once read; this
        // removes any the import did not, and their versions, within a day (ADR-065 decision 7).
        {
          id: 'ExpireGoldenUploads',
          prefix: 'golden-uploads/',
          expiration: cdk.Duration.days(1),
          noncurrentVersionExpiration: cdk.Duration.days(1),
        },
      ],
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
          ],
          allowedOrigins: [scope.node.tryGetContext('appUrl') || 'http://localhost:5173'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
    });

    // Published for offboarding (Identity), which deploys before this stack and resolves it at runtime,
    // and for the admin credential exchange's attachment reads. Every stack that deploys after this one takes the bucket by reference.
    new ssm.StringParameter(this, 'AttachmentsBucketArnParam', {
      parameterName: SHARED_SSM.attachmentsBucketArn,
      stringValue: this.attachmentsBucket.bucketArn,
      description: 'Attachments bucket ARN — resolved by the credential exchange for the S3 attachment-read session policy',
    });

    // Lambda function to generate presigned URLs.
    //
    // BUNDLED rather than shipped as a raw asset, so it asks the one resolver who called it
    // (`lib/auth.ts` `callerPersonId`) instead of reading the token's claims itself. The AWS SDK stays
    // external, so the runtime's SDK serves it exactly as it served the raw asset.
    this.presignedUrlFunction = new lambdaNodeJs.NodejsFunction(this, 'PresignedUrlFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: 'lambda/presigned-url/index.js',
      handler: 'handler',
      bundling: { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] },
      timeout: cdk.Duration.seconds(10),
      environment: {
        BUCKET_NAME: this.attachmentsBucket.bucketName,
        EXPIRATION_SECONDS: '3600', // 1 hour
        ALLOWED_ORIGIN: this.node.tryGetContext('appUrl') || 'http://localhost:5173',
      },
    });

    // Grant Lambda permissions to generate presigned URLs
    this.attachmentsBucket.grantReadWrite(this.presignedUrlFunction);
    // Who called is the edge authorizer's context, read through the registry (callerPersonId).
    grantIssuerRegistry(this.presignedUrlFunction, props.selfPoolId);
    this.presignedUrlFunction.addEnvironment('APP_INSTANCE_ARN', props.appInstanceArn);
    this.routes.push({
      api: 'person', method: 'POST', path: '/presigned-url', handler: this.presignedUrlFunction, capability: 'core',
      throttle: { rate: 25, burst: 50 },
    });

    new cdk.CfnOutput(this, 'AttachmentsBucketName', {
      value: this.attachmentsBucket.bucketName,
      description: 'S3 bucket for file attachments',
      exportName: `${this.stackName}-BucketName`,
    });

    // OFFBOARDING ERASES A PERSON'S RECORDS HERE (ADR-058, lib/offboarding.ts). The profile row by key; the
    // task partition by a query on its key; the stop records and the budget rows have no index by person,
    // so a scan of those two small, short-lived tables finds them. Delete and read only, nothing that writes;
    // the profile and budget rows are also read by key, for an export of the person (below).
    // And a person's uploads, `attachments/<conversation>/<personId>/`, every version, since the bucket is
    // versioned and a delete marker alone would keep the bytes: the listing is held to the `attachments/`
    // prefix and the deletes to its objects, with no read of an object.
    if (props.offboardingRoleArn) {
      const offboarding = iam.Role.fromRoleArn(this, 'ImportedOffboardingRole', props.offboardingRoleArn, { mutable: true });
      offboarding.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['s3:ListBucket', 's3:ListBucketVersions'],
        resources: [this.attachmentsBucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': ['attachments/*'] } },
      }));
      offboarding.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
        resources: [this.attachmentsBucket.arnForObjects('attachments/*')],
      }));
      offboarding.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:DeleteItem'],
        resources: [userProfileTable.tableArn, userTasksTable.tableArn, turnStateTable.tableArn, abuseControlsTable.tableArn],
      }));
      offboarding.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        // The person's partition, and the rows they own in an assistant's (`ownerPersonId-index`).
        resources: [userTasksTable.tableArn, `${userTasksTable.tableArn}/index/ownerPersonId-index`],
      }));
      // THE TASK RECORDS NAMING THE PERSON: found by a scan (a task is keyed by its id and conversation) and
      // deleted by key. Read and delete only.
      offboarding.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Scan', 'dynamodb:DeleteItem'],
        resources: [agentTasksTable.tableArn],
      }));
      // THE PERSON'S PLACE IN A CONVERSATION'S CONTEXT ROW: found by a scan, read again by key when a host
      // changed it meanwhile, and rewritten in the member identity lookup and the onboarding intake only.
      offboarding.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Scan', 'dynamodb:GetItem'],
        resources: [channelContextTable.tableArn],
      }));
      offboarding.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [channelContextTable.tableArn],
        conditions: { 'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['channelArn', 'memberIdentities', 'onboardingIntake'] } },
      }));
      // AN EXPORT READS WHAT AN ERASURE REMOVES (B13, `lib/person-export.ts`): the profile row, the contact
      // copies and the preferences by key, and the budget rows by key. Reads only, on the same two tables.
      offboarding.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [userProfileTable.tableArn, abuseControlsTable.tableArn],
      }));
      offboarding.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Scan'],
        resources: [turnStateTable.tableArn, abuseControlsTable.tableArn],
      }));
      // A person's own tokens (`reply#`, `unsubscribe#`, `claim#`, and `invitation#`, the ones they issued or
      // are named by): found by a scan, as the stop records are, and deleted by key, those kinds only
      // (`PERSON_TOKEN_KINDS`, lib/offboarding.ts). A deleted invitation is unredeemable.
      offboarding.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['dynamodb:Scan'], resources: [tokensTable.tableArn] }));
      grantTokenKinds(tokensTable, offboarding, ['reply', 'unsubscribe', 'claim', 'invitation'], ['dynamodb:DeleteItem']);
      // PATH B'S REGISTRATION RECORD, found by following a customer conversation's `upgradedFrom` tag
      // (P-12): deleted by its key, and no other kind in `Tokens`.
      if (issuersOf(this).guest() && claimTargetOf(GUEST_VISITOR_TYPE)) {
        grantTokenKinds(tokensTable, offboarding, ['registration'], ['dynamodb:DeleteItem']);
      }
    }

    // ============================================================
    // The conversation routes (on PersonApi)
    // ============================================================

    const appUrl = this.node.tryGetContext('appUrl') || 'http://localhost:5173';

    // EVERY ROUTE BELOW IS A PERSON ROUTE, behind the edge authorizer on `PersonApi`, so no anonymous
    // caller can create channels, impersonate a userArn (taken from the request body), or burn Bedrock
    // spend via the welcome generator. A person whose issuer declares the one-conversation session reaches
    // only `ONE_CHANNEL_ROUTES` there, and is refused again by every handler that does not admit them
    // (`callerPerson`, lib/auth.ts): two layers (tenet D3).

    // ── GET /tasks/mine — the open work items this user owns, across every conversation ──────────
    //
    // It lives HERE, on the existing conversation API, because this stack owns `userTasksTable`. A
    // separate API would mean a second authorizer, a second CORS surface and a cross-stack grant for
    // one read of a table three meters away.
    //
    // The grant is READ ONLY and scoped to that one table. This endpoint never writes: an item is
    // handed over by the assistant that owns the work, and closed by the turn that finishes it, so a
    // client that could write here could fabricate or clear someone's obligations.
    const userTasksApiFn = new lambdaNodeJs.NodejsFunction(this, 'UserTasksApiFunction', {
      entry: './lambda/src/user-tasks-api.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        USER_TASKS_TABLE: userTasksTable.tableName,
        ALLOWED_ORIGIN: appUrl,
        SSM_ROOT,
        // POST /tasks composes the caller's AppInstanceUser ARN from their person id (callerPersonId) and
        // proves membership as that bearer, so it needs the instance it is composing against.
        APP_INSTANCE_ARN: props.appInstanceArn,
        // Where a classification's intent-pack body lives when its parameter holds a pointer.
        PROFILE_BODY_BUCKET: this.attachmentsBucket.bucketName,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    userTasksTable.grantReadData(userTasksApiFn);
    // Who called is the edge authorizer's context, read through the registry (callerPersonId).
    grantIssuerRegistry(userTasksApiFn, props.selfPoolId);

    // ── WHAT THE WRITE HALF NEEDS, AND NOTHING MORE ─────────────────────────────────────────────
    //
    // `DescribeChannel` is the membership proof and is called with the CALLER as `ChimeBearer`, so the
    // grant covers `/user/*` as well as `/channel/*` for the same reason `turnStateApiFn`'s does: a
    // bearer this role may not act as cannot be used, so a channel the caller is not on cannot be
    // described. `ListTagsForResource` reads the authoritative `archived` tag; the Metadata mirror of
    // it is explicitly non-authoritative and a live refusal may not rest on an archived copy.
    //
    // NO DIRECT TASK-TABLE WRITE. The row is written by the task service, which is the second
    // enforcement layer task access carries (tenet D3). Granting this function the table would make
    // that boundary a suggestion.
    userTasksApiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['chime:DescribeChannel', 'chime:ListTagsForResource'],
      resources: [`${props.appInstanceArn}/channel/*`, `${props.appInstanceArn}/user/*`],
    }));

    // ── THE PER-CLASSIFICATION TASK SERVICE, READ BY NAME AT RUNTIME ────────────────────────────
    //
    // NOT `valueForStringParameter`. The classification stacks publish these keys and they deploy
    // AFTER this one, so resolving at synth would fail a first install outright - the cost
    // `agent-classification-common.ts` already records on a different key. Reaching back from the
    // classification stack to add the ARN as an env var is not available either: this function's
    // construct lives in this tree and that stack already depends on this one, so the reference
    // would be a dependency cycle. The handler reads the parameter by name and refuses when absent.
    userTasksApiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/task-service-arn`],
    }));

    // INVOKE BY PATTERN, for the same cycle reason: the service ARNs do not exist at this stack's
    // synth, so they cannot be named. Scoped to this account and region, to this instance's prefix and the construct id the
    // classification stacks give their service, and to this instance's conversational classifications
    // by their tags (`ownInstanceFunctions`), so another instance's services in the account are out of
    // reach. A write targets ONE service - the conversation's - so the breadth of the grant is not the
    // breadth of any single call.
    userTasksApiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${STACK_PREFIX}*TaskService*`],
      conditions: ownInstanceFunctions(EVERY_CLASSIFICATION),
    }));
    // WHAT A STEP NEEDS FROM THE PERSON is declared by each classification's intent pack, so the item
    // list reads every pack, keyed by the assistant that publishes it. Read-only, and only these two
    // parameter names under each classification.
    userTasksApiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/bot-arn`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/assistant-intent-pack`,
      ],
    }));
    // And the pack bodies those parameters point at. Read-only, on the pack key family and nothing else
    // in the bucket; every classification's, for the same reason the parameter read is.
    userTasksApiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [this.attachmentsBucket.arnForObjects(`${CLASSIFICATION_PACK_PREFIX}/*`)],
    }));

    // What is waiting in a conversation, for the client to RENDER rather than reconstruct (ADR-033).
    // Ordering is not a reliable encoding of set membership - a client that reloaded with partial
    // history, joined late, or scrolled a short window all get it wrong - so the record is read
    // directly.
    const turnStateApiFn = new lambdaNodeJs.NodejsFunction(this, 'TurnStateApiFunction', {
      entry: './lambda/src/turn-state-api.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        // THE SAME WIRING THE WRITERS TAKE, from the same context key. This hand-rolled its own
        // environment and set only the table, so `turnQueueEnabled()` was false INSIDE THIS
        // FUNCTION and `readTurnState` returned `{ busy: false, queued: [] }` before it ever looked
        // at the record. The queue worked: turns claimed, messages queued, the notice was posted.
        // Every client that asked what was waiting was told nothing was, so the composer and the
        // transcript rendered an idle conversation over a full queue - the one thing this endpoint
        // exists to prevent. A flag read by the writers and not by the reader is not a feature
        // switch, it is a way for half a feature to ship dark.
        ...turnQueueWiring(this, turnStateTable.tableArn, turnStateTable.tableName).env,
        APP_INSTANCE_ARN: props.appInstanceArn,
        ALLOWED_ORIGIN: appUrl,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    // READ ONLY. This answers a question; it must never be able to change what is waiting, or a
    // client could clear somebody else's queue.
    turnStateTable.grantReadData(turnStateApiFn);
    // Who called is the edge authorizer's context, read through the registry (callerPersonId).
    grantIssuerRegistry(turnStateApiFn, props.selfPoolId);
    // Membership and per-message visibility are decided by Amazon Chime SDK, AS THE CALLER: the
    // handler passes the caller's own bearer, so a non-member's describe fails and a targeted message
    // they are not on cannot be fetched. That is why this grant is on `/user/*` rather than a bot.
    turnStateApiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['chime:DescribeChannel', 'chime:GetChannelMessage'],
      resources: [`${props.appInstanceArn}/channel/*`, `${props.appInstanceArn}/user/*`],
    }));

    // POST /tasks - a person opens a work item in a conversation they are a member of. Authorized at the
    // edge like every other conversation write; the handler then proves MEMBERSHIP with the Amazon Chime
    // SDK as the CALLER, so a token alone is not enough to put work in a room.
    // GET /turn-state?channelArn=...&responderId=... - what is waiting, for this caller. The handler checks
    // MEMBERSHIP with the Amazon Chime SDK as the caller, so a token alone is not enough to ask about a room.
    this.routes.push(
      { api: 'person', method: 'POST', path: '/tasks', handler: userTasksApiFn, capability: 'core', throttle: CONVERSATION_THROTTLE },
      { api: 'person', method: 'GET', path: '/tasks/mine', handler: userTasksApiFn, capability: 'core', throttle: CONVERSATION_THROTTLE },
      // A PERSON TAKES A CHOICE ON THEIR TASK'S CARD (ADR-063 decision 2): no new grant; the task service authorizes it.
      { api: 'person', method: 'POST', path: '/tasks/advance', handler: userTasksApiFn, capability: 'core', throttle: CONVERSATION_THROTTLE },
      { api: 'person', method: 'GET', path: '/turn-state', handler: turnStateApiFn, capability: 'core', throttle: CONVERSATION_THROTTLE },
    );

    // GET /classifications - the deployment's classifications as its clients render them, read from the runtime
    // registry, so the chat app and the admin console render a classification added later with no frontend build.
    // Its only grant is the registry read every function holds (`ProfileRegistryReaders`); the answer holds no secret.
    const classificationsApiFn = new lambdaNodeJs.NodejsFunction(this, 'ClassificationsApiFunction', {
      entry: './lambda/src/classifications-api.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: { ALLOWED_ORIGIN: [...new Set([appUrl, adminOrigin(this)])].join(',') },
      bundling: { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] },
    });
    this.routes.push({
      api: 'person', method: 'GET', path: '/classifications', handler: classificationsApiFn, capability: 'core', throttle: CONVERSATION_THROTTLE,
    });

    const channelFlowArnParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${CHANNEL_FLOW_ARN_SSM_KEY}`;

    // THE ONE IDENTITY EVERY CONVERSATION IS CREATED AS (step 33). No bot-bearing create, tag or
    // membership change: a deployment with no service admin refuses creation rather than creating as an
    // assistant (`NoServiceAdminError` in `lib/channel-creation.ts`).
    const conversationServiceAdminArn = `${props.appInstanceArn}/user/${RES_PREFIX}-admin`;

    // ── EACH CLASSIFICATION'S CONVERSATION CREATOR IS ITS OWN STACK'S ──────
    //
    // A conversation is created by its classification's own creator (`ConversationCreator`,
    // `lib/constructs/conversation-creator.ts`), built by `Assistants-<classification>`. Every caller here
    // finds it by the key that stack publishes and is granted the invoke by the creators' name pattern, this
    // instance's `Instance` tag and the tag the caller is bounded to (`conversationCreatorInvoke`), so
    // declaring a classification changes nothing in this stack.
    //
    // THE CONTEXT CLASSIFICATION: the one the trusted-issuer registry's oneChannel issuers name
    // (lib/config/issuers.ts), at which a host's context conversations are created. Its creator also
    // serves the context request, and its role also holds the re-open reads below.
    const contextClassification = issuersOf(this).contextClassification();
    /** Reads and refreshes, bearing the service admin, of a channel of the context classification only. */
    const contextChannelReads = (sid: string, actions: string[]): iam.PolicyStatement[] => (contextClassification ? [
      new iam.PolicyStatement({
        sid: `${sid}OwnClassificationChannel`,
        actions,
        resources: [`${props.appInstanceArn}/channel/*`],
        conditions: { StringEquals: { 'aws:ResourceTag/classification': contextClassification } },
      }),
      new iam.PolicyStatement({ sid: `${sid}AsTheServiceAdmin`, actions, resources: [conversationServiceAdminArn] }),
    ] : []);
    this.tokensTable = tokensTable;

    // ── A HOST ASSERTION'S `jti` (A9) ────────────────────────────────────────────────────────────
    //
    // The edge authorizer records it (`PutItem`, granted in PersonApi on the construct that owns the
    // function); the credential exchange consumes it, here: `UpdateItem` to set `consumedAt` and `GetItem` to
    // say why a consume was refused, on `assertion-jti#*` alone and never a `PutItem`, so the exchange
    // cannot write a record the edge did not.
    if (issuersOf(this).hostAssertions().length && props.credentialExchangeRoleArn) {
      grantTokenKinds(tokensTable, exchangeRole(props.credentialExchangeRoleArn), ['assertion-jti'], ['dynamodb:GetItem', 'dynamodb:UpdateItem']);
    }

    // ── THE GUEST'S GRANTS, WITH THE RESOURCES (A7, A8) ──────────────────────────────────────────
    //
    // Guest start and refresh run on the credential exchange (Identity), which deploys before this stack, so
    // it reads these by name at runtime and is granted on them here, by reference: its two token kinds,
    // the per-address rows of the abuse-controls table (`guest-ip#`, the salted hash of an address and the
    // window it counts) and the guest classification's creator, which opens a visitor's conversation.
    const guestEntry = issuersOf(this).guest();
    if (guestEntry && props.credentialExchangeRoleArn) {
      const exchange = exchangeRole(props.credentialExchangeRoleArn);
      grantTokenKinds(tokensTable, exchange, ['guest-refresh', 'guest-family', 'guest-bind'], ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']);
      exchange.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'GuestAddressLimit',
        actions: ['dynamodb:UpdateItem'],
        resources: [abuseControlsTable.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['guest-ip#*'] } },
      }));
      // THE GUEST CLASSIFICATION'S CREATOR, which opens a visitor's conversation: found by its key and invoked by
      // the creators' name pattern, bounded to that one classification's function.
      const guestClassification = (guestEntry.clearance as { fixed: string[] }).fixed[0];
      for (const st of conversationCreatorInvoke(this, 'GuestConversationCreate', { StringEquals: { 'aws:ResourceTag/classification': guestClassification } }, guestClassification)) {
        exchange.addToPrincipalPolicy(st);
      }

      // PATH A'S CONTINUATION (P-11): a bind opens the visit's next conversation at the account's own
      // classification, through that classification's creator, so the exchange may invoke a creator a visit can
      // continue at, the one its classification's own stack tags `bindTarget` (`bindTargetOf`), and read its key.
      // The tag is set by that stack, so adding a classification changes nothing here; the creator still checks
      // `bindTargetOf` itself. It reads the visit's registration record, when there is one, for the seed: `GetItem`
      // on that kind alone, and no write.
      if (upgradePathsOf(GUEST_VISITOR_TYPE).includes('bind')) {
        for (const st of conversationCreatorInvoke(this, 'BindContinuesTheVisit', bindTargetCreatorsOnly())) exchange.addToPrincipalPolicy(st);
        grantTokenKinds(tokensTable, exchange, ['registration'], ['dynamodb:GetItem']);
      }
    }

    // ── PATH B: REGISTRATION AND CLAIM (P-12, B6), WHEN A GUEST ISSUER IS DECLARED ─────────────────
    //
    // One function, the writer of the `registration` and `claim` kinds and of no other (A8), and the one
    // caller granted the claim target's creator. `POST /guest/register` takes a guest token (`GUEST_ROUTES`)
    // and `POST /upgrade/claim` a signed-in person's, never answered from the authorizer cache.
    const claimTarget = claimTargetOf(GUEST_VISITOR_TYPE);
    if (guestEntry && claimTarget) {
      const guestClassification = (guestEntry.clearance as { fixed: string[] }).fixed[0];
      const upgradeFn = new lambdaNodeJs.NodejsFunction(this, 'GuestUpgradeFunction', {
        entry: './lambda/src/guest-upgrade.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        // A claim assesses the visit (a model call, bounded at 8 s) before it opens the conversation, inside
        // the HTTP API's 30-second integration limit.
        timeout: cdk.Duration.seconds(28),
        memorySize: 256,
        bundling: { minify: false, forceDockerBundling: false },
        environment: {
          APP_INSTANCE_ARN: props.appInstanceArn,
          TOKENS_TABLE: tokensTable.tableName,
          // The claim target's creator opens the conversation, and the visitor's own assesses and retires the
          // visit; each is found by its classification's key at call time.
          CONVERSATION_CREATOR_PARAM_ROOT,
          GUEST_CLASSIFICATION: guestClassification,
          // Where the claim email's sign-in link lands, and whether a registration waits for an operator.
          APP_URL: appUrl,
          REGISTRATION_APPROVAL: registrationApproval,
        },
      });
      grantTokenKinds(tokensTable, upgradeFn.role!, ['registration', 'claim'], ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']);
      for (const st of [
        ...conversationCreatorInvoke(this, 'OpenTheClaimedConversation', { StringEquals: { 'aws:ResourceTag/classification': claimTarget.classification } }, claimTarget.classification),
        ...conversationCreatorInvoke(this, 'AssessAndRetireTheVisit', { StringEquals: { 'aws:ResourceTag/classification': guestClassification } }, guestClassification),
      ]) upgradeFn.addToRolePolicy(st);
      if (registrationApproval === 'admin') {
        upgradeFn.addToRolePolicy(new iam.PolicyStatement({
          sid: 'ListTheRegistrationsAwaitingApproval',
          actions: ['dynamodb:Query'],
          resources: [`${tokensTable.tableArn}/index/${REGISTRATIONS_AWAITING_APPROVAL}`],
        }));
      }
      // THE ONE EMAIL, the account's sign-in link, as the transactional `claim` kind, sent by `Notifications`.
      nameTransactionalMail(upgradeFn, props.transactionalMail);
      this.guestUpgradeFunction = upgradeFn;
      grantIssuerRegistry(upgradeFn, props.selfPoolId);
      // THE FUNNEL'S PATH B STAGES (B12): a claim issued, and a claim redeemed.
      grantServerEventAppend(upgradeFn, 'UpgradeFunnel');
      this.routes.push(
        { api: 'person', method: 'POST', path: '/guest/register', handler: upgradeFn, capability: 'core', throttle: CONVERSATION_THROTTLE },
        { api: 'person', method: 'POST', path: '/upgrade/claim', handler: upgradeFn, capability: 'core', throttle: CONVERSATION_THROTTLE },
      );
    }

    // ── INVITATIONS (M-10, M-5, B8) ──────────────────────────────────────────────────────────────
    //
    // One function, the writer of the `invitation` kind and of no other (A8), and the one caller granted
    // the credential exchange's invoke, which mints each invitee. It proves the inviter's membership as
    // the inviter (`DescribeChannel` bearing them), reads the conversation's tags and its context row, adds
    // and removes the invitee as the service admin in a conversation of a member classification, asks
    // whether a member moderates, and sends the one transactional email. The exchange reads and redeems
    // the records, on `invitation#*` alone, and never writes a new one. Every deployment passes the exchange;
    // a stack built on its own (a test of another of its parts) issues no invitation.
    // A DEPLOYMENT WITH NO MEMBER CONVERSATION (a guest-only widget, whose classifications are all outside)
    // has nothing to invite anyone into, so it issues no invitation and builds no invitations function.
    const minter = props.credentialExchangeFunctionArn;
    const memberClassifications = profiles.memberClassificationValues().filter((c) => profiles.isConversational(c));
    if (minter && memberClassifications.length) {
      const invitationsFn = new lambdaNodeJs.NodejsFunction(this, 'InvitationsFunction', {
        entry: './lambda/src/invitations.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(20),
        memorySize: 256,
        bundling: { minify: false, forceDockerBundling: false },
        environment: {
          APP_INSTANCE_ARN: props.appInstanceArn,
          TOKENS_TABLE: tokensTable.tableName,
          CHANNEL_CONTEXT_TABLE: channelContextTable.tableName,
          CREDENTIAL_EXCHANGE_FUNCTION: minter,
          ADMIN_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn,
          ALLOWED_ORIGIN: appUrl,
          // THE LANDING PAGE (`invite.html`) IS ON THE CLIENT `invitationLandingFor` NAMES: the chat app.
          INVITATION_LANDING_ORIGIN: invitationLandingFor(this).origin,
          ...(props.invitationLinkReach?.length ? { INVITATION_LINK_REACH: JSON.stringify(props.invitationLinkReach) } : {}),
          INSTANCE_NAME: INSTANCE_NAME,
        },
      });
      grantTokenKinds(tokensTable, invitationsFn.role!, ['invitation'], ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem']);
      invitationsFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'ListAConversationsInvitations',
        actions: ['dynamodb:Query'],
        resources: [`${tokensTable.tableArn}/index/${INVITATIONS_BY_CHANNEL}`],
      }));
      invitationsFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'ReadTheConversationsType',
        actions: ['dynamodb:GetItem'],
        resources: [channelContextTable.tableArn],
      }));
      // THE INVITEE'S PARTICIPANT ROLE (DESIGN-CONVERSATION-TYPES section 6.1): the one attribute of the context row this
      // function writes, its `participantRoles` holdings, and no other field of the row.
      invitationsFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'RecordTheInviteesParticipantRole',
        actions: ['dynamodb:UpdateItem'],
        resources: [channelContextTable.tableArn],
        conditions: {
          'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['channelArn', 'participantRoles'] },
          StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'] },
        },
      }));
      invitationsFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'MintTheInvitee',
        actions: ['lambda:InvokeFunction'],
        resources: [minter],
      }));
      // MEMBERSHIP AS THE CALLER, and the conversation's tags.
      invitationsFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'TheInvitersMembership',
        actions: ['chime:DescribeChannel', 'chime:ListTagsForResource'],
        resources: [`${props.appInstanceArn}/channel/*`, `${props.appInstanceArn}/user/*`],
      }));
      for (const st of membershipAsServiceAdminStatements('InviteeMembership', props.appInstanceArn, EVERY_CLASSIFICATION, conversationServiceAdminArn,
        // A participant role that confers `moderator` makes its invitee a moderator, and revoking takes that back.
        ['chime:CreateChannelMembership', 'chime:DeleteChannelMembership', 'chime:DescribeChannelModerator', 'chime:CreateChannelModerator', 'chime:DeleteChannelModerator'])) {
        invitationsFn.addToRolePolicy(st);
      }
      invitationsFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${INSTANCE_SSM.appInstanceAdminArn}`],
      }));
      grantIssuerRegistry(invitationsFn, props.selfPoolId);
      // THE ONE EMAIL, as the transactional `invitation` kind, sent by `Notifications`.
      nameTransactionalMail(invitationsFn, props.transactionalMail);
      // `invitation-sent` IS NAMED TO THE ROUTER of the conversation's classification (ADR-061 decision 1), found by
      // name at call time: only the routers of the classifications a person may be invited into, by their `audience`
      // tag rather than a list, so adding a classification changes no grant here. Nothing about a router lets this
      // function speak, because the router verifies the invitation's record before anything runs.
      for (const st of memberRoutersByNameStatements(this, 'NameANoticeToTheRouter')) invitationsFn.addToRolePolicy(st);
      for (const [k, v] of Object.entries(routerByNameEnvironment())) invitationsFn.addEnvironment(k, v);
      this.invitationsFunction = invitationsFn;
      this.routes.push(
        { api: 'person', method: 'POST', path: '/invitations', handler: invitationsFn, capability: 'core', throttle: CONVERSATION_THROTTLE },
        { api: 'person', method: 'GET', path: '/invitations', handler: invitationsFn, capability: 'core', throttle: CONVERSATION_THROTTLE },
        { api: 'person', method: 'POST', path: '/invitations/revoke', handler: invitationsFn, capability: 'core', throttle: CONVERSATION_THROTTLE },
      );
    }
    // ── PROPOSALS (ADR-061 decision 8, rule 8): THE APPLY ENDPOINT ─────────────────────────────────────────────
    //
    // A person applies or declines a proposal an agent step addressed to them (`proposals-api.ts`). It reads and
    // consumes `proposal#*` records alone, proves the caller's membership as the caller (`DescribeChannel` bearing
    // them), reads the conversation's tags and its participant-role holdings, and performs the act holding grants the
    // assistant does not: the invitations function's reminder, and a member classification's typed creator, found by
    // its fixed name and bounded by its `audience` tag to this instance's member conversations, naming no list. Each grant is
    // deny-tested in `a-proposal-is-applied-once-by-its-addressee.test.ts`.
    if (memberClassifications.length) {
      const proposalsFn = new lambdaNodeJs.NodejsFunction(this, 'ProposalsFunction', {
        entry: './lambda/src/proposals-api.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        bundling: { minify: false, forceDockerBundling: false },
        environment: {
          APP_INSTANCE_ARN: props.appInstanceArn,
          TOKENS_TABLE: tokensTable.tableName,
          CHANNEL_CONTEXT_TABLE: channelContextTable.tableName,
          ALLOWED_ORIGIN: appUrl,
          TYPED_CREATOR_NAME_PATTERN: `${STACK_PREFIX}Assistants-{classification}-TypedCreator`,
          ...(this.invitationsFunction ? { INVITATIONS_FUNCTION: this.invitationsFunction.functionName } : {}),
        },
      });
      grantTokenKinds(tokensTable, proposalsFn.role!, ['proposal'], ['dynamodb:GetItem', 'dynamodb:UpdateItem']);
      proposalsFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'ReadTheParticipantRoleHoldings',
        actions: ['dynamodb:GetItem'],
        resources: [channelContextTable.tableArn],
        conditions: { 'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['channelArn', 'conversationType', 'participantRoles'] } },
      }));
      proposalsFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'TheDecidersMembership',
        actions: ['chime:DescribeChannel', 'chime:ListTagsForResource'],
        resources: [`${props.appInstanceArn}/channel/*`, `${props.appInstanceArn}/user/*`],
      }));
      if (this.invitationsFunction) {
        proposalsFn.addToRolePolicy(new iam.PolicyStatement({
          sid: 'SendAConfirmedReminder',
          actions: ['lambda:InvokeFunction'],
          resources: [this.invitationsFunction.functionArn],
        }));
      }
      proposalsFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'OpenAConfirmedConversation',
        actions: ['lambda:InvokeFunction'],
        resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${STACK_PREFIX}Assistants-*-TypedCreator`],
        conditions: ownInstanceMemberConversationFunctions(),
      }));
      this.routes.push(
        { api: 'person', method: 'POST', path: '/proposals/apply', handler: proposalsFn, capability: 'core', throttle: CONVERSATION_THROTTLE },
      );
    }

    // THE EXCHANGE READS AND REDEEMS AN INVITATION (`lib/invitation-redemption.ts`): `GetItem` for the
    // landing page and the redemption's checks, `UpdateItem` for the one conditional consume. Never a put.
    if (props.credentialExchangeRoleArn) {
      grantTokenKinds(tokensTable, exchangeRole(props.credentialExchangeRoleArn), ['invitation'], ['dynamodb:GetItem', 'dynamodb:UpdateItem']);
    }

    // THE API: it authenticates the person, applies the reach gate, the admin-plane refusal and the TTL
    // limit, and invokes the requested classification's creator. It holds no Amazon Chime SDK grant.
    // EVERY MEMBERS CLASSIFICATION'S CREATOR, and never an outside one's: a person never opens a visitor's
    // conversation, and only guest start may ask the guest creator for one. A guest-only deployment has no
    // member creator, so the API holds no invoke and opens no conversation.
    const memberConversational = profiles.memberClassificationValues().some((c) => profiles.isConversational(c));
    const createConversationApiRole = new iam.Role(this, 'CreateConversationApiRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: memberConversational ? {
        InvokeTheClassificationsCreators: new iam.PolicyDocument({
          statements: conversationCreatorInvoke(this, 'InvokeAMemberClassificationsCreator', memberCreatorsOnly()),
        }),
      } : {},
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // ── BUNDLED, WHICH IS THE WHOLE POINT (ADR-053 consolidation) ────────────────────────────────
    //
    // This was `lambda.Function` + `Code.fromAsset('lambda/create-conversation')`, raw JavaScript that
    // could not import `lib/*`. That is why it was handed the registry's decision data as
    // `CLASSIFICATION_ADMISSION_JSON` and its default retention as env vars mirrored out of the
    // conversation-type registry. Bundled, the handler calls the registry directly, and the creators
    // apply the type's own `expiration`, so both mirrors are deleted rather than maintained.
    //
    // THE CONSTRUCT ID SAYS WHAT THIS FUNCTION IS, which is a conversation API and not a channel one;
    // the route is `/create-conversation` and the entry is `create-conversation.ts`.
    const createConversationFunction = new lambdaNodeJs.NodejsFunction(this, 'CreateConversationFunction', {
      entry: './lambda/src/create-conversation.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(20),
      // 1024 MB, for the CPU it buys: a cold open is mostly first-call SDK work, which at 256 MB ran on about a
      // seventh of a vCPU (docs/guides/developer/PERFORMANCE-OPTIMIZATION.md, "Opening a conversation").
      memorySize: 1024,
      bundling: { minify: false, forceDockerBundling: false },
      environment: {
        APP_INSTANCE_ARN: props.appInstanceArn,
        ...(props.selfPoolId ? { USER_POOL_ID: props.selfPoolId } : {}),
        // Each member classification's creator, found by its key at call time.
        CONVERSATION_CREATOR_PARAM_ROOT,
      },
      role: createConversationApiRole,
    });

    // Who called is the edge authorizer's context, read through the registry (callerPersonId). Every issuer
    // reaches it, the one-conversation ones included: it is one of `ONE_CHANNEL_ROUTES`.
    grantIssuerRegistry(createConversationFunction, props.selfPoolId);
    this.routes.push({
      api: 'person', method: 'POST', path: '/create-conversation', handler: createConversationFunction, capability: 'core',
      throttle: CONVERSATION_THROTTLE,
    });

    // ============================================================
    // Conversation management — moderator archive / member removal / self-leave
    // (SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md, ADR-017). One Cognito-JWT
    // Lambda that authorizes per operation (live ChannelModerator check) then
    // acts as the app-instance-admin bearer. The `archived` tag it sets is what
    // the Phase-2 IAM read-only Deny keys on.
    // ============================================================

    // Durable audit trail for archive / remove / leave (actor, op, target, channel).
    // A small dedicated table (spec "Audit" — the lighter of the two options); keeps
    // this feature self-contained rather than coupling to the analytics store.
    const conversationActionsTable = new dynamodb.Table(this, 'ConversationActionsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: dataRemovalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // The archive notice is named to the router of the conversation's classification, read by name at
    // call time because the classification stacks that publish the router ARNs deploy after this one.
    const managementNotices = sayThroughRouterWiring(this, EVERY_CLASSIFICATION);
    const conversationMgmtRole = new iam.Role(this, 'ConversationManagementRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            // Acting as the app-instance-admin bearer: read the live moderator list (authorization),
            // drop moderators, and remove memberships. This is the admin plane, deliberately NOT
            // archived-tag-gated. Archive also mirrors `archived:true` into channel Metadata as a
            // NON-authoritative display hint (DescribeChannel to preserve, then UpdateChannel); the tag
            // stays the IAM authority.
            //
            // IN A CLASSIFIED CHANNEL, BEARING THE SERVICE ADMIN: any
            // declared classification, because archive, remove and leave serve every conversation, and
            // the admin by its exact ARN, never `/user/*` (any person) or the app instance.
            ...adminPlaneMembershipStatements('ConversationManagement', props.appInstanceArn, {
              bearerArns: [conversationServiceAdminArn],
              channelClassifications: EVERY_CLASSIFICATION,
              actions: [
                'chime:ListChannelModerators',
                'chime:DeleteChannelModerator',
                'chime:DeleteChannelMembership',
                'chime:DescribeChannel',
                'chime:UpdateChannel',
              ],
            }),
            // NO ADD, AND AN ADD NEVER INTO AN OUTSIDE CONVERSATION (tenet D3). This role serves a member's and a
            // customer's own leave, a moderator's removal and archive, and the console's archive, so the grant
            // above reaches every conversation by its classification tag, outside ones included, with no
            // audience condition. It holds no membership add, and an add is denied on a channel whose audience
            // is `outside` or absent, so an add granted here later is still refused there by IAM, under the
            // handler, while the removals and the archive keep working on every conversation.
            ...neverAnOutsideConversation('ConversationManagementAdds', props.appInstanceArn, [...CONVERSATION_MANAGEMENT_ADDS]),
            // Read the classification tag before anything is decided: a read of the channel's tags,
            // which takes no bearer, on any channel so an untagged one is reported rather than denied.
            new iam.PolicyStatement({
              actions: ['chime:ListTagsForResource'],
              resources: [`${props.appInstanceArn}/channel/*`],
              effect: iam.Effect.ALLOW,
            }),
            // Setting the `archived` tag, on a channel and never on an assistant identity: TagResource
            // on an existing resource takes no bearer, so nothing here needs to reach a bot.
            // THE `archived` KEY AND NO OTHER: every key the request
            // writes must be `archived`, so this grant can never write a conversation's `classification`
            // (or its primary, or its type).
            new iam.PolicyStatement({
              sid: 'ArchiveTagOnly',
              actions: ['chime:TagResource'],
              resources: [`${props.appInstanceArn}/channel/*`],
              conditions: { 'ForAllValues:StringEquals': { 'aws:TagKeys': ['archived'] } },
              effect: iam.Effect.ALLOW,
            }),
            // NO SEND. The archive notice is named to the room's router, which says it as the room's
            // assistant (`sayThroughRouter`), so this role posts nothing and holds no session.
            ...managementNotices.statements,
            // The archiver's name as the room shows it: their AppInstanceUser record.
            new iam.PolicyStatement({
              actions: ['chime:DescribeAppInstanceUser'],
              resources: [`${props.appInstanceArn}/user/*`],
              effect: iam.Effect.ALLOW,
            }),
          ],
        }),
        SSMPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // The app-instance-admin ARN used as ChimeBearer (published by Messaging).
              actions: ['ssm:GetParameter'],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${INSTANCE_SSM.appInstanceAdminArn}`],
            }),
            new iam.PolicyStatement({
              // The assistant's configured words for the notice (`conversationArchived`). Refused, the
              // notice falls back to the shipped line.
              actions: ['ssm:GetParameter', 'ssm:GetParameterHistory'],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/definition`],
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    conversationActionsTable.grantWriteData(conversationMgmtRole);

    const conversationMgmtFn = new lambdaNodeJs.NodejsFunction(this, 'ConversationManagementFunction', {
      entry: './lambda/src/conversation-management.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      role: conversationMgmtRole,
      environment: {
        APP_INSTANCE_ARN: props.appInstanceArn,
        ADMIN_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn,
        AUDIT_TABLE: conversationActionsTable.tableName,
        ...managementNotices.env,
        // The admin console calls this function too, to archive from the console (admin API, IAM).
        ALLOWED_ORIGIN: [...new Set([appUrl, adminOrigin(this)])].join(','),
      },
      bundling: { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] },
    });
    // The admin API routes `archive-conversation` to this same function, so archiving has one sequence
    // whoever asks. Published by name rather than exported, so the admin stack's deploy order is free.
    new ssm.StringParameter(this, 'ConversationManagementFunctionArn', {
      parameterName: `${SSM_ROOT}/admin/conversation-management-function-arn`,
      stringValue: conversationMgmtFn.functionArn,
    });

    // Who called is the edge authorizer's context, read through the registry (callerPersonId).
    grantIssuerRegistry(conversationMgmtFn, props.selfPoolId);
    this.conversationManagementFunction = conversationMgmtFn;
    for (const action of ['archive', 'remove-member', 'leave']) {
      this.routes.push({
        api: 'person', method: 'POST', path: `/conversations/${action}`, handler: conversationMgmtFn, capability: 'core',
        throttle: CONVERSATION_THROTTLE,
      });
    }


    // --- A host's membership changes in its context conversations ---
    // A host app adds or removes a person in one of its context conversations AFTER its own access check,
    // by invoking this function directly (lambda:InvokeFunction): IAM, the host's invoke grant, is the
    // authorization boundary, so membership is a projection of the host's access list. No public route,
    // no end-user token, no shared secret, no bare-channel-membership trust. ADD enrols the target as a
    // DEFAULT member (never a moderator) and the room's primary greets them; REMOVE evicts. The person is
    // named by issuer and subject and resolved through the trusted-issuer registry and Identities.
    //
    // Stood up when the registry declares a oneChannel issuer, whose context classification it serves.
    if (contextClassification) {
      const membershipRole = new iam.Role(this, 'ConversationMembershipRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        inlinePolicies: {
          // CREATE AND ADD as the service admin, EVICT as the assistant, in the context classification's
          // conversations only. The join notice and greeting are named to the router, so this role holds
          // no send.
          ChimePolicy: new iam.PolicyDocument({
            statements: [
              // ADD CREATES THROUGH THE SHARED CREATOR, AS THE SERVICE ADMIN:
              // every bearer leg is the admin's exact ARN, and every membership change is held only on a
              // channel of this classification.
              ...driftChannelCreateStatements(contextClassification as Classification, props.appInstanceArn, this.region, this.account, conversationServiceAdminArn, { linkPostedOnSession: true }),
              // REMOVE EVICTS BEARING THIS CLASSIFICATION'S ASSISTANT, a moderator of the room, in this
              // classification's conversations only (step 24).
              ...membershipAsAssistantStatements('ContextEvictAsAssistant', props.appInstanceArn,
                [contextClassification], ['chime:DeleteChannelMembership']),
              // READ BEFORE THAT WRITE, in an existing conversation: `UpdateChannel` replaces Metadata
              // wholesale, so the handler describes the channel first and merges.
              ...contextChannelReads('ContextRefresh', ['chime:UpdateChannel', 'chime:DescribeChannel']),
            ],
          }),
          // The join line and the welcome are named to the router (`sayThroughRouter`); this role speaks as nobody.
          NameANotice: new iam.PolicyDocument({
            statements: sayThroughRouterWiring(this, [contextClassification]).statements,
          }),
          SSMPolicy: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ['ssm:GetParameter'],
                resources: [
                  channelFlowArnParamArn,
                  `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/bot-arn`,
                  // THE SERVICE ADMIN add creates and adds as. Named: it is an identity.
                  `arn:aws:ssm:${this.region}:${this.account}:parameter${INSTANCE_SSM.appInstanceAdminArn}`,
                ],
              }),
            ],
          }),
        },
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        ],
      });
      // Add writes the private host grounding to the server-only store, never channel Metadata.
      channelContextTable.grant(membershipRole, 'dynamodb:UpdateItem');
      const membershipFn = new lambdaNodeJs.NodejsFunction(this, 'ConversationMembershipFunction', {
        entry: './lambda/src/conversation-management.ts',
        handler: 'membershipHandler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        role: membershipRole,
        environment: {
          ...sayThroughRouterWiring(this, [contextClassification]).env,
          SSM_ROOT,
          APP_INSTANCE_ARN: props.appInstanceArn,
          CHANNEL_FLOW_ARN_PARAM: CHANNEL_FLOW_ARN_SSM_KEY,
          // THE SERVICE ADMIN CREATES AND ADDS, so the channel flow is attached before any assistant is
          // a member and every welcome passes through it (`lib/channel-creation.ts`).
          CREATOR_BEARER_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn,
          CONTEXT_CLASSIFICATION: contextClassification,
          CHANNEL_CONTEXT_TABLE: channelContextTable.tableName,
        },
        bundling: { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] },
      });
      // The host names a person by issuer and subject; they become the AppInstanceUser they sign in as
      // through the registry and Identities, exactly as at sign-in, and one never signed in is refused.
      grantDirectoryRead(membershipFn, { appInstanceArn: props.appInstanceArn, userPoolId: props.selfPoolId, poolReads: [] });
      // AN ADD ADMITS ONLY A PERSON WHO MAY STILL SIGN IN, asked of their issuers' pools now
      // (`accountStateOfPerson`; SPEC-CREDENTIAL-EXCHANGE §4b).
      grantAccountStateRead(this, membershipFn, props.selfPoolId);

      // No API route: the host backend is granted lambda:InvokeFunction on this ARN (host side).
      new cdk.CfnOutput(this, 'ConversationMembershipFunctionArn', {
        value: membershipFn.functionArn,
        description: 'Host direct-invoke membership change ({ op: add | remove, ... }) for context conversations',
      });
    }

    // ============================================================
    // Outputs
    // ============================================================

    new cdk.CfnOutput(this, 'AgentTasksTableName', {
      value: agentTasksTable.tableName,
      description: 'DynamoDB table for agent tasks',
    });

    new cdk.CfnOutput(this, 'UserTasksTableName', {
      value: userTasksTable.tableName,
      description: 'DynamoDB table for user tasks',
    });

    // PUBLISHED SO THE HARNESS CAN FIND IT. Every e2e that asserts a conversation's private
    // grounding has to read this row, and with no output the only ways to locate it were an env var a
    // human set by hand or a table scan by name guess. A spec that cannot find the table SKIPS, and a
    // skip that looks like a pass is how a guard stops guarding.
    new cdk.CfnOutput(this, 'ChannelContextTableName', {
      value: channelContextTable.tableName,
      description: 'DynamoDB table for per-conversation private grounding (server-only)',
    });

    new cdk.CfnOutput(this, 'UserProfileTableName', {
      value: userProfileTable.tableName,
      description: 'DynamoDB table for per-user profiles (onboarding state + facts); reference stand-in',
    });



    // ============================================================
    // User Feedback: the thumbs table and its API
    // ============================================================
    // Thumbs up/down on an assistant reply is a product feature with no identity relationship, so the
    // table and its route live with the conversation state rather than in the identity stack.
    const feedbackOrigins = sharedOrigins(this);
    this.feedbackTable = new dynamodb.Table(this, 'UserFeedbackTable', {
      partitionKey: { name: 'feedbackId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: dataRemovalPolicy,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });
    // NO INDEX BY VOTER. Offboarding keeps a person's thumbs, still carrying their AppInstanceUser id, so
    // nothing needs to find them by person (ADR-058).
    const feedbackTable = this.feedbackTable;

    const feedbackRole = new iam.Role(this, 'UserFeedbackRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        FeedbackDdb: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // Submit only. The summary that reads every vote is the admin backend's
              // (`AdminServices`), which reads this table by reference.
              actions: ['dynamodb:PutItem'],
              resources: [feedbackTable.tableArn],
            }),
          ],
        }),
        // Caller-membership check uses the caller's own AppInstanceUser ARN as
        // ChimeBearer (allowed for self-membership-lookup by Chime); no bot SSM
        // lookup needed.
        FeedbackChime: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['chime:DescribeChannelMembership'],
              resources: [`${props.appInstanceArn}/*`],
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const feedbackFn = new lambdaNodeJs.NodejsFunction(this, 'UserFeedbackFunction', {
      entry: './lambda/src/user-feedback.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      role: feedbackRole,
      environment: {
        FEEDBACK_TABLE: feedbackTable.tableName,
        ALLOWED_ORIGIN: feedbackOrigins.join(','),
        // M4: needed for the channel-membership check before recording feedback.
        APP_INSTANCE_ARN: props.appInstanceArn,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    // Who called is the edge authorizer's context, read through the registry (callerPersonId).
    grantIssuerRegistry(feedbackFn, props.selfPoolId);
    // POST is person-level: any signed-in person submits feedback. The summary an administrator reads is
    // the `AdminServices` stack's (`view-analytics`), on `AdminApi`.
    this.routes.push({
      api: 'person', method: 'POST', path: '/feedback', handler: feedbackFn, capability: 'core',
      throttle: { rate: 15, burst: 30 },
    });

    // ============================================================
    // A person's own language (ADR-062 decision 4): GET and POST /me/language
    // ============================================================
    //
    // The chat app's Account settings over `preferences.preferredLanguage` on the person's user-profile row, which the
    // router and the processor read as `person:preferredLanguage`. The person is the caller the edge resolved, never
    // the request's (`language-preference-api.ts`). Two layers: this role reads only a row's `preferences` and writes
    // only `preferences` and `updatedAt`, and is denied every item whose key carries a `#` (a person's notice
    // preferences, contact copies), so it reaches no onboarding answer and no other record.
    const languagePreferenceFn = new lambdaNodeJs.NodejsFunction(this, 'LanguagePreferenceFunction', {
      entry: './lambda/src/language-preference-api.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        USER_PROFILE_TABLE: userProfileTable.tableName,
        APP_INSTANCE_ARN: props.appInstanceArn,
        ALLOWED_ORIGIN: appUrl,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    grantIssuerRegistry(languagePreferenceFn, props.selfPoolId);
    languagePreferenceFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadOwnLanguagePreference',
      actions: ['dynamodb:GetItem'],
      resources: [userProfileTable.tableArn],
      conditions: {
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['personId', 'preferences'] },
        StringEqualsIfExists: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
      },
    }));
    languagePreferenceFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'WriteOwnLanguagePreference',
      actions: ['dynamodb:UpdateItem'],
      resources: [userProfileTable.tableArn],
      conditions: { 'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['personId', 'preferences', 'updatedAt'] } },
    }));
    languagePreferenceFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'NeverAnotherKindOfProfileItem',
      effect: iam.Effect.DENY,
      actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
      resources: [userProfileTable.tableArn],
      conditions: { 'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': ['*#*'] } },
    }));
    for (const method of ['GET', 'POST'] as const) {
      this.routes.push({
        api: 'person', method, path: '/me/language', handler: languagePreferenceFn, capability: 'core',
        throttle: { rate: 10, burst: 20 },
      });
    }

    cdk.Tags.of(this).add('Component', 'Conversations');
  }
}

/**
 * THE INVITATION AND CLAIM EMAILS ARE SENT BY `Notifications`, which holds the deployment's only SES send
 * grant (ADR-055). Where `notifications` is declared, the function is told the `TransactionalMail` function by
 * its fixed name, its environment being the capability's one attach point here; the invoke grant is attached to
 * this function's role by `Notifications` itself. Where it is not, the function names no mail function and
 * answers each link as not emailed, with no call.
 */
function nameTransactionalMail(fn: lambda.Function, declared: boolean | undefined): void {
  if (declared) fn.addEnvironment('TRANSACTIONAL_MAIL_FUNCTION', CAPABILITY_RESOURCES.transactionalMail);
}
