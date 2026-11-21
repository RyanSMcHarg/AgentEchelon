/**
 * THE IN-MEETING CHAT PANEL (SPEC-ASSISTANT-MEETINGS FR71):
 * the meeting conversation's own messages, drawn by the app's message list, and the app's composer posting to it; the
 * Chat toggle and T open and close it; the count of what arrived while it was closed, cleared on opening; and a
 * read-only composer once the conversation is archived.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@ae/shared/i18n';
import type { Message } from '@ae/shared';

const APP = 'arn:aws:chime:us-east-1:1:app-instance/abc';
const ME = `${APP}/user/me-sub`;
const ALICE = `${APP}/user/alice-sub`;
const MEETING_CONV = { id: 'meet-1', conversationArn: `${APP}/channel/meet-1`, title: 'Meeting Room', meetingOf: 'room-1', modelTier: 'premium' };

const sendMessage = vi.fn();
const state: { conversation: Record<string, unknown>; messages: Message[]; loading?: boolean } = { conversation: MEETING_CONV, messages: [] };
const conversations = () => ({
  activeConversation: state.conversation,
  messages: state.messages,
  isLoadingMessages: !!state.loading,
  isBotTyping: false,
  isSending: false,
  sendError: null,
  clearSendError: () => {},
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  channelMembers: [
    { userArn: ME, name: 'Me', isBot: false },
    { userArn: ALICE, name: 'Alice Cooper', isBot: false },
  ],
  stickyTarget: null,
  setStickyTarget: () => {},
  battleWaitingBots: [],
  openWorkItems: [],
  refreshOpenWorkItems: () => {},
  renameConversation: vi.fn(),
  archiveConversation: vi.fn(),
  selectConversation: vi.fn(),
  conversations: [],
});
vi.mock('../../providers/ConversationProvider.chime', () => ({ useConversations: () => conversations() }));
vi.mock('../../providers/AwsClientProvider', () => ({ useAwsClient: () => ({ userArn: ME, isInitialized: true, error: null }) }));
vi.mock('../../hooks/useConversationMeeting', () => ({ useConversationMeeting: () => ({}) }));
vi.mock('../../hooks/useTurnState', () => ({ useTurnState: () => ({ queuedIds: new Set<string>(), dispatchFailed: false }) }));
vi.mock('../../hooks/useAttachmentCapability', () => ({ useAttachmentCapability: () => ({ canAttach: undefined }) }));
vi.mock('../../services/meetingService', () => ({ isMeetingEnabled: () => false }));
vi.mock('../../services/channelBattleService', () => ({ getBattleConfig: () => Promise.resolve(null) }));
vi.mock('../../services/chimeService', () => ({ chimeService: { listModerators: () => Promise.resolve([]) } }));
vi.mock('../../services/attachmentService', () => ({ uploadFile: vi.fn() }));
vi.mock('../../services/messageLatencyTracker', () => ({ markMessageSent: () => {} }));
vi.mock('@ae/shared', async (orig) => ({
  ...(await orig<object>()),
  personApiServes: () => false,
  useAuth: () => ({ user: { id: 'me-sub', userArn: ME, email: 'me@example.com', isAdmin: false } }),
  trackEvent: () => {},
}));
vi.mock('../ChannelMembersPanel', () => ({ default: () => null }));
vi.mock('../ShareConversationModal', () => ({ default: () => null }));
vi.mock('../ArchiveConversationModal', () => ({ default: () => null }));
vi.mock('./MeetingInProgress', () => ({ default: () => null }));

import ConversationInterface from '../ConversationInterface';
import MessageInput from '../MessageInput';
import { MeetingChatPanel, MeetingChatProvider, MeetingChatToggle } from './MeetingChatPanel';

let at = 0;
const message = (id: string, content: string, from: string): Message => ({
  id,
  content,
  isBot: false,
  timestamp: new Date(Date.UTC(2026, 10, 12, 10, 0, at++)),
  sender: { arn: from, name: from === ME ? 'Me' : 'Alice Cooper' },
} as unknown as Message);

function Panel() {
  return (
    <MeetingChatProvider>
      <MeetingChatToggle />
      <MeetingChatPanel>
        <ConversationInterface inMeetingWindow />
        <MessageInput />
      </MeetingChatPanel>
    </MeetingChatProvider>
  );
}

const toggle = () => screen.getByTestId('meeting-chat-toggle');
const panel = () => screen.getByTestId('meeting-chat-panel');
const badge = () => screen.queryByTestId('meeting-chat-unread');
const textarea = () => document.querySelector('.message-textarea') as HTMLTextAreaElement;

beforeEach(() => {
  vi.clearAllMocks();
  sendMessage.mockResolvedValue(undefined);
  state.conversation = MEETING_CONV;
  state.messages = [message('m1', 'Agenda first, then the latency numbers', ALICE)];
  state.loading = false;
});

describe('the in-meeting chat panel', () => {
  it("shows the meeting conversation's messages, opened beside the meeting", () => {
    render(<Panel />);
    expect(panel().hidden).toBe(false);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(panel().textContent).toContain('Agenda first, then the latency numbers');
  });

  it("posts what is typed to the meeting's conversation through the app's composer", async () => {
    render(<Panel />);
    fireEvent.change(textarea(), { target: { value: 'Joining in a minute' } });
    await act(async () => { fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter' }); });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe('Joining in a minute');
    // The composer sends to the open conversation, which is the meeting's own.
    expect(state.conversation.conversationArn).toBe(`${APP}/channel/meet-1`);
  });

  it('counts what others post while it is closed, not what the viewer posts, and clears the count on opening', () => {
    const { rerender } = render(<Panel />);
    fireEvent.click(toggle());
    expect(panel().hidden).toBe(true);
    expect(badge()).toBeNull();

    state.messages = [...state.messages, message('m2', 'Numbers are in the doc', ALICE), message('m3', 'Thanks', ME)];
    rerender(<Panel />);
    state.messages = [...state.messages, message('m4', '@Me can you take this one?', ALICE)];
    rerender(<Panel />);
    expect(badge()?.textContent).toBe('2');
    // The count is in the button's own name, which is what assistive technology reads.
    expect(screen.getByRole('button', { name: 'Chat, 2 unread messages' })).toBe(toggle());

    fireEvent.click(toggle());
    expect(panel().hidden).toBe(false);
    expect(badge()).toBeNull();
    // Closed again, only what arrives after that counts.
    fireEvent.click(toggle());
    expect(badge()).toBeNull();
    state.messages = [...state.messages, message('m5', 'One more', ALICE)];
    rerender(<Panel />);
    expect(badge()?.textContent).toBe('1');
  });

  it('counts nothing a conversation already held when it finished loading, behind a closed chat', () => {
    const { rerender } = render(<Panel />);
    fireEvent.click(toggle());
    // The window moves to another conversation: the old list stays on screen while the new one loads.
    state.conversation = { ...MEETING_CONV, id: 'meet-2', conversationArn: `${APP}/channel/meet-2` };
    state.loading = true;
    rerender(<Panel />);
    // The load ends and its list arrives in the same render.
    state.loading = false;
    state.messages = [message('h1', 'Earlier in this meeting', ALICE), message('h2', 'And this too', ALICE)];
    rerender(<Panel />);
    expect(badge()).toBeNull();
    state.messages = [...state.messages, message('h3', 'New now', ALICE)];
    rerender(<Panel />);
    expect(badge()?.textContent).toBe('1');
  });

  it('opens and closes on T, and not while the person is typing', () => {
    render(<Panel />);
    fireEvent.keyDown(window, { key: 't' });
    expect(panel().hidden).toBe(true);
    fireEvent.keyDown(window, { key: 'T' });
    expect(panel().hidden).toBe(false);
    fireEvent.keyDown(textarea(), { key: 't' });
    expect(panel().hidden).toBe(false);
  });

  it('keeps the composer, and its draft, while closed and open again', () => {
    render(<Panel />);
    fireEvent.change(textarea(), { target: { value: 'half a thought' } });
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(textarea().value).toBe('half a thought');
  });

  it('turns read-only once the meeting ends and its conversation is archived', () => {
    const { rerender } = render(<Panel />);
    expect(textarea().disabled).toBe(false);
    state.conversation = { ...MEETING_CONV, archived: true };
    rerender(<Panel />);
    expect(textarea().disabled).toBe(true);
    expect(panel().textContent).toContain('This conversation is archived and read-only.');
    // The thread stays readable.
    expect(panel().textContent).toContain('Agenda first, then the latency numbers');
  });

  it('is the plain right column outside the meeting window', () => {
    render(<MeetingChatPanel><p>chat</p></MeetingChatPanel>);
    expect(screen.queryByTestId('meeting-chat-panel')).toBeNull();
    expect(document.querySelector('aside.ae-meeting-chat')?.textContent).toBe('chat');
  });
});

describe('the right column: the roster above, the chat in a panel of its own, resized from its edge', () => {
  beforeEach(() => { try { localStorage.removeItem('ae.meeting.sideWidth'); } catch { /* none kept */ } });

  const withRoster = () => render(
    <MeetingChatProvider>
      <MeetingChatPanel roster={<div data-testid="roster">People</div>}><p>chat</p></MeetingChatPanel>
    </MeetingChatProvider>,
  );

  it('shows the roster, the chat or both from the toggles at its top, and one always stays on', () => {
    withRoster();
    const people = screen.getByTestId('meeting-side-view-people');
    const chat = screen.getByTestId('meeting-side-view-chat');
    // Both at first, the roster outside the chat panel, and the chat panel has no header of its own.
    expect(people).toHaveAttribute('aria-pressed', 'true');
    expect(chat).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('meeting-chat-panel').contains(screen.getByTestId('roster'))).toBe(false);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('button', { name: /Hide chat/ })).toBeNull();
    // The chat alone: the roster hides, and the chat's toggle is the one left on, so it cannot be turned off.
    fireEvent.click(people);
    expect(screen.getByTestId('roster').parentElement!.hidden).toBe(true);
    expect(screen.getByTestId('meeting-chat-panel').hidden).toBe(false);
    expect(chat).toBeDisabled();
    // The roster alone.
    fireEvent.click(people);
    fireEvent.click(chat);
    expect(screen.getByTestId('meeting-chat-panel').hidden).toBe(true);
    expect(screen.getByTestId('roster').parentElement!.hidden).toBe(false);
    expect(screen.getByTestId('meeting-side').hidden).toBe(false);
    expect(people).toBeDisabled();
  });

  it('gives the roster or the chat more room from the line between them, and remembers the split', () => {
    try { localStorage.removeItem('ae.meeting.rosterShare'); } catch { /* none kept */ }
    withRoster();
    const line = screen.getByTestId('meeting-roster-chat-splitter');
    expect(line).toHaveAttribute('aria-orientation', 'horizontal');
    expect(line).toHaveAttribute('aria-valuenow', '40');
    fireEvent.keyDown(line, { key: 'ArrowDown' });
    expect(line).toHaveAttribute('aria-valuenow', '45');
    expect(localStorage.getItem('ae.meeting.rosterShare')).toBe('0.45');
    expect(screen.getByTestId('roster').parentElement!.style.flex).toBe('0 0 45%');
    fireEvent.keyDown(line, { key: 'End' });
    expect(line).toHaveAttribute('aria-valuenow', '85');
    fireEvent.keyDown(line, { key: 'Home' });
    expect(line).toHaveAttribute('aria-valuenow', '15');
    // Only while both show.
    fireEvent.click(screen.getByTestId('meeting-side-view-chat'));
    expect(screen.queryByTestId('meeting-roster-chat-splitter')).toBeNull();
  });

  it('resizes from the keyboard within its bounds, and remembers the width', () => {
    render(<MeetingChatProvider><MeetingChatPanel><p>chat</p></MeetingChatPanel></MeetingChatProvider>);
    const splitter = screen.getByRole('separator');
    expect(splitter).toHaveAttribute('aria-valuenow', '380');
    fireEvent.keyDown(splitter, { key: 'ArrowLeft' });
    expect(splitter).toHaveAttribute('aria-valuenow', '396');
    expect(localStorage.getItem('ae.meeting.sideWidth')).toBe('396');
    fireEvent.keyDown(splitter, { key: 'End' });
    expect(splitter).toHaveAttribute('aria-valuenow', '640');
    fireEvent.keyDown(splitter, { key: 'Home' });
    expect(splitter).toHaveAttribute('aria-valuenow', '280');
    expect(screen.getByTestId('meeting-side').style.getPropertyValue('--ae-meeting-side-width')).toBe('280px');
  });

  it('follows a drag as it moves, and remembers the width only when the drag is let go', () => {
    render(<MeetingChatProvider><MeetingChatPanel><p>chat</p></MeetingChatPanel></MeetingChatProvider>);
    const splitter = screen.getByRole('separator');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    fireEvent.pointerDown(splitter, { clientX: 900, pointerId: 1 });
    fireEvent.pointerMove(splitter, { clientX: 880, pointerId: 1 });
    fireEvent.pointerMove(splitter, { clientX: 850, pointerId: 1 });
    expect(splitter).toHaveAttribute('aria-valuenow', '430');
    expect(write).not.toHaveBeenCalled();
    fireEvent.pointerUp(splitter, { clientX: 850, pointerId: 1 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('ae.meeting.sideWidth', '430');
    write.mockRestore();
  });
});
