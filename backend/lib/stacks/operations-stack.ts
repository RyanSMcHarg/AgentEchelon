/**
 * OPERATIONS (`<prefix>Operations`, the `operations` capability): the deployment's account-wide
 * dashboard, and nothing else.
 *
 * DASHBOARDS ONLY. Every stack keeps its own alarms beside the resources they watch (the stranded-lock
 * alarm with the turn-state table, the repair-rate alarm with post-processing, the notification-failure
 * and archival alarms with the email bridge), and the audit trail is in `Identity`. So a deployment that
 * does not declare `operations` loses a view, never a signal: this stack reads metrics the other stacks
 * already emit and creates no alarm, no function and no grant.
 *
 * ONE VIEW ACROSS THE STACKS. A per-stack alarm answers "is this broken"; this answers "what is the
 * deployment doing", on one page: whether messages are flowing, whether the after-the-fact repairs are
 * running, whether turns are being recovered, and how each classification's context sources answer, each found
 * by a search over the metrics it emits rather than from a list of the declared classifications.
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type * as kinesis from 'aws-cdk-lib/aws-kinesis';
import { Construct } from 'constructs';
import { CONTEXT_SOURCE_METRIC_NAMESPACE } from '../config/context-sources';
import { RES_PREFIX } from './agent-classification-common';

export interface OperationsStackProps extends cdk.StackProps {
  /** The message stream, from the Messaging stack: its incoming records are the deployment's pulse. */
  messageStream: kinesis.IStream;
}

/** One period for every widget, so the graphs line up. */
const PERIOD = cdk.Duration.minutes(5);

const sum = (namespace: string, metricName: string, label: string, dimensionsMap?: Record<string, string>): cloudwatch.Metric =>
  new cloudwatch.Metric({ namespace, metricName, dimensionsMap, statistic: 'Sum', period: PERIOD, label });

export class OperationsStack extends cdk.Stack {
  /** The dashboard's name, for a link from a runbook or an alert. */
  public readonly dashboardName: string;

  constructor(scope: Construct, id: string, props: OperationsStackProps) {
    super(scope, id, props);

    this.dashboardName = `${RES_PREFIX}-operations`;

    const rows: cloudwatch.IWidget[][] = [
      [
        new cloudwatch.TextWidget({
          markdown: '## Deployment operations\n'
            + 'Each stack holds its own alarms; this dashboard reads the metrics they watch. '
            + 'Message flow is the stream the archive, post-processing and the email bridge read.',
          width: 24,
          height: 2,
        }),
      ],
      [
        new cloudwatch.GraphWidget({
          title: 'Messages into the stream',
          left: [props.messageStream.metricIncomingRecords({ statistic: 'Sum', period: PERIOD, label: 'records' })],
          width: 12,
        }),
        new cloudwatch.GraphWidget({
          title: 'Turns recovered from a stranded lock',
          left: [sum('AgentEchelon/TurnQueue', 'LockTakeover', 'lock takeovers')],
          width: 12,
        }),
      ],
      [
        new cloudwatch.GraphWidget({
          title: 'Task answers repaired from the stream',
          left: [sum('AgentEchelon/TaskAnswerRepair', 'Repairs', 'repairs')],
          width: 12,
        }),
        // Present whether or not `notifications` is declared: declaring it later changes no other
        // stack, this one included. Without the bridge the series is empty.
        new cloudwatch.GraphWidget({
          title: 'Notifications that failed to send',
          left: [sum('AgentEchelon/Notifications', 'Failed', 'failed')],
          width: 12,
        }),
      ],
      [
        // ONE SERIES PER CLASSIFICATION THAT EMITS ONE, found by a CloudWatch SEARCH over the `Classification,
        // Outcome` dimension set the runtime emits (`context-source-outcomes.ts`), rather than one series per
        // declared classification. So declaring a classification changes nothing here: its series appears
        // when its context sources first answer.
        new cloudwatch.GraphWidget({
          title: 'Context-source refusals by classification (denied is the security one)',
          left: [new cloudwatch.MathExpression({
            expression: `SEARCH('{${CONTEXT_SOURCE_METRIC_NAMESPACE},Classification,Outcome} MetricName="ContextSourceFailed" Outcome="denied"', 'Sum', ${PERIOD.toSeconds()})`,
            usingMetrics: {},
            period: PERIOD,
            label: '',
          })],
          width: 24,
        }),
      ],
    ];

    new cloudwatch.Dashboard(this, 'OperationsDashboard', {
      dashboardName: this.dashboardName,
      widgets: rows,
    });

    new cdk.CfnOutput(this, 'OperationsDashboardName', {
      value: this.dashboardName,
      description: 'The deployment-wide CloudWatch dashboard',
    });

    cdk.Tags.of(this).add('Component', 'Operations');
  }
}
