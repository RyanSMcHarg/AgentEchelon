/**
 * model-backfill — historical model/telemetry reconciliation unit tests.
 *
 * Pins the contract that the backfill:
 *   - scans the out-of-band DynamoDB analytics table (paginated);
 *   - folds bedrockModel + token/latency onto CREATE rows, COALESCE-guarded and
 *     only where bedrock_model IS NULL (idempotent);
 *   - skips items missing messageId / channelArn / bedrockModel;
 *   - reports scanned / withModel / messagesPatched counts.
 */

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  ScanCommand: jest.fn((input) => ({ __scan: input })),
}));
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({ query: jest.fn() }));

import { query } from '../../lambda/src/analytics-aurora/db-client';
import { backfillModelFromAnalytics } from '../../lambda/src/analytics-aurora/model-backfill';

const mockedQuery = query as jest.MockedFunction<typeof query>;

describe('model-backfill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MESSAGE_ANALYTICS_TABLE = 'test-analytics-table';
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 1 } as any);
  });

  it('folds model + telemetry onto CREATE rows, guarded and idempotent', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { messageId: 'm1', channelArn: 'c1', bedrockModel: 'anthropic.claude-3-haiku-20240307-v1:0', inputTokens: 10, outputTokens: 20, latencyMs: 900, totalMs: 1200, pollMs: 300, agentType: 'basic' },
        { messageId: 'm2', channelArn: 'c1', bedrockModel: 'us.anthropic.claude-sonnet-4-6', inputTokens: '5', outputTokens: '7' },
      ],
      LastEvaluatedKey: undefined,
    });

    
    const result = await backfillModelFromAnalytics();

    expect(result).toEqual({ scanned: 2, withModel: 2, messagesPatched: 2 });
    expect(mockedQuery).toHaveBeenCalledTimes(2);

    const [sql, params] = mockedQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE messages/);
    expect(sql).toMatch(/bedrock_model\s*=\s*COALESCE\(bedrock_model, \$1\)/);
    expect(sql).toMatch(/event_type = 'CREATE_CHANNEL_MESSAGE'/);
    expect(sql).toMatch(/bedrock_model IS NULL/);
    // param order: model, in, out, latency, total, poll, agentType, channelArn, messageId
    expect(params[0]).toBe('anthropic.claude-3-haiku-20240307-v1:0');
    expect(params[7]).toBe('c1');
    expect(params[8]).toBe('m1');
    // string token counts are coerced to ints
    const [, params2] = mockedQuery.mock.calls[1] as [string, unknown[]];
    expect(params2[1]).toBe(5);
    expect(params2[2]).toBe(7);
  });

  it('skips items missing messageId/channelArn/model and paginates', async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [
          { messageId: 'm1', channelArn: 'c1' }, // no model -> skip
          { messageId: '', channelArn: 'c1', bedrockModel: 'x' }, // no id -> skip
        ],
        LastEvaluatedKey: { messageId: 'm1' },
      })
      .mockResolvedValueOnce({
        Items: [
          { messageId: 'm9', channelArn: 'c2', bedrockModel: 'model-z' }, // patched
        ],
        LastEvaluatedKey: undefined,
      });

    
    const result = await backfillModelFromAnalytics();

    expect(mockSend).toHaveBeenCalledTimes(2); // paginated
    expect(result.scanned).toBe(3);
    expect(result.withModel).toBe(1);
    expect(result.messagesPatched).toBe(1);
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it('throws when the analytics table env is unset', async () => {
    jest.resetModules();
    delete process.env.MESSAGE_ANALYTICS_TABLE;
    
    await expect(backfillModelFromAnalytics()).rejects.toThrow(/MESSAGE_ANALYTICS_TABLE/);
  });
});
