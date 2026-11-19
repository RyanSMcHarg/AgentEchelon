/**
 * THE MEETING WINDOW shows the meeting's own conversation (SPEC-ASSISTANT-MEETINGS FR27, FR37): opened for the room a
 * meeting was started from, it switches its chat to the meeting's conversation once the start or join names it, acts on
 * that meeting from then on and follows a start again to the next one; opened from a meeting's link by someone not yet in it, it still offers
 * the meeting, whose join decides.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@ae/shared/i18n';

const mockSelect = vi.fn();
const mockConversations = vi.fn();
vi.mock('../../providers/ConversationProvider.chime', () => ({ useConversations: () => mockConversations() }));
const mockMeeting = vi.fn();
vi.mock('../../providers/MeetingProvider', () => ({ useMeeting: () => mockMeeting() }));
vi.mock('../../providers/AwsClientProvider', () => ({ useAwsClient: () => ({ userArn: null }) }));
// What the server says of the open conversation's meeting before a start or a join names one (its status read).
const mockBefore = vi.fn();
vi.mock('../../hooks/useConversationMeeting', () => ({ useConversationMeeting: (arn: string | undefined) => mockBefore(arn) }));
const mockAlias = vi.fn();
vi.mock('../../utils/meetingWindow', async (orig) => ({ ...(await orig<object>()), aliasMeetingWindow: (ids: string[]) => mockAlias(ids) }));
vi.mock('@ae/shared', async (orig) => ({ ...(await orig<object>()), APP_INSTANCE_ARN: 'arn:aws:chime:us-east-1:1:app-instance/abc' }));
// The room and the chat are other components' tests; here they say which conversation they were given.
vi.mock('./MeetingRoom', () => ({
  default: ({ channelArn, chat, roster, title }: { channelArn: string; chat?: React.ReactNode; roster?: React.ReactNode; title?: string }) => (
    <div data-testid="room" data-channel={channelArn} data-chat={chat ? 'yes' : 'no'} data-title={title}>{roster}{chat}</div>
  ),
}));
const chatRenders = vi.fn();
vi.mock('../ConversationInterface', () => ({ default: () => { chatRenders(); return null; } }));
vi.mock('../MessageInput', () => ({ default: () => null }));
vi.mock('./MeetingRoster', () => ({ default: () => <div data-testid="roster" /> }));

import MeetingWindow from './MeetingWindow';

const APP = 'arn:aws:chime:us-east-1:1:app-instance/abc';
const conversation = (id: string) => ({ id, conversationArn: `${APP}/channel/${id}`, title: id });

beforeEach(() => {
  vi.clearAllMocks();
  mockSelect.mockResolvedValue(undefined);
  mockMeeting.mockReturnValue({ status: 'idle' });
  mockBefore.mockReturnValue({ running: false, ended: false, known: false });
});

describe('the meeting window', () => {
  it("names the meeting for its room, before joining and in the meeting's own conversation", () => {
    const room = { ...conversation('room-1'), title: 'Report Latency' };
    mockConversations.mockReturnValue({ activeConversation: room, selectConversation: mockSelect, channelMembers: [], conversations: [room] });
    const { rerender } = render(<MeetingWindow conversationId="room-1" />);
    expect(screen.getByTestId('room').dataset.title).toBe('Meeting in Report Latency');
    const meetingConv = { ...conversation('meet-1'), title: 'Meeting Room', meetingOf: 'room-1' };
    mockMeeting.mockReturnValue({ status: 'joined', conversationId: 'meet-1', roomConversationId: 'room-1' });
    mockConversations.mockReturnValue({ activeConversation: meetingConv, selectConversation: mockSelect, channelMembers: [], conversations: [room, meetingConv] });
    rerender(<MeetingWindow conversationId="room-1" />);
    expect(screen.getByTestId('room').dataset.title).toBe('Meeting in Report Latency');
  });

  it("DENY: a channel's Metadata naming another room neither names the meeting for it nor makes this window that room's", () => {
    const room = { ...conversation('room-1'), title: 'Report Latency' };
    const other = { ...conversation('other-1'), title: 'Payroll' };
    const meetingConv = { ...conversation('meet-1'), title: 'Meeting Room', meetingOf: 'other-1' };
    mockMeeting.mockReturnValue({ status: 'joined', conversationId: 'meet-1', roomConversationId: 'room-1' });
    mockConversations.mockReturnValue({ activeConversation: meetingConv, selectConversation: mockSelect, channelMembers: [], conversations: [room, other, meetingConv] });
    render(<MeetingWindow conversationId="room-1" />);
    expect(screen.getByTestId('room').dataset.title).toBe('Meeting in Report Latency');
    expect(mockAlias).toHaveBeenCalledWith(['room-1', 'meet-1', 'room-1']);
    expect(mockAlias.mock.calls.flat(2)).not.toContain('other-1');
  });

  it('shows the meeting conversation\'s chat once the join names it, and acts on that meeting from then on', async () => {
    mockConversations.mockReturnValue({ activeConversation: null, selectConversation: mockSelect, channelMembers: [], conversations: [] });
    const { rerender } = render(<MeetingWindow conversationId="room-1" />);
    await waitFor(() => expect(mockSelect).toHaveBeenCalledWith('room-1'));
    mockConversations.mockReturnValue({ activeConversation: conversation('room-1'), selectConversation: mockSelect, channelMembers: [], conversations: [] });
    rerender(<MeetingWindow conversationId="room-1" />);
    expect(screen.getByTestId('room').dataset.channel).toBe(`${APP}/channel/room-1`);

    mockMeeting.mockReturnValue({ status: 'joined', conversationId: 'meet-1' });
    rerender(<MeetingWindow conversationId="room-1" />);
    await waitFor(() => expect(mockSelect).toHaveBeenCalledWith('meet-1'));
    mockConversations.mockReturnValue({ activeConversation: conversation('meet-1'), selectConversation: mockSelect, channelMembers: [], conversations: [] });
    rerender(<MeetingWindow conversationId="room-1" />);
    // The chat is the meeting's, and so is what the room acts on: an end ends this meeting, wherever it was entered from.
    expect(screen.getByTestId('room').dataset.channel).toBe(`${APP}/channel/meet-1`);
    expect(screen.getByTestId('room').dataset.chat).toBe('yes');
  });

  it("never shows the room's chat as the meeting's: no chat before the meeting names its conversation, then the meeting's", async () => {
    mockConversations.mockReturnValue({ activeConversation: conversation('room-1'), selectConversation: mockSelect, channelMembers: [], conversations: [] });
    const { rerender } = render(<MeetingWindow conversationId="room-1" />);
    expect(screen.getByTestId('room').dataset.chat).toBe('no');
    // The start answers while the session is still connecting: the meeting's conversation is opened at once.
    mockMeeting.mockReturnValue({ status: 'joining', conversationId: 'meet-1' });
    rerender(<MeetingWindow conversationId="room-1" />);
    await waitFor(() => expect(mockSelect).toHaveBeenCalledWith('meet-1'));
    expect(screen.queryByTestId('room')?.dataset.chat ?? 'no').toBe('no');
    mockConversations.mockReturnValue({ activeConversation: conversation('meet-1'), selectConversation: mockSelect, channelMembers: [], conversations: [] });
    rerender(<MeetingWindow conversationId="room-1" />);
    expect(screen.getByTestId('room').dataset.chat).toBe('yes');
  });

  it("shows the chat of a meeting's own conversation opened from its link, before joining, as its status read says", () => {
    mockBefore.mockReturnValue({ running: true, ended: false, known: true, meetingConversationId: 'meet-1' });
    mockConversations.mockReturnValue({ activeConversation: conversation('meet-1'), selectConversation: mockSelect, channelMembers: [], conversations: [] });
    render(<MeetingWindow conversationId="meet-1" />);
    expect(screen.getByTestId('room').dataset.chat).toBe('yes');
  });

  it('DENY: a conversation whose Metadata alone calls it a meeting\u2019s shows no chat beside the meeting', () => {
    mockConversations.mockReturnValue({ activeConversation: { ...conversation('room-2'), meetingOf: 'room-1' }, selectConversation: mockSelect, channelMembers: [], conversations: [] });
    render(<MeetingWindow conversationId="room-2" />);
    expect(screen.getByTestId('room').dataset.chat).toBe('no');
  });

  it("follows a start again to the room's next meeting, held in a new conversation", async () => {
    mockConversations.mockReturnValue({ activeConversation: conversation('meet-1'), selectConversation: mockSelect, channelMembers: [], conversations: [] });
    const { rerender } = render(<MeetingWindow conversationId="meet-1" />);
    mockMeeting.mockReturnValue({ status: 'joined', conversationId: 'meet-2' });
    rerender(<MeetingWindow conversationId="meet-1" />);
    await waitFor(() => expect(mockSelect).toHaveBeenCalledWith('meet-2'));
    expect(window.name).toBe('ae-meeting-meet-2');
    mockConversations.mockReturnValue({ activeConversation: conversation('meet-2'), selectConversation: mockSelect, channelMembers: [], conversations: [] });
    rerender(<MeetingWindow conversationId="meet-1" />);
    expect(screen.getByTestId('room').dataset.channel).toBe(`${APP}/channel/meet-2`);
    window.name = '';
  });

  it("stays on the meeting's own conversation once the meeting ends, so the room says it ended rather than offering a new one", async () => {
    mockConversations.mockReturnValue({ activeConversation: conversation('room-1'), selectConversation: mockSelect, channelMembers: [], conversations: [] });
    mockMeeting.mockReturnValue({ status: 'joined', conversationId: 'meet-1' });
    const { rerender } = render(<MeetingWindow conversationId="room-1" />);
    await waitFor(() => expect(mockSelect).toHaveBeenCalledWith('meet-1'));
    mockConversations.mockReturnValue({ activeConversation: conversation('meet-1'), selectConversation: mockSelect, channelMembers: [], conversations: [] });
    rerender(<MeetingWindow conversationId="room-1" />);
    mockSelect.mockClear();
    // The meeting ends: the session leaves and no longer names its conversation.
    mockMeeting.mockReturnValue({ status: 'idle' });
    rerender(<MeetingWindow conversationId="room-1" />);
    expect(screen.getByTestId('room').dataset.channel).toBe(`${APP}/channel/meet-1`);
    expect(mockSelect).not.toHaveBeenCalledWith('room-1');
  });

  it('offers the meeting from its link to someone not yet in its conversation, without its chat', async () => {
    mockSelect.mockRejectedValue(new Error('not a member'));
    mockConversations.mockReturnValue({ activeConversation: null, selectConversation: mockSelect, channelMembers: [], conversations: [] });
    render(<MeetingWindow conversationId="meet-1" />);
    await waitFor(() => expect(screen.getByTestId('room').dataset.channel).toBe(`${APP}/channel/meet-1`));
    expect(screen.getByTestId('room').dataset.chat).toBe('no');
  });

  it('keeps an open conversation as it is through a reconnect and a new conversation list', async () => {
    mockMeeting.mockReturnValue({ status: 'joined', conversationId: 'meet-1' });
    mockConversations.mockReturnValue({ activeConversation: conversation('meet-1'), selectConversation: mockSelect, channelMembers: [], conversations: [] });
    const { rerender } = render(<MeetingWindow conversationId="meet-1" />);
    const opened: string[] = [];
    for (const status of ['reconnecting', 'joined']) {
      mockMeeting.mockReturnValue({ status, conversationId: 'meet-1' });
      // Each page of the conversation list gives the provider a new selectConversation.
      mockConversations.mockReturnValue({ activeConversation: conversation('meet-1'), selectConversation: vi.fn(async (id: string) => { opened.push(id); }), channelMembers: [], conversations: [] });
      rerender(<MeetingWindow conversationId="meet-1" />);
    }
    expect(opened).toEqual([]);
  });

  it('does not re-render the chat when only the meeting changes', () => {
    mockMeeting.mockReturnValue({ status: 'joined', conversationId: 'meet-1' });
    mockConversations.mockReturnValue({ activeConversation: conversation('meet-1'), selectConversation: mockSelect, channelMembers: [], conversations: [] });
    const { rerender } = render(<MeetingWindow conversationId="meet-1" />);
    const before = chatRenders.mock.calls.length;
    mockMeeting.mockReturnValue({ status: 'joined', conversationId: 'meet-1', activeSpeaker: 'a-2' });
    rerender(<MeetingWindow conversationId="meet-1" />);
    expect(chatRenders.mock.calls.length).toBe(before);
  });

  it('shows the meeting roster and its chat together in the right column', () => {
    mockMeeting.mockReturnValue({ status: 'joined', conversationId: 'meet-1' });
    mockConversations.mockReturnValue({ activeConversation: conversation('meet-1'), selectConversation: mockSelect, channelMembers: [], conversations: [] });
    render(<MeetingWindow conversationId="meet-1" />);
    expect(screen.getByTestId('roster')).toBeTruthy();
    expect(chatRenders).toHaveBeenCalled();
  });

  it('goes by the name of its meeting once the meeting names its conversation', () => {
    mockMeeting.mockReturnValue({ status: 'joined', conversationId: 'meet-1' });
    mockConversations.mockReturnValue({ activeConversation: conversation('meet-1'), selectConversation: mockSelect, channelMembers: [], conversations: [] });
    render(<MeetingWindow conversationId="room-1" />);
    expect(window.name).toBe('ae-meeting-meet-1');
    window.name = '';
  });
});
