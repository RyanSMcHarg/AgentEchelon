/**
 * PostProcessingStack synthesis.
 *
 * Everything this component needs is wiring, and every piece of it fails SILENTLY when it is missing.
 * Without the Kinesis source it never runs; without the invoke grant it denies at runtime and the
 * answer is dropped exactly as it was before; without the task-table read it resolves nothing; without
 * the alarm the repair succeeds invisibly and ADR-032 tenet 6 is lost - which is the failure that gets
 * worse the longer it goes unnoticed, because the client defect stops being measurable.
 *
 * None of that is reachable from a handler unit test: the code paths all degrade politely.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PostProcessingStack } from '../lib/stacks/post-processing-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const STREAM_ARN = 'arn:aws:kinesis:us-east-1:123456789012:stream/agent-echelon-messages';
const props = {
  env,
  appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/11111111-2222-3333-4444-555555555555',
  kinesisStreamArn: STREAM_ARN,
};

function synth(): Template {
  const app = new cdk.App();
  return Template.fromStack(new PostProcessingStack(app, 'TestPostProcessing', props));
}

/** Every statement on every policy in the stack, flattened. */
function statements(template: Template): any[] {
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .concat(Object.values(template.findResources('AWS::IAM::Role')))
    .flatMap((r: any) => {
      const doc = r.Properties?.PolicyDocument?.Statement;
      const inline = (r.Properties?.Policies || []).flatMap((p: any) => p.PolicyDocument?.Statement || []);
      return [...(doc || []), ...inline];
    });
}

const actionsOf = (s: any): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]).filter(Boolean);

describe('PostProcessingStack', () => {
  it('consumes the Chime message stream, from LATEST', () => {
    const template = synth();
    // TRIM_HORIZON would dispatch turns for messages sent before this consumer existed - answering
    // questions people gave up on days ago.
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      EventSourceArn: STREAM_ARN,
      StartingPosition: 'LATEST',
    });
  });

  it('DOES NOT BATCH, because a batching window is added to a person\'s wait', () => {
    // This consumer dispatches a turn; the archival consumer on the SAME stream does bulk writes and
    // wants the opposite setting. This shipped with archival's 5s window copied onto it, and it cost
    // 3.0-3.4s per repair on the live deployment - all of it the window, none of it Kinesis, which
    // measures ~200-500ms for this shape in a comparable dispatch-off-stream deployment.
    //
    // Asserted as an ABSENT property rather than a value, because the failure mode is someone copying
    // the archival block again, and that is what this must catch.
    const mappings = synth().findResources('AWS::Lambda::EventSourceMapping');
    const [mapping] = Object.values(mappings) as any[];
    expect(mapping.Properties.MaximumBatchingWindowInSeconds).toBeUndefined();
    // A cap, not a delay: with no window, records are delivered as they arrive.
    expect(mapping.Properties.BatchSize).toBeLessThanOrEqual(10);
  });

  it('can invoke the classification routers, and nothing else', () => {
    const invoke = statements(synth()).filter((s) => actionsOf(s).includes('lambda:InvokeFunction'));
    expect(invoke).toHaveLength(1);
    // Named by the stack PREFIX rather than by a pattern built from a full stack name:
    // CloudFormation truncates a generated physical name at 64 characters, and a grant built from
    // the full name deploys green and denies at runtime (the defect that made an earlier version of
    // this seam inert).
    expect(JSON.stringify(invoke[0].Resource)).toContain('Classification-*');
  });

  it('reads the task table and cannot write it', () => {
    const onTasks = statements(synth()).filter((s) =>
      actionsOf(s).some((a) => a.startsWith('dynamodb:')) && actionsOf(s).includes('dynamodb:GetItem'));
    expect(onTasks.length).toBeGreaterThan(0);
    // This component resolves a turn; it never advances one. A write grant here would let a stream
    // consumer mutate the chain it is only supposed to read.
    for (const s of onTasks) {
      expect(actionsOf(s)).not.toContain('dynamodb:UpdateItem');
      expect(actionsOf(s)).not.toContain('dynamodb:DeleteItem');
    }
  });

  it('can take the durable repair claim', () => {
    // An in-memory claim is per container, so two Kinesis deliveries on two containers would each
    // believe they were first and the person would be answered twice.
    const claims = statements(synth()).filter((s) => actionsOf(s).includes('dynamodb:PutItem'));
    expect(claims.length).toBeGreaterThan(0);
  });

  it('reads Chime and never sends', () => {
    const chime = statements(synth()).filter((s) => actionsOf(s).some((a) => a.startsWith('chime:')));
    const actions = chime.flatMap(actionsOf);
    expect(actions).toEqual(expect.arrayContaining(['chime:ListTagsForResource', 'chime:ListChannelMemberships']));
    // A repair that posted would be a second implementation of a turn. It cannot, by grant as well as
    // by code.
    expect(actions).not.toContain('chime:SendChannelMessage');
  });

  it('knows all three routers, so a basic channel is never answered by standard', () => {
    const fns = Object.values(synth().findResources('AWS::Lambda::Function')) as any[];
    expect(fns).toHaveLength(1);
    const vars = fns[0].Properties.Environment.Variables;
    // `basic` deliberately has no upward fallback in the code; the wiring has to supply its own ARN
    // or that rule cannot be honoured.
    expect(Object.keys(vars)).toEqual(expect.arrayContaining([
      'ROUTER_ARN', 'BASIC_ROUTER_ARN', 'PREMIUM_ROUTER_ARN', 'TASKS_TABLE', 'ABUSE_CONTROLS_TABLE',
    ]));
  });

  it('ALARMS ON THE REPAIR SUCCEEDING (ADR-032 tenet 6)', () => {
    // Not an error alarm. A repair nobody can see is a permanent one: the client defect stops being
    // measurable, and the stream path quietly becomes the primary one.
    synth().hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AgentEchelon/TaskAnswerRepair',
      MetricName: 'Repairs',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  it('is one Lambda and touches nothing else', () => {
    const template = synth();
    template.resourceCountIs('AWS::Lambda::Function', 1);
    // No table, no stream, no queue: it owns no state. Everything it reads belongs to someone else,
    // which is what makes the whole stack removable without consequence.
    template.resourceCountIs('AWS::DynamoDB::Table', 0);
    template.resourceCountIs('AWS::Kinesis::Stream', 0);
    void Match;
  });
});
