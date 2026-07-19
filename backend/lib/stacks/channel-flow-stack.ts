/**
 * Channel Flow Stack
 *
 * Creates a Chime SDK Channel Flow Processor that runs on every message
 * before Lex processing. Handles:
 * - @all mention routing (bypasses Lex, responds directly as bot)
 * - Message filtering and moderation
 * - Idempotency for at-least-once delivery
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';
import {
  SSM_ROOT,
  STACK_PREFIX,
  INSTANCE_SSM,
  processorArnKey,
  CHANNEL_FLOW_ARN_SSM_KEY,
} from './agent-tier-common';

/** SSM parameter key for the channel flow ARN. Read at runtime by create-conversation
 *  so we avoid a circular stack dependency with FoundationsStack. Re-exported from the
 *  namespace foundation so existing `from './channel-flow-stack'` imports keep working. */
export { CHANNEL_FLOW_ARN_SSM_KEY };

export interface ChannelFlowStackProps extends cdk.StackProps {
  appInstanceArn: string;
  /** BattleStateTable name + ARN for initial INVOKED row writes and orchestrator state queries */
  battleStateTableName?: string;
  battleStateTableArn?: string;
  /** ChannelBattleConfigTable for reading whether a channel has /battle enabled */
  channelBattleConfigTableName?: string;
  channelBattleConfigTableArn?: string;
  /** PRIMARY IDP user pool — the processor resolves participant emails by sub (AdminGetUser) when
   *  fanning a notify-tagged channel message out over email, for targets without an explicit issuer.
   *  Identity is never persisted; it is the single source of truth resolved at send time. */
  userPoolId?: string;
  /** Additional trusted IDP pools, for conversations whose members span MULTIPLE IDPs. A notify
   *  target's issuer is resolved to its pool and must be in this set (∪ primary) to be looked up. */
  additionalUserPoolIds?: string[];
  /** Verified SES sender for the outbound notification transport (SPEC-NOTIFICATION-BRIDGE P1). */
  senderEmail?: string;
}

export class ChannelFlowStack extends cdk.Stack {
  public readonly channelFlowArn: string;
  public readonly processorFunctionArn: string;

