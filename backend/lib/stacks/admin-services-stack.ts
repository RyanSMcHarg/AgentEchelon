/**
 * ADMIN SERVICES (`<prefix>AdminServices`): every admin handler, the admin credential exchange and its roles,
 * and the admin alert channel. The `admin` capability; with `AdminApp` it is the admin backend and console,
 * present or absent as one unit (D7).
 *
 * THE ADMIN BACKEND SITS ON THE CORE, AND NOTHING IN THE CORE KNOWS IT EXISTS. It takes what it needs from
 * the core stacks by reference (the pool, `Identities`, the access log, the offboarding function, the
 * attachments bucket, the feedback table, the archive and its VPC) and from the capabilities it
 * administers (the experiments table, the battle outcome table). No core stack reads anything of this one:
 * a core alert is an `ae.alert` event on the default bus, and the one rule that posts it into the admin
 * channel is here (L2). A deployment without `admin` has no admin handler, route, role or table anywhere.
 *
 * What it holds:
 *  - the admin notification channel, the admin assistant that owns it, and the `ae.alert` rule and poster;
 *  - the admin credential exchange (console sessions, per-conversation admin credentials, a team member's
 *    attachment read), the admin-plane role, the console roles and the team attachment role (L3), and the
 *    access log read;
 *  - user management, the admin-conversation sync and the team-members group (the admin console app client
 *    is the Identity stack's, beside the pool, because both APIs' edge authorizers check its audience);
 *  - the admin conversation read plane and the operator task routes;
 *  - assistant administration: profiles, ownership and the roster, and experiments when declared;
 *  - the admin analytics query (a VPC function in the archive's VPC in Aurora mode) and the feedback summary.
 *
 * OFFBOARDING IS NOT HERE (D9). It is identity: the console's delete asks the `Identity` stack's one
 * `OffboardingFunction`, which runs on the one role holding offboarding's grants.
 *
 * ROUTES ARE DATA (`routes`), served by `AdminApi` (`admin-api-stack.ts`): one HTTP API behind IAM, with the
 * console session on the admin edge authorizer. This stack holds no API, and `AdminApi` grants the console
 * roles on its routes from the capability catalog.
 */
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { permissionsBoundary } from '../constructs/permissions-boundary';
import { exchangeRoleName } from '../constructs/exchange-role';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { adminAuthEnv } from '../constructs/admin-auth-mode';
import { adminOrigin } from '../config/app-origins';
import { ADMIN_CAPABILITIES, ADMIN_ROLE_GROUP, vendRoutePath, type AdminRole } from '../config/admin-capabilities';
import { ADMIN_CONSOLE_ROLE_NAME, adminRoute } from '../constructs/admin-role-grants';
import { grantAssistantScopeCheck } from '../constructs/assistant-scope-grants';
import { grantAccountStateRead, grantDirectoryRead } from '../constructs/directory-access';
import { MEMBERSHIP_AUDIT_FN_NAME } from '../constructs/membership-audit';
import { issuersOf, trustedIssuersJson } from '../constructs/trusted-issuers';
import { guestSettingsOf } from '../config/issuers';
import type { RouteSource, RouteSpec } from '../constructs/http-api';
import { AdminAssistantAdministration } from '../constructs/admin-assistant-administration';
import { AdminAnalytics } from '../constructs/admin-analytics';
import { DeclaredAssistantsSeed } from '../constructs/declared-assistants-seed';
import { defaultProfileRegistry as profiles } from '../profile-registry';
import {
  ALERT_SOURCE,
  ANALYTICS_DB_NAME,
  ANALYTICS_PREFIX,
  ATHENA_WORKGROUP_NAME,
  INSTANCE_NAME,
  INSTANCE_SSM,
  SHARED_SSM,
  SSM_ROOT,
  STACK_PREFIX,
  adminPlaneMembershipStatements,
  createOwnClassificationOnly,
  guestKillSwitchParameter,
  ownInstanceFunctions,
  serviceAdminArnOf,
  tagOnCreateStatements,
  taskServiceByNameEnvironment,
  taskServiceByNameStatements,
  EVERY_CLASSIFICATION,
  messageTemplateReadStatements,
} from './agent-classification-common';
import type { ArchiveStackAurora } from './archive-stack-aurora';
import { TEAM_MEMBERS_GROUP_PRECEDENCE } from '../config/profiles';
import { templateFamilyPrefix, templatePointerPath } from '../../lambda/src/lib/template-store';
import { ADMIN_NOTICE_ASSISTANT, ADMIN_NOTICE_CLASSIFICATION } from '../../lambda/src/lib/admin-notice-templates';

/** The team-members group's Cognito precedence, which no classification may declare (`validateProfilesConfig`). */
export const TEAM_MEMBERS_PRECEDENCE = TEAM_MEMBERS_GROUP_PRECEDENCE;

export interface AdminServicesStackProps extends cdk.StackProps {
  /** The Amazon Chime SDK app instance (Messaging). */
  appInstanceArn: string;
  /** The service app-instance-admin (Messaging): adds the admins to the admin channel, and never joins. */
  appInstanceAdminArn: string;
  /** This deployment's own pool (Identity), when the registry declares an issuer on it (L15). */
  userPool?: cognito.IUserPool;
  /** The pool's id, or `''` for a deployment with no pool of its own. */
  selfPoolId: string;
  /** The conversation-management function (Conversations): the console's archive route reaches it. */
  conversationManagementFunction: lambda.IFunction;
  /** The invitations function (Conversations): the console lists and revokes a conversation's invitations through it. */
  invitationsFunction?: lambda.IFunction;
  /** Path B's function (Conversations): the console lists and approves visitors' registrations through it. */
  guestUpgradeFunction?: lambda.IFunction;
  /** (issuer id, subject) -> person (Identity): read by user management, the sync and the exchange. */
  identitiesTable: dynamodb.ITable;
  /** The access log (Identity): written by the admin exchange, read by the console. */
  accessLogTable: dynamodb.ITable;
  /** The one offboarding function (Identity), which the console's delete asks. */
  offboardingFunction: lambda.IFunction;
  /**
   * The admin subject provisioner (Identity), when the registry declares a `provisioned-only` issuer
   * (P-13): user management invokes it for `POST /users/provision`, and holds no `Identities` write itself.
   */
  subjectProvisioner?: lambda.IFunction;
  /** The attachments bucket ARN (Conversations): admin attachment reads, and the profile body store. */
  attachmentsBucketArn: string;
  /** The thumbs table (Conversations), for the feedback summary and the per-variant thumbs join. */
  feedbackTable: { tableName: string; tableArn: string };
  /** The archive bucket ARN (Archive). */
  archiveBucketArn: string;
  /** The Archive stack in Aurora mode: the data plane, the VPC the analytics query runs in, the audit. */
  aurora?: ArchiveStackAurora;
  /** The Experiments stack's table, when `experiments` is declared: its admin routes join this stack. */
  experimentsTable?: dynamodb.ITable;
  /** Whether `battle` is declared, for the analytics battle-wins join. */
  battle: boolean;
  /** The group that marks an admin of this deployment's pool. Default `admins`. */
  adminGroupName?: string;
}

export class AdminServicesStack extends cdk.Stack implements RouteSource {
  /** Every admin route, on `AdminApi`; the nested stacks' routes are appended to it. */
  public readonly routes: RouteSpec[] = [];
  /** The console roles, which `AdminApi` grants on exactly the routes their capabilities name. */
  public readonly consoleRoles: Record<AdminRole, iam.IRole>;
  /** The admin notification channel ARN. */
  public readonly channelArn: string;
  /** The admin assistant's AppInstanceBot ARN: the channel's owner and the bearer of every alert in it. */
  public readonly adminAgentBotArn: string;

