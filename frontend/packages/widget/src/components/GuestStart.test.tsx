/**
 * Guest start in the widget: the notice before the first message, the captcha, guest start, and a
 * settled, localized state for every refusal it can give (A7, L16, D-4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WidgetApp } from './WidgetApp';
import { Refusal } from './Refusal';
import { renderWidget } from '../test/render';
import { GuestVisit } from '../session/refreshLeader';
import { WidgetRefusal, type GuestStart, type RefusalCode } from '../session/personApi';
import type { WidgetSession } from '../session/widgetSession';
import en from '../locales/en.json';

const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const emptyVisit = () => new GuestVisit('test', { refresh: vi.fn(), channel: null, locks: null, storage: memoryStorage() });

const started = (): GuestStart => {
  const now = Math.floor(Date.now() / 1000);
  return {
    guestToken: 'g', guestTokenExpiresAt: now + 600, refreshToken: 'r', sessionEndsAt: now + 86400,
    channelArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/c1',
    userArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/visitor',
    credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' },
    noticeVersion: 'sample-1',
  };
};

function Conversation({ session }: { session: WidgetSession }) {
  return <p>conversation {session.channelArn.split('/').pop()}</p>;
}

beforeEach(() => {
  vi.stubEnv('VITE_GUEST_CAPTCHA_SITE_KEY', '1x00000000000000000000AA');
  vi.stubEnv('VITE_GUEST_NOTICE_VERSION', 'sample-1');
});
afterEach(() => vi.unstubAllEnvs());

describe('guest start', () => {
  it('shows the notice before the first message, then starts the visit with its version and the captcha token', async () => {
    const user = userEvent.setup();
    const captcha = vi.fn(async () => 'captcha-token');
    const guestStart = vi.fn(async () => started());
    renderWidget(<WidgetApp mode="guest" deps={{ visit: emptyVisit(), captcha, guestStart, Conversation }} />);
    await user.click(screen.getByRole('button', { name: 'Open the assistant' }));
    expect(await screen.findByText('Before you start')).toBeInTheDocument();
    expect(screen.getByText('Notice sample-1')).toBeInTheDocument();
    expect(screen.queryByText(/conversation c1/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Start the conversation' }));
    expect(await screen.findByText('conversation c1')).toBeInTheDocument();
    expect(guestStart).toHaveBeenCalledWith('captcha-token', 'sample-1');
  });

  it('shows the captcha refusal, and never calls guest start, when the challenge fails', async () => {
    const user = userEvent.setup();
    const guestStart = vi.fn();
    renderWidget(<WidgetApp mode="guest" deps={{ visit: emptyVisit(), captcha: async () => { throw new Error('no'); }, guestStart, Conversation }} />);
    await user.click(screen.getByRole('button', { name: 'Open the assistant' }));
    await user.click(await screen.findByRole('button', { name: 'Start the conversation' }));
    expect(await screen.findByRole('alert')).toHaveAttribute('data-code', 'captcha_failed');
    expect(guestStart).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Before you start')).toBeInTheDocument();
  });

  it.each<[RefusalCode, number | undefined, string]>([
    ['paused', undefined, 'The assistant is paused'],
    ['rate_limited', 120, 'Try again in 120 seconds.'],
    ['captcha_failed', undefined, 'The check did not pass'],
    ['unavailable', undefined, 'The assistant is unavailable'],
  ])('settles a %s refusal into its own state', async (code, retry, text) => {
    const user = userEvent.setup();
    const guestStart = vi.fn(async () => { throw new WidgetRefusal(code, 429, retry); });
    renderWidget(<WidgetApp mode="guest" deps={{ visit: emptyVisit(), captcha: async () => 't', guestStart, Conversation }} />);
    await user.click(screen.getByRole('button', { name: 'Open the assistant' }));
    await user.click(await screen.findByRole('button', { name: 'Start the conversation' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-code', code);
    expect(alert).toHaveTextContent(text);
  });

  it('says the visitor cannot start here when the deployment declares no guest issuer', async () => {
    vi.stubEnv('VITE_GUEST_CAPTCHA_SITE_KEY', '');
    const user = userEvent.setup();
    renderWidget(<WidgetApp mode="guest" deps={{ visit: emptyVisit(), Conversation }} />);
    await user.click(screen.getByRole('button', { name: 'Open the assistant' }));
    expect(await screen.findByText(en.widget.noGuestStart)).toBeInTheDocument();
  });

  it('shows "opened elsewhere" with a way to start again when another tab replayed the visit', async () => {
    const user = userEvent.setup();
    const visit = new GuestVisit('test', { refresh: async () => { throw new WidgetRefusal('replayed', 401); }, channel: null, locks: null, storage: memoryStorage() });
    const now = Math.floor(Date.now() / 1000);
    visit.open({ guestToken: 'g', guestTokenExpiresAt: now - 1, refreshToken: 'r', sessionEndsAt: now + 86400, channelArn: started().channelArn, userArn: started().userArn });
    renderWidget(<WidgetApp mode="guest" deps={{ visit, Conversation }} />);
    await user.click(screen.getByRole('button', { name: 'Open the assistant' }));
    await expect(visit.guestToken()).rejects.toMatchObject({ code: 'replayed' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This conversation was opened elsewhere');
    await user.click(screen.getByRole('button', { name: 'Start a new conversation' }));
    expect(await screen.findByText('Before you start')).toBeInTheDocument();
  });
});

describe('every refusal is localized', () => {
  const CODES: RefusalCode[] = ['paused', 'rate_limited', 'captcha_failed', 'unavailable', 'network', 'invalid_request', 'replayed', 'revoked', 'expired', 'ended', 'not_provisioned', 'refused'];

  it('has a title and a body in English for every code', () => {
    for (const code of CODES) {
      const entry = (en.widget.refused as Record<string, { title?: string; body?: string }>)[code];
      expect({ code, title: !!entry?.title, body: !!entry?.body }).toEqual({ code, title: true, body: true });
    }
  });

  it('renders in a second locale from that locale\'s strings, not fixed English', () => {
    // A test locale with every refusal key, marked so English cannot pass for it.
    const marked = JSON.parse(JSON.stringify(en), (_k, v) => (typeof v === 'string' ? `[xx] ${v}` : v));
    renderWidget(<Refusal code="paused" />, 'xx', { xx: { translation: marked } });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('[xx] The assistant is paused');
    expect(alert.textContent).not.toMatch(/^The assistant/);
  });
});
