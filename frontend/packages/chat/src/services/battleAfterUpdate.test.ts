/**
 * A DUEL SIDE'S PRIVATE PLACEHOLDER THAT BECAME THE PERSON'S RECEIPT STOPS RENDERING AS THAT SIDE.
 *
 * When a person answers a waiting duel side privately, the side's answer goes to the room as a new
 * message and the private placeholder becomes "Thanks - picking that back up...", declared
 * `turnKind: 'receipt'`. The placeholder's CREATE carried the `<!--battle:-->` marker, and the receipt
 * never gets a battlestats summary, so a merge that kept the identity rendered the receipt as
 * "<side> is drafting..." for the rest of the session (live, B-E7, 2026-10-28).
 */
import { describe, it, expect } from 'vitest';
import { battleAfterUpdate } from './battleAfterUpdate';
import { liftTurnStateFields } from './turnStateFields';

const PLACEHOLDER_BATTLE = { battleId: 'b1', round: 1 as const, total: 2, rivalArn: 'arn:rival' };

describe('battleAfterUpdate', () => {
  it('drops the duel identity when the update declares the message a receipt', () => {
    const receipt = liftTurnStateFields({ turnKind: 'receipt', respPhase: 'final' });
    expect(battleAfterUpdate(PLACEHOLDER_BATTLE as never, { battle: undefined, turnKind: receipt.turnKind }))
      .toBeUndefined();
  });

  it('keeps the placeholder identity across an answer update that carries no marker', () => {
    expect(battleAfterUpdate(PLACEHOLDER_BATTLE as never, { battle: undefined }))
      .toEqual(PLACEHOLDER_BATTLE);
  });

  it('merges the battlestats summary onto the placeholder identity', () => {
    const merged = battleAfterUpdate(
      PLACEHOLDER_BATTLE as never,
      { battle: { battleId: 'b1', round: 1, responseMs: 333 } as never },
    );
    expect(merged).toMatchObject({ ...PLACEHOLDER_BATTLE, responseMs: 333 });
  });
});
