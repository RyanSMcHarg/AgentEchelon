/**
 * THE MEETING'S ROSTER lists the meeting conversation's people with their state in the meeting, and its assistants apart
 * (SPEC-ASSISTANT-MEETINGS FR54): joined, left (apart from never joined), not joined, or
 * removed; muted (by themselves, on join, or by a host), no audio connected, a poor network, speaking. A host alone sees
 * the controls (FR59), and each calls the meeting's signals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@ae/shared/i18n';

const mockMeeting = vi.fn();
vi.mock('../../providers/MeetingProvider', () => ({ useMeeting: () => mockMeeting() }));
const mockConversations = vi.fn();
vi.mock('../../providers/ConversationProvider.chime', () => ({ useConversations: () => mockConversations() }));
vi.mock('../../services/chimeService', () => ({ chimeService: { getUserArn: () => 'arn:app/user/me' } }));
const mockSignals = vi.fn();
vi.mock('../../providers/meetingSignals', () => ({ useMeetingSignals: () => mockSignals() }));
const mockAddress = vi.fn();
vi.mock('../../utils/composerRequests', () => ({ requestComposerAddress: (r: unknown) => mockAddress(r) }));

import MeetingRoster, { meetingRosterOf } from './MeetingRoster';

const members = [
  { userArn: 'arn:app/user/me', name: 'Ada', isBot: false },
  { userArn: 'arn:app/user/bo', name: 'Bo', isBot: false },
  { userArn: 'arn:app/user/cy', name: 'Cy', isBot: false },
  { userArn: 'arn:app/bot/advisor', name: 'Advisor', isBot: true },
];
const attendees = [
  { attendeeId: 'a-me', personId: 'me' },
  { attendeeId: 'a-bo', personId: 'bo', muted: true, weakSignal: true },
  { attendeeId: 'a-guest', personId: 'guest' },
];
const self = { muted: false, cameraOn: true, sharing: false, reconnecting: false };
const setSpeaking = vi.fn();
const remove = vi.fn();
const dismiss = vi.fn();
const signals = (over: Record<string, unknown> = {}) => ({
  speaking: new Set<string>(), poorSignal: new Set<string>(), hostMuted: new Set<string>(), removed: new Set<string>(),
  asking: new Set<string>(), setSpeaking, remove, dismiss, ...over,
});
const meeting = (over: Record<string, unknown> = {}) => ({
  status: 'joined', attendees, tiles: [], hostIds: [], leftPersonIds: [], muted: false, cameraOn: false, sharing: false, isHost: false, ...over,
});
const rowOf = (name: string) => screen.getAllByTestId('meeting-roster-person').find((r) => r.textContent?.includes(name))!;
const guestRow = () => screen.getAllByTestId('meeting-roster-person').find((r) => !/Ada|Bo|Cy|Di/.test(r.textContent || ''))!;

beforeEach(() => {
  vi.clearAllMocks();
  try { localStorage.clear(); } catch { /* none */ }
  mockConversations.mockReturnValue({ channelMembers: members });
  mockSignals.mockReturnValue(signals());
  mockMeeting.mockReturnValue(meeting());
});

describe('meetingRosterOf', () => {
  it('gives each person their live state, those in the meeting first, and lists assistants apart', () => {
    const { people, assistants } = meetingRosterOf({
      members, attendees, activeSpeaker: 'a-bo', selfId: 'me', self,
      speakingIds: new Set(['a-bo']), poorSignalIds: new Set(['a-bo']),
      tiles: [{ tileId: 1, attendeeId: 'a-bo#content', isLocal: false, isContent: true }],
    });
    expect(people.map((p) => p.personId)).toEqual(['guest', 'me', 'bo', 'cy']);
    const bo = people.find((p) => p.personId === 'bo')!;
    expect(bo).toMatchObject({ inMeeting: true, speaking: true, activeSpeaker: true, muted: true, sharing: true, camera: false, weakConnection: true, noAudio: false });
    const me = people.find((p) => p.personId === 'me')!;
    expect(me).toMatchObject({ isYou: true, inMeeting: true, camera: true, muted: false, noAudio: false });
    expect(people.find((p) => p.personId === 'cy')).toMatchObject({ inMeeting: false, speaking: false, camera: false, noAudio: false, left: false, removed: false });
    expect(people.find((p) => p.personId === 'guest')).toMatchObject({ inMeeting: true, noAudio: true });
    expect(assistants.map((a) => a.name)).toEqual(['Advisor']);
  });

  it('says a camera is on for everyone who publishes one, the people on another page of the grid included', () => {
    const { people } = meetingRosterOf({ members, attendees, selfId: 'me', self, tiles: [], videoSources: ['a-bo'] });
    expect(people.find((p) => p.personId === 'bo')).toMatchObject({ camera: true });
  });

  it('reads left apart from never joined, removed apart from both, and each only while they are away', () => {
    const { people } = meetingRosterOf({ members, attendees, selfId: 'me', self, tiles: [], leftIds: ['cy', 'bo'], removedIds: new Set(['cy']) });
    expect(people.find((p) => p.personId === 'cy')).toMatchObject({ inMeeting: false, removed: true, left: false });
    expect(people.find((p) => p.personId === 'bo')).toMatchObject({ inMeeting: true, left: false, removed: false });
  });
});

