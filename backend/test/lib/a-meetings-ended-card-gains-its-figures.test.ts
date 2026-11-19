/**
 * A MEETING'S ENDED CARD GAINS ITS FIGURES, ONCE (the `meetings` capability).
 *
 *  - the router schedules one summary per meeting, by the meeting's id, only once the ended card is recorded with the
 *    assistant that posted it;
 *  - when it fires, the router checks the conversation and its record before anything is read, and rewrites the card in
 *    place as that same assistant, only for an ended meeting someone joined;
 *  - the summary entry reads the conversation's own last meeting, answers counts and minutes, and refuses a partial read;
 *  - the entry is a reader: it holds no write in the system of record and no meeting grant.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../lambda/src/lib/channel-context-client', () => ({ readChannelContext: jest.fn() }));
jest.mock('../../lambda/src/lib/meeting-event-reader', () => ({ meetingEventsIn: jest.fn() }));
const mockReadClassification = jest.fn();
jest.mock('../../lambda/src/lib/channel-classification', () => ({
  ...jest.requireActual('../../lambda/src/lib/channel-classification'),
  readChannelClassificationTag: (...a: unknown[]) => mockReadClassification(...a),
}));
jest.mock('../../lib/profile-registry', () => ({ ...jest.requireActual('../../lib/profile-registry'), loadProfileRegistry: jest.fn(async () => undefined) }));

import { readChannelContext as getChannelContext } from '../../lambda/src/lib/channel-context-client';
import { isTransientEntryCode } from '../../lambda/src/router-agent-handler';
import { meetingEventsIn } from '../../lambda/src/lib/meeting-event-reader';
import { MEETING_SUMMARY_DELAY_SECONDS, meetingSummaryFiringOf } from '../../lambda/src/lib/event-deadlines';
import { handler, __setMessagingClient } from '../../lambda/src/meeting-summary';
import { shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';

const SRC = path.join(__dirname, '..', '..');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai';
const CHANNEL = `${APP}/channel/ch-1`;
const M = 'a1b2c3d4-0000-1111-2222-333344445555';

const row = (event_type: string, event_at: string, extra: Record<string, unknown> = {}) => ({
  meeting_id: M, channel_arn: CHANNEL, classification: 'standard', event_type, source: 'server', attendee_id: null, person_key: null,
  is_content: false, network_transport: null, event_at, detail: null, ...extra,
});

describe('the firing', () => {
  it('carries ids only, and is read strictly', () => {
    expect(meetingSummaryFiringOf({ kind: 'meeting', channelArn: CHANNEL, meetingId: M })).toEqual({ kind: 'meeting', channelArn: CHANNEL, meetingId: M });
    expect(meetingSummaryFiringOf({ kind: 'meeting', channelArn: CHANNEL, meetingId: "m'1" })).toBeNull();
    expect(meetingSummaryFiringOf({ kind: 'meeting', channelArn: 'arn:aws:s3:::x', meetingId: M })).toBeNull();
    expect(meetingSummaryFiringOf({ kind: 'task', channelArn: CHANNEL, meetingId: M })).toBeNull();
    // Past the archive stream's 60 second buffer.
    expect(MEETING_SUMMARY_DELAY_SECONDS).toBeGreaterThan(60);
  });

  it('is named by its meeting, so a redelivered end schedules nothing twice', () => {
    const lib = read('lambda/src/lib/event-deadlines.ts');
    expect(lib).toContain("if (firing.kind === 'meeting') return `meeting-${firing.meetingId}`;");
  });
});

describe('the router', () => {
  const router = read('lambda/src/router-agent-handler.ts');
  const fnOf = (name: string) => {
    const start = router.indexOf(`export async function ${name}(`);
    return router.slice(start, router.indexOf('\nexport async function', start + 10));
  };

  it('schedules the summary only once the ended card is recorded with its poster and the room it is in', () => {
    const fn = fnOf('handleMeetingLifecycle');
    expect(fn).toMatch(/if \(await endedCardRecorded\(h\.channelArn, h\.meetingId, sent\.MessageId, primary\.botArn, room\)\) \{\s*if \(await scheduleMeetingSummary\(h\.channelArn, h\.meetingId\) === 'failed'\) throw/);
    expect(router).toContain('if (await recordEndedMeetingCard(channelArn, meetingId, messageId, by, room)) return true;');
  });

  it('rewrites the card in the room it was posted in, from the meeting conversation\'s record', () => {
    const fn = fnOf('handleMeetingSummaryFired');
    expect(fn).toContain('const cardIn = last.endedCardIn || firing.channelArn;');
    const rewrite = fnOf('rewriteEndedCard');
    expect(rewrite).toContain('const cardIn = last.endedCardIn || meetingArn;');
    expect(rewrite).toContain('ChannelArn: cardIn,');
  });

  it('checks the tag, the archive state and the record before the read, and the read before the rewrite', () => {
    const fn = fnOf('handleMeetingSummaryFired');
    const order = [
      'tagsUnlessGone(firing.channelArn)', 'roomRefusal(meetingTags)',
      'readChannelContext(firing.channelArn, { consistent: true })', 'last.meetingId !== firing.meetingId', '!last.endedCardBy',
      'summarizeConversationMeeting(fn, firing.channelArn, firing.meetingId)', 's?.ok && s.ended && s.people',
      'rewriteEndedCard(firing.channelArn, firing.meetingId, { transcriptKey, figures })',
    ].map((t) => fn.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The assistant that posted the card is the one that edits it, in that assistant's wording, through the one rewrite.
    const rewrite = fnOf('rewriteEndedCard');
    expect(rewrite).toContain('const bearer = last.endedCardBy;');
    expect(rewrite).toContain('ChimeBearer: bearer');
    expect(rewrite).toContain('cardWording(await cardSpeaker(bearer, cardIn))');
    expect(rewrite).toContain("const name = figures || last.summary ? 'meeting-summary' : 'meeting-ended';");
  });

  it('reaches the summary through the deadline entry it already has', () => {
    expect(fnOf('handleDeadlineFired')).toContain('meetingSummaryFiringOf(raw)');
  });

  it('starts nothing without the capability', async () => {
    delete process.env.MEETING_SUMMARY_FUNCTION;
    const { handleMeetingSummaryFired } = await import('../../lambda/src/router-agent-handler');
    expect(await handleMeetingSummaryFired({ kind: 'meeting', channelArn: CHANNEL, meetingId: M })).toEqual({ ran: false, reason: 'not wired' });
  });
});

describe('the card', () => {
  it('names each figure in the template, never in code', () => {
    const t = shippedMessageTemplate('meeting-summary');
    expect(Object.keys(t.fields ?? {}).sort()).toEqual(['connected_minutes', 'conversation_link', 'drops', 'duration_minutes', 'ended_how', 'people', 'people_names', 'recording_link', 'recording_parts', 'recording_status', 'transcript_link', 'action_items', 'key_points', 'summary', 'summary_note'].sort());
  });
});

describe('the summary entry', () => {
  beforeEach(() => {
    process.env.APP_INSTANCE_ARN = APP;
    // The summary entry under test is the standard classification's (`MEETING_SUMMARY_CLASSIFICATION`, one per classification).
    process.env.MEETING_SUMMARY_CLASSIFICATION = 'standard';
    __setMessagingClient({ send: jest.fn() } as never);
    mockReadClassification.mockReset().mockResolvedValue('standard');
    (getChannelContext as jest.Mock).mockReset();
    (meetingEventsIn as jest.Mock).mockReset();
  });

  it('REFUSED: a conversation of another classification, or one whose classification cannot be read, before its record is read (tenets D3, D12)', async () => {
    mockReadClassification.mockResolvedValue('premium');
    expect(await handler({ channelArn: CHANNEL, meetingId: M })).toEqual({ ok: false, code: 'OTHER_CLASSIFICATION' });
    // A tag that cannot be read is a failed read, which the router asks again.
    mockReadClassification.mockResolvedValue(undefined);
    expect(await handler({ channelArn: CHANNEL, meetingId: M })).toEqual({ ok: false, code: 'CLASSIFICATION_UNREADABLE' });
    expect(isTransientEntryCode('CLASSIFICATION_UNREADABLE')).toBe(true);
    expect(getChannelContext).not.toHaveBeenCalled();
    expect(meetingEventsIn).not.toHaveBeenCalled();
  });

  it('REFUSED: every read of a summary entry deployed without its classification', async () => {
    delete process.env.MEETING_SUMMARY_CLASSIFICATION;
    expect(await handler({ channelArn: CHANNEL, meetingId: M })).toEqual({ ok: false, code: 'INVALID' });
    expect(mockReadClassification).not.toHaveBeenCalled();
    expect(getChannelContext).not.toHaveBeenCalled();
  });

  it('refuses a conversation outside the app instance, or a malformed meeting, before any read', async () => {
    expect(await handler({ channelArn: 'arn:aws:chime:us-east-1:1:app-instance/other/channel/x', meetingId: M })).toEqual({ ok: false, code: 'INVALID' });
    expect(await handler({ channelArn: CHANNEL, meetingId: "m'1" })).toEqual({ ok: false, code: 'INVALID' });
    expect(getChannelContext).not.toHaveBeenCalled();
  });

  it('answers a record it could not read as a failed read the router asks again, never as not this meeting', async () => {
    (getChannelContext as jest.Mock).mockRejectedValue(Object.assign(new Error('x'), { name: 'ChannelContextUnreadable' }));
    const out = await handler({ channelArn: CHANNEL, meetingId: M });
    expect(out).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(isTransientEntryCode((out as { code: string }).code)).toBe(true);
    expect(meetingEventsIn).not.toHaveBeenCalled();
  });

  it('reads only the last meeting of the conversation', async () => {
    (getChannelContext as jest.Mock).mockResolvedValue({ lastMeeting: { meetingId: 'other', createdAt: '2026-11-11T10:00:00Z' } });
    expect(await handler({ channelArn: CHANNEL, meetingId: M })).toEqual({ ok: false, code: 'NOT_THIS_MEETING' });
    expect(meetingEventsIn).not.toHaveBeenCalled();
  });

  it('refuses a read cut short rather than a figure over part of the meeting', async () => {
    (getChannelContext as jest.Mock).mockResolvedValue({ lastMeeting: { meetingId: M, createdAt: '2026-11-11T10:00:00Z' } });
    (meetingEventsIn as jest.Mock).mockResolvedValue({ rows: [], truncated: true, unread: [], store: 'athena' });
    expect(await handler({ channelArn: CHANNEL, meetingId: M })).toEqual({ ok: false, code: 'INCOMPLETE' });
  });

  it('reads the meeting without its connectivity samples, which its figures do not use', async () => {
    (getChannelContext as jest.Mock).mockResolvedValue({ lastMeeting: { meetingId: M, createdAt: '2026-11-11T10:00:00Z' } });
    (meetingEventsIn as jest.Mock).mockResolvedValue({ rows: [], truncated: false, unread: [], store: 'athena' });
    await handler({ channelArn: CHANNEL, meetingId: M });
    expect((meetingEventsIn as jest.Mock).mock.calls[0][3]).toMatchObject({ samples: false });
  });

  it('answers counts and minutes from the rows of that meeting alone, and nothing about a person', async () => {
    (getChannelContext as jest.Mock).mockResolvedValue({ lastMeeting: { meetingId: M, createdAt: '2026-11-11T10:00:00Z' } });
    (meetingEventsIn as jest.Mock).mockResolvedValue({
      rows: [
        row('MeetingStarted', '2026-11-11T10:00:00.000Z'),
        row('AttendeeJoined', '2026-11-11T10:00:30.000Z', { attendee_id: 'a1', person_key: 'p1' }),
        row('AttendeeJoined', '2026-11-11T10:01:00.000Z', { attendee_id: 'a2', person_key: 'p2' }),
        row('AttendeeDropped', '2026-11-11T10:10:00.000Z', { attendee_id: 'a2', person_key: 'p2' }),
        row('AttendeeLeft', '2026-11-11T10:20:30.000Z', { attendee_id: 'a1', person_key: 'p1' }),
        row('MeetingEnded', '2026-11-11T10:21:00.000Z'),
        // Another conversation's row under the same meeting id counts for nothing.
        row('AttendeeJoined', '2026-11-11T10:02:00.000Z', { attendee_id: 'x', person_key: 'px', channel_arn: `${APP}/channel/ch-2` }),
      ],
      truncated: false, unread: [], store: 'aurora',
    });
    const a = await handler({ channelArn: CHANNEL, meetingId: M });
    expect(a).toEqual({ ok: true, ended: true, durationMinutes: 21, people: 2, present: 0, connectedMinutes: 29, drops: 1 });
    expect(JSON.stringify(a)).not.toMatch(/p1|p2|a1|a2|px/);
  });
});

describe('the entry is a reader', () => {
  const stack = read('lib/stacks/meetings-stack.ts');
  const block = stack.slice(stack.indexOf('new lambdaNodeJs.NodejsFunction(this, `MeetingSummaryFunction-${classification}`'), stack.indexOf('// ── THE ROSTER'));

  it('writes nothing in the system of record and holds no meeting grant', () => {
    expect(block.length).toBeGreaterThan(100);
    // Its one Amazon Chime SDK action is the read of a conversation's classification tag, which it checks against its own.
    expect(block).not.toMatch(/actions: \[[^\]]*('firehose:|'chime:(?!ListTagsForResource')|'dynamodb:(UpdateItem|PutItem))/);
    // The guard bites: the run entry's grants, which start meetings, would fail it.
    expect("actions: ['chime:CreateMeeting']").toMatch(/actions: \[[^\]]*('firehose:|'chime:(?!ListTagsForResource')|'dynamodb:(UpdateItem|PutItem))/);
    expect(block).toContain("filter((st) => !st.actions.includes('firehose:PutRecordBatch'))");
    // Its object reads are the meeting-events family and the query results; its only write is the results.
    expect(block).toContain("resources: [`${archive.bucketArn}/${MEETING_EVENTS_PREFIX}/*`, `${archive.bucketArn}/athena-results/*`]");
    expect(block).toContain("actions: ['s3:PutObject'], resources: [`${archive.bucketArn}/athena-results/*`]");
  });

  it('is invoked by its own classification\'s router by its fixed name, only with the capability', () => {
    const profile = read('lib/stacks/assistant-profile-stack.ts');
    const gated = profile.slice(profile.indexOf("if (props.capabilities?.includes('meetings')) {"), profile.indexOf('// ── DEADLINES (ADR-061 decision 1)'));
    expect(gated).toContain("agentHandler.addEnvironment('MEETING_SUMMARY_FUNCTION', CAPABILITY_RESOURCES.meetingSummary(classification))");
    expect(gated).toContain('function:${CAPABILITY_RESOURCES.meetingSummary(classification)}');
  });
});
