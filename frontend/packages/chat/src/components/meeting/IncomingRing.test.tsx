/**
 * A MEETING RINGING (`IncomingRing.tsx`): Join opens its meeting window and answers the ring, Dismiss stops it, and a
 * ring the browser cannot sound yet starts its tones on the person's first click.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@ae/shared/i18n';
import en from '@ae/shared/locales/en.json';

const ROOM = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/room-1';
const mockDismiss = vi.fn();
vi.mock('../../providers/MessagingProvider', () => ({ useMessaging: () => ({ incomingRing: { channelArn: ROOM, endsAt: Date.now() + 10000 }, dismissRing: mockDismiss }) }));
vi.mock('../../providers/ConversationProvider.chime', () => ({ useConversations: () => ({ conversations: [{ conversationArn: ROOM, title: 'Checkout latency' }] }) }));
const mockOpen = vi.fn();
vi.mock('../../utils/meetingWindow', () => ({ openMeetingWindow: (...a: unknown[]) => mockOpen(...a) }));
vi.mock('../../services/meetingPresence', () => ({ ringInOneTab: (start: () => () => void) => start() }));

const resume = vi.fn(() => Promise.resolve());
class SuspendedAudio {
  state = 'suspended';
  currentTime = 0;
  destination = {};
  resume = resume;
  close = () => Promise.resolve();
  createOscillator = () => ({ frequency: {}, connect: () => ({ connect: () => undefined }), start: () => undefined, stop: () => undefined });
  createGain = () => ({ gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined } });
}

import IncomingRing from './IncomingRing';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('AudioContext', SuspendedAudio);
});

describe('a meeting ringing', () => {
  it('stops on Dismiss, without opening the meeting', () => {
    render(<IncomingRing />);
    screen.getByRole('button', { name: en.meeting.dismiss }).click();
    expect(mockDismiss).toHaveBeenCalledWith('ringDismissed');
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it('opens the meeting window on Join and answers the ring', () => {
    render(<IncomingRing />);
    screen.getByRole('button', { name: en.meeting.join }).click();
    expect(mockOpen).toHaveBeenCalledWith(ROOM);
    expect(mockDismiss).toHaveBeenCalledWith('ringAnswered');
  });

  it('shows at once and starts its sound on the first click where the browser holds sound until then', () => {
    render(<IncomingRing />);
    expect(screen.getByTestId('meeting-ring')).toBeInTheDocument();
    expect(resume).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pointerdown'));
    expect(resume).toHaveBeenCalled();
  });

  it("tries again on each later gesture, a phone's touchend and click included, until the sound runs, then stops listening", async () => {
    let made: SuspendedAudio | undefined;
    vi.stubGlobal('AudioContext', class extends SuspendedAudio { constructor() { super(); made = this; } });
    render(<IncomingRing />);
    // The browser did not count the first gesture: the sound stays held.
    window.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('touchend'));
    expect(resume).toHaveBeenCalledTimes(2);
    // A click it counts runs it.
    made!.state = 'running';
    window.dispatchEvent(new Event('click'));
    await Promise.resolve();
    const after = resume.mock.calls.length;
    window.dispatchEvent(new Event('keydown'));
    window.dispatchEvent(new Event('click'));
    expect(resume).toHaveBeenCalledTimes(after);
  });
});
