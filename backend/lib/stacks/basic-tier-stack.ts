/**
 * BasicTierStack — independently-deployable stack for the BASIC agent tier.
 *
 * Per-tier ownership model (ADR-011).
 * Owns everything the basic-tier team controls end-to-end:
 *   - Text content guardrail (`agent-echelon-basic-guardrail`).
 *   - Async-processor Lambda + tier-scoped IAM (basic = Haiku only; supports
 *     lightweight multi-turn tasks — grounds the prompt + stamps task_id — but
 *     no /battle, no image gen, no generated-doc writes).
 *   - Per-tier Lex bot fulfilling into the SHARED router (router-agent-handler,
 *     TIER=basic). There is no separate basic handler — that was drift; retired.
 *   - Per-tier AppInstanceBot for the channel-side handle.
 *   - SSM publishers: `/agent-echelon/assistant/basic/processor-arn`,
 *     `/agent-echelon/assistant/basic/bot-arn`.
 *
 * Tier isolation boundary: the processor role's S3 IAM is scoped to
 * `context/basic/` only. S3 returns AccessDenied for any other prefix — the
 * tier boundary is IAM, not Lambda logic.
 *
 * Cross-stack inputs flow in via props from the composition root
 * (bin/backend.ts). No `Fn::importValue` between tiers; no shared TierStack
 * class. A basic-team change here does not review-couple Standard/Premium.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { createHash } from 'node:crypto';
import * as path from 'path';
import { AgentGuardrails } from '../constructs/bedrock-guardrails';
import { getModelCatalog, TierModelSelection } from '../config/model-strategy';
import {
  tierChannelScopedAllow,
  modelArnsForTier,
  resolveSharedSSM,
  adminErrorAlertWiring,
  abuseControlsWiring,
  tierBotArnKey,
  tierProcessorArnKey,
  auroraDriftWiring,
  AuroraDriftHookup,
  MessageAnalyticsWiring,
  wireMessageAnalytics,
  driftChannelCreateStatements,
  CHANNEL_FLOW_ARN_SSM_KEY,
  RES_PREFIX,
  SSM_ROOT,
} from './agent-tier-common';

export interface BasicTierStackProps extends cdk.StackProps {
  /** Shared Chime AppInstance ARN (from AgentEchelonChimeMessaging). */
  appInstanceArn: string;
  /** Shared attachments bucket holding context/basic/*.json (from AgentEchelonS3Storage). */
  attachmentsBucketName: string;
  attachmentsBucketArn: string;
  /** Tier model selection (basic-team picks `tierModelSelection.basic`). */
  tierModelSelection: TierModelSelection;
  /**
   * Aurora hookup for LIVE drift detection (conversation-level, all-tier,
   * on-by-default in Aurora mode — NOT premium-only). Present only in Aurora
   * mode; in Athena mode it's undefined and the basic handler wires no drift.
   */
  auroraDriftHookup?: AuroraDriftHookup;
  /**
   * Out-of-band per-message analytics table (Phase 1). Aurora mode only; when
   * absent the processor keeps full inline metadata (Athena mode unchanged).
   */
  messageAnalytics?: MessageAnalyticsWiring;
  /**
   * Admin conversation channel the async processor posts failures to (CH parity). The channel
   * flow emails the admin roster via the message's notify directive. Empty/undefined ⇒ error
   * alerting is log-only.
   */
  adminErrorAlertChannelArn?: string;
}

export class BasicTierStack extends cdk.Stack {
  public readonly asyncProcessorArn: string;
  public readonly appInstanceBotArn: string;

