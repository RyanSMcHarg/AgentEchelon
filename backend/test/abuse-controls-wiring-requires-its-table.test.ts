/**
 * THE LIMITS FAIL CLOSED, SO SYNTHESIS REFUSES THEM WITHOUT THEIR TABLE.
 *
 * The rate limit and the spend budgets refuse every call when their table name is unset
 * (`lambda/src/lib/abuse-controls.ts`). A wiring that set the limits and lost the name would deploy a
 * deployment that refuses every turn, so `abuseControlsWiring` refuses it at synthesis instead.
 */
import * as cdk from 'aws-cdk-lib';
import { abuseControlsWiring } from '../lib/stacks/agent-classification-common';

const ARN = 'arn:aws:dynamodb:us-east-1:123456789012:table/abuse';

function stack(context: Record<string, unknown> = {}): cdk.Stack {
  return new cdk.Stack(new cdk.App({ context }), 'AbuseWiring', { env: { account: '123456789012', region: 'us-east-1' } });
}

describe('abuseControlsWiring', () => {
  it('refuses an empty table name', () => {
    expect(() => abuseControlsWiring(stack(), ARN, '', 'standard', 'us-east-1', '123456789012'))
      .toThrow(/abuse-controls table name is empty/);
  });

  it('refuses an empty table name even with both budgets 0, since the rate limit is set per assistant at runtime', () => {
    const s = stack({ bedrockUserHourlyBudget: '0', bedrockGlobalHourlyBudget: '0' });
    expect(() => abuseControlsWiring(s, ARN, '', 'standard', 'us-east-1', '123456789012')).toThrow();
  });

  it('wires the table it is given', () => {
    const { env } = abuseControlsWiring(stack(), ARN, 'abuse', 'standard', 'us-east-1', '123456789012');
    expect(env.ABUSE_CONTROLS_TABLE).toBe('abuse');
  });
});
