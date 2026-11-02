/**
 * Post-Processing Stack
 *
 * The platform's after-the-fact half (ADR-032 tenet 4): one consumer on the Amazon Chime SDK message
 * stream. It carries two kinds of rule.
 *
 * Rules that act on messages DELIVERY DID NOT ROUTE: a person answers a task in a shared
 * conversation, addresses nobody, and their answer reaches no assistant at all
 * (`lambda/src/lib/task-answer-repair.ts`); and triage on arrival, which reads a queue from the
 * deferral notice that announced it (`lambda/src/lib/triage-on-arrival.ts`). ADR-023's B-stream, an
 * assistant-to-assistant message that Amazon Chime SDK delivers and persists but routes to no
 * handler, is the same shape and belongs here as a further rule rather than as a second consumer.
 *
 * The notification fan-out, which reaches members over email when an assistant's message carries a
 * `notify` directive, is a second consumer of the same stream, in the Notifications stack, which holds
 * the deployment's only SES send grant: a deployment that does not declare `notifications` sends no email
 * and carries no grant to send one.
 *
 * WHY IT IS ITS OWN STACK, AND NOT PART OF THE CHANNEL FLOW OR OF ANALYTICS.
 *
 * Not the channel flow, because ADR-032 is precisely the rule that none of this may sit on the critical
 * path: the flow is synchronous and runs on every message in every conversation, and a correction for
 * a state that should not exist has to cost time only in the broken case. Putting it in the flow's
 * stack would also invite the next reader to put it in the flow's Lambda.
 *
 * Not the archive, because the archive has two implementations (Athena and Aurora) and the wiring would
 * have to be duplicated and kept in step - and the archive deploys BEFORE the assistant stacks, so the
 * router ARNs this reads from SSM at deploy do not exist yet at that point. The stream is the Messaging
 * stack's, taken by reference, and this stack sits after the ones that publish what it reads.
 *
 * IT IS ENTIRELY OPTIONAL. Remove it and the platform behaves exactly as it did before: an
 * unaddressed task answer strands, which is the defect this measures rather than a regression it
 * introduces.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import * as path from 'path';
import {
  SSM_ROOT,
  STACK_PREFIX,
  routerByNameEnvironment,
  routerByNameStatements,
  resolveSharedSSM,
  turnQueueWiring,
  speakAsAssistantStatements,
  speakAsAssistantEnv,
  EVERY_CLASSIFICATION,
} from './agent-classification-common';
import { defaultProfileRegistry as profiles } from '../profile-registry';

export interface PostProcessingStackProps extends cdk.StackProps {
  /** The app instance whose channels this may read. Scopes every Chime grant. */
  appInstanceArn: string;
  /** The message stream, from the Messaging stack. */
  messageStream: kinesis.IStream;
  /**
   * The bucket holding profile BODIES (an active version's persona lives under `profiles/*`). Needed
   * because arrival triage resolves the active profile for its configured copy.
   */
  attachmentsBucketName: string;
  attachmentsBucketArn: string;
}

export class PostProcessingStack extends cdk.Stack {
  public readonly postProcessingFunctionArn: string;

  constructor(scope: Construct, id: string, props: PostProcessingStackProps) {
    super(scope, id, props);

    const shared = resolveSharedSSM(this);
    // The queue record and the kill switch, so triage-on-arrival is inert wherever queueing is.
    const turnQueue = turnQueueWiring(this, shared.turnStateArn, shared.turnStateName);

    // The turn is handed to the ROUTER for the channel's classification - the same Lambda Lex fulfills
    // into and the same one the flow's `@all` bypass uses. Found by name at call time from the parameter
    // each classification stack publishes (`resolveRouterArn`), so there is no second routing table to
    // drift and this stack takes no deploy-time value from the classification stacks. A classification
    // reaches only its own router.

    const messageStream = props.messageStream;

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
              resources: [props.messageStream.streamArn],
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
        // TRIAGE ON ARRIVAL (ADR-033). Reads the queue record, decides whether it may serve the
        // conversation, and reads the queued messages themselves - all as this component, which
        // already dispatches turns through the routers.
        //
        // NO WRITE TO THE TASK TABLES here, deliberately: the dispatched turn creates the tasks, and
        // it does so through the task service. This one reads a queue and hands it on.
        TriageOnArrival: new iam.PolicyDocument({
          statements: [
            // A tag READ cannot itself be tag-gated - it is how the classification is learned - so it
            // is unconditioned and read-only, the same statement and reasoning the router carries.
            new iam.PolicyStatement({
              actions: ['chime:ListTagsForResource'],
              resources: [`${props.appInstanceArn}/channel/*`],
            }),
            // The queued messages are read, and the notice settled, AS THE ASSISTANT whose queue it
            // is: on a session its classification's vend mints for that one bot. So this role reads
            // no message content and edits nothing itself. (It held GetChannelMessage bearing any bot.)
            ...speakAsAssistantStatements(this, EVERY_CLASSIFICATION),
          ],
        }),
        // THE ASSISTANT'S CONFIGURED WORDS. Arrival triage resolves the active profile version
        // for its copy, and without these the read was refused (`AccessDeniedException`, measured on
        // the premium profile 2026-09-14) and every notice it wrote fell back to shipped English. The
        // same READ-ONLY grants the router carries: the definition namespace, and `profiles/*` for the
        // persona body a version points at. Reading a definition is behavior, not a boundary.
        ProfileRead: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter', 'ssm:GetParameterHistory'],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/definition`],
            }),
            new iam.PolicyStatement({
              actions: ['s3:GetObject'],
              resources: [`${props.attachmentsBucketArn}/profiles/*`],
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
        // THE ROUTERS, AND NOTHING ELSE IN THE CLASSIFICATION STACKS. The rules dispatch turns through each
        // classification's router and need no other function there: the router's construct id, bounded to
        // this instance's functions that carry a classification, read by name (`routerByNameStatements`).
        RouterInvoke: new iam.PolicyDocument({
          statements: routerByNameStatements(this, EVERY_CLASSIFICATION),
        }),
      },
    });

    // Read AND write on the queue record: triage claims the right to read it, then releases.
    turnQueue.grant(postProcessingRole);

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
        ...speakAsAssistantEnv(),
        PROFILE_BODY_BUCKET: props.attachmentsBucketName,
        ...routerByNameEnvironment(),
        TASKS_TABLE: shared.agentTasksName,
        // The queue record triage reads, and the same kill switch every other queue path honors -
        // so this rule is inert on a deployment that has not enabled queueing, like the rest of it.
        ...turnQueue.env,
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
