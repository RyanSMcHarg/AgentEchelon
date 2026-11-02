/**
 * Archive Stack Interface
 *
 * What the `Archive` stack exposes in either mode, so the app entry point switches between the
 * Athena-based and the Aurora-based archive at deploy time through CDK context
 * (`analyticsMode: 'athena' | 'aurora'`) and every consumer reads one shape. Both modes deploy under the
 * one stack name `Archive`; the message stream they consume is the Messaging stack's.
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { RouteSpec } from '../constructs/http-api';

export interface IArchiveStackOutputs {
  /** S3 archive bucket ARN (conversation archives, evaluation results) */
  readonly archiveBucketArn: string;

  /** S3 archive bucket name */
  readonly archiveBucketName: string;

  /** Which archive backend is active. Also the stack's `AnalyticsMode` output. */
  readonly analyticsMode: 'athena' | 'aurora';

  /** The person routes the archive serves (client events, and the paused-deployment probe), on `PersonApi`. */
  readonly routes: readonly RouteSpec[];

  // Aurora-mode only properties

  /** RDS Proxy endpoint (Aurora mode only) */
  readonly dbProxyEndpoint?: string;

  /** VPC containing Aurora cluster and Lambdas (Aurora mode only) */
  readonly vpc?: ec2.IVpc;

  /** Security group for Aurora access (Aurora mode only) */
  readonly dbSecurityGroup?: ec2.ISecurityGroup;
}
