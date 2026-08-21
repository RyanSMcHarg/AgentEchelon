/**
 * THE HUMAN AXIS COUNTS THE VARIANTS THIS EXPERIMENT ACTUALLY HAS.
 *
 * `getExperimentPicks` reported `treatment_wins` and `control_wins` by filtering on the LITERAL
 * strings 'treatment' and 'control'. Variant ids are caller-supplied - `admin-experiments.ts:323`
 * builds its map from whatever was submitted - so an experiment named any other way reported 0 and 0.
 *
 * That is the worst possible failure for this particular number. Picks are the HUMAN axis of the
 * decision loop: the one signal a person produced deliberately by choosing a winner. Reporting it as
 * empty does not look like a bug, it looks like nobody voted, and it looks that way on exactly the
 * experiments whose custom naming suggests someone was paying attention.
 *
 * The fix resolves the two ids from the picks, keeping the conventional names when they are present
 * so every existing experiment reads identically, and adds `wins_by_variant` so a comparison with
 * more than two sides is not flattened into two buckets.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  ScanCommand: jest.fn().mockImplementation((a) => ({ __t: 'Scan', input: a })),
  QueryCommand: jest.fn().mockImplementation((a) => ({ __t: 'Query', input: a })),
  GetCommand: jest.fn().mockImplementation((a) => ({ __t: 'Get', input: a })),
  PutCommand: jest.fn().mockImplementation((a) => ({ __t: 'Put', input: a })),
  UpdateCommand: jest.fn().mockImplementation((a) => ({ __t: 'Update', input: a })),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

// SET BEFORE THE IMPORT, not in beforeEach. `BATTLE_OUTCOME_TABLE` is read into a module-level const
// at load time, so a value assigned later never reaches it - `scanBattleOutcomeItems` returns []
// immediately and every assertion below reads 0. That is green-because-nothing-ran, the exact failure
// these tests exist to catch, and it cost a run here before the ordering was fixed.
process.env.BATTLE_OUTCOME_TABLE = 'battle-outcome-test';

import { handler } from '../../lambda/src/analytics-aurora/analytics-query';

function postEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/query',
    body: JSON.stringify(body),
    requestContext: { authorizer: { claims: { sub: 'admin-sub', 'cognito:groups': 'admins' } } },
  } as unknown as APIGatewayProxyEvent;
}

/**
 * A battle-outcome item in the shape `selectBattlePicks` actually filters on: it requires a non-empty
 * experimentId and variantId, and a PARSEABLE `chosenAt` at or after the window start. A row missing
 * `chosenAt` is dropped silently, which is what makes the field worth naming here.
 */
const pick = (variantId: string, battleId: string) => ({
  experimentId: 'exp-1',
  variantId,
  battleId,
  winner: variantId,
  chosenAt: new Date().toISOString(),
  chosenByUserSub: 'user-1',
});

async function picksFor(items: unknown[]): Promise<any> {
  mockDdbSend.mockResolvedValue({ Items: items });
  mockDbQuery.mockResolvedValue({ rows: [] });
  const res = await handler(postEvent({ queryType: 'experiment_picks', experimentId: 'exp-1' }));
  return JSON.parse(res.body);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('experiment picks report the wins that exist', () => {
  it('still reads the conventional names identically', async () => {
    // Non-regression for every experiment that already exists: the two names win when present, so
    // this fix must not move a number anybody is currently reading.
    const body = await picksFor([pick('treatment', 'b1'), pick('treatment', 'b2'), pick('control', 'b3')]);
    expect(body.stats.treatment_wins).toBe(2);
    expect(body.stats.control_wins).toBe(1);
  });

  it('counts CUSTOM variant ids instead of reporting nobody voted', async () => {
    // The defect. With ids the platform does not recognise, both counts read 0 - which reads as "no
    // human picked a winner" rather than "this rollup cannot name your variants".
    const body = await picksFor([pick('haiku-fast', 'b1'), pick('opus-deep', 'b2'), pick('opus-deep', 'b3')]);
    expect(body.stats.treatment_wins + body.stats.control_wins).toBe(3);
  });

  it('gives the full per-variant breakdown, so a third side is not flattened away', async () => {
    // Two counts cannot describe three variants. The breakdown is appended rather than replacing
    // them, so the existing contract survives and the extra side stops being invisible.
    const body = await picksFor([pick('a', 'b1'), pick('b', 'b2'), pick('c', 'b3'), pick('c', 'b4')]);
    expect(body.stats.wins_by_variant).toEqual({ a: 1, b: 1, c: 2 });
  });

  it('counts over the WHOLE result, not the returned page', async () => {
    // A rollup that changed when someone paged would not be a rollup. Asserted with a limit smaller
    // than the pick count, which is the shape that would expose a page-scoped tally.
    mockDdbSend.mockResolvedValue({
      Items: [pick('control', 'b1'), pick('control', 'b2'), pick('treatment', 'b3')],
    });
    mockDbQuery.mockResolvedValue({ rows: [] });
    const res = await handler(postEvent({ queryType: 'experiment_picks', experimentId: 'exp-1', limit: '1' }));
    const body = JSON.parse(res.body);
    expect(body.data.length).toBe(1);
    expect(body.stats.control_wins).toBe(2);
    expect(body.stats.treatment_wins).toBe(1);
  });
});
