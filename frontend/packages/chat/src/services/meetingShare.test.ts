/**
 * SHARING NEVER LOSES THE MEETING (`meetingShare.ts`): a cancelled or refused picker changes nothing, a share that
 * cannot start releases what was captured, and the meeting window keeps the focus where the browser lets it say so.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startScreenShare } from './meetingShare';

function stream(surface: string, audio: boolean) {
  const stop = vi.fn();
  const video = { stop, getSettings: () => ({ displaySurface: surface }) };
  const s = {
    getVideoTracks: () => [video],
    getAudioTracks: () => (audio ? [{ stop }] : []),
    getTracks: () => (audio ? [video, { stop }] : [video]),
  } as unknown as MediaStream;
  return { s, stop };
}

const named = (name: string) => Object.assign(new Error(name), { name });

afterEach(() => vi.unstubAllGlobals());

describe('sharing a screen from the meeting', () => {
  /** A clock on which the picker was open for `ms` before it answered. */
  const pickerOpenFor = (ms: number) => { let t = 0; return () => { const at = t; t += ms; return at; }; };

  it('changes nothing when the person dismisses the picker', async () => {
    const session = { startContentShare: vi.fn() };
    const out = await startScreenShare(session, { getDisplayMedia: vi.fn().mockRejectedValue(named('NotAllowedError')) }, () => true, pickerOpenFor(2_000));
    expect(out).toEqual({ kind: 'cancelled' });
    expect(session.startContentShare).not.toHaveBeenCalled();
  });

  it('says a refusal the operating system or the browser gave, after any time, as sharing that did not start', async () => {
    const refused = Object.assign(new Error('Permission denied by system'), { name: 'NotAllowedError' });
    const session = { startContentShare: vi.fn() };
    expect(await startScreenShare(session, { getDisplayMedia: vi.fn().mockRejectedValue(refused) }, () => true, pickerOpenFor(2_000))).toEqual({ kind: 'failed' });
    expect(session.startContentShare).not.toHaveBeenCalled();
  });

  it('says a refusal given before any picker could be answered as sharing that did not start', async () => {
    const out = await startScreenShare({ startContentShare: vi.fn() }, { getDisplayMedia: vi.fn().mockRejectedValue(named('NotAllowedError')) }, () => true, pickerOpenFor(20));
    expect(out).toEqual({ kind: 'failed' });
  });

  it("says sharing did not start where the page's permissions policy forbids capture, and opens no picker", async () => {
    vi.stubGlobal('document', { permissionsPolicy: { allowsFeature: (f: string) => f !== 'display-capture' } });
    const getDisplayMedia = vi.fn();
    expect(await startScreenShare({ startContentShare: vi.fn() }, { getDisplayMedia })).toEqual({ kind: 'failed' });
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('treats an aborted picker as a choice not to share', async () => {
    const out = await startScreenShare({ startContentShare: vi.fn() }, { getDisplayMedia: vi.fn().mockRejectedValue(named('AbortError')) });
    expect(out.kind).toBe('cancelled');
  });

  it('lets go of a pick answered after its session has gone, without sharing it', async () => {
    const { s, stop } = stream('monitor', true);
    const session = { startContentShare: vi.fn() };
    const out = await startScreenShare(session, { getDisplayMedia: vi.fn().mockResolvedValue(s) }, () => false);
    expect(out).toEqual({ kind: 'cancelled' });
    expect(session.startContentShare).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('says a picker that fails, without starting a share', async () => {
    const session = { startContentShare: vi.fn() };
    const out = await startScreenShare(session, { getDisplayMedia: vi.fn().mockRejectedValue(named('NotReadableError')) });
    expect(out).toEqual({ kind: 'failed' });
    expect(session.startContentShare).not.toHaveBeenCalled();
  });

  it('releases what was captured when the session cannot share it', async () => {
    const { s, stop } = stream('browser', true);
    const out = await startScreenShare({ startContentShare: vi.fn().mockRejectedValue(new Error('x')) }, { getDisplayMedia: vi.fn().mockResolvedValue(s) });
    expect(out).toEqual({ kind: 'failed' });
    expect(stop).toHaveBeenCalled();
  });

  it('reports what is shared and whether its sound goes with it', async () => {
    const { s } = stream('browser', true);
    const out = await startScreenShare({ startContentShare: vi.fn().mockResolvedValue(undefined) }, { getDisplayMedia: vi.fn().mockResolvedValue(s) });
    expect(out).toEqual({ kind: 'started', share: { surface: 'browser', audio: true } });
  });

  it('keeps the meeting window in front and leaves it out of the picker', async () => {
    const setFocusBehavior = vi.fn();
    vi.stubGlobal('CaptureController', class { setFocusBehavior = setFocusBehavior; });
    const getDisplayMedia = vi.fn().mockResolvedValue(stream('window', false).s);
    await startScreenShare({ startContentShare: vi.fn().mockResolvedValue(undefined) }, { getDisplayMedia });
    expect(setFocusBehavior).toHaveBeenCalledWith('focus-capturing-application');
    expect(getDisplayMedia.mock.calls[0][0]).toMatchObject({ selfBrowserSurface: 'exclude' });
    expect(getDisplayMedia.mock.calls[0][0].controller).toBeDefined();
  });
});
