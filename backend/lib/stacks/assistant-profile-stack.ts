/**
 * AssistantProfileStack — the ONE parametrized, independently-deployable stack for an assistant
 * profile (SPEC-CAPABILITY-PROFILES). It replaces the former per-classification {basic,standard,premium}-tier
 * stacks, which were ~1787 lines of near-duplicated topology diverging only in capability.
 *
 * A `ProfileTopology` descriptor makes the divergence DATA, not three code copies:
 *   - model selection, Lambda sizing (timeout/memory/concurrency), response ceiling;
 *   - `contextRouting` (external/CN model path + secret), `systemPromptParam` (persona SSM),
 *     `intentPackParam` (custom intent taxonomy), `richProcessor` (multi-turn tasks + docs +
 *     experiments + attachment-in), `imageGen` (/battle image generation-out + image guardrail),
 *     `streaming`, `battleCapable`.
 * Each profile's thin stack (basic/standard/premium-tier-stack.ts) supplies its topology; the shared
 * body here is authored once. Construct ids match the legacy per-classification stacks, so a fresh deploy mints
 * the same logical resources.
 *
 * Per-profile ownership (was ADR-011's per-classification stack): a profile team now owns its topology
 * descriptor (its thin stack file), and the shared body is reviewed platform-side. Classification isolation is
 * unchanged — the processor role's S3 IAM is scoped to `context/{classifications-at-or-below}/`, the
 * boundary is IAM, not Lambda logic. Shared platform contract (tasks tables, experiments, /battle
 * state) still resolves via SSM dynamic refs (NOT Fn::importValue), so profiles deploy decoupled.
 */

