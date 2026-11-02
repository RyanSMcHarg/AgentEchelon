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
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';
import {
  SSM_ROOT,
  STACK_PREFIX,
  RES_PREFIX,
  routerByNameEnvironment,
  routerByNameStatements,
  taskServiceByNameEnvironment,
  taskServiceByNameStatements,
  CHANNEL_FLOW_ARN_SSM_KEY,
  resolveSharedSSM,
  abuseControlsWiring,
  turnQueueWiring,
  roomPrimaryReadStatements,
  battleResourcesOf,
  experimentsResourcesOf,
  EVERY_CLASSIFICATION,
} from './agent-classification-common';
import { defaultProfileRegistry as profiles } from '../profile-registry';
import { utilityModelArns } from '../config/model-strategy';

/** SSM parameter key for the channel flow ARN. Read at runtime by create-conversation
 *  so we avoid a circular stack dependency with ConversationsStack. Re-exported from the
 *  namespace foundation so existing `from './channel-flow-stack'` imports keep working. */
export { CHANNEL_FLOW_ARN_SSM_KEY };

export interface ChannelFlowStackProps extends cdk.StackProps {
  appInstanceArn: string;
  /**
   * The deployment declares `battle`: the flow is told the battle tables' fixed names
   * (`CAPABILITY_RESOURCES`), and the `Battle` stack grants its role on them (`processorRole`).
   */
  battle?: boolean;
  /**
   * The deployment declares `experiments`: the /battle fan-out reads the experiments table (Scan) to resolve a
   * generation-out battle's per-variant image-gen models (resolveBattleImageGenPair); the `Experiments` stack
   * grants the read. Without it, loadExperiments() returns [] and every image battle falls to a text battle.
   */
  experiments?: boolean;
  /** PRIMARY IDP user pool — the sender's clearance for the `@all` and `/battle` abuse gate is
   *  derived from the server-verified group list (`AdminListGroupsForUser`) in this pool.
   *
   *  The NOTIFICATION fan-out used to resolve recipient contacts here too, and no longer does: it
   *  runs on the message stream (`post-processing-stack.ts`, ADR-041 decision 7), so this stack
   *  grants no `AdminGetUser` and no SES send. */
  userPoolId?: string;
  /** The bucket an active profile version's persona body lives in (`profiles/*`). The flow resolves the
   *  active version for the ASSISTANT'S CONFIGURED COPY of the notices it sends itself; absent, a
   *  version with a persona pointer fails closed to the compiled seed's copy. */
  attachmentsBucketName?: string;
  attachmentsBucketArn?: string;
}

export class ChannelFlowStack extends cdk.Stack {
  public readonly channelFlowArn: string;
  public readonly processorFunctionArn: string;
  /** The processor's role, which `Battle` and `Experiments` attach their table grants to. */
  public readonly processorRole: iam.IRole;

