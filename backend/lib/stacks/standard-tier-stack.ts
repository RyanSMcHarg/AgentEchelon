/**
 * StandardTierStack — independently-deployable stack for the STANDARD agent tier.
 *
 * Per-tier ownership model (ADR-011).
 * Owns everything the standard-tier team controls end-to-end:
 *   - Text content guardrail (`agent-echelon-standard-guardrail`).
 *   - Async-processor Lambda + tier-scoped IAM (standard = Sonnet by default;
 *     supports multi-turn tasks, /battle round participation, generated docs;
 *     no streaming, no image gen).
 *   - Per-tier Lex bot (WelcomeIntent + FallbackIntent → shared router).
 *   - Per-tier AppInstanceBot for the channel-side handle.
 *   - SSM publishers: `/agent-echelon/assistant/standard/processor-arn`,
 *     `/agent-echelon/assistant/standard/bot-arn`.
 *
 * Tier isolation boundary: the processor role's S3 IAM is scoped to
 * `context/basic/` + `context/standard/`. Standard inherits basic, blocks
 * premium. Boundary is IAM, not Lambda logic.
 *
 * Standard reads the SHARED platform contract (tasks tables, /battle state,
 * experiments) via `valueForStringParameter` at deploy time — an SSM dynamic
 * ref, NOT Fn::importValue — so the tier deploys decoupled from the feature
 * stacks that publish it. A standard-team change here does not review-couple
 * Basic or Premium.
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

export interface StandardTierStackProps extends cdk.StackProps {
  /** Shared Chime AppInstance ARN (from AgentEchelonChimeMessaging). */
  appInstanceArn: string;
  /** Shared attachments bucket holding context/{basic,standard}/*.json (from AgentEchelonS3Storage). */
  attachmentsBucketName: string;
  attachmentsBucketArn: string;
  /** Tier model selection (standard-team picks `tierModelSelection.standard`). */
  tierModelSelection: TierModelSelection;
  /**
   * Wire /battle plumbing (battle-state/config table grants + env + orchestrator
   * invoke), resolving the battle SSM contract AgentEchelonBattle publishes. False
   * when /battle is not deployed (`enableBattle=false`) — the processor then
   * carries no battle plumbing and fails open.
   */
  enableBattle?: boolean;
  /** Aurora hookup for LIVE drift (conversation-level, all-tier, on-by-default).
   *  Present only in Aurora mode; VPC-attaches the handler to Aurora pgvector. */
  auroraDriftHookup?: AuroraDriftHookup;
  /** Out-of-band per-message analytics table (Phase 1). Aurora mode only. */
  messageAnalytics?: MessageAnalyticsWiring;
  /** Admin conversation channel the async processor posts failures to (CH parity); the channel
   *  flow emails its roster via the notify directive. Empty/undefined ⇒ error alerting is log-only. */
  adminErrorAlertChannelArn?: string;
}

export class StandardTierStack extends cdk.Stack {
  public readonly asyncProcessorArn: string;
  public readonly appInstanceBotArn: string;

