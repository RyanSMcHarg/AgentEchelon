/**
 * PremiumTierStack — independently-deployable stack for the PREMIUM agent tier.
 *
 * Per-tier ownership model (ADR-011).
 * Owns everything the premium-tier team controls end-to-end:
 *   - Text content guardrail (`agent-echelon-premium-guardrail`).
 *   - Image-output guardrail (`agent-echelon-premium-battle-image-guardrail`)
 *     for /battle generation-out (premium-exclusive).
 *   - Async-processor Lambda + tier-scoped IAM (premium = Opus by default;
 *     streams via InvokeModelWithResponseStream; supports multi-turn tasks,
 *     /battle round participation including image-gen, generated docs).
 *   - Per-tier Lex bot (WelcomeIntent + FallbackIntent → shared router).
 *   - Per-tier AppInstanceBot for the channel-side handle.
 *   - SSM publishers: `/agent-echelon/tier/premium/processor-arn`,
 *     `/agent-echelon/tier/premium/bot-arn`.
 *
 * Tier isolation boundary: the processor role's S3 IAM is scoped to
 * `context/basic/` + `context/standard/` + `context/premium/`. Premium
 * inherits everything below it. Boundary is IAM, not Lambda logic.
 *
 * Premium reads the SHARED platform contract (tasks tables, /battle state,
 * experiments) via `valueForStringParameter` at deploy time — an SSM dynamic
 * ref, NOT Fn::importValue. A premium-team change here does not
 * review-couple Basic or Standard.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';
import { AgentGuardrails } from '../constructs/bedrock-guardrails';
import { BattleImageGuardrails } from '../constructs/battle-image-guardrails';
import { getModelCatalog, TierModelSelection } from '../config/model-strategy';
import {
  tierChannelScopedAllow,
  modelArnsForTier,
  resolveSharedSSM,
  adminErrorAlertWiring,
  abuseControlsWiring,
  resolveBattleSSM,
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

export interface PremiumTierStackProps extends cdk.StackProps {
  /** Shared Chime AppInstance ARN (from AgentEchelonChimeMessaging). */
  appInstanceArn: string;
  /** Shared attachments bucket holding context/{basic,standard,premium}/*.json
   *  (from AgentEchelonS3Storage), plus the attachments/ and battle-images/ prefixes
   *  premium reads + writes during /battle vision-in and generation-out. */
  attachmentsBucketName: string;
  attachmentsBucketArn: string;
  /** Tier model selection (premium-team picks `tierModelSelection.premium`). */
  tierModelSelection: TierModelSelection;
  /**
   * Wire /battle plumbing (battle-state/config table grants + env + orchestrator
   * invoke), resolving the battle SSM contract AgentEchelonBattle publishes. False
   * when /battle is not deployed (`enableBattle=false`) — the processor then
   * carries no battle plumbing and fails open. The premium image-gen guardrail +
   * IAM are premium-exclusive and remain unconditional (harmless when unused).
   */
  enableBattle?: boolean;
  /**
   * Aurora hookup for LIVE drift detection (conversation-level, all-tier,
   * on-by-default). Present only in Aurora mode; when set, the agent handler is
   * VPC-attached to Aurora pgvector + granted RDS-IAM + Titan-embedding access.
   */
  auroraDriftHookup?: AuroraDriftHookup;
  /** Out-of-band per-message analytics table (Phase 1). Aurora mode only. */
  messageAnalytics?: MessageAnalyticsWiring;
  /** Admin conversation channel the async processor posts failures to (CH parity); the channel
   *  flow emails its roster via the notify directive. Empty/undefined ⇒ error alerting is log-only. */
  adminErrorAlertChannelArn?: string;
}

export class PremiumTierStack extends cdk.Stack {
  public readonly asyncProcessorArn: string;
  public readonly appInstanceBotArn: string;

