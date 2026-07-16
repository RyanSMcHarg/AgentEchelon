/**
 * Scoped Channels — security/privacy unit tests
 *
 * The related-conversation cosine-NN query is the highest-risk surface in
 * drift detection. A bug here leaks one user's conversation summaries to
 * another via nearest-neighbor lookup. These tests pin the contract:
 *
 *   - 1:1 channel (1 human + bot): scope = sender's memberships
 *   - Multi-member channel: scope = INTERSECTION of all humans' memberships
 *   - Bot ARNs are excluded from the intersection seed (bots are in many
 *     channels; including them would defeat the boundary)
 *   - 0-human edge case returns []
 *
 * See SPEC-DRIFT-CONVERGENCE.md "Scoping (Security + Privacy)".
 */

import type { QueryResult, QueryResultRow } from 'pg';

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
}));

import { query } from '../../lambda/src/analytics-aurora/db-client';

const mockedQuery = query as jest.MockedFunction<typeof query>;

function mockRows<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] as never } as QueryResult<T>;
}

const CHAN_CURRENT = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/current';
const CHAN_A_PRIVATE = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/userA-private';
const CHAN_B_PRIVATE = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/userB-private';
const CHAN_SHARED = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/shared-AB';
const USER_A = 'arn:aws:chime:us-east-1:111:app-instance/i/user/userA';
const USER_B = 'arn:aws:chime:us-east-1:111:app-instance/i/user/userB';
const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/main';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getScopedChannelArns', () => {
  it('returns the lone human member\'s memberships in a 1:1 channel', async () => {
    // Members of the current channel: user A + bot
    mockedQuery.mockResolvedValueOnce(mockRows([{ user_sub: USER_A }, { user_sub: BOT }]));
    // User A is in current + their private channel
    mockedQuery.mockResolvedValueOnce(
      mockRows([{ channel_arn: CHAN_CURRENT }, { channel_arn: CHAN_A_PRIVATE }]),
    );

    const { getScopedChannelArns } = await import('../../lambda/src/lib/scoped-channels');
    const scope = await getScopedChannelArns(CHAN_CURRENT);

    expect(scope.sort()).toEqual([CHAN_CURRENT, CHAN_A_PRIVATE].sort());
    // The bot's memberships were never queried — bots excluded from the seed
    expect(mockedQuery).toHaveBeenCalledTimes(2);
  });

  it('returns the INTERSECTION of human memberships in a multi-member channel', async () => {
    // Members: user A, user B, bot
    mockedQuery.mockResolvedValueOnce(
      mockRows([{ user_sub: USER_A }, { user_sub: USER_B }, { user_sub: BOT }]),
    );
    // User A: current + their private + shared
    mockedQuery.mockResolvedValueOnce(
      mockRows([
        { channel_arn: CHAN_CURRENT },
        { channel_arn: CHAN_A_PRIVATE },
        { channel_arn: CHAN_SHARED },
      ]),
    );
    // User B: current + their own private + shared (NOT in A's private)
    mockedQuery.mockResolvedValueOnce(
      mockRows([
        { channel_arn: CHAN_CURRENT },
        { channel_arn: CHAN_B_PRIVATE },
        { channel_arn: CHAN_SHARED },
      ]),
    );

    const { getScopedChannelArns } = await import('../../lambda/src/lib/scoped-channels');
    const scope = await getScopedChannelArns(CHAN_CURRENT);

    // Intersection: current + shared. A's private and B's private are excluded.
    expect(scope.sort()).toEqual([CHAN_CURRENT, CHAN_SHARED].sort());
  });

  it('does NOT include user A\'s private channel in the multi-member scope (privacy boundary)', async () => {
    // Same as the previous test — pins the specific leakage condition called
    // out in SPEC-DRIFT-CONVERGENCE.md: A's private channel must not appear
    // in the scope of a multi-member channel where B is also present.
    mockedQuery.mockResolvedValueOnce(
      mockRows([{ user_sub: USER_A }, { user_sub: USER_B }, { user_sub: BOT }]),
    );
    mockedQuery.mockResolvedValueOnce(
      mockRows([{ channel_arn: CHAN_CURRENT }, { channel_arn: CHAN_A_PRIVATE }]),
    );
    mockedQuery.mockResolvedValueOnce(mockRows([{ channel_arn: CHAN_CURRENT }]));

    const { getScopedChannelArns } = await import('../../lambda/src/lib/scoped-channels');
    const scope = await getScopedChannelArns(CHAN_CURRENT);

    expect(scope).not.toContain(CHAN_A_PRIVATE);
    expect(scope).not.toContain(CHAN_B_PRIVATE);
  });

  it('returns [] when the channel has no human members', async () => {
    // Only bot members (edge case)
    mockedQuery.mockResolvedValueOnce(
      mockRows([{ user_sub: BOT }, { user_sub: BOT }]),
    );

    const { getScopedChannelArns } = await import('../../lambda/src/lib/scoped-channels');
    const scope = await getScopedChannelArns(CHAN_CURRENT);

    expect(scope).toEqual([]);
    // No follow-up queries for memberships were made
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it('treats user_sub entries containing "/bot/" as bots regardless of pattern', async () => {
    // Mix of formats: full ARNs, with and without bot segment
    mockedQuery.mockResolvedValueOnce(
      mockRows([
        { user_sub: USER_A },
        { user_sub: 'arn:aws:chime:...:app-instance/i/bot/secondary' },
        { user_sub: 'arn:aws:chime:...:app-instance/i/bot/main' },
      ]),
    );
    mockedQuery.mockResolvedValueOnce(mockRows([{ channel_arn: CHAN_CURRENT }]));

    const { getScopedChannelArns } = await import('../../lambda/src/lib/scoped-channels');
    const scope = await getScopedChannelArns(CHAN_CURRENT);

    expect(scope).toEqual([CHAN_CURRENT]);
    // Only user A's memberships fetched; both bot ARNs filtered before fetching
    expect(mockedQuery).toHaveBeenCalledTimes(2);
  });
});
