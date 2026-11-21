/**
 * A CLASSIFICATION'S CONVERSATION CREATOR, built by the classification's own
 * `Assistants-<classification>` stack, so declaring a classification adds its creator with its own stack and
 * changes no other stack (the classification-independence plan, step 4).
 *
 * A conversation is created by its classification's own creator, and the classification is the FUNCTION's
 * (`CREATOR_CLASSIFICATION`), never the request's. Its role holds the drift creators' grant for that one
 * classification (`driftChannelCreateStatements`): `CreateChannel` only when the request is tagged with it and
 * its audience, the tag stamped only as it, the membership changes only in its channels, bearing only the
 * service admin. So no role creating a conversation spans classifications, and a creator asked for another
 * classification is refused by its handler and by IAM.
 *
 * WHO MAY ASK IT: the function has a fixed name (`conversationCreatorName`) and carries the stack's
 * `classification` tag and its own `audience` tag, and its ARN is published under the classification's own key
 * (`conversationCreatorArnKey`). A caller reads the key at call time and is granted the invoke by the name
 * pattern, this instance's `Instance` tag and the tag the caller is bounded to (`conversationCreatorInvoke`):
 * the create-conversation API any member classification's, guest start the visitor classification's alone, and a
 * path A bind only a creator tagged `bindTarget`, which a classification's own stack sets when its classification is
 * where a visit continues (`bindTargetOf`).
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  CHANNEL_FLOW_ARN_SSM_KEY, INSTANCE_NAME, INSTANCE_SSM, RES_PREFIX, SSM_ROOT, STACK_PREFIX, driftChannelCreateStatements, modelArnsForClassification,
  roomPrimaryReadStatements, messageTemplateReadStatements, type Classification,
} from '../stacks/agent-classification-common';
import { getModelCatalog } from '../config/model-strategy';
import { INSTANCE_TAG } from '../tagging';
import { AUDIENCE_TAG } from '../../lambda/src/lib/channel-classification';
import { defaultProfileRegistry as profiles } from '../profile-registry';
import { issuersOf } from './trusted-issuers';
import { bindTargetOf, CONVERSATION_TYPES, GUEST_VISITOR_TYPE, PATTERN_ROOM_TAG_KEY, classificationAllowedForType, isPatternType } from '../config/conversation-types';

/**
 * The tag a creator carries when its classification is where a path A bind continues a visit (`bindTargetOf`).
 * Set by the classification's own stack, so a bind target added or removed changes no caller's grant.
 */
export const BIND_TARGET_TAG = 'bindTarget';

/** A caller bounded to the creators a visit can continue at: those tagged `bindTarget`. */
export function bindTargetCreatorsOnly(): Record<string, Record<string, unknown>> {
  return { StringEquals: { [`aws:ResourceTag/${BIND_TARGET_TAG}`]: 'true' }, Null: { 'aws:ResourceTag/classification': 'false' } };
}

/** The SSM key a classification's creator ARN is published under, beside its router's. */
export function conversationCreatorArnKey(classification: string): string {
  return `${SSM_ROOT}/assistant/${classification}/conversation-creator-arn`;
}

/** The SSM root a caller reads a creator's ARN under (`CONVERSATION_CREATOR_PARAM_ROOT`). */
export const CONVERSATION_CREATOR_PARAM_ROOT = `${SSM_ROOT}/assistant`;

/** A classification's creator's fixed function name. Refused at synth past Lambda's 64 characters. */
export function conversationCreatorName(classification: string): string {
  const name = `${STACK_PREFIX}Assistants-${classification}-ConversationCreator`;
  if (name.length > 64) throw new Error(`conversationCreatorName: "${name}" is longer than Lambda's 64 characters`);
  return name;
}

/** The stand-ins a name pattern carries in place of a classification: a runtime placeholder, and an IAM wildcard. */
const CLASSIFICATION_STANDINS: readonly string[] = ['{classification}', '*'];

/**
 * A classification's TYPED creator's fixed function name (`typed-conversation-from-event.ts`): the creator that opens a
 * typed conversation for an event, an operator, or a confirmed `open_conversation` proposal (ADR-061 decision 8).
 * Fixed, so the apply endpoint (`proposals-api.ts`) names it without a dependency on the classification's stack.
 * Lambda's 64-character bound holds for a real classification's name; a pattern (`{classification}`, `*`) is not a name,
 * and its own length bounds nothing.
 */
