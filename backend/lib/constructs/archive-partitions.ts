/**
 * THE CONVERSATION ARCHIVE'S PARTITIONS, REGISTERED AS THE ARCHIVAL PATH WRITES THEM.
 *
 * The `conversations` Glue table is partitioned by `user_type` (the conversation's classification, or `unknown`)
 * and the date, and registers its partitions rather than projecting them, so the table names no classification:
 * a classification added or removed changes no table, and every query reads the partitions as it read the
 * projected ones. Each object the archive's Firehose creates under `conversations/` invokes the registrar
 * (`lambda/src/archive-partition-registrar.ts`, an S3 event notification), which creates its partition in Glue,
 * idempotently. Built in both analytics modes, by the stack that owns the bucket and the table.
 *
 * Three more things make the registration whole: a custom resource runs the registrar once per deploy over the
 * partition prefixes already in the bucket (objects archived before the registrar existed); an invocation that
 * fails every retry is kept on a dead-letter queue, which is alarmed; and the registrar remembers nothing across
 * invocations, so a partition removed from Glue is registered again by the next object written to it.
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as path from 'path';
import type { Construct } from 'constructs';
import { ANALYTICS_DB_NAME } from '../stacks/agent-classification-common';

/** The table whose partitions the registrar creates, and the prefix its objects are written under. */
export const ARCHIVE_CONVERSATIONS_TABLE = 'conversations';
export const ARCHIVE_CONVERSATIONS_PREFIX = 'conversations/';

/** Register each `conversations/` partition the archive's Firehose writes into `bucket`, as it is written. */
export function registerArchivePartitions(scope: Construct, bucket: s3.IBucket): lambdaNodeJs.NodejsFunction {
  const stack = cdk.Stack.of(scope);
  const { region, account } = stack;
  // AN EVENT EVERY RETRY FAILED is kept here for an operator, and the alarm below says so.
  const dlq = new sqs.Queue(scope, 'ArchivePartitionRegistrarDlq', {
    retentionPeriod: cdk.Duration.days(14),
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
  });
  const fn = new lambdaNodeJs.NodejsFunction(scope, 'ArchivePartitionRegistrar', {
    entry: path.join(__dirname, '../../lambda/src/archive-partition-registrar.ts'),
    handler: 'handler',
    runtime: lambda.Runtime.NODEJS_20_X,
    // The deploy-time backfill lists and registers every partition already in the bucket.
    timeout: cdk.Duration.minutes(5),
    memorySize: 256,
    description: 'Registers each conversation archive partition in Glue as the archive writes it, and those already written at deploy',
    retryAttempts: 2,
    deadLetterQueue: dlq,
    environment: {
      ARCHIVE_DATABASE: ANALYTICS_DB_NAME,
      ARCHIVE_TABLE: ARCHIVE_CONVERSATIONS_TABLE,
      ARCHIVE_PREFIX: ARCHIVE_CONVERSATIONS_PREFIX,
    },
    bundling: { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] },
  });
  // THE TABLE'S DESCRIPTOR AND ITS PARTITIONS, AND NOTHING ELSE: it reads the table to copy its storage
  // descriptor and creates a partition; it reads no object and holds no other table.
  fn.addToRolePolicy(new iam.PolicyStatement({
    sid: 'RegisterTheConversationsPartitions',
    actions: ['glue:GetTable', 'glue:CreatePartition', 'glue:BatchCreatePartition'],
    resources: [
      `arn:aws:glue:${region}:${account}:catalog`,
      `arn:aws:glue:${region}:${account}:database/${ANALYTICS_DB_NAME}`,
      `arn:aws:glue:${region}:${account}:table/${ANALYTICS_DB_NAME}/${ARCHIVE_CONVERSATIONS_TABLE}`,
    ],
  }));
  bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(fn), { prefix: ARCHIVE_CONVERSATIONS_PREFIX });

  // THE BACKFILL: list the partition prefixes under `conversations/` (names only, no object read) and register each.
  fn.addToRolePolicy(new iam.PolicyStatement({
    sid: 'ListTheConversationsPartitionPrefixes',
    actions: ['s3:ListBucket'],
    resources: [bucket.bucketArn],
    conditions: { StringLike: { 's3:prefix': [`${ARCHIVE_CONVERSATIONS_PREFIX}*`] } },
  }));
  const provider = new cr.Provider(scope, 'ArchivePartitionBackfillProvider', { onEventHandler: fn });
  new cdk.CustomResource(scope, 'ArchivePartitionBackfill', {
    serviceToken: provider.serviceToken,
    // Runs on the deploy that creates it and on any change to what it lists; registering again is a no-op.
    properties: { BucketName: bucket.bucketName, Prefix: ARCHIVE_CONVERSATIONS_PREFIX },
  });

  new cloudwatch.Alarm(scope, 'ArchivePartitionRegistrarDlqAlarm', {
    alarmName: `${stack.stackName}-archive-partition-unregistered`,
    alarmDescription: 'The partition of an archive object was not registered in Glue after every retry; the S3 event is kept in the '
      + 'dead-letter queue of the registrar, and the records of that partition are unread until it is registered. '
      + 'See docs/specs/interaction/conversation/SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md Appendix D.',
    metric: dlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5), statistic: 'Maximum' }),
    threshold: 0,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  return fn;
}
