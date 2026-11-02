/**
 * ONE CLASSIFICATION'S ROW OF THE RUNTIME REGISTRY, published by the stack that owns the classification.
 *
 * `Assistants-<classification>` publishes its classification's row and `Identity` the admin plane's, each as
 * one SSM parameter under the registry's path (`registryPathOf`, `lib/config/profiles.ts`), so adding a
 * classification adds one row and removing its stack removes it, and no other stack carries it. Every handler
 * reads the rows at runtime (`loadProfileRegistry`, `lib/profile-registry.ts`). A row longer than a standard
 * parameter holds is compressed, and published as an advanced parameter when it is still longer
 * (`registryRowValue`).
 *
 * THE SAME VALUE IS WRITTEN TO S3, one object per row at `registry/classification/<value>` in the registry bucket
 * `Identity` creates (`registryBucket`), by the same call that publishes the parameter, and the stack delete removes
 * it with the parameter. A function in the analytics VPC reads that copy (`PROFILE_REGISTRY_S3_ENV`): the VPC is
 * NAT-free and reaches S3 through its free gateway endpoint, and has no route to SSM. Only the writer of a row's own
 * object holds a write on it.
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import {
  registryBucketNameOf, registryPathOf, registryRowValue, REGISTRY_S3_PREFIX, STANDARD_PARAMETER_LIMIT,
} from '../config/profiles';
import { defaultProfileRegistry, PROFILE_REGISTRY_METRIC_NAMESPACE } from '../profile-registry';
import { RES_PREFIX, SSM_ROOT } from '../stacks/agent-classification-common';

/** The parameter name of `classification`'s row. */
export function registryRowKey(classification: string): string {
  return `${registryPathOf(SSM_ROOT)}/${classification}`;
}

/** The registry bucket's name in `scope`'s account and region, the same in every stack, so no stack references another for it. */
export function registryBucketName(scope: Construct): string {
  const stack = cdk.Stack.of(scope);
  return registryBucketNameOf(RES_PREFIX, stack.account, stack.region);
}

/** The S3 key of `classification`'s row. */
export function registryRowObjectKey(classification: string): string {
  return `${REGISTRY_S3_PREFIX}/${classification}`;
}

/**
 * THE REGISTRY BUCKET, created by `Identity`: the one stack every deployment has, and the first to publish a row.
 * It holds the S3 copy of the rows and nothing else. It is removed with that stack, after every
 * `Assistants-<classification>` stack (each deploys after it) has removed its own row.
 */
export function registryBucket(scope: Construct): s3.Bucket {
  return new s3.Bucket(scope, 'ProfileRegistryBucket', {
    bucketName: registryBucketName(scope),
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
  });
}

/** A published row: its parameter, and the custom resource that writes its S3 copy. */
export interface PublishedRegistryRow {
  parameter: ssm.StringParameter;
  s3Copy: cr.AwsCustomResource;
}

/**
 * Publish `classification`'s row of the deployment's set as `scope`'s parameter `id`, and write the same value to
 * its object in the registry bucket (`<id>S3Copy`), which the stack delete removes with the parameter.
 */
export function publishRegistryRow(scope: Construct, id: string, classification: string): PublishedRegistryRow {
  const value = registryRowValue(defaultProfileRegistry.registryRowOf(classification));
  const parameter = new ssm.StringParameter(scope, id, {
    parameterName: registryRowKey(classification),
    stringValue: value,
    tier: value.length > STANDARD_PARAMETER_LIMIT ? ssm.ParameterTier.ADVANCED : ssm.ParameterTier.STANDARD,
    description: `The ${classification} classification's row of the deployment's profile registry, read by every handler at runtime`,
  });
  const object = { Bucket: registryBucketName(scope), Key: registryRowObjectKey(classification) };
  const write: cr.AwsSdkCall = {
    service: 'S3',
    action: 'putObject',
    parameters: { ...object, Body: value, ContentType: 'text/plain; charset=utf-8' },
    physicalResourceId: cr.PhysicalResourceId.of(object.Key),
  };
  const s3Copy = new cr.AwsCustomResource(scope, `${id}S3Copy`, {
    onCreate: write,
    onUpdate: write,
    onDelete: { service: 'S3', action: 'deleteObject', parameters: object },
    policy: cr.AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({ actions: ['s3:PutObject', 's3:DeleteObject'], resources: [`arn:aws:s3:::${object.Bucket}/${object.Key}`] }),
    ]),
    installLatestAwsSdk: false,
  });
  return { parameter, s3Copy };
}

/**
 * THE REGISTRY'S TWO ALARMS, on the metrics every handler and the Cognito trigger emit as they load it
 * (`loadProfileRegistry`, `loadAdmission`), by the registry's path:
 *
 *   - `RegistryItemDropped`: the runtime assembly left a row, grant or profile copy out of the set, which is
 *     expected for the minutes between one classification's deploy or removal and the next deploy of a stack
 *     whose row names it, and a defect when it lasts longer (three periods in a row);
 *   - `RegistryReadFailed`: a read of the rows failed. A handler keeps the set it read before for twice the TTL,
 *     then refuses, so this alarms before that.
 */
export function registryHealthAlarms(scope: Construct): void {
  const stack = cdk.Stack.of(scope);
  const metric = (metricName: string) => new cloudwatch.Metric({
    namespace: PROFILE_REGISTRY_METRIC_NAMESPACE, metricName, statistic: 'Sum',
    period: cdk.Duration.minutes(5), dimensionsMap: { RegistryPath: registryPathOf(SSM_ROOT) },
  });
  new cloudwatch.Alarm(scope, 'ProfileRegistryItemDroppedAlarm', {
    alarmName: `${stack.stackName}-profile-registry-item-dropped`,
    alarmDescription: 'A handler left an item of the profile registry out of the set it serves (an unreadable row, a grant naming a '
      + 'classification with no row, or a profile two rows publish differently) for fifteen minutes. The log line '
      + '"profile-registry.RegistryItemDropped" names the item. Deploy the stack whose row names it, or the one it names.',
    metric: metric('RegistryItemDropped'),
    threshold: 0,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    evaluationPeriods: 3,
    datapointsToAlarm: 3,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  new cloudwatch.Alarm(scope, 'ProfileRegistryReadFailedAlarm', {
    alarmName: `${stack.stackName}-profile-registry-read-failed`,
    alarmDescription: 'A handler could not read the profile registry rows. It serves the set read before for ten minutes, then '
      + 'refuses every request. The log line "profile-registry.RegistryReadFailed" carries the error.',
    metric: metric('RegistryReadFailed'),
    threshold: 0,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
}
