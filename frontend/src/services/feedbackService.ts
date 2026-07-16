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

function getIdToken(): string {
  const idToken = localStorage.getItem('idToken');
  if (!idToken) throw new Error('Not authenticated');
  return idToken;
}

async function feedbackRequest(path = '', init: RequestInit = {}, token?: string) {
  const idToken = token || getIdToken();

  const response = await fetch(`${getFeedbackApiUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }

  return response.json();
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
  await feedbackRequest('', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, token);
}

export async function getFeedbackSummary(days = 30, token?: string): Promise<FeedbackSummaryRow[]> {
  const result = await feedbackRequest(`?days=${days}`, { method: 'GET' }, token);
  return result.data || [];
}
