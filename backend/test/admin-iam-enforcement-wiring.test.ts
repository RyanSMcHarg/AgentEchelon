/**
 * Every Lambda behind an AWS_IAM-authorized admin route must be TOLD the deployment enforces IAM.
 *
 * `requireAdmin` trusts a gateway-vetted signed principal only when `ADMIN_IAM_ENFORCEMENT=true` is
 * in its environment. Without that variable it falls through to Cognito authorizer claims — which an
 * IAM-authorized request does not carry — and refuses every single call with a 401.
 *
 * This guard exists because that is exactly what shipped: `ClassifierReplayStartFn` deployed
 * cleanly, its route answered, its IAM grant was correct, and the first real request was refused.
 * Nothing in the unit tests could see it (the handler is right; the environment was incomplete) and
 * nothing in the template review could either, because a missing variable looks like every other
 * variable that is deliberately absent.
 *
 * Asserted from the TEMPLATE rather than as a list of expected functions, so a new IAM-authorized
 * admin route is covered the day it is added instead of the day someone remembers this file.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

const env = { account: '123456789012', region: 'us-east-1' };

/** The logical ids a `Fn::GetAtt`/`Fn::Sub` integration URI refers to. */
function referencedLogicalIds(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const n of node) referencedLogicalIds(n, out);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'Fn::GetAtt' && Array.isArray(v) && typeof v[0] === 'string') out.add(v[0]);
      else referencedLogicalIds(v, out);
    }
  }
  return out;
}

describe('an IAM-authorized admin route always tells its Lambda that IAM is enforced', () => {
  it('every function behind an AWS_IAM analytics method carries ADMIN_IAM_ENFORCEMENT', async () => {
    const { AnalyticsStackAurora } = await import('../lib/stacks/analytics-stack-aurora');
    const app = new cdk.App({
      context: {
        adminIamEnforcement: true,
        adminAppUrl: 'https://admin.example.com',
        appUrl: 'https://chat.example.com',
      },
    });
    const stack = new AnalyticsStackAurora(app, 'TestAnalyticsIamEnforcement', {
      env,
      appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
      userPoolId: 'us-east-1_TestPoolId',
      adminIamEnforcement: true,
    } as never);

    const template = Template.fromStack(stack);
    const methods = template.findResources('AWS::ApiGateway::Method');
    const functions = template.findResources('AWS::Lambda::Function');

    const iamAuthedFunctionIds = new Set<string>();
    for (const method of Object.values(methods)) {
      if ((method.Properties as Record<string, unknown>)?.AuthorizationType !== 'AWS_IAM') continue;
      for (const id of referencedLogicalIds((method.Properties as Record<string, unknown>).Integration)) {
        if (functions[id]) iamAuthedFunctionIds.add(id);
      }
    }

    // If this is empty the test is vacuous — it would pass while asserting nothing at all.
    expect(iamAuthedFunctionIds.size).toBeGreaterThan(0);

    const missing = [...iamAuthedFunctionIds].filter((id) => {
      const vars = ((functions[id].Properties as Record<string, unknown>)?.Environment as
        | { Variables?: Record<string, unknown> }
        | undefined)?.Variables;
      return vars?.ADMIN_IAM_ENFORCEMENT !== 'true';
    });

    expect(missing).toEqual([]);
  });
});
