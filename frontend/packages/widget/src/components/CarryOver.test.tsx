/**
 * THE VISIT CARRIES OVER WITH NOTHING TO CLICK, AND THE CONTACT ROUTE: every state settled, localized and
 * accessible.
 *
 *  - A live guest session is never asked to keep anything: there is no "Keep this conversation" step. Under
 *    the conversation it shows what the deployment declares and the chat app it names allow, and nothing
 *    when it declares no path or names no chat app.
 *  - Path A: "Sign in" opens a tab at once, refreshes once for a sign-in hand-off, sends the tab to the
 *    chat app's sign-in with the hand-off's nonce in its fragment (never the refresh credential), and gives
 *    the hand-off's secret only to that tab, at the chat app's origin, for that nonce. A forwarded link has
 *    no tab behind it, so nothing answers it. The panel says the visit continues there, with a way to open
 *    the tab again and the way back.
 *  - Path B: the registration form in the conversation registers the visit with its guest token and the
 *    address the sign-in link goes to, and says where the link went, or that it goes once approved. The
 *    widget never holds a claim token. A refused registration is said beside the form, which keeps what
 *    was typed.
 *  - A paused or unavailable assistant names the host's declared contact route; a route of any other
 *    scheme is dropped.
 *  - Every one of these states renders in a second locale from that locale's strings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WidgetApp } from './WidgetApp';
import { Refusal } from './Refusal';
import { CarryOverBar, RegisterForm, SigningIn } from './CarryOver';
import { renderWidget } from '../test/render';
import { GuestVisit } from '../session/refreshLeader';
import { BIND_REQUEST, BIND_SECRET, handOffSecretHash, RegistrationRefusal } from '../session/upgrade';
import { contactRoute } from '../config';
import type { WidgetSession } from '../session/widgetSession';
import en from '../locales/en.json';

const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/c1';
const USER = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/visitor';
const REFRESH = 'refresh-credential-0123456789abcdef';

const NONCE = 'hand-off-nonce-0123456789abcdef';
const NEXT = 'refresh-credential-fedcba9876543210';

function liveVisit(refresh: ConstructorParameters<typeof GuestVisit>[1]['refresh'] = vi.fn()) {
  const visit = new GuestVisit('test', { refresh, channel: null, locks: null, storage: memoryStorage() });
  const now = Math.floor(Date.now() / 1000);
  visit.open({ guestToken: 'guest-token', guestTokenExpiresAt: now + 600, refreshToken: REFRESH, sessionEndsAt: now + 86400, channelArn: CHANNEL, userArn: USER });
  return visit;
}

function Conversation({ session }: { session: WidgetSession }) {
  return <p>conversation {session.channelArn.split('/').pop()}</p>;
}

/** A test locale with every key, marked so English cannot pass for it. */
const marked = JSON.parse(JSON.stringify(en), (_k, v) => (typeof v === 'string' ? `[xx] ${v}` : v));

beforeEach(() => {
  vi.stubEnv('VITE_GUEST_CAPTCHA_SITE_KEY', '1x00000000000000000000AA');
  vi.stubEnv('VITE_GUEST_NOTICE_VERSION', 'sample-1');
  vi.stubEnv('VITE_GUEST_UPGRADE_PATHS', 'bind,claim');
  vi.stubEnv('VITE_GUEST_SIGN_IN_URL', 'https://chat.example.com/');
});
afterEach(() => vi.unstubAllEnvs());

async function openReady(deps: Parameters<typeof WidgetApp>[0]['deps'] = {}) {
  const user = userEvent.setup();
  renderWidget(<WidgetApp mode="guest" deps={{ visit: liveVisit(), Conversation, ...deps }} />);
  await user.click(screen.getByRole('button', { name: 'Open the assistant' }));
  expect(await screen.findByText('conversation c1')).toBeInTheDocument();
  return user;
}

async function fillRegistration(user: ReturnType<typeof userEvent.setup>, name = ' Ada ', email = 'ada@example.com') {
  await user.click(screen.getByText(en.widget.carry.register.title));
  if (name) await user.type(screen.getByRole('textbox', { name: 'Name' }), name);
  if (email) await user.type(screen.getByRole('textbox', { name: 'Email' }), email);
}

