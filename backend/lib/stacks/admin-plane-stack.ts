import * as cdk from 'aws-cdk-lib';
import { apiAccessLogConfig } from '../constructs/api-access-logging';
import { adminApiMethodOptions, adminAuthEnv } from '../constructs/admin-auth-mode';
import { adminOrigin } from '../config/app-origins';
import { personaExecuteApiResources, type AdminPersona } from '../config/admin-capabilities';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import {
  STACK_PREFIX,
  ANALYTICS_PREFIX,
  ATHENA_WORKGROUP_NAME,
  ANALYTICS_DB_NAME,
  SHARED_SSM,
} from './agent-classification-common';

/**
 * AdminPlaneStack — the admin console's conversation READ plane (list, message content, membership
 * history over the archive).
 *
 * WHY A SEPARATE STACK (was in cognito-auth-stack): this is an admin-plane DATA api, not identity
 * infrastructure. It was parked in the IdP stack only because its auth wiring (the `admins` Identity-Pool
 * sign-on role + A14 persona roles + the userPool) lives there. Coupling an admin DATA feature to the
 * pluggable IdP layer is a layering violation (BUGS-ADMIN-CONSOLE D1): swap the IdP and this drags along.
 *
 * BREAKING THE CIRCULAR DEP: the Identity-Pool roles (created in cognito-auth) grant `execute-api:Invoke`
 * on THIS api's exact ARNs — a naive move (roles reference this api, this api references userPool/ceilings)
 * would be a stack cycle CDK rejects. Resolution mirrors the analytics stack's proven pattern: the roles
 * are CREATED in cognito-auth and IMPORTED here by ARN, and the conversation `execute-api` teeth are
 * attached HERE (one-directional: admin-plane → cognito-auth). The credential-exchange's view-messages
 * session-policy scoping stays in cognito-auth using a wildcard-api-id ARN string (exact method+path),
 * so it needs no reference back to this stack.
 */
export interface AdminPlaneStackProps extends cdk.StackProps {
  /** The Chime app-instance ARN (from ChimeMessagingStack). */
  appInstanceArn: string;
  /** The Cognito user pool (from CognitoAuthStack) — for the Cognito authorizer (non-IAM mode) and the
   *  handler's group/ceiling lookups. */
  userPool: cognito.IUserPool;
  /** Serialized role→classification-ceiling map (A14 Scoped) resolved from the caller's assumed role. */
  classificationRoleCeilings: string;
  /** The `admins` sign-on Identity-Pool role ARN — imported here to grant the view-conversations teeth. */
  adminSignOnRoleArn: string;
  /** A14 persona group → sign-on role ARN map — imported here to grant per-persona conversation teeth. */
  adminPersonaRoleArns?: Record<string, string>;
}

export class AdminPlaneStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AdminPlaneStackProps) {
    super(scope, id, props);

    const adminAppUrl = adminOrigin(this);