  constructor(scope: Construct, id: string, props: ChannelFlowStackProps) {
    super(scope, id, props);

    // @all fan-out and /battle target the per-tier async-processors
    // (AgentEchelonTier-{Standard,Premium}), resolved at deploy from the SSM
    // contract those stacks publish (dynamic ref, not Fn::importValue).
    const standardProcessorArn = ssm.StringParameter.valueForStringParameter(
      this, processorArnKey('standard'));
    const premiumProcessorArn = ssm.StringParameter.valueForStringParameter(
      this, processorArnKey('premium'));

    // ============================================================
    // Channel Flow Processor Lambda
    // ============================================================

    const processorRole = new iam.Role(this, 'ChannelFlowProcessorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'chime:ChannelFlowCallback',
                'chime:SendChannelMessage',
                'chime:ListChannelMemberships',
                // The tier decision (which assistant responds + the /battle premium
                // gate) reads the IMMUTABLE `classification` tag via ListTagsForResource,
                // NOT mutable metadata, so a moderator cannot tamper the tier up. Without
                // this grant the catch fails closed to 'basic'. DescribeChannel is no
                // longer needed here (the tier no longer comes from channel metadata).
                'chime:ListTagsForResource',
              ],
              resources: [`${props.appInstanceArn}/*`],
            }),
          ],
        }),
        // /battle intent classifier: ChannelFlowProcessor invokes Haiku
        // via the IntentClassifier in planBattleTaskDelivery to decide
        // TASK_* vs PLACEHOLDER. Without this grant the classifier
        // AccessDenies and the fail-safe degrades intent routing -
        // battles still run but TASK_* detection becomes a heuristic.
        // (Single-region model, not a cross-region profile, so no
        // member-region expansion needed - see TROUBLESHOOTING section 11.)
        BedrockPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel'],
              resources: [
                `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
              ],
            }),
          ],
        }),
        SSMPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter'],
              resources: [
                // The processor resolves the channel's per-tier bot (the real
                // member) to send @all broadcasts + member counts. No shared
                // cross-tier bot.
                `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/bot-arn`,
              ],
            }),
          ],
        }),
        // @all fan-out → tier standard processor; /battle fan-out → tier
        // premium processor. Both are ${STACK_PREFIX}Tier-* functions.
        LambdaInvokePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['lambda:InvokeFunction'],
              resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${STACK_PREFIX}Tier-*`],
            }),
          ],
        }),
        // /battle: write initial INVOKED state rows + read ChannelBattleConfig
        ...(props.battleStateTableArn && props.channelBattleConfigTableArn && {
          BattleTablesPolicy: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: [
                  'dynamodb:GetItem',
                  'dynamodb:PutItem',
                  'dynamodb:UpdateItem',
                  'dynamodb:Query',
                ],
                resources: [props.battleStateTableArn, props.channelBattleConfigTableArn],
              }),
            ],
          }),
        }),
        // SSM lookup for the alt-bot slot roster (channel-flow needs to know
        // which channel members are alt-slot bots when fanning out /battle).
        SSMRosterPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
              resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/alt-bot-slots/*`,
              ],
            }),
          ],
        }),
        // Notification bridge (SPEC-NOTIFICATION-BRIDGE P1, outbound): a notify-tagged
        // channel message fans out over email. The processor resolves each participant's
        // email from the IDP by (iss, sub) (AdminGetUser — single source of truth, never
        // stored) then sends via SES. AdminGetUser is granted on the FULL set of trusted
        // pools (primary ∪ additional) so cross-IDP rosters resolve. Only wired when a
        // primary user pool is provided.
        ...(props.userPoolId && {
          NotifyBridgePolicy: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ['cognito-idp:AdminGetUser'],
                resources: [...new Set([props.userPoolId, ...(props.additionalUserPoolIds || [])])].map(
                  (poolId) => `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${poolId}`,
                ),
              }),
              new iam.PolicyStatement({
                actions: ['ses:SendEmail', 'ses:SendRawEmail'],
                // Scope to the configured sender identity (matching notification-stack),
                // not '*' — a '*' would let the processor send as any verified SES
                // identity in the account.
                resources: [
                  `arn:aws:ses:${this.region}:${this.account}:identity/${props.senderEmail || 'noreply@example.com'}`,
                ],
              }),
            ],
          }),
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const processorFn = new lambdaNodeJs.NodejsFunction(this, 'ChannelFlowProcessor', {
      entry: path.join(__dirname, '../../lambda/src/channel-flow-processor.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      reservedConcurrentExecutions: 50,
      role: processorRole,
      environment: {
        // @all fan-out (standard) + /battle fan-out (premium) → tier processors,
        // resolved from SSM at deploy. lib/battle-state.ts fails open if these
        // are absent, so a partial rollout never throws at runtime.
        SSM_ROOT,
        ASYNC_PROCESSOR_ARN: standardProcessorArn,
        PREMIUM_ASYNC_PROCESSOR_ARN: premiumProcessorArn,
        ...(props.battleStateTableName && {
          BATTLE_STATE_TABLE: props.battleStateTableName,
        }),
        ...(props.channelBattleConfigTableName && {
          CHANNEL_BATTLE_CONFIG_TABLE: props.channelBattleConfigTableName,
        }),
        ALT_BOT_SLOTS_ROSTER_PARAM: INSTANCE_SSM.altBotSlotsRoster,
        // Notification bridge (P1): resolve participant emails by (iss, sub) + send via SES.
        // NOTIFY_ALLOWED_POOL_IDS = the trusted pools an issuer may resolve to (multi-IDP).
        ...(props.userPoolId && { USER_POOL_ID: props.userPoolId }),
        ...(props.additionalUserPoolIds && props.additionalUserPoolIds.length && {
          NOTIFY_ALLOWED_POOL_IDS: props.additionalUserPoolIds.join(','),
        }),
        ...(props.senderEmail && { SENDER_EMAIL: props.senderEmail }),
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    this.processorFunctionArn = processorFn.functionArn;

    // Grant Chime SDK permission to invoke the processor
    processorFn.addPermission('ChimeInvoke', {
      principal: new iam.ServicePrincipal('chime.amazonaws.com'),
      sourceAccount: this.account,
    });

    // ============================================================
    // Channel Flow (Chime SDK) — created via Custom Resource
    // because AWS::Chime::ChannelFlow is not a native CFN type
    // ============================================================

    const channelFlowRole = new iam.Role(this, 'ChannelFlowCustomResourceRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'chime:CreateChannelFlow',
                'chime:DeleteChannelFlow',
                'chime:UpdateChannelFlow',
                'chime:DescribeChannelFlow',
              ],
              // Scoped to channel-flow ARNs under any AppInstance in this
              // account+region (the role is a CFN custom-resource helper;
              // we don't know the flow ARN ahead of CreateChannelFlow,
              // so the resource pattern is the channel-flow namespace).
              // Bounds the blast radius if the role is ever compromised.
              resources: [
                // Chime channel-flow ARN shape:
                //   arn:aws:chime:<region>:<account>:app-instance/<uuid>/channel-flow/<uuid>
                // SLASH_RESOURCE_NAME so the separator after `app-instance`
                // is `/` not `:`.
                cdk.Stack.of(this).formatArn({
                  service: 'chime',
                  resource: 'app-instance',
                  resourceName: '*/channel-flow/*',
                  arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
                }),
              ],
            }),
          ],
        }),
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const channelFlowHandler = new lambda.Function(this, 'ChannelFlowCustomResourceHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      role: channelFlowRole,
      code: lambda.Code.fromInline(`
const { ChimeSDKMessagingClient, CreateChannelFlowCommand, DeleteChannelFlowCommand } = require('@aws-sdk/client-chime-sdk-messaging');
const client = new ChimeSDKMessagingClient({});
exports.handler = async (event) => {
  const props = event.ResourceProperties;
  const requestType = event.RequestType;
  if (requestType === 'Create' || requestType === 'Update') {
    const cmd = new CreateChannelFlowCommand({
      AppInstanceArn: props.AppInstanceArn,
      Name: props.Name,
      Processors: props.Processors.map((p, i) => ({
        Name: p.Name,
        Configuration: { Lambda: { ResourceArn: p.LambdaArn, InvocationType: p.InvocationType } },
        ExecutionOrder: i + 1,
        FallbackAction: p.FallbackAction,
      })),
      ClientRequestToken: event.RequestId,
    });
    try {
      const res = await client.send(cmd);
      return { PhysicalResourceId: res.ChannelFlowArn, Data: { ChannelFlowArn: res.ChannelFlowArn } };
    } catch (e) {
      if (requestType === 'Update' && e.name === 'ConflictException') {
        return { PhysicalResourceId: event.PhysicalResourceId, Data: { ChannelFlowArn: event.PhysicalResourceId } };
      }
      throw e;
    }
  }
  if (requestType === 'Delete' && event.PhysicalResourceId) {
    try {
      await client.send(new DeleteChannelFlowCommand({ ChannelFlowArn: event.PhysicalResourceId }));
    } catch (e) {
      if (e.name !== 'NotFoundException') throw e;
    }
  }
  return { PhysicalResourceId: event.PhysicalResourceId };
};
      `),
    });

    const channelFlowProvider = new cdk.custom_resources.Provider(this, 'ChannelFlowProvider', {
      onEventHandler: channelFlowHandler,
    });

    const channelFlowResource = new cdk.CustomResource(this, 'ChannelFlow', {
      serviceToken: channelFlowProvider.serviceToken,
      properties: {
        AppInstanceArn: props.appInstanceArn,
        Name: 'AgentEchelonChannelFlow',
        Processors: [
          {
            Name: 'MessageProcessor',
            LambdaArn: processorFn.functionArn,
            InvocationType: 'ASYNC',
            FallbackAction: 'CONTINUE',
          },
        ],
      },
    });

    this.channelFlowArn = channelFlowResource.getAttString('ChannelFlowArn');

    // Publish the flow ARN to SSM so create-conversation and backfill scripts
    // can read it at runtime without a CDK stack dependency.
    new ssm.StringParameter(this, 'ChannelFlowArnParameter', {
      parameterName: CHANNEL_FLOW_ARN_SSM_KEY,
      stringValue: this.channelFlowArn,
      description: 'Channel flow ARN used by create-conversation to AssociateChannelFlow',
    });

    // ============================================================
    // Outputs
    // ============================================================

    new cdk.CfnOutput(this, 'ChannelFlowArn', {
      value: this.channelFlowArn,
      description: 'Channel Flow ARN — associate with channels for @all routing and message filtering',
      exportName: `${this.stackName}-ChannelFlowArn`,
    });

    new cdk.CfnOutput(this, 'ProcessorFunctionArn', {
      value: processorFn.functionArn,
      description: 'Channel Flow Processor Lambda ARN',
    });

    cdk.Tags.of(this).add('Component', 'ChannelFlow');
  }
}
