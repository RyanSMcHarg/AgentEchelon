/**
 * The invitation landing page (M-5, M-10, D-4): the token is read from the fragment and cleared from the
 * address bar; opening the page redeems nothing; a sign-in invitation sends its holder to sign in with the
 * token in that page's fragment; a link invitation solves the captcha, redeems once and opens the
 * conversation under a standing banner; and every refusal is a settled, localized state naming the inviter.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InvitationLanding, type InvitationLandingDeps } from './InvitationLanding';
import { renderWidget } from '../test/render';
import { InvitationRefusal, signInDestination, tokenFromFragment, type InvitationPeek, type InvitationRefusalCode } from '../session/invitationApi';
import type { WidgetSession } from '../session/widgetSession';
import en from '../locales/en.json';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';
const peeked = (over: Partial<InvitationPeek> = {}): InvitationPeek => ({
  status: 'pending', mode: 'sign-in', conversationName: 'Quarterly plan', inviterName: 'Riley', inviteeName: 'Jordan',
  expiresAt: 2_000_000_000, signInUrl: 'https://app.example.com', ...over,
});

function Conversation({ session }: { session: WidgetSession }) {
  return <p>conversation {session.channelArn.split('/').pop()} as {session.kind}</p>;
}

function deps(over: Partial<InvitationLandingDeps> = {}): InvitationLandingDeps & { cleared: ReturnType<typeof vi.fn> } {
  const cleared = vi.fn();
  return {
    readFragment: () => `#t=${TOKEN}`,
    clearFragment: cleared,
    peek: vi.fn(async () => peeked()),
    redeem: vi.fn(),
    navigate: vi.fn(),
    captcha: vi.fn(async () => 'captcha-token'),
    Conversation,
    ...over,
    cleared,
  } as never;
}

describe('the invitation landing page', () => {
  it('reads the token from the fragment, clears it, and redeems nothing by opening', async () => {
    const d = deps();
    renderWidget(<InvitationLanding deps={d} />);
    expect(await screen.findByRole('heading', { name: 'Riley invited you to "Quarterly plan"' })).toBeInTheDocument();
    expect(screen.getByText('You are invited as Jordan.')).toBeInTheDocument();
    expect(d.peek).toHaveBeenCalledWith(TOKEN);
    expect(d.cleared).toHaveBeenCalledTimes(1);
    expect(d.redeem).not.toHaveBeenCalled();
    expect(d.navigate).not.toHaveBeenCalled();
  });

  it('sends a sign-in invitation\'s holder to sign in, the token in that page\'s fragment', async () => {
    const user = userEvent.setup();
    const d = deps();
    renderWidget(<InvitationLanding deps={d} />);
    await user.click(await screen.findByRole('button', { name: 'Sign in to join' }));
    expect(d.navigate).toHaveBeenCalledWith(`https://app.example.com/#invitation=${TOKEN}`);
    expect(d.redeem).not.toHaveBeenCalled();
  });

  it('redeems a link invitation once after the captcha, and opens the conversation under the banner', async () => {
    const user = userEvent.setup();
    const now = Math.floor(Date.now() / 1000);
    const d = deps({
      peek: vi.fn(async () => peeked({ mode: 'link', linkAvailable: true, captchaSiteKey: '1x00000000000000000000AA', sessionMinutes: 15, signInUrl: undefined })),
      redeem: vi.fn(async () => ({
        credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' },
        userArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/invitee',
        channelArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/room-1',
        sessionEndsAt: now + 900, conversationName: 'Quarterly plan', inviterName: 'Riley',
      })),
    });
    renderWidget(<InvitationLanding deps={d} />);
    expect(await screen.findByText(/for 15 minutes, without signing in/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Join the conversation' }));
    expect(await screen.findByText('conversation room-1 as link')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(en.invitation.banner);
    expect(d.captcha).toHaveBeenCalledTimes(1);
    expect(d.redeem).toHaveBeenCalledWith(TOKEN, 'captcha-token');
  });

  it('settles a captcha that fails, and redeems nothing', async () => {
    const user = userEvent.setup();
    const d = deps({
      peek: vi.fn(async () => peeked({ mode: 'link', linkAvailable: true, captchaSiteKey: 'k' })),
      captcha: vi.fn(async () => { throw new Error('no'); }),
    });
    renderWidget(<InvitationLanding deps={d} />);
    await user.click(await screen.findByRole('button', { name: 'Join the conversation' }));
    expect(await screen.findByRole('alert')).toHaveAttribute('data-code', 'captcha_failed');
    expect(d.redeem).not.toHaveBeenCalled();
  });

  it.each<[InvitationRefusalCode, string]>([
    ['redeemed_elsewhere', 'Somebody joined with this link already. Ask Riley for a new invitation.'],
    ['revoked', 'It can no longer be used. Ask Riley if you still need to join.'],
    ['expired', 'Ask Riley for a new invitation.'],
    ['wrong_mode', 'Ask Riley for a new invitation.'],
    ['paused', 'Joining by link is paused right now. Please come back later.'],
    ['rate_limited', 'Too many invitations were opened from your network. Try again in 30 seconds.'],
  ])('settles a %s redemption refusal into its own state, naming the inviter', async (code, body) => {
    const user = userEvent.setup();
    const d = deps({
      peek: vi.fn(async () => peeked({ mode: 'link', linkAvailable: true })),
      redeem: vi.fn(async () => { throw new InvitationRefusal(code, 30); }),
    });
    renderWidget(<InvitationLanding deps={d} />);
    await user.click(await screen.findByRole('button', { name: 'Join the conversation' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-code', code);
    expect(alert).toHaveTextContent(body);
  });

  it.each<[InvitationPeek['status'], InvitationRefusalCode]>([
    ['redeemed', 'redeemed'], ['expired', 'expired'], ['revoked', 'revoked'],
  ])('shows an invitation that is %s as that state, with no Join', async (status, code) => {
    renderWidget(<InvitationLanding deps={deps({ peek: vi.fn(async () => peeked({ status })) })} />);
    expect(await screen.findByRole('alert')).toHaveAttribute('data-code', code);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('refuses a link this deployment cannot redeem, and a link with no token', async () => {
    renderWidget(<InvitationLanding deps={deps({ peek: vi.fn(async () => peeked({ mode: 'link', linkAvailable: false })) })} />);
    expect(await screen.findByRole('alert')).toHaveAttribute('data-code', 'wrong_mode');
  });

  it('knows nothing of a fragment with no token, and asks nothing', async () => {
    const d = deps({ readFragment: () => '#' });
    renderWidget(<InvitationLanding deps={d} />);
    expect(await screen.findByRole('alert')).toHaveAttribute('data-code', 'unknown');
    expect(d.peek).not.toHaveBeenCalled();
  });

  it('every refusal the page shows has its copy', () => {
    const codes: InvitationRefusalCode[] = ['expired', 'redeemed', 'revoked', 'redeemed_elsewhere', 'wrong_account', 'wrong_mode', 'ended', 'unknown', 'paused', 'rate_limited', 'captcha_failed', 'unavailable', 'network'];
    for (const c of codes) expect(Object.keys(en.invitation.refused)).toContain(c);
  });

  it('speaks a second locale', async () => {
    const fr = {
      invitation: {
        ...en.invitation,
        heading: '{{inviter}} vous invite à « {{conversation}} »',
        signInToJoin: 'Se connecter pour rejoindre',
      },
    };
    renderWidget(<InvitationLanding deps={deps()} />, 'fr', { fr: { translation: { ...en, ...fr } } });
    expect(await screen.findByRole('heading', { name: 'Riley vous invite à « Quarterly plan »' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Se connecter pour rejoindre' })).toBeInTheDocument();
  });
});

describe('the invitation link', () => {
  it('carries a token only in its fragment, and a sign-in destination carries it only in the chat app\'s', () => {
    expect(tokenFromFragment(`#t=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromFragment('#t=short')).toBe('');
    expect(tokenFromFragment('#t=<script>')).toBe('');
    expect(signInDestination('https://app.example.com/', TOKEN)).toBe(`https://app.example.com/#invitation=${TOKEN}`);
  });
});
