/**
 * Archive Stack, Athena mode (`<prefix>Archive` when `analyticsMode` is `athena`)
 *
 * The conversation archive and evaluation infrastructure:
 * - Firehose delivery of the message stream (owned by Messaging) to S3 with dynamic partitioning
 * - S3 bucket for conversation archives
 * - Athena workgroup and Glue catalog for analytics queries
 * - Evaluation runner Lambda (daily scheduled)
 * - the membership audit, on the same stream
 * - the client-events ingestion route
 *
 * The admin analytics query over this archive is the `AdminServices` stack's, which reads the bucket,
 * the Glue catalog and the Athena workgroup by name and reference.
 *
 * Data flow: Chime Messages -> Kinesis (Messaging) -> Firehose -> S3 -> Athena
 *
 * Cost: ~$25/month (Firehose + S3 + Athena on-demand; the stream is billed to Messaging)
 */

import * as cdk from 'aws-cdk-lib';
import { ALL_PARTITION_VALUES } from '../../lambda/src/lib/client-event-types';
import type * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import { grantIssuerRegistry } from '../constructs/trusted-issuers';
import type { RouteSpec } from '../constructs/http-api';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { ANALYTICS_PREFIX, ATHENA_WORKGROUP_NAME, ANALYTICS_DB_NAME, INSTANCE_SSM } from './agent-classification-common';
import { MembershipAuditConstruct } from '../constructs/membership-audit';
import { registerArchivePartitions } from '../constructs/archive-partitions';
import { utilityModelArns } from '../config/model-strategy';
import type { IArchiveStackOutputs } from '../interfaces/archive-stack-interface';

export interface ArchiveStackProps extends cdk.StackProps {
  appInstanceArn: string;
  /** The message stream the app instance publishes to, from the Messaging stack. */
  messageStream: kinesis.IStream;
  /** This deployment's own pool, when it has one (L15): the membership audit reads its groups. */
  userPool?: cognito.IUserPool;
  /** Layer 6 membership audit (SPEC-CONVERSATION-SECURITY): ALWAYS deployed. `membershipAuditEnforce`
   *  is the only knob - report-only (flag for review, default) vs auto-revoke. */
  membershipAuditEnforce?: boolean;
  senderEmail?: string;
  /**
   * The attachments bucket (Conversations). The evaluation runner reads a delivered document from the
   * conversation's deliverables (`generated-docs/*`, nothing else) to make the archive's own copy before
   * grading it (SPEC-EVALUATION FR22). Absent: no document is copied and none is graded.
   */
  attachmentsBucketArn?: string;
}

export class ArchiveStack extends cdk.Stack implements IArchiveStackOutputs {
  public readonly archiveBucketName: string;
  public readonly archiveBucketArn: string;
  public readonly analyticsMode = 'athena' as const;
  /** The client-events route, on `PersonApi`. */
  public readonly routes: RouteSpec[] = [];

  // S3 prefixes for IAM policy scoping
  public readonly basicPrefix = 'conversations/user_type=basic/';
  public readonly standardPrefix = 'conversations/user_type=standard/';
  public readonly adminPrefix = 'conversations/';

