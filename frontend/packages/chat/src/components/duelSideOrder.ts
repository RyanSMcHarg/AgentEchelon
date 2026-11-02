/**
 * WHICH SIDE OF A DUEL IS A, AND WHICH IS B.
 *
 * A pick is recorded as `A`, `B` or `tie`, and the server credits it to a variant by that letter alone:
 * `A` is the control and `B` the treatment (`lib/battle-outcome.ts`). So the column the scorecard calls
 * A has to be the control's reply. Rendering order cannot decide it: both sides of round 1 are dispatched
 * at once, and whichever placeholder posts first renders first, so a duel's columns could swap between
 * duels and a vote for the treatment be counted for the control.
 *
 * The answer each side posts carries its `variantId` (`control` or `treatment`) in its message metadata,
 * the same join key the thumbs vote uses. Sides are ordered by it. A side that does not carry one keeps its
 * place, so a duel with no experiment behind it renders as it always did.
 */
export interface DuelSide {
  variantId?: string;
}

const RANK: Record<string, number> = { control: 0, treatment: 1 };

/** The round-1 replies with the control first and the treatment second; otherwise in the order given. */
export function duelSidesInOrder<T extends DuelSide>(sides: readonly T[]): T[] {
  return sides
    .map((side, index) => ({ side, index, rank: side.variantId !== undefined && side.variantId in RANK ? RANK[side.variantId] : undefined }))
    .sort((a, b) => (a.rank !== undefined && b.rank !== undefined ? a.rank - b.rank : a.index - b.index))
    .map((s) => s.side);
}
