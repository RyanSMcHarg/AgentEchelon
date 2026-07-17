import * as cdk from 'aws-cdk-lib';
import { apiAccessLogConfig } from '../constructs/api-access-logging';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { SSM_ROOT, SHARED_SSM, CHANNEL_FLOW_ARN_SSM_KEY, INSTANCE_SSM } from './agent-tier-common';
import { getConversationTypeConfig, DEFAULT_CONVERSATION_TYPE } from '../config/conversation-types';

export interface FoundationsStackProps extends cdk.StackProps {
  appInstanceArn: string;
  /** User Pool ID for the create-conversation tier gate. */
  userPoolId: string;
}

/**
 * FoundationsStack (`AgentEchelonFoundations`) — the always-on shared data/control
 * plane the rest of the platform is built on. Owns the task-tracking tables
 * (`agent-tasks` + `user-tasks`) + the create-conversation / add-agent API, and
 * publishes their shared SSM contract. It hosts no bot — it's the foundation the
 * feature stacks build on: /battle in AgentEchelonBattle, the per-tier assistants
 * in AgentEchelonTier-*, and experiments in AgentEchelonExperiments.
 */
export class FoundationsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FoundationsStackProps) {
    super(scope, id, props);

    // Per-tier company-context S3 scoping + per-tier model selection live in the
    // AgentEchelonTier-* stacks alongside the processors (ADR-011).

    // Every tier owns its own Lex + AppInstanceBot + router (AgentEchelonTier-*),
    // /battle owns its alt-slot Lex (AgentEchelonBattle), and experiments live in
    // AgentEchelonExperiments — so there is no shared Lex/AppInstanceBot/router here.

    // ============================================================
    // DynamoDB Tables for Task Tracking
    // ============================================================

