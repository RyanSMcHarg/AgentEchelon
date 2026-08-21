/**
 * Post-Processing Stack
 *
 * The platform's after-the-fact half (ADR-032 tenet 4): one consumer on the Amazon Chime SDK message
 * stream that acts on messages DELIVERY DID NOT ROUTE. Today it carries one rule - a person answers a
 * task in a shared conversation, addresses nobody, and their answer reaches no assistant at all
 * (`lambda/src/lib/task-answer-repair.ts`). ADR-023's B-stream, an assistant-to-assistant message that
 * Amazon Chime SDK delivers and persists but routes to no handler, is the same shape and belongs here
 * as a second rule rather than as a second consumer.
 *
 * WHY IT IS ITS OWN STACK, AND NOT PART OF THE CHANNEL FLOW OR OF ANALYTICS.
 *
 * Not the channel flow, because ADR-032 is precisely the rule that none of this may sit on the critical
 * path: the flow is synchronous and runs on every message in every conversation, and a correction for
 * a state that should not exist has to cost time only in the broken case. Putting it in the flow's
 * stack would also invite the next reader to put it in the flow's Lambda.
 *
 * Not the analytics stacks, because there are TWO of them (Athena and Aurora) and the wiring would
 * have to be duplicated and kept in step - and neither can resolve what this needs: analytics deploys
 * BEFORE foundations and the classification stacks (`foundationsStack.addDependency(analyticsStack)`),
 * so the tasks table and the router ARNs it reads from SSM at deploy do not exist yet at that point.
 * Both analytics modes expose `kinesisStreamArn` identically, so the stream comes in as a prop and
 * this stack sits after the ones that publish what it reads.
 *
 * IT IS ENTIRELY OPTIONAL. Remove it and the platform behaves exactly as it did before: an
 * unaddressed task answer strands, which is the defect this measures rather than a regression it
 * introduces.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import * as path from 'path';
import {
  SSM_ROOT,
  STACK_PREFIX,
  routerArnKey,
  resolveSharedSSM,
} from './agent-classification-common';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export interface PostProcessingStackProps extends cdk.StackProps {
  /** The app instance whose channels this may read. Scopes every Chime grant. */
  appInstanceArn: string;
  /** The Chime message stream. Published identically by both analytics modes. */
  kinesisStreamArn: string;
}

export class PostProcessingStack extends cdk.Stack {
  public readonly postProcessingFunctionArn: string;

