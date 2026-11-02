/**
 * THE FEEDBACK SUMMARY IS A SIGNED ADMIN READ (SPEC-ADMIN-CONSOLE FR43).
 *
 * `GET /feedback` is an `AWS_IAM` catalog route like every other admin route, so the console signs it
 * with its console session. It was sent with a Cognito Bearer token instead, which the gateway refuses
 * on an IAM route, and the refusal was swallowed into an empty table.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.stubEnv('VITE_ADMIN_API_URL', 'https://admin.example.com/');
vi.mock('@ae/shared/i18n', () => ({ default: { t: (k: string) => k } }));
const creds = { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c' };
const signedGet = vi.fn(async () => ({ data: [{ model_name: 'm', intent: 'i', thumbs_up: 1, thumbs_down: 0, feedback_count: 1, approval_rate: 100 }] }));
vi.mock('./sigv4Fetch', () => ({
  consoleCredentials: async () => creds,
  sigv4GetJson: (...args: unknown[]) => signedGet(...(args as [])),
}));

import { fetchFeedbackSummary } from './feedbackSummaryService';
import { setTeamAssistant } from './teamScope';

describe('fetchFeedbackSummary', () => {
  afterEach(() => { setTeamAssistant(null); signedGet.mockClear(); });

  it('signs a GET to the feedback route with the console session', async () => {
    const res = await fetchFeedbackSummary(30);
    expect(signedGet).toHaveBeenCalledTimes(1);
    expect(signedGet).toHaveBeenCalledWith('https://admin.example.com/feedback', { days: 30 }, creds);
    expect(res.data).toHaveLength(1);
    expect(res.unsupported).toBeUndefined();
  });

  it('passes a refusal through, so the tab can say it rather than show an empty table', async () => {
    signedGet.mockImplementationOnce(async () => { throw new Error('admin.refusal.lacksCapability'); });
    await expect(fetchFeedbackSummary(30)).rejects.toThrow('admin.refusal.lacksCapability');
  });

  it('asks nothing for a team console, because the summary counts every assistant together', async () => {
    setTeamAssistant('analyst');
    const res = await fetchFeedbackSummary(30);
    expect(signedGet).not.toHaveBeenCalled();
    expect(res).toEqual({ data: [], unsupported: true, reason: 'admin.refusal.notAttributedPerAssistant' });
  });
});
