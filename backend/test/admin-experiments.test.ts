/**
 * admin-experiments handler — the experiments CRUD API behind the admin
 * Experiments tab. Pins the frontend contract (GET list / POST create /
 * POST {id}/status), server-authoritative boundBy, the alt record's bot ARN
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
    PutParameterCommand: jest.fn().mockImplementation((a) => ({ __t: 'PutParam', input: a })),
  }),
  { virtual: true },
);

// ARMING A BATTLE DERIVES BOTH SIDES (§3.7): the handler asks the profile writer, invoked directly. This
// stands in for it, answering the way `deriveBattleSides` does unless a test says otherwise.
const mockLambdaSend = jest.fn();
jest.mock(
  '@aws-sdk/client-lambda',
  () => ({
    LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
    InvokeCommand: jest.fn().mockImplementation((a) => ({ __t: 'Invoke', input: a })),
    InvocationType: { RequestResponse: 'RequestResponse' },
  }),
  { virtual: true },
);

process.env.EXPERIMENTS_TABLE = 'experiments-test';
process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:1:app-instance/app';
process.env.MANAGE_PROFILES_FUNCTION_NAME = 'manage-profiles-fn';
// An admin group that runs experiments but does not hold the profile capability, for the promotion refusal.
process.env.ADMIN_GROUP_NAMES = 'admins,experiment-admins';
process.env.MANAGE_PROFILES_GROUP_NAMES = 'admins';

import { handler } from '../lambda/src/admin-experiments';
import { defaultProfileRegistry } from '../lib/profile-registry';
import { edgeContext } from './helpers/edge-context';

/** The live assistant and alt of a classification's duel role, as the registry names them. */
const liveOf = (c: string) => defaultProfileRegistry.roleAssistantName(c, 'primary')!;
const altOf = (c: string) => defaultProfileRegistry.altAssistantName(c, 'primary')!;

/**
 * Answer a derivation the way `deriveExperimentVersions` does: the control is the live assistant's active
 * version (a reference), the treatment a candidate under the alt. A battle's name request is answered as applied.
 */
function deriveAnswers(over: Partial<{ controlPin: unknown; altPin: unknown; ok: boolean; status: number; error: string; code: string }> = {}) {
  mockLambdaSend.mockImplementation(async (cmd: { input: { Payload: Uint8Array } }) => {
    const payload = JSON.parse(Buffer.from(cmd.input.Payload).toString());
    if (payload.aeApplyAltAlias) return { Payload: Buffer.from(JSON.stringify({ identityRename: 'applied' })) };
    const { experiment } = payload.aeDeriveExperimentVersions;
    const c = String(experiment.tiers[0]);
    return {
      Payload: Buffer.from(JSON.stringify({
        ok: true,
        controlPin: { profileName: liveOf(c), version: 12 },
        altPin: { profileName: altOf(c), version: 7 },
        ...over,
      })),
    };
  });
}
/** The experiment rows each derivation was asked about. */
const derivationsAskedFor = () => mockLambdaSend.mock.calls
  .map((c) => JSON.parse(Buffer.from(c[0].input.Payload).toString()).aeDeriveExperimentVersions?.experiment)
  .filter(Boolean);
/** The duel name each battle asked the alt identity to wear (undefined = its provisioned name back). */
const aliasesAsked = () => mockLambdaSend.mock.calls
  .map((c) => JSON.parse(Buffer.from(c[0].input.Payload).toString()).aeApplyAltAlias)
  .filter(Boolean);

function evt(
  over: Omit<Partial<APIGatewayProxyEvent>, 'body'> & { body?: unknown },
): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/admin/experiments',
    headers: { origin: 'http://localhost:5173' },
    // The handler requires the admins group.
    requestContext: { authorizer: edgeContext({ claims: { sub: 'admin-sub', 'cognito:groups': 'admins' } }) },
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

/**
 * A treatment pinned to its alt's own version (ADR-050), and the SSM answers that let it arm: the alt's
 * assignment record, which its classification stack writes (§3.7), and that version's `derivedFrom`,
 * which names the experiment and variant that produced it. `alt: null` is a classification that
 * provisions no alt.
 */
const pinnedTreatment = (alt = 'alt-primary-premium', modelKey = 'opus') => ({
  variantId: 'treatment', modelKey, altPin: { profileName: alt, version: 1 }, weight: 50,
});
const ALT_RECORD = { classification: 'premium', botArn: 'arn:bot/alt-premium', lexBotId: 'LEXALT' };
function armedSsm(
  alt: { classification: string; botArn: string; lexBotId?: string } | null = ALT_RECORD,
  derivedFrom: Record<string, string> = { experimentId: 'exp-1', variantId: 'treatment' },
) {
  mockSsmSend.mockImplementation(async (cmd: { __t?: string; input?: { Name?: string } }) => {
    const name = cmd.input?.Name ?? '';
    if (cmd.__t === 'GetParam' && /\/assistant\/alt-[^/]+\/definition:\d+$/.test(name)) {
      return { Parameter: { Value: JSON.stringify({ derivedFrom }) } };
    }
    // The control's pinned version, under the live assistant, derived for the same experiment.
    if (cmd.__t === 'GetParam' && /\/assistant\/[^/]+\/definition:\d+$/.test(name)) {
      return { Parameter: { Value: JSON.stringify({ derivedFrom: { experimentId: derivedFrom.experimentId, variantId: 'control' } }) } };
    }
    if (cmd.__t === 'GetParam' && /\/assistant-assignments\/[^/]+\/primary\/alt$/.test(name)) {
      if (!alt || !name.includes(`/assistant-assignments/${alt.classification}/`)) {
        throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
      }
      return { Parameter: { Value: JSON.stringify({
        classification: alt.classification, role: 'primary', occupancy: 'alt', assistant: null,
        botArn: alt.botArn, lexBotId: alt.lexBotId ?? 'LEXALT',
      }) } };
    }
    return {};
  });
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockSsmSend.mockReset();
  mockLambdaSend.mockReset();
  deriveAnswers();
  armedSsm();
});

