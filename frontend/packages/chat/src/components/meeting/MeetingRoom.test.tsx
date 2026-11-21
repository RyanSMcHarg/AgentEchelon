/**
 * MeetingRoom - render tests.
 *
 * These use the REAL locale file rather than a stub `t`, because the behavior under test IS the
 * lookup: the provider holds error CODES and this component is the only thing that turns one into a
 * sentence. A stubbed `t` would pass whether or not the key exists, which is the one failure that
 * matters here - a code with no entry renders as nothing, or as the code itself, on screen.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@ae/shared/i18n';
import en from '@ae/shared/locales/en.json';
import { setClassificationsForTest } from '@ae/shared/config/classifications.ts';
import { SAMPLE_CLASSIFICATIONS } from '@ae/shared/config/sampleClassifications.ts';
import MeetingRoom from './MeetingRoom';
import type { MeetingContextValue } from '../../providers/MeetingProvider';
import type { CaptionLine } from '../../services/meetingTranscription';

const mockEnabled = vi.fn();
vi.mock('../../services/meetingService', () => ({
  isMeetingEnabled: () => mockEnabled(),
  meetingService: {},
}));

const mockMeeting = vi.fn();
let mockCaptions: CaptionLine[] = [];
vi.mock('../../providers/MeetingProvider', () => ({
  useMeeting: () => mockMeeting(),
  useMeetingCaptions: () => mockCaptions,
}));

// WHAT THE SERVICE SAYS OF THE MEETING before this person is in it (`useConversationMeeting`).
const mockHere = vi.fn();
vi.mock('../../hooks/useConversationMeeting', () => ({ useConversationMeeting: () => mockHere() }));
// THE MEETING'S SIGNALS: only the request to speak, which the microphone sends while the service holds it.
const mockRequestToSpeak = vi.fn();
let mockSignalsPending = false;
vi.mock('../../providers/meetingSignals', () => ({ useMeetingSignals: () => ({ requestToSpeak: mockRequestToSpeak, speakRequestPending: mockSignalsPending, hostMuted: new Set(), poorSignal: new Set() }) }));
let mockElsewhere = false;
vi.mock('../../services/meetingPresence', () => ({
  watchMeetingPresenceAs: (_ids: readonly string[], on: (here: boolean) => void) => { if (mockElsewhere) on(true); return () => undefined; },
}));
// THE DEVICE CHECK: jsdom has no camera or microphone, so its one permission request would settle at once. A test that
// sets `mockAccess` holds the check where it says (`pending` until the browser answers), and the rest see the real hook.
let mockAccess: 'pending' | 'granted' | 'denied' | undefined;
vi.mock('../../hooks/useMeetingDevices', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../hooks/useMeetingDevices')>();
  return {
    ...real,
    useMeetingDevices: (opts?: Parameters<typeof real.useMeetingDevices>[0]) => {
      const devices = real.useMeetingDevices(opts);
      return mockAccess && opts?.preview ? { ...devices, access: mockAccess } : devices;
    },
  };
});
const runningHere = (over: Record<string, unknown> = {}) => ({ running: true, joinedHere: false, mayEnd: false, isHost: false, mayStart: false, ended: false, known: true, ...over });
const notRunningHere = (over: Record<string, unknown> = {}) => ({ running: false, joinedHere: false, mayEnd: false, isHost: false, mayStart: true, ended: false, known: true, ...over });

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/channel/c1';

function meetingState(over: Partial<MeetingContextValue> = {}): MeetingContextValue {
  return {
    status: 'idle',
    isHost: false,
    hostIds: [],
    mayEnd: false,
    attendees: [],
    leftPersonIds: [],
    transcribing: false,
    recording: false,
    mediaRecording: false,
    dismissError: vi.fn(),
    setTranscription: vi.fn(),
    tiles: [],
    muted: false,
    cameraOn: false,
    sharing: false,
    holdMicForNotice: vi.fn(() => () => undefined),
    mutedForNotice: false,
    start: vi.fn(),
    startNow: vi.fn(async () => true),
    startedHere: false,
    join: vi.fn(),
    leave: vi.fn(),
    end: vi.fn(),
    toggleMute: vi.fn(),
    mutedByHost: false,
    mutedByRoom: false,
    speakRequests: [],
    holdMute: vi.fn(),
    removedIds: [],
    audioVideo: () => null,
    videoSources: [],
    videoPolicy: () => null,
    toggleCamera: vi.fn(),
    deviceIds: {},
    chooseDevice: vi.fn(),
    toggleShare: vi.fn(),
    bindVideoElement: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  mockElsewhere = false;
  mockCaptions = [];
  mockEnabled.mockReturnValue(true);
  mockMeeting.mockReturnValue(meetingState());
  mockHere.mockReturnValue(notRunningHere());
});

describe('a deployment without meetings has no room', () => {
  it('renders nothing at all when the meeting API is not configured', () => {
    mockEnabled.mockReturnValue(false);
    const { container } = render(<MeetingRoom channelArn={CHANNEL} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('a control that failed mid-meeting', () => {
  it('says so over the video and can be put away, leaving the meeting running', () => {
    const dismissError = vi.fn();
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', errorCode: 'CAMERA_UNAVAILABLE', dismissError }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByRole('alert')).toHaveTextContent(en.meeting.errors.CAMERA_UNAVAILABLE);
    fireEvent.click(screen.getByTestId('meeting-error-dismiss'));
    expect(dismissError).toHaveBeenCalled();
  });
});

describe('an error code becomes a sentence, never a code', () => {
  it('renders the copy the locale file holds for a known code', () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'error', errorCode: 'NO_ACTIVE_MEETING' }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    // Asserted against the locale file rather than a copy of the sentence, so rewording the copy does
    // not break the test while a MISSING key still does.
    expect(screen.getByRole('alert')).toHaveTextContent(en.meeting.errors.NO_ACTIVE_MEETING);
    expect(screen.getByRole('alert').textContent).not.toContain('NO_ACTIVE_MEETING');
  });

  it('falls back to a real sentence for a code the locale file does not know', () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'error', errorCode: 'SOME_NEW_SERVER_CODE' }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(en.meeting.errors.JOIN_FAILED);
    // The raw code must never reach the screen.
    expect(alert.textContent).not.toContain('SOME_NEW_SERVER_CODE');
    expect(alert.textContent).not.toContain('meeting.errors');
  });

  it('covers every code the handler can return', () => {
    // THE HANDLER'S CODES, READ FROM meeting-api.ts ITSELF: every `code: '...'` it answers and every refusal its start
    // and open steps name, so a code added there without copy here fails this test rather than showing the generic
    // sentence. A code with no entry renders the fallback, which is survivable but says less than it could.
    const source = readFileSync(resolve(__dirname, '../../../../../../backend/lambda/src/meeting-api.ts'), 'utf8');
    const answered = [...source.matchAll(/\b(?:code: |refusal\(\d+, )'([A-Z_]+)'/g)].map((m) => m[1]);
    const refusals = [...source.matchAll(/type \w*Refusal = ([^;]+);/g)].flatMap((m) => [...m[1].matchAll(/'([A-Z_]+)'/g)].map((q) => q[1]));
    // The access check's codes, answered through a shared helper rather than spelled in the handler.
    const accessCodes = ['INVALID_CONVERSATION', 'NOT_CLEARED', 'UNAVAILABLE', 'NOT_A_PERSON_SESSION'];
    // Codes the room never shows: the analytics report's (the app sends its own attendee and JSON), a route the app does
    // not call, the creator's internal answer, which the handler turns into one of its own, and the admin console's end.
    const neverShown = new Set(['INVALID_ATTENDEE', 'NOT_YOUR_ATTENDEE', 'INVALID_BODY', 'NOT_FOUND', 'FAILED', 'NOT_RUNNING']);
    const handlerCodes = [...new Set([...answered, ...refusals, ...accessCodes])].filter((c) => !neverShown.has(c));
    // The discovery reads the file it means to: the codes a start can be refused with are among them.
    expect(handlerCodes).toEqual(expect.arrayContaining(['MEETING_STARTING', 'CONVERSATION_NOT_OPENED', 'NOT_ADMITTED', 'MEETING_RACE']));
    const missing = handlerCodes.filter((c) => !(c in en.meeting.errors));
    expect(missing).toEqual([]);
  });

  it('has copy for the control that opens the room from the conversation header', () => {
    // The header button's visible label IS its aria-label, so a missing key puts the key itself on
    // screen and into the accessible name. It lives outside this component, which is why it is
    // asserted here rather than discovered by rendering the whole conversation view.
    expect(en.meeting.openTitle).toBeTruthy();
    expect(en.meeting.openTitle).not.toContain('meeting.');
  });
});

describe('the controls exist only while connected', () => {
  it('offers Start to its host before any meeting runs, no Join, and no device controls', () => {
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByRole('button', { name: en.meeting.start })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.meeting.join })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.meeting.mute })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.meeting.leave })).not.toBeInTheDocument();
  });

  it('offers Join while the meeting runs, and no Start', () => {
    mockHere.mockReturnValue(runningHere());
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByRole('button', { name: en.meeting.join })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.meeting.start })).not.toBeInTheDocument();
    // The pre-join screen offers End for everyone to nobody, a host included.
    expect(screen.queryByRole('button', { name: en.meeting.end })).not.toBeInTheDocument();
  });

  it('offers no Join for a meeting that has ended, says so, and offers Start again to its host only', () => {
    mockHere.mockReturnValue(notRunningHere({ ended: true, mayStart: false }));
    const { unmount } = render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByRole('status')).toHaveTextContent(en.meeting.ended);
    expect(screen.queryByRole('button', { name: en.meeting.join })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.meeting.startAgain })).not.toBeInTheDocument();
    unmount();
    mockHere.mockReturnValue(notRunningHere({ ended: true, mayStart: true }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByRole('button', { name: en.meeting.startAgain })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.meeting.join })).not.toBeInTheDocument();
  });

  it('tells a member who may not start it that its host starts it', () => {
    mockHere.mockReturnValue(notRunningHere({ mayStart: false }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByRole('status')).toHaveTextContent(en.meeting.waitingForHost);
    expect(screen.queryByRole('button', { name: en.meeting.start })).not.toBeInTheDocument();
  });

  it('never offers End for everyone before joining, even to its host: a host ends it from the Leave dialog or the conversation banner', () => {
    mockHere.mockReturnValue(runningHere({ mayEnd: true, isHost: true }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByText(en.meeting.host)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.meeting.join })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.meeting.end })).not.toBeInTheDocument();
  });

  it('offers Join again after this person left a meeting that still runs', () => {
    // After Leave the window's session is idle, and the service says the meeting runs.
    const join = vi.fn();
    mockMeeting.mockReturnValue(meetingState({ status: 'idle', join }));
    mockHere.mockReturnValue(runningHere());
    render(<MeetingRoom channelArn={CHANNEL} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.join }));
    expect(join).toHaveBeenCalledWith(CHANNEL);
  });

  it('offers the device controls once joined, and no join affordance', () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'joined' }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByRole('button', { name: en.meeting.mute })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.meeting.startVideo })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.meeting.share })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.meeting.leave })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.meeting.start })).not.toBeInTheDocument();
  });

  it('reflects live device state in the control labels and their pressed state', () => {
    mockMeeting.mockReturnValue(meetingState({
      status: 'joined', muted: true, cameraOn: true, sharing: true,
    }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByRole('button', { name: en.meeting.unmute }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: en.meeting.stopVideo })).toBeInTheDocument();
    // Stop sharing in the control bar, and again in the bar that says what is being shared.
    expect(screen.getAllByRole('button', { name: en.meeting.stopShare })).toHaveLength(2);
  });

  it("says what this person is sharing and whether its sound goes with it, with Stop sharing, while they stay in the meeting", () => {
    const toggleShare = vi.fn();
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', sharing: true, share: { surface: 'browser', audio: true }, toggleShare }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    const bar = screen.getByTestId('meeting-sharing-bar');
    expect(bar.textContent).toContain(en.meeting.sharingBar.browser);
    expect(bar.textContent).toContain(en.meeting.sharingBar.withAudio);
    within(bar).getByRole('button', { name: en.meeting.stopShare }).click();
    expect(toggleShare).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: en.meeting.leave })).toBeInTheDocument();
  });

  it("says on the share control what sharing with audio means", () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'joined' }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByRole('button', { name: en.meeting.share })).toHaveAttribute('title', en.meeting.shareHint);
  });

  it('starts the conversation\'s meeting the moment Start is pressed, passing the conversation and nothing else', () => {
    const startNow = vi.fn(async () => true);
    mockMeeting.mockReturnValue(meetingState({ startNow }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    screen.getByRole('button', { name: en.meeting.start }).click();
    expect(startNow).toHaveBeenCalledWith(CHANNEL);
  });

  it('joins a meeting this window started once the device check has settled, with no second press', () => {
    const start = vi.fn();
    mockMeeting.mockReturnValue(meetingState({ startedHere: true, start }));
    mockAccess = 'pending';
    try {
      const { rerender } = render(<MeetingRoom channelArn={CHANNEL} />);
      expect(screen.getByTestId('meeting-started-here')).toHaveTextContent(en.meeting.startedJoining);
      // The browser has not answered the permission request yet: nothing joins.
      expect(start).not.toHaveBeenCalled();
      mockAccess = 'granted';
      rerender(<MeetingRoom channelArn={CHANNEL} />);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith(CHANNEL);
      // No Start again: the meeting runs and this window is joining it.
      expect(screen.queryByRole('button', { name: en.meeting.start })).not.toBeInTheDocument();
    } finally { mockAccess = undefined; }
  });

  it('while a start waits on the device check, keeps Join within reach, and offers no End for everyone', () => {
    const start = vi.fn();
    const end = vi.fn(async () => true);
    mockMeeting.mockReturnValue(meetingState({ startedHere: true, mayEnd: true, start, end }));
    mockHere.mockReturnValue(runningHere());
    mockAccess = 'pending';
    try {
      render(<MeetingRoom channelArn={CHANNEL} onLeave={vi.fn()} />);
      // The check is still pending, so the start has not joined on its own.
      expect(start).not.toHaveBeenCalled();
      // Closing without joining stays possible beside Join, which a press takes at once.
      expect(screen.getByRole('button', { name: en.meeting.close })).toBeInTheDocument();
      const join = screen.getByRole('button', { name: en.meeting.join });
      expect(join).toBeEnabled();
      join.click();
      expect(start).toHaveBeenCalledWith(CHANNEL);
      expect(screen.queryByRole('button', { name: en.meeting.end })).not.toBeInTheDocument();
      expect(end).not.toHaveBeenCalled();
    } finally { mockAccess = undefined; }
  });

  it('says a kept start has ended once the service says its meeting no longer runs, and lets the start go', () => {
    const leave = vi.fn();
    mockMeeting.mockReturnValue(meetingState({ startedHere: true, leave }));
    mockHere.mockReturnValue(runningHere());
    const { rerender } = render(<MeetingRoom channelArn={CHANNEL} />);
    expect(leave).not.toHaveBeenCalled();
    // The service now says none runs: it was ended while this window waited.
    mockHere.mockReturnValue(notRunningHere());
    rerender(<MeetingRoom channelArn={CHANNEL} />);
    expect(leave).toHaveBeenCalledTimes(1);
    mockMeeting.mockReturnValue(meetingState({ startedHere: false, leave }));
    rerender(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByTestId('meeting-ended-note')).toHaveTextContent(en.meeting.ended);
    expect(screen.getByRole('button', { name: en.meeting.start })).toBeInTheDocument();
  });

  it('does not take a read from before the start for the meeting having ended', () => {
    const leave = vi.fn();
    mockMeeting.mockReturnValue(meetingState({ startedHere: true, leave }));
    mockHere.mockReturnValue(notRunningHere());
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(leave).not.toHaveBeenCalled();
    expect(screen.queryByTestId('meeting-ended-note')).toBeNull();
  });

  it('says the microphone is muted while a spoken notice plays, on the control and beside it, and still takes a mute', () => {
    const toggleMute = vi.fn();
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', mutedForNotice: true, toggleMute }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByTestId('meeting-muted-for-notice')).toHaveTextContent(en.meeting.mutedForNotice);
    const mic = screen.getByRole('button', { name: en.meeting.mute });
    expect(mic).toHaveAttribute('title', en.meeting.mutedForNotice);
    expect(mic.className).toContain('ae-mc-btn--held');
    mic.click();
    expect(toggleMute).toHaveBeenCalled();
  });

  it('keeps the bands of controls apart from the tiles, the view and full screen before them and the controls after', () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'joined' }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    const videoArea = screen.getByTestId('meeting-video');
    expect([...videoArea.children].map((el) => el.className.split(' ')[0])).toEqual(['ae-meeting-stage-top', 'ae-meeting-stage-wrap', 'ae-meeting-stage-bottom']);
  });

  it("puts every control over the video as an icon named in the reader's language, with the view, full screen and devices", () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', isHost: true }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    const video = screen.getByTestId('meeting-video');
    const bar = within(video).getByRole('toolbar', { name: en.meeting.controls });
    for (const name of [en.meeting.mute, en.meeting.startVideo, en.meeting.share, en.meeting.transcription.turnOn, en.meeting.transcription.startRecording, en.meeting.leave]) {
      const button = within(bar).getByRole('button', { name });
      // An icon, not words: the name is its label, and it shows on hover.
      expect(button.textContent).toBe('');
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button).toHaveAttribute('title');
    }
    expect(within(video).getByRole('button', { name: en.meeting.layoutGrid })).toHaveAttribute('aria-pressed', 'true');
    expect(within(video).getByRole('button', { name: en.meeting.devices.title })).toBeInTheDocument();
  });
});

describe('reconnecting is still being in the meeting', () => {
  it('keeps the stage and the controls, and does not offer to start a meeting', () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'reconnecting' }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    // Dropping to the pre-join screen here would take the room away from somebody whose connection
    // is being restored, and offer them a "start meeting" button for the meeting they are in.
    expect(screen.getByRole('button', { name: en.meeting.leave })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.meeting.mute })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.meeting.start })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.meeting.join })).not.toBeInTheDocument();
  });

  it('says so, as a status rather than an alert: it is being handled', () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'reconnecting' }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByRole('status')).toHaveTextContent(en.meeting.reconnecting);
  });

  it('has copy for a connection given up on', () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'error', errorCode: 'CONNECTION_LOST' }));
    mockHere.mockReturnValue(runningHere());
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByRole('alert')).toHaveTextContent(en.meeting.errors.CONNECTION_LOST);
    // Back at the pre-join screen, where rejoining is possible.
    expect(screen.getByRole('button', { name: en.meeting.join })).toBeInTheDocument();
  });
});

describe('the boundary people are meeting inside is visible', () => {
  it('shows the classification the meeting was created under', () => {
    setClassificationsForTest(SAMPLE_CLASSIFICATIONS);
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', classification: 'premium' }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    // BY ITS DISPLAY NAME, never the classification's key.
    expect(screen.getByText('Confidential')).toBeInTheDocument();
    expect(screen.queryByText('premium')).not.toBeInTheDocument();
    setClassificationsForTest(null);
  });

  it('names the meeting by its title, and shows the classification only as a tag', () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', classification: 'premium' }));
    render(<MeetingRoom channelArn={CHANNEL} title="Meeting in Report Latency" />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Meeting in Report Latency');
    expect(screen.queryByText(/Meeting in premium/)).not.toBeInTheDocument();
  });

  it('shows no boundary chip before one is known, rather than an empty one', () => {
    const { container } = render(<MeetingRoom channelArn={CHANNEL} />);
    expect(container.querySelector('.ae-meeting-boundary')).toBeNull();
  });
});

describe('leaving the room', () => {
  it('can be closed before joining, without starting or joining a meeting', () => {
    const onLeave = vi.fn();
    const start = vi.fn();
    const join = vi.fn();
    mockMeeting.mockReturnValue(meetingState({ start, join }));
    render(<MeetingRoom channelArn={CHANNEL} onLeave={onLeave} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.close }));
    expect(onLeave).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });

  it('leaves at once for someone who may not end it, leaving the meeting running', () => {
    const leave = vi.fn();
    const end = vi.fn();
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', leave, end }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.leave }));
    expect(leave).toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('asks its host whether to leave or end it for everyone, and Leave leaves it running', () => {
    const leave = vi.fn();
    const end = vi.fn();
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', mayEnd: true, isHost: true, leave, end }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.leave }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.meeting.leaveDialog.leave }));
    expect(leave).toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  it('moves focus into the leave dialog, keeps Tab inside it, closes on Escape and gives focus back', () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', mayEnd: true, isHost: true }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    const leaveButton = screen.getByRole('button', { name: en.meeting.leave });
    leaveButton.focus();
    fireEvent.click(leaveButton);
    const dialog = screen.getByRole('alertdialog');
    const cancel = within(dialog).getByRole('button', { name: en.meeting.leaveDialog.cancel });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(within(dialog).getByRole('button', { name: en.meeting.end })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(leaveButton).toHaveFocus();
  });

  it('stays open when ending for everyone fails, because the meeting is still running', async () => {
    const onLeave = vi.fn();
    const end = vi.fn().mockResolvedValue(false);
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', mayEnd: true, end }));
    render(<MeetingRoom channelArn={CHANNEL} onLeave={onLeave} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.leave }));
    fireEvent.click(screen.getByRole('button', { name: en.meeting.end }));
    await waitFor(() => expect(end).toHaveBeenCalledWith(CHANNEL));
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('closes once the meeting has ended for everyone', async () => {
    const onLeave = vi.fn();
    const end = vi.fn().mockResolvedValue(true);
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', mayEnd: true, end }));
    render(<MeetingRoom channelArn={CHANNEL} onLeave={onLeave} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.leave }));
    fireEvent.click(screen.getByRole('button', { name: en.meeting.end }));
    await waitFor(() => expect(onLeave).toHaveBeenCalled());
  });
});

describe('leaving or ending never shows the join screen', () => {
  /** A session whose leave drops it to idle, as the provider's does, while the meeting still runs for the others. */
  function liveSession(over: Partial<MeetingContextValue> = {}) {
    let state = meetingState({ status: 'joined', mayEnd: true, isHost: true, ...over });
    const leave = vi.fn(() => { state = { ...state, status: 'idle' }; });
    state = { ...state, leave };
    mockMeeting.mockImplementation(() => state);
    mockHere.mockReturnValue(runningHere({ mayEnd: true, isHost: true }));
    return { leave, set: (next: Partial<MeetingContextValue>) => { state = { ...state, ...next }; } };
  }
  const noJoinScreen = () => {
    expect(screen.queryByRole('button', { name: en.meeting.join })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.meeting.start })).not.toBeInTheDocument();
    expect(screen.queryByTestId('meeting-prejoin-devices')).not.toBeInTheDocument();
  };

  it('goes from Leave straight to leaving, never through the join screen', () => {
    const { leave } = liveSession({ mayEnd: false, isHost: false });
    const onLeave = vi.fn();
    const { rerender } = render(<MeetingRoom channelArn={CHANNEL} onLeave={onLeave} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.leave }));
    rerender(<MeetingRoom channelArn={CHANNEL} onLeave={onLeave} />);
    expect(leave).toHaveBeenCalled();
    expect(onLeave).toHaveBeenCalled();
    noJoinScreen();
    expect(screen.getByTestId('meeting-departing')).toHaveTextContent(en.meeting.leaving);
  });

  it('goes from End for everyone straight to ending, never through the join screen, while the end is answered', async () => {
    let answer: (ended: boolean) => void = () => undefined;
    const { set } = liveSession();
    const end = vi.fn(() => { set({ status: 'idle' }); return new Promise<boolean>((r) => { answer = r; }); });
    set({ end });
    const onLeave = vi.fn();
    const { rerender } = render(<MeetingRoom channelArn={CHANNEL} onLeave={onLeave} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.leave }));
    fireEvent.click(screen.getByRole('button', { name: en.meeting.end }));
    rerender(<MeetingRoom channelArn={CHANNEL} onLeave={onLeave} />);
    noJoinScreen();
    expect(screen.getByTestId('meeting-departing')).toHaveTextContent(en.meeting.ending);
    answer(true);
    await waitFor(() => expect(onLeave).toHaveBeenCalled());
    noJoinScreen();
  });

  it('offers the meeting again when ending it for everyone fails, since it still runs', async () => {
    const { set } = liveSession();
    const end = vi.fn(async () => { set({ status: 'error', errorCode: 'END_FAILED' }); return false; });
    set({ end });
    render(<MeetingRoom channelArn={CHANNEL} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.leave }));
    fireEvent.click(screen.getByRole('button', { name: en.meeting.end }));
    await waitFor(() => expect(screen.queryByTestId('meeting-departing')).not.toBeInTheDocument());
    // Joining again is their choice: nothing rejoins on its own, and ending it is done from inside.
    expect(screen.getByRole('button', { name: en.meeting.join })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.meeting.end })).not.toBeInTheDocument();
  });
});

