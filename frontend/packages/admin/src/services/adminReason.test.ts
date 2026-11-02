/**
 * A REASON IS ASKED FOR BEFORE A CONVERSATION IS REACHED (SPEC-ADMIN-CONSOLE FR51), once per conversation
 * for reading it and every time for changing it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@ae/shared/i18n', () => ({ default: { t: (k: string) => k } }));

import { reasonFor, setReasonProvider, clearReasons, ReasonDeclinedError } from './adminReason';

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/c1';

describe('reasonFor', () => {
  beforeEach(() => clearReasons());

  it('asks once for reading a conversation, and reuses that reason for its other reads', async () => {
    const ask = vi.fn(async () => 'investigating a reported answer');
    const off = setReasonProvider(ask);
    expect(await reasonFor({ capability: 'view-messages', channelArn: CHANNEL, kind: 'read' })).toBe('investigating a reported answer');
    expect(await reasonFor({ capability: 'view-live-members', channelArn: CHANNEL, kind: 'read' })).toBe('investigating a reported answer');
    expect(ask).toHaveBeenCalledTimes(1);
    off();
  });

  it('asks again for every change, even in a conversation already opened', async () => {
    const ask = vi.fn(async () => 'removing a leaked password');
    const off = setReasonProvider(ask);
    await reasonFor({ capability: 'view-messages', channelArn: CHANNEL, kind: 'read' });
    await reasonFor({ capability: 'redact', channelArn: CHANNEL, kind: 'change' });
    await reasonFor({ capability: 'redact', channelArn: CHANNEL, kind: 'change' });
    expect(ask).toHaveBeenCalledTimes(3);
    off();
  });

  it('abandons the action when the operator gives no reason', async () => {
    const off = setReasonProvider(async () => '   ');
    await expect(reasonFor({ capability: 'delete', channelArn: CHANNEL, kind: 'change' })).rejects.toBeInstanceOf(ReasonDeclinedError);
    off();
  });

  it('refuses rather than proceeding when nothing can ask', async () => {
    await expect(reasonFor({ capability: 'view-messages', channelArn: CHANNEL, kind: 'read' })).rejects.toThrow('admin.reason.noPrompt');
  });
});

describe('reasonFor, when a conversation opens several reads at once', () => {
  beforeEach(() => clearReasons());

  it('asks once for concurrent reads of one conversation', async () => {
    let answer: (r: string) => void = () => {};
    const ask = vi.fn(() => new Promise<string>((resolve) => { answer = resolve; }));
    const off = setReasonProvider(ask);
    const both = Promise.all([
      reasonFor({ capability: 'view-messages', channelArn: CHANNEL, kind: 'read' }),
      reasonFor({ capability: 'view-live-members', channelArn: CHANNEL, kind: 'read' }),
    ]);
    await Promise.resolve();
    await Promise.resolve();
    answer('reviewing a complaint');
    expect(await both).toEqual(['reviewing a complaint', 'reviewing a complaint']);
    expect(ask).toHaveBeenCalledTimes(1);
    off();
  });

  it('queues a second prompt behind the first rather than replacing it', async () => {
    const order: string[] = [];
    const off = setReasonProvider(async (r) => { order.push(r.capability); return `reason for ${r.capability}`; });
    const [a, b] = await Promise.all([
      reasonFor({ capability: 'redact', channelArn: CHANNEL, kind: 'change' }),
      reasonFor({ capability: 'delete', channelArn: CHANNEL, kind: 'change' }),
    ]);
    expect([a, b]).toEqual(['reason for redact', 'reason for delete']);
    expect(order).toEqual(['redact', 'delete']);
    off();
  });
});
