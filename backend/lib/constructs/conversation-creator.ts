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
import { bindTargetOf, GUEST_VISITOR_TYPE } from '../config/conversation-types';

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

/**
 * A classification's TYPED creator's fixed function name (`typed-conversation-from-event.ts`): the creator that opens a
 * typed conversation for an event, an operator, or a confirmed `open_conversation` proposal (ADR-061 decision 8).
 * Fixed, so the apply endpoint (`proposals-api.ts`) names it without a dependency on the classification's stack.
 */
export function typedCreatorName(classification: string): string {
  const name = `${STACK_PREFIX}Assistants-${classification}-TypedCreator`;
  if (name.length > 64) throw new Error(`typedCreatorName: "${name}" is longer than Lambda's 64 characters`);
  return name;
}

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
  /** Where the classification's message templates are: the room it opens is named from its `conversation-name` template. */
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

    // THE CONTEXT CLASSIFICATION: the one the trusted-issuer registry's oneChannel issuers name, at which a
    // host's context conversations are created. Its creator also serves the context request, and its role also
    // holds the re-open reads below.
    const servesContext = classification === issuers.contextClassification();
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
            // A CONTEXT CONVERSATION'S RE-OPEN: whether the caller is already in it, and its Metadata refresh, as
            // the service admin, in a channel of this classification. It also reads the channel to find whether a
            // creation that stopped part way left it without its flow, and attaches the flow before any member
            // (`reseatContextOpener`), through the creator grant's `AssociateChannelFlow`.
            ...(servesContext ? [
              new iam.PolicyStatement({
                sid: 'ContextReopenOwnClassificationChannel',
                actions: ['chime:UpdateChannel', 'chime:DescribeChannel', 'chime:DescribeChannelMembership', 'chime:ListChannelMemberships'],
                resources: [`${appInstanceArn}/channel/*`],
                conditions: ownClassification,
              }),
              new iam.PolicyStatement({
                sid: 'ContextReopenAsTheServiceAdmin',
                actions: ['chime:UpdateChannel', 'chime:DescribeChannel', 'chime:DescribeChannelMembership', 'chime:ListChannelMemberships'],
                resources: [serviceAdminArn],
              }),
            ] : []),
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
    // WHICH HOST TITLE A CONTEXT ROOM WAS NAMED FROM, and no other attribute of the row: a reopen renames the room from
    // its context only while it still carries that title (SPEC-CONVERSATION-TYPES FR32).
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadTheTitleARoomWasNamedFrom',
      actions: ['dynamodb:GetItem'],
      resources: [props.channelContextTableArn],
      conditions: {
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['topic'] },
        StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
      },
    }));
    // A room is created for its classification's primary and tagged with it (§3.8).
    for (const stmt of roomPrimaryReadStatements(stack, [classification])) role.addToPolicy(stmt);
    // THE ROOM IS NAMED FROM ITS ASSISTANT'S conversation-name TEMPLATE (`conversation-name.ts`): a visitor's and a
    // customer's room are created with that name, so the creator reads this classification's message templates.
    for (const stmt of messageTemplateReadStatements(stack, props.templateBucketArn, classification)) role.addToPolicy(stmt);

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
        // Whether it also creates a host's context conversations (the registry's oneChannel issuers).
        ...(servesContext ? { CONTEXT_CONVERSATIONS: 'true' } : {}),
        // The visitor's assistant's model is named by catalog key and resolved to its id per account.
        ...(servesVisits ? { AWS_ACCOUNT_ID: stack.account } : {}),
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