  constructor(scope: Construct, id: string, props: ChannelFlowStackProps) {
    super(scope, id, props);

    // The per-classification ROUTER (`router-agent-handler`). `@all` hands the turn to it rather than
    // running the turn itself (MESSAGE-FLOW §6.1). Found by name at call time from the `router-arn` parameter
    // each classification stack publishes (`resolveRouterArn`), as is the task service, so this stack takes
    // no deploy-time value from the classification stacks and deploys before or without any one of them; no
    // classification borrows another's router.
    // NAMED, NEVER GRANTED HERE (`CAPABILITY_RESOURCES`): the `Battle` and `Experiments` stacks own the grants.
    const battle = props.battle ? battleResourcesOf(this) : undefined;
    const experiments = props.experiments ? experimentsResourcesOf(this) : undefined;

    // Abuse-controls plane (SPEC-ABUSE-CONTROLS). @all/@assistant mentions and /battle fan-outs are
    // dispatched HERE, before the Lex router that gates the 1:1 tier turn - so the channel-flow
    // processor must enforce the SAME per-user rate limit + per-user/global spend budget, or a group
    // channel becomes a budget-bypass path to the model. Same shared control table + budget envs the
    // classification processors wire. This shared flow discovers the classification per message at
    // runtime, so it is wired under its own name.
    const shared = resolveSharedSSM(this);
    const abuse = abuseControlsWiring(
      this, shared.abuseControlsArn, shared.abuseControlsName, 'channel-flow', this.region, this.account);
    // THE TURN STATE A FAILED DISPATCH IS RECORDED IN. A turn the flow cannot start (`assistant_unreachable`,
    // `handoff_failed`) is recorded there for the sender's own client to show; without the table those
    // records were written nowhere and the person saw silence.
    const turnQueue = turnQueueWiring(this, shared.turnStateArn, shared.turnStateName);

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
                // NO SEND AND NO EDIT. Everything the flow says in a conversation - a handed-back
                // placeholder, a notice, a duel's waiting marker cleared - goes out as the assistant on
                // that assistant's own vended session (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b), which can act only as that bot. This
                // role, holding `${appInstanceArn}/*`, could otherwise post as ANY bot in ANY channel.
                'chime:ListChannelMemberships',
                // `/battle end` asks whether the sender is a channel MODERATOR, because ending a duel
                // destroys work in flight for everyone in it (DESIGN-BATTLE 2a-i). The check is
                // deliberately fail-closed, which makes a missing grant INVISIBLE: every moderator
                // would simply be told they are not one, and only the duel's initiator could ever end
                // a battle. A silently narrower authority is exactly the shape that goes unnoticed.
                'chime:ListChannelModerators',
                // ENDING A DUEL EDITS A MESSAGE. A side stopped at `WAITING_FOR_USER` holds a question
                // carrying the `<!--battlewaiting-->` marker the client renders as a live "Replying to:"
                // control, and `/battle end` has to take it down or an ended duel goes on inviting an
                // answer nothing is listening for. That clear is a read-then-write on the message.
                //
                // Like the moderator check, it fails soft: without these the clear AccessDenies into a
                // caught warning, reports `false`, and leaves the affordance standing - the precise
                // defect the shared marker module was extracted to fix, silently reintroduced by a
                // missing grant rather than by any change to the code.
                'chime:GetChannelMessage',
                // A PRIVATE ADDRESS THAT DISAGREES WITH ITS STORED `Target`. After
                // release the flow reads the stored message back as the assistant to see its `Target`
                // (GetChannelMessage, above) and tells the sender what happened
                // (`lib/private-command.ts`).
                //
                // NO `chime:DeleteChannelMessage` HERE, and its absence is the enforcement rather than an
                // omission. The flow used to delete such a message as the app-instance admin; neither
                // disagreement deletes any more, because the delete
                // never unsent anything and destroyed the sender's words to fix their client's bug. The
                // grant is withdrawn with the behavior, so re-adding the delete without re-deciding the
                // policy fails on permissions rather than quietly working.
                // The classification decision (which assistant responds + the /battle premium
                // gate) reads the IMMUTABLE `classification` tag via ListTagsForResource,
                // NOT mutable metadata, so a moderator cannot tamper the classification up. Without
                // this grant the read fails and nothing is dispatched. DescribeChannel is no
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
                ...utilityModelArns(this.region, this.account),
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
                // THE ASSIGNMENT RECORD is how the flow resolves which assistant serves a role
                // (DESIGN-SEPARATE-ASSISTANTS 3.0), and it is the ONLY parameter this processor reads.
                //
                // The `/assistant/*/bot-arn` grant that stood here is removed rather than kept "for
                // the other reads": there are none. `channel-flow-processor.ts` has one
                // `GetParameterCommand` call site and it is the assignment. A grant justified by a
                // reader that does not exist is how a wildcard outlives its reason.
                `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant-assignments/*/*/*`,
                // WHETHER BATTLE IS TURNED ON for a classification (ADR-049) is the Battle stack's grant on this
                // role (`BattleOnTheChannelFlow`), present exactly where `battle` is declared.
              ],
            }),
          ],
        }),
        // NO ROUTING-TABLE WRITE AND NO VEND: the flow speaks as no assistant, so it never asks for a session.
        // THE ASSISTANT'S CONFIGURED WORDS for the notices the flow sends itself: telling a sender their
        // private message did not carry the `Target` its text named (`lib/private-command.ts`). The same
        // READ-ONLY grants the router and arrival triage carry: the definition namespace, and
        // `profiles/*` for the persona body a version points at. Without them the read is refused and
        // the notice falls back to shipped English.
        ProfileRead: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter', 'ssm:GetParameterHistory'],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/definition`],
            }),
            ...(props.attachmentsBucketArn ? [new iam.PolicyStatement({
              actions: ['s3:GetObject'],
              resources: [`${props.attachmentsBucketArn}/profiles/*`],
            })] : []),
          ],
        }),
        // THE ROUTERS AND TASK SERVICES, BY THEIR CONSTRUCT IDS, and nothing else in the classification stacks.
        // `@all` and `/battle` hand off to the router, an ended duel's waiting markers are named to it
        // (`battle-marker-clear.ts`), and a task answer goes to the task service. Each is read from its
        // classification's parameter and invoked on its own pattern, bounded to this instance's functions that
        // carry a classification, so neither reaches a classification's vend or processor.
        LambdaInvokePolicy: new iam.PolicyDocument({
          statements: [
            ...routerByNameStatements(this, EVERY_CLASSIFICATION),
            ...taskServiceByNameStatements(this, EVERY_CLASSIFICATION),
          ],
        }),
        // /battle's INVOKED state rows and ChannelBattleConfig reads, and the experiments read of a duel's
        // per-variant image models, are granted on this role by the `Battle` and `Experiments` stacks.
        // THE SENDER'S CLEARANCE, and nothing else this pool can answer.
        //
        // The /battle and @all abuse gate meters the sender against the limits for a
        // classification, and clearance is derived from the server-verified group list rather
        // than from anything the client says. Primary pool only: clearance is an AE-pool concept,
        // and a federated sender never reaches the lookup.
        //
        // THIS USED TO CARRY THE NOTIFICATION BRIDGE AS WELL - `AdminGetUser` on every trusted pool
        // and `ses:SendEmail` on the sender identity - because the fan-out was awaited in front of
        // `ChannelFlowCallback`. It runs on the message stream now (ADR-041 decision 7), so the
        // grants moved with it rather than being left behind on a role that no longer sends.
        ...(props.userPoolId && {
          SenderClearancePolicy: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                // ListUsers resolves a federated person's `sub` to their pool username (`bySubjectOrUsername`, cognito-pool-directory.ts).
                actions: ['cognito-idp:AdminListGroupsForUser', 'cognito-idp:ListUsers'],
                resources: [
                  `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.userPoolId}`,
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
    // THE ROOM'S PRIMARY (§3.8): `primaryAssistantOf` reads the room's tags and enumerates the assignment
    // records (`GetParametersByPath`), which the single-key grant above does not cover.
    for (const stmt of roomPrimaryReadStatements(this, EVERY_CLASSIFICATION)) processorRole.addToPolicy(stmt);

    // The processor's reserved concurrency, sized in the note on `reservedConcurrentExecutions` below
    // and read again by the occupancy alarm, so the alarm moves with the reservation.
    const processorConcurrency = 50;
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
      // THE 35s LIMIT ABOVE DOES NOT SIZE THIS NUMBER. Concurrency is consumed by DURATION, not by
      // the timeout, and the `@all` handoff returns at TTFF: the router classifies, dispatches the
      // async processor and returns the placeholder, so it is back in the SLO's 1s target / 2s
      // threshold (LATENCY-TARGETS), not at the 35s limit. At the 2s threshold, 50 executions sustain 25
      // `@all` turns per second; an ordinary message takes the `callbackAllow` path and frees its execution
      // in well under a second. The battle round-1 fan-out invokes the two sides with `Promise.all`,
      // so a duel still holds ONE execution for one TTFF, not two in series.
      //
      // RAISING THIS MAKES A BURST WORSE, WHICH IS WHY IT IS NOT RAISED. A reservation is a hard
      // carve-out from the account's concurrency pool, and `AgentHandler` - the router this function
      // invokes and WAITS on - holds no reservation of its own. Extra reserved executions here therefore come out of
      // the pool the callee draws from, and a throttled `RequestResponse` invoke throws rather than
      // being retried, so the added capacity lands on the caller and the failure lands on the callee.
      // A duel doubles that pressure: one flow execution issues two concurrent router invokes.
      //
      // What a burst past 50 actually does: Amazon Chime SDK invokes this processor ASYNC with
      // `FallbackAction: CONTINUE` (below), so a throttled invocation is retried from Lambda's async
      // queue rather than dropped, and only a wait past the flow's own deadline delivers the message
      // unprocessed. Sustained saturation here is a router-latency incident, not a sizing one - the
      // signal to act on is `@all` occupancy climbing toward the limit, not this number.
      reservedConcurrentExecutions: processorConcurrency,
      role: processorRole,
      environment: {
        SSM_ROOT,
        // @all hands the turn to the classification's ROUTER, which classifies, resolves the profile
        // and variant, and dispatches the processor - the same code Lex fulfills into. Each
        // classification reaches only its own router (`lib/router-arn.ts`), found by name at call time.
        ...routerByNameEnvironment(),
        // ADR-035: a bare `#<n>` in a group is routed only when the task service of the conversation's
        // classification says its sender may answer that item, found by name like the router
        // (`resolveTaskServiceArn`). No fallback across classifications.
        ...taskServiceByNameEnvironment(),
        ...(battle ? { BATTLE_STATE_TABLE: battle.battleStateName, CHANNEL_BATTLE_CONFIG_TABLE: battle.channelBattleConfigName } : {}),
        // /battle generation-out: lets loadExperiments() resolve a battle's image-gen
        // models in the fan-out. Absent ⇒ loadExperiments returns [] ⇒ text battle.
        ...(experiments ? { EXPERIMENTS_TABLE: experiments.experimentsName } : {}),
        // The pool the sender's clearance is read from (`lib/clearance-source.ts`). The notification
        // bridge's own variables - the additional trusted pools and the SES sender - moved to the
        // post-processing stack with the fan-out (ADR-041 decision 7).
        ...(props.userPoolId && { USER_POOL_ID: props.userPoolId }),
        // The persona body store, so resolving the active profile version for its copy can follow a
        // persona pointer (`hydrateBodies`) instead of failing closed to the seed.
        ...(props.attachmentsBucketName && { PROFILE_BODY_BUCKET: props.attachmentsBucketName }),
        // Abuse controls: ABUSE_CONTROLS_TABLE + budget/rate/circuit envs, so enforceAbuseGate can
        // meter the @all/battle dispatch paths. No-op until the budget limits are set via context.
        ...abuse.env,
        ...turnQueue.env,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    this.processorFunctionArn = processorFn.functionArn;
    this.processorRole = processorRole;

    // Grant the processor role PutItem/UpdateItem/GetItem on the shared abuse-controls table (+ the
    // circuit SSM param when a global budget is wired) so the rate-limit / budget counters can bump.
    abuse.grant(processorRole);
    turnQueue.grant(processorRole);

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
    // Alarms
    // ============================================================
    //
    // THE FLOW SITS IN FRONT OF EVERY MESSAGE, AND ITS FAILURES ARE QUIET. Amazon Chime SDK invokes the
    // processor with `FallbackAction: CONTINUE`, so a processor that errors, is throttled or runs past
    // the flow's deadline still lets the person's message through - it just reaches no assistant. The
    // room sees an unanswered message and nothing else does, so these three are the only places the
    // failure shows. Left without an action, like the stack's other alarms: existing and visible is the
    // floor, and wiring a destination is the deployer's choice.
    const FIVE_MINUTES = cdk.Duration.minutes(5);
    new cloudwatch.Alarm(this, 'ChannelFlowProcessorErrorsAlarm', {
      alarmName: `${STACK_PREFIX}-channel-flow-processor-errors`,
      alarmDescription:
        'The channel-flow processor threw. Its fallback lets the message through, so the person sees '
        + 'their message delivered and unanswered. Read the processor log group for the failing '
        + 'invocation; a refusal from the classification boundary is logged as a [SecurityEvent].',
      metric: processorFn.metricErrors({ period: FIVE_MINUTES, statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'ChannelFlowProcessorThrottlesAlarm', {
      alarmName: `${STACK_PREFIX}-channel-flow-processor-throttles`,
      alarmDescription:
        'The channel-flow processor was throttled at its reserved concurrency. A throttled invocation '
        + 'is retried from the async queue, and one that waits past the flow deadline delivers the '
        + 'message unprocessed. Sustained throttling is a router-latency incident: check the router '
        + 'duration before raising the reservation (see the note on reservedConcurrentExecutions).',
      metric: processorFn.metricThrottles({ period: FIVE_MINUTES, statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // OCCUPANCY CLIMBING TOWARD THE RESERVATION is the signal the sizing note names, and it comes
    // before the throttles: 80% of the reserved concurrency, held across two periods.
    new cloudwatch.Alarm(this, 'ChannelFlowProcessorOccupancyAlarm', {
      alarmName: `${STACK_PREFIX}-channel-flow-processor-occupancy`,
      alarmDescription:
        'The channel-flow processor is using 80% of its reserved concurrency. Turns that wait on the '
        + 'router (@all, /battle) hold an execution for the router time, so rising occupancy means the router '
        + 'is slow before it means traffic is high. Throttling follows at 100%.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'ConcurrentExecutions',
        dimensionsMap: { FunctionName: processorFn.functionName },
        statistic: 'Maximum',
        period: FIVE_MINUTES,
      }),
      threshold: Math.floor(processorConcurrency * 0.8),
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
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
