/**
 * WHAT AN INVITATION OR A KEPT VISIT CAME TO: one settled, localized state each, with what to do next.
 *
 *  - A visit kept: its conversation is open (path A's continuation, path B's claim). One whose
 *    conversation could not be opened yet offers "Try again", which makes the same call. A refusal names
 *    what to do (an existing account is pointed at path B), and an unknown code reads the generic line.
 *  - An invitation refused with `wrong_account` offers "Sign out and continue", carrying the invitation.
 *  - The paused-deployment banner reads its copy from the locale.
 *  - Every state renders in a second locale from that locale's strings.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '@ae/shared/locales/en.json';
import type { InvitationOutcome, UpgradeOutcome } from '@ae/shared';
import { ArrivalNotice } from './ArrivalNotice';

const marked = JSON.parse(JSON.stringify(en), (_k, v) => (typeof v === 'string' ? `[xx] ${v}` : v));
const ARN = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/continued-1';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';

function show(props: { invitation?: InvitationOutcome | null; upgrade?: UpgradeOutcome | null; retrying?: boolean }, lng: 'en' | 'xx' = 'en') {
  const i18n = i18next.createInstance();
  void i18n.use(initReactI18next).init({ resources: { en: { translation: en }, xx: { translation: marked } }, lng, fallbackLng: 'en', interpolation: { escapeValue: false }, initAsync: false });
  const handlers = { onRetry: vi.fn(), onSignOutAndContinue: vi.fn(), onDismiss: vi.fn() };
  render(
    <I18nextProvider i18n={i18n}>
      <ArrivalNotice invitation={props.invitation ?? null} upgrade={props.upgrade ?? null} retrying={props.retrying} {...handlers} />
    </I18nextProvider>,
  );
  return handlers;
}

describe('a visit kept from the widget', () => {
  it.each([
    [{ opened: ARN, path: 'bind' } as UpgradeOutcome, en.upgrade.opened.bind],
    [{ opened: ARN, path: 'claim' } as UpgradeOutcome, en.upgrade.opened.claim],
  ])('says the conversation continues here once it is open', (upgrade, text) => {
    show({ upgrade });
    expect(screen.getByRole('status')).toHaveTextContent(text);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('offers "Try again" when the conversation could not be opened yet, which makes the same call', () => {
    const { onRetry } = show({ upgrade: { pending: 'bind' } });
    expect(screen.getByRole('status')).toHaveTextContent(en.upgrade.pending.bind);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('says it is trying while the call is in flight', () => {
    show({ upgrade: { pending: 'claim' }, retrying: true });
    expect(screen.getByRole('button', { name: 'Trying again' })).toBeDisabled();
  });

  it.each(['SUBJECT_ALREADY_BOUND', 'GUEST_SESSION_NOT_LIVE', 'CLAIM_USED', 'CLAIM_EXPIRED', 'NOT_CLEARED_FOR_TARGET'] as const)('settles a %s refusal into its own state', (code) => {
    show({ upgrade: { refused: code, path: code.startsWith('CLAIM') || code === 'NOT_CLEARED_FOR_TARGET' ? 'claim' : 'bind' } });
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('data-code', code);
    expect(status).toHaveTextContent(en.upgrade.refused[code]);
  });

  it('reads the generic line for a code it has no copy for, never the code', () => {
    show({ upgrade: { refused: 'SOMETHING_NEW', path: 'bind' } });
    expect(screen.getByRole('status')).toHaveTextContent(en.upgrade.refused.unknown);
  });
});

describe('an invitation', () => {
  it('offers to sign out and continue with a new account on wrong_account, carrying the invitation', () => {
    const { onSignOutAndContinue } = show({ invitation: { refused: 'wrong_account', retryToken: TOKEN } });
    expect(screen.getByRole('status')).toHaveTextContent(en.invitation.refused.wrong_account);
    fireEvent.click(screen.getByRole('button', { name: en.invitation.signOutAndContinue }));
    expect(onSignOutAndContinue).toHaveBeenCalledWith(TOKEN);
  });

  it('offers no way on for a refusal that has none here', () => {
    show({ invitation: { refused: 'revoked' } });
    expect(screen.getByRole('status')).toHaveTextContent(en.invitation.refused.revoked);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([en.invitation.dismiss]);
  });
});

describe('in a second locale', () => {
  it('renders each state from that locale\'s strings', () => {
    show({ upgrade: { pending: 'bind' } }, 'xx');
    expect(screen.getByRole('status')).toHaveTextContent(`[xx] ${en.upgrade.pending.bind}`);
    expect(screen.getByRole('button', { name: '[xx] Try again' })).toBeInTheDocument();
  });

  it('renders the invitation\'s way on', () => {
    show({ invitation: { refused: 'wrong_account', retryToken: TOKEN } }, 'xx');
    expect(screen.getByRole('button', { name: `[xx] ${en.invitation.signOutAndContinue}` })).toBeInTheDocument();
  });
});

describe('the paused deployment', () => {
  it('reads its banner from the locale', async () => {
    vi.stubEnv('VITE_SLEEP_MODE_ENABLED', 'true');
    vi.stubEnv('VITE_PERSON_API_URL', 'https://person.example.com');
    vi.stubEnv('VITE_PERSON_API_CAPABILITIES', 'core');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ state: 'asleep', changedAt: null }), { status: 200 })));
    vi.resetModules();
    const { default: DeploymentStatusBanner } = await import('./DeploymentStatusBanner');
    const i18n = i18next.createInstance();
    void i18n.use(initReactI18next).init({ resources: { xx: { translation: marked } }, lng: 'xx', initAsync: false });
    render(<I18nextProvider i18n={i18n}><DeploymentStatusBanner /></I18nextProvider>);
    expect(await screen.findByRole('status')).toHaveTextContent(`[xx] ${en.deployment.paused}`);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
});
