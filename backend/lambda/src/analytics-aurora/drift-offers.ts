/**
 * WHICH DRIFT EVENTS ARE OFFERS (migration 101), the one population every figure about offers is a share of. A change nobody
 * was asked about, moved unasked or offered nothing, had no offer to accept, decline, or be judged.
 */
export const IS_A_DRIFT_OFFER = (alias: string): string => `(${alias}.outcome IS NULL OR ${alias}.outcome NOT IN ('moved_unasked', 'not_offered'))`;
