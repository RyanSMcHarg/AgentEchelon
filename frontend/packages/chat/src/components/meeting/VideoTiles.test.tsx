/**
 * A PERSON'S AUDIO SIGNS ON THEIR TILE, as on the roster (SPEC-ASSISTANT-MEETINGS FR54): muted, muted by a host, and a
 * network losing their audio, the viewer's own tile included; the active speaker's tile is ringed.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '@ae/shared/i18n';
import en from '@ae/shared/locales/en.json';

const mockMeeting = vi.fn();
vi.mock('../../providers/MeetingProvider', () => ({ useMeeting: () => mockMeeting() }));
const mockSignals = vi.fn();
vi.mock('../../providers/meetingSignals', () => ({ useMeetingSignals: () => mockSignals() }));

import VideoTiles from './VideoTiles';

describe('the tiles', () => {
  it('carry each person\'s mute, a host\'s mute and a poor network, and ring the active speaker', () => {
    mockMeeting.mockReturnValue({
      status: 'joined', tiles: [], activeSpeaker: 'a-cy', bindVideoElement: vi.fn(), muted: false, selfAttendeeId: 'a-me',
      attendees: [
        { attendeeId: 'a-me', personId: 'me' },
        { attendeeId: 'a-bo', personId: 'bo', muted: true },
        { attendeeId: 'a-cy', personId: 'cy', muted: false },
        { attendeeId: 'a-di', personId: 'di', muted: true },
      ],
    });
    mockSignals.mockReturnValue({ hostMuted: new Set(['di']), poorSignal: new Set(['a-me', 'a-cy']) });
    const names: Record<string, string> = { me: 'Ada', bo: 'Bo', cy: 'Cy', di: 'Di' };
    render(<VideoTiles nameOf={(id) => names[id]} />);
    const tileOf = (label: string) => screen.getAllByTestId('meeting-tile').find((t) => t.textContent?.includes(label))!;
    expect(within(tileOf('Bo')).getByLabelText('Muted')).toBeTruthy();
    expect(within(tileOf('Bo')).queryByTestId('mic-network')).toBeNull();
    expect(within(tileOf('Di')).getByLabelText('Muted by host')).toBeTruthy();
    expect(within(tileOf('Cy')).getByTestId('mic-network')).toBeTruthy();
    expect(within(tileOf('Cy')).queryByTestId('mic-muted')).toBeNull();
    // The viewer's own tile shows their own network.
    expect(within(tileOf(en.meeting.you)).getByTestId('mic-network').getAttribute('title')).toContain('your audio');
    expect(tileOf('Cy').className).toContain('ae-video-tile--speaking');
    expect(tileOf('Bo').className).not.toContain('ae-video-tile--speaking');
  });
});