describe('admin-experiments handler', () => {
  it('OPTIONS → 200 CORS preflight', async () => {
    const r = await handler(evt({ httpMethod: 'OPTIONS' }));
    expect(r.statusCode).toBe(200);
    expect(r.headers!['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
  });

  it('401 when no caller sub', async () => {
    const r = await handler(
      evt({ requestContext: { authorizer: edgeContext({ claims: {} }) } as never }),
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
    // Idempotent: it only flips a row still in the state this reconcile READ. The state is bound
    // rather than spelled into the expression now, because `paused` expires the same way - so the
    // assertion checks the binding as well, which is stricter than the literal it replaces.
    expect(input.ConditionExpression).toContain('#s = :from');
    expect(input.ExpressionAttributeValues[':from']).toBe('active');
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
    // No alt record is read or written for a non-battle experiment.
    expect(mockSsmSend.mock.calls.map((c) => c[0]).find((c) => c?.__t === 'PutParam' || /assistant-assignments/.test(c?.input?.Name ?? ''))).toBeUndefined();
  });

  it('POST create (battle) → server boundBy, the challenger by assistant id, and no bot ARN on the row', async () => {
    armedSsm();
    // Scan first, then Put.
    mockDdbSend.mockResolvedValueOnce({ Items: [] });
    mockDdbSend.mockResolvedValueOnce({});
    const battle = {
      ...baseExp,
      battleEnabled: true,
      challengerAssistant: 'alt-primary-premium',
      variants: [
        { variantId: 'control', modelKey: 'sonnet', weight: 50 },
        pinnedTreatment('alt-primary-premium'),
      ],
    };
    const r = await handler(evt({ httpMethod: 'POST', body: battle }));
    expect(r.statusCode).toBe(200);
    const putCall = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put');
    const item = putCall![0].input.Item;
    // THE ALT OF THE EXPERIMENT'S CLASSIFICATION, by assistant id: the alt is an assistant its
    // classification stack provisions, one per (classification, role). Its bot stays on its record.
    expect(item.challengerAssistant).toBe('alt-primary-premium');
    expect(item).not.toHaveProperty('altBotSlotArn');
    expect(item).not.toHaveProperty('altBotSlotId');
    expect(item.boundBy).toBe('arn:aws:chime:us-east-1:1:app-instance/app/user/admin-sub');
    expect(item.boundAt).toBeDefined();
    // The alt is checked against its record, not a roster.
    const reads = mockSsmSend.mock.calls.map((c) => c[0]).filter((c) => c?.__t === 'GetParam').map((c) => c.input.Name);
    expect(reads).toContain('/agent-echelon/assistant-assignments/premium/primary/alt');
  });

  it('GET /challengers lists each battle-capable classification\'s alt the records provision, by assistant id', async () => {
    // Premium provisions an alt that an experiment holds; standard provisions none here, so it is not offered.
    mockSsmSend.mockImplementation(async (cmd: { __t?: string; input?: { Name?: string } }) => {
      if (cmd.__t === 'GetParam' && cmd.input?.Name === '/agent-echelon/assistant-assignments/premium/primary/alt') {
        return { Parameter: { Value: JSON.stringify({ botArn: ALT_RECORD.botArn, assistant: 'alt-primary-premium', experimentId: 'exp-live' }) } };
      }
      throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
    });
    const r = await handler(evt({ httpMethod: 'GET', path: '/admin/experiments/challengers' }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).challengers).toEqual([
      { assistant: 'alt-primary-premium', classification: 'premium', role: 'primary', inUseBy: 'exp-live' },
    ]);
    // Read from the records, never the experiments table.
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  it('GET /challengers answers 503 when a record cannot be read, rather than an empty list', async () => {
    mockSsmSend.mockRejectedValue(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    const r = await handler(evt({ httpMethod: 'GET', path: '/admin/experiments/challengers' }));
    expect(r.statusCode).toBe(503);
  });

  it('POST create (battle) from a client that sends the old console handle → stored by challenger id', async () => {
    // `altBotSlotId` is what a console from before the re-key sends. It means "this classification's
    // alt", so the row is written in the current shape and carries neither old attribute.
    armedSsm();
    mockDdbSend.mockResolvedValueOnce({ Items: [] });
    mockDdbSend.mockResolvedValueOnce({});
    const r = await handler(evt({
      httpMethod: 'POST',
      body: {
        ...baseExp,
        battleEnabled: true,
        altBotSlotId: 'slot-1',
        variants: [
          { variantId: 'control', modelKey: 'sonnet', weight: 50 },
          pinnedTreatment('alt-primary-premium'),
        ],
      },
    }));
    expect(r.statusCode).toBe(200);
    const item = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')![0].input.Item;
    expect(item.challengerAssistant).toBe('alt-primary-premium');
    expect(item).not.toHaveProperty('altBotSlotId');
    expect(item).not.toHaveProperty('altBotSlotArn');
  });

  it('REFUSES a challenger that is not the classification\'s alt', async () => {
    armedSsm();
    const r = await handler(evt({
      httpMethod: 'POST',
      body: {
        ...baseExp,
        battleEnabled: true,
        challengerAssistant: 'alt-primary-standard',
        variants: [
          { variantId: 'control', modelKey: 'sonnet', weight: 50 },
          pinnedTreatment('alt-primary-premium'),
        ],
      },
    }));
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).code).toBe('BATTLE_CHALLENGER_MISMATCH');
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')).toBeUndefined();
  });

  it('arming a battle ASSIGNS the alt for the life of the experiment, keeping the record\'s own fields', async () => {
    // A BATTLE IS AN OPTION ON AN EXPERIMENT (DESIGN-BATTLE anchor 2), so the challenger exists
    // because an experiment is running. The classification stack provisions the alt's RECORD at deploy
    // with `assistant: null` - the honest between-battles state - and arming is what names an assistant
    // in it. The Lex bot id stays, or a reply targeted at the alt would stop resolving to it.
    armedSsm();
    mockDdbSend.mockResolvedValueOnce({ Items: [] });
    mockDdbSend.mockResolvedValueOnce({});
    const r = await handler(evt({
      httpMethod: 'POST',
      body: {
        ...baseExp,
        status: 'active',
        battleEnabled: true,
        challengerAssistant: 'alt-primary-premium',
        variants: [
          { variantId: 'control', modelKey: 'sonnet', weight: 50 },
          pinnedTreatment('alt-primary-premium'),
        ],
      },
    }));
    expect(r.statusCode).toBe(200);

    const put = mockSsmSend.mock.calls.map((c) => c[0]).find((c) => c?.__t === 'PutParam');
    expect(put).toBeDefined();
    expect(put.input.Name).toMatch(/\/assistant-assignments\/premium\/primary\/alt$/);
    const assigned = JSON.parse(put.input.Value);
    expect(assigned).toMatchObject({
      classification: 'premium',
      role: 'primary',
      occupancy: 'alt',
      assistant: 'alt-primary-premium',
      botArn: ALT_RECORD.botArn,
      lexBotId: ALT_RECORD.lexBotId,
    });
    // WHICH experiment justifies the assistant, so an assignment can be traced to the thing that made it.
    expect(assigned.experimentId).toBe(baseExp.experimentId);
  });

  it('a battle armed but NOT active assigns nobody', async () => {
    // Both halves have to be true. A draft or paused experiment runs no duels, so a challenger
    // assigned by `battleEnabled` alone would claim a live opponent that cannot be reached.
    armedSsm();
    mockDdbSend.mockResolvedValueOnce({ Items: [] });
    mockDdbSend.mockResolvedValueOnce({});
    const r = await handler(evt({
      httpMethod: 'POST',
      body: {
        ...baseExp,
        status: 'paused',
        battleEnabled: true,
        challengerAssistant: 'alt-primary-premium',
        variants: [
          { variantId: 'control', modelKey: 'sonnet', weight: 50 },
          { variantId: 'treatment', modelKey: 'opus', weight: 50 },
        ],
      },
    }));
    expect(r.statusCode).toBe(200);
    const put = mockSsmSend.mock.calls.map((c) => c[0]).find((c) => c?.__t === 'PutParam');
    expect(JSON.parse(put.input.Value).assistant).toBeNull();
    expect(JSON.parse(put.input.Value).experimentId).toBeNull();
    expect(JSON.parse(put.input.Value).lexBotId).toBe(ALT_RECORD.lexBotId);
  });

  it('REFUSES a battle in a classification that provisions no alt, and writes nothing', async () => {
    // No `.../alt` record: the classification's deployment wires no battle, so there is no challenger
    // to bind. Refused at the write rather than stored and discovered at `/battle`.
    armedSsm(null);
    const r = await handler(evt({
      httpMethod: 'POST',
      body: {
        ...baseExp,
        tiers: ['premium'],
        battleEnabled: true,
        challengerAssistant: 'alt-primary-premium',
        variants: [
          { variantId: 'control', modelKey: 'sonnet', weight: 50 },
          pinnedTreatment(),
        ],
      },
    }));
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).code).toBe('ALT_NOT_PROVISIONED');
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')).toBeUndefined();
    expect(mockSsmSend.mock.calls.map((c) => c[0]).find((c) => c?.__t === 'PutParam')).toBeUndefined();
  });

  it('names the alt of the classification the experiment targets, so a mismatch cannot be stored', async () => {
    // A standard experiment names the standard alt.
    armedSsm({ classification: 'standard', botArn: 'arn:bot/alt-standard' });
    mockDdbSend.mockResolvedValueOnce({ Items: [] });
    mockDdbSend.mockResolvedValueOnce({});
    const r = await handler(evt({
      httpMethod: 'POST',
      body: {
        ...baseExp,
        tiers: ['standard'],
        battleEnabled: true,
        challengerAssistant: 'alt-primary-standard',
        variants: [
          { variantId: 'control', modelKey: 'sonnet', weight: 50 },
          pinnedTreatment('alt-primary-standard', 'haiku'),
        ],
      },
    }));
    expect(r.statusCode).toBe(200);
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')![0].input.Item.challengerAssistant).toBe('alt-primary-standard');
  });

  it('POST create (battle) → 400 BATTLE_TIER_PREMIUM_ONLY when it targets a MIXED classification set', async () => {
    // SPEC-PORTABLE-PROFILES §1/§6: `battleEligible` is now a HINT, so an operator-driven
    // battle may target any SINGLE classification (the classification's model allow-list still binds at resolution). What stays
    // rejected is a MIXED set — a battle runs head-to-head in ONE channel, so exactly one classification.
    armedSsm();
    const bad = {
      ...baseExp,
      tiers: ['standard', 'premium'],
      battleEnabled: true,
      challengerAssistant: 'alt-primary-premium',
      variants: [
        { variantId: 'control', modelKey: 'sonnet', weight: 50 },
        { variantId: 'treatment', modelKey: 'haiku', weight: 50 },
      ],
    };
    const r = await handler(evt({ httpMethod: 'POST', body: bad }));
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).code).toBe('BATTLE_TIER_PREMIUM_ONLY');
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')).toBeUndefined();
  });

  it('POST create (battle) → 200 on a single NON-premium classification (battleEligible demoted to a hint)', async () => {
    armedSsm({ classification: 'standard', botArn: 'arn:bot/alt-standard' });
    const ok = {
      ...baseExp,
      tiers: ['standard'],
      battleEnabled: true,
      challengerAssistant: 'alt-primary-standard',
      boundBy: 'admin-sub',
      variants: [
        { variantId: 'control', modelKey: 'sonnet', weight: 50 },
        pinnedTreatment('alt-primary-standard', 'haiku'),
      ],
    };
    const r = await handler(evt({ httpMethod: 'POST', body: ok }));
    expect(r.statusCode).toBe(200);
  });

  it('POST create → 400 with code when validation fails (one-sided imageGenModelKey)', async () => {
    armedSsm();
    const bad = {
      ...baseExp,
      battleEnabled: true,
      challengerAssistant: 'alt-primary-premium',
      variants: [
        { variantId: 'control', modelKey: 'sonnet', weight: 50, imageGenModelKey: 'titan_image' },
        { variantId: 'treatment', modelKey: 'opus', weight: 50 },
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

  // ── A BATTLE ARMS ONLY WITH BOTH SIDES PINNED TO VERSIONS DERIVED FOR IT (ADR-050, §3.7) ─────────
  it('refuses to arm when a derived pin names another assistant or a version derived for another experiment', async () => {
    const cases: Array<[string, () => void, Record<string, string> | undefined, string]> = [
      ["the treatment pins another role's alt", () => deriveAnswers({ altPin: { profileName: 'alt-ops-premium', version: 1 } }), undefined, 'BATTLE_TREATMENT_MUST_PIN_ALT_VERSION'],
      ['the treatment version is another experiment\'s', () => deriveAnswers(), { experimentId: 'someone-else', variantId: 'treatment' }, 'BATTLE_TREATMENT_MUST_PIN_ALT_VERSION'],
      ['the control pins the alt', () => deriveAnswers({ controlPin: { profileName: 'alt-primary-premium', version: 3 } }), undefined, 'BATTLE_CONTROL_MUST_PIN_LIVE_VERSION'],
    ];
    for (const [why, derive, derivedFrom, code] of cases) {
      armedSsm(undefined, derivedFrom);
      derive();
      mockDdbSend.mockReset();
      mockDdbSend.mockResolvedValue({ Items: [] });
      const r = await handler(evt({ httpMethod: 'POST', body: {
        ...baseExp, status: 'active', battleEnabled: true, challengerAssistant: 'alt-primary-premium',
        variants: [{ variantId: 'control', modelKey: 'sonnet', weight: 50 }, { variantId: 'treatment', modelKey: 'opus', weight: 50 }],
      } }));
      expect({ why, status: r.statusCode, code: JSON.parse(r.body).code }).toEqual({ why, status: 409, code });
      expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')).toBeUndefined();
    }
  });

  it('refuses to arm, and stores nothing, when the derivation itself is refused', async () => {
    armedSsm();
    deriveAnswers({ ok: false, status: 422, error: 'a variant may not change intentPack', code: 'PATCH_OUTSIDE_EXPERIMENT_TYPE' });
    mockDdbSend.mockResolvedValue({ Items: [] });
    const r = await handler(evt({ httpMethod: 'POST', body: {
      ...baseExp, status: 'active', battleEnabled: true, challengerAssistant: 'alt-primary-premium',
      variants: [{ variantId: 'control', modelKey: 'sonnet', weight: 50 }, { variantId: 'treatment', modelKey: 'opus', weight: 50 }],
    } }));
    expect(r.statusCode).toBe(422);
    expect(JSON.parse(r.body)).toMatchObject({ code: 'PATCH_OUTSIDE_EXPERIMENT_TYPE' });
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')).toBeUndefined();
  });
});

/**
 * EXPERIMENTS ARE CREATED AS EXPECTED, END TO END, FOR EVERY TYPE, WITH AND WITHOUT A BATTLE.
 *
 * Each type is created, validated, stored and (for a battle) armed through the handler the console calls.
 * A battle's arm derives both sides' pinned versions in the same request (§3.7), so the stored row carries
 * `controlPin` and `altPin` and the operator made one call. A non-battle experiment never asks for one.
 */
describe('creating an experiment of every type', () => {
  const statusEvent = (body: unknown) =>
    evt({ httpMethod: 'POST', path: '/admin/experiments/exp-1/status', pathParameters: { experimentId: 'exp-1' }, body });
  const variantsFor = (type: string): Array<Record<string, unknown>> => {
    switch (type) {
      case 'profile':
        return [
          { variantId: 'control', profileRef: { profileName: 'advisor', version: 3 }, weight: 50 },
          { variantId: 'treatment', profileRef: { profileName: 'advisor', version: 4 }, weight: 50, systemPromptAddendum: 'be terse' },
        ];
      case 'classification':
        return [
          { variantId: 'control', modelKey: 'haiku', weight: 50 },
          { variantId: 'treatment', modelKey: 'titan', weight: 50 },
        ];
      default:
        return [
          { variantId: 'control', modelKey: 'sonnet', weight: 50 },
          { variantId: 'treatment', modelKey: 'opus', weight: 50, systemPromptAddendum: 'be terse' },
        ];
    }
  };
  const TYPES = ['intent', 'base_model', 'classification', 'profile'] as const;

  it.each(TYPES)('%s, no battle: one create arms it, pinning the live version and a candidate, and assigns no alt', async (experimentType) => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    const r = await handler(evt({ httpMethod: 'POST', body: {
      ...baseExp, experimentType, intent: experimentType === 'intent' ? 'general' : '', variants: variantsFor(experimentType),
    } }));
    expect(r.statusCode).toBe(200);
    const item = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')![0].input.Item;
    expect(item).toMatchObject({ experimentType, status: 'active', servesVersions: true });
    expect(item.variants[0].controlPin).toEqual({ profileName: liveOf('premium'), version: 12 });
    expect(item.variants[1].altPin).toEqual({ profileName: altOf('premium'), version: 7 });
    expect(derivationsAskedFor()).toHaveLength(1);
    // No challenger: the alt's history holds the candidate, its identity is not assigned and wears no duel name.
    expect(mockSsmSend.mock.calls.map((c) => c[0]).find((c) => c?.__t === 'PutParam')).toBeUndefined();
    expect(aliasesAsked()).toEqual([]);
  });

  it.each(TYPES)("%s, battle: one create arms it, pins both versions and names the alt by the challenger's profile", async (experimentType) => {
    // The table answers the row once it is written, so the name is resolved from it as a duel resolves it.
    let written: Record<string, unknown> | undefined;
    mockDdbSend.mockImplementation(async (cmd: { __t?: string; input?: { Item?: Record<string, unknown> } }) => {
      if (cmd?.__t === 'Put') written = cmd.input?.Item;
      if (cmd?.__t === 'Scan') return { Items: written ? [written] : [] };
      if (!cmd?.__t) return written ? { Item: written } : {};
      return { Items: [] };
    });
    // Both pinned versions read the live name, as a candidate copied from the live version does.
    const answer = mockSsmSend.getMockImplementation()!;
    mockSsmSend.mockImplementation(async (cmd: { __t?: string; input?: { Name?: string } }) => {
      const out = await answer(cmd);
      const version = /\/assistant\/([^/]+)\/definition:\d+$/.exec(cmd.input?.Name ?? '');
      if (cmd.__t === 'GetParam' && version && out?.Parameter) {
        const body = JSON.parse(out.Parameter.Value);
        return { Parameter: { Value: JSON.stringify({
          ...body, schemaVersion: 1, profileName: version[1], configId: `${version[1]}-cfg`, modelKey: 'sonnet', displayName: 'Advisor',
        }) } };
      }
      return out;
    });
    const r = await handler(evt({ httpMethod: 'POST', body: {
      ...baseExp, experimentType, intent: experimentType === 'intent' ? 'general' : '',
      battleEnabled: true, challengerAssistant: 'alt-primary-premium', variants: variantsFor(experimentType),
    } }));
    expect(r.statusCode).toBe(200);
    // The derivation was asked about this experiment, its variants as sent.
    expect(derivationsAskedFor()).toEqual([expect.objectContaining({
      experimentId: 'exp-1', experimentType, battleEnabled: true, variants: expect.arrayContaining([expect.objectContaining({ variantId: 'treatment' })]),
    })]);
    const item = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')![0].input.Item;
    expect(item.variants[0].controlPin).toEqual({ profileName: liveOf('premium'), version: 12 });
    expect(item.variants[1].altPin).toEqual({ profileName: altOf('premium'), version: 7 });
    // The variants keep what they say; the pins sit beside them.
    expect(item.variants[1]).toMatchObject(variantsFor(experimentType)[1]);
    // The alt is assigned for the experiment's life, and its identity wears the challenger's duel name: its
    // version's, marked as the challenger because it matches the control's (`battleSideNames`).
    const put = mockSsmSend.mock.calls.map((c) => c[0]).find((c) => c?.__t === 'PutParam');
    expect(JSON.parse(put.input.Value).assistant).toBe(altOf('premium'));
    expect(aliasesAsked()).toEqual([{ alt: altOf('premium'), alias: 'Advisor (alt)' }]);
  });

  /** Both pinned versions read `name`, as a candidate copied from the live version does. */
  const versionsNamed = (name: string) => {
    const answer = mockSsmSend.getMockImplementation()!;
    mockSsmSend.mockImplementation(async (cmd: { __t?: string; input?: { Name?: string } }) => {
      const out = await answer(cmd);
      const version = /\/assistant\/([^/]+)\/definition:\d+$/.exec(cmd.input?.Name ?? '');
      if (cmd.__t === 'GetParam' && version && out?.Parameter) {
        const body = JSON.parse(out.Parameter.Value);
        return { Parameter: { Value: JSON.stringify({
          ...body, schemaVersion: 1, profileName: version[1], configId: `${version[1]}-cfg`, modelKey: 'sonnet', displayName: name,
        }) } };
      }
      return out;
    });
  };

  it("a battle armed with a start date still ahead names the alt from the experiment in hand", async () => {
    // No live battle names the challenger yet (the start date is ahead) and the table answers no row, so a
    // name resolved by searching for the live battle would be none; the alt holds the duel's name anyway.
    mockDdbSend.mockResolvedValue({ Items: [] });
    versionsNamed('Advisor');
    const r = await handler(evt({ httpMethod: 'POST', body: {
      ...baseExp, startDate: '2999-01-01T00:00:00Z', experimentType: 'base_model', intent: '',
      battleEnabled: true, challengerAssistant: 'alt-primary-premium', variants: variantsFor('base_model'),
    } }));
    expect(r.statusCode).toBe(200);
    expect(aliasesAsked()).toEqual([{ alt: altOf('premium'), alias: 'Advisor (alt)' }]);
  });

  it("the list names each battle side as the duel names it, and a write that sends the names back stores none", async () => {
    const armed = {
      ...baseExp, experimentType: 'base_model', battleEnabled: true, challengerAssistant: 'alt-primary-premium',
      variants: [
        { variantId: 'control', modelKey: 'sonnet', weight: 50, controlPin: { profileName: liveOf('premium'), version: 12 } },
        { variantId: 'treatment', modelKey: 'opus', weight: 50, altPin: { profileName: altOf('premium'), version: 7 } },
      ],
    };
    mockDdbSend.mockResolvedValueOnce({ Items: [armed, baseExp] });
    versionsNamed('Advisor');
    const r = await handler(evt({ httpMethod: 'GET' }));
    expect(r.statusCode).toBe(200);
    const [battle, plain] = JSON.parse(r.body).experiments;
    expect(battle.sideNames).toEqual({ control: 'Advisor', treatment: 'Advisor (alt)' });
    // An experiment with no battle is returned as stored.
    expect(plain).toEqual(baseExp);

    const { validateAndSanitizeExperiment } = await import('../lambda/src/lib/experiment-manager');
    expect(validateAndSanitizeExperiment({ ...armed, boundBy: 'u', sideNames: battle.sideNames } as never)).not.toHaveProperty('sideNames');
  });

  it.each(TYPES)('%s, battle created as a draft: nothing is derived until it is armed', async (experimentType) => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    const r = await handler(evt({ httpMethod: 'POST', body: {
      ...baseExp, status: 'draft', experimentType, intent: experimentType === 'intent' ? 'general' : '',
      battleEnabled: true, challengerAssistant: 'alt-primary-premium', variants: variantsFor(experimentType),
    } }));
    expect(r.statusCode).toBe(200);
    expect(derivationsAskedFor()).toEqual([]);
    const item = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')![0].input.Item;
    expect(item.servesVersions).toBeUndefined();
  });

  it.each(TYPES)('%s, activated through the status route: pins both versions and writes them with the status', async (experimentType) => {
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        ...baseExp, status: 'draft', experimentType, intent: experimentType === 'intent' ? 'general' : '',
        battleEnabled: true, challengerAssistant: 'alt-primary-premium', variants: variantsFor(experimentType),
      },
    });
    mockDdbSend.mockResolvedValue({ Items: [] });
    const r = await handler(statusEvent({ status: 'active' }));
    expect(r.statusCode).toBe(200);
    expect(derivationsAskedFor()).toHaveLength(1);
    const update = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Update')![0].input;
    expect(update.UpdateExpression).toContain('#v = :v');
    expect(update.UpdateExpression).toContain('#sv = :sv');
    expect(update.ExpressionAttributeValues[':sv']).toBe(true);
    expect(update.ExpressionAttributeValues[':v'][0].controlPin).toEqual({ profileName: liveOf('premium'), version: 12 });
    expect(update.ExpressionAttributeValues[':v'][1].altPin).toEqual({ profileName: altOf('premium'), version: 7 });
  });

  // ONE RULE FOR EVERY MODEL (`modelFits`): a variant names only models each of its classifications allows,
  // each fit for its use. Refused at create, for every type, with or without a battle, and nothing is stored.
  it.each(TYPES.filter((t) => t !== 'profile'))('%s: refuses a variant model the classification does not allow', async (experimentType) => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    const r = await handler(evt({ httpMethod: 'POST', body: {
      ...baseExp, experimentType, intent: experimentType === 'intent' ? 'general' : '', tiers: ['basic'],
      variants: [
        { variantId: 'control', modelKey: 'haiku', weight: 50 },
        { variantId: 'treatment', modelKey: 'opus', weight: 50 },
      ],
    } }));
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).code).toBe('VARIANT_MODEL_NOT_ALLOWED');
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')).toBeUndefined();
  });

  it.each([false, true])('refuses an image model on a classification the catalog allows none (battle: %s)', async (battle) => {
    armedSsm({ classification: 'standard', botArn: 'arn:bot/alt-standard' });
    mockDdbSend.mockResolvedValue({ Items: [] });
    const r = await handler(evt({ httpMethod: 'POST', body: {
      ...baseExp, experimentType: 'intent', intent: 'image_generation', tiers: ['standard'],
      ...(battle ? { battleEnabled: true, challengerAssistant: 'alt-primary-standard' } : {}),
      variants: [
        { variantId: 'control', modelKey: 'sonnet', imageGenModelKey: 'stability_image_core', weight: 50 },
        { variantId: 'treatment', modelKey: 'haiku', imageGenModelKey: 'stability_image_ultra', weight: 50 },
      ],
    } }));
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).code).toBe('VARIANT_IMAGE_MODEL_NOT_ALLOWED');
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('accepts the same image experiment on premium, which the catalog allows image models', async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    const r = await handler(evt({ httpMethod: 'POST', body: {
      ...baseExp, experimentType: 'intent', intent: 'image_generation', battleEnabled: true, challengerAssistant: 'alt-primary-premium',
      variants: [
        { variantId: 'control', modelKey: 'sonnet', imageGenModelKey: 'stability_image_core', weight: 50 },
        { variantId: 'treatment', modelKey: 'opus', imageGenModelKey: 'stability_image_ultra', weight: 50 },
      ],
    } }));
    expect(r.statusCode).toBe(200);
  });

  it('refuses a TEXT model named as a variant\'s image model', async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    const r = await handler(evt({ httpMethod: 'POST', body: {
      ...baseExp, experimentType: 'intent', intent: 'image_generation',
      variants: [
        { variantId: 'control', modelKey: 'sonnet', imageGenModelKey: 'opus', weight: 50 },
        { variantId: 'treatment', modelKey: 'opus', weight: 50 },
      ],
    } }));
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).code).toBe('VARIANT_IMAGE_MODEL_NOT_ALLOWED');
  });

  it('the control of a model experiment may leave its model unnamed: it is the live version', async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    const r = await handler(evt({ httpMethod: 'POST', body: {
      ...baseExp, experimentType: 'base_model', variants: [{ variantId: 'control', weight: 50 }, { variantId: 'treatment', modelKey: 'opus', weight: 50 }],
    } }));
    expect(r.statusCode).toBe(200);
    // A profile experiment's control still references its version.
    const p = await handler(evt({ httpMethod: 'POST', body: {
      ...baseExp, experimentType: 'profile', variants: [{ variantId: 'control', weight: 50 }, { variantId: 'treatment', profileRef: { profileName: 'advisor' }, weight: 50 }],
    } }));
    expect(p.statusCode).toBe(400);
    expect(JSON.parse(p.body).code).toBe('VARIANT_MODEL_KEY_REQUIRED');
  });

  it('a client cannot supply pins or the shape marker: arming derives them', async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    const r = await handler(evt({ httpMethod: 'POST', body: {
      ...baseExp, status: 'draft', servesVersions: true,
      variants: [
        { variantId: 'control', modelKey: 'sonnet', weight: 50, controlPin: { profileName: liveOf('premium'), version: 99 } },
        { variantId: 'treatment', modelKey: 'opus', weight: 50, altPin: { profileName: altOf('premium'), version: 99 } },
      ],
    } }));
    expect(r.statusCode).toBe(200);
    const item = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')![0].input.Item;
    expect(item.servesVersions).toBeUndefined();
    expect(item.variants[0].controlPin).toBeUndefined();
    expect(item.variants[1].altPin).toBeUndefined();
  });

  it('an edit of an armed experiment keeps its pins and pins nothing new (the live version may have moved)', async () => {
    const armed = {
      ...baseExp, servesVersions: true, transitions: [],
      variants: [
        { variantId: 'control', modelKey: 'sonnet', weight: 50, controlPin: { profileName: liveOf('premium'), version: 3 } },
        { variantId: 'treatment', modelKey: 'opus', weight: 50, altPin: { profileName: altOf('premium'), version: 4 } },
      ],
    };
    mockDdbSend.mockResolvedValueOnce({ Item: armed });
    mockDdbSend.mockResolvedValue({ Items: [] });
    const r = await handler(evt({ httpMethod: 'POST', body: {
      ...baseExp, variants: [{ variantId: 'control', modelKey: 'sonnet', weight: 60 }, { variantId: 'treatment', modelKey: 'opus', weight: 40 }],
    } }));
    expect(r.statusCode).toBe(200);
    expect(derivationsAskedFor()).toEqual([]);
    const item = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')![0].input.Item;
    expect(item.servesVersions).toBe(true);
    expect(item.variants[0]).toMatchObject({ weight: 60, controlPin: { version: 3 } });
    expect(item.variants[1]).toMatchObject({ weight: 40, altPin: { version: 4 } });
  });

  it('an edit of a PAUSED experiment keeps its pins, and Promote still accepts it', async () => {
    // Pins were kept only when both the stored and the new status were active, so an edit of a paused row
    // dropped them, and Promote then refused it as an experiment armed before versions were pinned.
    const paused = {
      ...baseExp, status: 'paused', servesVersions: true, transitions: [], battleEnabled: true, challengerAssistant: 'alt-primary-premium',
      variants: [
        { variantId: 'control', modelKey: 'sonnet', weight: 50, controlPin: { profileName: liveOf('premium'), version: 3 } },
        { variantId: 'treatment', modelKey: 'opus', weight: 50, altPin: { profileName: altOf('premium'), version: 4 } },
      ],
    };
    mockDdbSend.mockResolvedValueOnce({ Item: paused });
    mockDdbSend.mockResolvedValue({ Items: [] });
    const r = await handler(evt({ httpMethod: 'POST', body: {
      ...baseExp, status: 'paused', battleEnabled: true, challengerAssistant: 'alt-primary-premium', endDate: '2027-01-01T00:00:00Z',
      variants: [
        { variantId: 'control', modelKey: 'sonnet', weight: 70 },
        { variantId: 'treatment', modelKey: 'opus', weight: 30 },
      ],
    } }));
    expect(r.statusCode).toBe(200);
    expect(derivationsAskedFor()).toEqual([]);
    const item = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')![0].input.Item;
    expect(item.status).toBe('paused');
    expect(item.servesVersions).toBe(true);
    expect(item.variants[0]).toMatchObject({ weight: 70, controlPin: { version: 3 } });
    expect(item.variants[1]).toMatchObject({ weight: 30, altPin: { version: 4 } });

    // Promote reads the row the edit wrote, and asks the profile writer for its candidate.
    mockDdbSend.mockReset();
    mockLambdaSend.mockReset().mockImplementation(async (cmd: { input: { Payload: Uint8Array } }) => {
      const payload = JSON.parse(Buffer.from(cmd.input.Payload).toString());
      if (payload.aeApplyAltAlias) return { Payload: Buffer.from(JSON.stringify({ identityRename: 'applied' })) };
      return { Payload: Buffer.from(JSON.stringify({ ok: true, profileName: liveOf('premium'), version: 5, configId: 'cfg-cand' })) };
    });
    mockDdbSend.mockResolvedValueOnce({ Item: item });
    mockDdbSend.mockResolvedValue({});
    const promoted = await handler({
      ...evt({ httpMethod: 'POST', path: '/admin/experiments/exp-1/promote', pathParameters: { experimentId: 'exp-1' }, body: {} }),
    } as unknown as APIGatewayProxyEvent);
    expect(promoted.statusCode).toBe(200);
    const asked = mockLambdaSend.mock.calls.map((c) => JSON.parse(Buffer.from(c[0].input.Payload).toString()).aePromoteCandidate).filter(Boolean);
    expect(asked[0].experiment.variants[1].altPin).toEqual({ profileName: altOf('premium'), version: 4 });
  });

  it('an edit of an armed experiment that changes what its pins were derived from is refused, and the pins stay', async () => {
    const paused = {
      ...baseExp, status: 'paused', servesVersions: true, transitions: [],
      variants: [
        { variantId: 'control', modelKey: 'sonnet', weight: 50, controlPin: { profileName: liveOf('premium'), version: 3 } },
        { variantId: 'treatment', modelKey: 'opus', weight: 50, altPin: { profileName: altOf('premium'), version: 4 } },
      ],
    };
    for (const change of [{ intent: 'data_extraction' }, { experimentType: 'base_model' }]) {
      mockDdbSend.mockReset().mockResolvedValueOnce({ Item: paused });
      mockDdbSend.mockResolvedValue({ Items: [] });
      const r = await handler(evt({ httpMethod: 'POST', body: {
        ...baseExp, status: 'paused', ...change,
        variants: [{ variantId: 'control', modelKey: 'sonnet', weight: 50 }, { variantId: 'treatment', modelKey: 'opus', weight: 50 }],
      } }));
      expect(r.statusCode).toBe(409);
      expect(JSON.parse(r.body).code).toBe('EXPERIMENT_LIVE_EDIT_LOCKED');
      expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put')).toBeUndefined();
    }
  });

  it('a refused arm writes no version: the cap and the classification are checked before anything is derived', async () => {
    const paused = { ...baseExp, status: 'paused', transitions: [], battleEnabled: true, challengerAssistant: 'alt-primary-premium', variants: variantsFor('base_model') };
    const full = Array.from({ length: 50 }, (_, i) => ({ experimentId: `e-${i}` }));
    const occupant = { experimentId: 'other', status: 'active', tiers: ['premium'], variants: [] };

    // Resume on the status route, over the cap.
    mockDdbSend.mockReset().mockResolvedValueOnce({ Item: paused }).mockResolvedValueOnce({ Items: full });
    const overCap = await handler(statusEvent({ status: 'active' }));
    expect(overCap.statusCode).toBe(429);
    // Resume on the status route, into an occupied classification.
    mockDdbSend.mockReset().mockResolvedValueOnce({ Item: paused }).mockResolvedValueOnce({ Items: [] }).mockResolvedValue({ Items: [occupant] });
    const occupied = await handler(statusEvent({ status: 'active' }));
    expect(occupied.statusCode).toBe(409);
    expect(JSON.parse(occupied.body).code).toBe('EXPERIMENT_TYPE_CONFLICT');
    // A create that arms, over the cap and into an occupied classification.
    mockDdbSend.mockReset().mockResolvedValueOnce({}).mockResolvedValueOnce({ Items: full });
    expect((await handler(evt({ httpMethod: 'POST', body: { ...baseExp, experimentId: 'exp-2', variants: variantsFor('base_model') } }))).statusCode).toBe(429);
    mockDdbSend.mockReset().mockResolvedValueOnce({}).mockResolvedValueOnce({ Items: [] }).mockResolvedValue({ Items: [occupant] });
    const createOccupied = await handler(evt({ httpMethod: 'POST', body: { ...baseExp, experimentId: 'exp-2', variants: variantsFor('base_model') } }));
    expect(JSON.parse(createOccupied.body).code).toBe('EXPERIMENT_TYPE_CONFLICT');

    // Nothing was derived, so no candidate was published, and nothing was written.
    expect(derivationsAskedFor()).toEqual([]);
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Put' || c[0].__t === 'Update')).toBeUndefined();
  });

  it('a row armed before versions were pinned is armed this way when it is resumed', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: { ...baseExp, status: 'paused', transitions: [] } });
    mockDdbSend.mockResolvedValue({ Items: [] });
    const r = await handler(statusEvent({ status: 'active' }));
    expect(r.statusCode).toBe(200);
    expect(derivationsAskedFor()).toHaveLength(1);
    const update = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Update')![0].input;
    expect(update.ExpressionAttributeValues[':sv']).toBe(true);
    expect(update.ExpressionAttributeValues[':v'][1].altPin).toEqual({ profileName: altOf('premium'), version: 7 });
  });

  it('ending a battle releases the alt and puts its provisioned name back', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: {
      ...baseExp, status: 'active', transitions: [], battleEnabled: true, challengerAssistant: 'alt-primary-premium', servesVersions: true,
      variants: variantsFor('base_model'),
    } });
    mockDdbSend.mockResolvedValue({});
    const r = await handler(statusEvent({ status: 'completed' }));
    expect(r.statusCode).toBe(200);
    expect(aliasesAsked()).toEqual([{ alt: altOf('premium') }]);
  });
});

