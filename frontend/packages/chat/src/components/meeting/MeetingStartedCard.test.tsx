/**
 * A MEETING'S STARTED CARD (`MeetingStartedCard.tsx`): the room address is not shown, the title leads, the alarm's reason
 * is a secondary line, and Join opens the meeting window from the room while the meeting runs, and only then.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@ae/shared/i18n';
import en from '@ae/shared/locales/en.json';

const mockOpen = vi.fn();
vi.mock('../../utils/meetingWindow', () => ({ openMeetingWindow: (...a: unknown[]) => mockOpen(...a) }));

import MeetingStartedCard, { meetingCardText, shownAssistantText, startedCardOf } from './MeetingStartedCard';

const ROOM = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/room-1';
const CONTENT = '@humans An incident call has started on **Checkout latency**: [join it](?meeting=meet-1).\nThe alarm reports: Threshold Crossed: 1 datapoint [5.0 (13/11/26 10:00:00)] was greater than the threshold (1.0).';
const plain = (md: string) => <span>{md}</span>;

beforeEach(() => mockOpen.mockClear());

describe("a meeting's started card", () => {
  it('drops the room address and the meeting link, and splits the title from the detail', () => {
    expect(meetingCardText(CONTENT)).toEqual({
      title: 'An incident call has started on **Checkout latency**.',
      detail: 'The alarm reports: Threshold Crossed: 1 datapoint [5.0 (13/11/26 10:00:00)] was greater than the threshold (1.0).',
    });
  });

  it('offers Join while its meeting runs, opening the meeting window from the room by the meeting', () => {
    render(<MeetingStartedCard content={CONTENT} roomArn={ROOM} meetingConversationId="meet-1" running renderText={plain} />);
    expect(screen.queryByText(/@humans/)).toBeNull();
    screen.getByRole('button', { name: en.meeting.join }).click();
    expect(mockOpen).toHaveBeenCalledWith(ROOM, 'meet-1');
  });

  it('says the meeting ended, with no Join, once it has', () => {
    render(<MeetingStartedCard content={CONTENT} roomArn={ROOM} meetingConversationId="meet-1" running={false} renderText={plain} />);
    expect(screen.queryByRole('button', { name: en.meeting.join })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(en.meeting.cardEnded);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', en.meeting.ended);
  });

  it('offers nothing inside the meeting window, which is the meeting', () => {
    render(<MeetingStartedCard content={CONTENT} roomArn={ROOM} running inMeeting renderText={plain} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('the incident call card as the room is sent it', () => {
  const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops-assistant';
  const MEETING_CONVERSATION = '00000000-0000-4000-8000-0000000000a1';
  // The router's text: `@humans ` and the `meeting-started-incident` template's chat section, rendered.
  const INCIDENT = `@humans **Incident call in progress: AgentEchelon-demo-incident** · [Join the call](?meeting=${MEETING_CONVERSATION})\n`
    + 'The alarm reports: Threshold Crossed: 2 out of the last 2 datapoints [1.0 (13/11/26 23:01:00), 1.0 (13/11/26 23:00:00)] were greater than or equal to the threshold (1.0) (minimum 2 datapoints for OK -> ALARM transition).';
  // The router's Metadata for a workflow's started card: attribution, the card, the step, the run and the room's email.
  const METADATA = JSON.parse(JSON.stringify({
    botResponse: true, agentType: 'ops', classification: 'premium', turnKind: 'notification',
    meetingCard: { event: 'meeting-started', meetingId: '5f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f', conversationId: MEETING_CONVERSATION },
    eventStep: { workflow: 'ops-room', step: 'start-call', event: 'alarm', outcome: 'posted' },
    eventRun: { runKey: 'run#room-1#ops-room#1', transitions: [{ step: 'open', outcome: 'posted' }], originConfigId: 'cfg-1', workflowHash: 'abc123' },
    notify: { email: true }, notifySubject: 'Incident call: AgentEchelon-demo-incident', notifyConversationId: 'room-1', notifyLink: 'meeting',
  }));

  it('reads its card from the metadata the router writes', async () => {
    const { meetingCardFromMetadata } = await import('../../services/meetingService');
    const card = meetingCardFromMetadata(METADATA, BOT);
    expect(card).toEqual({ event: 'meeting-started', meetingId: METADATA.meetingCard.meetingId, conversationId: MEETING_CONVERSATION });
    expect(startedCardOf({ meetingCard: card })).toBe(card);
  });

  it('draws a bold title with no room address or separator, the reason beneath, and Join to the meeting', () => {
    expect(meetingCardText(INCIDENT)).toEqual({
      title: '**Incident call in progress: AgentEchelon-demo-incident**',
      detail: expect.stringMatching(/^The alarm reports: Threshold Crossed/),
    });
    render(<MeetingStartedCard content={INCIDENT} roomArn={ROOM} meetingConversationId={MEETING_CONVERSATION} running renderText={plain} />);
    expect(screen.queryByText(/@humans/)).toBeNull();
    screen.getByRole('button', { name: en.meeting.join }).click();
    expect(mockOpen).toHaveBeenCalledWith(ROOM, MEETING_CONVERSATION);
  });

  it('is a card by its metadata alone: the same text with no meetingCard is not one', () => {
    expect(startedCardOf({})).toBeUndefined();
    expect(startedCardOf({ meetingCard: { event: 'meeting-ended', meetingId: 'm-1' } })).toBeUndefined();
  });

  it("shows an assistant's message without the @humans room address", () => {
    expect(shownAssistantText('@humans The deploy finished.')).toBe('The deploy finished.');
    expect(shownAssistantText('Ask @humans later')).toBe('Ask @humans later');
  });
});
