/**
 * A MEETING'S START OR END REACHES ITS CONVERSATION'S ROUTER (`meeting-started`, `meeting-ended`, the meetings capability).
 *
 *  - the events are built, keyed once per meeting, and carry platform fields;
 *  - the router refuses a malformed handoff, and checks the conversation's tag, its archive state and its own record of
 *    the meeting before it posts a card or runs a workflow;
 *  - each classification's rule matches only this instance's events for its own classification.
 */
import * as fs from 'fs';
import * as path from 'path';
import { EVENT_WORKFLOW_EVENTS, eventRunKey } from '../../lambda/src/lib/event-workflow';
import { eventNaturalKey } from '../../lambda/src/lib/event-natural-key';
import { EVENT_FIELDS } from '../../lambda/src/lib/variables';
import { durationMinutes, lifecycleEventOf, readLifecycleHandoff } from '../../lambda/src/lib/meeting-lifecycle';
import { handleMeetingLifecycle } from '../../lambda/src/router-agent-handler';
import { shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';
import { renderMessageTemplate } from '../../lambda/src/lib/message-template';

const SRC = path.join(__dirname, '..', '..');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai/channel/ch-1';

describe('the events', () => {
  it('are built, keyed once per meeting, and carry the link or the length from the platform', () => {
    expect(EVENT_WORKFLOW_EVENTS).toEqual(expect.arrayContaining(['meeting-started', 'meeting-ended']));
    expect(eventNaturalKey('meeting-ended', CHANNEL, undefined, undefined, undefined, undefined, undefined, undefined, 'm-1')).toBe('meeting-m-1');
    expect(eventNaturalKey('meeting-ended', CHANNEL)).toBeUndefined();
    expect(eventNaturalKey('meeting-started', CHANNEL, undefined, undefined, undefined, undefined, undefined, undefined, "m'1")).toBeUndefined();
    expect(eventRunKey('meeting-started', 'meeting-m-1', 'ops-premium')).not.toBe(eventRunKey('meeting-ended', 'meeting-m-1', 'ops-premium'));
    expect(EVENT_FIELDS.filter((f) => f.event === 'meeting-started' || f.event === 'meeting-ended').map((f) => [f.event, f.field, f.computedByPlatform]))
      .toEqual([['meeting-started', 'meetingLink', true], ['meeting-ended', 'meetingDuration', true]]);
  });

  it('come only from the service start and end', () => {
    expect(lifecycleEventOf('MeetingStarted')).toBe('meeting-started');
    expect(lifecycleEventOf('MeetingEnded')).toBe('meeting-ended');
    expect(lifecycleEventOf('AttendeeJoined')).toBeNull();
  });

  it('read a handoff strictly, and give a length in whole minutes', () => {
    expect(readLifecycleHandoff({ channelArn: CHANNEL, meetingId: 'm-1', event: 'meeting-ended', at: '2026-11-11T10:00:00Z' }))
      .toEqual({ channelArn: CHANNEL, meetingId: 'm-1', event: 'meeting-ended', at: '2026-11-11T10:00:00Z' });
    expect(readLifecycleHandoff({ channelArn: 'arn:aws:s3:::x', meetingId: 'm-1', event: 'meeting-ended' })).toBeNull();
    expect(readLifecycleHandoff({ channelArn: CHANNEL, meetingId: 'm-1', event: 'AttendeeJoined' })).toBeNull();
    expect(durationMinutes('2026-11-11T10:00:00Z', '2026-11-11T10:42:20Z')).toBe(42);
    expect(durationMinutes('2026-11-11T10:00:00Z', '2026-11-11T10:00:10Z')).toBe(1);
    expect(durationMinutes('x', '2026-11-11T10:00:10Z')).toBeNull();
  });
});

describe('the router checks before anything happens', () => {
  it('starts nothing on a malformed handoff', async () => {
    expect(await handleMeetingLifecycle({ meetingId: 'm-1' })).toEqual({ ran: false, carded: false, reason: 'malformed' });
  });

  it('reads the tag, the archive state and its own record of the meeting, in that order, before the card and the run', () => {
    const router = read('lambda/src/router-agent-handler.ts');
    const start = router.indexOf('export async function handleMeetingLifecycle(');
    const fn = router.slice(start, router.indexOf('\nexport async function', start + 10));
    const order = [
      'readLifecycleHandoff(raw)', 'conversationClosedTo(await readChannelTags(chimeClient, h.channelArn), STATIC_CLASSIFICATION)',
      'readChannelContext(h.channelArn, { consistent: true })', 'last.meetingId !== h.meetingId', 'record?.activeMeeting?.meetingId !== h.meetingId',
      'meetingRunsNow(h.meetingId)', 'primaryAssistantOf(', 'postMeetingCard(', 'endedCardRecorded(', 'scheduleMeetingSummary(', 'declaredWorkflowOn(runnerServed?.version.eventWorkflows, h.event)', 'runWorkflowFor(',
    ].map((t) => fn.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A workflow that started the meeting told the room itself, so the platform posts no started card for it.
    expect(fn).toContain("last.startedVia !== 'workflow'");
    // One card per meeting per event.
    expect(fn).toContain('token: `${h.event}-${h.meetingId}`');
    expect(routerFn('postMeetingCard')).toContain('ClientRequestToken: args.token.slice(0, 64)');
  });

  it('emails the room on a person\'s start, as a workflow\'s start does, its button opening the meeting window', () => {
    const router = read('lambda/src/router-agent-handler.ts');
    const start = router.indexOf('export async function handleMeetingLifecycle(');
    const fn = router.slice(start, router.indexOf('\nexport async function', start + 10));
    expect(fn).toContain('content: (chat) => (started ? `@humans ${chat}` : chat)');
    expect(fn).toContain("conversationId: conversationKey(h.channelArn), link: 'meeting', exclude: starter,");
    // The words of the email are the template's own sections, never code.
    expect(fn).toContain('values: cardValues, email: started,');
    expect(routerFn('sayMeetingCard')).toContain("args.email ? ['chat', 'email.subject', 'email.body'] : ['chat']");
  });
});

/** One function of the router's source, from its declaration to the next top-level function. */
const routerFn = (name: string): string => {
  const router = read('lambda/src/router-agent-handler.ts');
  const start = router.search(new RegExp(`\\n(export )?async function ${name}[(<]`));
  expect(start).toBeGreaterThan(-1);
  const next = router.slice(start + 10).search(/\n(export )?async function /);
  return router.slice(start, next < 0 ? undefined : start + 10 + next);
};

describe('the call of an incident room names its incident', () => {
  it('is announced by the alarm the room watches, from its own record, and what the alarm reports now', () => {
    const fn = routerFn('meetingStartedCard');
    // The alarm comes from the server-only row the creator wrote, never from the event or the message.
    expect(fn).toContain("typeof record?.watchedAlarm === 'string' && record.watchedAlarm ? record.watchedAlarm : ''");
    expect(fn).toContain('alarmStateNow(incident)');
    expect(fn).toContain('(incident ? MEETING_INCIDENT_TEMPLATE : MEETING_NOTICE_TEMPLATE)');
  });

  it('is announced the same way when a person starts the call and when a workflow\'s step does', () => {
    // The room's record says what the room is about; the link opens the meeting's own conversation.
    expect(routerFn('handleMeetingLifecycle')).toContain('meetingStartedCard(h.channelArn, roomRecord)');
    const step = routerFn('startMeetingStep');
    expect(step).toContain('getChannelContext(args.channelArn, { consistent: true })');
    expect(step).toContain('const meetingArn = started.meetingConversationArn || args.channelArn;');
    expect(step).toContain('meetingStartedCard(meetingArn, record)');
    // A step that names its own notice keeps it, and is still handed the alarm's values to say.
    expect(step).toContain('template: args.def.notice ?? card.template, values: card.values');
  });

  it('is said, with every other meeting card, in the team\'s wording before the shipped one', () => {
    const select = routerFn('meetingCardTemplate');
    // The version's named template, then the assistant's own, then the classification's, then the shipped one.
    expect(select).toContain('selectMessageTemplate({ classification: STATIC_CLASSIFICATION, ...(assistant ? { assistant } : {}), name, messages: version?.messages })');
    expect(routerFn('handleMeetingLifecycle')).toContain('postMeetingCard(');
    expect(routerFn('rewriteEndedCard')).toContain('sayMeetingCard(');
    for (const fn of ['handleMeetingLifecycle', 'rewriteEndedCard', 'postMeetingCard']) expect(routerFn(fn)).not.toContain('shippedMessageTemplate(');
    expect(routerFn('postMeetingCard')).toContain('sayMeetingCard(');
    expect(routerFn('sayMeetingCard')).toContain('meetingCardTemplate(args.name, args.assistant, args.version, args.room, { shipped })');
    expect(routerFn('handleMeetingLifecycle')).toContain('const speaker = await cardSpeaker(primary.botArn, room);');
    expect(read('lambda/src/router-agent-handler.ts')).toContain("...(speaker.decision.decision === 'decline' ? {} : { assistant: speaker.decision.profile.name }), version: speaker.served?.version");
  });

  it('says the alarm in the room and the email, and leaves the reason out where CloudWatch gave none', () => {
    const t = shippedMessageTemplate('meeting-started-incident');
    const all = { meeting_link: '?meeting=c1', alarm: 'checkout-latency', alarm_reason: 'Threshold Crossed: p99 above 2s' };
    const said = renderMessageTemplate(t, all, { sections: ['chat', 'email.subject', 'email.body'], refusedValue: 'empty' });
    expect(said.ok && said.sections.chat).toContain('checkout-latency');
    expect(said.ok && said.sections.chat).toContain('Threshold Crossed: p99 above 2s');
    expect(said.ok && said.sections['email.subject']).toContain('checkout-latency');
    const bare = renderMessageTemplate(t, { meeting_link: '?meeting=c1', alarm: 'checkout-latency' }, { sections: ['chat'], refusedValue: 'empty' });
    expect(bare.ok && bare.sections.chat).toContain('checkout-latency');
    expect(bare.ok && bare.sections.chat.split('\n')).toHaveLength(1);
  });
});

describe('a meeting held in its own conversation is carded in the room it was started from (FR27)', () => {
  it('finds the room from the meeting conversation\'s own row, at this classification and not archived, else posts in the meeting\'s', () => {
    const room = routerFn('meetingRoomOf');
    expect(room).toContain('record?.meetingOf');
    expect(room).toContain('readChannelTags(chimeClient, parent)');
    expect(room).toContain('roomRefusal(await readChannelTags(chimeClient, parent))');
    expect(room).toContain('return meetingArn;');
  });

  it('posts the card in the room, speaks there as the room\'s primary, and runs the room\'s workflow', () => {
    const fn = routerFn('handleMeetingLifecycle');
    expect(fn).toContain('const room = await meetingRoomOf(h.channelArn, record);');
    expect(fn).toContain("primaryAssistantOf(room, chimeClient, '[Router][meeting]')");
    expect(fn).toContain('target: room,');
    expect(fn).toContain('event: h.event, channelArn: room, meeting: { meetingId: h.meetingId }');
    // The card names the meeting's own conversation, which its link and the email's button open.
    expect(fn).toContain("const cardEvent = started ? 'meeting-started' : 'meeting-ended';");
    expect(fn).toContain('meetingCardMetadata(cardEvent, h.meetingId, h.channelArn, ended)');
  });
});

describe('each classification hears only its own', () => {
  it('matches the lifecycle events of this instance for its own classification, and hands over four fields', () => {
    const stack = read('lib/stacks/assistant-profile-stack.ts');
    const rule = stack.slice(stack.indexOf("new events.Rule(this, 'MeetingLifecycle'"), stack.indexOf("new events.Rule(this, 'MeetingAttended'"));
    expect(rule).toContain("detail: { instance: [INSTANCE_NAME], classification: [classification], event: [{ 'anything-but': ['person-attended'] }] }");
    expect(rule.match(/EventField\.fromPath\('\$\.detail\.[a-zA-Z]+'\)/g)).toHaveLength(4);
  });

  it('hands over a person who took a meeting by its own rule, with the person: five fields, for that event alone', () => {
    const stack = read('lib/stacks/assistant-profile-stack.ts');
    const rule = stack.slice(stack.indexOf("new events.Rule(this, 'MeetingAttended'"), stack.indexOf("new iam.ManagedPolicy(this, 'AgentHandlerStartsMeetings'"));
    expect(rule).toContain("detail: { instance: [INSTANCE_NAME], classification: [classification], event: ['person-attended'] }");
    expect(rule.match(/EventField\.fromPath\('\$\.detail\.[a-zA-Z]+'\)/g)).toHaveLength(5);
    expect(rule).toContain("personId: events.EventField.fromPath('$.detail.personId')");
  });
});