  constructor(scope: Construct, id: string, props: PostProcessingStackProps) {
    super(scope, id, props);

    const shared = resolveSharedSSM(this);

    // The turn is handed to the ROUTER for the channel's classification - the same Lambda Lex fulfills
    // into and the same one the flow's `@all` bypass uses. Resolved at deploy from the SSM contract the
    // classification stacks publish, so there is no second routing table to drift.
    const basicRouterArn = ssm.StringParameter.valueForStringParameter(this, routerArnKey('basic'));
    const standardRouterArn = ssm.StringParameter.valueForStringParameter(this, routerArnKey('standard'));
    const premiumRouterArn = ssm.StringParameter.valueForStringParameter(this, routerArnKey('premium'));

    const messageStream = kinesis.Stream.fromStreamArn(this, 'MessageStream', props.kinesisStreamArn);

    const postProcessingRole = new iam.Role(this, 'PostProcessingRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        KinesisRead: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'kinesis:GetRecords',
                'kinesis:GetShardIterator',
                'kinesis:DescribeStream',
                'kinesis:DescribeStreamSummary',
                'kinesis:ListShards',
              ],
              resources: [props.kinesisStreamArn],
            }),
          ],
        }),
        // READ ONLY, and only these two calls. The classification comes from the channel's IMMUTABLE
        // tag (never mutable metadata, which a member holding UpdateChannel could raise), and the
        // member count decides whether the message already reached Lex via the 1:1 AUTO trigger.
        // Nothing here sends, and nothing here reads message content: the repair works from the
        // stream record it was handed.
        ChimeRead: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['chime:ListTagsForResource', 'chime:ListChannelMemberships'],
              resources: [`${props.appInstanceArn}/*`],
            }),
          ],
        }),
        // The task is the AUTHORITY for which assistant owns the work; the message only names it.
        // GetItem alone - this component resolves a turn, it never advances one.
        TaskRead: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['dynamodb:GetItem'],
              resources: [shared.agentTasksArn],
            }),
          ],
        }),
        // The durable one-action-per-message claim. Conditional PutItem is the whole of it: an
        // in-memory claim would let two Kinesis deliveries on two containers each believe they were
        // first, which is exactly the defect the flow's dedup was found to have.
        ActionClaim: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['dynamodb:PutItem'],
              resources: [shared.abuseControlsArn],
            }),
          ],
        }),
        // The routers are `${STACK_PREFIX}Classification-*` functions, so one wildcard covers all
        // three. Named by prefix rather than by a pattern built from a stack name: CloudFormation
        // truncates a generated physical name at 64 characters, and a grant built from the full name
        // deploys green and denies at runtime.
        RouterInvoke: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['lambda:InvokeFunction'],
              resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${STACK_PREFIX}Classification-*`],
            }),
          ],
        }),
      },
    });

    const postProcessingFn = new lambdaNodeJs.NodejsFunction(this, 'MessagePostProcessing', {
      entry: path.join(__dirname, '../../lambda/src/message-post-processing.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      // A dispatch is fire-and-forget, so this budget covers the reads on the rare message a rule acts
      // on, plus the walk over a batch that mostly rejects on a string test.
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      role: postProcessingRole,
      environment: {
        SSM_ROOT,
        ROUTER_ARN: standardRouterArn,
        BASIC_ROUTER_ARN: basicRouterArn,
        PREMIUM_ROUTER_ARN: premiumRouterArn,
        TASKS_TABLE: shared.agentTasksName,
        ABUSE_CONTROLS_TABLE: shared.abuseControlsName,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    this.postProcessingFunctionArn = postProcessingFn.functionArn;

    // LATEST, not TRIM_HORIZON. These rules act on live conversations - dispatching turns for messages
    // sent before the consumer existed would answer questions people have long since given up on.
    //
    // NO BATCHING WINDOW, AND THAT IS THE DIFFERENCE BETWEEN THIS CONSUMER AND THE ARCHIVAL ONE.
    // Two components read this same stream for two different reasons, and they want opposite settings:
    //
    //   archival   - bulk writes, latency-indifferent -> batch 100 over a 5s window, fewer invocations
    //   THIS one   - DISPATCHES A TURN, so the window is added directly to a person's wait
    //
    // This shipped with archival's settings copied onto it, and the cost was measured on the live
    // deployment before anyone noticed the cause: 3.0s and 3.4s from message to dispatch on two probes,
    // essentially all of it the window. Kinesis itself is not slow - a comparable dispatch-off-stream
    // deployment measures ~200-500ms end to end for exactly this shape, where the stream event
    // triggers a whole model turn, and it distinguishes the two uses the same way: the dispatch
    // consumer sets no window, the archival consumer sets 5s.
    //
    // `batchSize` is a CAP, not a delay: with no window, records are delivered as they arrive. Kept
    // small so one slow record cannot hold up the messages behind it.
    postProcessingFn.addEventSource(
      new lambdaEventSources.KinesisEventSource(messageStream, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        // The handler swallows its own errors by contract (a throw would stall the shard for a defect
        // that only affects one message), so retries exist for infrastructure faults alone.
        retryAttempts: 2,
      }),
    );

    // ─────────────────────────────────────────────────────────────────────────
    // ADR-032 TENET 6: A REPAIR MUST BE COUNTED, OR IT BECOMES THE DESIGN.
    //
    // This alarm is not an error alarm. It fires when the repair is WORKING - which is the point:
    // a silent fix is indistinguishable from the defect not existing, so the client would never get
    // corrected and the stream path would quietly become the primary one. A breach means clients are
    // failing to address task answers often enough to go and look at why.
    //
    // Deliberately left without an action: an alarm that exists and is visible is the floor, and
    // wiring it to a destination is the deployer's choice.
    const repairsAlarm = new cloudwatch.Alarm(this, 'TaskAnswerRepairRateAlarm', {
      alarmName: `${STACK_PREFIX}-task-answer-repairs`,
      alarmDescription:
        'Task answers are reaching no assistant and are being repaired from the message stream. The '
        + 'repair is working - people are getting answered - but every count is a message the CLIENT '
        + 'should have addressed at send (ADR-032 tenet 3). Sustained counts mean the client defect is '
        + 'real and the repair has become the primary path. Check which classification is counting and '
        + 'whether that client is stamping the task reference.',
      metric: new cloudwatch.Metric({
        namespace: 'AgentEchelon/TaskAnswerRepair',
        metricName: 'Repairs',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      // No repairs is the goal, not missing data.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    void repairsAlarm;

    new cdk.CfnOutput(this, 'MessagePostProcessingFunctionArn', {
      value: postProcessingFn.functionArn,
      description: 'Stream-side repair for a task answer that reached no assistant (ADR-032)',
    });
  }
}
