/**
 * AN INVITATION LANDS IN THE CHAT APP (SPEC-CONVERSATION-TYPES FR25, M-5, M-10): the chat app serves the landing
 * page every invitation's link opens (`invite.html`), and redeems both modes from it.
 *
 *  - a `sign-in` invitation sends its holder to this app's root, the token in the fragment, which this app's
 *    entry takes out of the address bar and keeps for the first sign-in, which redeems it;
 *  - a `link` invitation is redeemed on the page after the captcha, once, and its session for the one
 *    conversation is hosted there;
 *  - opening the page redeems nothing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InvitationLandingPage, type InvitationLandingDeps } from '@ae/widget/invitation-landing';
import { capturePendingInvitation } from '@ae/shared';
import { takePendingInvitation } from '@ae/shared/services/pendingInvitation.ts';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';
const CHAT = 'https://chat.example.com';
const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/room-1';

const peeked = (over: Record<string, unknown> = {}) => ({
  status: 'pending' as const, mode: 'sign-in' as const, conversationName: 'Quarterly plan', inviterName: 'Riley', inviteeName: 'Jordan',
  expiresAt: 2_000_000_000, signInUrl: CHAT, ...over,
});

function Conversation({ session }: { session: { kind: string; channelArn: string; userArn: string } }) {
  return <p>conversation {session.channelArn.split('/').pop()} as {session.kind} for {session.userArn.split('/').pop()}</p>;
}

function deps(over: Partial<InvitationLandingDeps> = {}): InvitationLandingDeps {
  return {
    readFragment: () => `#t=${TOKEN}`,
    clearFragment: vi.fn(),
    peek: vi.fn(async () => peeked()),
    redeem: vi.fn(),
    navigate: vi.fn(),
    captcha: vi.fn(async () => 'captcha-token'),
    Conversation: Conversation as never,
    ...over,
  } as InvitationLandingDeps;
}

const landing = (d: InvitationLandingDeps) => render(<InvitationLandingPage deps={d} languages={['en']} />);

describe('the chat app\'s invitation landing page', () => {
  beforeEach(() => sessionStorage.clear());

  it('is its own entry, served as invite.html', () => {
    const html = readFileSync(resolve(__dirname, '../../invite.html'), 'utf8');
    expect(html).toContain('src="/src/invite/main.tsx"');
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
    expect(readFileSync(resolve(__dirname, 'main.tsx'), 'utf8')).toContain("from '@ae/widget/invitation-landing'");
  });

  it('shows who invited the holder, and redeems nothing by opening', async () => {
    const d = deps();
    landing(d);
    expect(await screen.findByRole('heading', { name: 'Riley invited you to "Quarterly plan"' })).toBeInTheDocument();
    expect(d.peek).toHaveBeenCalledWith(TOKEN);
    expect(d.redeem).not.toHaveBeenCalled();
    expect(d.navigate).not.toHaveBeenCalled();
  });

  it('sends a sign-in invitation\'s holder to sign in here, and the first sign-in carries the token', async () => {
    const user = userEvent.setup();
    const d = deps();
    landing(d);
    await user.click(await screen.findByRole('button', { name: 'Sign in to join' }));
    const destination = new URL(vi.mocked(d.navigate!).mock.calls[0][0]);
    expect(destination.origin).toBe(CHAT);
    expect(destination.pathname).toBe('/');
    expect(d.redeem).not.toHaveBeenCalled();
    // THIS APP'S ENTRY TAKES IT FROM THE FRAGMENT (`main.tsx`), and the first credential exchange presents it.
    const replace = vi.spyOn(window.history, 'replaceState');
    expect(capturePendingInvitation({ hash: destination.hash, pathname: destination.pathname, search: '' })).toBe(true);
    expect(replace).toHaveBeenCalledWith(null, '', '/');
    expect(takePendingInvitation()).toBe(TOKEN);
  });

  it('redeems a link invitation once after the captcha, and hosts its session for the one conversation', async () => {
    const user = userEvent.setup();
    const now = Math.floor(Date.now() / 1000);
    const d = deps({
      peek: vi.fn(async () => peeked({ mode: 'link', linkAvailable: true, captchaSiteKey: '1x00000000000000000000AA', sessionMinutes: 15, signInUrl: undefined })),
      redeem: vi.fn(async () => ({
        credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' },
        userArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/invitee',
        channelArn: CHANNEL, sessionEndsAt: now + 900, conversationName: 'Quarterly plan', inviterName: 'Riley',
      })),
    });
    landing(d);
    await user.click(await screen.findByRole('button', { name: 'Join the conversation' }));
    expect(await screen.findByText('conversation room-1 as link for invitee')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('You are joined as a guest to this conversation only');
    expect(d.captcha).toHaveBeenCalledTimes(1);
    expect(d.redeem).toHaveBeenCalledTimes(1);
    expect(d.redeem).toHaveBeenCalledWith(TOKEN, 'captcha-token');
  });

  it('settles a link this deployment cannot redeem, with no Join', async () => {
    landing(deps({ peek: vi.fn(async () => peeked({ mode: 'link', linkAvailable: false })) }));
    expect(await screen.findByRole('alert')).toHaveAttribute('data-code', 'wrong_mode');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
