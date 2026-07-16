/**
 * admin-conversations-aurora — the Aurora read path for the admin Conversations
 * views (BUG #21). Pins the query targets and the row→response mapping (incl.
 * marker stripping and the channel-name/member-name parity fields).
 */
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({ query: jest.fn() }));

import { query } from '../../lambda/src/analytics-aurora/db-client';
import {
  adminListConversations,
  adminListMessages,
  adminMembershipHistory,
} from '../../lambda/src/analytics-aurora/admin-conversations-aurora';

const mockedQuery = query as jest.MockedFunction<typeof query>;

describe('admin-conversations-aurora', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists conversations grouped by channel with name + tier', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ channel_arn: 'c1', tier: 'premium', name: 'Q3 Forecast', message_count: '12', last_message_at: '2026-07-15T00:05:00Z' }],
      rowCount: 1,
    } as any);
    const out = await adminListConversations(50);
    const [sql] = mockedQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/event_type IN \('CREATE_CHANNEL','UPDATE_CHANNEL'\)/); // name source
    expect(sql).toMatch(/CREATE_CHANNEL_MESSAGE/);
    expect(out[0]).toEqual({
      channelArn: 'c1', name: 'Q3 Forecast', messageCount: 12,
      lastMessageAt: '2026-07-15T00:05:00Z', memberCount: 0,
      metadata: { modelTier: 'premium' },
    });
  });

  it('falls back to "Untitled Conversation" when no channel name row exists', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ channel_arn: 'c2', tier: null, name: null, message_count: '3', last_message_at: null }],
      rowCount: 1,
    } as any);
    const out = await adminListConversations();
    expect(out[0].name).toBe('Untitled Conversation');
    expect(out[0].metadata.modelTier).toBe('');
  });

  it('lists messages, strips markers, exposes model/intent + inspect raw', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{
        message_id: 'm1',
        content: 'Done.<!--corr:abc--> NAVIGATE_CHANNEL:arn:x|Follow-up',
        sender_name: 'Assistant', sender_arn: 'a/bot/1', created_at: '2026-07-15T00:01:00Z',
        is_bot: true, bedrock_model: 'anthropic.claude-3-haiku', input_tokens: 5, output_tokens: 9,
        total_ms: 1200, metadata: { intent: 'general' },
      }],
      rowCount: 1,
    } as any);
    const out = await adminListMessages('c1');
    const [sql] = mockedQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/event_type = 'CREATE_CHANNEL_MESSAGE'/);
    expect(out[0].content).toBe('Done.'); // markers stripped
    expect(out[0].isBot).toBe(true);
    expect(out[0].modelId).toBe('anthropic.claude-3-haiku');
    expect(out[0].intent).toBe('general');
    expect(out[0].raw?.MessageId).toBe('m1');
  });

  it('maps membership events to actions with member/inviter names', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        { event_type: 'CREATE_CHANNEL_MEMBERSHIP', member_arn: 'u/user/1', member_name: 'Ada', invited_by: 'Admin', at: '2026-07-15T00:00:00Z' },
        { event_type: 'DELETE_CHANNEL_MODERATOR', member_arn: 'u/bot/2', member_name: 'Bot', invited_by: null, at: '2026-07-15T00:02:00Z' },
      ],
      rowCount: 2,
    } as any);
    const out = await adminMembershipHistory('c1');
    const [sql] = mockedQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/target_arn\s+AS member_arn/);
    expect(sql).toMatch(/content\s+AS member_name/);
    expect(out[0]).toEqual({ action: 'joined', memberArn: 'u/user/1', memberName: 'Ada', invitedBy: 'Admin', timestamp: '2026-07-15T00:00:00Z', isBot: false });
    expect(out[1]).toMatchObject({ action: 'revoked_moderator', memberName: 'Bot', isBot: true });
  });
});