  constructor(scope: Construct, id: string, props: ArchiveStackProps) {
    super(scope, id, props);

    // ============================================================
    // The message stream (Messaging owns it; this stack consumes it)
    // ============================================================
    const messageStream = props.messageStream;

    // Layer 6: near-real-time membership audit (SPEC-CONVERSATION-SECURITY). ALWAYS deployed - flagging
    // uncleared members for review is a standing security guarantee, not opt-in; the only knob
    // is enforcement mode (membershipAuditEnforce). Requires the user pool (to resolve member tiers).
    if (props.userPool) {
      new MembershipAuditConstruct(this, 'MembershipAudit', {
        stream: messageStream,
        appInstanceArn: props.appInstanceArn,
        userPoolId: props.userPool.userPoolId,
        userPoolArn: props.userPool.userPoolArn,
        adminArnParam: INSTANCE_SSM.appInstanceAdminArn,
        enforce: props.membershipAuditEnforce,
      });
    }

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
          // 7-day expiry bounds the cost amplification limit.
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
                  // The `user_type` partition holds the CONVERSATION'S CLASSIFICATION. Its name is
                  // the S3 layout and the Glue projection, so it stays; its source is the turn's
                  // `classification`. A nested `.analytics` block (an admin alert) first, else the
                  // FLAT top-level key buildAnalyticsMetadata() emits. `unknown` when neither is
                  // present. It reads the message and nothing else, so `classification` has to stay
                  // in FRONTEND_METADATA_KEYS: Firehose cannot follow Aurora mode's out-of-band hop
                  // to DynamoDB the way the archival Lambda does.
                  parameterValue: '{user_type:(if .Payload.Metadata then (.Payload.Metadata | fromjson | .analytics.classification // .classification // "unknown") else "unknown" end)}',
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

    // Conversations table: its partitions are registered by the archival path as they are written.
    new glue.CfnTable(this, 'ConversationsTable', {
      catalogId: this.account,
      databaseName: ANALYTICS_DB_NAME,
      tableInput: {
        name: 'conversations',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          // REGISTERED, NOT PROJECTED. A projected `user_type` would enumerate the deployment's classifications here,
          // so adding one would change this table, and an injected one would refuse every query that scans across
          // classifications. Each partition is created by the archival path as it is written
          // (`registerArchivePartitions`, `lib/constructs/archive-partitions.ts`).
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
    // Each partition of that table, registered as the archive's Firehose writes it (`registerArchivePartitions`).
    registerArchivePartitions(this, archiveBucket);

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
            // WHICH ARTIFACT THE ROW IS ABOUT (SPEC-EVALUATION FR22): `exchange` (the chat reply),
            // `document` (the file the reply delivered, graded from the archive's copy) or
            // `document_skipped` (a delivered document not graded, with its reason and no score).
            // NULL on a row written before the column, which was a reply.
            { name: 'evaluationType', type: 'string' },
            { name: 'artifactKey', type: 'string' },
            { name: 'artifactSha256', type: 'string' },
            { name: 'documentKind', type: 'string' },
            { name: 'skipReason', type: 'string' },
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
              resources: utilityModelArns(this.region, this.account),
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

    // A DELIVERED DOCUMENT IS COPIED INTO THE ARCHIVE BY THE RUNNER IN THIS MODE (SPEC-EVALUATION FR22).
    // The Firehose that archives messages runs no code that could read a second object, so the runner
    // makes the archive's copy (`delivered-documents/*`, covered by its archive grant above) from the
    // conversation's deliverables, and is granted those alone (`generated-docs/*`), read-only.
    if (props.attachmentsBucketArn) {
      evaluationRunner.addEnvironment(
        'ATTACHMENTS_BUCKET',
        cdk.Fn.select(5, cdk.Fn.split(':', props.attachmentsBucketArn)),
      );
      evaluationRunnerRole.addToPolicy(new iam.PolicyStatement({
        sid: 'ReadDeliveredDocuments',
        actions: ['s3:GetObject'],
        resources: [`${props.attachmentsBucketArn}/generated-docs/*`],
      }));
    }

    // Daily 2am UTC evaluation schedule
    new events.Rule(this, 'DailyEvaluationRule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '2' }),
      targets: [new targets.LambdaFunction(evaluationRunner)],
    });

    const appUrl = this.node.tryGetContext('appUrl') || 'http://localhost:5173';

    // ============================================================
    // Client Events Pipeline
    // ============================================================
    // The frontend eventTrackingService.ts batches client events
    // (message_sent, tab_switched, web_vitals…) and POSTs them here. This
    // block provides the destination: a dedicated Firehose → S3 → Glue table
    // partitioned by event_type + date, plus the POST /events route on
    // PersonApi, behind the edge authorizer.
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
            { name: 'person_id', type: 'string' },
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

    // Who called is the edge authorizer's context, read through the registry (callerPersonId): the person
    // and the classification their issuer clears them for, for any issuer (A5).
    grantIssuerRegistry(clientEventsFn, props.userPool?.userPoolId ?? '');
    clientEventsFn.addEnvironment('APP_INSTANCE_ARN', props.appInstanceArn);
    // A PERSON ROUTE, so it ingests only user-attributed events from a token the edge verified.
    this.routes.push({
      api: 'person', method: 'POST', path: '/events', handler: clientEventsFn, capability: 'core',
      throttle: { rate: 10, burst: 20 },
    });

    // ============================================================
    // Outputs
    // ============================================================

    new cdk.CfnOutput(this, 'ArchiveBucketName', {
      value: archiveBucket.bucketName,
      description: 'S3 bucket for conversation archives',
    });

    new cdk.CfnOutput(this, 'ArchiveBucketArn', {
      value: archiveBucket.bucketArn,
      description: 'S3 bucket ARN for IAM policy configuration',
    });

    // WHICH ARCHIVE THIS IS. Both modes deploy under one stack name, so a tool that must know the mode
    // (the deploy's mode lock, the operator scripts) reads it here rather than from a stack name.
    new cdk.CfnOutput(this, 'AnalyticsMode', {
      value: this.analyticsMode,
      description: 'The archive mode this deployment runs: athena or aurora',
    });

    // The archival alarm (the stream's IncomingRecords at zero for an hour) emails people, so it lives in
    // the Notifications stack, which holds the only SES send grant.

    cdk.Tags.of(this).add('Component', 'Archive');
  }
}