  constructor(scope: Construct, id: string, props: BasicTierStackProps) {
    super(scope, id, props);

    const tier = 'basic' as const;
    const modelCatalog = getModelCatalog(this.region, this.account);
    const tierModel = modelCatalog[props.tierModelSelection.basic];
    const tierModelArns = modelArnsForTier(tier, modelCatalog);

    // Shared platform contract (task tables + experiments). Basic now runs the shared
    // router (which creates tasks + resolves experiments) and gives lightweight task
    // support in its async processor, so it needs these too. Resolved at deploy time via
    // SSM (dynamic ref), NOT Fn::importValue — same decoupling standard/premium use.
    const shared = resolveSharedSSM(this);

    // Admin error-alert wiring (CH parity): env + grant for posting processor failures to the
    // admin conversation. Log-only when no alert channel is configured.
    const errAlert = adminErrorAlertWiring(this, props.appInstanceArn, props.adminErrorAlertChannelArn);
    // Abuse controls (SPEC-ABUSE-CONTROLS): dedup (processor) + spend budget (handler). Dedup is
    // active; budgets are opt-in via -c bedrock*HourlyBudget. Env spread on both; grant both roles.
    const abuse = abuseControlsWiring(this, shared.abuseControlsArn, shared.abuseControlsName, tier, this.region, this.account);

    // ── Tier content guardrail (text) ──────────────────────────────────────
    const guardrail = new AgentGuardrails(this, 'AssistantGuardrail', {
      name: `${RES_PREFIX}-${tier}-guardrail`,
    });

    // ── Async-processor execution role (the tier isolation boundary) ───────
    const processorRole = new iam.Role(this, 'ProcessorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        // SPEC-CONVERSATION-SECURITY Layer 1 (assistant-identity half), fail-closed:
        // the basic assistant may act ONLY on channels tagged classification ∈
        // {basic}. An untagged or higher-tier channel → no Allow → implicit deny.
        // (Title auto-derive reads + renames the channel via DescribeChannel/
        // UpdateChannel, also tier-gated.)
        ChimePolicy: new iam.PolicyDocument({
          statements: tierChannelScopedAllow(tier, props.appInstanceArn, [
            'chime:SendChannelMessage',
            'chime:ListChannelMessages',
            'chime:GetChannelMessage',
            'chime:UpdateChannelMessage',
            'chime:DescribeChannel',
            'chime:UpdateChannel',
          ], { bearerResources: [`${props.appInstanceArn}/bot/*`] }),
        }),
        BedrockPolicy: new iam.PolicyDocument({
          statements: [
            // Basic = buffered InvokeModel only (no streaming).
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel'],
              resources: tierModelArns,
            }),
            // Guardrail parity: the self-hosted tool loop applies
            // the tier guardrail out-of-band on its reply.
            new iam.PolicyStatement({
              actions: ['bedrock:ApplyGuardrail'],
              resources: [guardrail.guardrailArn],
            }),
          ],
        }),
        // Tier-scoped company-context read (ADR-011). Basic sees
        // ONLY `context/basic/*`; S3 returns AccessDenied for any other
        // prefix — this is the actual tier-isolation boundary.
        ContextS3Read: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:ListBucket'],
              resources: [props.attachmentsBucketArn],
              // platform-knowledge/* is the AgentEchelon self-knowledge (load_platform_info);
              // every tier may read it (it is not tier-scoped company data).
              conditions: { StringLike: { 's3:prefix': ['context/basic/*', 'platform-knowledge/*'] } },
            }),
            new iam.PolicyStatement({
              actions: ['s3:GetObject'],
              resources: [
                `${props.attachmentsBucketArn}/context/basic/*`,
                `${props.attachmentsBucketArn}/platform-knowledge/*`,
              ],
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Task tables: basic now supports lightweight tasks. The processor reads the task
    // (getTask) to ground the prompt and the shared core updates task status. No
    // /battle, generated-doc, or experiment grants — those stay standard/premium-only.
    processorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
        resources: [
          shared.agentTasksArn,
          `${shared.agentTasksArn}/index/*`,
          shared.userTasksArn,
          `${shared.userTasksArn}/index/*`,
        ],
      }),
    );
    // Admin error alert: post processor failures to the configured admin channel (no-op when unset).
    errAlert.grant(processorRole);
    // Abuse controls: the processor writes the dedup claim.
    abuse.grant(processorRole);

    // ── Async-processor Lambda (the assistant) ──────────────
    const asyncProcessor = new lambdaNodeJs.NodejsFunction(this, 'AsyncProcessor', {
      entry: path.join(__dirname, '../../lambda/src/basic-async-processor.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      reservedConcurrentExecutions: 100,
      role: processorRole,
      environment: {
        APP_INSTANCE_ARN: props.appInstanceArn,
        MODEL_ID: tierModel.bedrockModelId,
        MODEL_NAME: tierModel.displayName,
        AWS_ACCOUNT_ID: this.account,
        CONTEXT_BUCKET: props.attachmentsBucketName,
        GUARDRAIL_ID: guardrail.guardrailId,
        GUARDRAIL_VERSION: guardrail.guardrailVersion,
        // Lightweight task support: getTask reads TASKS_TABLE to ground the prompt; the
        // shared core updates task status. Both tables so the core's helpers never fail.
        TASKS_TABLE: shared.agentTasksName,
        USER_TASKS_TABLE: shared.userTasksName,
        ...errAlert.env,
        ...abuse.env,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    this.asyncProcessorArn = asyncProcessor.functionArn;
    // Phase 1: write the full analytics blob out-of-band + slim the Chime Metadata (Aurora mode).
    wireMessageAnalytics(asyncProcessor, props.messageAnalytics);

    new ssm.StringParameter(this, 'ProcessorArnParam', {
      parameterName: tierProcessorArnKey(tier),
      stringValue: asyncProcessor.functionArn,
      description: 'Async-processor ARN for basic tier',
    });

    // Per-deployment intent taxonomy — SAME plumbing as standard/premium so a custom
    // pack (-c assistantIntentPack) reaches basic too (consistent classification across
    // tiers). Lives in SSM (can exceed the 4 KB env cap); the router hydrates it at cold
    // start. Empty ⇒ no param ⇒ DEFAULT_INTENT_PACK, which already emits task intents by
    // keyword. Basic never had a legacy param, so there is no 2-step migration to worry
    // about; the RETAIN branch just creates a fresh param. Onboarding-intake param is
    // optional too (absent ⇒ static welcome).
    const intentPackJson = (this.node.tryGetContext('assistantIntentPack') as string) || '';
    const useParamWriter =
      this.node.tryGetContext('assistantParamWriter') === 'true' ||
      this.node.tryGetContext('assistantParamWriter') === true;
    const intentPackParamName = `${SSM_ROOT}/assistant/${tier}/assistant-intent-pack`;
    const intentPackParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${intentPackParamName}`;
    const onboardingIntakeParamName = `${SSM_ROOT}/assistant/${tier}/onboarding-intake`;
    const onboardingIntakeParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${onboardingIntakeParamName}`;
    if (intentPackJson.trim()) {
      if (useParamWriter) {
        new cr.AwsCustomResource(this, 'IntentPackParamWriter', {
          onUpdate: {
            service: 'SSM',
            action: 'putParameter',
            parameters: { Name: intentPackParamName, Value: intentPackJson, Type: 'String', Tier: 'Advanced', Overwrite: true },
            physicalResourceId: cr.PhysicalResourceId.of(
              `${intentPackParamName}@${createHash('sha256').update(intentPackJson).digest('hex').slice(0, 16)}`,
            ),
          },
          policy: cr.AwsCustomResourcePolicy.fromStatements([
            new iam.PolicyStatement({ actions: ['ssm:PutParameter'], resources: [intentPackParamArn] }),
          ]),
          installLatestAwsSdk: false,
        });
      } else {
        new ssm.StringParameter(this, 'IntentPackParam', {
          parameterName: intentPackParamName,
          stringValue: intentPackJson,
          description: 'Per-deployment assistant intent pack (JSON) — read by the router classifier',
          tier: ssm.ParameterTier.ADVANCED,
        }).applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
      }
    }

    // ── Per-tier agent handler (Lex fulfillment) ──────────────────────────
    // Full bot-layer isolation (ADR-011): the SHARED router (router-agent-handler.ts) is
    // deployed PER TIER. TIER=basic makes it skip channel-tier discovery (it IS the tier),
    // act as the basic bot, enforce min(senderTier, basic) via Cognito, resolve
    // experiments, create/continue tasks, and dispatch to THIS tier's async-processor.
    // Basic runs the SAME router as standard/premium — there is no separate basic handler
    // (that was drift; retired). Basic keeps keyword classification (cheap, no per-turn
    // Bedrock) and gets lightweight task support in its async processor.
    //
    // Live drift detection (SPEC-DRIFT-CONVERGENCE.md) is wired here in Aurora mode — drift
    // is conversation-level + ALL-tier + on-by-default, so basic runs the same shared flow
    // (lib/live-drift-flow.ts). VPC-attaches to Aurora pgvector + adds DB env + RDS/Titan IAM.
    const drift = props.auroraDriftHookup
      ? auroraDriftWiring(this, tier, props.auroraDriftHookup)
      : undefined;

    const handlerRole = new iam.Role(this, 'AgentHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        // The handler only READS channel tier metadata + member count; it does not send.
        // Tier-gated fail-closed + a bare tag read (which is how the served tier is learned).
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            ...tierChannelScopedAllow(tier, props.appInstanceArn, ['chime:DescribeChannel', 'chime:ListChannelMemberships'], { bearerResources: [`${props.appInstanceArn}/bot/*`] }),
            new iam.PolicyStatement({ actions: ['chime:ListTagsForResource'], resources: [`${props.appInstanceArn}/channel/*`] }),
          ],
        }),
        // Basic classifies by keyword (no Bedrock call), but grant the tier (Haiku) model
        // so any LLM-classify fallback path never AccessDenies.
        BedrockPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: tierModelArns }),
        ] }),
        SSMPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [
            `arn:aws:ssm:${this.region}:${this.account}:parameter${tierBotArnKey(tier)}`,
            intentPackParamArn,
            onboardingIntakeParamArn,
          ] }),
        ] }),
        // Tasks (createTask/getActiveTask) + experiments (resolveExperimentModel) — the
        // shared platform contract every tier's router uses.
        DynamoDBPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({
            actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan'],
            resources: [
              shared.agentTasksArn, `${shared.agentTasksArn}/index/*`,
              shared.userTasksArn, `${shared.userTasksArn}/index/*`,
              shared.experimentsArn, `${shared.experimentsArn}/index/*`,
            ],
          }),
        ] }),
        // resolveUserTier reads the sender's Cognito groups to enforce min(senderTier, basic).
        CognitoReadPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({ actions: ['cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser'], resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${shared.cognitoUserPoolId}`] }),
        ] }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    if (drift) {
      drift.grantTo(handlerRole);
      // The drift-confirm path creates a follow-up channel as the bot. Grant the
      // create-flow IAM (SendChannelMessage stays tag-gated) + channel-flow SSM read.
      for (const stmt of driftChannelCreateStatements(tier, props.appInstanceArn, this.region, this.account)) {
        handlerRole.addToPolicy(stmt);
      }
    }

    const agentHandler = new lambdaNodeJs.NodejsFunction(this, 'AgentHandler', {
      entry: path.join(__dirname, '../../lambda/src/router-agent-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: drift ? 1024 : 512,
      role: handlerRole,
      // NOT VPC-attached (project decision 018): invokes the data-plane Lambda for
      // retrieval + drift. No lambdaVpcProps.
      environment: {
        TIER: tier,
        ...(drift?.env ?? {}),
        ...(drift ? { CHANNEL_FLOW_ARN_PARAM: CHANNEL_FLOW_ARN_SSM_KEY } : {}),
        SSM_ROOT,
        ASSISTANT_INTENT_PACK_PARAM: intentPackParamName,
        ONBOARDING_INTAKE_PARAM: onboardingIntakeParamName,
        BOT_ARN_PARAM: tierBotArnKey(tier),
        BASIC_ASYNC_PROCESSOR_ARN: asyncProcessor.functionArn,
        APP_INSTANCE_ARN: props.appInstanceArn,
        AWS_ACCOUNT_ID: this.account,
        USER_POOL_ID: shared.cognitoUserPoolId,
        // Intent classification is a cheap, high-frequency call — always Haiku (never the
        // tier primary). Basic uses keyword classification so this is only a fallback, but
        // the router reads it unconditionally.
        CLASSIFIER_MODEL_ID: modelCatalog['haiku'].bedrockModelId,
        TASKS_TABLE: shared.agentTasksName,
        USER_TASKS_TABLE: shared.userTasksName,
        EXPERIMENTS_TABLE: shared.experimentsName,
        ...abuse.env,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    asyncProcessor.grantInvoke(agentHandler);
    // Abuse controls: the router (handler) runs the spend-budget check.
    abuse.grant(handlerRole);
    // Let the classifier read the intent-pack SSM param at cold start (only when a pack is set).
    agentHandler.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [intentPackParamArn, onboardingIntakeParamArn] }),
    );
    new lambda.CfnPermission(this, 'AgentHandlerLexInvoke', {
      action: 'lambda:InvokeFunction',
      functionName: agentHandler.functionName,
      principal: 'lexv2.amazonaws.com',
    });
    const handlerArn = agentHandler.functionArn;

    // ── Lex bot + AppInstanceBot (per tier) ────────────────────────────────
    const lexBotRole = new iam.Role(this, 'LexBotRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lexv2.amazonaws.com'),
        new iam.ServicePrincipal('chime.amazonaws.com'),
      ),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonLexRunBotsOnly')],
      inlinePolicies: {
        LambdaInvokePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['lambda:InvokeFunction'],
              resources: [handlerArn],
            }),
          ],
        }),
      },
    });

    const createLexBotRole = new iam.Role(this, 'CreateLexBotRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        LexBotPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'lex:CreateBot', 'lex:CreateBotLocale', 'lex:CreateIntent', 'lex:CreateSlotType',
                'lex:BuildBotLocale', 'lex:CreateBotVersion', 'lex:CreateBotAlias',
                'lex:DescribeBotLocale', 'lex:DeleteBot', 'lex:ListBots', 'lex:ListBotAliases',
                'lex:ListIntents', 'lex:ListBotLocales', 'lex:UpdateIntent', 'lex:UpdateBotAlias',
                // create-lex-bot.ts attaches a bot resource policy so Chime can
                // invoke the bot (CreateResourcePolicy, then UpdateResourcePolicy
                // on conflict). Required or fresh bot creation fails AccessDenied.
                'lex:CreateResourcePolicy', 'lex:UpdateResourcePolicy',
              ],
              resources: [`arn:aws:lex:${this.region}:${this.account}:*`],
            }),
            new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [lexBotRole.roleArn] }),
          ],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    const createLexBotFn = new lambdaNodeJs.NodejsFunction(this, 'CreateLexBotFunction', {
      entry: path.join(__dirname, '../../lambda/lex-bot/create-lex-bot.ts'),
      environment: {
        LEX_BOT_ROLE_ARN: lexBotRole.roleArn,
        AWS_ACCOUNT_ID: this.account,
        BOT_HANDLER_LAMBDA_ARN: handlerArn,
        APP_INSTANCE_ARN: props.appInstanceArn,
      },
      handler: 'handler',
      role: createLexBotRole,
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(10),
      bundling: { minify: false, forceDockerBundling: false },
    });

    const lexProvider = new cdk.custom_resources.Provider(this, 'CreateLexBotProvider', {
      onEventHandler: createLexBotFn,
    });
    const lexResource = new cdk.CustomResource(this, 'CreateLexBotResource', {
      serviceToken: lexProvider.serviceToken,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      properties: {
        tier,
        botName: `Assistant-${tier}`,
      },
    });
    const lexBotAliasArn = lexResource.getAtt('LexBotAliasArn').toString();

    const createBotRole = new iam.Role(this, 'CreateBotRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        CreateBotPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({ actions: ['chime:CreateAppInstanceBot'], resources: [props.appInstanceArn, `${props.appInstanceArn}/bot/*`] }),
          ],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    const createBotFn = new lambdaNodeJs.NodejsFunction(this, 'CreateBotFunction', {
      entry: path.join(__dirname, '../../lambda/lex-bot/create-bot.ts'),
      environment: {
        APP_INSTANCE_ARN: props.appInstanceArn,
        BOT_HANDLER_LAMBDA_ARN: handlerArn,
        LEX_BOT_ALIAS_ARN: lexBotAliasArn,
        BOT_NAME: `Assistant-${tier}`,
      },
      handler: 'handler',
      role: createBotRole,
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      bundling: { minify: false, forceDockerBundling: false },
    });

    const botProvider = new cdk.custom_resources.Provider(this, 'CreateBotProvider', {
      onEventHandler: createBotFn,
    });
    const botResource = new cdk.CustomResource(this, 'CreateBotResource', {
      serviceToken: botProvider.serviceToken,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    botResource.node.addDependency(lexResource);
    this.appInstanceBotArn = botResource.getAtt('AppInstanceBotArn').toString();

    new ssm.StringParameter(this, 'TierBotArnParam', {
      parameterName: tierBotArnKey(tier),
      stringValue: this.appInstanceBotArn,
      description: 'AppInstanceBot ARN for basic tier — read by create-conversation',
    });

    new cdk.CfnOutput(this, 'TierAsyncProcessorArn', { value: asyncProcessor.functionArn });
    new cdk.CfnOutput(this, 'TierAppInstanceBotArn', { value: this.appInstanceBotArn });

    cdk.Tags.of(this).add('Component', 'Tier-Basic');
    cdk.Tags.of(this).add('Tier', tier);
  }
}
