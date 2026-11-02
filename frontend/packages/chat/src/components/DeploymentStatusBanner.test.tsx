/**
 * THE PAUSED BANNER READS THE DEPLOYMENT'S STATE WHEN A PERSON ARRIVES OR RETURNS, NEVER ON A TIMER.
 *
 *  - It reads once on load.
 *  - It reads again when the tab becomes visible, the window takes focus, or the network returns, and
 *    shows what that read says.
 *  - Time passing alone reads nothing (tenet D6).
 *  - A hidden tab's visibility change reads nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '@ae/shared/locales/en.json';

let state: 'awake' | 'asleep' = 'awake';
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ state, changedAt: null }), { status: 200 }));

async function mount() {
  vi.resetModules();
  const { default: DeploymentStatusBanner } = await import('./DeploymentStatusBanner');
  const i18n = i18next.createInstance();
  void i18n.use(initReactI18next).init({ resources: { en: { translation: en } }, lng: 'en', initAsync: false });
  render(<I18nextProvider i18n={i18n}><DeploymentStatusBanner /></I18nextProvider>);
  await act(async () => { await Promise.resolve(); });
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('the paused banner', () => {
  beforeEach(() => {
    state = 'awake';
    fetchMock.mockClear();
    vi.stubEnv('VITE_SLEEP_MODE_ENABLED', 'true');
    vi.stubEnv('VITE_PERSON_API_URL', 'https://person.example.com');
    vi.stubEnv('VITE_PERSON_API_CAPABILITIES', 'core');
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('reads the state once on load', async () => {
    await mount();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0 as never])).toContain('/deployment/state');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('reads it again when the person comes back to the tab, and shows what it says', async () => {
    await mount();
    await settle();
    state = 'asleep';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('status')).toHaveTextContent(en.deployment.paused);
  });

  it('reads it on focus and when the network returns', async () => {
    await mount();
    await settle();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reads nothing while time passes, or when the tab is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'Date'] });
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
