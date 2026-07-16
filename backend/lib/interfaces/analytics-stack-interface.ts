/**
 * Analytics Stack Interface
 *
 * Common interface for analytics stack outputs, allowing the app entry point
 * to switch between Athena-based and Aurora-based analytics at deploy time
 * via CDK context: `analyticsMode: 'athena' | 'aurora'`.
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';

export interface IAnalyticsStackOutputs {
  /** Kinesis Data Stream ARN for Chime SDK message streaming */
  readonly kinesisStreamArn: string;

  /** Kinesis Data Stream name */
  readonly kinesisStreamName: string;

  /** S3 archive bucket ARN (conversation archives, evaluation results) */
  readonly archiveBucketArn: string;

  /** S3 archive bucket name */
  readonly archiveBucketName: string;

  /** Which analytics backend is active */
  readonly analyticsMode: 'athena' | 'aurora';

  // Aurora-mode only properties

  /** RDS Proxy endpoint (Aurora mode only) */
  readonly dbProxyEndpoint?: string;

  /** VPC containing Aurora cluster and Lambdas (Aurora mode only) */
  readonly vpc?: ec2.IVpc;

  /** Security group for Aurora access (Aurora mode only) */
  readonly dbSecurityGroup?: ec2.ISecurityGroup;
}
