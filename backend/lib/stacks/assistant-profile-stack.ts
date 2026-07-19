/**
 * AssistantProfileStack — the ONE parametrized, independently-deployable stack for an assistant
 * profile (SPEC-CAPABILITY-PROFILES). It replaces the former per-tier {basic,standard,premium}-tier
 * stacks, which were ~1787 lines of near-duplicated topology diverging only in capability.
 *
 * A `ProfileTopology` descriptor makes the divergence DATA, not three code copies:
 *   - model selection, Lambda sizing (timeout/memory/concurrency), response ceiling;
 *   - `contextRouting` (external/CN model path + secret), `systemPromptParam` (persona SSM),
 *     `intentPackParam` (custom intent taxonomy), `richProcessor` (multi-turn tasks + docs +
 *     experiments + attachment-in), `imageGen` (/battle image generation-out + image guardrail),
 *     `streaming`, `battleCapable`.
 * Each profile's thin stack (basic/standard/premium-tier-stack.ts) supplies its topology; the shared
 * body here is authored once. Construct ids match the legacy per-tier stacks, so a fresh deploy mints
 * the same logical resources.
 *
 * Per-profile ownership (was ADR-011's per-tier stack): a profile team now owns its topology
 * descriptor (its thin stack file), and the shared body is reviewed platform-side. Tier isolation is
 * unchanged — the processor role's S3 IAM is scoped to `context/{classifications-at-or-below}/`, the
 * boundary is IAM, not Lambda logic. Shared platform contract (tasks tables, experiments, /battle
 * state) still resolves via SSM dynamic refs (NOT Fn::importValue), so profiles deploy decoupled.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { createHash } from 'node:crypto';
import * as path from 'path';
import { AgentGuardrails } from '../constructs/bedrock-guardrails';
import { BattleImageGuardrails } from '../constructs/battle-image-guardrails';
import { getModelCatalog, ProfileModelSelection } from '../config/model-strategy';
import { defaultProfileRegistry } from '../profile-registry';
import {
  classificationChannelScopedAllow,
  classificationsAllowedFor,
  modelArnsForClassification,
  resolveSharedSSM,
  adminErrorAlertWiring,
  abuseControlsWiring,
  resolveBattleSSM,
  tierBotArnKey,
  tierProcessorArnKey,
  Tier,
  auroraDriftWiring,
  AuroraDriftHookup,
  MessageAnalyticsWiring,
  wireMessageAnalytics,
  driftChannelCreateStatements,
  CHANNEL_FLOW_ARN_SSM_KEY,
  RES_PREFIX,
  SSM_ROOT,
} from './agent-tier-common';

/** The per-profile capability shape that drives the shared body. */
export interface ProfileTopology {
  /** Profile name = classification value = SSM segment (basic/standard/premium). */
  name: string;
  /** Key into ProfileModelSelection for this profile's default model. */
  modelSelectionKey: keyof ProfileModelSelection;
  /** async-processor Lambda sizing. */
  timeoutSeconds: number;
  memorySize: number;
  reservedConcurrency: number;
  /** MAX_TOKENS env — the profile's response ceiling. */
  maxTokens: number;
  /** Premium: also grant InvokeModelWithResponseStream (long-form streaming). */
  streaming: boolean;
  /** Premium: /battle image generation-out — image guardrail, Titan/Nova invoke, battle-images S3,
   *  image-gen provider secrets, and the processor's default-bot SSM read. */
  imageGen: boolean;
  /** Standard: external/CN model routing — DeepSeek secret + CN Bedrock model grants + env. */
  contextRouting: boolean;
  /** Standard: per-deployment persona in SSM (ASSISTANT_SYSTEM_PROMPT_PARAM) + empty-config warning. */
  systemPromptParam: boolean;
  /** Basic + Standard: per-deployment intent taxonomy in SSM (the classifier hydrates it). */
  intentPackParam: boolean;
  /** Standard + Premium: multi-turn tasks (fuller DynamoDB), experiments, generated-doc writes,
   *  attachment-in read, and (when /battle is on) the battle-state grant + orchestrator invoke. */
  richProcessor: boolean;
  /** Standard + Premium: /battle round participation is wire-able (opt-in via props.enableBattle). */
  battleCapable: boolean;
  /** Basic only: the handler role also grants Query on the experiments GSI (experiments/index/*).
   *  Preserved verbatim from the per-tier stacks; standard/premium query experiments by primary key. */
  handlerExperimentsIndex: boolean;
  /** CloudFormation Component tag value (e.g. 'Tier-Basic'). */
  componentTag: string;
}

