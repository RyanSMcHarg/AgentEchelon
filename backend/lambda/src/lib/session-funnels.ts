/**
 * THE SIGN-UP AND SIGN-IN FUNNELS, as data: pure, so the analytics query in either mode reads the same
 * steps, the same entry step and the same output columns.
 *
 * A session funnel counts a step for a session only when that session recorded the entry step at or
 * before it, within the window. Every step is therefore a subset of the entry step's sessions, and a
 * conversion read off the funnel cannot exceed 100% by construction. A session that recorded a step
 * with no entry step before it is counted apart, in `sessions_outside_funnel`, so it is reported rather
 * than silently dropped.
 *
 * The browser records these steps and `/events` accepts only a signed-in caller, so a step recorded before
 * sign-in is held in the tab until the person signs in (`eventTrackingService.ts`). A visit that never
 * signs in sends nothing, and the funnel describes the sessions that reached the server.
 */

export interface SessionFunnel {
  /** The steps, in funnel order. The first is the entry step. */
  readonly steps: readonly string[];
  /** The step every other step is counted among. */
  readonly entryStep: string;
  /** The step the console reads as the funnel's success. */
  readonly successStep: string;
}

export const SIGNUP_FUNNEL: SessionFunnel = {
  steps: [
    'signup_form_viewed',
    'signup_submitted',
    'signup_confirmation_required',
    'signup_confirmation_completed',
    'signup_failed',
  ],
  entryStep: 'signup_form_viewed',
  successStep: 'signup_confirmation_completed',
};

export const SIGNIN_FUNNEL: SessionFunnel = {
  steps: [
    'signin_form_viewed',
    'signin_submitted',
    'signin_succeeded',
    'signin_failed',
    'signin_password_reset_initiated',
  ],
  entryStep: 'signin_form_viewed',
  successStep: 'signin_succeeded',
};

/**
 * The columns both modes return, one row per step that any session recorded in the window.
 *
 * - `event_count`: occurrences of the step in sessions that entered the funnel at or before it.
 * - `session_count`: sessions that recorded the step at or after their first entry step.
 * - `sessions_outside_funnel`: sessions that recorded the step, but never at or after an entry step.
 */
export const SESSION_FUNNEL_COLUMNS = ['step', 'event_count', 'session_count', 'sessions_outside_funnel'] as const;