  constructor(scope: Construct, id: string, props: StandardTierStackProps) {
    super(scope, id, props);

    const tier = 'standard' as const;
    const modelCatalog = getModelCatalog(this.region, this.account);
    const tierModel = modelCatalog[props.tierModelSelection.standard];

    // DeepSeek-on-Bedrock CN routing (SPEC-CONTEXT-AWARE-MODEL-ROUTING). In-AWS, intent-routed:
    // reasoning-heavy intents → R1 (inference profile), the rest → V3 (on-demand). Configurable;
    // defaults to the verified us-east-1 DeepSeek models. Active only when ENABLE_CONTEXT_ROUTING is
    // on (runtime). Empty chat model ⇒ no env, no IAM.
    const cnChatModel = (this.node.tryGetContext('cnBedrockChatModel') as string) ?? 'deepseek.v3.2';
    const cnReasoningModel = (this.node.tryGetContext('cnBedrockReasoningModel') as string) ?? 'us.deepseek.r1-v1:0';
    const cnReasoningIntents =
      (this.node.tryGetContext('cnBedrockReasoningIntents') as string) ?? 'report_generation,data_extraction,guided_troubleshooting';
    const cnBedrockArns = cnChatModel
      ? [
          `arn:aws:bedrock:${this.region}::foundation-model/${cnChatModel}`,
          // R1 reasoning via the us. cross-region inference profile: grant the profile ARN AND the
          // regional foundation models it fans out to (us-east-1/us-east-2/us-west-2).
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${cnReasoningModel}`,
          ...['us-east-1', 'us-east-2', 'us-west-2'].map(
            (r) => `arn:aws:bedrock:${r}::foundation-model/${cnReasoningModel.replace(/^us\./, '')}`,
          ),
        ]
      : [];

    const tierModelArns = [...modelArnsForTier(tier, modelCatalog), ...cnBedrockArns];

    // Shared platform contract (tasks tables + experiments). Standard needs
    // these; basic does not. Resolved at deploy time via SSM, NOT Fn::importValue.
    const shared = resolveSharedSSM(this);
    // Admin error-alert wiring (CH parity): env + grant for posting processor failures to the
    // admin conversation. Log-only when no alert channel is configured.
    const errAlert = adminErrorAlertWiring(this, props.appInstanceArn, props.adminErrorAlertChannelArn);
    // Abuse controls (SPEC-ABUSE-CONTROLS): dedup (processor) + spend budget (handler). Dedup
    // active; budgets opt-in via -c bedrock*HourlyBudget. Env spread on both; grant both roles.
    const abuse = abuseControlsWiring(this, shared.abuseControlsArn, shared.abuseControlsName, tier, this.region, this.account);
    // /battle plumbing — only resolved when /battle is deployed. AgentEchelonBattle is
    // opt-in, so resolving these unconditionally would fail the deploy on a
    // missing SSM param when battle is off.
    const battle = props.enableBattle ? resolveBattleSSM(this) : undefined;

    // ── Tier content guardrail (text) ──────────────────────────────────────
    const guardrail = new AgentGuardrails(this, 'AssistantGuardrail', {
      name: `${RES_PREFIX}-${tier}-guardrail`,
    });

    // ── Async-processor execution role (the tier isolation boundary) ───────
    const processorRole = new iam.Role(this, 'ProcessorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        // SPEC-CONVERSATION-SECURITY Layer 1 (assistant-identity half), fail-closed:
        // the standard assistant may act ONLY on channels tagged classification ∈
        // {basic, standard}. Untagged or premium → no Allow → implicit deny.
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
            // Standard = buffered InvokeModel only (no streaming).
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel'],
              resources: tierModelArns,
            }),
            new iam.PolicyStatement({
              actions: ['bedrock:ApplyGuardrail'],
              resources: [guardrail.guardrailArn],
            }),
          ],
        }),
        // Tier-scoped company-context: basic + standard prefixes; premium is
        // denied via the absence of its prefix here.
        ContextS3Read: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:ListBucket'],
              resources: [props.attachmentsBucketArn],
              // platform-knowledge/* (load_platform_info) is readable by every tier.
              conditions: { StringLike: { 's3:prefix': ['context/basic/*', 'context/standard/*', 'platform-knowledge/*'] } },
            }),
            new iam.PolicyStatement({
              actions: ['s3:GetObject'],
              resources: [
                `${props.attachmentsBucketArn}/context/basic/*`,
                `${props.attachmentsBucketArn}/context/standard/*`,
                `${props.attachmentsBucketArn}/platform-knowledge/*`,
              ],
            }),
            new iam.PolicyStatement({
              // Attachment-in: read the user-uploaded file the current turn references
              // (attachments/<conversationId>/<sub>/...) so the processor can attach a
              // Converse image/document block. Same grant the premium tier has.
              actions: ['s3:GetObject'],
              resources: [`${props.attachmentsBucketArn}/attachments/*`],
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Shared tables: tasks (multi-turn), /battle state, experiments,
    // generated-doc writes, and the battle-orchestrator invoke.
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

    // ── External (Chinese) LLM provider — DeepSeek (SPEC-CONTEXT-AWARE-MODEL-ROUTING) ──
    // The API key lives in Secrets Manager; the operator sets its value out-of-band (the secret
    // ships empty). Context routing is OFF by default — flip it on at deploy
    // (`-c enableContextRouting=true`) once the key is set. Consent defaults ON in the private
    // phase (`-c externalConsentDefault=false` flips it to opt-in when the site opens).
    const deepseekSecret = new secretsmanager.Secret(this, 'DeepseekApiKey', {
      description: 'DeepSeek API key for the Chinese-LLM routing path. Set the value out-of-band: aws secretsmanager put-secret-value --secret-id <arn> --secret-string <key>',
    });
    const enableContextRouting =
      this.node.tryGetContext('enableContextRouting') === 'true' ||
      this.node.tryGetContext('enableContextRouting') === true;
    const consentCtx = this.node.tryGetContext('externalConsentDefault');
    const externalConsentDefault = consentCtx === undefined ? 'true' : String(consentCtx);

    // ── Async-processor Lambda (the assistant) ──────────────
    // Per-deployment persona. A rich persona exceeds Lambda's 4 KB env cap, so (like the intent
    // pack) it lives in an SSM parameter the processor hydrates at cold start; the env carries only
    // the param name. Empty context ⇒ no param ⇒ the processor uses its generic default.
    // CONFIG GUARD: a personaless standard/premium assistant silently falls back to the generic
    // default and reads off-brand ("I'm an AI assistant without access to..."). An empty context
    // drops the param, so warn loudly at synth instead of letting it be discovered via a bad
    // conversation.
    const systemPromptValue = (this.node.tryGetContext('assistantSystemPrompt') as string) || '';
    if (!systemPromptValue.trim() && (tier === 'standard' || tier === 'premium')) {
      cdk.Annotations.of(this).addWarning(
        `[${tier}] assistantSystemPrompt is EMPTY - the assistant will use the generic default persona ` +
        `(off-brand, no host grounding). Pass -c assistantSystemPrompt to set a persona.`,
      );
    }
    // Preserve-on-absent (see docs/decisions/012-assistant-config-store-and-drift.md):
    // the writer path writes the persona/pack via an `AwsCustomResource` that PutParameters ONLY when a
    // non-empty value is supplied and NEVER deletes — so a deploy that omits -c assistantSystemPrompt
    // can't blank an existing persona (the production footgun). The physicalResourceId carries a content
    // hash so a changed persona re-PUTs (busts the CFN "no changes"/drift no-op). The param name is
    // stable; the processor reads it by name regardless of whether THIS deploy set it.
    //
    // MIGRATION (2-step RETAIN) — the persona/pack params are currently CFN-managed `ssm.StringParameter`s
    // (logical ids SystemPromptParam / IntentPackParam). Swapping StringParameter → writer in ONE deploy
    // would BLANK the param: CFN runs the writer's PutParameter (create phase) and then DELETES the
    // removed StringParameter LAST (cleanup phase); a StringParameter's default DeletionPolicy is Delete,
    // so DeleteParameter fires on the same name and wins. CFN reads DeletionPolicy from the
    // ALREADY-DEPLOYED template when removing a resource, so the only safe path is two deploys, gated on
    // `-c assistantParamWriter=true`:
    //   Deploy 1 (default, flag absent): StringParameter kept but RemovalPolicy.RETAIN. Metadata-only
    //            diff — teaches the LIVE stack to ORPHAN (not delete) the param when it is later removed.
    //   Deploy 2 (`-c assistantParamWriter=true`): StringParameter gone, writer present. CFN orphans the
    //            old param (Retain honored), the writer's PutParameter(Overwrite) re-owns it — survives.
    // BOTH deploys MUST carry -c assistantSystemPrompt / -c assistantIntentPack (+ assistantTier=standard).
    // Once Deploy 2 has landed in every environment, a follow-up commit drops this flag + the RETAIN
    // branch so the writer is the permanent default.
    const useParamWriter =
      this.node.tryGetContext('assistantParamWriter') === 'true' ||
      this.node.tryGetContext('assistantParamWriter') === true;

    const systemPromptParamName = `${SSM_ROOT}/assistant/${tier}/assistant-system-prompt`;
    const systemPromptParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${systemPromptParamName}`;
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
          // No onDelete ⇒ removing this writer (an empty-context deploy) PRESERVES the param.
          policy: cr.AwsCustomResourcePolicy.fromStatements([
            new iam.PolicyStatement({ actions: ['ssm:PutParameter'], resources: [systemPromptParamArn] }),
          ]),
          installLatestAwsSdk: false,
        });
      } else {
        // Deploy 1 — keep the legacy CFN-managed param (SAME logical id + name + tier as the live
        // resource, so this is a metadata-only diff) but RETAIN it, so Deploy 2's removal orphans
        // rather than deletes the underlying SSM parameter.
        new ssm.StringParameter(this, 'SystemPromptParam', {
          parameterName: systemPromptParamName,
          stringValue: systemPromptValue,
          description: 'Per-deployment assistant persona (system prompt) — read by the AsyncProcessor',
          tier: ssm.ParameterTier.ADVANCED,
        }).applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
      }
    }

    const asyncProcessor = new lambdaNodeJs.NodejsFunction(this, 'AsyncProcessor', {
      entry: path.join(__dirname, '../../lambda/src/standard-async-processor.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      reservedConcurrentExecutions: 50,
      role: processorRole,
      environment: {
        APP_INSTANCE_ARN: props.appInstanceArn,
        MODEL_ID: tierModel.bedrockModelId,
        MODEL_NAME: tierModel.displayName,
        // Per-deployment persona (empty ⇒ AE generic default). Stored in SSM (param name passed
        // here; the processor hydrates at cold start) so a rich persona doesn't blow the 4 KB cap.
        // Always reference the param by NAME (it may exist from a preserved prior deploy even if THIS
        // deploy didn't set it); the processor falls back to its default when the param is absent.
        ASSISTANT_SYSTEM_PROMPT_PARAM: systemPromptParamName,
        // NB: ASSISTANT_INTENT_PACK is intentionally NOT here. The classifier runs in the
        // AgentHandler (this processor consumes the already-classified `event.intent`), and AWS
        // caps a Lambda's TOTAL env-var size at 4 KB — the persona above (~1.6 KB) plus the pack
        // (~2.5 KB minified) would exceed it. The pack lives on the AgentHandler only.
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
        // Context-aware routing. OFF unless -c enableContextRouting=true.
        ENABLE_CONTEXT_ROUTING: enableContextRouting ? 'true' : 'false',
        EXTERNAL_MODEL_CONSENT_DEFAULT: externalConsentDefault,
        // PREFERRED CN path: DeepSeek-on-Bedrock (in-AWS, no consent gate). Intent-routed: reasoning
        // intents → R1, the rest → V3. Wins over the external api.deepseek.com path below.
        ...(cnChatModel
          ? {
              CN_BEDROCK_CHAT_MODEL: cnChatModel,
              CN_BEDROCK_REASONING_MODEL: cnReasoningModel,
              CN_BEDROCK_REASONING_INTENTS: cnReasoningIntents,
            }
          : {}),
        // LEGACY external DeepSeek (api.deepseek.com) — only used if CN_BEDROCK_CHAT_MODEL is unset.
        DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
        DEEPSEEK_MODEL: (this.node.tryGetContext('deepseekModel') as string) || 'deepseek-chat',
        DEEPSEEK_API_KEY_SECRET: deepseekSecret.secretArn,
        ...(battle
          ? {
              BATTLE_STATE_TABLE: battle.battleStateName,
              CHANNEL_BATTLE_CONFIG_TABLE: battle.channelBattleConfigName,
              BATTLE_ORCHESTRATOR_ARN: battle.battleOrchestratorArn,
            }
          : {}),
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    this.asyncProcessorArn = asyncProcessor.functionArn;
    // Phase 1: write the full analytics blob out-of-band + slim the Chime Metadata (Aurora mode).
    wireMessageAnalytics(asyncProcessor, props.messageAnalytics);
    // Let the processor read the DeepSeek key (least-privilege: this one secret).
    deepseekSecret.grantRead(asyncProcessor);
    // Let the processor read its persona from SSM at cold start (always — the param may exist from a
    // preserved prior deploy even if THIS deploy didn't set it).
    asyncProcessor.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [systemPromptParamArn] }),
    );
    new cdk.CfnOutput(this, 'DeepseekSecretArn', {
      value: deepseekSecret.secretArn,
      description: 'Put the DeepSeek API key here (aws secretsmanager put-secret-value), then deploy with -c enableContextRouting=true.',
    });

    new ssm.StringParameter(this, 'ProcessorArnParam', {
      parameterName: tierProcessorArnKey(tier),
      stringValue: asyncProcessor.functionArn,
      description: 'Async-processor ARN for standard tier',
    });

    // Per-deployment intent taxonomy (lib/intent-pack.ts). The pack JSON can exceed AWS Lambda's
    // 4 KB total env-var budget, so it lives in an SSM parameter and the AgentHandler (where the
    // classifier runs) gets only the param NAME + read grant; it hydrates the pack at cold start.
    // Empty context ⇒ no param, no env ⇒ the handler uses DEFAULT_INTENT_PACK (generic AE behavior).
    const intentPackJson = (this.node.tryGetContext('assistantIntentPack') as string) || '';
    if (!intentPackJson.trim() && (tier === 'standard' || tier === 'premium')) {
      cdk.Annotations.of(this).addWarning(
        `[${tier}] assistantIntentPack is EMPTY - the classifier will use the generic default intents. ` +
        `Pass -c assistantIntentPack to set the pack.`,
      );
    }
    // D1 preserve-on-absent (same pattern as the persona above): write the pack via a custom resource
    // that PutParameters only when non-empty and never deletes; the hash in the physicalId busts
    // drift. Advanced tier (8 KB) — a rich intent pack exceeds the 4 KB Standard cap.
    const intentPackParamName = `${SSM_ROOT}/assistant/${tier}/assistant-intent-pack`;
    const intentPackParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${intentPackParamName}`;
    // Optional onboarding-intake schema (opt-in welcome). The router reads this
    // SSM param at cold start; absent/empty ⇒ onboarding is disabled and the
    // static welcome is used (the default). A deployment enables the multi-step
    // intake by writing the JSON schema here (no redeploy — takes effect on the
    // next cold start). See docs/GUIDE-ASSISTANT-CONTEXT.md "Welcome patterns".
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
        // Deploy 1 (2-step RETAIN — see the persona block above). Same logical id + name + tier as the
        // live resource ⇒ metadata-only diff; RETAIN so Deploy 2's removal orphans (not deletes) it.
        new ssm.StringParameter(this, 'IntentPackParam', {
          parameterName: intentPackParamName,
          stringValue: intentPackJson,
          description: 'Per-deployment assistant intent pack (JSON) — read by the AgentHandler classifier',
          tier: ssm.ParameterTier.ADVANCED,
        }).applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
      }
    }

    // ── Per-tier agent handler (Lex fulfillment) ──────────────────────────
    // Full bot-layer isolation (ADR-011): the router code is deployed
    // PER TIER. TIER=standard makes it skip channel-tier discovery (it IS the
    // tier), act as the standard bot, enforce min(senderTier, standard) via
    // Cognito, resolve experiments, and dispatch to THIS tier's processor. No
    // shared cross-tier handler. (Drift/Aurora is premium+Aurora-mode only — not
    // wired here.)
    const handlerRole = new iam.Role(this, 'AgentHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        // The handler only reads channel tier metadata + member count; it does
        // NOT send. Tier-gated fail-closed + stripped of unused send/update grants.
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
          new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${tierBotArnKey(tier)}`] }),
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
    // VPC-attaches this handler to Aurora pgvector + adds DB env + RDS/Titan IAM,
    // on-by-default. Same wiring for every tier.
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
        ...(drift ? { CHANNEL_FLOW_ARN_PARAM: CHANNEL_FLOW_ARN_SSM_KEY } : {}),
        SSM_ROOT,
        // Per-deployment intent taxonomy (empty ⇒ AE generic/enterprise default). The classifier
        // runs in THIS lambda; it hydrates the pack from this SSM param at cold start (the JSON is
        // too large for the 4 KB env budget). A deployment sets `-c assistantIntentPack='[…]'`.
        ASSISTANT_INTENT_PACK_PARAM: intentPackParamName,
        // Opt-in onboarding intake schema source (empty/absent ⇒ static welcome).
        ONBOARDING_INTAKE_PARAM: onboardingIntakeParamName,
        BOT_ARN_PARAM: tierBotArnKey(tier),
        STANDARD_ASYNC_PROCESSOR_ARN: asyncProcessor.functionArn,
        APP_INSTANCE_ARN: props.appInstanceArn,
        AWS_ACCOUNT_ID: this.account,
        USER_POOL_ID: shared.cognitoUserPoolId,
        // Intent classification is a cheap, high-frequency call — always Haiku
        // (on-demand-capable), never the tier's primary. Using the tier model
        // here would invoke Opus/Sonnet by bare on-demand id, which Bedrock rejects
        // ("...with on-demand throughput isn't supported; use an inference
        // profile"), silently degrading every classification to 'general'.
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
      description: 'AppInstanceBot ARN for standard tier — read by create-conversation',
    });

    new cdk.CfnOutput(this, 'TierAsyncProcessorArn', { value: asyncProcessor.functionArn });
    new cdk.CfnOutput(this, 'TierAppInstanceBotArn', { value: this.appInstanceBotArn });

    cdk.Tags.of(this).add('Component', 'Tier-Standard');
    cdk.Tags.of(this).add('Tier', tier);
  }
}
