import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as cr from 'aws-cdk-lib/custom-resources';
import { MessagingAppInstance } from 'cdk-amazon-chime-resources';
import { MESSAGE_RETENTION_DAYS } from '../config/conversation-types';
import { dataRemovalPolicy } from '../config/environment';
import { Construct } from 'constructs';
import { SSM_ROOT, RES_PREFIX, ANALYTICS_PREFIX } from './agent-classification-common';
import { assistantProvisioner } from '../constructs/assistant-provisioner';

export interface MessagingStackProps extends cdk.StackProps {
  appInstanceName: string;
}

/** SSM key for the service app-instance admin ARN (admin-console moderation). */
export const APP_INSTANCE_ADMIN_ARN_SSM_KEY = `${SSM_ROOT}/app-instance-admin-arn`;

/**
 * MESSAGING: the Amazon Chime SDK app instance, its service admin, its retention limit, and the
 * message stream every consumer reads.
 *
 * THE STREAM LIVES WITH THE APP INSTANCE THAT WRITES IT. The streaming configuration is a setting of the
 * app instance, so the stream and the configuration that points the app instance at it are one
 * capability, held here once, whichever archive mode the deployment runs. Its consumers take the stream
 * by reference: the archive (Firehose in Athena mode, the archival function in Aurora mode, and the
 * membership audit in both), post-processing, and the email bridge when the deployment declares
 * notifications.
 *
 * THE PROVISIONER LIVES WITH THE APP INSTANCE ITS IDENTITIES ARE ON (`lib/constructs/assistant-provisioner.ts`):
 * the one principal that builds and retires every assistant's identity and Amazon Lex bot. It is core because
 * every deployment has assistants and not every one declares `admin`, and every stack that declares assistants
 * deploys after this one, so the provisioner exists before any seed asks it.
 */
export class MessagingStack extends cdk.Stack {
  public readonly appInstanceArn: string;
  public readonly appInstanceAdminArn: string;
  /** The message stream the app instance publishes channel and message events to. */
  public readonly messageStream: kinesis.IStream;
  /** The provisioner: every assistant's identity and Amazon Lex bot are built and removed by it alone. */
  public readonly assistantProvisioner: lambda.IFunction;

