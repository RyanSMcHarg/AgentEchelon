/**
 * WHICH placeholder message a turn's answer belongs on.
 *
 * A duplicate delivery of one turn starts two independent races, and nothing used to tie them
 * together:
 *  - the channel flow's duplicate-placeholder guard claims `corr#<id>` for the FIRST placeholder it
 *    sees and DENIES every other, so exactly one placeholder survives in the channel;
 *  - `claimCorrelation` lets exactly one processor proceed, whichever claimed first.
 *
 * Those two winners are chosen by different writers in different Lambdas and need not belong to the
 * same delivery. When they diverged, the surviving processor wrote its answer onto the placeholder
 * its own dispatch had created — the one the flow had already denied — so the user watched
 * "One moment..." forever while the finished answer landed on a message that was no longer in the
 * channel. Nothing errored; both halves believed they had succeeded.
 *
 * The claim is the tiebreaker because it is the one the CHANNEL agrees with: whatever survived the
 * guard is what the user is actually looking at.
 */

export interface PlaceholderTarget {
  /** The message to update, or undefined when neither source knows one yet. */
  messageId?: string;
  /** True when a handed id was overridden — a real duplicate-delivery divergence, worth logging. */
  overrodeHandedId: boolean;
}

/**
 * @param claimed the current owner of `corr#<id>`, or null when nothing has claimed it YET. A miss is
 *                the normal case on the fast path: the processor is dispatched before the placeholder
 *                exists, so the claim lands a moment later.
 * @param handed  the placeholder id the dispatching path created and passed in, when it had one.
 */
export function resolvePlaceholderTarget(claimed: string | null | undefined, handed?: string): PlaceholderTarget {
  const claim = (claimed || '').trim();
  const dispatched = (handed || '').trim();
  if (claim) {
    return { messageId: claim, overrodeHandedId: !!dispatched && dispatched !== claim };
  }
  return { messageId: dispatched || undefined, overrodeHandedId: false };
}
