/**
 * Battle Outcome API handler — unit tests (SPEC-BATTLE.md §"Battle
 * Scoring & Per-Step Telemetry", Phase 1A / option #2).
 *
 * Tests the transport + auth + validation contract. Storage semantics
 * (LWW, server-stamped chosenAt) are covered in battle-outcome.test.ts;
 * here lib/battle-outcome is mocked so we pin:
 *   - chosenByUserSub comes from the Cognito token, NEVER the body
 *   - 401 without a sub; 400 on missing battleId / invalid winner /
 *     bad JSON; 503 when the store is unavailable after valid input
 *   - GET returns { outcome } (possibly null = "no pick yet")
 *   - routing + CORS
 */

import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockRecord = jest.fn();
const mockRead = jest.fn();
jest.mock('../lambda/src/lib/battle-outcome', () => ({
  recordBattleOutcome: (...a: unknown[]) => mockRecord(...a),
  readBattleOutcome: (...a: unknown[]) => mockRead(...a),
}));

import { handler } from '../lambda/src/battle-outcome-api';

const BATTLE_ID = 'a1b2c3d4e5f60718';
const SUB = 'user-sub-1';
// The handler requires channelArn in the body so it can verify caller
// membership. Tests use a placeholder ARN;
// the membership-check itself is skipped when APP_INSTANCE_ARN env is
// unset (which it is in this test process).
const CHANNEL_ARN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c';

function makeEvent(opts: {
  method: string;
  path?: string;
  body?: unknown;
  query?: Record<string, string>;
  sub?: string | null;
  origin?: string;
}): APIGatewayProxyEvent {
  const claims = opts.sub === null ? {} : { sub: opts.sub ?? SUB };
  return {
    httpMethod: opts.method,
    path: opts.path ?? '/channels/battle/outcome',
    body: opts.body === undefined ? null : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    queryStringParameters: opts.query ?? null,
    headers: { origin: opts.origin ?? 'http://localhost:5173' },
    requestContext: { authorizer: { claims } },
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => jest.clearAllMocks());

describe('POST /channels/battle/outcome', () => {
  it('records a pick with chosenByUserSub from the TOKEN, not the body', async () => {
    mockRecord.mockResolvedValueOnce({
      battleId: BATTLE_ID,
      winner: 'B',
      chosenByUserSub: SUB,
      chosenAt: '2026-05-15T00:00:00.000Z',
    });

    const res = await handler(
      makeEvent({
        method: 'POST',
        // Attacker tries to attribute the pick to someone else via body:
        body: { battleId: BATTLE_ID, winner: 'B', channelArn: CHANNEL_ARN, chosenByUserSub: 'victim-sub' },
        sub: SUB,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).outcome.winner).toBe('B');
    expect(mockRecord).toHaveBeenCalledWith({
      battleId: BATTLE_ID,
      winner: 'B',
      chosenByUserSub: SUB, // from claims, body value ignored
    });
  });

  it('401 when there is no Cognito sub', async () => {
    const res = await handler(
      makeEvent({ method: 'POST', body: { battleId: BATTLE_ID, winner: 'A' }, sub: null }),
    );
    expect(res.statusCode).toBe(401);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('400 on missing battleId', async () => {
    const res = await handler(makeEvent({ method: 'POST', body: { winner: 'A' } }));
    expect(res.statusCode).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('400 on an invalid winner', async () => {
    const res = await handler(
      makeEvent({ method: 'POST', body: { battleId: BATTLE_ID, winner: 'C', channelArn: CHANNEL_ARN } }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('INVALID_WINNER');
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('400 on missing channelArn (M2 requires membership context)', async () => {
    const res = await handler(
      makeEvent({ method: 'POST', body: { battleId: BATTLE_ID, winner: 'A' } }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('MISSING_CHANNEL_ARN');
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('400 on invalid JSON body', async () => {
    const res = await handler(makeEvent({ method: 'POST', body: '{not json' }));
    expect(res.statusCode).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('503 when the store is unavailable after valid input', async () => {
    mockRecord.mockResolvedValueOnce(null);
    const res = await handler(
      makeEvent({ method: 'POST', body: { battleId: BATTLE_ID, winner: 'tie', channelArn: CHANNEL_ARN } }),
    );
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('OUTCOME_STORE_UNAVAILABLE');
  });
});

describe('GET /channels/battle/outcome', () => {
  it('returns the recorded outcome', async () => {
    const stored = {
      battleId: BATTLE_ID,
      winner: 'A',
      chosenByUserSub: SUB,
      chosenAt: '2026-05-15T00:00:00.000Z',
    };
    mockRead.mockResolvedValueOnce(stored);
    const res = await handler(
      makeEvent({ method: 'GET', query: { battleId: BATTLE_ID } }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).outcome).toEqual(stored);
    expect(mockRead).toHaveBeenCalledWith(BATTLE_ID);
  });

  it('returns { outcome: null } when there is no pick yet', async () => {
    mockRead.mockResolvedValueOnce(null);
    const res = await handler(makeEvent({ method: 'GET', query: { battleId: BATTLE_ID } }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).outcome).toBeNull();
  });

  it('401 without a sub; 400 without battleId', async () => {
    expect((await handler(makeEvent({ method: 'GET', query: { battleId: BATTLE_ID }, sub: null }))).statusCode).toBe(401);
    expect((await handler(makeEvent({ method: 'GET' }))).statusCode).toBe(400);
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe('routing + CORS', () => {
  it('OPTIONS preflight → 200 with CORS headers', async () => {
    const res = await handler(makeEvent({ method: 'OPTIONS' }));
    expect(res.statusCode).toBe(200);
    expect(res.headers!['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
  });

  it('unknown route → 404', async () => {
    const res = await handler(makeEvent({ method: 'POST', path: '/channels/battle/nope' }));
    expect(res.statusCode).toBe(404);
  });

  it('echoes an allowed origin, falls back otherwise', async () => {
    mockRead.mockResolvedValue(null);
    const ok = await handler(makeEvent({ method: 'GET', query: { battleId: BATTLE_ID }, origin: 'http://localhost:5173' }));
    expect(ok.headers!['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    const bad = await handler(makeEvent({ method: 'GET', query: { battleId: BATTLE_ID }, origin: 'https://evil.example' }));
    expect(bad.headers!['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
  });
});
