/**
 * A MEETING'S AUDIO AND VIDEO RECORDING (SPEC-ASSISTANT-MEETINGS FR70).
 *
 *  - recording mode starts an Amazon Chime SDK media capture into the meeting conversation's recording family, with the
 *    guide's composited settings; captions-only mode does not, and a deployment without `meetingMediaRecording` never does;
 *  - recording off (and a meeting's end) deletes the capture and starts a concatenation into the part's `media` prefix;
 *  - a capture the service stopped on its own is concatenated from its event, once;
 *  - the recording's written file makes its part ready, deletes its capture chunks (and nothing else), files it and tells
 *    the router, and the ended card then carries its link;
 *  - a concatenation that failed marks its part failed, files it and tells the router, and the card says so;
 *  - an event for a pipeline or a key the record does not hold changes nothing;
 *  - the conversation store lets the media pipelines service write the recording family only.
 */
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Template } from 'aws-cdk-lib/assertions';

const mockFact = jest.fn();
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  ...jest.requireActual('../../lambda/src/lib/channel-context-client'),
  recordMeetingFact: (...a: unknown[]) => mockFact(...a),
}));
const mockFile = jest.fn();
jest.mock('../../lambda/src/lib/meeting-event-archive', () => ({ fileMeetingEvents: (...a: unknown[]) => mockFile(...a) }));
jest.mock('../../lambda/src/lib/event-archive', () => ({ ensureDataPlaneArn: async () => undefined }));

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
process.env.APP_INSTANCE_ARN = APP;
process.env.ATTACHMENTS_BUCKET = 'conversation-store';
process.env.CHANNEL_CONTEXT_TABLE = 'channel-context';
process.env.MEETING_LIFECYCLE_INSTANCE = 'test';

import { __setTranscriptionBus, setTranscription } from '../../lambda/src/lib/meeting-transcription';
import { __setCaptureClients, __setCapturePause, concatenatePart, stopMediaCapture, syncMediaCapture } from '../../lambda/src/lib/meeting-media-capture';
import { __setRecordingEventClients, handler as recordingEvent } from '../../lambda/src/meeting-recording-events';
import { parseRecordingKey, recordingCardValues, recordingLink } from '../../lambda/src/lib/meeting-recording';
import { readLifecycleHandoff } from '../../lambda/src/lib/meeting-lifecycle';
import { renderMessageTemplate } from '../../lambda/src/lib/message-template';
import { shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';
import { meetingRecordingsSinkStatements } from '../../lib/constructs/meeting-recordings';
import type { EventBridgeEvent } from 'aws-lambda';

const MEETING_ARN = `${APP}/channel/c1`;
const MEETING = { meetingArn: MEETING_ARN, meetingId: 'm-1', classification: 'premium' };
const SOURCE_ARN = 'arn:aws:chime:us-east-1:111122223333:meeting/m-1';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };
const calls: Cmd[] = [];
const named = (name: string) => calls.filter((c) => c.constructor.name === name);

