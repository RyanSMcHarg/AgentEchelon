/**
 * Archive Stack, Aurora mode (`<prefix>Archive` when `analyticsMode` is `aurora`)
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
 * - The archival Lambda on the message stream Messaging owns (VPC-attached)
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
import { grantIssuerRegistry } from '../constructs/trusted-issuers';
import type { RouteSpec } from '../constructs/http-api';
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
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { adminAuthEnv } from '../constructs/admin-auth-mode';
import * as path from 'path';
import { Construct } from 'constructs';
import { IArchiveStackOutputs } from '../interfaces/archive-stack-interface.js';
import { dataRemovalPolicy, environmentOf, isProduction } from '../config/environment';
import { ANALYTICS_PREFIX, INSTANCE_NAME, SHARED_SSM, STACK_PREFIX, INSTANCE_SSM, turnRoutingTableName } from './agent-classification-common';
import { defaultProfileRegistry as turnProfiles } from '../profile-registry';
import { MembershipAuditConstruct } from '../constructs/membership-audit';
import { ConversationArchive } from '../constructs/conversation-archive';
import { getModelCatalog } from '../config/model-strategy';
import type { Classification } from '../config/model-strategy';
import { UTILITY_MODEL_ID, utilityModelArns } from '../config/model-strategy';
import { AgentGuardrails } from '../constructs/bedrock-guardrails';
import { deidentifyGuardrailPolicy } from '../config/deidentify-guardrail';
import { alertEmitterWiring, RES_PREFIX, modelArnsForClassification, SSM_ROOT } from './agent-classification-common';

/**
 * How DocumentIngestion's asynchronous invocations (the S3 notifications on `rag/`) are retried. A failed invocation
 * (it threw, or timed out) is retried twice; an event not processed within six hours (throttled, or still failing)
 * is not retried further; either lands in the dead-letter queue, kept for fourteen days, and its alarm fires. The
 * retries are safe because an ingest is idempotent on the object's ETag (`document-ingestion.ts`).
 */
export const DOCUMENT_INGESTION_RETRY = { retryAttempts: 2, maxEventAgeHours: 6, dlqRetentionDays: 14 } as const;

/**
 * esbuild commandHooks for a DB Lambda's asset. Copies:
 *  - the RDS CA bundle (`analytics-aurora/certs/*.pem`), so `db-client.ts` can verify the DIRECT Aurora
 *    cluster TLS connection (the cluster's RDS-CA cert is not in Node's default trust store); and
 *  - the schema migration files (`analytics-aurora/schema/*.sql`), so `db-client.ensureSchema` can apply
 *    any PENDING migration at runtime over the IAM connection (the `schema-init` Custom Resource only
 *    bootstraps on Create and cannot reconnect afterwards - see ensureSchema).
 * Applied to every Lambda that talks to the DB.
 */
export function dbLambdaCommandHooks(): lambdaNodeJs.ICommandHooks {
  return {
    beforeBundling(inputDir: string, outputDir: string): string[] {
      const aa = path.join(inputDir, 'lambda', 'src', 'analytics-aurora');
      const certSrc = path.join(aa, 'certs');
      const certDest = path.join(outputDir, 'certs');
      const schemaSrc = path.join(aa, 'schema');
      const schemaDest = path.join(outputDir, 'schema');
      return process.platform === 'win32'
        ? [
            `if not exist "${certDest}" mkdir "${certDest}"`,
            `copy /Y "${certSrc}\\*.pem" "${certDest}\\"`,
            `if not exist "${schemaDest}" mkdir "${schemaDest}"`,
            `copy /Y "${schemaSrc}\\*.sql" "${schemaDest}\\"`,
          ]
        : [
            `mkdir -p "${certDest}"`,
            `cp "${certSrc}"/*.pem "${certDest}"/`,
            `mkdir -p "${schemaDest}"`,
            `cp "${schemaSrc}"/*.sql "${schemaDest}"/`,
          ];
    },
    afterBundling: (): string[] => [],
    beforeInstall: (): string[] => [],
  };
}

