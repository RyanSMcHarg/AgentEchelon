/**
 * EVERY ALARM THE APP CREATES IS PUBLISHED BY NAME, BY THE STACK THAT OWNS IT.
 *
 * The ops assistant's `read_deployment_health` reads this deployment's alarm state with `DescribeAlarms`,
 * granted on this deployment's alarm ARNs. CloudWatch authorizes a listing call (by prefix, by state, or
 * with no filter) against `alarm:*`, and a call that names its alarms against each alarm's own ARN, so a
 * narrowly scoped reader asks by name. The names therefore come from the deployment itself rather than
 * from a listing: each stack (nested stacks included) publishes the names of the alarms it declares under
 * `alarmNamesPathOf(ssmRoot)/<stack path>/<n>`, and the tool reads that path.
 *
 * COLLECTED FROM THE CONSTRUCT TREE, once every stack exists, so an alarm needs no registration of its own:
 * declaring it is publishing it. Each value is the alarm's `Ref`, which is its name whether the stack chose
 * it or CloudFormation generated it. Names are written in groups of `NAMES_PER_PARAMETER`, so a value stays
 * inside a Standard parameter's 4 KB whatever the alarm names' length (at most 255 characters each).
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { IConstruct } from 'constructs';

/** Ten names of at most 255 characters, comma-joined, fit a Standard parameter. */
export const NAMES_PER_PARAMETER = 10;

/** The SSM path under which every stack publishes its alarm names. */
export function alarmNamesPathOf(ssmRoot: string): string {
  return `${ssmRoot}/alarms`;
}

/** A stack's place under the path: its construct path, which names a nested stack under its parent. */
function stackSegment(stack: cdk.Stack): string {
  return stack.node.path.replace(/[^a-zA-Z0-9_./-]/g, '-');
}

/** Publish every alarm in `root`'s tree under `alarmNamesPathOf(ssmRoot)`, in the stack that owns it. */
export function publishAlarmNames(root: IConstruct, ssmRoot: string): void {
  const byStack = new Map<cdk.Stack, cloudwatch.CfnAlarm[]>();
  for (const c of root.node.findAll()) {
    if (!(c instanceof cloudwatch.CfnAlarm)) continue;
    const stack = cdk.Stack.of(c);
    byStack.set(stack, [...(byStack.get(stack) ?? []), c]);
  }
  for (const [stack, alarms] of byStack) {
    for (let i = 0; i * NAMES_PER_PARAMETER < alarms.length; i += 1) {
      const group = alarms.slice(i * NAMES_PER_PARAMETER, (i + 1) * NAMES_PER_PARAMETER);
      new ssm.StringParameter(stack, `PublishedAlarmNames${i}`, {
        parameterName: `${alarmNamesPathOf(ssmRoot)}/${stackSegment(stack)}/${i}`,
        description: 'The names of the CloudWatch alarms this stack declares, read by the ops assistant.',
        stringValue: cdk.Fn.join(',', group.map((a) => a.ref)),
      });
    }
  }
}
