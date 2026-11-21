/**
 * THE TRIGGER FORM CHOOSES FROM WHAT EXISTS (DESIGN-EVENT-TARGETS 11.1, phase 5).
 *
 * An admin attaching a trigger picks a rule already in the account or an alarm from lists rather than typing one: the
 * account's rules on the default bus, with this deployment's own trigger and watch rules marked as attached, and its alarms
 * with their state. Both lists are an admin's (`manage-event-triggers`), never a team's, and the alarm read changes nothing.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

process.env.EVENT_TRIGGER_RULE_PREFIX = 'AgentEchelon-';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { listAccountRules, listAccountAlarms, MAX_LISTED } = require('../../lambda/src/event-triggers-api') as typeof import('../../lambda/src/event-triggers-api');
import { ADMIN_CAPABILITIES } from '../../lib/config/admin-capabilities';

const STACK = readFileSync(join(__dirname, '../../lib/stacks/admin-services-stack.ts'), 'utf8');
const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe('the account\'s rules', () => {
  it('lists each with its pattern and state, and marks this deployment\'s own as attached', async () => {
    const rules = await listAccountRules('', async () => ({ Rules: [
      { Name: 'AgentEchelon-premium-trigger-571de87a1647', Arn: 'arn:r1', EventPattern: '{"source":["aws.cloudwatch"]}', State: 'ENABLED' },
      { Name: 'billing-nightly', Arn: 'arn:r2', EventPattern: '{"source":["aws.ce"]}', State: 'DISABLED', Description: 'cost report' },
    ] }));
    expect(rules).toEqual([
      { name: 'AgentEchelon-premium-trigger-571de87a1647', arn: 'arn:r1', pattern: '{"source":["aws.cloudwatch"]}', state: 'ENABLED', attached: true },
      { name: 'billing-nightly', arn: 'arn:r2', pattern: '{"source":["aws.ce"]}', state: 'DISABLED', description: 'cost report', attached: false },
    ]);
  });

  it('reads page after page, and stops at the listing\'s bound', async () => {
    let calls = 0;
    const rules = await listAccountRules('x', async () => {
      calls += 1;
      return { Rules: Array.from({ length: 100 }, (_v, i) => ({ Name: `r${calls}-${i}`, Arn: 'a', State: 'ENABLED' })), NextToken: 'more' };
    });
    expect(rules).toHaveLength(MAX_LISTED);
    expect(calls).toBe(MAX_LISTED / 100);
  });
});

describe('the account\'s alarms', () => {
  it('lists metric and composite alarms with their state, by name prefix', async () => {
    const asked: Array<Record<string, unknown>> = [];
    const alarms = await listAccountAlarms('Customer', async (c) => {
      asked.push(c.input as Record<string, unknown>);
      return {
        MetricAlarms: [{ AlarmName: 'Customer-API-availability', AlarmArn: 'arn:a1', StateValue: 'ALARM', Namespace: 'AWS/ApiGateway', MetricName: '5XXError' }],
        CompositeAlarms: [{ AlarmName: 'Customer-overall', AlarmArn: 'arn:a2', StateValue: 'OK' }],
      };
    });
    expect(asked[0]).toMatchObject({ AlarmNamePrefix: 'Customer', AlarmTypes: ['MetricAlarm', 'CompositeAlarm'] });
    expect(alarms).toEqual([
      { name: 'Customer-API-availability', arn: 'arn:a1', state: 'ALARM', kind: 'metric', namespace: 'AWS/ApiGateway', metric: '5XXError' },
      { name: 'Customer-overall', arn: 'arn:a2', state: 'OK', kind: 'composite' },
    ]);
  });
});

describe('who may list them', () => {
  it('DENY: both lists are an admin\'s, and no team route reaches them', () => {
    const manage = ADMIN_CAPABILITIES['manage-event-triggers'];
    expect(manage.roles).toEqual(['admins']);
    expect(manage.resources.map(key)).toEqual(expect.arrayContaining(['GET admin/event-rules', 'GET admin/event-alarms']));
    const teamRoutes = Object.values(ADMIN_CAPABILITIES).flatMap((c) => (c.teamResources ?? []).map(key));
    expect(teamRoutes.filter((r) => /event-rules|event-alarms/.test(r))).toEqual([]);
  });

  it('DENY: the alarm grant is a read, and nothing else', () => {
    expect(STACK).toMatch(/sid: 'ListAlarmsForTheForm', actions: \['cloudwatch:DescribeAlarms'\], resources: \['\*'\]/);
    expect(STACK).not.toMatch(/cloudwatch:(PutMetricAlarm|DeleteAlarms|SetAlarmState)/);
  });
});