export function typedCreatorName(classification: string): string {
  const name = `${STACK_PREFIX}Assistants-${classification}-TypedCreator`;
  if (name.length > 64 && !CLASSIFICATION_STANDINS.includes(classification)) throw new Error(`typedCreatorName: "${name}" is longer than Lambda's 64 characters`);
  return name;
}

/** The function a trigger's rule targets at a classification, which hands the event to that classification's router. */
export function eventTriggerRelayName(classification: string): string {
  return `${STACK_PREFIX}Assistants-${classification}-EventTriggerRelay`;
}

/** The name every rule an event trigger creates begins with at a classification (`event-triggers-api.ts`). */
export function eventTriggerRulePrefix(classification: string): string {
  // A SEPARATOR AFTER THE INSTANCE PREFIX, as alarm names have, so `AgentEchelon-*` never matches `AgentEchelonTwo-*`.
  return `${STACK_PREFIX}-${classification}-trigger-`;
}

/** The name every watch rule begins with at a classification (DESIGN-EVENT-TARGETS section 4), followed by a 12-hex id. */
export function eventWatchRulePrefix(classification: string): string {
  return `${STACK_PREFIX}-${classification}-watch-`;
}

/** An IAM resource pattern for exactly this classification's rules of one kind: twelve characters after the prefix, so `premium-watch` is never `premium`. */
export const twelveCharIds = (prefix: string): string => `${prefix}????????????`;

/**
 * INVOKE A CREATOR OF THIS INSTANCE, FOUND BY NAME AT CALL TIME: read the classification's key, and invoke a
 * function of the creators' name pattern carrying this instance's `Instance` tag and `bound` (a tag condition:
 * the `audience` a caller serves, or the one `classification` it may ask). No ARN and no list of classifications.
 */
export function conversationCreatorInvoke(stack: cdk.Stack, sid: string, bound: Record<string, Record<string, unknown>>, parameterFor = '*'): iam.PolicyStatement[] {
  const conditions: Record<string, Record<string, unknown>> = { ...bound };
  conditions.StringEquals = { ...(bound.StringEquals ?? {}), [`aws:ResourceTag/${INSTANCE_TAG}`]: INSTANCE_NAME };
  return [
    new iam.PolicyStatement({
      sid,
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${stack.region}:${stack.account}:function:${STACK_PREFIX}Assistants-*-ConversationCreator`],
      conditions,
    }),
    new iam.PolicyStatement({
      sid: `${sid}FoundByName`,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${stack.region}:${stack.account}:parameter${conversationCreatorArnKey(parameterFor)}`],
    }),
  ];
}

/** A caller bounded to the deployment's own people's creators: a member classification's, by its `audience` tag. */
export function memberCreatorsOnly(): Record<string, Record<string, unknown>> {
  return { StringEquals: { [`aws:ResourceTag/${AUDIENCE_TAG}`]: 'members' }, Null: { 'aws:ResourceTag/classification': 'false' } };
}

export interface ConversationCreatorProps {
  classification: string;
  appInstanceArn: string;
  /** The channel-context table (Conversations), by its published name and ARN. */
  channelContextTableName: string;
  channelContextTableArn: string;
  /**
   * Where the classification's message templates are: the room it opens is named from its `conversation-name` template.
   * The same bucket holds profile bodies under `profiles/*`, which the visitors' creator reads (below).
   */
  templateBucketName: string;
  templateBucketArn: string;
}

export class ConversationCreator extends Construct {
  public readonly function: lambda.IFunction;