export interface AssistantProfileStackProps extends cdk.StackProps {
  /** The profile this stack instance serves. */
  topology: ProfileTopology;
  /** Shared Chime AppInstance ARN (from AgentEchelonChimeMessaging). */
  appInstanceArn: string;
  /** Shared attachments bucket holding context/{classification}/*.json (from AgentEchelonS3Storage). */
  attachmentsBucketName: string;
  attachmentsBucketArn: string;
  /** Model selection (the profile team picks profileModelSelection[topology.modelSelectionKey]). */
  profileModelSelection: ProfileModelSelection;
  /** Wire /battle plumbing (only meaningful when topology.battleCapable). False ⇒ no battle plumbing. */
  enableBattle?: boolean;
  /** Aurora hookup for LIVE drift (conversation-level, all-profile, on-by-default in Aurora mode). */
  auroraDriftHookup?: AuroraDriftHookup;
  /** Out-of-band per-message analytics table (Aurora mode only). */
  messageAnalytics?: MessageAnalyticsWiring;
  /** Admin conversation channel the async processor posts failures to; empty ⇒ error alerting log-only. */
  adminErrorAlertChannelArn?: string;
}

export class AssistantProfileStack extends cdk.Stack {
  public readonly asyncProcessorArn: string;
  public readonly appInstanceBotArn: string;

