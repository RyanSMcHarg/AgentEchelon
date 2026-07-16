/**
 * Unit tests for cross-conversation context module
 *
 * Tests related conversation lookup and context update logic.
 * Mocks the database client.
 */

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
}));

import { query } from '../../lambda/src/analytics-aurora/db-client';

const mockedQuery = query as jest.MockedFunction<typeof query>;

function mockQueryResult(rows: any[], rowCount?: number) {
  return { rows, rowCount: rowCount ?? rows.length, command: '', oid: 0, fields: [] as any[] };
}

describe('Cross-Conversation Context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DB_HOST = 'localhost';
    process.env.DB_PORT = '5432';
    process.env.DB_NAME = 'analytics';
    process.env.DB_USER = 'testuser';
    process.env.DB_REGION = 'us-east-1';
  });

  describe('findRelatedConversations', () => {
    it('should return empty array when user has no prior conversations', async () => {
      // First call: embeddings check
      mockedQuery.mockResolvedValueOnce(mockQueryResult([{ count: '0' }]));
      // Second call: keyword search
      mockedQuery.mockResolvedValueOnce(mockQueryResult([]));

      const { findRelatedConversations } = await import(
        '../../lambda/src/analytics-aurora/cross-conversation-context'
      );

      const result = await findRelatedConversations('user-sub-123', 'product management');

      expect(result).toEqual([]);
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('cross_conversation_context'),
        expect.arrayContaining(['user-sub-123'])
      );
    });

    it('should return related conversations ranked by relevance', async () => {
      // First call: embeddings check
      mockedQuery.mockResolvedValueOnce(mockQueryResult([{ count: '0' }]));
      // Second call: keyword search
      mockedQuery.mockResolvedValueOnce(mockQueryResult([
          {
            channel_arn: 'channel-1',
            topic: 'Senior PM role at Acme',
            summary: 'Discussed qualifications and interview process',
            relevance_score: '0.85',
            updated_at: '2026-04-01T10:00:00Z',
          },
          {
            channel_arn: 'channel-2',
            topic: 'Engineering leadership',
            summary: 'Talked about team scaling challenges',
            relevance_score: '0.45',
            updated_at: '2026-03-28T14:00:00Z',
          },
      ]));

      const { findRelatedConversations } = await import(
        '../../lambda/src/analytics-aurora/cross-conversation-context'
      );

      const result = await findRelatedConversations('user-sub-123', 'product management', 5);

      expect(result).toHaveLength(2);
      expect(result[0].relevanceScore).toBeGreaterThan(result[1].relevanceScore);
      expect(result[0].channelArn).toBe('channel-1');
    });

    it('should respect the limit parameter', async () => {
      // First call: embeddings check
      mockedQuery.mockResolvedValueOnce(mockQueryResult([{ count: '0' }]));
      // Second call: keyword search
      mockedQuery.mockResolvedValueOnce(mockQueryResult([
          { channel_arn: 'c1', topic: 'A', summary: 'S1', relevance_score: '0.9', updated_at: '2026-04-01' },
      ]));

      const { findRelatedConversations } = await import(
        '../../lambda/src/analytics-aurora/cross-conversation-context'
      );

      await findRelatedConversations('user-sub-123', 'test', 1);

      // Verify LIMIT was passed to query
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT'),
        expect.any(Array)
      );
    });
  });

  describe('updateConversationContext', () => {
    it('should upsert context record for user + channel', async () => {
      mockedQuery.mockResolvedValueOnce(mockQueryResult([], 1));

      const { updateConversationContext } = await import(
        '../../lambda/src/analytics-aurora/cross-conversation-context'
      );

      await updateConversationContext(
        'user-sub-123',
        'arn:aws:chime:us-east-1:123456789012:app-instance/test/channel/abc',
        'PM role discussion',
        'Discussed qualifications and next steps for the senior PM position'
      );

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO cross_conversation_context'),
        expect.arrayContaining(['user-sub-123', expect.stringContaining('channel')])
      );
    });

    it('should update existing context on conflict', async () => {
      mockedQuery.mockResolvedValueOnce(mockQueryResult([], 1));

      const { updateConversationContext } = await import(
        '../../lambda/src/analytics-aurora/cross-conversation-context'
      );

      await updateConversationContext('user-sub-123', 'channel-1', 'New topic', 'Updated summary');

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT'),
        expect.any(Array)
      );
    });
  });
});