  constructor(scope: Construct, id: string, props: PremiumTierStackProps) {
    super(scope, id, props);

    const tier = 'premium' as const;
    const modelCatalog = getModelCatalog(this.region, this.account);
    const tierModel = modelCatalog[props.tierModelSelection.premium];
    const tierModelArns = modelArnsForTier(tier, modelCatalog);

    const shared = resolveSharedSSM(this);
    // Admin error-alert wiring (CH parity): env + grant for posting processor failures to the
    // admin conversation. Log-only when no alert channel is configured.
    const errAlert = adminErrorAlertWiring(this, props.appInstanceArn, props.adminErrorAlertChannelArn);
    // Abuse controls (SPEC-ABUSE-CONTROLS): dedup (processor) + spend budget (handler). Dedup
    // active; budgets opt-in via -c bedrock*HourlyBudget. Env spread on both; grant both roles.
    const abuse = abuseControlsWiring(this, shared.abuseControlsArn, shared.abuseControlsName, tier, this.region, this.account);
    // /battle plumbing — only resolved when /battle is deployed (AgentEchelonBattle is
    // opt-in; resolving its SSM unconditionally would fail the deploy when off).
    const battle = props.enableBattle ? resolveBattleSSM(this) : undefined;

    // ── Tier content guardrail (text) ──────────────────────────────────────
    const guardrail = new AgentGuardrails(this, 'AssistantGuardrail', {
      name: `${RES_PREFIX}-${tier}-guardrail`,
    });

    // ── Image-output guardrail (premium-only, for /battle generation-out) ──
    // Tier-scoped name so it stays unique per tier (guardrail names are
    // account-unique).
    const imageGuardrail = new BattleImageGuardrails(this, 'BattleImageGuardrails', {
      name: `${RES_PREFIX}-${tier}-battle-image-guardrail`,
    });

    // ── Async-processor execution role (the tier isolation boundary) ───────
    const processorRole = new iam.Role(this, 'ProcessorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        // SPEC-CONVERSATION-SECURITY Layer 1 (assistant-identity half), fail-closed:
        // premium may act on channels tagged classification ∈ {basic, standard,
        // premium}. Premium is the top tier so it's not cross-tier-restricted, but
        // it's still fail-closed: an UNTAGGED / unknown-tag channel → no Allow →
        // implicit deny (so a tagging gap never silently grants access).
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
            // Premium streams the model (long-form deliverables) as well as
            // the buffered Converse path.
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
              resources: tierModelArns,
            }),
            new iam.PolicyStatement({
              actions: ['bedrock:ApplyGuardrail'],
              resources: [guardrail.guardrailArn],
            }),
          ],
        }),
        SSMPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter'],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${tierBotArnKey(tier)}`],
            }),
          ],
        }),
        // Tier-scoped company-context: basic + standard + premium prefixes.
        ContextS3Read: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:ListBucket'],
              resources: [props.attachmentsBucketArn],
              conditions: {
                StringLike: {
                  // platform-knowledge/* (load_platform_info) is readable by every tier.
                  's3:prefix': ['context/basic/*', 'context/standard/*', 'context/premium/*', 'platform-knowledge/*'],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ['s3:GetObject'],
              resources: [
                `${props.attachmentsBucketArn}/context/basic/*`,
                `${props.attachmentsBucketArn}/context/standard/*`,
                `${props.attachmentsBucketArn}/context/premium/*`,
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

    // Shared tables + generated-doc writes + battle-orchestrator invoke.
    processorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
          'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:BatchWriteItem',
          'dynamodb:BatchGetItem',
        ],
        resources: [
          shared.agentTasksArn,
          `${shared.agentTasksArn}/index/*`,
          shared.userTasksArn,
          `${shared.userTasksArn}/index/*`,
          shared.experimentsArn,
          ...(battle ? [battle.battleStateArn] : []),
        ],
      }),
    );
    processorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Scan'],
        resources: [shared.experimentsArn],
      }),
    );
    processorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [`${props.attachmentsBucketArn}/generated-docs/*`],
      }),
    );
    // Admin error alert: post processor failures to the configured admin channel (no-op when unset).
    errAlert.grant(processorRole);
    // Abuse controls: the processor writes the dedup claim.
    abuse.grant(processorRole);
    if (battle) {
      processorRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [battle.battleOrchestratorArn],
        }),
      );
    }

    // Premium-only: /battle image generation-out (Titan Image + Nova Canvas)
    // plus the image-output guardrail, plus vision-in (read user-uploaded image)
    // and generation-out (write + read the generated PNG).
    processorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/amazon.titan-image-generator-v2:0',
          'arn:aws:bedrock:*::foundation-model/amazon.nova-canvas-v1:0',
        ],
      }),
    );
    processorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:ApplyGuardrail'],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:guardrail/${imageGuardrail.guardrailId}`,
        ],
      }),
    );
    processorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`${props.attachmentsBucketArn}/attachments/*`],
      }),
    );
    processorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:GetObject'],
        resources: [`${props.attachmentsBucketArn}/battle-images/*`],
      }),
    );

    // ── Async-processor Lambda (the assistant) ──────────────
    const processorEnv: Record<string, string> = {
      APP_INSTANCE_ARN: props.appInstanceArn,
      BOT_ARN_PARAM: tierBotArnKey(tier),
      MODEL_ID: tierModel.bedrockModelId,
      MODEL_NAME: tierModel.displayName,
      AWS_ACCOUNT_ID: this.account,
      CONTEXT_BUCKET: props.attachmentsBucketName,
      GUARDRAIL_ID: guardrail.guardrailId,
      GUARDRAIL_VERSION: guardrail.guardrailVersion,
      TASKS_TABLE: shared.agentTasksName,
      USER_TASKS_TABLE: shared.userTasksName,
      EXPERIMENTS_TABLE: shared.experimentsName,
      ATTACHMENTS_BUCKET: props.attachmentsBucketName,
      ...errAlert.env,
      ...abuse.env,
      BATTLE_IMAGE_GUARDRAIL_ID: imageGuardrail.guardrailId,
      BATTLE_IMAGE_GUARDRAIL_VERSION: imageGuardrail.guardrailVersion,
      ...(battle
        ? {
            BATTLE_STATE_TABLE: battle.battleStateName,
            CHANNEL_BATTLE_CONFIG_TABLE: battle.channelBattleConfigName,
            BATTLE_ORCHESTRATOR_ARN: battle.battleOrchestratorArn,
          }
        : {}),
    };
    // Optional deployer cost caps — only LOWER the registry hard caps.
    const maxImages = this.node.tryGetContext('battleImageMaxImages');
    const maxDimension = this.node.tryGetContext('battleImageMaxDimension');
    if (maxImages != null) processorEnv.BATTLE_IMAGE_MAX_IMAGES = String(maxImages);
    if (maxDimension != null) processorEnv.BATTLE_IMAGE_MAX_DIMENSION = String(maxDimension);

    // External-HTTP image-gen providers (OpenAI / FAL) for /battle
    // generation-out. PREFERRED: keys live in a Secrets Manager secret
    // (a JSON object keyed by env-var name, e.g. {FAL_KEY, OPENAI_API_KEY});
    // the processor fetches + caches them at runtime (image-gen-models.ts
    // hydrateImageGenKeysFromSecret) so nothing sensitive sits in the
    // Lambda config and keys rotate without a redeploy. Provide the secret
    // ARN via `-c imageGenKeysSecretArn=...` or IMAGE_GEN_KEYS_SECRET_ARN.
    const igKeysSecretArn =
      (this.node.tryGetContext('imageGenKeysSecretArn') as string | undefined) ||
      process.env.IMAGE_GEN_KEYS_SECRET_ARN;
    if (igKeysSecretArn) {
      const igKeysSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        'ImageGenKeysSecret',
        igKeysSecretArn,
      );
      igKeysSecret.grantRead(processorRole);
      processorEnv.IMAGE_GEN_KEYS_SECRET_ARN = igKeysSecretArn;
    }
    // Fallback: a deployer who prefers plain env vars can still export the
    // key at deploy time (the Secrets Manager path above takes precedence;
    // a real env var here wins over the secret in hydration). Absent BOTH ⇒
    // the registry models that need a key return an actionable error naming
    // the variable. AWS-native Bedrock image models need neither key.
    if (process.env.OPENAI_API_KEY) processorEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (process.env.FAL_KEY) processorEnv.FAL_KEY = process.env.FAL_KEY;

    // Optional cross-region image-gen: the AWS-native Stability base
    // generators (stable-image-core/ultra) are offered in us-west-2, not
    // us-east-1. A us-east-1 deployment can still use them by pointing the
    // image-gen Bedrock client at us-west-2. Absent ⇒ image-gen uses the
    // Lambda's own region. External-HTTP providers ignore this.
    const igRegion = this.node.tryGetContext('imageGenRegion') as string | undefined;
    if (igRegion) processorEnv.IMAGE_GEN_REGION = igRegion;

    const asyncProcessor = new lambdaNodeJs.NodejsFunction(this, 'AsyncProcessor', {
      entry: path.join(__dirname, '../../lambda/src/premium-async-processor.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(90),
      memorySize: 1024,
      reservedConcurrentExecutions: 20,
      role: processorRole,
      environment: processorEnv,
      bundling: { minify: false, forceDockerBundling: false },
    });
    this.asyncProcessorArn = asyncProcessor.functionArn;
    // Phase 1: write the full analytics blob out-of-band + slim the Chime Metadata (Aurora mode).
    wireMessageAnalytics(asyncProcessor, props.messageAnalytics);

    new ssm.StringParameter(this, 'ProcessorArnParam', {
      parameterName: tierProcessorArnKey(tier),
      stringValue: asyncProcessor.functionArn,
      description: 'Async-processor ARN for premium tier',
    });

    // ── Per-tier agent handler (Lex fulfillment) ──────────────────────────
    // Full bot-layer isolation (ADR-011): the router code deployed PER TIER
    // (TIER=premium). Acts as the premium bot, enforces min(senderTier,
    // premium), resolves experiments, dispatches to THIS tier's processor. Live
    // drift (Aurora pgvector) is wired separately in Aurora mode; not here.
    // Optional onboarding-intake schema (opt-in welcome). The router reads this
    // SSM param at cold start; absent/empty ⇒ onboarding is disabled and the
    // static welcome is used (the default). A deployment enables the multi-step
    // intake by writing the JSON schema here (no redeploy — takes effect on the
    // next cold start). See docs/GUIDE-ASSISTANT-CONTEXT.md "Welcome patterns".
    const onboardingIntakeParamName = `${SSM_ROOT}/tier/${tier}/onboarding-intake`;
    const onboardingIntakeParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${onboardingIntakeParamName}`;

    const handlerRole = new iam.Role(this, 'AgentHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        // The handler only reads channel tier metadata + member count
        // (DescribeChannel / ListChannelMemberships); it does NOT send. Tier-gated
        // fail-closed, with no send/update actions — least privilege.
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            ...tierChannelScopedAllow(tier, props.appInstanceArn, ['chime:DescribeChannel', 'chime:ListChannelMemberships'], { bearerResources: [`${props.appInstanceArn}/bot/*`] }),
            // Read the immutable `classification` tag to resolve the served tier when
            // running as a single-handler multi-tier dispatcher (STATIC_TIER unset).
            // A tag-READ cannot itself be tier-gated (it is how the tier is learned),
            // so it is an ungated channel read — read-only, discloses only the tag.
            new iam.PolicyStatement({ actions: ['chime:ListTagsForResource'], resources: [`${props.appInstanceArn}/channel/*`] }),
          ],
        }),
        BedrockPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: tierModelArns }),
        ] }),
        SSMPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${tierBotArnKey(tier)}`, onboardingIntakeParamArn] }),
        ] }),
        DynamoDBPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({
            actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan'],
            resources: [shared.agentTasksArn, `${shared.agentTasksArn}/index/*`, shared.userTasksArn, `${shared.userTasksArn}/index/*`, shared.experimentsArn, ...(battle ? [battle.battleStateArn, `arn:aws:dynamodb:${this.region}:${this.account}:table/${battle.channelBattleConfigName}`] : [])],
          }),
        ] }),
        CognitoReadPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({ actions: ['cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser'], resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${shared.cognitoUserPoolId}`] }),
        ] }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    // Live drift detection (SPEC-DRIFT-CONVERGENCE.md) — only in Aurora mode.
    // VPC-attaches this handler to Aurora pgvector + adds DB env + RDS/Titan IAM.
    // On-by-default (the env sets ENABLE_LIVE_DRIFT='true'); same wiring for
    // every tier.
    const drift = props.auroraDriftHookup
      ? auroraDriftWiring(this, tier, props.auroraDriftHookup)
      : undefined;
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
      // Handler is NOT VPC-attached (project decision 018): it invokes the
      // data-plane Lambda for retrieval + drift. No lambdaVpcProps.
      environment: {
        TIER: tier,
        ...(drift?.env ?? {}),
        // Channel-flow ARN param for the drift-confirm create path (only read
        // when drift is wired; harmless string otherwise).
        ...(drift ? { CHANNEL_FLOW_ARN_PARAM: CHANNEL_FLOW_ARN_SSM_KEY } : {}),
        SSM_ROOT,
        // Opt-in onboarding intake schema source (empty/absent ⇒ static welcome).
        ONBOARDING_INTAKE_PARAM: onboardingIntakeParamName,
        BOT_ARN_PARAM: tierBotArnKey(tier),
        PREMIUM_ASYNC_PROCESSOR_ARN: asyncProcessor.functionArn,
        APP_INSTANCE_ARN: props.appInstanceArn,
        AWS_ACCOUNT_ID: this.account,
        USER_POOL_ID: shared.cognitoUserPoolId,
        // Intent classification is a cheap, high-frequency call — always Haiku
        // (on-demand-capable), never the tier's primary. Using the tier model
        // here would invoke Opus by bare on-demand id, which Bedrock rejects
        // ("...with on-demand throughput isn't supported; use an inference
        // profile"), silently degrading every classification to 'general' and
        // downgrading premium answers to Haiku.
        CLASSIFIER_MODEL_ID: modelCatalog['haiku'].bedrockModelId,
        TASKS_TABLE: shared.agentTasksName,
        USER_TASKS_TABLE: shared.userTasksName,
        EXPERIMENTS_TABLE: shared.experimentsName,
        ...abuse.env,
        ...(battle
          ? {
              BATTLE_STATE_TABLE: battle.battleStateName,
              CHANNEL_BATTLE_CONFIG_TABLE: battle.channelBattleConfigName,
            }
          : {}),
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    asyncProcessor.grantInvoke(agentHandler);
    // Abuse controls: the router (handler) runs the spend-budget check.
    abuse.grant(handlerRole);
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
      description: 'AppInstanceBot ARN for premium tier — read by create-conversation',
    });

    new cdk.CfnOutput(this, 'TierAsyncProcessorArn', { value: asyncProcessor.functionArn });
    new cdk.CfnOutput(this, 'TierAppInstanceBotArn', { value: this.appInstanceBotArn });

    cdk.Tags.of(this).add('Component', 'Tier-Premium');
    cdk.Tags.of(this).add('Tier', tier);
  }
}