export interface ArchiveStackAuroraProps extends cdk.StackProps {
  appInstanceArn: string;
  /** The message stream the app instance publishes to, from the Messaging stack. */
  messageStream: kinesis.IStream;
  /** This deployment's own pool, when it has one (L15): the membership audit reads its groups. */
  userPoolId?: string;
  /** Cognito User Pool ARN (Layer 6 membership audit: AdminListGroupsForUser + AdminGetUser). */
  userPoolArn?: string;
  /** Layer 6 membership audit (SPEC-CONVERSATION-SECURITY): ALWAYS deployed. `membershipAuditEnforce`
   *  is the only knob - report-only (flag for review, default) vs auto-revoke. */
  membershipAuditEnforce?: boolean;
  senderEmail?: string;
  /**
   * BYO existing-VPC. When set, the stack imports this
   * VPC via `ec2.Vpc.fromLookup` instead of creating a dedicated
   * `${prefix}-analytics-vpc`. Lets an Aurora deploy share a VPC already in the
   * account to avoid a second VPC + endpoint
   * footprint. `fromLookup` does a context lookup at synth, so it needs a
   * concrete account/region env. Unset => create a new VPC (default behavior).
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
   * The attachments bucket ARN, from the Conversations stack. The eval runner scores an image-generation
   * turn by fetching its generated image from that bucket (battle-images/...) and judging it with a
   * vision model. A construct reference, so the edge to Conversations is declared by the reference.
   * Absent => image turns are skipped (unscored), never mis-scored on their caption text.
   */
  attachmentsBucketArn?: string;
  /**
   * Cost sleep mode (docs/SPEC-COST-SLEEP-MODE.md). When true, this stack also
   * provisions the deployment-state table, the idle checker + EventBridge rule,
   * the public state route, and the SNS notification topic. The admin sleep and wake routes are the
   * `AdminServices` stack's, on the same function (`deploymentSleepFunctionArn`). Auto-sleep pauses
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

export class ArchiveStackAurora extends cdk.Stack implements IArchiveStackOutputs {
  // IArchiveStackOutputs implementation
  public readonly archiveBucketArn: string;
  public readonly archiveBucketName: string;
  public readonly analyticsMode = 'aurora' as const;
  /** The client-events route and, with sleep mode, the paused-deployment probe, on `PersonApi`. */
  public readonly routes: RouteSpec[] = [];
  /** The sleep and wake function, with sleep mode: the admin sleep and wake routes reach it. */
  public readonly deploymentSleepFunction?: lambda.IFunction;
  public readonly dbProxyEndpoint: string;
  public readonly vpc: ec2.IVpc;
  public readonly dbSecurityGroup: ec2.ISecurityGroup;

  /**
   * Pre-authorized DB-client security group for cross-stack consumers (the
   * per-classification agent handlers that run LIVE drift). Its ingress on 5432 is added
   * to `dbSecurityGroup` INSIDE this stack, so consumers ATTACH to it read-only
   * (`securityGroups: [dbClientSecurityGroup]`) without mutating the Aurora DB
   * SG — that mutation-from-a-classification is what created the synth CYCLE
   * (Archive ⇄ Assistants-*). Same one-SG-per-consumer pattern the
   * in-stack Lambdas (schema-init / setup / archival) already use, but shared.
   */
  public readonly dbClientSecurityGroup: ec2.ISecurityGroup;

  // Cross-stack outputs for the router-agent-handler's live-drift VPC attachment
  // and IAM grants (see agent-classification-common.ts `auroraDriftWiring`).
  public readonly dbProxyArn: string;
  public readonly dbClusterResourceId: string;
  // ARN of the retrieval + drift data-plane Lambda (ADR-013): the
  // non-VPC agent handler invokes it instead of being VPC-attached itself.
  public readonly dataPlaneLambdaArn: string;

  // ── WHAT THE ADMIN BACKEND'S ANALYTICS QUERY RUNS ON ───────────────────────────────────────────
  //
  // The analytics query is an `AdminServices` function in this stack's VPC (it reads Aurora directly).
  // It attaches to `dbClientSecurityGroup`, connects with the environment and the `rds-db:connect`
  // resources below, and deploys after the IAM-auth bootstrap (`iamAuthSetup`).
  /** The subnets the data plane runs in. */
  public readonly dbSubnets: ec2.SubnetSelection;
  /** The connection settings every function that talks to the database is given. */
  public readonly dbEnvironment: Record<string, string>;
  /** The `rds-db:connect` resources: the cluster's users, and the proxy's when it exists. */
  public readonly dbConnectResources: string[];
  /** The bootstrap that creates the IAM-auth database users. A function connecting as them deploys after it. */
  public readonly iamAuthSetup: cdk.CustomResource;
  /** The membership audit's findings table, which the admin review surface reads and changes. */
  public readonly membershipAuditTable?: dynamodb.ITable;
  /** The sleep function (`sleepMode` only), whose admin sleep and wake routes are the admin backend's. */
  public readonly deploymentSleepFunctionArn?: string;