  constructor(scope: Construct, id: string, props: MessagingStackProps) {
    super(scope, id, props);

    // Create Chime SDK Messaging App Instance
    const appInstance = new MessagingAppInstance(this, 'AppInstance', {
      name: props.appInstanceName,
    });

    this.appInstanceArn = appInstance.appInstanceArn;

    // THE APP INSTANCE'S PROVIDER BUILDS NO ASSISTANT. `cdk-amazon-chime-resources` gives the provider that creates
    // the app instance `chime:*AppInstance*` on every resource, which would also create and delete an assistant's
    // identity (`AppInstanceBot`). One principal builds and retires every assistant, the provisioner below, so the
    // provider's role is denied every bot action.
    const provider = this.node.tryFindChild('Custom:MessagingResourcesCustomResourceProvider');
    if (!(provider instanceof cdk.CustomResourceProviderBase)) {
      throw new Error('MessagingStack: the app instance provider was not found, so its bot actions cannot be denied');
    }
    provider.addToRolePolicy({ Sid: 'TheProvisionerAloneBuildsAssistants', Effect: 'Deny', Action: ['chime:*AppInstanceBot*'], Resource: '*' });

    // A person becomes an AppInstanceUser through the credential exchange, the one minter, at their
    // first sign-in. Separately, register ONE service AppInstanceUser as an
    // AppInstanceAdmin — the identity the admin CONSOLE uses for level-2
    // moderation (manual/automated action across conversations: redact AND
    // delete; a channel moderator can only redact). This is NOT the bot layer:
    // per-classification bots still operate as themselves for conversation work. See
    // docs/SPEC-MODERATION.md (two-level moderation model).
    const adminCreatorRole = new iam.Role(this, 'CreateAppInstanceAdminRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        ChimeIdentity: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['chime:CreateAppInstanceUser', 'chime:CreateAppInstanceAdmin'],
              resources: [this.appInstanceArn, `${this.appInstanceArn}/*`],
            }),
          ],
        }),
      },
    });

    const adminCreatorFn = new lambdaNodeJs.NodejsFunction(this, 'CreateAppInstanceAdminFunction', {
      entry: './lambda/src/create-app-instance-admin.ts',
      handler: 'handler',
      role: adminCreatorRole,
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        APP_INSTANCE_ARN: this.appInstanceArn,
        ADMIN_USER_ID: `${RES_PREFIX}-admin`,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    const adminProvider = new cdk.custom_resources.Provider(this, 'CreateAppInstanceAdminProvider', {
      onEventHandler: adminCreatorFn,
    });
    const adminResource = new cdk.CustomResource(this, 'CreateAppInstanceAdminResource', {
      serviceToken: adminProvider.serviceToken,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.appInstanceAdminArn = adminResource.getAtt('AdminArn').toString();

    // THE RETENTION LIMIT, set on the app instance so it binds every channel rather than the
    // channels whose creator remembered to check. Amazon Chime SDK evaluates this above every
    // conversation, so it is the one bound the six creation paths cannot each get wrong.
    //
    // It deletes MESSAGES and leaves the conversation standing, which is a different operation from
    // a channel expiring, and it applies to history that already exists. See the handler.
    const retentionRole = new iam.Role(this, 'SetAppInstanceRetentionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      inlinePolicies: {
        retention: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // Get as well as Put: the handler reads the current value first so a deploy that
              // LOWERS the limit is findable afterwards, which is the destructive direction.
              actions: ['chime:PutAppInstanceRetentionSettings', 'chime:GetAppInstanceRetentionSettings'],
              resources: [this.appInstanceArn],
            }),
          ],
        }),
      },
    });

    const retentionFn = new lambdaNodeJs.NodejsFunction(this, 'SetAppInstanceRetentionFunction', {
      entry: './lambda/src/set-app-instance-retention.ts',
      handler: 'handler',
      role: retentionRole,
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        APP_INSTANCE_ARN: this.appInstanceArn,
        // The MESSAGE axis, not the conversation axis: this prunes messages and leaves the channel.
        RETENTION_DAYS: String(MESSAGE_RETENTION_DAYS),
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    const retentionProvider = new cdk.custom_resources.Provider(this, 'SetAppInstanceRetentionProvider', {
      onEventHandler: retentionFn,
    });
    new cdk.CustomResource(this, 'SetAppInstanceRetentionResource', {
      serviceToken: retentionProvider.serviceToken,
      // RETAIN so a stack teardown does not relax a retention commitment as a side effect.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // The value is a property so a change to the constant triggers the resource rather than
      // leaving the deployed limit silently behind the declared one.
      properties: { RetentionDays: MESSAGE_RETENTION_DAYS },
    });

    // Publish the admin ARN so the admin-conversations Lambda can read it at
    // runtime (SSM-only contract — no Fn::importValue cross-stack coupling).
    new ssm.StringParameter(this, 'AppInstanceAdminArnParam', {
      parameterName: APP_INSTANCE_ADMIN_ARN_SSM_KEY,
      stringValue: this.appInstanceAdminArn,
      description: 'Service app-instance admin ARN — admin-console moderation (redact/delete)',
    });

    // ============================================================
    // The message stream
    // ============================================================
    //
    // The name MUST begin with `chime-messaging-`: Amazon Chime SDK Messaging refuses a streaming
    // configuration naming any other stream ("resource Arn invalid"), so the name is fixed rather than
    // generated. A transient 24-hour buffer, not durable data: the conversation archive is the system of
    // record. RETAIN in production; DESTROY otherwise, because a retained stream with a fixed name would
    // orphan at teardown and block the next fresh deploy ("resource already exists").
    const messageStream = new kinesis.Stream(this, 'MessageStream', {
      streamName: `chime-messaging-${ANALYTICS_PREFIX}`,
      shardCount: 2,
      retentionPeriod: cdk.Duration.hours(24),
      encryption: kinesis.StreamEncryption.MANAGED,
    });
    messageStream.applyRemovalPolicy(dataRemovalPolicy(this));
    this.messageStream = messageStream;

    // The app instance publishes channel and message events to the stream. Without this the stream
    // stays at zero IncomingRecords and every consumer is silently empty, so it is part of the deploy
    // rather than a manual `put-messaging-streaming-configurations` step.
    const streamingConfigurations = [
      { DataType: 'Channel', ResourceArn: messageStream.streamArn },
      { DataType: 'ChannelMessage', ResourceArn: messageStream.streamArn },
    ];
    new cr.AwsCustomResource(this, 'ChimeMessagingStreaming', {
      onCreate: {
        service: 'ChimeSDKMessaging',
        action: 'putMessagingStreamingConfigurations',
        parameters: { AppInstanceArn: this.appInstanceArn, StreamingConfigurations: streamingConfigurations },
        physicalResourceId: cr.PhysicalResourceId.of(`chime-streaming-${this.appInstanceArn}`),
      },
      onUpdate: {
        service: 'ChimeSDKMessaging',
        action: 'putMessagingStreamingConfigurations',
        parameters: { AppInstanceArn: this.appInstanceArn, StreamingConfigurations: streamingConfigurations },
        physicalResourceId: cr.PhysicalResourceId.of(`chime-streaming-${this.appInstanceArn}`),
      },
      onDelete: {
        service: 'ChimeSDKMessaging',
        action: 'deleteMessagingStreamingConfigurations',
        parameters: { AppInstanceArn: this.appInstanceArn },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'chime:PutMessagingStreamingConfigurations',
            'chime:DeleteMessagingStreamingConfigurations',
            'chime:GetMessagingStreamingConfigurations',
          ],
          resources: [this.appInstanceArn],
        }),
        // Amazon Chime SDK Messaging checks server-side that the caller of
        // PutMessagingStreamingConfigurations can write to the target stream; without these the custom
        // resource fails with "Unable to access Kinesis stream <name>" and rolls back.
        new iam.PolicyStatement({
          actions: ['kinesis:PutRecord', 'kinesis:PutRecords', 'kinesis:DescribeStream', 'kinesis:DescribeStreamSummary'],
          resources: [messageStream.streamArn],
        }),
        // Amazon Chime SDK Messaging creates its service-linked role on the first streaming setup, even
        // when one exists; without this the custom resource rolls back with "Unable to create service
        // linked role". The condition scopes the grant to that one role.
        new iam.PolicyStatement({
          actions: ['iam:CreateServiceLinkedRole'],
          resources: [
            'arn:aws:iam::*:role/aws-service-role/messaging.chime.amazonaws.com/AWSServiceRoleForChimeSDKMessaging',
          ],
          conditions: { StringLike: { 'iam:AWSServiceName': 'messaging.chime.amazonaws.com' } },
        }),
      ]),
      installLatestAwsSdk: false,
    });

    this.assistantProvisioner = assistantProvisioner(this, { appInstanceArn: this.appInstanceArn });

    // Output the App Instance ARN
    new cdk.CfnOutput(this, 'AppInstanceArnOutput', {
      value: this.appInstanceArn,
      description: 'Chime SDK App Instance ARN',
      exportName: `${this.stackName}-AppInstanceArn`,
    });

    new cdk.CfnOutput(this, 'KinesisStreamArn', {
      value: messageStream.streamArn,
      description: 'The message stream the app instance publishes to',
    });
    new cdk.CfnOutput(this, 'KinesisStreamName', {
      value: messageStream.streamName,
      description: 'The message stream name',
    });

    cdk.Tags.of(this).add('Component', 'Messaging');
  }
}
