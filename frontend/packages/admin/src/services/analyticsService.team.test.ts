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
    await queryAnalytics('evaluation_exchanges' as never, { start: '2026-01-01', end: '2026-01-02' });
    expect(signed).toHaveBeenCalledTimes(1);
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
