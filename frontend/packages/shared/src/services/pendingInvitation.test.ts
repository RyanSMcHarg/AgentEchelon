// @vitest-environment jsdom
/**
 * A sign-in invitation carried from its landing page into the first sign-in (M-10): the token leaves the
 * address bar at once, is kept for this tab and presented once, on the first exchange; a refusal is
 * recorded for the app to show, and the person is still signed in as themselves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { exchange } = vi.hoisted(() => ({ exchange: vi.fn() }));
vi.mock('./credentialExchange', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./credentialExchange')>()),
  exchangeCredentials: exchange,
}));

import { capturePendingInvitation, restorePendingInvitation, takeInvitationOutcome, takePendingInvitation } from './pendingInvitation';
import { resolvePersonIdentity } from './personIdentity';
import { ExchangeRefusedError } from './credentialExchange';
import { endSessionEpoch } from './sessionEpoch';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';
const ARN = 'arn:aws:chime:us-east-1:111:app-instance/i/user/0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/room-1';
const answer = (extra: Record<string, unknown> = {}) => ({ credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' }, userArn: ARN, ...extra });
const fragment = (hash: string, search = '') => ({ hash, pathname: '/', search });

beforeEach(() => {
  sessionStorage.clear();
  exchange.mockReset();
  endSessionEpoch();
});

describe('capturing the invitation', () => {
  it('takes it out of the fragment and the address bar, and keeps it for the first exchange', () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    expect(capturePendingInvitation(fragment(`#invitation=${TOKEN}`))).toBe(true);
    expect(replace).toHaveBeenCalledWith(null, '', '/');
    expect(takePendingInvitation()).toBe(TOKEN);
    // Presented once.
    expect(takePendingInvitation()).toBeNull();
  });

  it('keeps nothing that is not a token, and nothing from a page with no invitation', () => {
    expect(capturePendingInvitation(fragment('#invitation=%3Cscript%3E'))).toBe(false);
    expect(capturePendingInvitation(fragment('#message=m1', '?conversation=c'))).toBe(false);
    expect(takePendingInvitation()).toBeNull();
  });
});

describe('the first exchange presents it', () => {
  it('binds the first sign-in and records the conversation it opened', async () => {
    capturePendingInvitation(fragment(`#invitation=${TOKEN}`));
    exchange.mockResolvedValue(answer({ invitationChannelArn: CHANNEL }));
    await expect(resolvePersonIdentity('id-token')).resolves.toMatchObject({ userArn: ARN });
    expect(exchange).toHaveBeenCalledWith({ invitation: TOKEN }, 'id-token');
    expect(takeInvitationOutcome()).toEqual({ joined: CHANNEL });
  });

  it('records a refusal and signs the person in as themselves', async () => {
    capturePendingInvitation(fragment(`#invitation=${TOKEN}`));
    exchange
      .mockRejectedValueOnce(new ExchangeRefusedError('this sign-in already has an account', 409, 'wrong_account'))
      .mockResolvedValue(answer());
    await expect(resolvePersonIdentity('id-token')).resolves.toMatchObject({ userArn: ARN });
    expect(exchange.mock.calls.map((c) => c[0])).toEqual([{ invitation: TOKEN }, {}]);
    // The invitation is kept in the outcome, so the app can offer to sign out and continue with a new account.
    expect(takeInvitationOutcome()).toEqual({ refused: 'wrong_account', retryToken: TOKEN });
    expect(takeInvitationOutcome()).toBeNull();
  });

  it('is pending again after sign out and continue, for the next sign-in, and binds nothing now', () => {
    restorePendingInvitation(TOKEN);
    expect(takePendingInvitation()).toBe(TOKEN);
    restorePendingInvitation('<script>');
    expect(takePendingInvitation()).toBeNull();
  });

  it('does not swallow an outage', async () => {
    capturePendingInvitation(fragment(`#invitation=${TOKEN}`));
    exchange.mockRejectedValue(new ExchangeRefusedError('down', 503));
    await expect(resolvePersonIdentity('id-token')).rejects.toThrow('down');
  });

  it('asks with an empty body when nothing is pending', async () => {
    exchange.mockResolvedValue(answer());
    await resolvePersonIdentity('id-token');
    expect(exchange).toHaveBeenCalledWith({}, 'id-token');
    expect(takeInvitationOutcome()).toBeNull();
  });
});
