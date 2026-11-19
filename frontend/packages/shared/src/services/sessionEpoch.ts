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

/**
 * HOW A SESSION ENDED. `signed-out` is the person choosing to sign out in this window; `ended` is every other end (a
 * refresh the issuer refused, a token that expired, a session that was never there). A holder of state shared by every
 * window of the browser lets it go only on `signed-out`, since another window may still be signed in.
 */
export type SessionEndReason = 'signed-out' | 'ended';

let epoch = 0;
const onEnd = new Set<(reason: SessionEndReason) => void>();

/** The current session's epoch. Capture it before an await; compare after. */
export function currentSessionEpoch(): number {
  return epoch;
}

/** End the current session: every capture taken before this call is now stale, and every holder of its state lets it go. */
export function endSessionEpoch(reason: SessionEndReason = 'ended'): void {
  epoch += 1;
  for (const listener of [...onEnd]) listener(reason);
}

/**
 * Run `listener` each time a session ends, for a holder of a person's state. Answers the function that stops listening,
 * for a holder that goes away before the page does.
 */
export function onSessionEnd(listener: (reason: SessionEndReason) => void): () => void {
  onEnd.add(listener);
  return () => { onEnd.delete(listener); };
}