/**
 * PROMOTION (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.6): an activation of the live assistant's profile
 * through the profile writer, then the experiment completes with the decision recorded and the alt released.
 */
describe('promoting an experiment\'s treatment', () => {
  const promoteEvent = (groups = 'admins', body: unknown = { note: 'ship it' }) => ({
    ...evt({ httpMethod: 'POST', path: '/admin/experiments/exp-1/promote', pathParameters: { experimentId: 'exp-1' }, body }),
    requestContext: { authorizer: edgeContext({ claims: { sub: 'admin-sub', 'cognito:groups': groups } }) },
  }) as unknown as APIGatewayProxyEvent;
  const armed = {
    ...baseExp, status: 'active', servesVersions: true, transitions: [], battleEnabled: true, challengerAssistant: 'alt-primary-premium',
    variants: [
      { variantId: 'control', modelKey: 'sonnet', weight: 50, controlPin: { profileName: 'advisor', version: 3 } },
      { variantId: 'treatment', modelKey: 'opus', weight: 50, altPin: { profileName: 'alt-primary-premium', version: 4 } },
    ],
  };
  const promoteAnswers = (answer: Record<string, unknown>) => mockLambdaSend.mockImplementation(async (cmd: { input: { Payload: Uint8Array } }) => {
    const payload = JSON.parse(Buffer.from(cmd.input.Payload).toString());
    if (payload.aeApplyAltAlias) return { Payload: Buffer.from(JSON.stringify({ identityRename: 'applied' })) };
    return { Payload: Buffer.from(JSON.stringify(answer)) };
  });
  const promotionsAsked = () => mockLambdaSend.mock.calls
    .map((c) => JSON.parse(Buffer.from(c[0].input.Payload).toString()).aePromoteCandidate).filter(Boolean);

  it('asks the profile writer to promote, completes the experiment with the decision and the promoted version, and releases the alt', async () => {
    promoteAnswers({ ok: true, profileName: 'advisor', version: 5, configId: 'cfg-cand', promotedFrom: { profileName: 'alt-primary-premium', version: 4, experimentId: 'exp-1' } });
    mockDdbSend.mockResolvedValueOnce({ Item: armed });
    mockDdbSend.mockResolvedValue({});
    const r = await handler(promoteEvent());
    expect(r.statusCode).toBe(200);
    expect(promotionsAsked()).toEqual([expect.objectContaining({ experiment: expect.objectContaining({ experimentId: 'exp-1' }) })]);
    const update = mockDdbSend.mock.calls.find((c) => c[0].__t === 'Update')![0].input;
    expect(update.ExpressionAttributeValues[':s']).toBe('completed');
    expect(update.ExpressionAttributeValues[':d']).toMatchObject({ outcome: 'promoted_treatment', note: 'ship it' });
    expect(update.ExpressionAttributeValues[':p']).toMatchObject({ profileName: 'advisor', version: 5, configId: 'cfg-cand' });
    expect(update.ExpressionAttributeValues[':t'].at(-1)).toMatchObject({ from: 'active', to: 'completed', reason: 'promote' });
    // The alt is released: the record names no assistant, and its identity gets its provisioned name back.
    const put = mockSsmSend.mock.calls.map((c) => c[0]).find((c) => c?.__t === 'PutParam');
    expect(JSON.parse(put.input.Value).assistant).toBeNull();
    expect(mockLambdaSend.mock.calls.map((c) => JSON.parse(Buffer.from(c[0].input.Payload).toString()).aeApplyAltAlias).filter(Boolean))
      .toEqual([{ alt: 'alt-primary-premium' }]);
  });

  it('a refusal from the profile writer is answered as it is, and the experiment is left running', async () => {
    promoteAnswers({ ok: false, status: 409, error: 'advisor now serves version 6', code: 'LIVE_VERSION_MOVED' });
    mockDdbSend.mockResolvedValueOnce({ Item: armed });
    const r = await handler(promoteEvent());
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).code).toBe('LIVE_VERSION_MOVED');
    expect(mockDdbSend.mock.calls.find((c) => c[0].__t === 'Update')).toBeUndefined();
  });

  it('is refused to a caller who administers experiments but cannot activate profiles, before anything is read', async () => {
    const r = await handler(promoteEvent('experiment-admins'));
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).code).toBe('PROMOTION_NEEDS_ACTIVATE_PROFILES');
    expect(mockDdbSend).not.toHaveBeenCalled();
    expect(promotionsAsked()).toEqual([]);
  });

  it('refuses an experiment armed before versions were pinned, and one that is not running', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: { ...armed, servesVersions: undefined } });
    const legacy = await handler(promoteEvent());
    expect(JSON.parse(legacy.body).code).toBe('PROMOTION_NEEDS_TWO_VERSIONS');
    mockDdbSend.mockResolvedValueOnce({ Item: { ...armed, status: 'completed' } });
    const ended = await handler(promoteEvent());
    expect(JSON.parse(ended.body).code).toBe('EXPERIMENT_NOT_RUNNING');
    expect(promotionsAsked()).toEqual([]);
  });
});