/** The meeting conversation's record, as DynamoDB holds it, and a reader of the three update shapes the capture writes. */
let item: { channelArn: string; lastMeeting: Record<string, unknown> };
const recordings = () => (item.lastMeeting.recordings ?? {}) as Record<string, Record<string, unknown>>;
function conditionFailed(): never { throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' }); }
const ddb = {
  send: async (cmd: Cmd) => {
    calls.push(cmd);
    const i = cmd.input as { Key: { channelArn: string }; UpdateExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> };
    if (cmd.constructor.name === 'GetCommand') return { Item: i.Key.channelArn === item.channelArn ? structuredClone(item) : undefined };
    const v = i.ExpressionAttributeValues ?? {};
    const n = i.ExpressionAttributeNames ?? {};
    if (i.Key.channelArn !== item.channelArn || item.lastMeeting.meetingId !== v[':meetingId']) conditionFailed();
    const expr = i.UpdateExpression ?? '';
    if (expr.includes('if_not_exists')) { item.lastMeeting.recordings ??= {}; return {}; }
    if (expr === 'SET #last.#recs.#part = :part') { recordings()[n['#part']] = structuredClone(v[':part']) as Record<string, unknown>; return {}; }
    const part = recordings()[n['#part']];
    const from = Object.entries(v).filter(([k]) => k.startsWith(':from')).map(([, s]) => s);
    if (!part || !from.includes(part.state)) conditionFailed();
    part.state = v[':to'];
    for (const [k, name] of Object.entries(n)) if (k.startsWith('#f_')) part[name] = v[`:f_${name}`];
    return {};
  },
};
let pipelineSeq = 0;
const pipelines = {
  send: async (cmd: Cmd) => {
    calls.push(cmd);
    if (cmd.constructor.name === 'CreateMediaCapturePipelineCommand') {
      pipelineSeq += 1;
      return { MediaCapturePipeline: { MediaPipelineId: `cap-${pipelineSeq}`, MediaPipelineArn: `arn:aws:chime:us-east-1:111122223333:media-pipeline/cap-${pipelineSeq}` } };
    }
    if (cmd.constructor.name === 'CreateMediaConcatenationPipelineCommand') {
      if (concatenationRefused) throw Object.assign(new Error('refused'), { name: 'BadRequestException' });
      return { MediaConcatenationPipeline: { MediaPipelineId: 'cat-1' } };
    }
    return {};
  },
};
let concatenationRefused = false;
const meetings = { send: async (cmd: Cmd) => { calls.push(cmd); return cmd.constructor.name === 'GetMeetingCommand' ? { Meeting: { MeetingId: 'm-1', MeetingArn: SOURCE_ARN } } : {}; } };
let objects: string[] = [];
const store = {
  send: async (cmd: Cmd) => {
    calls.push(cmd);
    if (cmd.constructor.name === 'ListObjectsV2Command') return { Contents: objects.filter((k) => k.startsWith(String(cmd.input.Prefix))).map((Key) => ({ Key })) };
    if (cmd.constructor.name === 'DeleteObjectsCommand') {
      const gone = new Set((cmd.input.Delete as { Objects: Array<{ Key: string }> }).Objects.map((o) => o.Key));
      objects = objects.filter((k) => !gone.has(k));
    }
    return {};
  },
};
const bus = { send: async (cmd: Cmd) => { calls.push(cmd); return { FailedEntryCount: 0 }; } };
/** The recording finishes told to the router (a change of mode is published too, by the transcription's own seam). */
const published = () => named('PutEventsCommand').map((c) => JSON.parse((c.input.Entries as Array<{ Detail: string }>)[0].Detail).event as string)
  .filter((e) => e === 'recording-ready' || e === 'recording-failed');
const filed = () => mockFile.mock.calls.flatMap((c) => c[0] as Array<{ event_type: string; source: string }>);
const chimeMeetings = { send: async () => ({}) };

beforeEach(() => {
  calls.length = 0;
  pipelineSeq = 0;
  concatenationRefused = false;
  objects = [];
  item = { channelArn: MEETING_ARN, lastMeeting: { meetingId: 'm-1', createdAt: '2026-11-12T10:00:00.000Z', createdBy: 'host-1' } };
  process.env.MEETING_MEDIA_RECORDING = 'true';
  mockFact.mockReset().mockResolvedValue(true);
  mockFile.mockReset().mockResolvedValue({ archived: 1, projected: null, duplicates: 0 });
  __setCaptureClients({ ddb, pipelines, meetings, s3: store, bus });
  __setRecordingEventClients({ pipelines, s3: store });
  __setTranscriptionBus(bus as never);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const captions = { lastMeeting: { meetingId: 'm-1', createdAt: '2026-11-12T10:00:00.000Z', createdBy: 'host-1', transcription: { on: true, recording: false, changedAt: 'x', changedBy: 'platform' } } };
const recordingOn = { lastMeeting: { meetingId: 'm-1', createdAt: '2026-11-12T10:00:00.000Z', createdBy: 'host-1', transcription: { on: true, recording: true, changedAt: 'x', changedBy: 'platform' } } };
const onlyPart = () => Object.entries(recordings())[0] as [string, Record<string, unknown>];

describe('recording mode is the one switch for the audio and video capture', () => {
  it('recording on starts a capture of the meeting into its conversation\'s recording family, composited by the guide\'s settings', async () => {
    await setTranscription(chimeMeetings, MEETING, { recording: true }, 'host-1', captions);
    const created = named('CreateMediaCapturePipelineCommand');
    expect(created).toHaveLength(1);
    const [partId, part] = onlyPart();
    expect(created[0].input).toEqual(expect.objectContaining({
      SourceType: 'ChimeSdkMeeting', SourceArn: SOURCE_ARN, SinkType: 'S3Bucket',
      SinkArn: `arn:aws:s3:::conversation-store/recordings/premium/c1/m-1/${partId}/capture`,
      ChimeSdkMeetingConfiguration: { ArtifactsConfiguration: expect.objectContaining({
        Audio: { MuxType: 'AudioWithCompositedVideo' },
        CompositedVideo: expect.objectContaining({ Layout: 'GridView', GridViewConfiguration: expect.objectContaining({ ContentShareLayout: 'ActiveSpeakerOnly' }) }),
      }) },
    }));
    expect(part).toEqual(expect.objectContaining({ capture: 'cap-1', classification: 'premium', state: 'capturing' }));
    expect(filed().map((e) => e.event_type)).toEqual(['recordingStarted']);
  });

  it('captions-only mode captures nothing', async () => {
    await setTranscription(chimeMeetings, MEETING, { on: true }, 'platform', null);
    expect(named('CreateMediaCapturePipelineCommand')).toHaveLength(0);
    expect(item.lastMeeting.recordings).toBeUndefined();
  });

  it('a deployment without meetingMediaRecording captures nothing, even in recording mode', async () => {
    delete process.env.MEETING_MEDIA_RECORDING;
    await setTranscription(chimeMeetings, MEETING, { recording: true }, 'host-1', captions);
    expect(named('CreateMediaCapturePipelineCommand')).toHaveLength(0);
  });

  it('recording off deletes the capture, then joins it into one composited file under the part\'s media prefix', async () => {
    await setTranscription(chimeMeetings, MEETING, { recording: true }, 'host-1', captions);
    calls.length = 0;
    await setTranscription(chimeMeetings, MEETING, { recording: false }, 'host-1', recordingOn);
    const order = calls.map((c) => c.constructor.name).filter((n) => n.includes('Media'));
    expect(order).toEqual(['DeleteMediaCapturePipelineCommand', 'CreateMediaConcatenationPipelineCommand']);
    const [partId, part] = onlyPart();
    expect(named('DeleteMediaCapturePipelineCommand')[0].input).toEqual({ MediaPipelineId: 'cap-1' });
    const concat = named('CreateMediaConcatenationPipelineCommand')[0].input as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(concat.Sources[0].MediaCapturePipelineSourceConfiguration.MediaPipelineArn).toBe('arn:aws:chime:us-east-1:111122223333:media-pipeline/cap-1');
    expect(concat.Sources[0].MediaCapturePipelineSourceConfiguration.ChimeSdkMeetingConfiguration.ArtifactsConfiguration.CompositedVideo).toEqual({ State: 'Enabled' });
    expect(concat.Sinks[0].S3BucketSinkConfiguration.Destination).toBe(`arn:aws:s3:::conversation-store/recordings/premium/c1/m-1/${partId}/media`);
    expect(part).toEqual(expect.objectContaining({ state: 'processing', concatenation: 'cat-1' }));
  });

  it('the meeting\'s end stops the capture and starts its concatenation, once however often it is asked', async () => {
    await setTranscription(chimeMeetings, MEETING, { recording: true }, 'host-1', captions);
    expect(await stopMediaCapture(MEETING)).toEqual({ stopped: 1, stillCapturing: 0 });
    expect(await stopMediaCapture(MEETING)).toEqual({ stopped: 0, stillCapturing: 0 });
    expect(named('CreateMediaConcatenationPipelineCommand')).toHaveLength(1);
  });

  it('a capture that could not be deleted is still recording: its part stays capturing, is not joined, and the stop says so', async () => {
    await setTranscription(chimeMeetings, MEETING, { recording: true }, 'host-1', captions);
    __setCapturePause(async () => undefined);
    const failing = { send: async (cmd: Cmd) => {
      calls.push(cmd);
      if (cmd.constructor.name === 'DeleteMediaCapturePipelineCommand') throw Object.assign(new Error('down'), { name: 'ServiceUnavailableException', $metadata: { httpStatusCode: 503 } });
      return pipelines.send(cmd);
    } };
    __setCaptureClients({ pipelines: failing });
    expect(await stopMediaCapture(MEETING)).toEqual({ stopped: 0, stillCapturing: 1 });
    expect(named('DeleteMediaCapturePipelineCommand')).toHaveLength(3);
    expect(named('CreateMediaConcatenationPipelineCommand')).toHaveLength(0);
    expect(onlyPart()[1]).toEqual(expect.objectContaining({ state: 'capturing' }));
    expect(await syncMediaCapture(MEETING, { recording: true }, { recording: false })).toBe('still-capturing');
    __setCaptureClients({ pipelines });
  });

  it('a concatenation the service could not take for a passing reason is tried again, and then left to be joined again', async () => {
    await setTranscription(chimeMeetings, MEETING, { recording: true }, 'host-1', captions);
    __setCapturePause(async () => undefined);
    let fails = 5;
    const busy = { send: async (cmd: Cmd) => {
      if (cmd.constructor.name === 'CreateMediaConcatenationPipelineCommand' && fails-- > 0) {
        calls.push(cmd);
        throw Object.assign(new Error('slow down'), { name: 'ThrottledClientException', $metadata: { httpStatusCode: 429 } });
      }
      return pipelines.send(cmd);
    } };
    __setCaptureClients({ pipelines: busy });
    const [partId, part] = onlyPart();
    await expect(concatenatePart(MEETING, { partId, ...part } as never)).rejects.toThrow('slow down');
    // Left processing with no concatenation, which no capture start reads as capturing.
    expect(onlyPart()[1]).toEqual(expect.objectContaining({ state: 'processing' }));
    expect(onlyPart()[1].concatenation).toBeUndefined();
    expect(published()).toEqual([]);
    // The retry joins it.
    expect(await concatenatePart(MEETING, { partId, ...onlyPart()[1] } as never)).toBe('started');
    expect(onlyPart()[1]).toEqual(expect.objectContaining({ state: 'processing', concatenation: 'cat-1' }));
    __setCaptureClients({ pipelines });
  });

  it("a part a stop left processing with no concatenation is joined from the capture's own end event, the event the stop's window would have dropped", async () => {
    await setTranscription(chimeMeetings, MEETING, { recording: true }, 'host-1', captions);
    __setCapturePause(async () => undefined);
    let fails = 3;
    const busy = { send: async (cmd: Cmd) => {
      if (cmd.constructor.name === 'CreateMediaConcatenationPipelineCommand' && fails-- > 0) {
        calls.push(cmd);
        throw Object.assign(new Error('slow down'), { name: 'ThrottledClientException', $metadata: { httpStatusCode: 429 } });
      }
      return pipelines.send(cmd);
    } };
    __setCaptureClients({ pipelines: busy });
    // The meeting's end stops the capture; every create attempt fails for a passing reason, and the stop never throws.
    expect(await stopMediaCapture(MEETING)).toEqual({ stopped: 0, stillCapturing: 0 });
    expect(onlyPart()[1]).toEqual(expect.objectContaining({ state: 'processing' }));
    // The capture's deletion event joins it.
    expect(await recordingEvent(pipelineEvent('chime:MediaPipelineDeleted', 'cap-1'))).toEqual({ outcome: 'capture started' });
    expect(onlyPart()[1]).toEqual(expect.objectContaining({ state: 'processing', concatenation: 'cat-1' }));
    __setCaptureClients({ pipelines });
  });
});

const pipelineEvent = (eventType: string, mediaPipelineId: string) => ({
  source: 'aws.chime', 'detail-type': 'Chime Media Pipeline State Change',
  detail: { eventType, mediaPipelineId, meetingId: 'm-1', externalMeetingId: 'c1' },
}) as unknown as EventBridgeEvent<string, never>;
const objectCreated = (key: string, bucket = 'conversation-store') => ({
  source: 'aws.s3', 'detail-type': 'Object Created', detail: { bucket: { name: bucket }, object: { key } },
}) as unknown as EventBridgeEvent<string, never>;

describe('the services\' own events finish each part', () => {
  it('a capture the service stopped on its own (the meeting ended) is concatenated from its event, once', async () => {
    await setTranscription(chimeMeetings, MEETING, { recording: true }, 'host-1', captions);
    expect(await recordingEvent(pipelineEvent('chime:MediaPipelineDeleted', 'cap-1'))).toEqual({ outcome: 'capture started' });
    expect(await recordingEvent(pipelineEvent('chime:MediaPipelineDeleted', 'cap-1'))).toEqual({ outcome: 'already concatenating' });
    expect(named('CreateMediaConcatenationPipelineCommand')).toHaveLength(1);
  });

  it('the written recording makes its part ready, deletes its capture chunks and nothing else, files it and tells the router', async () => {
    await setTranscription(chimeMeetings, MEETING, { recording: true }, 'host-1', captions);
    await stopMediaCapture(MEETING);
    const [partId] = onlyPart();
    const prefix = `recordings/premium/c1/m-1/${partId}`;
    const key = `${prefix}/media/composited-video/cat-1.mp4`;
    objects = [`${prefix}/capture/audio/1.mp4`, `${prefix}/capture/composited-video/1.mp4`, `${prefix}/capture/composited-video/2.mp4`, key, 'transcripts/premium/c1/m-1.md'];
    expect(await recordingEvent(objectCreated(key))).toEqual({ outcome: 'ready' });
    expect(onlyPart()[1]).toEqual(expect.objectContaining({ state: 'ready', key }));
    expect(objects).toEqual([key, 'transcripts/premium/c1/m-1.md']);
    expect(filed().map((e) => e.event_type)).toContain('recordingReady');
    expect(published()).toContain('recording-ready');
    // The finished concatenation's own event, arriving after, changes nothing.
    expect(await recordingEvent(pipelineEvent('chime:MediaPipelineDeleted', 'cat-1'))).toEqual({ outcome: 'already finished' });
  });

  it('a finished concatenation whose file is there makes the part ready from the pipeline event too', async () => {
    await setTranscription(chimeMeetings, MEETING, { recording: true }, 'host-1', captions);
    await stopMediaCapture(MEETING);
    const [partId] = onlyPart();
    objects = [`recordings/premium/c1/m-1/${partId}/media/composited-video/cat-1.mp4`];
    expect(await recordingEvent(pipelineEvent('chime:MediaPipelineDeleted', 'cat-1'))).toEqual({ outcome: 'ready' });
  });

  it('a concatenation that failed marks its part failed, files it and tells the router', async () => {
    await setTranscription(chimeMeetings, MEETING, { recording: true }, 'host-1', captions);
    await stopMediaCapture(MEETING);
    expect(await recordingEvent(pipelineEvent('chime:MediaPipelinePermanentFailure', 'cat-1'))).toEqual({ outcome: 'failed' });
    expect(onlyPart()[1]).toEqual(expect.objectContaining({ state: 'failed', failure: 'concatenation' }));
    expect(filed().map((e) => e.event_type)).toContain('recordingFailed');
    expect(filed().every((e) => e.source === 'platform')).toBe(true);
    expect(published()).toEqual(['recording-failed']);
  });

  it('a concatenation the service refuses marks the part failed at once', async () => {
    await setTranscription(chimeMeetings, MEETING, { recording: true }, 'host-1', captions);
    concatenationRefused = true;
    await stopMediaCapture(MEETING);
    expect(onlyPart()[1]).toEqual(expect.objectContaining({ state: 'failed', failure: 'concatenation' }));
    expect(published()).toEqual(['recording-failed']);
  });

  it('an event for a pipeline or a key the record does not hold, or another bucket, changes nothing', async () => {
    await setTranscription(chimeMeetings, MEETING, { recording: true }, 'host-1', captions);
    const before = structuredClone(item);
    expect((await recordingEvent(pipelineEvent('chime:MediaPipelineDeleted', 'someone-elses'))).outcome).toBe('not a recording of this deployment');
    expect((await recordingEvent(objectCreated('recordings/premium/c1/m-1/other-part/media/composited-video/x.mp4'))).outcome).toBe('not a recording of this deployment');
    const [partId] = onlyPart();
    expect((await recordingEvent(objectCreated(`recordings/premium/c1/m-1/${partId}/media/composited-video/x.mp4`, 'another-bucket'))).outcome).toBe('not the conversation store');
    expect(item).toEqual(before);
  });
});

describe('the ended card carries the recording', () => {
  const say = async (name: string) => {
    const r = renderMessageTemplate(shippedMessageTemplate(name), {}, { sections: ['chat'] });
    return r.ok ? r.sections.chat ?? '' : '';
  };
  const card = (values: Record<string, string>) => {
    const r = renderMessageTemplate(shippedMessageTemplate('meeting-ended'), { duration_minutes: '12', ended_how: 'Everyone left.', ...values }, { sections: ['chat'] });
    return r.ok ? r.sections.chat ?? '' : '';
  };
  const KEY = 'recordings/premium/c1/m-1/p-1/media/composited-video/cat-1.mp4';
  const part = (state: string, extra: Record<string, unknown> = {}) => ({ capture: 'cap-1', captureArn: 'arn', classification: 'premium', startedAt: '2026-11-12T10:00:00.000Z', state, ...extra });

  it('says the recording is processing while it is joined', async () => {
    const text = card({ ...await recordingCardValues({ 'p-1': part('processing') }, say) });
    expect(text).toContain('The recording is processing');
    expect(text).not.toContain('[Recording]');
  });

  it('links the recording once it is ready, by the link the chat app opens', async () => {
    const values = await recordingCardValues({ 'p-1': part('ready', { key: KEY }) }, say);
    expect(values).toEqual({ recording_link: recordingLink(KEY) });
    expect(card(values as Record<string, string>)).toContain(`- [Recording](?recording=${encodeURIComponent(KEY)})`);
    expect(parseRecordingKey(KEY)).toEqual(expect.objectContaining({ conversationId: 'c1', meetingId: 'm-1', partId: 'p-1', classification: 'premium' }));
  });

  it('numbers each part where recording was turned off and on again, and says one failed', async () => {
    const values = await recordingCardValues({
      'p-1': part('ready', { key: KEY }),
      'p-2': part('ready', { key: KEY.replace('p-1', 'p-2'), startedAt: '2026-11-12T10:10:00.000Z' }),
      'p-3': part('failed', { startedAt: '2026-11-12T10:20:00.000Z' }),
    }, say);
    const text = card(values as Record<string, string>);
    expect(text).toContain('- Recording: [1](?recording=');
    expect(text).toContain(' · [2](?recording=');
    expect(text).toContain('The recording could not be made.');
  });

  it('carries no recording item for a meeting that was not recorded', async () => {
    expect(await recordingCardValues(undefined, say)).toEqual({});
    expect(card({})).not.toMatch(/Recording|recording/);
  });

  it('a recording\'s finish is a lifecycle event the router reads', () => {
    for (const event of ['recording-ready', 'recording-failed']) {
      expect(readLifecycleHandoff({ channelArn: MEETING_ARN, meetingId: 'm-1', event })).toEqual(expect.objectContaining({ event }));
    }
  });

  it('the recording notice says only that the meeting is being recorded', () => {
    const r = renderMessageTemplate(shippedMessageTemplate('meeting-recording-started-media'), {}, { sections: ['chat'] });
    expect(r.ok && r.sections.chat).toBe('This meeting is being recorded.');
  });
});

describe('the conversation store lets the media pipelines service write the recording family only', () => {
  const stack = new cdk.Stack(new cdk.App(), 'Store', { env: { account: '111122223333', region: 'us-east-1' } });
  const bucket = new s3.Bucket(stack, 'Bucket');
  for (const st of meetingRecordingsSinkStatements(bucket, '111122223333')) bucket.addToResourcePolicy(st);
  const statements = (Object.values(Template.fromStack(stack).findResources('AWS::S3::BucketPolicy'))[0] as {
    Properties: { PolicyDocument: { Statement: Array<{ Sid?: string; Principal?: unknown; Action: string | string[]; Resource: unknown; Condition?: Record<string, unknown> }> } };
  }).Properties.PolicyDocument.Statement.filter((s) => JSON.stringify(s.Principal).includes('mediapipelines.chime.amazonaws.com'));

  it('names the service principal, this account and its Amazon Chime SDK resources on every statement', () => {
    expect(statements).toHaveLength(2);
    for (const s of statements) {
      expect(s.Condition?.StringEquals).toEqual({ 'aws:SourceAccount': '111122223333' });
      expect(s.Condition?.ArnLike).toEqual({ 'aws:SourceArn': 'arn:aws:chime:*:111122223333:*' });
    }
  });

  it('writes and reads objects under recordings/ alone, and lists only that prefix', () => {
    const write = statements.find((s) => s.Sid === 'MeetingRecordingsFromMediaPipelines')!;
    expect(write.Action).toEqual(['s3:PutObject', 's3:PutObjectAcl', 's3:GetObject']);
    expect(JSON.stringify(write.Resource)).toMatch(/\/recordings\/\*"/);
    expect(JSON.stringify(write.Resource)).not.toMatch(/attachments|transcripts|generated-docs/);
    const list = statements.find((s) => s.Sid === 'MeetingRecordingsListedByMediaPipelines')!;
    expect(list.Action).toBe('s3:ListBucket');
    expect(list.Condition?.StringLike).toEqual({ 's3:prefix': ['recordings/*'] });
  });
});

describe('the router rewrites the ended card on a recording\'s finish, from the event and never on a timer', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const router: string = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8');
  const fnOf = (name: string) => {
    const start = router.indexOf(`export async function ${name}(`);
    return router.slice(start, router.indexOf('\nexport async function', start + 10));
  };

  it('answers recording-ready and recording-failed with a rewrite, before any card is posted or workflow run', () => {
    const fn = fnOf('handleMeetingLifecycle');
    const branch = fn.indexOf("if (h.event === 'recording-ready' || h.event === 'recording-failed') {");
    expect(branch).toBeGreaterThan(-1);
    expect(fn.slice(branch, branch + 200)).toContain('rewriteEndedCard(h.channelArn, h.meetingId)');
    expect(branch).toBeLessThan(fn.indexOf('postMeetingCard('));
    expect(branch).toBeLessThan(fn.indexOf('runWorkflowFor('));
  });

  it('rewrites in place as the assistant that posted the card, with every item the record holds', () => {
    const fn = fnOf('rewriteEndedCard');
    for (const t of ['!last.endedCardMessageId || !last.endedCardBy', 'endedCardValues(meetingArn, cardIn, last, speaker)', 'new UpdateChannelMessageCommand(', 'ChimeBearer: bearer']) {
      expect(fn).toContain(t);
    }
    expect(fn).not.toMatch(/setTimeout|setInterval|schedule/);
    // The card's items include the recording, read from the record (`recordingCardValues`).
    expect(router).toContain('...await recordingCardValues(last.recordings,');
  });
});
