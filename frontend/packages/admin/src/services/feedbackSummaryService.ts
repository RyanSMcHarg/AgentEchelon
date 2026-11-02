/**
 * The thumbs-up/down summary the Models tab shows, read from the user-feedback API.
 *
 * An ordinary admin catalog route (`view-analytics`, `GET /feedback`): IAM-authorized like every other
 * admin route, so it is SigV4-signed with the console session and the gateway refuses a role that does
 * not hold it. The chat client posts votes to the same API with its Cognito token; only the summary is
 * an admin read.
 *
 * The summary counts every assistant together, per model and intent, so it has no team route. A team
 * console does not ask for it and gets an empty, explained result instead, the same shape
 * `queryAnalytics` returns for an unattributed query.
 */
import i18n from '@ae/shared/i18n';
import type { FeedbackSummaryRow } from '@ae/shared';
import { consoleCredentials, sigv4GetJson } from './sigv4Fetch';
import { teamAssistant } from './teamScope';
import { adminApiConfigured, adminUrl } from './adminApi';

export interface FeedbackSummaryResult {
  data: FeedbackSummaryRow[];
  /** Set when this console cannot be shown the summary at all, with the reason to show instead. */
  unsupported?: boolean;
  reason?: string;
}

function feedbackApiUrl(): string {
  if (!adminApiConfigured()) throw new Error(i18n.t('admin.feedbackSummary.notConfigured'));
  return adminUrl('feedback', '/feedback');
}

/** The feedback summary over the last `days` days. Throws the signed call's error on a refusal or failure. */
export async function fetchFeedbackSummary(days = 30): Promise<FeedbackSummaryResult> {
  if (teamAssistant()) {
    return { data: [], unsupported: true, reason: i18n.t('admin.refusal.notAttributedPerAssistant') };
  }
  const creds = await consoleCredentials();
  const body = await sigv4GetJson<{ data?: FeedbackSummaryRow[] }>(feedbackApiUrl(), { days }, creds);
  return { data: Array.isArray(body?.data) ? body.data : [] };
}
