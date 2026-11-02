/**
 * THE OPERATIONS DASHBOARD NAMES NO CLASSIFICATION (the classification-independence plan, step 4).
 *
 * The context-source refusals widget graphs one series per classification that emits one, found by a CloudWatch
 * SEARCH over the `Classification, Outcome` dimension set the runtime emits, so declaring a classification
 * changes nothing in `Operations`. Read from the synthesized dashboard body.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { OperationsStack } from '../lib/stacks/operations-stack';
import { testMessageStream } from './helpers/synth';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';
import { CONTEXT_SOURCE_METRIC_NAMESPACE } from '../lib/config/context-sources';

const env = { account: '123456789012', region: 'us-east-1' };

it('finds each classification\'s refusals by a search, and names none', () => {
  const app = new cdk.App();
  const stack = new OperationsStack(app, 'TestOperations', { env, messageStream: testMessageStream(app) });
  const dashboards = Object.values(Template.fromStack(stack).findResources('AWS::CloudWatch::Dashboard')) as Array<{ Properties: { DashboardBody: unknown } }>;
  expect(dashboards).toHaveLength(1);
  const body = JSON.stringify(dashboards[0].Properties.DashboardBody);
  expect(body).toContain(`SEARCH('{${CONTEXT_SOURCE_METRIC_NAMESPACE},Classification,Outcome} MetricName=\\\\\\"ContextSourceFailed\\\\\\" Outcome=\\\\\\"denied\\\\\\"'`);
  // One mention of the metric, the search: never one series per declared classification.
  expect(profiles.classificationValues().length).toBeGreaterThan(1);
  expect(body.split('ContextSourceFailed').length - 1).toBe(1);
});
