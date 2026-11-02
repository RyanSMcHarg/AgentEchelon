/**
 * The widget is keyboard operable, its transcript is an ARIA live region, and focus returns to the
 * launcher when the panel closes (E12).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WidgetApp } from './WidgetApp';
import { Transcript } from './Transcript';
import { Composer } from './Composer';
import { renderWidget } from '../test/render';
import type { TranscriptMessage } from '../messaging/useChannel';
import { GuestVisit } from '../session/refreshLeader';

const USER = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/visitor';
const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/c1';

const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

/** A visit already open in this tab, so the widget goes straight to the conversation. */
function openVisit(): GuestVisit {
  const visit = new GuestVisit('test', { refresh: vi.fn(), channel: null, locks: null, storage: memoryStorage() });
  const now = Math.floor(Date.now() / 1000);
  visit.open({ guestToken: 'g', guestTokenExpiresAt: now + 600, refreshToken: 'r', sessionEndsAt: now + 86400, channelArn: CHANNEL, userArn: USER });
  return visit;
}

function FakeConversation() {
  return (
    <>
      <Transcript messages={[]} status="live" />
      <Composer onSend={() => undefined} />
    </>
  );
}

const msg = (id: string, text: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage => ({ id, mine: false, fromAssistant: true, text, ...extra });

beforeEach(() => {
  vi.stubEnv('VITE_GUEST_CAPTCHA_SITE_KEY', '1x00000000000000000000AA');
  vi.stubEnv('VITE_GUEST_NOTICE_VERSION', 'sample-1');
});
afterEach(() => vi.unstubAllEnvs());

describe('the launcher and the panel', () => {
  it('opens a labelled dialog from the launcher and moves focus into it', async () => {
    const user = userEvent.setup();
    renderWidget(<WidgetApp mode="guest" deps={{ visit: openVisit(), Conversation: FakeConversation }} />);
    const launcher = screen.getByRole('button', { name: 'Open the assistant' });
    expect(launcher).toHaveAttribute('aria-expanded', 'false');
    await user.click(launcher);
    const dialog = await screen.findByRole('dialog', { name: 'Assistant' });
    expect(launcher).toHaveAttribute('aria-expanded', 'true');
    expect(launcher).toHaveAttribute('aria-controls', dialog.id);
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it('returns focus to the launcher when the close button closes the panel', async () => {
    const user = userEvent.setup();
    renderWidget(<WidgetApp mode="guest" deps={{ visit: openVisit(), Conversation: FakeConversation }} />);
    await user.click(screen.getByRole('button', { name: 'Open the assistant' }));
    const dialog = await screen.findByRole('dialog');
    const close = screen.getAllByRole('button', { name: 'Close the assistant' }).find((b) => dialog.contains(b))!;
    await user.click(close);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open the assistant' }));
  });

  it('is operable from the keyboard alone, and Escape returns focus to the launcher', async () => {
    const user = userEvent.setup();
    renderWidget(<WidgetApp mode="guest" deps={{ visit: openVisit(), Conversation: FakeConversation }} />);
    await user.keyboard('{Tab}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open the assistant' }));
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open the assistant' }));
  });

  it('tells the parent page whether it is open, so the loader sizes the frame', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWidget(<WidgetApp mode="guest" deps={{ visit: openVisit(), onOpenChange, Conversation: FakeConversation }} />);
    await user.click(screen.getByRole('button', { name: 'Open the assistant' }));
    await user.keyboard('{Escape}');
    expect(onOpenChange.mock.calls.map((c) => c[0])).toEqual([false, true, false]);
  });
});

describe('the transcript', () => {
  it('is a polite live log, so each new message is announced without moving focus', () => {
    renderWidget(<Transcript messages={[]} status="live" />);
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(log).toHaveAttribute('aria-relevant', 'additions text');
  });

  it('keeps the connection state in a status region of its own, outside the log', () => {
    renderWidget(<Transcript messages={[msg('1', 'Hello')]} status="reconnecting" />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Reconnecting');
    expect(screen.getByRole('log').contains(status)).toBe(false);
  });

  it('names who said each message: the visitor, the assistant, or another member', () => {
    renderWidget(<Transcript messages={[msg('1', 'Hi', { mine: true, fromAssistant: false }), msg('2', 'Hello'), msg('3', 'Joining', { fromAssistant: false, senderName: 'Dana' })]} status="live" />);
    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('You');
    expect(log).toHaveTextContent('Assistant');
    expect(log).toHaveTextContent('Dana');
  });

  it('adds a live message inside the same region the screen reader is watching', () => {
    const { rerenderWidget } = renderWidget(<Transcript messages={[]} status="live" />);
    const log = screen.getByRole('log');
    rerenderWidget(<Transcript messages={[msg('a', 'An answer')]} status="live" />);
    expect(screen.getByRole('log')).toBe(log);
    expect(log).toHaveTextContent('An answer');
  });
});
