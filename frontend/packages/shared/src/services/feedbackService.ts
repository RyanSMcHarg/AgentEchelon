import { apiCall } from '../api/apiCall';
import { personUrl } from '../platform/config';

/**
 * One row of the admin feedback summary (`GET /feedback`). The admin console reads it with a signed
 * call (`fetchFeedbackSummary` in the admin package), because that route is AWS_IAM like every admin route.
 */
export interface FeedbackSummaryRow {
  model_name: string;
  intent: string;
  thumbs_up: number;
  thumbs_down: number;
  feedback_count: number;
  approval_rate: number;
}

/**
 * Why a person said a response needed work, as a CLOSED set.
 *
 * A thumbs-down alone says a person was unhappy and nothing about what to fix. The three values
 * here are the three things effectiveness is judged on, so a down vote can be attributed to the
 * axis it actually indicts rather than counted as undifferentiated displeasure:
 *
 * - `wrong_assistant` - the routing was wrong. This is the user-signal counterpart to the
 *   classifier's own confidence and to the post-hoc judge's verdict: a person saying the wrong
 *   assistant answered is direct evidence about classification, not about the answer.
 * - `poor_answer`     - the routing was right and the response was bad.
 * - `asked_again`     - the person had to re-ask to get what they wanted, which is the signal that
 *   shows up as a repeated exchange rather than as an obviously bad one.
 *
 * Open text would fragment into ungroupable prose, so this is closed and the server validates
 * against it (`user-feedback.ts`). It is deliberately OPTIONAL: the vote is recorded the moment it
 * is clicked, and a reason only ever refines a vote that already counted.
 */
export type FeedbackReason = 'wrong_assistant' | 'poor_answer' | 'asked_again';

export const FEEDBACK_REASONS: readonly FeedbackReason[] = ['wrong_assistant', 'poor_answer', 'asked_again'];

function getFeedbackApiUrl(): string {
  return personUrl('/feedback');
}

export async function submitMessageFeedback(payload: {
  messageId: string;
  channelArn: string;
  modelId?: string;
  intent?: string;
  // 'clear' un-votes (recorded server-side for the audit trail; not counted).
  feedback: 'up' | 'down' | 'clear';
  /**
   * Which axis a `down` indicts. Only ever sent as a REFINEMENT of a vote already recorded, so the
   * person is never made to answer this before their vote counts.
   */
  reason?: FeedbackReason;
  note?: string;
  // Feedback join: the experiment + variant
  // that served this message, so thumbs aggregate per variant. Lifted from the
  // bot message's Chime analytics metadata onto the Message (chimeService +
  // MessagingProvider) and forwarded here by ConversationInterface.handleFeedback;
  // undefined for messages not served by an experiment (the common case).
  experimentId?: string;
  variantId?: string;
  assignmentMode?: string;
}, token?: string): Promise<void> {
  await apiCall(getFeedbackApiUrl(), '', {
    method: 'POST',
    body: payload,
    token,
  });
}
