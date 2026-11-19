import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  conversationIdOf, isMeetingWindowLink, meetingLinkConversation, meetingWindowHref, meetingWindowName, meetingWindowRequest,
  aliasMeetingWindow, closeMeetingWindow, nameMeetingWindow, openMeetingWindow, unaliasMeetingWindow,
} from './meetingWindow';

describe('the meeting window', () => {
  beforeEach(() => { sessionStorage.clear(); });

  it('is addressed by the conversation id alone', () => {
    expect(meetingWindowHref('c-1')).toBe('?meeting=c-1');
    expect(conversationIdOf('arn:aws:chime:us-east-1:1:app-instance/i/channel/c-1')).toBe('c-1');
  });

  it('keeps the request through a sign-in that leaves the page', () => {
    expect(meetingWindowRequest('?meeting=c-1')).toBe('c-1');
    expect(meetingWindowRequest('')).toBe('c-1');
  });

  it('takes only an id, never a URL or another query', () => {
    expect(meetingWindowRequest('?meeting=https://evil.example')).toBeNull();
    expect(isMeetingWindowLink('?meeting=c-1')).toBe(true);
    expect(isMeetingWindowLink('?meeting=c-1&next=https://evil.example')).toBe(false);
    expect(isMeetingWindowLink('https://evil.example/?meeting=c-1')).toBe(false);
    expect(isMeetingWindowLink('?conversation=c-1')).toBe(false);
  });

  it('refuses, without throwing, a meeting link whose encoding does not decode', () => {
    expect(() => isMeetingWindowLink('?meeting=%zz')).not.toThrow();
    expect(isMeetingWindowLink('?meeting=%zz')).toBe(false);
    expect(meetingLinkConversation('?meeting=%E0%A4')).toBeNull();
    expect(meetingLinkConversation('?meeting=c%2D1')).toBe('c-1');
  });

  /** A window as `window.open` answers it: a fresh one is blank, an existing one shows the app. */
  const fakeWindow = (href: string) => ({ location: { href }, focus: vi.fn() });

  it('opens a new window for the meeting and sends it to the meeting', () => {
    const fresh = fakeWindow('about:blank');
    const open = vi.spyOn(window, 'open').mockReturnValue(fresh as unknown as Window);
    openMeetingWindow('arn:aws:chime:us-east-1:1:app-instance/i/channel/c-1');
    expect(open).toHaveBeenCalledWith('', 'ae-meeting-c-1', expect.stringContaining('popup'));
    expect(fresh.location.href).toBe('?meeting=c-1');
    open.mockRestore();
  });

  it('brings a window already in the meeting forward without reloading it', () => {
    const live = fakeWindow('https://app.example/?meeting=m-1');
    const open = vi.spyOn(window, 'open').mockReturnValue(live as unknown as Window);
    openMeetingWindow('arn:aws:chime:us-east-1:1:app-instance/i/channel/room-1', 'm-1');
    // Looked up by the meeting's own conversation, whichever conversation the person opened it from.
    expect(open).toHaveBeenCalledWith('', 'ae-meeting-m-1', expect.any(String));
    expect(live.location.href).toBe('https://app.example/?meeting=m-1');
    expect(live.focus).toHaveBeenCalled();
    open.mockRestore();
  });

  it('takes the meeting\'s name once it shows the meeting, so every way in finds it', () => {
    nameMeetingWindow('arn:aws:chime:us-east-1:1:app-instance/i/channel/m-1');
    expect(window.name).toBe(meetingWindowName('m-1'));
    window.name = '';
  });

  it("finds the window in a meeting from its room, so a ring's Join brings it forward rather than opening a second", () => {
    localStorage.clear();
    window.name = meetingWindowName('m-1');
    aliasMeetingWindow(['room-1', 'arn:aws:chime:us-east-1:1:app-instance/i/channel/m-1']);
    window.name = '';
    const live = fakeWindow('https://app.example/?meeting=m-1');
    const open = vi.spyOn(window, 'open').mockReturnValue(live as unknown as Window);
    openMeetingWindow('arn:aws:chime:us-east-1:1:app-instance/i/channel/room-1');
    expect(open).toHaveBeenCalledWith('', 'ae-meeting-m-1', expect.any(String));
    expect(live.focus).toHaveBeenCalled();
    // Once that window leaves the meeting, the room opens its own window again.
    window.name = meetingWindowName('m-1');
    unaliasMeetingWindow();
    window.name = '';
    openMeetingWindow('arn:aws:chime:us-east-1:1:app-instance/i/channel/room-1');
    expect(open).toHaveBeenLastCalledWith('', 'ae-meeting-room-1', expect.any(String));
    open.mockRestore();
  });

  it('gives up its name on leaving, so a window that becomes the app is never found as the meeting window', () => {
    window.name = meetingWindowName('m-1');
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    const assign = vi.fn();
    const location = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...location, pathname: '/', assign } });
    try {
      closeMeetingWindow();
      expect(window.name).toBe('');
      expect(assign).toHaveBeenCalledWith('/');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: location });
      close.mockRestore();
    }
  });
});