describe('everyone in the meeting, in either layout', () => {
  const people = [
    { attendeeId: 'a-1', personId: 'p-1' },
    { attendeeId: 'a-2', personId: 'p-2' },
    { attendeeId: 'a-3', personId: 'p-3' },
  ];
  const names: Record<string, string> = { 'p-1': 'Avery', 'p-2': 'Blake', 'p-3': 'Casey' };
  beforeEach(() => { try { localStorage.removeItem('ae.meeting.layout'); } catch { /* none kept */ } });

  it('gives every attendee a tile in the grid, named where their camera is off', () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', attendees: people, tiles: [{ tileId: 1, attendeeId: 'a-1', isLocal: false, isContent: false }] }));
    render(<MeetingRoom channelArn={CHANNEL} nameOf={(p) => names[p]} />);
    expect(screen.getAllByTestId('meeting-tile')).toHaveLength(3);
    expect(screen.getByText('Blake')).toBeInTheDocument();
    expect(screen.getByText('Casey')).toBeInTheDocument();
  });

  it('puts whoever is speaking on the stage in the speaker layout, the rest in the strip', () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', attendees: people, activeSpeaker: 'a-3' }));
    const { container } = render(<MeetingRoom channelArn={CHANNEL} nameOf={(p) => names[p]} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.layoutSpeaker }));
    const stage = container.querySelector('.ae-video-stage');
    expect(stage).toHaveTextContent('Casey');
    expect(container.querySelectorAll('.ae-video-strip [data-testid="meeting-tile"]')).toHaveLength(2);
  });

  it('puts a shared screen on the stage ahead of the speaker', () => {
    mockMeeting.mockReturnValue(meetingState({
      status: 'joined', attendees: people, activeSpeaker: 'a-3',
      tiles: [{ tileId: 9, attendeeId: 'a-1#content', isLocal: false, isContent: true }],
    }));
    const { container } = render(<MeetingRoom channelArn={CHANNEL} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.layoutSpeaker }));
    expect(container.querySelector('.ae-video-stage')).toHaveTextContent(en.meeting.sharedScreen);
  });

  it('remembers the layout the viewer chose', () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', attendees: people }));
    const first = render(<MeetingRoom channelArn={CHANNEL} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.layoutSpeaker }));
    first.unmount();
    const { container } = render(<MeetingRoom channelArn={CHANNEL} />);
    expect(container.querySelector('[data-layout="speaker"]')).not.toBeNull();
  });
});