  constructor(scope: Construct, id: string, props: ConversationCreatorProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const { classification, appInstanceArn } = props;
    // THE ONE IDENTITY EVERY CONVERSATION IS CREATED AS (step 33). No bot-bearing create, tag or membership
    // change: a deployment with no service admin refuses creation rather than creating as an assistant.
    const serviceAdminArn = `${appInstanceArn}/user/${RES_PREFIX}-admin`;
    const issuers = issuersOf(this);

    // THE VISITORS' CLASSIFICATION, whose creator also assesses and retires a visitor's conversation when its
    // visit carries over (FR26, P-12): it reads the visit's messages and deletes the channel as the service
    // admin, on a channel of its own classification only, and asks the visitor's assistant's model.
    const visitorClassification = (issuers.guest()?.clearance as { fixed?: string[] } | undefined)?.fixed?.[0];
    const servesVisits = classification === visitorClassification;
    const ownClassification = { StringEquals: { 'aws:ResourceTag/classification': classification } };

    const role = new iam.Role(this, 'Role', {
      // A fixed name, as the function's, so a reader of the account finds it whichever stack built it.
      roleName: conversationCreatorName(classification),
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            ...driftChannelCreateStatements(classification as Classification, appInstanceArn,
              stack.region, stack.account, serviceAdminArn, { linkPostedOnSession: true }),
            // AN ARCHIVED PATTERN CONVERSATION IS CREATED AGAIN AT ITS ID (DESIGN-EVENT-TARGETS 11.2): its delete is admitted on a
            // channel in this classification's pattern namespace only, tagged archived and of this classification, and only where
            // the classification permits a pattern type at all.
            ...(classificationHasPatternTypes(classification) ? [new iam.PolicyStatement({
              sid: 'RecreateAnArchivedPatternConversation',
              actions: ['chime:DeleteChannel'],
              resources: [`${appInstanceArn}/channel/pat-${classification}-*`],
              conditions: { StringEquals: { 'aws:ResourceTag/classification': classification, 'aws:ResourceTag/archived': 'true' } },
            }),
            new iam.PolicyStatement({ sid: 'RecreateAsTheServiceAdmin', actions: ['chime:DeleteChannel'], resources: [serviceAdminArn] })] : []),
            // THE TYPES THIS CREATOR STAMPS, bounded by IAM as well as by its code (DESIGN-EVENT-TARGETS 11.2): a create of a type
            // this classification does not permit is refused, and a pattern conversation's tag names a declared pattern type.
            ...creatorTypeBounds(classification, appInstanceArn),
            ...(servesVisits ? [
              new iam.PolicyStatement({
                sid: 'VisitReadAndRetireOwnClassificationChannel',
                actions: ['chime:ListChannelMessages', 'chime:DeleteChannel'],
                resources: [`${appInstanceArn}/channel/*`],
                conditions: ownClassification,
              }),
              new iam.PolicyStatement({ sid: 'VisitReadAndRetireAsTheServiceAdmin', actions: ['chime:ListChannelMessages', 'chime:DeleteChannel'], resources: [serviceAdminArn] }),
              new iam.PolicyStatement({
                sid: 'VisitAssessedOnTheAssistantsModel',
                actions: ['bedrock:InvokeModel'],
                resources: modelArnsForClassification(classification as Classification, getModelCatalog(stack.region, stack.account)),
              }),
              new iam.PolicyStatement({
                sid: 'VisitAssessedWithTheAssistantsVersion',
                actions: ['ssm:GetParameter'],
                resources: [
                  `arn:aws:ssm:${stack.region}:${stack.account}:parameter${SSM_ROOT}/assistant/*/definition`,
                  // THE CLASSIFICATION'S GUARDRAIL CATALOG, which this stack publishes.
                  `arn:aws:ssm:${stack.region}:${stack.account}:parameter${SSM_ROOT}/assistant/${classification}/guardrails`,
                ],
              }),
              // WHAT THE MODEL WROTE PASSES THE CLASSIFICATION'S OWN GUARDRAIL before it is stored or shown, by the
              // classification tag this stack puts on everything it holds: this classification's, and no other's.
              new iam.PolicyStatement({
                sid: 'VisitAssessmentPassesTheClassificationsGuardrail',
                actions: ['bedrock:ApplyGuardrail'],
                resources: [`arn:aws:bedrock:${stack.region}:${stack.account}:guardrail/*`],
                conditions: ownClassification,
              }),
            ] : []),
          ],
        }),
        SSMPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter'],
              // THE SERVICE ADMIN THIS FUNCTION CREATES AS. Named rather than wildcarded: it is an identity.
              resources: [`arn:aws:ssm:${stack.region}:${stack.account}:parameter${INSTANCE_SSM.appInstanceAdminArn}`],
            }),
          ],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    // WHO will be in the conversation, written before the assistant is added (SPEC-USER-PROFILE-AND-ONBOARDING
    // §2), so the welcome reads it. UpdateItem only.
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'WriteWhoIsInTheConversation',
      actions: ['dynamodb:UpdateItem'],
      resources: [props.channelContextTableArn],
    }));
    // A room is created for its classification's primary and tagged with it (§3.8).
    for (const stmt of roomPrimaryReadStatements(stack, [classification])) role.addToPolicy(stmt);
    // THE ROOM IS NAMED FROM ITS ASSISTANT'S conversation-name TEMPLATE (`conversation-name.ts`): a visitor's and a
    // customer's room are created with that name, so the creator reads this classification's message templates.
    for (const stmt of messageTemplateReadStatements(stack, props.templateBucketArn, classification)) role.addToPolicy(stmt);
    // THE VISITOR'S ASSISTANT'S VERSION IS READ WHOLE, its persona and pack bodies included: an assessment runs on
    // the version that was approved or does not run (`resolveActiveProfile`), so its bodies must be readable here.
    if (servesVisits) {
      role.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [`${props.templateBucketArn}/profiles/*`] }));
    }

    const fn = new lambdaNodeJs.NodejsFunction(this, 'Function', {
      functionName: conversationCreatorName(classification),
      entry: './lambda/src/create-conversation-at-classification.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      // 1024 MB, for the CPU it buys: a cold open is mostly first-call SDK work, which at 256 MB ran on about a
      // seventh of a vCPU (docs/guides/developer/PERFORMANCE-OPTIMIZATION.md, "Opening a conversation").
      memorySize: 1024,
      bundling: { minify: false, forceDockerBundling: false },
      environment: {
        SSM_ROOT,
        APP_INSTANCE_ARN: appInstanceArn,
        CHANNEL_FLOW_ARN_PARAM: CHANNEL_FLOW_ARN_SSM_KEY,
        // THE SERVICE ADMIN CREATES THE CHANNEL, so the channel flow is attached before any assistant is a
        // member and every welcome passes through it.
        CREATOR_BEARER_ARN_PARAM: INSTANCE_SSM.appInstanceAdminArn,
        CHANNEL_CONTEXT_TABLE: props.channelContextTableName,
        // THE CLASSIFICATION THIS FUNCTION CREATES, and the only one.
        CREATOR_CLASSIFICATION: classification,
        TEMPLATE_BUCKET: props.templateBucketName,
        // The visitor's assistant's model is named by catalog key and resolved to its id per account.
        ...(servesVisits ? { AWS_ACCOUNT_ID: stack.account, PROFILE_BODY_BUCKET: props.templateBucketName } : {}),
      },
      role,
    });
    // WHO THE CREATOR IS FOR, which a caller's invoke is bounded by (`memberCreatorsOnly`).
    cdk.Tags.of(fn).add(AUDIENCE_TAG, profiles.audienceOf(classification));
    // WHETHER A VISIT MAY CONTINUE HERE, which the credential exchange's bind invoke is bounded by
    // (`bindTargetCreatorsOnly`). The handler still refuses any other (`bindTargetOf`).
    if (bindTargetOf(GUEST_VISITOR_TYPE, classification)) cdk.Tags.of(fn).add(BIND_TARGET_TAG, 'true');
    this.function = fn;

    new ssm.StringParameter(this, 'Arn', {
      parameterName: conversationCreatorArnKey(classification),
      stringValue: fn.functionArn,
      description: `The ${classification} classification's conversation creator, which a caller finds by name at call time`,
    });
  }
}

