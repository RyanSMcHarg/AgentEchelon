/**
 * THE ROOM'S IN-PROGRESS BANNER: Join for anyone not in the meeting, and End for everyone for its host and the
 * moderators, without joining it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@ae/shared/i18n';
import en from '@ae/shared/locales/en.json';
import MeetingInProgress from './MeetingInProgress';
import type { ConversationMeeting } from '../../hooks/useConversationMeeting';

const mockEnd = vi.fn();
vi.mock('../../services/meetingService', () => ({ meetingService: { endMeeting: (...a: unknown[]) => mockEnd(...a) } }));
const mockRing = vi.fn();
vi.mock('../../services/chimeService', () => ({ chimeService: { sendRing: (...a: unknown[]) => mockRing(...a) } }));
const mockOpen = vi.fn();
vi.mock('../../utils/meetingWindow', () => ({ openMeetingWindow: (...a: unknown[]) => mockOpen(...a) }));

const ROOM = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/room-1';
const running = (over: Partial<ConversationMeeting> = {}): ConversationMeeting => ({
  running: true, joinedHere: false, mayEnd: false, isHost: false, mayStart: false, ended: false, removed: false, known: true, meetingConversationId: 'meet-1', ...over,
});

beforeEach(() => { mockEnd.mockReset(); mockRing.mockReset().mockResolvedValue(undefined); mockOpen.mockReset(); });

describe('the in-progress banner', () => {
  it('offers Join and no End to a member who may not end it', () => {
    render(<MeetingInProgress channelArn={ROOM} meeting={running()} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.join }));
    expect(mockOpen).toHaveBeenCalledWith(ROOM, 'meet-1');
    expect(screen.queryByRole('button', { name: en.meeting.end })).not.toBeInTheDocument();
  });

  it('lets its host end it for everyone without joining, and sends no ring itself (the platform stops it)', async () => {
    mockEnd.mockResolvedValue(undefined);
    render(<MeetingInProgress channelArn={ROOM} meeting={running({ mayEnd: true })} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.end }));
    await waitFor(() => expect(mockEnd).toHaveBeenCalledWith(ROOM));
    await waitFor(() => expect(screen.queryByTestId('meeting-in-progress')).not.toBeInTheDocument());
    expect(mockRing).not.toHaveBeenCalled();
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it('says why an end the server refused did not happen, and keeps the banner', async () => {
    mockEnd.mockRejectedValue(Object.assign(new Error('x'), { code: 'NOT_PERMITTED_TO_END' }));
    render(<MeetingInProgress channelArn={ROOM} meeting={running({ mayEnd: true })} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.end }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en.meeting.errors.NOT_PERMITTED_TO_END);
    expect(screen.getByTestId('meeting-in-progress')).toBeInTheDocument();
  });

  it('shows nothing for a meeting that does not run, or that this person is in', () => {
    const { container, rerender } = render(<MeetingInProgress channelArn={ROOM} meeting={running({ running: false })} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<MeetingInProgress channelArn={ROOM} meeting={running({ joinedHere: true })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
