/**
 * THE MEETING WINDOW ON A PHONE-WIDTH SCREEN: the video, the roster and the chat are panes, one on screen at a time,
 * reached by a swipe across the window or from the tab bar at its foot; at a wider width every column is on screen and
 * there is no tab bar.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@ae/shared/i18n';
import en from '@ae/shared/locales/en.json';
import type { Message } from '@ae/shared';
import type { MeetingContextValue } from '../../providers/MeetingProvider';

const APP = 'arn:aws:chime:us-east-1:1:app-instance/abc';
const ME = `${APP}/user/me-sub`;
const CHANNEL = `${APP}/channel/meet-1`;

vi.mock('../../services/meetingService', () => ({ isMeetingEnabled: () => true, meetingService: {} }));
const mockMeeting = vi.fn();
vi.mock('../../providers/MeetingProvider', () => ({ useMeeting: () => mockMeeting(), useMeetingCaptions: () => [] }));
vi.mock('../../hooks/useConversationMeeting', () => ({ useConversationMeeting: () => ({ running: true, known: true }) }));
vi.mock('../../providers/meetingSignals', () => ({ useMeetingSignals: () => ({ requestToSpeak: vi.fn(), speakRequestPending: false, hostMuted: new Set(), poorSignal: new Set() }) }));
vi.mock('../../services/meetingPresence', () => ({ watchMeetingPresenceAs: () => () => undefined }));
const state: { messages: Message[] } = { messages: [] };
vi.mock('../../providers/ConversationProvider.chime', () => ({
  useConversations: () => ({ activeConversation: { id: 'meet-1', conversationArn: CHANNEL, title: 'Meeting Room' }, messages: state.messages, isLoadingMessages: false }),
}));
vi.mock('../../providers/AwsClientProvider', () => ({ useAwsClient: () => ({ userArn: ME }) }));
vi.mock('./MeetingDevices', () => ({ MeetingDeviceMenu: () => null, MeetingPreJoin: () => null }));

import MeetingRoom from './MeetingRoom';
import { MeetingChatProvider } from './MeetingChatPanel';

const joined = (over: Partial<MeetingContextValue> = {}) => ({
  status: 'joined', isHost: false, hostIds: [], mayEnd: false, transcribing: false, recording: false, mediaRecording: false,
  muted: false, mutedForNotice: false, cameraOn: false, sharing: false, startedHere: false, mutedByHost: false, mutedByRoom: false,
  attendees: [{ attendeeId: 'a-1', personId: 'p1' }, { attendeeId: 'a-2', personId: 'p2' }], tiles: [], leftPersonIds: [],
  holdMicForNotice: () => () => undefined, toggleMute: vi.fn(), toggleCamera: vi.fn(), toggleShare: vi.fn(), leave: vi.fn(),
  bindVideoElement: vi.fn(), audioVideo: () => null, videoSources: [], videoPolicy: () => null,
  ...over,
} as unknown as MeetingContextValue);

/** The window's width, as the media query answers it. */
function width(narrow: boolean) {
  vi.stubGlobal('matchMedia', (media: string) => ({ matches: narrow, media, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

const message = (id: string, from: string): Message => ({
  id, content: 'hello', isBot: false, timestamp: new Date(Date.UTC(2026, 10, 13, 10, 0, Number(id.slice(1)))), sender: { arn: from, name: 'x' },
} as unknown as Message);

function Window() {
  return (
    <MeetingChatProvider>
      <MeetingRoom channelArn={CHANNEL} roster={<div data-testid="roster">People 2 of 3</div>} chat={<div data-testid="thread">thread</div>} />
    </MeetingChatProvider>
  );
}

const video = () => document.getElementById('ae-meeting-pane-video') as HTMLElement;
const people = () => document.getElementById('ae-meeting-pane-people') as HTMLElement;
const chat = () => screen.getByTestId('meeting-chat-panel');
const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });
const shown = () => [video(), people(), chat()].filter((el) => !el.hidden && !el.closest('[hidden]')).map((el) => el.id);

/** One finger across the body, from a point on `on`. */
function swipe(on: Element, dx: number, dy = 0) {
  fireEvent.touchStart(on, { touches: [{ clientX: 200, clientY: 300 }] });
  fireEvent.touchMove(on, { touches: [{ clientX: 200 + dx, clientY: 300 + dy }] });
  fireEvent.touchEnd(on, { changedTouches: [{ clientX: 200 + dx, clientY: 300 + dy }] });
}

beforeEach(() => {
  state.messages = [message('m1', `${APP}/user/alice`)];
  mockMeeting.mockReturnValue(joined());
  try { localStorage.clear(); } catch { /* none */ }
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('at a phone width', () => {
  beforeEach(() => width(true));

  it('shows the video alone at first, with a tab for each pane and no splitter or header chat button', () => {
    render(<Window />);
    expect(shown()).toEqual(['ae-meeting-pane-video']);
    const tabs = within(screen.getByRole('tablist', { name: en.meeting.panes.label })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([en.meeting.panes.video, en.meeting.panes.people, en.meeting.panes.chat]);
    expect(tab(en.meeting.panes.video)).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.queryByTestId('meeting-chat-toggle')).toBeNull();
  });

  it('shows one pane at a time from its tab, each pane labelled by its tab', () => {
    render(<Window />);
    fireEvent.click(tab(en.meeting.panes.people));
    expect(shown()).toEqual(['ae-meeting-pane-people']);
    expect(people()).toHaveAttribute('role', 'tabpanel');
    expect(people()).toHaveAttribute('aria-labelledby', tab(en.meeting.panes.people).id);
    expect(tab(en.meeting.panes.people)).toHaveAttribute('aria-controls', people().id);
    fireEvent.click(tab(en.meeting.panes.chat));
    expect(shown()).toEqual(['ae-meeting-chat-panel']);
    fireEvent.click(tab(en.meeting.panes.video));
    expect(shown()).toEqual(['ae-meeting-pane-video']);
    // The video keeps its elements while another pane is shown, so nothing rebinds on the way back.
    expect(screen.getByTestId('meeting-video')).toBeInTheDocument();
  });

  it('moves between the panes on a swipe across the window, and stops at either end', () => {
    render(<Window />);
    const body = document.querySelector('.ae-meeting-body') as HTMLElement;
    swipe(body, -90);
    expect(shown()).toEqual(['ae-meeting-pane-people']);
    swipe(body, -90);
    expect(shown()).toEqual(['ae-meeting-chat-panel']);
    swipe(body, -90);
    expect(shown()).toEqual(['ae-meeting-chat-panel']);
    swipe(body, 90);
    swipe(body, 90);
    expect(shown()).toEqual(['ae-meeting-pane-video']);
  });

  it('leaves the pane as it is for a touch that starts on a control, and for a scroll up or down', () => {
    render(<Window />);
    swipe(screen.getByRole('button', { name: en.meeting.mute }), -120);
    expect(shown()).toEqual(['ae-meeting-pane-video']);
    swipe(document.querySelector('.ae-meeting-body') as HTMLElement, -60, 240);
    expect(shown()).toEqual(['ae-meeting-pane-video']);
  });

  it('moves along the tab bar with the arrow keys, taking focus to the tab shown', () => {
    render(<Window />);
    const bar = screen.getByRole('tablist');
    tab(en.meeting.panes.video).focus();
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(shown()).toEqual(['ae-meeting-pane-people']);
    expect(document.activeElement).toBe(tab(en.meeting.panes.people));
    expect(tab(en.meeting.panes.video)).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(bar, { key: 'End' });
    expect(shown()).toEqual(['ae-meeting-chat-panel']);
  });

  it('counts on the Chat tab what arrives while another pane is shown, and clears it on showing the chat', () => {
    const { rerender } = render(<Window />);
    state.messages = [...state.messages, message('m2', `${APP}/user/alice`)];
    rerender(<Window />);
    expect(screen.getByTestId('meeting-pane-unread')).toHaveTextContent('1 unread message');
    fireEvent.click(tab(en.meeting.panes.chat));
    expect(screen.queryByTestId('meeting-pane-unread')).toBeNull();
  });

  it('the Video tab returns from the chat to the video, which takes the window', () => {
    render(<Window />);
    fireEvent.click(tab(en.meeting.panes.chat));
    fireEvent.click(tab(en.meeting.panes.video));
    expect(shown()).toEqual(['ae-meeting-pane-video']);
    expect(screen.getByTestId('meeting-side').hidden).toBe(true);
  });

  it('offers no screen share where the browser cannot share a screen', () => {
    render(<Window />);
    expect(screen.queryByRole('button', { name: en.meeting.share })).toBeNull();
  });

  it('has no tab bar for a room with no roster and no chat', () => {
    render(<MeetingChatProvider><MeetingRoom channelArn={CHANNEL} /></MeetingChatProvider>);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(video().hidden).toBe(false);
  });
});

describe('at a wider width', () => {
  beforeEach(() => width(false));

  it('shows every column at once, with the splitter and no tab bar, and a swipe changes nothing', () => {
    render(<Window />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByTestId('meeting-side-splitter')).toBeInTheDocument();
    expect(screen.getByTestId('meeting-roster-chat-splitter')).toBeInTheDocument();
    expect(shown()).toEqual(['ae-meeting-pane-video', 'ae-meeting-pane-people', 'ae-meeting-chat-panel']);
    expect(video()).not.toHaveAttribute('role');
    swipe(document.querySelector('.ae-meeting-body') as HTMLElement, -200);
    expect(shown()).toEqual(['ae-meeting-pane-video', 'ae-meeting-pane-people', 'ae-meeting-chat-panel']);
    expect(screen.getByRole('button', { name: en.meeting.share })).toBeInTheDocument();
  });
});
