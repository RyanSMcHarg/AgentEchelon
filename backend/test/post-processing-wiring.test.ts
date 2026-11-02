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
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import { PostProcessingStack, type PostProcessingStackProps } from '../lib/stacks/post-processing-stack';
import { assistantClassifications } from '../lib/config/profiles';

const env = { account: '123456789012', region: 'us-east-1' };
const STREAM_ARN = 'arn:aws:kinesis:us-east-1:123456789012:stream/agent-echelon-messages';
const props = {
  env,
  classifications: assistantClassifications(),
  appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/11111111-2222-3333-4444-555555555555',
  attachmentsBucketName: 'test-attachments',
  attachmentsBucketArn: 'arn:aws:s3:::test-attachments',
};

function synth(over: Partial<PostProcessingStackProps> = {}): Template {
  const app = new cdk.App();
  // The Messaging stack's stream, imported by its ARN so the test needs no Messaging stack.
  const messageStream = kinesis.Stream.fromStreamArn(new cdk.Stack(app, 'StreamHost', { env }), 'MessageStream', STREAM_ARN);
  return Template.fromStack(new PostProcessingStack(app, 'TestPostProcessing', { ...props, messageStream, ...over }));
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

  it('can invoke the classification routers and their vends, each by its own construct id and tags, and nothing else', () => {
    // The vend is how triage reads the queue as the assistant whose queue it is.
    const invoke = statements(synth()).filter((s) => actionsOf(s).includes('lambda:InvokeFunction')
      && !JSON.stringify(s.Resource).includes('AssistantVend'));
    expect(invoke).toHaveLength(1);
    // THE ROUTERS BY THEIR CONSTRUCT ID, never a pattern over the assistant stacks, which would also reach each
    // classification's vend and processor. Found by name at call time, so the grant names no classification:
    // this instance's functions (the `Instance` tag) that carry a classification. The construct id follows the
    // stack name's truncated part, so the 64-character truncation that breaks a stack-name pattern cannot apply.
    const resources = ([] as unknown[]).concat(invoke[0].Resource).map((r) => JSON.stringify(r));
    expect(resources).toHaveLength(1);
    expect(resources[0]).toContain('-AgentHandler*');
    expect(resources[0]).not.toContain('Assistants-*');
    expect(invoke[0].Condition).toEqual({
      StringEquals: { 'aws:ResourceTag/Instance': 'agent-echelon' },
      Null: { 'aws:ResourceTag/classification': 'false' },
    });
  });

  it('holds no Amazon Chime SDK bearer on any bot: it reads the queue on the assistant session', () => {
    const onBots = statements(synth()).filter((s) => actionsOf(s).some((a) => a.startsWith('chime:'))
      && JSON.stringify(s.Resource ?? '').includes('/bot/'));
    expect(onBots).toEqual([]);
  });

  it('reads the task table and cannot write it', () => {
    // SCOPED TO THE TASK TABLE, not to "any DynamoDB statement with a GetItem". It was the looser
    // form while the task read was the only such grant, and it then failed the moment this component
    // gained a legitimate write on a DIFFERENT table - reporting a widening that had not happened.
    // A guard that fires on the wrong resource is one people learn to relax rather than read.
    const onTasks = statements(synth()).filter((s) =>
      actionsOf(s).some((a) => a.startsWith('dynamodb:'))
      && JSON.stringify(s.Resource ?? '').toLowerCase().includes('agenttasks'));
    expect(onTasks.length).toBeGreaterThan(0);
    // This component resolves a turn; it never advances one. A write grant here would let a stream
    // consumer mutate the chain it is only supposed to read.
    for (const s of onTasks) {
      expect(actionsOf(s)).not.toContain('dynamodb:UpdateItem');
      expect(actionsOf(s)).not.toContain('dynamodb:DeleteItem');
      expect(actionsOf(s)).not.toContain('dynamodb:PutItem');
    }
  });

  it('may claim and release triage on the QUEUE record, which is a different table', () => {
    // Triage-on-arrival needs exclusion from itself, and that claim is a conditional write. It lands
    // on the turn-state record and must never reach the task tables - which is why the assertion
    // above is scoped by resource rather than by verb.
    const onQueue = statements(synth()).filter((s) =>
      JSON.stringify(s.Resource ?? '').toLowerCase().includes('turnstate'));
    expect(onQueue.length).toBeGreaterThan(0);
    const verbs = onQueue.flatMap(actionsOf);
    expect(verbs).toContain('dynamodb:UpdateItem');
    expect(verbs).toContain('dynamodb:GetItem');
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

  it('finds each classification\'s router by name, so it carries no table of them and none is answered by another', () => {
    const t = synth();
    const fns = Object.values(t.findResources('AWS::Lambda::Function')) as any[];
    expect(fns).toHaveLength(1);
    const vars = fns[0].Properties.Environment.Variables;
    // No classification falls back to another's router in the code (lib/router-arn.ts): each is read from its
    // own `router-arn` parameter at call time, under the root the function carries.
    expect(vars.ROUTER_ARN_PARAM_ROOT).toBe('/agent-echelon/assistant');
    expect(Object.keys(vars)).toEqual(expect.arrayContaining(['TASKS_TABLE', 'ABUSE_CONTROLS_TABLE']));
    expect(Object.keys(vars).filter((k) => k.endsWith('_ROUTER_ARN'))).toEqual([]);
    // And so no router parameter is resolved at deploy: the stack deploys before, or without, any one
    // classification's stack.
    expect(Object.keys(t.toJSON().Parameters ?? {}).filter((k) => /routerarn/i.test(k))).toEqual([]);
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

  it('may read the assistant\'s active profile, so arrival triage speaks in its configured words', () => {
    // Measured live: `[active-profile] 'premium' active version unresolved; serving seed:
    // AccessDeniedException`, so every notice triage wrote was shipped English.
    const all = statements(synth());
    const ssmRead = all.find((s) => actionsOf(s).includes('ssm:GetParameter')
      && JSON.stringify(s.Resource).includes('/assistant/*/definition'));
    expect(ssmRead).toBeDefined();
    const bodyRead = all.find((s) => actionsOf(s).includes('s3:GetObject')
      && JSON.stringify(s.Resource).includes('/profiles/*'));
    expect(bodyRead).toBeDefined();
    expect(actionsOf(ssmRead)).not.toContain('ssm:PutParameter');
    const fn = Object.values(synth().findResources('AWS::Lambda::Function'))[0] as any;
    expect(fn.Properties.Environment.Variables.PROFILE_BODY_BUCKET).toBe('test-attachments');
  });

  /**
   * NO EMAIL HERE. The notification fan-out is the Notifications stack's own consumer on the stream
   * (`notification-bridge.ts`), which holds the deployment's only SES send grant, so this role can
   * neither send nor resolve a contact (`the-email-bridge-is-in-notifications.test.ts`).
   */
  it('holds no send grant and no contact lookup: email belongs to the Notifications stack', () => {
    const all = statements(synth());
    expect(all.find((s) => actionsOf(s).includes('ses:SendEmail'))).toBeUndefined();
    expect(all.find((s) => actionsOf(s).includes('cognito-idp:AdminGetUser'))).toBeUndefined();
    const fn = Object.values(synth().findResources('AWS::Lambda::Function'))[0] as any;
    expect(fn.Properties.Environment.Variables.SENDER_EMAIL).toBeUndefined();
    expect(fn.Properties.Environment.Variables.APP_URL).toBeUndefined();
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