// THE MEETING'S TRANSCRIPTION (FR28): what everyone in it sees and hears, and who may turn it on or off.
const mockAnnounce = vi.fn();
vi.mock('../../services/meetingTranscription', () => ({ announce: (...a: unknown[]) => mockAnnounce(...a) }));

describe('a transcribed meeting', () => {
  beforeEach(() => { mockEnabled.mockReturnValue(true); mockHere.mockReturnValue(runningHere()); mockAnnounce.mockReset(); });

  it('shows the indicator to every attendee, host or not, in the mode it is in', () => {
    for (const isHost of [false, true]) {
      mockMeeting.mockReturnValue(meetingState({ status: 'joined', isHost, transcribing: true, recording: true }));
      const { unmount } = render(<MeetingRoom channelArn={CHANNEL} />);
      const indicator = screen.getByTestId('meeting-transcribing');
      expect(indicator).toHaveTextContent(en.meeting.transcription.recordingOn);
      expect(indicator).toHaveAttribute('data-mode', 'recording');
      expect(indicator.className).toContain('ae-meeting-transcribing--recording');
      unmount();
    }
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', transcribing: true, recording: false }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByTestId('meeting-transcribing')).toHaveTextContent(en.meeting.transcription.on);
    expect(screen.getByTestId('meeting-transcribing')).toHaveAttribute('data-mode', 'captions');
  });

  it('shows no indicator while it is not transcribed, nor before joining', () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', transcribing: false }));
    const { unmount } = render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.queryByTestId('meeting-transcribing')).toBeNull();
    unmount();
    mockMeeting.mockReturnValue(meetingState({ status: 'idle', transcribing: true }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.queryByTestId('meeting-transcribing')).toBeNull();
  });

  it('shows every speaker\'s live captions while it is transcribed, by the names the room shows', () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', transcribing: true, recording: false }));
    mockCaptions = [{ resultId: 'r1', personId: 'p1', text: 'we ship friday', partial: false }, { resultId: 'r2', personId: 'p2', text: 'agre', partial: true }];
    render(<MeetingRoom channelArn={CHANNEL} nameOf={(p) => ({ p1: 'Hana', p2: 'Gus' } as Record<string, string>)[p]} />);
    const captions = screen.getByTestId('meeting-captions');
    expect(captions).toHaveTextContent('Hanawe ship friday');
    expect(captions).toHaveTextContent('Gusagre');
  });

  it('tells a person aloud on joining: the recording consent while it records, captions while captioned, nothing otherwise', () => {
    const cases: Array<[Partial<MeetingContextValue>, string | null]> = [
      [{ transcribing: true, recording: true }, en.meeting.transcription.recordingJoinNotice],
      [{ transcribing: true, recording: false }, en.meeting.transcription.captionsJoinNotice],
      [{ transcribing: false, recording: false }, null],
    ];
    for (const [state, said] of cases) {
      mockAnnounce.mockReset();
      mockMeeting.mockReturnValue(meetingState({ status: 'joined', ...state }));
      const { unmount } = render(<MeetingRoom channelArn={CHANNEL} />);
      if (said) expect(mockAnnounce).toHaveBeenCalledWith(said, expect.anything(), expect.any(Function));
      else expect(mockAnnounce).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('tells everyone in it aloud when recording starts and stops, and when captions start and stop', () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', transcribing: false }));
    const { rerender } = render(<MeetingRoom channelArn={CHANNEL} />);
    const step = (state: Partial<MeetingContextValue>, said: string) => {
      mockMeeting.mockReturnValue(meetingState({ status: 'joined', ...state }));
      rerender(<MeetingRoom channelArn={CHANNEL} />);
      expect(mockAnnounce).toHaveBeenLastCalledWith(said, expect.anything(), expect.any(Function));
    };
    step({ transcribing: true, recording: false }, en.meeting.transcription.captionsStartedNotice);
    step({ transcribing: true, recording: true }, en.meeting.transcription.recordingStartedNotice);
    step({ transcribing: true, recording: false }, en.meeting.transcription.recordingStoppedNotice);
    step({ transcribing: false, recording: false }, en.meeting.transcription.captionsStoppedNotice);
  });

  it('says audio and video are recorded, aloud and on the indicator, where recording keeps them (FR70)', () => {
    mockAnnounce.mockReset();
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', transcribing: true, recording: true, mediaRecording: true }));
    const { rerender } = render(<MeetingRoom channelArn={CHANNEL} />);
    expect(mockAnnounce).toHaveBeenCalledWith(en.meeting.transcription.recordingJoinNoticeMedia, expect.anything(), expect.any(Function));
    expect(screen.getByTestId('meeting-transcribing')).toHaveTextContent(en.meeting.transcription.recordingOnMedia);
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', transcribing: true, recording: false, mediaRecording: true }));
    rerender(<MeetingRoom channelArn={CHANNEL} />);
    expect(mockAnnounce).toHaveBeenLastCalledWith(en.meeting.transcription.recordingStoppedNotice, expect.anything(), expect.any(Function));
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', transcribing: true, recording: true, mediaRecording: true }));
    rerender(<MeetingRoom channelArn={CHANNEL} />);
    expect(mockAnnounce).toHaveBeenLastCalledWith(en.meeting.transcription.recordingStartedNoticeMedia, expect.anything(), expect.any(Function));
  });

  it('offers the captions and recording controls to a host only, and holds captions on while it records', () => {
    const setTranscription = vi.fn().mockResolvedValue(true);
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', isHost: false, transcribing: true, recording: true, setTranscription }));
    const { unmount } = render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.queryByRole('button', { name: en.meeting.transcription.stopRecording })).toBeNull();
    expect(screen.queryByRole('button', { name: en.meeting.transcription.turnOff })).toBeNull();
    unmount();
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', isHost: true, transcribing: true, recording: true, setTranscription }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByRole('button', { name: en.meeting.transcription.turnOff })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: en.meeting.transcription.stopRecording }));
    expect(setTranscription).toHaveBeenCalledWith({ recording: false });
  });
});

