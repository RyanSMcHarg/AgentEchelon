import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@ae/shared/i18n';
import MeetingExperience from './MeetingExperience';
import { ALICE, BOB, at } from './meetingFixture';
import type { ExperienceIssue } from '../../services/meetingAnalyticsService';

const THRESHOLDS = { packetLossPct: 3, jitterMs: 30, roundTripMs: 300, sustainedSeconds: 30 };
const issue = (over: Partial<ExperienceIssue> & Pick<ExperienceIssue, 'kind' | 'personKey'>): ExperienceIssue => ({
  attendeeId: 'x', from: at(5), to: at(6), seconds: 60, peak: null, eventType: null, ...over,
});
const ISSUES: ExperienceIssue[] = [
  issue({ personKey: BOB, kind: 'packetLossReceive', from: at(5), to: at(5.75), seconds: 45, peak: 9.5 }),
  issue({ personKey: BOB, kind: 'roundTrip', from: at(6), to: at(7), seconds: 60, peak: 820 }),
  issue({ personKey: BOB, kind: 'deviceFailure', from: at(9), to: at(9), seconds: 0, eventType: 'audioInputFailed' }),
  issue({ personKey: BOB, kind: 'drop', from: at(14), to: null, seconds: null, eventType: 'AttendeeDropped' }),
  issue({ personKey: ALICE, kind: 'reconnect', from: at(3), to: at(3), seconds: 0, eventType: 'meetingReconnected' }),
];
const START = Date.parse(at(0));

describe('the experience issues at the top of a meeting', () => {
  it('lists each person with a poor stretch or moment by id, with what, when, how long and the worst reading', () => {
    render(<MeetingExperience experience={{ thresholds: THRESHOLDS, issues: ISSUES }} startedAt={START} onJump={vi.fn()} />);
    const people = screen.getAllByTestId('experience-person');
    expect(people.map((p) => p.getAttribute('data-person'))).toEqual([BOB, ALICE]);
    expect(people[0].textContent).toContain('4 issues');
    const items = within(people[0]).getAllByTestId('experience-item');
    expect(items[0].textContent).toContain('Audio lost receiving');
    expect(items[0].textContent).toContain('worst 9.5%');
    expect(items[0].textContent).toContain('+5m 00s');
    expect(items[0].textContent).toContain('for 45s');
    expect(items[1].textContent).toContain('worst 820 ms');
    expect(items[2].textContent).toContain('Device failed');
    expect(items[2].textContent).toContain('at that moment');
    expect(items[3].textContent).toContain('did not come back');
  });

  it('says what poor meant, from the thresholds the server judged against', () => {
    render(<MeetingExperience experience={{ thresholds: { ...THRESHOLDS, roundTripMs: 250 }, issues: [] }} startedAt={START} onJump={vi.fn()} />);
    const panel = screen.getByTestId('meeting-experience');
    expect(panel.textContent).toContain('packet loss over 3%');
    expect(panel.textContent).toContain('round trip over 250 ms');
    expect(panel.textContent).toContain('30s');
    expect(screen.getByTestId('experience-none')).toBeTruthy();
  });

  it('marks a failure or a drop apart from a degraded stretch, by a glyph as well as a color', () => {
    render(<MeetingExperience experience={{ thresholds: THRESHOLDS, issues: ISSUES }} startedAt={START} onJump={vi.fn()} />);
    const glyphs = screen.getAllByTestId('experience-glyph').map((g) => g.textContent);
    expect(glyphs).toEqual(['▲', '▲', '◆', '◆', '▲']);
  });

  it('jumps to an issue\'s moment from a click and from the keyboard', async () => {
    const onJump = vi.fn();
    render(<MeetingExperience experience={{ thresholds: THRESHOLDS, issues: ISSUES }} startedAt={START} onJump={onJump} />);
    fireEvent.click(screen.getAllByTestId('experience-item')[1]);
    expect(onJump).toHaveBeenLastCalledWith(ISSUES[1]);
    const user = userEvent.setup();
    screen.getAllByTestId('experience-item')[3].focus();
    await user.keyboard('{Enter}');
    expect(onJump).toHaveBeenLastCalledWith(ISSUES[3]);
    expect(screen.getAllByTestId('experience-item')[3].getAttribute('aria-label')).toContain('Dropped');
  });

  it('draws nothing where the answer carries no experience', () => {
    const { container } = render(<MeetingExperience startedAt={START} onJump={vi.fn()} />);
    expect(container.textContent).toBe('');
  });
});
