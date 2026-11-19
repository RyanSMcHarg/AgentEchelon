/**
 * A MEETING'S TRANSCRIPT IS READ ONLY WITH A REASON: the console asks for the operator's reason under `view-events`,
 * sends it with the read, and sends nothing when the operator gives none.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@ae/shared/i18n';
import { ApiError } from '@ae/shared';

const sigv4GetJson = vi.fn();
vi.mock('./sigv4Fetch', () => ({
  sigv4GetJson: (...a: unknown[]) => sigv4GetJson(...a),
  consoleCredentials: async () => ({ accessKeyId: 'a', secretAccessKey: 's' }),
  adminRequest: vi.fn(),
}));
vi.mock('./adminApi', () => ({ adminUrl: (_s: string, p: string) => `https://admin.example${p}`, adminApiServes: () => true }));

import { fetchMeetingContent } from './meetingAnalyticsService';
import { clearReasons, setReasonProvider, ReasonDeclinedError } from './adminReason';

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/meet-1';

beforeEach(() => {
  vi.clearAllMocks();
  clearReasons();
});

describe('a meeting transcript read', () => {
  it('asks for the reason under the content capability and sends it with the read', async () => {
    const asked = vi.fn(async () => 'A customer asked what was agreed');
    const stop = setReasonProvider(asked);
    sigv4GetJson.mockResolvedValue({ meetingId: 'm-1', transcript: 'hello', summary: null });
    expect(await fetchMeetingContent('m-1', CHANNEL, 7)).toEqual({ transcript: 'hello', summary: null });
    expect(asked).toHaveBeenCalledWith(expect.objectContaining({ capability: 'view-events', channelArn: CHANNEL, kind: 'read' }));
    expect(sigv4GetJson).toHaveBeenCalledWith('https://admin.example/admin/meetings/m-1/transcript', { days: 7, accessReason: 'A customer asked what was agreed' }, expect.anything());
    stop();
  });

  it('sends nothing when the operator gives no reason', async () => {
    const stop = setReasonProvider(async () => null);
    await expect(fetchMeetingContent('m-1', CHANNEL, 7)).rejects.toBeInstanceOf(ReasonDeclinedError);
    expect(sigv4GetJson).not.toHaveBeenCalled();
    stop();
  });

  it('answers a meeting with no transcript written as none', async () => {
    const stop = setReasonProvider(async () => 'why');
    sigv4GetJson.mockRejectedValue(new ApiError(404, 'none'));
    expect(await fetchMeetingContent('m-1', CHANNEL, 7)).toBeNull();
    stop();
  });
});
