/**
 * MeetingsStack: the meeting routes on the person API, the run entry by its fixed name, and where an unfiled meeting
 * event lands.
 *
 * EventBridge invokes the consumer asynchronously, so the rule target's dead-letter queue catches an event that could not
 * be delivered, and the function's own queue catches one the handler threw on. A roster missing an arrival is wrong in a
 * way nothing downstream can detect, so both are pinned.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MeetingsStack } from '../lib/stacks/meetings-stack';
import { ANALYTICS_DB_NAME, CAPABILITY_RESOURCES } from '../lib/stacks/agent-classification-common';
import { typedCreatorName } from '../lib/constructs/conversation-creator';
import { MEETING_RUN_TIMEOUT_SECONDS } from '../lambda/src/lib/meeting-run';
import { CLIENT_FAILURES_PER_HOUR, MEETINGS_METRIC_NAMESPACE, MEETING_EVENTS_STREAM } from '../lib/stacks/meetings-stack';

const ARCHIVE_BUCKET = 'test-conversation-archive-111122223333-us-east-1';
const ARCHIVE_KEY = 'arn:aws:kms:us-east-1:111122223333:key/archive';
const CLASSIFICATIONS = ['standard', 'premium'];

const stack = (() => {
  const app = new cdk.App();
  return new MeetingsStack(app, 'TestMeetings', {
    env: { account: '111122223333', region: 'us-east-1' },
    appInstanceArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/abc',
    selfPoolId: 'us-east-1_test',
    appUrl: 'https://example.test',
    archive: { bucketName: ARCHIVE_BUCKET, bucketArn: `arn:aws:s3:::${ARCHIVE_BUCKET}`, keyArn: ARCHIVE_KEY },
    classifications: CLASSIFICATIONS,
  });
})();
const template = Template.fromStack(stack);

const dlqRef = () => {
  const ids = Object.keys(template.findResources('AWS::SQS::Queue')).filter((id) => id.startsWith('MeetingEventsDlq'));
  expect(ids).toHaveLength(1);
  return ids[0];
};

describe('the meeting routes and the run entry', () => {
  it('puts the meeting routes on the person API, under the meetings capability', () => {
    expect(stack.routes.map((r) => `${r.api} ${r.method} ${r.path} ${r.capability}`)).toEqual([
      'person POST /meetings meetings',
      'person POST /meetings/join meetings',
      'person POST /meetings/end meetings',
      'person POST /meetings/status meetings',
      'person POST /meetings/mine meetings',
      'person POST /meetings/transcription meetings',
      'person POST /meetings/transcript meetings',
      'person POST /meetings/speaking meetings',
      'person POST /meetings/remove meetings',
      'person POST /meetings/unmute-request meetings',
      'person POST /meetings/events meetings',
    ]);
  });

  it.each(CLASSIFICATIONS)('names %s\'s run and summary entries by the fixed names its router invokes, each told its classification', (c) => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: CAPABILITY_RESOURCES.meetingRun(c), Handler: 'index.runHandler',
      Environment: { Variables: Match.objectLike({ MEETING_RUN_CLASSIFICATION: c }) },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: CAPABILITY_RESOURCES.meetingSummary(c), Handler: 'index.handler',
      Environment: { Variables: Match.objectLike({ MEETING_SUMMARY_CLASSIFICATION: c }) },
    });
  });

  it('deploys one run entry and one summary entry per classification, and none serving every classification', () => {
    const fns = Object.values(template.findResources('AWS::Lambda::Function')) as Array<{ Properties: { FunctionName?: string; Handler?: string; Environment?: { Variables?: Record<string, unknown> } } }>;
    const runs = fns.filter((f) => f.Properties.Handler === 'index.runHandler');
    expect(runs.map((f) => f.Properties.FunctionName).sort()).toEqual(CLASSIFICATIONS.map((c) => CAPABILITY_RESOURCES.meetingRun(c)).sort());
    for (const f of runs) expect(f.Properties.Environment?.Variables?.MEETING_RUN_CLASSIFICATION).toBeTruthy();
    const summaries = fns.filter((f) => String(f.Properties.FunctionName ?? '').includes('Meetings-MeetingSummary'));
    expect(summaries.map((f) => f.Properties.FunctionName).sort()).toEqual(CLASSIFICATIONS.map((c) => CAPABILITY_RESOURCES.meetingSummary(c)).sort());
  });

  it("finds and may invoke the creator by the name the creator is given, in the stack's partition", () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.runHandler',
      Timeout: MEETING_RUN_TIMEOUT_SECONDS,
      Environment: { Variables: Match.objectLike({ TYPED_CREATOR_NAME_PATTERN: typedCreatorName('{classification}') }) },
    });
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: Array<{ Sid?: string; Resource: unknown }> } } }).Properties.PolicyDocument.Statement)
      .filter((s) => s.Sid === 'OpenMeetingConversations');
    // The person routes' function and each classification's run entry.
    expect(statements).toHaveLength(1 + CLASSIFICATIONS.length);
    for (const s of statements) {
      expect(s.Resource).toEqual({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:lambda:us-east-1:111122223333:function:${typedCreatorName('*')}`]] });
    }
  });

  it('gives the run entry no membership read: it acts for the conversation\'s own router', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const runPolicies = Object.entries(policies).filter(([id]) => id.startsWith('MeetingRunFunction'));
    expect(runPolicies).toHaveLength(CLASSIFICATIONS.length);
    for (const [, p] of runPolicies) expect(JSON.stringify(p)).not.toContain('DescribeChannelMembership');
  });
});

describe('a meeting event that could not be filed lands on the dead-letter queue', () => {
  it('the consumer function names the queue, so an event the handler threw on is kept', () => {
    const dlq = dlqRef();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      DeadLetterConfig: { TargetArn: { 'Fn::GetAtt': [dlq, 'Arn'] } },
    });
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', { MaximumRetryAttempts: 2 });
  });

  it('the rule target names the same queue, for an event that could not be delivered at all', () => {
    const dlq = dlqRef();
    template.hasResourceProperties('AWS::Events::Rule', {
      Targets: Match.arrayWith([Match.objectLike({ DeadLetterConfig: { Arn: { 'Fn::GetAtt': [dlq, 'Arn'] } } })]),
    });
  });
});

describe('meeting events are a family of the conversation archive, the system of record', () => {
  it('delivers directly into the archive bucket under meeting_events/, partitioned by date and not by content', () => {
    template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
      DeliveryStreamName: MEETING_EVENTS_STREAM,
      DeliveryStreamType: 'DirectPut',
      ExtendedS3DestinationConfiguration: Match.objectLike({
        BucketARN: `arn:aws:s3:::${ARCHIVE_BUCKET}`,
        Prefix: 'meeting_events/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
        ErrorOutputPrefix: Match.stringLikeRegexp('^errors/meeting_events/'),
        DynamicPartitioningConfiguration: Match.absent(),
      }),
    });
  });

  it('lets the stream write its own family and the expiring errors family, and nothing else in the archive', () => {
    const policies = Object.entries(template.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith('MeetingEventsDeliveryRole'));
    expect(policies).toHaveLength(1);
    const statements = (policies[0][1] as { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> } } }).Properties.PolicyDocument.Statement;
    const put = statements.find((st) => [st.Action].flat().includes('s3:PutObject'));
    expect(put?.Resource).toEqual([`arn:aws:s3:::${ARCHIVE_BUCKET}/meeting_events/*`, `arn:aws:s3:::${ARCHIVE_BUCKET}/errors/meeting_events/*`]);
    expect(JSON.stringify(statements)).toContain(ARCHIVE_KEY);
  });

  it('is read by Athena through the meeting_events table, with classification as a column', () => {
    template.hasResourceProperties('AWS::Glue::Table', {
      DatabaseName: ANALYTICS_DB_NAME,
      TableInput: Match.objectLike({
        Name: 'meeting_events',
        Parameters: Match.objectLike({ 'projection.enabled': 'true' }),
        StorageDescriptor: Match.objectLike({ Columns: Match.arrayWith([{ Name: 'classification', Type: 'string' }, { Name: 'source', Type: 'string' }]) }),
      }),
    });
  });

  it('lets the consumer put to that stream only', () => {
    const consumer = Object.entries(template.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith('MeetingEventsFunction'));
    const doc = JSON.stringify(consumer![1]);
    expect(doc).toContain('MeetingEventsArchive');
    expect(doc).not.toContain('-client-events');
  });
});

describe('every meeting state change reaches the consumer', () => {
  it('matches on the service and the detail type only, never narrowing by event type', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: { source: ['aws.chime'], 'detail-type': ['Chime Meeting State Change'] },
    });
    const rules = Object.values(template.findResources('AWS::Events::Rule'));
    expect(JSON.stringify(rules)).not.toContain('eventType');
  });
});

describe('what an operator watches', () => {
  it('raises one alarm on client failures in an hour, read with no dimension, through the shared notifier', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: MEETINGS_METRIC_NAMESPACE, MetricName: 'ClientFailure', Threshold: CLIENT_FAILURES_PER_HOUR, Period: 3600,
      TreatMissingData: 'notBreaching', Dimensions: Match.absent(),
    });
  });

  it('charts no meeting figure: every one is the console\'s, from the recorded events (tenet D7), and the alarm points there', () => {
    expect(template.findResources('AWS::CloudWatch::Dashboard')).toEqual({});
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmDescription: Match.stringLikeRegexp('Meetings tab in the console') });
  });

  it('gives the meeting API the namespace it emits under', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ MEETINGS_METRIC_NAMESPACE }) } });
  });
});

describe('a meeting\'s transcription and its transcript (FR28)', () => {
  type Stmt = { Sid?: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
  const policiesOf = () => Object.values(template.findResources('AWS::IAM::Policy'))
    .flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: Stmt[] } } }).Properties.PolicyDocument.Statement);
  const actions = (s: Stmt) => ([] as string[]).concat(s.Action);
  const flat = (v: unknown) => JSON.stringify(v);

  it('starts and stops transcription in a statement of those two actions alone, on the only resource IAM authorizes them on', () => {
    // IAM refuses StartMeetingTranscription under a `meeting/*` resource (iam:SimulatePrincipalPolicy against the deployed
    // role, 2026-11-13), so the statement names '*' and holds nothing else.
    const t = policiesOf().filter((s) => actions(s).includes('chime:StartMeetingTranscription'));
    expect(t.length).toBeGreaterThan(0);
    for (const s of t) {
      expect(actions(s).sort()).toEqual(['chime:StartMeetingTranscription', 'chime:StopMeetingTranscription']);
      expect(s.Resource).toBe('*');
    }
  });

  it('writes and reads the conversation store\'s transcript family only, and lists it only under that prefix', () => {
    const s3 = policiesOf().filter((s) => actions(s).some((a) => a.startsWith('s3:')) && flat(s.Resource).includes('transcripts/'));
    expect(s3.length).toBeGreaterThan(0);
    const objectGrants = policiesOf().filter((s) => (s.Sid === 'TranscriptObjects' || s.Sid === 'TranscriptSegmentWrites'));
    for (const s of objectGrants) expect(flat(s.Resource)).toMatch(/\/transcripts\/\*/);
    // The person routes only file segments; they never read a transcript back.
    expect(policiesOf().find((s) => s.Sid === 'TranscriptSegmentWrites')).toEqual(expect.objectContaining({ Action: 's3:PutObject' }));
    for (const s of policiesOf().filter((x) => x.Sid === 'TranscriptListing')) expect(flat(s.Condition)).toBe('{"StringLike":{"s3:prefix":["transcripts/*"]}}');
  });

  it('transcribes from the start only where the deployment says so', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler', Environment: { Variables: Match.objectLike({ MEETING_TRANSCRIPTION: 'false' }) },
    });
    const app = new cdk.App({ context: { meetingTranscription: 'true' } });
    const on = Template.fromStack(new MeetingsStack(app, 'TestMeetingsTranscribed', {
      env: { account: '111122223333', region: 'us-east-1' }, appInstanceArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/abc',
      selfPoolId: 'us-east-1_test', appUrl: 'https://example.test',
      archive: { bucketName: ARCHIVE_BUCKET, bucketArn: `arn:aws:s3:::${ARCHIVE_BUCKET}`, keyArn: ARCHIVE_KEY },
    classifications: CLASSIFICATIONS,
    }));
    on.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.handler', Environment: { Variables: Match.objectLike({ MEETING_TRANSCRIPTION: 'true' }) } });
  });
});

describe('a meeting\'s recording mode (the two transcription modes)', () => {
  it('records from the start unless meetingRecording is false, and the person routes publish a change of mode to the lifecycle source only', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler', Environment: { Variables: Match.objectLike({ MEETING_RECORDING: 'true', MEETING_LIFECYCLE_INSTANCE: Match.anyValue() }) },
    });
    const puts = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: Array<{ Sid?: string; Condition?: unknown }> } } }).Properties.PolicyDocument.Statement)
      .filter((s) => s.Sid === 'HandAModeChangeToItsRouter');
    expect(puts).toHaveLength(1);
    expect(JSON.stringify(puts[0].Condition)).toContain('events:source');
  });
});
