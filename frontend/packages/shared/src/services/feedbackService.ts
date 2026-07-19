import { apiCall } from '../api/apiCall';

export interface FeedbackSummaryRow {
  model_name: string;
  intent: string;
  thumbs_up: number;
  thumbs_down: number;
  feedback_count: number;
  approval_rate: number;
}

function getFeedbackApiUrl(): string {
  const url = import.meta.env.VITE_USER_FEEDBACK_API_URL;
  if (!url) throw new Error('VITE_USER_FEEDBACK_API_URL not configured');
  return url;
}

export async function submitMessageFeedback(payload: {
  messageId: string;
  channelArn: string;
  modelId?: string;
  intent?: string;
  // 'clear' un-votes (recorded server-side for the audit trail; not counted).
  feedback: 'up' | 'down' | 'clear';
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

export async function getFeedbackSummary(days = 30, token?: string): Promise<FeedbackSummaryRow[]> {
  const result = await apiCall<{ data?: FeedbackSummaryRow[] }>(getFeedbackApiUrl(), '', {
    method: 'GET',
    query: { days },
    token,
  });
  return result.data || [];
}