  // Out-of-band per-message analytics table (SPEC-MESSAGE-METADATA-CODEBOOK.md
  // Phase 1; ADR-016). The archival Lambda (this stack) reads it; the per-classification
  // async processors write it — bin passes these to the classification stacks, which are
  // created after this stack, so a direct prop reference is clean.
  public readonly messageAnalyticsTableName: string;
  public readonly messageAnalyticsTableArn: string;

  constructor(scope: Construct, id: string, props: ArchiveStackAuroraProps) {
    super(scope, id, props);

    // The deployment environment, one value (lib/config/environment.ts): production retains the cluster,
    // its key and the stream, and protects the cluster from deletion.
    const environment = environmentOf(this);
    const production = isProduction(this);
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
    this.dbSubnets = dbSubnets;

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
    // mutation, hence no Archive ⇄ Assistants-* cycle. The in-stack
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
        production ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
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
      deletionProtection: production,

      backup: {
        retention: cdk.Duration.days(7),
      },

      removalPolicy:
        production
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
            // The runtime identity (ADR-028). The direct-cluster grant below is already a wildcard
            // over db users, so this path was the only one pinned to the owner; without it, enabling
            // the optional proxy would break every runtime query with an auth error that looks
            // nothing like its cause.
            `arn:aws:rds-db:${this.region}:${this.account}:dbuser:${dbCluster.clusterResourceIdentifier}/ae_app`,
          ],
        })
      );
    }

    this.dbProxyEndpoint = dbProxy ? dbProxy.endpoint : '';
    this.dbProxyArn = dbProxy ? dbProxy.dbProxyArn : '';
    this.dbClusterResourceId = dbCluster.clusterResourceIdentifier;

    // =====================================================
    // The message stream (Messaging owns it; this stack consumes it)
    // =====================================================
    const messageStream = props.messageStream;

    // Always-on conversation event archive (system of record for history + audit).
    // Aurora holds the analytics/context projection, but it collapses membership to
    // current-state and does not capture moderator events, so the append-only archive
    // must exist here too. This is a second consumer of the message stream (alongside
    // the Postgres archival Lambda) and is what admin-conversations.ts reads over Athena
    // in Aurora mode. Reuses this stack's ArchiveKey; names come from shared constants so
    // the admin-conversations IAM resolves to it unchanged.
    // See docs/guides/developer/MESSAGE-FLOW.md section 9.
    new ConversationArchive(this, 'ConversationEventArchive', {
      messageStream,
      encryptionKey: archiveKey,
    });

    // Layer 6: near-real-time membership audit (SPEC-CONVERSATION-SECURITY). ALWAYS deployed - flagging
    // uncleared members for review is a standing security guarantee, not opt-in. The only knob
    // is enforcement mode (membershipAuditEnforce: report-only flag-for-review vs auto-revoke). Non-VPC
    // (only Chime/Cognito/SSM/SES), so it needs no Aurora access even here. Requires the user pool (to
    // resolve member tiers), so it is skipped only when no pool is wired.
    let membershipAudit: MembershipAuditConstruct | undefined;
    if (props.userPoolArn && props.userPoolId) {
      membershipAudit = new MembershipAuditConstruct(this, 'MembershipAudit', {
        stream: messageStream,
        appInstanceArn: props.appInstanceArn,
        userPoolId: props.userPoolId,
        userPoolArn: props.userPoolArn,
        adminArnParam: INSTANCE_SSM.appInstanceAdminArn,
        enforce: props.membershipAuditEnforce,
      });
      this.membershipAuditTable = membershipAudit.auditTable;
    }

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
    this.iamAuthSetup = iamAuthSetup;

    // =====================================================
    // Helper: Lambda IAM role for RDS Proxy IAM auth
    // =====================================================
    const dbConnectResources = [
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
    ];
    this.dbConnectResources = dbConnectResources;
    const rdsIamAuthPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          actions: ['rds-db:connect'],
          resources: dbConnectResources,
        }),
      ],
    });

    // Common DB environment variables for VPC Lambdas
    const dbEnvironment = {
      DB_HOST: dbProxy ? dbProxy.endpoint : dbCluster.clusterEndpoint.hostname,
      DB_PORT: '5432',
      DB_NAME: 'evaluation',
      // The OWNER identity: migrations, DDL, and the classification-boundary bootstrap only.
      DB_USER: 'evaladmin',
      // The RUNTIME identity (ADR-028). Every ordinary query connects as this: no ownership and no
      // DDL, so row-level security applies to it through the ordinary path instead of depending on
      // FORCE and owner-exemption semantics. The role itself is created BY the bootstrap, which runs
      // as the owner, so the first cold start after this ships still connects fine.
      DB_APP_USER: 'ae_app',
      DB_REGION: this.region,
      USE_IAM_AUTH: 'true',
    };
    this.dbEnvironment = dbEnvironment;

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
      // A transient buffer, not a system of record; retained in production like every table.
      removalPolicy: dataRemovalPolicy(this),
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
              resources: [
                titanEmbedArn,
                // Haiku too: archival refreshes a conversation's summary once its new messages land
                // (summary-updater.ts summarizeChannelsNow), with the model the summary updater uses.
                ...utilityModelArns(this.region, this.account),
                'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-haiku-*',
              ],
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
          commandHooks: dbLambdaCommandHooks(), // RDS CA for direct cluster TLS
        },
      }
    );

    // NO GRANT ON THE CHANNEL-CONTEXT TABLE, and a grant to cache a member count there needs a reader
    // first. The obvious one does not exist: the `@all` responder branch resolves channel size through
    // `lib/channel-size.ts`, which takes a live `ListChannelMemberships` because a count derived from
    // `channel_membership` collapses assistants into the human roster (a battle channel of three
    // reports 2). With no write there is nothing to grant, no table env to set, and no write-failure
    // alarm to raise, so the archival role reaches only the analytics stores it uses.

    // Read-only: archival merges the out-of-band analytics over the slim inline metadata.
    messageAnalyticsTable.grantReadData(archivalLambda);

    // THE ARCHIVE KEEPS ITS OWN COPY OF A DELIVERED DOCUMENT (SPEC-EVALUATION FR22,
    // `delivered-document-archive.ts`). Archival reads the file from the conversation's deliverables
    // (`generated-docs/*`, nothing else in the attachments bucket) and writes it under the archive's own
    // family (`delivered-documents/*`, nothing else in the archive), so each grant names one owner's
    // prefix (tenet D15). Without an attachments bucket there is nothing to copy and no grant.
    if (props.attachmentsBucketArn) {
      archivalLambda.addEnvironment(
        'ATTACHMENTS_BUCKET',
        cdk.Fn.select(5, cdk.Fn.split(':', props.attachmentsBucketArn)),
      );
      archivalLambda.addEnvironment('ARCHIVE_BUCKET', archiveBucket.bucketName);
      archivalLambdaRole.addToPolicy(new iam.PolicyStatement({
        sid: 'ReadDeliveredDocuments',
        actions: ['s3:GetObject'],
        resources: [`${props.attachmentsBucketArn}/generated-docs/*`],
      }));
      archivalLambdaRole.addToPolicy(new iam.PolicyStatement({
        sid: 'ArchiveDeliveredDocuments',
        actions: ['s3:PutObject'],
        resources: [`${archiveBucket.bucketArn}/delivered-documents/*`],
      }));
      // The archive bucket is SSE-KMS on the archive's own key.
      archivalLambdaRole.addToPolicy(new iam.PolicyStatement({
        sid: 'ArchiveDeliveredDocumentsKey',
        actions: ['kms:GenerateDataKey'],
        resources: [archiveKey.keyArn],
      }));
    }

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

    // Attachments-bucket ARN/name for the eval runner's image scoring: a construct reference from the
    // Conversations stack (the VPC has no SSM endpoint, so it is never a runtime read).
    const evalAttachmentsBucketArn = props.attachmentsBucketArn;
    const evalAttachmentsBucketName = evalAttachmentsBucketArn
      ? cdk.Fn.select(5, cdk.Fn.split(':', evalAttachmentsBucketArn))
      : undefined;

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
                ...utilityModelArns(this.region, this.account),
                'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-haiku-*',
                'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet-*',
                `arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.*`,
              ],
            }),
          ],
        }),
        // WHAT THE RUNNER READS FROM THE ARCHIVE, AND NOTHING ELSE. The archive is the system of record
        // and nothing in evaluation writes to it, so there is no PutObject; the one family it reads is
        // the archive's copy of each delivered document it grades (`delivered-documents/*`, written by
        // archival, SPEC-EVALUATION FR22). Every other evaluation input is in Aurora.
        S3Access: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'ReadArchivedDeliveredDocuments',
              actions: ['s3:GetObject'],
              resources: [`${archiveBucket.bucketArn}/delivered-documents/*`],
            }),
            // The archive bucket is SSE-KMS on the customer CMK: a read needs decrypt.
            new iam.PolicyStatement({
              actions: ['kms:Decrypt'],
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
          EVALUATOR_MODEL: UTILITY_MODEL_ID,
          // Image-generation turns are judged by fetching the generated image from the attachments
          // bucket (battle-images/...). Absent => image turns are skipped, never mis-scored.
          ...(evalAttachmentsBucketName ? { ATTACHMENTS_BUCKET: evalAttachmentsBucketName } : {}),
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
          commandHooks: dbLambdaCommandHooks(),
        },
      }
    );

    evaluationLambda.node.addDependency(iamAuthSetup);

    // Image scoring: the eval runner fetches the generated image from the attachments bucket. Grant
    // read-only GetObject on the generated images' family (`battle-images/*`, `image-gen-output.ts`)
    // and no other: member uploads and delivered documents are not read from this bucket (a delivered
    // document is read from the archive's own copy above). The attachments bucket is SSE-AES256, so no
    // KMS key grant is needed.
    if (evalAttachmentsBucketArn) {
      evaluationLambdaRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ReadGeneratedImages',
          actions: ['s3:GetObject'],
          resources: [`${evalAttachmentsBucketArn}/battle-images/*`],
        }),
      );
    }

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
                ...utilityModelArns(this.region, this.account),
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
          SUMMARY_MODEL_ID: UTILITY_MODEL_ID,
          DRIFT_EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
          SUMMARY_BATCH_LIMIT: '20',
          SUMMARY_MAX_MESSAGES: '50',
        },
        bundling: {
          externalModules: ['@aws-sdk/*'],
          minify: true,
          sourceMap: true,
          commandHooks: dbLambdaCommandHooks(), // RDS CA for direct cluster TLS
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
          commandHooks: dbLambdaCommandHooks(), // RDS CA for direct cluster TLS
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
          commandHooks: dbLambdaCommandHooks(),
        },
      },
    );
    documentIngestionLambda.node.addDependency(iamAuthSetup);

    // S3 → Lambda notification, filtered to the rag/ prefix. Using the
    // L2 EventBridge target would be cleaner but it has a deploy-time
    // race with the bucket's eventbridge configuration; the L1
    // BucketNotification flows directly to Lambda invoke.
    // AND REMOVED: a document deleted from the corpus takes its chunks with it (document-ingestion.ts).
    archiveBucket.addObjectRemovedNotification(
      new s3n.LambdaDestination(documentIngestionLambda),
      { prefix: 'rag/' },
    );
    archiveBucket.addObjectCreatedNotification(
      new s3n.LambdaDestination(documentIngestionLambda),
      { prefix: 'rag/' },
    );

    // AN INGEST THAT FAILS IS RETRIED, AND ONE THAT NEVER SUCCEEDS IS KEPT. The S3 notification is an
    // asynchronous invoke, so without a destination a timed-out or failed ingest is dropped after Lambda's
    // default retries with no record: the corpus stays short of the object and nothing says so. The failed
    // event (the S3 records it carried) lands in this queue, and its alarm fires (DOCUMENT_INGESTION_RETRY).
    const documentIngestionDlq = new sqs.Queue(this, 'DocumentIngestionDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(DOCUMENT_INGESTION_RETRY.dlqRetentionDays),
    });
    documentIngestionLambda.configureAsyncInvoke({
      retryAttempts: DOCUMENT_INGESTION_RETRY.retryAttempts,
      maxEventAge: cdk.Duration.hours(DOCUMENT_INGESTION_RETRY.maxEventAgeHours),
      onFailure: new lambdaDestinations.SqsDestination(documentIngestionDlq),
    });
    new cloudwatch.Alarm(this, 'DocumentIngestionDlqAlarm', {
      alarmName: `${this.stackName}-document-ingestion-failed`,
      alarmDescription: 'A RAG corpus object under rag/ was not ingested after every retry; its S3 event is kept in the '
        + 'document ingestion dead-letter queue. Re-run the sync (it re-puts every synced key the database holds no '
        + 'chunks for) or re-put the object. See docs/guides/developer/RAG.md.',
      metric: documentIngestionDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5), statistic: 'Maximum' }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // =====================================================
    // Retrieval + drift DATA-PLANE Lambda (ADR-013)
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

    // One shape for every data-plane role: the shared data plane's, and each turn data plane's own
    // (Phase 1c), which adds only the read of its own classification's routing table.
    const dataPlaneRole = (id: string) => new iam.Role(this, id, {
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
              // Titan embed: the drift / RAG vector path.
              // Haiku: the first-turn summary SEED (`seedSummary` op) summarizes the opening
              // exchange HERE, so this role needs the same model access the scheduled
              // summary-updater already has. Without it the seed reaches the data plane and then
              // dies on AccessDenied at the Bedrock call - live-verified, and invisible from the
              // deploy, which reports success either way.
              resources: [
                titanEmbedArn,
                ...utilityModelArns(this.region, this.account),
                'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-haiku-*',
              ],
            }),
          ],
        }),
      },
    });
    const dataPlaneLambdaRole = dataPlaneRole('DataPlaneLambdaRole');

    // Shared by the data plane and every classification's turn data plane: one entry, one bundle.
    const dataPlaneBundling: lambdaNodeJs.BundlingOptions = {
      externalModules: ['@aws-sdk/*'],
      minify: true,
      sourceMap: true,
      // Ship the RDS CA bundle so db-client verifies the DIRECT cluster TLS
      // connection after RDS-Proxy removal (see rdsCertCommandHooks).
      commandHooks: dbLambdaCommandHooks(),
    };
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
        bundling: dataPlaneBundling,
      },
    );
    dataPlaneLambda.node.addDependency(iamAuthSetup);
    this.dataPlaneLambdaArn = dataPlaneLambda.functionArn;

    // ── EACH CLASSIFICATION'S OWN FUNCTIONS IN THIS VPC ARE ITS OWN STACK'S ───────────────────────────
    //
    // A classification's turn data plane and classifier replay are built by its `Assistants-<classification>`
    // stack (`ClassificationArchiveFunctions`), so declaring one changes nothing here. What they run on is
    // published here under fixed keys, read at their deploy: the data plane's subnets and security group (which
    // has the database ingress rule above), the database host, and the IAM-auth resource ids.
    const dataPlaneSubnetIds = vpc.selectSubnets(dbSubnets).subnetIds;
    for (const [id, parameterName, stringValue] of [
      ['DataPlaneSubnetIdsParam', SHARED_SSM.auroraDataPlaneSubnetIds, cdk.Fn.join(',', dataPlaneSubnetIds)],
      ['DataPlaneSecurityGroupIdParam', SHARED_SSM.auroraDataPlaneSecurityGroupId, dataPlaneLambdaSg.securityGroupId],
      ['DbHostParam', SHARED_SSM.auroraDbHost, dbEnvironment.DB_HOST],
      ['DbClusterResourceIdParam', SHARED_SSM.auroraDbClusterResourceId, dbCluster.clusterResourceIdentifier],
      ...(dbProxy ? [['DbProxyResourceIdParam', SHARED_SSM.auroraDbProxyResourceId, cdk.Fn.select(6, cdk.Fn.split(':', dbProxy.dbProxyArn))]] : []),
    ] as Array<[string, string, string]>) {
      new ssm.StringParameter(this, id, { parameterName, stringValue });
    }

    // Publish the data-plane ARN to SSM so the readers that deploy BEFORE this stack (offboarding, in
    // Identity) resolve it at RUNTIME; a direct CDK prop would be a circular dependency, since this stack
    // depends on Identity's user pool. Readers deployed after it take `dataPlaneLambdaArn` by reference.
    // See BUG #21 / SHARED_SSM.auroraDataPlaneArn.
    new ssm.StringParameter(this, 'DataPlaneArnParam', {
      parameterName: SHARED_SSM.auroraDataPlaneArn,
      stringValue: dataPlaneLambda.functionArn,
      description: 'Aurora data-plane Lambda ARN for the admin-conversations read path (BUG #21).',
    });

    // The classifier replay (the classification shadow gate, DESIGN-EXPERIMENTS-BATTLE §5.2) is one function per
    // classification, its classification's own stack's (`ClassificationArchiveFunctions`), on the hooks above.

    // The premium + standard async processors need read access to
    // pgvector via the RDS Proxy + Bedrock for query embedding. Those
    // Lambdas live in the per-classification AgentEchelonAssistants-* stacks and are wired
    // into the VPC separately when enableLiveDrift=true — the same path also
    // gives them the embeddings table access (see agent-classification-common.ts
    // `auroraDriftWiring`).

    // =====================================================
    // The client-events and deployment-state routes (on PersonApi)
    // =====================================================
    //
    // THE CHAT APP'S ROUTES ONLY. The admin analytics query, the queue-health panel, the classifier-replay
    // starter and the membership-audit review are the `AdminServices` stack's, on `AdminApi`: the query
    // runs in this stack's VPC there, on the references this stack exposes.
    const appUrl = this.node.tryGetContext('appUrl') || 'http://localhost:5173';
    const ARCHIVE_ROUTE_THROTTLE = { rate: 100, burst: 200 };

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
    // Who called is the edge authorizer's context, read through the registry (callerPersonId): the person
    // and the classification their issuer clears them for, for any issuer (A5).
    grantIssuerRegistry(clientEventsFn, props.userPoolId ?? '');
    clientEventsFn.addEnvironment('APP_INSTANCE_ARN', props.appInstanceArn);

    // =====================================================
    // The de-identified conversation copy (SPEC-ADMIN-CONSOLE FR54, DESIGN-ADMIN-CONSOLE 5.3)
    // =====================================================
    // A daily batch OUTSIDE the VPC: it calls the detector and posts to the admin channel itself, and
    // reaches Aurora only through data-plane ops, so it needs no new endpoint (tenet D8). The detector is a
    // guardrail of its own, built by the same construct as the assistants' one with a policy that
    // anonymizes every entity type (deidentify-guardrail.ts).
    const deidentifyGuardrail = new AgentGuardrails(this, 'DeidentifyGuardrail', {
      policy: deidentifyGuardrailPolicy(`${RES_PREFIX}-deidentify`),
    });
    const cleanCopyAlert = alertEmitterWiring(this);
    const cleanCopyFn = new lambdaNodeJs.NodejsFunction(this, 'CleanCopyBatchFunction', {
      entry: path.join(__dirname, '../../lambda/src/clean-copy-batch.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      // The run watches its own clock and stops taking conversations with 90 seconds left, so it can
      // record and announce how it ended; the timeout is that clock, not a budget.
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      // One run at a time: a second would derive the same conversations twice.
      reservedConcurrentExecutions: 1,
      // A failed asynchronous invocation is NOT retried: the run reports its own failure, and a retry
      // would run the batch again on top of a report that already went out.
      retryAttempts: 0,
      environment: {
        AURORA_DATA_PLANE_ARN: dataPlaneLambda.functionArn,
        DEIDENTIFY_GUARDRAIL_ID: deidentifyGuardrail.guardrailId,
        DEIDENTIFY_GUARDRAIL_VERSION: deidentifyGuardrail.guardrailVersion,
        ...cleanCopyAlert.env,
      },
      bundling: { externalModules: ['@aws-sdk/*'], minify: true, sourceMap: true },
    });
    dataPlaneLambda.grantInvoke(cleanCopyFn);
    cleanCopyAlert.grant(cleanCopyFn.role!);
    // The same detector de-identifies a golden-set upload, on each classification's golden run (ADR-065 decision 7).
    for (const [id, parameterName, stringValue] of [
      ['DeidentifyGuardrailIdParam', SHARED_SSM.deidentifyGuardrailId, deidentifyGuardrail.guardrailId],
      ['DeidentifyGuardrailVersionParam', SHARED_SSM.deidentifyGuardrailVersion, deidentifyGuardrail.guardrailVersion],
      ['DeidentifyGuardrailArnParam', SHARED_SSM.deidentifyGuardrailArn, deidentifyGuardrail.guardrailArn],
    ] as Array<[string, string, string]>) {
      new ssm.StringParameter(this, id, { parameterName, stringValue });
    }
    cleanCopyFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:ApplyGuardrail'],
      resources: [deidentifyGuardrail.guardrailArn],
    }));
    new events.Rule(this, 'CleanCopySchedule', {
      // Daily at 02:00 UTC beside the nightly job; a deployment wanting a fresher copy sets
      // `-c cleanCopySchedule='rate(6 hours)'`. The detector charges per character, so a higher rate
      // costs little more.
      schedule: events.Schedule.expression(
        (this.node.tryGetContext('cleanCopySchedule') as string | undefined) || 'cron(0 2 * * ? *)',
      ),
      targets: [new targets.LambdaFunction(cleanCopyFn, { retryAttempts: 0 })],
    });

    // A DEPLOYMENT STARTS ITS COPY WHEN IT IS DEPLOYED, not at the next 02:00. One asynchronous invoke on create, so
    // the copy begins at once and the never-started alarm below has a datapoint from its first evaluation. It runs
    // again on an update only when the function is replaced, which is the one change that starts an empty
    // Invocations metric (the parameters name the function, so a new name is a changed property). The batch is safe
    // to repeat: it derives only what is pending and writes each conversation whole, and its reserved concurrency of
    // one queues a run that meets the scheduled one. `Event` returns once Lambda accepts the invoke, so a long run
    // never holds the deploy.
    const firstCleanCopyRun: cr.AwsSdkCall = {
      service: 'Lambda',
      action: 'invoke',
      parameters: { FunctionName: cleanCopyFn.functionName, InvocationType: 'Event', Payload: '{}' },
      physicalResourceId: cr.PhysicalResourceId.of('clean-copy-first-run'),
    };
    const cleanCopyFirstRun = new cr.AwsCustomResource(this, 'CleanCopyFirstRun', {
      onCreate: firstCleanCopyRun,
      onUpdate: firstCleanCopyRun,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [cleanCopyFn.functionArn] }),
      ]),
      installLatestAwsSdk: false,
    });

    // A RUN THAT NEVER STARTED SAYS NOTHING, so the absence is alarmed on. Every run that starts
    // announces how it ended; this covers the one that does not start at all - a disabled rule, a
    // broken role, a throttle that ate the invocation. Missing data is a breach: no invocation in a day
    // is exactly the case. It reaches the admin channel through the generic alarm notifier.
    const cleanCopyAlarmTopic = new sns.Topic(this, 'CleanCopyAlarmTopic', {
      displayName: 'De-identified copy: run never started',
    });
    const alarmNotifierFn = new lambdaNodeJs.NodejsFunction(this, 'AlarmToAdminChannelFunction', {
      entry: path.join(__dirname, '../../lambda/src/alarm-to-admin-channel.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: { ...cleanCopyAlert.env },
      bundling: { externalModules: ['@aws-sdk/*'], minify: true, sourceMap: true },
    });
    cleanCopyAlert.grant(alarmNotifierFn.role!);
    cleanCopyAlarmTopic.addSubscription(new snsSubs.LambdaSubscription(alarmNotifierFn));
    const cleanCopyNeverStarted = new cloudwatch.Alarm(this, 'CleanCopyNeverStartedAlarm', {
      alarmDescription:
        'The de-identified copy batch did not start in two consecutive days, so the copy is falling behind '
        + 'the archive. Check the CleanCopySchedule rule is enabled and the function can be invoked. '
        + 'For anything urgent, read the conversation in the archive.',
      metric: cleanCopyFn.metricInvocations({ period: cdk.Duration.hours(24), statistic: 'Sum' }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      // TWO EMPTY DAYS, NOT ONE. A daily run lands near the edge of a 24-hour window, so one window can hold two runs
      // and the next none; two consecutive empty windows still catch a schedule that stopped, within 48 hours. The
      // deploy-time run (`CleanCopyFirstRun`) puts a datapoint in the newest window before the alarm first evaluates.
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    // Created after the first run is asked for, so its first evaluation already has that run to count.
    cleanCopyNeverStarted.node.addDependency(cleanCopyFirstRun);
    cleanCopyNeverStarted.addAlarmAction(new cloudwatchActions.SnsAction(cleanCopyAlarmTopic));
    cleanCopyNeverStarted.addOkAction(new cloudwatchActions.SnsAction(cleanCopyAlarmTopic));

    this.routes.push({
      api: 'person', method: 'POST', path: '/events', handler: clientEventsFn, capability: 'core', throttle: ARCHIVE_ROUTE_THROTTLE,
    });


    // =====================================================
    // Outputs
    // =====================================================
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
        removalPolicy: dataRemovalPolicy(this),
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
          ALLOWED_ORIGINS: (this.node.tryGetContext('appUrl') as string) || 'http://localhost:5173',
          // The admin sleep and wake routes (`AdminServices`) are IAM-authorized and gate on
          // `callerIsAdmin`, which trusts the signed principal only when told IAM is enforced.
          ...adminAuthEnv(this),
          ADMIN_IAM_ENFORCEMENT: 'true',
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

      // GET /deployment/state (public, for the SPA paused banner): it names nobody and reads nothing private,
      // so it has no authorizer. POST /deployment/{sleep,wake} are admin routes, on `AdminApi`.
      this.routes.push({
        api: 'person', method: 'GET', path: '/deployment/state', handler: sleepFn, capability: 'core', auth: 'none',
        throttle: ARCHIVE_ROUTE_THROTTLE,
      });
      this.deploymentSleepFunctionArn = sleepFn.functionArn;
      this.deploymentSleepFunction = sleepFn;

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

    // WHICH ARCHIVE THIS IS. Both modes deploy under one stack name, so a tool that must know the mode
    // (the deploy's mode lock, the operator scripts, the admin console's settings) reads it here rather
    // than from a stack name.
    new cdk.CfnOutput(this, 'AnalyticsMode', {
      value: this.analyticsMode,
      description: 'The archive mode this deployment runs: athena or aurora',
    });

    cdk.Tags.of(this).add('Component', 'Archive');
    cdk.Tags.of(this).add('AnalyticsMode', 'aurora');
  }
}