describe('each state renders', () => {
  it('those in the meeting in a list at the top, and the rest at the bottom, tagged Left or Removed where that is why', () => {
    mockConversations.mockReturnValue({ channelMembers: [...members, { userArn: 'arn:app/user/di', name: 'Di', isBot: false }, { userArn: 'arn:app/user/ed', name: 'Ed', isBot: false }] });
    mockMeeting.mockReturnValue(meeting({ leftPersonIds: ['cy'] }));
    mockSignals.mockReturnValue(signals({ removed: new Set(['ed']) }));
    render(<MeetingRoster />);
    const joined = screen.getByTestId('meeting-roster-joined');
    const away = screen.getByTestId('meeting-roster-away');
    expect(within(joined).getByText('Bo')).toBeTruthy();
    for (const name of ['Cy', 'Di', 'Ed']) expect(within(away).getByText(name)).toBeTruthy();
    // THE AWAY LIST COMES AFTER EVERY OTHER: it is the bottom of the roster, below those in the meeting and the assistants.
    const assistant = screen.getByTestId('meeting-roster-assistant');
    expect(within(assistant).getByText('Advisor')).toBeTruthy();
    expect(joined.compareDocumentPosition(away) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(assistant.compareDocumentPosition(away) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(away.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING).toBeFalsy();
    expect(rowOf('Cy').textContent).toContain('Left');
    // NEVER JOINED SAYS NOTHING MORE: the list's heading says it.
    expect(rowOf('Di').querySelector('.ae-meeting-roster-tag')).toBeNull();
    expect(rowOf('Ed').textContent).toContain('Removed');
    expect(guestRow().textContent).toContain('No audio connected');
    expect(rowOf('Bo').textContent).not.toContain('No audio connected');
  });

  it('shows the struck microphone for each kind of mute: self-muted, muted on join, and muted by a host', () => {
    mockMeeting.mockReturnValue(meeting({ muted: true, attendees: [...attendees, { attendeeId: 'a-cy', personId: 'cy', muted: false }] }));
    mockSignals.mockReturnValue(signals({ hostMuted: new Set(['cy']) }));
    render(<MeetingRoster />);
    // The viewer muted themselves; Bo joined muted, as the service reports; a host stopped Cy's audio.
    expect(within(rowOf('Ada')).getByLabelText('Muted')).toBeTruthy();
    expect(within(rowOf('Bo')).getByLabelText('Muted')).toBeTruthy();
    expect(within(rowOf('Cy')).getByLabelText('Muted by host')).toBeTruthy();
    expect(within(rowOf('Cy')).queryByTestId('mic-network')).toBeNull();
  });

  it('a poor network is its own red sign: shown alone with good mute state, and beside the mute when both hold', () => {
    mockMeeting.mockReturnValue(meeting({ attendees: [...attendees, { attendeeId: 'a-cy', personId: 'cy', muted: false }] }));
    mockSignals.mockReturnValue(signals({ poorSignal: new Set(['a-cy', 'a-bo']) }));
    render(<MeetingRoster />);
    expect(within(rowOf('Cy')).getByTestId('mic-network')).toBeTruthy();
    expect(within(rowOf('Cy')).queryByTestId('mic-muted')).toBeNull();
    expect(within(rowOf('Bo')).getByTestId('mic-network')).toBeTruthy();
    expect(within(rowOf('Bo')).getByTestId('mic-muted')).toBeTruthy();
  });

  it('muted with a good network shows the mute alone', () => {
    render(<MeetingRoster />);
    expect(within(rowOf('Bo')).getByTestId('mic-muted')).toBeTruthy();
    expect(within(rowOf('Bo')).queryByTestId('mic-network')).toBeNull();
  });

  it('marks speaking from the volume, and highlights the active speaker', () => {
    mockMeeting.mockReturnValue(meeting({ activeSpeaker: 'a-me' }));
    mockSignals.mockReturnValue(signals({ speaking: new Set(['a-me']) }));
    render(<MeetingRoster />);
    // SPEAKING IS A MICROPHONE THAT FLICKERS, not a word.
    expect(within(rowOf('Ada')).getByTestId('mic-speaking').className).toContain('ae-meeting-mic--speaking');
    expect(within(rowOf('Bo')).queryByTestId('mic-speaking')).toBeNull();
    // A MICROPHONE THAT IS ON SHOWS, DRAWN LIKE THE CAMERA; it flickers only while its person speaks.
    expect(within(rowOf('Ada')).getByTestId('mic-speaking').className).toContain('ae-meeting-activity');
    expect(rowOf('Ada').className).toContain('ae-meeting-roster-row--speaking');
    expect(rowOf('Bo').className).not.toContain('ae-meeting-roster-row--speaking');
  });

  it('shows a camera icon while a camera is on and a screen icon while sharing, each named for a screen reader', () => {
    mockMeeting.mockReturnValue(meeting({ cameraOn: true, tiles: [{ tileId: 1, attendeeId: 'a-bo#content', isLocal: false, isContent: true }] }));
    render(<MeetingRoster />);
    expect(within(rowOf('Ada')).getByLabelText('Camera on')).toBeTruthy();
    expect(within(rowOf('Bo')).getByLabelText('Sharing')).toBeTruthy();
    expect(within(rowOf('Bo')).queryByLabelText('Camera on')).toBeNull();
  });

  it('marks every host, and nobody else', () => {
    mockMeeting.mockReturnValue(meeting({ hostIds: ['bo', 'cy'] }));
    render(<MeetingRoster />);
    const hosted = screen.getAllByTestId('meeting-roster-person').filter((r) => r.textContent?.includes('Host'));
    expect(hosted).toHaveLength(2);
  });
});

describe('a host\'s controls', () => {
  it('a member who is not a host sees none: no host icon, and no mute or remove on any row', () => {
    render(<MeetingRoster />);
    expect(screen.queryByTestId('meeting-roster-host-controls')).toBeNull();
    expect(screen.queryByText('Mute')).toBeNull();
    expect(screen.queryByText('Remove')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /People/ }));
    expect(screen.queryAllByTestId('meeting-roster-person')).toHaveLength(0);
  });

  it('a host sees mute and remove for each person in the meeting who is not a host, and everyone\'s controls', () => {
    mockMeeting.mockReturnValue(meeting({ isHost: true, hostIds: ['me'] }));
    render(<MeetingRoster />);
    expect(within(rowOf('Bo')).getByText('Mute')).toBeTruthy();
    expect(within(rowOf('Bo')).getByText('Remove')).toBeTruthy();
    // Not the host themselves, and nobody away from the meeting.
    expect(within(rowOf('Ada')).queryByText('Mute')).toBeNull();
    expect(within(rowOf('Cy')).queryByText('Mute')).toBeNull();
    // Everyone's controls are behind one icon at the top of the roster.
    expect(screen.queryByText('Mute everyone')).toBeNull();
    fireEvent.click(screen.getByTestId('meeting-roster-host-controls'));
    fireEvent.click(screen.getByText('Mute everyone'));
    expect(setSpeaking).toHaveBeenCalledWith('all', false);
    fireEvent.click(screen.getByTestId('meeting-roster-host-controls'));
    fireEvent.click(screen.getByText('Let everyone speak'));
    expect(setSpeaking).toHaveBeenCalledWith('all', true);
  });

  it('mute, let speak and remove each call the meeting\'s controls, remove after a confirming click', () => {
    mockMeeting.mockReturnValue(meeting({ isHost: true, hostIds: ['me'] }));
    mockSignals.mockReturnValue(signals({ hostMuted: new Set(['guest']) }));
    render(<MeetingRoster />);
    fireEvent.click(within(rowOf('Bo')).getByText('Mute'));
    expect(setSpeaking).toHaveBeenCalledWith('bo', false);
    fireEvent.click(within(guestRow()).getByText('Let speak'));
    expect(setSpeaking).toHaveBeenCalledWith('guest', true);
    fireEvent.click(within(rowOf('Bo')).getByText('Remove'));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(rowOf('Bo')).getByText('Remove from meeting'));
    expect(remove).toHaveBeenCalledWith('bo');
  });

  it('says a refused control in words', () => {
    mockMeeting.mockReturnValue(meeting({ isHost: true, hostIds: ['me'] }));
    mockSignals.mockReturnValue(signals({ controlError: 'HOST_ONLY' }));
    render(<MeetingRoster />);
    expect(screen.getByRole('alert').textContent).toBe('Only a host of the meeting can do that.');
  });
});

