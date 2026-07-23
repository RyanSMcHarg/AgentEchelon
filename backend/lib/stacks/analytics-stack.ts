/**
 * Analytics Stack
 *
 * Provides conversation archiving and evaluation infrastructure:
 * - Kinesis stream for Chime SDK message streaming
 * - Firehose delivery to S3 with dynamic partitioning
 * - S3 bucket for conversation archives
 * - Athena workgroup and Glue catalog for analytics queries
 * - Evaluation runner Lambda (daily scheduled)
 *
 * Data flow: Chime Messages -> Kinesis -> Firehose -> S3 -> Athena
 *
 * Cost: ~$25/month (Kinesis 2 shards + Firehose + S3 + Athena on-demand)
 */

import * as cdk from 'aws-cdk-lib';
import { apiAccessLogConfig } from '../constructs/api-access-logging';
import { adminApiMethodOptions, adminAuthEnv } from '../constructs/admin-auth-mode';
import { adminOrigin, sharedOrigins } from '../config/app-origins';
import { ALL_PARTITION_VALUES } from '../../lambda/src/lib/client-event-types';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { ANALYTICS_PREFIX, ATHENA_WORKGROUP_NAME, ANALYTICS_DB_NAME, INSTANCE_SSM } from './agent-classification-common';
import { MembershipAuditConstruct } from '../constructs/membership-audit';

export interface AnalyticsStackProps extends cdk.StackProps {
  appInstanceArn: string;
  userPool?: cognito.IUserPool;
  /** A14: the `admins` sign-on role ARN (execute-api teeth on the analytics API under adminIamEnforcement). */
  adminSignOnRoleArn?: string;
  /** A14 Scoped: role -> ceiling map (JSON) from the CognitoAuth stack; the handler resolves the
   *  caller's classification ceiling from their assumed-role ARN with no Cognito call. */
  classificationRoleCeilings?: string;
  /** Layer 6 membership audit (SPEC-CONVERSATION-SECURITY). Opt-in; report-only unless enforce. */
  enableMembershipAudit?: boolean;
  membershipAuditEnforce?: boolean;
  membershipAuditAlertChannelArn?: string;
  senderEmail?: string;
}

export class AnalyticsStack extends cdk.Stack {
  public readonly kinesisStreamArn: string;
  public readonly kinesisStreamName: string;
  public readonly archiveBucketName: string;
  public readonly archiveBucketArn: string;

