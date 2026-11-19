/**
 * A TEAM CONSOLE NEVER ASKS FOR WHAT ITS ROUTE DOES NOT ANSWER (SPEC-ADMIN-CONSOLE FR48, FR53).
 *
 * The team analytics route runs only queries bound to one assistant. A view that asks for another - one
 * that counts every assistant together, or one that returns what was said - gets an empty, explained
 * result without a request, rather than a refusal on screen.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.stubEnv('VITE_ADMIN_API_URL', 'https://admin.example.com');
vi.mock('@ae/shared/i18n', () => ({ default: { t: (k: string) => k } }));
const signed = vi.fn(async () => ({ data: [{ intent: 'x' }], columns: [] }));
vi.mock('./sigv4Fetch', () => ({
  consoleCredentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
  sigv4PostJson: (...args: unknown[]) => signed(...(args as [])),
  sigv4GetJson: vi.fn(),
}));

import { queryAnalytics } from './analyticsService';
import { setTeamAssistant } from './teamScope';

describe('queryAnalytics for a team', () => {
  afterEach(() => { setTeamAssistant(null); signed.mockClear(); });

  it('answers an unattributed query locally, without a request', async () => {
    setTeamAssistant('analyst');
    const res = await queryAnalytics('evaluation_exchanges' as never, { start: '2026-01-01', end: '2026-01-02' });
    expect(res.unsupported).toBe(true);
    expect(res.reason).toBe('admin.refusal.notAttributedPerAssistant');
    expect(signed).not.toHaveBeenCalled();
  });

  it('sends an attributed one to the assistant\'s route', async () => {
    setTeamAssistant('analyst');
    await queryAnalytics('intent_effectiveness' as never, { start: '2026-01-01', end: '2026-01-02' });
    expect(signed).toHaveBeenCalledTimes(1);
    expect((signed.mock.calls[0] as unknown[])[0]).toBe('https://admin.example.com/query/analytics/assistants/analyst/query');
  });

  it('sends anything for an admin', async () => {
    const { setReasonProvider, clearReasons } = await import('./adminReason');
    clearReasons();
    const release = setReasonProvider(async () => 'quality review');
    await queryAnalytics('evaluation_exchanges' as never, { start: '2026-01-01', end: '2026-01-02' });
    release();
    expect(signed).toHaveBeenCalledTimes(1);
  });
});

describe('an admin\'s read of conversation content', () => {
  afterEach(() => { signed.mockClear(); });

  it('posts to the content resource with a stated reason, asked once for the content lists', async () => {
    const { setReasonProvider, clearReasons } = await import('./adminReason');
    clearReasons();
    const ask = vi.fn(async () => 'investigating a complaint');
    const release = setReasonProvider(ask);
    for (const q of ['conversation_summaries', 'evaluation_exchanges', 'flagged_responses', 'ground_truth', 'label_queue', 'user_ratings']) {
      await queryAnalytics(q as never, undefined);
    }
    release();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ capability: 'view-events', subject: 'content' }));
    for (const call of signed.mock.calls as unknown[][]) {
      expect(call[0]).toBe('https://admin.example.com/query/events-log');
      expect(call[1]).toMatchObject({ accessReason: 'investigating a complaint' });
    }
  });

  it('reuses the reason a conversation was opened for on that conversation\'s event log', async () => {
    const { setReasonProvider, clearReasons } = await import('./adminReason');
    clearReasons();
    const ask = vi.fn(async () => 'a reported message');
    const release = setReasonProvider(ask);
    await queryAnalytics('channel_events' as never, undefined, { channelArn: 'arn:c1' });
    await queryAnalytics('channel_events' as never, undefined, { channelArn: 'arn:c1' });
    release();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ capability: 'view-events', channelArn: 'arn:c1' }));
  });

  it('asks no reason for an aggregate, or for a write', async () => {
    const { setReasonProvider, clearReasons } = await import('./adminReason');
    clearReasons();
    const ask = vi.fn(async () => 'unused');
    const release = setReasonProvider(ask);
    await queryAnalytics('model_usage' as never, undefined);
    await queryAnalytics('flagged_responses' as never, undefined, { action: 'flag', channelArn: 'arn:c', messageId: 'm1', reason: 'poor_answer' });
    release();
    expect(ask).not.toHaveBeenCalled();
    expect((signed.mock.calls[0] as unknown[])[0]).toBe('https://admin.example.com/query');
    expect((signed.mock.calls[1] as unknown[])[0]).toBe('https://admin.example.com/query/triage');
  });
});

describe('the moderation attribution', () => {
  afterEach(() => { signed.mockReset(); signed.mockImplementation(async () => ({ data: [{ intent: 'x' }], columns: [] })); });

  it('retries while the archive has not yet recorded the moderation, then stops', async () => {
    const { recordModeration, MODERATION_RECORD_ATTEMPTS } = await import('./analyticsService');
    const pending = Object.assign(new Error('not yet'), { status: 409 });
    signed.mockRejectedValueOnce(pending).mockRejectedValueOnce(pending);
    const wait = vi.fn(async () => undefined);
    await recordModeration('arn:c', 'm1', 'redact', wait);
    await vi.waitFor(() => expect(signed).toHaveBeenCalledTimes(3));
    expect(wait).toHaveBeenCalledTimes(2);
    expect(MODERATION_RECORD_ATTEMPTS).toBeGreaterThanOrEqual(3);
  });

  it('does not retry a refusal that is not "not yet recorded"', async () => {
    const { recordModeration } = await import('./analyticsService');
    signed.mockRejectedValueOnce(Object.assign(new Error('no such message'), { status: 404 }));
    const wait = vi.fn(async () => undefined);
    await recordModeration('arn:c', 'm1', 'delete', wait);
    await vi.waitFor(() => expect(signed).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(signed).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});

describe('a team\'s triage and labels', () => {
  afterEach(() => { setTeamAssistant(null); signed.mockClear(); });

  it('writes on the assistant\'s triage and ground-truth routes', async () => {
    setTeamAssistant('analyst');
    await queryAnalytics('flagged_responses' as never, undefined, { action: 'review', exchangeId: 'e1', reviewAction: 'approved' });
    await queryAnalytics('ground_truth' as never, undefined, { action: 'submit', exchangeId: 'e1', score: 80 });
    expect((signed.mock.calls[0] as unknown[])[0]).toBe('https://admin.example.com/query/analytics/assistants/analyst/triage');
    expect((signed.mock.calls[1] as unknown[])[0]).toBe('https://admin.example.com/query/analytics/assistants/analyst/ground-truth');
    // A write names its own turn, so it carries no read reason.
    expect((signed.mock.calls[0] as unknown[])[1]).not.toHaveProperty('accessReason');
  });

  it('reads the response lists with a stated reason, asked once', async () => {
    const { setReasonProvider, clearReasons } = await import('./adminReason');
    clearReasons();
    const ask = vi.fn(async () => 'reviewing last week\'s flags');
    const release = setReasonProvider(ask);
    setTeamAssistant('analyst');
    await queryAnalytics('flagged_responses' as never, undefined);
    await queryAnalytics('ground_truth' as never, undefined);
    release();
    expect(ask).toHaveBeenCalledTimes(1);
    expect((signed.mock.calls[0] as unknown[])[0]).toBe('https://admin.example.com/query/analytics/assistants/analyst/query');
    expect((signed.mock.calls[0] as unknown[])[1]).toMatchObject({ accessReason: 'reviewing last week\'s flags' });
    expect((signed.mock.calls[1] as unknown[])[1]).toMatchObject({ accessReason: 'reviewing last week\'s flags' });
  });
});
