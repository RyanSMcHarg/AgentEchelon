import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { MessagingAppInstance } from 'cdk-amazon-chime-resources';
import { Construct } from 'constructs';
import { SSM_ROOT, RES_PREFIX } from './agent-tier-common';

export interface ChimeMessagingStackProps extends cdk.StackProps {
  appInstanceName: string;
}

/** SSM key for the service app-instance admin ARN (admin-console moderation). */
export const APP_INSTANCE_ADMIN_ARN_SSM_KEY = `${SSM_ROOT}/app-instance-admin-arn`;

export class ChimeMessagingStack extends cdk.Stack {
  public readonly appInstanceArn: string;
  public readonly appInstanceAdminArn: string;

  constructor(scope: Construct, id: string, props: ChimeMessagingStackProps) {
    super(scope, id, props);

    // Create Chime SDK Messaging App Instance
    const appInstance = new MessagingAppInstance(this, 'AppInstance', {
      name: props.appInstanceName,
    });

    this.appInstanceArn = appInstance.appInstanceArn;

    // Human users become AppInstanceUsers via the Cognito Identity Pool after
    // authentication. Separately, register ONE service AppInstanceUser as an
    // AppInstanceAdmin — the identity the admin CONSOLE uses for level-2
    // moderation (manual/automated action across conversations: redact AND
    // delete; a channel moderator can only redact). This is NOT the bot layer:
    // per-tier bots still operate as themselves for conversation work. See
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

    // Publish the admin ARN so the admin-conversations Lambda can read it at
    // runtime (SSM-only contract — no Fn::importValue cross-stack coupling).
    new ssm.StringParameter(this, 'AppInstanceAdminArnParam', {
      parameterName: APP_INSTANCE_ADMIN_ARN_SSM_KEY,
      stringValue: this.appInstanceAdminArn,
      description: 'Service app-instance admin ARN — admin-console moderation (redact/delete)',
    });

    // Output the App Instance ARN
    new cdk.CfnOutput(this, 'AppInstanceArnOutput', {
      value: this.appInstanceArn,
      description: 'Chime SDK App Instance ARN',
      exportName: `${this.stackName}-AppInstanceArn`,
    });

    // Add tags
    cdk.Tags.of(this).add('Component', 'ChimeMessaging');
  }
}