  constructor(scope: Construct, id: string, props: AdminServicesStackProps) {
    super(scope, id, props);
    const adminAppUrl = adminOrigin(this);
    const issuers = issuersOf(this);
    const trustedIssuersJsonValue = trustedIssuersJson(this, props.selfPoolId);

    const notification = this.adminNotificationChannel(props);
    this.channelArn = notification.channelArn;
    this.adminAgentBotArn = notification.botArn;
    this.alertRule(props, notification);

    // ── THE ADMIN CREDENTIAL EXCHANGE AND ITS ROLES (L3) ────────────────────────────────────────────
    const exchange = this.adminExchange(props, trustedIssuersJsonValue);
    const consoleRoles: Record<AdminRole, iam.IRole> = { admins: exchange.adminConsoleRole, 'team-members': exchange.teamConsoleRole };
    this.consoleRoles = consoleRoles;
    this.consoleEvents(consoleRoles, exchange.exchangeFn);

    // A14 Scoped: the role -> scope map the analytics and admin-conversation handlers resolve a caller's
    // classification scope from (lib/caller-scope.ts), with no Cognito call, so it works from an
    // isolated VPC. The person exchange's per-classification roles -> their classification; Full for the
    // roles an administrator acts through: the admin console session, the admin-plane role, and the admin
    // classification's own role. FULL IS WRITTEN LAST AND WINS: a role listed both ways must come out Full.
    // THE TEAM CONSOLE IS NOT IN THIS MAP: its scope is the person's own clearance, which the exchange
    // writes into each team session's name and `caller-scope.ts` reads from the caller's ARN.
    // A PERSON'S VEND ROLE IS NOT LISTED: the handlers resolve it from its fixed name (`EXCHANGE_ROLE_NAME_PREFIX`)
    // and the runtime registry, so a classification added later is resolved with no edit here, and the admin
    // plane's vend role resolves Full there too.
    const scopeByRole = new Map<string, string>();
    for (const roleArn of [exchange.adminPlaneRole.roleArn, exchange.adminConsoleRole.roleArn]) scopeByRole.set(roleArn, 'full');
    const classificationRoleScopes = this.toJsonString([...scopeByRole].map(([role, scope]) => ({ role, scope })));

    this.userManagement(props, issuers, adminAppUrl);
    if (props.userPool) this.adminConversationSync({ ...props, userPool: props.userPool }, issuers);
    this.adminConversations(props, classificationRoleScopes, adminAppUrl);
    this.feedbackSummary(props, adminAppUrl);

    const assistants = new AdminAssistantAdministration(this, 'AssistantAdministration', {
      appInstanceArn: props.appInstanceArn,
      userPoolId: props.selfPoolId,
      attachmentsBucketArn: props.attachmentsBucketArn,
      experimentsTable: props.experimentsTable,
      identities: { tableName: props.identitiesTable.tableName, tableArn: props.identitiesTable.tableArn },
    });
    this.routes.push(...assistants.routes);

    const analytics = new AdminAnalytics(this, 'Analytics', {
      appInstanceArn: props.appInstanceArn,
      userPoolId: props.selfPoolId,
      archiveBucketArn: props.archiveBucketArn,
      aurora: props.aurora,
      classificationRoleScopes,
      feedbackTable: props.feedbackTable,
      // Resolved here, at deploy, from the battle contract: the Battle stack deploys first.
      battleOutcomeTableName: props.aurora && props.battle ? ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.battleOutcomeName) : undefined,
      attachmentsBucketArn: props.attachmentsBucketArn,
    });
    this.routes.push(...analytics.routes);

