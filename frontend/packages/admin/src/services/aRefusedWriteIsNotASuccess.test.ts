/**
 * A REFUSED WRITE ARRIVES AS HTTP 200, AND AWAITING IT IS NOT CHECKING IT.
 *
 * The analytics write actions answer `{ submitted | flagged | reviewed | unflagged: false, error }` with
 * a 200 status: the request was well-formed and authorized, and what failed is the write's own
 * precondition - a label that cannot be attributed to a caller, a missing reason, an unknown verdict.
 * `apiCall` and `sigv4PostJson` throw only on a non-2xx, so a caller that awaits and moves on reports
 * SUCCESS for a write that never happened: the console refreshes, no error appears, and the row is
 * simply absent.
 *
 * THAT IS THE SAME FAILURE THE SERVER-SIDE GUARD EXISTS TO PREVENT, ONE LAYER UP. The backend refuses an
 * unattributable ground-truth label precisely because a label with nobody's name against it "succeeds and
 * then counts"; a refusal the operator never sees is a refusal that succeeds and then vanishes.
 *
 * The rule is verb-agnostic on purpose: a non-empty `error` on a write envelope means the write did not
 * happen, whatever the action is called. Reads never carry one.
 *
 * The TRANSPORT is mocked rather than `queryAnalytics`, because `writeAnalytics` calls it inside its own
 * module, where an export mock does not reach.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every analytics call is signed (all admin routes are IAM-authorized), so the transport is the signed
// POST. `mockApiCall` keeps its name: it is the one transport these tests assert against.
const mockApiCall = vi.fn();
vi.mock('./sigv4Fetch', () => ({
  consoleCredentials: async () => ({ accessKeyId: 'AKIA', secretAccessKey: 'secret' }),
  sigv4PostJson: (...args: unknown[]) => mockApiCall(...args),
  sigv4GetJson: (...args: unknown[]) => mockApiCall(...args),
}));
vi.mock('@ae/shared/i18n', () => ({ default: { t: (k: string) => k } }));
vi.stubEnv('VITE_ADMIN_API_URL', 'https://admin.example.com/');

import { writeAnalytics } from './analyticsService';

/** The request body the service posted, for the payload assertions. */
const postedBody = () =>
  (mockApiCall.mock.calls[0]?.[1] as Record<string, unknown> | undefined) ?? {};

beforeEach(() => mockApiCall.mockReset());

describe('writeAnalytics refuses to report a refusal as a success', () => {
  it("throws the server's own reason when a 200 carries a refusal", async () => {
    // The exact envelope the ground-truth submit returns for a caller it cannot attribute.
    mockApiCall.mockResolvedValue({ submitted: false, error: 'Unable to attribute the label to a caller' });
    await expect(
      writeAnalytics('ground_truth', { action: 'submit', exchangeId: 'e1', score: 80 }),
    ).rejects.toThrow(/Unable to attribute the label to a caller/);
  });

  it('applies to any write verb, not just the one it was found on', async () => {
    mockApiCall.mockResolvedValue({ flagged: false, error: 'channelArn, messageId and a reason required' });
    await expect(writeAnalytics('flagged_responses', { action: 'flag' })).rejects.toThrow(/a reason required/);
  });

  it('resolves quietly when the write was accepted', async () => {
    mockApiCall.mockResolvedValue({ submitted: true });
    await expect(
      writeAnalytics('ground_truth', { action: 'submit', exchangeId: 'e1', score: 80 }),
    ).resolves.toBeUndefined();
  });

  it('does not invent a failure from an empty or absent error field', async () => {
    // A blank string is not a refusal, and neither is a missing key. Treating either as one would
    // surface phantom errors on writes that succeeded.
    mockApiCall.mockResolvedValue({ reviewed: true, error: '   ' });
    await expect(writeAnalytics('flagged_responses', { action: 'review' })).resolves.toBeUndefined();

    mockApiCall.mockResolvedValue({ unflagged: true });
    await expect(writeAnalytics('flagged_responses', { action: 'unflag' })).resolves.toBeUndefined();
  });

  it("sends the caller's payload through unchanged", async () => {
    mockApiCall.mockResolvedValue({ submitted: true });
    await writeAnalytics('ground_truth', { action: 'submit', exchangeId: 'e9', score: 42 });
    expect(postedBody()).toMatchObject({
      queryType: 'ground_truth',
      action: 'submit',
      exchangeId: 'e9',
      score: 42,
    });
  });

  it('never names the scorer, because the server derives that from the verified caller', async () => {
    mockApiCall.mockResolvedValue({ submitted: true });
    await writeAnalytics('ground_truth', { action: 'submit', exchangeId: 'e9', score: 42 });
    expect(Object.keys(postedBody())).not.toContain('scorerId');
  });
});

describe('each write lands on its own capability resource', () => {
  const postedUrl = () => String(mockApiCall.mock.calls[0]?.[0] ?? '');
  beforeEach(() => mockApiCall.mockResolvedValue({ ok: true }));

  it('posts a flag, an unflag and a review to triage, never to the read bundle', async () => {
    for (const action of ['flag', 'unflag', 'review']) {
      mockApiCall.mockClear();
      await writeAnalytics('flagged_responses', { action });
      expect(postedUrl()).toBe('https://admin.example.com/query/triage');
    }
  });

  it('posts a ground-truth label to ground-truth', async () => {
    await writeAnalytics('ground_truth', { action: 'submit', exchangeId: 'e1', score: 80 });
    expect(postedUrl()).toBe('https://admin.example.com/query/ground-truth');
  });
});
