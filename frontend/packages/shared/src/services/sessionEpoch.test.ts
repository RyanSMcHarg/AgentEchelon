import { describe, it, expect, vi } from 'vitest';
import { currentSessionEpoch, endSessionEpoch, onSessionEnd } from './sessionEpoch';

describe('a session ending', () => {
  it('tells each holder how it ended, and a holder that stopped listening is not told', () => {
    const heard = vi.fn();
    const stop = onSessionEnd(heard);
    const before = currentSessionEpoch();
    endSessionEpoch('signed-out');
    endSessionEpoch();
    expect(heard.mock.calls).toEqual([['signed-out'], ['ended']]);
    expect(currentSessionEpoch()).toBe(before + 2);
    stop();
    endSessionEpoch('signed-out');
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
