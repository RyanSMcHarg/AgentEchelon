/**
 * Analytics Stack - Aurora Mode
 *
 * Optional Aurora PostgreSQL + VPC deployment for advanced analytics.
 * Activated via CDK context: `analyticsMode: 'aurora'`
 *
 * Provides:
 * - VPC with 2 AZs, PRIVATE_ISOLATED subnets (no NAT)
 * - VPC endpoints: Kinesis (interface), S3 (gateway), Secrets Manager (interface), Bedrock (interface)
 * - Aurora PostgreSQL Serverless v2 (0.5-4 ACU, IAM auth, encrypted)
 * - Optional RDS Proxy (off by default; Lambdas use direct IAM auth to the cluster)
 * - Schema initialization via custom resource Lambda
 * - Kinesis stream + archival Lambda (VPC-attached)
 * - Evaluation runner Lambda (VPC-attached, daily schedule)
 * - Analytics query Lambda (VPC-attached, API Gateway endpoint)
 * - S3 archive bucket (backwards compatible with Athena mode)
 *
 * Cost: dominated by Aurora Serverless v2 compute; RDS Proxy is optional (off by
 * default). See docs/AURORA-MODE-GUIDE.md for the measured cost breakdown.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import { apiAccessLogConfig } from '../constructs/api-access-logging';
import { adminApiMethodOptions, adminAuthEnv } from '../constructs/admin-auth-mode';
import { adminOrigin, sharedOrigins } from '../config/app-origins';
import * as path from 'path';
import { Construct } from 'constructs';
import { IAnalyticsStackOutputs } from '../interfaces/analytics-stack-interface.js';
import { ANALYTICS_PREFIX, INSTANCE_NAME, SHARED_SSM, STACK_PREFIX, INSTANCE_SSM } from './agent-classification-common';
import { MembershipAuditConstruct } from '../constructs/membership-audit';
import { ConversationArchive } from '../constructs/conversation-archive';
import { ANALYTICS_CAPABILITY_SUBPATHS } from '../../lambda/src/lib/admin-capability-map';

/**
 * esbuild commandHooks that copy the RDS CA bundle (`analytics-aurora/certs/*.pem`)
 * into a DB Lambda's asset, so `db-client.ts` can verify the DIRECT Aurora cluster
 * TLS connection after RDS-Proxy removal (the cluster's RDS-CA cert is not in
 * Node's default trust store). Applied to every Lambda that talks to the DB.
 */
function rdsCertCommandHooks(): lambdaNodeJs.ICommandHooks {
  return {
    beforeBundling(inputDir: string, outputDir: string): string[] {
      const certSrc = path.join(inputDir, 'lambda', 'src', 'analytics-aurora', 'certs');
      const certDest = path.join(outputDir, 'certs');
      return process.platform === 'win32'
        ? [`if not exist "${certDest}" mkdir "${certDest}"`, `copy /Y "${certSrc}\\*.pem" "${certDest}\\"`]
        : [`mkdir -p "${certDest}"`, `cp "${certSrc}"/*.pem "${certDest}"/`];
    },
    afterBundling: (): string[] => [],
    beforeInstall: (): string[] => [],
  };
}

export interface AnalyticsStackAuroraProps extends cdk.StackProps {
  appInstanceArn: string;
  /**
   * Cognito User Pool ID for the API Gateway authorizer. Required: every
   * /analytics/* endpoint is authenticated behind this authorizer, so a user's
   * conversations, drift events, and cross-conversation context are never
   * exposed unauthenticated.
   */
  userPoolId: string;
  /** Cognito User Pool ARN (Layer 6 membership audit: AdminListGroupsForUser + AdminGetUser). */
  userPoolArn?: string;
  /**
   * A14 (SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md): the `admins` group's sign-on role
   * ARN. When `-c adminIamEnforcement=true`, the analytics read resources are
   * AWS_IAM-authorized and this role is granted `execute-api:Invoke` on them, so
   * a signing admin is allowed while a finer persona role that omits a capability
   * is denied at the gateway.
   */
  adminSignOnRoleArn?: string;
  /** Layer 6 membership audit (SPEC-CONVERSATION-SECURITY). Opt-in; report-only unless enforce. */
  enableMembershipAudit?: boolean;
  membershipAuditEnforce?: boolean;
  membershipAuditAlertChannelArn?: string;
  senderEmail?: string;
  environment?: 'dev' | 'prod';
  /**
   * BYO existing-VPC. When set, the stack imports this
   * VPC via `ec2.Vpc.fromLookup` instead of creating a dedicated
   * `${prefix}-analytics-vpc`. Lets an Aurora deploy share a VPC already in the
   * account to avoid a second VPC + endpoint
   * footprint. `fromLookup` does a context lookup at synth, so it needs a
   * concrete account/region env. Unset => create a new VPC (default behaviour).
   */
  vpcId?: string;
  /**
   * Which subnet type of the IMPORTED VPC hosts the data plane (Aurora, RDS
   * Proxy, the in-VPC Lambdas). Ignored when creating a new VPC (always
   * isolated). Default 'isolated'.
   */
  vpcSubnetType?: 'isolated' | 'private' | 'public';
  /**
   * Create the Kinesis / Secrets Manager / Bedrock interface endpoints (+ the
   * free S3 gateway endpoint). Default true. Set false ONLY when importing a VPC
   * that already provides AWS-API egress (its own endpoints or a NAT) — that
   * avoids duplicate-endpoint CREATE failures and ~$21/mo of redundant cost. A
   * newly created VPC is NAT-free, so it always needs these.
   */
  createVpcEndpoints?: boolean;
  /**
   * Create an RDS Proxy in front of Aurora for connection pooling. Default false.
   * On Aurora Serverless v2 the proxy bills a fixed 8-ACU minimum (~$86/mo)
   * regardless of load, so it is off by default; Lambdas connect directly to the
   * cluster writer endpoint with IAM auth. Enable only for high-concurrency
   * workloads that need pooling. See docs/AURORA-MODE-GUIDE.md.
   */
  enableRdsProxy?: boolean;
  /**
   * UserFeedback (thumbs) DynamoDB table name + ARN, from the CognitoAuth stack.
   * The analytics-query Lambda scans this at read time for the per-variant
   * thumbs join. Optional: when unset the join
   * is skipped and results render without a thumbs column. Requires the VPC's
   * DynamoDB gateway endpoint (created with the other endpoints).
   */
  feedbackTableName?: string;
  feedbackTableArn?: string;
  /**
   * Whether the opt-in AgentEchelonBattle stack is deployed. When true, the analytics
   * Lambda also folds /battle head-to-head picks into the per-variant results.
   * The BattleOutcome table is
   * created AFTER this stack in bin/backend.ts, so its name is resolved at
   * DEPLOY time via an SSM dynamic reference (not a runtime SSM read — the VPC
   * has no SSM endpoint) and bin adds an explicit dependency on the battle stack
   * so the param exists first. When false the battle join is simply skipped.
   */
  enableBattleJoin?: boolean;
  /**
   * Cost sleep mode (docs/SPEC-COST-SLEEP-MODE.md). When true, this stack also
   * provisions the deployment-state table, the idle checker + EventBridge rule,
   * the admin sleep/wake API, and the SNS notification topic. Auto-sleep pauses
   * Aurora Serverless v2 (ModifyDBCluster → MinCapacity 0) after `sleepAfterIdle`
   * of inactivity; wake restores it. Aurora-mode only (this stack) — inert
   * elsewhere. Off by default.
   */
  sleepMode?: boolean;
  /** Idle threshold before auto-sleep (e.g. '30m', '2h', '1d'). Default '2h'. */
  sleepAfterIdle?: string;
  /** EventBridge cadence for the idle checker. Default 'rate(15 minutes)'. */
  sleepCheckRate?: string;
  /** JSON [{email,name}] to receive sleep/wake notifications (SES-verified in sandbox). */
  sleepRecipients?: Array<{ email: string; name?: string }>;
}

export class AnalyticsStackAurora extends cdk.Stack implements IAnalyticsStackOutputs {
  // IAnalyticsStackOutputs implementation
  public readonly kinesisStreamArn: string;
  public readonly kinesisStreamName: string;
  public readonly archiveBucketArn: string;
  public readonly archiveBucketName: string;
  public readonly analyticsMode = 'aurora' as const;
  public readonly dbProxyEndpoint: string;
  public readonly vpc: ec2.IVpc;
  public readonly dbSecurityGroup: ec2.ISecurityGroup;

