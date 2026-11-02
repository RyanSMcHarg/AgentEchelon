/**
 * THE ADMIN ANALYTICS QUERY, over whichever archive the deployment keeps. Part of the `AdminServices` stack, its
 * routes on `AdminApi` behind IAM below `/query` in either mode (`analytics` in the capability catalog), as a
 * nested stack of it: one deployable unit, whose resources count against their own template's limit rather
 * than the parent's.
 *
 *  - ATHENA MODE: the query function reads the archive bucket, the Glue catalog and the Athena workgroup
 *    the `Archive` stack owns, by name and reference.
 *  - AURORA MODE: the query function runs in the `Archive` stack's VPC, attached to its pre-authorized
 *    database-client security group (`dbClientSecurityGroup`), with its connection settings and its
 *    `rds-db:connect` resources, after its IAM-auth bootstrap. Beside it, outside the VPC: the
 *    queue-health panel, the classifier-replay starter (which invokes the `Archive` stack's replay
 *    functions), the membership-audit review surface (on the audit's findings table) and, with
 *    `sleepMode`, the admin sleep and wake routes (on the `Archive` stack's sleep function).
 *
 * Every route is IAM-authorized: the console SigV4-signs with its console session, and each capability
 * owns its own resource, so a role is refused at the gateway on any capability it does not hold.
 */
import { CLASSIFIER_REPLAY_PARAM_ROOT, classifierReplayInvoke } from './classification-archive-functions';
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { adminAuthEnv } from './admin-auth-mode';
import { adminOrigin } from '../config/app-origins';
import { adminRoute } from './admin-role-grants';
import type { RouteMethod, RouteSpec } from './http-api';
import { ANALYTICS_CAPABILITY_SUBPATHS } from '../../lambda/src/lib/admin-capability-map';
import { utilityModelArns } from '../config/model-strategy';
import { defaultProfileRegistry as profiles } from '../profile-registry';
import {
  ANALYTICS_DB_NAME, ATHENA_WORKGROUP_NAME, INSTANCE_SSM, SSM_ROOT,
  adminPlaneMembershipStatements, serviceAdminArnOf, battleResourcesOf,
  EVERY_CLASSIFICATION,
} from '../stacks/agent-classification-common';
import { dbLambdaCommandHooks, type ArchiveStackAurora } from '../stacks/archive-stack-aurora';
import { exchangeRoleName } from './exchange-role';
import { CLASSIFICATION_PACK_PREFIX } from '../../lambda/src/lib/profile-bodies';

export interface AdminAnalyticsProps extends cdk.NestedStackProps {
  appInstanceArn: string;
  userPoolId: string;
  /** The archive bucket ARN (both modes). */
  archiveBucketArn: string;
  /** The `Archive` stack in Aurora mode; absent in Athena mode. */
  aurora?: ArchiveStackAurora;
  /** Role ARN -> classification scope (A14 Scoped), read from the caller's assumed-role ARN. */
  classificationRoleScopes: string;
  /** The thumbs table, for the per-variant thumbs join (Aurora mode). */
  feedbackTable: { tableName: string; tableArn: string };
  /**
   * The BattleOutcome table's name when `battle` is declared, for the battle-wins join (Aurora mode).
   * Resolved by the parent stack at deploy from the battle SSM contract (the VPC has no SSM endpoint).
   */
  battleOutcomeTableName?: string;
  /** The attachments bucket ARN, where profile bodies live (the replay starter reads them). */
  attachmentsBucketArn: string;
}

export class AdminAnalytics extends cdk.NestedStack {
  /** The analytics routes, on `AdminApi` below `/query`. */
  public readonly routes: RouteSpec[] = [];

  constructor(scope: Construct, id: string, props: AdminAnalyticsProps) {
    super(scope, id, { description: props.description });
    const adminAppUrl = adminOrigin(this);
    // Every route is IAM-authorized (the admin app SIGNS these requests), and each capability owns its
    // own route, so a role is refused at the gateway on any capability it does not hold.
    const route = (method: RouteMethod, path: string, handler: lambda.IFunction): void => {
      this.routes.push(adminRoute('analytics', method, path, handler));
    };
    if (props.aurora) this.aurora(route, props.aurora, props, adminAppUrl);
    else this.athena(route, props, adminAppUrl);
  }

