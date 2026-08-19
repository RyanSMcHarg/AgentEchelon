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
    DeleteCommand: jest.fn().mockImplementation((a) => ({ __t: 'Delete', input: a })),
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

/**
 * Every lifecycle write in this handler is a read-modify-write: the row is read, one entry is
 * appended to the append-only `transitions` audit (L7), and the WHOLE array is written back.
 * `attribute_exists(experimentId)` only asserts the row still exists, so two overlapping admin
 * actions both read N entries, both append their own, and the second write lands N+1 entries with
 * the first action's entry gone - the audit silently loses a status change while both callers are
 * told 200. Pinning each write to the status AND audit length it was decided from is the same
 * idiom `advanceTaskStateTo` uses (task-transition-concurrency.test.ts in this dir).
 */
describe('admin-experiments: optimistic concurrency on the lifecycle audit', () => {
  const conditionalFailure = () =>
    Object.assign(new Error('The conditional request failed'), {
      name: 'ConditionalCheckFailedException',
    });

  const statusEvent = (body: unknown) =>
    evt({
      httpMethod: 'POST',
      path: '/admin/experiments/exp-1/status',
      pathParameters: { experimentId: 'exp-1' },
      body,
    });

  const storedActive = (transitions: unknown[] = []) => ({
    ...baseExp,
    status: 'active',
    transitions,
  });

  it('POST {id}/status pins the write to the status and audit length it read', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: storedActive([{ from: 'create', to: 'active', by: 'a', at: 't0' }]) })
      .mockResolvedValueOnce({});
    const r = await handler(statusEvent({ status: 'paused' }));
    expect(r.statusCode).toBe(200);

    const upd = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Update')![0];
    // Without both clauses the write is unguarded against a concurrent writer: the status clause
    // catches a competing transition, the audit-length clause catches a competing EDIT that appends
    // without changing status.
    expect(upd.input.ConditionExpression).toContain('#s = :expectedStatus');
    expect(upd.input.ConditionExpression).toContain('size(#t) = :expectedTransitions');
    expect(upd.input.ExpressionAttributeValues[':expectedStatus']).toBe('active');
    expect(upd.input.ExpressionAttributeValues[':expectedTransitions']).toBe(1);
    // The audit still grows by exactly the one entry this request appends.
    expect((upd.input.ExpressionAttributeValues[':t'] as unknown[]).length).toBe(2);
  });

  it('POST {id}/status → 409 EXPERIMENT_CONCURRENT_MODIFICATION when another writer lands first', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: storedActive() }) // the read this transition was decided from
      .mockRejectedValueOnce(conditionalFailure()) // another admin action wrote in between
      .mockResolvedValueOnce({ Item: { ...baseExp, status: 'completed' } }); // re-read: where it actually is
    const r = await handler(statusEvent({ status: 'paused' }));

    // Reporting this as "not found" would be a lie about a row that exists, and reporting 200 would
    // claim a status change that was never applied.
    expect(r.statusCode).toBe(409);
    const body = JSON.parse(r.body);
    expect(body.code).toBe('EXPERIMENT_CONCURRENT_MODIFICATION');
    expect(body.currentStatus).toBe('completed');
    expect(body.from).toBe('active');
    expect(body.to).toBe('paused');
  });

  it('POST {id}/status → still 404 when the guard fails because the row is gone', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: storedActive() })
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({}); // re-read: the row was deleted
    const r = await handler(statusEvent({ status: 'paused' }));
    expect(r.statusCode).toBe(404);
  });

  it('DELETE (soft tombstone) pins its write to the audit it is preserving', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: storedActive([{ from: 'create', to: 'active', by: 'a', at: 't0' }]) })
      .mockResolvedValueOnce({});
    const r = await handler(
      evt({ httpMethod: 'DELETE', pathParameters: { experimentId: 'exp-1' } }),
    );
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).mode).toBe('soft');
    const upd = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Update')![0];
    expect(upd.input.ConditionExpression).toContain('#s = :expectedStatus');
    expect(upd.input.ConditionExpression).toContain('size(#t) = :expectedTransitions');
    expect(upd.input.ExpressionAttributeValues[':expectedTransitions']).toBe(1);
  });

  it('DELETE (hard) refuses to erase a draft that was activated between the read and the write', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...baseExp, status: 'draft' } })
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({ Item: { ...baseExp, status: 'active' } });
    const r = await handler(
      evt({ httpMethod: 'DELETE', pathParameters: { experimentId: 'exp-1' } }),
    );
    const del = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Delete')![0];
    expect(del.input.ConditionExpression).toContain('#s = :expectedStatus');
    expect(del.input.ExpressionAttributeValues[':expectedStatus']).toBe('draft');
    // The row is no longer the never-started draft the hard delete was chosen for.
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).code).toBe('EXPERIMENT_CONCURRENT_MODIFICATION');
  });

  it('POST upsert (edit) pins the row rewrite, so it cannot revive a concurrently paused experiment', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Item: storedActive([{ from: 'create', to: 'active', by: 'a', at: 't0' }]),
    });
    mockDdbSend.mockResolvedValue({ Items: [] }); // active-count scan, conflict scan, then the Put
    const r = await handler(evt({ httpMethod: 'POST', body: baseExp }));
    expect(r.statusCode).toBe(200);
    const put = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')![0];
    // An edit writes the whole row back, including the status it read: unpinned, an edit racing a
    // Pause writes `active` back over the pause and drops the pause's audit entry.
    expect(put.input.ConditionExpression).toContain('#s = :expectedStatus');
    expect(put.input.ConditionExpression).toContain('size(#t) = :expectedTransitions');
    expect(put.input.ExpressionAttributeValues[':expectedStatus']).toBe('active');
  });

  it('POST create (no prior row) stays unconditional so an idempotent re-create still writes', async () => {
    // The create/edit decision is made from an eventually-consistent read, so conditioning a create
    // on the row's absence would reject legitimate retries.
    mockDdbSend.mockResolvedValueOnce({}); // no existing row
    mockDdbSend.mockResolvedValue({ Items: [] });
    const r = await handler(evt({ httpMethod: 'POST', body: baseExp }));
    expect(r.statusCode).toBe(200);
    const put = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')![0];
    expect(put.input.ConditionExpression).toBeUndefined();
  });

  it('GET reconcile pins its auto-complete to the audit it read', async () => {
    const expired = { ...baseExp, endDate: '2020-01-01T00:00:00Z', transitions: [{ from: 'create', to: 'active', by: 'a', at: 't0' }] };
    mockDdbSend.mockResolvedValueOnce({ Items: [expired] }).mockResolvedValueOnce({});
    await handler(evt({ httpMethod: 'GET' }));
    const upd = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Update')![0];
    expect(upd.input.ConditionExpression).toContain('size(#t) = :expectedTransitions');
    expect(upd.input.ExpressionAttributeValues[':expectedTransitions']).toBe(1);
  });
});

