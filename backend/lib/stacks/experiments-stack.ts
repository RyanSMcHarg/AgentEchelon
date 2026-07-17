/**
 * ExperimentsStack (`AgentEchelonExperiments`) — the A/B experiments feature, an
 * independently-deployable stack.
 *
 * Owns:
 *   - The `experiments` DynamoDB table (all-tier A/B DATA — shared, carries no
 *     agent identity, so a shared table is consistent with the separation posture).
 *   - The `admin-experiments` API (`/admin/experiments` GET/POST + `{id}/status`)
 *     behind a Cognito authorizer; the handler additionally requires the `admins`
 *     group. Output `ExperimentsApiUrl` → frontend `VITE_EXPERIMENTS_API_URL`.
 *   - Publishes the shared SSM contract `/agent-echelon/shared/tables/experiments-{arn,name}`
 *     that the per-tier processors/handlers resolve for runtime A/B variant lookup.
 *
 * A deployer who doesn't want A/B experiments can still deploy it (cheap: one
 * on-demand table + one Lambda); battle-enabled experiments additionally require
 * AgentEchelonBattle (the handler resolves the alt-bot roster it publishes).
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { apiAccessLogConfig } from '../constructs/api-access-logging';
import { adminApiMethodOptions, adminAuthEnv } from '../constructs/admin-auth-mode';
import { SHARED_SSM, INSTANCE_SSM } from './agent-tier-common';

export interface ExperimentsStackProps extends cdk.StackProps {
  appInstanceArn: string;
  userPoolId: string;
  /** Frontend URL for CORS (defaults to the `appUrl` context / localhost). */
  appUrl?: string;
}

export class ExperimentsStack extends cdk.Stack {
  public readonly experimentsTableName: string;
  public readonly experimentsTableArn: string;
  public readonly experimentsApiUrl: string;

  constructor(scope: Construct, id: string, props: ExperimentsStackProps) {
    super(scope, id, props);

    const isProduction = this.node.tryGetContext('isProduction') === 'true';
    const dataRemovalPolicy = isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    const appUrl = this.node.tryGetContext('appUrl') || props.appUrl || 'http://localhost:5173';
    // AgentEchelonBattle owns + publishes this roster; admin-experiments only READS it
    // (by name) to denormalize altBotSlotId → altBotSlotArn for battle experiments.
    const altBotRosterParamName = INSTANCE_SSM.altBotSlotsRoster;

    const experimentsTable = new dynamodb.Table(this, 'ExperimentsTable', {
      partitionKey: { name: 'experimentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: dataRemovalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    this.experimentsTableName = experimentsTable.tableName;
    this.experimentsTableArn = experimentsTable.tableArn;

    // Shared SSM contract — the per-tier processors/handlers resolve these at
    // deploy time for runtime A/B variant lookup.
    new ssm.StringParameter(this, 'SharedExperimentsArnParam', {
      parameterName: SHARED_SSM.experimentsArn,
      stringValue: experimentsTable.tableArn,
    });
    new ssm.StringParameter(this, 'SharedExperimentsNameParam', {
      parameterName: SHARED_SSM.experimentsName,
      stringValue: experimentsTable.tableName,
    });

    // ── admin-experiments API ──────────────────────────────────────────────
    const adminExperimentsRole = new iam.Role(this, 'AdminExperimentsRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ExperimentsDdb: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem'],
              resources: [experimentsTable.tableArn],
            }),
          ],
        }),
        RosterSSM: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter'],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${altBotRosterParamName}`],
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const adminExperimentsFn = new lambdaNodeJs.NodejsFunction(this, 'AdminExperimentsFunction', {
      entry: './lambda/src/admin-experiments.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(20),
      memorySize: 256,
      role: adminExperimentsRole,
      environment: {
        ...adminAuthEnv(this),
        EXPERIMENTS_TABLE: experimentsTable.tableName,
        APP_INSTANCE_ARN: props.appInstanceArn,
        ALT_BOT_SLOTS_ROSTER_PARAM: altBotRosterParamName,
        ALLOWED_ORIGIN: appUrl,
        // Battle eligibility is per-profile config now (AssistantProfile.battleEligible), read by
        // experiment-manager.ts via the registry — no longer an ALLOWED_BATTLE_TIERS env var.
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    const api = new apigateway.RestApi(this, 'ExperimentsApi', {
      restApiName: 'AI Agent Experiments API',
      description: 'Admin A/B experiments CRUD',
      defaultCorsPreflightOptions: {
        allowOrigins: [appUrl],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      deployOptions: {
        throttlingBurstLimit: 50,
        throttlingRateLimit: 25,
        ...apiAccessLogConfig(this, 'ExperimentsApiAccessLogs'),
      },
    });

    // Admin-plane auth mode (ae-cognito default / federated / service) — see
    // docs/ADMIN-INTEGRATION-GUIDE.md. ae-cognito uses a Cognito authorizer on AE's own pool.
    const experimentsAuthOptions = adminApiMethodOptions(this, 'ExperimentsAuthorizer', {
      userPoolId: props.userPoolId,
    });

    const integration = new apigateway.LambdaIntegration(adminExperimentsFn);
    const adminRoot = api.root.addResource('admin');
    const experimentsResource = adminRoot.addResource('experiments');
    for (const m of ['GET', 'POST']) {
      experimentsResource.addMethod(m, integration, experimentsAuthOptions);
    }
    experimentsResource
      .addResource('{experimentId}')
      .addResource('status')
      .addMethod('POST', integration, experimentsAuthOptions);

    this.experimentsApiUrl = `${api.url}admin/experiments`;

    new cdk.CfnOutput(this, 'ExperimentsApiUrl', {
      value: this.experimentsApiUrl,
      description: 'Experiments admin API URL (frontend Experiments tab — VITE_EXPERIMENTS_API_URL)',
      exportName: `${this.stackName}-ExperimentsApiUrl`,
    });
    new cdk.CfnOutput(this, 'ExperimentsTableName', {
      value: experimentsTable.tableName,
      description: 'DynamoDB table for A/B test experiments',
    });

    cdk.Tags.of(this).add('Component', 'Experiments');
  }
}
