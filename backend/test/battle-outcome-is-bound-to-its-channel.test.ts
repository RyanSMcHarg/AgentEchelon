/**
 * A pick is recorded against the duel it names, not just by someone who belongs somewhere.
 *
 * WHAT THIS GUARDS. `POST /channels/battle/outcome` takes `battleId` and `channelArn` from the same
 * request body and, until the binding this file pins, checked only the second: the caller had to be a
 * member of the channel they NAMED, and nothing tied that channel to the battle. A member of any
 * channel holding a battleId from elsewhere could therefore cast a pick into a duel they cannot see -
 * per-user last-write-wins, so it also overwrites nothing of their own - and the experiment
 * attribution is resolved from the channel they named, which lands the vote under the wrong
 * experiment as well.
 *
 * `battleId` is sha256(channelArn + ':' + userMessageId), so the channel is INSIDE the id and cannot
 * be recovered from it. The join is recorded instead, at fan-out, on the `__round1__` sentinel - the
 * one row per battle written exactly once and never replaced.
 *
 * THE REAL `battleChannelFrom` AND `duelWasAbandoned` RUN HERE. Only the two I/O functions are
 * mocked; stubbing the predicates would leave this asserting that a mock returns what it was told to.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockRecord = jest.fn();
const mockReadRows = jest.fn();

jest.mock('../lambda/src/lib/battle-outcome', () => ({
  recordBattleOutcome: (...a: unknown[]) => mockRecord(...a),
  readUserBattleOutcome: jest.fn(),
}));

jest.mock('../lambda/src/lib/battle-state', () => ({
  ...jest.requireActual('../lambda/src/lib/battle-state'),
  readBattleRows: (...a: unknown[]) => mockReadRows(...a),
  loadChannelBattleConfig: jest.fn().mockResolvedValue(null),
}));

import { handler } from '../lambda/src/battle-outcome-api';
import { edgeContext } from './helpers/edge-context';

const SUB = 'user-sub-1';
const BATTLE_ID = 'a1b2c3d4e5f60718';
const MINE = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/mine';
const THEIRS = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/theirs';

/** The sentinel row the fan-out writes, carrying the duel's channel. */
const round1Row = (channelArn?: string) => ({
  battleId: BATTLE_ID,
  botArn: '__round1__',
  state: 'COMPLETED',
  ...(channelArn && { channelArn }),
});

/** A finished bot row, so `duelWasAbandoned` is false and only the binding decides. */
const botRow = () => ({
  battleId: BATTLE_ID,
  botArn: 'arn:aws:chime:us-east-1:111:app-instance/i/bot/a',
  state: 'COMPLETED',
});

function post(body: unknown, sub: string | null = SUB): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/channels/battle/outcome',
    body: JSON.stringify(body),
    queryStringParameters: null,
    headers: { origin: 'http://localhost:5173' },
    requestContext: { authorizer: edgeContext({ claims: sub === null ? {} : { sub } }) },
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRecord.mockResolvedValue({
    battleId: BATTLE_ID, winner: 'A', chosenByPersonId: SUB, chosenAt: '2026-09-25T00:00:00.000Z',
  });
});

describe('a pick is bound to the battle it names', () => {
  it('refuses a pick whose battle ran in another channel', async () => {
    mockReadRows.mockResolvedValueOnce([round1Row(THEIRS), botRow()]);

    // The caller is a member of MINE (membership passes: APP_INSTANCE_ARN is unset in this process),
    // and names a battle that ran in THEIRS.
    const res = await handler(post({ battleId: BATTLE_ID, winner: 'A', channelArn: MINE }));

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('NOT_A_MEMBER');
    // THE POINT OF THE TEST: nothing was written. A 403 that still recorded would be worse than no
    // check at all, because the response would say it had refused.
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('records a pick whose battle ran in the channel named', async () => {
    mockReadRows.mockResolvedValueOnce([round1Row(MINE), botRow()]);

    const res = await handler(post({ battleId: BATTLE_ID, winner: 'A', channelArn: MINE }));

    expect(res.statusCode).toBe(200);
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  // ── UNKNOWN IS NOT MISMATCH ───────────────────────────────────────────────────────────────────
  //
  // Three different situations produce no recorded channel: a duel that predates the binding, one
  // whose rows have passed their TTL, and a deployment with no state table. Refusing on any of them
  // would discard a real judgement from someone who did watch the comparison, and would make the
  // endpoint's behavior depend on a clock.
  it.each([
    ['the sentinel carries no channel (a duel from before the binding)', [round1Row(), botRow()]],
    ['there is no sentinel at all (rows aged out)', [botRow()]],
    ['there are no rows at all (no state table, or read failed)', []],
  ])('still records when %s', async (_case, rows) => {
    mockReadRows.mockResolvedValueOnce(rows);

    const res = await handler(post({ battleId: BATTLE_ID, winner: 'A', channelArn: MINE }));

    expect(res.statusCode).toBe(200);
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it('refuses in the membership gate\'s own words, not more specific ones', async () => {
    // A distinct code or message would confirm to a caller who has just failed the check that the id
    // they hold is real and belongs to a channel they are not in. The refusal is byte-identical to
    // the one a non-member gets, so the two are indistinguishable from outside.
    mockReadRows.mockResolvedValueOnce([round1Row(THEIRS), botRow()]);
    const res = await handler(post({ battleId: BATTLE_ID, winner: 'A', channelArn: MINE }));

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: "Caller is not a member of the battle's channel",
      code: 'NOT_A_MEMBER',
    });
  });

  it('checks the binding before it tells anyone a duel was abandoned', async () => {
    // Ordering matters: the abandoned 409 distinguishes real battle ids from invented ones, so it
    // must sit behind every gate that establishes the caller belongs here - including this one.
    mockReadRows.mockResolvedValueOnce([
      round1Row(THEIRS),
      { battleId: BATTLE_ID, botArn: 'arn:aws:chime:us-east-1:111:app-instance/i/bot/a', state: 'ABANDONED' },
    ]);

    const res = await handler(post({ battleId: BATTLE_ID, winner: 'A', channelArn: MINE }));

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('NOT_A_MEMBER');
  });
});
