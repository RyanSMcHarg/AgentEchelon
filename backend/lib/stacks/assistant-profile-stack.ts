/**
 * AssistantsStack: the one parametrized, independently deployable stack that serves a classification's
 * assistants (SPEC-CAPABILITY-PROFILES, ADR-057). `bin/backend.ts` creates one `Assistants-<classification>`
 * stack for each classification the profile registry declares with a `topology` (`lib/config/profiles.ts`),
 * so adding a classification adds its stack without a new file.
 *
 * The registry's `AssistantTopology` makes the divergence between classifications data:
 *   - model selection, Lambda sizing (timeout/memory/concurrency), response limit;
 *   - `contextRouting` (external/CN model path + secret), `systemPromptParam` (persona SSM),
 *     `intentPackParam` (custom intent taxonomy), `richProcessor` (multi-turn tasks + docs +
 *     experiments + attachment-in),
 *     `streaming`. Neither image generation nor /battle is a topology field: image generation is wired
 *     where the model catalog allows the classification an image model (`imageModelsAllowedFor`), and
 *     /battle where the classification is `battleCapable` and the deployment declares `battle`, so the
 *     plumbing and the runtime read one source.
 *
 * Ownership: a classification's team owns its registry entry, and the shared body here is reviewed
 * platform-side. Classification isolation is IAM, not Lambda logic: company context (`context/`) is granted
 * on the classification's acting role only as statements conditioned on the session's `role` tag
 * (`roleContextStatements`), never unconditionally to every assistant of the classification. The shared
 * platform contract (tasks tables, and the experiments and battle tables when those capabilities are
 * declared) resolves via SSM dynamic refs (not Fn::importValue), so the assistant stacks deploy decoupled.
 */

import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { dataRemovalPolicy } from '../config/environment';
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
// The image-model grant is DERIVED from the classification's model selection (`models`), the same list the
// write path and the resolver read, so a classification is granted exactly the image models it selects.
import { imageModelArnsForClassification, externalImageKeyFieldsFor, IMAGE_GEN_MODELS } from '../../lambda/src/lib/image-gen-models';
import { classificationEnvName } from '../../lambda/src/lib/classification-env';
import { getModelCatalog, bedrockInvokeId, INTENT_ROUTE_STRATEGY, UTILITY_MODEL_ID, utilityModelArns, type BackendModelKey } from '../config/model-strategy';
import { EXTERNAL_MODELS } from '../config/model-catalog';
import { DEFAULT_IMAGE_MODEL } from '../../lambda/src/lib/active-profile';
// A classification's intent pack is a body on the shared store, keyed under that classification.
import { classificationPackKey, classificationPackPrefix, contentIdOf } from '../../lambda/src/lib/profile-bodies';
import { templatesDeclaredFor } from '../config/default-templates';
import { DefaultTemplateWriter } from '../constructs/default-template-writer';
import { MAX_INTENT_PACK_BYTES, packPointerValue, parseIntentPack, taskStateMachines } from '../../lambda/src/lib/intent-pack';
import { machineCatalogConditionErrors } from '../../lambda/src/lib/task-state-machines';
import { buildSourceTable, catalogEntryForVariables, sourceLookup, type VariableCatalogEntry } from '../../lambda/src/lib/variables';
import { imageModelsAllowedFor, modelAllowedFor } from '../config/model-availability';
import { CONVERSATION_TYPES, classificationAllowedForType, membershipSourceGroups } from '../config/conversation-types';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import { defaultProfileRegistry } from '../profile-registry';
import type { AssistantTopology } from '../config/profiles';
import { grantDirectoryRead } from '../constructs/directory-access';
import { incidentWatchAlarmPrefixes, incidentWatchPattern, wireEventOpenedConversations } from '../constructs/event-opened-conversations';
import { eventOpenersAt, openerWatchesAlarms } from '../config/event-openers';
import { issuersOf } from '../constructs/trusted-issuers';
import { ExchangeRole, vendedClassifications } from '../constructs/exchange-role';
import { clearanceGroups } from '../constructs/clearance-groups';
import { ConversationCreator, typedCreatorName } from '../constructs/conversation-creator';
import { ClassificationArchiveFunctions } from '../constructs/classification-archive-functions';
import { userProfileServiceArn } from '../config/issuers';
import { assertTypeGroupsRequireTheirClassifications } from '../conversation-type-grants';
import { assertParticipantRolesAreDeclared, roleGroups } from '../config/participant-roles';
import { PLATFORM_EVENT_WORKFLOWS, eventWorkflowRoleWarnings } from '../../lambda/src/lib/event-workflow';
import { attachBattle, attachExperiments } from './classification-capabilities';
import { publishRegistryRow } from '../constructs/registry-row';
import { DeclaredAssistantsSeed, type DeclaredAssistant } from '../constructs/declared-assistants-seed';
import {
  classificationChannelScopedAllow,
  assistantActingRole,
  allowContextSourceObjects,
  turnRoutingTableName,
  vendArnKey,
  ASSISTANT_TURN_CHANNEL_ACTIONS,
  contextPrefixesAllowedFor,
  modelArnsForClassification,
  resolveSharedSSM,
  alertEmitterWiring,
  abuseControlsWiring,
  turnQueueWiring,
  battleResourcesOf,
  experimentsResourcesOf,
  botArnKey,
  processorArnKey,
  routerArnKey,
  ASSISTANT_ROLES,
  assistantRolesFor,
  taskServiceArnKey,
  Classification,
  auroraDriftWiring,
  AuroraDriftHookup,
  MessageAnalyticsWiring,
  wireMessageAnalytics,
  driftChannelCreateStatements,
  membershipAsAssistantStatements,
  sayThroughRouterWiring,
  CHANNEL_FLOW_ARN_SSM_KEY,
  RES_PREFIX,
  SSM_ROOT,
  STACK_PREFIX,
  INSTANCE_SSM,
  speakAsAssistantStatements,
  speakAsAssistantEnv,
  assistantGrantCatalog,
  SHARED_SSM,
  tagAudience,
  messageTemplateReadStatements,
} from './agent-classification-common';
import { invitationIndexReadStatement, invitationRecordReadStatement, leadingKeysFor } from '../constructs/token-store';
import { DEADLINE_METRIC_NAMESPACE, DEADLINE_SCHEDULE_FAILED_METRIC } from '../../lambda/src/lib/event-workflow';
import { alarmNamesPathOf } from '../constructs/alarm-names';

/** The topology the shared body reads: the registry's, plus the classification it serves. */
type ResolvedTopology = AssistantTopology & {
  /** The classification value this stack serves (basic/standard/premium), used as the SSM segment.
   *  NOT a profile name: the profile (e.g. `concierge`) is resolved from it via `requireProfileFor`
   *  (`profile-registry.ts`), and `validateProfilesConfig` (`config/profiles.ts`) rejects any profile
   *  named after a classification. */
  name: string;
  /** CloudFormation Component tag value: the stack's own name, `Assistants-<classification>`. */
  componentTag: string;
};


/** The stack name, without the instance prefix, that serves a classification's assistants. */
export function assistantsStackName(classification: string): string {
  return `Assistants-${classification}`;
}

export interface AssistantsStackProps extends cdk.StackProps {
  /** The classification this stack serves. Its topology is read from the profile registry. */
  classification: string;
  /** Shared Chime AppInstance ARN (from AgentEchelonMessaging). */
  appInstanceArn: string;
  /** Shared attachments bucket holding context/{classification}/*.json (from AgentEchelonConversations). */
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
  /**
   * The deployment declares `battle`: wire the /battle plumbing (only where the classification is
   * battleCapable). Absent means the Battle stack is not deployed and this stack builds none of it.
   */
  battle?: boolean;
  /**
   * The deployment declares `experiments`: resolve the experiments table the Experiments stack
   * publishes, and grant and pass it. Absent means there is no Experiments stack, so neither the
   * grant nor `EXPERIMENTS_TABLE` exists and every turn serves the assistant's active version.
   */
  experiments?: boolean;
  /**
   * The capabilities the deployment declares: an observability role reads the alarms of their stacks beside the
   * core's, each capability's read its own policy (`assistantActingRole`). Absent reads the core's alone.
   */
  capabilities?: readonly string[];
  /**
   * The archive in Aurora mode: the classification's own turn data plane and classifier replay are built here,
   * and live drift wires the router to its own turn data plane. Absent in Athena mode.
   */
  auroraDriftHookup?: AuroraDriftHookup;
  /** Out-of-band per-message analytics table (Aurora mode only). */
  messageAnalytics?: MessageAnalyticsWiring;
  /**
   * The credential exchange's own role (Identity), the one principal this classification's vend role trusts.
   * Absent (a stack built on its own, in a test of another of its parts), no vend role is built here.
   */
  credentialExchangeRoleArn?: string;
}

/**
 * WHAT A CAPABILITY'S PART IN THIS CLASSIFICATION IS BUILT ON. Where `experiments` and `battle` are declared,
 * this stack builds its own part in them on these (`attachExperiments`, `attachBattle`,
 * `classification-capabilities.ts`): the grants on the capability's tables on its roles, and each duel's alt
 * through its two provisioners. So declaring a capability adds those resources here and changes none this stack
 * had, and no capability stack names a classification (STACKS.md, additivity).
 */
export interface AssistantAttachPoints {
  classification: string;
  /** The role every assistant of the classification acts through, one tagged session per turn. */
  actingRole: iam.IRole;
  /** The router's (the Amazon Lex fulfillment handler's) role. */
  handlerRole: iam.IRole;
  /** Whether the processor runs the full tool loop (the topology's `richProcessor`), which battle and experiments use. */
  richProcessor: boolean;
  /** Whether the router queries the experiments table's indexes (`handlerExperimentsIndex`). */
  handlerExperimentsIndex: boolean;
  /** Whether a duel can run in this classification and the deployment declares `battle`. */
  battleWired: boolean;
}

export class AssistantsStack extends cdk.Stack {
  public readonly asyncProcessorArn: string;
  /** The declared primary's identity, read from the seed's answer: the provisioner's, never this stack's. */
  public readonly appInstanceBotArn: string;
  /** What this classification's part in `experiments` and `battle` is built on. */
  public readonly attachPoints: AssistantAttachPoints;

  /**
   * THE ROLES THIS STACK BUILDS: every role the classification declares, and nothing beside the declaration
   * decides it. A deployment declares a shipped classification's role by naming its assistant in `profiles`
   * (`ops-premium`, `shippedProfilesSelection`), so adding a role is a deploy of this stack and removing it
   * is the same deploy without the name (`npm run add-assistant-role`).
   *
   * A ROLE AND THE ASSISTANTS FILLING IT ARE SEPARATE: the role's reach is this stack's (its acting-role statements
   * and its role publications), and an assistant filling it is data. So withdrawing a role is refused while any
   * assistant, declared or created in the console, still fills it (the seed's provisioner names them), and once
   * they are retired in the console the withdrawal releases the declared one's name, so declaring the role again
   * seeds it afresh (`lib/declared-assistants.ts`). Alts are declared for the platform `ASSISTANT_ROLES` only,
   * where battle is wired, so no alt is ever made for a role added here.
   *
   * WHAT REMOVAL DOES NOT UNDO is conversation history: turns the role already answered stay in the
   * archive, attributed to an assistant that no longer exists. That is correct - the archive is the
   * record of what happened - and it is why the analytics dimension is the assistant NAME rather than
   * a pointer to a live resource.
   */
  private deployedRoles(classification: string): string[] {
    return assistantRolesFor(classification);
  }