/**
 * A Resume request for an experiment whose `endDate` has passed used to return 200 while nothing
 * resumed: the row's status label flipped to `active`, but `isLiveForClassification` gates
 * resolution on `endDate`, so no traffic was served, and the next list read auto-completed the row
 * again (L5). The API has to answer honestly - the spec's lifecycle has no resume-past-the-window
 * edge ("on endDate reached: active|paused --auto--> completed"), and extending a run is the edit
 * route's job, where `endDate` is validated and stays editable on a live experiment (§3.2 L1).
 */
describe('admin-experiments: activating a past-endDate experiment', () => {
  const statusEvent = (body: unknown) =>
    evt({
      httpMethod: 'POST',
      path: '/admin/experiments/exp-1/status',
      pathParameters: { experimentId: 'exp-1' },
      body,
    });

  it('POST {id}/status resume → 409 EXPERIMENT_WINDOW_ENDED naming the endDate, and writes nothing', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Item: { ...baseExp, status: 'paused', endDate: '2020-01-01T00:00:00Z' },
    });
    const r = await handler(statusEvent({ status: 'active' }));

    expect(r.statusCode).toBe(409);
    const body = JSON.parse(r.body);
    expect(body.code).toBe('EXPERIMENT_WINDOW_ENDED');
    expect(body.endDate).toBe('2020-01-01T00:00:00Z');
    expect(body.error).toContain('2020-01-01T00:00:00Z');
    // A 200 here would report a resume that resolves no traffic.
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Update')).toBeUndefined();
  });

  it('POST {id}/status activate → 409 for an expired DRAFT too (same dead window)', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Item: { ...baseExp, status: 'draft', endDate: '2020-01-01T00:00:00Z' },
    });
    const r = await handler(statusEvent({ status: 'active' }));
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).code).toBe('EXPERIMENT_WINDOW_ENDED');
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Update')).toBeUndefined();
  });

  it('POST {id}/status resume → 200 when the window is still open (the guard is not over-broad)', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Item: { ...baseExp, status: 'paused', endDate: '2099-01-01T00:00:00Z' },
    });
    mockDdbSend.mockResolvedValue({ Items: [] }); // active-count scan, conflict scan, then the Update
    const r = await handler(statusEvent({ status: 'active' }));
    expect(r.statusCode).toBe(200);
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Update')).toBeDefined();
  });

  it('POST {id}/status pause of an expired experiment is unaffected (only activation is refused)', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...baseExp, status: 'active', endDate: '2020-01-01T00:00:00Z' } })
      .mockResolvedValueOnce({});
    const r = await handler(statusEvent({ status: 'paused' }));
    expect(r.statusCode).toBe(200);
  });
});