describe('the visit carries over with nothing to click', () => {
  it('never asks the visitor to keep the conversation: the conversation, then what the deployment declares', async () => {
    await openReady();
    expect(screen.queryByRole('button', { name: /keep/i })).toBeNull();
    expect(screen.queryByText(/keep this conversation/i)).toBeNull();
    const carry = screen.getByRole('region', { name: en.widget.carry.label });
    expect(carry).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAccessibleDescription(en.widget.carry.signInHint);
    expect(screen.getByText(en.widget.carry.register.title)).toBeInTheDocument();
    // The conversation stays where it is while either is offered.
    expect(screen.getByText('conversation c1')).toBeInTheDocument();
  });

  it('offers only the declared path', async () => {
    vi.stubEnv('VITE_GUEST_UPGRADE_PATHS', 'claim');
    await openReady();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.getByText(en.widget.carry.register.title)).toBeInTheDocument();
  });

  it.each([['names no chat app to sign in at', 'VITE_GUEST_SIGN_IN_URL'], ['declares no path', 'VITE_GUEST_UPGRADE_PATHS']])('offers neither when the deployment %s', async (_why, unset) => {
    vi.stubEnv(unset, '');
    await openReady();
    expect(screen.queryByRole('region', { name: en.widget.carry.label })).toBeNull();
  });

  it('path A: signing in hands the visit off to the tab it opened, never the refresh credential, and says the visit continues there', async () => {
    const now = Math.floor(Date.now() / 1000);
    const refresh = vi.fn(async () => ({
      guestToken: 'guest-token-2', guestTokenExpiresAt: now + 600, refreshToken: NEXT, sessionEndsAt: now + 86400, channelArn: CHANNEL, userArn: USER, bindNonce: NONCE,
    }));
    const tab = { location: { href: '' }, postMessage: vi.fn(), close: vi.fn() };
    const openTab = vi.fn(() => tab as unknown as Window);
    const user = await openReady({ openTab, visit: liveVisit(refresh) });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    // Opened inside the click, before anything is asked of the server.
    expect(openTab).toHaveBeenNthCalledWith(1, 'about:blank');
    expect(await screen.findByRole('status')).toHaveTextContent('Continue in the new tab');
    // One refresh, with the hash of a secret this page keeps, minted the nonce the link carries.
    expect(refresh).toHaveBeenCalledWith(REFRESH, { bindSecretHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(tab.location.href).toBe(`https://chat.example.com/#bindNonce=${NONCE}`);
    expect(tab.location.href).not.toContain(REFRESH);
    expect(tab.location.href).not.toContain(NEXT);

    const ask = (data: unknown, origin: string, source: unknown) => {
      const e = new MessageEvent('message', { data, origin });
      Object.defineProperty(e, 'source', { value: source });
      window.dispatchEvent(e);
    };
    // NOT ANSWERED: another window, another origin, another nonce, another message.
    ask({ type: BIND_REQUEST, nonce: NONCE }, 'https://chat.example.com', { postMessage: vi.fn() });
    ask({ type: BIND_REQUEST, nonce: NONCE }, 'https://evil.example', tab);
    ask({ type: BIND_REQUEST, nonce: 'another' }, 'https://chat.example.com', tab);
    ask({ type: 'something-else', nonce: NONCE }, 'https://chat.example.com', tab);
    expect(tab.postMessage).not.toHaveBeenCalled();
    // ANSWERED: the tab it opened, at the chat app's origin, for this hand-off; the secret is the one hashed.
    ask({ type: BIND_REQUEST, nonce: NONCE }, 'https://chat.example.com', tab);
    expect(tab.postMessage).toHaveBeenCalledWith({ type: BIND_SECRET, nonce: NONCE, secret: expect.any(String) }, 'https://chat.example.com');
    const secret = (tab.postMessage.mock.calls[0] as unknown as [{ secret: string }])[0].secret;
    expect(await handOffSecretHash(secret)).toBe((refresh.mock.calls[0] as unknown as [string, { bindSecretHash: string }])[1].bindSecretHash);

    // "Open the sign-in page" opens the tab again through the widget, never as a plain link.
    expect(screen.queryByRole('link', { name: 'Open the sign-in page' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open the sign-in page' }));
    expect(openTab).toHaveBeenLastCalledWith(`https://chat.example.com/#bindNonce=${NONCE}`);
    // The conversation is not running while the visit is handed over, so nothing rotates the credential.
    expect(screen.queryByText('conversation c1')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back to the conversation' }));
    expect(screen.getByText('conversation c1')).toBeInTheDocument();
  });

  it('path A: a refresh that cannot hand off closes the tab it opened and says why', async () => {
    const refresh = vi.fn(async () => { throw new (await import('../session/personApi')).WidgetRefusal('revoked', 401); });
    const tab = { location: { href: '' }, postMessage: vi.fn(), close: vi.fn() };
    const user = await openReady({ openTab: () => tab as unknown as Window, visit: liveVisit(refresh) });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(tab.location.href).toBe('');
  });

  it('path B: the form in the conversation registers the visit and its address, and says where the link went', async () => {
    const openTab = vi.fn();
    const register = vi.fn(async () => ({ status: 'sent' as const }));
    const user = await openReady({ openTab, register });
    await fillRegistration(user);
    await user.type(screen.getByRole('textbox', { name: 'Company (optional)' }), 'Example Co');
    await user.click(screen.getByRole('button', { name: 'Send my link' }));
    expect(register).toHaveBeenCalledWith('guest-token', { name: 'Ada', company: 'Example Co' }, 'ada@example.com');
    expect(await screen.findByRole('status')).toHaveTextContent('We emailed a sign-in link to ada@example.com');
    // No tab opens and no token is handed anywhere: the link is in the email.
    expect(openTab).not.toHaveBeenCalled();
    expect(screen.getByText('conversation c1')).toBeInTheDocument();
  });

  it('path B, with approval declared: says the link goes once the details are reviewed', async () => {
    const register = vi.fn(async () => ({ status: 'awaiting-approval' as const }));
    const user = await openReady({ register });
    await fillRegistration(user);
    await user.click(screen.getByRole('button', { name: 'Send my link' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveAttribute('data-outcome', 'awaiting-approval');
    expect(status).toHaveTextContent('Once your details are reviewed');
  });

  it.each([
    ['invalid', en.widget.carry.register.refused.invalid],
    ['claimed', en.widget.carry.register.refused.claimed],
    ['unavailable', en.widget.carry.register.refused.unavailable],
    ['unsent', en.widget.carry.register.refused.unsent],
    ['network', en.widget.carry.register.refused.network],
  ] as const)('says a %s registration refusal beside the form, which keeps what was typed', async (code, text) => {
    const register = vi.fn(async () => { throw new RegistrationRefusal(code); });
    const user = await openReady({ register, openTab: vi.fn() });
    await fillRegistration(user, 'Ada');
    await user.click(screen.getByRole('button', { name: 'Send my link' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-code', code);
    expect(alert).toHaveTextContent(text);
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Ada');
  });
});

describe('the contact route', () => {
  it('is shown when the assistant is paused or unavailable, and never otherwise', () => {
    const { rerenderWidget } = renderWidget(<Refusal code="paused" contact="https://www.example.com/help" />);
    expect(screen.getByRole('link', { name: 'Contact us' })).toHaveAttribute('href', 'https://www.example.com/help');
    rerenderWidget(<Refusal code="unavailable" contact="mailto:help@example.com" onRetry={() => {}} />);
    expect(screen.getByRole('link', { name: 'Contact us' })).toHaveAttribute('href', 'mailto:help@example.com');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    rerenderWidget(<Refusal code="rate_limited" contact="https://www.example.com/help" onRetry={() => {}} />);
    expect(screen.queryByRole('link', { name: 'Contact us' })).toBeNull();
  });

  it('is read from the frame\'s URL, and only as an https, mailto or tel URL', () => {
    expect(contactRoute('?contact=https%3A%2F%2Fwww.example.com%2Fhelp')).toBe('https://www.example.com/help');
    expect(contactRoute('?contact=tel%3A%2B15555550100')).toBe('tel:+15555550100');
    expect(contactRoute('?contact=javascript%3Aalert(1)')).toBeNull();
    expect(contactRoute('?contact=http%3A%2F%2Fwww.example.com')).toBeNull();
    expect(contactRoute('')).toBeNull();
  });
});

describe('every state renders in a second locale', () => {
  const xx = { xx: { translation: marked } };

  it('signing in and leaving details', () => {
    renderWidget(<CarryOverBar paths={new Set(['bind', 'claim'])} onSignIn={() => {}} register={{ busy: false, onSubmit: () => {} }} />, 'xx', xx);
    expect(screen.getByRole('region', { name: '[xx] Continue from your own account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '[xx] Sign in' })).toBeInTheDocument();
    expect(screen.getByText('[xx] Leave your details')).toBeInTheDocument();
  });

  it('the registration, its refusal and its outcome', () => {
    const { rerenderWidget } = renderWidget(<RegisterForm busy={false} error="claimed" onSubmit={() => {}} />, 'xx', xx);
    expect(screen.getByRole('textbox', { name: '[xx] Name' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('[xx] This conversation was already carried into an account.');
    rerenderWidget(<RegisterForm busy={false} done={{ outcome: 'sent', email: 'ada@example.com' }} onSubmit={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('[xx] We emailed a sign-in link to ada@example.com');
  });

  it('the hand-over', () => {
    renderWidget(<SigningIn onOpen={() => {}} onBack={() => {}} />, 'xx', xx);
    expect(screen.getByRole('status')).toHaveTextContent('[xx] Continue in the new tab');
    expect(screen.getByRole('button', { name: '[xx] Open the sign-in page' })).toBeInTheDocument();
  });

  it('the contact route', () => {
    renderWidget(<Refusal code="paused" contact="https://www.example.com/help" />, 'xx', xx);
    expect(screen.getByRole('link', { name: '[xx] Contact us' })).toBeInTheDocument();
  });
});
