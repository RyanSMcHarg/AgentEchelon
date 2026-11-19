/**
 * Which stopped sessions are rejoined, and how far apart the rejoins are (`meetingRecovery.ts`), against the real
 * Amazon Chime SDK status codes.
 */
import { describe, it, expect, vi } from 'vitest';
import { MeetingSessionStatus, MeetingSessionStatusCode } from 'amazon-chime-sdk-js';
import { rejoinDelayMs, resumePlayback, stopOutcome } from './meetingRecovery';

const outcomeOf = (code: MeetingSessionStatusCode) => stopOutcome(new MeetingSessionStatus(code));

describe('what a stop means', () => {
  it.each([
    MeetingSessionStatusCode.Left,
    MeetingSessionStatusCode.MeetingEnded,
    MeetingSessionStatusCode.AudioCallAtCapacity,
    MeetingSessionStatusCode.VideoCallAtSourceCapacity,
    MeetingSessionStatusCode.AudioJoinedFromAnotherDevice,
    MeetingSessionStatusCode.AudioAttendeeRemoved,
    MeetingSessionStatusCode.AudioAuthenticationRejected,
  ])('the person\'s outcome %i is left, never rejoined', (code) => {
    expect(outcomeOf(code)).toBe('leave');
  });

  it.each([
    MeetingSessionStatusCode.AudioDisconnected,
    MeetingSessionStatusCode.SignalingRequestFailed,
    MeetingSessionStatusCode.SignalingBadRequest,
    MeetingSessionStatusCode.RealtimeApiFailed,
    MeetingSessionStatusCode.TURNCredentialsForbidden,
    MeetingSessionStatusCode.SignalingChannelClosedUnexpectedly,
    MeetingSessionStatusCode.TaskFailed,
    MeetingSessionStatusCode.ConnectionHealthReconnect,
  ])('a connection stop %i is rejoined, the SDK\'s terminal transport stops included', (code) => {
    expect(outcomeOf(code)).toBe('rejoin');
  });

  it('a stop that is neither a failure nor final changes nothing', () => {
    expect(outcomeOf(MeetingSessionStatusCode.OK)).toBe('stay');
  });
});

describe('the pause before each rejoin attempt', () => {
  it('is the settle pause, then grows by one backoff step per failed attempt', () => {
    expect(rejoinDelayMs(1)).toBe(500);
    expect(rejoinDelayMs(2)).toBe(2500);
    expect(rejoinDelayMs(3)).toBe(4500);
  });
});

describe('resuming what the browser paused', () => {
  const element = (paused: boolean, bound: boolean) => {
    const el = document.createElement('audio');
    Object.defineProperty(el, 'paused', { get: () => paused });
    Object.defineProperty(el, 'srcObject', { value: bound ? {} : null });
    el.play = vi.fn(() => Promise.resolve());
    return el;
  };

  it('plays a paused element that has the meeting bound to it', () => {
    const el = element(true, true);
    resumePlayback(el);
    expect(el.play).toHaveBeenCalled();
  });

  it('leaves a playing element, an unbound one and a missing one alone', () => {
    const playing = element(false, true);
    const unbound = element(true, false);
    resumePlayback(playing);
    resumePlayback(unbound);
    resumePlayback(null);
    expect(playing.play).not.toHaveBeenCalled();
    expect(unbound.play).not.toHaveBeenCalled();
  });
});
