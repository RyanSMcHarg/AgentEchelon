/**
 * A IS THE CONTROL AND B THE TREATMENT, whichever side posted first.
 *
 * The server credits a pick to a variant by its letter alone (`A` control, `B` treatment), and both sides
 * of round 1 are dispatched at once, so render order is a race. These pin that the scorecard's columns
 * follow the `variantId` each answer carries, and that a duel with no experiment behind it keeps its order.
 */
import { describe, it, expect } from 'vitest';
import { duelSidesInOrder } from './duelSideOrder';

describe('which side of a duel is A', () => {
  it('puts the control first when the treatment posted first', () => {
    const treatment = { id: 'alt', variantId: 'treatment' };
    const control = { id: 'live', variantId: 'control' };
    expect(duelSidesInOrder([treatment, control]).map((s) => s.id)).toEqual(['live', 'alt']);
  });

  it('keeps the control first when it already posted first', () => {
    const control = { id: 'live', variantId: 'control' };
    const treatment = { id: 'alt', variantId: 'treatment' };
    expect(duelSidesInOrder([control, treatment]).map((s) => s.id)).toEqual(['live', 'alt']);
  });

  it('keeps render order when a side carries no variant (no experiment, or the answer has not landed)', () => {
    type Side = { id: string; variantId?: string };
    const a: Side = { id: 'first' };
    const b: Side = { id: 'second', variantId: 'control' };
    expect(duelSidesInOrder([a, b]).map((s) => s.id)).toEqual(['first', 'second']);
    expect(duelSidesInOrder<Side>([{ id: 'x' }, { id: 'y' }]).map((s) => s.id)).toEqual(['x', 'y']);
  });

  it('does not reorder the input array it was given', () => {
    const input = [{ id: 'alt', variantId: 'treatment' }, { id: 'live', variantId: 'control' }];
    duelSidesInOrder(input);
    expect(input.map((s) => s.id)).toEqual(['alt', 'live']);
  });
});