/**
 * WHAT IAM REFUSES THE CREATOR WHATEVER ITS CODE ASKS: a conversation of a type its classification does not permit, and a
 * pattern conversation tagged with anything but a declared pattern type. Denies, so no allow elsewhere outweighs them.
 */
export function creatorTypeBounds(classification: string, appInstanceArn: string): iam.PolicyStatement[] {
  const permitted = Object.keys(CONVERSATION_TYPES).filter((k) => classificationAllowedForType(k, classification)).sort();
  const patterns = permitted.filter((k) => isPatternType(k));
  const resources = [appInstanceArn, `${appInstanceArn}/channel/*`];
  return [
    new iam.PolicyStatement({
      sid: 'NeverCreateATypeTheClassificationDoesNotPermit', effect: iam.Effect.DENY, actions: ['chime:CreateChannel'], resources,
      conditions: { StringNotEquals: { 'aws:RequestTag/conversationType': permitted } },
    }),
    new iam.PolicyStatement({
      sid: 'NeverTagAPatternConversationOfAnotherType', effect: iam.Effect.DENY, actions: ['chime:CreateChannel'], resources,
      conditions: patterns.length
        ? { StringNotEquals: { [`aws:RequestTag/${PATTERN_ROOM_TAG_KEY}`]: patterns }, Null: { [`aws:RequestTag/${PATTERN_ROOM_TAG_KEY}`]: 'false' } }
        : { Null: { [`aws:RequestTag/${PATTERN_ROOM_TAG_KEY}`]: 'false' } },
    }),
  ];
}

/** Whether a classification permits any type whose standing conversations a pattern names. */
export function classificationHasPatternTypes(classification: string): boolean {
  return Object.keys(CONVERSATION_TYPES).some((k) => classificationAllowedForType(k, classification) && isPatternType(k));
}
