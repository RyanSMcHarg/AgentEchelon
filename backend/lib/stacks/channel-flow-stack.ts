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
import { sesSenderIdentityArns } from '../ses-identity';
import {
  SSM_ROOT,
  STACK_PREFIX,
  INSTANCE_SSM,
  processorArnKey,
  routerArnKey,
  CHANNEL_FLOW_ARN_SSM_KEY,
  resolveSharedSSM,
  abuseControlsWiring,
} from './agent-classification-common';

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
  /** ExperimentsTable name + ARN. The /battle fan-out reads it (Scan) to resolve a
   *  generation-out battle's per-variant image-gen models (resolveBattleImageGenPair).
   *  Without it, loadExperiments() returns [] inside channel-flow and every image
   *  battle silently falls through to a text battle. */
  experimentsTableName?: string;
  experimentsTableArn?: string;
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

    // @all fan-out and /battle target the per-classification async-processors
    // (AgentEchelonClassification-{Standard,Premium}), resolved at deploy from the SSM
    // contract those stacks publish (dynamic ref, not Fn::importValue).
    const basicProcessorArn = ssm.StringParameter.valueForStringParameter(
      this, processorArnKey('basic'));
    const standardProcessorArn = ssm.StringParameter.valueForStringParameter(
      this, processorArnKey('standard'));
    const premiumProcessorArn = ssm.StringParameter.valueForStringParameter(
      this, processorArnKey('premium'));
    // The per-classification ROUTER (`router-agent-handler`). `@all` hands the turn to it rather than
    // running the turn itself (MESSAGE-FLOW §3.1), so the flow needs the same three-way routing table
    // it already has for processors. Published by the classification stacks alongside processor-arn;
    // no new SSM contract.
    const basicRouterArn = ssm.StringParameter.valueForStringParameter(
      this, routerArnKey('basic'));
    const standardRouterArn = ssm.StringParameter.valueForStringParameter(
      this, routerArnKey('standard'));
    const premiumRouterArn = ssm.StringParameter.valueForStringParameter(
      this, routerArnKey('premium'));

    // Abuse-controls plane (SPEC-ABUSE-CONTROLS). @all/@assistant mentions and /battle fan-outs are
    // dispatched HERE, before the Lex router that gates the 1:1 tier turn - so the channel-flow
    // processor must enforce the SAME per-user rate limit + per-user/global spend budget, or a group
    // channel becomes a budget-bypass path to the model. Same shared control table + budget envs the
    // classification processors wire; the `classification` arg is unused by the helper (this shared
    // flow discovers classification per message at runtime), so any value is fine.
    const shared = resolveSharedSSM(this);
    const abuse = abuseControlsWiring(
      this, shared.abuseControlsArn, shared.abuseControlsName, 'standard', this.region, this.account);

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
                // `/battle end` asks whether the sender is a channel MODERATOR, because ending a duel
                // destroys work in flight for everyone in it (DESIGN-BATTLE 2a-i). The check is
                // deliberately fail-closed, which makes a missing grant INVISIBLE: every moderator
                // would simply be told they are not one, and only the duel's initiator could ever end
                // a battle. A silently narrower authority is exactly the shape that goes unnoticed.
                'chime:ListChannelModerators',
                // The classification decision (which assistant responds + the /battle premium
                // gate) reads the IMMUTABLE `classification` tag via ListTagsForResource,
                // NOT mutable metadata, so a moderator cannot tamper the classification up. Without
                // this grant the catch fails closed to 'basic'. DescribeChannel is no
                // longer needed here (the classification no longer comes from channel metadata).
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
                // The processor resolves the channel's per-classification bot (the real
                // member) to send @all broadcasts + member counts. No shared
                // cross-classification bot.
                `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/bot-arn`,
              ],
            }),
          ],
        }),
        // @all hands off to the classification ROUTER; /battle fans out to the classification
        // processor. Both are ${STACK_PREFIX}Classification-* functions, so one wildcard covers them.
        LambdaInvokePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['lambda:InvokeFunction'],
              resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${STACK_PREFIX}Classification-*`],
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
        // /battle generation-out: read the ExperimentsTable to resolve a battle's
        // per-variant image-gen models (loadExperiments does a Scan). Without this,
        // an image battle can't resolve its models in the fan-out and falls to text.
        ...(props.experimentsTableArn && {
          ExperimentsReadPolicy: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ['dynamodb:Scan', 'dynamodb:GetItem'],
                resources: [props.experimentsTableArn],
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
                // AdminListGroupsForUser: the /battle and @all abuse gate meters the sender at
                // min(channel, clearance) - the same rule the router applies to ordinary turns -
                // and clearance is derived from the server-verified group list. Primary pool only:
                // clearance is an AE-pool concept, and federated senders never reach the lookup.
                actions: ['cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser'],
                resources: [...new Set([props.userPoolId, ...(props.additionalUserPoolIds || [])])].map(
                  (poolId) => `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${poolId}`,
                ),
              }),
              new iam.PolicyStatement({
                actions: ['ses:SendEmail', 'ses:SendRawEmail'],
                // Scope to the configured sender identity (matching notification-stack),
                // not '*' — a '*' would let the processor send as any verified SES
                // identity in the account. Both the address and its parent domain, since
                // SES authorizes against whichever it resolves the From address to.
                resources: sesSenderIdentityArns(
                  this.region,
                  this.account,
                  props.senderEmail || 'noreply@example.com',
                ),
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
      // MUST EXCEED THE ROUTER'S 30s. `@all` hands the turn to the router and WAITS for it
      // (RequestResponse), so this budget has to outlast the callee's or the caller dies first - and
      // that failure is silent and total: the router would still be running, so it dispatches the
      // processor, but the flow never returns to post the placeholder, so the processor polls for a
      // message that never appears and the answer is lost. `callbackAllow` runs BEFORE the handoff, so
      // a longer budget never delays the user's own message reaching the channel.
      // Pinned by `channel-flow-outlasts-router.test.ts`.
      timeout: cdk.Duration.seconds(35),
      memorySize: 256,
      // THE 35s CEILING ABOVE DOES NOT SIZE THIS NUMBER. Concurrency is consumed by DURATION, not by
      // the timeout, and the `@all` handoff returns at TTFF: the router classifies, dispatches the
      // async processor and returns the placeholder, so it is back in the SLO's 1s target / 2s
      // threshold (LATENCY-TARGETS), not at the 35s ceiling. At the 2s threshold, 50 slots sustain 25
      // `@all` turns per second; an ordinary message takes the `callbackAllow` path and frees its slot
      // in well under a second. The battle round-1 fan-out invokes the two sides with `Promise.all`,
      // so a duel still occupies ONE slot for one TTFF, not two in series.
      //
      // RAISING THIS MAKES A BURST WORSE, WHICH IS WHY IT IS NOT RAISED. A reservation is a hard
      // carve-out from the account's concurrency pool, and `AgentHandler` - the router this function
      // invokes and WAITS on - holds no reservation of its own. Extra slots here therefore come out of
      // the pool the callee draws from, and a throttled `RequestResponse` invoke throws rather than
      // being retried, so the added capacity lands on the caller and the failure lands on the callee.
      // A duel doubles that pressure: one flow slot issues two concurrent router invokes.
      //
      // What a burst past 50 actually does: Amazon Chime SDK invokes this processor ASYNC with
      // `FallbackAction: CONTINUE` (below), so a throttled invocation is retried from Lambda's async
      // queue rather than dropped, and only a wait past the flow's own deadline delivers the message
      // unprocessed. Sustained saturation here is a router-latency incident, not a sizing one - the
      // signal to act on is `@all` occupancy climbing toward the ceiling, not this number.
      reservedConcurrentExecutions: 50,
      role: processorRole,
      environment: {
        // @all fan-out (standard) + /battle fan-out (premium) → classification processors,
        // resolved from SSM at deploy. lib/battle-state.ts fails open if these
        // are absent, so a partial rollout never throws at runtime.
        SSM_ROOT,
        // @all routes to the processor MATCHING the channel classification (F1): basic→basic,
        // standard→standard (the ASYNC_PROCESSOR_ARN default), premium→premium. Without the basic ARN
        // an @all in a basic channel would run on the standard processor and leak standard-tier context.
        ASYNC_PROCESSOR_ARN: standardProcessorArn,
        BASIC_ASYNC_PROCESSOR_ARN: basicProcessorArn,
        PREMIUM_ASYNC_PROCESSOR_ARN: premiumProcessorArn,
        // @all hands the turn to the classification's ROUTER, which classifies, resolves the profile
        // and variant, and dispatches the processor - the same code Lex fulfills into. Same
        // three-way routing rule as the processors above, and covered by the SAME invoke grant: the
        // routers are ${STACK_PREFIX}Classification-* functions too.
        ROUTER_ARN: standardRouterArn,
        BASIC_ROUTER_ARN: basicRouterArn,
        PREMIUM_ROUTER_ARN: premiumRouterArn,
        ...(props.battleStateTableName && {
          BATTLE_STATE_TABLE: props.battleStateTableName,
        }),
        ...(props.channelBattleConfigTableName && {
          CHANNEL_BATTLE_CONFIG_TABLE: props.channelBattleConfigTableName,
        }),
        // /battle generation-out: lets loadExperiments() resolve a battle's image-gen
        // models in the fan-out. Absent ⇒ loadExperiments returns [] ⇒ text battle.
        ...(props.experimentsTableName && {
          EXPERIMENTS_TABLE: props.experimentsTableName,
        }),
        ALT_BOT_SLOTS_ROSTER_PARAM: INSTANCE_SSM.altBotSlotsRoster,
        // Notification bridge (P1): resolve participant emails by (iss, sub) + send via SES.
        // NOTIFY_ALLOWED_POOL_IDS = the trusted pools an issuer may resolve to (multi-IDP).
        ...(props.userPoolId && { USER_POOL_ID: props.userPoolId }),
        ...(props.additionalUserPoolIds && props.additionalUserPoolIds.length && {
          NOTIFY_ALLOWED_POOL_IDS: props.additionalUserPoolIds.join(','),
        }),
        ...(props.senderEmail && { SENDER_EMAIL: props.senderEmail }),
        // Abuse controls: ABUSE_CONTROLS_TABLE + budget/rate/circuit envs, so enforceAbuseGate can
        // meter the @all/battle dispatch paths. No-op until the budget ceilings are set via context.
        ...abuse.env,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    this.processorFunctionArn = processorFn.functionArn;

    // Grant the processor role PutItem/UpdateItem/GetItem on the shared abuse-controls table (+ the
    // circuit SSM param when a global budget is wired) so the rate-limit / budget counters can bump.
    abuse.grant(processorRole);

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