  private athena(route: (method: RouteMethod, path: string, handler: lambda.IFunction) => void, props: AdminAnalyticsProps, adminAppUrl: string): void {
    const stack = cdk.Stack.of(this);
    const queryRole = new iam.Role(this, 'AnalyticsQueryRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        AthenaQuery: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults'],
              resources: [`arn:aws:athena:${stack.region}:${stack.account}:workgroup/${ATHENA_WORKGROUP_NAME}`],
            }),
            new iam.PolicyStatement({
              actions: ['glue:GetTable', 'glue:GetPartitions', 'glue:GetDatabase'],
              resources: [
                `arn:aws:glue:${stack.region}:${stack.account}:catalog`,
                `arn:aws:glue:${stack.region}:${stack.account}:database/${ANALYTICS_DB_NAME}`,
                `arn:aws:glue:${stack.region}:${stack.account}:table/${ANALYTICS_DB_NAME}/*`,
              ],
            }),
            // Athena verifies the result bucket's region (GetBucketLocation), reads the source data,
            // lists partitions and writes its results to the archive bucket.
            new iam.PolicyStatement({
              actions: ['s3:GetBucketLocation', 's3:GetObject', 's3:ListBucket', 's3:PutObject'],
              resources: [props.archiveBucketArn, `${props.archiveBucketArn}/*`],
            }),
            // The archive bucket is SSE-KMS on the archive's own key. Scoped to KMS-via-S3, which with the
            // bucket statement above is effectively the archive alone.
            new iam.PolicyStatement({
              actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
              resources: ['*'],
              conditions: { StringEquals: { 'kms:ViaService': `s3.${stack.region}.amazonaws.com` } },
            }),
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel'],
              resources: utilityModelArns(stack.region, stack.account),
            }),
          ],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    const queryFn = new lambdaNodeJs.NodejsFunction(this, 'AnalyticsQueryFunction', {
      entry: './lambda/src/analytics-query.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(35),
      memorySize: 256,
      role: queryRole,
      environment: {
        ...adminAuthEnv(this),
        // Trust the gateway-vetted signed principal and enforce queryType -> capability per resource.
        ADMIN_IAM_ENFORCEMENT: 'true',
        ATHENA_WORKGROUP: ATHENA_WORKGROUP_NAME,
        ATHENA_DATABASE: ANALYTICS_DB_NAME,
        ALLOWED_ORIGIN: adminAppUrl,
        // The caller's classification scope, from their assumed-role ARN (lib/caller-scope.ts).
        CLASSIFICATION_ROLE_SCOPES: props.classificationRoleScopes,
        EXCHANGE_ROLE_NAME_PREFIX: exchangeRoleName(''),
        USER_POOL_ID: props.userPoolId,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    route('POST', '/', queryFn);
    for (const { path: subPath } of ANALYTICS_CAPABILITY_SUBPATHS) route('POST', `/${subPath}`, queryFn);
  }

  private aurora(
    route: (method: RouteMethod, path: string, handler: lambda.IFunction) => void,
    aurora: ArchiveStackAurora,
    props: AdminAnalyticsProps,
    adminAppUrl: string,
  ): void {
    const stack = cdk.Stack.of(this);

    // ── THE QUERY, IN THE ARCHIVE'S VPC ──────────────────────────────────────────────────────────
    const queryRole = new iam.Role(this, 'AnalyticsLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')],
      inlinePolicies: {
        RdsIamAuth: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({ actions: ['rds-db:connect'], resources: aurora.dbConnectResources })],
        }),
      },
    });
    const queryFn = new lambdaNodeJs.NodejsFunction(this, 'AnalyticsQueryLambda', {
      entry: path.join(__dirname, '../../lambda/src/analytics-aurora/analytics-query.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 1024,
      vpc: aurora.vpc,
      vpcSubnets: aurora.dbSubnets,
      // PRE-AUTHORIZED: its ingress on 5432 is the Archive stack's own, so this stack attaches to it and
      // never changes the database's security group.
      securityGroups: [aurora.dbClientSecurityGroup],
      role: queryRole,
      environment: {
        ...adminAuthEnv(this),
        ...aurora.dbEnvironment,
        ADMIN_IAM_ENFORCEMENT: 'true',
        ALLOWED_ORIGINS: adminAppUrl,
        CLASSIFICATION_ROLE_SCOPES: props.classificationRoleScopes,
        EXCHANGE_ROLE_NAME_PREFIX: exchangeRoleName(''),
        USER_POOL_ID: props.userPoolId,
        // Thumbs per-variant join, read over the VPC's DynamoDB endpoint.
        FEEDBACK_TABLE: props.feedbackTable.tableName,
        // Battle-wins join: the BattleOutcome table name, resolved at DEPLOY time from the battle SSM
        // contract (the VPC has no SSM endpoint), so the Battle stack deploys first.
        ...(props.battleOutcomeTableName ? { BATTLE_OUTCOME_TABLE: props.battleOutcomeTableName } : {}),
        // Exchanges-per-variant floor before a result is decision-grade. Unset keeps the built-in 30.
        ...(this.node.tryGetContext('minSamplePerVariant')
          ? { MIN_SAMPLE_PER_VARIANT: String(this.node.tryGetContext('minSamplePerVariant')) }
          : {}),
      },
      bundling: {
        externalModules: [],
        minify: true,
        sourceMap: true,
        commandHooks: dbLambdaCommandHooks(), // RDS CA for direct cluster TLS
      },
    });
    // It connects as the users the IAM-auth bootstrap creates, so it deploys after it.
    queryFn.node.addDependency(aurora.iamAuthSetup);
    // The experiment recommendation summarizes an outcome through Bedrock (Haiku); without this grant it
    // degrades to its deterministic heuristic.
    queryFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        ...utilityModelArns(stack.region, stack.account),
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-haiku-*',
        `arn:aws:bedrock:*:${stack.account}:inference-profile/us.anthropic.*`,
      ],
    }));
    queryFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:Scan'], resources: [props.feedbackTable.tableArn] }));
    if (props.battleOutcomeTableName) {
      // The BattleOutcome table by the fixed name the Battle stack creates it under
      // (`CAPABILITY_RESOURCES.battleOutcomeTable`), so the ARN is exact with no cross-stack reference. Read only.
      queryFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Scan'],
        resources: [battleResourcesOf(this).battleOutcomeArn],
      }));
    }
    // POST /query: the `{ queryType }` contract the console's queryAnalytics() uses in both modes.
    route('POST', '/', queryFn);
    for (const p of ['evaluation', 'evaluation/exchanges', 'evaluation/flows', 'conversations', 'drift', 'context', 'model-effectiveness']) {
      route('GET', `/analytics/${p}`, queryFn);
    }
    // A TEAM'S ANALYTICS: the query POST under one assistant (SPEC-ADMIN-CONSOLE FR48), its triage and its
    // labels, each bound by the handler to the path's assistant.
    for (const p of ['query', 'triage', 'ground-truth']) route('POST', `/analytics/assistants/{assistant}/${p}`, queryFn);
    // The SENSITIVE queryTypes each on their own POST route, so a role can be denied one at the gateway.
    for (const { path: subPath } of ANALYTICS_CAPABILITY_SUBPATHS) route('POST', `/${subPath}`, queryFn);

    // ── QUEUE HEALTH, OUTSIDE THE VPC (ADR-033) ─────────────────────────────────────────────────
    //
    // The isolated subnets have no CloudWatch endpoint, so a CloudWatch call from the VPC hangs until the
    // function times out. These numbers need no database.
    const queueHealthFn = new lambdaNodeJs.NodejsFunction(this, 'QueueHealthFn', {
      entry: path.join(__dirname, '../../lambda/src/analytics-aurora/queue-health.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: { ALLOWED_ORIGINS: adminAppUrl, ...adminAuthEnv(this), ADMIN_IAM_ENFORCEMENT: 'true' },
      bundling: { minify: false, forceDockerBundling: false },
    });
    // READ ONLY, and GetMetricData takes no resource.
    queueHealthFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['cloudwatch:GetMetricData'], resources: ['*'] }));
    route('GET', '/analytics/queue-health', queueHealthFn);

    // ── STARTING A CLASSIFIER REPLAY, OUTSIDE THE VPC (DESIGN §5.2) ─────────────────────────────
    //
    // The replay is a batch function in the archive's VPC, and the isolated subnets cannot reach the
    // Lambda control plane, so the hop that starts it originates outside the VPC.
    const replayStartFn = new lambdaNodeJs.NodejsFunction(this, 'ClassifierReplayStartFn', {
      entry: path.join(__dirname, '../../lambda/src/classifier-replay-start.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        ...adminAuthEnv(this),
        ADMIN_IAM_ENFORCEMENT: 'true',
        // One replay function per classification, its classification's own stack's: the starter dispatches a run
        // to the one it finds under the classification's key at call time.
        CLASSIFIER_REPLAY_PARAM_ROOT,
        ALLOWED_ORIGINS: adminAppUrl,
        SSM_ROOT,
        // The body store a version's pack and a classification's pack pointer resolve against.
        PROFILE_BODY_BUCKET: cdk.Fn.select(5, cdk.Fn.split(':', props.attachmentsBucketArn)),
      },
      bundling: { externalModules: ['@aws-sdk/*'], minify: true, sourceMap: true },
    });
    // Any classification's replay, by the replays' name pattern and this instance's tag: the admin plane reaches
    // every classification, with no list.
    for (const st of classifierReplayInvoke(stack)) replayStartFn.addToRolePolicy(st);
    // THE ASSISTANT'S SERVED INTENT PACK, which both candidates classify against, read here because the
    // replay function inside the VPC has no route to SSM.
    replayStartFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadTheAssistantsServedPack',
      actions: ['ssm:GetParameter', 'ssm:GetParameterHistory'],
      resources: [
        `arn:aws:ssm:${stack.region}:${stack.account}:parameter${SSM_ROOT}/assistant/*/definition`,
        `arn:aws:ssm:${stack.region}:${stack.account}:parameter${SSM_ROOT}/assistant/*/assistant-intent-pack`,
      ],
    }));
    replayStartFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadTheVersionBody',
      actions: ['s3:GetObject'],
      // The version bodies, and every classification's pack body behind its parameter's pointer: the
      // admin plane replays any classification's assistant.
      resources: [`${props.attachmentsBucketArn}/profiles/*`, `${props.attachmentsBucketArn}/${CLASSIFICATION_PACK_PREFIX}/*`],
    }));
    route('POST', '/classifier-replay-start', replayStartFn);

    // ── THE MEMBERSHIP-AUDIT REVIEW SURFACE (Layer 6) ─────────────────────────────────────────────
    //
    // The flagged-memberships panel and the runtime enforce toggle, on the audit's findings table.
    const auditTable = aurora.membershipAuditTable;
    if (auditTable) {
      const auditAdminFn = new lambdaNodeJs.NodejsFunction(this, 'MembershipAuditAdminFn', {
        entry: path.join(__dirname, '../../lambda/src/membership-audit-admin.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        environment: {
          ...adminAuthEnv(this),
          ADMIN_IAM_ENFORCEMENT: 'true',
          AUDIT_TABLE: auditTable.tableName,
          ADMIN_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn,
          ALLOWED_ORIGINS: adminAppUrl,
        },
        bundling: { externalModules: ['@aws-sdk/*'], minify: true, sourceMap: true },
      });
      auditTable.grantReadWriteData(auditAdminFn);
      // An administrator's eviction: a classified channel and the service admin's exact ARN (step 38).
      for (const stmt of adminPlaneMembershipStatements('AuditAdminEvicts', props.appInstanceArn, {
        bearerArns: [serviceAdminArnOf(props.appInstanceArn)],
        channelClassifications: EVERY_CLASSIFICATION,
        actions: ['chime:DeleteChannelMembership'],
      })) auditAdminFn.addToRolePolicy(stmt);
      auditAdminFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: INSTANCE_SSM.appInstanceAdminArn.replace(/^\//, '') })],
      }));
      route('GET', '/membership-audit/findings', auditAdminFn);
      route('GET', '/membership-audit/enforce', auditAdminFn);
      route('POST', '/membership-audit/enforce', auditAdminFn);
      route('POST', '/membership-audit/revoke', auditAdminFn);
    }

    // ── SLEEP AND WAKE (SPEC-COST-SLEEP-MODE), on the Archive stack's sleep function ─────────────────
    //
    // By reference: `AdminApi` creates the permission API Gateway needs to call it, beside the API, and
    // the Archive stack takes no reference back.
    if (aurora.deploymentSleepFunction) {
      route('POST', '/deployment/sleep', aurora.deploymentSleepFunction);
      route('POST', '/deployment/wake', aurora.deploymentSleepFunction);
    }
  }
}
