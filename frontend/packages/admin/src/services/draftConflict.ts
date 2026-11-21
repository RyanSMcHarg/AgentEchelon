/**
 * THE REFUSALS OF A DRAFT WRITE THAT WAS NOT BASED ON THE DRAFT STORED NOW (SPEC-PORTABLE-PROFILES FR19). Every profile
 * route that replaces or promotes a draft names the draft it was based on, and the server answers `409` (`404` for
 * `NO_DRAFT`) with the configId of the draft there now when the request named none while one exists
 * (`CONFIG_ID_REQUIRED`), named one replaced since (`DRAFT_CHANGED`), would replace a draft it did not name
 * (`DRAFT_EXISTS`), or named one that is gone (`NO_DRAFT`). A first edit, or an activation, based on an active version that is
 * no longer the active one is `VERSION_CHANGED`: another version was activated since, and it is never written over.
 *
 * Its own module, beside the profile service rather than inside it, so a caller reads the code from a failed call
 * whatever the service is replaced with.
 */
export const DRAFT_CONFLICT_CODES = ['CONFIG_ID_REQUIRED', 'DRAFT_CHANGED', 'DRAFT_EXISTS', 'NO_DRAFT', 'VERSION_CHANGED'] as const;

export type DraftConflictCode = (typeof DRAFT_CONFLICT_CODES)[number];

/** The conflict code a failed draft write carries, or null when it failed for another reason. */
export function draftConflictOf(err: unknown): DraftConflictCode | null {
  const code = (err as { body?: { code?: unknown } } | null)?.body?.code;
  return (DRAFT_CONFLICT_CODES as readonly unknown[]).includes(code) ? code as DraftConflictCode : null;
}
