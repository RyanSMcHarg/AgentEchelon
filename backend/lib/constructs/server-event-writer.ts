/**
 * A FUNCTION THAT APPENDS EVENTS THE PLATFORM RECORDS ABOUT ITSELF TO THE ARCHIVE (`appendServerEvent`,
 * `lambda/src/lib/event-archive.ts`): the client-events Firehose in Athena mode, the Aurora data plane in
 * Aurora mode. Both are named before they exist, because the Archive stack deploys after the stacks that
 * write here, so the grant names them by the instance's fixed names.
 *
 * One definition for every writer (tenet D9): the guest funnel's stages (B12), an export's record (B13).
 * Offboarding's own role carries the same two statements in its inline policy.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { ANALYTICS_PREFIX, SHARED_SSM, STACK_PREFIX, ownInstanceFunctionsOnly } from '../stacks/agent-classification-common';

/** The archive's statements, for a role assembled by hand. */
export function serverEventStatements(stack: cdk.Stack, sidPrefix = 'ServerEvent'): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      sid: `${sidPrefix}Firehose`,
      actions: ['firehose:PutRecordBatch'],
      resources: [`arn:aws:firehose:${stack.region}:${stack.account}:deliverystream/${ANALYTICS_PREFIX}-client-events`],
    }),
    new iam.PolicyStatement({
      sid: `${sidPrefix}DataPlane`,
      actions: ['lambda:InvokeFunction'],
      // This instance's data plane only: the prefix pattern also matches an instance whose prefix starts
      // with this one, so the `Instance` tag bounds it.
      resources: [`arn:aws:lambda:${stack.region}:${stack.account}:function:${STACK_PREFIX}Archive*DataPlaneLambda*`],
      conditions: ownInstanceFunctionsOnly(),
    }),
    new iam.PolicyStatement({
      sid: `${sidPrefix}DataPlaneArn`,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${stack.region}:${stack.account}:parameter${SHARED_SSM.auroraDataPlaneArn}`],
    }),
  ];
}

/** Hand a function the archive: its two destinations' names and the grants to write to them. */
export function grantServerEventAppend(fn: lambda.Function, sidPrefix = 'ServerEvent'): void {
  const stack = cdk.Stack.of(fn);
  fn.addEnvironment('CLIENT_EVENTS_DELIVERY_STREAM', `${ANALYTICS_PREFIX}-client-events`);
  fn.addEnvironment('AURORA_DATA_PLANE_ARN_PARAM', SHARED_SSM.auroraDataPlaneArn);
  for (const s of serverEventStatements(stack, sidPrefix)) fn.addToRolePolicy(s);
}
