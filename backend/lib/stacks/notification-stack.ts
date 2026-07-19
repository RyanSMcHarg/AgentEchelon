import * as cdk from 'aws-cdk-lib';
import { apiAccessLogConfig } from '../constructs/api-access-logging';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { SSM_ROOT, botArnKey } from './agent-classification-common';

export interface NotificationStackProps extends cdk.StackProps {
  appInstanceArn: string;
  userPoolId: string;
  /**
   * Email address used as the sender for share notifications.
   * SES will create an email identity verification for this address.
   * In SES sandbox mode (the default for new AWS accounts), both sender
   * AND recipient emails must be verified. Request production access
   * via the SES console to send to any recipient.
   */
  senderEmail: string;
  /** Frontend URL for conversation deep links */
  appUrl?: string;
  /**
   * Set true when `senderEmail` is ALREADY a verified SES identity (or is
   * covered by a verified domain identity, or verification is managed outside
   * this stack). Skips creating the per-address `AWS::SES::EmailIdentity` —
   * which CloudFormation cannot do for an identity that already exists
   * ("AlreadyExists"). The SendEmail IAM grant and the SENDER_EMAIL env still
   * use the address, so delivery works.
   */
  senderEmailPreVerified?: boolean;
}

export class NotificationStack extends cdk.Stack {
  public readonly shareConversationApiUrl: string;

