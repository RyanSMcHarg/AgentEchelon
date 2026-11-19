/**
 * A MEETING ENDS IN BOUNDED TIME (SPEC-ASSISTANT-MEETINGS FR50, `meeting-watch.ts`).
 *
 *  - the check ends a meeting nobody else joined within five minutes, one left with one person for five minutes, and one
 *    past the deployment's limit, each with its reason, and leaves an attended meeting running, checked again;
 *  - the router watches a meeting from its start through one-shot schedules, ends an unattended one through the meetings
 *    function's one end, says why in the room first, and does nothing for a meeting that has already ended.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockTags = jest.fn();
jest.mock('../../lambda/src/lib/channel-classification', () => ({
  ...jest.requireActual('../../lambda/src/lib/channel-classification'),
  readChannelTags: (...a: unknown[]) => mockTags(...a),
}));
const mockContext = jest.fn();
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  ...jest.requireActual('../../lambda/src/lib/channel-context-client'),
  getChannelContext: (...a: unknown[]) => mockContext(...a),
  readChannelContext: (...a: unknown[]) => mockContext(...a),
}));
const mockRuns = jest.fn();
const mockSummary = jest.fn();
const mockEnd = jest.fn();
jest.mock('../../lambda/src/lib/meeting-run', () => ({
  ...jest.requireActual('../../lambda/src/lib/meeting-run'),
  meetingRunsNow: (...a: unknown[]) => mockRuns(...a),
  summarizeConversationMeeting: (...a: unknown[]) => mockSummary(...a),
  endConversationMeeting: (...a: unknown[]) => mockEnd(...a),
}));
const mockSchedule = jest.fn();
jest.mock('../../lambda/src/lib/event-deadlines', () => ({
  ...jest.requireActual('../../lambda/src/lib/event-deadlines'),
  createTaskDeadlineSchedule: (...a: unknown[]) => mockSchedule(...a),
}));
// The room's primary is another classification's here, so no card is posted: what is said is the template's own test.
jest.mock('../../lambda/src/lib/conversation-primary', () => ({
  ...jest.requireActual('../../lambda/src/lib/conversation-primary'),
  primaryAssistantOf: async () => ({ assistant: 'x', botArn: 'arn:bot', classification: 'other', source: 'tag' }),
}));

process.env.CLASSIFICATION = 'premium';
process.env.MEETING_RUN_FUNCTION = 'AgentEchelonMeetings-MeetingRun';
process.env.MEETING_SUMMARY_FUNCTION = 'AgentEchelonMeetings-MeetingSummary';
process.env.EVENT_DEADLINE_GROUP = 'ae-deadlines-premium';
process.env.EVENT_DEADLINE_ROLE_ARN = 'arn:aws:iam::111122223333:role/scheduler';
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_LAMBDA_FUNCTION_NAME = 'router';

import { meetingWatchDecision, meetingMaxMinutes, MEETING_TIMEOUT_TEMPLATES, EVENTS_SETTLE_MS } from '../../lambda/src/lib/meeting-watch';
import { MEETING_SUMMARY_DELAY_SECONDS } from '../../lambda/src/lib/event-deadlines';
import { meetingWatchFiringOf } from '../../lambda/src/lib/event-deadlines';
import { shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';
import { renderMessageTemplate } from '../../lambda/src/lib/message-template';
import { handleDeadlineFired } from '../../lambda/src/router-agent-handler';

const MIN = 60_000;
const T0 = Date.parse('2026-11-12T22:00:00Z');
const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai/channel/conv-meeting-1';
const M = 'a1b2c3d4-0000-1111-2222-333344445555';

describe('the check', () => {
  const at = (minutes: number, over: Partial<Parameters<typeof meetingWatchDecision>[0]> = {}) =>
    meetingWatchDecision({ now: T0 + minutes * MIN, startedAt: T0, maxMinutes: 90, present: 0, people: 0, ...over });

  it('ends a meeting nobody else joined within five minutes', () => {
    expect(at(5, { present: 0, people: 0 })).toEqual({ end: 'nobody-joined' });
    expect(at(5, { present: 1, people: 1 })).toEqual({ end: 'nobody-joined' });
  });

  it('ends a meeting one person was left alone in for five minutes, seen at two checks', () => {
    // Two were in it; one left before this check.
    const first = at(20, { present: 1, people: 2 });
    expect(first).toEqual({ next: T0 + 25 * MIN, aloneSince: T0 + 20 * MIN });
    expect(at(25, { present: 1, people: 2, aloneSince: T0 + 20 * MIN })).toEqual({ end: 'left-alone' });
  });

  it('ends a meeting at the deployment\'s limit, whoever is in it', () => {
    expect(at(90, { present: 6, people: 6 })).toEqual({ end: 'time-limit' });
    expect(meetingWatchDecision({ now: T0 + 30 * MIN, startedAt: T0, maxMinutes: 30, present: 3, people: 3 })).toEqual({ end: 'time-limit' });
  });

  it('leaves an attended meeting running until its limit, with no check between (a leave schedules its own)', () => {
    expect(at(5, { present: 2, people: 2 })).toEqual({ next: T0 + 90 * MIN });
    expect(at(88, { present: 2, people: 2 })).toEqual({ next: T0 + 90 * MIN });
    // Someone came back: what an earlier check saw is forgotten.
    expect(at(30, { present: 2, people: 3, aloneSince: T0 + 25 * MIN })).toEqual({ next: T0 + 90 * MIN });
  });

  it('never ends a meeting a person joined before the events store filed it: checked again once it is', () => {
    // Nobody is in the store five minutes on, but the running meeting's record holds a join forty seconds ago.
    expect(at(5, { present: 1, people: 1, lastJoinAt: T0 + 5 * MIN - 40_000 })).toEqual({ next: T0 + 5 * MIN - 40_000 + EVENTS_SETTLE_MS });
    expect(at(25, { present: 1, people: 2, aloneSince: T0 + 20 * MIN, lastJoinAt: T0 + 25 * MIN - 1000 })).not.toHaveProperty('end');
    // A join the store has had time to file decides nothing by itself.
    expect(at(5, { present: 1, people: 1, lastJoinAt: T0 + MIN })).toEqual({ end: 'nobody-joined' });
    // The limit ends it whatever.
    expect(at(90, { present: 0, people: 2, lastJoinAt: T0 + 90 * MIN - 1000 })).toEqual({ end: 'time-limit' });
  });

  it('waits for a join to be filed as long as a summary waits for a meeting\'s last events', () => {
    expect(EVENTS_SETTLE_MS).toBe(MEETING_SUMMARY_DELAY_SECONDS * 1000);
  });

  it('takes the limit from the deployment, 90 minutes unless set within 10 to 1440', () => {
    expect(meetingMaxMinutes(undefined)).toBe(90);
    expect(meetingMaxMinutes('45')).toBe(45);
    expect(meetingMaxMinutes('5')).toBe(90);
    expect(meetingMaxMinutes('abc')).toBe(90);
  });
});

describe('the room is told why, in a template', () => {
  it('has a line for each reason, the limit said from its value', () => {
    for (const name of Object.values(MEETING_TIMEOUT_TEMPLATES)) {
      const said = renderMessageTemplate(shippedMessageTemplate(name), { max_minutes: '90' }, { sections: ['chat'], refusedValue: 'empty' });
      expect(said.ok && said.sections.chat).toBeTruthy();
    }
    const limit = renderMessageTemplate(shippedMessageTemplate('meeting-ended-time-limit'), { max_minutes: '90' }, { sections: ['chat'], refusedValue: 'empty' });
    expect(limit.ok && limit.sections.chat).toContain('90');
  });
});

describe('the firing', () => {
  it('carries ids, its moment and what an earlier check saw, read strictly', () => {
    expect(meetingWatchFiringOf({ kind: 'meeting-watch', channelArn: CHANNEL, meetingId: M, at: 1794522900 }))
      .toEqual({ kind: 'meeting-watch', channelArn: CHANNEL, meetingId: M, at: 1794522900 });
    expect(meetingWatchFiringOf({ kind: 'meeting-watch', channelArn: CHANNEL, meetingId: M, at: 1794522900, aloneSince: 5 })).toMatchObject({ aloneSince: 5 });
    expect(meetingWatchFiringOf({ kind: 'meeting-watch', channelArn: CHANNEL, meetingId: "m'1", at: 1 })).toBeNull();
    expect(meetingWatchFiringOf({ kind: 'meeting-watch', channelArn: CHANNEL, meetingId: M })).toBeNull();
  });
});

describe('the router', () => {
  const firing = (over: Record<string, unknown> = {}) => ({ kind: 'meeting-watch', channelArn: CHANNEL, meetingId: M, at: Math.floor(Date.now() / 1000), ...over });
  const running = (createdAt: string) => mockContext.mockResolvedValue({ activeMeeting: { meetingId: M, createdAt, createdBy: 'p1' }, lastMeeting: { meetingId: M, createdAt, createdBy: 'p1' } });
  const minutesAgo = (m: number) => new Date(Date.now() - m * MIN).toISOString();

  beforeEach(() => {
    jest.clearAllMocks();
    mockTags.mockResolvedValue({ classification: 'premium' });
    mockRuns.mockResolvedValue(true);
    mockSchedule.mockResolvedValue('created');
    mockEnd.mockResolvedValue({ ok: true });
  });

  it('ends a meeting nobody joined through the meetings function\'s one end', async () => {
    running(minutesAgo(6));
    mockSummary.mockResolvedValue({ ok: true, ended: false, present: 0, people: 0 });
    expect(await handleDeadlineFired(firing())).toEqual({ ran: true, reason: 'nobody-joined' });
    // Why it ended goes with the end, so the ended card the service's end raises says it.
    expect(mockEnd).toHaveBeenCalledWith('AgentEchelonMeetings-MeetingRun', CHANNEL, M, 'nobody-joined');
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('ends a meeting one person was left alone in', async () => {
    running(minutesAgo(30));
    mockSummary.mockResolvedValue({ ok: true, ended: false, present: 1, people: 3 });
    expect(await handleDeadlineFired(firing({ aloneSince: Date.now() - 6 * MIN }))).toEqual({ ran: true, reason: 'left-alone' });
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it('ends a meeting past its limit without reading its people', async () => {
    running(minutesAgo(91));
    expect(await handleDeadlineFired(firing())).toEqual({ ran: true, reason: 'time-limit' });
    expect(mockSummary).not.toHaveBeenCalled();
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it('leaves an attended meeting running and schedules its next check', async () => {
    running(minutesAgo(12));
    mockSummary.mockResolvedValue({ ok: true, ended: false, present: 3, people: 3 });
    const out = await handleDeadlineFired(firing());
    expect(out.ran).toBe(false);
    expect(mockEnd).not.toHaveBeenCalled();
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const [, next, when] = mockSchedule.mock.calls[0];
    expect(next).toMatchObject({ kind: 'meeting-watch', channelArn: CHANNEL, meetingId: M });
    expect(next.aloneSince).toBeUndefined();
    expect((when as Date).getTime()).toBeGreaterThan(Date.now() + 4 * MIN);
  });

  it('does nothing for a meeting that has already ended, and schedules nothing', async () => {
    mockContext.mockResolvedValue({ lastMeeting: { meetingId: M, createdAt: minutesAgo(10), createdBy: 'p1' } });
    expect((await handleDeadlineFired(firing())).ran).toBe(false);
    running(minutesAgo(10));
    mockRuns.mockResolvedValue(false);
    expect((await handleDeadlineFired(firing())).ran).toBe(false);
    expect(mockEnd).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockSummary).not.toHaveBeenCalled();
  });

  it('keeps a meeting someone just joined running, though the events store does not show them yet', async () => {
    mockContext.mockResolvedValue({ activeMeeting: { meetingId: M, createdAt: minutesAgo(6), createdBy: 'p1', lastJoinAt: new Date(Date.now() - 30_000).toISOString() } });
    mockSummary.mockResolvedValue({ ok: true, ended: false, present: 1, people: 1 });
    expect((await handleDeadlineFired(firing())).ran).toBe(false);
    expect(mockEnd).not.toHaveBeenCalled();
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('a firing delivered twice schedules the same next check, so a meeting keeps one chain of checks', async () => {
    running(minutesAgo(20));
    mockSummary.mockResolvedValue({ ok: true, ended: false, present: 1, people: 3 });
    const f = firing({ at: Math.floor(Date.now() / 1000) - 7 });
    await handleDeadlineFired(f);
    await new Promise((r) => setTimeout(r, 1100));
    await handleDeadlineFired(f);
    expect(mockSchedule).toHaveBeenCalledTimes(2);
    const [[, a, whenA], [, b, whenB]] = mockSchedule.mock.calls;
    expect(b).toEqual(a);
    expect((whenB as Date).getTime()).toBe((whenA as Date).getTime());
  });

  it('checks a meeting five minutes after a person leaves it, and nothing for one no longer running', async () => {
    const { handleMeetingLifecycle } = await import('../../lambda/src/router-agent-handler');
    running(minutesAgo(30));
    const leftAt = new Date(Date.now() - 10_000).toISOString();
    const out = await handleMeetingLifecycle({ channelArn: CHANNEL, meetingId: M, event: 'person-left', at: leftAt });
    expect(out).toMatchObject({ ran: false, carded: false });
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const [, next, when] = mockSchedule.mock.calls[0];
    expect(next).toMatchObject({ kind: 'meeting-watch', channelArn: CHANNEL, meetingId: M });
    expect(next.aloneSince).toBeUndefined();
    expect(Math.abs((when as Date).getTime() - (Date.parse(leftAt) + 5 * MIN))).toBeLessThan(1000);
    mockSchedule.mockClear();
    mockContext.mockResolvedValue({ lastMeeting: { meetingId: M, createdAt: minutesAgo(30), createdBy: 'p1' } });
    expect((await handleMeetingLifecycle({ channelArn: CHANNEL, meetingId: M, event: 'person-left', at: leftAt })).ran).toBe(false);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it("finishes a recording's card after the meeting's conversation is archived, and refuses every other event there", async () => {
    const { handleMeetingLifecycle } = await import('../../lambda/src/router-agent-handler');
    mockTags.mockResolvedValue({ classification: 'premium', archived: 'true' });
    mockContext.mockResolvedValue({ lastMeeting: { meetingId: M, createdAt: minutesAgo(30), createdBy: 'p1' } });
    const at = new Date().toISOString();
    const ready = await handleMeetingLifecycle({ channelArn: CHANNEL, meetingId: M, event: 'recording-ready', at });
    expect(ready.reason).toBeUndefined();
    expect(mockContext).toHaveBeenCalled();
    const ended = await handleMeetingLifecycle({ channelArn: CHANNEL, meetingId: M, event: 'person-left', at });
    expect(ended).toEqual({ ran: false, carded: false, reason: 'the conversation is archived' });
  });

  it('checks again when its conversation or its record cannot be read, and ends nothing', async () => {
    running(minutesAgo(10));
    mockTags.mockRejectedValueOnce(new Error('throttled'));
    expect((await handleDeadlineFired(firing())).ran).toBe(false);
    mockContext.mockRejectedValueOnce(new Error('throttled'));
    expect((await handleDeadlineFired(firing())).ran).toBe(false);
    expect(mockEnd).not.toHaveBeenCalled();
    expect(mockSchedule).toHaveBeenCalledTimes(2);
  });

  it('checks again when its people cannot be read, and ends nothing', async () => {
    running(minutesAgo(10));
    mockSummary.mockResolvedValue({ ok: false, code: 'INCOMPLETE' });
    expect((await handleDeadlineFired(firing())).ran).toBe(false);
    expect(mockEnd).not.toHaveBeenCalled();
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('watches every meeting from its start, and ends one with its reason, which the ended card says', () => {
    const router = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8');
    const start = router.indexOf('export async function handleMeetingLifecycle(');
    const lifecycle = router.slice(start, router.indexOf('\nexport async function', start + 10));
    expect(lifecycle).toContain("if (h.event === 'meeting-started') {");
    expect(lifecycle).toContain('await scheduleMeetingWatch(h.channelArn, h.meetingId, startedAt + MEETING_WATCH_MINUTES * 60_000);');
    const w = router.indexOf('export async function handleMeetingWatchFired(');
    const watch = router.slice(w, router.indexOf('\nasync function scheduleMeetingSummary', w));
    expect(watch).toContain('endConversationMeeting(runFn, firing.channelArn, firing.meetingId, decision.end)');
    // No separate message: the ended card says why (`endedCardValues`).
    expect(watch.indexOf('sayMeetingCard(')).toBe(-1);
    expect(router).toContain("return MEETING_TIMEOUT_TEMPLATES[reason];");
  });
});
