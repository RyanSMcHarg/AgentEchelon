/**
 * The keys of the abuse-controls table that name a person, in one place, so the writer
 * (`abuse-controls.ts`) and offboarding (`offboarding.ts`), which removes them by key, cannot drift.
 */

/** A counter row's lifetime: the 1 h window plus slack before it expires. */
export const BUDGET_TTL_SECONDS = 7200;

/** The UTC hour a counter row is keyed on, `YYYY-MM-DDTHH`. */
export const hourKeyAt = (at: Date): string => at.toISOString().slice(0, 13);

/** One person's model-spend counter for one hour. */
export const userBudgetKey = (personId: string, hour: string): string => `budget#user#${personId}#${hour}`;
