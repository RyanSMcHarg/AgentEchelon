/**
 * AN EMPTY DATE RANGE IS NOT "NO WINDOW" - IT IS A NAMED WINDOW THAT CANNOT BE READ, AND IT IS REFUSED.
 *
 * The backend draws the distinction deliberately (`analytics-aurora/analytics-query.ts`): `dateRange`
 * ABSENT means no window was named and the query's own default stands for it, while `dateRange` PRESENT
 * and unusable is REFUSED rather than answered with a different window - because the one thing it must
 * never do is answer a named window with a different one. Its error message even names the fix: "omit
 * dateRange to accept the default window".
 *
 * Three call sites in `analyticsService` passed `{ start: '', end: '' }` to mean "all of it", which is
 * PRESENT and unusable, so all three took a 400:
 *
 *   - the conversation Events panel showed the operator "Analytics query failed: 400" where the archived
 *     event log should be. Not a blank panel - the refusal text renders in the empty-message area, which
 *     is why it read as an empty conversation rather than as a broken request;
 *   - `record_moderation`, a best-effort audit whose callers deliberately ignore failures, failed every
 *     single time and by design said nothing;
 *   - `writeAnalytics` defaulted to the same empty range for any caller that did not pass one.
 *
 * Normalized at the SEAM rather than at the three call sites, so the next caller reaching for an empty
 * range to mean "everything" is also covered. These tests pin the seam, not the call sites.
 *
 * The TRANSPORT is mocked rather than `queryAnalytics`, because the call sites reach it inside their own
 * module where an export mock does not reach - the same reason `aRefusedWriteIsNotASuccess` does it.
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

import { queryAnalytics, listChannelEvents, recordModeration } from './analyticsService';

const postedBody = () =>
  (mockApiCall.mock.calls[0]?.[1] as Record<string, unknown> | undefined) ?? {};

beforeEach(() => {
  mockApiCall.mockReset();
  mockApiCall.mockResolvedValue({ data: [] });
});

describe('the analytics seam omits a window it cannot name', () => {
  it('sends no dateRange at all when both bounds are blank', async () => {
    await queryAnalytics('channel_events', { start: '', end: '' }, { channelArn: 'arn:test' });
    expect(postedBody()).not.toHaveProperty('dateRange');
  });

  it('sends no dateRange when it is undefined', async () => {
    await queryAnalytics('channel_events', undefined, { channelArn: 'arn:test' });
    expect(postedBody()).not.toHaveProperty('dateRange');
  });

  it('sends no dateRange when only one bound is present, because a half window is not a window', async () => {
    await queryAnalytics('channel_events', { start: '2026-09-01', end: '' }, {});
    expect(postedBody()).not.toHaveProperty('dateRange');
  });

  it('PASSES A REAL WINDOW THROUGH UNCHANGED, which is the half that must not regress', async () => {
    const named = { start: '2026-09-01', end: '2026-09-28' };
    await queryAnalytics('intent_effectiveness', named, {});
    expect(postedBody().dateRange).toEqual(named);
  });

  it('keeps the queryType and the extra params either way', async () => {
    await queryAnalytics('channel_events', { start: '', end: '' }, { channelArn: 'arn:test' });
    expect(postedBody()).toMatchObject({ queryType: 'channel_events', channelArn: 'arn:test' });
  });
});

describe('the two call sites the operator actually meets', () => {
  it('the Events panel asks for the whole log rather than a window it cannot name', async () => {
    await listChannelEvents('arn:aws:chime:test:channel/abc');
    expect(postedBody()).not.toHaveProperty('dateRange');
    expect(postedBody()).toMatchObject({ queryType: 'channel_events' });
  });

  it('the moderation audit is not silently refused on every call', async () => {
    await recordModeration('arn:aws:chime:test:channel/abc', 'msg-1', 'redact');
    expect(postedBody()).not.toHaveProperty('dateRange');
    expect(postedBody()).toMatchObject({ queryType: 'record_moderation', moderation: 'redact' });
  });
});
