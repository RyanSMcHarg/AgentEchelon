import { describe, it, expect } from 'vitest';
import { conversationIsUnread } from './conversationUnread';

const at = (iso: string) => new Date(iso);
const ms = (iso: string) => Date.parse(iso);

describe('conversationIsUnread', () => {
  it('a conversation with no message is read', () => {
    expect(conversationIsUnread({})).toBe(false);
  });

  it('a last message newer than the read marker is unread until the person views it', () => {
    const f = { lastMessageAt: at('2026-11-12T22:33:00Z'), lastReadAt: at('2026-11-12T22:30:00Z') };
    expect(conversationIsUnread(f)).toBe(true);
    expect(conversationIsUnread({ ...f, viewedAt: ms('2026-11-12T22:34:00Z') })).toBe(false);
  });

  it('a last message the read marker covers is read', () => {
    expect(conversationIsUnread({ lastMessageAt: at('2026-11-12T22:33:00Z'), lastReadAt: at('2026-11-12T22:33:00Z') })).toBe(false);
  });

  it('a conversation viewed on a device whose clock runs two minutes slow stays read', () => {
    // The server's message is at 22:33:00; the device read it at 22:33:30 server time, which its clock calls 22:31:30.
    const slow = (serverTime: number) => serverTime - 120_000;
    const f = {
      lastMessageAt: at('2026-11-12T22:33:00Z'), lastReadAt: at('2026-11-12T22:30:00Z'),
      viewedAt: ms('2026-11-12T22:31:30Z'), localTimeOf: slow,
    };
    expect(conversationIsUnread(f)).toBe(false);
    // Without the clock's difference the same view reads as before the message.
    expect(conversationIsUnread({ ...f, localTimeOf: undefined })).toBe(true);
  });

  it('a message that arrived after the last view is unread, and one before it is not', () => {
    expect(conversationIsUnread({ arrivedAt: 2_000, viewedAt: 1_000 })).toBe(true);
    expect(conversationIsUnread({ arrivedAt: 1_000, viewedAt: 2_000 })).toBe(false);
  });
});