import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { createHash } from 'node:crypto';
import * as path from 'path';
import { AgentGuardrails } from '../constructs/bedrock-guardrails';
import { guardrailCatalog } from '../config/guardrail-catalog';
import {
  loadContextSourceCatalog,
  contextSourceGrant,
  publishableContextSource,
  CONTEXT_SOURCE_METRIC_NAMESPACE,
} from '../config/context-sources';
import { BattleImageGuardrails } from '../constructs/battle-image-guardrails';
// The processor's image-model grant is DERIVED from the image-gen registry, so a model added there
// cannot be left ungranted here (precedent: ANALYTICS_CAPABILITY_SUBPATHS in analytics-stack-aurora).
import { BEDROCK_IMAGE_MODEL_ARNS } from '../../lambda/src/lib/image-gen-models';
import { getModelCatalog, ProfileModelSelection } from '../config/model-strategy';
import { defaultProfileRegistry } from '../profile-registry';
import {
  classificationChannelScopedAllow,
  contextPrefixesAllowedFor,
  modelArnsForClassification,
  resolveSharedSSM,
  adminErrorAlertWiring,
  abuseControlsWiring,
  resolveBattleSSM,
  botArnKey,
  processorArnKey,
  routerArnKey,
  Classification,
  auroraDriftWiring,
  AuroraDriftHookup,
  MessageAnalyticsWiring,
  wireMessageAnalytics,
  driftChannelCreateStatements,
  CHANNEL_FLOW_ARN_SSM_KEY,
  RES_PREFIX,
  SSM_ROOT,
  INSTANCE_SSM,
} from './agent-classification-common';

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
   *  Preserved verbatim from the per-classification stacks; standard/premium query experiments by primary key. */
  handlerExperimentsIndex: boolean;
  /** CloudFormation Component tag value (e.g. 'Classification-Basic'). */
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
  /**
   * Image-generation guardrails in the regions the MODELS live in, region -> {id, version}.
   *
   * Bedrock guardrails are regional and the Stability generators are us-west-2-only, so a us-east-1
   * deployment invokes them cross-region and the deploy-region guardrail cannot be attached. Provided
   * by `bin/backend.ts` from a per-region `ImageGuardrailStack`. Absent for a region means the runtime
   * REFUSES to generate there rather than generating unmoderated.
   */
  imageGuardrailByRegion?: Record<string, { id: string; version: string }>;
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
    // The agent-classification-common helpers are typed to the built-in Classification union. The default
    // profiles ARE that union; a deployment-defined profile name would widen this (a follow-up when custom
    // profiles ship). Cast keeps the shared boundary helpers strongly typed for the shipped set.
    const classification = topo.name as Classification;
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
    const classificationModelArns = [...modelArnsForClassification(classification, modelCatalog), ...cnBedrockArns];

    const shared = resolveSharedSSM(this);
    const errAlert = adminErrorAlertWiring(this, props.appInstanceArn, props.adminErrorAlertChannelArn);
    const abuse = abuseControlsWiring(this, shared.abuseControlsArn, shared.abuseControlsName, classification, this.region, this.account);
    // /battle plumbing — only resolved when the profile is battle-capable AND /battle is deployed.
    const battle = topo.battleCapable && props.enableBattle ? resolveBattleSSM(this) : undefined;

    // ── Content guardrail (text) ────────────────────────────────────────────
    const guardrail = new AgentGuardrails(this, 'AssistantGuardrail', {
      name: `${RES_PREFIX}-${classification}-guardrail`,
    });
    // 4.6b: provision the deployment's SELECTABLE alternate guardrails from the catalog (the default
    // above is what GUARDRAIL_ID env points at). A profile SELECTS one via its guardrailId; the
    // ApplyGuardrail grant below covers EVERY provisioned ARN, so an unprovisioned selection AccessDenies
    // and the apply path fails open — a version can never point at a resource the deployment didn't provision.
    const alternateGuardrails = guardrailCatalog(RES_PREFIX)
      .filter((e) => e.key !== 'default')
      .map((e) => ({
        key: e.key,
        name: `${RES_PREFIX}-${classification}-${e.key}-guardrail`,
        gr: new AgentGuardrails(this, `AssistantGuardrail-${e.key}`, {
          policy: { ...e.policy, name: `${RES_PREFIX}-${classification}-${e.key}-guardrail` },
        }),
      }));
    // Publish the SELECTABLE guardrails (resolved ids + versions) so an operator / the admin console /
    // a profile author can discover what a profile's guardrailId may be set to (4.6b). Not read by the
    // runtime (the processor gets guardrailId from the profile definition); it is the selection catalog.
    new ssm.StringParameter(this, 'GuardrailsCatalogParam', {
      parameterName: `${SSM_ROOT}/assistant/${classification}/guardrails`,
      stringValue: JSON.stringify([
        { key: 'default', name: `${RES_PREFIX}-${classification}-guardrail`, guardrailId: guardrail.guardrailId, guardrailVersion: guardrail.guardrailVersion },
        ...alternateGuardrails.map((a) => ({ key: a.key, name: a.name, guardrailId: a.gr.guardrailId, guardrailVersion: a.gr.guardrailVersion })),
      ]),
      description: 'Selectable guardrails for this classification (SPEC-CONFIGURABLE-ASSISTANTS 4.6b): a profile.guardrailId picks one.',
    });

    // ── Image-output guardrail (imageGen profiles only, for /battle generation-out) ──
    const imageGuardrail = topo.imageGen
      ? new BattleImageGuardrails(this, 'BattleImageGuardrails', { name: `${RES_PREFIX}-${classification}-battle-image-guardrail` })
      : undefined;

    // ── Async-processor execution role (the profile isolation boundary) ─────
    const processorRole = new iam.Role(this, 'ProcessorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        // SPEC-CONVERSATION-SECURITY Layer 1 (assistant-identity half), fail-closed: the assistant may
        // act ONLY on channels tagged classification ∈ {this profile's rank and below}. Untagged / a
        // higher classification → no Allow → implicit deny (a tagging gap never silently grants access).
        ChimePolicy: new iam.PolicyDocument({
          statements: classificationChannelScopedAllow(classification, props.appInstanceArn, [
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
              // The deployment default + every selectable alternate (4.6b): a profile can only apply a
              // PROVISIONED guardrail; anything else fails closed (open).
              resources: [guardrail.guardrailArn, ...alternateGuardrails.map((a) => a.gr.guardrailArn)],
            }),
          ],
        }),
        // Classification-scoped company-context read (ADR-011): ONLY context/{classifications-at-or-below}/* +
        // the platform-knowledge/* self-knowledge (readable by every profile). S3 AccessDenies any
        // other prefix — this is the actual isolation boundary.
        ContextS3Read: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:ListBucket'],
              resources: [props.attachmentsBucketArn],
              conditions: { StringLike: { 's3:prefix': [...contextPrefixesAllowedFor(classification).map((p) => `${p}*`), 'platform-knowledge/*'] } },
            }),
            new iam.PolicyStatement({
              actions: ['s3:GetObject'],
              resources: [
                ...contextPrefixesAllowedFor(classification).map((p) => `${props.attachmentsBucketArn}/${p}*`),
                `${props.attachmentsBucketArn}/platform-knowledge/*`,
                // The active version's PERSONA (SPEC-PORTABLE-PROFILES, "Bodies are S3"): the definition
                // in SSM holds a pointer under `profiles/*` and the processor follows it every time it
                // resolves its profile. READ-ONLY, and deliberately not classification-scoped the way the
                // context prefixes are: a profile can only ever be handed its OWN version's key, which is
                // content-addressed, and the assistant fails closed to the compiled seed if the read
                // fails. Write stays exclusive to manage-profiles (§7).
                `${props.attachmentsBucketArn}/profiles/*`,
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
      // Non-rich profile (richProcessor:false): the SAME DynamoDB task grants as above (read/create/
      // advance task state — taskSupport is still 'full'), but WITHOUT the rich-output grants (no
      // generated-docs S3 write, no attachment-in read). So basic tracks and advances tasks; it just
      // does not produce downloadable documents.
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

    // Image-gen profiles: image generation on ordinary `image_generation` turns and /battle
    // generation-out + image-output guardrail + the default-bot SSM read (loadDefaultBotArn) +
    // battle-images read/write.
    //
    // EVERY `aws-bedrock` MODEL IN THE REGISTRY IS LISTED, not just the ones a battle happens to use.
    // This grant previously named only Titan Image and Nova Canvas, both LEGACY, while
    // `DEFAULT_IMAGE_MODEL` had moved to Stability Image Core — so the shipped default was ungranted
    // and every image turn failed. IAM and the registry drifted silently because nothing held them
    // together; `image-gen-iam-parity.test.ts` now does.
    //
    // The `:*:` region wildcard is load-bearing. Bedrock does not offer every model in every region
    // (the Stability base generators are us-west-2 only, see `region` in the registry), so the
    // processor invokes them cross-region and a grant pinned to the deploy region would deny them.
    let igKeysSecretArn: string | undefined;
    if (topo.imageGen) {
      processorRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: BEDROCK_IMAGE_MODEL_ARNS,
        }),
      );
      processorRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:ApplyGuardrail'],
          resources: [
            `arn:aws:bedrock:${this.region}:${this.account}:guardrail/${imageGuardrail!.guardrailId}`,
            // A guardrail attached to a CROSS-REGION InvokeModel is enforced in the region the call
            // goes to, so the grant has to name it there too. Without this the guardrail resolves and
            // then AccessDenies - the same "ships inert" shape as the per-member fallback that was
            // deployed without its ListChannelMemberships grant and died on first contact.
            ...Object.entries(props.imageGuardrailByRegion ?? {}).map(
              ([region, g]) => `arn:aws:bedrock:${region}:${this.account}:guardrail/${g.id}`,
            ),
          ],
        }),
      );
      processorRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [`${props.attachmentsBucketArn}/attachments/*`] }));
      processorRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject', 's3:GetObject'], resources: [`${props.attachmentsBucketArn}/battle-images/*`] }));
      // Default-bot ARN read (battle default-bot resolution).
      processorRole.addToPolicy(
        new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${botArnKey(classification)}`] }),
      );
    }

    // ── Context source catalog (SPEC-CONTEXT-SOURCES-AND-STORES phase 2) ─────────
    //
    // The set of context sources a profile bound to THIS classification may select by key. Entries are
    // DATA (lib/config/context-sources: the deployer's gitignored local file, else the tracked
    // example), so this loop is generic and never names a source.
    //
    // INV-CTX-CAT-3: the grant is emitted HERE, beside the publication, and scoped to each entry's
    // exact resource. A published key without its grant imports cleanly and fails at RUNTIME - an
    // omission that fails OPEN. Publishing and granting in one place is what makes that impossible to
    // get half-right, and `cdk-synth.test.ts` asserts the resource scope, not merely that a statement
    // exists, because a wildcard would satisfy "a grant exists" while destroying least privilege.
    const contextSources = loadContextSourceCatalog({
      classification,
      attachmentsBucketArn: props.attachmentsBucketArn,
      attachmentsBucketName: props.attachmentsBucketName,
      userProfileTableArn: shared.userProfileArn,
      userProfileTableName: shared.userProfileName,
      region: this.region,
      account: this.account,
    });
    for (const entry of contextSources.entries) {
      // Resource form is per type: an s3-prefix grants only its own prefix, never the bucket.
      // A LIST of statements: a type may need more than one shape (an object-level read plus a
      // conditioned bucket-level list, say), and folding those into one statement is how `ListBucket`
      // ended up on an object ARN authorizing nothing.
      for (const { actions, resources, conditions } of contextSourceGrant(entry)) {
        processorRole.addToPolicy(new iam.PolicyStatement({ actions, resources, conditions }));
      }
    }
    // The processor must be able to READ the catalog it resolves against. Granting the sources but not
    // the catalog parameter is the same failure this file's INV-CTX-CAT-3 comment describes, one level
    // up - and it fails the same way: the read denies, the code sees an empty catalog, and every
    // selected key logs "not in this classification's catalog" as though the PROFILE were wrong.
    // Found exactly that way on the live deployment.
    processorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/${classification}/context-sources`,
      ],
    }));
    new ssm.StringParameter(this, 'ContextSourcesCatalogParam', {
      parameterName: `${SSM_ROOT}/assistant/${classification}/context-sources`,
      // Published WITHOUT the arn, WITH the locator and prefix. The arn is the grant resource and is
      // the only field carrying an account and region, so stripping it keeps account identifiers out
      // of a parameter any principal with ssm:GetParameter on it can read. The locator and prefix
      // stay because the READER resolves them - that is what keeps the read at the same location the
      // grant above authorised. Stripping them forced the reader onto a hardcoded corpus path, so an
      // entry granted on a per-team prefix was read from somewhere else entirely.
      stringValue: JSON.stringify(contextSources.entries.map(publishableContextSource)),
      description:
        'Selectable context sources for this classification (SPEC-CONTEXT-SOURCES-AND-STORES): a profile.contextSources entry picks one by key.',
    });

    // ── Context source observability: dashboard + failure-RATE alarm (INV-CTX-CAT-7) ──────────
    //
    // The runtime counts every source's outcome, but a metric nobody watches is not a control. This
    // is the watching half, and it deploys with the grants it exists to police - same argument as
    // publish-and-grant above.
    //
    // A RATE, not an occurrence. Context sources resolve on every turn, so a broken grant fails
    // continuously; alerting per occurrence would email every admin once per user message. CloudWatch
    // does the 5-minute windowing, and because an alarm notifies on STATE TRANSITION it also does the
    // de-duplication - one message when it breaks, one when it clears.
    //
    // Opt-in via the admin notification channel: with nowhere to deliver to, an alarm is a light
    // nobody sees, and a dashboard is a monthly charge for a page nobody opens.
    if (props.adminErrorAlertChannelArn) {
      const thresholdPercent = Number(this.node.tryGetContext('contextSourceAlertThresholdPercent') ?? 10);
      // The floor that stops a quiet deployment paging on arithmetic: 1 failure in 2 attempts is 50%
      // and means nothing. Below this many attempts in the window the expression yields 0.
      const minAttempts = Number(this.node.tryGetContext('contextSourceAlertMinAttempts') ?? 20);

      const byClassification = { Classification: classification };
      const failed = new cloudwatch.Metric({
        namespace: CONTEXT_SOURCE_METRIC_NAMESPACE,
        metricName: 'ContextSourceFailed',
        dimensionsMap: byClassification,
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });
      const resolvedM = new cloudwatch.Metric({
        namespace: CONTEXT_SOURCE_METRIC_NAMESPACE,
        metricName: 'ContextSourceResolved',
        dimensionsMap: byClassification,
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

      // FILL(...,0) on both sides: a period with no failures emits no datapoint at all, and without
      // the fill the expression would go missing rather than reporting a healthy 0%.
      const failureRate = new cloudwatch.MathExpression({
        expression: `IF(FILL(mf,0)+FILL(mr,0) >= ${minAttempts}, 100*FILL(mf,0)/(FILL(mf,0)+FILL(mr,0)), 0)`,
        usingMetrics: { mf: failed, mr: resolvedM },
        label: `${classification} context source failure %`,
        period: cdk.Duration.minutes(5),
      });

      const dashboardName = `${RES_PREFIX}-${classification}-context-sources`;
      const alarmTopic = new sns.Topic(this, 'ContextSourceAlarmTopic', {
        displayName: `Context source failures (${classification})`,
      });

      const alarmFn = new lambdaNodeJs.NodejsFunction(this, 'ContextSourceAlarmFunction', {
        entry: path.join(__dirname, '../../lambda/src/context-source-alarm.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(30),
        environment: {
          ...errAlert.env,
          CLASSIFICATION: classification,
          CONTEXT_SOURCE_DASHBOARD: dashboardName,
        },
      });
      errAlert.grant(alarmFn.role!);
      alarmTopic.addSubscription(new snsSubscriptions.LambdaSubscription(alarmFn));

      const alarm = new cloudwatch.Alarm(this, 'ContextSourceFailureRateAlarm', {
        alarmName: `${RES_PREFIX}-${classification}-context-source-failure-rate`,
        alarmDescription:
          `More than ${thresholdPercent}% of context source reads failed over 5 minutes `
          + `(${classification}). A grant, a document, or the catalog parameter itself.`,
        metric: failureRate,
        threshold: thresholdPercent,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        // No traffic is not a failure. Without this the alarm would sit in INSUFFICIENT_DATA and, on
        // some configurations, page for it.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
      // Recovery goes to the same place. An alert that never says "fixed" trains people to ignore it.
      alarm.addOkAction(new cloudwatchActions.SnsAction(alarmTopic));

      // The dashboard the alert links to. Source keys are known at SYNTH time, so the per-source
      // widget names this deployment's actual catalog rather than making an operator guess.
      const sourceKeys = [...contextSources.entries.map((e) => e.key), '(catalog)'];
      const perSource = (metricName: string) => sourceKeys.map((key) => new cloudwatch.Metric({
        namespace: CONTEXT_SOURCE_METRIC_NAMESPACE,
        metricName,
        dimensionsMap: { Classification: classification, Outcome: 'denied', SourceKey: key },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
        label: key,
      }));

      new cloudwatch.Dashboard(this, 'ContextSourceDashboard', {
        dashboardName,
        widgets: [
          [
            new cloudwatch.GraphWidget({
              title: `Failure rate % (alarm at ${thresholdPercent}%, min ${minAttempts} attempts)`,
              left: [failureRate],
              leftAnnotations: [{ value: thresholdPercent, label: 'alarm', color: '#d13212' }],
              width: 12,
            }),
            new cloudwatch.GraphWidget({
              title: 'Resolved vs failed',
              left: [resolvedM, failed],
              width: 12,
            }),
          ],
          [
            new cloudwatch.GraphWidget({
              title: 'Failures by reason - denied is the security one',
              left: (['denied', 'absent', 'timeout', 'error'] as const).map((outcome) =>
                new cloudwatch.Metric({
                  namespace: CONTEXT_SOURCE_METRIC_NAMESPACE,
                  metricName: 'ContextSourceFailed',
                  dimensionsMap: { Classification: classification, Outcome: outcome },
                  statistic: 'Sum',
                  period: cdk.Duration.minutes(5),
                  label: outcome,
                })),
              width: 12,
            }),
            new cloudwatch.GraphWidget({
              title: 'Refusals by source - (catalog) means every source at once',
              left: perSource('ContextSourceFailed'),
              width: 12,
            }),
          ],
          [
            new cloudwatch.GraphWidget({
              title: 'Never attempted - sustained not-in-catalog is a profile naming a removed key',
              left: (['not-in-catalog', 'unavailable'] as const).map((outcome) =>
                new cloudwatch.Metric({
                  namespace: CONTEXT_SOURCE_METRIC_NAMESPACE,
                  metricName: 'ContextSourceSkipped',
                  dimensionsMap: { Classification: classification, Outcome: outcome },
                  statistic: 'Sum',
                  period: cdk.Duration.minutes(5),
                  label: outcome,
                })),
              width: 24,
            }),
          ],
        ],
      });
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
    const systemPromptParamName = `${SSM_ROOT}/assistant/${classification}/assistant-system-prompt`;
    const systemPromptParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${systemPromptParamName}`;
    if (topo.systemPromptParam) {
      // CONFIG GUARD: an empty persona silently falls back to the generic default (off-brand). Warn
      // loudly at synth rather than let it be discovered via a bad conversation.
      const systemPromptValue = (this.node.tryGetContext('assistantSystemPrompt') as string) || '';
      if (!systemPromptValue.trim()) {
        cdk.Annotations.of(this).addWarning(
          `[${classification}] assistantSystemPrompt is EMPTY - the assistant will use the generic default persona ` +
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
      PROFILE_NAME: classification,
      BATTLE_ELIGIBLE: String(defaultProfileRegistry.profileFor(classification).battleEligible ?? false),
      MAX_TOKENS: String(topo.maxTokens),
      MODEL_ID: profileModel.bedrockModelId,
      MODEL_NAME: profileModel.displayName,
      AWS_ACCOUNT_ID: this.account,
      CONTEXT_BUCKET: props.attachmentsBucketName,
      GUARDRAIL_ID: guardrail.guardrailId,
      GUARDRAIL_VERSION: guardrail.guardrailVersion,
      TASKS_TABLE: shared.agentTasksName,
      USER_TASKS_TABLE: shared.userTasksName,
      // The PROCESSOR needs this too, not just the router. The router reads the profile store for the
      // once-per-user onboarding gate; the processor reads it to resolve a `user-profile` CONTEXT
      // SOURCE on a real turn (SPEC-CONTEXT-SOURCES-AND-STORES). Without the table name here the catalog
      // grant exists, the key publishes, and the reader silently resolves nothing - the published-key/
      // absent-wiring shape this spec's INV-CTX-CAT-3 exists to prevent, one level up from IAM.
      USER_PROFILE_TABLE: shared.userProfileName,
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
      processorEnv.BOT_ARN_PARAM = botArnKey(classification);
      processorEnv.BATTLE_IMAGE_GUARDRAIL_ID = imageGuardrail!.guardrailId;
      processorEnv.BATTLE_IMAGE_GUARDRAIL_VERSION = imageGuardrail!.guardrailVersion;
      // Per-region guardrails for models Bedrock pins outside the deploy region. `toJsonString`
      // rather than JSON.stringify: these ids are cross-region CloudFormation tokens, and only the
      // CDK-aware serializer emits them as a resolvable Fn::Join instead of "${Token[...]}".
      // The deploy region is included from the local guardrail so one map answers every region.
      processorEnv.BATTLE_IMAGE_GUARDRAIL_BY_REGION = this.toJsonString({
        [this.region]: { id: imageGuardrail!.guardrailId, version: imageGuardrail!.guardrailVersion },
        ...(props.imageGuardrailByRegion ?? {}),
      });
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
    // SPEC-PORTABLE-PROFILES P0/P2/§7: the processor resolves its OWN active profile version
    // (P0), and — for a /battle profileRef variant — reads OTHER profiles' versions (P2), so grant read
    // across the whole assistant-definition namespace. READ-ONLY: the write path (PutParameter/label on
    // /assistant/*) belongs ONLY to the manage-profiles role; reading a definition is behavior, not a
    // boundary (§7), so a broad read never escalates. Absent param ⇒ the resolver fails closed to the seed.
    const definitionsReadArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/definition`;
    asyncProcessor.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter', 'ssm:GetParameterHistory'], resources: [definitionsReadArn] }));
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
      // Footgun guard: imageGen wires the guardrail + bucket UNCONDITIONALLY above, but external providers
      // (OpenAI/FAL) need a key. If none is wired at synth, /battle image generation-out with an external
      // model silently honest-empties (no auth). Warn loudly so an image-enabled deploy can't quietly ship
      // without the keys (the exact way external image battles broke: guardrail present, keys dropped).
      if (!igKeysSecretArn && !process.env.OPENAI_API_KEY && !process.env.FAL_KEY) {
        cdk.Annotations.of(this).addWarning(
          `imageGen is enabled for '${classification}' but no external image-gen provider key is wired. ` +
            `Set -c imageGenKeysSecretArn=<secret-arn> (JSON of {OPENAI_API_KEY, FAL_KEY}) or export ` +
            `OPENAI_API_KEY / FAL_KEY at deploy time — otherwise /battle image generation-out with an ` +
            `external provider cannot authenticate and produces no image (Bedrock image models still work).`,
        );
      }
    }

    new ssm.StringParameter(this, 'ProcessorArnParam', {
      parameterName: processorArnKey(classification),
      stringValue: asyncProcessor.functionArn,
      description: `Async-processor ARN for ${classification} classification`,
    });
    // The handler READS this param on every turn (resolveAsyncProcessorArn), so it must be granted
    // below. Without the grant the read fails AccessDenied and silently falls back to the
    // *_ASYNC_PROCESSOR_ARN env var: turns still work, so nothing looks broken, but the indirection
    // this param exists for — re-pointing a classification at a different processor WITHOUT
    // redeploying the handler — never takes effect, and every turn logs an IAM stack trace that
    // trains the reader to ignore AccessDenied.
    const processorArnParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${processorArnKey(classification)}`;

    // ── Per-deployment intent taxonomy (intentPackParam profiles) + onboarding-intake (all) ──
    const intentPackParamName = `${SSM_ROOT}/assistant/${classification}/assistant-intent-pack`;
    const intentPackParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${intentPackParamName}`;
    const onboardingIntakeParamName = `${SSM_ROOT}/assistant/${classification}/onboarding-intake`;
    const onboardingIntakeParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${onboardingIntakeParamName}`;
    // Welcome orientation (all profiles): optional per-assistant SSM param the deployment writes
    // (company/access/examples) to give a first-time user context. Absent ⇒ generic welcome. The
    // handler reads it on the WelcomeIntent path; the demo seed writes it (see seed-demo.ts).
    const welcomeParamName = `${SSM_ROOT}/assistant/${classification}/welcome-orientation`;
    const welcomeParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${welcomeParamName}`;
    if (topo.intentPackParam) {
      const intentPackJson = (this.node.tryGetContext('assistantIntentPack') as string) || '';
      // Only systemPromptParam profiles (standard) warn on an empty pack — basic ships the generic
      // default intents silently (keyword task intents already emit).
      if (!intentPackJson.trim() && topo.systemPromptParam) {
        cdk.Annotations.of(this).addWarning(
          `[${classification}] assistantIntentPack is EMPTY - the classifier will use the generic default intents. ` +
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
    // The SHARED router (router-agent-handler.ts) is deployed PER PROFILE. CLASSIFICATION=<profile> makes it skip
    // classification discovery (it IS the profile), act as this profile's bot, enforce
    // min(senderClearance, profile) via Cognito, resolve experiments, create/continue tasks, and
    // dispatch to THIS profile's async-processor. Live drift (Aurora) is wired in Aurora mode (all-profile).
    const drift = props.auroraDriftHookup ? auroraDriftWiring(this, classification, props.auroraDriftHookup) : undefined;

    // Additional trusted IdP pools for a MULTI-IDP deployment, read from the same context key the
    // notification fan-out uses. Empty on a single-IdP deployment, which is the default.
    const additionalUserPoolIds = ((this.node.tryGetContext('notifyAdditionalUserPoolIds') as string | undefined) || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const handlerRole = new iam.Role(this, 'AgentHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        // The handler READS channel classification metadata, member count and recent messages, and
        // SENDS its own acknowledgment on a bypass turn (ADR-025).
        //
        // WHY IT SENDS. The handler already composes the acknowledgment text (`getQuickResponse` /
        // `getTaskPlaceholder`, resolved from the profile version it loaded), so before this the words
        // were authored here and the ACT was performed elsewhere - by Chime on the Lex path, by the
        // channel flow on a bypass. One profile-resolved behaviour reaching the channel by two routes
        // is the divergence class the `@all` and round-1 handoffs exist to remove. The Lex path is
        // unchanged and still materialises from the fulfillment return; this grant covers the bypass
        // turns, where the assistant now speaks its own acknowledgment.
        //
        // The grant goes through `classificationChannelScopedAllow`, which layers the archived-channel
        // read-only Deny automatically because `chime:SendChannelMessage` is in
        // `ARCHIVE_DENIED_ACTIONS`. That is asserted by a test rather than left to the helper, because
        // protection that arrives as a side effect is what disappears quietly when the helper is
        // bypassed.
        //
        // `ListChannelMessages` is here so the drift flow can resolve the MessageId of the message that
        // triggered it: Chime does not send `CHIME.message.id` as a Lex request attribute, so the id is
        // read back from the channel and matched on the exact text being handled. Without it the
        // resolution is denied and
        // swallowed by its own catch, and the new conversation's link back can only anchor to the
        // conversation rather than the message. Still classification-scoped through the same helper, so a
        // classification cannot read another's channels.
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            // `GetChannelMessage` is here for the 1:1 `@all` fall-through: the attachment rides the
            // message Metadata, which Lex never passes, so the one entry that answers reads the
            // stored message back. Read-only, and classification-scoped through the same helper.
            ...classificationChannelScopedAllow(classification, props.appInstanceArn, ['chime:DescribeChannel', 'chime:ListChannelMemberships', 'chime:ListChannelMessages', 'chime:GetChannelMessage', 'chime:SendChannelMessage'], { bearerResources: [`${props.appInstanceArn}/bot/*`] }),
            // Read the immutable `classification` tag to resolve the served profile. A tag-READ cannot
            // itself be gated (it is how the profile is learned) — read-only, discloses only the tag.
            new iam.PolicyStatement({ actions: ['chime:ListTagsForResource'], resources: [`${props.appInstanceArn}/channel/*`] }),
            // ADR-012 drift scoping: ask the messaging service which channels ALL of this
            // conversation's human members belong to (`SearchChannels`, MEMBERS…INCLUDES), instead of
            // reconstructing that intersection from the Aurora archive, which lags exactly when
            // membership has just changed. A search is an app-instance operation, so it cannot carry
            // the per-channel tag condition the statement above uses — the BEARER is what bounds it.
            //
            // The bearer is a HUMAN member, not the bot: the service requires the searching
            // AppInstanceUser's own ARN to appear in the MEMBERS filter, and rejects a bot bearer
            // outright (`AppInstanceUser must include its own ARN for MEMBERS field`, verified live).
            // The search therefore only ever sees channels that member already belongs to.
            new iam.PolicyStatement({
              actions: ['chime:SearchChannels'],
              resources: [props.appInstanceArn, `${props.appInstanceArn}/user/*`],
            }),
          ],
        }),
        BedrockPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: classificationModelArns }),
        ] }),
        SSMPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${botArnKey(classification)}`] }),
          // SPEC-PORTABLE-PROFILES P2/§6: the router resolves an A/B profileRef variant to the
          // referenced profile version's model — READ-ONLY on the assistant-definition namespace (reading a
          // definition is behavior, not a boundary, §7). Writes stay exclusive to the manage-profiles role.
          new iam.PolicyStatement({ actions: ['ssm:GetParameter', 'ssm:GetParameterHistory'], resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/definition`] }),
        ] }),
        DynamoDBPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({
            actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan'],
            resources: [
              shared.agentTasksArn, `${shared.agentTasksArn}/index/*`,
              shared.userTasksArn, `${shared.userTasksArn}/index/*`,
              // Per-user profile store: the router reads it on WelcomeIntent (once-per-user onboarding
              // gate) and writes it when the intake completes. Built-in stand-in; unused when an
              // implementer swaps in their own store via USER_PROFILE_SERVICE_ARN.
              shared.userProfileArn,
              shared.experimentsArn,
              ...(topo.handlerExperimentsIndex ? [`${shared.experimentsArn}/index/*`] : []),
              ...(battle ? [battle.battleStateArn, `arn:aws:dynamodb:${this.region}:${this.account}:table/${battle.channelBattleConfigName}`] : []),
            ],
          }),
          // Channel Context store: GetItem for per-turn grounding, plus UpdateItem because this Lambda is
          // also a conversation-CREATING path.
          //
          // The boundary here used to be read-only, on the rule that "writes belong to the create Lambdas".
          // That rule assumed creation happens only in a create Lambda, and the drift-confirm flow breaks the
          // assumption: it creates channels from inside this handler (`lib/channel-creation.ts`), and now
          // enrolls the assistant so the new conversation gets the same composed welcome as any other. That
          // welcome reads the participant shape, which must be written BEFORE the channel exists
          // (SPEC-USER-PROFILE-AND-ONBOARDING §2), so the write has to be possible from here.
          //
          // Still narrow, and deliberately not the broad set: one GetItem and one UpdateItem are the only
          // operations any caller in this Lambda performs. No PutItem (which would replace a whole item
          // rather than patch owned fields), no Delete, no Scan or Query. The alternative — moving drift
          // channel creation into a create Lambda, which `channel-creation.ts`'s own TODO proposes — keeps
          // the original boundary and is the better end state; this grant is what makes the welcome correct
          // in the meantime rather than silently degraded.
          new iam.PolicyStatement({
            actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
            resources: [shared.channelContextArn],
          }),
        ] }),
        // AdminGetUser is granted on the FULL set of trusted pools, not just this deployment's own:
        // the participant roster the prompt grounds on comes from live membership, and a FEDERATED
        // member's name lives in their home IdP's pool. Same set, same context key
        // (`notifyAdditionalUserPoolIds`) and same trust boundary as the notification fan-out. With
        // no additional pools configured this is exactly the single-pool grant it always was.
        CognitoReadPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({
            actions: ['cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser'],
            resources: [...new Set([shared.cognitoUserPoolId, ...additionalUserPoolIds])].map(
              (poolId) => `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${poolId}`,
            ),
          }),
        ] }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    if (drift) {
      drift.grantTo(handlerRole);
      for (const stmt of driftChannelCreateStatements(classification, props.appInstanceArn, this.region, this.account)) {
        handlerRole.addToPolicy(stmt);
      }
      // The ASYNC PROCESSOR needs the same data-plane access as the handler, because the first-turn
      // summary seed runs there: it is the only component holding BOTH the user message and the
      // assistant's reply at the moment the reply is produced. The handler dispatches and returns, so
      // it never sees the answer.
      //
      // Without this the seed is silently inert - `seedConversationSummary` gates on hasDataPlane(),
      // which reads AURORA_DATA_PLANE_ARN, so an unwired processor no-ops with no error and drift
      // never gets its turn-one anchor. Verified live: all three AsyncProcessors had the variable
      // unset while the handlers had it, so a green deploy shipped a feature that did nothing.
      for (const [key, value] of Object.entries(drift.env)) {
        asyncProcessor.addEnvironment(key, value);
      }
      if (asyncProcessor.role) drift.grantTo(asyncProcessor.role);
    }
    // Handler SSM reads: the onboarding-intake schema (all profiles) + the intent pack (intentPackParam
    // profiles). The bot-arn read is in the inline SSMPolicy above; these ride the role's default policy
    // (effective grant is identical regardless of grouping).
    handlerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          onboardingIntakeParamArn,
          welcomeParamArn,
          processorArnParamArn,
          // THE ALT-BOT SLOT ROSTER. `isSanctionedBattleBot` reads it to validate a caller-supplied bot
          // identity on a `/battle` turn, and it FAILS CLOSED: without this grant the read throws
          // AccessDenied, every alt-slot identity is rejected, and both sides of a duel answer as the
          // classification's own bot. The duel still runs, which is why this shipped inert and was only
          // caught by the backend-error guard on a live run (`[battle-turn] alt-bot roster unreadable`).
          //
          // Read-only, and it is a ROSTER of sanctioned ARNs - reading it is how the boundary is
          // enforced, not a widening of it.
          `arn:aws:ssm:${this.region}:${this.account}:parameter${INSTANCE_SSM.altBotSlotsRoster}`,
          ...(topo.intentPackParam ? [intentPackParamArn] : []),
        ],
      }),
    );

    // The router resolves the ACTIVE profile version too (its classifier model is per-profile,
    // SPEC-ASSISTANT-CONFIG §4 U2b), and an active version's persona lives in S3 behind a pointer.
    // Without the bucket env + grant, `hydrateBodies` failed on the router, `resolveActiveProfile`
    // fail-closed to the compiled seed with only a console.warn, and the router classified with the
    // deployment default forever while the processor ran the activated version. The grant is
    // `profiles/*` ONLY - the router gets none of the processor's classification-scoped context
    // prefixes.
    handlerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`${props.attachmentsBucketArn}/profiles/*`],
      }),
    );

    const handlerEnv: Record<string, string> = {
      CLASSIFICATION: classification,
      PROFILE_BODY_BUCKET: props.attachmentsBucketName,
      ...(drift?.env ?? {}),
      ...(drift ? { CHANNEL_FLOW_ARN_PARAM: CHANNEL_FLOW_ARN_SSM_KEY } : {}),
      SSM_ROOT,
      ONBOARDING_INTAKE_PARAM: onboardingIntakeParamName,
      ASSISTANT_WELCOME_PARAM: welcomeParamName,
      BOT_ARN_PARAM: botArnKey(classification),
      // Named explicitly rather than left to `battle-turn.ts`'s hardcoded fallback. The fallback is
      // `/agent-echelon/alt-bot-slots/roster`, which is only correct while SSM_ROOT is the default - a
      // deployment that sets its own root would read a parameter that does not exist, fail closed, and
      // silently run every duel with one bot answering as both sides.
      ALT_BOT_SLOTS_ROSTER_PARAM: INSTANCE_SSM.altBotSlotsRoster,
      [`${classification.toUpperCase()}_ASYNC_PROCESSOR_ARN`]: asyncProcessor.functionArn,
      APP_INSTANCE_ARN: props.appInstanceArn,
      AWS_ACCOUNT_ID: this.account,
      USER_POOL_ID: shared.cognitoUserPoolId,
      // Which OTHER pools a federated member's name may be resolved from. Absent on a single-IdP
      // deployment; the router then queries only `USER_POOL_ID` and leaves anyone else unnamed
      // rather than guessing at a pool.
      ...(additionalUserPoolIds.length ? { NOTIFY_ALLOWED_POOL_IDS: additionalUserPoolIds.join(',') } : {}),
      // Intent classification is a cheap, high-frequency call — always Haiku (on-demand-capable), never
      // the profile primary (a bare on-demand id for Opus/Sonnet is rejected by Bedrock).
      CLASSIFIER_MODEL_ID: modelCatalog['haiku'].bedrockModelId,
      TASKS_TABLE: shared.agentTasksName,
      USER_TASKS_TABLE: shared.userTasksName,
      // Built-in per-user profile store (once-per-user onboarding gate + durable facts). An implementer
      // can leave this and instead set USER_PROFILE_SERVICE_ARN to reach their own store; the client
      // prefers the ARN when present. See SPEC-USER-PROFILE-AND-ONBOARDING.md.
      USER_PROFILE_TABLE: shared.userProfileName,
      CHANNEL_CONTEXT_TABLE: shared.channelContextName,
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
    // THE HANDOVER INVOKES THIS SAME FUNCTION as the assistant that owns the chain.
    //
    // A message answers the TASK, not whoever it was addressed to, so an assistant that receives one it
    // does not own hands the turn to the one that does (rule 1, owner 2026-08-14). It cannot be sent as
    // a message: ADR-023 measured that Amazon Chime SDK does not deliver a bot-authored message to
    // another bot's Lex, so it would reach nobody.
    //
    // SELF is the whole target set, not a shortcut. Every identity this handler may answer as is one
    // `isSanctionedBattleBot` sanctions - this classification's own bot, or an alt slot - and this
    // function serves all of them, so the grant is exactly as wide as the sanction check.
    //
    // ITS OWN POLICY RESOURCE, not the role's default one, and that is the whole trick.
    //
    // `grantInvoke` puts the statement on the role's DEFAULT policy, which CDK makes the function
    // depend on - so a statement naming the function closes a cycle (default policy -> function ->
    // default policy) and the template will not deploy at all. A policy of its own carries no such
    // dependency, so it can reference the function's real ARN.
    //
    // The alternative - a name PATTERN, which is what the battle stack must use across stacks - is not
    // good enough here, and the reason is worth keeping: CloudFormation truncates the stack name when
    // the generated physical name would exceed 64 characters, so this handler is really
    // `AgentEchelonClassification-Pr-AgentHandler...`, and a pattern built from the full stack name
    // matches nothing. That grant deploys clean and denies at runtime.
    new iam.Policy(this, 'AgentHandlerSelfInvoke', {
      roles: [handlerRole],
      statements: [new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [agentHandler.functionArn],
      })],
    });
    abuse.grant(handlerRole);
    // `sourceAccount` is the confused-deputy condition, and it is load-bearing rather than hygiene.
    //
    // A Lex fulfillment code hook controls the request attributes it sends, and `isFlowEntry(event)`
    // reads one of them (`AE.entry`) to decide whether this turn came from the channel flow. Since
    // ADR-025 that flag no longer selects a response SHAPE - it gates whether the handler POSTS A
    // MESSAGE ITSELF, as a resolved bot identity (`postAsAssistant`). Without this condition the
    // resource policy accepts the Lex SERVICE principal from ANY account, so a Lex bot outside this
    // account could set that attribute and reach the authorship path. Scoping to this account closes
    // the only route by which the `isFlowEntry` gate can be reached from outside the two sanctioned
    // callers (the channel flow and the battle orchestrator, both identity-based grants).
    //
    // IAM still bounds the damage either way - the send is classification-tag-scoped, bearer-restricted
    // to `/bot/*`, and carries the archived-channel Deny - but "bounded impersonation" is not the
    // boundary this should rest on.
    new lambda.CfnPermission(this, 'AgentHandlerLexInvoke', {
      action: 'lambda:InvokeFunction',
      functionName: agentHandler.functionName,
      principal: 'lexv2.amazonaws.com',
      sourceAccount: this.account,
    });
    const handlerArn = agentHandler.functionArn;

    // Publish the router/AgentHandler ARN (like processor-arn) so the admin console can deep-link to this
    // classification's Lex-fulfillment/classification Lambda for troubleshooting (SPEC-ASSISTANT-CONFIG).
    new ssm.StringParameter(this, 'RouterArnParam', {
      parameterName: routerArnKey(classification),
      stringValue: agentHandler.functionArn,
      description: `Router/AgentHandler ARN for ${classification} classification`,
    });

    // ── Lex bot + AppInstanceBot (per profile) ──────────────────────────────

    // CONVERSATION LOGS: THE ONLY INSTRUMENT THAT CAN SEE A DUPLICATE FULFILLMENT'S ORIGIN.
    //
    // One user message sometimes produces TWO fulfillments of the same turn. `lib/correlation.ts`
    // measured what it is NOT - not a timeout (a turn duplicated at 3055ms while six slower ones, to
    // 4222ms, did not), and not initiated by this codebase, because nothing here invokes the router:
    // Lex does. It concludes that confirming the trigger "needs Lex conversation logs", and until now
    // there were none, on any deployment, so the question could not be asked at all.
    //
    // Text logs only. Audio does not apply (this is a messaging bot with no speech), and text logs
    // record the request/response pair per invocation - which is exactly what distinguishes ONE Lex
    // invocation that our handler ran twice from TWO Lex invocations of the same turn.
    //
    // Retention is short on purpose: this is a diagnostic instrument for an open investigation, not an
    // audit trail. The immutable S3 conversation archive is the record of what was SAID; this only
    // records how many times Lex asked.
    const lexConversationLogGroup = new logs.LogGroup(this, 'LexConversationLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

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
    // Conversation logs are written by LEX under the BOT's role, not by the provisioning Lambda under
    // its own. Granting the wrong one leaves the alias configured and the log group permanently empty,
    // which reads as "no duplicates" - the failure mode this whole investigation is trying to avoid.
    lexConversationLogGroup.grantWrite(lexBotRole);

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
        LEX_CONVERSATION_LOG_GROUP_ARN: lexConversationLogGroup.logGroupArn,
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
      properties: {
        tier: classification, // `tier` property key is the create-lex-bot custom-resource contract (PR5b)
        botName: `Assistant-${classification}`,
        // THE LOG GROUP IS A PROPERTY SO THE RESOURCE ACTUALLY RE-RUNS.
        //
        // CloudFormation invokes a Custom Resource on Update only when its PROPERTIES change. Changing
        // the provider Lambda's CODE does not do it. The first attempt at conversation logs shipped
        // exactly that way: the handler learned to configure them, the stack updated successfully, no
        // Update event was ever sent, and `describe-bot-alias` returned
        // `conversationLogSettings: null`. Green deploy, nothing applied.
        //
        // Passing the ARN makes the property change when the log group appears or moves, which is
        // precisely when the alias needs reconfiguring. It also documents the dependency: this
        // resource's configuration depends on that log group.
        conversationLogGroupArn: lexConversationLogGroup.logGroupArn,
      },
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
        BOT_NAME: `Assistant-${classification}`,
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

    new ssm.StringParameter(this, 'ClassificationBotArnParam', {
      parameterName: botArnKey(classification),
      stringValue: this.appInstanceBotArn,
      description: `AppInstanceBot ARN for ${classification} classification — read by create-conversation`,
    });

    new cdk.CfnOutput(this, 'ClassificationAsyncProcessorArn', { value: asyncProcessor.functionArn });
    new cdk.CfnOutput(this, 'ClassificationAppInstanceBotArn', { value: this.appInstanceBotArn });

    cdk.Tags.of(this).add('Component', topo.componentTag);
    cdk.Tags.of(this).add('Classification', classification);
  }
}
