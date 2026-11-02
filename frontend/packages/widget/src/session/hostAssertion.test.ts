/**
 * The frame accepts a posted host assertion only when its origin is a declared host AND its source is
 * the frame's own parent (A9). Every other post is refused, and an accepted one is taken once.
 */
import { describe, it, expect } from 'vitest';
import { ASSERTION_MESSAGE, ASSERTION_REQUEST, checkPostedAssertion, HostAssertionInbox, type FrameWindow } from './hostAssertion';

const HOST = 'https://acme.lightning.force.com';
const HOSTS = new Set([HOST]);
const parent = { postMessage: (..._args: unknown[]) => undefined };
const post = (data: unknown, origin = HOST, source: unknown = parent) => ({ data, origin, source: source as MessageEventSource });
const assertion = { type: ASSERTION_MESSAGE, assertion: 'header.payload.signature', conversationArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/c1' };

describe('checking a posted assertion', () => {
  it('accepts an assertion from a declared host, posted by the parent frame', () => {
    expect(checkPostedAssertion(post(assertion), HOSTS, parent)).toMatchObject({ ok: true, origin: HOST, value: { assertion: 'header.payload.signature' } });
  });

  it('refuses an undeclared origin', () => {
    expect(checkPostedAssertion(post(assertion, 'https://evil.example.com'), HOSTS, parent)).toEqual({ ok: false, reason: 'origin' });
  });

  it('refuses an origin that only starts like a declared one', () => {
    expect(checkPostedAssertion(post(assertion, `${HOST}.evil.example.com`), HOSTS, parent)).toEqual({ ok: false, reason: 'origin' });
    expect(checkPostedAssertion(post(assertion, 'http://acme.lightning.force.com'), HOSTS, parent)).toEqual({ ok: false, reason: 'origin' });
  });

  it('refuses a post from a frame other than the parent, even on a declared host', () => {
    const sibling = { postMessage: () => undefined };
    expect(checkPostedAssertion(post(assertion, HOST, sibling), HOSTS, parent)).toEqual({ ok: false, reason: 'source' });
    expect(checkPostedAssertion(post(assertion, HOST, null), HOSTS, parent)).toEqual({ ok: false, reason: 'source' });
  });

  it('refuses every post when the frame has no parent (opened on its own)', () => {
    expect(checkPostedAssertion(post(assertion), HOSTS, null)).toEqual({ ok: false, reason: 'source' });
  });

  it('refuses a message that is not an assertion', () => {
    expect(checkPostedAssertion(post({ type: 'something-else' }), HOSTS, parent)).toEqual({ ok: false, reason: 'shape' });
    expect(checkPostedAssertion(post({ type: ASSERTION_MESSAGE, assertion: 42 }), HOSTS, parent)).toEqual({ ok: false, reason: 'shape' });
  });

  it('accepts nothing when the deployment declares no host', () => {
    expect(checkPostedAssertion(post(assertion), new Set(), parent)).toEqual({ ok: false, reason: 'origin' });
  });
});

/** A fake frame window whose `message` listeners the test dispatches to. */
function frame() {
  const listeners = new Set<(e: MessageEvent) => void>();
  const sent: Array<{ message: unknown; origin: string }> = [];
  const parentWin = { postMessage: (message: unknown, origin: string) => sent.push({ message, origin }) };
  const win: FrameWindow & { dispatch: (e: unknown) => void } = {
    parent: parentWin,
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
    dispatch: (e) => listeners.forEach((l) => l(e as MessageEvent)),
  };
  return { win, parentWin, sent };
}

describe('the inbox', () => {
  it('takes an accepted assertion once, and holds nothing after', async () => {
    const { win, parentWin } = frame();
    const inbox = new HostAssertionInbox(HOSTS, win);
    win.dispatch(post(assertion, HOST, parentWin));
    expect((await inbox.take()).assertion).toBe('header.payload.signature');
    let second = false;
    void inbox.take().then(() => { second = true; });
    await Promise.resolve();
    expect(second).toBe(false);
  });

  it('ignores refused posts, and counts them by reason', async () => {
    const { win, parentWin } = frame();
    const inbox = new HostAssertionInbox(HOSTS, win);
    win.dispatch(post(assertion, 'https://evil.example.com', parentWin));
    win.dispatch(post(assertion, HOST, { postMessage: () => undefined }));
    expect(inbox.refused).toEqual({ origin: 1, source: 1, shape: 0 });
    win.dispatch(post(assertion, HOST, parentWin));
    expect((await inbox.take()).conversationArn).toContain('channel/c1');
  });

  it('asks for a fresh assertion only at the origin the accepted one came from', () => {
    const { win, parentWin, sent } = frame();
    const inbox = new HostAssertionInbox(HOSTS, win);
    expect(inbox.request()).toBe(false);
    win.dispatch(post(assertion, HOST, parentWin));
    expect(inbox.request()).toBe(true);
    expect(sent).toEqual([{ message: { type: ASSERTION_REQUEST }, origin: HOST }]);
  });
});