    // The read role: archive-backed viewing over Athena/Glue/S3 (mirrors the analytics-query grants). It
    // holds NO Chime bearer permissions — live-Chime actions run client-side as the admin's own
    // `${sub}-admin` identity (docs/SPEC-ADMIN-IDENTITY.md); this API is read-only over the archive.
    const adminConversationRole = new iam.Role(this, 'AdminConversationRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        AthenaQuery: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults'],
              resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/${ATHENA_WORKGROUP_NAME}`],
            }),
            new iam.PolicyStatement({
              actions: ['glue:GetTable', 'glue:GetPartitions', 'glue:GetDatabase'],
              resources: [
                `arn:aws:glue:${this.region}:${this.account}:catalog`,
                `arn:aws:glue:${this.region}:${this.account}:database/${ANALYTICS_DB_NAME}`,
                `arn:aws:glue:${this.region}:${this.account}:table/${ANALYTICS_DB_NAME}/*`,
              ],
            }),
            new iam.PolicyStatement({
              actions: ['s3:GetBucketLocation', 's3:GetObject', 's3:ListBucket', 's3:PutObject'],
              resources: [
                `arn:aws:s3:::${ANALYTICS_PREFIX}-conversation-archive-${this.account}-${this.region}`,
                `arn:aws:s3:::${ANALYTICS_PREFIX}-conversation-archive-${this.account}-${this.region}/*`,
              ],
            }),
            // Archive bucket is SSE-KMS on the analytics CMK (ARN not importable here); scope decrypt to
            // KMS-via-S3 — combined with the archive-bucket S3 statement, effectively archive-scoped.
            new iam.PolicyStatement({
              actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
              resources: ['*'],
              conditions: { StringEquals: { 'kms:ViaService': `s3.${this.region}.amazonaws.com` } },
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const adminConversationFn = new lambdaNodeJs.NodejsFunction(this, 'AdminConversationFunction', {
      entry: './lambda/src/admin-conversations.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(20),
      memorySize: 512,
      role: adminConversationRole,
      environment: {
        ...adminAuthEnv(this),
        APP_INSTANCE_ARN: props.appInstanceArn,
        CLASSIFICATION_ROLE_CEILINGS: props.classificationRoleCeilings,
        USER_POOL_ID: props.userPool.userPoolId,
        ATHENA_WORKGROUP: ATHENA_WORKGROUP_NAME,
        ATHENA_DATABASE: ANALYTICS_DB_NAME,
        ALLOWED_ORIGIN: adminAppUrl,
        // Aurora mode: resolve the data-plane Lambda ARN from SSM at cold start and read conversations
        // from Aurora instead of the slow Athena archive (BUG #21). Static param name (no cross-stack
        // dep); absent in Athena mode → the handler falls back to Athena.
        AURORA_DATA_PLANE_ARN_PARAM: SHARED_SSM.auroraDataPlaneArn,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    adminConversationFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SHARED_SSM.auroraDataPlaneArn}`],
      }),
    );
    // Resolve the caller's classification ceiling from their Cognito groups (read-only, this pool).
    adminConversationFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminListGroupsForUser'],
        resources: [props.userPool.userPoolArn],
      }),
    );
    adminConversationFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${STACK_PREFIX}AnalyticsAuror*DataPlaneLambda*`],
      }),
    );

    const adminConversationApi = new apigateway.RestApi(this, 'AdminConversationApi', {
      restApiName: 'Agent Echelon Admin Conversations',
      defaultCorsPreflightOptions: {
        allowOrigins: [adminAppUrl],
        allowMethods: ['GET', 'OPTIONS'],
        // Under A14 IAM enforcement the console SIGNS these GETs (SigV4): the conversation LIST +
        // membership-history with its sign-on Identity-Pool creds, and the message read with an
        // exchange-vended execute-api cred. The browser preflight must allow the X-Amz-* signing headers,
        // not just Authorization/Content-Type — without them the signed request is CORS-blocked
        // (net::ERR_FAILED → "Failed to fetch"), breaking the Conversations tab and "View conversation".
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Amz-Security-Token', 'X-Amz-Content-Sha256'],
      },
      deployOptions: {
        throttlingBurstLimit: 20,
        throttlingRateLimit: 10,
        ...apiAccessLogConfig(this, 'AdminConversationApiAccessLogs'),
      },
    });

    // A14: optionally IAM-authorize the archive endpoints. Default OFF (Cognito JWT authorizer). When
    // `-c adminIamEnforcement=true` the routes require SigV4 (the console signs them); the coordinated
    // frontend signing lands with the same flag.
    const adminIamEnforcement = this.node.tryGetContext('adminIamEnforcement') === true
      || this.node.tryGetContext('adminIamEnforcement') === 'true';
    const archiveAuthOptions: apigateway.MethodOptions = adminIamEnforcement
      ? { authorizationType: apigateway.AuthorizationType.IAM }
      : adminApiMethodOptions(this, 'AdminConversationAuthorizer', { userPool: props.userPool });
    // Tell the handler the archive methods are IAM-authorized so it trusts the gateway-vetted signed
    // principal (which already proved it holds the archive capability) instead of a Cognito JWT.
    if (adminIamEnforcement) {
      adminConversationFn.addEnvironment('ADMIN_IAM_ENFORCEMENT', 'true');
    }

    const adminConversationIntegration = new apigateway.LambdaIntegration(adminConversationFn);
    const adminRoot = adminConversationApi.root.addResource('admin');
    const conversationsResource = adminRoot.addResource('conversations');
    conversationsResource.addMethod('GET', adminConversationIntegration, archiveAuthOptions);
    conversationsResource.addResource('messages').addMethod('GET', adminConversationIntegration, archiveAuthOptions);
    conversationsResource.addResource('membership-history').addMethod('GET', adminConversationIntegration, archiveAuthOptions);

    // A14 sign-on-role plane (view-conversations): the `admins` sign-on role — created in cognito-auth,
    // imported here — carries execute-api:Invoke on the conversation-list + membership-history resources,
    // so a console signing with its sign-on creds is allowed at the gateway while a finer role that omits
    // the statement is denied. view-messages (A2) is NOT here — it is exchange-vended (in cognito-auth).
    const importedSignOnRole = iam.Role.fromRoleArn(this, 'ImportedAdminSignOnRole', props.adminSignOnRoleArn, { mutable: true });
    for (const p of ['/admin/conversations', '/admin/conversations/membership-history']) {
      importedSignOnRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['execute-api:Invoke'],
        resources: [adminConversationApi.arnForExecuteApi('GET', p)],
      }));
    }

    // A14 personas: each persona sign-on role (created in cognito-auth) gets execute-api teeth for EXACTLY
    // its admin-conversations capability set — same cross-stack teeth pattern the analytics stack uses.
    if (adminIamEnforcement && props.adminPersonaRoleArns) {
      for (const [persona, roleArn] of Object.entries(props.adminPersonaRoleArns)) {
        const resources = personaExecuteApiResources(persona as AdminPersona, 'admin-conversations')
          .map((r) => adminConversationApi.arnForExecuteApi(r.method, r.path));
        if (resources.length === 0) continue;
        iam.Role.fromRoleArn(this, `ImportedPersonaRole-${persona}`, roleArn, { mutable: true })
          .addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['execute-api:Invoke'], resources }));
      }
    }

    new cdk.CfnOutput(this, 'AdminConversationApiUrl', {
      value: `${adminConversationApi.url}admin/conversations`,
      description: 'Admin conversation API URL',
      exportName: `${this.stackName}-AdminConversationApiUrl`,
    });
  }
}
