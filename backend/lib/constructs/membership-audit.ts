/**
 * MembershipAuditConstruct — SPEC-CONVERSATION-SECURITY Layer 6.
 *
 * Wires the near-real-time membership-audit consumer to a Chime -> Kinesis message stream.
 * Instantiated by BOTH analytics stacks (Athena and Aurora) behind `enableMembershipAudit`,
 * so the audit runs in whichever analytics mode is deployed. The Lambda is intentionally
 * NOT in a VPC: it only calls Chime, Cognito, SSM, and SES (all public AWS APIs), so it
 * needs no Aurora/VPC access even in Aurora mode.
 *
 * See `backend/lambda/src/membership-audit.ts` for the runtime behavior.
 */
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as path from 'path';
import { SSM_ROOT } from '../stacks/agent-classification-common';

export interface MembershipAuditProps {
  /** The Chime -> Kinesis message stream (carries CREATE/UPDATE_CHANNEL_MEMBERSHIP events). */
  stream: kinesis.IStream;
  appInstanceArn: string;
  /** Primary Cognito user pool: member-tier resolution + recipient contact lookup. */
  userPoolId: string;
  userPoolArn: string;
  /** SSM parameter NAME holding the app-instance-admin ARN (the cross-channel moderator bearer). */
  adminArnParam: string;
  /** Admin conversation channel that alerts post into (in-app + email fan-out). Optional;
   *  when absent the audit degrades to log-only. */
  alertChannelArn?: string;
  /** Verified SES sender for the email leg. Optional; the email fan-out degrades gracefully. */
  senderEmail?: string;
  /** When true, over-tier memberships are auto-revoked. Default false (report-only). */
  enforce?: boolean;
}

export class MembershipAuditConstruct extends Construct {
  public readonly fn: lambdaNodeJs.NodejsFunction;
  public readonly auditTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: MembershipAuditProps) {
    super(scope, id);

    // Findings the admin dashboard reviews, plus the runtime enforce toggle (`config/enforce`
    // item). CDK creates the table only; the enforce item is written at runtime by the admin
    // API, so `cdk deploy` never resets a live report-only <-> auto-revoke choice.
    this.auditTable = new dynamodb.Table(this, 'AuditTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.fn = new lambdaNodeJs.NodejsFunction(this, 'Fn', {
      entry: path.join(__dirname, '../../lambda/src/membership-audit.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        USER_POOL_ID: props.userPoolId,
        APP_INSTANCE_ARN: props.appInstanceArn,
        ADMIN_ARN_PARAM: props.adminArnParam,
        SSM_ROOT,
        AUDIT_TABLE: this.auditTable.tableName,
        MEMBERSHIP_AUDIT_ALERT_CHANNEL_ARN: props.alertChannelArn || '',
        MEMBERSHIP_AUDIT_ENFORCE: props.enforce ? 'true' : 'false',
        ...(props.senderEmail ? { SES_SENDER_EMAIL: props.senderEmail } : {}),
      },
    });

    // Consume the stream (its own iterator/checkpoint, independent of the archival consumer).
    props.stream.grantRead(this.fn);
    this.fn.addEventSource(
      new lambdaEventSources.KinesisEventSource(props.stream, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 100,
        maxBatchingWindow: cdk.Duration.seconds(5),
        retryAttempts: 3,
        bisectBatchOnError: true,
      }),
    );
    this.auditTable.grantReadWriteData(this.fn);

    // Chime: read channel tier from the immutable `classification` tag, revoke membership, post
    // the admin-conversation alert. Authorizes against the channel resource AND the admin bearer
    // identity (`/user/*`). ListTagsForResource replaces the old DescribeChannel metadata read so
    // the tier comparison keys on the tamper-proof tag, not mutable channel metadata.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['chime:ListTagsForResource', 'chime:DeleteChannelMembership', 'chime:SendChannelMessage'],
        resources: [`${props.appInstanceArn}/channel/*`, `${props.appInstanceArn}/user/*`],
      }),
    );

    // Cognito: authoritative member tier (AdminListGroupsForUser) + recipient contact (AdminGetUser).
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser'],
        resources: [props.userPoolArn],
      }),
    );

    // SSM: the app-instance-admin ARN.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: props.adminArnParam.replace(/^\//, ''),
          }),
          // Per-tier assistant bot ARNs, to resolve a bot member's tier.
          cdk.Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: `${SSM_ROOT.replace(/^\//, '')}/assistant/*`,
          }),
        ],
      }),
    );

    // SES: the email leg of the admin alert (best-effort).
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
      }),
    );
  }
}
