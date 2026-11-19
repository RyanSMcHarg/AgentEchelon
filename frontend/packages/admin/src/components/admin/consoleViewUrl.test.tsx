/**
 * EVERY VIEW OF THE CONSOLE IS A URL (`consoleViewUrl.ts`).
 *
 * What it proves: a view's keys belong to its tab, and leaving the tab drops them; a change a person makes adds one history
 * entry however many keys it changes, and following the address adds none; Back hands the address back to the view; and
 * Effectiveness's four drill levels read and write as the keys say.
 */
import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import React, { useState } from 'react';
import {
  ALL_VIEW_KEYS, VIEW_KEYS_OF_TAB, effectivenessDrillFromUrl, effectivenessDrillParams, holdsViewOf, setViewParams, useUrlViews, viewParam, withOnlyViewsOf,
} from './consoleViewUrl';

describe('a view\'s keys belong to its tab', () => {
  it('leaving a tab drops what only it owns, and keeps what the next tab owns too', () => {
    expect(withOnlyViewsOf('effectiveness', '?admin=processes&process=p&processRun=a1b2c3d4e5f6&as=x')).toBe('?admin=processes&as=x');
    expect(withOnlyViewsOf('conversations', '?admin=meetings&meeting=m1&meetingDays=7')).toBe('?admin=meetings&meeting=m1&meetingDays=7');
    expect(withOnlyViewsOf('profiles', '?assistant=a&section=workflows&exp=e&expDrill=metrics:v')).toBe('?assistant=a&section=workflows');
  });

  it('says whether an address names a view inside a tab', () => {
    expect(holdsViewOf('profiles', '?admin=profiles&assistant=a')).toBe(true);
    expect(holdsViewOf('profiles', '?admin=profiles')).toBe(false);
    expect(holdsViewOf('processes', '?admin=processes&processRun=a1b2c3d4e5f6')).toBe(true);
  });

  it('every key is owned by some tab', () => {
    for (const k of ALL_VIEW_KEYS) expect(Object.values(VIEW_KEYS_OF_TAB).some((keys) => keys.includes(k))).toBe(true);
  });
});

describe('the address follows the view', () => {
  const Probe: React.FC<{ onApply: (v: Record<string, string | null>) => void }> = ({ onApply }) => {
    const [a, setA] = useState<string | null>(viewParam('a'));
    const [b, setB] = useState<string | null>(viewParam('b'));
    useUrlViews({ a, b }, (v) => { setA(v.a); setB(v.b); onApply(v); });
    return <button type="button" data-testid="both" onClick={() => { setA('1'); setB('2'); }}>{`${a}|${b}`}</button>;
  };

  it('one change of several keys is one history entry, and following the address adds none', () => {
    window.history.replaceState({}, '', '/?admin=x');
    const seen: Array<Record<string, string | null>> = [];
    const { getByTestId } = render(<Probe onApply={(v) => seen.push(v)} />);
    const before = window.history.length;
    act(() => { getByTestId('both').click(); });
    expect(window.history.length).toBe(before + 1);
    expect(new URLSearchParams(window.location.search).get('a')).toBe('1');
    expect(new URLSearchParams(window.location.search).get('b')).toBe('2');
    // BACK, as the browser takes it: the view takes the address, and writes nothing more.
    window.history.replaceState({}, '', '/?admin=x');
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(seen.at(-1)).toEqual({ a: null, b: null });
    expect(getByTestId('both').textContent).toBe('null|null');
    expect(window.history.length).toBe(before + 1);
  });

  it('writes nothing where the address already says it', () => {
    window.history.replaceState({}, '', '/?a=1');
    expect(setViewParams({ a: '1', b: null })).toBe(false);
    expect(setViewParams({ a: '2' }, { replace: true })).toBe(true);
    expect(viewParam('a')).toBe('2');
  });
});

describe('Effectiveness\'s drill levels', () => {
  it('each level reads back from the keys it writes', () => {
    const levels = [
      { level: 0 as const },
      { level: 1 as const, intent: 'billing', step: 'gather' },
      { level: 2 as const, intent: 'billing', delivery: 'direct' as const },
      { level: 3 as const, intent: 'billing', taskId: 't-1' },
    ];
    for (const d of levels) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(effectivenessDrillParams(d))) if (v) q.set(k, v);
      expect(effectivenessDrillFromUrl(`?${q}`)).toEqual(d);
    }
  });
});