  constructor(scope: Construct, id: string, props: AssistantProfileStackProps) {
    super(scope, id, props);

    const topo = props.topology;
    // The agent-tier-common helpers are typed to the built-in Tier union. The default profiles ARE
    // that union; a deployment-defined profile name would widen this (a follow-up when custom
    // profiles ship). Cast keeps the shared boundary helpers strongly typed for the shipped set.
    const tier = topo.name as Tier;
    const modelCatalog = getModelCatalog(this.region, this.account);
    const profileModel = modelCatalog[props.profileModelSelection[topo.modelSelectionKey]];

    // External/CN model routing (SPEC-CONTEXT-AWARE-MODEL-ROUTING). In-AWS DeepSeek-on-Bedrock,
    // intent-routed (reasoning → R1 inference profile, rest → V3). Active only at runtime when
    // ENABLE_CONTEXT_ROUTING is on. Empty chat model ⇒ no env, no IAM.
    let cnChatModel = '';
    let cnReasoningModel = '';
    let cnReasoningIntents = '';
    let cnBedrockArns: string[] = [];
    if (topo.contextRouting) {
      cnChatModel = (this.node.tryGetContext('cnBedrockChatModel') as string) ?? 'deepseek.v3.2';
      cnReasoningModel = (this.node.tryGetContext('cnBedrockReasoningModel') as string) ?? 'us.deepseek.r1-v1:0';
      cnReasoningIntents =
        (this.node.tryGetContext('cnBedrockReasoningIntents') as string) ?? 'report_generation,data_extraction,guided_troubleshooting';
      cnBedrockArns = cnChatModel
        ? [
            `arn:aws:bedrock:${this.region}::foundation-model/${cnChatModel}`,
            `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${cnReasoningModel}`,
            ...['us-east-1', 'us-east-2', 'us-west-2'].map(
              (r) => `arn:aws:bedrock:${r}::foundation-model/${cnReasoningModel.replace(/^us\./, '')}`,
            ),
          ]
        : [];
    }
    const classificationModelArns = [...modelArnsForClassification(tier, modelCatalog), ...cnBedrockArns];

    const shared = resolveSharedSSM(this);
    const errAlert = adminErrorAlertWiring(this, props.appInstanceArn, props.adminErrorAlertChannelArn);
    const abuse = abuseControlsWiring(this, shared.abuseControlsArn, shared.abuseControlsName, tier, this.region, this.account);
    // /battle plumbing — only resolved when the profile is battle-capable AND /battle is deployed.
    const battle = topo.battleCapable && props.enableBattle ? resolveBattleSSM(this) : undefined;

    // ── Content guardrail (text) ────────────────────────────────────────────
    const guardrail = new AgentGuardrails(this, 'AssistantGuardrail', {
      name: `${RES_PREFIX}-${tier}-guardrail`,
    });
    // ── Image-output guardrail (imageGen profiles only, for /battle generation-out) ──
    const imageGuardrail = topo.imageGen
      ? new BattleImageGuardrails(this, 'BattleImageGuardrails', { name: `${RES_PREFIX}-${tier}-battle-image-guardrail` })
      : undefined;

    // ── Async-processor execution role (the profile isolation boundary) ─────
    const processorRole = new iam.Role(this, 'ProcessorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        // SPEC-CONVERSATION-SECURITY Layer 1 (assistant-identity half), fail-closed: the assistant may
        // act ONLY on channels tagged classification ∈ {this profile's rank and below}. Untagged / a
        // higher classification → no Allow → implicit deny (a tagging gap never silently grants access).
        ChimePolicy: new iam.PolicyDocument({
          statements: classificationChannelScopedAllow(tier, props.appInstanceArn, [
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
            new iam.PolicyStatement({
              // Streaming profiles add InvokeModelWithResponseStream (long-form deliverables).
              actions: topo.streaming
                ? ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']
                : ['bedrock:InvokeModel'],
              resources: classificationModelArns,
            }),
            new iam.PolicyStatement({
              actions: ['bedrock:ApplyGuardrail'],
              resources: [guardrail.guardrailArn],
            }),
          ],
        }),
        // Tier-scoped company-context read (ADR-011): ONLY context/{classifications-at-or-below}/* +
        // the platform-knowledge/* self-knowledge (readable by every profile). S3 AccessDenies any
        // other prefix — this is the actual isolation boundary.
        ContextS3Read: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:ListBucket'],
              resources: [props.attachmentsBucketArn],
              conditions: { StringLike: { 's3:prefix': [...classificationsAllowedFor(tier).map((c) => `context/${c}/*`), 'platform-knowledge/*'] } },
            }),
            new iam.PolicyStatement({
              actions: ['s3:GetObject'],
              resources: [
                ...classificationsAllowedFor(tier).map((c) => `${props.attachmentsBucketArn}/context/${c}/*`),
                `${props.attachmentsBucketArn}/platform-knowledge/*`,
              ],
            }),
          ],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    if (topo.richProcessor) {
      // Multi-turn tasks + /battle state + experiments + generated-doc writes + attachment-in read.
      processorRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
            'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:BatchWriteItem', 'dynamodb:BatchGetItem',
          ],
          resources: [
            shared.agentTasksArn, `${shared.agentTasksArn}/index/*`,
            shared.userTasksArn, `${shared.userTasksArn}/index/*`,
            shared.experimentsArn,
            ...(battle ? [battle.battleStateArn] : []),
          ],
        }),
      );
      processorRole.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:Scan'], resources: [shared.experimentsArn] }));
      processorRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [`${props.attachmentsBucketArn}/generated-docs/*`] }));
      // Attachment-in: read the user-uploaded file the current turn references so the processor can
      // attach a Converse image/document block (same grant across rich profiles).
      processorRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [`${props.attachmentsBucketArn}/attachments/*`] }));
    } else {
      // Lightweight task support only: getTask grounds the prompt; the shared core updates status.
      processorRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
          resources: [
            shared.agentTasksArn, `${shared.agentTasksArn}/index/*`,
            shared.userTasksArn, `${shared.userTasksArn}/index/*`,
          ],
        }),
      );
    }
    errAlert.grant(processorRole);
    abuse.grant(processorRole);
    if (topo.richProcessor && battle) {
      processorRole.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [battle.battleOrchestratorArn] }));
    }

    // Image-gen profiles: /battle generation-out (Titan Image + Nova Canvas) + image-output guardrail
    // + the default-bot SSM read (loadDefaultBotArn) + battle-images read/write.
    let igKeysSecretArn: string | undefined;
    if (topo.imageGen) {
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
          resources: [`arn:aws:bedrock:${this.region}:${this.account}:guardrail/${imageGuardrail!.guardrailId}`],
        }),
      );
      processorRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [`${props.attachmentsBucketArn}/attachments/*`] }));
      processorRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject', 's3:GetObject'], resources: [`${props.attachmentsBucketArn}/battle-images/*`] }));
      // Default-bot ARN read (battle default-bot resolution).
      processorRole.addToPolicy(
        new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${tierBotArnKey(tier)}`] }),
      );
    }

    // ── External (CN) provider secret (contextRouting profiles) ──────────────
    let deepseekSecret: secretsmanager.Secret | undefined;
    let externalConsentDefault = 'true';
    if (topo.contextRouting) {
      deepseekSecret = new secretsmanager.Secret(this, 'DeepseekApiKey', {
        description: 'DeepSeek API key for the Chinese-LLM routing path. Set the value out-of-band: aws secretsmanager put-secret-value --secret-id <arn> --secret-string <key>',
      });
      const consentCtx = this.node.tryGetContext('externalConsentDefault');
      externalConsentDefault = consentCtx === undefined ? 'true' : String(consentCtx);
    }
    const enableContextRouting =
      this.node.tryGetContext('enableContextRouting') === 'true' ||
      this.node.tryGetContext('enableContextRouting') === true;

    // ── Persona (systemPromptParam profiles): per-deployment persona in SSM ──
    const useParamWriter =
      this.node.tryGetContext('assistantParamWriter') === 'true' ||
      this.node.tryGetContext('assistantParamWriter') === true;
    const systemPromptParamName = `${SSM_ROOT}/assistant/${tier}/assistant-system-prompt`;
    const systemPromptParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${systemPromptParamName}`;
    if (topo.systemPromptParam) {
      // CONFIG GUARD: an empty persona silently falls back to the generic default (off-brand). Warn
      // loudly at synth rather than let it be discovered via a bad conversation.
      const systemPromptValue = (this.node.tryGetContext('assistantSystemPrompt') as string) || '';
      if (!systemPromptValue.trim()) {
        cdk.Annotations.of(this).addWarning(
          `[${tier}] assistantSystemPrompt is EMPTY - the assistant will use the generic default persona ` +
          `(off-brand, no host grounding). Pass -c assistantSystemPrompt to set a persona.`,
        );
      }
      // Preserve-on-absent (docs/decisions/012): the writer PutParameters only when non-empty and never
      // deletes; the content hash in the physicalId busts drift. 2-step RETAIN migration gated on
      // -c assistantParamWriter (see the history in git; moot on a fresh deploy).
      if (systemPromptValue.trim()) {
        if (useParamWriter) {
          new cr.AwsCustomResource(this, 'SystemPromptParamWriter', {
            onUpdate: {
              service: 'SSM',
              action: 'putParameter',
              parameters: { Name: systemPromptParamName, Value: systemPromptValue, Type: 'String', Tier: 'Advanced', Overwrite: true },
              physicalResourceId: cr.PhysicalResourceId.of(
                `${systemPromptParamName}@${createHash('sha256').update(systemPromptValue).digest('hex').slice(0, 16)}`,
              ),
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
              new iam.PolicyStatement({ actions: ['ssm:PutParameter'], resources: [systemPromptParamArn] }),
            ]),
            installLatestAwsSdk: false,
          });
        } else {
          new ssm.StringParameter(this, 'SystemPromptParam', {
            parameterName: systemPromptParamName,
            stringValue: systemPromptValue,
            description: 'Per-deployment assistant persona (system prompt) — read by the AsyncProcessor',
            tier: ssm.ParameterTier.ADVANCED,
          }).applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
        }
      }
    }

    // ── Async-processor Lambda (the assistant) ───────────────────────────────
    const processorEnv: Record<string, string> = {
      APP_INSTANCE_ARN: props.appInstanceArn,
      // SPEC-CAPABILITY-PROFILES: PROFILE_NAME selects the persona default + model-strategy key;
      // BATTLE_ELIGIBLE (from profile.battleEligible) gates the /battle code paths; MAX_TOKENS is the
      // profile's response ceiling. Capabilities self-gate on the env below, which is set only when
      // the matching IAM is granted — so the profile's execution stays within its role.
      PROFILE_NAME: tier,
      BATTLE_ELIGIBLE: String(defaultProfileRegistry.profileFor(tier).battleEligible ?? false),
      MAX_TOKENS: String(topo.maxTokens),
      MODEL_ID: profileModel.bedrockModelId,
      MODEL_NAME: profileModel.displayName,
      AWS_ACCOUNT_ID: this.account,
      CONTEXT_BUCKET: props.attachmentsBucketName,
      GUARDRAIL_ID: guardrail.guardrailId,
      GUARDRAIL_VERSION: guardrail.guardrailVersion,
      TASKS_TABLE: shared.agentTasksName,
      USER_TASKS_TABLE: shared.userTasksName,
      ...errAlert.env,
      ...abuse.env,
    };
    if (topo.richProcessor) {
      processorEnv.EXPERIMENTS_TABLE = shared.experimentsName;
      processorEnv.ATTACHMENTS_BUCKET = props.attachmentsBucketName;
    }
    if (topo.systemPromptParam) {
      // Always reference the param by NAME (it may exist from a preserved prior deploy even if THIS
      // deploy didn't set it); the processor falls back to its default when the param is absent.
      processorEnv.ASSISTANT_SYSTEM_PROMPT_PARAM = systemPromptParamName;
    }
    if (topo.contextRouting) {
      processorEnv.ENABLE_CONTEXT_ROUTING = enableContextRouting ? 'true' : 'false';
      processorEnv.EXTERNAL_MODEL_CONSENT_DEFAULT = externalConsentDefault;
      if (cnChatModel) {
        processorEnv.CN_BEDROCK_CHAT_MODEL = cnChatModel;
        processorEnv.CN_BEDROCK_REASONING_MODEL = cnReasoningModel;
        processorEnv.CN_BEDROCK_REASONING_INTENTS = cnReasoningIntents;
      }
      processorEnv.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
      processorEnv.DEEPSEEK_MODEL = (this.node.tryGetContext('deepseekModel') as string) || 'deepseek-chat';
      processorEnv.DEEPSEEK_API_KEY_SECRET = deepseekSecret!.secretArn;
    }
    if (topo.imageGen) {
      processorEnv.BOT_ARN_PARAM = tierBotArnKey(tier);
      processorEnv.BATTLE_IMAGE_GUARDRAIL_ID = imageGuardrail!.guardrailId;
      processorEnv.BATTLE_IMAGE_GUARDRAIL_VERSION = imageGuardrail!.guardrailVersion;
      const maxImages = this.node.tryGetContext('battleImageMaxImages');
      const maxDimension = this.node.tryGetContext('battleImageMaxDimension');
      if (maxImages != null) processorEnv.BATTLE_IMAGE_MAX_IMAGES = String(maxImages);
      if (maxDimension != null) processorEnv.BATTLE_IMAGE_MAX_DIMENSION = String(maxDimension);
      const igRegion = this.node.tryGetContext('imageGenRegion') as string | undefined;
      if (igRegion) processorEnv.IMAGE_GEN_REGION = igRegion;
    }
    if (battle) {
      processorEnv.BATTLE_STATE_TABLE = battle.battleStateName;
      processorEnv.CHANNEL_BATTLE_CONFIG_TABLE = battle.channelBattleConfigName;
      processorEnv.BATTLE_ORCHESTRATOR_ARN = battle.battleOrchestratorArn;
    }

    const asyncProcessor = new lambdaNodeJs.NodejsFunction(this, 'AsyncProcessor', {
      entry: path.join(__dirname, '../../lambda/src/assistant-async-processor.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(topo.timeoutSeconds),
      memorySize: topo.memorySize,
      reservedConcurrentExecutions: topo.reservedConcurrency,
      role: processorRole,
      environment: processorEnv,
      bundling: { minify: false, forceDockerBundling: false },
    });
    this.asyncProcessorArn = asyncProcessor.functionArn;
    wireMessageAnalytics(asyncProcessor, props.messageAnalytics);

    if (topo.contextRouting) {
      // Least-privilege: this one secret.
      deepseekSecret!.grantRead(asyncProcessor);
      new cdk.CfnOutput(this, 'DeepseekSecretArn', {
        value: deepseekSecret!.secretArn,
        description: 'Put the DeepSeek API key here (aws secretsmanager put-secret-value), then deploy with -c enableContextRouting=true.',
      });
    }
    if (topo.systemPromptParam) {
      // Read the persona from SSM at cold start (always — the param may exist from a preserved prior deploy).
      asyncProcessor.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [systemPromptParamArn] }));
    }
    if (topo.imageGen) {
      // External-HTTP image-gen provider keys (OpenAI / FAL) — PREFERRED: a Secrets Manager secret the
      // processor fetches + caches at runtime, so nothing sensitive sits in the Lambda config.
      igKeysSecretArn =
        (this.node.tryGetContext('imageGenKeysSecretArn') as string | undefined) || process.env.IMAGE_GEN_KEYS_SECRET_ARN;
      if (igKeysSecretArn) {
        const igKeysSecret = secretsmanager.Secret.fromSecretCompleteArn(this, 'ImageGenKeysSecret', igKeysSecretArn);
        igKeysSecret.grantRead(processorRole);
        asyncProcessor.addEnvironment('IMAGE_GEN_KEYS_SECRET_ARN', igKeysSecretArn);
      }
      // Fallback: a deployer who prefers plain env vars can export the key at deploy time.
      if (process.env.OPENAI_API_KEY) asyncProcessor.addEnvironment('OPENAI_API_KEY', process.env.OPENAI_API_KEY);
      if (process.env.FAL_KEY) asyncProcessor.addEnvironment('FAL_KEY', process.env.FAL_KEY);
    }

    new ssm.StringParameter(this, 'ProcessorArnParam', {
      parameterName: tierProcessorArnKey(tier),
      stringValue: asyncProcessor.functionArn,
      description: `Async-processor ARN for ${tier} tier`,
    });

    // ── Per-deployment intent taxonomy (intentPackParam profiles) + onboarding-intake (all) ──
    const intentPackParamName = `${SSM_ROOT}/assistant/${tier}/assistant-intent-pack`;
    const intentPackParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${intentPackParamName}`;
    const onboardingIntakeParamName = `${SSM_ROOT}/assistant/${tier}/onboarding-intake`;
    const onboardingIntakeParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${onboardingIntakeParamName}`;
    // Welcome orientation (all profiles): optional per-assistant SSM param the deployment writes
    // (company/access/examples) to give a first-time user context. Absent ⇒ generic welcome. The
    // handler reads it on the WelcomeIntent path; the demo seed writes it (see seed-demo.ts).
    const welcomeParamName = `${SSM_ROOT}/assistant/${tier}/welcome-orientation`;
    const welcomeParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${welcomeParamName}`;
    if (topo.intentPackParam) {
      const intentPackJson = (this.node.tryGetContext('assistantIntentPack') as string) || '';
      // Only systemPromptParam profiles (standard) warn on an empty pack — basic ships the generic
      // default intents silently (keyword task intents already emit).
      if (!intentPackJson.trim() && topo.systemPromptParam) {
        cdk.Annotations.of(this).addWarning(
          `[${tier}] assistantIntentPack is EMPTY - the classifier will use the generic default intents. ` +
          `Pass -c assistantIntentPack to set the pack.`,
        );
      }
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
    }

    // ── Per-profile agent handler (Lex fulfillment) ─────────────────────────
    // The SHARED router (router-agent-handler.ts) is deployed PER PROFILE. TIER=<profile> makes it skip
    // classification discovery (it IS the profile), act as this profile's bot, enforce
    // min(senderClearance, profile) via Cognito, resolve experiments, create/continue tasks, and
    // dispatch to THIS profile's async-processor. Live drift (Aurora) is wired in Aurora mode (all-profile).
    const drift = props.auroraDriftHookup ? auroraDriftWiring(this, tier, props.auroraDriftHookup) : undefined;

    const handlerRole = new iam.Role(this, 'AgentHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        // The handler only READS channel classification metadata + member count; it does not send.
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            ...classificationChannelScopedAllow(tier, props.appInstanceArn, ['chime:DescribeChannel', 'chime:ListChannelMemberships'], { bearerResources: [`${props.appInstanceArn}/bot/*`] }),
            // Read the immutable `classification` tag to resolve the served profile. A tag-READ cannot
            // itself be gated (it is how the profile is learned) — read-only, discloses only the tag.
            new iam.PolicyStatement({ actions: ['chime:ListTagsForResource'], resources: [`${props.appInstanceArn}/channel/*`] }),
          ],
        }),
        BedrockPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: classificationModelArns }),
        ] }),
        SSMPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${tierBotArnKey(tier)}`] }),
        ] }),
        DynamoDBPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({
            actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan'],
            resources: [
              shared.agentTasksArn, `${shared.agentTasksArn}/index/*`,
              shared.userTasksArn, `${shared.userTasksArn}/index/*`,
              shared.experimentsArn,
              ...(topo.handlerExperimentsIndex ? [`${shared.experimentsArn}/index/*`] : []),
              ...(battle ? [battle.battleStateArn, `arn:aws:dynamodb:${this.region}:${this.account}:table/${battle.channelBattleConfigName}`] : []),
            ],
          }),
        ] }),
        CognitoReadPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({ actions: ['cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser'], resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${shared.cognitoUserPoolId}`] }),
        ] }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    if (drift) {
      drift.grantTo(handlerRole);
      for (const stmt of driftChannelCreateStatements(tier, props.appInstanceArn, this.region, this.account)) {
        handlerRole.addToPolicy(stmt);
      }
    }
    // Handler SSM reads: the onboarding-intake schema (all profiles) + the intent pack (intentPackParam
    // profiles). The bot-arn read is in the inline SSMPolicy above; these ride the role's default policy
    // (effective grant is identical regardless of grouping).
    handlerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [onboardingIntakeParamArn, welcomeParamArn, ...(topo.intentPackParam ? [intentPackParamArn] : [])],
      }),
    );

    const handlerEnv: Record<string, string> = {
      TIER: tier,
      ...(drift?.env ?? {}),
      ...(drift ? { CHANNEL_FLOW_ARN_PARAM: CHANNEL_FLOW_ARN_SSM_KEY } : {}),
      SSM_ROOT,
      ONBOARDING_INTAKE_PARAM: onboardingIntakeParamName,
      ASSISTANT_WELCOME_PARAM: welcomeParamName,
      BOT_ARN_PARAM: tierBotArnKey(tier),
      [`${tier.toUpperCase()}_ASYNC_PROCESSOR_ARN`]: asyncProcessor.functionArn,
      APP_INSTANCE_ARN: props.appInstanceArn,
      AWS_ACCOUNT_ID: this.account,
      USER_POOL_ID: shared.cognitoUserPoolId,
      // Intent classification is a cheap, high-frequency call — always Haiku (on-demand-capable), never
      // the profile primary (a bare on-demand id for Opus/Sonnet is rejected by Bedrock).
      CLASSIFIER_MODEL_ID: modelCatalog['haiku'].bedrockModelId,
      TASKS_TABLE: shared.agentTasksName,
      USER_TASKS_TABLE: shared.userTasksName,
      EXPERIMENTS_TABLE: shared.experimentsName,
      ...abuse.env,
    };
    if (topo.intentPackParam) handlerEnv.ASSISTANT_INTENT_PACK_PARAM = intentPackParamName;
    if (battle) {
      handlerEnv.BATTLE_STATE_TABLE = battle.battleStateName;
      handlerEnv.CHANNEL_BATTLE_CONFIG_TABLE = battle.channelBattleConfigName;
    }

    const agentHandler = new lambdaNodeJs.NodejsFunction(this, 'AgentHandler', {
      entry: path.join(__dirname, '../../lambda/src/router-agent-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: drift ? 1024 : 512,
      role: handlerRole,
      environment: handlerEnv,
      bundling: { minify: false, forceDockerBundling: false },
    });
    asyncProcessor.grantInvoke(agentHandler);
    abuse.grant(handlerRole);
    new lambda.CfnPermission(this, 'AgentHandlerLexInvoke', {
      action: 'lambda:InvokeFunction',
      functionName: agentHandler.functionName,
      principal: 'lexv2.amazonaws.com',
    });
    const handlerArn = agentHandler.functionArn;

    // ── Lex bot + AppInstanceBot (per profile) ──────────────────────────────
    const lexBotRole = new iam.Role(this, 'LexBotRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lexv2.amazonaws.com'),
        new iam.ServicePrincipal('chime.amazonaws.com'),
      ),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonLexRunBotsOnly')],
      inlinePolicies: {
        LambdaInvokePolicy: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [handlerArn] })],
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

    const lexProvider = new cdk.custom_resources.Provider(this, 'CreateLexBotProvider', { onEventHandler: createLexBotFn });
    const lexResource = new cdk.CustomResource(this, 'CreateLexBotResource', {
      serviceToken: lexProvider.serviceToken,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      properties: { tier, botName: `Assistant-${tier}` },
    });
    const lexBotAliasArn = lexResource.getAtt('LexBotAliasArn').toString();

    const createBotRole = new iam.Role(this, 'CreateBotRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        CreateBotPolicy: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({ actions: ['chime:CreateAppInstanceBot'], resources: [props.appInstanceArn, `${props.appInstanceArn}/bot/*`] })],
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

    const botProvider = new cdk.custom_resources.Provider(this, 'CreateBotProvider', { onEventHandler: createBotFn });
    const botResource = new cdk.CustomResource(this, 'CreateBotResource', {
      serviceToken: botProvider.serviceToken,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    botResource.node.addDependency(lexResource);
    this.appInstanceBotArn = botResource.getAtt('AppInstanceBotArn').toString();

    new ssm.StringParameter(this, 'TierBotArnParam', {
      parameterName: tierBotArnKey(tier),
      stringValue: this.appInstanceBotArn,
      description: `AppInstanceBot ARN for ${tier} tier — read by create-conversation`,
    });

    new cdk.CfnOutput(this, 'TierAsyncProcessorArn', { value: asyncProcessor.functionArn });
    new cdk.CfnOutput(this, 'TierAppInstanceBotArn', { value: this.appInstanceBotArn });

    cdk.Tags.of(this).add('Component', topo.componentTag);
    cdk.Tags.of(this).add('Tier', tier);
  }
}
