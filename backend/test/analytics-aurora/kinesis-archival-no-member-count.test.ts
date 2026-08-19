/**
 * kinesis-archival - the membership sync publishes no derived member count.
 *
 * The archival path used to follow every membership batch with a per-channel
 * `SELECT COUNT(*) FROM channel_membership` and write the result onto the
 * server-only channel-context item as `memberCount`. Nothing read that
 * attribute: `ChannelContext` never declared it and no read accessor exists,
 * because a count derived from `channel_membership` collapses assistants into
 * the human roster (that table keys on `user_sub`, projected from `/user/`
 * ARNs, so a battle channel of one user and two bots reports 2). The `@all`
 * responder branch therefore resolves size live through
 * `lib/channel-size.ts`, and the derived count cost a query per touched
 * channel, an IAM grant on a table holding private grounding, and an alarm
 * for a value with no consumer.
 *
 * These tests pin the removal at three levels, because the write, the grant
 * and the alarm each advertised a consumer independently.
 */
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
  transaction: jest.fn(async (fn: () => Promise<unknown>) => fn()),
  batchInsert: jest.fn(async () => 1),
  ensureSchema: jest.fn(),
  resetConnection: jest.fn(),
  isAuthError: jest.fn(() => false),
}));
jest.mock('../../lambda/src/analytics-aurora/drift-detection', () => ({
  detectDrift: jest.fn(),
  recordDriftFire: jest.fn(),
}));
jest.mock('../../lambda/src/analytics-aurora/cross-conversation-context', () => ({
  updateConversationContext: jest.fn(),
}));
jest.mock('../../lambda/src/analytics-aurora/turn-events-live', () => ({
  writeTurnEvents: jest.fn(),
}));
jest.mock('../../lambda/src/lib/message-analytics', () => ({
  readMessageAnalytics: jest.fn(async () => null),
}));
jest.mock('../../lambda/src/lib/sleep-mode', () => ({
  touchActivity: jest.fn(),
}));
// The store the count was written to. Kept as a mock so a reintroduced writer is CAUGHT here rather
// than reaching a real DynamoDB client: an assertion below proves this module is not used at all.
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  recordMemberCount: jest.fn(),
  getChannelContext: jest.fn(async () => null),
  putChannelContext: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';
import { query } from '../../lambda/src/analytics-aurora/db-client';
import { handler } from '../../lambda/src/analytics-aurora/kinesis-archival';

const mockedQuery = query as jest.MockedFunction<typeof query>;
const contextStore = jest.requireMock(
  '../../lambda/src/lib/channel-context-client',
) as { recordMemberCount: jest.Mock };

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/c-members';
const MEMBER = 'arn:aws:chime:us-east-1:1:app-instance/a/user/u-1';

function membershipEvent(eventType: string): { kinesis: { data: string } } {
  return {
    kinesis: {
      data: Buffer.from(JSON.stringify({
        EventType: eventType,
        Payload: {
          ChannelArn: CHANNEL,
          Member: { Arn: MEMBER, Name: 'Ada' },
          InvitedBy: { Arn: MEMBER, Name: 'Ada' },
          CreatedTimestamp: '2026-08-18T00:00:00Z',
        },
      })).toString('base64'),
    },
  };
}

function sqlOf(call: unknown[]): string {
  return String(call[0]);
}

describe('the membership sync writes rows and derives no member count', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);
  });

  it('syncs the membership row (the path under test actually ran)', async () => {
    // Asserted FIRST and on its own: every "did not happen" assertion below is vacuous if the
    // membership branch never executed.
    await handler(
      { Records: [membershipEvent('CREATE_CHANNEL_MEMBERSHIP')] } as never,
      { awsRequestId: 'r-1' } as never,
    );
    const insert = mockedQuery.mock.calls.find((c) => /INSERT INTO channel_membership/.test(sqlOf(c)));
    expect(insert).toBeDefined();
    expect((insert as unknown[])[1]).toEqual([CHANNEL, 'u-1']);
  });

  it('issues no per-channel COUNT(*) over channel_membership', async () => {
    await handler(
      {
        Records: [
          membershipEvent('CREATE_CHANNEL_MEMBERSHIP'),
          membershipEvent('DELETE_CHANNEL_MEMBERSHIP'),
        ],
      } as never,
      { awsRequestId: 'r-2' } as never,
    );
    const counts = mockedQuery.mock.calls
      .map(sqlOf)
      .filter((sql) => /COUNT\(\*\)/i.test(sql) && /channel_membership/i.test(sql));
    expect(counts).toEqual([]);
  });

  it('writes nothing to the channel-context store', async () => {
    await handler(
      { Records: [membershipEvent('CREATE_CHANNEL_MEMBERSHIP')] } as never,
      { awsRequestId: 'r-3' } as never,
    );
    expect(contextStore.recordMemberCount).not.toHaveBeenCalled();
  });
});

describe('nothing advertises a consumer for a stored member count', () => {
  const read = (...segments: string[]): string =>
    fs.readFileSync(path.join(__dirname, '..', '..', ...segments), 'utf8');

  const archival = read('lambda', 'src', 'analytics-aurora', 'kinesis-archival.ts');
  const contextClient = read('lambda', 'src', 'lib', 'channel-context-client.ts');
  const channelSize = read('lambda', 'src', 'lib', 'channel-size.ts');
  const auroraStack = read('lib', 'stacks', 'analytics-stack-aurora.ts');

  it('the archival path does not import the channel-context store', () => {
    // The import is the whole coupling: this Lambda has no other use for that table, so its presence
    // means the write is back.
    expect(archival).not.toMatch(/from '\.\.\/lib\/channel-context-client\.js'/);
  });

  it('the store has no member-count writer and no alarm emitter for one', () => {
    expect(contextClient).not.toMatch(/UpdateExpression:\s*'SET memberCount/);
    expect(contextClient).not.toContain('emitMemberCountWriteFailure');
    expect(contextClient).not.toContain('export async function recordMemberCount');
  });

  it('channel size is resolved from live membership, not from a stored count', () => {
    expect(channelSize).toContain('ListChannelMembershipsCommand');
  });

  it('the archival Lambda holds no grant on the channel-context table and no member-count alarm', () => {
    // Source-level because the property is the STACK's: a grant or an alarm left behind claims a
    // consumer that does not exist, which is what made this write look load-bearing.
    expect(auroraStack).not.toContain('channelContextArn');
    expect(auroraStack).not.toContain('CHANNEL_CONTEXT_TABLE');
    expect(auroraStack).not.toContain('ChannelMemberCountWriteFailureAlarm');
    expect(auroraStack).not.toContain('AgentEchelon/ChannelMemberCount');
  });
});
