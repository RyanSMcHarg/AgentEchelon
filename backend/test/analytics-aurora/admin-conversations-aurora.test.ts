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
  adminListEvents,
  adminMembershipHistory,
} from '../../lambda/src/analytics-aurora/admin-conversations-aurora';

const mockedQuery = query as jest.MockedFunction<typeof query>;

describe('admin-conversations-aurora', () => {
  beforeAll(async () => {
    // adminListMessages calls a memoized ensureModerationTable() (two DDL queries) on first use.
    // Warm it once here with a benign default so each test's mockResolvedValueOnce maps to the real
    // read query, not the DDL. After this, moderationTableReady stays true for the rest of the file.
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as any);
    await adminListMessages('warmup');
    mockedQuery.mockReset();
  });

  beforeEach(() => jest.clearAllMocks());

  it('lists conversations grouped by channel with name + classification', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ channel_arn: 'c1', classification: 'premium', name: 'Q3 Forecast', message_count: '12', last_message_at: '2026-07-15T00:05:00Z' }],
      rowCount: 1,
    } as any);
    const out = await adminListConversations(50);
    const [sql] = mockedQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/event_type IN \('CREATE_CHANNEL','UPDATE_CHANNEL'\)/); // name source
    expect(sql).toMatch(/CREATE_CHANNEL_MESSAGE/);
    expect(out[0]).toEqual({
      channelArn: 'c1', name: 'Q3 Forecast', messageCount: 12,
      lastMessageAt: '2026-07-15T00:05:00Z', memberCount: 0,
      state: 'live',
      metadata: { modelTier: 'premium' },
    });
  });

  it('derives lifecycle state: deleted wins over archived, else archived, else live', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        { channel_arn: 'c1', classification: 'premium', name: 'Live one', message_count: '4', last_message_at: '2026-07-15T00:05:00Z', member_count: '2', is_deleted: false, is_archived: false },
        { channel_arn: 'c2', classification: 'standard', name: 'Archived one', message_count: '9', last_message_at: '2026-07-14T00:00:00Z', member_count: '0', is_deleted: false, is_archived: true },
        { channel_arn: 'c3', classification: 'premium', name: 'Deleted one', message_count: '3', last_message_at: '2026-07-13T00:00:00Z', member_count: '0', is_deleted: true, is_archived: true },
      ],
      rowCount: 3,
    } as any);
    const out = await adminListConversations();
    const [sql] = mockedQuery.mock.calls[0] as [string];
    // State is derived from the archived channel events, not a live Chime read.
    expect(sql).toMatch(/DELETE_CHANNEL/);
    expect(sql).toMatch(/metadata->>'archived' = 'true'/);
    expect(out.map((c) => c.state)).toEqual(['live', 'archived', 'deleted']); // deleted wins over archived on c3
  });

  it('falls back to "Untitled Conversation" when no channel name row exists', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ channel_arn: 'c2', classification: null, name: null, message_count: '3', last_message_at: null }],
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
        // intent is projected from the exchange (SELECT ... AS intent), NOT read from
        // metadata — the messages row has no intent, so metadata.intent was always blank.
        total_ms: 1200, intent: 'general', metadata: {},
      }],
      rowCount: 1,
    } as any);
    const out = await adminListMessages('c1');
    const [sql] = mockedQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/event_type = 'CREATE_CHANNEL_MESSAGE'/);
    // Intent must come from the exchange, keyed by either side of the pair.
    expect(sql).toMatch(/exchanges/);
    expect(sql).toMatch(/agent_message_id|user_message_id/);
    expect(out[0].content).toBe('Done.'); // markers stripped
    expect(out[0].isBot).toBe(true);
    expect(out[0].modelId).toBe('anthropic.claude-3-haiku');
    expect(out[0].intent).toBe('general');
    expect(out[0].raw?.MessageId).toBe('m1');
  });

  it('derives redaction from the -RED sibling row: flag set, content + raw blanked', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{
        message_id: 'm1',
        content: 'my SSN is 123-45-6789',
        sender_name: 'Ada', sender_arn: 'a/user/1', created_at: '2026-07-15T00:01:00Z',
        is_bot: false, bedrock_model: null, input_tokens: null, output_tokens: null,
        total_ms: null, metadata: {}, redacted: true,
      }],
      rowCount: 1,
    } as any);
    const out = await adminListMessages('c1');
    const [sql] = mockedQuery.mock.calls[0] as [string];
    // Redaction is derived by joining the sibling REDACT event, not a column.
    expect(sql).toMatch(/event_type = 'REDACT_CHANNEL_MESSAGE'/);
    expect(sql).toMatch(/\|\| '-RED'/);
    expect(out[0].redacted).toBe(true);
    expect(out[0].content).toBe(''); // original content must not leak
    expect(out[0].raw?.Content).toBe('');
    expect(out[0].raw?.Redacted).toBe(true);
  });

  it('derives deletion from the -DEL sibling row: content + raw blanked, deleted flag set', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{
        message_id: 'm2',
        content: 'sensitive text the moderator removed',
        sender_name: 'Ada', sender_arn: 'a/user/1', created_at: '2026-07-15T00:02:00Z',
        is_bot: false, bedrock_model: null, input_tokens: null, output_tokens: null,
        total_ms: null, metadata: {}, redacted: false, deleted: true,
      }],
      rowCount: 1,
    } as any);
    const out = await adminListMessages('c1');
    const [sql] = mockedQuery.mock.calls[0] as [string];
    // Deletion is derived by joining the sibling DELETE event, not a column.
    expect(sql).toMatch(/event_type = 'DELETE_CHANNEL_MESSAGE'/);
    expect(sql).toMatch(/\|\| '-DEL'/);
    expect(out[0].deleted).toBe(true);
    expect(out[0].redacted).toBe(false);
    expect(out[0].content).toBe(''); // deleted content must not leak
    expect(out[0].raw?.Content).toBe('');
    expect(out[0].raw?.Deleted).toBe(true);
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

  it('event log blanks moderated content on EVERY message-content row incl. the -UPD finalized row', async () => {
    // A redacted bot reply: CREATE (placeholder), UPDATE (`-UPD`, the finalized text), and the REDACT
    // event. `moderated` is true for the message-content rows (the base has a -RED sibling). Content
    // must be blanked on BOTH the CREATE and the -UPD row; a NON-moderated update still shows content.
    mockedQuery.mockResolvedValueOnce({
      rows: [
        { event_type: 'CREATE_CHANNEL_MESSAGE', message_id: 'm1', sender_name: 'Bot', sender_arn: 'a/bot/1', target_arn: null, content: 'One moment…', created_at: '2026-07-18T00:00:00Z', is_bot: true, metadata: {}, moderated: true },
        { event_type: 'UPDATE_CHANNEL_MESSAGE', message_id: 'm1-UPD', sender_name: 'Bot', sender_arn: 'a/bot/1', target_arn: null, content: 'the SECRET final answer', created_at: '2026-07-18T00:00:01Z', is_bot: true, metadata: {}, moderated: true },
        { event_type: 'REDACT_CHANNEL_MESSAGE', message_id: 'm1-RED', sender_name: 'Bot', sender_arn: 'a/bot/1', target_arn: null, content: '', created_at: '2026-07-18T00:01:00Z', is_bot: true, metadata: {}, moderated: true },
        { event_type: 'UPDATE_CHANNEL_MESSAGE', message_id: 'm2-UPD', sender_name: 'Bot', sender_arn: 'a/bot/1', target_arn: null, content: 'a normal visible answer', created_at: '2026-07-18T00:02:00Z', is_bot: true, metadata: {}, moderated: false },
      ],
      rowCount: 4,
    } as any);
    const out = await adminListEvents('c1');
    const [sql] = mockedQuery.mock.calls[0] as [string];
    // The moderation check must key off the BASE id (strip the -UPD/-RED/-DEL suffix), not the row id.
    expect(sql).toMatch(/regexp_replace\(m\.message_id, '-\(UPD\|RED\|DEL\)\$'/);
    expect(out[0].content).toBe(''); // CREATE placeholder blanked
    expect(out.find((e) => e.messageId === 'm1-UPD')!.content).toBe(''); // the finalized text must NOT leak
    expect(out.find((e) => e.messageId === 'm2-UPD')!.content).toBe('a normal visible answer'); // non-moderated shows
    expect(out.some((e) => (e.content || '').includes('SECRET'))).toBe(false); // nothing leaks the secret
  });
});
