/**
 * A HIDDEN JOIN IS RECORDED AS HIDDEN (SPEC-ADMIN-CONSOLE FR55).
 *
 * A membership event carries `Type`: `DEFAULT`, or `HIDDEN` for a member the others cannot see. The
 * archive keeps the raw event, so the projection keeps the type too, and the membership history answers
 * `hidden` from it. Without it the console's "Current state" filter cannot tell an operator who joined
 * invisibly from a participant, and would show participants a join they never saw.
 *
 * A row archived before the type was kept has none, and the history then says nothing rather than
 * `hidden: false`: the filter must not guess that such a member was visible.
 */
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
  transaction: jest.fn(async (fn: () => Promise<unknown>) => fn()),
  batchInsert: jest.fn(async () => 1),
  ensureSchema: jest.fn(),
  resetConnection: jest.fn(),
  isAuthError: jest.fn(() => false),
}));
jest.mock('../../lambda/src/analytics-aurora/drift-detection', () => ({ detectDrift: jest.fn(), recordDriftFire: jest.fn() }));
jest.mock('../../lambda/src/analytics-aurora/cross-conversation-context', () => ({ updateConversationContext: jest.fn() }));
jest.mock('../../lambda/src/analytics-aurora/turn-events-live', () => ({ writeTurnEvents: jest.fn() }));
jest.mock('../../lambda/src/lib/message-analytics', () => ({ readMessageAnalytics: jest.fn(async () => null) }));
jest.mock('../../lambda/src/lib/sleep-mode', () => ({ touchActivity: jest.fn() }));
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  getChannelContext: jest.fn(async () => null),
  putChannelContext: jest.fn(),
}));

import { batchInsert, query } from '../../lambda/src/analytics-aurora/db-client';
import { handler } from '../../lambda/src/analytics-aurora/kinesis-archival';
import { adminMembershipHistory } from '../../lambda/src/analytics-aurora/admin-conversations-aurora';

const mockedQuery = query as jest.MockedFunction<typeof query>;
const mockedBatch = batchInsert as jest.MockedFunction<typeof batchInsert>;
const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/c-hidden';

function join(type: string | undefined, member: string) {
  return {
    kinesis: {
      data: Buffer.from(JSON.stringify({
        EventType: 'CREATE_CHANNEL_MEMBERSHIP',
        Payload: {
          ChannelArn: CHANNEL,
          Member: { Arn: `arn:aws:chime:us-east-1:1:app-instance/a/user/${member}`, Name: member },
          InvitedBy: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/a/user/admin', Name: 'admin' },
          CreatedTimestamp: '2026-10-10T00:00:00Z',
          ...(type ? { Type: type } : {}),
        },
      })).toString('base64'),
    },
  };
}

/** Everything the archival path handed to the database, as one string to search. */
const written = () => JSON.stringify([...mockedQuery.mock.calls, ...mockedBatch.mock.calls]);

describe('archiving a membership event', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);
  });

  it('keeps a hidden member\'s type', async () => {
    await handler({ Records: [join('HIDDEN', 'operator')] } as never, { awsRequestId: 'r-1' } as never);
    // Non-vacuity: the member was written at all.
    expect(written()).toContain('operator');
    expect(written()).toContain('\\"membershipType\\":\\"HIDDEN\\"');
  });

  it('keeps a visible member\'s type', async () => {
    await handler({ Records: [join('DEFAULT', 'ada')] } as never, { awsRequestId: 'r-2' } as never);
    expect(written()).toContain('\\"membershipType\\":\\"DEFAULT\\"');
  });

  it('records no type where the event carries none', async () => {
    await handler({ Records: [join(undefined, 'ada')] } as never, { awsRequestId: 'r-3' } as never);
    expect(written()).toContain('ada');
    expect(written()).not.toContain('membershipType');
  });
});

describe('the membership history', () => {
  beforeEach(() => jest.clearAllMocks());

  it('answers hidden for a hidden member, visible for a default one, and nothing where unrecorded', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        { event_type: 'CREATE_CHANNEL_MEMBERSHIP', member_arn: 'u/user/op', member_name: 'op', invited_by: null, at: '2026-10-10T00:00:00Z', membership_type: 'HIDDEN' },
        { event_type: 'CREATE_CHANNEL_MEMBERSHIP', member_arn: 'u/user/ada', member_name: 'ada', invited_by: null, at: '2026-10-10T00:01:00Z', membership_type: 'DEFAULT' },
        { event_type: 'CREATE_CHANNEL_MEMBERSHIP', member_arn: 'u/user/old', member_name: 'old', invited_by: null, at: '2026-10-10T00:02:00Z', membership_type: null },
      ],
      rowCount: 3,
    } as never);
    const out = await adminMembershipHistory('c1');
    const [sql] = mockedQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/metadata->>'membershipType'/);
    expect(out[0].hidden).toBe(true);
    expect(out[1].hidden).toBe(false);
    expect(out[2]).not.toHaveProperty('hidden');
  });
});
