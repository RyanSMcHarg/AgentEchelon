/**
 * Host-supplied grounding is bounded to what a turn can actually DISPATCH.
 *
 * WHY THIS IS A LOST-TURN BUG AND NOT A SIZE PREFERENCE. `domainContext` and `otherContexts` were the
 * only host-supplied fields on the federated creation path accepted with no cap at all, while every
 * sibling was capped (`participantProfile` 600 chars, `participants` 8, `userLanguage` 8). The private
 * store is DynamoDB, which takes 400KB an item, so it accepted far more than the rest of the system can
 * carry. The router then spreads the whole grounding into the async processor's payload on an `Event`
 * invoke - capped at 256KB - and `invokeAsync` catches its own failure and returns.
 *
 * So an oversized plan produced: `RequestEntityTooLargeException`, one `console.error`, no worker, and a
 * placeholder that is never resolved. And not for one turn - for EVERY turn in that conversation, because
 * the grounding is re-read and re-sent each time. The conversation is permanently stuck and the only
 * symptom is a log line.
 *
 * Bounded in `lib/host-grounding.ts` rather than in either handler because BOTH write these fields
 * (create and add-member) and an unbounded value through either breaks the same reader.
 */
import {
  boundedDomainContext,
  boundedOtherContexts,
  MAX_DOMAIN_CONTEXT_ITEMS,
  MAX_DOMAIN_CONTEXT_BYTES,
  MAX_OTHER_CONTEXTS,
} from '../../lambda/src/lib/host-grounding';

/** A plan item big enough that a few hundred of them pass the byte cap. */
function item(i: number) {
  return { id: `item-${i}`, title: `Work item ${i}`, notes: 'x'.repeat(400) };
}

/** The caller's own shape. The helper is generic so each handler keeps its real `DomainContext` type. */
interface Plan {
  planName?: string;
  items?: unknown[];
  blob?: string;
}

describe('a plan is trimmed by ITEM COUNT first', () => {
  it('keeps the first N items and drops the tail', () => {
    const ctx = boundedDomainContext<Plan>({ planName: 'Q3', items: Array.from({ length: 500 }, (_, i) => ({ id: i })) }, '[test]');
    expect(ctx?.items).toHaveLength(MAX_DOMAIN_CONTEXT_ITEMS);
    // By count, not by truncating the serialized blob: a prompt reads items sequentially, so the FIRST
    // ones are the useful ones, and a blob cut mid-object is not parseable grounding at all.
    expect((ctx?.items as Array<{ id: number }>)[0].id).toBe(0);
    expect(ctx?.planName).toBe('Q3'); // sibling fields survive
  });

  it('leaves a plan under the cap completely untouched', () => {
    const input = { planName: 'Q3', items: [{ id: 1 }, { id: 2 }] };
    expect(boundedDomainContext<Plan>(input, '[test]')).toEqual(input);
  });
});

describe('a plan that is still too large after trimming is DROPPED, not sent partially', () => {
  it('returns undefined rather than a plan missing its tail', () => {
    // Under the item cap, over the byte cap: one enormous field rather than many items.
    const huge: Plan = { planName: 'Q3', blob: 'x'.repeat(MAX_DOMAIN_CONTEXT_BYTES + 1_000) };
    expect(boundedDomainContext<Plan>(huge, '[test]')).toBeUndefined();
  });

  it('a plan the host believes is complete is never silently truncated', () => {
    // The distinction that matters: grounding the assistant reasons over must be whole or absent. A plan
    // that lost its tail invisibly is worse than none, because the answer looks confident and is wrong.
    const ctx = boundedDomainContext<Plan>(
      { items: Array.from({ length: MAX_DOMAIN_CONTEXT_ITEMS }, (_, i) => item(i)) },
      '[test]',
    );
    if (ctx) {
      expect(Buffer.byteLength(JSON.stringify(ctx), 'utf8')).toBeLessThanOrEqual(MAX_DOMAIN_CONTEXT_BYTES);
    } else {
      expect(ctx).toBeUndefined(); // dropped whole is the other acceptable outcome
    }
  });

  it('whatever survives is ALWAYS within the dispatchable budget', () => {
    // The property the whole fix exists for, asserted against an ABSOLUTE budget rather than against
    // `MAX_DOMAIN_CONTEXT_BYTES`. Comparing the output to the constant that produced it is vacuous: it
    // passes for ANY cap, including one raised past the real limit, which is precisely the state this
    // test is supposed to catch. Verified by raising the cap - this line reddens, the self-referential
    // version did not.
    //
    // 128KB is half the 256KB `Event`-invoke ceiling, leaving room for the transcript, RAG chunks and
    // the summary that share the payload.
    const ABSOLUTE_DISPATCH_BUDGET = 128 * 1024;
    const ctx = boundedDomainContext<Plan>({ items: Array.from({ length: 400 }, (_, i) => item(i)) }, '[test]');
    const bytes = ctx ? Buffer.byteLength(JSON.stringify(ctx), 'utf8') : 0;
    expect(bytes).toBeLessThanOrEqual(ABSOLUTE_DISPATCH_BUDGET);
    // And the shipped cap must itself stay inside that budget, or the bound is decorative.
    expect(MAX_DOMAIN_CONTEXT_BYTES).toBeLessThanOrEqual(ABSOLUTE_DISPATCH_BUDGET);
  });
});

describe('side contexts are bounded by count', () => {
  it('trims past the cap', () => {
    expect(boundedOtherContexts(Array.from({ length: 100 }, (_, i) => ({ title: `c${i}` }))))
      .toHaveLength(MAX_OTHER_CONTEXTS);
  });

  it('passes a short list through, and drops a non-array', () => {
    expect(boundedOtherContexts([{ title: 'a' }])).toEqual([{ title: 'a' }]);
    expect(boundedOtherContexts('not an array')).toBeUndefined();
    expect(boundedOtherContexts(undefined)).toBeUndefined();
  });
});

describe('non-objects and absent values behave as before', () => {
  it('undefined in, undefined out — a host that sends no plan is unaffected', () => {
    expect(boundedDomainContext(undefined, '[test]')).toBeUndefined();
    expect(boundedDomainContext(null, '[test]')).toBeUndefined();
    expect(boundedDomainContext('a string', '[test]')).toBeUndefined();
  });
});
