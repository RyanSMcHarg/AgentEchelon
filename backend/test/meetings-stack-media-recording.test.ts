/**
 * MeetingsStack: a recorded meeting's audio and video capture (SPEC-ASSISTANT-MEETINGS FR70), synthesized only where
 * `meetingMediaRecording` is "true", with the developer guide's caller grants scoped to media pipelines and meetings of
 * the account and region, and the recording's event function on the two rules its finish is driven by.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MeetingsStack } from '../lib/stacks/meetings-stack';

const ARCHIVE_BUCKET = 'test-conversation-archive-111122223333-us-east-1';
const synth = (context: Record<string, string> = {}) => Template.fromStack(new MeetingsStack(new cdk.App({ context }), 'TestMeetings', {
  env: { account: '111122223333', region: 'us-east-1' },
  appInstanceArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/abc',
  selfPoolId: 'us-east-1_test',
  appUrl: 'https://example.test',
  archive: { bucketName: ARCHIVE_BUCKET, bucketArn: `arn:aws:s3:::${ARCHIVE_BUCKET}`, keyArn: 'arn:aws:kms:us-east-1:111122223333:key/archive' },
  classifications: ['standard', 'premium'],
}));
type Statement = { Sid?: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
const statementsOf = (t: Template): Statement[] => Object.values(t.findResources('AWS::IAM::Policy'))
  .flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement);
const actions = (s: Statement) => ([] as string[]).concat(s.Action);

describe('without meetingMediaRecording', () => {
  const t = synth();
  it('holds no media pipeline grant, no recording function and no rule on media pipelines', () => {
    expect(statementsOf(t).flatMap(actions).filter((a) => /MediaCapture|MediaConcatenation|MediaPipeline/.test(a))).toEqual([]);
    expect(JSON.stringify(t.findResources('AWS::Events::Rule'))).not.toContain('Chime Media Pipeline State Change');
    t.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.handler', Environment: { Variables: Match.objectLike({ MEETING_MEDIA_RECORDING: 'false' }) } });
  });
});

describe('with meetingMediaRecording "true"', () => {
  const t = synth({ meetingMediaRecording: 'true' });
  const capture = statementsOf(t).filter((s) => s.Sid === 'MeetingMediaCapture');

  it('tells the person routes and the run entry to capture', () => {
    t.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.runHandler', Environment: { Variables: Match.objectLike({ MEETING_MEDIA_RECORDING: 'true' }) } });
    t.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.handler', Environment: { Variables: Match.objectLike({ MEETING_MEDIA_RECORDING: 'true', ATTACHMENTS_BUCKET: Match.anyValue() }) } });
  });

  it('grants the media pipeline actions on media pipelines and meetings of this account and region only', () => {
    // The person routes, each classification's run entry (two here) and the recording's event function.
    expect(capture).toHaveLength(4);
    for (const s of capture) {
      expect(actions(s).sort()).toEqual(['chime:DeleteMediaCapturePipeline', 'chime:GetMediaCapturePipeline', 'chime:GetMediaPipeline']);
      const resources = JSON.stringify(s.Resource);
      expect(resources).toContain(':111122223333:media-pipeline/*');
      expect(resources).toContain(':111122223333:meeting/*');
      expect(resources).not.toContain('"*"');
    }
    // A pipeline is created on '*', the only resource IAM authorizes the creates on, in a statement of the two creates alone.
    const creates = statementsOf(t).filter((s) => s.Sid === 'MeetingMediaPipelineCreate');
    expect(creates).toHaveLength(4);
    for (const s of creates) {
      expect(actions(s).sort()).toEqual(['chime:CreateMediaCapturePipeline', 'chime:CreateMediaConcatenationPipeline']);
      expect(s.Resource).toBe('*');
    }
  });

  it('lets the recording\'s event function delete capture chunks only, and list the recording family only', () => {
    const deletes = statementsOf(t).filter((s) => actions(s).some((a) => a.startsWith('s3:Delete')));
    expect(deletes.map((s) => s.Sid)).toEqual(['CaptureChunkCleanup']);
    expect(JSON.stringify(deletes[0].Resource)).toMatch(/\/recordings\/\*\/capture\/\*"/);
    const listing = statementsOf(t).find((s) => s.Sid === 'RecordingListing');
    expect(JSON.stringify(listing?.Condition)).toBe('{"StringLike":{"s3:prefix":["recordings/*"]}}');
  });

  it('publishes a finish under the meetings\' lifecycle source only', () => {
    const puts = statementsOf(t).filter((s) => s.Sid === 'HandARecordingToItsRouter');
    expect(puts.length).toBeGreaterThan(0);
    for (const s of puts) expect(JSON.stringify(s.Condition)).toContain('agentechelon.meetings');
  });

  it('drives the finish from the media pipeline events and the recording\'s written file, never a schedule', () => {
    t.hasResourceProperties('AWS::Events::Rule', { EventPattern: { source: ['aws.chime'], 'detail-type': ['Chime Media Pipeline State Change'] } });
    t.hasResourceProperties('AWS::Events::Rule', { EventPattern: Match.objectLike({
      source: ['aws.s3'], 'detail-type': ['Object Created'],
      detail: Match.objectLike({ object: { key: [{ wildcard: 'recordings/*/media/composited-video/*.mp4' }] } }),
    }) });
    expect(JSON.stringify(t.findResources('AWS::Events::Rule'))).not.toContain('ScheduleExpression');
    t.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.handler', DeadLetterConfig: Match.anyValue(), Environment: { Variables: Match.objectLike({ MEETING_LIFECYCLE_INSTANCE: Match.anyValue() }) } });
  });
});
