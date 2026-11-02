/**
 * ConversationArchive - the always-on conversation event archive.
 *
 * The append-only, faithful record of every channel event (messages incl.
 * redact/update/delete, membership, moderator, channel) that the Chime message
 * stream carries: Kinesis -> Firehose -> S3 (`conversations/`) -> Glue table ->
 * Athena workgroup. This is the SYSTEM OF RECORD for conversation history and the
 * audit trail (docs/guides/developer/MESSAGE-FLOW.md section 11.2), read by the admin console's
 * Conversations tab (`admin-conversations.ts`) and by Legal/HR audit.
 *
 * It is DELIBERATELY independent of the analytics engine. The Athena analytics
 * stack embeds an equivalent pipeline inline; this construct exists so the SAME
 * archive can be stood up in Aurora mode (where analytics lives in Postgres but
 * the audit trail must still exist). The Aurora projection is not a substitute:
 * it collapses membership to current-state and does not capture moderator events.
 *
 * Names (bucket, Glue database, Athena workgroup) come from the shared constants
 * so the admin-conversations Lambda's IAM (in identity-stack) and env resolve
 * to this archive unchanged in both modes.
 */
import * as cdk from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kinesis from 'aws-cdk-lib/aws-kinesis';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { ANALYTICS_PREFIX, ANALYTICS_DB_NAME, ATHENA_WORKGROUP_NAME } from '../stacks/agent-classification-common';
import { registerArchivePartitions } from './archive-partitions';


export interface ConversationArchiveProps {
  /** The Chime message event stream (Kinesis) to archive. */
  readonly messageStream: kinesis.IStream;
  /** Customer-managed key that encrypts the archive bucket. */
  readonly encryptionKey: kms.IKey;
}

export class ConversationArchive extends Construct {
  public readonly archiveBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: ConversationArchiveProps) {
    super(scope, id);

    const { account, region } = cdk.Stack.of(this);

    // Archive bucket. Deterministic name matches the admin-conversations role's
    // resource ARN (identity-stack) and the Athena analytics stack's bucket,
    // so exactly one exists per deployment (analytics mode is either/or).
    const archiveBucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `${ANALYTICS_PREFIX}-conversation-archive-${account}-${region}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.encryptionKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
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
    this.archiveBucket = archiveBucket;

    // Firehose: Kinesis stream -> S3, partitioned by classification and date.
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
      description: 'Role for Firehose to deliver conversation events to the archive',
    });
    props.messageStream.grantRead(firehoseRole);
    archiveBucket.grantWrite(firehoseRole);
    firehoseLogGroup.grantWrite(firehoseRole);
    // Firehose writes SSE-KMS objects to the archive bucket.
    props.encryptionKey.grantEncryptDecrypt(firehoseRole);

    const deliveryStream = new firehose.CfnDeliveryStream(this, 'Delivery', {
      deliveryStreamName: `${ANALYTICS_PREFIX}-message-archive`,
      deliveryStreamType: 'KinesisStreamAsSource',
      kinesisStreamSourceConfiguration: {
        kinesisStreamArn: props.messageStream.streamArn,
        roleArn: firehoseRole.roleArn,
      },
      extendedS3DestinationConfiguration: {
        bucketArn: archiveBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        prefix:
          'conversations/user_type=!{partitionKeyFromQuery:user_type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
        errorOutputPrefix: 'errors/!{firehose:error-output-type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
        bufferingHints: { intervalInSeconds: 300, sizeInMBs: 64 },
        compressionFormat: 'GZIP',
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: firehoseLogGroup.logGroupName,
          logStreamName: firehoseLogStream.logStreamName,
        },
        dynamicPartitioningConfiguration: { enabled: true },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'MetadataExtraction',
              parameters: [
                {
                  parameterName: 'MetadataExtractionQuery',
                  // The `user_type` partition holds the CONVERSATION'S CLASSIFICATION; the name is
                  // the S3 layout, the source is the turn's `classification`. A nested `.analytics`
                  // block (an admin alert) first, else the FLAT top-level key
                  // buildAnalyticsMetadata() emits. `unknown` when absent.
                  //
                  // THIS READS THE MESSAGE AND NOTHING ELSE, which is why `classification` has to
                  // stay in FRONTEND_METADATA_KEYS. Archival compensates for Aurora-mode slimming by
                  // re-reading the full blob from DynamoDB; Firehose has no such hop, so a key
                  // slimmed out of the Chime Metadata is simply gone here. It was, and every record
                  // partitioned as `unknown` until it was put back.
                  parameterValue:
                    '{user_type:(if .Payload.Metadata then (.Payload.Metadata | fromjson | .analytics.classification // .classification // "unknown") else "unknown" end)}',
                },
                { parameterName: 'JsonParsingEngine', parameterValue: 'JQ-1.6' },
              ],
            },
            {
              type: 'AppendDelimiterToRecord',
              parameters: [{ parameterName: 'Delimiter', parameterValue: '\\n' }],
            },
          ],
        },
      },
    });
    deliveryStream.node.addDependency(firehoseRole);

    // Glue catalog: database + the `conversations` table (partitions registered as they are written),
    // read by admin-conversations.ts over Athena.
    const glueDatabase = new glue.CfnDatabase(this, 'GlueDatabase', {
      catalogId: account,
      databaseInput: {
        name: ANALYTICS_DB_NAME,
        description: 'AgentEchelon analytics database',
      },
    });

    new glue.CfnTable(this, 'ConversationsTable', {
      catalogId: account,
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
          columns: [{ name: 'line', type: 'string' }],
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

    // Athena workgroup used by admin-conversations.ts (results land in the bucket).
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
  }
}
