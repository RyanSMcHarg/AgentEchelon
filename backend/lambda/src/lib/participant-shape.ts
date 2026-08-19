/**
 * Participant shape - who is in a conversation, expressed as a SHAPE rather than as one id.
 *
 * SPEC-USER-PROFILE-AND-ONBOARDING §2. Reducing membership to "the participant" is wrong for most
 * conversation types, and the shape is what the welcome actually needs: it decides how personal to be and
 * whether onboarding is in scope at all.
 *
 *   single - one human; that person is the subject. Personalize; onboarding applies.
 *   group  - several humans, no single subject. Address the group; onboarding does NOT apply, because
 *            there is no one person whose profile the gate could key on.
 *   none   - nobody has joined (an alert-initiated conversation). Nothing to greet and nobody to onboard.
 *
 * `none` is a STEADY STATE, not a transient one. That distinction is the point of this module: the previous
 * design read membership live at `WelcomeIntent`, where it has not converged, so "nobody resolved" was
 * ambiguous between "genuinely nobody" and "not yet". Resolving it the wrong way re-onboarded users who had
 * already completed the intake, which is the exact defect the once-per-user gate exists to prevent.
 *
 * The disambiguation is ORDERING, not logic: the creating path writes this shape BEFORE the channel exists,
 * from what the creation request already knew, so by the time anything can fire it is a completed fact. See
 * `derivedChannelArn` for why writing ahead of creation is possible at all.
 */

export type ParticipantFocus = 'single' | 'group' | 'none';


export interface ParticipantContext {
  focus: ParticipantFocus;
  /** AppInstanceUser ids of the human members. Ordered as supplied; empty for `none`. */
  humans: string[];
  /**
   * The one human when `focus === 'single'`, else ''. Present as its own field so a consumer cannot
   * accidentally treat `humans[0]` of a GROUP as the subject, which is the mistake this shape prevents.
   */
  subject: string;
}

/**
 * The channel ARN for a channel that may not exist yet.
 *
 * Chime channel ARNs are `{appInstanceArn}/channel/{channelId}` and the CALLER supplies `channelId`, so the
 * ARN is fully determined before `CreateChannel` is invoked. That is what makes it possible to key
 * per-conversation context ahead of creation - which is required, because the assistant is added to the
 * channel BY creation (it is the acting bearer), leaving no window afterwards in which to write something
 * the welcome will read.
 */
export function derivedChannelArn(appInstanceArn: string, channelId: string): string {
  return `${appInstanceArn}/channel/${channelId}`;
}

/**
 * Classify a set of human member ids into a shape.
 *
 * Bot and assistant identities must be filtered out by the caller: this takes HUMANS. Blank ids are dropped
 * and duplicates collapsed, so a roster that names the same person twice is still `single` rather than
 * becoming a spurious `group` and silently disabling onboarding.
 */
export function participantContextFor(humanIds: Array<string | undefined | null>): ParticipantContext {
  const humans = [...new Set(humanIds.map((id) => (id || '').trim()).filter((id) => id.length > 0))];
  if (humans.length === 0) return { focus: 'none', humans: [], subject: '' };
  if (humans.length === 1) return { focus: 'single', humans, subject: humans[0] };
  return { focus: 'group', humans, subject: '' };
}

/** True when onboarding can apply at all: exactly one human, so there is a person to key the gate on. */
export function onboardingApplies(ctx: ParticipantContext | null | undefined): boolean {
  return ctx?.focus === 'single' && Boolean(ctx.subject);
}

/**
 * Parse a shape read back from the context store, tolerating anything unexpected.
 *
 * Returns null rather than a guessed shape when the value is unusable. A guessed `single` would key the
 * onboarding gate on a fabricated subject; a guessed `none` would silently disable onboarding. Both are
 * worse than the caller knowing it has nothing and falling back deliberately.
 */
export function parseParticipantContext(raw: unknown): ParticipantContext | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const humans = Array.isArray(r.humans)
    ? r.humans.filter((h): h is string => typeof h === 'string' && h.trim().length > 0).map((h) => h.trim())
    : [];
  // `focus` must be one of the known literals. It is not used as the ANSWER - it is the marker that this row
  // was written by this mechanism at all, so a row carrying some other shape of object is rejected rather
  // than silently reinterpreted.
  if (r.focus !== 'single' && r.focus !== 'group' && r.focus !== 'none') return null;

  // The shape is then RE-DERIVED from `humans` rather than trusting the stored `focus`/`subject` triple to be
  // self-consistent. A row written by an older version, or returned by a pluggable store, could say
  // `focus: 'single'` while carrying three humans; recomputing is the only reading that cannot key the
  // onboarding gate on a subject the member list does not support.
  return participantContextFor(humans);
}