    cdk.Tags.of(this).add('Component', 'AdminServices');
  }

  // ── THE ADMIN NOTIFICATION CHANNEL AND THE ADMIN ASSISTANT ──────────────────────────────────────────────
  //
  // THREE IDENTITIES, KEPT DISTINCT (DESIGN-ADMIN-AGENT-NOTIFICATIONS section 1). The ADMIN ASSISTANT, an
  // AppInstanceBot provisioned here from the `admin-agent` profile, CREATES the channel and is therefore its
  // moderator and the bearer for every alert posted into it. The SERVICE app-instance-admin is borrowed for
  // `CreateChannelMembership` only, because bots cannot call it, and never joins. HUMAN ADMINS are the
  // members. A post by the service admin to a RESTRICTED, PRIVATE channel it is not a member of is refused
  // (verified live: `ForbiddenException`); a bot that creates a channel is its moderator and may post to it.
  private adminNotificationChannel(props: AdminServicesStackProps): { channelArn: string; botArn: string } {
    // The Lex half is required rather than wanted: `CreateAppInstanceBot` has no form without a
    // `Configuration.Lex`, and its fulfillment is deliberately silent (admin-agent-lex-handler.ts). The role Amazon
    // Lex runs its bot as is the provisioner's, one for every assistant.
    const lexHandler = new lambdaNodeJs.NodejsFunction(this, 'AdminAgentLexHandler', {
      entry: path.join(__dirname, '../../lambda/src/admin-agent-lex-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      // It closes without a message. A budget past this would only hide a defect.
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      bundling: { minify: false, forceDockerBundling: false },
    });
    // `sourceAccount`: `grantInvoke` on the Lex SERVICE principal alone accepts an invoke from ANY account.
    new lambda.CfnPermission(this, 'AdminAgentLexHandlerLexInvoke', {
      action: 'lambda:InvokeFunction',
      functionName: lexHandler.functionName,
      principal: 'lexv2.amazonaws.com',
      sourceAccount: cdk.Stack.of(this).account,
    });
    // THE ADMIN PLANE'S CLASSIFICATION, RESOLVED ONCE AND REQUIRED: the seed's grant and the identity's own
    // `classification` tag read it.
    const adminClassification = profiles.adminPlaneValues()[0];
    if (!adminClassification) {
      throw new Error(
        'AdminServicesStack: the profile registry declares no admin-plane classification, and the admin '
        + 'assistant must be assigned one (set `adminPlane: true` on a classification in lib/config/profiles.ts)',
      );
    }
    // THE ADMIN ASSISTANT IS SEEDED LIKE EVERY DECLARED ASSISTANT (ADR-048, amended 2026-10-24): its identity and its
    // Amazon Lex bot are the provisioner's (`Messaging`), built once from this declaration, and this stack reads its ARN from
    // the seed's answer. It stays silent when it joins and is invoked by no standard message: its fulfillment has
    // nothing to say, and a silent fulfillment on join makes Amazon Chime SDK post a 500 into the alert room.
    const adminAgent = profiles.requireProfileFor(adminClassification).name;
    const seed = new DeclaredAssistantsSeed(this, 'AdminAgentSeed', {
      classification: adminClassification,
      roles: ['primary'],
      // The name people read is the profile's own ("Admin Assistant"), by the registry's one rule, as every
      // classification's declaration names its assistants.
      assistants: [{ assistantId: adminAgent, role: 'primary', occupancy: 'live', displayName: profiles.displayNameFor(adminAgent), welcome: false }],
      fulfillmentArn: lexHandler.functionArn,
    });
    const botArn = seed.primaryBotArn;
    // Published under the profile's own prefix, for operator scripts and the e2e suite.
    new ssm.StringParameter(this, 'AdminAgentBotArnParameter', {
      parameterName: INSTANCE_SSM.adminAgentBotArn,
      stringValue: botArn,
      description: 'AppInstanceBot ARN for the admin assistant (owns the admin notification channel; bears its alerts)',
    });

    const fn = new lambdaNodeJs.NodejsFunction(this, 'ProvisionFn', {
      entry: path.join(__dirname, '../../lambda/src/admin-notification-channel-provision.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        APP_INSTANCE_ARN: props.appInstanceArn,
        // The MEMBER-ADD bearer, and nothing else. Bots cannot call CreateChannelMembership.
        ADMIN_BEARER_ARN: props.appInstanceAdminArn,
        // The OWNER. Creates the channel, moderates it, stamps its metadata.
        ADMIN_AGENT_BOT_ARN: botArn,
        USER_POOL_ID: props.selfPoolId,
        ADMIN_GROUP_NAME: props.adminGroupName || 'admins',
        // Where the admin plane's assignment records are, to name the admin assistant as the room's primary, and the root
        // its template pointers are under.
        SSM_ROOT,
        // THE CHANNEL IS NAMED FROM THE ADMIN PLANE'S conversation-name TEMPLATE (`conversation-name.ts`), so a console edit
        // names it at the next provisioning.
        TEMPLATE_BUCKET: cdk.Arn.split(props.attachmentsBucketArn, cdk.ArnFormat.NO_RESOURCE_NAME).resource,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    // Read-only, the admin plane's templates and no other's (`messageTemplateReadStatements`).
    for (const stmt of messageTemplateReadStatements(this, props.attachmentsBucketArn, adminClassification)) fn.addToRolePolicy(stmt);
    // THE ROOM'S PRIMARY, read from the admin plane's own assignment records (`primaryTagFor`): the path and
    // its children, because `GetParametersByPath` authorizes against the path itself. Read only, and no other
    // classification's records.
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadTheAdminPlanesAssignments',
      actions: ['ssm:GetParametersByPath'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant-assignments/${adminClassification}`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant-assignments/${adminClassification}/*`,
      ],
    }));
    // Create and moderate as the ADMIN ASSISTANT, add members as the service app-instance admin. Each bearer is
    // named: never `/user/*` (any person) or any other assistant.
    const adminPlane = profiles.adminPlaneValues();
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'CreateTheAdminChannel',
      actions: ['chime:CreateChannel'],
      resources: [props.appInstanceArn, `${props.appInstanceArn}/channel/*`],
      conditions: createOwnClassificationOnly(adminPlane),
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'CreateTheAdminChannelAsTheAdminAgent',
      actions: ['chime:CreateChannel'],
      resources: [`${props.appInstanceArn}/bot/*`],
      conditions: (() => {
        const own = createOwnClassificationOnly(adminPlane);
        return { ...own, StringEquals: { ...own.StringEquals, 'aws:ResourceTag/classification': adminPlane } };
      })(),
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ManageTheAdminChannel',
      actions: ['chime:UpdateChannel', 'chime:DeleteChannel'],
      resources: [`${props.appInstanceArn}/channel/*`],
      conditions: { StringEquals: { 'aws:ResourceTag/classification': adminPlane } },
    }));
    // The read that decides whether the recorded channel still exists, on any channel: a channel the
    // previous version created may predate its tags. Bearing only the identities below.
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadTheRecordedChannel',
      actions: ['chime:DescribeChannel'],
      resources: [`${props.appInstanceArn}/channel/*`],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ManageTheAdminChannelAsTheAdminAgent',
      actions: ['chime:DescribeChannel', 'chime:UpdateChannel', 'chime:DeleteChannel'],
      resources: [`${props.appInstanceArn}/bot/*`],
      conditions: { StringEquals: { 'aws:ResourceTag/classification': adminPlane } },
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ManageTheAdminChannelAsTheServiceAdmin',
      actions: ['chime:DescribeChannel', 'chime:UpdateChannel', 'chime:DeleteChannel'],
      resources: [props.appInstanceAdminArn],
    }));
    for (const stmt of adminPlaneMembershipStatements('AdminChannelMembership', props.appInstanceArn, {
      bearerArns: [props.appInstanceAdminArn],
      channelClassifications: adminPlane,
      actions: ['chime:CreateChannelMembership', 'chime:CreateChannelModerator', 'chime:DeleteChannelMembership'],
    })) fn.addToRolePolicy(stmt);
    for (const stmt of tagOnCreateStatements({
      sid: 'AdminChannelTagged',
      appInstanceArn: props.appInstanceArn,
      classifications: [adminClassification],
      serviceAdminArn: props.appInstanceAdminArn,
    })) fn.addToRolePolicy(stmt);
    // Who to add: the admins group's enabled members, each resolved through Identities to the person they
    // sign in as (`Directory.personsInGroup`).
    grantDirectoryRead(fn, {
      appInstanceArn: props.appInstanceArn,
      userPoolId: props.selfPoolId,
      poolReads: ['cognito-idp:ListUsersInGroup'],
      identities: { tableName: props.identitiesTable.tableName, tableArn: props.identitiesTable.tableArn },
    });
    const provider = new cr.Provider(this, 'Provider', { onEventHandler: fn, logRetention: logs.RetentionDays.ONE_WEEK });
    const resource = new cdk.CustomResource(this, 'AdminNotificationChannel', {
      serviceToken: provider.serviceToken,
      properties: {
        // Force an Update each deploy so the admin roster re-syncs (picks up new admins).
        Timestamp: Date.now().toString(),
        // AUTHORIZES A NEW CHANNEL when the recorded one is unreadable. Off by default.
        AllowReplacement: this.node.tryGetContext('replaceAdminNotificationChannel') === true
          || this.node.tryGetContext('replaceAdminNotificationChannel') === 'true' ? 'true' : 'false',
      },
    });
    // The channel cannot be created before the identity that owns it exists.
    resource.node.addDependency(seed);
    const channelArn = resource.getAttString('ChannelArn');
    // Published for operator scripts and the e2e suite. No stack reads it: alerts reach the channel as
    // events this stack posts itself.
    new ssm.StringParameter(this, 'AdminNotificationChannelArnParameter', {
      parameterName: INSTANCE_SSM.adminNotificationChannelArn,
      stringValue: channelArn,
      description: 'Admin notification channel ARN (operator scripts and the e2e suite read it)',
    });
    new cdk.CfnOutput(this, 'AdminNotificationChannelArn', {
      value: channelArn,
      description: 'Admin notification channel ARN (every ae.alert is posted here)',
    });
    new cdk.CfnOutput(this, 'AdminAgentBotArn', {
      value: botArn,
      description: 'Admin Assistant AppInstanceBot ARN (channel owner + alert sender)',
    });
    return { channelArn, botArn };
  }

  // ── THE ONE RULE THAT POSTS AN ALERT INTO THE ADMIN CHANNEL (L2) ────────────────────────────────────
  //
  // Every platform alert is an `ae.alert` event on the default bus (`lib/admin-notice.ts`), carrying the
  // instance that raised it. This rule matches this instance's, and the poster posts each as the admin
  // assistant. Nothing else in the deployment holds a send into this channel.
  /**
   * THE CONSOLE IS TOLD WHEN BACKGROUND WORK ENDS (ADR-065, tenet D6): a golden run, an upload or a generation, each run as
   * an Event on a classification's GoldenRun function. The Lambda service reports each invocation's end to the default
   * EventBridge bus (the function's async destination, `classification-archive-functions.ts`); this rule sends those
   * reports to a publisher outside the VPC, which publishes `{ id, kind, status }` on `/console/batch/<id>` of an AppSync
   * Event API. The console subscribes to the one channel of the work it started, with its own console credentials.
   *
   * IAM ON EVERY LEG: the console roles may connect and subscribe, only the publisher may publish, and the namespace's
   * subscribe handler refuses any channel but one batch's exact path, so a wildcard cannot follow every batch.
   */
  private consoleEvents(roles: Record<AdminRole, iam.IRole>, exchangeFn: lambda.IFunction): void {
    const api = new appsync.EventApi(this, 'ConsoleEvents', {
      apiName: `${STACK_PREFIX}ConsoleEvents`,
      authorizationConfig: { authProviders: [{ authorizationType: appsync.AppSyncAuthorizationType.IAM }] },
    });
    api.addChannelNamespace('console', {
      code: appsync.Code.fromInline([
        "import { util } from '@aws-appsync/utils';",
        '// One batch\'s exact channel, never a wildcard: a session follows only work whose id it was given.',
        '// String checks, not a regular expression: the APPSYNC_JS runtime takes the plain form.',
        'export function onSubscribe(ctx) {',
        "  const parts = ctx.info.channel.path.split('/');",
        "  const id = parts.length === 4 ? parts[3] : '';",
        "  if (parts[0] !== '' || parts[1] !== 'console' || parts[2] !== 'batch' || id.length !== 36 || id.indexOf('*') !== -1) {",
        '    util.unauthorized();',
        '  }',
        '}',
      ].join('\n')),
    });
    for (const role of Object.values(roles)) {
      api.grantConnect(role);
      api.grantSubscribe(role);
    }
    // A TEAM SESSION FOLLOWS EVENTS THROUGH A MANAGED SESSION POLICY naming this API alone (`teamSessionPolicyArns`):
    // kept out of the inline session policy, whose size bounds how many assistants a team may own.
    const teamEventsSessionPolicy = new iam.ManagedPolicy(this, 'TeamConsoleEventsSessionPolicy', {
      description: 'A team console session may connect to and subscribe on the console events API, and nothing else',
      statements: [new iam.PolicyStatement({
        actions: ['appsync:EventConnect', 'appsync:EventSubscribe'],
        resources: [api.apiArn, `${api.apiArn}/*`],
      })],
    });
    (exchangeFn as lambda.Function).addEnvironment('CONSOLE_EVENTS_SESSION_POLICY_ARN', teamEventsSessionPolicy.managedPolicyArn);
    const publisher = new lambdaNodeJs.NodejsFunction(this, 'ConsoleEventsPublisher', {
      entry: path.join(__dirname, '../../lambda/src/console-events-publisher.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: { CONSOLE_EVENTS_HTTP_DNS: api.httpDns },
      bundling: { externalModules: ['@aws-sdk/*'], minify: true, sourceMap: true },
    });
    api.grantPublish(publisher);
    new events.Rule(this, 'GoldenRunEndedRule', {
      description: 'A GoldenRun invocation ended: tell the console on the run or batch channel',
      eventPattern: {
        source: ['lambda'],
        detailType: ['Lambda Function Invocation Result - Success', 'Lambda Function Invocation Result - Failure'],
        resources: events.Match.wildcard(`arn:aws:lambda:${this.region}:${this.account}:function:${STACK_PREFIX}Assistants-*-GoldenRun*`),
      },
      targets: [new targets.LambdaFunction(publisher, { retryAttempts: 2 })],
    });
    new cdk.CfnOutput(this, 'ConsoleEventsHttpDns', {
      value: api.httpDns,
      description: 'The console events API, HTTP - VITE_CONSOLE_EVENTS_HTTP (admin package only)',
    });
    new cdk.CfnOutput(this, 'ConsoleEventsRealtimeDns', {
      value: api.realtimeDns,
      description: 'The console events API, WebSocket - VITE_CONSOLE_EVENTS_REALTIME (admin package only)',
    });
  }

  private alertRule(props: AdminServicesStackProps, notification: { channelArn: string; botArn: string }): void {
    const poster = new lambdaNodeJs.NodejsFunction(this, 'AdminAlertPosterFunction', {
      entry: path.join(__dirname, '../../lambda/src/admin-alert-poster.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ALERT_INSTANCE: INSTANCE_NAME,
        ADMIN_ALERT_CHANNEL_ARN: notification.channelArn,
        ADMIN_ALERT_BEARER_ARN: notification.botArn,
        // The admin assistant's own notice templates (ADR-062 decision 6): the store's bucket and the pointers' root.
        TEMPLATE_BUCKET: cdk.Arn.split(props.attachmentsBucketArn, cdk.ArnFormat.NO_RESOURCE_NAME).resource,
        SSM_ROOT,
      },
      bundling: { externalModules: ['@aws-sdk/*'], minify: true, sourceMap: true },
    });
    // THE ADMIN ASSISTANT'S OWN NOTICE TEMPLATES, AND NO OTHER FAMILY (ADR-062 decision 6, tenet D15): read-only, its bodies
    // under `templates/admin/_assistants/admin-agent/` and their pointers. No classification's templates, no write.
    const adminFamily = { family: 'assistant' as const, assistant: ADMIN_NOTICE_ASSISTANT };
    poster.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadTheAdminAgentsNoticeTemplates',
      actions: ['s3:GetObject'],
      resources: [`${props.attachmentsBucketArn}/${templateFamilyPrefix(ADMIN_NOTICE_CLASSIFICATION, adminFamily)}*`],
    }));
    poster.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadTheAdminAgentsNoticePointers',
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${templatePointerPath(SSM_ROOT, ADMIN_NOTICE_CLASSIFICATION)}/_assistants/${ADMIN_NOTICE_ASSISTANT}/*`],
    }));
    // THIS CHANNEL, by its exact ARN (this stack's own resource), AS THE ADMIN ASSISTANT: Amazon Chime SDK does
    // not bind the bearer to the caller, so the bot leg is held to a bot carrying an admin-plane
    // `classification`, which only the admin assistant does (lib/config/speakers.ts declares this speaker).
    poster.addToRolePolicy(new iam.PolicyStatement({
      actions: ['chime:SendChannelMessage'],
      resources: [notification.channelArn],
    }));
    poster.addToRolePolicy(new iam.PolicyStatement({
      actions: ['chime:SendChannelMessage'],
      resources: [`${props.appInstanceArn}/bot/*`],
      conditions: { StringEquals: { 'aws:ResourceTag/classification': profiles.adminPlaneValues() } },
    }));
    new events.Rule(this, 'AdminAlertRule', {
      description: 'Post every platform alert this instance raises into the admin notification channel',
      eventPattern: { source: [ALERT_SOURCE], detail: { instance: [INSTANCE_NAME] } },
      targets: [new targets.LambdaFunction(poster, { retryAttempts: 2 })],
    });
  }

  // ── THE ADMIN CREDENTIAL EXCHANGE (L3) ──────────────────────────────────────────────────────────────
  private adminExchange(props: AdminServicesStackProps, trustedIssuersJsonValue: string): {
    adminPlaneRole: iam.Role; adminConsoleRole: iam.Role; teamConsoleRole: iam.Role; exchangeFn: lambda.IFunction;
  } {
    const exchangeOrigins = [adminOrigin(this)];
    const PINNED_ADMIN_USER_ARN = `${props.appInstanceArn}/user/` + '${aws:PrincipalTag/person}-admin';
    // The chat set the admin plane also reads with, and the moderation set vended ONLY on the admin plane;
    // each request narrows to the one action via an STS session policy in the exchange.
    const MSG_ACTIONS = [
      'chime:SendChannelMessage', 'chime:GetChannelMessage', 'chime:ListChannelMessages', 'chime:DescribeChannel',
      'chime:ListChannelMemberships', 'chime:ListChannelModerators', 'chime:UpdateChannelReadMarker', 'chime:UpdateChannel',
    ];
    const MODERATION_ACTIONS = [
      'chime:RedactChannelMessage', 'chime:DeleteChannelMessage',
      'chime:CreateChannelMembership', 'chime:DeleteChannelMembership', 'chime:CreateChannelModerator',
      'chime:UpdateChannel', 'chime:DeleteChannel',
    ];

    const exchangeRole = new iam.Role(this, 'AdminCredentialExchangeRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        AdminTwin: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            // THE ADMIN-PLANE TWIN `<personId>-admin`, and its standing app-instance-admin registration.
            // This exchange creates no person: the person exchange is the one minter.
            actions: [
              'chime:CreateAppInstanceUser', 'chime:DescribeAppInstanceUser', 'chime:UpdateAppInstanceUser',
              'chime:CreateAppInstanceAdmin', 'chime:TagResource',
            ],
            resources: [`${props.appInstanceArn}/user/*`, props.appInstanceArn],
          })],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    // The person a console session's subject signs in as, read and never written.
    exchangeRole.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [props.identitiesTable.tableArn] }));
    // THE SUBJECTS OF THE PERSON A CONSOLE SESSION NAMES, through the `byPerson` index, read at every
    // per-capability and attachment vend so each asks the person's issuers whether the account is still
    // active (`refuseInactivePerson`, lib/vend.ts; SPEC-CREDENTIAL-EXCHANGE §4b). Read only.
    exchangeRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TheSubjectsOfTheSessionsPerson',
      actions: ['dynamodb:Query'],
      resources: [`${props.identitiesTable.tableArn}/index/byPerson`],
    }));
    // Every vend is recorded before it is returned, and the record can only be added to.
    exchangeRole.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [props.accessLogTable.tableArn] }));

    // The admin-PLANE role: pinned to the admin's SEPARATE `${personId}-admin` identity (a standing
    // app-instance-admin), carrying the view + moderation boundary on any channel. Assumed ONLY for a
    // channel-scoped, short-lived, audited vend; the session policy narrows it to the one target. THE SAME
    // TAG PIN AS THE PERSON VEND ROLES, ON THE ASSUME, so an untagged assume cannot skip the pin.
    const adminPlaneTagPin = {
      StringLike: { 'aws:RequestTag/person': '*' },
      // The admin plane's own classification, which the exchange asserts on every admin-plane vend.
      StringEquals: { 'aws:RequestTag/classification': profiles.adminPlaneValues()[0] },
    };
    // ── THE ARCHIVE PLANE'S BOUNDARIES: the wildcard here, the one subject in each vend's session policy ──
    //
    // The message read and the task routes are on this stack's admin conversation API. Named by a
    // wildcard-api-id ARN with the exact method and path, and completed per vend with the one channel or
    // owner id, the same two layers the S3 attachment plane uses (boundary on the bucket, session policy
    // on one key prefix). Handing work to a different person and stopping it are different authorities,
    // so each has its own boundary (tenet P4).
    const executeApi = (method: string, p: string) => `arn:aws:execute-api:${this.region}:${this.account}:*/*/${method}/${p}`;
    // WHAT THE ADMIN PLANE REACHES, written once: its identity policy, and its permissions boundary, so a grant
    // attached to it later reaches nothing this list does not (STACKS.md "Permissions boundaries").
    const adminPlaneStatements = (): iam.PolicyStatement[] => [
      new iam.PolicyStatement({ actions: ['chime:GetMessagingSessionEndpoint'], resources: ['*'] }),
      new iam.PolicyStatement({ actions: ['chime:Connect'], resources: [PINNED_ADMIN_USER_ARN] }),
      new iam.PolicyStatement({
        actions: [...new Set([...MSG_ACTIONS, ...MODERATION_ACTIONS])],
        resources: [`${props.appInstanceArn}/channel/*`, PINNED_ADMIN_USER_ARN],
      }),
      new iam.PolicyStatement({
        actions: ['execute-api:Invoke'],
        resources: [
          executeApi('GET', 'admin/conversations/*/messages'),
          executeApi('GET', 'admin/tasks/channel/*'),
          executeApi('POST', 'admin/tasks/channel/*/cancel'),
          executeApi('POST', 'admin/tasks/channel/*/owner'),
          executeApi('GET', 'admin/tasks/assignee/*'),
          executeApi('GET', 'admin/tasks/owned-by/*'),
        ],
      }),
      // Admin conversation attachment review: the BOUNDARY on the two attachment key families. The exchange's
      // per-request session policy narrows to one channel's keys and picks the prefix per capability.
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`${props.attachmentsBucketArn}/generated-docs/*`, `${props.attachmentsBucketArn}/attachments/*`],
      }),
    ];
    const adminPlaneRole = new iam.Role(this, 'ExchangeRoleAdminPlane', {
      assumedBy: new iam.PrincipalWithConditions(new iam.ArnPrincipal(exchangeRole.roleArn), adminPlaneTagPin),
      permissionsBoundary: permissionsBoundary(this, 'ExchangeRoleAdminPlaneBoundary',
        'The boundary of the admin plane: view and moderation as the admin twin, the archive plane routes and the attachment reads', adminPlaneStatements()),
    });
    for (const st of adminPlaneStatements()) adminPlaneRole.addToPolicy(st);
    adminPlaneRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
      principals: [new iam.ArnPrincipal(exchangeRole.roleArn)],
      actions: ['sts:TagSession'],
      conditions: adminPlaneTagPin,
    }));

    // ── THE CONSOLE ROLES (SPEC-ADMIN-CONSOLE "Temporary, scoped credentials") ─────────────────────
    //
    // The admin console holds no standing credential. The exchange assumes one of these for it, per
    // sign-in, as `console-<personId>`; each holds exactly the capabilities the catalog gives its role,
    // granted on every API in this stack. Only the exchange may assume them, and only with the `person` it
    // asserts on the session, which is how every admin route reads the person from a signed request.
    const consoleTagPin = { StringLike: { 'aws:RequestTag/person': '*' } };
    // THE BOUNDARY OF A CONSOLE SESSION: an admin route, and being told when work it started ends, nothing else. Each
    // route a role holds is granted by `AdminApi` from the capability catalog (`grantAdminRolesOnApi`), and the console
    // events API grants connect and subscribe (`consoleEvents`); the boundary is what those grants can add up to, so no
    // grant attached to a console role reaches a table, a bucket or the Amazon Chime SDK, or publishes an event.
    const consoleBoundary = permissionsBoundary(this, 'ConsoleRoleBoundary',
      'The boundary of an admin console session: invoking this account API routes and following console events, nothing else', [
        new iam.PolicyStatement({ actions: ['execute-api:Invoke'], resources: [`arn:aws:execute-api:${this.region}:${this.account}:*`] }),
        new iam.PolicyStatement({
          actions: ['appsync:EventConnect', 'appsync:EventSubscribe'],
          resources: [`arn:aws:appsync:${this.region}:${this.account}:apis/*`],
        }),
      ]);
    const makeConsoleRole = (id: string, roleName: string, description: string): iam.Role => {
      const role = new iam.Role(this, id, {
        roleName,
        description,
        maxSessionDuration: cdk.Duration.hours(1),
        assumedBy: new iam.PrincipalWithConditions(new iam.ArnPrincipal(exchangeRole.roleArn), consoleTagPin),
        permissionsBoundary: consoleBoundary,
      });
      role.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
        principals: [new iam.ArnPrincipal(exchangeRole.roleArn)],
        actions: ['sts:TagSession'],
        conditions: consoleTagPin,
      }));
      return role;
    };
    const adminConsoleRole = makeConsoleRole('AdminConsoleRole', ADMIN_CONSOLE_ROLE_NAME.admins,
      'Admin console session for the admins role - every admin capability');
    const teamConsoleRole = makeConsoleRole('TeamConsoleRole', ADMIN_CONSOLE_ROLE_NAME['team-members'],
      'Admin console session for the team-members role - capabilities scoped to the team\'s assistants');

    // ── A TEAM MEMBER'S ATTACHMENT READ (`attachment-read` on a team route) ─────────────────────────
    //
    // Its own role rather than the admin plane's: a team member is not an administrator, and the boundary
    // is assistant deliverables alone (`generated-docs/*`), never a user upload.
    const teamAttachmentTagPin = { StringLike: { 'aws:RequestTag/person': '*', 'aws:RequestTag/classification': '*', 'aws:RequestTag/assistant': '*' } };
    const teamDeliverables = () => new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`${props.attachmentsBucketArn}/generated-docs/*`],
    });
    const teamAttachmentRole = new iam.Role(this, 'TeamAttachmentRole', {
      permissionsBoundary: permissionsBoundary(this, 'TeamAttachmentRoleBoundary',
        'The boundary of a team member attachment read: assistant deliverables, and nothing else', [teamDeliverables()]),
      description: 'A team member\'s read of one conversation\'s assistant deliverables',
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.PrincipalWithConditions(new iam.ArnPrincipal(exchangeRole.roleArn), teamAttachmentTagPin),
    });
    teamAttachmentRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
      principals: [new iam.ArnPrincipal(exchangeRole.roleArn)],
      actions: ['sts:TagSession'],
      conditions: teamAttachmentTagPin,
    }));
    teamAttachmentRole.addToPolicy(teamDeliverables());

    exchangeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [adminPlaneRole.roleArn, adminConsoleRole.roleArn, teamConsoleRole.roleArn, teamAttachmentRole.roleArn],
    }));
    // Whether the assistant is in the conversation, asked as the assistant's own identity.
    exchangeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['chime:DescribeChannelMembershipForAppInstanceUser'],
      resources: [`${props.appInstanceArn}/channel/*`, `${props.appInstanceArn}/bot/*`],
    }));
    // The attachments bucket ARN the attachment vends resolve.
    exchangeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SHARED_SSM.attachmentsBucketArn}`],
    }));

    const exchangeFn = new lambdaNodeJs.NodejsFunction(this, 'AdminCredentialExchangeFunction', {
      entry: './lambda/src/admin-credential-exchange.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      role: exchangeRole,
      environment: {
        APP_INSTANCE_ARN: props.appInstanceArn,
        ALLOWED_ORIGIN: exchangeOrigins.join(','),
        EXCHANGE_ROLE_ADMIN_PLANE: adminPlaneRole.roleArn,
        ADMIN_CONSOLE_ROLE_ARN: adminConsoleRole.roleArn,
        TEAM_CONSOLE_ROLE_ARN: teamConsoleRole.roleArn,
        TEAM_ATTACHMENT_ROLE_ARN: teamAttachmentRole.roleArn,
        IDENTITIES_TABLE: props.identitiesTable.tableName,
        ACCESS_LOG_TABLE: props.accessLogTable.tableName,
        // Every issuer's entry: whether it declares `admin`, its subject claim, and its clearance source.
        TRUSTED_ISSUERS: trustedIssuersJsonValue,
        EXCHANGE_ATTACHMENTS_BUCKET_ARN_PARAM: SHARED_SSM.attachmentsBucketArn,
        // `{id}` is substituted per vend with the channel id or the owner id the vend is scoped to.
        EXCHANGE_EXECUTE_API_MESSAGES_ARN: executeApi('GET', 'admin/conversations/{id}/messages'),
        EXCHANGE_EXECUTE_API_TASKS_READ_ARN: executeApi('GET', 'admin/tasks/channel/{id}'),
        EXCHANGE_EXECUTE_API_TASKS_MANAGE_ARN: executeApi('POST', 'admin/tasks/channel/{id}/cancel'),
        EXCHANGE_EXECUTE_API_TASKS_REASSIGN_ARN: executeApi('POST', 'admin/tasks/channel/{id}/owner'),
        EXCHANGE_EXECUTE_API_TASKS_OWNED_BY_ARN: executeApi('GET', 'admin/tasks/owned-by/{id}'),
        EXCHANGE_EXECUTE_API_TASKS_ASSIGNEE_ARN: executeApi('GET', 'admin/tasks/assignee/{id}'),
      },
      bundling: { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] },
    });
    // A team member's console session names the assistants their team owns, read from the ownership tags,
    // and the team attachment route re-checks the caller's groups (assistant-scope.ts).
    grantAssistantScopeCheck(exchangeFn, props.appInstanceArn, props.selfPoolId, { tableName: props.identitiesTable.tableName, tableArn: props.identitiesTable.tableArn });
    // WHETHER THE ACCOUNT MAY STILL SIGN IN, asked of its pool at every console session, as the person
    // exchange asks at every vend (`refuseInactiveAccount`, lib/vend.ts; SPEC-CREDENTIAL-EXCHANGE §4b).
    grantAccountStateRead(this, exchangeRole, props.selfPoolId);

    // The access log read (`view-access-log`): it reads the log and records its own read.
    const accessLogReaderFn = new lambdaNodeJs.NodejsFunction(this, 'AccessLogReaderFunction', {
      entry: './lambda/src/access-log-reader.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        ACCESS_LOG_TABLE: props.accessLogTable.tableName,
        APP_INSTANCE_ARN: props.appInstanceArn,
        ALLOWED_ORIGIN: exchangeOrigins.join(','),
        ...adminAuthEnv(this),
        ADMIN_IAM_ENFORCEMENT: 'true',
      },
      bundling: { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] },
    });
    accessLogReaderFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [props.accessLogTable.tableArn, `${props.accessLogTable.tableArn}/index/*`],
    }));
    accessLogReaderFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [props.accessLogTable.tableArn] }));

    // THE CONSOLE SESSION, with the person's token: the one admin request that is not IAM-signed, since it
    // is how the console obtains the credentials it signs with. `AdminApi`'s edge authorizer admits only a
    // token whose issuer declares `admin: true` (the admin plane), uncached, and the handler refuses again on
    // the entry the token resolves to (tenet D3). The admin console's own app client is the Identity stack's,
    // because both APIs' edge authorizers check its tokens' audience.
    this.routes.push(adminRoute('admin-exchange', 'POST', '/exchange-credentials', exchangeFn, { auth: 'person' }));
    // EVERY ADMIN CREDENTIAL ON ITS OWN IAM-AUTHORIZED ROUTE, one per capability the exchange vends
    // (SPEC-ADMIN-CONSOLE FR45), so API Gateway refuses a role without the capability before the exchange runs.
    for (const cap of Object.values(ADMIN_CAPABILITIES)) {
      if (cap.enforcement !== 'exchangeVend' || !cap.wired || !cap.vends?.length) continue;
      this.routes.push(adminRoute('admin-exchange', 'POST', `/${vendRoutePath(cap.key)}`, exchangeFn));
    }
    // A team member's attachment read, on its assistant's route.
    this.routes.push(
      adminRoute('admin-exchange', 'POST', '/exchange-credentials/admin/assistants/{assistant}/attachment-read', exchangeFn),
      adminRoute('admin-exchange', 'GET', '/admin/access-log', accessLogReaderFn),
    );

    return { adminPlaneRole, adminConsoleRole, teamConsoleRole, exchangeFn };
  }

  // ── USER MANAGEMENT (ADR-021: the Cognito reference implementation of user lifecycle administration) ──
  private userManagement(
    props: AdminServicesStackProps,
    issuers: ReturnType<typeof issuersOf>,
    adminAppUrl: string,
  ): void {
    const fn = new lambdaNodeJs.NodejsFunction(this, 'UserManagementFunction', {
      entry: './lambda/src/user-management.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(29),
      memorySize: 256,
      environment: {
        ...adminAuthEnv(this),
        ADMIN_IAM_ENFORCEMENT: 'true',
        SSM_ROOT,
        APP_INSTANCE_ARN: props.appInstanceArn,
        ALLOWED_ORIGIN: adminAppUrl,
        // The service admin, which the list of people leaves out.
        ADMIN_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn,
        // A delete, a re-admission and an export are asked of the Identity stack's one
        // offboarding function, which holds offboarding's grants; this role holds none of them.
        OFFBOARDING_FUNCTION_NAME: props.offboardingFunction.functionName,
        // A provisioned-only issuer's subject is pre-assigned by Identity's admin provisioner, the same way.
        ...(props.subjectProvisioner ? { PROVISION_FUNCTION_NAME: props.subjectProvisioner.functionName } : {}),
        // Trigger #3: the membership-audit function to async-invoke on a clearance downgrade.
        MEMBERSHIP_AUDIT_FN_NAME,
        // The guest issuer's kill switch, read for the console's Guest panel (E6, L16), when one is declared.
        ...(issuers.guest() ? { GUEST_KILL_SWITCH_PARAMETER: guestKillSwitchParameter(issuers.guest()!.id) } : {}),
        // Whether the registrations awaiting approval are served here, so the Guest panel asks for them only then.
        ...(registrationApprovalRouted(props, issuers) ? { GUEST_REGISTRATION_APPROVAL: 'admin' } : {}),
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    // The Guest panel reads the kill switch and who changed it; it never changes it (`scripts/guest-switch.mjs` does).
    const guestEntry = issuers.guest();
    if (guestEntry) fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadTheGuestKillSwitch',
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${guestKillSwitchParameter(guestEntry.id)}`],
    }));
    // The pool's administration: approve, reject, enable, set a clearance or a membership group. A deployment
    // with no pool of its own administers no account here, and the console says which issuer governs them.
    if (props.userPool) fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:ListUsers',
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:AdminDisableUser',
        'cognito-idp:AdminEnableUser',
        'cognito-idp:AdminAddUserToGroup',
        'cognito-idp:AdminRemoveUserFromGroup',
        'cognito-idp:AdminListGroupsForUser',
        // Membership-group and team members shown in the user list (one listing per group).
        'cognito-idp:ListUsersInGroup',
        // The teams that exist (`team-<name>` groups), offered in a person's details.
        'cognito-idp:ListGroups',
      ],
      resources: [props.userPool.userPoolArn],
    }));
    // THE CONSOLE LISTS PEOPLE FROM THE APPINSTANCEUSERS (ADR-058), and re-stamps a person's classification
    // tag on a clearance change: a stale tag on a principal is worse than an absent one.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['chime:ListAppInstanceUsers', 'chime:TagResource'],
      resources: [props.appInstanceArn, `${props.appInstanceArn}/user/*`],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${INSTANCE_SSM.appInstanceAdminArn}`],
    }));
    props.offboardingFunction.grantInvoke(fn);
    props.subjectProvisioner?.grantInvoke(fn);
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${MEMBERSHIP_AUDIT_FN_NAME}`],
    }));
    // A pool username becomes the person it signs in as through Identities, for the identity tag a
    // clearance change re-stamps and the membership re-audit it asks for.
    grantDirectoryRead(fn, {
      appInstanceArn: props.appInstanceArn,
      userPoolId: props.selfPoolId,
      poolReads: [],
      identities: { tableName: props.identitiesTable.tableName, tableArn: props.identitiesTable.tableArn },
    });
    // THE LIST OF PEOPLE READS `enabled` FROM THE ISSUER'S RECORD, for a person of any trusted pool, the way
    // the exchange asks at a vend: the platform keeps no copy of it (SPEC-CREDENTIAL-EXCHANGE §4b).
    grantAccountStateRead(this, fn, props.selfPoolId);

    // Every route is IAM-authorized: a role is refused at the gateway on a capability it does not hold
    // (`view-users`, `manage-users`, `delete-users`).
    this.routes.push(adminRoute('user-management', 'GET', '/users', fn));
    // The Guest panel's kill-switch state (`view-guest-sessions`).
    this.routes.push(adminRoute('user-management', 'GET', '/users/guest', fn));
    for (const action of ['approve', 'reject', 'tier', 'enable', 'group', 'team', 'delete', 'readmit', 'provision', 'export']) {
      this.routes.push(adminRoute('user-management', 'POST', `/users/${action}`, fn));
    }

    // A VISITOR'S REGISTRATION, APPROVED (`approve-registrations`, B6), where the guest issuer declares
    // `guest.registration.approval: 'admin'`: asked of path B's function (Conversations), the one writer of
    // registrations and claims, which sends the sign-in link. This function's one grant is the invoke.
    // GATED BY THE `issuers` DECLARATION, which the reference's guest variant synthesizes: path B's function
    // exists exactly where a guest issuer and a claim target are declared.
    const upgradeFunction = props.guestUpgradeFunction;
    if (upgradeFunction && registrationApprovalRouted(props, issuers)) {
      const registrationsFn = new lambdaNodeJs.NodejsFunction(this, 'AdminRegistrationsFunction', {
        entry: './lambda/src/admin-registrations.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(20),
        memorySize: 256,
        environment: {
          ...adminAuthEnv(this),
          ADMIN_IAM_ENFORCEMENT: 'true',
          ALLOWED_ORIGINS: adminAppUrl,
          UPGRADE_FUNCTION: upgradeFunction.functionArn,
        },
        bundling: { minify: false, forceDockerBundling: false },
      });
      upgradeFunction.grantInvoke(registrationsFn);
      this.routes.push(
        adminRoute('user-management', 'GET', '/users/guest/registrations', registrationsFn),
        adminRoute('user-management', 'POST', '/users/guest/registrations/{registrationId}/approve', registrationsFn),
      );
    }

    // Which identity provider actually governs users on this deployment. `user-management.ts` drives
    // Cognito User Pools directly, so on a deployment that replaces them the console says so plainly
    // rather than presenting buttons that act on a directory the deployment no longer uses.
    new cdk.CfnOutput(this, 'IdentityProvider', {
      value: issuers.identityProviderLabel(),
      description: 'Identity provider governing end users. "cognito" enables the User Management tab; any other value renders a pointer to that IdP.',
    });

    // TEAM MEMBERS (SPEC-ADMIN-CONSOLE "Admin and team-member groups"). The group names the role; the
    // exchange issues a team member's console session on the team console role. The group carries no role.
    if (props.userPool) {
      new cognito.CfnUserPoolGroup(this, 'TeamMembersGroup', {
        userPoolId: props.selfPoolId,
        groupName: ADMIN_ROLE_GROUP['team-members'],
        description: 'Admin team members - capabilities scoped to the assistants their team-<name> group owns',
        precedence: TEAM_MEMBERS_PRECEDENCE,
      });
    }
  }

  // ── ADMIN CONVERSATION MEMBERSHIP SYNC (SPEC-ADMIN-IDENTITY section 8) ─────────────────────────────
  //
  // Resolves the admins group and syncs each configured admin conversation's membership and Metadata
  // participants; also de-provisions app-instance-admin for humans no longer in the group. Runs as the
  // service app-instance-admin. Configure channels with -c adminConversationArns.
  private adminConversationSync(props: AdminServicesStackProps & { userPool: cognito.IUserPool }, issuers: ReturnType<typeof issuersOf>): void {
    const adminConversationArns = (this.node.tryGetContext('adminConversationArns') as string) || '';
    const deploymentAdminGroups = issuers.deploymentAdminGroups();
    const fn = new lambdaNodeJs.NodejsFunction(this, 'AdminConversationSyncFunction', {
      entry: './lambda/src/admin-conversation-sync.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        USER_POOL_ID: props.userPool.userPoolId,
        APP_INSTANCE_ARN: props.appInstanceArn,
        ADMIN_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn,
        ADMIN_CONVERSATION_ARNS: adminConversationArns,
        // The admin notification channel is kept to the admins as well, members only: its creator, the
        // admin assistant, is its moderator, and an alert is not something an admin edits.
        ADMIN_NOTIFICATION_CHANNEL_ARN: this.channelArn,
        ...(deploymentAdminGroups ? { ADMIN_GROUP_NAME: deploymentAdminGroups[0] } : {}),
      },
      bundling: { externalModules: ['@aws-sdk/*'], minify: true },
    });
    grantDirectoryRead(fn, {
      appInstanceArn: props.appInstanceArn,
      userPoolId: props.userPool.userPoolId,
      poolReads: ['cognito-idp:ListUsersInGroup'],
      identities: { tableName: props.identitiesTable.tableName, tableArn: props.identitiesTable.tableArn },
    });
    // THE ADMIN CONVERSATIONS, AND ONLY THEM, bearing the service admin.
    // The admin plane's own channels by their tag, which takes in the admin notification channel (members only, see the env above).
    for (const stmt of adminPlaneMembershipStatements('AdminConversationMembership', props.appInstanceArn, {
      bearerArns: [serviceAdminArnOf(props.appInstanceArn)],
      channelArns: adminConversationArns.split(',').map((a) => a.trim()).filter(Boolean),
      // The admin notification channel is reached through its classification tag, the admin plane's own,
      // so the grant names no channel outside the admin plane and needs no ARN the stack does not know.
      channelClassifications: profiles.adminPlaneValues(),
      actions: [
        'chime:ListChannelMemberships', 'chime:CreateChannelMembership', 'chime:DeleteChannelMembership',
        'chime:DescribeChannel', 'chime:UpdateChannel',
        // The shared reconcile reads the moderator list first and makes each current admin a moderator of
        // each admin conversation, revoking it on removal.
        'chime:ListChannelModerators', 'chime:CreateChannelModerator', 'chime:DeleteChannelModerator',
      ],
    })) fn.addToRolePolicy(stmt);
    // Clean up a demoted admin's orphaned `${personId}-admin` identity, and drop the elevation.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['chime:DeleteAppInstanceAdmin', 'chime:DeleteAppInstanceUser'],
      resources: [props.appInstanceArn, `${props.appInstanceArn}/user/*`],
    }));
    // ListAppInstanceAdmins authorizes against TWO resources, and needs both: the app instance and a
    // wildcard covering the identities it would return. Its own statement, so the wildcard applies to the
    // LIST call alone.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['chime:ListAppInstanceAdmins'],
      resources: [props.appInstanceArn, `arn:aws:chime:${this.region}:${this.account}:app-instance/*/user/*`],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${INSTANCE_SSM.appInstanceAdminArn}`],
    }));
    // EVENT-DRIVEN, with a backstop (tenet D6): a change to the admin group reaches EventBridge as the
    // CloudTrail-recorded Cognito call (the platform trail, in the Identity stack).
    new events.Rule(this, 'AdminGroupChanged', {
      description: 'Sync the admin conversations when the admin group changes',
      eventPattern: {
        source: ['aws.cognito-idp'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['cognito-idp.amazonaws.com'],
          eventName: ['AdminAddUserToGroup', 'AdminRemoveUserFromGroup', 'AdminDeleteUser', 'AdminDisableUser', 'AdminEnableUser'],
          requestParameters: { userPoolId: [props.userPool.userPoolId] },
        },
      },
      targets: [new targets.LambdaFunction(fn)],
    });
    new events.Rule(this, 'AdminConversationSyncSchedule', {
      schedule: events.Schedule.expression((this.node.tryGetContext('adminSyncRate') as string) || 'rate(1 day)'),
      targets: [new targets.LambdaFunction(fn)],
    });
  }

  // ── THE ADMIN CONVERSATION READ PLANE AND THE OPERATOR TASK ROUTES ─────────────────────────────────
  //
  // List, message content and membership history over the archive, and the task routes (ADR-033). The
  // read role holds NO Amazon Chime SDK bearer permission: live actions run client-side as the admin's own
  // `${personId}-admin` identity (SPEC-ADMIN-IDENTITY). Message content and tasks are exchange-vended per
  // conversation; the rest is a standing console-role grant.
  private adminConversations(
    props: AdminServicesStackProps,
    classificationRoleScopes: string,
    adminAppUrl: string,
  ): void {
    const readRole = new iam.Role(this, 'AdminConversationRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        AthenaQuery: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults'],
              resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/${ATHENA_WORKGROUP_NAME}`],
            }),
            new iam.PolicyStatement({
              actions: ['glue:GetTable', 'glue:GetPartitions', 'glue:GetDatabase'],
              resources: [
                `arn:aws:glue:${this.region}:${this.account}:catalog`,
                `arn:aws:glue:${this.region}:${this.account}:database/${ANALYTICS_DB_NAME}`,
                `arn:aws:glue:${this.region}:${this.account}:table/${ANALYTICS_DB_NAME}/*`,
              ],
            }),
            new iam.PolicyStatement({
              actions: ['s3:GetBucketLocation', 's3:GetObject', 's3:ListBucket', 's3:PutObject'],
              resources: [
                `arn:aws:s3:::${ANALYTICS_PREFIX}-conversation-archive-${this.account}-${this.region}`,
                `arn:aws:s3:::${ANALYTICS_PREFIX}-conversation-archive-${this.account}-${this.region}/*`,
              ],
            }),
            // The archive bucket is SSE-KMS on the archive's key: decrypt scoped to KMS-via-S3.
            new iam.PolicyStatement({
              actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
              resources: ['*'],
              conditions: { StringEquals: { 'kms:ViaService': `s3.${this.region}.amazonaws.com` } },
            }),
          ],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    const readFn = new lambdaNodeJs.NodejsFunction(this, 'AdminConversationFunction', {
      entry: './lambda/src/admin-conversations.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(20),
      memorySize: 512,
      role: readRole,
      environment: {
        ...adminAuthEnv(this),
        ADMIN_IAM_ENFORCEMENT: 'true',
        APP_INSTANCE_ARN: props.appInstanceArn,
        CLASSIFICATION_ROLE_SCOPES: classificationRoleScopes,
        EXCHANGE_ROLE_NAME_PREFIX: exchangeRoleName(''),
        USER_POOL_ID: props.selfPoolId,
        ATHENA_WORKGROUP: ATHENA_WORKGROUP_NAME,
        ATHENA_DATABASE: ANALYTICS_DB_NAME,
        ALLOWED_ORIGIN: adminAppUrl,
        // Aurora mode reads conversations from Aurora through the data plane (BUG #21); Athena mode reads
        // the archive. The ARN is resolved from SSM at cold start, so one handler serves both.
        AURORA_DATA_PLANE_ARN_PARAM: SHARED_SSM.auroraDataPlaneArn,
        // A team member's read of a conversation is recorded in the access log, before the messages are
        // returned, as every vend is (ADR-052). Without it those reads reached CloudWatch only, and the
        // console's Access Log could not show who on a team read which conversation, or why.
        ACCESS_LOG_TABLE: props.accessLogTable.tableName,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    // Write only, one record at a time: the reader of the log is `accessLogReaderFn`, not this function.
    readFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [props.accessLogTable.tableArn] }));
    readFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SHARED_SSM.auroraDataPlaneArn}`],
    }));
    if (props.userPool) {
      readFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminListGroupsForUser'],
        resources: [props.userPool.userPoolArn],
      }));
    }
    if (props.aurora) {
      // This instance's data plane, by its ARN.
      readFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [props.aurora.dataPlaneLambdaArn] }));
    }
    grantAssistantScopeCheck(readFn, props.appInstanceArn, props.selfPoolId, { tableName: props.identitiesTable.tableName, tableArn: props.identitiesTable.tableArn });
    const conversations = (method: 'GET' | 'POST', path: string, handler: lambda.IFunction = readFn): void => {
      this.routes.push(adminRoute('admin-conversations', method, path, handler));
    };

    // ── OPERATOR TASK ROUTES (ADR-033, DESIGN-TASK-ACCESS) ───────────────────────────────────────
    //
    // Reading what is open and CANCELLING somebody's work are different clearances. WHAT IS BEING ASKED
    // ABOUT IS A PATH SEGMENT, so the session policy the exchange vends can name it in an IAM resource ARN.
    // IT GOES THROUGH THE TASK SERVICES, never the tables, of every classification this deployment declares.
    const tasksFn = new lambdaNodeJs.NodejsFunction(this, 'AdminTasksFn', {
      entry: path.join(__dirname, '../../lambda/src/admin-tasks.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(20),
      memorySize: 256,
      environment: {
        ALLOWED_ORIGINS: adminAppUrl,
        ...adminAuthEnv(this),
        ADMIN_IAM_ENFORCEMENT: 'true',
        ...taskServiceByNameEnvironment(),
        APP_INSTANCE_ARN: props.appInstanceArn,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    // THE TASK SERVICES, each found by name at call time from its classification's parameter and invoked on
    // the service's construct id, bounded to this instance's functions that carry a classification by their
    // tags. No deploy-time value comes from the classification stacks, so this stack deploys without them.
    for (const statement of taskServiceByNameStatements(this, EVERY_CLASSIFICATION)) tasksFn.addToRolePolicy(statement);
    conversations('GET', '/admin/tasks/channel/{channelId}', tasksFn);
    conversations('POST', '/admin/tasks/channel/{channelId}/cancel', tasksFn);
    // Handing a task to a different owner, channel-scoped because a task is keyed by (taskId, channelArn).
    conversations('POST', '/admin/tasks/channel/{channelId}/owner', tasksFn);
    // TWO CROSS-CONVERSATION READS, because a task has two principal roles (ADR-024 D8).
    conversations('GET', '/admin/tasks/assignee/{assigneeId}', tasksFn);
    conversations('GET', '/admin/tasks/owned-by/{ownerPersonId}', tasksFn);

    conversations('GET', '/admin/conversations');
    // Message content hangs off the CONVERSATION, so the id is in the path and the vended session policy
    // can pin it. A literal sibling still wins over the parameter in API Gateway's routing.
    conversations('GET', '/admin/conversations/{channelId}/messages');
    // The de-identified copy (`view-clean-conversations`): its own route, so the grant that reaches it
    // never reaches the raw messages beside it.
    conversations('GET', '/admin/conversations/{channelId}/clean');
    // ARCHIVING FROM THE CONSOLE (`archive-conversation`): the same function and sequence a moderator's
    // archive runs (Conversations), by reference.
    conversations('POST', '/admin/conversations/{channelId}/archive', props.conversationManagementFunction);
    // A CONVERSATION'S INVITATIONS (`view-invitations`, `revoke-invitations`, M-10): asked of the invitations
    // function (Conversations), which owns the records and the one revocation. This function's one grant is
    // the invoke; it reaches no table and no Amazon Chime SDK action itself.
    if (props.invitationsFunction) {
      const invitationsFn = new lambdaNodeJs.NodejsFunction(this, 'AdminInvitationsFunction', {
        entry: './lambda/src/admin-invitations.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(20),
        memorySize: 256,
        environment: {
          ...adminAuthEnv(this),
          ADMIN_IAM_ENFORCEMENT: 'true',
          ALLOWED_ORIGINS: adminAppUrl,
          APP_INSTANCE_ARN: props.appInstanceArn,
          INVITATIONS_FUNCTION: props.invitationsFunction.functionArn,
        },
        bundling: { minify: false, forceDockerBundling: false },
      });
      props.invitationsFunction.grantInvoke(invitationsFn);
      conversations('GET', '/admin/conversations/{channelId}/invitations', invitationsFn);
      conversations('POST', '/admin/conversations/{channelId}/invitations/{invitationId}/revoke', invitationsFn);
    }
    conversations('GET', '/admin/conversations/membership-history');
    // WHO the participants are (`see-user-identity`), refusable on its own.
    conversations('GET', '/admin/conversations/identities');
    // One conversation by the id a person gave an operator (`find-conversation`, FR52).
    conversations('GET', '/admin/conversations/find');
    // A TEAM'S CONVERSATIONS: the conversations its assistant was made a member of (FR48).
    conversations('GET', '/admin/assistants/{assistant}/conversations');
    conversations('GET', '/admin/assistants/{assistant}/conversations/find');
    conversations('GET', '/admin/assistants/{assistant}/conversations/{channelId}/messages');
    conversations('GET', '/admin/assistants/{assistant}/conversations/{channelId}/clean');
  }

  // ── THE FEEDBACK SUMMARY (`view-analytics`) ─────────────────────────────────────────────────────────
  //
  // The thumbs-up/down summary the Models tab shows, over the Conversations stack's feedback table. It
  // counts every assistant together, so it has no team route.
  private feedbackSummary(props: AdminServicesStackProps, adminAppUrl: string): void {
    const fn = new lambdaNodeJs.NodejsFunction(this, 'FeedbackSummaryFunction', {
      entry: './lambda/src/user-feedback.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        FEEDBACK_TABLE: props.feedbackTable.tableName,
        ALLOWED_ORIGIN: adminAppUrl,
        APP_INSTANCE_ARN: props.appInstanceArn,
        ...adminAuthEnv(this),
        ADMIN_IAM_ENFORCEMENT: 'true',
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:Scan'], resources: [props.feedbackTable.tableArn] }));
    this.routes.push(adminRoute('feedback', 'GET', '/feedback', fn));
  }
}

/**
 * WHETHER THE REGISTRATION APPROVAL ROUTES EXIST: a guest issuer declaring `guest.registration.approval:
 * 'admin'` and path B's function to approve through. One answer, read by the routes and by the user
 * management function that tells the console whether to ask for them.
 */
function registrationApprovalRouted(props: AdminServicesStackProps, issuers: ReturnType<typeof issuersOf>): boolean {
  const guest = issuers.guest();
  return !!props.guestUpgradeFunction && !!guest && guestSettingsOf(guest).registrationApproval === 'admin';
}