  constructor(scope: Construct, id: string, props: AssistantsStackProps) {
    super(scope, id, props);

    const topo: ResolvedTopology = {
      ...defaultProfileRegistry.requireTopology(props.classification),
      name: props.classification,
      componentTag: assistantsStackName(props.classification),
    };
    // The agent-classification-common helpers are typed to the built-in Classification union, and
    // `topo.name` is a classification value of that union, never a profile name. A deployment-defined
    // classification would widen this. Cast keeps the shared boundary helpers strongly typed for the shipped set.
    const classification = topo.name as Classification;
    // MAY THIS PROFILE READ AN ATTACHED FILE? Declared once in `config/profiles.ts` and read here for
    // both the S3 grant and `ATTACHMENTS_BUCKET`, so the thing that ENFORCES it and the thing that
    // ADVERTISES it are the same fact. Absent reads false: a profile that never considered the
    // question is not handed the grant.
    const attachmentsReadable =
      defaultProfileRegistry.requireProfileFor(classification).attachmentsReadable === true;
    // THE DOCUMENT TEMPLATES THIS CLASSIFICATION'S WORKFLOWS DECLARE (SPEC-DOCUMENT-TEMPLATES FR2), derived
    // from the intents it serves and the machines they select (`templatesDeclaredFor`). Empty means no
    // templated workflow: no document template is written for it. Its roles read its templates either way, for
    // the message templates every classification says (ADR-062 decision 2).
    const declaredTemplates = templatesDeclaredFor(
      topo.intentPackParam ? (this.node.tryGetContext('assistantIntentPack') as string | undefined) : undefined,
      defaultProfileRegistry.produces(classification, 'document'),
    );
    const writesDocumentTemplates = declaredTemplates.length > 0;
    const modelCatalog = getModelCatalog(this.region, this.account);
    // THE CLASSIFICATION'S DEFAULT MODEL, from its own selection (`models` on its registry entry): what its
    // assistant answers on when nothing more specific chooses. Validated at synth to be a Bedrock text model it selects.
    const defaultModelKey = defaultProfileRegistry.defaultModelOf(classification) as BackendModelKey;
    const profileModel = modelCatalog[defaultModelKey];
    if (!profileModel) throw new Error(`classification '${classification}' default model '${defaultModelKey}' is not a Bedrock text model in the catalog`);

    // External/CN model routing (SPEC-CONTEXT-AWARE-MODEL-ROUTING). In-AWS DeepSeek-on-Bedrock where the
    // classification selects `deepseek_v3`, intent-routed (reasoning to `deepseek_r1` when it selects that too,
    // otherwise to V3); without it, a Chinese turn takes the external adapter the classification selects
    // (`deepseek_api`, below). Synth refuses `contextRouting` on a classification that selects neither.
    // Active only at runtime when ENABLE_CONTEXT_ROUTING is on.
    let cnChatModel = '';
    let cnReasoningModel = '';
    let cnReasoningIntents = '';
    let cnBedrockArns: string[] = [];
    if (topo.contextRouting && defaultProfileRegistry.selectsModel(classification, 'deepseek_v3')) {
      const chat = modelCatalog.deepseek_v3;
      const reasoning = defaultProfileRegistry.selectsModel(classification, 'deepseek_r1') ? modelCatalog.deepseek_r1 : chat;
      cnChatModel = bedrockInvokeId(chat);
      cnReasoningModel = bedrockInvokeId(reasoning);
      cnReasoningIntents =
        (this.node.tryGetContext('cnBedrockReasoningIntents') as string) ?? 'report_generation,data_extraction,guided_troubleshooting';
      cnBedrockArns = [chat, reasoning].flatMap((m) => [...m.foundationModelArns, ...(m.inferenceProfileArns ?? [])]);
    }
    // THE EXTERNAL DEEPSEEK ADAPTER, where the classification selects it (`deepseek_api`, `model-catalog.ts`):
    // its key secret, its read on the acting role and the processor's environment exist exactly then.
    const deepseekExternal = defaultProfileRegistry.selectsModel(classification, 'deepseek_api') ? EXTERNAL_MODELS.deepseek_api : undefined;
    const classificationModelArns = [...new Set([...modelArnsForClassification(classification, modelCatalog), ...cnBedrockArns])];

    const shared = resolveSharedSSM(this);
    // THIS DEPLOYMENT'S OWN POOL, read only when the registry declares an issuer on it (L15): with none,
    // Identity publishes no pool id, and nothing here names a pool.
    const selfPoolId = issuersOf(this).ownsPool() ? shared.cognitoUserPoolId : '';
    // ── WHAT A PERSON IS VENDED AT THIS CLASSIFICATION, AND THE GROUPS THAT CLEAR THEM FOR IT ─────────────
    //
    // The classification's vend role, its boundary and its published ARN (`ExchangeRole`), where a person is
    // vended at it (a member classification, or an outside one a signed-in issuer reaches), and the groups on
    // the deployment's own pool that clear for it (`clearanceGroups`), with the precedence it declares. Built
    // here rather than in Identity, so declaring a classification changes no other stack.
    if (props.credentialExchangeRoleArn && vendedClassifications(issuersOf(this)).includes(classification)) {
      new ExchangeRole(this, 'ExchangeRole', {
        appInstanceArn: props.appInstanceArn, token: classification, exchangeRoleArn: props.credentialExchangeRoleArn,
      });
    }
    if (selfPoolId) clearanceGroups(this, classification, selfPoolId);
    // THE CLASSIFICATION'S CONVERSATION CREATOR: the one function that creates a
    // conversation at it, published under its own key for the callers that find it by name at call time.
    new ConversationCreator(this, 'ConversationCreator', {
      classification, appInstanceArn: props.appInstanceArn,
      channelContextTableName: shared.channelContextName, channelContextTableArn: shared.channelContextArn,
      templateBucketName: props.attachmentsBucketName, templateBucketArn: props.attachmentsBucketArn,
    });
    // THE SERVICE ADMIN, COMPOSED RATHER THAN RESOLVED FROM SSM AT DEPLOY TIME.
    //
    // It is needed in IAM and not only at runtime: it is the bearer the creation path uses for
    // `CreateChannel` and `AssociateChannelFlow`, and both authorize against the bearer resource. So it
    // has to be a synth-time value, which rules out the runtime-by-name read every other consumer uses.
    //
    // WHY NOT `valueForStringParameter`, STATED NARROWLY because the obvious reason does not hold.
    // It is tempting to say the SSM ref coupled this stack's deploy to `MessagingStack` having
    // published the parameter. It does not add that coupling: this stack already takes
    // `props.appInstanceArn` as a cross-stack reference, so the synthesized template carries an
    // `Fn::ImportValue` on the Chime stack's export and cannot deploy before it regardless. An
    // `Fn::ImportValue` is in fact the harder of the two to break.
    //
    // What composing it actually buys is one fewer deploy-time dynamic reference per classification
    // stack, on a value that is not dynamic: the identity is deterministic, so resolving it through a
    // parameter store at synth is indirection without a question it answers. The related failure this
    // repo HAS paid for is recorded on a different key in `agent-classification-common.ts`, where the
    // parameter belongs to an opt-in stack and genuinely may not exist - that is the shape to watch for,
    // and it is not this one.
    //
    // The composition is the Chime stack's own: `create-app-instance-admin.ts` builds
    // `${APP_INSTANCE_ARN}/user/${ADMIN_USER_ID}` from `ADMIN_USER_ID = ${RES_PREFIX}-admin`, and
    // `RES_PREFIX` is the same env-derived constant in the same synth - so this is the one expression
    // rather than a second guess at it.
    const serviceAdminArn = `${props.appInstanceArn}/user/${RES_PREFIX}-admin`;
    const errAlert = alertEmitterWiring(this);
    const abuse = abuseControlsWiring(this, shared.abuseControlsArn, shared.abuseControlsName, classification, this.region, this.account);
    // One turn at a time (ADR-033). Its own table and its own fail policy - see turnQueueWiring.
    const turnQueue = turnQueueWiring(this, shared.turnStateArn, shared.turnStateName);
    // /battle plumbing — only resolved when the profile is battle-capable AND /battle is deployed.
    // ONE SOURCE for whether this classification wires battle: the classification config, which is
    // also what the runtime refuses on. It was a topology field, and a SECOND field on the assistant
    // profile (`battleEligible`) answered the same question differently for basic - so the stack built
    // no plumbing while the API happily enabled Battle Mode (ADR-049).
    //
    // BY THEIR FIXED NAMES. The battle tables and orchestrator, and the experiments table, are told to the
    // functions that use them by their fixed names (`CAPABILITY_RESOURCES`), and this stack grants its own roles
    // on the same names in policies of their own (`attachBattle`, `attachExperiments`, below), so declaring
    // either adds resources here and changes none this stack had.
    const battle = defaultProfileRegistry.isBattleCapable(classification) && props.battle
      ? battleResourcesOf(this) : undefined;
    // Experiments, only when the deployment declares them.
    const experiments = props.experiments ? experimentsResourcesOf(this) : undefined;

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

    // ── IMAGE GENERATION IS WIRED WHERE THE CLASSIFICATION SELECTS AN IMAGE MODEL, AND NOWHERE ELSE ──────────────
    //
    // Not a per-stack flag: the image guardrail, the image-model grant and the processor's image env follow
    // `imageModelsAllowedFor(classification)`, the classification's own selection (`models`), and the external
    // providers' keys follow the external image models in it (`externalImageGen`). `image-gen-iam-parity.test.ts` synthesizes every classification and
    // holds the grant to that list.
    const imageModelArns = imageModelArnsForClassification(classification);
    const imageGen = imageModelsAllowedFor(classification).length > 0;
    const externalImageGen = imageModelsAllowedFor(classification).some((k) => IMAGE_GEN_MODELS[k].hosting === 'external-http');
    const imageGuardrail = imageGen
      ? new BattleImageGuardrails(this, 'BattleImageGuardrails', { name: `${RES_PREFIX}-${classification}-battle-image-guardrail` })
      : undefined;

    // ── THE PROCESSOR'S OWN ROLE IS BOOTSTRAP ONLY (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b) ────────────────────────────────────────
    //
    // It writes logs, asks the vend for the turn's assistant session, and keeps the platform's own records
    // about a turn: the abuse counters and circuit, the turn state, the message-analytics row and the
    // triage dispatch. Everything the ASSISTANT does goes out on that
    // session, so it is granted on the acting role below - and a call made without a session is refused
    // by IAM rather than made as some wider identity.
    const processorRole = new iam.Role(this, 'ProcessorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    // ── EVERY ASSISTANT ACTS AS ITSELF: THE ROUTING RECORD, THE VEND AND THE ACTING ROLE (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b) ──
    //
    // The router writes which assistant a turn was routed to (the routing record). The vend is the only
    // principal the acting role trusts; it reads that record and mints a session tagged with the
    // assistant, its assistant role and its bot. The processor asks the vend and acts on the session.
    // Nothing about a particular assistant is written into IAM, so a classification holds any number.
    const turnRouting = new dynamodb.Table(this, 'TurnRoutingTable', {
      tableName: turnRoutingTableName(classification),
      partitionKey: { name: 'correlationId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: dataRemovalPolicy(this),
    });

    const vendRole = new iam.Role(this, 'AssistantVendRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      description: `Mints ${classification} assistant sessions from routing records. The only principal the acting role trusts.`,
    });
    const { role: actingRole, boundary: actingBoundary } = assistantActingRole(this, {
      classification,
      appInstanceArn: props.appInstanceArn,
      vendRole,
      roles: this.deployedRoles(classification),
      sessionChannelActions: [...ASSISTANT_TURN_CHANNEL_ACTIONS, 'chime:UpdateChannel'],
      contextBucketArn: props.attachmentsBucketArn,
      // Every classification's turns say message templates (ADR-062 decision 2).
      readsTemplates: true,
      capabilities: props.capabilities,
    });
    // THE VEND READS THE DECISION AND THE REGISTRY, AND MINTS. It cannot write a routing record, so it
    // can only ever vend what the router decided.
    turnRouting.grant(vendRole, 'dynamodb:GetItem');
    vendRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadWhichAssistantEachBotIs',
      actions: ['ssm:GetParametersByPath'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant-assignments/${classification}`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant-assignments/${classification}/*`,
      ],
    }));
    vendRole.addToPolicy(new iam.PolicyStatement({
      sid: 'MintAssistantSessions',
      actions: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'],
      resources: [actingRole.roleArn],
    }));
    // ── EACH ASSISTANT'S OWN REACH, INSIDE THE CLASSIFICATION AND ROLE ──────────────────────────
    //
    // The catalog of session policies the vend narrows a session to, from the assistant's approved
    // definition (`assistantGrantCatalog`, `lambda/src/lib/assistant-grant.ts`). The routed text-model
    // set is what every turn may need whatever the definition says: the intent strategy's models the
    // classification allows, its default and the utility model.
    const grantCatalog = assistantGrantCatalog(this, {
      classification,
      modelCatalog,
      classificationModelArns: modelArnsForClassification(classification, modelCatalog),
      contextRoutingArns: cnBedrockArns,
      imageModelArns,
      streaming: !!topo.streaming,
    });
    const routedModelKeys = [...new Set([
      profileModel.key,
      'haiku',
      ...INTENT_ROUTE_STRATEGY.flatMap((r) => [r.primaryModel, r.fallbackModel]),
    ])].filter((k) => defaultProfileRegistry.selectsModel(classification, k));
    // The approved definition the vend narrows by. Read-only; a definition is not a secret, and an
    // assistant's name is not known at synth.
    vendRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadTheApprovedDefinition',
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/definition`],
    }));
    const assistantVend = new lambdaNodeJs.NodejsFunction(this, 'AssistantVend', {
      entry: path.join(__dirname, '../../lambda/src/assistant-vend.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      role: vendRole,
      environment: {
        CLASSIFICATION: classification,
        TURN_ROUTING_TABLE: turnRouting.tableName,
        ACTING_ROLE_ARN: actingRole.roleArn,
        SSM_ROOT,
        GRANT_POLICY_PREFIX: grantCatalog.policyArnPrefix,
        GRANT_EDGES: JSON.stringify(grantCatalog.edges),
        GRANT_ROUTED_MODELS: JSON.stringify(routedModelKeys),
        // The seed's preselected image model, only where the catalog allows it (no default an assistant
        // did not choose, and a seed preselects only what its classification allows).
        GRANT_DEFAULT_IMAGE_MODEL: modelAllowedFor(DEFAULT_IMAGE_MODEL, classification) ? DEFAULT_IMAGE_MODEL : '',
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    // THE VEND WAITS FOR EVERY GRANT POLICY IT CAN NAME. It passes them to AssumeRole by a literal prefix
    // (`GRANT_POLICY_PREFIX` + an edge), so CloudFormation sees no reference and could update the vend
    // before a new edge's policy exists; AssumeRole then fails closed and every turn is refused until it does.
    for (const policy of grantCatalog.policies) assistantVend.node.addDependency(policy);

    // ── WHAT A TURN DOES, GRANTED TO THE ASSISTANT IT ACTS AS ──────────────────────────────────────
    //
    // These were the processor role's own inline policies. They are the acting role's now: the turn
    // runs on the session, so the reach belongs to the assistant, bounded by the classification's
    // boundary. `chime:UpdateChannel` is the first-turn title rename, done as the assistant.
    const platformGrantedPrefixes = defaultProfileRegistry.grantsFor(classification).map((c) => `platform-knowledge/${c}/`);
    const turnPolicyDocs: Record<string, iam.PolicyDocument> = {
      BedrockPolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            // Streaming profiles add InvokeModelWithResponseStream (long-form deliverables).
            actions: topo.streaming
              ? ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']
              : ['bedrock:InvokeModel'],
            resources: classificationModelArns,
          }),
          // THE PLATFORM'S UTILITY MODEL, beside the selection and scoped exactly like the router's grant of it:
          // the first-turn conversation title runs on it (`channel-title.ts`) whatever the classification
          // selects. The vend narrows a session to it through the `utility` edge, and nothing answers on it.
          new iam.PolicyStatement({
            sid: 'PlatformUtilityModel',
            actions: ['bedrock:InvokeModel'],
            resources: utilityModelArns(this.region, this.account),
          }),
          new iam.PolicyStatement({
            actions: ['bedrock:ApplyGuardrail'],
            // The deployment default + every selectable alternate (4.6b): a profile can only apply a
            // PROVISIONED guardrail; anything else fails closed (open).
            resources: [guardrail.guardrailArn, ...alternateGuardrails.map((a) => a.gr.guardrailArn)],
          }),
        ],
      }),
      // WHAT EVERY ASSISTANT OF THE CLASSIFICATION READS: the platform's self-knowledge and the
      // content-addressed profile bodies. Company context is not here: it is read per assistant role,
      // conditioned on the session's `role` tag (`roleContextStatements`).
      ContextS3Read: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['s3:ListBucket'],
            resources: [props.attachmentsBucketArn],
            // SCOPED TO THE CLASSIFICATION'S GRANTS: platform documentation is internal
            // material, and the external classification is granted a public overview only.
            conditions: { StringLike: { 's3:prefix': platformGrantedPrefixes.map((p) => `${p}*`) } },
          }),
          new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: [
              ...platformGrantedPrefixes.map((p) => `${props.attachmentsBucketArn}/${p}*`),
              // The active version's PERSONA (SPEC-PORTABLE-PROFILES, "Bodies are S3"): the definition
              // in SSM holds a pointer under `profiles/*` and the processor follows it every time it
              // resolves its profile. READ-ONLY, and deliberately not classification-scoped the way the
              // context prefixes are: a profile can only ever be handed its OWN version's key, which is
              // content-addressed, and the assistant fails closed to the compiled seed if the read
              // fails. Write stays exclusive to manage-profiles (§7).
              `${props.attachmentsBucketArn}/profiles/*`,
              // THE CLASSIFICATION'S OWN INTENT PACK BODY, which its `assistant-intent-pack` parameter
              // points at. Scoped to this classification's prefix and no other: the processor of one
              // classification has no read on another's pack (`a-classification-reads-only-its-own-pack`).
              ...(topo.intentPackParam ? [`${props.attachmentsBucketArn}/${classificationPackPrefix(classification)}*`] : []),
            ],
          }),
          // THE CLASSIFICATION'S OWN TEMPLATES (SPEC-DOCUMENT-TEMPLATES FR2, ADR-062 decision 2), through the one helper every
          // role that words a message for the classification holds: read-only bodies under `templates/<classification>/`
          // and no other's, the pointers that say which version is active, and the list of which templates each family
          // holds. Every classification's turns say messages, so the read is unconditional; no turn role writes one.
          ...messageTemplateReadStatements(this, props.attachmentsBucketArn, classification),
        ],
      }),
    };
    for (const [name, document] of Object.entries(turnPolicyDocs)) {
      // THE TURN'S MODEL AND READ-ONLY CONTEXT GRANTS ARE MANAGED, NOT INLINE. IAM caps a role's inline
      // policies at 10,240 bytes combined, and premium's acting role reached 182 bytes under it in the
      // synthesized template. A managed policy carries the same statements, scope unchanged, and counts
      // against its own 6,144-byte limit and the role's ten-attachment limit instead
      // (no-role-exceeds-the-inline-policy-limit.test.ts checks all three). Unnamed, so a replacement never
      // collides on a fixed name. CloudFormation attaches the new policy in the update phase and deletes the
      // inline one in cleanup, so a deploy has no window without the grant.
      new iam.ManagedPolicy(this, `AssistantTurn${name}Managed`, { roles: [actingRole], document });
    }

    if (topo.richProcessor) {
      // Generated-doc writes. The battle state and experiments tables a rich session also calls are
      // granted on this role in policies of their own, when declared (`attachBattle`, `attachExperiments`).
      //
      // TASKS ARE NOT HERE ANY MORE (ADR-033, DESIGN-TASK-ACCESS): every task read and write on the turn
      // path goes through the task service, the second enforcement layer the store never had.
      actingRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [`${props.attachmentsBucketArn}/generated-docs/*`] }));
    }
    // Attachment-in: read the user-uploaded file the current turn references so the processor can
    // attach a Converse image/document block.
    //
    // KEYED ON THE PROFILE FLAG, NOT ON `richProcessor`, and moved OUT of the rich block above so it
    // is one decision instead of a coincidence. The same flag sets `ATTACHMENTS_BUCKET` below and
    // answers the composer's "may I offer the paperclip" - so the grant, the env and the UI cannot
    // disagree. Under `richProcessor` they could, and did: basic offered the control, had neither,
    // and dropped every file in silence.
    if (attachmentsReadable) {
      actingRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [`${props.attachmentsBucketArn}/attachments/*`] }));
    }
    if (!topo.richProcessor) {
      // Non-rich profile (richProcessor:false): the SAME DynamoDB task grants as above (read/create/
      // advance task state — every profile runs the full loop), but WITHOUT the rich-output grants (no
      // generated-docs S3 write, no attachment-in read). So basic tracks and advances tasks; it just
      // does not produce downloadable documents.
      // NO TASK-TABLE GRANT AT ALL on this profile. Its only DynamoDB need was the task tables, and
      // those now go through the task service - so the statement is gone rather than emptied, and a
      // future reader finds an absence with a reason instead of a policy that grants nothing.
    }
    // An admin alert is a platform action, raised as an `ae.alert` event, so it is the processor's own
    // grant and never the assistant's: the session holds no grant it does not need for its own turn.
    errAlert.grant(processorRole);
    // THE PROCESSOR'S OWN RECORDS: the abuse counters and circuit, the
    // turn state and the message-analytics row are the platform's bookkeeping about a turn, written on
    // the processor's ambient role. The acting role holds none of them, so an assistant session cannot
    // reset a counter, release another turn's lock or write an analytics row.
    abuse.grant(processorRole);
    turnQueue.grant(processorRole);

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
    if (imageGen) {
      actingRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: Object.values(imageModelArns),
        }),
      );
      actingRole.addToPolicy(
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
      actingRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [`${props.attachmentsBucketArn}/attachments/*`] }));
      actingRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject', 's3:GetObject'], resources: [`${props.attachmentsBucketArn}/battle-images/*`] }));
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
    // A TASK MACHINE'S `ctx:` CONDITIONS ARE HELD AGAINST THIS CLASSIFICATION'S CATALOG (ADR-060 decision 3), here, where
    // the pack that declares them and the catalog that publishes their sources are both read. A machine is a global
    // workflow, never part of a version, so this is the check its conditions pass before they deploy.
    if (topo.intentPackParam) {
      const packJson = (this.node.tryGetContext('assistantIntentPack') as string | undefined) || '';
      const lookup = sourceLookup(buildSourceTable({
        catalog: contextSources.entries.map((e) => catalogEntryForVariables(publishableContextSource(e) as VariableCatalogEntry)),
        classifications: defaultProfileRegistry.classificationValues(),
      }));
      const refused = machineCatalogConditionErrors(taskStateMachines(parseIntentPack(packJson.trim() ? packJson : undefined)), lookup);
      if (refused.length) {
        throw new Error(`[${classification}] the intent pack's machine conditions are refused against this classification's context-source catalog: ${refused.join('; ')}`);
      }
    }
    for (const entry of contextSources.entries) {
      // Resource form is per type: an s3-prefix grants only its own prefix, never the bucket.
      // A LIST of statements: a type may need more than one shape (an object-level read plus a
      // conditioned bucket-level list, say), and folding those into one statement is how `ListBucket`
      // ended up on an object ARN authorizing nothing.
      //
      // Company context (`context/`) is granted per ROLE, conditioned on the session's `role` tag
      // (`roleContextStatements`), never unconditionally here, or every assistant of the classification
      // could read what only one role is scoped to (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION Phase 1b).
      if (entry.type === 's3-prefix' && (entry.prefix || '').startsWith('context/')) continue;
      for (const { actions, resources, conditions } of contextSourceGrant(entry)) {
        actingRole.addToPolicy(new iam.PolicyStatement({ actions, resources, conditions }));
      }
    }
    // The boundary admits S3 only where a turn uses it, so the catalog's own object prefixes are added to it
    // here, beside their grant: this classification's catalog, and nothing another classification declares.
    allowContextSourceObjects(actingBoundary, contextSources.entries
      .filter((e) => e.type === 's3-prefix' && !(e.prefix || '').startsWith('context/'))
      .flatMap((e) => contextSourceGrant(e).flatMap((g) => g.resources)));
    // The processor must be able to READ the catalog it resolves against. Granting the sources but not
    // the catalog parameter is the same failure this file's INV-CTX-CAT-3 comment describes, one level
    // up - and it fails the same way: the read denies, the code sees an empty catalog, and every
    // selected key logs "not in this classification's catalog" as though the PROFILE were wrong.
    // Found exactly that way on the live deployment.
    actingRole.addToPolicy(new iam.PolicyStatement({
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
      // grant above authorized. Stripping them forced the reader onto a hardcoded corpus path, so an
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
    // IN EVERY DEPLOYMENT. The alarm's notifier raises an `ae.alert` event, which the `AdminServices`
    // stack posts into the admin channel when the deployment declares `admin`; this stack does not know
    // or ask whether it does (the component rule: the core never branches on the admin capability).
    {
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

      // THE ONE ALARM NOTIFIER, as for every alarm in the deployment. What this alarm means and what to do
      // is its description, below; the dashboard it links is named in the notifier's environment.
      const alarmFn = new lambdaNodeJs.NodejsFunction(this, 'ContextSourceAlarmFunction', {
        entry: path.join(__dirname, '../../lambda/src/alarm-to-admin-channel.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(30),
        environment: {
          ...errAlert.env,
          ALARM_DASHBOARD: dashboardName,
        },
      });
      errAlert.grant(alarmFn.role!);
      alarmTopic.addSubscription(new snsSubscriptions.LambdaSubscription(alarmFn));

      const alarm = new cloudwatch.Alarm(this, 'ContextSourceFailureRateAlarm', {
        alarmName: `${this.stackName}-context-source-failure-rate`,
        alarmDescription:
          `More than ${thresholdPercent}% of context source reads failed over 5 minutes `
          + `(${classification}). A grant, a document, or the catalog parameter itself. Open the dashboard `
          + 'and check the Outcome breakdown: `denied` means a grant is missing or was refused, `absent` '
          + 'means content is missing (a per-person source with no record for this person is the '
          + '`no-record` skip and never counts here), and `(catalog)` as the source key means the catalog parameter '
          + 'itself could not be read, which takes out every source at once.',
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
              title: 'Skipped - sustained not-in-catalog is a profile naming a removed key; no-record is a person with no record yet',
              left: (['not-in-catalog', 'unavailable', 'no-record'] as const).map((outcome) =>
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

    // ── External (CN) provider secret, where the classification selects the external adapter ──────────
    // WHETHER A TURN MAY USE THAT PROVIDER IS THE CLASSIFICATION'S SELECTION, and nothing a profile version says:
    // a profile enables nothing. The secret, its read and the environment exist exactly where it is selected.
    let deepseekSecret: secretsmanager.Secret | undefined;
    if (deepseekExternal) {
      deepseekSecret = new secretsmanager.Secret(this, 'DeepseekApiKey', {
        description: 'DeepSeek API key for the Chinese-LLM routing path. Set the value out-of-band: aws secretsmanager put-secret-value --secret-id <arn> --secret-string <key>',
      });
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
      // BATTLE_CAPABLE (the classification capability, ADR-049) gates the /battle code paths; MAX_TOKENS is the
      // profile's response limit. Capabilities self-gate on the env below, which is set only when
      // the matching IAM is granted — so the profile's execution stays within its role.
      // THE PROFILE'S NAME, AND NOT THE CLASSIFICATION. The note below used to say these "happen to
      // hold the same string today" and predicted exactly what breaks when they stop: a deployment
      // may point a classification at a differently-named profile and the strings come apart. They
      // have, so this reads the registry rather than assuming the diagonal.
      // Passing `classification` here would send the runtime looking for `/assistant/{classification}
      // /definition`, which no longer exists, and an unresolvable definition degrades silently to "no
      // profile" rather than failing - the worst shape for a mistake to take.
      PROFILE_NAME: defaultProfileRegistry.requireProfileFor(classification).name,
      // THE DEPLOYMENT PACK THE ROUTER CLASSIFIES AGAINST, so a version with no pack of its own is
      // answered by the same one (SPEC-CONFIGURABLE-INTENT-PACK FR17). Read on the assistant's session;
      // the grant is on the acting role below.
      ...(topo.intentPackParam ? { ASSISTANT_INTENT_PACK_PARAM: `${SSM_ROOT}/assistant/${classification}/assistant-intent-pack` } : {}),
      /**
       * THE ASSISTANT'S CLASSIFICATION, as an access fact rather than a profile lookup.
       *
       * `PROFILE_NAME` above happens to hold the same string today - this stack assigns
       * `classification` to it - but the two are different questions and the config says so:
       * `profiles.ts` models a classification as REFERENCING a profile
       * (`{ value: 'basic', profile: 'concierge', grants: ['basic'] }`), so a deployment may point a classification
       * at a differently-named profile and the strings come apart. Reading a profile name where a
       * classification is meant is the same coincidence-on-the-diagonal error that let the user's
       * clearance be recorded as the assistant's identity.
       *
       * A PROFILE IS CAPABILITY CONFIG; A CLASSIFICATION IS A BOUNDARY. Profiles are operator-editable
       * and versioned; the boundary must not move because somebody edited a persona. Stamped here from
       * the stack's own topology, which is the same value the classification's IAM role and channel-tag
       * conditions are built from, so the analytics record and the enforcement agree by construction.
       *
       * THE DURABLE ANCHOR IS NOW THE IDENTITY'S OWN TAG, and this env var is the second layer rather
       * than the only one. The provisioner (`assistant-provisioner.ts`) stamps `classification` on the
       * `AppInstanceBot` at creation, symmetric with the channel tag IAM already evaluates, and
       * `runtimeAssistantProvisioningAllow` conditions the provisioning grants on it - so an assistant's
       * classification lives on the identity and the env var agrees with it by construction rather
       * than standing in for it.
       */
      CLASSIFICATION: classification,
      /**
       * WHICH ROLE THIS ASSISTANT HOLDS in its classification (DESIGN-SEPARATE-ASSISTANTS 3.0).
       *
       * One role is declared today, `primary`, so this is that for every deployment - and it is
       * stamped rather than assumed because the whole point of the structure is that a classification
       * will declare more. Recording it now means the analytics dimension exists before there is a
       * second role to tell apart, instead of being retrofitted onto history that never carried it.
       *
       * ROLE, NOT OCCUPANCY. An alt is the alternate assistant of the SAME role (`alt-{role}`), so a
       * battle turn is still `primary` here. Which of the two answered is not derivable
       * from this Lambda's environment - the classification's processor serves both - so occupancy is
       * deliberately NOT recorded from here rather than guessed.
       */
      ASSISTANT_ROLE: ASSISTANT_ROLES[0],
      /**
       * WHICH AWS LAMBDA FUNCTIONS ARE THIS DEPLOYMENT'S, for the observability tool.
       *
       * `STACK_PREFIX` is the PascalCase instance name every stack - and therefore every generated
       * function name - begins with, so it is the one string that separates this deployment's telemetry
       * from anything else in the account. Without it `read_deployment_health` can only ask about the
       * ACCOUNT, which on a shared account is another application's health reported as this platform's:
       * measured 2026-09-30, a 44.2% error rate called critical whose every error belonged to three
       * other CDK apps in the same account.
       *
       * A SEPARATE INSTANCE OF THIS PLATFORM is covered by the same string, because a second instance
       * gets its own PascalCase prefix - which is exactly what that prefix exists for.
       */
      DEPLOYMENT_FUNCTION_PREFIX: STACK_PREFIX,
      // WHERE THIS DEPLOYMENT'S ALARM NAMES ARE PUBLISHED (`publishAlarmNames`): the tool reads them as the
      // assistant and asks CloudWatch for those alarms by name.
      DEPLOYMENT_ALARM_NAMES_PATH: alarmNamesPathOf(SSM_ROOT),
      // THE CAPABILITY, NOT THE POLICY (ADR-049). This is a deploy-time fact about whether this
      // classification's plumbing exists, so an env is the right place for it and it now reads the
      // SAME field the battle wiring below is built from. It used to read `profile.battleEligible`,
      // which was `true` for basic while basic's topology said `battleCapable: false` - the env and
      // the grants disagreed, and the env was the half a person saw. Whether battle is turned ON is
      // runtime policy and is read on the turn path, not baked here.
      BATTLE_CAPABLE: String(defaultProfileRegistry.isBattleCapable(classification)),
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
      ...turnQueue.env,
    };
    if (topo.richProcessor && experiments) {
      processorEnv.EXPERIMENTS_TABLE = experiments.experimentsName;
    }
    // PAIRED WITH THE GRANT ABOVE, on the same flag and for the same reason. Set without the grant the
    // processor gets AccessDenied it reports as a non-fatal warning; granted without this it never
    // looks. Both come from `attachmentsReadable`, so neither can happen.
    if (attachmentsReadable) {
      processorEnv.ATTACHMENTS_BUCKET = props.attachmentsBucketName;
    }
    if (topo.systemPromptParam) {
      // Always reference the param by NAME (it may exist from a preserved prior deploy even if THIS
      // deploy didn't set it); the processor falls back to its default when the param is absent.
      processorEnv.ASSISTANT_SYSTEM_PROMPT_PARAM = systemPromptParamName;
    }
    if (topo.contextRouting) {
      processorEnv.ENABLE_CONTEXT_ROUTING = enableContextRouting ? 'true' : 'false';
      if (cnChatModel) {
        processorEnv.CN_BEDROCK_CHAT_MODEL = cnChatModel;
        processorEnv.CN_BEDROCK_REASONING_MODEL = cnReasoningModel;
        processorEnv.CN_BEDROCK_REASONING_INTENTS = cnReasoningIntents;
      }
    }
    if (deepseekExternal) {
      processorEnv.DEEPSEEK_BASE_URL = deepseekExternal.endpoint;
      processorEnv.DEEPSEEK_MODEL = deepseekExternal.model;
      processorEnv.DEEPSEEK_API_KEY_SECRET = deepseekSecret!.secretArn;
    }
    if (imageGen) {
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

    // ── THE TURN THAT NEVER CAME BACK (ADR-033) ───────────────────────────────────────────────
    //
    // A turn releases its lock in a `finally`, which covers every ending its own code reaches. The
    // one it cannot reach is the platform killing the invocation - a timeout, or out of memory -
    // because nothing in that process runs afterwards. Left there, the conversation stays held
    // until a later message finds the holder stale (`STALE_AFTER_MS` in lib/turn-lock.ts) and takes
    // the lock over, which is counted as `LockTakeover`. The record has no TTL.
    //
    // The processor is invoked ASYNCHRONOUSLY, so that ending is an event: Lambda emits a failure
    // record carrying the payload that started the invocation, which names the channel, the bot and
    // the correlation. That is the whole lock. The destination below re-dispatches the turn while
    // fewer than `TURN_MAX_ATTEMPTS` (default 2) dispatches have run, then asks the assistant to
    // announce the failure, which releases the lock in its own `finally`.
    //
    // Wired here so recovery does not wait on the staleness bound: the platform already knows the
    // invocation ended.
    // ── PER CLASSIFICATION, BECAUSE IT RETRIES ───────────────────────────────────────────────
    //
    // This was the SHARED Foundations function, which was right while it only released a lock: one
    // conditional write, no target to choose. It now RE-DISPATCHES the turn, and a shared deputy
    // that re-dispatches is a boundary hole. Wiring a function as a destination grants the source
    // permission to invoke it, so every processor could call it directly; destination records carry
    // no signature, so a hand-made one is indistinguishable from a real one. A basic processor could
    // therefore have reached the premium processor - and its tag-scoped Chime rights - in one hop,
    // through a deputy, defeating the boundary this stack enforces at IAM everywhere else.
    //
    // Deployed beside the processor it serves, told which one that is, and granted invoke on that
    // ARN and no other. The classification boundary is then back where the rest of the design keeps
    // it: denied at IAM rather than refused in code.
    const turnRecovery = new lambdaNodeJs.NodejsFunction(this, 'TurnRecoveryOnFailure', {
      entry: path.join(__dirname, '../../lambda/src/turn-lock-release-on-failure.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      // NO REFERENCE TO THE PROCESSOR HERE. Naming its ARN in this environment makes the recovery
      // function depend on the processor, which depends on its role, whose policy depends on this
      // function - a cycle CloudFormation refuses. The bound is IAM instead, below, which is where
      // this codebase keeps boundaries anyway.
      environment: { ...turnQueue.env },
      bundling: { minify: false, forceDockerBundling: false },
    });
    // The lock it releases, and nothing wider: a conditional UpdateItem, not write access.
    turnQueue.grant(turnRecovery.role!);
    // THE ONE FUNCTION IT MAY RETRY, granted on the PROCESSOR rather than on the recovery role.
    //
    // An identity grant here is a dependency cycle. Wiring the destination already puts "may invoke
    // the recovery function" on the processor role, so adding "may invoke the processor" to the
    // recovery role makes each policy wait on the other function and CloudFormation refuses the
    // template outright.
    //
    // A resource policy on the target names the recovery ROLE, which nothing else depends on, so the
    // edge disappears. Same-account invoke needs only one of the two sides to allow it, and this is
    // the side that does not close a loop.
    asyncProcessor.addPermission('AllowTurnRecoveryRetry', {
      principal: new iam.ArnPrincipal(turnRecovery.role!.roleArn),
      action: 'lambda:InvokeFunction',
    });

    asyncProcessor.configureAsyncInvoke({
      onFailure: new lambdaDestinations.LambdaDestination(turnRecovery),
    });
    // The analytics row is the processor's own record (step 18), so it is the processor role's grant.
    wireMessageAnalytics({
      addEnvironment: (k: string, v: string) => asyncProcessor.addEnvironment(k, v),
      addToRolePolicy: (st: iam.PolicyStatement) => processorRole.addToPolicy(st),
    }, props.messageAnalytics);

    if (deepseekExternal) {
      // This one secret, on the classification's acting role, which every assistant of the classification acts
      // through: the classification selected the external adapter, so each of its assistants may use it, and a
      // classification that does not select it holds no secret and no read (the platform allows, the
      // classification selects).
      deepseekSecret!.grantRead(actingRole);
      new cdk.CfnOutput(this, 'DeepseekSecretArn', {
        value: deepseekSecret!.secretArn,
        description: 'Put the DeepSeek API key here (aws secretsmanager put-secret-value), then deploy with -c enableContextRouting=true.',
      });
    }
    if (topo.systemPromptParam) {
      // Read the persona from SSM at cold start (always — the param may exist from a preserved prior deploy).
      actingRole.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [systemPromptParamArn] }));
    }
    // SPEC-PORTABLE-PROFILES P0/P2/§7: the processor resolves its OWN active profile version
    // (P0), and — for a /battle profileRef variant — reads OTHER profiles' versions (P2), so grant read
    // across the whole assistant-definition namespace. READ-ONLY: the write path (PutParameter/label on
    // /assistant/*) belongs ONLY to the manage-profiles role; reading a definition is behavior, not a
    // boundary (§7), so a broad read never escalates. Absent param ⇒ the resolver fails closed to the seed.
    const definitionsReadArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/definition`;
    actingRole.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter', 'ssm:GetParameterHistory'], resources: [definitionsReadArn] }));
    // WHICH ASSISTANT HOLDS WHICH ROLE, so a turn can tell the live assistant from the alt and ask the
    // vend for that assistant's session (`adoptTurnIdentity`, which calls the vend).
    //
    // READ AT RUNTIME RATHER THAN STAMPED AT SYNTH, and the reason is structural: handing the
    // processor `this.appInstanceBotArn` makes it depend on the bot resource, which closes a
    // dependency cycle through the Lex bot and the handler role and makes the template undeployable.
    // The assignment record carries the same fact without the edge - and it is the AUTHORITY on who
    // is live, which the bot-arn key is not, so this is the better source as well as the possible one.
    //
    // A STRING, NOT A TOKEN: the path is fixed at synth, so granting it references no construct.
    // `GetParametersByPath` JOINED IT when a classification gained a second role. A turn knows only
    // the bot it was addressed as, and the role it is answering in is whichever assignment record holds that bot -
    // a question over the whole subtree rather than one key, because the turn cannot name the record it
    // is looking for. Scoped to this classification's own subtree, so it enumerates no other's.
    actingRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
      // BOTH THE PATH AND ITS CHILDREN. `GetParametersByPath` authorizes against the PATH itself and
      // not only the parameters beneath it, so a grant carrying the wildcard alone is denied on the
      // call that enumerates - measured, as `not authorized to perform: ssm:GetParametersByPath on
      // resource: …/assistant-assignments/{classification}`. The wildcard stays for the keyed reads.
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant-assignments/${classification}`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant-assignments/${classification}/*`,
      ],
    }));
    if (externalImageGen) {
      // External-HTTP image-gen provider keys (OpenAI / FAL), exactly where the classification selects an external
      // image model — PREFERRED: a Secrets Manager secret the
      // processor fetches + caches at runtime, so nothing sensitive sits in the Lambda config.
      //
      // ONE SECRET MAY HOLD EVERY PROVIDER'S KEY, and the processor reads only the fields of the providers this
      // classification selects (`IMAGE_GEN_KEY_FIELDS`, `externalImageKeyFieldsFor`). The IAM grant is on the
      // secret, so a deployment that wants IAM to separate the providers points each classification at a secret
      // holding only its own providers' keys.
      const keyFields = externalImageKeyFieldsFor(classification);
      asyncProcessor.addEnvironment('IMAGE_GEN_KEY_FIELDS', keyFields.join(','));
      igKeysSecretArn =
        (this.node.tryGetContext('imageGenKeysSecretArn') as string | undefined) || process.env.IMAGE_GEN_KEYS_SECRET_ARN;
      if (igKeysSecretArn) {
        const igKeysSecret = secretsmanager.Secret.fromSecretCompleteArn(this, 'ImageGenKeysSecret', igKeysSecretArn);
        igKeysSecret.grantRead(actingRole);
        asyncProcessor.addEnvironment('IMAGE_GEN_KEYS_SECRET_ARN', igKeysSecretArn);
      }
      // Fallback: a deployer who prefers plain env vars can export the key at deploy time, copied for a selected
      // provider only.
      for (const field of keyFields) {
        const value = process.env[field];
        if (value) asyncProcessor.addEnvironment(field, value);
      }
      // Footgun guard: imageGen wires the guardrail + bucket UNCONDITIONALLY above, but external providers
      // (OpenAI/FAL) need a key. If none is wired at synth, /battle image generation-out with an external
      // model silently honest-empties (no auth). Warn loudly so an image-enabled deploy can't quietly ship
      // without the keys (the exact way external image battles broke: guardrail present, keys dropped).
      if (!igKeysSecretArn && !keyFields.some((f) => process.env[f])) {
        cdk.Annotations.of(this).addWarning(
          `'${classification}' selects an external image model but no external image-gen provider key is wired. ` +
            `Set -c imageGenKeysSecretArn=<secret-arn> (JSON of {${keyFields.join(', ')}}) or export ` +
            `${keyFields.join(' / ')} at deploy time — otherwise /battle image generation-out with an ` +
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
        // THE PACK IS A BODY, AND THE PARAMETER HOLDS ITS POINTER. A pack with a declared prompt on
        // every workflow step outgrows any parameter tier, so the JSON is written to the classification's
        // own prefix of the body store (`classification-packs/<classification>/<sha256>/intentPack`) and
        // the parameter carries `{ ref: { key, configId } }`. The key is content-addressed, so a changed
        // pack is a new object and the previous one stays for a rollback; nothing here deletes it.
        //
        // Bounded by the same whole-pack limit a version-carried pack has, refused at synth with the
        // measurement named rather than discovered as a failed deploy.
        const packBytes = Buffer.byteLength(intentPackJson, 'utf8');
        if (packBytes > MAX_INTENT_PACK_BYTES) {
          throw new Error(
            `[${classification}] assistantIntentPack is ${packBytes} bytes, over the ${MAX_INTENT_PACK_BYTES}-byte `
            + 'limit on a whole pack. Trim the per-intent `instructions` and the workflow step prompts first.',
          );
        }
        const packContentId = contentIdOf(intentPackJson);
        const packKey = classificationPackKey(classification, packContentId);
        const packPointer = packPointerValue({ key: packKey, configId: packContentId });
        // WRITE SCOPE FOLLOWS THE OWNER (D15): this classification's prefix, PutObject only.
        const packBody = new cr.AwsCustomResource(this, 'IntentPackBodyWriter', {
          onUpdate: {
            service: 'S3',
            action: 'putObject',
            parameters: { Bucket: props.attachmentsBucketName, Key: packKey, Body: intentPackJson, ContentType: 'application/json' },
            physicalResourceId: cr.PhysicalResourceId.of(packKey),
          },
          policy: cr.AwsCustomResourcePolicy.fromStatements([
            new iam.PolicyStatement({
              actions: ['s3:PutObject'],
              resources: [`${props.attachmentsBucketArn}/${classificationPackPrefix(classification)}*`],
            }),
          ]),
          installLatestAwsSdk: false,
        });
        // Intelligent-Tiering: a pointer fits the Standard tier, and a parameter an earlier deploy made
        // Advanced stays Advanced rather than failing a downgrade.
        if (useParamWriter) {
          const pointerWriter = new cr.AwsCustomResource(this, 'IntentPackParamWriter', {
            onUpdate: {
              service: 'SSM',
              action: 'putParameter',
              parameters: { Name: intentPackParamName, Value: packPointer, Type: 'String', Tier: 'Intelligent-Tiering', Overwrite: true },
              physicalResourceId: cr.PhysicalResourceId.of(`${intentPackParamName}@${packContentId.slice(0, 16)}`),
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
              new iam.PolicyStatement({ actions: ['ssm:PutParameter'], resources: [intentPackParamArn] }),
            ]),
            installLatestAwsSdk: false,
          });
          // The body before the pointer, so the parameter never names an object that is not there.
          pointerWriter.node.addDependency(packBody);
        } else {
          const pointerParam = new ssm.StringParameter(this, 'IntentPackParam', {
            parameterName: intentPackParamName,
            stringValue: packPointer,
            description: 'Per-deployment assistant intent pack pointer (JSON) into the body store',
            tier: ssm.ParameterTier.INTELLIGENT_TIERING,
          });
          pointerParam.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
          pointerParam.node.addDependency(packBody);
        }
      }
    }

    // ── The platform's document templates its workflows declare (SPEC-DOCUMENT-TEMPLATES FR2) ──
    // Create-only, body then pointer; a version the deployment activated is never moved by a redeploy.
    if (writesDocumentTemplates) {
      new DefaultTemplateWriter(this, 'DefaultTemplates', {
        classification,
        declared: declaredTemplates,
        ssmRoot: SSM_ROOT,
        bucketName: props.attachmentsBucketName,
        bucketArn: props.attachmentsBucketArn,
        region: this.region,
        account: this.account,
      });
    }

    // ── Per-profile agent handler (Lex fulfillment) ─────────────────────────
    // The SHARED router (router-agent-handler.ts) is deployed PER PROFILE. CLASSIFICATION=<profile> makes it skip
    // classification discovery (it IS the profile), act as this profile's bot, enforce
    // min(senderClearance, profile) via Cognito, resolve experiments, create/continue tasks, and
    // dispatch to THIS profile's async-processor. Live drift (Aurora) is wired in Aurora mode (all-profile).
    // THE CLASSIFICATION'S OWN FUNCTIONS IN THE ARCHIVE'S VPC (Aurora mode): its turn data plane and its classifier
    // replay, each pinned to it (`ClassificationArchiveFunctions`).
    const archiveFunctions = props.auroraDriftHookup
      ? new ClassificationArchiveFunctions(this, 'Archive', {
        classification,
        rdsProxy: props.auroraDriftHookup.rdsProxy,
        // A draft answers the golden set on the classification's own guardrails and reads its version bodies (ADR-065).
        goldenRun: {
          defaultGuardrailId: guardrail.guardrailId,
          defaultGuardrailVersion: guardrail.guardrailVersion,
          guardrailArns: [guardrail.guardrailArn, ...alternateGuardrails.map((a) => a.gr.guardrailArn)],
          bodyBucketName: props.attachmentsBucketName,
          bodyBucketArn: props.attachmentsBucketArn,
        },
      })
      : undefined;
    const drift = archiveFunctions && props.auroraDriftHookup?.liveDrift
      ? auroraDriftWiring(this, classification, archiveFunctions.turnDataPlane.functionArn)
      : undefined;

    // The other trusted pools of a MULTI-ISSUER deployment, from the trusted-issuer registry, the same
    // set the notification fan-out reads. Empty when the registry declares only this deployment's pool.
    const additionalUserPoolIds = issuersOf(this).otherPoolIds();
    // THE PROFILE STORE SWAPS WITH NO CODE CHANGE (C6): an optional Lambda ARN beside the registry.
    const profileServiceArn = userProfileServiceArn(this.node.tryGetContext('userProfileService'));

    const handlerRole = new iam.Role(this, 'AgentHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        // The handler READS channel classification metadata, member count and recent messages, and
        // SENDS its own acknowledgment on a bypass turn (ADR-025).
        //
        // WHY IT SENDS. The handler already composes the acknowledgment text (`getQuickResponse` /
        // `getTaskPlaceholder`, resolved from the profile version it loaded), so before this the words
        // were authored here and the ACT was performed elsewhere - by Chime on the Lex path, by the
        // channel flow on a bypass. One profile-resolved behavior reaching the channel by two routes
        // is the divergence class the `@all` and round-1 handoffs exist to remove. The Lex path is
        // unchanged and still materializes from the fulfillment return; this grant covers the bypass
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
            // `UpdateChannelMessage` is what makes the deferral notice ONE message. The design is
            // that a second queued message updates the notice in place rather than adding another,
            // and this role could only Send: every update was denied, the notice code fell through
            // to "post a fresh one rather than going quiet", and a burst of three drew three
            // near-identical notices - the exact doubling ADR-033 exists to prevent, reached by
            // an IAM gap rather than by any decision in the code.
            //
            // Same classification scope and same bot bearer as the send beside it: this lets the
            // assistant edit a message in a channel of its own classification, which is what it
            // already does to resolve its own placeholder from the processor role.
            // READS ONLY. Everything the router SAYS in a conversation - the placeholder, a refusal, a handover,
            // the queue notice - goes out on the session of the assistant it routed to (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b), which can
            // act only as that bot. This role can read as the classification's bots, to route, and cannot post
            // or edit as any of them.
            ...classificationChannelScopedAllow(classification, props.appInstanceArn, ['chime:DescribeChannel', 'chime:ListChannelMemberships', 'chime:ListChannelMessages', 'chime:GetChannelMessage'], { actor: 'assistant', bearerResources: [`${props.appInstanceArn}/bot/*`] }),
            // Read the immutable `classification` tag to resolve the served profile. A tag-READ cannot
            // itself be gated (it is how the profile is learned) — read-only, discloses only the tag.
            new iam.PolicyStatement({ actions: ['chime:ListTagsForResource'], resources: [`${props.appInstanceArn}/channel/*`] }),
            // ADR-012 drift scoping: ask the messaging service which channels ALL of this
            // conversation's human members belong to (`SearchChannels`, MEMBERS…INCLUDES), instead of
            // reconstructing that intersection from the Aurora archive, which lags exactly when
            // membership has just changed. A search is an app-instance operation, so it cannot carry
            // the per-channel tag condition the statement above uses — the BEARER is what bounds it.
            //
            // THE ASSISTANT BEARS THE SEARCH, AND THE GRANT HAS TO SAY SO.
            //
            // This comment used to read "the bearer is a HUMAN member, not the bot... rejects a bot bearer
            // outright", and the resources matched that belief: app-instance plus `user/*`. The belief was
            // disproved on 2026-09-30 and `scoped-channels.ts` was deliberately changed to bear as the
            // assistant - measured, with a control, in the comment above `searchAs` - but THIS grant was
            // not widened with it. Half a change landed.
            //
            // The cost was invisible, which is why it survived: every search came back AccessDenied on a
            // `bot/*` resource, the caller fails CLOSED and suggests nothing, so cross-conversation
            // suggestions simply never appeared and nothing told anyone. Found 2026-10-02 from a WARN line
            // the e2e's backend-error guard refused to let pass.
            //
            // STILL BOUNDED BY THE BEARER, which is what makes it safe either way: the service requires the
            // searching principal's own ARN among the MEMBERS values, so a search only ever returns channels
            // that principal already belongs to. `user/*` stays because a human bears the retry when the
            // service refuses the assistant for its membership limit.
            new iam.PolicyStatement({
              actions: ['chime:SearchChannels'],
              resources: [props.appInstanceArn, `${props.appInstanceArn}/user/*`, `${props.appInstanceArn}/bot/*`],
            }),
          ],
        }),
        BedrockPolicy: new iam.PolicyDocument({ statements: [
          // The classification's selection (a version's `models.classifier`), and the platform's utility model the
          // intent classifier runs on by default (`CLASSIFIER_MODEL_ID`).
          new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [...new Set([...classificationModelArns, ...utilityModelArns(this.region, this.account)])] }),
        ] }),
        SSMPolicy: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${botArnKey(classification)}`] }),
          // SPEC-PORTABLE-PROFILES P2/§6: the router resolves an A/B profileRef variant to the
          // referenced profile version's model — READ-ONLY on the assistant-definition namespace (reading a
          // definition is behavior, not a boundary, §7). Writes stay exclusive to the manage-profiles role.
          new iam.PolicyStatement({ actions: ['ssm:GetParameter', 'ssm:GetParameterHistory'], resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/definition`] }),
          // ── WHAT A ROOMMATE ADVERTISES, AND NOTHING ELSE ABOUT IT ──────────────────────────────
          //
          // A primary routing work to a specialist reads that specialist's ADVERTISEMENT: its intent
          // keys, their person-facing lines, and its authored boundary. This is a separate parameter
          // from the definition precisely so this grant can exist: the definition read above is
          // wildcarded across every assistant and not scoped by classification, so serving the
          // advertisement from it would make reading a peer's summary indistinguishable from reading
          // that peer's `instructions`, tool selection, persona and guardrail selection. The design
          // promises keys and one line and never implementation; this is the half of that promise which
          // is IAM rather than code (tenet D3: two layers, and the projection is the other one).
          //
          // READ-ONLY, and the write stays with the profile manager, which is what makes an
          // advertisement a statement by its own owner rather than something a peer can edit.
          new iam.PolicyStatement({
            sid: 'ReadWhatRoommatesAdvertise',
            actions: ['ssm:GetParameter'],
            resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/advertisement`],
          }),
          // WHICH ASSISTANT A LEX BOT SERVES. A Lex turn does not say which assistant was addressed
          // (DESIGN-ADDING-AN-ASSISTANT-ROLE §10a), so the handler resolves it from the Lex bot it
          // arrived on against these records. `GetParametersByPath` rather than `GetParameter` because
          // the turn cannot name the record it is looking for - that is the question - and scoped to this
          // classification's own subtree so it enumerates no other's.
          new iam.PolicyStatement({
            actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
            // Both the path and its children: `GetParametersByPath` authorizes against the path itself.
            resources: [
              `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant-assignments/${classification}`,
              `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant-assignments/${classification}/*`,
            ],
          }),
        ] }),
        DynamoDBPolicy: new iam.PolicyDocument({ statements: [
          // KEYED READS ONLY ON THE TASK TABLES. `Scan` is absent deliberately and belongs to the
          // experiments statement below.
          //
          // A task is scoped to its conversation by a KEY CONDITION (`channelArn = :ch`), which is
          // the only thing standing between one classification's assistant and another's tasks: the
          // grant itself carries no condition, because DynamoDB IAM cannot express one per row. A
          // `Scan` has no key condition, so granting it here makes that scope unenforceable rather
          // than merely unasserted, across every conversation and every classification at once.
          //
          // The processor's equivalent grant already draws this line (`Scan` on experiments alone);
          // this one did not, and the only code that would have used it (`scanActiveDueTasks`, the
          // due-date reminder sweep) has no caller.
          new iam.PolicyStatement({
            actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query'],
            resources: [
            // TASKS ARE NOT HERE ANY MORE (ADR-033, DESIGN-TASK-ACCESS).
            //
            // Every task read and write on the turn path goes through the task service, which is the
            // second enforcement layer this store never had: the grant carries no condition, and the
            // only thing scoping a read was a channelArn the caller supplied. Leaving the tables here
            // as well would keep the front door and the back door open at once, and the fallback in
            // `task-store` would silently prefer the back one on any deployment where the service
            // ARN was unset.
            //
            // What removes a bypass is not discipline. It is this.
              //
              // Per-user profile store: the router reads it on WelcomeIntent (once-per-user onboarding
              // gate) and writes it when the intake completes. Built-in stand-in; unused when an
              // implementer swaps in their own store via USER_PROFILE_SERVICE_ARN.
              shared.userProfileArn,
              // The battle tables a duel's turn reads and writes, and the experiments table the router
              // scans for the active experiment, are granted on this role in policies of their own, when
              // declared (`attachBattle`, `attachExperiments`).
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
        ...(selfPoolId || additionalUserPoolIds.length ? {
          CognitoReadPolicy: new iam.PolicyDocument({ statements: [
            new iam.PolicyStatement({
              // ListUsers resolves a federated person's `sub` to their pool username (`bySubjectOrUsername`, cognito-pool-directory.ts).
              actions: ['cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser', 'cognito-idp:ListUsers'],
              resources: [...new Set([selfPoolId, ...additionalUserPoolIds].filter(Boolean))].map(
                (poolId) => `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${poolId}`,
              ),
            }),
          ] }),
        } : {}),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    if (drift) {
      drift.grantTo(handlerRole);
      // ITS OWN MANAGED POLICY, NOT THE ROLE'S DEFAULT POLICY. IAM caps the inline policies on one role
      // at 10,240 bytes combined, and this role's default policy grows with every capability its
      // classification declares: premium's crossed the cap when one action was added here, and the stack
      // rolled back (ServiceLimitExceeded, 2026-10-06). A managed policy carries its own 6,144-byte budget.
      new iam.ManagedPolicy(this, 'AgentHandlerDriftCreatePolicy', {
        description: `Drift channel creation for the ${classification} agent handler`,
        statements: driftChannelCreateStatements(classification, props.appInstanceArn, this.region, this.account, serviceAdminArn, { linkPostedOnSession: true }),
        roles: [handlerRole],
      });
      // ── CONTINUING A SUBJECT SOMEWHERE ELSE (DESIGN 2.4.2) ──────────────────────────────────
      //
      // ON BY DEFAULT WHEREVER DRIFT AND THE QUEUE BOTH ARE, rather than a third switch an operator
      // has to find. The two halves are already decided: drift is the capability that spawns a
      // conversation from a parent one, and a deployment running it has accepted that grant; the
      // queue is what produces a reading covering several subjects at all. So this is wired here,
      // inside the drift branch, and the queue half is read from the environment at runtime - which
      // keeps turning the queue on a configuration change rather than a redeploy.
      //
      // ── AND IT IS ITS OWN FUNCTION BECAUSE OF WHAT IT HOLDS ─────────────────────────────────
      //
      // `chime:CreateChannel` cannot be tag-scoped the way the assistant's other rights are: the
      // tag that would gate it does not exist until the channel does. Granting it to the PROCESSOR
      // would put it in the component that executes model output, so a reply that talked its way
      // past the contract could open rooms. Here, the processor can only ASK, and the ask is checked
      // against the offer record the model never wrote.
      const splitRole = new iam.Role(this, 'ConversationSplitRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      });
      // The link in the parent goes out on the session the vend mints for the turn that asked, so the
      // creation statements carry no send.
      for (const stmt of driftChannelCreateStatements(classification, props.appInstanceArn, this.region, this.account, serviceAdminArn, { linkPostedOnSession: true })) {
        splitRole.addToPolicy(stmt);
      }
      // NO VEND INVOKE: the split speaks as nobody. The processor that asked posts the link to each new
      // conversation on its own turn session.
      // The offer it validates against lives on the turn-state record.
      turnQueue.grant(splitRole);

      // WHO IS IN THE PARENT CONVERSATION. A subject the room could already read carries the room
      // into its new conversation, and membership is Chime-owned state that has to be read live -
      // an archived copy is never the authority for a live access decision.
      //
      // THROUGH THE SHARED HELPER, which gets two things right that a hand-written statement got
      // wrong. It TAG-GATES the channel, so this role cannot enumerate the membership of a
      // conversation of another classification - the boundary every other channel read in this stack
      // sits behind. And it grants the BEARER resource, which Chime authorizes channel reads
      // against in addition to the channel: without it the call is denied at runtime, and
      // `parentMembers` swallows that and carries NOBODY - so a split would quietly produce a
      // conversation with the room left out of it, which is the failure the membership rule exists
      // to prevent.
      // THE SIDS ARE RENAMED, because this role already holds the helper's output once. IAM refuses
      // a policy with two statements of the same id, and `driftChannelCreateStatements` above
      // includes its own `classificationChannelScopedAllow` call for SendChannelMessage - so the
      // second call collides with the first and the whole stack update rolls back. Caught by a
      // failed deploy, not by synth: CloudFormation renders both happily and IAM rejects them.
      classificationChannelScopedAllow(
        classification, props.appInstanceArn, ['chime:ListChannelMemberships'],
        { actor: 'assistant', bearerResources: [`${props.appInstanceArn}/bot/*`] },
      ).forEach((stmt, i) => {
        stmt.sid = `SplitReadParentMembership${i === 0 ? 'Channel' : 'Bearer'}`;
        splitRole.addToPolicy(stmt);
      });

      // THE PARENT'S CLASSIFICATION TAG, which is what the split creates the new conversation at. The
      // request's classification is not trusted for that (CreateChannel and TagResource above are
      // app-scoped, so IAM would not stop a higher one), and without this read the function refuses
      // every split - fail closed, but silently useless. A tag READ cannot itself be tag-gated; it is
      // read-only and discloses only the tag, the same statement the router and task service carry.
      splitRole.addToPolicy(new iam.PolicyStatement({
        sid: 'SplitReadParentClassificationTag',
        actions: ['chime:ListTagsForResource'],
        resources: [`${props.appInstanceArn}/channel/*`],
      }));

      // WHICH ASSISTANTS THE NEW CONVERSATION HOLDS. Since the service admin creates the conversation, the
      // creator adds the assistants itself and reads who they are from the assignment records, the same
      // read `EventCreateResolveTypeNamedAssistants` carries. Without it every split was refused
      // (`ssm:GetParametersByPath` denied on `assistant-assignments/premium`, 2026-10-15) and nothing was
      // announced. Both the path and its children: `GetParametersByPath` authorizes against the path itself.
      splitRole.addToPolicy(new iam.PolicyStatement({
        sid: 'SplitResolveAssignedAssistants',
        actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant-assignments/${classification}`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant-assignments/${classification}/*`,
        ],
      }));

      const conversationSplit = new lambdaNodeJs.NodejsFunction(this, 'ConversationSplit', {
        entry: path.join(__dirname, '../../lambda/src/conversation-split.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        role: splitRole,
        environment: {
          APP_INSTANCE_ARN: props.appInstanceArn,
          CHANNEL_FLOW_ARN_PARAM: CHANNEL_FLOW_ARN_SSM_KEY,
          // The grant set: a parent tagged with a classification this deployment's does not grant is
          // refused, so this function never mints a conversation the processor that asked for it cannot reach.
          CLASSIFICATION: classification,
          // ── THE SPLIT CREATES A CONVERSATION, SO IT NEEDS WHAT CREATION READS ──────────────────
          //
          // This Lambda calls `createConversationFromDrift`, which reads and writes channel context.
          // Without the table name it took the "skipped" branch: every split-created room lost its
          // participant shape, its `parentRef` back-link to the conversation it came from, and on a
          // federated deployment the carried member identity - while the split reported success and
          // left only a `putChannelContext skipped` warning.
          CHANNEL_CONTEXT_TABLE: shared.channelContextName,
          // The service admin creates the split conversation, so its channel flow is attached before
          // any assistant is a member. Same parameter, same runtime read as the event creator.
          CREATOR_BEARER_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn,
          ...turnQueue.env,
        },
        bundling: { minify: false, forceDockerBundling: false },
      });

      // The split reads the same one parameter for its creating identity. Declared here rather than with
      // the other two because this role only exists when the split is wired.
      splitRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${INSTANCE_SSM.appInstanceAdminArn}`,
        ],
      }));

      // The same NARROW pair the processor holds on this table, for the same reason: the split
      // patches owned fields on a context row it is creating. No PutItem, no Delete, no Scan.
      splitRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [shared.channelContextArn],
      }));

      // The processor may ask, and only ask.
      conversationSplit.grantInvoke(actingRole);
      asyncProcessor.addEnvironment('CONVERSATION_SPLIT_FUNCTION_ARN', conversationSplit.functionArn);

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
      drift.grantTo(actingRole);
    }

    // ── OPENING A TYPED CONVERSATION BECAUSE SOMETHING HAPPENED (ADR-053 Phase 1) ─────────────────
    //
    // WIRED FROM THE REGISTRY, NOT FROM A FLAG. The function exists where this classification is named
    // by a conversation type that is not simply its own classification - today that is `ops` naming
    // `premium`, and on a deployment of any other classification this block adds nothing. The
    // declaration is what decides, so adding a type is the whole of enabling it, and a deployment that
    // declared none is not carrying a creator it has no use for.
    //
    // OUTSIDE THE DRIFT BRANCH ABOVE, deliberately. Drift is a capability a deployment may decline, and
    // a conversation type has nothing to do with it; nesting this there would make `ops` silently
    // unavailable wherever drift is off, for no reason anybody could find.
    const eventInitiatedTypes = Object.entries(CONVERSATION_TYPES)
      // An EVENT-OPENED type that permits this classification, or one a person's confirmed proposal opens: a type that
      // sources a participant role from `{ creator: true }` (ADR-061 `open_conversation`). A person-opened type
      // (`initiation` absent or 'user') that no proposal opens has no business with a manually invokable creator.
      .filter(([key, cfg]) => ((!!cfg.initiation && cfg.initiation !== 'user')
        || Object.values(cfg.participants?.participantRoles ?? {}).some((r) => r.from.some((src) => 'creator' in src)))
        && classificationAllowedForType(key, classification))
      .map(([key]) => key);
    if (eventInitiatedTypes.length > 0) {
      // ITS OWN ROLE, PINNED TO ONE CLASSIFICATION, which is what makes a manually invokable creator
      // safe to have at all. `driftChannelCreateStatements` is the same statement set the split role
      // holds - named for its first caller rather than for drift as a capability - and the statement
      // that matters here is `chime:TagResource` conditioned on
      // `aws:RequestTag/classification`: this role can stamp this classification and no other, whatever
      // its payload says. The handler checks the same thing twice more (the type must permit the
      // classification, and the conversation the event concerned must already carry it), which is the
      // two-enforcement-layers rule in tenet D3.
      const eventCreateRole = new iam.Role(this, 'TypedConversationFromEventRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      });
      // It posts nothing into the conversation the event concerned, so the creation statements carry no send.
      for (const stmt of [
        ...driftChannelCreateStatements(classification, props.appInstanceArn, this.region, this.account, serviceAdminArn, { linkPostedOnSession: true }),
      ]) {
        eventCreateRole.addToPolicy(stmt);
      }

      // THE CONCERNED CONVERSATION'S CLASSIFICATION TAG. The handler refuses an event whose concerned
      // conversation is at another classification, and it cannot make that check without reading the tag. A tag read
      // cannot itself be tag-gated; it is read-only and discloses only the tag.
      eventCreateRole.addToPolicy(new iam.PolicyStatement({
        sid: 'EventCreateReadConcernedClassificationTag',
        actions: ['chime:ListTagsForResource'],
        resources: [`${props.appInstanceArn}/channel/*`],
      }));

      // WHICH ASSISTANT ANSWERS TO WHICH HANDLE. The conversation type names its assistants by handle,
      // and the assignment records are the authority on which assistant holds which role. Scoped to
      // this classification's own subtree, so a handle cannot resolve to an assistant in another
      // classification - `(premium, ops)` and `(standard, ops)` are different role instances with
      // different scopes. BOTH the path and its children: `GetParametersByPath` authorizes against the
      // path itself and not only the parameters beneath it, so the wildcard alone is denied on the call
      // that enumerates.
      eventCreateRole.addToPolicy(new iam.PolicyStatement({
        sid: 'EventCreateResolveTypeNamedAssistants',
        actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant-assignments/${classification}`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant-assignments/${classification}/*`,
        ],
      }));

      // The create bearer: this classification's primary assistant, which is a channel member by
      // creation itself.
      eventCreateRole.addToPolicy(new iam.PolicyStatement({
        sid: 'EventCreateReadOwnBotArn',
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${botArnKey(classification)}`],
      }));

      const typedConversationFromEvent = new lambdaNodeJs.NodejsFunction(this, 'TypedConversationFromEvent', {
        // FIXED, so the apply endpoint of an `open_conversation` proposal names it (`typedCreatorName`).
        functionName: typedCreatorName(classification),
        entry: path.join(__dirname, '../../lambda/src/typed-conversation-from-event.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(60),
        memorySize: 256,
        role: eventCreateRole,
        environment: {
          APP_INSTANCE_ARN: props.appInstanceArn,
          CHANNEL_FLOW_ARN_PARAM: CHANNEL_FLOW_ARN_SSM_KEY,
          // The one classification. The handler creates at this classification and refuses an event naming a
          // conversation at any other, and the role may stamp no other value.
          CLASSIFICATION: classification,
          BOT_ARN_PARAM: botArnKey(classification),
          
          // Creation reads and writes channel context, and an unset table name makes that write a
          // SILENT no-op: the conversation would come up without its participant shape, without its
          // link back, and - on a federated deployment - without the carried member identity, while
          // the creation reported success. The split function lost exactly that once.
          CHANNEL_CONTEXT_TABLE: shared.channelContextName,
          // THE SERVICE ADMIN CREATES THE CHANNEL, so the channel flow is attached before any assistant
          // is a member. Passed as the PARAMETER NAME and read at runtime, the same way BOT_ARN_PARAM is,
          // so this stack does not need the admin ARN as a prop.
          CREATOR_BEARER_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn,
          // A type with a membership source adds its group's members, each admitted against this
          // classification (DESIGN-CONVERSATION-TYPES §6), so the creator reads the group and the groups.
          USER_POOL_ID: selfPoolId,
          // Where the classification's message templates are, for the room's name: the bucket, and the root their
          // pointers are under, which the read grant below names (`messageTemplateReadStatements`).
          TEMPLATE_BUCKET: props.attachmentsBucketName,
          SSM_ROOT,
        },
        bundling: { minify: false, forceDockerBundling: false },
      });
      // WHO IT OPENS CONVERSATIONS FOR, which the apply endpoint's invoke is bounded by (`ownInstanceMemberConversationFunctions`).
      tagAudience(typedConversationFromEvent, classification);
      // The group's members are people: each is resolved through Identities and admitted on the groups
      // the directory reports for them. One account is read by subject for the name its welcome greets, and
      // an event naming its person by address is looked up in the pool (`Directory.findByAddress`).
      grantDirectoryRead(typedConversationFromEvent, {
        appInstanceArn: props.appInstanceArn,
        userPoolId: selfPoolId,
        poolReads: ['cognito-idp:ListUsersInGroup', 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser'],
      });

      // The one parameter the creator reads for its bearer. Narrow on purpose: it is an identity, and a
      // wildcard here would let this role read every assistant's published ARN as well.
      //
      // GRANTED TO EVERY ROLE THAT CREATES A CONVERSATION, not just this one. There are three paths -
      // the event creator here, the conversation split, and the live-drift confirm inside the handler -
      // and a role that cannot read it refuses every creation (`NoServiceAdminError`), since none creates
      // as the assistant. So the grant is listed rather than assumed.
      const serviceAdminParamRead = new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${INSTANCE_SSM.appInstanceAdminArn}`,
        ],
      });
      eventCreateRole.addToPrincipalPolicy(serviceAdminParamRead);
      handlerRole.addToPrincipalPolicy(serviceAdminParamRead);

      // The same NARROW pair every other writer on this table holds: owned-field patches on a row this
      // function is creating. No PutItem, no Delete, no Scan.
      eventCreateRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [shared.channelContextArn],
      }));
      // THE ROOM IS NAMED FROM THE conversation-name TEMPLATE its assistant words (`conversation-name.ts`), so the
      // creator reads this classification's message templates, as the router does.
      for (const stmt of messageTemplateReadStatements(this, props.attachmentsBucketArn, classification)) eventCreateRole.addToPrincipalPolicy(stmt);

      // THE DECLARED EVENTS THAT OPEN A TYPE AT THIS CLASSIFICATION (`openedBy`, lib/config/event-openers.ts):
      // one EventBridge rule each, targeting this function with a dead-letter queue, bounded retries and an
      // alarm, and the router invoke its welcomes need (lib/constructs/event-opened-conversations.ts). A
      // direct invoke still works, for the platform's own standing room and for an operator.
      wireEventOpenedConversations(this, { classification, creator: typedConversationFromEvent, creatorRole: eventCreateRole });
      new cdk.CfnOutput(this, 'TypedConversationFromEventFunctionName', {
        value: typedConversationFromEvent.functionName,
        description:
          `Opens a typed conversation (${eventInitiatedTypes.join(', ')}) for an event, posting nothing `
          + 'into the conversation it concerned. Invoke: aws lambda invoke --function-name <this> --payload \'{"detail":'
          + '{"conversationType":"ops","concernedChannelArn":"...","forUserArn":"...","topicLabel":"..."}}\' out.json',
      });
    }

    // ── THE GROUP-MEMBERSHIP RECONCILE (DESIGN-CONVERSATION-TYPES §6) ─────────────────────────────────
    //
    // Keeps every live conversation of a type whose membership is sourced from a group equal to that
    // group, at THIS classification only. ONE PER CLASSIFICATION (owner decision, 2026-10-05): it acts as
    // this classification's own assistant, which moderates only conversations created at this
    // classification, and Amazon Chime SDK refuses a membership change to anyone who is not a moderator.
    // IAM holds the same line: its membership changes are conditioned on the channel's classification
    // and on its assistant's (step 31).
    //
    // EVENT-DRIVEN FIRST (tenet D6): a Cognito group change arrives as the CloudTrail-recorded API call, via
    // the platform trail in the foundations stack, and invokes it within seconds. The daily schedule is
    // the backstop for an event that was dropped, never the primary mechanism. Built only where some type
    // sources its membership from a group at this classification, so a classification with none carries
    // nothing it does not use.
    // A type's group must require the type's classification of its members, or the type names people it refuses.
    assertTypeGroupsRequireTheirClassifications(defaultProfileRegistry);
    // A PLATFORM WORKFLOW WITH NO `types` that names a participant role runs everywhere, and addresses nobody where a type
    // does not declare the role: synthesis records each such reference as a warning (ADR-061 decision 1).
    for (const [name, wf] of Object.entries(PLATFORM_EVENT_WORKFLOWS)) {
      for (const warning of eventWorkflowRoleWarnings(name, wf)) cdk.Annotations.of(this).addWarning(warning);
    }
    // A type's participant roles name only sources a path fills and conferrals a reader binds (DESIGN-CONVERSATION-TYPES 6.1).
    assertParticipantRolesAreDeclared({
      membershipGroups: defaultProfileRegistry.membershipGroups(),
      outside: defaultProfileRegistry.outsideClassificationValues(),
    });
    // The groups a participant role is sourced from are reconciled too: the reconcile keeps their holdings (section 6.1).
    const roleSourceGroups = roleGroups(classification);
    const sourcedGroups = [...new Set([...membershipSourceGroups(classification), ...roleSourceGroups])].sort();
    if (sourcedGroups.length > 0) {
      const reconcileRole = new iam.Role(this, 'GroupMembershipReconcileRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      });
      // READ THE ROOM, as this classification's bot, on this classification's channels only.
      classificationChannelScopedAllow(
        classification, props.appInstanceArn, ['chime:ListChannelMemberships', 'chime:ListChannelModerators'],
        { actor: 'assistant', bearerResources: [`${props.appInstanceArn}/bot/*`] },
      ).forEach((stmt, i) => {
        stmt.sid = `ReconcileReadRoom${i === 0 ? 'Channel' : 'Bearer'}`;
        reconcileRole.addToPolicy(stmt);
      });
      // CHANGE THE ROOM, in this classification's conversations only and bearing this classification's
      // assistant (step 31): the channel leg and the bot leg both carry the classification tag. The
      // member added or removed is a request parameter IAM never sees; Amazon Chime SDK's own rule that
      // only a moderator of the channel may add or remove a member bounds it, and this classification's
      // assistant moderates only this classification's rooms.
      for (const stmt of membershipAsAssistantStatements('ReconcileMembership', props.appInstanceArn, [classification],
        ['chime:CreateChannelMembership', 'chime:DeleteChannelMembership', 'chime:DeleteChannelModerator'])) {
        reconcileRole.addToPolicy(stmt);
      }
      reconcileRole.addToPolicy(new iam.PolicyStatement({
        sid: 'ReconcileReadClassificationTag',
        actions: ['chime:ListTagsForResource'],
        resources: [`${props.appInstanceArn}/channel/*`],
      }));
      reconcileRole.addToPolicy(new iam.PolicyStatement({
        sid: 'ReconcileReadOwnBotArn',
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${botArnKey(classification)}`],
      }));
      // FIND THE ROOMS: the sparse, keys-only index over the stamped type. Query only - no item reads.
      reconcileRole.addToPolicy(new iam.PolicyStatement({
        sid: 'ReconcileFindConversationsOfType',
        actions: ['dynamodb:Query'],
        resources: [`${shared.channelContextArn}/index/ByConversationType`],
      }));
      // A GROUP-SOURCED PARTICIPANT ROLE'S HOLDINGS (DESIGN-CONVERSATION-TYPES section 6.1), only where a type declares one at
      // this classification: the row's `participantRoles` attribute alone, read and written; the moderation a role confers,
      // bearing this classification's assistant in its own rooms; and `person-joined` named to this classification's router
      // for a person a role adds.
      if (roleSourceGroups.length) {
        reconcileRole.addToPolicy(new iam.PolicyStatement({
          sid: 'ReconcileParticipantRoleHoldings',
          actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
          resources: [shared.channelContextArn],
          conditions: {
            'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['channelArn', 'participantRoles'] },
            StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'], 'dynamodb:Select': ['SPECIFIC_ATTRIBUTES'] },
          },
        }));
        for (const stmt of membershipAsAssistantStatements('ReconcileRoleModeration', props.appInstanceArn, [classification], ['chime:CreateChannelModerator'])) {
          reconcileRole.addToPolicy(stmt);
        }
        for (const stmt of sayThroughRouterWiring(this, [classification], { resolvesPrimary: false }).statements) reconcileRole.addToPolicy(stmt);
      }

      const reconcileFn = new lambdaNodeJs.NodejsFunction(this, 'GroupMembershipReconcile', {
        entry: path.join(__dirname, '../../lambda/src/group-membership-reconcile.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.minutes(5),
        memorySize: 256,
        role: reconcileRole,
        environment: {
          APP_INSTANCE_ARN: props.appInstanceArn,
          CLASSIFICATION: classification,
          BOT_ARN_PARAM: botArnKey(classification),
          USER_POOL_ID: selfPoolId,
          CHANNEL_CONTEXT_TABLE: shared.channelContextName,
          ...(roleSourceGroups.length ? sayThroughRouterWiring(this, [classification], { resolvesPrimary: false }).env : {}),
        },
        bundling: { minify: false, forceDockerBundling: false },
      });
      // The group's members are people: each is resolved through Identities and admitted on the groups
      // the directory reports for them.
      grantDirectoryRead(reconcileFn, {
        appInstanceArn: props.appInstanceArn,
        userPoolId: selfPoolId,
        poolReads: ['cognito-idp:ListUsersInGroup', 'cognito-idp:AdminListGroupsForUser'],
      });

      // THE EVENT. Add and remove name the group; a deleted, disabled or re-enabled user changes every
      // group they count in, so those reconcile every sourced group. Matched on this deployment's own pool.
      if (selfPoolId) new events.Rule(this, 'GroupMembershipChanged', {
        description: `Reconcile ${classification} conversations whose membership is sourced from a group (${sourcedGroups.join(', ')})`,
        eventPattern: {
          source: ['aws.cognito-idp'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventSource: ['cognito-idp.amazonaws.com'],
            eventName: ['AdminAddUserToGroup', 'AdminRemoveUserFromGroup', 'AdminDeleteUser', 'AdminDisableUser', 'AdminEnableUser'],
            requestParameters: { userPoolId: [selfPoolId] },
          },
        },
        targets: [new eventTargets.LambdaFunction(reconcileFn)],
      });
      // THE BACKSTOP. Daily, because it only has to catch what the event path dropped.
      new events.Rule(this, 'GroupMembershipBackstop', {
        schedule: events.Schedule.rate(cdk.Duration.days(1)),
        targets: [new eventTargets.LambdaFunction(reconcileFn)],
      });
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
        resources: [
          `${props.attachmentsBucketArn}/profiles/*`,
          // The classification's own intent-pack body, behind its parameter's pointer. This prefix only.
          ...(topo.intentPackParam ? [`${props.attachmentsBucketArn}/${classificationPackPrefix(classification)}*`] : []),
        ],
      }),
    );

    // THE CLASSIFICATION'S OWN MESSAGE TEMPLATES (ADR-062 decision 2): the router says notices and asks for
    // join recaps from an assistant's own template, else the classification's, else the shipped one, so it reads
    // `templates/<classification>/` and that classification's pointers whatever its workflows declare. Read-only,
    // this classification's prefix and no other's; managed, because this role's inline policies sit near IAM's
    // size cap. No role of a turn writes a template.
    new iam.ManagedPolicy(this, 'RouterMessageTemplatesRead', {
      roles: [handlerRole],
      statements: messageTemplateReadStatements(this, props.attachmentsBucketArn, classification),
    });

    const handlerEnv: Record<string, string> = {
      CLASSIFICATION: classification,
      // THE ROLE THIS HANDLER SERVES, and it is a turn-path fact rather than an analytics one here.
      // The alt-bot identity guard admits the alt of THIS (classification, role) and no other, so a
      // handler that cannot say which role it serves admits no alt at all. `ASSISTANT_ROLES[0]` is
      // the one declared role; when a classification declares more, each gets its own handler and
      // this reads that handler's role.
      ASSISTANT_ROLE: ASSISTANT_ROLES[0],
      PROFILE_BODY_BUCKET: props.attachmentsBucketName,
      ...(drift?.env ?? {}),
      ...(drift ? { CHANNEL_FLOW_ARN_PARAM: CHANNEL_FLOW_ARN_SSM_KEY } : {}),
      SSM_ROOT,
      ONBOARDING_INTAKE_PARAM: onboardingIntakeParamName,
      ASSISTANT_WELCOME_PARAM: welcomeParamName,
      BOT_ARN_PARAM: botArnKey(classification),
      // The live-drift confirm creates a conversation from inside this handler, so it needs the same
      // creating identity as the other two paths: the service admin, so the channel flow is attached
      // before any assistant is a member and the welcome goes through it.
      CREATOR_BEARER_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn,
      [classificationEnvName(classification, 'ASYNC_PROCESSOR_ARN')]: asyncProcessor.functionArn,
      APP_INSTANCE_ARN: props.appInstanceArn,
      AWS_ACCOUNT_ID: this.account,
      USER_POOL_ID: selfPoolId,
      // Intent classification is a cheap, high-frequency call — always Haiku (on-demand-capable), never
      // the profile primary (a bare on-demand id for Opus/Sonnet is rejected by Bedrock).
      // THE PLATFORM'S UTILITY MODEL, like the archive's summaries: intent classification is the platform's,
      // so it runs whatever models the classification selects (the router's BedrockPolicy grants it).
      CLASSIFIER_MODEL_ID: UTILITY_MODEL_ID,
      TASKS_TABLE: shared.agentTasksName,
      USER_TASKS_TABLE: shared.userTasksName,
      // Built-in per-user profile store (once-per-user onboarding gate + durable facts). A deployment that
      // declares `userProfileService` (C6) reaches its own store instead: the ARN is set below with the
      // invoke grant, and the client prefers it. See SPEC-USER-PROFILE-AND-ONBOARDING.md.
      USER_PROFILE_TABLE: shared.userProfileName,
      ...(profileServiceArn ? { USER_PROFILE_SERVICE_ARN: profileServiceArn } : {}),
      CHANNEL_CONTEXT_TABLE: shared.channelContextName,
      ...(experiments ? { EXPERIMENTS_TABLE: experiments.experimentsName } : {}),
      ...abuse.env,
      ...turnQueue.env,
    };
    if (topo.intentPackParam) handlerEnv.ASSISTANT_INTENT_PACK_PARAM = intentPackParamName;
    if (battle) {
      handlerEnv.BATTLE_STATE_TABLE = battle.battleStateName;
      handlerEnv.CHANNEL_BATTLE_CONFIG_TABLE = battle.channelBattleConfigName;
    }

    // A TURN THAT CANNOT START IS REPORTED TO AN ADMINISTRATOR (`reportTurnNotStarted`), through the same
    // admin-alert path the processor uses: an `ae.alert` event, and no message send of its own.
    Object.assign(handlerEnv, errAlert.env);
    errAlert.grant(handlerRole);
    // AN INVITATION'S EVENT IS VERIFIED AGAINST THE INVITATION'S RECORD (ADR-061 decision 1). `invitation-sent` arrives
    // the moment after the record is written, so the router reads that record by the key its writer names, strongly
    // consistent and only the attributes verifying needs (`invitationRecordReadStatement`); the eventually consistent
    // index could miss it and refuse a real event. Every other read (a deadline that fires, a hand-back, an archive's
    // cancel) lists the conversation's invitations through the sparse index (`invitationIndexReadStatement`). Neither
    // reaches a token of another kind or writes anything. Only a classification a person may be invited into holds them.
    // Its own managed policy, because this role's inline policies sit near IAM's size cap.
    if (defaultProfileRegistry.memberClassificationValues().includes(classification)) {
      handlerEnv.TOKENS_TABLE = ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.tokensName);
      const tokensArn = ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.tokensArn);
      new iam.ManagedPolicy(this, 'AgentHandlerInvitationRead', {
        roles: [handlerRole],
        statements: [
          invitationIndexReadStatement(tokensArn, 'VerifyAnInvitationEvent'),
          invitationRecordReadStatement(tokensArn, 'VerifyAJustWrittenInvitation'),
        ],
      });
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

    // ── DEADLINES (ADR-061 decision 1): THIS CLASSIFICATION'S SCHEDULE GROUP AND SCHEDULER ROLE ──────────────
    //
    // `invitation-unredeemed` is a one-shot EventBridge Scheduler schedule the router creates when it handles
    // `invitation-sent`, so only a classification a person may be invited into has one. The group is this
    // classification's alone: the router may create and delete schedules in it and nowhere else, and may pass only this
    // classification's scheduler role, to the scheduler service alone. The scheduler role is trusted by the scheduler
    // service only for schedules in this group of this account, and may invoke this classification's router and no
    // other function. A schedule carries ids alone, and the router checks the record it names when it fires. Each is
    // deny-tested in `a-deadline-reaches-only-its-own-router.test.ts`.
    if (defaultProfileRegistry.memberClassificationValues().includes(classification)) {
      const deadlineGroupName = `${RES_PREFIX}-${classification}-event-deadlines`.slice(0, 64);
      new scheduler.CfnScheduleGroup(this, 'EventDeadlineGroup', { name: deadlineGroupName });
      const deadlineSchedules = `arn:aws:scheduler:${this.region}:${this.account}:schedule/${deadlineGroupName}/*`;
      // THE SCHEDULER NAMES THE GROUP AS ITS SOURCE: it checks it may assume this role when a schedule is created, presenting
      // the schedule group's ARN, so the trust is bound to this group (not to its schedules' ARNs, which it never presents).
      const deadlineGroupArn = `arn:aws:scheduler:${this.region}:${this.account}:schedule-group/${deadlineGroupName}`;
      const deadlineRole = new iam.Role(this, 'EventDeadlineSchedulerRole', {
        assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
          conditions: { StringEquals: { 'aws:SourceAccount': this.account, 'aws:SourceArn': deadlineGroupArn } },
        }),
        description: `Fires ${classification}'s deadline schedules at its own router, and nothing else`,
      });
      new iam.Policy(this, 'EventDeadlineSchedulerInvoke', {
        roles: [deadlineRole],
        statements: [new iam.PolicyStatement({
          sid: 'FireThisClassificationsRouter',
          actions: ['lambda:InvokeFunction'],
          resources: [agentHandler.functionArn, `${agentHandler.functionArn}:*`],
        })],
      });
      new iam.ManagedPolicy(this, 'AgentHandlerDeadlineSchedules', {
        roles: [handlerRole],
        statements: [
          new iam.PolicyStatement({
            sid: 'ManageThisClassificationsDeadlines',
            actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule'],
            resources: [deadlineSchedules],
          }),
          new iam.PolicyStatement({
            sid: 'PassThisClassificationsSchedulerRole',
            actions: ['iam:PassRole'],
            resources: [deadlineRole.roleArn],
            conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
          }),
        ],
      });
      agentHandler.addEnvironment('EVENT_DEADLINE_GROUP', deadlineGroupName);
      agentHandler.addEnvironment('EVENT_DEADLINE_ROLE_ARN', deadlineRole.roleArn);

      // A DEADLINE THAT COULD NOT BE SCHEDULED IS RAISED, NOT SWEPT FOR (ADR-061 decision 1, decided): the router retries
      // the create with backoff in the same call, then counts `DeadlineScheduleFailed`, and this alarm tells an operator
      // through the one notifier (`alarm-to-admin-channel.ts`). No sweep and no poll stands behind it.
      const deadlineAlarmTopic = new sns.Topic(this, 'EventDeadlineAlarmTopic', {
        displayName: `Deadline schedules not created (${classification})`,
      });
      const deadlineAlarmFn = new lambdaNodeJs.NodejsFunction(this, 'EventDeadlineAlarmFunction', {
        entry: path.join(__dirname, '../../lambda/src/alarm-to-admin-channel.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(30),
        environment: { ...errAlert.env },
      });
      errAlert.grant(deadlineAlarmFn.role!);
      deadlineAlarmTopic.addSubscription(new snsSubscriptions.LambdaSubscription(deadlineAlarmFn));
      const deadlineAlarm = new cloudwatch.Alarm(this, 'EventDeadlineUnscheduledAlarm', {
        alarmName: `${this.stackName}-event-deadline-unscheduled`,
        alarmDescription:
          `A deadline schedule (invitation-unredeemed) could not be created after its retries (${classification}), so that `
          + "invitation will not be chased. Read the router's log line \"[Router][deadline] ... could not be created\" for the "
          + "error: AccessDenied means the router's schedule grant or its scheduler role is missing, ValidationException "
          + "a malformed schedule, ServiceQuotaExceeded the account's schedule quota.",
        metric: new cloudwatch.Metric({
          namespace: DEADLINE_METRIC_NAMESPACE,
          metricName: DEADLINE_SCHEDULE_FAILED_METRIC,
          dimensionsMap: { Classification: classification },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      deadlineAlarm.addAlarmAction(new cloudwatchActions.SnsAction(deadlineAlarmTopic));
      deadlineAlarm.addOkAction(new cloudwatchActions.SnsAction(deadlineAlarmTopic));
    }

    // ── THE INCIDENT WATCH (ADR-061 slice 5): `alarm-state-changed` FROM ITS ONE SOURCE ──────────────────────────────
    //
    // Built where a conversation type this classification opens declares an opener that names an alarm its room watches
    // (`watchesAlarm`, `lib/config/event-openers.ts`). One rule on the account's default bus matches a CloudWatch alarm
    // state change of this deployment's alarms (`incidentWatchAlarmPrefixes`) and hands the router the alarm's name and
    // the state it reported, nothing else. `LambdaFunction` admits this rule's ARN alone to the router's resource policy.
    // The router reads the alarm back by name before anything runs, under the one alarm read below, which reaches this
    // deployment's alarms and no other. Both are deny-tested in `the-incident-watch-reaches-only-its-own-router.test.ts`.
    if (eventOpenersAt(CONVERSATION_TYPES, classification).some((o) => openerWatchesAlarms(o.opener))) {
      const prefixes = incidentWatchAlarmPrefixes();
      const watchRule = new events.Rule(this, 'IncidentWatchAlarmChanges', {
        description: `Hands ${classification}'s router each state change of this deployment's alarms, for the rooms that watch them`,
        eventPattern: incidentWatchPattern(prefixes),
      });
      watchRule.addTarget(new eventTargets.LambdaFunction(agentHandler, {
        event: events.RuleTargetInput.fromObject({
          aeAlarm: { alarmName: events.EventField.fromPath('$.detail.alarmName'), state: events.EventField.fromPath('$.detail.state.value') },
        }),
        retryAttempts: 4,
        maxEventAge: cdk.Duration.hours(1),
      }));
      new iam.ManagedPolicy(this, 'AgentHandlerAlarmRead', {
        roles: [handlerRole],
        statements: [new iam.PolicyStatement({
          sid: 'ReadThisDeploymentsAlarms',
          actions: ['cloudwatch:DescribeAlarms'],
          resources: prefixes.map((p) => `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:${p}*`),
        })],
      });
    }

    // ── PROPOSALS (ADR-061 decision 8, rule 8): THE ASSISTANT RECORDS WHAT ITS AGENT STEP PROPOSES ──────────────
    //
    // Proposing is the turn's act, so the record is written on the assistant's session (tenet D1: a turn acts as the
    // assistant), never on the processor's role. A `proposal` record in the token store, `PutItem` on `proposal#*`
    // alone: the session can neither read nor consume one, and reaches no other kind. The apply endpoint
    // (`proposals-api.ts`, Conversations) consumes it.
    asyncProcessor.addEnvironment('TOKENS_TABLE', ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.tokensName));
    new iam.ManagedPolicy(this, 'AssistantProposalWrite', {
      roles: [actingRole],
      statements: [new iam.PolicyStatement({
        sid: 'RecordAnAgentStepsProposal',
        actions: ['dynamodb:PutItem'],
        resources: [ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.tokensArn)],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': leadingKeysFor(['proposal']) } },
      })],
    });

    if (profileServiceArn) {
      agentHandler.addToRolePolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [profileServiceArn] }));
    }
    // WHO A PERSON IS, BY AppInstanceUser: the router names the sender and the room's members and reads the
    // sender's clearance through the directory, which reaches each person's issuer subject through
    // Identities. Its pool reads are in CognitoReadPolicy above; this adds the table and index reads, as its
    // own managed policy because this role's inline policies sit near IAM's size cap.
    grantDirectoryRead(agentHandler, {
      appInstanceArn: props.appInstanceArn,
      userPoolId: selfPoolId,
      additionalPoolIds: additionalUserPoolIds,
      poolReads: [],
      managed: true,
    });
    // THE ROUTER POSTS ON A SPEAK SESSION, whose edge carries the conversation read its boundary check makes, so
    // it waits for every grant policy: a router updated before the speak edge would be refused that read.
    for (const policy of grantCatalog.policies) agentHandler.node.addDependency(policy);
    // THE HANDOVER INVOKES THIS SAME FUNCTION as the assistant that owns the chain.
    //
    // A message answers the TASK, not whoever it was addressed to, so an assistant that receives one it
    // does not own hands the turn to the one that does (rule 1, owner 2026-08-14). It cannot be sent as
    // a message: ADR-023 measured that Amazon Chime SDK does not deliver a bot-authored message to
    // another bot's Lex, so it would reach nobody.
    //
    // SELF is the whole target set, not a shortcut. Every identity this handler may answer as is one
    // `isSanctionedBattleBot` sanctions - this classification's own bot, or its alt - and this
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
    // the generated physical name would exceed 64 characters, so this handler's name can carry a
    // shortened stack name (measured on a
    // 34-character stack name), and a pattern built from the full stack name matches nothing. That grant deploys clean and denies at runtime.
    new iam.Policy(this, 'AgentHandlerSelfInvoke', {
      roles: [handlerRole],
      statements: [
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [agentHandler.functionArn],
        }),
        // THE STOP-EVALUATION DISPATCH (ADR-033). The judged half of a `/stop` is a turn the router
        // dispatches to ITSELF, behind the acknowledgment - and like the drain's return path below,
        // the router cannot carry its own ARN in its environment (the same role-default-policy cycle),
        // so it reads it from the parameter this stack publishes. The invoke grant above already
        // existed; this read is what makes the ARN reachable. Without BOTH, `resolveRouterArn`
        // returns undefined at runtime and every stop logs "the stop goes unexplained" - unit-green,
        // typechecked, and inert when deployed, which is exactly the failure shape this repo has
        // shipped once before.
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [cdk.Arn.format(
            { service: 'ssm', resource: 'parameter', resourceName: routerArnKey(classification).replace(/^\//, '') },
            this,
          )],
        }),
      ],
    });
    // The parameter NAME is a literal string and refers to nothing, so unlike the ARN it closes no
    // cycle. Same mechanism as the processor's triage dispatch below.
    agentHandler.addEnvironment('ROUTER_ARN_PARAM', routerArnKey(classification));
    abuse.grant(handlerRole);
    turnQueue.grant(handlerRole);
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
    // ── THE DRAIN'S RETURN PATH (ADR-033) ────────────────────────────────────────────────────────
    //
    // When a turn ends holding queued messages, the processor answers them as ONE new turn - which
    // means invoking this router, the same entry every other re-dispatch uses (the `@all` bypass, the
    // battle round-2 fan-out, the task-answer repair).
    //
    // THE ARN IS NOT HANDED TO IT. It is looked up at runtime, from the parameter this stack already
    // publishes, and the reason is a cycle CloudFormation cannot deploy through.
    //
    // The router carries the processor's ARN in its environment, and CDK makes a function depend on
    // its role's default policy. So putting the ROUTER's arn in the PROCESSOR's environment closes
    // AsyncProcessor -> AgentHandler -> AgentHandlerRoleDefaultPolicy -> AsyncProcessor, and no
    // ordering of the assignment escapes it: `addEnvironment` after both exist produces the same
    // template. The edge itself has to go.
    //
    // What goes in instead is the PARAMETER NAME, which is a literal string and refers to nothing.
    // The value behind it is written by this same deployment, and the processor reads it on the
    // triage path only - so a container that never triages never makes the call, and one that does
    // makes it once.
    //
    // It cannot run away. The dispatched turn takes the lock like any other and drains only what
    // queued while IT ran, so an empty queue dispatches nothing and the chain stops as soon as the
    // person stops sending.
    asyncProcessor.addEnvironment('ROUTER_ARN_PARAM', routerArnKey(classification));
    // ITS OWN POLICY, for the reason spelled out on `AgentHandlerSelfInvoke` above: `grantInvoke`
    // writes onto the role's DEFAULT policy, which the processor function depends on, so the
    // statement naming the router would close the same cycle a second way.
    new iam.Policy(this, 'ProcessorTriageDispatch', {
      roles: [processorRole],
      statements: [
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [agentHandler.functionArn],
        }),
        // ITSELF, to resume an answer parked for a reading (ADR-033, `lib/parked-turn.ts`). The reading
        // and the answer it resumes are both this classification's turns, so the target is this one
        // function and nothing else. In this separate policy for the same cycle reason as above.
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [asyncProcessor.functionArn],
        }),
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [cdk.Arn.format(
            { service: 'ssm', resource: 'parameter', resourceName: routerArnKey(classification).replace(/^\//, '') },
            this,
          )],
        }),
      ],
    });

    // ── THE TASK SERVICE (DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING) ───────────────────────────────
    //
    // ONE PER CLASSIFICATION, AND THAT IS THE BOUNDARY ITSELF.
    //
    // A direct Lambda invoke attests nothing about its caller, so a service cannot read "which
    // classification is asking" from the request: `clientContext` is set by the caller and
    // `requestContext.identity` is an API Gateway construct a direct invoke never populates. Asking
    // the caller to state its classification would be exactly the declared value this replaces.
    //
    // So the classification is the FUNCTION'S. Each classification stack deploys its own service,
    // stamped with `SERVICE_CLASSIFICATION`, and only this stack's roles are granted to invoke it.
    // A premium turn cannot ask the basic service, because the invoke is denied at IAM rather than
    // refused inside the handler - which is what makes the boundary expressible here at all, and
    // assertable at synth (`test/task-store-boundary.test.ts`).
    //
    // NO `dynamodb:Scan`, for the reason the router's grant now records: a task is scoped to its
    // conversation by a key condition, and a scan has none.
    const taskServiceRole = new iam.Role(this, 'TaskServiceRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        TaskStore: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            actions: [
              'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
              'dynamodb:DeleteItem', 'dynamodb:Query',
            ],
            resources: [
              shared.agentTasksArn, `${shared.agentTasksArn}/index/*`,
              shared.userTasksArn, `${shared.userTasksArn}/index/*`,
            ],
          })],
        }),
        // The classification tag, which is what every refusal is decided on. A tag READ cannot itself
        // be tag-gated - it is how the classification is learned - so it is unconditioned and
        // read-only, the same statement and the same reasoning the router already carries.
        ChannelTagRead: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            actions: ['chime:ListTagsForResource'],
            resources: [`${props.appInstanceArn}/channel/*`],
          })],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    const taskService = new lambdaNodeJs.NodejsFunction(this, 'TaskService', {
      entry: path.join(__dirname, '../../lambda/src/task-service.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      // It reads a tag and up to three keyed rows. A budget past that would only hide a defect.
      timeout: cdk.Duration.seconds(10),
      memorySize: 512,
      role: taskServiceRole,
      environment: {
        // THE ONE FACT NO CALLER CAN INFLUENCE. Everything the service refuses, it refuses against
        // this value.
        SERVICE_CLASSIFICATION: classification,
        TASKS_TABLE: shared.agentTasksName,
        USER_TASKS_TABLE: shared.userTasksName,
        // ── THE DEPLOYMENT'S OWN TASK STATE MACHINES (code review, 2026-09-09) ───────────────────
        //
        // `task-tracking` reads the pack's machines in two places that now run in HERE rather than
        // in the router: the state `createTask` opens a task in, and the `awaits` boundary that
        // decides whether a finished step hands the work back to a person. Without the pointer the
        // service resolved the platform DEFAULTS, so a pack-defined state produced no awaited party
        // and the task stayed assistant-owned - the deployment's taxonomy accepted and then ignored.
        //
        // Set only where a pack exists, exactly as the handler's is: an absent pointer is the
        // documented "run the defaults" path, not a degraded one.
        ...(topo.intentPackParam ? { ASSISTANT_INTENT_PACK_PARAM: intentPackParamName, PROFILE_BODY_BUCKET: props.attachmentsBucketName } : {}),
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    // And the read that makes the pointer mean anything. Read-only, on the ONE parameter, and only
    // for a profile that has a pack: `hydrateIntentPackFromSsm` logs and keeps the defaults when the
    // fetch fails, so a missing grant degrades silently - which is how the env-less version of this
    // went unnoticed. Granting it is what makes the machines the deployment declared the ones it runs.
    if (topo.intentPackParam) {
      taskService.addToRolePolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [intentPackParamArn],
      }));
      // The body the parameter points at, on this classification's pack prefix only.
      taskService.addToRolePolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`${props.attachmentsBucketArn}/${classificationPackPrefix(classification)}*`],
      }));
      // The processor reads the same pack on the assistant's session (FR17).
      actingRole.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'ReadTheDeploymentIntentPack',
        actions: ['ssm:GetParameter'],
        resources: [intentPackParamArn],
      }));
    }

    // ── THE TASK SERVICE NAMES WHAT CHANGED TO ITS OWN ROUTER, AND TO NO OTHER FUNCTION (ADR-063 decision E1) ───────
    //
    // A task a workflow run waits on that settled, and a task that became an assistant's to take up. Found by name at
    // call time (no deploy-time reference, so no cycle with the router that invokes this service), the invoke scoped to
    // this instance's router of THIS classification, and this classification's assignment records read to refuse an
    // assistant that is not its own. Deny-tested in `a-task-service-reaches-only-its-own-router.test.ts`.
    const taskServiceNames = sayThroughRouterWiring(this, [classification]);
    for (const stmt of taskServiceNames.statements) taskService.addToRolePolicy(stmt);
    for (const [k, v] of Object.entries({ ...taskServiceNames.env, SSM_ROOT })) taskService.addEnvironment(k, v);

    // Both halves of a turn ask it. `grantInvoke` is safe here where it was not for the router: the
    // service references neither function, so there is no edge back and no cycle to close.
    taskService.grantInvoke(actingRole);
    taskService.grantInvoke(handlerRole);
    asyncProcessor.addEnvironment('TASK_SERVICE_ARN', taskService.functionArn);
    agentHandler.addEnvironment('TASK_SERVICE_ARN', taskService.functionArn);

    new lambda.CfnPermission(this, 'AgentHandlerLexInvoke', {
      action: 'lambda:InvokeFunction',
      functionName: agentHandler.functionName,
      principal: 'lexv2.amazonaws.com',
      sourceAccount: this.account,
    });
    const handlerArn = agentHandler.functionArn;

    // WHO MAY ASK FOR A SESSION: the processor, which runs the turn. It holds no `sts:AssumeRole` of its
    // own on the acting role, and the role does not trust it.
    assistantVend.grantInvoke(processorRole);
    asyncProcessor.addEnvironment('ASSISTANT_VEND_ARN', assistantVend.functionArn);
    // WHO MAY DECIDE: the router writes the routing record for every turn it dispatches, and for its own
    // invocation, whose conversation calls it makes as the assistant it routed to.
    turnRouting.grant(handlerRole, 'dynamodb:PutItem');
    agentHandler.addEnvironment('TURN_ROUTING_TABLE', turnRouting.tableName);
    assistantVend.grantInvoke(handlerRole);
    agentHandler.addEnvironment('ASSISTANT_VEND_ARN', assistantVend.functionArn);
    // For the routing services in other stacks (the channel flow, the battle orchestrator).
    new ssm.StringParameter(this, 'AssistantVendArnParam', {
      parameterName: vendArnKey(classification),
      stringValue: assistantVend.functionArn,
      description: `The ${classification} assistant vend: mints a session for a routed assistant`,
    });

    // Publish the router/AgentHandler ARN (like processor-arn) so the admin console can deep-link to this
    // classification's Lex-fulfillment/classification Lambda for troubleshooting (SPEC-ASSISTANT-CONFIG).
    const routerArnParam = new ssm.StringParameter(this, 'RouterArnParam', {
      parameterName: routerArnKey(classification),
      stringValue: agentHandler.functionArn,
      description: `Router/AgentHandler ARN for ${classification} classification`,
    });
    // WHO THE ROUTER SERVES, on the router and the parameter that names it: a shared caller that names notices to
    // the routers of member conversations is bounded by this tag rather than a list (`memberRoutersByNameStatements`).
    tagAudience(agentHandler, classification);
    tagAudience(routerArnParam, classification);

    // The task service, for the admin plane. It lives in another stack and asks every
    // classification about a conversation, because a channel belongs to one and the console does
    // not know which - so it needs these by name rather than by reference.
    new ssm.StringParameter(this, 'TaskServiceArnParam', {
      parameterName: taskServiceArnKey(classification),
      stringValue: taskService.functionArn,
      description: `Task service ARN for ${classification} classification`,
    });

    // ── WHAT EVERY ASSISTANT OF THIS CLASSIFICATION RUNS ON, AND THE SEED THAT ASKS FOR THEM ──────────────
    //
    // NO ASSISTANT IDENTITY IS THIS STACK'S (ADR-048, amended 2026-10-24). Each assistant's `AppInstanceBot`, its
    // own Amazon Lex bot, its assignment record and its name binding are the provisioner's (`Messaging`), built once
    // from the declaration below and the console's from then on. What stays here is what they run in: the router,
    // the processor and the acting role above. The role Amazon Lex runs each bot as, and the conversation log group
    // its text logs go to (`lib/correlation.ts` reads one record per Amazon Lex invocation), are the provisioner's,
    // one for every assistant: Amazon Lex invokes the router through its resource policy (`AgentHandlerLexInvoke`).

    // ── THE DECLARATION: WHICH ASSISTANTS THIS CLASSIFICATION ASKS FOR ────────────────────────────────────
    //
    // Its primary and each deployed role's live assistant (by the registry's one naming rule, `roleAssistantName`),
    // and, below, where a duel is wired, the alt of each platform role a duel fields. Each live assistant is named
    // what a person calls it (the profile's display name), because an `@` token is matched against the Amazon Chime
    // SDK member NAME. A duel's alt joins silently: Battle Mode turning on is announced by the room's primary.
    const declared: DeclaredAssistant[] = this.deployedRoles(classification).map((role) => {
      const assistantId = defaultProfileRegistry.roleAssistantName(classification, role);
      if (!assistantId) throw new Error(`role ${role} is not declared on classification ${classification}`);
      return {
        assistantId, role, occupancy: 'live' as const,
        displayName: defaultProfileRegistry.displayNameFor(assistantId) || assistantId,
        welcome: true,
      };
    });
    const seed = new DeclaredAssistantsSeed(this, 'DeclaredAssistants', {
      classification,
      roles: this.deployedRoles(classification),
      assistants: declared,
      fulfillmentArn: handlerArn,
    });
    this.appInstanceBotArn = seed.primaryBotArn;
    const declarations = [seed.resource];
    // A DUEL'S ALTS, where `battle` is declared, in a declaration of their own on the same seed: declaring the
    // capability adds that resource and changes none the stack had, and withdrawing it removes the alts alone.
    if (battle) {
      const alts: DeclaredAssistant[] = ASSISTANT_ROLES.map((role) => {
        const assistantId = defaultProfileRegistry.altAssistantName(classification, role);
        if (!assistantId) throw new Error(`role ${role} is not declared on classification ${classification}`);
        return { assistantId, role, occupancy: 'alt' as const, displayName: `Alt-${classification}-${role}`, welcome: false };
      });
      declarations.push(seed.declare(this, 'DeclaredDuelAlts', alts));
    }

    // ── THIS CLASSIFICATION'S ROW OF THE RUNTIME REGISTRY ──────────────────────────────────────────
    //
    // Its own declaration, its profiles and its groups, under the registry's path and as its S3 copy, where every handler reads
    // the deployment's set (`loadProfileRegistry`). This stack is the only writer, so adding the classification
    // adds its row and the stack delete that removes it removes the row, and no other stack carries it.
    const registryRow = publishRegistryRow(this, 'ProfileRegistryRow', classification);
    // THE ROW IS PUBLISHED BEFORE THE SEED ASKS: the provisioner holds a declaration to the names the registry gives
    // this classification, so a role this deploy adds must be in the row it reads. On the classification's removal
    // the seed is deleted first, while the row still names it.
    for (const d of declarations) d.node.addDependency(registryRow.parameter);

    // A DEPLOYMENT POINTER TO THE PRIMARY'S IDENTITY, read from the seed's answer: the identity is the provisioner's,
    // and this parameter only says where it is. A room's speaker is never resolved from it (`primaryAssistantOf`).
    new ssm.StringParameter(this, 'ClassificationBotArnParam', {
      parameterName: botArnKey(classification),
      stringValue: this.appInstanceBotArn,
      description: `AppInstanceBot ARN for ${classification} classification — read by create-conversation`,
    });

    // THE PROCESSOR IS NOT GIVEN THE BOT ARN AS AN ENV VAR. A turn resolves its own bot at runtime from the
    // assignment records, and the published pointer above carries the primary's without a synth-time edge.

    this.attachPoints = {
      classification,
      actingRole,
      handlerRole,
      richProcessor: topo.richProcessor,
      handlerExperimentsIndex: topo.handlerExperimentsIndex === true,
      battleWired: Boolean(battle),
    };

    // THIS CLASSIFICATION'S PART IN A DECLARED CAPABILITY, built here on the capability's fixed names, so a
    // classification is added or removed with its grants and no capability stack names it. A duel's alt is in the
    // declaration above.
    if (this.attachPoints.battleWired) attachBattle(this, this.attachPoints);
    if (props.experiments) attachExperiments(this, this.attachPoints);

    new cdk.CfnOutput(this, 'ClassificationAsyncProcessorArn', { value: asyncProcessor.functionArn });
    new cdk.CfnOutput(this, 'ClassificationAppInstanceBotArn', { value: this.appInstanceBotArn });

    cdk.Tags.of(this).add('Component', topo.componentTag);
    cdk.Tags.of(this).add('classification', classification);
  }
}