    const isProduction = this.node.tryGetContext('environment') === 'production';
    const dataRemovalPolicy = isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    const agentTasksTable = new dynamodb.Table(this, 'AgentTasksTable', {
      partitionKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'channelArn', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: dataRemovalPolicy,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    // Work-item tasks: per-context (plan) lookup for cascade-cancel + (later) the per-plan digest.
    // SPARSE — only work-item tasks carry `contextId`, so enterprise tasks aren't indexed. Cross-user
    // by design (a co-participant's task must cancel when the owner drops the item), which a user-tasks
    // index can't do; the plan's tasks all share `contextId`.
    agentTasksTable.addGlobalSecondaryIndex({
      indexName: 'contextId-index',
      partitionKey: { name: 'contextId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const userTasksTable = new dynamodb.Table(this, 'UserTasksTable', {
      partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: dataRemovalPolicy,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    userTasksTable.addGlobalSecondaryIndex({
      indexName: 'userSub-taskType-index',
      partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'taskType', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Abuse-controls control plane (docs/specs/analytics-eval/SPEC-ABUSE-CONTROLS.md). One
    // generic pk+ttl table backs request dedup (`dedup#<corr>`), spend budgets
    // (`budget#user#…`, `budget#global#…`), and later rate limits. Every entry is short-lived
    // (minutes to two hours) and self-expires via DynamoDB TTL, so the table never accumulates.
    const abuseControlsTable = new dynamodb.Table(this, 'AbuseControlsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: dataRemovalPolicy,
    });

    // The /battle DynamoDB tables live in AgentEchelonBattle; the experiments table +
    // admin-experiments API live in AgentEchelonExperiments (experiments-stack.ts).

    // The Alt-Bot Slot Pool + Battle Orchestrator (SPEC-BATTLE.md) live in the
    // opt-in AgentEchelonBattle stack (battle-stack.ts). The alt-slots there run on a
    // battle-OWNED Lex, so this stack needs no shared Lex/router.

    // ============================================================
    // Shared SSM contract for the per-tier stacks (SPEC-PER-TIER-OWNERSHIP.md).
    // AgentEchelonTier-{Standard,Premium} resolve these at DEPLOY time via
    // valueForStringParameter (an SSM dynamic ref, NOT Fn::importValue), so a
    // tier deploys decoupled from this stack while still pointing at the shared
    // TASK tables. The experiments SSM keys are published by AgentEchelonExperiments
    // and the /battle SSM keys by the opt-in AgentEchelonBattle stack.
    // ============================================================
    const sharedParams: Array<[string, string, string]> = [
      ['SharedAgentTasksArnParam', SHARED_SSM.agentTasksArn, agentTasksTable.tableArn],
      ['SharedAgentTasksNameParam', SHARED_SSM.agentTasksName, agentTasksTable.tableName],
      ['SharedUserTasksArnParam', SHARED_SSM.userTasksArn, userTasksTable.tableArn],
      ['SharedUserTasksNameParam', SHARED_SSM.userTasksName, userTasksTable.tableName],
      ['SharedAbuseControlsArnParam', SHARED_SSM.abuseControlsArn, abuseControlsTable.tableArn],
      ['SharedAbuseControlsNameParam', SHARED_SSM.abuseControlsName, abuseControlsTable.tableName],
      // NOTE: cognito pool id is published by AgentEchelonCognitoAuth (not here) to
      // avoid a deploy-order cycle with the router-export removal — see
      // cognito-auth-stack.ts.
    ];
    for (const [paramId, parameterName, stringValue] of sharedParams) {
      new ssm.StringParameter(this, paramId, { parameterName, stringValue });
    }

    // ============================================================
    // API Gateway (unchanged — add-agent + create-conversation)
    // ============================================================

    const addBotRole = new iam.Role(this, 'AddBotToChannelRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // DescribeChannelMembership verifies the caller is a member of the
              // target channel before adding the bot. ListTagsForResource reads the
              // channel's enforced tier from the IMMUTABLE `classification` tag (not
              // mutable metadata) so we bind THAT tier's assistant and a moderator
              // cannot tamper metadata to attract a higher-tier bot. DescribeChannel
              // remains for the membership/name reads.
              actions: [
                'chime:CreateChannelMembership',
                'chime:DescribeChannelMembership',
                'chime:DescribeChannel',
                'chime:ListTagsForResource',
              ],
              resources: [`${props.appInstanceArn}/*`],
              effect: iam.Effect.ALLOW,
            }),
          ],
        }),
        SSMPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter'],
              // Per-tier AppInstanceBot ARNs published by the AgentEchelonTier-*
              // stacks; add-agent binds the channel's own-tier assistant. No
              // shared cross-tier bot.
              resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/tier/*/bot-arn`,
              ],
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const addBotFunction = new lambda.Function(this, 'AddBotToChannelFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/add-agent-to-conversation'),
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        SSM_ROOT,
        // Needed for the C3 membership check — Lambda composes the
        // caller's AppInstanceUser ARN from JWT sub + this prefix.
        APP_INSTANCE_ARN: props.appInstanceArn,
      },
      role: addBotRole,
    });

    const appUrl = this.node.tryGetContext('appUrl') || 'http://localhost:5173';

    // Cognito authorizer for the conversation-management endpoints. Both
    // /add-agent and /create-conversation require a valid session, so no
    // anonymous caller can create channels, impersonate a userArn (taken from
    // the request body), or burn Bedrock spend via the welcome generator. Shared
    // by both endpoints below.
    const conversationApiUserPool = cognito.UserPool.fromUserPoolId(
      this,
      'ImportedUserPoolForConversationApi',
      props.userPoolId,
    );
    const conversationApiAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      'ConversationApiAuthorizer',
      { cognitoUserPools: [conversationApiUserPool] },
    );

    const api = new apigateway.RestApi(this, 'AddBotApi', {
      restApiName: 'AI Agent Conversation API',
      description: 'API for managing conversations with AI agent',
      defaultCorsPreflightOptions: {
        allowOrigins: [appUrl],
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      deployOptions: {
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
        // Access logging.
        ...apiAccessLogConfig(this, 'AddBotApiAccessLogs'),
      },
    });

    const addAgentIntegration = new apigateway.LambdaIntegration(addBotFunction);
    api.root.addResource('add-agent').addMethod('POST', addAgentIntegration, {
      authorizer: conversationApiAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    const channelFlowArnParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${CHANNEL_FLOW_ARN_SSM_KEY}`;
    const userPoolArn = `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.userPoolId}`;

    const createChannelRole = new iam.Role(this, 'CreateChannelRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'chime:CreateChannel',
                'chime:CreateChannelMembership',
                'chime:CreateChannelModerator',
                'chime:AssociateChannelFlow',
                // Federated create-conversation re-stamps host context into channel Metadata on
                // an existing (deterministic) channel — needs UpdateChannel.
                'chime:UpdateChannel',
                // Contextual welcome: when the caller passes a topic,
                // the create-conversation lambda posts a Haiku-derived
                // welcome as a real bot message via SendChannelMessage.
                'chime:SendChannelMessage',
                // SPEC-CONVERSATION-SECURITY Layer 1: tag every channel
                // `classification=<tier>` at creation. CreateChannel with Tags
                // requires chime:TagResource on the new channel resource.
                'chime:TagResource',
                // Conversation archive (SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP):
                // create-conversation stamps a 90-day channel expiration at creation,
                // which requires chime:PutChannelExpirationSettings on the new channel.
                'chime:PutChannelExpirationSettings',
              ],
              resources: [`${props.appInstanceArn}/*`],
              effect: iam.Effect.ALLOW,
            }),
          ],
        }),
        // Haiku 3 is the cheapest available model and is universally
        // tier-permitted; we use it both for the contextual welcome
        // (topic-seeded creates) and as a fallback.
        BedrockPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel'],
              resources: [
                `arn:aws:bedrock:*::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
              ],
            }),
          ],
        }),
        SSMPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter'],
              resources: [
                channelFlowArnParamArn,
                // Per-tier AppInstanceBot ARNs published by the AgentEchelonTier-*
                // stacks; create-conversation adds the right tier bot to a new
                // channel. No shared cross-tier bot — a missing per-tier key
                // is an error, not a silent fallback.
                `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/tier/*/bot-arn`,
              ],
            }),
          ],
        }),
        // Tier gate reads the creator's tier from the validated `cognito:groups` JWT
        // claim (see create-conversation/index.js), so no cognito-idp:AdminListGroupsForUser
        // grant is needed here.
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // The default conversation type's retention TTL, surfaced to the standalone
    // create-conversation handler as env vars (it cannot import this TS config).
    const defaultExpiration = getConversationTypeConfig(DEFAULT_CONVERSATION_TYPE).expiration;
    const defaultExpirationEnv: Record<string, string> = defaultExpiration
      ? {
          DEFAULT_EXPIRATION_DAYS: String(defaultExpiration.days),
          DEFAULT_EXPIRATION_CRITERION: defaultExpiration.criterion,
        }
      : {};

    const createChannelFunction = new lambda.Function(this, 'CreateChannelFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/create-conversation'),
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        SSM_ROOT,
        CHANNEL_FLOW_ARN_PARAM: CHANNEL_FLOW_ARN_SSM_KEY,
        APP_INSTANCE_ARN: props.appInstanceArn,
        USER_POOL_ID: props.userPoolId,
        // Deployment-wide default channel TTL, sourced from the conversation-type
        // `expiration` (all shipped types are 90-day LAST_MESSAGE_TIMESTAMP). The
        // standalone create-conversation asset can't import the CDK-side config, so
        // it reads these env vars and applies them when a request sends no override.
        ...defaultExpirationEnv,
      },
      role: createChannelRole,
    });

    const createConversationIntegration = new apigateway.LambdaIntegration(createChannelFunction);
    const createConversationResource = api.root.addResource('create-conversation');
    createConversationResource.addMethod('POST', createConversationIntegration, {
      authorizer: conversationApiAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // ============================================================
    // Conversation management — moderator archive / member removal / self-leave
    // (SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md, ADR-017). One Cognito-JWT
    // Lambda that authorizes per operation (live ChannelModerator check) then
    // acts as the app-instance-admin bearer. The `archived` tag it sets is what
    // the Phase-2 IAM read-only Deny keys on.
    // ============================================================

    // Durable audit trail for archive / remove / leave (actor, op, target, channel).
    // A small dedicated table (spec "Audit" — the lighter of the two options); keeps
    // this feature self-contained rather than coupling to the analytics store.
    const conversationActionsTable = new dynamodb.Table(this, 'ConversationActionsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: dataRemovalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const conversationMgmtRole = new iam.Role(this, 'ConversationManagementRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // Acting as the app-instance-admin bearer: read the live moderator
              // list (authorization), post the archive system message, set the
              // `archived` tag, drop moderators, and remove memberships. This is the
              // admin plane — deliberately NOT archived-tag-gated, so the system
              // message still posts to an archived channel.
              actions: [
                'chime:ListChannelModerators',
                'chime:DeleteChannelModerator',
                'chime:DeleteChannelMembership',
                'chime:SendChannelMessage',
                'chime:TagResource',
                // Archive also mirrors `archived:true` into channel Metadata as a
                // NON-authoritative display hint (DescribeChannel to preserve, then
                // UpdateChannel). The tag stays the IAM authority.
                'chime:DescribeChannel',
                'chime:UpdateChannel',
              ],
              resources: [`${props.appInstanceArn}/*`],
              effect: iam.Effect.ALLOW,
            }),
          ],
        }),
        SSMPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // The app-instance-admin ARN used as ChimeBearer (published by CognitoAuth).
              actions: ['ssm:GetParameter'],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${INSTANCE_SSM.appInstanceAdminArn}`],
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    conversationActionsTable.grantWriteData(conversationMgmtRole);

    const conversationMgmtFn = new lambdaNodeJs.NodejsFunction(this, 'ConversationManagementFunction', {
      entry: './lambda/src/conversation-management.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      role: conversationMgmtRole,
      environment: {
        APP_INSTANCE_ARN: props.appInstanceArn,
        ADMIN_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn,
        AUDIT_TABLE: conversationActionsTable.tableName,
        ALLOWED_ORIGIN: appUrl,
      },
      bundling: { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] },
    });

    const conversationMgmtIntegration = new apigateway.LambdaIntegration(conversationMgmtFn);
    const conversationsResource = api.root.addResource('conversations');
    for (const action of ['archive', 'remove-member', 'leave']) {
      conversationsResource.addResource(action).addMethod('POST', conversationMgmtIntegration, {
        authorizer: conversationApiAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });
    }

    // CORS headers on gateway error responses (4XX/5XX) so a Lambda error or a
    // 403/401 still carries Access-Control-Allow-Origin — otherwise the browser
    // reports a backend error as a misleading CORS failure (the BUG #21/#23 lesson).
    for (const [id, type] of [
      ['Default4xxCors', apigateway.ResponseType.DEFAULT_4XX],
      ['Default5xxCors', apigateway.ResponseType.DEFAULT_5XX],
    ] as const) {
      new apigateway.GatewayResponse(this, id, {
        restApi: api,
        type,
        responseHeaders: {
          'Access-Control-Allow-Origin': `'${appUrl}'`,
          'Access-Control-Allow-Headers': "'Content-Type,Authorization'",
        },
      });
    }

    // --- Federated create-conversation (host app's OWN Cognito pool) — opt-in ---
    // POST /create-conversation/federated, authorized by the host pool, creates-or-gets
    // a {contextType, contextId}-bound channel and adds the host user (as the disjoint
    // `fed_` AppInstanceUser the federated credential exchange vends) as member+moderator.
    // Reuses createChannelRole. Enable with `-c federatedUserPoolId=us-east-1_xxx`.
    const federatedHostPoolId = this.node.tryGetContext('federatedUserPoolId') as string | undefined;
    if (federatedHostPoolId) {
      const federatedHostPool = cognito.UserPool.fromUserPoolId(this, 'FederatedHostPoolForCreateConv', federatedHostPoolId);
      const federatedConvAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'FederatedCreateConvAuthorizer', {
        cognitoUserPools: [federatedHostPool],
      });
      const federatedCreateConvFn = new lambdaNodeJs.NodejsFunction(this, 'FederatedCreateConversationFunction', {
        entry: './lambda/src/federated-create-conversation.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        role: createChannelRole, // reuse: CreateChannel/Membership/Moderator/AssociateFlow + SSM bot lookup
        environment: {
          SSM_ROOT,
          APP_INSTANCE_ARN: props.appInstanceArn,
          CHANNEL_FLOW_ARN_PARAM: CHANNEL_FLOW_ARN_SSM_KEY,
          ASSISTANT_CLASSIFICATION: (this.node.tryGetContext('assistantTier') as string) || 'basic',
          ALLOWED_ORIGIN: '*',
        },
        bundling: { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] },
      });
      createConversationResource.addResource('federated').addMethod(
        'POST',
        new apigateway.LambdaIntegration(federatedCreateConvFn),
        { authorizer: federatedConvAuthorizer, authorizationType: apigateway.AuthorizationType.COGNITO },
      );
      new cdk.CfnOutput(this, 'FederatedCreateConversationApiUrl', {
        value: `${api.url}create-conversation/federated`,
        description: 'Federated create-conversation (host-pool token → context-bound channel)',
      });
    }

    // --- Federated sharing: add/remove a THIRD-PARTY member across IdPs ---
    // System reconcile invoked DIRECTLY by the host backend (lambda:InvokeFunction) after its
    // own ACL check — IAM (the host's invoke permission) is the authorization boundary, so
    // conversation membership is always a projection of the host's ACL. No public route, no
    // end-user token, no shared secret, no bare-channel-membership trust. Adds the target as a
    // DEFAULT member (never a moderator) + greets; remove evicts. Gated on the federated-integration
    // toggle. The host references these Lambdas by the ARNs output below (the same AE-output →
    // host-config flow as the federated create-conversation URL).
    if (federatedHostPoolId) {
      const shareMemberRole = new iam.Role(this, 'FederatedShareMemberRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        inlinePolicies: {
          ChimePolicy: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                  'chime:CreateChannel',
                  'chime:CreateChannelMembership',
                  'chime:DeleteChannelMembership', // revoke ⇒ evict
                  'chime:AssociateChannelFlow',
                  'chime:UpdateChannel',
                  'chime:SendChannelMessage', // join announce + targeted greeting
                  'chime:TagResource',
                ],
                resources: [`${props.appInstanceArn}/*`],
              }),
            ],
          }),
          SSMPolicy: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ['ssm:GetParameter'],
                resources: [
                  channelFlowArnParamArn,
                  `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/tier/*/bot-arn`,
                ],
              }),
            ],
          }),
        },
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        ],
      });

      const shareEnv = {
        SSM_ROOT,
        APP_INSTANCE_ARN: props.appInstanceArn,
        CHANNEL_FLOW_ARN_PARAM: CHANNEL_FLOW_ARN_SSM_KEY,
        ASSISTANT_CLASSIFICATION: (this.node.tryGetContext('assistantTier') as string) || 'basic',
      };
      const shareBundling = { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] };

      const addMemberFn = new lambdaNodeJs.NodejsFunction(this, 'FederatedAddMemberFunction', {
        entry: './lambda/src/federated-add-member.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        role: shareMemberRole,
        environment: shareEnv,
        bundling: shareBundling,
      });
      const removeMemberFn = new lambdaNodeJs.NodejsFunction(this, 'FederatedRemoveMemberFunction', {
        entry: './lambda/src/federated-remove-member.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        role: shareMemberRole,
        environment: shareEnv,
        bundling: shareBundling,
      });

      // No API route: these are invoked directly by the host backend, which is granted
      // lambda:InvokeFunction on these ARNs (host side). Output the ARNs for the host config.
      new cdk.CfnOutput(this, 'FederatedAddMemberFunctionArn', {
        value: addMemberFn.functionArn,
        description: 'Host direct-invoke add-member — set as addMemberFnArn in the host config',
      });
      new cdk.CfnOutput(this, 'FederatedRemoveMemberFunctionArn', {
        value: removeMemberFn.functionArn,
        description: 'Host direct-invoke remove-member — set as removeMemberFnArn in the host config',
      });
    }

    // ============================================================
    // Outputs
    // ============================================================

    new cdk.CfnOutput(this, 'AgentTasksTableName', {
      value: agentTasksTable.tableName,
      description: 'DynamoDB table for agent tasks',
    });

    new cdk.CfnOutput(this, 'UserTasksTableName', {
      value: userTasksTable.tableName,
      description: 'DynamoDB table for user tasks',
    });

    new cdk.CfnOutput(this, 'AddAgentApiUrl', {
      value: `${api.url}add-agent`,
      description: 'API Gateway URL for adding AI agent to conversations',
      exportName: `${this.stackName}-AddAgentApiUrl`,
    });

    new cdk.CfnOutput(this, 'CreateConversationApiUrl', {
      value: `${api.url}create-conversation`,
      description: 'API Gateway URL for creating conversations with AI agent',
      exportName: `${this.stackName}-CreateConversationApiUrl`,
    });

    cdk.Tags.of(this).add('Component', 'Foundations');
  }
}
