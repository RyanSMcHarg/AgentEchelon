/**
 * EVERY ALARM IS PUBLISHED BY NAME, IN THE STACK THAT OWNS IT (`publishAlarmNames`).
 *
 * The ops assistant reads alarm state by name, because CloudWatch refuses a listing call under a grant
 * scoped to this deployment's alarm ARNs. These pin the construct: every alarm in the tree is published,
 * a generated name as well as a chosen one, a nested stack's in the nested stack, and in groups small
 * enough for a Standard parameter. The deploy matrix checks the same property over the whole app
 * (`alarmPublicationViolations`).
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { alarmNamesPathOf, NAMES_PER_PARAMETER, publishAlarmNames } from '../../lib/constructs/alarm-names';

const metric = new cloudwatch.Metric({ namespace: 'T', metricName: 'm' });
const alarm = (scope: cdk.Stack | cdk.NestedStack, id: string, alarmName?: string) =>
  new cloudwatch.Alarm(scope, id, { metric, threshold: 1, evaluationPeriods: 1, ...(alarmName ? { alarmName } : {}) });

function build() {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'AgentEchelonArchive', { env: { account: '123456789012', region: 'us-east-1' } });
  alarm(stack, 'Named', 'AgentEchelonArchive-named');
  for (let i = 0; i < 11; i += 1) alarm(stack, `Generated${i}`);
  const nested = new cdk.NestedStack(stack, 'Inner');
  alarm(nested, 'NestedAlarm');
  const quiet = new cdk.Stack(app, 'AgentEchelonQuiet', { env: { account: '123456789012', region: 'us-east-1' } });
  publishAlarmNames(app, '/agent-echelon');
  return { stack, nested, quiet };
}

type Param = { Properties: { Name: string; Value: unknown } };
const params = (t: Template) => Object.values(t.findResources('AWS::SSM::Parameter')) as Param[];
const refsIn = (value: unknown): string[] => JSON.stringify(value).match(/"Ref":"([^"]+)"/g)?.map((m) => m.slice(7, -1)) ?? [];

describe('publishAlarmNames', () => {
  it('publishes every alarm of a stack, chosen and generated names alike, in groups', () => {
    const { stack } = build();
    const t = Template.fromStack(stack);
    const published = params(t).filter((p) => p.Properties.Name.startsWith(`${alarmNamesPathOf('/agent-echelon')}/AgentEchelonArchive/`));
    expect(published.map((p) => p.Properties.Name).sort()).toEqual([
      '/agent-echelon/alarms/AgentEchelonArchive/0',
      '/agent-echelon/alarms/AgentEchelonArchive/1',
    ]);
    const alarmIds = Object.keys(t.findResources('AWS::CloudWatch::Alarm'));
    expect(alarmIds).toHaveLength(12);
    const refs = published.flatMap((p) => refsIn(p.Properties.Value));
    expect(refs.sort()).toEqual([...alarmIds].sort());
    for (const p of published) expect(refsIn(p.Properties.Value).length).toBeLessThanOrEqual(NAMES_PER_PARAMETER);
  });

  it('publishes a nested stack\'s alarm in the nested stack, under its parent\'s path', () => {
    const { nested } = build();
    const t = Template.fromStack(nested);
    const [p] = params(t);
    expect(p.Properties.Name).toBe('/agent-echelon/alarms/AgentEchelonArchive/Inner/0');
    expect(refsIn(p.Properties.Value)).toEqual(Object.keys(t.findResources('AWS::CloudWatch::Alarm')));
  });

  it('publishes nothing for a stack with no alarm', () => {
    const { quiet } = build();
    expect(params(Template.fromStack(quiet))).toEqual([]);
  });
});