describe('a host\'s controls, as the person they act on sees them (SPEC-ASSISTANT-MEETINGS FR59)', () => {
  it('a microphone the service holds asks rather than unmutes: Ask to speak for a host hold, Request to unmute for the room rule', () => {
    const toggleMute = vi.fn();
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', muted: true, mutedByHost: true, toggleMute }));
    const view = render(<MeetingRoom channelArn={CHANNEL} />);
    const ask = screen.getByRole('button', { name: en.meeting.askToSpeak });
    expect(ask.getAttribute('title')).toBe(en.meeting.mutedByHostHint);
    expect(screen.getByText(en.meeting.mutedByHost)).toBeTruthy();
    fireEvent.click(ask);
    expect(mockRequestToSpeak).toHaveBeenCalledTimes(1);
    expect(toggleMute).not.toHaveBeenCalled();
    view.unmount();
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', muted: true, mutedByRoom: true, toggleMute }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.requestToUnmute }));
    expect(mockRequestToSpeak).toHaveBeenCalledTimes(2);
    expect(toggleMute).not.toHaveBeenCalled();
  });

  it('a request waiting on a host shows as asked, and cannot be sent twice', () => {
    mockSignalsPending = true;
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', muted: true, mutedByHost: true }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByRole('button', { name: en.meeting.askedToSpeak })).toBeDisabled();
    mockSignalsPending = false;
  });

  it('an unheld microphone mutes and unmutes as before', () => {
    const toggleMute = vi.fn();
    mockMeeting.mockReturnValue(meetingState({ status: 'joined', muted: true, toggleMute }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.unmute }));
    expect(toggleMute).toHaveBeenCalledTimes(1);
  });

  it('a person a host removed is told so as the room\'s state, not as an error, and is offered no Join', () => {
    mockMeeting.mockReturnValue(meetingState({ status: 'error', errorCode: 'REMOVED_FROM_MEETING' }));
    mockHere.mockReturnValue(runningHere());
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByRole('status')).toHaveTextContent(en.meeting.removedByHost);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: en.meeting.join })).toBeNull();
  });

  it('the status read saying the reader was removed offers no Join either', () => {
    mockHere.mockReturnValue(runningHere({ removed: true }));
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByRole('status')).toHaveTextContent(en.meeting.removedByHost);
    expect(screen.queryByRole('button', { name: en.meeting.join })).toBeNull();
  });
});

describe('a meeting this person is already in from another window', () => {
  it('says so, and offers Join here rather than a plain Join', () => {
    mockElsewhere = true;
    mockHere.mockReturnValue(runningHere());
    render(<MeetingRoom channelArn={CHANNEL} />);
    expect(screen.getByTestId('meeting-elsewhere')).toHaveTextContent(en.meeting.inAnotherWindow);
    expect(screen.getByRole('button', { name: en.meeting.joinHere })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.meeting.join })).not.toBeInTheDocument();
  });
});