describe('a person asking to speak', () => {
  it('a host sees who asks, with Allow and Dismiss, and each calls the meeting\'s controls', () => {
    mockMeeting.mockReturnValue(meeting({ isHost: true, hostIds: ['me'] }));
    mockSignals.mockReturnValue(signals({ asking: new Set(['bo']) }));
    render(<MeetingRoster />);
    const ask = screen.getByTestId('meeting-roster-ask');
    expect(ask.textContent).toContain('Bo asks to speak');
    fireEvent.click(within(ask).getByText('Allow'));
    expect(setSpeaking).toHaveBeenCalledWith('bo', true);
    fireEvent.click(within(ask).getByText('Dismiss'));
    expect(dismiss).toHaveBeenCalledWith('bo');
  });

  it('a member who is not a host sees no request', () => {
    mockSignals.mockReturnValue(signals({ asking: new Set(['bo']) }));
    render(<MeetingRoster />);
    expect(screen.queryByTestId('meeting-roster-ask')).toBeNull();
  });
});

describe('addressing a member from the roster', () => {
  it('clicking a person or an assistant mentions them in the chat, as the composer\'s own pick would', () => {
    render(<MeetingRoster />);
    fireEvent.click(within(rowOf('Bo')).getByRole('button', { name: 'Bo' }));
    expect(mockAddress).toHaveBeenCalledWith({ member: members[1], mode: 'mention' });
    fireEvent.click(within(screen.getByTestId('meeting-roster-assistant')).getByRole('button', { name: 'Advisor' }));
    expect(mockAddress).toHaveBeenCalledWith({ member: members[3], mode: 'mention' });
  });

  it('right-click offers Message privately, which starts a message to that member alone', () => {
    render(<MeetingRoster />);
    fireEvent.contextMenu(rowOf('Bo'));
    const menu = screen.getByTestId('meeting-roster-menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Message privately' }));
    expect(mockAddress).toHaveBeenCalledWith({ member: members[1], mode: 'private' });
    expect(screen.queryByTestId('meeting-roster-menu')).toBeNull();
  });

  it('the More button closes its own open menu with a mouse, rather than closing and opening it again', () => {
    render(<MeetingRoster />);
    const more = within(rowOf('Cy')).getByRole('button', { name: 'Options for Cy' });
    fireEvent.click(more);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(more);
    fireEvent.click(more);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('the same menu is reached from the keyboard, through the row\'s More button, and Escape closes it', () => {
    render(<MeetingRoster />);
    const more = within(rowOf('Cy')).getByRole('button', { name: 'Options for Cy' });
    fireEvent.click(more);
    const menu = screen.getByRole('menu', { name: 'Options for Cy' });
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps focus on the item the arrow keys chose while the roster re-renders, so Enter picks that item', () => {
    const { rerender } = render(<MeetingRoster />);
    fireEvent.click(within(rowOf('Cy')).getByRole('button', { name: 'Options for Cy' }));
    const menu = screen.getByRole('menu', { name: 'Options for Cy' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    const privately = within(menu).getByRole('menuitem', { name: 'Message privately' });
    expect(document.activeElement).toBe(privately);
    // The roster re-renders as the meeting changes: somebody starts speaking.
    mockSignals.mockReturnValue(signals({ speaking: new Set(['a-bo']) }));
    rerender(<MeetingRoster />);
    mockMeeting.mockReturnValue(meeting({ activeSpeaker: 'a-bo' }));
    rerender(<MeetingRoster />);
    expect(document.activeElement).toBe(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Message privately' }));
    fireEvent.click(document.activeElement as HTMLElement);
    expect(mockAddress).toHaveBeenCalledWith({ member: members[2], mode: 'private' });
  });

  it('says on the viewer\'s own row that a spoken notice holds their microphone', () => {
    mockMeeting.mockReturnValue(meeting({ mutedForNotice: true }));
    render(<MeetingRoster />);
    expect(within(rowOf('Ada')).getByRole('img', { name: 'Muted while the notice plays' })).toBeInTheDocument();
    expect(within(rowOf('Cy')).queryByRole('img', { name: 'Muted while the notice plays' })).toBeNull();
  });

  it('never offers to address the viewer themselves', () => {
    render(<MeetingRoster />);
    expect(within(rowOf('Ada')).queryByRole('button', { name: /Options for/ })).toBeNull();
  });
});
