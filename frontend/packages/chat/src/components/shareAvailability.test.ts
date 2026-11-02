import { describe, it, expect } from 'vitest';
import { shareDisabledReason } from './shareAvailability';

const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key);

describe('Share is unavailable where membership comes from a source', () => {
  it('is available in an ordinary conversation', () => {
    expect(shareDisabledReason(undefined, t)).toBe('');
    expect(shareDisabledReason('', t)).toBe('');
  });

  it('names the group a conversation takes its people from', () => {
    expect(shareDisabledReason('group:ops', t)).toBe('conversation.shareDisabledGroup:{"group":"ops"}');
    expect(shareDisabledReason('group:ops+list', t)).toBe('conversation.shareDisabledGroup:{"group":"ops"}');
  });

  it('says a fixed list when there is no group', () => {
    expect(shareDisabledReason('list', t)).toBe('conversation.shareDisabledList');
  });
});