  /**
   * Pre-authorized DB-client security group for cross-stack consumers (the
   * per-classification agent handlers that run LIVE drift). Its ingress on 5432 is added
   * to `dbSecurityGroup` INSIDE this stack, so consumers ATTACH to it read-only
   * (`securityGroups: [dbClientSecurityGroup]`) without mutating the Aurora DB
   * SG — that mutation-from-a-classification is what created the synth CYCLE
   * (AnalyticsAurora ⇄ AgentEchelonClassification-*). Same one-SG-per-consumer pattern the
   * in-stack Lambdas (schema-init / setup / archival) already use, but shared.
   */
  public readonly dbClientSecurityGroup: ec2.ISecurityGroup;

  // Cross-stack outputs for the router-agent-handler's live-drift VPC attachment
  // and IAM grants (see agent-classification-common.ts `auroraDriftWiring`).
  public readonly dbProxyArn: string;
  public readonly dbClusterResourceId: string;
  // ARN of the retrieval + drift data-plane Lambda (project decision 018): the
  // non-VPC agent handler invokes it instead of being VPC-attached itself.
  public readonly dataPlaneLambdaArn: string;

  // Additional Aurora-specific outputs
  public readonly analyticsApiUrl: string;

  // Out-of-band per-message analytics table (SPEC-MESSAGE-METADATA-CODEBOOK.md
  // Phase 1; ADR-016). The archival Lambda (this stack) reads it; the per-classification
  // async processors write it — bin passes these to the classification stacks, which are
  // created after this stack, so a direct prop reference is clean.
  public readonly messageAnalyticsTableName: string;
  public readonly messageAnalyticsTableArn: string;

  constructor(scope: Construct, id: string, props: AnalyticsStackAuroraProps) {
    super(scope, id, props);

    const environment = props.environment || 'dev';
    // Account/region-unique Aurora identifiers (secret, cluster, proxy, VPC name)
    // must differ per instance, so they derive from the instance name
    // (`agent-echelon` by default) — two instances never collide.
    const prefix = INSTANCE_NAME;

    // =====================================================
    // VPC - created by default (minimal, no NAT), or an imported BYO VPC
    // =====================================================
    // Default: a dedicated, NAT-free, PRIVATE_ISOLATED VPC (cheapest standalone
    // design). Opt-in: `-c analyticsVpcId=<id>` imports an existing VPC
    // via fromLookup so an Aurora deploy can SHARE a VPC already in the account
    // instead of standing up a second VPC + endpoints.
    const importedVpc = Boolean(props.vpcId);

    const subnetTypeFor = (
      t: 'isolated' | 'private' | 'public',
    ): ec2.SubnetType =>
      t === 'public'
        ? ec2.SubnetType.PUBLIC
        : t === 'private'
          ? ec2.SubnetType.PRIVATE_WITH_EGRESS
          : ec2.SubnetType.PRIVATE_ISOLATED;

    const vpc: ec2.IVpc = importedVpc
      ? ec2.Vpc.fromLookup(this, 'AnalyticsVpc', { vpcId: props.vpcId! })
      : new ec2.Vpc(this, 'AnalyticsVpc', {
          vpcName: `${prefix}-analytics-vpc`,
          maxAzs: 2,
          natGateways: 0,
          subnetConfiguration: [
            {
              cidrMask: 24,
              name: 'isolated',
              subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
          ],
        });

    this.vpc = vpc;

    // Subnet selection for the data plane (Aurora, RDS Proxy, in-VPC Lambdas).
    // A created VPC only has isolated subnets; an imported VPC lets the operator
    // pick which subnet type hosts the data resources (default: isolated).
    const dbSubnets: ec2.SubnetSelection = {
      subnetType: importedVpc
        ? subnetTypeFor(props.vpcSubnetType ?? 'isolated')
        : ec2.SubnetType.PRIVATE_ISOLATED,
    };

    // VPC Endpoints (replace a NAT gateway for AWS service access). Created by
    // default. A new VPC is NAT-free and MUST have them; refusing to create them
    // there would leave the Lambdas with no AWS-API egress. When importing a VPC
    // that already provides egress, skip with `-c createVpcEndpoints=false`.
    const createVpcEndpoints = props.createVpcEndpoints ?? true;
    // RDS Proxy is opt-in (see enableRdsProxy on the props). Off by default because
    // on Aurora Serverless v2 the proxy bills a fixed 8-ACU minimum regardless of
    // load; the analytics Lambdas connect directly to the cluster with IAM auth.
    const enableRdsProxy = props.enableRdsProxy ?? false;
    if (!importedVpc && !createVpcEndpoints) {
      throw new Error(
        'createVpcEndpoints=false is only valid with an imported analyticsVpcId; '
          + 'a newly created isolated VPC has no other AWS-API egress.',
      );
    }
    if (createVpcEndpoints) {
      vpc.addInterfaceEndpoint('KinesisEndpoint', {
        service: ec2.InterfaceVpcEndpointAwsService.KINESIS_STREAMS,
        subnets: dbSubnets,
      });

      vpc.addGatewayEndpoint('S3Endpoint', {
        service: ec2.GatewayVpcEndpointAwsService.S3,
      });

      // Free gateway endpoint (route-table based, like S3) so the in-VPC
      // analytics Lambda can reach DynamoDB for the thumbs per-variant join
      // without a NAT.
      vpc.addGatewayEndpoint('DynamoDbEndpoint', {
        service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      });

      vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        subnets: dbSubnets,
      });

      vpc.addInterfaceEndpoint('BedrockEndpoint', {
        service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
        subnets: dbSubnets,
      });
    }