  // S3 prefixes for IAM policy scoping
  public readonly basicPrefix = 'conversations/user_type=basic/';
  public readonly standardPrefix = 'conversations/user_type=standard/';
  public readonly adminPrefix = 'conversations/';

  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);

    // ============================================================
    // Kinesis Stream
    // ============================================================

    const messageStream = new kinesis.Stream(this, 'MessageStream', {
      streamName: `chime-messaging-${ANALYTICS_PREFIX}`,
      shardCount: 2,
      retentionPeriod: cdk.Duration.hours(24),
      encryption: kinesis.StreamEncryption.MANAGED,
    });

    this.kinesisStreamArn = messageStream.streamArn;
    this.kinesisStreamName = messageStream.streamName;

    // Layer 6: near-real-time membership audit (SPEC-CONVERSATION-SECURITY). Opt-in.
    if (props.enableMembershipAudit && props.userPool) {
      new MembershipAuditConstruct(this, 'MembershipAudit', {
        stream: messageStream,
        appInstanceArn: props.appInstanceArn,
        userPoolId: props.userPool.userPoolId,
        userPoolArn: props.userPool.userPoolArn,
        adminArnParam: INSTANCE_SSM.appInstanceAdminArn,
        alertChannelArn: props.membershipAuditAlertChannelArn,
        senderEmail: props.senderEmail,
        enforce: props.membershipAuditEnforce,
      });
    }

    // ============================================================
    // Chime SDK Messaging -> Kinesis streaming configuration
    // ============================================================
    // Wires the Chime AppInstance to publish channel + message events
    // to the Kinesis stream above. Without this, Kinesis stays at 0
    // IncomingRecords, the Firehose has nothing to deliver, the S3
    // conversations/ prefix never populates, and Athena + the admin
    // Evaluations/Conversations/Latency tabs are silently empty. This
    // MUST be in CDK so fresh OSS deploys do not need a manual
    // aws chime-sdk-messaging put-messaging-streaming-configurations
    // step (see feedback-post-deploy-validate-pipelines in /memory).
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
        // Chime SDK Messaging validates server-side that the principal
        // calling PutMessagingStreamingConfigurations can write to the
        // target Kinesis stream. Without these grants on the custom-
        // resource Lambda role, the CFN custom resource fails with
        // "Unable to access Kinesis stream <name>" and rolls back.
        new iam.PolicyStatement({
          actions: [
            'kinesis:PutRecord',
            'kinesis:PutRecords',
            'kinesis:DescribeStream',
            'kinesis:DescribeStreamSummary',
          ],
          resources: [messageStream.streamArn],
        }),
        // Chime SDK Messaging defensively creates its service-linked
        // role on first streaming setup (even when one exists). Without
        // this, the custom resource rolls back with "Unable to create
        // service linked role .../AWSServiceRoleForChimeSDKMessaging".
        // The IfExists condition scopes the grant to that single SLR.
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

    // ============================================================
    // S3 Archive Bucket
    // ============================================================

    // Customer-managed KMS key for the archive plane (the S3 conversation archive +
    // Athena results). A single CMK lets a future proof-of-need model gate decryption
    // via key grants (docs/SPEC-ADMIN-IDENTITY.md); today it provides customer-managed
    // encryption at rest. The default key policy delegates to account IAM, so principals
    // get access via their roles + grants below (Firehose writers via grantWrite auto-KMS;
    // Athena readers/writers explicitly).
    const archiveKey = new kms.Key(this, 'ArchiveKey', {
      description: `${ANALYTICS_PREFIX} archive plane CMK (S3 conversation archive, Athena)`,
      enableKeyRotation: true,
      alias: `${ANALYTICS_PREFIX}-archive`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const archiveBucket = new s3.Bucket(this, 'ConversationArchive', {
      bucketName: `${ANALYTICS_PREFIX}-conversation-archive-${this.account}-${this.region}`,
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
        {
          // The Firehose MetadataExtraction
          // partitionKey expression falls back to `unknown` when a record
          // arrives without a partitionKey field. Unreachable via the
          // Lambda allow-list (every accepted event sets partitionKey),
          // but direct-Kinesis-IAM access or a future ingestion path
          // would land records under client_events/event_type=unknown/.
          // 7-day expiry bounds the cost amplification ceiling.
          id: 'client-events-unknown-partition-7d',
          prefix: 'client_events/event_type=unknown/',
          expiration: cdk.Duration.days(7),
        },
      ],
    });

    this.archiveBucketName = archiveBucket.bucketName;
    this.archiveBucketArn = archiveBucket.bucketArn;

    // ============================================================
    // Firehose Delivery Stream
    // ============================================================

    const firehoseLogGroup = new logs.LogGroup(this, 'FirehoseLogGroup', {
      logGroupName: `/aws/kinesisfirehose/${ANALYTICS_PREFIX}-message-archive`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const firehoseLogStream = new logs.LogStream(this, 'FirehoseLogStream', {
      logGroup: firehoseLogGroup,
      logStreamName: 'delivery-errors',
    });

    const firehoseRole = new iam.Role(this, 'FirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
      description: 'Role for Firehose to deliver messages to S3',
    });

    messageStream.grantRead(firehoseRole);
    archiveBucket.grantWrite(firehoseRole);
    firehoseLogGroup.grantWrite(firehoseRole);

    const deliveryStream = new firehose.CfnDeliveryStream(this, 'MessageArchiveDelivery', {
      deliveryStreamName: `${ANALYTICS_PREFIX}-message-archive`,
      deliveryStreamType: 'KinesisStreamAsSource',

      kinesisStreamSourceConfiguration: {
        kinesisStreamArn: messageStream.streamArn,
        roleArn: firehoseRole.roleArn,
      },

      extendedS3DestinationConfiguration: {
        bucketArn: archiveBucket.bucketArn,
        roleArn: firehoseRole.roleArn,

        // Dynamic partitioning by user_type and date
        prefix: 'conversations/user_type=!{partitionKeyFromQuery:user_type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
        errorOutputPrefix: 'errors/!{firehose:error-output-type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/',

        bufferingHints: {
          intervalInSeconds: 300,
          sizeInMBs: 64,
        },

        compressionFormat: 'GZIP',

        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: firehoseLogGroup.logGroupName,
          logStreamName: firehoseLogStream.logStreamName,
        },

        dynamicPartitioningConfiguration: {
          enabled: true,
        },

        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'MetadataExtraction',
              parameters: [
                {
                  parameterName: 'MetadataExtractionQuery',
                  // Metadata produced by buildAnalyticsMetadata() is FLAT —
                  // `.userType` at the top level, not nested under `.analytics`.
                  // The old `.analytics.userType` path always returned null and
                  // partitioned every event into user_type=unknown, which made
                  // Models/Latency/Users/Intent tabs all look empty.
                  parameterValue: '{user_type:(if .Payload.Metadata then (.Payload.Metadata | fromjson | .userType // "unknown") else "unknown" end)}',
                },
                {
                  parameterName: 'JsonParsingEngine',
                  parameterValue: 'JQ-1.6',
                },
              ],
            },
            {
              type: 'AppendDelimiterToRecord',
              parameters: [
                {
                  parameterName: 'Delimiter',
                  parameterValue: '\\n',
                },
              ],
            },
          ],
        },
      },
    });

    deliveryStream.node.addDependency(firehoseRole);

    // ============================================================
    // Glue Catalog (Database + Tables)
    // ============================================================

    const glueDatabase = new glue.CfnDatabase(this, 'GlueDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: ANALYTICS_DB_NAME,
        description: 'AgentEchelon analytics database',
      },
    });

    // Conversations table with partition projection
    new glue.CfnTable(this, 'ConversationsTable', {
      catalogId: this.account,
      databaseName: ANALYTICS_DB_NAME,
      tableInput: {
        name: 'conversations',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          'projection.enabled': 'true',
          'projection.user_type.type': 'enum',
          'projection.user_type.values': 'basic,standard,premium,unknown',
          'projection.year.type': 'integer',
          'projection.year.range': '2024,2030',
          'projection.month.type': 'integer',
          'projection.month.range': '1,12',
          'projection.month.digits': '2',
          'projection.day.type': 'integer',
          'projection.day.range': '1,31',
          'projection.day.digits': '2',
          'storage.location.template': `s3://${archiveBucket.bucketName}/conversations/user_type=\${user_type}/year=\${year}/month=\${month}/day=\${day}/`,
        },
        storageDescriptor: {
          columns: [
            { name: 'line', type: 'string' },
          ],
          location: `s3://${archiveBucket.bucketName}/conversations/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
          },
          compressed: true,
        },
        partitionKeys: [
          { name: 'user_type', type: 'string' },
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
        ],
      },
    }).addDependency(glueDatabase);

    // Evaluation results table with partition projection
    new glue.CfnTable(this, 'EvaluationResultsTable', {
      catalogId: this.account,
      databaseName: ANALYTICS_DB_NAME,
      tableInput: {
        name: 'evaluation_results',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          'projection.enabled': 'true',
          'projection.year.type': 'integer',
          'projection.year.range': '2024,2030',
          'projection.month.type': 'integer',
          'projection.month.range': '1,12',
          'projection.month.digits': '2',
          'projection.day.type': 'integer',
          'projection.day.range': '1,31',
          'projection.day.digits': '2',
          'storage.location.template': `s3://${archiveBucket.bucketName}/evaluations/year=\${year}/month=\${month}/day=\${day}/`,
        },
        storageDescriptor: {
          columns: [
            { name: 'exchangeId', type: 'string' },
            { name: 'intentType', type: 'string' },
            { name: 'agentType', type: 'string' },
            { name: 'relevanceScore', type: 'int' },
            { name: 'classification', type: 'string' },
            { name: 'reasoning', type: 'string' },
            { name: 'evaluatedAt', type: 'string' },
            // Config attribution — slice eval quality by config, not just model.
            // JsonSerDe leaves these null for rows written without a config fingerprint.
            { name: 'configId', type: 'string' },
            { name: 'personaVersion', type: 'string' },
            { name: 'intentPackVersion', type: 'string' },
            { name: 'systemPromptHash', type: 'string' },
          ],
          location: `s3://${archiveBucket.bucketName}/evaluations/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
          },
        },
        partitionKeys: [
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
        ],
      },
    }).addDependency(glueDatabase);

    // ============================================================
    // Athena Workgroup
    // ============================================================

    new athena.CfnWorkGroup(this, 'AthenaWorkgroup', {
      name: ATHENA_WORKGROUP_NAME,
      state: 'ENABLED',
      workGroupConfiguration: {
        resultConfiguration: {
          outputLocation: `s3://${archiveBucket.bucketName}/athena-results/`,
        },
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
      },
    });

    // ============================================================
    // Evaluation Runner Lambda
    // ============================================================

    const evaluationRunnerRole = new iam.Role(this, 'EvaluationRunnerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        AthenaPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'athena:StartQueryExecution',
                'athena:GetQueryExecution',
                'athena:GetQueryResults',
              ],
              resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/${ATHENA_WORKGROUP_NAME}`],
            }),
          ],
        }),
        GluePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'glue:GetTable',
                'glue:GetPartitions',
                'glue:GetDatabase',
              ],
              resources: [
                `arn:aws:glue:${this.region}:${this.account}:catalog`,
                `arn:aws:glue:${this.region}:${this.account}:database/${ANALYTICS_DB_NAME}`,
                `arn:aws:glue:${this.region}:${this.account}:table/${ANALYTICS_DB_NAME}/*`,
              ],
            }),
          ],
        }),
        S3Policy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // Athena requires GetBucketLocation on the query output
              // bucket to verify its region before writing results -
              // without this, every StartQueryExecution fails with
              // InvalidRequestException "Unable to verify/create output
              // bucket ...". GetObject/ListBucket/PutObject cover read
              // of source data, list of partitions, and write of both
              // Athena results and evaluation NDJSON archives.
              actions: [
                's3:GetBucketLocation',
                's3:GetObject',
                's3:ListBucket',
                's3:PutObject',
              ],
              resources: [
                archiveBucket.bucketArn,
                `${archiveBucket.bucketArn}/*`,
              ],
            }),
            // Archive bucket + Athena results are SSE-KMS on the customer CMK: reading
            // source data and writing Athena results / NDJSON both need key access.
            new iam.PolicyStatement({
              actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
              resources: [archiveKey.keyArn],
            }),
          ],
        }),
        BedrockPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel'],
              resources: [`arn:aws:bedrock:*::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`],
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const evaluationRunner = new lambdaNodeJs.NodejsFunction(this, 'EvaluationRunner', {
      entry: './lambda/src/evaluation/evaluation-runner.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      role: evaluationRunnerRole,
      environment: {
        ARCHIVE_BUCKET: archiveBucket.bucketName,
        ATHENA_WORKGROUP: ATHENA_WORKGROUP_NAME,
        ATHENA_DATABASE: ANALYTICS_DB_NAME,
        AWS_REGION_NAME: this.region,
      },
      bundling: {
        minify: false,
        forceDockerBundling: false,
      },
    });

    // Daily 2am UTC evaluation schedule
    new events.Rule(this, 'DailyEvaluationRule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '2' }),
      targets: [new targets.LambdaFunction(evaluationRunner)],
    });

    // ============================================================
    // Analytics Query API
    // ============================================================

    const appUrl = this.node.tryGetContext('appUrl') || 'http://localhost:5173';
    // The analytics query API is admin-only → the admin console origin. (The
    // client-events ingestion API below stays chat-facing on appUrl.)
    const adminAppUrl = adminOrigin(this);

    const analyticsQueryFn = new lambdaNodeJs.NodejsFunction(this, 'AnalyticsQueryFunction', {
      entry: './lambda/src/analytics-query.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(35),
      memorySize: 256,
      role: evaluationRunnerRole, // Reuse the same Athena/Glue/S3 permissions
      environment: {
        ...adminAuthEnv(this),
        ATHENA_WORKGROUP: ATHENA_WORKGROUP_NAME,
        ATHENA_DATABASE: ANALYTICS_DB_NAME,
        ALLOWED_ORIGIN: adminAppUrl,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    const analyticsApi = new apigateway.RestApi(this, 'AnalyticsApi', {
      restApiName: 'Agent Echelon Analytics',
      description: 'Analytics query API for admin dashboard',
      defaultCorsPreflightOptions: {
        // Co-hosts the admin analytics query routes AND the chat-facing /events
        // ingestion route, so the shared preflight allows both origins; each
        // Lambda echoes only its own origin (analytics -> adminAppUrl, events ->
        // appUrl) in the actual response.
        allowOrigins: sharedOrigins(this),
        allowMethods: ['POST', 'OPTIONS'],
        // A14 IAM enforcement: the admin app SIGNS these requests (SigV4); the preflight must
        // allow the signing headers or the browser CORS-blocks them ("Analytics API unavailable").
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Amz-Security-Token', 'X-Amz-Content-Sha256'],
      },
      deployOptions: {
        throttlingBurstLimit: 20,
        throttlingRateLimit: 10,
        // Access logging.
        ...apiAccessLogConfig(this, 'AnalyticsApiAccessLogs'),
      },
    });

    const analyticsIntegration = new apigateway.LambdaIntegration(analyticsQueryFn);

    // Admin-plane auth mode (ae-cognito default / federated / service) — see
    // docs/ADMIN-INTEGRATION-GUIDE.md. In ae-cognito mode this uses a Cognito
    // authorizer on AE's own user pool.
    // A14 (SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md): under adminIamEnforcement the
    // analytics query is AWS_IAM-authorized (the console SigV4-signs). Athena mode
    // enforces at the COARSE analytics-read level: this API is a single POST /query
    // (no per-capability sub-path split), so the handler's per-resource queryType
    // guard is a no-op here. This is a stack gap, NOT a data limitation — the
    // S3/Athena `conversations` archive is the system of record for the event log
    // and holds the user-activity data (Aurora is a lossy projection). Bringing
    // Athena to parity = the sub-path split here + the `channel_events` queryType in
    // the Athena Lambda. Default ON; opt out with `-c adminIamEnforcement=false` for the Cognito authorizer.
    const adminIamEnforcement = this.node.tryGetContext('adminIamEnforcement') !== false
      && this.node.tryGetContext('adminIamEnforcement') !== 'false';
    const analyticsAuthOptions: apigateway.MethodOptions = adminIamEnforcement
      ? { authorizationType: apigateway.AuthorizationType.IAM }
      : adminApiMethodOptions(this, 'AnalyticsAuthorizer', { userPool: props.userPool });
    if (adminIamEnforcement) {
      analyticsQueryFn.addEnvironment('ADMIN_IAM_ENFORCEMENT', 'true');
      // A14 Scoped: resolve the caller's classification ceiling from their assumed-role ARN via
      // this role -> ceiling map (lib/caller-scope.ts) — no Cognito call, no `cognito-idp` grant.
      if (props.classificationRoleCeilings) {
        analyticsQueryFn.addEnvironment('CLASSIFICATION_ROLE_CEILINGS', props.classificationRoleCeilings);
      }
      if (props.userPool) {
        analyticsQueryFn.addEnvironment('USER_POOL_ID', props.userPool.userPoolId);
      }
    }
    analyticsApi.root
      .addResource('query')
      .addMethod('POST', analyticsIntegration, analyticsAuthOptions);

    // A14 sign-on-role teeth: the `admins` role gets execute-api on the analytics
    // API (admins = Full). Finer persona roles get per-capability grants (Aurora).
    if (adminIamEnforcement && props.adminSignOnRoleArn) {
      const adminRole = iam.Role.fromRoleArn(this, 'ImportedAdminSignOnRole', props.adminSignOnRoleArn, { mutable: true });
      adminRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['execute-api:Invoke'],
        resources: [analyticsApi.arnForExecuteApi()],
      }));
    }

    new cdk.CfnOutput(this, 'AnalyticsApiUrl', {
      value: `${analyticsApi.url}query`,
      description: 'Analytics query API URL',
      exportName: `${this.stackName}-AnalyticsApiUrl`,
    });

    // A14: gen-frontend-env maps this to VITE_ADMIN_IAM_ENFORCEMENT so the admin console
    // signs its requests iff the backend enforces IAM — the two flags are derived from one
    // deployed value and can't drift. See SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md.
    new cdk.CfnOutput(this, 'AdminIamEnforcement', {
      value: String(adminIamEnforcement),
      description: 'Whether admin read APIs require AWS_IAM (SigV4) auth; drives admin-app request signing.',
    });

    // ============================================================
    // Client Events Pipeline
    // ============================================================
    // The frontend eventTrackingService.ts batches client events
    // (message_sent, tab_switched, web_vitals…) and POSTs them here. This
    // block provides the destination: a dedicated Firehose → S3 → Glue table
    // partitioned by event_type + date, plus a Cognito-authed POST /events
    // Lambda fronted by the existing AnalyticsApi.
    //
    // Athena-mode default (no Aurora dependency). Aurora-mode adopters
    // can dual-write later by extending the Lambda; this surface stays
    // mode-agnostic.

    const clientEventsBucketPrefix = 'client_events';

    const clientEventsFirehoseLogGroup = new logs.LogGroup(this, 'ClientEventsFirehoseLogGroup', {
      logGroupName: `/aws/kinesisfirehose/${ANALYTICS_PREFIX}-client-events`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const clientEventsFirehoseLogStream = new logs.LogStream(this, 'ClientEventsFirehoseLogStream', {
      logGroup: clientEventsFirehoseLogGroup,
      logStreamName: 'delivery-errors',
    });

    const clientEventsFirehoseRole = new iam.Role(this, 'ClientEventsFirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
      description: 'Role for the client-events Firehose to deliver records to S3',
    });

    archiveBucket.grantWrite(clientEventsFirehoseRole);
    clientEventsFirehoseLogGroup.grantWrite(clientEventsFirehoseRole);

    const clientEventsDeliveryStream = new firehose.CfnDeliveryStream(this, 'ClientEventsDelivery', {
      deliveryStreamName: `${ANALYTICS_PREFIX}-client-events`,
      deliveryStreamType: 'DirectPut',
      extendedS3DestinationConfiguration: {
        bucketArn: archiveBucket.bucketArn,
        roleArn: clientEventsFirehoseRole.roleArn,

        // partitionKey carries either an event-type name (e.g.
        // message_sent) or the literal "performance" for web-vital /
        // timer records. Both land under client_events/event_type=…/
        // so a single Glue table covers them with one partition column.
        prefix: `${clientEventsBucketPrefix}/event_type=!{partitionKeyFromQuery:event_type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/`,
        errorOutputPrefix: `${clientEventsBucketPrefix}-errors/!{firehose:error-output-type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/`,

        bufferingHints: {
          // Dynamic partitioning requires SizeInMBs >= 64 (Firehose hard
          // constraint). Interval still flushes at 60s — most batches will
          // hit the time bound first, not the size bound, given typical
          // event volume.
          intervalInSeconds: 60,
          sizeInMBs: 64,
        },

        compressionFormat: 'GZIP',

        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: clientEventsFirehoseLogGroup.logGroupName,
          logStreamName: clientEventsFirehoseLogStream.logStreamName,
        },

        dynamicPartitioningConfiguration: {
          enabled: true,
        },

        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'MetadataExtraction',
              parameters: [
                {
                  parameterName: 'MetadataExtractionQuery',
                  // partitionKey is the top-level field the Lambda writes;
                  // fall back to "unknown" so a malformed record still
                  // lands somewhere queryable rather than killing the
                  // Firehose batch.
                  parameterValue: '{event_type:.partitionKey // "unknown"}',
                },
                {
                  parameterName: 'JsonParsingEngine',
                  parameterValue: 'JQ-1.6',
                },
              ],
            },
            {
              type: 'AppendDelimiterToRecord',
              parameters: [
                { parameterName: 'Delimiter', parameterValue: '\\n' },
              ],
            },
          ],
        },
      },
    });

    clientEventsDeliveryStream.node.addDependency(clientEventsFirehoseRole);

    // Glue table — partition projection mirrors `conversations` so the
    // admin dashboard does not need a partition-load step. event_type is
    // an open enum (any string the partitioning rule wrote), so we use
    // the injected projection type.
    new glue.CfnTable(this, 'ClientEventsTable', {
      catalogId: this.account,
      databaseName: ANALYTICS_DB_NAME,
      tableInput: {
        name: 'client_events',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          'projection.enabled': 'true',
          // `injected` would require every query to include a static
          // equality predicate on event_type (Athena: "CONSTRAINT_VIOLATION
          // … the WHERE clause must contain only static equality conditions").
          // `error_rate_daily` and `page_load_metrics` legitimately scan
          // across all event_types, so we enumerate the allow-list here.
          // ALL_PARTITION_VALUES is the single source of truth, imported from
          // the same module the client-events Lambda imports for its runtime
          // allow-list — so the projection values and the accepted event types
          // can never drift apart.
          'projection.event_type.type': 'enum',
          'projection.event_type.values': [...ALL_PARTITION_VALUES].join(','),
          'projection.year.type': 'integer',
          'projection.year.range': '2024,2030',
          'projection.month.type': 'integer',
          'projection.month.range': '1,12',
          'projection.month.digits': '2',
          'projection.day.type': 'integer',
          'projection.day.range': '1,31',
          'projection.day.digits': '2',
          'storage.location.template': `s3://${archiveBucket.bucketName}/${clientEventsBucketPrefix}/event_type=\${event_type}/year=\${year}/month=\${month}/day=\${day}/`,
        },
        storageDescriptor: {
          // event_type is the partition key (defined below); Hive rejects
          // it as a regular column too. The partition column is already
          // selectable in queries, so no information is lost.
          columns: [
            { name: 'partitionkey', type: 'string' },
            { name: 'record_type', type: 'string' },
            { name: 'user_id', type: 'string' },
            { name: 'user_email', type: 'string' },
            { name: 'user_tier', type: 'string' },
            { name: 'session_id', type: 'string' },
            { name: 'timestamp', type: 'string' },
            { name: 'properties', type: 'string' },
            { name: 'perf_value', type: 'double' },
          ],
          location: `s3://${archiveBucket.bucketName}/${clientEventsBucketPrefix}/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
            parameters: {
              'ignore.malformed.json': 'true',
            },
          },
          compressed: true,
        },
        partitionKeys: [
          { name: 'event_type', type: 'string' },
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
        ],
      },
    }).addDependency(glueDatabase);

    const clientEventsFn = new lambdaNodeJs.NodejsFunction(this, 'ClientEventsFunction', {
      entry: './lambda/src/client-events.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        CLIENT_EVENTS_DELIVERY_STREAM: clientEventsDeliveryStream.deliveryStreamName!,
        ALLOWED_ORIGIN: appUrl,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    clientEventsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
        resources: [
          `arn:aws:firehose:${this.region}:${this.account}:deliverystream/${clientEventsDeliveryStream.deliveryStreamName}`,
        ],
      }),
    );

    const clientEventsIntegration = new apigateway.LambdaIntegration(clientEventsFn);
    const eventsResource = analyticsApi.root.addResource('events');
    // Fail closed: the /events endpoint ingests user-attributed events and MUST
    // be Cognito-authed. Rather than silently emit an unauthenticated method if
    // the pool prop is ever dropped, fail loudly at synth.
    if (!props.userPool) {
      throw new Error(
        'AnalyticsStack requires props.userPool to authorize the /events endpoint (fail-closed).',
      );
    }
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'ClientEventsAuthorizer', {
      cognitoUserPools: [props.userPool],
    });
    eventsResource.addMethod('POST', clientEventsIntegration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    new cdk.CfnOutput(this, 'ClientEventsApiUrl', {
      value: `${analyticsApi.url}events`,
      description: 'Client events ingestion API URL (POST). Cognito-authed when userPool prop is set.',
      exportName: `${this.stackName}-ClientEventsApiUrl`,
    });

    // ============================================================
    // Outputs
    // ============================================================

    new cdk.CfnOutput(this, 'KinesisStreamArn', {
      value: messageStream.streamArn,
      description: 'Kinesis stream ARN for Chime SDK streaming configuration',
      exportName: `${this.stackName}-KinesisStreamArn`,
    });

    new cdk.CfnOutput(this, 'KinesisStreamName', {
      value: messageStream.streamName,
      description: 'Kinesis stream name',
    });

    new cdk.CfnOutput(this, 'ArchiveBucketName', {
      value: archiveBucket.bucketName,
      description: 'S3 bucket for conversation archives',
    });

    new cdk.CfnOutput(this, 'ArchiveBucketArn', {
      value: archiveBucket.bucketArn,
      description: 'S3 bucket ARN for IAM policy configuration',
    });

    // ============================================================
    // Archival Pipeline Monitoring (opt-in)
    // ============================================================
    // Watches Kinesis IncomingRecords on the Chime → analytics stream.
    // If Chime stops streaming (config wiped, account quotas hit, IAM
    // denial), the alarm fires after 1h of zero records and an email is
    // sent to the operator addresses below via the archival-alarm Lambda.
    //
    // Opt-in: only deploys the alarm + Lambda when alertRecipients is
    // configured. Empty/unset → no alarm, no Lambda cost. The CDK
    // context shape mirrors briefingRecipients in NotificationStack:
    //   --context alertRecipients='[{"email":"ops@you.com","name":"Ops"}]'
    // The sender uses SES_SENDER_EMAIL (same identity NotificationStack
    // verifies). In SES sandbox, every recipient must also be verified.
    //
    // The metric is on the Kinesis stream, not the archival Lambda,
    // because in Athena mode there is no archival Lambda — Firehose
    // delivers straight to S3. Kinesis IncomingRecords is the upstream
    // signal and catches the most common silent failure (Chime → Kinesis
    // wiring rot) regardless of mode.
    const rawAlertRecipients =
      (this.node.tryGetContext('alertRecipients') as string | undefined) || '[]';
    const senderEmail =
      (this.node.tryGetContext('senderEmail') as string | undefined) ||
      process.env.SES_SENDER_EMAIL ||
      'noreply@example.com';

    let parsedRecipients: Array<{ email: string; name: string }> = [];
    try {
      const parsed = JSON.parse(rawAlertRecipients);
      if (Array.isArray(parsed)) {
        parsedRecipients = parsed.filter(
          (r): r is { email: string; name: string } =>
            r && typeof r.email === 'string' && typeof r.name === 'string',
        );
      }
    } catch {
      // Invalid JSON → treated as empty; the Lambda also defends against
      // a malformed env var at runtime.
    }

    if (parsedRecipients.length > 0) {
      const archivalAlarmTopic = new sns.Topic(this, 'ArchivalAlarmTopic', {
        displayName: 'AgentEchelon archival pipeline alarms',
      });

      const archivalAlarmFn = new lambdaNodeJs.NodejsFunction(this, 'ArchivalAlarmFunction', {
        entry: './lambda/src/archival-alarm.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        environment: {
          ALERT_RECIPIENTS: rawAlertRecipients,
          SENDER_EMAIL: senderEmail,
        },
        bundling: { minify: false, forceDockerBundling: false },
      });

      archivalAlarmFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail', 'ses:SendRawEmail'],
          resources: [
            `arn:aws:ses:${this.region}:${this.account}:identity/${senderEmail}`,
          ],
        }),
      );

      archivalAlarmTopic.addSubscription(new snsSubs.LambdaSubscription(archivalAlarmFn));

      const archivalAlarm = new cloudwatch.Alarm(this, 'ArchivalPipelineAlarm', {
        alarmName: `${this.stackName}-archival-pipeline-stopped`,
        alarmDescription:
          'Kinesis IncomingRecords on the Chime→analytics stream has been zero for 1 hour. ' +
          'Messages are not flowing to S3 — admin dashboard will be empty until resolved.',
        metric: messageStream.metricIncomingRecords({
          period: cdk.Duration.hours(1),
          statistic: 'Sum',
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });

      archivalAlarm.addAlarmAction(new cloudwatchActions.SnsAction(archivalAlarmTopic));
    }

    cdk.Tags.of(this).add('Component', 'Analytics');
  }
}
