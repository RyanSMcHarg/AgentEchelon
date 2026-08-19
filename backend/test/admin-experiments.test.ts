/**
 * admin-experiments handler — the experiments CRUD API behind the admin
 * Experiments tab. Pins the frontend contract (GET list / POST create /
 * POST {id}/status), server-authoritative boundBy, roster slot-ARN
 * denormalization for battle experiments, validation bubbling, and auth.
 *
 * Mirrors experiment-manager.battle.test.ts mock style (virtual SDK
 * mocks — these modules only exist at Lambda runtime).
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDdbSend = jest.fn();
const mockSsmSend = jest.fn();
const mockDocFrom = jest.fn(() => ({ send: mockDdbSend }));
jest.mock(
  '@aws-sdk/lib-dynamodb',
  () => ({
    DynamoDBDocumentClient: { from: mockDocFrom },
    ScanCommand: jest.fn().mockImplementation((a) => ({ __t: 'Scan', input: a })),
    PutCommand: jest.fn().mockImplementation((a) => ({ __t: 'Put', input: a })),
    UpdateCommand: jest.fn().mockImplementation((a) => ({ __t: 'Update', input: a })),
    GetCommand: jest.fn(),
  }),
  { virtual: true },
);
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });
jest.mock(
  '@aws-sdk/client-ssm',
  () => ({
    SSMClient: jest.fn(() => ({ send: mockSsmSend })),
    GetParameterCommand: jest.fn().mockImplementation((a) => ({ __t: 'GetParam', input: a })),
  }),
  { virtual: true },
);

process.env.EXPERIMENTS_TABLE = 'experiments-test';
process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:1:app-instance/app';

import { handler } from '../lambda/src/admin-experiments';

function evt(
  over: Omit<Partial<APIGatewayProxyEvent>, 'body'> & { body?: unknown },
): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/admin/experiments',
    headers: { origin: 'http://localhost:5173' },
    // The handler requires the admins group.
    requestContext: { authorizer: { claims: { sub: 'admin-sub', 'cognito:groups': 'admins' } } },
    pathParameters: null,
    ...over,
    body: over.body === undefined ? null : JSON.stringify(over.body),
  } as unknown as APIGatewayProxyEvent;
}

const baseExp = {
  experimentId: 'exp-1',
  status: 'active',
  intent: 'general',
  tiers: ['premium'],
  startDate: '2026-05-16T00:00:00Z',
  variants: [
    { variantId: 'control', modelKey: 'sonnet', weight: 50 },
    { variantId: 'treatment', modelKey: 'opus', weight: 50 },
  ],
};

beforeEach(() => {
  mockDdbSend.mockReset();
  mockSsmSend.mockReset();
});

describe('admin-experiments handler', () => {
  it('OPTIONS → 200 CORS preflight', async () => {
    const r = await handler(evt({ httpMethod: 'OPTIONS' }));
    expect(r.statusCode).toBe(200);
    expect(r.headers!['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
  });

  it('401 when no caller sub', async () => {
    const r = await handler(
      evt({ requestContext: { authorizer: { claims: {} } } as never }),
    );
    expect(r.statusCode).toBe(401);
  });

  // Regression: a battle experiment with a blank systemPromptAddendum /
  // text-only imageGenModelKey reaches PutCommand with undefined nested
  // values. Without removeUndefinedValues the real marshaller throws and
  // the handler returns 500 "Internal error" (the post-2 demo blocker).
  // The SDK is mocked here so the throw can't be reproduced — pin the
  // client construction instead.
  it('constructs the doc client with removeUndefinedValues', () => {
    expect(mockDocFrom).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        marshallOptions: expect.objectContaining({ removeUndefinedValues: true }),
      }),
    );
  });

  it('GET → { experiments } from a Scan', async () => {
    mockDdbSend.mockResolvedValueOnce({ Items: [baseExp] });
    const r = await handler(evt({ httpMethod: 'GET' }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).experiments).toEqual([baseExp]);
    expect(mockDdbSend.mock.calls[0][0].__t).toBe('Scan');
  });

  it('GET auto-completes a past-endDate active experiment (L5) with an auto:endDate audit', async () => {
    const expired = { ...baseExp, experimentId: 'exp-expired', endDate: '2020-01-01T00:00:00Z', transitions: [] };
    mockDdbSend
      .mockResolvedValueOnce({ Items: [expired] }) // the paginated Scan
      .mockResolvedValueOnce({}); // the reconcile Update
    const r = await handler(evt({ httpMethod: 'GET' }));
    expect(r.statusCode).toBe(200);
    // The response reflects the reconciled status (endDate is authoritative).
    expect(JSON.parse(r.body).experiments[0].status).toBe('completed');
    // A conditional Update flipped it to completed with an auto:endDate transition.
    const upd = mockDdbSend.mock.calls.find((c: unknown[]) => (c[0] as { __t?: string }).__t === 'Update');
    expect(upd).toBeDefined();
    const input = (upd![0] as { input: { ConditionExpression: string; ExpressionAttributeValues: Record<string, unknown> } }).input;
    expect(input.ExpressionAttributeValues[':s']).toBe('completed');
    expect(input.ConditionExpression).toContain('#s = :active'); // idempotent: only flips a still-active row
    const txns = input.ExpressionAttributeValues[':t'] as Array<{ reason?: string }>;
    expect(txns[txns.length - 1].reason).toBe('auto:endDate');
  });

  it('POST create (non-battle) → Puts with server createdAt, returns the row', async () => {
    // The handler Scans for active experiment count BEFORE the Put.
    // Queue both responses and locate the Put by __t rather than index.
    mockDdbSend.mockResolvedValueOnce({ Items: [] }); // active count
    mockDdbSend.mockResolvedValueOnce({}); // Put
    const r = await handler(evt({ httpMethod: 'POST', body: baseExp }));
    expect(r.statusCode).toBe(200);
    const put = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')![0];
    expect(put.input.Item.experimentId).toBe('exp-1');
    expect(typeof put.input.Item.createdAt).toBe('string');
    expect(mockSsmSend).not.toHaveBeenCalled(); // no roster read for non-battle
  });

  it('POST create (battle) → server boundBy + roster-resolved altBotSlotArn', async () => {
    mockSsmSend.mockResolvedValueOnce({
      Parameter: {
        Value: JSON.stringify([
          { slotId: 'slot-0', botArn: 'arn:aws:chime:...:bot/slot-0' },
          { slotId: 'slot-1', botArn: 'arn:aws:chime:...:bot/slot-1' },
        ]),
      },
    });
    // Scan first, then Put.
    mockDdbSend.mockResolvedValueOnce({ Items: [] });
    mockDdbSend.mockResolvedValueOnce({});
    const battle = {
      ...baseExp,
      battleEnabled: true,
      altBotSlotId: 'slot-1',
      variants: [
        { variantId: 'control', modelKey: 'sonnet', weight: 50, displayName: 'Atlas' },
        { variantId: 'treatment', modelKey: 'opus', weight: 50, displayName: 'Echo' },
      ],
    };
    const r = await handler(evt({ httpMethod: 'POST', body: battle }));
    expect(r.statusCode).toBe(200);
    const putCall = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put');
    const item = putCall![0].input.Item;
    expect(item.altBotSlotArn).toBe('arn:aws:chime:...:bot/slot-1');
    expect(item.boundBy).toBe('arn:aws:chime:us-east-1:1:app-instance/app/user/admin-sub');
    expect(item.boundAt).toBeDefined();
  });

  it('POST create (battle) → 400 when the slot is not in the roster', async () => {
    mockSsmSend.mockResolvedValueOnce({ Parameter: { Value: JSON.stringify([]) } });
    const battle = {
      ...baseExp,
      battleEnabled: true,
      altBotSlotId: 'slot-9',
      variants: [
        { variantId: 'control', modelKey: 'sonnet', weight: 50, displayName: 'Atlas' },
        { variantId: 'treatment', modelKey: 'opus', weight: 50, displayName: 'Echo' },
      ],
    };
    const r = await handler(evt({ httpMethod: 'POST', body: battle }));
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/not provisioned/);
    // Upsert reads the existing row first, but a rejected create never WRITES.
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')).toBeUndefined();
  });

  it('POST create (battle) → 400 BATTLE_TIER_PREMIUM_ONLY when it targets a MIXED classification set', async () => {
    // SPEC-PORTABLE-PROFILES §1/§6: `battleEligible` is now a HINT, so an operator-driven
    // battle may target any SINGLE classification (the ceiling still binds at resolution). What stays
    // rejected is a MIXED set — a battle runs head-to-head in ONE channel, so exactly one classification.
    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: JSON.stringify([{ slotId: 'slot-0', botArn: 'arn:bot/0' }]) },
    });
    const bad = {
      ...baseExp,
      tiers: ['standard', 'premium'],
      battleEnabled: true,
      altBotSlotId: 'slot-0',
      variants: [
        { variantId: 'control', modelKey: 'sonnet', weight: 50, displayName: 'Atlas' },
        { variantId: 'treatment', modelKey: 'opus', weight: 50, displayName: 'Echo' },
      ],
    };
    const r = await handler(evt({ httpMethod: 'POST', body: bad }));
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).code).toBe('BATTLE_TIER_PREMIUM_ONLY');
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')).toBeUndefined();
  });

  it('POST create (battle) → 200 on a single NON-premium classification (battleEligible demoted to a hint)', async () => {
    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: JSON.stringify([{ slotId: 'slot-0', botArn: 'arn:bot/0' }]) },
    });
    const ok = {
      ...baseExp,
      tiers: ['standard'],
      battleEnabled: true,
      altBotSlotId: 'slot-0',
      boundBy: 'admin-sub',
      variants: [
        { variantId: 'control', modelKey: 'sonnet', weight: 50, displayName: 'Atlas' },
        { variantId: 'treatment', modelKey: 'opus', weight: 50, displayName: 'Echo' },
      ],
    };
    const r = await handler(evt({ httpMethod: 'POST', body: ok }));
    expect(r.statusCode).toBe(200);
  });

  it('POST create → 400 with code when validation fails (one-sided imageGenModelKey)', async () => {
    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: JSON.stringify([{ slotId: 'slot-0', botArn: 'arn:bot/0' }]) },
    });
    const bad = {
      ...baseExp,
      battleEnabled: true,
      altBotSlotId: 'slot-0',
      variants: [
        { variantId: 'control', modelKey: 'sonnet', weight: 50, displayName: 'Atlas', imageGenModelKey: 'titan_image' },
        { variantId: 'treatment', modelKey: 'opus', weight: 50, displayName: 'Echo' },
      ],
    };
    const r = await handler(evt({ httpMethod: 'POST', body: bad }));
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).code).toBe('BATTLE_IMAGE_GEN_PAIR');
    // Upsert reads the existing row first, but a rejected create never WRITES.
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')).toBeUndefined();
  });

  it('POST create → 429 MAX_ACTIVE_EXPERIMENTS when cap exceeded (audit L3)', async () => {
    // 50 active rows already.
    const fullActive = Array.from({ length: 50 }, (_, i) => ({ experimentId: `e-${i}` }));
    // Upsert now reads any existing row first (Get, for createdAt/edit semantics); this
    // create is a brand-new id, so no existing row. THEN the active-count Scan runs.
    mockDdbSend.mockResolvedValueOnce({}); // getExistingExperiment — none
    mockDdbSend.mockResolvedValueOnce({ Items: fullActive }); // active count
    const r = await handler(evt({ httpMethod: 'POST', body: baseExp }));
    expect(r.statusCode).toBe(429);
    expect(JSON.parse(r.body).code).toBe('MAX_ACTIVE_EXPERIMENTS');
    // No Put was ever issued — only the count Scan.
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')).toBeUndefined();
  });

  it('POST create → cap excludes self so idempotent re-create is OK', async () => {
    // 49 other active rows + the row being re-created (exp-1) — total 50,
    // but excluding self brings count to 49, under the cap.
    const items = [
      ...Array.from({ length: 49 }, (_, i) => ({ experimentId: `e-${i}` })),
      { experimentId: 'exp-1' },
    ];
    mockDdbSend.mockResolvedValueOnce({ Items: items });
    mockDdbSend.mockResolvedValueOnce({}); // Put
    const r = await handler(evt({ httpMethod: 'POST', body: baseExp }));
    expect(r.statusCode).toBe(200);
  });

  // L2/§3.2 on the UPSERT path. POST /admin/experiments writes `status` straight onto the row, so
  // without these guards it was a way around the state machine POST /{id}/status enforces: the
  // create route would resurrect a terminal experiment into live traffic resolution.
  it('POST upsert → 409 EXPERIMENT_TERMINAL rather than resurrecting a completed experiment', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: { ...baseExp, status: 'completed' } }); // the Get
    const r = await handler(evt({ httpMethod: 'POST', body: { ...baseExp, status: 'active' } }));
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).code).toBe('EXPERIMENT_TERMINAL');
    // and nothing was written
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')).toBeUndefined();
  });

  it('POST upsert → 409 rather than resurrecting a soft-deleted (tombstoned) experiment', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: { ...baseExp, status: 'deleted' } });
    const r = await handler(evt({ httpMethod: 'POST', body: { ...baseExp, status: 'active' } }));
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).code).toBe('EXPERIMENT_TERMINAL');
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')).toBeUndefined();
  });

  it('POST upsert → 400 on a status outside the enum (never stored unchecked)', async () => {
    // 'Active' is not a status; storing it produced a row that is never live and never errors.
    const r = await handler(evt({ httpMethod: 'POST', body: { ...baseExp, status: 'Active' } }));
    expect(r.statusCode).toBe(400);
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')).toBeUndefined();
  });

  it('POST upsert → 409 INVALID_TRANSITION on an illegal status change through an edit', async () => {
    // draft → paused is not in the transition table (draft may only go active | deleted).
    mockDdbSend.mockResolvedValueOnce({ Item: { ...baseExp, status: 'draft' } });
    const r = await handler(evt({ httpMethod: 'POST', body: { ...baseExp, status: 'paused' } }));
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).code).toBe('INVALID_TRANSITION');
  });

  it('POST upsert → a plain edit of a live row (no status field) still succeeds', async () => {
    // The guards must not break ordinary editing: omitting `status` keeps the current one and is
    // not a transition.
    const { status: _drop, ...noStatus } = baseExp;
    mockDdbSend.mockResolvedValueOnce({ Item: { ...baseExp, status: 'active' } }); // the Get
    mockDdbSend.mockResolvedValueOnce({ Items: [] }); // active count
    mockDdbSend.mockResolvedValueOnce({}); // Put
    const r = await handler(evt({ httpMethod: 'POST', body: noStatus }));
    expect(r.statusCode).toBe(200);
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')).toBeDefined();
  });

  it('POST {id}/status → Update; rejects an invalid status', async () => {
    // L6: the status route now reads the row first (clean 404 on a missing id),
    // then Updates. Supply the existing active row, then the Update response.
    mockDdbSend.mockResolvedValueOnce({ Item: { experimentId: 'exp-1', status: 'active' } });
    mockDdbSend.mockResolvedValueOnce({});
    const ok = await handler(
      evt({
        httpMethod: 'POST',
        path: '/admin/experiments/exp-1/status',
        pathParameters: { experimentId: 'exp-1' },
        body: { status: 'paused' },
      }),
    );
    expect(ok.statusCode).toBe(200);
    const upd = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Update')![0];
    expect(upd.__t).toBe('Update');
    expect(upd.input.Key).toEqual({ experimentId: 'exp-1' });

    const bad = await handler(
      evt({
        httpMethod: 'POST',
        path: '/admin/experiments/exp-1/status',
        pathParameters: { experimentId: 'exp-1' },
        body: { status: 'bogus' },
      }),
    );
    expect(bad.statusCode).toBe(400);
  });
});
