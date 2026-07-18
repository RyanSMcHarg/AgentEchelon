/**
 * AdminNotificationStack (A6) — auto-provisions the admin notification channel that the
 * membership-audit and admin-error alert paths post to (in-app + email). SEPARATELY-DEPLOYABLE and
 * opt-in (`enableAdminNotificationChannel`); when off, those alerts stay log-only (or use a
 * hand-passed `-c membershipAuditAlertChannelArn`).
 *
 * A Lambda-backed custom resource (mirrors create-app-instance-admin) creates ONE "Admin
 * Notifications" channel as the service app-instance-admin, adds the `admins` group as members, and
 * stamps them into Metadata.participants (the email fan-out reads the roster, not membership). The
 * channel ARN is exposed as `channelArn` (a cross-stack token) so bin can feed it to both alert
 * paths; referencing it there adds the stack dependency automatically.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { Construct } from 'constructs';

export interface AdminNotificationStackProps extends cdk.StackProps {
  /** The Chime app-instance ARN (channels + members live under it). */
  appInstanceArn: string;
  /** The service app-instance-admin ARN — the ChimeBearer that creates the channel + adds members. */
  appInstanceAdminArn: string;
  /** Primary Cognito user pool (the `admins` group is resolved from it). */
  userPoolId: string;
  userPoolArn: string;
  /** Cognito group whose members are added to the channel. Default `admins`. */
  adminGroupName?: string;
}

export class AdminNotificationStack extends cdk.Stack {
  /** ARN of the provisioned admin notification channel (a cross-stack token). */
  public readonly channelArn: string;

  constructor(scope: Construct, id: string, props: AdminNotificationStackProps) {
    super(scope, id, props);

    const fn = new lambdaNodeJs.NodejsFunction(this, 'ProvisionFn', {
      entry: path.join(__dirname, '../../lambda/src/admin-notification-channel-provision.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        APP_INSTANCE_ARN: props.appInstanceArn,
        ADMIN_BEARER_ARN: props.appInstanceAdminArn,
        USER_POOL_ID: props.userPoolId,
        ADMIN_GROUP_NAME: props.adminGroupName || 'admins',
        CHANNEL_NAME: 'Admin Notifications',
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    // Chime: create the channel + add members + stamp the roster + delete on teardown, all as the
    // app-instance-admin bearer. Authorizes against the app-instance, its channels, and the bearer.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'chime:CreateChannel',
        'chime:CreateChannelMembership',
        'chime:UpdateChannel',
        'chime:DeleteChannel',
        'chime:TagResource',
        'chime:CreateChannelModerator',
      ],
      resources: [
        props.appInstanceArn,
        `${props.appInstanceArn}/user/*`,
        `${props.appInstanceArn}/channel/*`,
      ],
    }));
    // Cognito: list the admins group to resolve who to add.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:ListUsersInGroup'],
      resources: [props.userPoolArn],
    }));

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: fn,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    const resource = new cdk.CustomResource(this, 'AdminNotificationChannel', {
      serviceToken: provider.serviceToken,
      properties: {
        // Force an Update each deploy so the admin roster re-syncs (picks up new admins).
        Timestamp: Date.now().toString(),
      },
    });

    this.channelArn = resource.getAttString('ChannelArn');
    new cdk.CfnOutput(this, 'AdminNotificationChannelArn', {
      value: this.channelArn,
      description: 'Admin notification channel ARN (membership-audit + admin-error alerts post here)',
      exportName: `${this.stackName}-AdminNotificationChannelArn`,
    });

    cdk.Tags.of(this).add('Component', 'AdminNotification');
  }
}