    // =====================================================
    // Aurora PostgreSQL Serverless v2
    // =====================================================
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'Security group for Aurora PostgreSQL',
      // Aurora cluster never initiates outbound; inside PRIVATE_ISOLATED
      // there's nowhere to go anyway, but defense in depth removes the risk.
      allowAllOutbound: false,
    });

    this.dbSecurityGroup = dbSecurityGroup;

    // Shared DB-client SG for cross-stack consumers (per-classification live-drift
    // handlers). Authorize its ingress to Aurora HERE, inside the Aurora stack,
    // so the classification stacks only REFERENCE it (read-only attach) — no classification→DB-SG
    // mutation, hence no AnalyticsAurora ⇄ AgentEchelonClassification-* cycle. The in-stack
    // Lambdas keep their own per-consumer SGs (below); this one is for
    // out-of-stack consumers.
    const dbClientSecurityGroup = new ec2.SecurityGroup(this, 'DbClientSg', {
      vpc,
      // NOTE: EC2 SecurityGroup GroupDescription is restricted to the char set
      // [a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*] — which excludes BOTH non-ASCII (e.g. a
      // "->" arrow glyph) AND the plain ASCII '>' / '<'. A disallowed char fails
      // CREATE (InvalidParameterValue) and rolls back the whole Aurora stack.
      // Keep this to plain words.
      description: 'Cross-stack DB-client SG: per-classification live-drift handlers to Aurora',
    });
    dbSecurityGroup.addIngressRule(
      dbClientSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow cross-stack live-drift Lambdas to connect to Aurora'
    );
    this.dbClientSecurityGroup = dbClientSecurityGroup;

    // Master credentials in Secrets Manager
    const dbCredentials = new secretsmanager.Secret(this, 'DbCredentials', {
      secretName: `${prefix}/analytics-db/master`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'evaladmin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    // Customer-managed KMS key for the archive plane (Aurora storage + the S3
    // conversation/RAG archive). A single CMK lets a future proof-of-need model
    // gate decryption via key grants (docs/SPEC-ADMIN-IDENTITY.md); today it
    // provides customer-managed encryption at rest. The default key policy
    // delegates to account IAM, so principals get decrypt via their roles below.
    const archiveKey = new kms.Key(this, 'ArchiveKey', {
      description: `${prefix} archive plane CMK (Aurora + S3 conversation/RAG archive)`,
      enableKeyRotation: true,
      alias: `${prefix}-archive`,
      removalPolicy:
        environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Aurora Serverless v2 Cluster
    const dbCluster = new rds.DatabaseCluster(this, 'AnalyticsDb', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.of('15.10', '15'),
      }),
      clusterIdentifier: `${prefix}-analytics`,

      credentials: rds.Credentials.fromSecret(dbCredentials),
      defaultDatabaseName: 'evaluation',

      vpc,
      vpcSubnets: dbSubnets,
      securityGroups: [dbSecurityGroup],

      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 4,

      writer: rds.ClusterInstance.serverlessV2('writer', {
        enablePerformanceInsights: true,
      }),

      iamAuthentication: true,
      storageEncrypted: true,
      storageEncryptionKey: archiveKey,
      deletionProtection: environment === 'prod',

      backup: {
        retention: cdk.Duration.days(7),
      },

      removalPolicy:
        environment === 'prod'
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    });

    // =====================================================
    // Optional RDS Proxy for connection pooling + IAM auth
    // Off by default: on Aurora Serverless v2 the proxy bills a fixed 8-ACU
    // minimum (~$86/mo) regardless of load, so by default the Lambdas connect
    // directly to the cluster writer endpoint with IAM auth (see DB_HOST below).
    // Enable via `enableRdsProxy` only for high-concurrency workloads that need
    // pooling to avoid exhausting the cluster's max_connections.
    // =====================================================
    let dbProxy: rds.DatabaseProxy | undefined;
    if (enableRdsProxy) {
      dbProxy = new rds.DatabaseProxy(this, 'AnalyticsDbProxy', {
        proxyTarget: rds.ProxyTarget.fromCluster(dbCluster),
        vpc,
        vpcSubnets: dbSubnets,
        secrets: [dbCredentials],
        iamAuth: true,
        dbProxyName: `${prefix}-analytics-proxy`,
        securityGroups: [dbSecurityGroup],
      });

      // Escape hatch: Enable end-to-end IAM authentication
      const cfnProxy = dbProxy.node.defaultChild as rds.CfnDBProxy;
      cfnProxy.addPropertyOverride('DefaultAuthScheme', 'IAM_AUTH');
      cfnProxy.addPropertyOverride('Auth', [
        {
          AuthScheme: 'SECRETS',
          IAMAuth: 'REQUIRED',
          SecretArn: dbCredentials.secretArn,
        },
      ]);

      // Grant proxy role permission to connect via IAM
      const proxyRole = dbProxy.node.findChild('IAMRole') as iam.Role;
      proxyRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['rds-db:connect'],
          resources: [
            `arn:aws:rds-db:${this.region}:${this.account}:dbuser:${dbCluster.clusterResourceIdentifier}/evaladmin`,
          ],
        })
      );
    }

    this.dbProxyEndpoint = dbProxy ? dbProxy.endpoint : '';
    this.dbProxyArn = dbProxy ? dbProxy.dbProxyArn : '';
    this.dbClusterResourceId = dbCluster.clusterResourceIdentifier;

    // =====================================================
    // Kinesis Stream
    // =====================================================
    const messageStream = new kinesis.Stream(this, 'MessageStream', {
      // MUST begin with `chime-messaging-` — Chime SDK Messaging rejects
      // PutMessagingStreamingConfigurations with any other stream name
      // ("resource Arn invalid"). The Athena stack already followed this; the
      // Aurora stack didn't, so Chime streaming silently couldn't be wired and
      // nothing was ever archived.
      streamName: `chime-messaging-${ANALYTICS_PREFIX}-aurora`,
      shardCount: 2,
      retentionPeriod: cdk.Duration.hours(24),
      encryption: kinesis.StreamEncryption.MANAGED,
    });

    this.kinesisStreamArn = messageStream.streamArn;
    this.kinesisStreamName = messageStream.streamName;

    // Always-on conversation event archive (system of record for history + audit).
    // Aurora holds the analytics/context projection, but it collapses membership to
    // current-state and does not capture moderator events, so the append-only archive
    // must exist here too. This is a second consumer of the message stream (alongside
    // the Postgres archival Lambda) and is what admin-conversations.ts reads over Athena
    // in Aurora mode. Reuses this stack's ArchiveKey; names come from shared constants so
    // the admin-conversations IAM (cognito-auth-stack) resolves to it unchanged.
    // See docs/MESSAGE-FLOW.md section 6.3.
    new ConversationArchive(this, 'ConversationEventArchive', {
      messageStream,
      encryptionKey: archiveKey,
    });

    // Layer 6: near-real-time membership audit (SPEC-CONVERSATION-SECURITY). Opt-in.
    // Non-VPC (only Chime/Cognito/SSM/SES), so it needs no Aurora access even here.
    let membershipAudit: MembershipAuditConstruct | undefined;
    if (props.enableMembershipAudit && props.userPoolArn) {
      membershipAudit = new MembershipAuditConstruct(this, 'MembershipAudit', {
        stream: messageStream,
        appInstanceArn: props.appInstanceArn,
        userPoolId: props.userPoolId,
        userPoolArn: props.userPoolArn,
        adminArnParam: INSTANCE_SSM.appInstanceAdminArn,
        alertChannelArn: props.membershipAuditAlertChannelArn,
        senderEmail: props.senderEmail,
        enforce: props.membershipAuditEnforce,
      });
    }

    // Wire Chime SDK Messaging to stream channel + message events into the
    // Kinesis stream above (the archival Lambda consumes it). This lived ONLY
    // in the Athena AnalyticsStack — which Aurora-mode deployments never create
    // — so Aurora instances had an empty streaming config and zero archives.
    new cr.AwsCustomResource(this, 'ChimeMessagingStreaming', {
      onCreate: {
        service: 'ChimeSDKMessaging',
        action: 'putMessagingStreamingConfigurations',
        parameters: {
          AppInstanceArn: props.appInstanceArn,
          StreamingConfigurations: [
            { DataType: 'Channel', ResourceArn: messageStream.streamArn },
            { DataType: 'ChannelMessage', ResourceArn: messageStream.streamArn },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.of(`chime-streaming-${props.appInstanceArn}`),
      },
      onUpdate: {
        service: 'ChimeSDKMessaging',
        action: 'putMessagingStreamingConfigurations',
        parameters: {
          AppInstanceArn: props.appInstanceArn,
          StreamingConfigurations: [
            { DataType: 'Channel', ResourceArn: messageStream.streamArn },
            { DataType: 'ChannelMessage', ResourceArn: messageStream.streamArn },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.of(`chime-streaming-${props.appInstanceArn}`),
      },
      onDelete: {
        service: 'ChimeSDKMessaging',
        action: 'deleteMessagingStreamingConfigurations',
        parameters: { AppInstanceArn: props.appInstanceArn },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'chime:PutMessagingStreamingConfigurations',
            'chime:DeleteMessagingStreamingConfigurations',
            'chime:GetMessagingStreamingConfigurations',
          ],
          resources: [props.appInstanceArn],
        }),
        // Chime validates server-side that the caller can write to the target
        // stream, so the custom-resource role needs Kinesis write here too.
        new iam.PolicyStatement({
          actions: [
            'kinesis:PutRecord',
            'kinesis:PutRecords',
            'kinesis:DescribeStream',
            'kinesis:DescribeStreamSummary',
          ],
          resources: [messageStream.streamArn],
        }),
        // Chime defensively (re)creates its service-linked role on first setup.
        new iam.PolicyStatement({
          actions: ['iam:CreateServiceLinkedRole'],
          resources: [
            'arn:aws:iam::*:role/aws-service-role/messaging.chime.amazonaws.com/AWSServiceRoleForChimeSDKMessaging',
          ],
          conditions: {
            StringLike: { 'iam:AWSServiceName': 'messaging.chime.amazonaws.com' },
          },
        }),
      ]),
      installLatestAwsSdk: false,
    });

    // =====================================================
    // S3 Archive Bucket (backwards compatible)
    // =====================================================
    const archiveBucket = new s3.Bucket(this, 'ConversationArchive', {
      bucketName: `${ANALYTICS_PREFIX}-aurora-archive-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: archiveKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true, // deny non-TLS access (aws:SecureTransport)
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    this.archiveBucketName = archiveBucket.bucketName;
    this.archiveBucketArn = archiveBucket.bucketArn;

    // =====================================================
    // Schema Init Custom Resource
    // Runs during deployment to initialize database schema
    // =====================================================
    const schemaInitSg = new ec2.SecurityGroup(this, 'SchemaInitSg', {
      vpc,
      description: 'Security group for schema init Lambda',
    });

    dbSecurityGroup.addIngressRule(
      schemaInitSg,
      ec2.Port.tcp(5432),
      'Allow schema init Lambda to connect to Aurora'
    );

    const schemaInitLambda = new lambdaNodeJs.NodejsFunction(this, 'SchemaInitLambda', {
      entry: path.join(__dirname, '../../lambda/src/analytics-aurora/schema-init.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(120),
      memorySize: 256,
      vpc,
      vpcSubnets: dbSubnets,
      securityGroups: [schemaInitSg],
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        // Include SQL schema files in the bundle
        commandHooks: {
          // Cross-platform: CDK runs these via the host shell — `cmd /c` on
          // Windows (no `mkdir -p`, no `cp`) and `sh -c` on POSIX. Branch on
          // process.platform and build OS-correct paths with path.join so
          // local Windows synth works the same as Linux/CI/Docker.
          beforeBundling(inputDir: string, outputDir: string): string[] {
            const aa = path.join(inputDir, 'lambda', 'src', 'analytics-aurora');
            const schemaSrc = path.join(aa, 'schema');
            const schemaDest = path.join(outputDir, 'schema');
            const certSrc = path.join(aa, 'certs');
            const certDest = path.join(outputDir, 'certs');
            if (process.platform === 'win32') {
              return [
                `if not exist "${schemaDest}" mkdir "${schemaDest}"`,
                `copy /Y "${schemaSrc}\\*.sql" "${schemaDest}\\"`,
                `if not exist "${certDest}" mkdir "${certDest}"`,
                `copy /Y "${certSrc}\\*.pem" "${certDest}\\"`,
              ];
            }
            return [
              `mkdir -p "${schemaDest}"`,
              `cp "${schemaSrc}"/*.sql "${schemaDest}"/`,
              `mkdir -p "${certDest}"`,
              `cp "${certSrc}"/*.pem "${certDest}"/`,
            ];
          },
          afterBundling(): string[] {
            return [];
          },
          beforeInstall(): string[] {
            return [];
          },
        },
      },
    });

    dbCredentials.grantRead(schemaInitLambda);

    const schemaInitProvider = new cr.Provider(this, 'SchemaInitProvider', {
      onEventHandler: schemaInitLambda,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    const schemaInit = new cdk.CustomResource(this, 'SchemaInit', {
      serviceToken: schemaInitProvider.serviceToken,
      properties: {
        SecretArn: dbCredentials.secretArn,
        DbHost: dbCluster.clusterEndpoint.hostname,
        DbPort: '5432',
        DbName: 'evaluation',
        DbUser: 'evaladmin',
        Timestamp: Date.now().toString(), // Force update on each deploy
      },
    });

    schemaInit.node.addDependency(dbCluster);
    if (dbProxy) {
      schemaInit.node.addDependency(dbProxy);
    }

    // =====================================================
    // IAM Auth Setup Custom Resource
    // Grants rds_iam role to database user
    // =====================================================
    const setupLambdaSg = new ec2.SecurityGroup(this, 'SetupLambdaSg', {
      vpc,
      description: 'Security group for IAM auth setup Lambda',
    });

    dbSecurityGroup.addIngressRule(
      setupLambdaSg,
      ec2.Port.tcp(5432),
      'Allow setup Lambda to connect to Aurora'
    );

    const setupLambda = new lambdaNodeJs.NodejsFunction(this, 'IamAuthSetupLambda', {
      entry: path.join(__dirname, '../../lambda/src/analytics-aurora/iam-auth-setup.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      vpc,
      vpcSubnets: dbSubnets,
      securityGroups: [setupLambdaSg],
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        // Include the RDS CA bundle so the direct-to-cluster TLS connection
        // can verify the server cert (see rds-ssl.ts).
        commandHooks: {
          beforeBundling(inputDir: string, outputDir: string): string[] {
            const certSrc = path.join(inputDir, 'lambda', 'src', 'analytics-aurora', 'certs');
            const certDest = path.join(outputDir, 'certs');
            if (process.platform === 'win32') {
              return [
                `if not exist "${certDest}" mkdir "${certDest}"`,
                `copy /Y "${certSrc}\\*.pem" "${certDest}\\"`,
              ];
            }
            return [`mkdir -p "${certDest}"`, `cp "${certSrc}"/*.pem "${certDest}"/`];
          },
          afterBundling(): string[] {
            return [];
          },
          beforeInstall(): string[] {
            return [];
          },
        },
      },
    });

    dbCredentials.grantRead(setupLambda);

    const setupProvider = new cr.Provider(this, 'IamAuthSetupProvider', {
      onEventHandler: setupLambda,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    const iamAuthSetup = new cdk.CustomResource(this, 'IamAuthSetup', {
      serviceToken: setupProvider.serviceToken,
      properties: {
        SecretArn: dbCredentials.secretArn,
        DbHost: dbCluster.clusterEndpoint.hostname,
        DbPort: '5432',
        DbName: 'evaluation',
        DbUser: 'evaladmin',
        Timestamp: Date.now().toString(),
      },
    });

    iamAuthSetup.node.addDependency(schemaInit);

    // =====================================================
    // Helper: Lambda IAM role for RDS Proxy IAM auth
    // =====================================================
    const rdsIamAuthPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          actions: ['rds-db:connect'],
          resources: [
            // Direct cluster IAM auth: the default path (Lambdas connect to the
            // Aurora writer endpoint). Always granted.
            `arn:aws:rds-db:${this.region}:${this.account}:dbuser:${dbCluster.clusterResourceIdentifier}/*`,
            // Proxy IAM auth: only when the optional RDS Proxy is enabled.
            ...(dbProxy
              ? [
                  cdk.Fn.sub(
                    'arn:aws:rds-db:${AWS::Region}:${AWS::AccountId}:dbuser:${ProxyResourceId}/*',
                    {
                      ProxyResourceId: cdk.Fn.select(
                        6,
                        cdk.Fn.split(':', dbProxy.dbProxyArn)
                      ),
                    }
                  ),
                ]
              : []),
          ],
        }),
      ],
    });

    // Common DB environment variables for VPC Lambdas
    const dbEnvironment = {
      DB_HOST: dbProxy ? dbProxy.endpoint : dbCluster.clusterEndpoint.hostname,
      DB_PORT: '5432',
      DB_NAME: 'evaluation',
      DB_USER: 'evaladmin',
      DB_REGION: this.region,
      USE_IAM_AUTH: 'true',
    };

    // =====================================================
    // Kinesis Archival Lambda (VPC-attached)
    // =====================================================
    const archivalLambdaSg = new ec2.SecurityGroup(this, 'ArchivalLambdaSg', {
      vpc,
      description: 'Security group for archival Lambda',
    });

    dbSecurityGroup.addIngressRule(
      archivalLambdaSg,
      ec2.Port.tcp(5432),
      'Allow archival Lambda to connect to Aurora'
    );

    // Titan v2 embedding model ARN for drift detection
    const titanEmbedArn = `arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2*`;

    // Out-of-band per-message analytics table (Phase 1). Keyed by the Chime
    // MessageId; TTL'd (rows are consumed by archival within seconds, the TTL is
    // a replay safety margin — Aurora is the durable store). PAY_PER_REQUEST.
    const messageAnalyticsTable = new dynamodb.Table(this, 'MessageAnalyticsTable', {
      partitionKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY, // transient buffer, not a system of record
    });
    this.messageAnalyticsTableName = messageAnalyticsTable.tableName;
    this.messageAnalyticsTableArn = messageAnalyticsTable.tableArn;

    const archivalLambdaRole = new iam.Role(this, 'ArchivalLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole'
        ),
      ],
      inlinePolicies: {
        RdsIamAuth: rdsIamAuthPolicy,
        KinesisRead: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'kinesis:GetRecords',
                'kinesis:GetShardIterator',
                'kinesis:DescribeStream',
                'kinesis:DescribeStreamSummary',
                'kinesis:ListShards',
              ],
              resources: [messageStream.streamArn],
            }),
          ],
        }),
        // Archival post-hoc drift detection needs Titan v2 embeddings
        BedrockEmbed: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel'],
              resources: [titanEmbedArn],
            }),
          ],
        }),
      },
    });

    const archivalLambda = new lambdaNodeJs.NodejsFunction(
      this,
      'ArchivalLambda',
      {
        entry: path.join(
          __dirname,
          '../../lambda/src/analytics-aurora/kinesis-archival.ts'
        ),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(60),
        memorySize: 512,
        vpc,
        vpcSubnets: dbSubnets,
        securityGroups: [archivalLambdaSg],
        role: archivalLambdaRole,
        environment: {
          ...dbEnvironment,
          // Phase 1: read the out-of-band analytics row by message id.
          MESSAGE_ANALYTICS_TABLE: messageAnalyticsTable.tableName,
        },
        bundling: {
          externalModules: ['@aws-sdk/*'],
          minify: true,
          sourceMap: true,
          commandHooks: rdsCertCommandHooks(), // RDS CA for direct cluster TLS
        },
      }
    );

    // Read-only: archival merges the out-of-band analytics over the slim inline metadata.
    messageAnalyticsTable.grantReadData(archivalLambda);

    archivalLambda.node.addDependency(iamAuthSetup);

    // Add Kinesis event source
    archivalLambda.addEventSource(
      new lambdaEventSources.KinesisEventSource(messageStream, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 100,
        maxBatchingWindow: cdk.Duration.seconds(5),
        retryAttempts: 3,
        bisectBatchOnError: true,
      })
    );

    // =====================================================
    // Evaluation Runner Lambda (VPC-attached, daily schedule)
    // =====================================================
    const evaluationLambdaSg = new ec2.SecurityGroup(
      this,
      'EvaluationLambdaSg',
      {
        vpc,
        description: 'Security group for evaluation Lambda',
      }
    );

    dbSecurityGroup.addIngressRule(
      evaluationLambdaSg,
      ec2.Port.tcp(5432),
      'Allow evaluation Lambda to connect to Aurora'
    );

    const evaluationLambdaRole = new iam.Role(this, 'EvaluationLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole'
        ),
      ],
      inlinePolicies: {
        RdsIamAuth: rdsIamAuthPolicy,
        BedrockInvoke: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel'],
              resources: [
                'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-haiku-*',
                'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-haiku-*',
                'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet-*',
                `arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.*`,
              ],
            }),
          ],
        }),
        S3Access: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:GetObject', 's3:PutObject'],
              resources: [
                archiveBucket.bucketArn,
                `${archiveBucket.bucketArn}/*`,
              ],
            }),
            // The archive bucket is SSE-KMS on the customer CMK: get/put need key access.
            new iam.PolicyStatement({
              actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
              resources: [archiveKey.keyArn],
            }),
          ],
        }),
      },
    });

    // Aurora-native evaluation runner: reads unscored exchanges from Aurora,
    // scores with Bedrock, writes evaluation_results (the table the dashboard
    // reads).
    const evaluationLambda = new lambdaNodeJs.NodejsFunction(
      this,
      'EvaluationLambda',
      {
        entry: path.join(
          __dirname,
          '../../lambda/src/analytics-aurora/evaluation-runner.ts'
        ),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.minutes(15),
        memorySize: 1024,
        vpc,
        vpcSubnets: dbSubnets,
        securityGroups: [evaluationLambdaSg],
        role: evaluationLambdaRole,
        environment: {
          ...dbEnvironment,
          ARCHIVE_BUCKET: archiveBucket.bucketName,
          EVALUATOR_MODEL: 'anthropic.claude-3-haiku-20240307-v1:0',
        },
        bundling: {
          externalModules: ['@aws-sdk/*'],
          minify: true,
          sourceMap: true,
          // Ship the RDS CA bundle so db-client can verify the DIRECT cluster
          // TLS connection after RDS-Proxy removal (see rdsCertCommandHooks).
          // Every other Aurora-connecting Lambda has this; the eval runner was
          // missed in that migration, so it failed TLS ("unable to get local
          // issuer certificate") on every daily run.
          commandHooks: rdsCertCommandHooks(),
        },
      }
    );

    evaluationLambda.node.addDependency(iamAuthSetup);

    // Evaluation schedule — every 30 min (was daily 2am UTC). Frequent runs are cheap: the EventBridge
    // rule is ~free, a run with nothing to score exits in ~1s, and the Bedrock evaluator cost is
    // per-EXCHANGE (each scored once via getUnscoredExchanges), not per-run — so cadence barely affects
    // cost, it just lowers the latency from "message sent" to "score visible". (Construct id kept to
    // avoid replacing the rule.)
    new events.Rule(this, 'DailyEvaluationSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(30)),
      targets: [
        new targets.LambdaFunction(evaluationLambda, {
          event: events.RuleTargetInput.fromObject({
            action: 'scheduled-evaluation',
          }),
        }),
      ],
    });

    // Expose the evaluation runner so validate.mjs can invoke it on demand at the end of an e2e run
    // (score the freshly-generated exchanges immediately instead of waiting for the next schedule tick).
    new cdk.CfnOutput(this, 'EvaluationLambdaName', {
      value: evaluationLambda.functionName,
      description: 'Evaluation runner Lambda — invoke to score unscored exchanges/flows on demand.',
    });

    // =====================================================
    // Summary Updater Lambda (VPC-attached, scheduled)
    // Per SPEC-DRIFT-CONVERGENCE.md "Summary Updater" section.
    // Generates conversation_summaries rows for channels with new activity;
    // writes summary_embeddings inline. Time-only trigger.
    // =====================================================
    const summaryUpdaterLambdaSg = new ec2.SecurityGroup(this, 'SummaryUpdaterLambdaSg', {
      vpc,
      description: 'Security group for summary-updater Lambda',
    });
    dbSecurityGroup.addIngressRule(
      summaryUpdaterLambdaSg,
      ec2.Port.tcp(5432),
      'Allow summary-updater Lambda to connect to Aurora',
    );

    const summaryUpdaterLambdaRole = new iam.Role(this, 'SummaryUpdaterLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole',
        ),
      ],
      inlinePolicies: {
        RdsIamAuth: rdsIamAuthPolicy,
        // Haiku for summarization + Titan v2 for embedding the produced summary
        BedrockInvoke: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel'],
              resources: [
                'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-haiku-*',
                'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-haiku-*',
                titanEmbedArn,
              ],
            }),
          ],
        }),
      },
    });

    const summaryUpdaterLambda = new lambdaNodeJs.NodejsFunction(
      this,
      'SummaryUpdaterLambda',
      {
        entry: path.join(
          __dirname,
          '../../lambda/src/analytics-aurora/summary-updater.ts',
        ),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.minutes(10),
        memorySize: 1024,
        vpc,
        vpcSubnets: dbSubnets,
        securityGroups: [summaryUpdaterLambdaSg],
        role: summaryUpdaterLambdaRole,
        environment: {
          ...dbEnvironment,
          SUMMARY_MODEL_ID: 'anthropic.claude-3-haiku-20240307-v1:0',
          DRIFT_EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
          SUMMARY_BATCH_LIMIT: '20',
          SUMMARY_MAX_MESSAGES: '50',
        },
        bundling: {
          externalModules: ['@aws-sdk/*'],
          minify: true,
          sourceMap: true,
          commandHooks: rdsCertCommandHooks(), // RDS CA for direct cluster TLS
        },
      },
    );
    summaryUpdaterLambda.node.addDependency(iamAuthSetup);

    new events.Rule(this, 'SummaryUpdaterSchedule', {
      // Every 30 minutes. Lambda finds channels with messages newer than
      // their newest summary and refreshes them. Adjust via the env var
      // SUMMARY_UPDATER_INTERVAL_MIN if a deployer wants faster freshness.
      schedule: events.Schedule.rate(cdk.Duration.minutes(30)),
      targets: [new targets.LambdaFunction(summaryUpdaterLambda)],
    });

    // =====================================================
    // Drift Abandonment Detector Lambda (VPC-attached, scheduled)
    // Per SPEC-DRIFT-CONVERGENCE.md "Abandonment Detector" section.
    // Marks drift_events rows where the user accepted but never engaged.
    // =====================================================
    const abandonmentLambdaSg = new ec2.SecurityGroup(this, 'AbandonmentLambdaSg', {
      vpc,
      description: 'Security group for drift abandonment-detector Lambda',
    });
    dbSecurityGroup.addIngressRule(
      abandonmentLambdaSg,
      ec2.Port.tcp(5432),
      'Allow abandonment-detector Lambda to connect to Aurora',
    );

    const abandonmentLambdaRole = new iam.Role(this, 'AbandonmentLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole',
        ),
      ],
      inlinePolicies: {
        RdsIamAuth: rdsIamAuthPolicy,
      },
    });

    const abandonmentLambda = new lambdaNodeJs.NodejsFunction(
      this,
      'AbandonmentDetectorLambda',
      {
        entry: path.join(
          __dirname,
          '../../lambda/src/analytics-aurora/abandonment-detector.ts',
        ),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.minutes(2),
        memorySize: 512,
        vpc,
        vpcSubnets: dbSubnets,
        securityGroups: [abandonmentLambdaSg],
        role: abandonmentLambdaRole,
        environment: {
          ...dbEnvironment,
          ABANDONMENT_WINDOW_MIN: '5',
          ABANDONMENT_BATCH_LIMIT: '100',
        },
        bundling: {
          externalModules: ['@aws-sdk/*'],
          minify: true,
          sourceMap: true,
          commandHooks: rdsCertCommandHooks(), // RDS CA for direct cluster TLS
        },
      },
    );
    abandonmentLambda.node.addDependency(iamAuthSetup);

    new events.Rule(this, 'AbandonmentDetectorSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(abandonmentLambda)],
    });

    // =====================================================
    // Document Ingestion Lambda (VPC-attached, S3-triggered) — RAG
    // proof-point. Triggers on PutObject under the `rag/` prefix of
    // the archive bucket; chunks the file, embeds via Titan v2,
    // writes to the `embeddings` table.
    //
    // ADR-001 + ADR-002: Aurora pgvector @ 1024-dim is the KB backing.
    // The archive bucket already exists (it backs Kinesis archival);
    // adding `rag/` as a corpus prefix avoids provisioning another
    // bucket. Lifecycle rules already block-public-access + encrypt.
    // =====================================================
    const documentIngestionLambdaSg = new ec2.SecurityGroup(
      this,
      'DocumentIngestionLambdaSg',
      {
        vpc,
        description: 'Security group for document-ingestion Lambda (RAG)',
      },
    );
    dbSecurityGroup.addIngressRule(
      documentIngestionLambdaSg,
      ec2.Port.tcp(5432),
      'Allow document-ingestion Lambda to connect to Aurora',
    );

    const documentIngestionLambdaRole = new iam.Role(
      this,
      'DocumentIngestionLambdaRole',
      {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            'service-role/AWSLambdaVPCAccessExecutionRole',
          ),
        ],
        inlinePolicies: {
          RdsIamAuth: rdsIamAuthPolicy,
          BedrockEmbed: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ['bedrock:InvokeModel'],
                resources: [titanEmbedArn],
              }),
            ],
          }),
          S3RagRead: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ['s3:GetObject'],
                // Scoped to the rag/ prefix only — the ingestion Lambda
                // has no business reading conversation archives.
                resources: [`${archiveBucket.bucketArn}/rag/*`],
              }),
              // SSE-KMS archive: reading an object needs decrypt on the customer CMK.
              new iam.PolicyStatement({
                actions: ['kms:Decrypt'],
                resources: [archiveKey.keyArn],
              }),
            ],
          }),
        },
      },
    );

    const documentIngestionLambda = new lambdaNodeJs.NodejsFunction(
      this,
      'DocumentIngestionLambda',
      {
        entry: path.join(
          __dirname,
          '../../lambda/src/analytics-aurora/document-ingestion.ts',
        ),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        // Ingestion is bounded by max-chunks-per-doc (200) × Titan embed
        // latency (~100-300ms warm). 5 min is plenty for a 200-chunk doc.
        timeout: cdk.Duration.minutes(5),
        memorySize: 1024,
        vpc,
        vpcSubnets: dbSubnets,
        securityGroups: [documentIngestionLambdaSg],
        role: documentIngestionLambdaRole,
        environment: {
          ...dbEnvironment,
          DRIFT_EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
        },
        bundling: {
          externalModules: ['@aws-sdk/*'],
          minify: true,
          sourceMap: true,
          // Ship the RDS CA bundle so db-client verifies the DIRECT cluster TLS
          // connection after RDS-Proxy removal (see rdsCertCommandHooks).
          commandHooks: rdsCertCommandHooks(),
        },
      },
    );
    documentIngestionLambda.node.addDependency(iamAuthSetup);

    // S3 → Lambda notification, filtered to the rag/ prefix. Using the
    // L2 EventBridge target would be cleaner but it has a deploy-time
    // race with the bucket's eventbridge configuration; the L1
    // BucketNotification flows directly to Lambda invoke.
    archiveBucket.addObjectCreatedNotification(
      new s3n.LambdaDestination(documentIngestionLambda),
      { prefix: 'rag/' },
    );

    // =====================================================
    // Retrieval + drift DATA-PLANE Lambda (project decision 018)
    // VPC-attached; runs RAG retrieval + drift detection (embed + pgvector) so
    // the Lex-facing agent handler can stay NON-VPC and invoke it. Reuses the
    // existing Bedrock + Secrets endpoints + the in-VPC Aurora proxy, so it adds
    // no new VPC endpoints. See docs/RAG.md, docs/INFRASTRUCTURE-COST.md.
    // =====================================================
    const dataPlaneLambdaSg = new ec2.SecurityGroup(this, 'DataPlaneLambdaSg', {
      vpc,
      description: 'Security group for retrieval + drift data-plane Lambda',
    });
    dbSecurityGroup.addIngressRule(
      dataPlaneLambdaSg,
      ec2.Port.tcp(5432),
      'Allow data-plane Lambda to connect to Aurora',
    );

    const dataPlaneLambdaRole = new iam.Role(this, 'DataPlaneLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole',
        ),
      ],
      inlinePolicies: {
        RdsIamAuth: rdsIamAuthPolicy,
        BedrockEmbed: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel'],
              resources: [titanEmbedArn],
            }),
          ],
        }),
      },
    });

    const dataPlaneLambda = new lambdaNodeJs.NodejsFunction(
      this,
      'DataPlaneLambda',
      {
        entry: path.join(
          __dirname,
          '../../lambda/src/analytics-aurora/data-plane-handler.ts',
        ),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        // Synchronous per-turn call from the agent handler: embed (~100-300ms
        // warm) + one pgvector query. Well under the handler's 30s fulfillment
        // budget; drift and retrieval both skip trivial intents upstream.
        timeout: cdk.Duration.seconds(15),
        memorySize: 1024,
        vpc,
        vpcSubnets: dbSubnets,
        securityGroups: [dataPlaneLambdaSg],
        role: dataPlaneLambdaRole,
        environment: {
          ...dbEnvironment,
          DRIFT_EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
        },
        bundling: {
          externalModules: ['@aws-sdk/*'],
          minify: true,
          sourceMap: true,
          // Ship the RDS CA bundle so db-client verifies the DIRECT cluster TLS
          // connection after RDS-Proxy removal (see rdsCertCommandHooks).
          commandHooks: rdsCertCommandHooks(),
        },
      },
    );
    dataPlaneLambda.node.addDependency(iamAuthSetup);
    this.dataPlaneLambdaArn = dataPlaneLambda.functionArn;

    // Publish the data-plane ARN to SSM so the admin-conversations handler (in the
    // CognitoAuth stack) can resolve it at RUNTIME. A direct CDK prop would be a
    // circular dependency — the Aurora stack already depends on CognitoAuth's user
    // pool + feedback table. See BUG #21 / SHARED_SSM.auroraDataPlaneArn.
    new ssm.StringParameter(this, 'DataPlaneArnParam', {
      parameterName: SHARED_SSM.auroraDataPlaneArn,
      stringValue: dataPlaneLambda.functionArn,
      description: 'Aurora data-plane Lambda ARN for the admin-conversations read path (BUG #21).',
    });

    // The premium + standard async processors need read access to
    // pgvector via the RDS Proxy + Bedrock for query embedding. Those
    // Lambdas live in the per-classification AgentEchelonClassification-* stacks and are wired
    // into the VPC separately when enableLiveDrift=true — the same path also
    // gives them the embeddings table access (see agent-classification-common.ts
    // `auroraDriftWiring`).

    // =====================================================
    // Analytics Query Lambda + API Gateway (VPC-attached)
    // =====================================================
    const analyticsLambdaSg = new ec2.SecurityGroup(this, 'AnalyticsLambdaSg', {
      vpc,
      description: 'Security group for analytics query Lambda',
    });

    dbSecurityGroup.addIngressRule(
      analyticsLambdaSg,
      ec2.Port.tcp(5432),
      'Allow analytics Lambda to connect to Aurora'
    );

    const analyticsLambdaRole = new iam.Role(this, 'AnalyticsLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole'
        ),
      ],
      inlinePolicies: {
        RdsIamAuth: rdsIamAuthPolicy,
      },
    });

    const analyticsLambda = new lambdaNodeJs.NodejsFunction(
      this,
      'AnalyticsQueryLambda',
      {
        entry: path.join(
          __dirname,
          '../../lambda/src/analytics-aurora/analytics-query.ts'
        ),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(30),
        memorySize: 1024,
        vpc,
        vpcSubnets: dbSubnets,
        securityGroups: [analyticsLambdaSg],
        role: analyticsLambdaRole,
        environment: {
          ...adminAuthEnv(this),
          ...dbEnvironment,
          // Admin-only analytics query API → the admin console origin.
          ALLOWED_ORIGINS: adminOrigin(this),
          // Thumbs per-variant join. Empty => join skipped.
          ...(props.feedbackTableName ? { FEEDBACK_TABLE: props.feedbackTableName } : {}),
          // Battle-wins join. The
          // BattleOutcome table name is resolved at DEPLOY time from the battle
          // stack's SSM contract (it deploys first; see the dependency in bin).
          // Empty when /battle is off => the battle join is skipped.
          ...(props.enableBattleJoin
            ? { BATTLE_OUTCOME_TABLE: ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.battleOutcomeName) }
            : {}),
        },
        bundling: {
          externalModules: [],
          minify: true,
          sourceMap: true,
          commandHooks: rdsCertCommandHooks(), // RDS CA for direct cluster TLS
        },
      }
    );

    analyticsLambda.node.addDependency(iamAuthSetup);

    // The /analytics/experiments/recommendation endpoint
    // (analytics-query.ts getExperimentRecommendation) summarises an A/B
    // outcome into a verdict + rationale via Bedrock (Haiku). Without this grant
    // the endpoint still works but degrades to its deterministic heuristic fallback.
    analyticsLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-haiku-*',
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-haiku-*',
          `arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.*`,
        ],
      }),
    );

    // Thumbs per-variant join: read-only Scan
    // on the CognitoAuth UserFeedback table so the Experiments results can show
    // thumbs alongside the evaluator score. Scoped to the one table; absent when
    // the table wasn't wired (join silently skipped at runtime).
    if (props.feedbackTableArn) {
      analyticsLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:Scan'],
          resources: [props.feedbackTableArn],
        }),
      );
    }

    // Battle-wins join: read-only Scan
    // on the BattleOutcome table. Its exact ARN isn't known at synth here (the
    // battle stack is created after this one), so scope to the battle stack's
    // table-name prefix (`${STACK_PREFIX}Battle*`) — read-only, bounded to that
    // stack's tables. Only granted when /battle is enabled.
    if (props.enableBattleJoin) {
      analyticsLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:Scan'],
          resources: [
            `arn:aws:dynamodb:${this.region}:${this.account}:table/${STACK_PREFIX}Battle*`,
          ],
        }),
      );
    }

    // Every /analytics/* method below requires a valid Cognito session, and
    // CORS is restricted to the configured appUrl context. The Lambda performs
    // a defense-in-depth admin-group check too — the gateway authorizer is the
    // outer ring.
    const appUrl = this.node.tryGetContext('appUrl') || 'http://localhost:5173';
    // The analytics + membership-audit APIs are admin-only → the admin console
    // origin. (The client-events ingestion + deployment-state APIs below stay
    // chat-facing on appUrl.) SPEC-SEPARATE-ADMIN-APP.md.
    const adminAppUrl = adminOrigin(this);
    // Admin-plane auth mode (ae-cognito default / federated / service) — see
    // docs/ADMIN-INTEGRATION-GUIDE.md. In ae-cognito mode this uses a Cognito
    // authorizer on AE's own user pool.
    // A14: when adminIamEnforcement is on, the analytics READ plane is
    // AWS_IAM-authorized (the console SigV4-signs with its sign-on creds and the
    // per-resource split gates each capability). Default = the Cognito authorizer,
    // unchanged. Flipping the shared options flips every analytics-query method at
    // once and (like the admin-conversations API) avoids creating an unused Cognito
    // authorizer in IAM mode.
    const adminIamEnforcement = this.node.tryGetContext('adminIamEnforcement') === true
      || this.node.tryGetContext('adminIamEnforcement') === 'true';
    const authMethodOptions: apigateway.MethodOptions = adminIamEnforcement
      ? { authorizationType: apigateway.AuthorizationType.IAM }
      : adminApiMethodOptions(this, 'AuroraAnalyticsAuthorizer', { userPoolId: props.userPoolId });
    if (adminIamEnforcement) {
      // Trust the gateway-vetted signed principal + enforce queryType->capability
      // per resource (analytics-query.ts). Set only here — other Lambdas stay Cognito.
      analyticsLambda.addEnvironment('ADMIN_IAM_ENFORCEMENT', 'true');
    }

    // API Gateway
    const analyticsApi = new apigateway.RestApi(this, 'AnalyticsApi', {
      restApiName: `${prefix}-aurora-analytics`,
      description: 'Analytics API (Aurora mode) for admin dashboard',
      deployOptions: {
        stageName: environment,
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
        // Access logging.
        ...apiAccessLogConfig(this, 'AuroraAnalyticsApiAccessLogs'),
      },
      defaultCorsPreflightOptions: {
        // This RestApi co-hosts admin routes (/analytics/*, /audit/*) AND the
        // chat-facing /events ingestion route, so the shared OPTIONS preflight
        // must allow BOTH origins. Each Lambda still echoes only its own origin
        // in the actual response (analytics/audit -> adminAppUrl; events -> appUrl).
        allowOrigins: sharedOrigins(this),
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // Gateway CORS for error responses (incl. 401 from the analytics authorizer).
    // Static single-origin: these primarily surface analytics-query/authorizer
    // errors to the admin console, so they carry the admin origin.
    analyticsApi.addGatewayResponse('GatewayResponse4XX', {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': `'${adminAppUrl}'`,
        'Access-Control-Allow-Headers': "'Content-Type,Authorization'",
        'Access-Control-Allow-Methods': "'GET,POST,OPTIONS'",
      },
    });
    analyticsApi.addGatewayResponse('GatewayResponse5XX', {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': `'${adminAppUrl}'`,
        'Access-Control-Allow-Headers': "'Content-Type,Authorization'",
        'Access-Control-Allow-Methods': "'GET,POST,OPTIONS'",
      },
    });

    const analyticsIntegration = new apigateway.LambdaIntegration(
      analyticsLambda,
      { allowTestInvoke: false }
    );

    // Routes — all admin-authed (see audit C1).
    // POST / (root) — the Athena-style { queryType } contract the frontend's
    // queryAnalytics() uses for both modes. The Lambda bridges queryType to the
    // GET query fns and normalizes the result (analytics-query.ts handlePostQuery).
    // VITE_ANALYTICS_API_URL is the stage base, so the frontend POSTs here.
    analyticsApi.root.addMethod('POST', analyticsIntegration, authMethodOptions);

    const analyticsResource = analyticsApi.root.addResource('analytics');
    const evaluationResource = analyticsResource.addResource('evaluation');
    evaluationResource.addMethod('GET', analyticsIntegration, authMethodOptions);
    evaluationResource.addResource('exchanges').addMethod('GET', analyticsIntegration, authMethodOptions);
    evaluationResource.addResource('flows').addMethod('GET', analyticsIntegration, authMethodOptions);

    const conversationsResource = analyticsResource.addResource('conversations');
    conversationsResource.addMethod('GET', analyticsIntegration, authMethodOptions);

    const driftResource = analyticsResource.addResource('drift');
    driftResource.addMethod('GET', analyticsIntegration, authMethodOptions);

    const contextResource = analyticsResource.addResource('context');
    contextResource.addMethod('GET', analyticsIntegration, authMethodOptions);

    const modelEffectivenessResource = analyticsResource.addResource('model-effectiveness');
    modelEffectivenessResource.addMethod('GET', analyticsIntegration, authMethodOptions);

    // A14 per-capability resources: the SENSITIVE queryTypes get their own POST
    // resource so a persona role can be denied one at the gateway without losing
    // the low-sensitivity analytics bundle (which stays on the root POST). The
    // handler enforces that a queryType only runs on its capability's path
    // (admin-capability-map.ts). Created in both modes (harmless + unused under
    // Cognito, where the frontend posts everything to the root); IAM-authorized +
    // frontend-routed under the flag.
    for (const { path: subPath } of ANALYTICS_CAPABILITY_SUBPATHS) {
      analyticsApi.root.addResource(subPath).addMethod('POST', analyticsIntegration, authMethodOptions);
    }

    // A14 sign-on-role teeth: the `admins` group's role gets execute-api:Invoke on
    // the whole analytics API (admins = Full on every capability, SPEC section 4).
    // Finer persona roles get per-capability grants (see the persona wiring); a
    // role that omits a capability's resource is denied at the gateway.
    if (adminIamEnforcement && props.adminSignOnRoleArn) {
      const adminRole = iam.Role.fromRoleArn(this, 'ImportedAdminSignOnRole', props.adminSignOnRoleArn, { mutable: true });
      adminRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['execute-api:Invoke'],
        resources: [analyticsApi.arnForExecuteApi()],
      }));
    }

    // Membership-audit review surface (Layer 6): admin API for the flagged-memberships panel and
    // the runtime enforce toggle. NON-VPC (DynamoDB + Chime + SSM only), like the sleep API. Only
    // wired when the audit is enabled, and hangs off the same admin-authed analytics API.
    if (membershipAudit) {
      const auditAdminFn = new lambdaNodeJs.NodejsFunction(this, 'MembershipAuditAdminFn', {
        entry: path.join(__dirname, '../../lambda/src/membership-audit-admin.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        environment: {
          ...adminAuthEnv(this),
          AUDIT_TABLE: membershipAudit.auditTable.tableName,
          ADMIN_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn,
          ALLOWED_ORIGINS: adminAppUrl,
        },
        bundling: { externalModules: ['@aws-sdk/*'], minify: true, sourceMap: true },
      });
      membershipAudit.auditTable.grantReadWriteData(auditAdminFn);
      auditAdminFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['chime:DeleteChannelMembership'],
        resources: [`${props.appInstanceArn}/channel/*`, `${props.appInstanceArn}/user/*`],
      }));
      auditAdminFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: INSTANCE_SSM.appInstanceAdminArn.replace(/^\//, ''),
          }),
        ],
      }));

      const auditIntegration = new apigateway.LambdaIntegration(auditAdminFn, { allowTestInvoke: false });
      const auditOpts = adminApiMethodOptions(this, 'MembershipAuditAdminAuthorizer', { userPoolId: props.userPoolId });
      const auditRes = analyticsApi.root.addResource('membership-audit');
      auditRes.addResource('findings').addMethod('GET', auditIntegration, auditOpts);
      const enforceRes = auditRes.addResource('enforce');
      enforceRes.addMethod('GET', auditIntegration, auditOpts);
      enforceRes.addMethod('POST', auditIntegration, auditOpts);
      auditRes.addResource('revoke').addMethod('POST', auditIntegration, auditOpts);
    }

    // Client-events capture (#A). Aurora mode has no client-events Firehose, so
    // the /events endpoint writes to Aurora `client_events` via the data-plane
    // Lambda (same stack → wire the ARN directly, no SSM/circular concern). This
    // populates the Overview session/user/WebSocket rollups (empty otherwise).
    // Authorized for ANY signed-in user (their own claims), NOT admin — mirrors
    // the Athena stack's /events route.
    const clientEventsFn = new lambdaNodeJs.NodejsFunction(this, 'ClientEventsFunction', {
      entry: './lambda/src/client-events.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        ALLOWED_ORIGIN: appUrl,
        AURORA_DATA_PLANE_ARN: dataPlaneLambda.functionArn,
      },
      bundling: { externalModules: ['@aws-sdk/*'], minify: true, sourceMap: true },
    });
    dataPlaneLambda.grantInvoke(clientEventsFn);

    const eventsUserPool = cognito.UserPool.fromUserPoolId(this, 'ClientEventsUserPool', props.userPoolId);
    const clientEventsAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'ClientEventsAuthorizer', {
      cognitoUserPools: [eventsUserPool],
    });
    analyticsApi.root.addResource('events').addMethod(
      'POST',
      new apigateway.LambdaIntegration(clientEventsFn, { allowTestInvoke: false }),
      { authorizer: clientEventsAuthorizer, authorizationType: apigateway.AuthorizationType.COGNITO },
    );

    new cdk.CfnOutput(this, 'ClientEventsApiUrl', {
      value: `${analyticsApi.url}events`,
      description: 'Client-events ingest endpoint (Aurora mode). Frontend VITE_CLIENT_EVENTS_API_URL.',
    });

    this.analyticsApiUrl = analyticsApi.url;

    // =====================================================
    // Outputs
    // =====================================================
    new cdk.CfnOutput(this, 'KinesisStreamArn', {
      value: messageStream.streamArn,
      description: 'Kinesis stream ARN for Chime SDK streaming configuration',
      exportName: `${this.stackName}-KinesisStreamArn`,
    });

    new cdk.CfnOutput(this, 'KinesisStreamName', {
      value: messageStream.streamName,
    });

    new cdk.CfnOutput(this, 'ArchiveBucketName', {
      value: archiveBucket.bucketName,
    });

    new cdk.CfnOutput(this, 'ArchiveBucketArn', {
      value: archiveBucket.bucketArn,
    });

    if (dbProxy) {
      new cdk.CfnOutput(this, 'DbProxyEndpoint', {
        value: dbProxy.endpoint,
        description: 'RDS Proxy endpoint for Aurora PostgreSQL',
      });
    }

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID for analytics infrastructure',
    });

    new cdk.CfnOutput(this, 'AnalyticsApiUrl', {
      value: analyticsApi.url,
      description: 'Analytics API URL',
    });

    // Always emitted so gen-frontend-env can gate the DeploymentStatusBanner probe.
    // When sleep mode is off the GET /deployment/state route is never created, so the
    // frontend must not poll it (else every poll gets API Gateway's 403 for good).
    new cdk.CfnOutput(this, 'SleepModeEnabled', {
      value: String(!!props.sleepMode),
      description: 'Whether cost sleep mode (GET /deployment/state) is deployed.',
    });

    // --- Cost sleep mode (opt-in; docs/SPEC-COST-SLEEP-MODE.md) --------------
    if (props.sleepMode) {
      // Single-item state record; doubles as the app-level maintenance flag.
      const stateTable = new dynamodb.Table(this, 'DeploymentStateTable', {
        tableName: `${prefix}-deployment-state`,
        partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      // SNS → email: sleep/wake notices, chosen over a Chime channel because
      // email still delivers while the deployment is asleep.
      const sleepTopic = new sns.Topic(this, 'SleepTopic', {
        topicName: `${prefix}-deployment-sleep`,
        displayName: 'Deployment sleep/wake',
      });
      for (const r of props.sleepRecipients ?? []) {
        if (r?.email) sleepTopic.addSubscription(new snsSubs.EmailSubscription(r.email));
      }

      // Checker + admin API in one Lambda. NON-VPC on purpose: it only makes
      // control-plane RDS/DDB/SNS calls and never connects to the DB, so it
      // keeps default internet egress (the drift VPC-egress lesson).
      const sleepFn = new lambdaNodeJs.NodejsFunction(this, 'DeploymentSleepFn', {
        entry: path.join(__dirname, '../../lambda/src/deployment-sleep.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        environment: {
          DEPLOYMENT_STATE_TABLE: stateTable.tableName,
          AURORA_CLUSTER_ID: dbCluster.clusterIdentifier,
          AURORA_WAKE_MIN_ACU: '0.5',
          AURORA_WAKE_MAX_ACU: '4',
          SLEEP_AFTER_IDLE: props.sleepAfterIdle ?? '2h',
          SLEEP_TOPIC_ARN: sleepTopic.topicArn,
          ALLOWED_ORIGINS: (this.node.tryGetContext('appUrl') as string) || '*',
          // sleep/wake gate on callerIsAdmin; hand the handler the admin-auth mode
          // so service/federated modes resolve instead of failing closed.
          ...adminAuthEnv(this),
        },
        bundling: { externalModules: ['@aws-sdk/*'], minify: true, sourceMap: true },
      });
      stateTable.grantReadWriteData(sleepFn);
      sleepTopic.grantPublish(sleepFn);
      sleepFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['rds:ModifyDBCluster', 'rds:DescribeDBClusters'],
        resources: [dbCluster.clusterArn],
      }));

      // EventBridge idle checker (no input payload ⇒ the checker path runs).
      new events.Rule(this, 'SleepCheckRule', {
        schedule: events.Schedule.expression(props.sleepCheckRate ?? 'rate(15 minutes)'),
        targets: [new targets.LambdaFunction(sleepFn)],
      });

      // API on the existing analytics API: GET /deployment/state (public, for the
      // SPA paused banner) + POST /deployment/{sleep,wake} (admin-authed).
      const deployment = analyticsApi.root.addResource('deployment');
      const sleepIntegration = new apigateway.LambdaIntegration(sleepFn);
      deployment.addResource('state').addMethod('GET', sleepIntegration); // public
      const adminOpts = adminApiMethodOptions(this, 'SleepAdminAuthorizer', {
        userPoolId: props.userPoolId,
      });
      deployment.addResource('sleep').addMethod('POST', sleepIntegration, adminOpts);
      deployment.addResource('wake').addMethod('POST', sleepIntegration, adminOpts);

      // Activity signal: the archival Lambda (runs on every Chime event) bumps
      // lastActivityAt best-effort. Same-stack, no cross-stack wiring; reaches
      // DynamoDB via the VPC's DynamoDB gateway endpoint.
      archivalLambda.addEnvironment('DEPLOYMENT_STATE_TABLE', stateTable.tableName);
      stateTable.grantReadWriteData(archivalLambda);

      new cdk.CfnOutput(this, 'DeploymentStateTableName', {
        value: stateTable.tableName,
        description: 'Cost sleep mode: deployment-state DynamoDB table',
      });
    }

    new cdk.CfnOutput(this, 'AnalyticsMode', {
      value: 'aurora',
      description: 'Active analytics backend mode',
    });

    cdk.Tags.of(this).add('Component', 'Analytics-Aurora');
    cdk.Tags.of(this).add('AnalyticsMode', 'aurora');
  }
}