  constructor(scope: Construct, id: string, props: NotificationStackProps) {
    super(scope, id, props);

    // ============================================================
    // SES Email Identity
    //
    // Creates a verified email identity for the sender address.
    // After deployment, the email owner must click the verification
    // link that SES sends. Until verified, SendEmail calls will fail.
    //
    // For domain-level verification (avoids per-address verification),
    // replace EmailIdentity with a domain identity and add the DNS
    // records SES provides to your domain's DNS.
    // ============================================================

    // Skipped when senderEmailPreVerified: the address is already a verified SES
    // identity (CFN can't re-create an existing identity), or a domain identity
    // / external process handles verification. The IAM SendEmail grant + the
    // SENDER_EMAIL env below use the address directly, so delivery still works.
    const emailIdentity = props.senderEmailPreVerified
      ? undefined
      : new ses.EmailIdentity(this, 'SenderEmailIdentity', {
          identity: ses.Identity.email(props.senderEmail),
        });

    // ============================================================
    // Share Conversation Lambda
    // ============================================================

    const shareConversationRole = new iam.Role(this, 'ShareConversationRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'chime:CreateChannelMembership',
                'chime:ListChannelMemberships',
                'chime:ListChannelMessages',
                'chime:SendChannelMessage',
                'chime:DescribeChannel',
                // Verifies the caller is already a member of the conversation
                // before allowing them to share it with someone else.
                'chime:DescribeChannelMembership',
                // Reads the channel's classification from the IMMUTABLE `classification` tag
                // (not mutable metadata) for the over-classification-invite gate + bot-classification
                // binding, so a moderator cannot tamper metadata to weaken admission.
                'chime:ListTagsForResource',
              ],
              resources: [`${props.appInstanceArn}/*`],
            }),
          ],
        }),
        CognitoPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'cognito-idp:ListUsers',
                'cognito-idp:AdminListGroupsForUser',
              ],
              resources: [
                `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.userPoolId}`,
              ],
            }),
          ],
        }),
        BedrockPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel'],
              // Haiku is used for join-summary generation (cheapest model)
              resources: [
                `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
              ],
            }),
          ],
        }),
        SSMPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter'],
              resources: [
                // Resolve the channel's per-classification bot (the real creator+member)
                // to add members + send as the assistant. No shared cross-classification
                // bot.
                `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/bot-arn`,
              ],
            }),
          ],
        }),
        SESPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ses:SendEmail', 'ses:SendRawEmail'],
              // Scoped to the verified identity ARN
              resources: [
                `arn:aws:ses:${this.region}:${this.account}:identity/${props.senderEmail}`,
              ],
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const shareConversationFunction = new lambda.Function(this, 'ShareConversationFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/share-conversation'),
      // Timeout covers: Cognito lookup + Chime describe + Chime list members
      // + Bedrock summary (up to ~8s) + 2 SendChannelMessage calls + SES.
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        SSM_ROOT,
        APP_INSTANCE_ARN: props.appInstanceArn,
        USER_POOL_ID: props.userPoolId,
        SENDER_EMAIL: props.senderEmail,
        APP_URL: props.appUrl || 'http://localhost:5173',
        SUMMARY_MODEL_ID: 'anthropic.claude-3-haiku-20240307-v1:0',
      },
      role: shareConversationRole,
    });

    // ============================================================
    // API Gateway
    // ============================================================

    const appUrl = this.node.tryGetContext('appUrl') || props.appUrl || 'http://localhost:5173';

    const api = new apigateway.RestApi(this, 'NotificationApi', {
      restApiName: 'AI Agent Notification API',
      description: 'API for conversation sharing and notifications',
      defaultCorsPreflightOptions: {
        allowOrigins: [appUrl],
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      deployOptions: {
        throttlingBurstLimit: 50,
        throttlingRateLimit: 25,
        // Access logging.
        ...apiAccessLogConfig(this, 'NotificationApiAccessLogs'),
      },
    });

    // /share-conversation is Cognito-authed so no anonymous caller can add a
    // user to a channel or send a SES email under an arbitrary sender name. The
    // Lambda additionally verifies the caller is a channel member, and stamps
    // identity from the JWT rather than trusting the request body.
    const notificationUserPool = cognito.UserPool.fromUserPoolId(
      this,
      'ImportedUserPoolForNotification',
      props.userPoolId,
    );
    const notificationAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      'NotificationAuthorizer',
      { cognitoUserPools: [notificationUserPool] },
    );

    const shareIntegration = new apigateway.LambdaIntegration(shareConversationFunction);
    api.root.addResource('share-conversation').addMethod('POST', shareIntegration, {
      authorizer: notificationAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    this.shareConversationApiUrl = `${api.url}share-conversation`;

    // ============================================================
    // Outputs
    // ============================================================

    new cdk.CfnOutput(this, 'ShareConversationApiUrl', {
      value: this.shareConversationApiUrl,
      description: 'API Gateway URL for sharing conversations via email',
      exportName: `${this.stackName}-ShareConversationApiUrl`,
    });

    new cdk.CfnOutput(this, 'SenderEmailIdentityArn', {
      value: `arn:aws:ses:${this.region}:${this.account}:identity/${props.senderEmail}`,
      description: 'SES email identity ARN — verify this email after deployment',
    });

    new cdk.CfnOutput(this, 'SESVerificationNote', {
      value: `Check ${props.senderEmail} inbox for SES verification email. In sandbox mode, recipients must also be verified.`,
      description: 'Post-deployment action required',
    });

    // ============================================================
    // Proactive Briefing — EventBridge-triggered proactive workflow
    //
    // Demonstrates the "proactive" half of the product story: on a
    // schedule, with no user in the loop, create a conversation +
    // render an on-the-fly briefing page to S3 + email members via the
    // notification workflow. Minimal-but-real: a genuine
    // deployed EventBridge feature, not hardened for dedupe (a periodic
    // re-fire intentionally produces a fresh briefing).
    //
    // Recipients + schedule are deployment config via CDK context:
    //   --context briefingRecipients='[{"userArn":"...","email":"...","name":"..."}]'
    //   --context briefingScheduleRate='rate(1 day)'   (default: daily)
    // With no recipients the Lambda no-ops safely.
    // ============================================================

    const briefingsBucket = new s3.Bucket(this, 'BriefingsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Briefing pages are ephemeral (presigned link TTL is 7 days);
      // expire objects so the bucket doesn't accumulate.
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const briefingRole = new iam.Role(this, 'ProactiveBriefingRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'chime:CreateChannel',
                'chime:CreateChannelMembership',
                'chime:AssociateChannelFlow',
                'chime:SendChannelMessage',
                // Layer 1: briefing channels are tagged classification at creation.
                'chime:TagResource',
              ],
              resources: [`${props.appInstanceArn}/*`, props.appInstanceArn],
            }),
          ],
        }),
        SSMPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter'],
              resources: [
                // Resolve the channel's per-classification bot (the real creator+member)
                // to add members + send as the assistant. No shared cross-classification
                // bot.
                `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/bot-arn`,
              ],
            }),
          ],
        }),
        SESPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ses:SendEmail', 'ses:SendRawEmail'],
              resources: [
                `arn:aws:ses:${this.region}:${this.account}:identity/${props.senderEmail}`,
              ],
            }),
          ],
        }),
        S3Policy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:PutObject', 's3:GetObject'],
              resources: [`${briefingsBucket.bucketArn}/briefings/*`],
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    // SES identity must exist before the Lambda role references it.
    if (emailIdentity) briefingRole.node.addDependency(emailIdentity);

    const briefingRecipients =
      this.node.tryGetContext('briefingRecipients') || '[]';
    const briefingScheduleRate =
      this.node.tryGetContext('briefingScheduleRate') || 'rate(1 day)';

    const proactiveBriefingFunction = new lambdaNodeJs.NodejsFunction(
      this,
      'ProactiveBriefingFunction',
      {
        entry: './lambda/src/proactive-briefing.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(60),
        memorySize: 512,
        role: briefingRole,
        environment: {
          APP_INSTANCE_ARN: props.appInstanceArn,
          // The proactive briefing creates a STANDARD-classification conversation (its
          // metadata + classification tag) and runs as the STANDARD classification
          // assistant — no shared cross-classification bot. The classification must match the
          // channel's `classification` tag or the fail-closed Layer 1 IAM would
          // block the assistant. Future: select a per-classification assistant per
          // recipient.
          BOT_ARN_PARAM: botArnKey('standard'),
          REPORT_BUCKET: briefingsBucket.bucketName,
          APP_URL: appUrl,
          SENDER_EMAIL: props.senderEmail,
          // JSON [{userArn,email,name}] — deployment-configurable; the
          // Lambda no-ops on []. (Channel-flow association is omitted in
          // this minimal feature — it's best-effort/non-fatal in the
          // Lambda; the bot still creates + seeds the conversation.)
          BRIEFING_RECIPIENTS: briefingRecipients,
        },
        bundling: { minify: false, forceDockerBundling: false },
      },
    );

    new events.Rule(this, 'ProactiveBriefingSchedule', {
      description: 'Fires the proactive briefing workflow on a schedule (no user in the loop)',
      schedule: events.Schedule.expression(briefingScheduleRate),
      targets: [new targets.LambdaFunction(proactiveBriefingFunction)],
    });

    new cdk.CfnOutput(this, 'ProactiveBriefingFunctionName', {
      value: proactiveBriefingFunction.functionName,
      description:
        'Proactive briefing Lambda. Invoke manually with: ' +
        'aws lambda invoke --function-name <this> /dev/stdout',
    });
    new cdk.CfnOutput(this, 'BriefingsBucketName', {
      value: briefingsBucket.bucketName,
      description: 'S3 bucket holding the on-the-fly briefing pages (briefings/*)',
    });

    cdk.Tags.of(this).add('Component', 'Notifications');
  }
}
