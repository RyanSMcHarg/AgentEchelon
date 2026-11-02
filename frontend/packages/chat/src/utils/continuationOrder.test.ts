import { describe, it, expect } from 'vitest';
import { orderContinuations } from './continuationOrder';

type M = { id: string; continuation?: boolean; parentMessageId?: string; part?: number };

describe('orderContinuations', () => {
  it('moves a continuation back beside its parent when something was posted in between', () => {
    // The live shape: answer part 1, the queue notice created while the turn ran, then part 2.
    const messages: M[] = [
      { id: 'q1' },
      { id: 'answer' },
      { id: 'notice' },
      { id: 'part2', continuation: true, parentMessageId: 'answer', part: 1 },
    ];
    expect(orderContinuations(messages).map((m) => m.id)).toEqual(['q1', 'answer', 'part2', 'notice']);
  });

  it('keeps several parts in part order', () => {
    const messages: M[] = [
      { id: 'answer' },
      { id: 'notice' },
      { id: 'p3', continuation: true, parentMessageId: 'answer', part: 2 },
      { id: 'p2', continuation: true, parentMessageId: 'answer', part: 1 },
    ];
    expect(orderContinuations(messages).map((m) => m.id)).toEqual(['answer', 'p2', 'p3', 'notice']);
  });

  it('leaves a part whose parent is not loaded where it is', () => {
    const messages: M[] = [
      { id: 'x' },
      { id: 'orphan', continuation: true, parentMessageId: 'gone', part: 1 },
    ];
    expect(orderContinuations(messages).map((m) => m.id)).toEqual(['x', 'orphan']);
  });

  it('returns the same list when nothing needs moving', () => {
    const messages: M[] = [{ id: 'a' }, { id: 'b' }];
    expect(orderContinuations(messages)).toBe(messages);
  });
});
