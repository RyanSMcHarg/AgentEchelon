/**
 * WHICH SESSION THIS IS, so work started under an old one cannot land in a new one.
 *
 * A cleared timer does not cancel an in-flight promise. A token refresh, or an identity lookup, that is
 * awaiting an answer when the person signs out resolves a moment later and would write its result
 * back over the cleared session. A counter settles it where a handle cannot: anything that ends a
 * session advances it, and work that captured the old value discards its own result instead of
 * applying it.
 *
 * Module-level rather than a React ref because the writers are not all inside React:
 * `ensureFreshIdToken` refreshes from the admin SigV4 path and the credential provider, and must honour
 * the same sign-out the AuthProvider performs.
 */

let epoch = 0;

/** The current session's epoch. Capture it before an await; compare after. */
export function currentSessionEpoch(): number {
  return epoch;
}

/** End the current session: every capture taken before this call is now stale. */
export function endSessionEpoch(): void {
  epoch += 1;
}
